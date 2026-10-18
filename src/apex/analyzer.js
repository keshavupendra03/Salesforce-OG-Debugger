// Builds an org-wide call graph from parsed Apex and answers:
//   "which methods touch Object.Field (read/write), and which code paths lead to them?"

import { parseUnit, scanDecls, readType, readGenericArgs, implementsOf } from './parser.js';

const CALL_SKIP = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'super', 'this', 'when']);

// System namespaces / types whose methods are never user code.
const SYSTEM_RECEIVERS = new Set(['system', 'database', 'schema', 'string', 'integer', 'long',
  'decimal', 'double', 'boolean', 'date', 'datetime', 'time', 'math', 'json', 'limits', 'userinfo',
  'test', 'trigger', 'apexpages', 'label', 'http', 'httprequest', 'httpresponse', 'crypto',
  'encodingutil', 'messaging', 'approval', 'eventbus', 'auth', 'type', 'url', 'pattern', 'blob',
  'id', 'sobjecttype', 'site', 'search', 'cache', 'flow', 'connectapi', 'dom', 'xmlstreamreader',
  'jsonparser', 'jsongenerator', 'restcontext', 'restrequest', 'restresponse', 'list', 'set', 'map',
  'object', 'sobject', 'exception', 'organization', 'network', 'continuation', 'process']);

// Method names too generic to guess a target for when the receiver type is unknown.
const COMMON_NAMES = new Set(['add', 'addall', 'put', 'putall', 'get', 'size', 'contains',
  'containskey', 'keyset', 'values', 'isempty', 'remove', 'clear', 'equals', 'hashcode', 'tostring',
  'valueof', 'format', 'debug', 'sort', 'clone', 'length', 'substring', 'split', 'trim',
  'tolowercase', 'touppercase', 'startswith', 'endswith', 'indexof', 'replace', 'execute', 'start',
  'finish', 'run', 'init', 'insert', 'update', 'delete', 'upsert', 'query', 'getdescribe',
  'newinstance', 'deserialize', 'serialize', 'send', 'handle', 'process', 'iterator', 'next',
  'hasnext', 'getmessage', 'setbody', 'getbody', 'build', 'create', 'call', 'invoke', 'apply',
  'validate', 'save', 'load', 'parse', 'getinstance', 'getvalue', 'setvalue', 'getid', 'getname']);

const WRITE_OPS = new Set(['=', '+=', '-=', '*=', '/=', '|=', '&=', '^=', '++', '--']);

export const ROOT_ENTRY_KINDS = new Set(['trigger', 'lwc', 'flow', 'vf', 'rest', 'soap', 'batch', 'schedule', 'queueable']);

export class CodeIndex {
  /** units: [{ id, name, kind: 'class'|'trigger', body }] */
  static fromUnits(units) {
    return new CodeIndex(units.map(parseUnit));
  }

  constructor(files) {
    this.files = files;
    this.types = new Map();
    this.typesByShortName = new Map();
    this.methods = [];
    this.methodsById = new Map();
    this.methodsByName = new Map();
    this.subtypes = new Map();
    this.edges = [];
    this.callersOf = new Map();
    this.calleesOf = new Map();
    this._varCache = new Map();
    this._edgeKeys = new Set();

    for (const f of files) {
      for (const t of f.types) {
        this.types.set(t.key, t);
        if (t.kind !== 'trigger') {
          if (!this.typesByShortName.has(t.lname)) this.typesByShortName.set(t.lname, []);
          this.typesByShortName.get(t.lname).push(t);
        }
      }
      for (const m of f.methods) {
        this.methods.push(m);
        this.methodsById.set(m.id, m);
        if (m.kind === 'method') {
          if (!this.methodsByName.has(m.lname)) this.methodsByName.set(m.lname, []);
          this.methodsByName.get(m.lname).push(m);
        }
      }
    }
    for (const t of this.types.values()) {
      t.superType = t.extends ? this.resolveType(t.extends, t.outer || t) : null;
      t.interfaceTypes = t.implements.map((n) => this.resolveType(n, t.outer || t)).filter(Boolean);
      for (const s of [t.superType, ...t.interfaceTypes]) {
        if (!s) continue;
        if (!this.subtypes.has(s.key)) this.subtypes.set(s.key, []);
        this.subtypes.get(s.key).push(t);
      }
    }
    for (const m of this.methods) this.resolveCalls(m);
  }

  get stats() {
    let classes = 0, triggers = 0;
    for (const f of this.files) f.unit.kind === 'trigger' ? triggers++ : classes++;
    return { classes, triggers, methods: this.methods.length, edges: this.edges.length };
  }

  // ---------- type & method resolution ----------

  resolveType(name, fromType) {
    if (!name) return null;
    for (let t = fromType; t; t = t.outer) {
      const k = t.key + '.' + name;
      if (this.types.has(k)) return this.types.get(k);
    }
    if (this.types.has(name)) return this.types.get(name);
    const short = this.typesByShortName.get(name.split('.').pop());
    return short && short.length === 1 ? short[0] : null;
  }

  allSubtypes(type) {
    const out = [];
    const seen = new Set([type.key]);
    const queue = [type];
    while (queue.length) {
      const t = queue.shift();
      for (const s of this.subtypes.get(t.key) || []) {
        if (seen.has(s.key)) continue;
        seen.add(s.key);
        out.push(s);
        queue.push(s);
      }
    }
    return out;
  }

  findMethods(cls, name, argc, allowDispatch) {
    const found = [];
    const seen = new Set();
    for (let t = cls; t && !seen.has(t); t = t.superType) {
      seen.add(t);
      const ms = (t.methodsByName.get(name) || []).filter((x) => x.kind === 'method');
      if (ms.length) { found.push(...ms.map((method) => ({ method }))); break; }
      // interfaces may extend other interfaces
      for (const it of t.interfaceTypes || []) {
        for (const x of it.methodsByName.get(name) || []) found.push({ method: x });
      }
    }
    if (allowDispatch) {
      const isPolymorphic = cls.kind === 'interface' || cls.isVirtual || found.some((f) => f.method.mods.has('virtual') || f.method.mods.has('abstract') || f.method.type.kind === 'interface');
      if (isPolymorphic) {
        for (const sub of this.allSubtypes(cls)) {
          for (const x of sub.methodsByName.get(name) || []) {
            if (x.kind === 'method' && !found.some((f) => f.method === x)) found.push({ method: x, dispatch: true });
          }
        }
      }
    }
    return filterArity(found, argc);
  }

  findInScope(type, name, argc) {
    for (let t = type; t; t = t.outer) {
      const r = this.findMethods(t, name, argc, true);
      if (r.length) return r;
    }
    return null;
  }

  guess(name, argc) {
    if (COMMON_NAMES.has(name)) return null;
    const ms = this.methodsByName.get(name);
    if (!ms || new Set(ms.map((m) => m.type)).size !== 1) return null;
    return filterArity(ms.map((method) => ({ method })), argc);
  }

  varTypes(m) {
    let map = this._varCache.get(m.id);
    if (map) return map;
    map = new Map();
    const chain = [];
    for (let t = m.type; t; t = t.outer) chain.push(t);
    for (const t of chain.reverse()) for (const [k, v] of t.memberVars) map.set(k, v);
    if (m.paramOpen >= 0) scanDecls(m.file, m.paramOpen + 1, m.paramClose + 1, map);
    if (m.bodyStart >= 0) scanDecls(m.file, m.bodyStart + 1, m.bodyEnd, map);
    this._varCache.set(m.id, map);
    return map;
  }

  addEdge(from, to, tok, kind) {
    const line = from.file.toks[tok].line;
    const key = `${from.id}>${to.id}@${line}`;
    if (this._edgeKeys.has(key)) return;
    this._edgeKeys.add(key);
    const e = { from: from.id, to: to.id, line, tok, kind };
    this.edges.push(e);
    if (!this.callersOf.has(to.id)) this.callersOf.set(to.id, []);
    this.callersOf.get(to.id).push(e);
    if (!this.calleesOf.has(from.id)) this.calleesOf.set(from.id, []);
    this.calleesOf.get(from.id).push(e);
  }

  addConstructorEdges(m, cls, argc, tok) {
    const ctors = (cls.methodsByName.get(cls.lname) || []).filter((x) => x.kind === 'constructor');
    for (const { method } of filterArity(ctors.map((method) => ({ method })), argc)) this.addEdge(m, method, tok, 'new');
    // new MyBatch() / new MyJob() handed to the platform runs these methods asynchronously
    const impl = new Set();
    for (let t = cls; t; t = t.superType) for (const i of implementsOf(t)) impl.add(i);
    const asyncNames = [];
    if (impl.has('batchable')) asyncNames.push('start', 'execute', 'finish');
    if (impl.has('queueable') || impl.has('schedulable')) asyncNames.push('execute');
    for (const n of asyncNames) for (const { method } of this.findMethods(cls, n, -1, false)) this.addEdge(m, method, tok, 'async');
  }

  resolveCalls(m) {
    if (m.bodyStart < 0) return;
    const { toks, match, inSoql } = m.file;
    const vars = this.varTypes(m);
    for (let k = m.bodyStart + 1; k < m.bodyEnd; k++) {
      const t = toks[k];
      if (t.type !== 'id' || toks[k + 1]?.v !== '(' || inSoql[k] || CALL_SKIP.has(t.lv)) continue;
      const argc = countArgs(toks, match, k + 1);
      let s = k;
      while (toks[s - 1]?.v === '.' && toks[s - 2]?.type === 'id') s -= 2;
      const chain = [];
      for (let x = s; x <= k; x += 2) chain.push(toks[x].lv);
      const before = toks[s - 1];

      if (before?.type === 'id' && before.lv === 'new') {
        const cls = this.resolveType(chain.join('.'), m.type);
        if (cls) this.addConstructorEdges(m, cls, argc, k);
        continue;
      }

      const name = t.lv;
      let targets = null;
      let kind = 'call';
      if (chain.length === 1) {
        if (before?.v === '.') {
          // receiver is an expression: `new Foo().bar()`, `list[0].bar()`, `get().bar()`
          const r = toks[s - 2];
          let cls = null;
          if (r?.v === ')' && match[s - 2] > 0) {
            const open = match[s - 2];
            if (toks[open - 1]?.type === 'id' && toks[open - 2]?.lv === 'new') cls = this.resolveType(toks[open - 1].lv, m.type);
          } else if (r?.v === ']' && match[s - 2] > 0) {
            const vt = vars.get(toks[match[s - 2] - 1]?.lv);
            if (vt?.elem) cls = this.resolveType(vt.elem, m.type);
          }
          if (cls) targets = this.findMethods(cls, name, argc, true);
          else { targets = this.guess(name, argc); kind = 'guess'; }
        } else {
          targets = this.findInScope(m.type, name, argc);
        }
      } else {
        const recv = chain.slice(0, -1);
        if (recv.length === 1 && recv[0] === 'this') targets = this.findMethods(m.type, name, argc, true);
        else if (recv.length === 1 && recv[0] === 'super') targets = m.type.superType ? this.findMethods(m.type.superType, name, argc, false) : null;
        else {
          let cls = null;
          let knownNonUser = false;
          const varName = recv.length === 1 ? recv[0] : recv.length === 2 && recv[0] === 'this' ? recv[1] : null;
          if (varName && vars.has(varName)) {
            cls = this.resolveType(vars.get(varName).name, m.type);
            knownNonUser = !cls;
            if (cls) targets = this.findMethods(cls, name, argc, true);
          } else {
            cls = this.resolveType(recv.join('.'), m.type);
            if (cls) targets = this.findMethods(cls, name, argc, false);
            else knownNonUser = SYSTEM_RECEIVERS.has(recv[0]);
          }
          if (!cls && !knownNonUser) { targets = this.guess(name, argc); kind = 'guess'; }
        }
      }
      if (targets) for (const { method, dispatch } of targets) this.addEdge(m, method, k, dispatch ? 'dispatch' : kind);
    }
  }

  // ---------- field analysis ----------

  /** Returns Map<methodId, { method, refs: [{ access, how, confidence, line, tok }] }> */
  analyzeField(objectApi, fieldApi) {
    const O = objectApi.toLowerCase();
    const F = fieldApi.toLowerCase();
    const out = new Map();
    for (const m of this.methods) {
      if (m.bodyStart < 0) continue;
      const refs = this.findRefs(m, O, F);
      if (refs.length) out.set(m.id, { method: m, refs });
    }
    return out;
  }

  findRefs(m, O, F) {
    const { toks } = m.file;
    const refs = [];
    let vars = null;
    const V = () => vars || (vars = this.varTypes(m));
    for (let k = m.bodyStart + 1; k < m.bodyEnd; k++) {
      const t = toks[k];
      let r = null;
      if (t.type === 'id' && t.lv === F) r = this.classifyIdent(m, k, O, V);
      else if (t.type === 'str' && t.lv.includes(F)) r = this.classifyString(m, k, O, F, V);
      if (r) refs.push({ ...r, line: t.line, col: t.col, tok: k });
    }
    return refs;
  }

  classifyIdent(m, k, O, V) {
    const { toks, match } = m.file;
    const prev = toks[k - 1];
    const next = toks[k + 1];
    if (next?.v === '(') return null; // a method with the same name
    const access = WRITE_OPS.has(next?.v) ? 'write' : 'read';

    const soql = m.file.soqlAt(k);
    if (soql) {
      if (prev?.v === ':') return null; // bind variable
      if (soql.isSosl) {
        const open = enclosingParen(toks, match, k, soql.start);
        return open > 0 && toks[open - 1]?.lv === O ? ref('read', 'soql', 'sure') : null;
      }
      if (prev?.v === '.') {
        let s = k;
        while (toks[s - 1]?.v === '.' && toks[s - 2]?.type === 'id') s -= 2;
        if (toks[s - 1]?.v !== ':') {
          const rel = toks[k - 2].lv;
          if (rel === O) return ref('read', 'soql', 'sure');
          if (rel.endsWith('__r')) return ref('read', 'soql', 'possible');
          return null;
        }
        // otherwise it's a bind expression like :acc.Field — fall through to Apex rules
      } else {
        const from = soql.scope.fromAt(k);
        if (from === O) return ref('read', 'soql', 'sure');
        if (from && from.endsWith('__r')) return ref('read', 'soql', 'possible');
        return null;
      }
    }

    if (prev?.v === '.') {
      const r = toks[k - 2];
      if (!r) return null;
      if (r.type === 'id') {
        if (toks[k - 3]?.v === '.') {
          const base = toks[k - 4];
          if (r.lv === 'fields') return base?.lv === O ? ref('read', 'schema', 'sure') : null; // Schema.SObjectType.Account.fields.X
          if (base?.lv === 'this' && V().has(r.lv)) return byType(V().get(r.lv).name, access, O);
          if (r.lv === O) return ref(access, base?.lv === 'schema' ? 'schema' : 'field', 'sure'); // opp.Account.X
          return ref(access, 'field', 'possible');
        }
        const vt = V().get(r.lv);
        if (vt) return byType(vt.name, access, O);
        if (r.lv === O) {
          // SObjectField token: Account.Industry (e.g. sObj.put(Account.Industry, v))
          const isPut = toks[k - 3]?.v === '(' && toks[k - 4]?.lv === 'put';
          return ref(isPut ? 'write' : 'read', 'schema', 'sure');
        }
        return ref(access, 'field', 'possible');
      }
      if (r.v === ']' && match[k - 2] > 0) {
        const open = match[k - 2];
        const before = toks[open - 1];
        if (before?.type === 'id') {
          if ((before.lv === 'new' || before.lv === 'old') && toks[open - 3]?.lv === 'trigger') {
            return m.type.kind === 'trigger' && m.type.triggerObject === O ? ref(access, 'field', 'sure') : ref(access, 'field', 'possible');
          }
          const vt = V().get(before.lv);
          if (vt) return byType(vt.elem, access, O);
        }
        return ref(access, 'field', 'possible');
      }
      if (r.v === ')' && match[k - 2] > 0) {
        const ty = this.typeOfParenExpr(m, k - 2, V);
        return ty ? byType(ty, access, O) : ref(access, 'field', 'possible');
      }
      return ref(access, 'field', 'possible');
    }

    // new Account(Industry = 'x')
    if (next?.v === '=') {
      const open = enclosingParen(toks, match, k, m.bodyStart);
      if (open > 0 && toks[open - 2]?.lv === 'new') {
        return toks[open - 1]?.lv === O ? ref('write', 'constructor', 'sure') : null;
      }
    }
    return null;
  }

  // Type of `(...)` used as a receiver: casts and Map/List .get() calls.
  typeOfParenExpr(m, closeIdx, V) {
    const { toks, match } = m.file;
    const open = match[closeIdx];
    if (toks[open + 1]?.v === '(' && match[open + 1] > 0) {
      const T = readType(toks, open + 2);
      if (T && T.end === match[open + 1]) return T.array ? null : T.name; // ((Account) x).Field
    }
    const callee = toks[open - 1];
    if (callee?.type === 'id' && toks[open - 2]?.v === '.') {
      const recv = toks[open - 3];
      if (recv?.type === 'id') {
        if ((recv.lv === 'newmap' || recv.lv === 'oldmap') && toks[open - 5]?.lv === 'trigger' && m.type.kind === 'trigger') return m.type.triggerObject;
        const vt = V().get(recv.lv);
        if (vt && (callee.lv === 'get' || callee.lv === 'remove')) return vt.elem;
        if (vt && callee.lv === 'clone') return vt.name;
      }
    }
    return null;
  }

  classifyString(m, k, O, F, V) {
    const { toks } = m.file;
    const s = toks[k].lv.trim();
    if (s === F) {
      const fn = toks[k - 2]?.lv;
      if (toks[k - 1]?.v === '(' && toks[k - 3]?.v === '.' && (fn === 'get' || fn === 'put')) {
        const access = fn === 'put' ? 'write' : 'read';
        const r = toks[k - 4];
        if (r?.type === 'id') {
          const vt = V().get(r.lv);
          if (vt) {
            if (vt.name === O) return ref(access, 'dynamic', 'sure');
            if (vt.name === 'sobject') return ref(access, 'dynamic', 'possible');
            return null; // Map<String,Object>, AggregateResult, etc.
          }
        }
        return ref(access, 'dynamic', 'possible');
      }
      return null;
    }
    if (s === `${O}.${F}`) return ref('read', 'string', 'possible');
    if (/\bselect\b/.test(s) && new RegExp(`\\b${F}\\b`).test(s)) {
      const froms = s.match(/\bfrom\s+(\w+)/g) || [];
      const sure = froms.length === 1 && new RegExp(`\\bfrom\\s+${O}\\b`).test(s);
      return ref('read', 'dynamic-soql', sure ? 'sure' : 'possible');
    }
    return null;
  }

  // ---------- graph queries ----------

  callers(methodId, opts = {}) {
    const edges = (this.callersOf.get(methodId) || []).filter((e) => {
      if (!opts.possible && e.kind === 'guess') return false;
      if (!opts.tests && this.methodsById.get(e.from).isTest) return false;
      return true;
    });
    // group multiple call sites from the same caller
    const byFrom = new Map();
    for (const e of edges) {
      if (!byFrom.has(e.from)) byFrom.set(e.from, { from: e.from, kinds: new Set(), lines: [] });
      const g = byFrom.get(e.from);
      g.kinds.add(e.kind);
      g.lines.push(e.line);
    }
    return [...byFrom.values()];
  }

  /** All code paths from an entry point (or a method nobody calls) down to each root method. */
  entryPaths(rootIds, opts = {}) {
    const maxPaths = opts.maxPaths ?? 400;
    const maxDepth = opts.maxDepth ?? 15;
    const paths = [];
    let truncated = false;
    for (const rootId of rootIds) {
      const stack = [rootId];
      const dfs = (id) => {
        if (paths.length >= maxPaths) { truncated = true; return; }
        const m = this.methodsById.get(id);
        const callers = this.callers(id, opts);
        if (m.entry && ROOT_ENTRY_KINDS.has(m.entry.kind)) {
          paths.push({ ids: [...stack].reverse(), end: 'entry' });
        } else if (!callers.length) {
          paths.push({ ids: [...stack].reverse(), end: 'orphan' });
          return;
        }
        if (stack.length >= maxDepth) {
          if (!(m.entry && ROOT_ENTRY_KINDS.has(m.entry.kind))) paths.push({ ids: [...stack].reverse(), end: 'depth' });
          return;
        }
        for (const c of callers) {
          if (stack.includes(c.from)) continue; // recursion
          stack.push(c.from);
          dfs(c.from);
          stack.pop();
        }
      };
      dfs(rootId);
    }
    return { paths, truncated };
  }
}

function ref(access, how, confidence) {
  return { access, how, confidence };
}

function byType(typeName, access, O) {
  if (!typeName) return ref(access, 'field', 'possible');
  return typeName === O || typeName === "schema." + O ? ref(access, 'field', 'sure')
    : typeName === 'sobject' ? ref(access, 'field', 'possible') : null;
}

function filterArity(found, argc) {
  if (argc < 0 || found.length <= 1) return found;
  const exact = found.filter((f) => f.method.paramCount === argc);
  return exact.length ? exact : found;
}

function countArgs(toks, match, open) {
  const close = match[open];
  if (close < 0) return -1;
  if (close === open + 1) return 0;
  let n = 1;
  for (let x = open + 1; x < close; x++) {
    const v = toks[x].v;
    if ((v === '(' || v === '[' || v === '{') && match[x] > 0) { x = match[x]; continue; }
    if (v === '<' && toks[x - 1]?.type === 'id') {
      const g = readGenericArgs(toks, x);
      if (g) { x = g.end - 1; continue; }
    }
    if (v === ',') n++;
  }
  return n;
}

function enclosingParen(toks, match, k, lo) {
  for (let x = k - 1; x > lo; x--) {
    const v = toks[x].v;
    if ((v === ')' || v === ']' || v === '}') && match[x] >= 0) { x = match[x]; continue; }
    if (v === '(') return x;
    if (v === '{' || v === ';') return -1;
  }
  return -1;
}
