// Debug-log operations against a real org: users, debug levels, trace flags, Apex logs, org limits.

export const LEVEL_FIELDS = ['ApexCode', 'ApexProfiling', 'Callout', 'Database', 'System', 'Validation', 'Visualforce', 'Workflow', 'Wave', 'Nba'];
export const LOG_LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];

export const LEVEL_PRESETS = {
  standard: { ApexCode: 'FINEST', ApexProfiling: 'INFO', Callout: 'INFO', Database: 'INFO', System: 'DEBUG', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', Wave: 'INFO', Nba: 'INFO' },
  detailed: { ApexCode: 'FINEST', ApexProfiling: 'FINEST', Callout: 'FINEST', Database: 'FINEST', System: 'FINE', Validation: 'INFO', Visualforce: 'FINER', Workflow: 'FINER', Wave: 'INFO', Nba: 'INFO' },
  light: { ApexCode: 'DEBUG', ApexProfiling: 'INFO', Callout: 'INFO', Database: 'INFO', System: 'INFO', Validation: 'INFO', Visualforce: 'NONE', Workflow: 'INFO', Wave: 'NONE', Nba: 'NONE' },
};

const ID_RE = /^[a-zA-Z0-9]{15,18}$/;
function checkIds(ids) {
  for (const id of ids) if (!ID_RE.test(id)) throw new Error(`Invalid record id: ${id}`);
  return ids;
}
const soqlDate = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const likeEscape = (s) => s.replace(/[\\'%_]/g, (c) => '\\' + c);

export class SfLogBackend {
  constructor(api) {
    this.api = api;
  }

  get base() {
    return `/services/data/${this.api.version}`;
  }

  async currentUserId() {
    try { const r = await this.api.request('/services/oauth2/userinfo'); if (r?.user_id) return r.user_id; } catch { /* try next */ }
    try { const r = await this.api.request(`${this.base}/chatter/users/me`); if (r?.id) return r.id; } catch { /* Chatter off */ }
    return null;
  }

  searchUsers(q) {
    const s = likeEscape(q.trim());
    const where = s ? ` AND (Name LIKE '%${s}%' OR Username LIKE '%${s}%')` : '';
    return this.api.query(`SELECT Id, Name, Username FROM User WHERE IsActive = true${where} ORDER BY Name LIMIT 20`);
  }

  // The system user that runs platform-event triggers, some flows and other automation.
  async automatedProcessUser() {
    const [u] = await this.api.query("SELECT Id, Name, Username FROM User WHERE UserType = 'AutomatedProcess' LIMIT 1");
    return u || null;
  }

  async getUsers(ids) {
    if (!ids.length) return [];
    return this.api.query(`SELECT Id, Name, Username FROM User WHERE Id IN (${checkIds(ids).map((i) => `'${i}'`).join(',')})`);
  }

  listDebugLevels() {
    return this.api.query(`SELECT Id, DeveloperName, MasterLabel, ${LEVEL_FIELDS.join(', ')} FROM DebugLevel ORDER BY DeveloperName`, { tooling: true });
  }

  async createDebugLevel(name, levels) {
    const r = await this.api.request(`${this.base}/tooling/sobjects/DebugLevel/`, {
      method: 'POST', body: { DeveloperName: name, MasterLabel: name, ...levels },
    });
    return r.id;
  }

  listTraceFlags() {
    return this.api.query(`SELECT Id, TracedEntityId, LogType, StartDate, ExpirationDate, DebugLevelId FROM TraceFlag
      WHERE LogType = 'USER_DEBUG' AND ExpirationDate > ${soqlDate(new Date())} ORDER BY ExpirationDate DESC`, { tooling: true });
  }

  // Salesforce allows one USER_DEBUG flag per user at a time, so an existing flag is updated in place.
  async saveTraceFlag({ id, userId, debugLevelId, start, end }) {
    const body = { StartDate: start.toISOString(), ExpirationDate: end.toISOString(), DebugLevelId: debugLevelId };
    if (id) {
      checkIds([id]);
      await this.api.request(`${this.base}/tooling/sobjects/TraceFlag/${id}`, { method: 'PATCH', body });
      return id;
    }
    checkIds([userId]);
    const r = await this.api.request(`${this.base}/tooling/sobjects/TraceFlag/`, {
      method: 'POST', body: { ...body, TracedEntityId: userId, LogType: 'USER_DEBUG' },
    });
    return r.id;
  }

  async deleteTraceFlag(id) {
    checkIds([id]);
    await this.api.request(`${this.base}/tooling/sobjects/TraceFlag/${id}`, { method: 'DELETE' });
  }

  listLogs() {
    return this.api.query(`SELECT Id, LogUserId, LogUser.Name, Operation, Request, Status, LogLength, DurationMilliseconds,
      StartTime, Application, Location FROM ApexLog ORDER BY StartTime DESC LIMIT 200`);
  }

  getLogBody(id, { onProgress } = {}) {
    checkIds([id]);
    return this.api.request(`${this.base}/tooling/sobjects/ApexLog/${id}/Body`, { text: true, onProgress });
  }

  async deleteLogs(ids) {
    checkIds(ids);
    for (let i = 0; i < ids.length; i += 200) {
      const res = await this.api.request(`${this.base}/composite/sobjects?allOrNone=false&ids=${ids.slice(i, i + 200).join(',')}`, { method: 'DELETE' });
      const failed = (res || []).find((r) => !r.success);
      if (failed) throw new Error(failed.errors?.[0]?.message || 'Some logs could not be deleted');
    }
  }

  orgLimits() {
    return this.api.request(`${this.base}/limits/`);
  }
}
