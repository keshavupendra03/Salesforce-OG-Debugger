// Thin REST / Tooling API client using the browser session id.

export class SfError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readText(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parts = [];
  let got = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    parts.push(dec.decode(value, { stream: true }));
    onProgress(got, total);
  }
  parts.push(dec.decode());
  return parts.join('');
}

export class SfApi {
  constructor({ apiHost, sessionId }) {
    this.base = `https://${apiHost}`;
    this.sid = sessionId;
    this.version = 'v62.0';
  }

  // onProgress(bytesReceived, totalBytes|null) is called while a text body streams in.
  async request(path, { method = 'GET', body, text = false, onProgress, signal } = {}) {
    let res;
    try {
      const headers = { Authorization: `Bearer ${this.sid}`, Accept: text ? 'text/plain, */*' : 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      res = await fetch(this.base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new SfError(`Couldn't reach ${this.base}. Check your network/VPN, or whether your org blocks API access from browser sessions.`, 0);
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      let code;
      try {
        const body = await res.json();
        if (Array.isArray(body) && body[0]?.message) { code = body[0].errorCode; msg = `${code}: ${body[0].message}`; }
      } catch { /* not JSON */ }
      if (res.status === 401) msg += ' — your Salesforce session may have expired. Refresh the Salesforce tab and reopen Salesforce OG Debugger.';
      if (code === 'API_DISABLED_FOR_ORG' || code === 'API_CURRENTLY_DISABLED') msg += ' — your user needs the "API Enabled" permission.';
      throw new SfError(msg, res.status, code);
    }
    if (res.status === 204) return null;
    if (text && onProgress && res.body) return readText(res, onProgress);
    return text ? res.text() : res.json();
  }

  async init() {
    const versions = await this.request('/services/data/');
    if (Array.isArray(versions) && versions.length) this.version = 'v' + versions[versions.length - 1].version;
    return this.version;
  }

  async query(soql, { tooling = false } = {}) {
    let url = `/services/data/${this.version}/${tooling ? 'tooling/' : ''}query/?q=${encodeURIComponent(soql)}`;
    const records = [];
    while (url) {
      const r = await this.request(url);
      records.push(...r.records);
      url = r.done ? null : r.nextRecordsUrl;
    }
    return records;
  }

  async listObjects() {
    const r = await this.request(`/services/data/${this.version}/sobjects/`);
    const noise = /(__History|__Share|__Feed|__ChangeEvent|__Tag|__e|History|Share|Feed|ChangeEvent)$/;
    return r.sobjects
      .filter((o) => o.queryable && !o.deprecatedAndHidden && !noise.test(o.name))
      .map((o) => ({ name: o.name, label: o.label, custom: o.custom }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async listFields(objectName) {
    const r = await this.request(`/services/data/${this.version}/sobjects/${encodeURIComponent(objectName)}/describe/`);
    return r.fields
      .map((f) => ({ name: f.name, label: f.label, type: f.type, custom: f.custom }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}
