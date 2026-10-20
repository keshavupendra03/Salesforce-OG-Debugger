// Data Import: pure helpers (no DOM, no network), so they run in the tests too.
// - reading pasted / dropped data: Excel (tab-separated), CSV (comma or semicolon), JSON
// - working out which object it is (a "_" type column, JSON attributes, or the Ids' key prefix)
// - mapping columns to fields by API name or label, and turning cells into field values

export const ACTIONS = {
  insert: { label: 'Insert', verb: 'Insert', icon: '＋', needsId: false, help: 'Creates new records. An Id column is ignored.' },
  update: { label: 'Update', verb: 'Update', icon: '✎', needsId: true, help: 'Changes existing records: every row needs an Id. Blank cells leave the field as it is.' },
  upsert: { label: 'Upsert', verb: 'Upsert', icon: '⇅', needsId: false, help: 'Updates the record that matches on the chosen field, or creates it when there’s no match.' },
  delete: { label: 'Delete', verb: 'Delete', icon: '🗑', needsId: true, help: 'Moves the records to the Recycle Bin. Only the Id column is used.' },
  undelete: { label: 'Undelete', verb: 'Undelete', icon: '↺', needsId: true, help: 'Restores records from the Recycle Bin. Only the Id column is used.' },
};

// columns that are about the data, never fields: Inspector's "_" type column and our own result columns
const META_COLS = /^(_|attributes\.type|attributes\.url|__status|__id|__errors|__created)$/i;
export const isMetaColumn = (h) => META_COLS.test(String(h).trim());

// ---------- parsing ----------

/** Text → { format: 'excel' | 'csv' | 'json', headers: [], rows: [[]] } (rows as strings, JSON values as-is). */
export function parseData(text) {
  const t = String(text || '').replace(/^﻿/, '');
  if (!t.trim()) return { format: null, headers: [], rows: [] };
  const first = t.trimStart()[0];
  if (first === '[' || first === '{') {
    try { return fromJson(JSON.parse(t)); } catch { /* not JSON after all: read it as a table */ }
  }
  const line = t.split(/\r?\n/, 1)[0];
  const sep = line.includes('\t') ? '\t' : (line.split(';').length > line.split(',').length ? ';' : ',');
  const all = parseDelimited(t, sep).filter((r) => r.some((c) => c !== ''));
  if (!all.length) return { format: null, headers: [], rows: [] };
  const width = Math.max(...all.map((r) => r.length));
  const headers = all[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  const rows = all.slice(1).map((r) => headers.map((_, i) => r[i] ?? ''));
  return { format: sep === '\t' ? 'excel' : 'csv', headers, rows };
}

// RFC 4180-ish: quotes with doubled "" inside, separators and newlines inside quotes
function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === sep) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function fromJson(v) {
  const list = Array.isArray(v) ? v : Array.isArray(v?.records) ? v.records : [v];
  const recs = list.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const headers = [];
  const add = (k) => { if (!headers.includes(k)) headers.push(k); };
  const flat = recs.map((r) => {
    const out = {};
    if (r.attributes?.type) { out._ = `[${r.attributes.type}]`; add('_'); }
    const walk = (o, prefix) => {
      for (const [k, val] of Object.entries(o)) {
        if (k === 'attributes') continue;
        if (val && typeof val === 'object' && !Array.isArray(val) && !('records' in val)) walk(val, `${prefix}${k}.`);
        else if (!Array.isArray(val) && !(val && typeof val === 'object')) { out[prefix + k] = val; add(prefix + k); }
      }
    };
    walk(r, '');
    return out;
  });
  return { format: 'json', headers, rows: flat.map((o) => headers.map((h) => (o[h] == null ? '' : o[h]))) };
}

// ---------- which object ----------

/**
 * objects: [{ name, keyPrefix }]. Returns { name, how } or null.
 * how: 'type column' | 'id prefix'
 */
export function detectObject(data, objects = []) {
  const { headers, rows } = data;
  const typeCol = headers.findIndex((h) => /^(_|attributes\.type)$/i.test(h));
  if (typeCol >= 0) {
    const counts = new Map();
    for (const r of rows) {
      const m = /^\[?([A-Za-z][\w]*)\]?$/.exec(String(r[typeCol]).trim());
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const o = objects.find((x) => x.name.toLowerCase() === best[0].toLowerCase());
      return { name: o?.name || best[0], how: 'type column' };
    }
  }
  const idCol = headers.findIndex((h) => /^id$/i.test(h.trim()));
  if (idCol >= 0) {
    const counts = new Map();
    for (const r of rows.slice(0, 500)) {
      const id = String(r[idCol]).trim();
      if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)) counts.set(id.slice(0, 3), (counts.get(id.slice(0, 3)) || 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    const o = best && objects.find((x) => x.keyPrefix === best[0]);
    if (o) return { name: o.name, how: 'id prefix' };
  }
  return null;
}

/** A first guess at the action: Update when there are Ids, else Insert. */
export const suggestAction = (headers) => (headers.some((h) => /^id$/i.test(String(h).trim())) ? 'update' : 'insert');

// ---------- mapping ----------

const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');

/** A header → the field it most likely means: exact API name, label, or the name with spaces dropped. */
export function guessField(header, fields) {
  const h = String(header).trim();
  if (isMetaColumn(h)) return null;
  const low = h.toLowerCase();
  const exact = fields.find((f) => f.name.toLowerCase() === low);
  if (exact) return exact.name;
  // Account.ExternalId__c: a lookup set through the parent's external id (or Name-like idLookup field)
  const dot = /^([A-Za-z][\w]*)\.([A-Za-z][\w]*)$/.exec(h);
  if (dot) {
    const rel = fields.find((f) => f.relationshipName?.toLowerCase() === dot[1].toLowerCase());
    if (rel) return `${rel.relationshipName}.${dot[2]}`;
  }
  const byLabel = fields.filter((f) => f.label.toLowerCase() === low);
  if (byLabel.length === 1) return byLabel[0].name;
  const n = norm(h);
  const loose = fields.filter((f) => norm(f.name) === n || norm(f.name.replace(/__c$/i, '')) === n || norm(f.label) === n);
  return loose.length === 1 ? loose[0].name : null;
}

/**
 * How one column maps, for an action: { state, field, detail }
 * state: 'ok' | 'rel' | 'skip' | 'meta' | 'unused' | 'unknown' | 'readonly' | 'ignored'
 * 'unknown' and 'readonly' block a run until fixed or skipped.
 */
export function checkColumn(header, target, { fields, action, skipped }) {
  if (isMetaColumn(header) && !target) return { state: 'meta', detail: /^_|attributes/i.test(header) ? 'Object type column' : 'Result column from an earlier run' };
  if (skipped) return { state: 'skip', detail: 'Skipped' };
  const t = String(target || '').trim();
  if (!t) return { state: 'unknown', detail: 'Pick a field or skip this column' };
  const isId = /^id$/i.test(t);
  if (action === 'delete' || action === 'undelete') return isId ? { state: 'ok', field: 'Id', detail: 'Record Id' } : { state: 'unused', detail: `Not used for ${action}` };
  if (isId) return action === 'insert' ? { state: 'ignored', field: 'Id', detail: 'Ignored on insert' } : { state: 'ok', field: 'Id', detail: action === 'upsert' ? 'Record Id' : 'Record Id (which record to change)' };
  const dot = /^([A-Za-z][\w]*)\.([A-Za-z][\w]*)$/.exec(t);
  if (dot) {
    const ref = fields.find((f) => f.relationshipName?.toLowerCase() === dot[1].toLowerCase());
    if (!ref) return { state: 'unknown', detail: `No lookup called ${dot[1]}` };
    const can = action === 'insert' ? ref.createable : ref.updateable || ref.createable;
    if (can === false) return { state: 'readonly', detail: `${ref.name} can’t be set` };
    return { state: 'rel', field: `${ref.relationshipName}.${dot[2]}`, ref, detail: `${ref.name} → found by ${(ref.referenceTo || [])[0] || 'parent'}.${dot[2]}` };
  }
  const f = fields.find((x) => x.name.toLowerCase() === t.toLowerCase());
  if (!f) return { state: 'unknown', detail: 'Unknown field' };
  if (action === 'insert' && f.createable === false) return { state: 'readonly', field: f.name, detail: 'Read-only: can’t be set on insert' };
  if (action === 'update' && f.updateable === false) return { state: 'readonly', field: f.name, detail: 'Read-only: can’t be changed' };
  if (action === 'upsert' && f.updateable === false && f.createable === false) return { state: 'readonly', field: f.name, detail: 'Read-only' };
  return { state: 'ok', field: f.name, detail: typeLabel(f) };
}

export function typeLabel(f) {
  const t = f.type;
  if (t === 'reference') return `Lookup → ${(f.referenceTo || []).join(', ') || '?'}`;
  if (t === 'string' || t === 'textarea') return f.length ? `Text(${f.length})` : 'Text';
  if (t === 'picklist' || t === 'multipicklist') return t === 'picklist' ? 'Picklist' : 'Multi-select picklist';
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** Required fields an insert would miss: not nillable, createable, no default, not set by Salesforce. */
export function missingRequired(fields, mappedNames, action) {
  if (action !== 'insert' && action !== 'upsert') return [];
  const have = new Set(mappedNames.map((n) => n.toLowerCase().split('.')[0]));
  const relHave = new Set(mappedNames.filter((n) => n.includes('.')).map((n) => n.split('.')[0].toLowerCase()));
  return fields.filter((f) => f.createable && f.nillable === false && !f.defaultedOnCreate && f.type !== 'boolean'
    && !have.has(f.name.toLowerCase()) && !(f.relationshipName && relHave.has(f.relationshipName.toLowerCase())))
    .map((f) => f.name);
}

// ---------- values ----------

const TRUE = /^(true|yes|y|1|checked)$/i;
const FALSE = /^(false|no|n|0|unchecked)$/i;

/** A cell → the value to send (undefined = leave it out). */
export function convert(raw, field, { blankToNull = false } = {}) {
  if (raw === null || raw === undefined) return blankToNull ? null : undefined;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const s = String(raw);
  if (s.trim() === '') return blankToNull ? null : undefined;
  const t = field?.type;
  if (t === 'boolean') return TRUE.test(s.trim()) ? true : FALSE.test(s.trim()) ? false : s;
  if (['int', 'double', 'currency', 'percent', 'long'].includes(t)) {
    const n = s.trim().replace(/[,\s]/g, '').replace(/^[$€£₹]/, '').replace(/%$/, '');
    return /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(n) ? Number(n) : s;
  }
  return s;
}

/**
 * The record for one row. cols: [{ index, state, field, ref }], fieldsByName: Map(lower → field).
 * Returns { record } or { error }.
 */
export function buildRecord(row, cols, { action, object, fieldsByName, blankToNull, matchField }) {
  const rec = {};
  for (const c of cols) {
    if (c.state !== 'ok' && c.state !== 'rel') continue;
    const raw = row[c.index];
    if (c.state === 'rel') {
      const v = convert(raw, null, { blankToNull: false });
      if (v === undefined) continue;
      const [rel, extField] = c.field.split('.');
      rec[rel] = { [extField]: v };
      continue;
    }
    const f = fieldsByName.get(c.field.toLowerCase());
    // blank cells only clear fields on update / upsert: on insert a blank simply isn't set
    const v = convert(raw, f, { blankToNull: blankToNull && action !== 'insert' });
    if (v === undefined) continue;
    rec[f?.name || c.field] = typeof v === 'string' && c.field === 'Id' ? v.trim() : v;
  }
  if (ACTIONS[action].needsId && !/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(String(rec.Id || ''))) return { error: rec.Id ? `Not a record Id: ${rec.Id}` : 'This row has no Id' };
  if (action === 'insert') delete rec.Id;
  if (action === 'upsert') {
    const key = matchField || 'Id';
    if (rec[key] == null || rec[key] === '') return { error: `This row has no ${key} to match on` };
  }
  if (action === 'delete' || action === 'undelete') return { record: { Id: rec.Id } };
  return { record: { attributes: { type: object }, ...rec } };
}

export function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// ---------- results out ----------

const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** Rows with the result columns appended, as CSV or tab-separated (Excel). */
export function exportRows(headers, rows, format) {
  if (format === 'json') {
    return JSON.stringify(rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))), null, 2);
  }
  const cell = format === 'excel' ? (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ') : (s) => csvCell(String(s ?? ''));
  const sep = format === 'excel' ? '\t' : ',';
  return [headers.map(cell).join(sep), ...rows.map((r) => r.map(cell).join(sep))].join(format === 'excel' ? '\n' : '\r\n');
}
