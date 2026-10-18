// Field Trace: where did Object.Field get read or written in one log / session?
// Combines the static Code Flow analysis (which methods reference the field) with what actually ran in
// the log (method entries) and what the log itself shows (assigned values, workflow/flow/validation lines).

import { frameChain, nodeAtLine, LINE_RE } from './log-parser.js';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const srcLine = (s) => { const m = /^\[(\d+)\]$/.exec(s || ''); return m ? +m[1] : null; };

function walk(n, fn) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

export const srcFrameOf = (n) => {
  for (let x = n; x && x.kind !== 'root'; x = x.parent) if (x.src) return x;
  return null;
};

function countArgs(sig) {
  if (!sig || !sig.trim()) return 0;
  let depth = 0;
  let n = 1;
  for (const c of sig) {
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

// The parsed (static) method behind a method / trigger node from the log.
export function staticMethodFor(node, index) {
  const src = node?.src;
  if (!src || !index) return null;
  if (node.kind === 'unit') {
    return src.kind === 'trigger' ? index.types.get(`trigger:${src.name.toLowerCase()}`)?.methods[0] || null : null;
  }
  if (src.kind !== 'class' || !src.qual) return null;
  const type = index.resolveType(src.qual.toLowerCase(), null);
  if (!type) return null;
  const name = (src.ctor ? type.lname : src.method || '').toLowerCase();
  const cands = (type.methodsByName.get(name) || [])
    .filter((m) => (src.ctor ? m.kind === 'constructor' : m.kind === 'method' || m.kind === 'property'));
  if (cands.length <= 1) return cands[0] || null;
  const argc = countArgs(src.sig);
  return cands.find((m) => m.paramCount === argc) || cands[0];
}

// Source lines of `frame` itself (not its callees) that the log shows ran. `full` when the log has STATEMENT_EXECUTE
// (Apex Code FINER or finer) inside the frame: then every executed statement is listed and a missing line didn't run.
export function linesRun(p, frame) {
  const lines = new Set();
  const skip = []; // log-line ranges of nested frames (other source)
  const collect = (n) => {
    for (const c of n.children) {
      if (c.src) {
        skip.push(c);
        if (c.line != null) lines.add(c.line); // the call site ran in this frame
      } else collect(c);
    }
  };
  collect(frame);
  let full = false;
  let k = 0;
  for (let i = frame.li + 1; i <= frame.endLi && i < p.lines.length; i++) {
    while (k < skip.length && skip[k].endLi < i) k++;
    if (k < skip.length && skip[k].li <= i) { i = skip[k].endLi; continue; }
    const s = p.lines[i];
    if (!s.includes('|[')) continue;
    const m = LINE_RE.exec(s);
    const ln = m && srcLine((m[4] || '').split('|')[0]);
    if (ln == null) continue;
    lines.add(ln);
    if (m[3] === 'STATEMENT_EXECUTE') full = true;
  }
  return { full, lines };
}

// Log events that mention the field, by type.
function evidenceKind(type, parts, F) {
  if (type === 'VARIABLE_ASSIGNMENT') {
    const name = parts[1] || '';
    return name.toLowerCase().split('.').pop() === F ? 'assign' : null;
  }
  if (type.startsWith('WF_FIELD_UPDATE') || type === 'WF_ACTION') return 'workflow';
  if (type.startsWith('FLOW_')) return 'flow';
  if (type.startsWith('VALIDATION_')) return 'validation';
  if (type === 'SOQL_EXECUTE_BEGIN' || type === 'SOSL_EXECUTE_BEGIN') return 'soql';
  if (type === 'USER_DEBUG') return 'debug';
  return null;
}

/**
 * p: parsed (or merged) log. index: CodeIndex of the org's Apex (may be null: then only log evidence is used).
 * Returns { touches, dmls, evidence, paths, refsByMethod, assignsByFrame, stats }.
 */
export function traceField(p, index, objectApi, fieldApi, { possible = false } = {}) {
  const O = objectApi.toLowerCase();
  const F = fieldApi.toLowerCase();
  const analysis = index ? index.analyzeField(objectApi, fieldApi) : new Map();
  const refsByMethod = new Map();
  const refsOf = (m) => {
    if (!refsByMethod.has(m.id)) {
      const a = analysis.get(m.id);
      refsByMethod.set(m.id, a ? a.refs.filter((r) => possible || r.confidence === 'sure') : []);
    }
    return refsByMethod.get(m.id);
  };

  // 1. steps that ran and whose code references the field, plus DML on the object
  const touches = new Map(); // node -> { node, method, refs, write, read, assigns }
  const dmls = [];
  walk(p.root, (n) => {
    if (n.kind === 'dml' && n.d && n.d.object.toLowerCase() === O) dmls.push(n);
    if (n.kind !== 'method' && !(n.kind === 'unit' && n.sub === 'trigger')) return;
    const method = staticMethodFor(n, index);
    const refs = method ? refsOf(method) : [];
    if (refs.length) touches.set(n, { node: n, method, refs, assigns: [] });
  });

  // 2. what the log itself says about the field
  const wordRe = new RegExp(`(^|[^\\w])${escRe(F)}([^\\w]|$)`, 'i');
  const evidence = [];
  const assignsByFrame = new Map();
  for (let i = 0; i < p.lines.length; i++) {
    const line = p.lines[i];
    if (!line.toLowerCase().includes(F) || !wordRe.test(line)) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const parts = (m[4] || '').split('|');
    const kind = evidenceKind(m[3], parts, F);
    if (!kind) continue;
    const node = nodeAtLine(p.root, i);
    const frame = srcFrameOf(node);
    const ev = {
      li: i, kind, type: m[3], node, frame, line: srcLine(parts[0]),
      text: kind === 'assign' ? `${parts[1]} = ${parts[2] ?? ''}`
        : kind === 'debug' ? parts.slice(2).join('|')
          : kind === 'soql' ? parts.slice(2).join('|') || parts.slice(1).join('|')
            : parts.join(' · '),
      value: kind === 'assign' ? parts[2] : null,
    };
    evidence.push(ev);
    if (kind === 'assign' && frame) {
      if (!assignsByFrame.has(frame)) assignsByFrame.set(frame, []);
      assignsByFrame.get(frame).push(ev);
      // the log proves a write even when the static scan couldn't (dynamic Apex, unresolved types)
      if (!touches.has(frame)) touches.set(frame, { node: frame, method: staticMethodFor(frame, index), refs: [], assigns: [] });
      touches.get(frame).assigns.push(ev);
    }
  }
  for (const t of touches.values()) {
    // with statement-level logging, only count references on lines that actually ran
    t.run = linesRun(p, t.node);
    const live = t.run.full ? t.refs.filter((r) => t.run.lines.has(r.line)) : t.refs;
    t.write = live.some((r) => r.access === 'write') || t.assigns.length > 0;
    t.read = live.some((r) => r.access === 'read');
    t.idle = !t.write && !t.read;
  }

  // 3. paths: entry point -> ... -> step, grouped when the same chain repeats (loops, bulk triggers)
  const groups = new Map();
  const addPath = (kind, node, extra) => {
    const chain = frameChain(node);
    const sig = `${kind}|${chain.map((n) => n.label).join('>')}`;
    if (!groups.has(sig)) groups.set(sig, { kind, chain, node, items: [], ...extra });
    groups.get(sig).items.push(node);
  };
  for (const t of touches.values()) addPath(t.write ? 'write' : t.read ? 'read' : 'idle', t.node, { touch: t });
  for (const n of dmls) addPath('dml', n, {});
  const order = { write: 0, dml: 1, read: 2, idle: 3 };
  const paths = [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.node.li - b.node.li);

  const list = [...touches.values()];
  return {
    object: objectApi, field: fieldApi, touches: list, dmls, evidence, paths, refsByMethod, assignsByFrame,
    stats: {
      writers: new Set(list.filter((t) => t.write).map((t) => t.method?.id || t.node.label)).size,
      readers: new Set(list.filter((t) => t.read && !t.write).map((t) => t.method?.id || t.node.label)).size,
      dml: dmls.length,
      assigns: evidence.filter((e) => e.kind === 'assign').length,
      evidence: evidence.length,
    },
  };
}

// Objects and fields that show up in a log, offered as quick picks.
export function objectsInLog(p) {
  const counts = new Map();
  const bump = (o) => { if (o && /^\w+$/.test(o)) counts.set(o, (counts.get(o) || 0) + 1); };
  for (const d of p.dml) bump(d.object);
  for (const q of p.queries) bump(q.object);
  for (const u of p.units) bump(/ on (\w+) trigger event/i.exec(u.label)?.[1]);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([o]) => o);
}

export function fieldsInLog(p, objectApi) {
  const O = objectApi.toLowerCase();
  const out = new Map();
  for (const q of p.queries) {
    if ((q.object || '').toLowerCase() !== O) continue;
    const m = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(q.query);
    if (!m) continue;
    let depth = 0;
    let cur = '';
    for (const c of `${m[1]},`) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        const f = cur.trim();
        if (/^\w+$/.test(f) && f.toLowerCase() !== 'id') out.set(f.toLowerCase(), f);
        cur = '';
      } else cur += c;
    }
  }
  return [...out.values()];
}
