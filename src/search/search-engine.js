// OG Search engine: turns org metadata into searchable "docs" (lines of text) and finds a text in them.
// Pure functions, no DOM or network, so the tests can run them.
//
// doc: { kind, id, name, sub, lines: [{ text, label? }], meta }  — label: where in a flow / rule the line comes from

export const KINDS = {
  apex: { label: 'Apex classes', short: 'Apex', icon: '⌁' },
  trigger: { label: 'Apex triggers', short: 'Triggers', icon: '⚡' },
  flow: { label: 'Flows', short: 'Flows', icon: '⤳' },
  process: { label: 'Process Builder', short: 'Process Builder', icon: '⚙' },
  validation: { label: 'Validation rules', short: 'Validation', icon: '✓' },
  vf: { label: 'Visualforce', short: 'VF', icon: '◧' },
  lwc: { label: 'Lightning Web Components', short: 'LWC', icon: '◇' },
  aura: { label: 'Aura components', short: 'Aura', icon: '◈' },
  label: { label: 'Custom labels', short: 'Labels', icon: '🏷' },
};

/**
 * A pasted Salesforce error often carries an error code and a field list around the message people wrote:
 *   "Update failed. First exception on row 0 …; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Close Reason is required: [Close_Reason__c]"
 * Returns the human part ("Close Reason is required") or null when there's nothing to trim.
 */
export function trimErrorText(input) {
  let s = String(input || '').trim();
  const before = s;
  s = s.replace(/^.*?first error:\s*/i, '');
  s = s.replace(/^[A-Z][A-Z0-9_]{5,},\s*/, ''); // FIELD_CUSTOM_VALIDATION_EXCEPTION,
  s = s.replace(/^(System\.)?\w+Exception:\s*/, ''); // System.DmlException:
  s = s.replace(/^(Error|Review the errors on this page)[.:]\s*/i, '');
  s = s.replace(/\s*:\s*\[[\w\s,.]*\]\s*$/, ''); // : [Close_Reason__c]
  s = s.replace(/\s*Class\.[\w.]+: line \d+, column \d+[\s\S]*$/, ''); // a stack trace after the message
  s = s.trim().replace(/[.\s]+$/, '');
  return s && s !== before.replace(/[.\s]+$/, '') ? s : null;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for the query, or { error } for an invalid regex. Whitespace in the query matches any whitespace run. */
export function makeMatcher(q, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
  const text = String(q || '').trim();
  if (!text) return null;
  let src;
  if (regex) src = text;
  else src = text.split(/\s+/).map(escRe).join('\\s+');
  if (wholeWord) src = `(?<![\\w])(?:${src})(?![\\w])`;
  try {
    const re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    return { re, q: text, test: (s) => { re.lastIndex = 0; return re.test(s); } };
  } catch (e) {
    return { error: e.message };
  }
}

/** [{ start, end }] of every match in a string (for highlighting). */
export function matchRanges(m, s) {
  const out = [];
  m.re.lastIndex = 0;
  let r;
  while ((r = m.re.exec(s)) && out.length < 50) {
    if (r[0] === '') { m.re.lastIndex++; continue; }
    out.push({ start: r.index, end: r.index + r[0].length });
  }
  return out;
}

/**
 * Search docs. Returns { results: [{ doc, hits: [{ i, text, label }] , total }], docsHit, linesHit, capped }.
 * maxPerDoc / maxLines keep the UI fast on huge orgs; `total` still counts every matching line of a doc.
 */
export function search(docs, m, { maxPerDoc = 30, maxLines = 4000 } = {}) {
  const results = [];
  let linesHit = 0;
  let capped = false;
  for (const doc of docs) {
    const nameHit = m.test(doc.name) || (doc.sub && m.test(doc.sub));
    const hits = [];
    let total = 0;
    for (let i = 0; i < doc.lines.length; i++) {
      const ln = doc.lines[i];
      if (!m.test(ln.text) && !(ln.label && m.test(ln.label))) continue;
      total++;
      if (hits.length < maxPerDoc && linesHit < maxLines) { hits.push({ i, text: ln.text, label: ln.label || null }); linesHit++; } else capped = true;
    }
    if (total || nameHit) results.push({ doc, hits, total, nameHit, score: score(doc, hits, total, nameHit, m) });
  }
  // the most relevant first: where an error message would really live, exact lines, then more hits
  results.sort((a, b) => b.score - a.score || b.total - a.total || a.doc.name.localeCompare(b.doc.name));
  return { results, docsHit: results.length, linesHit, capped };
}

// Messages people see on a record page are written in these places
const MESSAGE_LABEL = /error message|custom error|errormessage|validationrule|^value$/i;
const norm = (s) => s.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').toLowerCase();

function score(doc, hits, total, nameHit, m) {
  let s = Math.min(total, 10);
  const q = m.q ? norm(m.q) : '';
  for (const h of hits) {
    const inMessage = h.label && MESSAGE_LABEL.test(h.label);
    if (inMessage) s += 20;
    if (q && norm(h.text) === q) s += inMessage ? 30 : 10; // the whole line is the text
    if (/addError\s*\(|throw new|AuraHandledException|ShowToastEvent|errorMessage|messageWhen/i.test(h.text)) s += 8; // code that raises it
  }
  if (nameHit) s += 3;
  if (doc.inactive) s -= 5; // inactive rules and flows can't be the cause
  return s;
}

// ---------- building docs ----------

export const linesOf = (text) => String(text || '').split(/\r?\n/).map((t) => ({ text: t }));

// Flow metadata keys that hold elements, and how to call them
const FLOW_ELEMENTS = {
  actionCalls: 'Action', apexPluginCalls: 'Apex plugin', assignments: 'Assignment', choices: 'Choice', collectionProcessors: 'Collection',
  constants: 'Constant', customErrors: 'Custom error', decisions: 'Decision', dynamicChoiceSets: 'Choice set', formulas: 'Formula',
  loops: 'Loop', orchestratedStages: 'Stage', recordCreates: 'Create records', recordDeletes: 'Delete records', recordLookups: 'Get records',
  recordRollbacks: 'Roll back', recordUpdates: 'Update records', screens: 'Screen', start: 'Start', steps: 'Step', subflows: 'Subflow',
  textTemplates: 'Text template', transforms: 'Transform', variables: 'Variable', waits: 'Pause',
};
const SKIP_KEYS = new Set(['locationX', 'locationY', 'processMetadataValues', 'connector', 'faultConnector', 'defaultConnector', 'nextValueConnector', 'noMoreValuesConnector', 'targetReference']);

/**
 * Flatten flow metadata into readable lines: "Custom error · Block_Close › errorMessage" = "Close reason can't be blank".
 * Only string values that people write or read are kept (labels, messages, formulas, field references, values).
 */
export function flowLines(md) {
  const out = [];
  if (!md || typeof md !== 'object') return out;
  for (const key of ['label', 'description', 'interviewLabel']) if (typeof md[key] === 'string' && md[key]) out.push({ label: `Flow › ${key}`, text: md[key] });
  for (const [key, kind] of Object.entries(FLOW_ELEMENTS)) {
    const v = md[key];
    const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
    for (const el of list) {
      const name = el?.label || el?.name || kind;
      walk(el, [], (path, text) => out.push({ label: `${kind} · ${name}${path.length ? ` › ${path.join('.')}` : ''}`, text }));
    }
  }
  return out;
}

function walk(v, path, emit, depth = 0) {
  if (depth > 12 || v == null) return;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return;
    // keep text people write (anything that isn't a bare identifier), and identifiers where they name a field,
    // object or value (so API names are searchable too); skip internal element names and enum-like settings
    const key = (path[path.length - 1] || '').replace(/\[\d+\]$/, '');
    if (!/^\w+$/.test(s) || /(field|object|value|label|message|formula|text|expression|reference|selection)$/i.test(key)) emit(path, v);
    return;
  }
  if (typeof v !== 'object') return;
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...path.slice(0, -1), `${path[path.length - 1] || 'item'}[${i}]`], emit, depth + 1)); return; }
  for (const [k, x] of Object.entries(v)) {
    if (SKIP_KEYS.has(k) || k === 'name' && depth === 0) continue;
    walk(x, [...path, k], emit, depth + 1);
  }
}

/** Process Builder flows have ProcessType "Workflow"; everything else is a Flow. */
export function flowKind(processType) {
  return processType === 'Workflow' || processType === 'CustomEvent' || processType === 'InvocableProcess' ? 'process' : 'flow';
}

export function flowTypeLabel(processType, triggerType) {
  if (flowKind(processType) === 'process') return 'Process Builder';
  if (processType === 'Flow') return 'Screen flow';
  if (triggerType === 'RecordAfterSave' || triggerType === 'RecordBeforeSave' || triggerType === 'RecordBeforeDelete') return 'Record-triggered flow';
  if (triggerType === 'PlatformEvent') return 'Platform event flow';
  if (triggerType === 'Scheduled') return 'Scheduled flow';
  return { AutoLaunchedFlow: 'Autolaunched flow', Orchestrator: 'Orchestration', ContactRequestFlow: 'Contact request flow' }[processType] || processType || 'Flow';
}

/** Validation rule → lines with labels for its parts. */
export function validationLines(r) {
  const out = [];
  if (r.ErrorMessage) out.push({ label: 'Error message', text: r.ErrorMessage });
  if (r.ErrorDisplayField) out.push({ label: 'Shown on field', text: r.ErrorDisplayField });
  if (r.Description) for (const t of r.Description.split(/\r?\n/)) out.push({ label: 'Description', text: t });
  if (r.formula) for (const t of r.formula.split(/\r?\n/)) out.push({ label: 'Formula', text: t });
  return out;
}

/** Rough memory of a doc set (strings are 2 bytes a char in the worst case, plus per-line objects). */
export function docsBytes(docs) {
  let b = 0;
  for (const d of docs) for (const l of d.lines) b += (l.text.length + (l.label?.length || 0)) * 2 + 48;
  return b;
}
