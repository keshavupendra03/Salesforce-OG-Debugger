// In-memory backend for the Data Export demo: sample records plus a small SOQL engine
// (fields, relationship paths, sub-queries, WHERE with AND/OR/NOT, LIKE, IN, date literals,
// ORDER BY, LIMIT/OFFSET, COUNT()). Anything else answers like Salesforce would: with an error.

import { tokenize, to18 } from './soql.js';
import { DEMO_UNITS } from '../demo-data.js';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

const F = (name, label, type, extra = {}) => ({ name, label, type, relationshipName: null, referenceTo: [], picklist: [], ...extra });
const ref = (name, label, rel, to) => F(name, label, 'reference', { relationshipName: rel, referenceTo: [to] });
// values: 'Same' or ['ApiName', 'Label'] when the label differs, like real orgs often do
const pick = (name, label, values) => F(name, label, 'picklist', {
  picklist: values.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v })),
});
const audit = () => [
  F('CreatedDate', 'Created Date', 'datetime'), F('LastModifiedDate', 'Last Modified Date', 'datetime'),
  ref('CreatedById', 'Created By ID', 'CreatedBy', 'User'), ref('OwnerId', 'Owner ID', 'Owner', 'User'),
];

const INDUSTRIES = ['Banking', 'Technology', 'Healthcare', 'Retail', 'Manufacturing', 'Energy', 'Education'];
const STAGES = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];

const SCHEMA = {
  Account: {
    prefix: '001',
    fields: [
      F('Id', 'Account ID', 'id'), F('Name', 'Account Name', 'string'), pick('Industry', 'Industry', INDUSTRIES),
      pick('Type', 'Account Type', [['Customer', 'Customer - Direct'], 'Prospect', ['Partner', 'Channel Partner / Reseller']]), pick('Rating', 'Account Rating', [['Hot', 'Hot (ready to buy)'], ['Warm', 'Warm (interested)'], ['Cold', 'Cold (no interest yet)']]),
      F('AnnualRevenue', 'Annual Revenue', 'currency'), F('NumberOfEmployees', 'Employees', 'int'), F('Website', 'Website', 'url'),
      F('BillingCity', 'Billing City', 'string'), F('BillingCountry', 'Billing Country', 'string'), F('IsActive__c', 'Active', 'boolean'),
      ref('ParentId', 'Parent Account ID', 'Parent', 'Account'), ...audit(),
    ],
    children: [{ name: 'Contacts', object: 'Contact', field: 'AccountId' }, { name: 'Opportunities', object: 'Opportunity', field: 'AccountId' }],
  },
  Contact: {
    prefix: '003',
    fields: [
      F('Id', 'Contact ID', 'id'), F('FirstName', 'First Name', 'string'), F('LastName', 'Last Name', 'string'), F('Name', 'Full Name', 'string'),
      F('Email', 'Email', 'email'), F('Phone', 'Phone', 'phone'), F('Title', 'Title', 'string'),
      pick('LeadSource', 'Lead Source', ['Web', 'Phone Inquiry', 'Partner Referral', 'Trade Show']),
      ref('AccountId', 'Account ID', 'Account', 'Account'), F('Birthdate', 'Birthdate', 'date'), ...audit(),
    ],
    children: [],
  },
  Opportunity: {
    prefix: '006',
    fields: [
      F('Id', 'Opportunity ID', 'id'), F('Name', 'Name', 'string'), pick('StageName', 'Stage', STAGES), F('Amount', 'Amount', 'currency'),
      F('CloseDate', 'Close Date', 'date'), F('Probability', 'Probability (%)', 'percent'), F('IsClosed', 'Closed', 'boolean'),
      F('IsWon', 'Won', 'boolean'), ref('AccountId', 'Account ID', 'Account', 'Account'), F('Account_Industry__c', 'Account Industry', 'string'), ...audit(),
    ],
    children: [],
  },
  Lead: {
    prefix: '00Q',
    fields: [
      F('Id', 'Lead ID', 'id'), F('FirstName', 'First Name', 'string'), F('LastName', 'Last Name', 'string'), F('Company', 'Company', 'string'),
      F('Email', 'Email', 'email'), pick('Status', 'Lead Status', [['Open', 'Open - Not Contacted'], ['Working', 'Working - Contacted'], ['Qualified', 'Closed - Converted'], ['Unqualified', 'Closed - Not Converted']]),
      pick('Industry', 'Industry', INDUSTRIES), F('IsConverted', 'Converted', 'boolean'), ...audit(),
    ],
    children: [],
  },
  User: {
    prefix: '005',
    fields: [F('Id', 'User ID', 'id'), F('Name', 'Full Name', 'string'), F('Username', 'Username', 'string'), F('Email', 'Email', 'email'),
      F('IsActive', 'Active', 'boolean'), pick('UserType', 'User Type', ['Standard', 'AutomatedProcess'])],
    children: [],
  },
};

const TOOLING = {
  ApexClass: {
    prefix: '01p',
    fields: [F('Id', 'Class ID', 'id'), F('Name', 'Name', 'string'), F('ApiVersion', 'Api Version', 'double'), pick('Status', 'Status', ['Active', 'Deleted']),
      F('LengthWithoutComments', 'Size Without Comments', 'int'), F('NamespacePrefix', 'Namespace Prefix', 'string'), F('Body', 'Body', 'textarea')],
    children: [],
  },
  ApexTrigger: {
    prefix: '01q',
    fields: [F('Id', 'Trigger ID', 'id'), F('Name', 'Name', 'string'), F('ApiVersion', 'Api Version', 'double'), pick('Status', 'Status', ['Active', 'Inactive']),
      F('TableEnumOrId', 'Object', 'string'), F('Body', 'Body', 'textarea')],
    children: [],
  },
};

// deterministic pseudo-random data
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

function makeId(prefix, n) {
  return to18(`${prefix}5g00000${String(n).padStart(5, '0')}`.slice(0, 15));
}

function seed() {
  const r = rng(42);
  const pickOne = (arr) => arr[Math.floor(r() * arr.length)];
  const day = 86400000;
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, '.000+0000');
  const date = (t) => new Date(t).toISOString().slice(0, 10);
  const db = { Account: [], Contact: [], Opportunity: [], Lead: [], User: [] };
  const users = ['Priya Sharma', 'Marco Rossi', 'Aisha Khan', 'Integration User', 'Automated Process', 'Lena Fischer'];
  users.forEach((name, i) => db.User.push({
    Id: makeId('005', i + 1), Name: name, Username: `${name.toLowerCase().replace(/\s+/g, '.')}@demo.org`,
    Email: `${name.toLowerCase().replace(/\s+/g, '.')}@demo.org`, IsActive: i !== 5, UserType: name === 'Automated Process' ? 'AutomatedProcess' : 'Standard',
  }));
  const owner = () => db.User[Math.floor(r() * 4)].Id;
  const stamp = () => { const c = now - Math.floor(r() * 400) * day - Math.floor(r() * day); return { CreatedDate: iso(c), LastModifiedDate: iso(Math.min(now, c + Math.floor(r() * 60) * day)) }; };
  const words1 = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark', 'Wayne', 'Wonka', 'Hooli', 'Vandelay', 'Soylent', 'Tyrell', 'Cyberdyne', 'Massive', 'Pied Piper', 'Aperture', 'Oscorp'];
  const words2 = ['Corp', 'Industries', 'Bank', 'Health', 'Labs', 'Retail', 'Energy', 'Systems'];
  const cities = [['London', 'UK'], ['Berlin', 'Germany'], ['Mumbai', 'India'], ['Austin', 'USA'], ['Toronto', 'Canada'], ['Sydney', 'Australia'], ['Milan', 'Italy']];
  for (let i = 0; i < 48; i++) {
    const [city, country] = pickOne(cities);
    const name = `${words1[i % words1.length]} ${words2[(i * 3 + Math.floor(i / 16)) % words2.length]}${i >= 16 ? ` ${Math.floor(i / 16) + 1}` : ''}`;
    db.Account.push({
      Id: makeId('001', i + 1), Name: name, Industry: r() < 0.08 ? null : pickOne(INDUSTRIES), Type: pickOne(['Customer', 'Prospect', 'Partner']),
      Rating: r() < 0.2 ? null : pickOne(['Hot', 'Warm', 'Cold']), AnnualRevenue: Math.round(r() * 900 + 10) * 100000,
      NumberOfEmployees: Math.round(r() * 5000 + 5), Website: `https://www.${name.split(' ')[0].toLowerCase()}.example`,
      BillingCity: city, BillingCountry: country, IsActive__c: r() > 0.15, ParentId: i > 20 && r() < 0.3 ? makeId('001', 1 + Math.floor(r() * 20)) : null,
      OwnerId: owner(), CreatedById: owner(), ...stamp(),
    });
  }
  const first = ['Ava', 'Liam', 'Noah', 'Mia', 'Arjun', 'Sofia', 'Kenji', 'Zara', 'Omar', 'Elena', 'Ravi', 'Chloe', 'Jonas', 'Ines'];
  const last = ['Patel', 'Smith', 'Garcia', 'Müller', 'Rossi', 'Tanaka', 'Khan', 'Dubois', 'Silva', 'Novak', "O'Brien", 'Kim'];
  for (let i = 0; i < 120; i++) {
    const fn = pickOne(first);
    const ln = pickOne(last);
    const acc = db.Account[Math.floor(r() * db.Account.length)];
    db.Contact.push({
      Id: makeId('003', i + 1), FirstName: fn, LastName: ln, Name: `${fn} ${ln}`,
      Email: `${fn}.${ln.replace(/\W/g, '')}@${acc.Name.split(' ')[0].toLowerCase()}.example`.toLowerCase(),
      Phone: `+1 555 ${String(1000 + Math.floor(r() * 9000))}`, Title: pickOne(['CEO', 'CFO', 'VP Sales', 'Buyer', 'Engineer', 'Analyst', null]),
      LeadSource: pickOne(['Web', 'Phone Inquiry', 'Partner Referral', 'Trade Show']), AccountId: r() < 0.06 ? null : acc.Id,
      Birthdate: date(now - (20 + Math.floor(r() * 40)) * 365 * day), OwnerId: owner(), CreatedById: owner(), ...stamp(),
    });
  }
  for (let i = 0; i < 90; i++) {
    const acc = db.Account[Math.floor(r() * db.Account.length)];
    const stage = pickOne(STAGES);
    db.Opportunity.push({
      Id: makeId('006', i + 1), Name: `${acc.Name} - ${pickOne(['Renewal', 'Expansion', 'New Business', 'Upsell'])}`, StageName: stage,
      Amount: Math.round(r() * 200 + 5) * 1000, CloseDate: date(now + Math.floor(r() * 240 - 120) * day),
      Probability: { Prospecting: 10, Qualification: 20, Proposal: 50, Negotiation: 75, 'Closed Won': 100, 'Closed Lost': 0 }[stage],
      IsClosed: stage.startsWith('Closed'), IsWon: stage === 'Closed Won', AccountId: acc.Id, Account_Industry__c: acc.Industry,
      OwnerId: owner(), CreatedById: owner(), ...stamp(),
    });
  }
  for (let i = 0; i < 35; i++) {
    db.Lead.push({
      Id: makeId('00Q', i + 1), FirstName: pickOne(first), LastName: pickOne(last), Company: `${pickOne(words1)} ${pickOne(words2)}`,
      Email: `lead${i + 1}@example.com`, Status: pickOne(['Open', 'Working', 'Qualified', 'Unqualified']), Industry: pickOne(INDUSTRIES),
      IsConverted: r() < 0.15, OwnerId: owner(), CreatedById: owner(), ...stamp(),
    });
  }
  const tooling = {
    ApexClass: DEMO_UNITS.filter((u) => u.kind === 'class').map((u) => ({
      Id: to18(u.id), Name: u.name, ApiVersion: 62, Status: 'Active', LengthWithoutComments: u.body.length, NamespacePrefix: null, Body: u.body,
    })),
    ApexTrigger: DEMO_UNITS.filter((u) => u.kind === 'trigger').map((u) => ({
      Id: to18(u.id), Name: u.name, ApiVersion: 62, Status: 'Active', TableEnumOrId: /\bon\s+(\w+)/.exec(u.body)?.[1] || null, Body: u.body,
    })),
  };
  return { db, tooling };
}

class SoqlError extends Error {
  constructor(msg) { super(`MALFORMED_QUERY: ${msg}`); }
}

const PAGE = 100;

export class DemoDataBackend {
  constructor() {
    const { db, tooling } = seed();
    this.db = db;
    this.tdb = tooling;
    this.orgKey = 'demo';
    this.cursors = new Map();
    this.seq = 0;
  }

  async listObjects({ tooling = false } = {}) {
    await wait(60);
    const s = tooling ? TOOLING : SCHEMA;
    return Object.keys(s).map((name) => ({ name, label: name.replace(/([a-z])([A-Z])/g, '$1 $2'), custom: false, keyPrefix: s[name].prefix }));
  }

  async describe(name, { tooling = false } = {}) {
    await wait(120);
    const s = (tooling ? TOOLING : SCHEMA)[canon(tooling ? TOOLING : SCHEMA, name)];
    if (!s) throw new Error(`NOT_FOUND: The requested resource does not exist (${name})`);
    return { name: canon(tooling ? TOOLING : SCHEMA, name), fields: [...s.fields].sort((a, b) => a.name.localeCompare(b.name)), children: s.children.map(({ name: n, object }) => ({ name: n, object })) };
  }

  async query(soql, { tooling = false, signal } = {}) {
    await wait(280, signal);
    const q = parse(soql, tooling ? TOOLING : SCHEMA);
    const rows = run(q, this.store(tooling), tooling ? TOOLING : SCHEMA);
    if (q.count) return { records: [], totalSize: rows.length, done: true, next: null };
    const id = `demo:${++this.seq}`;
    this.cursors.set(id, rows);
    return this.page(id, 0);
  }

  async more(next, { signal } = {}) {
    await wait(220, signal);
    const [, n, off] = /^(demo:\d+):(\d+)$/.exec(next) || [];
    if (!this.cursors.has(n)) throw new Error('INVALID_QUERY_LOCATOR: invalid query locator');
    return this.page(n, +off);
  }

  page(id, off) {
    const rows = this.cursors.get(id);
    const end = Math.min(rows.length, off + PAGE);
    const done = end >= rows.length;
    if (done) this.cursors.delete(id);
    return { records: rows.slice(off, end), totalSize: rows.length, done, next: done ? null : `${id}:${end}` };
  }

  store(tooling) { return tooling ? this.tdb : this.db; }

  async deleteRecords(ids, { onProgress } = {}) {
    await wait(300);
    const out = [];
    for (const id of ids) {
      const obj = Object.values(SCHEMA).find((s) => id.startsWith(s.prefix));
      const name = obj && Object.keys(SCHEMA).find((k) => SCHEMA[k] === obj);
      const list = name && this.db[name];
      const i = list ? list.findIndex((r) => r.Id === id) : -1;
      if (name === 'User') out.push({ id, success: false, error: 'DELETE_FAILED: Users can’t be deleted. Deactivate them instead.' });
      else if (i < 0) out.push({ id, success: false, error: 'ENTITY_IS_DELETED: entity is deleted' });
      else {
        list.splice(i, 1);
        out.push({ id, success: true, error: null });
      }
    }
    onProgress?.(ids.length, ids.length);
    return out;
  }

  recordUrl(id) { return `https://demo.example.my.salesforce.com/${id}`; }
}

// ---------- the mini SOQL engine ----------

const canon = (schema, name) => Object.keys(schema).find((k) => k.toLowerCase() === String(name).toLowerCase());

function parse(soql, schema) {
  const toks = tokenize(soql).filter((t) => t.t !== 'ws' && t.t !== 'comment');
  let i = 0;
  const peek = (k = 0) => toks[i + k];
  const up = (t) => t?.v.toUpperCase();
  const fail = (msg) => { throw new SoqlError(msg); };
  const expect = (v) => {
    if (up(peek()) !== v) fail(peek() ? `unexpected token: '${peek().v}'` : `expecting '${v}', found end of query`);
    i++;
  };

  function query(parentObj) {
    expect('SELECT');
    const items = [];
    for (;;) {
      const t = peek();
      if (!t) fail("expecting 'FROM'");
      if (t.v === '(') {
        i++;
        items.push({ sub: query(true) });
        expect(')');
      } else if (/^(COUNT)$/i.test(t.v) && peek(1)?.v === '(' && peek(2)?.v === ')') {
        i += 3;
        items.push({ count: true });
      } else if (/^FIELDS$/i.test(t.v) && peek(1)?.v === '(') {
        const which = up(peek(2));
        i += 4;
        items.push({ fields: which });
      } else if (t.t === 'id' || t.t === 'kw') {
        if (peek(1)?.v === '(') fail(`'${t.v}()' isn’t supported in the demo org`);
        i++;
        items.push({ path: t.v });
      } else fail(`unexpected token: '${t.v}'`);
      if (peek()?.v === ',') { i++; continue; }
      break;
    }
    expect('FROM');
    const fromTok = peek();
    if (!fromTok || fromTok.t !== 'id') fail('expecting an object name after FROM');
    i++;
    const q = { items, from: fromTok.v, where: null, order: [], limit: null, offset: 0, sub: !!parentObj };
    if (!parentObj && !canon(schema, q.from)) fail(`sObject type '${q.from}' is not supported.`);
    q.count = items.some((x) => x.count);
    if (q.count && items.length > 1) fail('COUNT() must be the only element in the SELECT list');
    if (up(peek()) === 'WHERE') { i++; q.where = orExpr(); }
    if (up(peek()) === 'GROUP') fail('GROUP BY isn’t supported in the demo org');
    if (up(peek()) === 'ORDER') {
      i++;
      expect('BY');
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'id') fail('expecting a field in ORDER BY');
        i++;
        const o = { path: t.v, dir: 1, nullsLast: true };
        if (up(peek()) === 'ASC') i++;
        else if (up(peek()) === 'DESC') { i++; o.dir = -1; o.nullsLast = false; }
        if (up(peek()) === 'NULLS') { i++; o.nullsLast = up(peek()) === 'LAST'; i++; }
        q.order.push(o);
        if (peek()?.v === ',') { i++; continue; }
        break;
      }
    }
    if (up(peek()) === 'LIMIT') { i++; q.limit = +peek()?.v; i++; if (!Number.isFinite(q.limit)) fail('LIMIT needs a number'); }
    if (up(peek()) === 'OFFSET') { i++; q.offset = +peek()?.v; i++; }
    if (up(peek()) === 'WITH' || up(peek()) === 'FOR') { while (peek() && peek().v !== ')') i++; }
    if (items.some((x) => x.fields && x.fields !== 'STANDARD') && (q.limit == null || q.limit > 200)) {
      fail('The SOQL FIELDS function must have a LIMIT of at most 200');
    }
    return q;
  }

  function orExpr() {
    let left = andExpr();
    while (up(peek()) === 'OR') { i++; left = { or: [left, andExpr()] }; }
    return left;
  }
  function andExpr() {
    let left = notExpr();
    while (up(peek()) === 'AND') { i++; left = { and: [left, notExpr()] }; }
    return left;
  }
  function notExpr() {
    if (up(peek()) === 'NOT') { i++; return { not: notExpr() }; }
    if (peek()?.v === '(') { i++; const e = orExpr(); expect(')'); return e; }
    const f = peek();
    if (!f || f.t !== 'id') fail(f ? `unexpected token: '${f.v}'` : 'unexpected end of query');
    i++;
    let op = peek()?.t === 'op' ? peek().v : up(peek());
    if (op === 'NOT' && up(peek(1)) === 'IN') { i++; op = 'NOT IN'; }
    if (!['=', '!=', '<>', '<', '<=', '>', '>=', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'].includes(op)) fail(`unexpected token: '${peek()?.v ?? 'end of query'}'`);
    i++;
    let value;
    if (['IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'].includes(op)) {
      expect('(');
      if (up(peek()) === 'SELECT') fail('semi-joins aren’t supported in the demo org');
      value = [];
      while (peek() && peek().v !== ')') { value.push(literal()); if (peek()?.v === ',') i++; }
      expect(')');
    } else value = literal();
    return { path: f.v, op: op === '<>' ? '!=' : op, value };
  }
  function literal() {
    const t = peek();
    if (!t) fail('expecting a value');
    i++;
    if (t.t === 'str') return t.v.slice(1, -1).replace(/\\(.)/g, '$1');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'date') return /^\d/.test(t.v) ? { at: t.v } : { lit: t.v.toUpperCase() };
    if (t.t === 'bind') fail('bind variables only work in Apex');
    const u = up(t);
    if (u === 'NULL') return null;
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    fail(`unexpected token: '${t.v}'`);
  }

  const q = query(false);
  if (i < toks.length) fail(`unexpected token: '${toks[i].v}'`);
  return q;
}

function run(q, store, schema, parentRow = null, parentObj = null) {
  const obj = canon(schema, q.from) || q.from;
  let rows;
  let childObj = obj;
  if (q.sub) {
    const rel = schema[parentObj]?.children.find((c) => c.name.toLowerCase() === q.from.toLowerCase());
    if (!rel) throw new SoqlError(`Didn't understand relationship '${q.from}' in FROM part of query call.`);
    childObj = rel.object;
    rows = store[childObj].filter((r) => r[rel.field] === parentRow.Id);
  } else rows = store[obj];
  const fieldsOf = (o) => schema[o].fields;
  const get = (row, o, path) => resolve(row, o, path, store, schema);

  for (const it of q.items) if (it.path) get(rows[0] || {}, childObj, it.path); // validates the field names
  if (q.where) rows = rows.filter((r) => test(q.where, r, childObj, get, schema));
  if (q.order.length) {
    rows = [...rows].sort((a, b) => {
      for (const o of q.order) {
        const x = get(a, childObj, o.path).value;
        const y = get(b, childObj, o.path).value;
        if (x === y) continue;
        if (x == null) return o.nullsLast ? 1 : -1;
        if (y == null) return o.nullsLast ? -1 : 1;
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * o.dir;
      }
      return 0;
    });
  }
  rows = rows.slice(q.offset, q.limit != null ? q.offset + q.limit : undefined);
  if (q.count) return rows;

  return rows.map((r) => {
    const out = { attributes: { type: childObj, url: `/services/data/v62.0/sobjects/${childObj}/${r.Id}` } };
    for (const it of q.items) {
      if (it.fields) {
        for (const f of fieldsOf(childObj)) if (it.fields !== 'CUSTOM' || f.name.endsWith('__c')) out[f.name] = r[f.name] ?? null;
      } else if (it.sub) {
        const recs = run(it.sub, store, schema, r, childObj);
        out[canonChild(schema, childObj, it.sub.from)] = recs.length ? { totalSize: recs.length, done: true, records: recs } : null;
      } else if (it.path) {
        put(out, get(r, childObj, it.path), schema);
      }
    }
    return out;
  });
}

const canonChild = (schema, obj, name) => schema[obj].children.find((c) => c.name.toLowerCase() === name.toLowerCase())?.name || name;

// Walk Account.Owner.Name from a row; returns { value, chain: [{ rel, type, record }], field }.
function resolve(row, obj, path, store, schema) {
  const segs = path.split('.');
  // "Account.Name" in a query FROM Account may start with the object name itself
  if (segs.length > 1 && segs[0].toLowerCase() === obj.toLowerCase() && !schema[obj].fields.some((f) => f.relationshipName?.toLowerCase() === segs[0].toLowerCase())) segs.shift();
  let cur = row;
  let o = obj;
  const chain = [];
  for (let k = 0; k < segs.length - 1; k++) {
    const f = schema[o].fields.find((x) => x.relationshipName?.toLowerCase() === segs[k].toLowerCase());
    if (!f) throw new SoqlError(`Didn't understand relationship '${segs[k]}' in field path. If you are attempting to use a custom relationship, be sure to append the '__r' after the custom relationship name.`);
    const target = f.referenceTo[0];
    const rec = cur ? store[target]?.find((x) => x.Id === cur[f.name]) || null : null;
    chain.push({ rel: f.relationshipName, type: target, record: rec });
    cur = rec;
    o = target;
  }
  const last = segs[segs.length - 1];
  const field = schema[o].fields.find((x) => x.name.toLowerCase() === last.toLowerCase());
  if (!field) throw new SoqlError(`No such column '${last}' on entity '${o}'. If you are attempting to use a custom field, be sure to append the '__c' after the custom field name.`);
  return { value: cur ? cur[field.name] ?? null : null, chain, field };
}

function put(out, { value, chain, field }) {
  let node = out;
  for (const c of chain) {
    if (!c.record) { node[c.rel] = null; return; }
    node[c.rel] ||= { attributes: { type: c.type, url: `/services/data/v62.0/sobjects/${c.type}/${c.record.Id}` } };
    node = node[c.rel];
  }
  node[field.name] = value;
}

function test(e, row, obj, get, schema) {
  if (e.and) return test(e.and[0], row, obj, get, schema) && test(e.and[1], row, obj, get, schema);
  if (e.or) return test(e.or[0], row, obj, get, schema) || test(e.or[1], row, obj, get, schema);
  if (e.not) return !test(e.not, row, obj, get, schema);
  const { value: v, field } = get(row, obj, e.path);
  const val = e.value;
  const isDate = field.type === 'date' || field.type === 'datetime';
  const cmp = (x, y) => {
    if (y && typeof y === 'object') {
      const [lo, hi] = y.lit ? dateRange(y.lit) : [Date.parse(y.at), Date.parse(y.at) + (y.at.length <= 10 ? 86400000 : 1)];
      const t = Date.parse(String(x).replace(/\+0000$/, 'Z'));
      return t < lo ? -1 : t >= hi ? 1 : 0;
    }
    if (isDate && typeof y === 'string') throw new SoqlError(`value of filter criterion for field '${field.name}' must be of type date and should not be enclosed in quotes`);
    return typeof x === 'number' ? x - y : String(x).toLowerCase().localeCompare(String(y).toLowerCase());
  };
  switch (e.op) {
    case '=': return val === null ? v == null : v != null && cmp(v, val) === 0;
    case '!=': return val === null ? v != null : v == null || cmp(v, val) !== 0;
    case '<': return v != null && cmp(v, val) < 0;
    case '<=': return v != null && cmp(v, val) <= 0;
    case '>': return v != null && cmp(v, val) > 0;
    case '>=': return v != null && cmp(v, val) >= 0;
    case 'LIKE': {
      const re = new RegExp(`^${String(val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
      return v != null && re.test(String(v));
    }
    case 'IN': return v != null && val.some((x) => cmp(v, x) === 0);
    case 'NOT IN': return v == null || !val.some((x) => cmp(v, x) === 0);
    case 'INCLUDES': return v != null && val.some((x) => String(v).split(';').includes(x));
    case 'EXCLUDES': return v == null || !val.some((x) => String(v).split(';').includes(x));
    default: return false;
  }
}

function dateRange(lit) {
  const d = new Date();
  const day = (y, m, dd) => Date.UTC(y, m, dd);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const today = day(Y, M, D);
  const DAY = 86400000;
  const n = /:(\d+)$/.exec(lit)?.[1];
  switch (lit.replace(/:\d+$/, '')) {
    case 'TODAY': return [today, today + DAY];
    case 'YESTERDAY': return [today - DAY, today];
    case 'TOMORROW': return [today + DAY, today + 2 * DAY];
    case 'THIS_WEEK': { const s = today - d.getUTCDay() * DAY; return [s, s + 7 * DAY]; }
    case 'LAST_WEEK': { const s = today - (d.getUTCDay() + 7) * DAY; return [s, s + 7 * DAY]; }
    case 'NEXT_WEEK': { const s = today + (7 - d.getUTCDay()) * DAY; return [s, s + 7 * DAY]; }
    case 'THIS_MONTH': return [day(Y, M, 1), day(Y, M + 1, 1)];
    case 'LAST_MONTH': return [day(Y, M - 1, 1), day(Y, M, 1)];
    case 'NEXT_MONTH': return [day(Y, M + 1, 1), day(Y, M + 2, 1)];
    case 'THIS_YEAR': return [day(Y, 0, 1), day(Y + 1, 0, 1)];
    case 'LAST_YEAR': return [day(Y - 1, 0, 1), day(Y, 0, 1)];
    case 'NEXT_YEAR': return [day(Y + 1, 0, 1), day(Y + 2, 0, 1)];
    case 'LAST_90_DAYS': return [today - 90 * DAY, today + DAY];
    case 'NEXT_90_DAYS': return [today, today + 91 * DAY];
    case 'LAST_N_DAYS': return [today - n * DAY, today + DAY];
    case 'NEXT_N_DAYS': return [today, today + (+n + 1) * DAY];
    case 'LAST_N_MONTHS': return [day(Y, M - n, 1), day(Y, M, 1)];
    case 'NEXT_N_MONTHS': return [day(Y, M + 1, 1), day(Y, M + 1 + +n, 1)];
    case 'LAST_N_YEARS': return [day(Y - n, 0, 1), day(Y, 0, 1)];
    default: throw new SoqlError(`the date literal ${lit} isn’t supported in the demo org`);
  }
}

// for the demo All data page (src/record/record-backend.js)
export { SCHEMA as DEMO_SCHEMA, makeId as demoId };
