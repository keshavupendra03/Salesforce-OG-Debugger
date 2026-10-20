// Suggestions while typing Anonymous Apex in The OG Executor. Pure: the caller passes what it knows.
// meta: {
//   classes: [{ name, statics: [{ name, params: [{type,name}], ret }], methods: [...] }],   // the org's Apex (from the scan)
//   objects: [{ name, label }],                                                              // SObjects
//   fields(objName) → [{ name, label, type }] | undefined (not loaded yet) | null (unknown)
// }
// Returns { from, to, items: [{ label, insert, kind, detail }], need: [objects to load] }.
// In `insert`, ⟂ marks where the caret goes.

export const CARET = '⟂';

const KEYWORDS = ['if', 'else', 'for', 'while', 'do', 'return', 'new', 'try', 'catch', 'finally', 'throw', 'break', 'continue',
  'insert', 'update', 'upsert', 'delete', 'undelete', 'merge', 'null', 'true', 'false', 'this', 'final', 'static',
  'Integer', 'String', 'Boolean', 'Decimal', 'Double', 'Long', 'Id', 'Date', 'Datetime', 'Time', 'Blob', 'Object', 'SObject',
  'List', 'Set', 'Map', 'Exception'];

const m = (name, args = '', detail = '') => ({ name, args, detail });
// System classes and their most used static members
export const SYSTEM = {
  System: [m('debug', '⟂', 'print to the debug log'), m('debug', 'JSON.serializePretty(⟂)', 'pretty JSON'), m('assert', '⟂, \'message\''), m('assertEquals', 'expected⟂, actual'),
    m('enqueueJob', 'new ⟂()', 'start a Queueable → job Id'), m('schedule', '\'Job name\', \'0 0 2 * * ?\', new ⟂()', 'schedule → CronTrigger Id'),
    m('abortJob', '⟂', 'stop a job or schedule by Id'), m('now', ''), m('today', ''), m('currentTimeMillis', ''), m('isBatch', ''), m('isQueueable', ''),
    m('isFuture', ''), m('isScheduled', ''), m('runAs', 'u⟂')],
  Database: [m('executeBatch', 'new ⟂(), 200', 'start Batch Apex → job Id'), m('query', '\'SELECT Id FROM ⟂\''), m('getQueryLocator', '\'SELECT Id FROM ⟂\''),
    m('countQuery', '\'SELECT COUNT() FROM ⟂\''), m('insert', '⟂, false', 'partial success'), m('update', '⟂, false', 'partial success'),
    m('upsert', '⟂, false'), m('delete', '⟂, false'), m('setSavepoint', '', 'for a dry run'), m('rollback', 'sp⟂', 'undo DML since the savepoint'),
    m('emptyRecycleBin', '⟂')],
  Limits: [m('getQueries', ''), m('getLimitQueries', ''), m('getDmlStatements', ''), m('getLimitDmlStatements', ''), m('getCpuTime', ''),
    m('getLimitCpuTime', ''), m('getHeapSize', ''), m('getLimitHeapSize', ''), m('getQueueableJobs', ''), m('getCallouts', '')],
  JSON: [m('serialize', '⟂'), m('serializePretty', '⟂'), m('deserialize', '⟂, Type.class'), m('deserializeUntyped', '⟂')],
  UserInfo: [m('getUserId', ''), m('getName', ''), m('getUserName', ''), m('getProfileId', ''), m('getOrganizationId', ''), m('getOrganizationName', ''), m('getTimeZone', '')],
  Test: [m('isRunningTest', ''), m('startTest', ''), m('stopTest', '')],
  Schema: [m('getGlobalDescribe', ''), m('describeSObjects', 'new String[]{\'⟂\'}')],
  Math: [m('max', '⟂, b'), m('min', '⟂, b'), m('abs', '⟂'), m('round', '⟂'), m('floor', '⟂'), m('ceil', '⟂'), m('mod', '⟂, b'), m('random', '')],
  String: [m('isBlank', '⟂'), m('isNotBlank', '⟂'), m('join', '⟂, \', \''), m('valueOf', '⟂'), m('format', '\'{0}\', new List<Object>{ ⟂ }'), m('escapeSingleQuotes', '⟂')],
  Date: [m('today', ''), m('newInstance', '2026, 1, ⟂'), m('valueOf', '\'2026-01-31⟂\'')],
  Datetime: [m('now', ''), m('newInstance', '2026, 1, 31, 0, 0, ⟂'), m('valueOf', '\'2026-01-31 00:00:00⟂\'')],
  Id: [m('valueOf', '\'⟂\'')],
  Type: [m('forName', '\'⟂\'')],
  EncodingUtil: [m('base64Encode', '⟂'), m('base64Decode', '⟂'), m('urlEncode', '⟂, \'UTF-8\'')],
  Crypto: [m('generateAesKey', '256'), m('getRandomInteger', '')],
};

// methods on values, by their declared type
const LIST = [m('add', '⟂'), m('addAll', '⟂'), m('size', ''), m('isEmpty', ''), m('get', '⟂'), m('set', '⟂, value'), m('remove', '⟂'), m('contains', '⟂'), m('indexOf', '⟂'), m('clear', ''), m('sort', ''), m('clone', '')];
const SET = [m('add', '⟂'), m('addAll', '⟂'), m('contains', '⟂'), m('containsAll', '⟂'), m('remove', '⟂'), m('size', ''), m('isEmpty', ''), m('clear', '')];
const MAP = [m('put', '⟂, value'), m('get', '⟂'), m('containsKey', '⟂'), m('keySet', ''), m('values', ''), m('remove', '⟂'), m('size', ''), m('isEmpty', '')];
const STRING = [m('length', ''), m('contains', '⟂'), m('startsWith', '⟂'), m('endsWith', '⟂'), m('toUpperCase', ''), m('toLowerCase', ''), m('trim', ''),
  m('split', '\'⟂\''), m('substring', '⟂'), m('replace', '⟂, \'\''), m('equalsIgnoreCase', '⟂'), m('indexOf', '⟂'), m('isNumeric', '')];
const SOBJ = [m('put', '\'⟂\', value'), m('get', '\'⟂\''), m('getSObjectType', ''), m('clone', 'false, true'), m('addError', '\'⟂\'')];
const EXC = [m('getMessage', ''), m('getStackTraceString', ''), m('getLineNumber', ''), m('getTypeName', ''), m('getCause', '')];

// snippets offered by name
export const SNIPPETS = [
  ['debug', 'System.debug(⟂);', 'System.debug'],
  ['debugjson', 'System.debug(JSON.serializePretty(⟂));', 'print anything as pretty JSON'],
  ['for', 'for (Account a : [SELECT Id, Name FROM Account LIMIT 10]) {\n    ⟂\n}', 'loop over a query'],
  ['fori', 'for (Integer i = 0; i < 10; i++) {\n    ⟂\n}', 'counting loop'],
  ['if', 'if (⟂) {\n    \n}', 'if block'],
  ['try', 'try {\n    ⟂\n} catch (Exception e) {\n    System.debug(e.getMessage() + \'\\n\' + e.getStackTraceString());\n}', 'try / catch, prints the error'],
  ['soql', 'List<Account> rows = [SELECT Id, Name FROM Account LIMIT 10⟂];', 'query into a list'],
  ['executebatch', 'Id jobId = Database.executeBatch(new ⟂(), 200);\nSystem.debug(\'OG_JOB_ID \' + jobId);', 'start Batch Apex (job is tracked)'],
  ['enqueuejob', 'Id jobId = System.enqueueJob(new ⟂());\nSystem.debug(\'OG_JOB_ID \' + jobId);', 'start a Queueable (job is tracked)'],
  ['schedule', 'Id cronId = System.schedule(\'⟂Job name\', \'0 0 2 * * ?\', new MySchedulable());\nSystem.debug(\'OG_CRON_ID \' + cronId);', 'schedule a Schedulable'],
  ['dryrun', 'Savepoint sp = Database.setSavepoint();\n⟂\nDatabase.rollback(sp); // nothing above is saved', 'dry run: undo every DML'],
  ['myjobs', 'System.debug(JSON.serializePretty([SELECT Id, ApexClass.Name, JobType, Status, JobItemsProcessed, TotalJobItems, NumberOfErrors, ExtendedStatus\n    FROM AsyncApexJob WHERE CreatedById = :UserInfo.getUserId() ORDER BY CreatedDate DESC LIMIT 10]));', 'my latest async jobs'],
  ['abortmine', 'for (AsyncApexJob j : [SELECT Id FROM AsyncApexJob WHERE CreatedById = :UserInfo.getUserId()\n        AND Status IN (\'Holding\', \'Queued\', \'Preparing\', \'Processing\')]) {\n    System.abortJob(j.Id);\n}', 'stop all my running jobs'],
  ['limits', 'System.debug(\'SOQL \' + Limits.getQueries() + \'/\' + Limits.getLimitQueries() + \' · DML \' + Limits.getDmlStatements() + \'/\' + Limits.getLimitDmlStatements() + \' · CPU \' + Limits.getCpuTime() + \' ms\');', 'print governor limits used'],
  ['insert', 'insert new Account(Name = \'⟂\');', 'create a record'],
];

const COMMON_NEW = [['List<⟂>()', 'List'], ['Set<⟂>()', 'Set'], ['Map<⟂, >()', 'Map'], ['Exception(\'⟂\')', 'Exception']];

/** Local variable declarations in the code: name (lower) → declared type. */
export function localVars(text) {
  const vars = new Map();
  const re = /\b([A-Za-z_][\w.]*(?:\s*<[^;=(){}]*?>)?(?:\[\])?)\s+([a-zA-Z_]\w*)\s*(?==|;|:|\))/g;
  let mt;
  while ((mt = re.exec(text))) {
    const type = mt[1].replace(/\s+/g, '');
    if (/^(return|new|else|throw|insert|update|upsert|delete|undelete|merge|in|instanceof)$/i.test(type)) continue;
    vars.set(mt[2].toLowerCase(), { name: mt[2], type });
  }
  return vars;
}

// where the caret is: inside a string or comment, the code before it is what counts
function inStringOrComment(text, pos) {
  let i = 0;
  while (i < pos) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); if (e < 0 || e >= pos) return true; i = e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); if (e < 0 || e + 2 > pos) return true; i = e + 2; continue; }
    if (c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= pos) return true;
      i = j + 1;
      continue;
    }
    i++;
  }
  return false;
}

const call = (x, kind, detail) => ({
  label: `${x.name}(${x.args.replace(CARET, '').replace(/'[^']*'/g, '…') ? '…' : ''})`,
  insert: `${x.name}(${x.args.includes(CARET) ? x.args : x.args + CARET})`,
  kind, detail: x.detail || detail || '',
});

export function suggest(text, pos, meta = {}) {
  const none = { from: pos, to: pos, items: [], need: [] };
  if (inStringOrComment(text, pos)) return none;
  const before = text.slice(0, pos);
  const wm = /[A-Za-z_]\w*$/.exec(before);
  const word = wm ? wm[0] : '';
  const from = pos - word.length;
  const to = pos + (/^\w*/.exec(text.slice(pos))[0].length);
  const need = [];
  const res = (items) => ({ from, to, items: rank(items, word), need });
  const pre = text.slice(0, from);
  const classes = meta.classes || [];
  const objects = meta.objects || [];
  const isObject = (n) => objects.some((o) => o.name.toLowerCase() === n.toLowerCase());

  // "Something." → its members
  const dot = /([A-Za-z_][\w]*)\s*\.\s*$/.exec(pre);
  if (dot) {
    const name = dot[1];
    const sys = Object.keys(SYSTEM).find((k) => k.toLowerCase() === name.toLowerCase());
    if (sys) return res(SYSTEM[sys].map((x) => call(x, 'method', sys)));
    const cls = classes.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (cls) {
      return res((cls.statics || []).map((s) => ({
        label: `${s.name}(${s.params.map((p) => p.type).join(', ')})`,
        insert: `${s.name}(${s.params.length ? CARET : ''})${s.params.length ? '' : CARET}`,
        kind: 'method', detail: s.ret ? `→ ${s.ret}` : `static · ${cls.name}`,
      })));
    }
    const v = localVars(text).get(name.toLowerCase());
    if (v) return res(membersOf(v.type, meta, classes, need));
    // SObjectType.Account. / Schema.SObjectType … nothing smart there
    return none;
  }

  // after "new"
  if (/\bnew\s+$/.test(pre)) {
    return res([
      ...classes.map((c) => ({ label: c.name, insert: `${c.name}(${CARET})`, kind: 'class', detail: c.kinds?.length ? c.kinds.join(' · ') : 'your class' })),
      ...COMMON_NEW.map(([ins, l]) => ({ label: `${l}<…>`, insert: ins, kind: 'type', detail: 'collection' })),
      ...(word ? objects.map((o) => ({ label: o.name, insert: `${o.name}(${CARET})`, kind: 'object', detail: o.label })) : []),
    ]);
  }

  // inside [SELECT … FROM |]
  if (/\[\s*select\b[^\]]*\bfrom\s+$/i.test(pre)) {
    return res(objects.map((o) => ({ label: o.name, insert: o.name, kind: 'object', detail: o.label })));
  }

  if (!word) return none;
  const items = [];
  for (const [name, body, detail] of SNIPPETS) items.push({ label: name, insert: body, kind: 'snippet', detail });
  for (const v of localVars(text).values()) if (v.name !== word) items.push({ label: v.name, insert: v.name, kind: 'var', detail: v.type });
  for (const k of Object.keys(SYSTEM)) items.push({ label: k, insert: k, kind: 'class', detail: 'Apex system class' });
  for (const c of classes) items.push({ label: c.name, insert: c.name, kind: 'class', detail: c.kinds?.length ? c.kinds.join(' · ') : 'your class' });
  for (const k of KEYWORDS) items.push({ label: k, insert: k, kind: 'kw' });
  if (word.length >= 2) for (const o of objects) items.push({ label: o.name, insert: o.name, kind: 'object', detail: o.label });
  return res(items);
}

function membersOf(type, meta, classes, need) {
  const t = type.replace(/\s+/g, '');
  const low = t.toLowerCase();
  if (/^list<|\[\]$/.test(low)) return LIST.map((x) => call(x, 'method', 'List'));
  if (/^set</.test(low)) return SET.map((x) => call(x, 'method', 'Set'));
  if (/^map</.test(low)) return MAP.map((x) => call(x, 'method', 'Map'));
  if (low === 'string') return STRING.map((x) => call(x, 'method', 'String'));
  if (/exception$/.test(low)) return EXC.map((x) => call(x, 'method', 'Exception'));
  const cls = classes.find((c) => c.name.toLowerCase() === low);
  if (cls) {
    return (cls.methods || []).map((s) => ({
      label: `${s.name}(${s.params.map((p) => p.type).join(', ')})`,
      insert: `${s.name}(${s.params.length ? CARET : ''})${s.params.length ? '' : CARET}`,
      kind: 'method', detail: s.ret ? `→ ${s.ret}` : cls.name,
    }));
  }
  if ((meta.objects || []).some((o) => o.name.toLowerCase() === low)) {
    const f = meta.fields?.(t);
    if (f === undefined) need.push(t);
    return [
      ...(f || []).map((x) => ({ label: x.name, insert: x.name, kind: 'field', detail: `${x.label} · ${x.type}` })),
      ...SOBJ.map((x) => call(x, 'method', 'SObject')),
    ];
  }
  return [];
}

const ORDER = { var: 0, snippet: 1, method: 1, field: 1, class: 2, object: 3, type: 3, kw: 4 };
function rank(items, partial) {
  const p = partial.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.kind}|${it.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const l = it.label.toLowerCase();
    let s;
    if (!p) s = 0;
    else if (l === p) s = it.kind === 'snippet' ? 0 : -1;
    else if (l.startsWith(p)) s = 1;
    else if (l.includes(p)) s = 3;
    else continue;
    out.push([s, it]);
  }
  // nothing typed yet (right after a "."): keep the curated order, most useful first
  out.sort((a, b) => a[0] - b[0] || (p ? (ORDER[a[1].kind] ?? 5) - (ORDER[b[1].kind] ?? 5) || a[1].label.length - b[1].label.length : 0));
  return out.slice(0, 60).map(([, it]) => it);
}
