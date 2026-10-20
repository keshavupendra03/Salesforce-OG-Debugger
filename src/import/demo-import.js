// Data Import in demo mode. It changes the same pretend org that Data Export queries, so an insert
// shows up in your next SELECT. It answers like Salesforce: required fields, read-only fields,
// restricted picklists, unknown Ids, the Recycle Bin for delete / undelete.

import { to18 } from '../data/soql.js';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// what Salesforce sets itself, and what an insert must have
const SYSTEM = new Set(['id', 'createddate', 'lastmodifieddate', 'createdbyid']);
const READONLY = { Contact: ['Name'], Opportunity: ['IsClosed', 'IsWon'], User: ['Name'] };
const REQUIRED = { Account: ['Name'], Contact: ['LastName'], Opportunity: ['Name', 'StageName', 'CloseDate'], Lead: ['LastName', 'Company'], User: ['Username', 'Email', 'LastName'] };
const LOOKUP = { Contact: ['Email'], Lead: ['Email'], User: ['Username'] };

export class DemoImportBackend {
  /** data: the DemoDataBackend Data Export uses (its in-memory records). */
  constructor(data) {
    this.data = data;
    this.demo = true;
    this.orgKey = 'demo';
    this.bin = new Map(); // id → { object, record }
    this.seq = 90000;
  }

  async listObjects() {
    const list = await this.data.listObjects();
    return list.map((o) => ({ ...o, createable: o.name !== 'User', updateable: true, deletable: o.name !== 'User', undeletable: o.name !== 'User' }));
  }

  async describe(name) {
    const d = await this.data.describe(name);
    const ro = new Set((READONLY[d.name] || []).map((x) => x.toLowerCase()));
    const req = new Set((REQUIRED[d.name] || []).map((x) => x.toLowerCase()));
    const lookup = new Set((LOOKUP[d.name] || []).map((x) => x.toLowerCase()));
    return {
      name: d.name, label: d.name,
      fields: d.fields.map((f) => {
        const k = f.name.toLowerCase();
        const fixed = SYSTEM.has(k) || ro.has(k);
        return {
          ...f, length: f.type === 'string' ? 255 : 0,
          createable: !fixed, updateable: !fixed, nillable: !req.has(k), defaultedOnCreate: k === 'ownerid',
          idLookup: k === 'id' || lookup.has(k), externalId: false,
        };
      }),
    };
  }

  async run(action, object, records, { matchField, signal } = {}) {
    await wait(350 + records.length * 3, signal);
    const d = await this.describe(object);
    const byName = new Map(d.fields.map((f) => [f.name.toLowerCase(), f]));
    const list = this.data.db[object];
    if (!list) throw new Error(`NOT_FOUND: ${object} can’t be imported in the demo org`);
    const prefix = (await this.data.listObjects()).find((o) => o.name === object)?.keyPrefix;
    const find = (id) => list.find((r) => r.Id.slice(0, 15) === String(id).slice(0, 15));
    return records.map((rec) => {
      try {
        if (action === 'delete') {
          const r = find(rec.Id);
          if (!r) return fail(this.bin.has(rec.Id) ? 'ENTITY_IS_DELETED: entity is deleted' : 'INVALID_CROSS_REFERENCE_KEY: invalid cross reference id');
          if (object === 'User') return fail('DELETE_FAILED: Users can’t be deleted. Deactivate them instead.');
          list.splice(list.indexOf(r), 1);
          this.bin.set(r.Id, { object, record: r });
          return ok(r.Id);
        }
        if (action === 'undelete') {
          const b = [...this.bin.entries()].find(([id]) => id.slice(0, 15) === String(rec.Id).slice(0, 15));
          if (!b) return fail('UNDELETE_FAILED: Entity is not in the recycle bin');
          this.bin.delete(b[0]);
          this.data.db[b[1].object].push(b[1].record);
          return ok(b[0]);
        }
        const { attributes, ...fields } = rec;
        const values = this.check(object, fields, byName);
        if (values.error) return fail(values.error);
        const existing = action === 'update' ? find(fields.Id)
          : action === 'upsert' ? (matchField && matchField !== 'Id' ? list.find((r) => String(r[matchField] ?? '').toLowerCase() === String(fields[matchField]).toLowerCase()) : find(fields.Id)) : null;
        if (action === 'update' && !existing) return fail('ENTITY_IS_DELETED: entity is deleted');
        if (action === 'upsert' && !existing && matchField === 'Id') return fail(`NOT_FOUND: Provided external ID field does not exist or is not accessible: ${fields.Id}`);
        if (existing) {
          Object.assign(existing, values.set, { LastModifiedDate: new Date().toISOString().replace('Z', '+0000') });
          return { success: true, id: existing.Id, created: action === 'upsert' ? false : null, error: null };
        }
        const missing = (REQUIRED[object] || []).filter((n) => values.set[n] == null || values.set[n] === '');
        if (missing.length) return fail(`REQUIRED_FIELD_MISSING: Required fields are missing: [${missing.join(', ')}]`);
        // Salesforce fills in the full name of a person
        if (/^(Contact|Lead)$/.test(object)) values.set.Name = [values.set.FirstName, values.set.LastName].filter(Boolean).join(' ');
        const id = to18(`${prefix}5g0000${String(++this.seq).padStart(6, '0')}`.slice(0, 15));
        const now = new Date().toISOString().replace('Z', '+0000');
        list.push({ Id: id, CreatedDate: now, LastModifiedDate: now, OwnerId: this.data.db.User[0]?.Id, CreatedById: this.data.db.User[0]?.Id, ...values.set });
        return { success: true, id, created: action === 'upsert' ? true : null, error: null };
      } catch (e) {
        return fail(e.message);
      }
    });
  }

  // field names, read-only fields, restricted picklists, numbers
  check(object, fields, byName) {
    const set = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'Id') continue;
      if (v && typeof v === 'object') {
        const ref = [...byName.values()].find((f) => f.relationshipName === k);
        if (!ref) return { error: `INVALID_FIELD: No such column '${k}' on entity '${object}'` };
        const [[extField, extVal]] = Object.entries(v);
        const parent = this.data.db[ref.referenceTo[0]]?.find((r) => String(r[extField] ?? '').toLowerCase() === String(extVal).toLowerCase());
        if (!parent) return { error: `INVALID_FIELD: Foreign key external ID: ${extVal} not found for field ${extField} in entity ${ref.referenceTo[0]}` };
        set[ref.name] = parent.Id;
        continue;
      }
      const f = byName.get(k.toLowerCase());
      if (!f) return { error: `INVALID_FIELD: No such column '${k}' on entity '${object}'` };
      if (!f.createable && !f.updateable) return { error: `INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: ${f.name}` };
      if (f.type === 'picklist' && v != null && f.picklist.length && !f.picklist.some((p) => p.value === v)) {
        return { error: `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: ${f.label}: bad value for restricted picklist field: ${v}` };
      }
      if (['int', 'double', 'currency', 'percent'].includes(f.type) && v != null && typeof v !== 'number') return { error: `INVALID_TYPE_ON_FIELD_IN_RECORD: ${f.label}: value not of required type: ${v}` };
      if (f.type === 'boolean' && v != null && typeof v !== 'boolean') return { error: `INVALID_TYPE_ON_FIELD_IN_RECORD: ${f.label}: value not of required type: ${v}` };
      if (f.type === 'date' && v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: `INVALID_TYPE_ON_FIELD_IN_RECORD: ${f.label}: value not of required type: ${v} (use 2026-01-31)` };
      set[f.name] = v;
    }
    return { set };
  }

  recordUrl(id) { return `https://demo.example.my.salesforce.com/${id}`; }
  orgLabel() { return { name: 'demo org', sandbox: true }; }
}

const ok = (id) => ({ success: true, id, created: null, error: null });
const fail = (error) => ({ success: false, id: null, created: null, error });
