// The OG Executor against a real org.
// Code runs through the Apex SOAP API's executeAnonymous (like the Developer Console), with a
// DebuggingHeader so the debug log of the run comes back in the same response, no trace flag needed.
// Async jobs run later in their own transactions: their logs need a USER_DEBUG trace flag on you.

import { soapEnvelope, parseSoapResult } from './exec-core.js';
import { LEVEL_PRESETS } from '../logs/log-backend.js';

const ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const ids = (list) => list.filter((x) => ID_RE.test(x)).map((x) => `'${x}'`).join(',');
const soqlTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const JOB_FIELDS = 'Id, JobType, Status, ApexClass.Name, MethodName, JobItemsProcessed, TotalJobItems, NumberOfErrors, ExtendedStatus, CreatedDate, CompletedDate, CronTriggerId';
export const CRON_FIELDS = 'Id, CronExpression, State, NextFireTime, PreviousFireTime, TimesTriggered, StartTime, CronJobDetail.Name';

export class SfExecBackend {
  constructor(api, session, logBackend) {
    this.api = api;
    this.session = session;
    this.logs = logBackend;
    this.demo = false;
  }

  /** You: { id, name }. */
  async me() {
    if (this._me) return this._me;
    const id = await this.logs.currentUserId();
    let name = '';
    try { name = (await this.logs.getUsers([id]))[0]?.Name || ''; } catch { /* name is cosmetic */ }
    this._me = { id, name };
    return this._me;
  }

  /** Run Anonymous Apex. preset: 'detail' | 'debug' (what the returned log records). */
  async execute(code, { preset = 'detail', signal } = {}) {
    const ver = this.api.version.replace(/^v/, '');
    let res;
    try {
      res = await fetch(`${this.api.base}/services/Soap/s/${ver}`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
        body: soapEnvelope(this.api.sid, code, preset),
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new Error(`Couldn’t reach ${this.api.base}. Check your network or VPN.`);
    }
    const text = await res.text();
    const r = parseSoapResult(text);
    if (r.fault) {
      const expired = /INVALID_SESSION/i.test(r.fault + (r.faultCode || ''));
      throw new Error(expired ? 'Your Salesforce session expired. Refresh the Salesforce tab and reopen this tool.' : r.fault);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return r;
  }

  jobs(list) {
    if (!list.length) return Promise.resolve([]);
    return this.api.query(`SELECT ${JOB_FIELDS} FROM AsyncApexJob WHERE Id IN (${ids(list)})`);
  }

  /** Jobs you started since `since` (ms): catches jobs from hand-written code too. */
  async recentJobs(since, userId) {
    if (!ID_RE.test(userId || '')) return [];
    return this.api.query(`SELECT ${JOB_FIELDS} FROM AsyncApexJob WHERE CreatedById = '${userId}' AND CreatedDate >= ${soqlTime(since)} AND JobType IN ('BatchApex', 'Queueable', 'ScheduledApex', 'Future') ORDER BY CreatedDate DESC LIMIT 20`);
  }

  crons(list) {
    if (!list.length) return Promise.resolve([]);
    return this.api.query(`SELECT ${CRON_FIELDS} FROM CronTrigger WHERE Id IN (${ids(list)})`);
  }

  /** Debug logs of yours since `since` (ms), newest first. */
  async logsSince(since, userId) {
    if (!ID_RE.test(userId || '')) return [];
    return this.api.query(`SELECT Id, LogUserId, LogUser.Name, Operation, Request, Status, LogLength, DurationMilliseconds, StartTime, Application, Location
      FROM ApexLog WHERE LogUserId = '${userId}' AND StartTime >= ${soqlTime(since)} ORDER BY StartTime DESC LIMIT 50`);
  }

  getLogBody(id) { return this.logs.getLogBody(id); }

  /** When your USER_DEBUG trace flag ends (ms), or null. */
  async traceUntil(userId) {
    const flags = await this.logs.listTraceFlags();
    const f = flags.find((x) => x.TracedEntityId?.slice(0, 15) === userId?.slice(0, 15));
    return f ? Date.parse(String(f.ExpirationDate).replace(/\+0000$/, 'Z')) : null;
  }

  /** Trace yourself for `minutes`, so async jobs write debug logs. Reuses your flag and a debug level if there is one. */
  async traceMe(userId, minutes = 60) {
    const [flags, levels] = await Promise.all([this.logs.listTraceFlags(), this.logs.listDebugLevels()]);
    const mine = flags.find((x) => x.TracedEntityId?.slice(0, 15) === userId.slice(0, 15));
    let levelId = mine?.DebugLevelId
      || levels.find((l) => l.DeveloperName === 'OG_Executor')?.Id
      || levels.find((l) => l.DeveloperName === 'SFDC_DevConsole')?.Id;
    if (!levelId) levelId = await this.logs.createDebugLevel('OG_Executor', LEVEL_PRESETS.standard);
    const start = new Date();
    const end = new Date(Date.now() + minutes * 60000);
    await this.logs.saveTraceFlag({ id: mine?.Id, userId, debugLevelId: levelId, start, end });
    return +end;
  }

  /** Stop a job or a schedule. */
  async abort(id) {
    if (!ID_RE.test(id)) throw new Error('Invalid job id');
    const r = await this.execute(`System.abortJob('${id}');`, { preset: 'debug' });
    if (!r.success) throw new Error(r.compileProblem || r.exceptionMessage || 'Couldn’t stop it');
  }
}
