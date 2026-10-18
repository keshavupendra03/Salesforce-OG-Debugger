// Single-pass parser for Salesforce Apex debug logs. Produces everything the log viewer shows:
// per-line categories (for colouring / filtering), queries, DML, debug output, errors, governor
// limits and an execution tree (code units → methods → SOQL/DML …) with nanosecond timings.

export const LINE_RE = /^(\d{1,2}:\d{2}:\d{2}\.\d+) \((\d+)\)\|([A-Z_]+)(?:\|(.*))?$/;

// 'session' marks the separator line between logs in a merged session.
export const CATS = ['other', 'unit', 'method', 'soql', 'dml', 'debug', 'error', 'limit', 'rule', 'callout', 'system', 'session'];
const C = Object.fromEntries(CATS.map((c, i) => [c, i]));
// lineCat flag: line continues the previous event (multi-line debug output, limit blocks, stack traces)
export const CONT = 0x80;

const SYSTEM_RE = /^(HEAP_|BULK_HEAP|STATEMENT_EXECUTE|VARIABLE_|SYSTEM_|STATIC_VARIABLE|ENTERING_MANAGED_PKG|TOTAL_EMAIL|SAVEPOINT_|USER_INFO|CUMULATIVE_PROFILING)/;
const RULE_RE = /^(FLOW_|VALIDATION_|WF_|DUPLICATE_|PUSH_|PROCESS_BUILDER)/;

export function categoryOf(type) {
  if (type === 'USER_DEBUG') return C.debug;
  if (type === 'EXCEPTION_THROWN' || type === 'FATAL_ERROR' || type.endsWith('_ERROR') || type === 'VALIDATION_FAIL') return C.error;
  if (type.startsWith('CODE_UNIT_') || type.startsWith('EXECUTION_')) return C.unit;
  if (type.startsWith('METHOD_') || type.startsWith('CONSTRUCTOR_')) return C.method;
  if (type.startsWith('SOQL_') || type.startsWith('SOSL_') || type.startsWith('QUERY_MORE')) return C.soql;
  if (type.startsWith('DML_')) return C.dml;
  if (type.startsWith('LIMIT_USAGE') || type.startsWith('CUMULATIVE_LIMIT') || type.startsWith('TESTING_LIMITS')) return C.limit;
  if (type.startsWith('CALLOUT_') || type.startsWith('NAMED_CREDENTIAL')) return C.callout;
  if (SYSTEM_RE.test(type)) return C.system;
  if (RULE_RE.test(type)) return C.rule;
  return C.other;
}

const OPEN = {
  EXECUTION_STARTED: 'execution', CODE_UNIT_STARTED: 'unit', METHOD_ENTRY: 'method', CONSTRUCTOR_ENTRY: 'method',
  SOQL_EXECUTE_BEGIN: 'soql', SOSL_EXECUTE_BEGIN: 'soql', DML_BEGIN: 'dml', FLOW_START_INTERVIEW_BEGIN: 'flow',
  FLOW_ELEMENT_BEGIN: 'flowel', WF_RULE_EVAL_BEGIN: 'workflow', CALLOUT_REQUEST: 'callout',
};
const CLOSE = {
  EXECUTION_FINISHED: 'execution', CODE_UNIT_FINISHED: 'unit', METHOD_EXIT: 'method', CONSTRUCTOR_EXIT: 'method',
  SOQL_EXECUTE_END: 'soql', SOSL_EXECUTE_END: 'soql', DML_END: 'dml', FLOW_START_INTERVIEW_END: 'flow',
  FLOW_ELEMENT_END: 'flowel', WF_RULE_EVAL_END: 'workflow', CALLOUT_RESPONSE: 'callout',
};

const srcLine = (s) => { const m = /^\[(\d+)\]$/.exec(s || ''); return m ? +m[1] : null; };
const joinMsg = (parts, extra) => [parts.join('|'), ...(extra || [])].join('\n');
const isId = (s) => /^0[0-9A-Za-z]{14,17}$/.test(s || '');
const add = (parent, child) => { child.parent = parent; parent.children.push(child); return child; };

const STACK_RE = /^(Class|Trigger)\.([\w.]+): line (\d+), column (\d+)/;
const parseStack = (msg) => msg.split('\n').map((l) => STACK_RE.exec(l.trim())).filter(Boolean)
  .map((m) => ({ kind: m[1] === 'Trigger' ? 'trigger' : 'class', qual: m[2], line: +m[3], col: +m[4] }));

function mkNode(kind, label, ev) {
  return {
    kind, sub: kind, label, li: ev ? ev.li : 0, endLi: ev ? ev.li : 0, line: ev ? srcLine(ev.parts[0]) : null,
    start: ev ? ev.ns : 0, end: ev ? ev.ns : 0, children: [], n: { soql: 0, dml: 0, error: 0, debug: 0 },
  };
}

export function parseLog(text) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lineCat = new Uint8Array(lines.length);
  const root = mkNode('root', 'Request', null);
  const p = {
    lines, lineCat, catCounts: new Uint32Array(CATS.length), apiVersion: null, levels: [], root,
    queries: [], dml: [], debugs: [], errors: [], callouts: [], units: [], limits: new Map(), anon: [],
    firstNs: null, lastNs: 0, durationNs: 0,
  };
  for (const l of lines) {
    const m = /^Execute Anonymous: ?(.*)$/.exec(l);
    if (m) p.anon.push(m[1]);
    else if (p.anon.length || LINE_RE.test(l)) break;
  }
  const head = /^(\d+\.\d+)\s+(.+)$/.exec(lines[0] || '');
  if (head && /^[A-Z_]+,[A-Z]+/.test(head[2])) {
    p.apiVersion = head[1];
    p.levels = head[2].split(';').map((s) => s.trim().split(',')).filter((x) => x.length === 2)
      .map(([cat, level]) => ({ cat, level }));
  }

  const stack = [root];
  let ev = null;
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) {
      if (ev) { (ev.extra ||= []).push(lines[i]); lineCat[i] = ev.cat | CONT; }
      continue; // header / "Execute Anonymous:" lines stay 'other'
    }
    if (ev) handle(p, stack, ev);
    const type = m[3];
    ev = { li: i, ns: Number(m[2]), type, parts: m[4] != null ? m[4].split('|') : [], cat: categoryOf(type), extra: null };
    lineCat[i] = ev.cat;
    p.catCounts[ev.cat]++;
    if (p.firstNs == null) p.firstNs = ev.ns;
    if (ev.ns > p.lastNs) p.lastNs = ev.ns;
  }
  if (ev) handle(p, stack, ev);
  for (let s = stack.length - 1; s > 0; s--) { // unfinished (truncated log, uncaught exception)
    stack[s].end = p.lastNs;
    stack[s].endLi = lines.length - 1;
  }
  root.start = p.firstNs ?? 0;
  root.end = p.lastNs;
  root.endLi = lines.length - 1;
  p.durationNs = root.end - root.start;
  rollup(root);
  return p;
}

function contextOf(stack) {
  for (let s = stack.length - 1; s > 0; s--) {
    if (stack[s].kind === 'method' || stack[s].kind === 'unit') return stack[s].label;
  }
  return null;
}

function handle(p, stack, ev) {
  const { type, parts } = ev;
  const top = stack[stack.length - 1];
  const openKind = OPEN[type];
  if (openKind) {
    stack.push(add(top, openNode(p, stack, ev, openKind)));
    return;
  }
  const closeKind = CLOSE[type];
  if (closeKind) {
    // tolerant: pop to the nearest matching open node, ignore unmatched closes
    for (let s = stack.length - 1; s > 0 && s >= stack.length - 40; s--) {
      if (stack[s].kind !== closeKind) continue;
      const node = stack[s];
      while (stack.length > s) {
        const n = stack.pop();
        n.end = ev.ns;
        n.endLi = ev.li;
      }
      closeNode(node, ev);
      break;
    }
    return;
  }
  switch (type) {
    case 'USER_DEBUG': {
      const msg = joinMsg(parts.slice(2), ev.extra);
      p.debugs.push({ li: ev.li, line: srcLine(parts[0]), level: parts[1] || 'DEBUG', msg, ns: ev.ns, context: contextOf(stack) });
      add(top, mkNode('debug', msg.split('\n')[0].slice(0, 300), ev));
      break;
    }
    case 'EXCEPTION_THROWN':
    case 'FATAL_ERROR': {
      const fatal = type === 'FATAL_ERROR';
      const msg = joinMsg(fatal ? parts : parts.slice(1), ev.extra).trim();
      const node = add(top, mkNode('error', msg.split('\n')[0], ev));
      p.errors.push({ li: ev.li, line: node.line, fatal, msg, context: contextOf(stack), node, stack: fatal ? parseStack(msg) : [] });
      break;
    }
    case 'VALIDATION_ERROR': {
      const msg = `Validation error: ${joinMsg(parts, ev.extra).trim()}`;
      const node = add(top, mkNode('error', msg, ev));
      p.errors.push({ li: ev.li, line: null, fatal: false, msg, context: contextOf(stack), node, stack: [] });
      break;
    }
    case 'VALIDATION_RULE':
      add(top, mkNode('validation', parts[parts.length - 1] || 'Validation rule', ev));
      break;
    case 'LIMIT_USAGE_FOR_NS': {
      const list = [];
      for (const l of ev.extra || []) {
        const m = /^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)/.exec(l);
        if (m) list.push({ name: m[1], used: +m[2], max: +m[3] });
      }
      if (list.length) p.limits.set((parts[0] || '(default)').trim(), list); // last block wins (cumulative)
      break;
    }
    default:
  }
}

function openNode(p, stack, ev, kind) {
  const { parts } = ev;
  const node = mkNode(kind, '', ev);
  switch (kind) {
    case 'execution':
      node.label = 'Execution';
      break;
    case 'unit': {
      node.label = parts.length >= 3 ? parts[2] : parts[1] || parts[0] || 'Code unit';
      node.sub = /trigger event/i.test(node.label) ? 'trigger'
        : /^Validation:/i.test(node.label) ? 'validation'
          : /^Workflow:/i.test(node.label) ? 'workflow'
            : /^Flow:/i.test(node.label) ? 'flow' : 'unit';
      node.ud = stack.filter((n) => n.kind === 'unit').length;
      if (isId(parts[1])) {
        const trigger = parts[1].startsWith('01q');
        const name = trigger ? (parts[3] || '').split('/').pop() || node.label.split(' ')[0] : node.label;
        node.src = { kind: trigger ? 'trigger' : 'class', id: parts[1], name: name.split('.')[0], qual: name };
      } else if (node.label === 'execute_anonymous_apex') {
        node.src = { kind: 'anon', name: 'Anonymous Apex', qual: 'Anonymous Apex', lines: p.anon };
      }
      p.units.push(node);
      break;
    }
    case 'method': {
      const last = parts[parts.length - 1] || '';
      const ctor = ev.type === 'CONSTRUCTOR_ENTRY';
      let qual;
      let method;
      let sig;
      if (ctor) {
        qual = last;
        method = last.split('.').pop();
        sig = /\((.*)\)/.exec(parts[parts.length - 2] || '')?.[1] ?? '';
        node.label = `new ${last}(${sig})`;
      } else {
        const q = last.replace(/\(.*$/, '');
        qual = q.slice(0, q.lastIndexOf('.'));
        method = q.slice(q.lastIndexOf('.') + 1);
        sig = /\((.*)\)\s*$/.exec(last)?.[1] ?? '';
        node.label = last;
      }
      node.src = { kind: 'class', id: isId(parts[1]) ? parts[1] : null, name: qual.split('.')[0], qual, method, ctor, sig };
      break;
    }
    case 'soql': {
      const sosl = ev.type === 'SOSL_EXECUTE_BEGIN';
      const query = joinMsg(sosl ? parts.slice(1) : parts.slice(2), ev.extra).trim();
      let outer = query;
      for (let prev; prev !== outer;) { prev = outer; outer = outer.replace(/\([^()]*\)/g, ''); } // drop sub-queries
      node.label = query;
      node.q = {
        idx: p.queries.length, li: ev.li, line: srcLine(parts[0]), query, sosl,
        object: sosl ? null : (/\bfrom\s+([\w.]+)/i.exec(outer)?.[1] ?? null),
        rows: null, dur: null, ns: ev.ns, context: contextOf(stack),
      };
      p.queries.push(node.q);
      break;
    }
    case 'dml': {
      const kv = {};
      for (const s of parts.slice(1)) { const i = s.indexOf(':'); if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1); }
      node.d = {
        idx: p.dml.length, li: ev.li, line: srcLine(parts[0]), op: kv.Op || '?', object: kv.Type || '?',
        rows: kv.Rows != null ? +kv.Rows : null, dur: null, ns: ev.ns, context: contextOf(stack),
      };
      node.label = `${node.d.op} ${node.d.object}${node.d.rows != null ? ` · ${node.d.rows} row${node.d.rows === 1 ? '' : 's'}` : ''}`;
      p.dml.push(node.d);
      break;
    }
    case 'flow':
      node.label = parts[parts.length - 1] || 'Flow interview';
      break;
    case 'flowel':
      node.label = `${(parts[1] || '').replace(/^Flow/, '')} ${parts[2] || ''}`.trim();
      break;
    case 'workflow':
      node.label = 'Workflow rules';
      break;
    case 'callout':
      node.label = joinMsg(parts.slice(1), ev.extra);
      node.c = { li: ev.li, line: srcLine(parts[0]), request: node.label, response: null, dur: null };
      p.callouts.push(node.c);
      break;
    default:
  }
  return node;
}

function closeNode(node, ev) {
  const dur = node.end - node.start;
  if (node.q) {
    const m = /Rows:(\d+)/.exec(ev.parts.join('|'));
    node.q.rows = m ? +m[1] : null;
    node.q.dur = dur;
  }
  if (node.d) node.d.dur = dur;
  if (node.c) { node.c.response = joinMsg(ev.parts.slice(1), ev.extra); node.c.dur = dur; }
}

function rollup(node) {
  const n = node.n;
  for (const c of node.children) {
    rollup(c);
    n.soql += c.n.soql + (c.kind === 'soql' ? 1 : 0);
    n.dml += c.n.dml + (c.kind === 'dml' ? 1 : 0);
    n.error += c.n.error + (c.kind === 'error' ? 1 : 0);
    n.debug += c.n.debug + (c.kind === 'debug' ? 1 : 0);
  }
}

// ---------- error paths ----------

const FRAME_KINDS = new Set(['tx', 'unit', 'method', 'dml', 'flow']);

// Code frames (units, methods, DML, flows) from the top of the request down to `node`, inclusive.
export function frameChain(node) {
  const out = [node];
  for (let x = node.parent; x && x.kind !== 'root'; x = x.parent) if (FRAME_KINDS.has(x.kind)) out.unshift(x);
  return out;
}

const headOf = (msg) => msg.split('\n')[0].trim();

// One entry per distinct failure. An uncaught FATAL_ERROR is paired with the earliest matching
// EXCEPTION_THROWN, because that event sits at the frame (and line) where the exception was raised.
export function errorPaths(p) {
  const used = new Set();
  const out = [];
  for (const f of p.errors) {
    if (!f.fatal) continue;
    const head = headOf(f.msg);
    const thrown = p.errors.find((e) => !e.fatal && !used.has(e) && e.li < f.li && headOf(e.msg) === head);
    if (thrown) { used.add(thrown); f.node.dupe = true; } // same failure; the tree shows it once
    const at = thrown || f;
    out.push({ fatal: true, head, msg: f.msg, at, chain: frameChain(at.node), stack: f.stack, count: 1 });
  }
  const seen = new Map();
  for (const e of p.errors) {
    if (e.fatal || used.has(e)) continue;
    const head = headOf(e.msg);
    if (seen.has(head)) { seen.get(head).count++; continue; }
    const entry = { fatal: false, head, msg: e.msg, at: e, chain: frameChain(e.node), stack: [], count: 1 };
    seen.set(head, entry);
    out.push(entry);
  }
  for (const e of out) e.rootCause = out.some((o) => o !== e && o.head !== e.head && o.msg.includes(e.head));
  return out;
}

export const queryKey =(q) => q.query.replace(/\s+/g, ' ').trim().toLowerCase();

export function groupQueries(queries) {
  const m = new Map();
  for (const q of queries) {
    const k = queryKey(q);
    if (!m.has(k)) m.set(k, { key: k, items: [], rows: 0, dur: 0 });
    const g = m.get(k);
    g.items.push(q);
    g.rows += q.rows || 0;
    g.dur += q.dur || 0;
  }
  return [...m.values()];
}

// ---------- sessions: several logs merged into one view ----------

const toMs = (s) => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

function walk(n, fn) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

// items: [{ meta: ApexLog record, body }] in any order. Returns the same shape as parseLog(), with every
// log becoming a 'tx' (transaction) node under one root. Line indexes and timings are shifted onto one
// shared timeline; governor limits stay per transaction because Salesforce enforces them per transaction.
export function mergeLogs(items) {
  const sorted = [...items].sort((a, b) => toMs(a.meta.StartTime) - toMs(b.meta.StartTime));
  const t0 = toMs(sorted[0].meta.StartTime);
  const lines = [];
  const cats = [];
  const root = mkNode('root', 'Session', null);
  const out = {
    merged: true, lines, lineCat: null, catCounts: new Uint32Array(CATS.length), apiVersion: null, levels: [], root,
    queries: [], dml: [], debugs: [], errors: [], callouts: [], units: [], limits: new Map(), anon: [],
    firstNs: 0, lastNs: 0, durationNs: 0, txs: [],
  };
  sorted.forEach(({ meta, body }, i) => {
    const p = parseLog(body);
    const tx = i + 1;
    const shift = Math.round((toMs(meta.StartTime) - t0) * 1e6) - (p.firstNs ?? 0);
    lines.push(`════ Transaction ${tx} of ${sorted.length} · ${meta.Operation || 'log'} · ${meta.LogUser?.Name || ''} · ${meta.StartTime} · ${meta.Id} ════`);
    cats.push(C.session);
    const offLi = lines.length;
    for (let k = 0; k < p.lines.length; k++) { lines.push(p.lines[k]); cats.push(p.lineCat[k]); }

    walk(p.root, (n) => { if (n !== p.root) { n.li += offLi; n.endLi += offLi; n.start += shift; n.end += shift; } });
    const txNode = mkNode('tx', `Transaction ${tx} · ${meta.Operation || 'log'}`, null);
    Object.assign(txNode, {
      li: offLi - 1, endLi: offLi + p.lines.length - 1, start: p.root.start + shift, end: p.root.end + shift, tx, meta, n: p.root.n,
    });
    txNode.children = p.root.children;
    for (const c of txNode.children) c.parent = txNode;
    add(root, txNode);

    const fix = (arr) => { for (const x of arr) { x.li += offLi; if (x.ns != null) x.ns += shift; x.tx = tx; } return arr; };
    out.queries.push(...fix(p.queries));
    out.dml.push(...fix(p.dml));
    out.debugs.push(...fix(p.debugs));
    out.errors.push(...fix(p.errors));
    out.callouts.push(...fix(p.callouts));
    out.units.push(...p.units);
    for (const [ns, list] of p.limits) out.limits.set(`Transaction ${tx} · ${meta.Operation || 'log'}${ns === '(default)' ? '' : ` · ${ns}`}`, list);
    for (let c = 0; c < CATS.length; c++) out.catCounts[c] += p.catCounts[c];
    if (!out.levels.length) { out.levels = p.levels; out.apiVersion = p.apiVersion; }
    out.txs.push({ tx, meta, node: txNode, summary: summarize(p) });
  });
  out.catCounts[C.session] = sorted.length;
  out.lineCat = Uint8Array.from(cats);
  out.queries.forEach((q, i) => { q.idx = i; });
  out.dml.forEach((d, i) => { d.idx = i; });
  root.start = 0;
  root.end = Math.max(0, ...root.children.map((t) => t.end));
  for (const t of root.children) for (const k of Object.keys(root.n)) root.n[k] += t.n[k];
  out.lastNs = root.end;
  out.durationNs = root.end;
  root.endLi = lines.length - 1;
  return out;
}

// The innermost node (method, code unit, DML…) whose log lines contain line `li`.
export function nodeAtLine(root, li) {
  let n = root;
  for (;;) {
    const kids = n.children;
    let lo = 0;
    let hi = kids.length - 1;
    let hit = null;
    while (lo <= hi) { // last child starting at or before li
      const mid = (lo + hi) >> 1;
      if (kids[mid].li <= li) { hit = kids[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (!hit || li > hit.endLi || !hit.children.length) return hit && li <= hit.endLi ? hit : n;
    n = hit;
  }
}

export function summarize(p) {
  const def = p.limits.get('(default)') || p.limits.values().next().value || [];
  const total = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
  // a merged session reports the worst transaction, since limits apply per transaction
  const worst = (k) => p.txs.map((t) => t.summary[k]).filter(Boolean).sort((a, b) => b.used / b.max - a.used / a.max)[0] || null;
  const lim = (re, k) => (p.merged ? worst(k) : def.find((l) => re.test(l.name)) || null);
  return {
    durationMs: p.durationNs / 1e6,
    soql: p.queries.length,
    rows: total(p.queries, 'rows'),
    repeated: groupQueries(p.queries).filter((g) => g.items.length > 1).length,
    dml: p.dml.length,
    dmlRows: total(p.dml, 'rows'),
    debugs: p.debugs.length,
    errors: p.errors.length,
    fatal: p.errors.find((e) => e.fatal) || null,
    cpu: lim(/cpu time/i, 'cpu'),
    heap: lim(/heap size/i, 'heap'),
    callouts: p.callouts.length,
  };
}
