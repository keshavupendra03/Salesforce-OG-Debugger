// The OG Executor in demo mode: a pretend org that "runs" Anonymous Apex well enough to show the flow:
// compile errors (unbalanced brackets, unknown classes), exceptions (throw), System.debug output,
// SOQL in the log, and async jobs that move through Queued → Preparing → Processing → Completed.
// IndustryEnrichmentBatch makes callouts: run it with a batch size over 100 and its batches fail
// with "Too many callouts", like they would in a real org.

const HEADER = '62.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,FINEST;NBA,INFO;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,INFO;WAVE,INFO;WORKFLOW,INFO';
const KNOWN = new Set(['list', 'set', 'map', 'exception', 'account', 'contact', 'opportunity', 'lead', 'user', 'string', 'integer', 'date', 'datetime',
  'industryenrichmentbatch', 'industryenrichmentscheduler', 'opportunitycleanupjob', 'accountservice', 'opportunityservice', 'enrichmentclient',
  'leadmapper', 'csvexporter', 'accounttriggerhandler', 'triggerhandler', 'accountcontroller', 'accountintakeresource', 'object', 'sobject']);
const ME = { id: '005000000000001AAA', name: 'Demo User' };

const pad = (n, w = 2) => String(n).padStart(w, '0');
const sfIso = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
let seq = 1;
const fakeId = (prefix) => `${prefix}5g00000${String(seq++).padStart(5, '0')}AAA`.slice(0, 18);

function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}
// lines: ['EVENT|…'] each 0.3 ms apart → a log the Debug Logs parser reads like a real one
function logText(start, head, events) {
  let ns = 0;
  const out = [HEADER, ...head];
  for (const e of events) {
    // indented limit lines, blank lines and stack traces carry no timestamp
    if (/^(\s|$|AnonymousBlock)/.test(e)) { out.push(e); continue; }
    ns += 300000;
    out.push(`${clock(start + ns / 1e6)} (${ns})|${e}`);
  }
  return { body: out.join('\n') + '\n', ms: ns / 1e6 };
}

// the first unbalanced bracket: { line, column, problem }
function bracketProblem(code) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  let line = 1;
  let col = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    col++;
    if (c === '\n') { line++; col = 0; continue; }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i + 1] !== '\n') i++; continue; }
    if (c === "'") { i++; col++; while (i < code.length && code[i] !== "'" && code[i] !== '\n') { if (code[i] === '\\') { i++; col++; } i++; col++; } continue; }
    if ('([{'.includes(c)) stack.push({ c, line, col });
    else if (pairs[c]) {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) return { line, column: col, problem: `Unexpected token '${c}'.` };
    }
  }
  const open = stack.pop();
  return open ? { line: open.line, column: open.col, problem: `Missing closing bracket for '${open.c}'.` } : null;
}

export class DemoExecBackend {
  constructor() {
    this.demo = true;
    this.jobsById = new Map();
    this.cronsById = new Map();
    this.traced = 0;
    this.asyncLogs = []; // { meta, body }
  }

  async me() { return ME; }

  async execute(code, { signal } = {}) {
    await new Promise((r, rej) => {
      const t = setTimeout(r, 450);
      signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('Stopped'), { name: 'AbortError' })); });
    });
    const start = Date.now();
    const lines = code.split('\n');
    const head = lines.map((l) => `Execute Anonymous: ${l}`);
    // compile: brackets, then unknown classes after `new`
    const bp = bracketProblem(code);
    if (bp) return { compiled: false, success: false, line: bp.line, column: bp.column, compileProblem: bp.problem, log: '' };
    for (const [i, l] of lines.entries()) {
      if (/^\s*\/\//.test(l)) continue;
      const m = /\bnew\s+([A-Za-z_][\w.]*)\s*[(<[{]/.exec(l);
      if (m && !KNOWN.has(m[1].toLowerCase()) && !/__c$/i.test(m[1])) return { compiled: false, success: false, line: i + 1, column: m.index + 5, compileProblem: `Invalid type: ${m[1]}`, log: '' };
    }
    const ev = [`USER_INFO|[EXTERNAL]|${ME.id.slice(0, 15)}|demo.user@fieldflow.dev|(GMT+05:30) India Standard Time (Asia/Kolkata)|GMT+05:30`,
      'EXECUTION_STARTED', 'CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex'];
    const vars = {};
    let soql = 0;
    let fail = null;
    for (const [i, raw] of lines.entries()) {
      const l = raw.replace(/\/\/.*$/, '');
      const ln = i + 1;
      for (const q of l.matchAll(/\[\s*(SELECT[^\]]*)\]/gi)) {
        soql++;
        ev.push(`SOQL_EXECUTE_BEGIN|[${ln}]|Aggregations:0|${q[1].trim()}`, `SOQL_EXECUTE_END|[${ln}]|Rows:${3 + (soql % 4)}`);
      }
      const assign = /\b(\w+)\s*=\s*(Database\.executeBatch|System\.enqueueJob|System\.schedule)\s*\(/.exec(l);
      const batch = /Database\.executeBatch\s*\(\s*new\s+(\w+)\s*\(([^)]*)\)\s*(?:,\s*(\d+))?/.exec(l);
      const queue = /System\.enqueueJob\s*\(\s*new\s+(\w+)\s*\(([^)]*)\)/.exec(l);
      const sched = /System\.schedule\s*\(\s*'((?:\\.|[^'])*)'\s*,\s*(\w+|'[^']*')\s*,\s*new\s+(\w+)\s*\(/.exec(l);
      if (batch) {
        const id = this.addJob({ cls: batch[1], type: 'BatchApex', size: +(batch[3] || 200), arg: batch[2], code });
        if (assign) vars[assign[1]] = id;
        ev.push(`METHOD_ENTRY|[${ln}]||Database.executeBatch(Database.Batchable<SObject>, Integer)`, `METHOD_EXIT|[${ln}]||Database.executeBatch(Database.Batchable<SObject>, Integer)`);
      } else if (queue) {
        const id = this.addJob({ cls: queue[1], type: 'Queueable', arg: queue[2], code });
        if (assign) vars[assign[1]] = id;
        ev.push(`METHOD_ENTRY|[${ln}]||System.enqueueJob(Object)`, `METHOD_EXIT|[${ln}]||System.enqueueJob(Object)`);
      } else if (sched) {
        const cronVar = sched[2];
        const expr = cronVar.startsWith("'") ? cronVar.slice(1, -1) : (new RegExp(`\\b${cronVar}\\s*=\\s*'([^']*)'`).exec(code)?.[1] || '0 0 2 * * ?');
        const id = this.addCron({ cls: sched[3], name: sched[1], expr });
        if (assign) vars[assign[1]] = id;
      }
      const abort = /System\.abortJob\s*\(\s*'([a-zA-Z0-9]{15,18})'\s*\)/.exec(l);
      if (abort) {
        const j = this.jobsById.get(abort[1]);
        const c = this.cronsById.get(abort[1]);
        if (j) j.aborted = Date.now();
        if (c) c.State = 'DELETED';
      }
      const dbg = /System\.debug\s*\((.*)\)\s*;/.exec(l);
      if (dbg) {
        let arg = dbg[1].trim();
        let level = 'DEBUG';
        const lv = /^LoggingLevel\.(\w+)\s*,\s*(.*)$/.exec(arg);
        if (lv) { level = lv[1].toUpperCase(); arg = lv[2]; }
        const text = arg.split(/\s*\+\s*/).map((part) => {
          const s = /^'((?:\\.|[^'])*)'$/.exec(part.trim());
          if (s) return s[1].replace(/\\'/g, "'").replace(/\\n/g, '\n');
          if (vars[part.trim()]) return vars[part.trim()];
          if (/UserInfo\.getUserName\(\)/.test(part)) return 'demo.user@fieldflow.dev';
          if (/serializePretty|serialize/.test(part)) return '[ {\n  "Id" : "0015g00000000001AAA",\n  "Name" : "Acme Corp"\n} ]';
          if (/Limits\./.test(part)) return String(soql);
          return `(${part.trim()})`;
        }).join('');
        ev.push(`USER_DEBUG|[${ln}]|${level}|${text}`);
      }
      const thr = /\bthrow\s+new\s+(\w+)\s*\(\s*'((?:\\.|[^'])*)'/.exec(l);
      if (thr) { fail = { line: ln, type: /exception$/i.test(thr[1]) ? thr[1] : 'System.Exception', msg: thr[2] }; break; }
      if (/\bnull\s*\.\s*\w|\(\s*\(\s*\w+\s*\)\s*null\s*\)\s*\./.test(l)) { fail = { line: ln, type: 'System.NullPointerException', msg: 'Attempt to de-reference a null object' }; break; }
    }
    if (fail) {
      ev.push(`EXCEPTION_THROWN|[${fail.line}]|${fail.type}: ${fail.msg}`, `FATAL_ERROR|${fail.type}: ${fail.msg}`, '', `AnonymousBlock: line ${fail.line}, column 1`);
    }
    ev.push('CUMULATIVE_LIMIT_USAGE', 'LIMIT_USAGE_FOR_NS|(default)|', `  Number of SOQL queries: ${soql} out of 100`, '  Number of DML statements: 0 out of 150',
      `  Maximum CPU time: ${8 + soql * 3} out of 10000`, 'CUMULATIVE_LIMIT_USAGE_END', 'CODE_UNIT_FINISHED|execute_anonymous_apex', 'EXECUTION_FINISHED');
    const { body } = logText(start, head, ev);
    return fail
      ? { compiled: true, success: false, line: fail.line, column: 1, exceptionMessage: `${fail.type}: ${fail.msg}`, exceptionStackTrace: `AnonymousBlock: line ${fail.line}, column 1`, log: body }
      : { compiled: true, success: true, line: null, column: null, log: body };
  }

  addJob({ cls, type, size = 0, arg = '', code = '' }) {
    const id = fakeId('707');
    // a null argument (literally, or a variable set to null) makes the job blow up, like it would
    const argVar = arg.trim();
    const nullArg = argVar === 'null' || (argVar && new RegExp(`\\b${argVar}\\s*=\\s*null\\s*;`).test(code));
    const callouts = /^IndustryEnrichmentBatch$/i.test(cls);
    this.jobsById.set(id, {
      Id: id, JobType: type, cls, created: Date.now(), size, total: type === 'BatchApex' ? 4 : 0,
      failWith: nullArg ? 'System.NullPointerException: Attempt to de-reference a null object'
        : type === 'BatchApex' && callouts && size > 100 ? `First error: System.LimitException: Too many callouts: 101` : null,
      batchErrors: type === 'BatchApex' && callouts && size > 100,
      logged: 0,
    });
    return id;
  }

  addCron({ cls, name, expr }) {
    const id = fakeId('08e');
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(2, 0, 0, 0);
    this.cronsById.set(id, {
      Id: id, CronExpression: expr, State: 'WAITING', NextFireTime: sfIso(+next), PreviousFireTime: null, TimesTriggered: 0,
      StartTime: sfIso(Date.now()), CronJobDetail: { Name: name },
    });
    const jid = fakeId('707');
    this.jobsById.set(jid, { Id: jid, JobType: 'ScheduledApex', cls, created: Date.now(), cron: id, total: 0 });
    return id;
  }

  // what a job looks like now, from how long ago it started
  view(j) {
    const t = (Date.now() - j.created) / 1000;
    const base = {
      Id: j.Id, JobType: j.JobType, ApexClass: { Name: j.cls }, MethodName: null, CreatedDate: sfIso(j.created),
      CompletedDate: null, ExtendedStatus: null, NumberOfErrors: 0, JobItemsProcessed: 0, TotalJobItems: j.total, CronTriggerId: j.cron || null,
    };
    if (j.JobType === 'ScheduledApex') return { ...base, Status: this.cronsById.get(j.cron)?.State === 'DELETED' ? 'Aborted' : 'Queued' };
    if (j.aborted) return { ...base, Status: 'Aborted', CompletedDate: sfIso(j.aborted) };
    if (t < 1.5) return { ...base, Status: 'Queued' };
    if (j.JobType === 'BatchApex') {
      if (t < 3) return { ...base, Status: 'Preparing' };
      const done = Math.min(j.total, Math.floor((t - 3) / 1.6));
      const errors = j.batchErrors ? Math.max(0, done - 1) : 0;
      this.logAsync(j, done);
      if (done < j.total) return { ...base, Status: 'Processing', JobItemsProcessed: done, NumberOfErrors: errors, ExtendedStatus: errors ? j.failWith : null };
      return { ...base, Status: j.failWith && !j.batchErrors ? 'Failed' : 'Completed', JobItemsProcessed: j.total, NumberOfErrors: j.batchErrors ? j.total - 1 : 0, ExtendedStatus: j.failWith, CompletedDate: sfIso(j.created + (3 + j.total * 1.6) * 1000) };
    }
    if (t < 3) return { ...base, Status: 'Processing' };
    this.logAsync(j, 1);
    return { ...base, Status: j.failWith ? 'Failed' : 'Completed', ExtendedStatus: j.failWith, CompletedDate: sfIso(j.created + 3000) };
  }

  // async logs appear only while you're traced, like in a real org
  logAsync(j, upto) {
    if (!(this.traced > Date.now())) return;
    while (j.logged < upto) {
      j.logged++;
      const start = j.created + 3000 + j.logged * 1600;
      const errored = j.batchErrors && j.logged > 1;
      const failed = !!j.failWith && !j.batchErrors;
      const ev = ['EXECUTION_STARTED', `CODE_UNIT_STARTED|[EXTERNAL]|01p000000000005|${j.cls}`,
        ...(j.JobType === 'BatchApex' ? [`SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id, Website, Industry FROM Account`, 'SOQL_EXECUTE_END|[4]|Rows:200',
          `USER_DEBUG|[10]|DEBUG|Enriching ${j.size} accounts (batch ${j.logged} of ${j.total})`] : [`USER_DEBUG|[7]|DEBUG|Closing stale opportunities`]),
        ...(errored ? ['EXCEPTION_THROWN|[6]|System.LimitException: Too many callouts: 101', 'FATAL_ERROR|System.LimitException: Too many callouts: 101'] : []),
        ...(failed ? ['EXCEPTION_THROWN|[7]|System.NullPointerException: Attempt to de-reference a null object', 'FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object'] : []),
        `CODE_UNIT_FINISHED|${j.cls}`, 'EXECUTION_FINISHED'];
      const { body, ms } = logText(start, [], ev);
      this.asyncLogs.unshift({
        meta: {
          Id: fakeId('07L'), LogUserId: ME.id, LogUser: { Name: ME.name }, Operation: j.JobType === 'BatchApex' ? 'BatchApex' : 'Queueable', Request: 'Batch',
          Status: errored ? 'Too many callouts: 101' : failed ? 'Attempt to de-reference a null object' : 'Success',
          LogLength: body.length, DurationMilliseconds: Math.round(ms), StartTime: sfIso(start), Application: 'Unknown', Location: 'SystemLog',
        },
        body,
      });
    }
  }

  async jobs(list) { return list.map((id) => this.jobsById.get(id)).filter(Boolean).map((j) => this.view(j)); }
  async recentJobs(since) { return [...this.jobsById.values()].filter((j) => j.created >= since).map((j) => this.view(j)); }
  async crons(list) { return list.map((id) => this.cronsById.get(id)).filter(Boolean).map((c) => ({ ...c })); }
  async logsSince(since) {
    for (const j of this.jobsById.values()) this.view(j); // brings logs up to date
    return this.asyncLogs.filter((l) => Date.parse(l.meta.StartTime.replace('+0000', 'Z')) >= since).map((l) => l.meta);
  }
  async getLogBody(id) { return this.asyncLogs.find((l) => l.meta.Id === id)?.body || ''; }
  async traceUntil() { return this.traced > Date.now() ? this.traced : null; }
  async traceMe(_userId, minutes = 60) { this.traced = Date.now() + minutes * 60000; return this.traced; }
  async abort(id) {
    const j = this.jobsById.get(id);
    const c = this.cronsById.get(id);
    if (j) j.aborted = Date.now();
    if (c) c.State = 'DELETED';
    if (!j && !c) throw new Error('No such job');
  }
}
