// Code Flow outside Apex: where a field or an Apex method is used by Flows, Process Builder, validation rules,
// formula fields, LWC, Aura and Visualforce. Pure: works on the docs FBI Search already loads (and caches),
// plus the structured references read from each flow's metadata.
//
// A usage: { key, kind, name, title, sub, inactive, link, entry: { kind, label, detail }, refs: [{ access, where, text, line, possible }] }
// access: 'write' | 'read' | 'uses' (a component shows / binds the field: read or edit isn't known) | 'calls'

const low = (s) => String(s || '').toLowerCase();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- flows ----------

const RECORD_ELEMENTS = [
  ['recordUpdates', 'Update Records', 'write'],
  ['recordCreates', 'Create Records', 'write'],
  ['recordLookups', 'Get Records', 'read'],
  ['recordDeletes', 'Delete Records', 'read'],
];
const ELEMENT_KINDS = {
  start: 'Start', assignments: 'Assignment', decisions: 'Decision', formulas: 'Formula', textTemplates: 'Text template',
  screens: 'Screen', actionCalls: 'Action', loops: 'Loop', recordUpdates: 'Update Records', recordCreates: 'Create Records',
  recordLookups: 'Get Records', recordDeletes: 'Delete Records', subflows: 'Subflow', waits: 'Wait', collectionProcessors: 'Collection',
  customErrors: 'Custom error', transforms: 'Transform',
};
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);

/**
 * What a flow touches, from its metadata (Tooling Flow.Metadata):
 * { object, fields: [{ object, field, access, element }], apex: [{ className, element }], subflows: [name] }
 * Record variables: $Record / $Record__Prior (the triggering record), SObject variables, Get Records outputs, loops.
 */
export function flowRefs(md) {
  if (!md || typeof md !== 'object') return { object: null, fields: [], apex: [], subflows: [] };
  const startObj = md.start?.object
    || asList(md.processMetadataValues).find((p) => p?.name === 'ObjectType')?.value?.stringValue || null;
  const vars = new Map();
  if (startObj) { vars.set('$record', startObj); vars.set('$record__prior', startObj); }
  for (const v of asList(md.variables)) if (v?.objectType && v.name) vars.set(low(v.name), v.objectType);
  // Process Builder: the record is myVariable_current / myVariable_old, its type in processMetadataValues
  const pbType = asList(md.processMetadataValues).find((p) => p?.name === 'ObjectType')?.value?.stringValue;
  if (pbType) for (const n of ['myvariable_current', 'myvariable_old']) if (!vars.has(n)) vars.set(n, pbType);
  for (const el of asList(md.recordLookups)) {
    if (!el?.object) continue;
    if (el.name && el.storeOutputAutomatically !== false) vars.set(low(el.name), el.object);
    if (el.outputReference) vars.set(low(el.outputReference), el.object);
  }
  for (const el of asList(md.loops)) {
    const o = vars.get(low(el?.collectionReference));
    if (o && el.name) vars.set(low(el.name), o);
  }
  const fields = [];
  const seen = new Set();
  const add = (object, field, access, element) => {
    if (!object || !field || !/^[A-Za-z]\w*$/.test(field)) return;
    const k = `${low(object)}|${low(field)}|${access}|${element}`;
    if (seen.has(k)) return;
    seen.add(k);
    fields.push({ object, field, access, element });
  };
  const nameOf = (el, kind) => `${kind}: ${el?.label || el?.name || ''}`.trim();

  for (const f of asList(md.start?.filters)) add(startObj, f?.field, 'read', 'Start: entry conditions');
  for (const [key, kind, access] of RECORD_ELEMENTS) {
    for (const el of asList(md[key])) {
      const obj = el?.object || vars.get(low(el?.inputReference)) || null;
      const where = nameOf(el, kind);
      for (const a of asList(el?.inputAssignments)) add(obj, a?.field, access, where);
      for (const f of asList(el?.filters)) add(obj, f?.field, 'read', where);
      for (const q of asList(el?.queriedFields)) add(obj, typeof q === 'string' ? q : q?.field, 'read', where);
      for (const o of asList(el?.outputAssignments)) add(obj, o?.field, 'read', where);
      // Update Records on $Record (no field list): the record itself is saved with whatever was assigned
    }
  }
  // X.Field anywhere (values, conditions, formulas, templates), X being a record variable; assignToReference writes
  const scan = (v, where, key) => {
    if (v == null) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(/(\$?[A-Za-z_][\w$]*)\.([A-Za-z_]\w*)/g)) {
        const obj = vars.get(low(m[1]));
        if (obj) add(obj, m[2], key === 'assignToReference' ? 'write' : 'read', where);
      }
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) scan(x, where, key); return; }
    for (const [k, x] of Object.entries(v)) scan(x, where, k);
  };
  for (const [key, kind] of Object.entries(ELEMENT_KINDS)) {
    for (const el of asList(md[key])) scan(el, key === 'start' ? 'Start' : nameOf(el, kind), '');
  }
  const apex = asList(md.actionCalls).filter((a) => low(a?.actionType) === 'apex' && a.actionName)
    .map((a) => ({ className: String(a.actionName).split('.').pop(), element: nameOf(a, 'Action') }));
  const subflows = asList(md.subflows).map((s) => s?.flowName).filter(Boolean);
  return { object: startObj, fields, apex, subflows };
}

// ---------- docs → usages ----------

const textOf = (doc) => (doc.lines || []).map((l) => l.text ?? '').join('\n');
const lineHits = (text, re) => {
  const out = [];
  text.split('\n').forEach((t, i) => { re.lastIndex = 0; if (re.test(t)) out.push({ line: i + 1, text: t.trim() }); });
  return out;
};

// LWC files and Aura definitions come one per doc: put each component back together
function bundles(docs) {
  const map = new Map();
  for (const d of docs || []) {
    const k = `${d.kind}|${d.name}`;
    if (!map.has(k)) map.set(k, { kind: d.kind, name: d.name, link: d.link, files: [] });
    map.get(k).files.push({ name: d.sub || d.name, text: textOf(d), code: d.code });
  }
  return [...map.values()];
}

const ENTRY = {
  flow: 'Flow', process: 'Process Builder', validation: 'Validation rule', formula: 'Formula field', lwc: 'LWC', aura: 'Aura', vf: 'Visualforce',
};

function flowUsage(doc, refs) {
  return {
    key: `${doc.kind}:${doc.id}`, kind: doc.kind, name: doc.name, title: doc.title || doc.name, sub: doc.sub, inactive: !!doc.inactive, link: doc.link,
    entry: { kind: doc.kind, label: ENTRY[doc.kind], detail: doc.sub }, refs,
  };
}

/**
 * Everything outside Apex that uses Object.Field.
 * sources: { flow, validation, lwc, aura, vf } (FBI Search docs; flows carry .refs, rules .formula + .object),
 * formulas: [{ name, label, formula }] — formula fields of this object (from its describe).
 */
export function fieldUsages(sources, object, field, formulas = []) {
  const O = low(object);
  const F = low(field);
  const out = [];
  const sameField = (f) => low(f) === F || (F.endsWith('id') && low(f) === F.slice(0, -2)) || (F.endsWith('__c') && low(f) === F.replace(/__c$/, '__r'));

  for (const d of sources.flow || []) {
    const refs = (d.refs?.fields || []).filter((r) => low(r.object) === O && sameField(r.field))
      .map((r) => ({ access: r.access, where: r.element, text: `${r.object}.${r.field}` }));
    if (refs.length) out.push(flowUsage(d, refs));
  }

  // a formula mentions the field by name (same object), or through a lookup to this object (Account.Industry on Contact)
  const fieldRe = new RegExp(`(^|[^.\\w$])${esc(field)}\\b`, 'i');
  const relRe = new RegExp(`\\b(${esc(object.replace(/__c$/i, '__r'))}|${esc(object)})\\.${esc(field)}\\b`, 'i');
  const formulaRefs = (formula, own) => lineHits(String(formula || ''), own ? fieldRe : relRe).map((h) => ({ access: 'read', where: `Formula, line ${h.line}`, text: h.text, line: h.line, possible: !own }));
  for (const d of sources.validation || []) {
    if (!d.formula) continue;
    const own = low(d.object) === O;
    const refs = formulaRefs(d.formula, own);
    if (!refs.length) continue;
    out.push({
      key: `validation:${d.id}`, kind: 'validation', name: d.name, title: d.name, sub: d.sub, inactive: !!d.inactive, link: d.link,
      entry: { kind: 'validation', label: ENTRY.validation, detail: `${d.object || 'object'}: runs on every save` }, refs, source: d.formula,
    });
  }
  for (const f of formulas) {
    if (low(f.name) === F) continue;
    const refs = formulaRefs(f.formula, true);
    if (!refs.length) continue;
    out.push({
      key: `formula:${object}.${f.name}`, kind: 'formula', name: `${object}.${f.name}`, title: f.label, sub: `Formula field on ${object}`, link: f.link,
      entry: { kind: 'formula', label: ENTRY.formula, detail: 'calculated whenever the record is read' }, refs, source: f.formula,
    });
  }

  // components: '@salesforce/schema/Account.Industry', 'Account.Industry', {!Account.Industry}; or field-name="Industry"
  // next to object-api-name="Account" (that one is marked possible: the object match is by the same component)
  const exactRe = new RegExp(`(@salesforce/schema/|['"\`{!]|\\b)${esc(object)}\\.${esc(field)}\\b`, 'i');
  const objRe = new RegExp(`(object-api-name|objectApiName|sObjectName|standardController|@salesforce/schema/)\\s*[=:]?\\s*["'{]?${esc(object)}\\b`, 'i');
  const nameRe = new RegExp(`(field-name|fieldName|fields|field)\\s*[=:]\\s*[{"'\\[][^\\n]*?\\b${esc(field)}\\b`, 'i');
  const inputRe = new RegExp(`(<apex:inputField[^>]*\\.${esc(field)}\\b|<lightning-input-field[^>]*\\b${esc(field)}\\b|updateRecord|createRecord|lightning-record-edit-form)`, 'i');
  for (const b of [...bundles(sources.lwc), ...bundles(sources.aura), ...(sources.vf || []).map((d) => ({ kind: 'vf', name: d.name, link: d.link, sub: d.sub, files: [{ name: `${d.name}.${d.sub === 'component' ? 'component' : 'page'}`, text: textOf(d) }] }))]) {
    const all = b.files.map((f) => f.text).join('\n');
    const mentionsObject = objRe.test(all);
    const refs = [];
    for (const f of b.files) {
      for (const h of lineHits(f.text, exactRe)) refs.push({ access: 'uses', where: `${f.name}, line ${h.line}`, text: h.text, line: h.line });
      if (mentionsObject) for (const h of lineHits(f.text, nameRe)) if (!refs.some((r) => r.where === `${f.name}, line ${h.line}`)) refs.push({ access: 'uses', where: `${f.name}, line ${h.line}`, text: h.text, line: h.line, possible: true });
    }
    if (!refs.length) continue;
    const edits = inputRe.test(all);
    for (const r of refs) if (edits && /input|edit|value=|updateRecord|createRecord/i.test(r.text)) r.access = 'write';
    out.push({
      key: `${b.kind}:${b.name}`, kind: b.kind, name: b.name, title: b.name, sub: b.kind === 'vf' ? `Visualforce ${b.sub || 'page'}` : `${ENTRY[b.kind]} component`, link: b.link,
      entry: { kind: b.kind, label: ENTRY[b.kind], detail: 'shown to users' }, refs, files: b.files,
    });
  }
  return out;
}

/**
 * Everything outside Apex that calls an Apex method directly.
 * m: { className, name, annots: [lowercased annotations], isStatic }
 */
export function methodUsages(sources, m) {
  const C = m.className;
  const n = m.name;
  const out = [];
  const annots = new Set((m.annots || []).map(low));

  // LWC: import x from '@salesforce/apex/Class.method' (optionally namespace.Class.method)
  const lwcRe = new RegExp(`@salesforce/apex/(?:\\w+\\.)?${esc(C)}\\.${esc(n)}['"]`, 'i');
  for (const b of bundles(sources.lwc)) {
    const refs = [];
    for (const f of b.files) for (const h of lineHits(f.text, lwcRe)) refs.push({ access: 'calls', where: `${f.name}, line ${h.line}`, text: h.text, line: h.line });
    if (refs.length) out.push({ key: `lwc:${b.name}`, kind: 'lwc', name: b.name, title: b.name, sub: 'Lightning web component', link: b.link, entry: { kind: 'lwc', label: 'LWC', detail: 'imports this method' }, refs, files: b.files });
  }
  // Aura: controller="Class" in the markup, and c.method in its JS
  const ctrlRe = new RegExp(`controller\\s*=\\s*["'](?:\\w+\\.)?${esc(C)}["']`, 'i');
  const actRe = new RegExp(`["']c\\.${esc(n)}["']`);
  for (const b of bundles(sources.aura)) {
    if (!b.files.some((f) => ctrlRe.test(f.text))) continue;
    const refs = [];
    for (const f of b.files) for (const h of lineHits(f.text, actRe)) refs.push({ access: 'calls', where: `${f.name}, line ${h.line}`, text: h.text, line: h.line });
    if (refs.length) out.push({ key: `aura:${b.name}`, kind: 'aura', name: b.name, title: b.name, sub: 'Aura component', link: b.link, entry: { kind: 'aura', label: 'Aura', detail: `controller ${C}` }, refs, files: b.files });
  }
  // Visualforce: the class is the controller / an extension, and the page uses {!method}, {!property} (getX) or remotes it
  const vfCtrlRe = new RegExp(`(controller|extensions)\\s*=\\s*["'][^"']*\\b${esc(C)}\\b`, 'i');
  const prop = /^get[A-Z]/.test(n) ? n[3].toLowerCase() + n.slice(4) : null;
  const vfUseRe = new RegExp(`(\\{!\\s*${esc(n)}\\s*[}(]|\\{!\\s*${prop ? esc(prop) : '\\u0000'}\\s*[}.\\[]|\\b${esc(C)}\\.${esc(n)}\\s*\\()`, 'i');
  for (const d of sources.vf || []) {
    const text = textOf(d);
    const remote = annots.has('remoteaction') && new RegExp(`\\b${esc(C)}\\.${esc(n)}\\s*\\(`).test(text);
    if (!vfCtrlRe.test(text) && !remote) continue;
    const refs = lineHits(text, vfUseRe).map((h) => ({ access: 'calls', where: `line ${h.line}`, text: h.text, line: h.line }));
    if (refs.length) out.push({ key: `vf:${d.name}`, kind: 'vf', name: d.name, title: d.name, sub: `Visualforce ${d.sub || 'page'}`, link: d.link, entry: { kind: 'vf', label: 'Visualforce', detail: d.sub || 'page' }, refs, files: [{ name: d.name, text }] });
  }
  // Flows: an Apex action runs the class's @InvocableMethod
  if (annots.has('invocablemethod')) {
    for (const d of sources.flow || []) {
      const calls = (d.refs?.apex || []).filter((a) => low(a.className) === low(C));
      if (calls.length) out.push(flowUsage(d, calls.map((a) => ({ access: 'calls', where: a.element, text: `Apex action ${C}` }))));
    }
  }
  return out;
}

export const USAGE_LABEL = ENTRY;
