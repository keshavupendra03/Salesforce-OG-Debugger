// The OG Executor: pure helpers (no DOM, no network) so they run in the tests too.
// - which classes can run async (Batchable / Queueable / Schedulable, also through a parent class)
// - their constructors and parameters, with a sensible Apex value for each type
// - the Anonymous Apex that starts them, and reading the result Salesforce sends back

import { implementsOf } from '../apex/parser.js';

export const KINDS = {
  batch: { label: 'Batch Apex', short: 'Batch', iface: 'Database.Batchable' },
  queueable: { label: 'Queueable', short: 'Queueable', iface: 'Queueable' },
  schedulable: { label: 'Schedulable', short: 'Schedulable', iface: 'Schedulable' },
};
const IFACE_KIND = { batchable: 'batch', queueable: 'queueable', schedulable: 'schedulable' };

// "Database.Batchable<SObject>" → "batchable"
const ifaceKey = (s) => s.toLowerCase().replace(/<.*$/, '').replace(/^(database|system)\./, '');

/** Async kinds a type implements, its own or inherited (walking `extends` through the scanned classes). */
export function asyncKinds(type, typesByName) {
  const out = new Set();
  const seen = new Set();
  for (let t = type; t && !seen.has(t); t = t.extends ? typesByName.get(t.extends.toLowerCase().replace(/<.*$/, '')) : null) {
    seen.add(t);
    for (const i of implementsOf(t)) { const k = IFACE_KIND[ifaceKey(i)]; if (k) out.add(k); }
  }
  return [...out].sort((a, b) => Object.keys(KINDS).indexOf(a) - Object.keys(KINDS).indexOf(b));
}

/**
 * Classes that can be started from Anonymous Apex, from a CodeIndex (or anything with .types: Map).
 * → [{ key, name, display, kinds: ['batch', …], ctors: [{ params: [{ type, name }], line }], callouts, unit, line }]
 */
export function asyncClasses(index) {
  const types = [...(index?.types?.values?.() || [])];
  const byName = new Map();
  for (const t of types) if (t.kind === 'class' && !t.outer) byName.set(t.lname, t);
  const out = [];
  for (const t of types) {
    if (t.kind !== 'class' || t.isTest || t.mods?.has('abstract') || t.mods?.has('private') && t.outer) continue;
    const kinds = asyncKinds(t, byName);
    if (!kinds.length) continue;
    const ctors = t.methods.filter((m) => m.kind === 'constructor' && !m.mods.has('private'))
      .map((m) => ({ params: paramsOf(m), line: m.startLine }));
    // no constructor written: Apex gives a public no-argument one
    const hasPrivateOnly = !ctors.length && t.methods.some((m) => m.kind === 'constructor');
    if (!ctors.length && !hasPrivateOnly) ctors.push({ params: [], line: null });
    out.push({
      key: t.key, name: t.name, display: t.display, kinds, ctors, line: t.line,
      callouts: [...implementsOf(t)].some((i) => ifaceKey(i) === 'allowscallouts'),
      stateful: [...implementsOf(t)].some((i) => ifaceKey(i) === 'stateful'),
      unit: t.file?.unit ? { id: t.file.unit.id, name: t.file.unit.name } : null,
    });
  }
  return out.sort((a, b) => a.display.localeCompare(b.display));
}

/** Parameters of a parsed method: [{ type: 'List<Opportunity>', name: 'opps' }]. */
export function paramsOf(m) {
  if (!m || m.paramOpen < 0 || m.paramClose <= m.paramOpen + 1) return [];
  const toks = m.file.toks.slice(m.paramOpen + 1, m.paramClose);
  const groups = [[]];
  let depth = 0;
  for (const t of toks) {
    if (t.v === '<') depth++;
    else if (t.v === '>') depth--;
    if (t.v === ',' && depth === 0) { groups.push([]); continue; }
    if (t.type === 'annot' || t.lv === 'final') continue;
    groups[groups.length - 1].push(t);
  }
  return groups.filter((g) => g.length >= 2).map((g) => ({
    name: g[g.length - 1].v,
    type: g.slice(0, -1).map((t) => t.v).join('').replace(/,/g, ', '),
  }));
}

const PRIMS = {
  string: "''", id: "''", integer: '0', long: '0L', decimal: '0', double: '0.0', boolean: 'false',
  date: 'Date.today()', datetime: 'Datetime.now()', time: 'Time.newInstance(0, 0, 0, 0)', blob: "Blob.valueOf('')", object: 'null',
};

/**
 * A starting value for a parameter of `type`. isSObject(name) says whether a name is an SObject:
 * then a List gets a small query, so the job has something to work on.
 */
export function defaultValue(type, isSObject = () => false) {
  const t = String(type || '').trim();
  const low = t.toLowerCase();
  if (PRIMS[low]) return PRIMS[low];
  const gen = /^(list|set)<\s*([\w.]+)\s*>$/i.exec(t);
  if (gen) {
    const inner = gen[2];
    if (gen[1].toLowerCase() === 'list' && isSObject(inner)) return `[SELECT Id FROM ${inner} LIMIT 200]`;
    if (gen[1].toLowerCase() === 'set' && inner.toLowerCase() === 'id') return 'new Set<Id>()';
    return `new ${gen[1][0].toUpperCase()}${gen[1].slice(1).toLowerCase()}<${inner}>()`;
  }
  if (/^map</i.test(t)) return `new ${t}()`;
  if (/\[\]$/.test(t)) return `new ${t.replace(/\[\]$/, '')}[]{}`;
  if (isSObject(t)) return `new ${t}()`;
  if (/^[A-Z]\w*(\.\w+)*$/.test(t)) return `new ${t}()`;
  return 'null';
}

/** A readable name for the job, e.g. "IndustryEnrichmentScheduler · OG 2026-10-19 10:05". */
export function jobName(cls, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${cls} · OG ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

export const CRON_PRESETS = [
  ['0 0 * * * ?', 'Every hour, on the hour'],
  ['0 0 2 * * ?', 'Every day at 2:00 AM'],
  ['0 0 8 ? * MON-FRI', 'Weekdays at 8:00 AM'],
  ['0 0 6 ? * MON', 'Every Monday at 6:00 AM'],
  ['0 0 0 1 * ?', 'First day of every month, midnight'],
  ['0 30 22 * * ?', 'Every night at 10:30 PM'],
];

/** A short English reading of common cron expressions (Salesforce: sec min hour dom month dow [year]). */
export function describeCron(expr) {
  const preset = CRON_PRESETS.find(([c]) => c === String(expr).trim());
  if (preset) return preset[1];
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length < 6 || f.length > 7) return 'Needs 6 or 7 fields: seconds minutes hours day-of-month month day-of-week [year]';
  const [s, m, hr, dom, mon, dow] = f;
  if (!/^\d+$/.test(s)) return 'Seconds must be a single number (usually 0)';
  if (dom !== '?' && dow !== '?') return 'Use ? in either day-of-month or day-of-week';
  const time = /^\d+$/.test(hr) && /^\d+$/.test(m) ? `at ${hr.padStart(2, '0')}:${m.padStart(2, '0')}` : `minute ${m}, hour ${hr}`;
  const day = dow !== '?' && dow !== '*' ? `on ${dow}` : dom !== '?' && dom !== '*' ? `on day ${dom}` : 'every day';
  return `${day[0].toUpperCase()}${day.slice(1)} ${time}${mon !== '*' ? ` in month ${mon}` : ''}`;
}

const apexStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// a variable name for a parameter that can't clash with Apex keywords or the job vars
const varName = (n) => (/^(job|jobid|cronid|list|set|map|date|integer|string|id|object)$/i.test(n) ? `${n}Arg` : n);

/**
 * The Anonymous Apex that runs a class.
 * o: { cls, kind, ctor: { params }, args: { [name]: expr }, batchSize, cron, jobName, delay, runNow }
 * Job ids are printed as "OG_JOB_ID <id>" / "OG_CRON_ID <id>" so the result can pick them up.
 */
export function generate(o) {
  const params = o.ctor?.params || [];
  const decls = params.map((p) => `${p.type} ${varName(p.name)} = ${(o.args?.[p.name] ?? '').trim() || 'null'};`);
  const newExpr = `new ${o.cls}(${params.map((p) => varName(p.name)).join(', ')})`;
  const head = [`// The OG Executor · ${o.cls} (${KINDS[o.kind]?.label || o.kind})`];
  if (decls.length) head.push('', '// constructor arguments: edit these', ...decls);
  const body = [];
  if (o.kind === 'batch') {
    const size = Math.max(1, Math.min(2000, Number(o.batchSize) || 200));
    body.push(`Id jobId = Database.executeBatch(${newExpr}, ${size});`, "System.debug('OG_JOB_ID ' + jobId);");
  } else if (o.kind === 'queueable') {
    const delay = Math.max(0, Math.min(10, Number(o.delay) || 0));
    body.push(delay ? `Id jobId = System.enqueueJob(${newExpr}, ${delay}); // starts in ${delay} min` : `Id jobId = System.enqueueJob(${newExpr});`,
      "System.debug('OG_JOB_ID ' + jobId);");
  } else if (o.kind === 'schedulable') {
    if (o.runNow) {
      body.push('// runs execute() once, right now, in this transaction (nothing is scheduled)', `${newExpr}.execute(null);`);
    } else {
      body.push(`String cronExpr = ${apexStr(o.cron || CRON_PRESETS[1][0])}; // ${describeCron(o.cron || CRON_PRESETS[1][0])}`,
        `Id cronId = System.schedule(${apexStr(o.jobName || jobName(o.cls))}, cronExpr, ${newExpr});`,
        "System.debug('OG_CRON_ID ' + cronId);");
    }
  }
  return [...head, '', ...body, ''].join('\n');
}

/** Job ids printed by generated code (or anyone): OG_JOB_ID 707… / OG_CRON_ID 08e… */
export function idsFromDebug(lines) {
  const jobs = new Set();
  const crons = new Set();
  for (const l of lines) {
    for (const m of String(l).matchAll(/OG_JOB_ID\s+([a-zA-Z0-9]{15,18})/g)) jobs.add(m[1]);
    for (const m of String(l).matchAll(/OG_CRON_ID\s+([a-zA-Z0-9]{15,18})/g)) crons.add(m[1]);
  }
  return { jobs: [...jobs], crons: [...crons] };
}

// ---------- the SOAP executeAnonymous call (Apex API) ----------

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');

// what the log records: "debug" keeps it short, "detail" is what the Developer Console uses
export const LOG_PRESETS = {
  debug: { Apex_code: 'Debug', Apex_profiling: 'Info', Db: 'Info', System: 'Info', Workflow: 'Info', Validation: 'Info', Callout: 'Info' },
  detail: { Apex_code: 'Finest', Apex_profiling: 'Info', Db: 'Finest', System: 'Debug', Workflow: 'Info', Validation: 'Info', Callout: 'Info' },
};

/** The SOAP envelope for executeAnonymous with a DebuggingHeader, so the log comes back in the response. */
export function soapEnvelope(sessionId, code, preset = 'detail') {
  const cats = Object.entries(LOG_PRESETS[preset] || LOG_PRESETS.detail)
    .map(([c, l]) => `<apex:categories><apex:category>${c}</apex:category><apex:level>${l}</apex:level></apex:categories>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">'
    + `<soapenv:Header><apex:DebuggingHeader>${cats}<apex:debugLevel>DETAIL</apex:debugLevel></apex:DebuggingHeader>`
    + `<apex:SessionHeader><apex:sessionId>${xmlEsc(sessionId)}</apex:sessionId></apex:SessionHeader></soapenv:Header>`
    + `<soapenv:Body><apex:executeAnonymous><apex:String>${xmlEsc(code)}</apex:String></apex:executeAnonymous></soapenv:Body>`
    + '</soapenv:Envelope>';
}

/** Read the SOAP response: { compiled, success, line, column, compileProblem, exceptionMessage, exceptionStackTrace, log } or { fault }. */
export function parseSoapResult(xml) {
  const tag = (name) => {
    const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
    return m ? xmlUnesc(m[1]) : null;
  };
  const fault = tag('faultstring');
  if (fault != null) return { fault, faultCode: tag('faultcode') };
  const num = (n) => { const v = Number(tag(n)); return Number.isFinite(v) && v > 0 ? v : null; };
  return {
    compiled: tag('compiled') === 'true',
    success: tag('success') === 'true',
    line: num('line'),
    column: num('column'),
    compileProblem: tag('compileProblem') || null,
    exceptionMessage: tag('exceptionMessage') || null,
    exceptionStackTrace: tag('exceptionStackTrace') || null,
    log: tag('debugLog') || '',
  };
}

/** "Class.Foo.bar: line 12, column 1\nAnonymousBlock: line 3, column 1" → [{ where, line, column, anon }] */
export function parseStack(trace) {
  return String(trace || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(.*?):\s*line (\d+)(?:,\s*column (\d+))?/.exec(l);
    return m ? { where: m[1], line: +m[2], column: m[3] ? +m[3] : null, anon: /^AnonymousBlock$/i.test(m[1]) } : { where: l, line: null, column: null, anon: false };
  });
}

export const TERMINAL = new Set(['Completed', 'Failed', 'Aborted']);
