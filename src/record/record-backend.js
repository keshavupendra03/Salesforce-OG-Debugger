// One record, every field: describe + read + update / create / delete, for a real org (REST API)
// and for the demo org (in memory, on top of the Data Export sample data).

import { DemoDataBackend, DEMO_SCHEMA, demoId } from '../data/demo-data-backend.js';
import { lightningHost, recordViewUrl } from './sf-urls.js';

// the describe fields the All data page uses
const pickField = (f) => ({
  name: f.name, label: f.label, type: f.type, length: f.length, precision: f.precision, scale: f.scale, digits: f.digits,
  nillable: f.nillable, updateable: f.updateable, createable: f.createable, calculated: f.calculated, autoNumber: f.autoNumber,
  defaultedOnCreate: f.defaultedOnCreate, restrictedPicklist: f.restrictedPicklist, externalId: f.externalId, unique: f.unique,
  encrypted: f.encrypted, htmlFormatted: f.htmlFormatted, nameField: f.nameField, inlineHelpText: f.inlineHelpText || null,
  referenceTo: f.referenceTo || [], relationshipName: f.relationshipName || null,
  picklist: (f.picklistValues || []).filter((p) => p.active).map((p) => ({ value: p.value, label: p.label ?? p.value })),
});

export class SfRecordBackend {
  constructor(api, session) {
    this.api = api;
    this.session = session;
    this.ui = lightningHost(session);
    this.describes = new Map();
    this.global = null;
  }

  get base() { return `/services/data/${this.api.version}`; }

  /** The object an id belongs to, from its 3-character key prefix. */
  async objectForId(id) {
    this.global ||= this.api.request(`${this.base}/sobjects/`).then((r) => r.sobjects);
    const list = await this.global;
    const o = list.find((s) => s.keyPrefix && s.keyPrefix === id.slice(0, 3));
    return o ? o.name : null;
  }

  describe(name) {
    if (!this.describes.has(name)) {
      this.describes.set(name, this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/describe/`).then((d) => ({
        name: d.name, label: d.label, labelPlural: d.labelPlural, keyPrefix: d.keyPrefix,
        updateable: d.updateable, createable: d.createable, deletable: d.deletable,
        fields: d.fields.map(pickField),
      })).catch((e) => { this.describes.delete(name); throw e; }));
    }
    return this.describes.get(name);
  }

  get(name, id) { return this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/${id}`); }
  update(name, id, fields) { return this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/${id}`, { method: 'PATCH', body: fields }); }
  async create(name, fields) { return (await this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/`, { method: 'POST', body: fields })).id; }
  remove(name, id) { return this.api.request(`${this.base}/sobjects/${encodeURIComponent(name)}/${id}`, { method: 'DELETE' }); }

  recordUrl(name, id) { return recordViewUrl(this.ui, name, id); }
}

// ---------- demo ----------

const READ_ONLY = new Set(['Id', 'CreatedDate', 'LastModifiedDate', 'CreatedById']);
const REQUIRED = { Account: ['Name'], Contact: ['LastName'], Opportunity: ['Name', 'StageName', 'CloseDate'], Lead: ['LastName', 'Company'] };
const LENGTHS = { string: 255, email: 80, phone: 40, url: 255, picklist: 255, textarea: 32768 };

export class DemoRecordBackend {
  constructor() {
    this.data = new DemoDataBackend();
    this.db = this.data.db;
    this.seq = 900;
  }

  async objectForId(id) {
    return Object.keys(DEMO_SCHEMA).find((k) => id.startsWith(DEMO_SCHEMA[k].prefix)) || null;
  }

  async describe(name) {
    const s = DEMO_SCHEMA[name];
    if (!s) throw new Error(`NOT_FOUND: The requested resource does not exist`);
    const req = new Set(REQUIRED[name] || []);
    return {
      name, label: name.replace(/([a-z])([A-Z])/g, '$1 $2'), keyPrefix: s.prefix, updateable: name !== 'User', createable: name !== 'User', deletable: name !== 'User',
      fields: s.fields.map((f) => {
        const formula = name === 'Contact' && f.name === 'Name';
        const ro = READ_ONLY.has(f.name) || formula || f.name === 'IsClosed' || f.name === 'IsWon';
        return {
          ...f, length: LENGTHS[f.type] || null, precision: f.type === 'currency' ? 18 : null, scale: f.type === 'currency' ? 2 : null,
          nillable: !req.has(f.name) && f.name !== 'Id', updateable: !ro, createable: !ro, calculated: formula,
          defaultedOnCreate: f.type === 'boolean' || f.name === 'OwnerId', restrictedPicklist: f.type === 'picklist' && f.name !== 'Title',
          nameField: f.name === 'Name', inlineHelpText: f.name === 'Industry' ? 'The industry this account works in.' : null,
          picklist: f.picklist || [],
        };
      }),
    };
  }

  async get(name, id) {
    await new Promise((r) => setTimeout(r, 120));
    const row = this.db[name]?.find((r) => r.Id === id);
    if (!row) throw new Error('NOT_FOUND: The requested resource does not exist');
    const out = { attributes: { type: name, url: `/services/data/v62.0/sobjects/${name}/${id}` } };
    for (const f of DEMO_SCHEMA[name].fields) out[f.name] = row[f.name] ?? null;
    return out;
  }

  async update(name, id, fields) {
    await new Promise((r) => setTimeout(r, 200));
    const row = this.db[name]?.find((r) => r.Id === id);
    if (!row) throw new Error('ENTITY_IS_DELETED: entity is deleted');
    for (const f of REQUIRED[name] || []) {
      if (f in fields && (fields[f] == null || fields[f] === '')) {
        const e = new Error(`REQUIRED_FIELD_MISSING: Required fields are missing: [${f}]`);
        e.fields = [f];
        throw e;
      }
    }
    if (name === 'Account' && fields.AnnualRevenue != null && fields.AnnualRevenue < 0) {
      const e = new Error('FIELD_CUSTOM_VALIDATION_EXCEPTION: Annual Revenue can’t be negative.');
      e.fields = ['AnnualRevenue'];
      throw e;
    }
    Object.assign(row, fields, { LastModifiedDate: new Date().toISOString().replace(/\.\d{3}Z$/, '.000+0000') });
    if (name === 'Contact' && ('FirstName' in fields || 'LastName' in fields)) row.Name = [row.FirstName, row.LastName].filter(Boolean).join(' ');
    return null;
  }

  async create(name, fields) {
    await new Promise((r) => setTimeout(r, 200));
    for (const f of REQUIRED[name] || []) {
      if (fields[f] == null || fields[f] === '') {
        const e = new Error(`REQUIRED_FIELD_MISSING: Required fields are missing: [${f}]`);
        e.fields = [f];
        throw e;
      }
    }
    const id = demoId(DEMO_SCHEMA[name].prefix, ++this.seq);
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '.000+0000');
    this.db[name].push({ ...fields, Id: id, CreatedDate: now, LastModifiedDate: now, CreatedById: this.db.User[0].Id, OwnerId: fields.OwnerId || this.db.User[0].Id });
    return id;
  }

  async remove(name, id) {
    await new Promise((r) => setTimeout(r, 200));
    const list = this.db[name];
    const i = list ? list.findIndex((r) => r.Id === id) : -1;
    if (i < 0) throw new Error('ENTITY_IS_DELETED: entity is deleted');
    list.splice(i, 1);
  }

  recordUrl(name, id) { return `https://demo.example.lightning.force.com/lightning/r/${name}/${id}/view`; }

  // a few ids the demo pages start from
  sampleId(name = 'Account') { return this.db[name][0].Id; }
}
