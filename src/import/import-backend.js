// Data Import against a real org.
// Insert / update / upsert / delete go through the REST sObject Collections API (up to 200 records a call,
// allOrNone=false so one bad row doesn't sink the batch). REST has no undelete, so that uses the SOAP API.

const ID_RE = /^[a-zA-Z0-9]{15,18}$/;
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlText = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class SfImportBackend {
  constructor(api, session) {
    this.api = api;
    this.session = session;
    this.demo = false;
    this.orgKey = session?.orgId || session?.apiHost || 'org';
  }

  get base() { return `/services/data/${this.api.version}`; }

  /** Objects you can change: [{ name, label, keyPrefix, createable, updateable, deletable, undeletable }]. */
  async listObjects() {
    const r = await this.api.request(`${this.base}/sobjects/`);
    return r.sobjects
      .filter((o) => o.createable || o.updateable || o.deletable)
      .map((o) => ({ name: o.name, label: o.label, keyPrefix: o.keyPrefix, createable: o.createable, updateable: o.updateable, deletable: o.deletable, undeletable: o.undeletable }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describe(name) {
    const r = await this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/describe/`);
    return {
      name: r.name, label: r.label,
      fields: r.fields.map((f) => ({
        name: f.name, label: f.label, type: f.type, length: f.length || 0,
        createable: f.createable, updateable: f.updateable, nillable: f.nillable, defaultedOnCreate: f.defaultedOnCreate,
        idLookup: f.idLookup, externalId: f.externalId, unique: f.unique,
        relationshipName: f.relationshipName || null, referenceTo: f.referenceTo || [],
        picklist: (f.picklistValues || []).filter((p) => p.active).map((p) => ({ value: p.value, label: p.label ?? p.value })),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * One batch. records: what buildRecord made. Returns one result per record, same order:
   * [{ success, id, created, error }]
   */
  async run(action, object, records, { matchField, headers, signal } = {}) {
    const opts = { signal, headers };
    let res;
    if (action === 'insert') {
      res = await this.api.request(`${this.base}/composite/sobjects`, { ...opts, method: 'POST', body: { allOrNone: false, records } });
    } else if (action === 'update') {
      res = await this.api.request(`${this.base}/composite/sobjects`, { ...opts, method: 'PATCH', body: { allOrNone: false, records } });
    } else if (action === 'upsert') {
      const key = encodeURIComponent(matchField || 'Id');
      res = await this.api.request(`${this.base}/composite/sobjects/${encodeURIComponent(object)}/${key}`, { ...opts, method: 'PATCH', body: { allOrNone: false, records } });
    } else if (action === 'delete') {
      const ids = records.map((r) => r.Id);
      if (!ids.every((id) => ID_RE.test(id))) throw new Error('Invalid record id');
      res = await this.api.request(`${this.base}/composite/sobjects?ids=${ids.join(',')}&allOrNone=false`, { ...opts, method: 'DELETE' });
    } else if (action === 'undelete') {
      return this.undelete(records.map((r) => r.Id), signal);
    } else throw new Error(`Unknown action ${action}`);
    return (res || []).map((x) => ({
      success: !!x.success, id: x.id || null, created: x.created ?? null,
      error: x.success ? null : (x.errors || []).map((e) => `${e.statusCode}: ${e.message}${e.fields?.length ? ` (${e.fields.join(', ')})` : ''}`).join('; ') || 'Failed',
    }));
  }

  async undelete(ids, signal) {
    if (!ids.every((id) => ID_RE.test(id))) throw new Error('Invalid record id');
    const ver = this.api.version.replace(/^v/, '');
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">'
      + `<soapenv:Header><urn:SessionHeader><urn:sessionId>${xmlEsc(this.api.sid)}</urn:sessionId></urn:SessionHeader></soapenv:Header>`
      + `<soapenv:Body><urn:undelete>${ids.map((id) => `<urn:ids>${id}</urn:ids>`).join('')}</urn:undelete></soapenv:Body></soapenv:Envelope>`;
    const res = await fetch(`${this.api.base}/services/Soap/u/${ver}`, { method: 'POST', signal, headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' }, body });
    const text = await res.text();
    const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(text);
    if (fault) throw new Error(xmlText(fault[1]));
    return [...text.matchAll(/<result>([\s\S]*?)<\/result>/g)].map(([, r]) => {
      const tag = (n) => { const m = new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(r); return m ? xmlText(m[1]) : null; };
      const ok = tag('success') === 'true';
      return { success: ok, id: tag('id'), created: null, error: ok ? null : `${tag('statusCode') || 'ERROR'}: ${tag('message') || 'Failed'}` };
    });
  }

  recordUrl(id) {
    const ui = this.session?.uiHost;
    if (ui && /\.lightning\.force\.com$/i.test(ui)) return `https://${ui}/lightning/r/${id}/view`;
    return `https://${this.session?.apiHost}/${id}`;
  }

  /** "panasonicindia--preprod" and whether it's a sandbox, for the confirmation. */
  orgLabel() {
    const host = this.session?.apiHost || '';
    const m = /^([\w-]+?)(?:--([\w-]+))?\.(sandbox\.)?my\.salesforce\.com$/i.exec(host);
    return { name: m ? (m[2] ? `${m[1]} · ${m[2]}` : m[1]) : host, sandbox: !!(m && (m[2] || m[3])) };
  }
}
