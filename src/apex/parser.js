// Structural Apex parser: finds classes (incl. inner), triggers, methods, member variables and
// SOQL regions. It is a tolerant heuristic parser, not a full grammar: anything it cannot
// understand is skipped rather than failing the whole file.

import { lex, matchBrackets } from './lexer.js';

export const KEYWORDS = new Set([
  'abstract', 'break', 'catch', 'class', 'continue', 'do', 'else', 'enum', 'extends', 'false',
  'final', 'finally', 'for', 'global', 'if', 'implements', 'instanceof', 'interface', 'new',
  'null', 'override', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'transient', 'true', 'try', 'virtual', 'void', 'webservice', 'when', 'while',
  'with', 'without', 'sharing', 'inherited', 'testmethod', 'trigger', 'on', 'insert', 'update',
  'upsert', 'delete', 'undelete', 'merge',
]);

const NOT_A_METHOD_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new',
  'else', 'when', 'super', 'this', 'do', 'try', 'throw']);

export function parseUnit(unit) {
  const toks = lex(unit.body || '');
  const match = matchBrackets(toks);
  const file = { unit, toks, match, types: [], methods: [] };
  const { regions, inSoql } = findSoqlRegions(toks, match);
  file.soqlRegions = regions;
  file.inSoql = inSoql;
  file.soqlAt = (k) => soqlAt(file, k);
  if (unit.kind === 'trigger') parseTrigger(file);
  else parseTopLevel(file);
  return file;
}

// ---------- types ----------

export function readType(toks, i) {
  const t = toks[i];
  if (!t || t.type !== 'id' || KEYWORDS.has(t.lv)) return null;
  const parts = [t.lv];
  let j = i + 1;
  while (toks[j]?.v === '.' && toks[j + 1]?.type === 'id') { parts.push(toks[j + 1].lv); j += 2; }
  let args = [];
  if (toks[j]?.v === '<') {
    const g = readGenericArgs(toks, j);
    if (g) { args = g.args; j = g.end; }
  }
  let array = false;
  while (toks[j]?.v === '[' && toks[j + 1]?.v === ']') { array = true; j += 2; }
  return { name: parts.join('.'), args, array, end: j };
}

export function readGenericArgs(toks, j) {
  const args = [];
  let k = j + 1;
  for (;;) {
    const a = readType(toks, k);
    if (!a) return null;
    args.push(a);
    k = a.end;
    if (toks[k]?.v === ',') { k++; continue; }
    if (toks[k]?.v === '>') return { args, end: k + 1 };
    return null;
  }
}

// Normalises a parsed type into { name, elem } where elem is the element/value type of a collection.
export function typeInfo(T) {
  if (T.array) return { name: 'list', elem: T.name };
  if (T.name === 'list' || T.name === 'set') return { name: T.name, elem: T.args[0]?.name || null };
  if (T.name === 'map') return { name: 'map', elem: T.args[1]?.name || null };
  return { name: T.name, elem: null };
}

// Records `Type name` declarations found in [a, b) into map (lowercase var name -> typeInfo).
export function scanDecls(file, a, b, map) {
  const { toks, inSoql } = file;
  for (let i = a; i < b; i++) {
    const t = toks[i];
    if (t.type !== 'id' || inSoql[i] || KEYWORDS.has(t.lv) || toks[i - 1]?.v === '.') continue;
    const T = readType(toks, i);
    if (!T || T.end >= b) continue;
    const nameTok = toks[T.end];
    if (nameTok?.type !== 'id' || KEYWORDS.has(nameTok.lv)) continue;
    const after = toks[T.end + 1]?.v;
    if (after === '=' || after === ';' || after === ':' || after === ',' || after === ')') {
      map.set(nameTok.lv, typeInfo(T));
    }
  }
}

// ---------- SOQL ----------

function findSoqlRegions(toks, match) {
  const regions = [];
  const inSoql = new Uint8Array(toks.length);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v === '[' && toks[i + 1]?.type === 'id' && (toks[i + 1].lv === 'select' || toks[i + 1].lv === 'find')) {
      const end = match[i] < 0 ? toks.length - 1 : match[i];
      regions.push({ start: i, end, isSosl: toks[i + 1].lv === 'find', scope: null });
      for (let x = i; x <= end; x++) inSoql[x] = 1;
      i = end;
    }
  }
  return { regions, inSoql };
}

function soqlAt(file, k) {
  if (!file.inSoql[k]) return null;
  const rs = file.soqlRegions;
  let lo = 0, hi = rs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rs[mid].end < k) lo = mid + 1;
    else if (rs[mid].start > k) hi = mid - 1;
    else {
      const r = rs[mid];
      if (!r.scope) r.scope = computeScopes(file.toks, r);
      return r;
    }
  }
  return null;
}

// Works out which FROM object each token in a SOQL query belongs to (handles sub-queries).
function computeScopes(toks, region) {
  const tokScope = new Map();
  const root = { depth: 0, from: null, sub: false };
  const stack = [root];
  let depth = 0;
  for (let x = region.start + 1; x < region.end; x++) {
    const t = toks[x];
    if (t.v === '(') {
      depth++;
      if (toks[x + 1]?.lv === 'select') stack.push({ depth, from: null, sub: true });
      continue;
    }
    if (t.v === ')') {
      if (stack.length > 1 && stack[stack.length - 1].depth === depth) stack.pop();
      depth--;
      continue;
    }
    const top = stack[stack.length - 1];
    if (t.type === 'id' && t.lv === 'from' && toks[x + 1]?.type === 'id' && !top.from) top.from = toks[x + 1].lv;
    tokScope.set(x, top);
  }
  return { fromAt: (k) => tokScope.get(k)?.from ?? null, isSub: (k) => !!tokScope.get(k)?.sub };
}

// ---------- triggers ----------

function parseTrigger(file) {
  const { toks, match, unit } = file;
  const i = toks.findIndex((t) => t.type === 'id' && t.lv === 'trigger');
  if (i < 0 || !toks[i + 1] || toks[i + 2]?.lv !== 'on' || !toks[i + 3]) return;
  const name = toks[i + 1];
  const obj = toks[i + 3];
  let events = '';
  let p = i + 4;
  if (toks[p]?.v === '(' && match[p] > 0) {
    events = toks.slice(p + 1, match[p]).filter((t) => t.type === 'id').map((t) => t.v).join(' ')
      .replace(/ (before|after) /gi, ', $1 ');
    p = match[p] + 1;
  }
  while (p < toks.length && toks[p].v !== '{') p++;
  if (p >= toks.length) return;
  const type = {
    key: 'trigger:' + name.lv, name: name.v, lname: name.lv, display: name.v, kind: 'trigger',
    triggerObject: obj.lv, triggerObjectLabel: obj.v, events, extends: null, implements: [],
    annots: [], isTest: false, outer: null, file, memberVars: new Map(), methods: [],
    methodsByName: new Map(), start: p, end: match[p] < 0 ? toks.length - 1 : match[p],
  };
  file.types.push(type);
  addMethod(file, type, {
    name: name.v, kind: 'trigger', declStart: i, nameTok: i + 1, paramOpen: -1, paramClose: -1,
    bodyStart: p, bodyEnd: type.end, annots: [], mods: new Set(),
  });
  file.methods[file.methods.length - 1].entry = {
    kind: 'trigger', label: 'Trigger', detail: `${obj.v}${events ? ' · ' + events : ''}`,
  };
  unit.triggerObject = obj.lv;
}

// ---------- classes ----------

function parseTopLevel(file) {
  const { toks, match } = file;
  const annots = [];
  let stmtStart = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'annot') {
      annots.push(t.lv);
      if (toks[i + 1]?.v === '(' && match[i + 1] > 0) i = match[i + 1];
      continue;
    }
    if (t.type === 'id' && (t.lv === 'class' || t.lv === 'interface' || t.lv === 'enum')) {
      parseType(file, i, null, annots, idsBetween(toks, stmtStart, i));
      return;
    }
  }
}

function idsBetween(toks, a, b) {
  const s = new Set();
  for (let x = a; x < b; x++) if (toks[x].type === 'id') s.add(toks[x].lv);
  return s;
}

function readHeaderList(toks, start, b) {
  // reads "Type, Type<..>, Type" until '{' or a keyword
  const out = [];
  let h = start;
  while (h < b) {
    const T = readType(toks, h);
    if (!T) break;
    out.push(T.name);
    h = T.end;
    if (toks[h]?.v === ',') h++;
    else break;
  }
  return { list: out, end: h };
}

function parseType(file, i, outer, annots, mods) {
  const { toks, match } = file;
  const kindTok = toks[i];
  const nameTok = toks[i + 1];
  if (!nameTok || nameTok.type !== 'id') return i + 1;
  let b = i + 2;
  while (b < toks.length && toks[b].v !== '{') b++;
  let ext = null;
  const impls = [];
  for (let h = i + 2; h < b; h++) {
    if (toks[h].lv === 'extends') {
      const r = readHeaderList(toks, h + 1, b);
      if (kindTok.lv === 'interface') impls.push(...r.list); else ext = r.list[0] || null;
      h = r.end - 1;
    } else if (toks[h].lv === 'implements') {
      const r = readHeaderList(toks, h + 1, b);
      impls.push(...r.list);
      h = r.end - 1;
    }
  }
  const end = b < toks.length && match[b] >= 0 ? match[b] : toks.length - 1;
  const type = {
    key: (outer ? outer.key + '.' : '') + nameTok.lv,
    name: nameTok.v, lname: nameTok.lv,
    display: outer ? outer.display + '.' + nameTok.v : nameTok.v,
    kind: kindTok.lv, extends: ext, implements: impls, annots: [...annots], mods,
    isTest: annots.includes('istest') || !!outer?.isTest,
    isVirtual: mods.has('virtual') || mods.has('abstract'),
    outer, file, memberVars: new Map(), methods: [], methodsByName: new Map(),
    start: b, end, line: kindTok.line,
  };
  file.types.push(type);
  if (type.kind === 'enum' || b >= toks.length) return end + 1;

  let j = b + 1;
  let stmtStart = j;
  let mAnnots = [];
  let sawEq = false;
  const reset = (k) => { stmtStart = k; mAnnots = []; sawEq = false; };

  while (j < end) {
    const t = toks[j];
    if (t.type === 'annot') {
      mAnnots.push(t.lv);
      j = toks[j + 1]?.v === '(' && match[j + 1] > 0 ? match[j + 1] + 1 : j + 1;
      continue;
    }
    if (!sawEq && t.type === 'id' && (t.lv === 'class' || t.lv === 'interface' || t.lv === 'enum')) {
      j = parseType(file, j, type, mAnnots, idsBetween(toks, stmtStart, j));
      reset(j);
      continue;
    }
    if (t.v === '=') { sawEq = true; j++; continue; }
    if (t.v === '{') {
      const close = match[j] < 0 ? end : match[j];
      if (sawEq) { j = close + 1; continue; } // collection initialiser
      const prev = toks[j - 1];
      const isProp = j - 1 >= stmtStart && prev.type === 'id';
      const mods = idsBetween(toks, stmtStart, j);
      if (isProp) {
        let ts = stmtStart;
        while (ts < j && (toks[ts].type === 'annot' || (toks[ts].type === 'id' && KEYWORDS.has(toks[ts].lv)))) ts++;
        const T = readType(toks, ts);
        if (T && T.end === j - 1) type.memberVars.set(prev.lv, typeInfo(T));
      }
      addMethod(file, type, {
        name: isProp ? prev.v : (mods.has('static') ? 'static initializer' : 'initializer'),
        kind: isProp ? 'property' : 'initializer', declStart: stmtStart, nameTok: isProp ? j - 1 : j,
        paramOpen: -1, paramClose: -1, bodyStart: j, bodyEnd: close, annots: mAnnots, mods,
      });
      j = close + 1;
      reset(j);
      continue;
    }
    if (t.v === '(' && !sawEq) {
      const close = match[j] < 0 ? end : match[j];
      const p = toks[j - 1];
      const q = toks[j - 2];
      const nameOk = j - 1 >= stmtStart && p?.type === 'id' && !NOT_A_METHOD_NAME.has(p.lv);
      const isCtor = nameOk && p.lv === nameTok.lv;
      const typeBefore = j - 2 >= stmtStart && q && ((q.type === 'id' && q.lv !== 'new') || q.v === '>' || q.v === ']');
      const after = toks[close + 1];
      if (nameOk && (isCtor || typeBefore) && after && (after.v === '{' || after.v === ';')) {
        const hasBody = after.v === '{';
        const bodyEnd = hasBody ? (match[close + 1] < 0 ? end : match[close + 1]) : close + 1;
        addMethod(file, type, {
          name: p.v, kind: isCtor ? 'constructor' : 'method', declStart: stmtStart, nameTok: j - 1,
          paramOpen: j, paramClose: close, bodyStart: hasBody ? close + 1 : -1, bodyEnd,
          annots: mAnnots, mods: idsBetween(toks, stmtStart, j - 1),
        });
        j = bodyEnd + 1;
        reset(j);
        continue;
      }
      j = close + 1;
      continue;
    }
    if (t.v === ';') {
      scanDecls(file, stmtStart, j + 1, type.memberVars);
      reset(j + 1);
      j++;
      continue;
    }
    j++;
  }
  return end + 1;
}

function countParams(toks, open, close) {
  if (open < 0 || close === open + 1) return 0;
  let n = 1;
  for (let x = open + 1; x < close; x++) {
    if (toks[x].v === '<') {
      const g = readGenericArgs(toks, x);
      if (g) { x = g.end - 1; continue; }
    }
    if (toks[x].v === ',') n++;
  }
  return n;
}

function detectEntry(type, m) {
  const a = new Set(m.annots);
  if (a.has('istest') || m.mods.has('testmethod') || type.isTest) return { kind: 'test', label: 'Test' };
  if (a.has('auraenabled')) return { kind: 'lwc', label: 'LWC / Aura' };
  if (a.has('invocablemethod')) return { kind: 'flow', label: 'Flow' };
  if (a.has('remoteaction')) return { kind: 'vf', label: 'Visualforce' };
  const verb = ['httpget', 'httppost', 'httpput', 'httppatch', 'httpdelete'].find((x) => a.has(x));
  if (verb) return { kind: 'rest', label: 'REST', detail: verb.slice(4).toUpperCase() };
  if (m.mods.has('webservice')) return { kind: 'soap', label: 'SOAP' };
  const impl = implementsOf(type);
  if (impl.has('batchable') && ['start', 'execute', 'finish'].includes(m.lname)) return { kind: 'batch', label: 'Batch' };
  if (impl.has('schedulable') && m.lname === 'execute') return { kind: 'schedule', label: 'Scheduled' };
  if (impl.has('queueable') && m.lname === 'execute') return { kind: 'queueable', label: 'Queueable' };
  if (a.has('future')) return { kind: 'future', label: '@future' };
  return null;
}

export function implementsOf(type) {
  return new Set((type.implements || []).map((s) => s.replace(/^(database|system)\./, '')));
}

function addMethod(file, type, d) {
  const { toks } = file;
  const m = {
    id: `${file.unit.id}#${file.methods.length}`,
    file, type, name: d.name, lname: d.name.toLowerCase(), kind: d.kind,
    declStart: d.declStart, nameTok: d.nameTok, paramOpen: d.paramOpen, paramClose: d.paramClose,
    bodyStart: d.bodyStart, bodyEnd: d.bodyEnd, annots: d.annots || [], mods: d.mods || new Set(),
    abstract: d.bodyStart < 0,
    startLine: toks[d.declStart]?.line ?? 1,
    endLine: toks[d.bodyEnd]?.line ?? toks[toks.length - 1]?.line ?? 1,
  };
  m.isStatic = m.mods.has('static');
  m.isOverride = m.mods.has('override');
  m.paramCount = countParams(toks, d.paramOpen, d.paramClose);
  m.entry = d.kind === 'trigger' ? null : detectEntry(type, m);
  m.isTest = m.entry?.kind === 'test';
  m.label = d.kind === 'trigger' ? type.display
    : d.kind === 'constructor' ? `new ${type.display}()`
      : d.kind === 'property' ? `${type.display}.${d.name}`
        : d.kind === 'initializer' ? `${type.display} {${d.name}}`
          : `${type.display}.${d.name}()`;
  file.methods.push(m);
  type.methods.push(m);
  if (!type.methodsByName.has(m.lname)) type.methodsByName.set(m.lname, []);
  type.methodsByName.get(m.lname).push(m);
}
