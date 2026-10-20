// Data Import: paste from Excel, CSV or JSON (or drop a file), pick what to do (insert, update, upsert,
// delete, undelete), check how columns map to fields, then run it in batches with several threads.
// Each row shows its status and result; failed rows can be fixed and retried, results copied out.

import { h } from '../dom.js';
import {
  ACTIONS, parseData, detectObject, suggestAction, guessField, checkColumn, missingRequired, buildRecord, chunks, exportRows, isMetaColumn,
} from './import-core.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const PREFS = 'og-import-prefs';
const ROW_H = 30;
const num = (n) => n.toLocaleString();
const plural = (n, w) => `${num(n)} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2600);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg, 'ok');
}
function modal({ title, body, actions }) {
  const card = h('div', { class: 'dx-modal-card di-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title), body, h('div', { class: 'dx-modal-actions' }, actions));
  const wrap = h('div', { class: 'dx-modal' }, card);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  (card.querySelector('input[type="text"]') || card.querySelector('.dx-modal-actions button:last-child'))?.focus();
  return { close, card };
}

const STATUS = { queued: 'Queued', processing: 'Processing', ok: 'Succeeded', failed: 'Failed' };

export function mountImport(root, backend, opts = {}) {
  const prefs = store.get(PREFS, {});
  const S = {
    active: false, objects: null, data: null, source: '',
    action: 'insert', actionAuto: true, object: '', objectHow: null, matchField: '',
    desc: null, descErr: null, descFor: null,
    map: [], status: [], result: [],
    show: { queued: true, processing: true, ok: true, failed: true },
    running: null,
    batchSize: prefs.batchSize || 200, threads: prefs.threads || 6,
    blankToNull: !!prefs.blankToNull, allowDupes: !!prefs.allowDupes, noAssign: !!prefs.noAssign, headers: prefs.headers || '',
    moreOpen: !!prefs.moreOpen,
  };
  const el = {};
  const savePrefs = () => store.set(PREFS, { batchSize: S.batchSize, threads: S.threads, blankToNull: S.blankToNull, allowDupes: S.allowDupes, noAssign: S.noAssign, headers: S.headers, moreOpen: S.moreOpen });

  // ---------- layout ----------
  el.config = h('section', { class: 'di-card di-config', 'aria-label': 'Configure import' });
  el.mapping = h('section', { class: 'di-card di-mapping', 'aria-label': 'Field mapping' });
  el.bar = h('div', { class: 'di-bar' });
  el.body = h('section', { class: 'di-body' });
  root.replaceChildren(h('div', { class: 'di-top' }, el.config, el.mapping), el.bar, el.body);
  el.fieldList = h('datalist', { id: 'di-fields' });
  el.objList = h('datalist', { id: 'di-objects' });
  root.append(el.fieldList, el.objList);

  // ---------- data in ----------
  function loadText(text, source) {
    if (S.running) { toast('Wait for the current run to finish, or cancel it first', 'error'); return; }
    const d = parseData(text);
    if (!d.headers.length || !d.rows.length) { toast(d.headers.length ? 'Only a header row: add some data rows under it' : 'Couldn’t find a table in that. Copy cells from Excel, or paste CSV or JSON.', 'error'); return; }
    S.data = d;
    S.source = source;
    S.map = d.headers.map(() => ({ target: '', skipped: false, edited: false }));
    S.status = d.rows.map(() => 'queued');
    S.result = d.rows.map(() => null);
    const found = detectObject(d, S.objects || []);
    // new data the object can't be read from: don't keep the last one (Contact rows into Account…), ask
    if (found) { S.object = found.name; S.objectHow = found.how; } else { S.object = ''; S.objectHow = null; S.descFor = null; S.desc = null; }
    if (S.actionAuto) S.action = suggestAction(d.headers);
    loadDescribe();
    drawAll();
    if (!found) el.config.querySelector('input[list="di-objects"]')?.focus();
    toast(`${plural(d.rows.length, 'row')} · ${d.headers.length} columns from ${source}${found ? ` · looks like ${found.name}` : ''}`, 'ok');
  }

  // a paste anywhere in the view (not into an input) is data
  document.addEventListener('paste', (e) => {
    if (!S.active || root.closest('[hidden]')) return;
    const t = e.target;
    if (t.closest?.('input, select, textarea:not(.di-paste)')) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    loadText(text, 'the clipboard');
  });
  async function loadFile(file) {
    if (!file) return;
    if (/\.(xlsx|xls)$/i.test(file.name)) { toast('Excel files can’t be read directly: open it, select the cells, copy and paste them here', 'error'); return; }
    if (file.size > 30 * 1024 * 1024) { toast('That file is over 30 MB. Split it into smaller files.', 'error'); return; }
    loadText(await file.text(), file.name);
  }
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); root.classList.add('di-drag'); } });
  root.addEventListener('dragleave', (e) => { if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('di-drag'); });
  root.addEventListener('drop', (e) => { if (!e.dataTransfer?.files?.length) return; e.preventDefault(); root.classList.remove('di-drag'); loadFile(e.dataTransfer.files[0]); });

  // ---------- object & fields ----------
  async function loadObjects() {
    try {
      S.objects = await backend.listObjects();
      el.objList.replaceChildren(...S.objects.map((o) => h('option', { value: o.name }, o.label)));
      if (S.data && !S.object) {
        const found = detectObject(S.data, S.objects);
        if (found) { S.object = found.name; S.objectHow = found.how; loadDescribe(); }
      }
    } catch (e) { S.objects = []; S.objectsErr = e.message; }
    drawConfig();
  }

  let descSeq = 0;
  async function loadDescribe() {
    const name = S.object.trim();
    if (!name) { S.desc = null; S.descFor = null; drawMapping(); return; }
    if (S.descFor === name.toLowerCase() && (S.desc || S.descErr)) { autoMap(); drawAll(); return; }
    const seq = ++descSeq;
    S.desc = null;
    S.descErr = null;
    S.descFor = name.toLowerCase();
    drawMapping();
    try {
      const d = await backend.describe(name);
      if (seq !== descSeq) return;
      S.desc = d;
      S.object = d.name;
      el.fieldList.replaceChildren(...d.fields.map((f) => h('option', { value: f.name }, `${f.label} · ${f.type}`)));
    } catch (e) {
      if (seq !== descSeq) return;
      S.descErr = /NOT_FOUND|does not exist/i.test(e.message) ? `There’s no object called ${name} (or you can’t see it)` : e.message;
    }
    autoMap();
    drawAll();
  }

  // columns the user hasn't touched follow the object's fields
  function autoMap() {
    if (!S.data || !S.desc) return;
    S.data.headers.forEach((hd, i) => {
      const m = S.map[i];
      if (m.edited) return;
      m.target = guessField(hd, S.desc.fields) || (isMetaColumn(hd) ? '' : hd.trim());
      m.skipped = false;
    });
    const keys = matchFields();
    if (S.action === 'upsert' && !keys.some((f) => f.name === S.matchField)) S.matchField = keys.some((f) => f.name === 'Id') && columns().some((c) => c.field === 'Id') ? 'Id' : (keys.find((f) => f.externalId)?.name || 'Id');
  }

  const matchFields = () => (S.desc?.fields || []).filter((f) => f.idLookup || f.externalId);

  function columns() {
    if (!S.data) return [];
    return S.data.headers.map((hd, i) => ({ index: i, header: hd, ...checkColumn(hd, S.map[i].target, { fields: S.desc?.fields || [], action: S.action, skipped: S.map[i].skipped }) }));
  }

  /** Why Run can't go yet, or null. */
  function blocker(cols = columns()) {
    if (!S.data) return 'Paste some data first';
    if (!S.object.trim()) return 'Pick the object to import into';
    if (S.descErr) return S.descErr;
    if (!S.desc) return 'Loading the object’s fields…';
    const bad = cols.filter((c) => c.state === 'unknown' || c.state === 'readonly');
    if (bad.length) return `Fix or skip ${plural(bad.length, 'column')} marked in red`;
    if (ACTIONS[S.action].needsId && !cols.some((c) => c.field === 'Id' && c.state === 'ok')) return `${ACTIONS[S.action].label} needs an Id column`;
    if (S.action === 'upsert' && !cols.some((c) => c.field?.toLowerCase() === (S.matchField || 'Id').toLowerCase())) return `Upsert matches on ${S.matchField || 'Id'}: add that column, or match on another field`;
    if (!S.status.some((s) => s === 'queued')) return 'Nothing queued: every row has run. Retry the failed ones, or re-queue all.';
    if (!['insert', 'upsert'].includes(S.action) && S.desc && S.objects) {
      const o = S.objects.find((x) => x.name === S.desc.name);
      if (o && S.action === 'delete' && o.deletable === false) return `${o.name} records can’t be deleted`;
      if (o && S.action === 'undelete' && o.undeletable === false) return `${o.name} records can’t be undeleted`;
    }
    return null;
  }

  // ---------- drawing ----------
  function drawAll() { drawConfig(); drawMapping(); drawBar(); drawBody(); }

  function drawConfig() {
    const actionBtns = Object.entries(ACTIONS).map(([k, a]) => h('button', {
      role: 'radio', 'aria-checked': String(S.action === k), class: `di-act k-${k}`, disabled: !!S.running,
      onclick: () => { S.action = k; S.actionAuto = false; autoMap(); drawAll(); },
    }, h('span', { 'aria-hidden': 'true' }, a.icon), a.label));
    const objIn = h('input', {
      type: 'text', class: 'di-mono', list: 'di-objects', value: S.object, placeholder: 'e.g. Account, WorkOrder', spellcheck: 'false', 'aria-label': 'Object', disabled: !!S.running,
      onchange: (e) => { S.object = e.target.value.trim(); S.objectHow = 'manual'; for (const m of S.map) if (!m.edited) m.target = ''; loadDescribe(); },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    });
    const how = S.objectHow && S.objectHow !== 'manual' && S.object ? h('span', { class: 'di-detected', title: S.objectHow === 'id prefix' ? 'From the first characters of the record Ids' : 'From the type column in the data' }, '✓ detected from ', S.objectHow === 'id prefix' ? 'Ids' : 'data') : null;
    const keys = matchFields();
    const org = backend.orgLabel?.() || { name: '', sandbox: true };
    const num2 = (label, key, min, max, help) => h('label', { class: 'di-field small' }, h('span', { class: 'di-label', title: help }, label, ' ', h('span', { class: 'di-help' }, 'ⓘ')),
      h('input', { type: 'number', min, max, value: S[key], disabled: !!S.running, oninput: (e) => { S[key] = Math.max(min, Math.min(max, Math.round(+e.target.value) || min)); savePrefs(); drawBar(); }, onblur: (e) => { e.target.value = S[key]; } }));
    const check = (key, label, help, show = true) => (show ? h('label', { class: 'di-check', title: help }, h('input', { type: 'checkbox', checked: S[key], onchange: (e) => { S[key] = e.target.checked; savePrefs(); } }), label) : null);
    el.config.replaceChildren(
      h('div', { class: 'di-card-head' }, h('h2', {}, 'Configure import'), h('span', { class: `di-org ${org.sandbox ? 'sb' : 'prod'}`, title: org.sandbox ? 'A sandbox' : 'Production: changes are real' }, org.sandbox ? '🧪 ' : '⚠ ', org.name)),
      h('div', { class: 'di-actions', role: 'radiogroup', 'aria-label': 'Action' }, actionBtns),
      h('p', { class: 'di-act-help' }, ACTIONS[S.action].help),
      h('div', { class: 'di-grid' },
        h('label', { class: 'di-field' }, h('span', { class: 'di-label' }, 'Object', how), objIn),
        S.action === 'upsert' ? h('label', { class: 'di-field' }, h('span', { class: 'di-label', title: 'Rows whose value matches an existing record update it; the rest are created' }, 'Match on ', h('span', { class: 'di-help' }, 'ⓘ')),
          h('select', { disabled: !S.desc || !!S.running, onchange: (e) => { S.matchField = e.target.value; drawAll(); } },
            (keys.length ? keys : [{ name: 'Id', label: 'Record ID' }]).map((f) => h('option', { value: f.name, selected: f.name === S.matchField }, `${f.name}${f.externalId ? ' · external id' : ''}`)))) : h('span'),
        num2('Batch size', 'batchSize', 1, 200, 'Records per API call: 1–200. Smaller batches help when triggers hit governor limits.'),
        num2('Threads', 'threads', 1, 10, 'Batches sent at the same time: 1–10. Use 1 to avoid record-locking errors (UNABLE_TO_LOCK_ROW).')),
      h('details', { class: 'di-more', open: S.moreOpen, ontoggle: (e) => { S.moreOpen = e.target.open; savePrefs(); } },
        h('summary', {}, 'More options'),
        h('div', { class: 'di-checks' },
          check('blankToNull', 'Blank cells clear the field', 'Update / upsert: an empty cell sets the field to empty. Off: empty cells leave the field as it is.', S.action === 'update' || S.action === 'upsert'),
          check('allowDupes', 'Save even if duplicate rules alert', 'Sends Sforce-Duplicate-Rule-Header: allowSave=true'),
          check('noAssign', 'Don’t run assignment rules', 'Leads and Cases: sends Sforce-Auto-Assign: FALSE')),
        h('label', { class: 'di-field' }, h('span', { class: 'di-label' }, 'Custom headers', h('span', { class: 'di-muted' }, ' · one per line, Name: value')),
          h('textarea', { class: 'di-mono di-headers', rows: 2, spellcheck: 'false', placeholder: 'Sforce-Call-Options: client=OG', value: S.headers, oninput: (e) => { S.headers = e.target.value; savePrefs(); } }, S.headers))),
    );
  }

  function drawMapping() {
    const head = (extra) => h('div', { class: 'di-card-head' }, h('h2', {}, 'Field mapping'), extra);
    if (!S.data) { el.mapping.replaceChildren(head(), h('p', { class: 'di-placeholder' }, 'Paste data and each column shows up here with the field it goes into.')); return; }
    if (!S.object.trim()) { el.mapping.replaceChildren(head(), h('p', { class: 'di-placeholder' }, 'Which object is this? The data doesn’t say: type it in ', h('b', {}, 'Object'), ' on the left (e.g. Contact), and the columns are matched to its fields.')); return; }
    if (S.descErr) { el.mapping.replaceChildren(head(), h('p', { class: 'di-placeholder err' }, S.descErr)); return; }
    if (!S.desc) { el.mapping.replaceChildren(head(), h('div', { class: 'di-loading' }, h('span', { class: 'lg-spinner' }), `Reading the fields of ${S.object}…`)); return; }
    const cols = columns();
    const n = (st) => cols.filter((c) => st.includes(c.state)).length;
    const bad = n(['unknown', 'readonly']);
    const missing = missingRequired(S.desc.fields, cols.filter((c) => c.state === 'ok' || c.state === 'rel').map((c) => c.field), S.action);
    const fieldOf = (name) => S.desc.fields.find((f) => f.name.toLowerCase() === String(name).toLowerCase());
    const rows = cols.map((c) => {
      const m = S.map[c.index];
      const sample = S.data.rows.find((r) => String(r[c.index] ?? '').trim() !== '')?.[c.index];
      const blocked = c.state === 'unknown' || c.state === 'readonly';
      const input = h('input', {
        type: 'text', class: `di-mono${blocked ? ' bad' : ''}`, list: 'di-fields', value: m.target, spellcheck: 'false', disabled: m.skipped || c.state === 'meta' || !!S.running,
        'aria-label': `Field for column ${c.header}`, placeholder: 'Type a field name',
        onchange: (e) => { m.target = e.target.value.trim(); m.edited = true; drawAll(); },
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      });
      const f = c.field && fieldOf(c.field);
      return h('div', { class: `di-map s-${c.state}`, 'data-col': c.index },
        h('div', { class: 'di-map-col' }, h('b', { title: c.header }, c.header), sample != null ? h('small', { title: String(sample) }, String(sample).slice(0, 40)) : null),
        h('span', { class: 'di-map-arrow', 'aria-hidden': 'true' }, '→'),
        input,
        h('span', { class: `di-map-st s-${c.state}`, title: f ? `${f.label} (${f.name})` : c.detail }, { ok: '✓ ', rel: '🔗 ', unknown: '✗ ', readonly: '✗ ', skip: '', meta: '', unused: '', ignored: '' }[c.state], c.state === 'ok' && f ? `${f.label} · ${c.detail}` : c.detail),
        c.state === 'meta' ? h('span') : h('button', { class: 'ghost small', disabled: !!S.running, onclick: () => { m.skipped = !m.skipped; m.edited = true; drawAll(); } }, m.skipped ? 'Use' : 'Skip'));
    });
    el.mapping.replaceChildren(...[ // (filter: replaceChildren would print a null as "null")
      head(h('span', { class: 'di-map-sum' },
        h('span', { class: 'ok' }, `${n(['ok', 'rel'])} mapped`),
        bad ? h('span', { class: 'bad' }, `${bad} to fix`) : null,
        n(['skip']) ? h('span', {}, `${n(['skip'])} skipped`) : null,
        h('button', { class: 'ghost small', disabled: !bad || !!S.running, onclick: () => { for (const c of cols) if (c.state === 'unknown' || c.state === 'readonly') { S.map[c.index].skipped = true; S.map[c.index].edited = true; } drawAll(); } }, 'Skip all unknown fields'))),
      missing.length ? h('div', { class: 'di-warn' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', {}, `Required for new ${S.desc.name} records, and not in your data: `, h('b', {}, missing.join(', ')), '. Rows without them will fail.')) : null,
      h('div', { class: 'di-maps' }, rows)].filter(Boolean));
  }

  function counts() {
    const c = { queued: 0, processing: 0, ok: 0, failed: 0 };
    for (const s of S.status) c[s]++;
    return c;
  }

  function drawBar() {
    if (!S.data) { el.bar.replaceChildren(); el.bar.hidden = true; return; }
    el.bar.hidden = false;
    const c = counts();
    const why = blocker();
    const a = ACTIONS[S.action];
    const run = h('button', {
      class: `primary di-run${S.action === 'delete' ? ' danger' : ''}`, disabled: !!why || !!S.running, title: why || `${a.verb} the queued rows`, onclick: confirmRun,
    }, h('span', { 'aria-hidden': 'true' }, S.running ? '' : '▶'), S.running ? h('span', { class: 'di-spin', 'aria-hidden': 'true' }) : null,
    S.running ? `Running · ${num(S.running.done)} / ${num(S.running.total)}` : `${a.verb} ${c.queued ? num(c.queued) : ''} ${S.object || ''} ${c.queued === 1 ? 'record' : 'records'}`.replace(/\s+/g, ' '));
    const chip = (k) => h('label', { class: `di-chip s-${k}${c[k] ? '' : ' zero'}` },
      h('input', { type: 'checkbox', checked: S.show[k], onchange: (e) => { S.show[k] = e.target.checked; drawBody(); } }), h('b', {}, num(c[k])), ` ${STATUS[k]}`);
    const total = S.status.length;
    const pct = (k) => `${((c[k] / total) * 100).toFixed(2)}%`;
    el.bar.replaceChildren(...[
      h('div', { class: 'di-bar-row' },
        run,
        h('button', { class: 'ghost small', disabled: !S.running, title: 'Stop after the batches already sent', onclick: () => { if (S.running) { S.running.cancel = true; toast('Stopping after the batches in flight…'); } } }, 'Cancel queued'),
        h('button', { class: 'ghost small', disabled: !c.failed || !!S.running, onclick: () => { S.status = S.status.map((s) => (s === 'failed' ? 'queued' : s)); drawBar(); drawBody(); } }, `Retry failed${c.failed ? ` (${num(c.failed)})` : ''}`),
        !c.queued && !S.running ? h('button', { class: 'link', onclick: () => { S.status = S.status.map(() => 'queued'); S.result = S.result.map(() => null); drawBar(); drawBody(); } }, 'Re-queue all') : null,
        h('span', { class: 'di-chips' }, ['queued', 'processing', 'ok', 'failed'].map(chip)),
        h('span', { class: 'di-grow' }),
        h('button', { class: 'ghost small', title: 'Copy the rows shown, with __Status, __Id and __Errors columns', onclick: (e) => copyMenu(e.currentTarget) }, '⧉ Copy ▾'),
        h('button', { class: 'ghost small', title: 'Download the rows shown, with results, as CSV', onclick: download }, '⤓ CSV'),
        h('button', { class: 'ghost small', disabled: !!S.running, onclick: clearData }, '✕ Clear')),
      why && !S.running ? h('div', { class: 'di-why', role: 'status' }, '▸ ', why) : null,
      h('div', { class: 'di-progress', 'aria-hidden': 'true' },
        h('span', { class: 's-ok', style: `width:${pct('ok')}` }), h('span', { class: 's-failed', style: `width:${pct('failed')}` }), h('span', { class: 's-processing', style: `width:${pct('processing')}` }))].filter(Boolean));
  }

  // ---------- the table (virtualized) ----------
  let view = [];
  function drawBody() {
    if (!S.data) { drawDrop(); return; }
    view = [];
    S.status.forEach((s, i) => { if (S.show[s]) view.push(i); });
    if (!el.wrap?.isConnected) {
      el.wrap = h('div', { class: 'di-tablewrap', tabindex: '0', 'aria-label': 'Rows to import' });
      el.wrap.addEventListener('scroll', () => { cancelAnimationFrame(el.raf); el.raf = requestAnimationFrame(drawRows); });
      el.srcLine = h('div', { class: 'di-src' });
      el.body.replaceChildren(el.srcLine, el.wrap);
    }
    const fmt = { excel: 'Excel', csv: 'CSV', json: 'JSON' }[S.data.format] || '';
    el.srcLine.replaceChildren(...[h('span', {}, `${plural(S.data.rows.length, 'row')} · ${S.data.headers.length} columns · ${fmt} from ${S.source}`),
      view.length !== S.data.rows.length ? h('span', { class: 'di-muted' }, ` · showing ${num(view.length)}`) : null,
      h('span', { class: 'di-grow' }), h('button', { class: 'link', disabled: !!S.running, onclick: clearData }, 'Paste different data')].filter(Boolean));
    const cols = columns();
    el.cols = cols;
    el.table = h('table', { class: 'di-table' },
      h('thead', {}, h('tr', {}, h('th', { class: 'di-rn' }, '#'), h('th', { class: 'di-stc' }, 'Status'), h('th', { class: 'di-res' }, 'Result'),
        cols.map((c) => h('th', { class: `c-${c.state}`, title: c.detail }, h('span', {}, c.header), h('small', {}, c.state === 'ok' || c.state === 'rel' ? c.field : c.state === 'skip' ? 'skipped' : c.state === 'unknown' || c.state === 'readonly' ? 'unmapped' : '—'))))),
      el.tbody = h('tbody'));
    el.wrap.replaceChildren(el.table);
    drawRows();
  }

  function drawRows() {
    if (!el.tbody?.isConnected) return;
    const top = el.wrap.scrollTop;
    const height = el.wrap.clientHeight || 500;
    const first = Math.max(0, Math.floor(top / ROW_H) - 10);
    const last = Math.min(view.length, first + Math.ceil(height / ROW_H) + 30);
    const span = el.cols.length + 3;
    const frag = [h('tr', { class: 'di-spacer', style: `height:${first * ROW_H}px` }, h('td', { colspan: span }))];
    for (let k = first; k < last; k++) {
      const i = view[k];
      const st = S.status[i];
      const r = S.result[i];
      const resultCell = r?.success
        ? h('td', { class: 'di-res ok' }, r.id ? h('a', { href: backend.recordUrl(r.id), target: '_blank', rel: 'noopener', title: 'Open the record' }, r.id) : '✓', r.created != null ? h('span', { class: 'di-created' }, r.created ? ' created' : ' updated') : null)
        : r?.error ? h('td', { class: 'di-res err', title: r.error }, r.error) : h('td', { class: 'di-res' });
      frag.push(h('tr', { class: `s-${st}` },
        h('td', { class: 'di-rn' }, i + 1),
        h('td', { class: 'di-stc' }, h('span', { class: `di-st s-${st}` }, STATUS[st])),
        resultCell,
        el.cols.map((c) => {
          const v = S.data.rows[i][c.index];
          return h('td', { class: `c-${c.state}`, title: String(v ?? '') }, String(v ?? ''));
        })));
    }
    if (!view.length) frag.push(h('tr', {}, h('td', { colspan: span, class: 'di-none' }, 'No rows with these statuses.')));
    frag.push(h('tr', { class: 'di-spacer', style: `height:${Math.max(0, view.length - last) * ROW_H}px` }, h('td', { colspan: span })));
    el.tbody.replaceChildren(...frag);
  }

  function drawDrop() {
    el.wrap = null;
    const file = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.json', hidden: true, onchange: (e) => loadFile(e.target.files[0]) });
    const ta = h('textarea', {
      class: 'di-paste', placeholder: 'Paste here (Ctrl+V)', spellcheck: 'false', 'aria-label': 'Paste data',
      onpaste: (e) => { const text = e.clipboardData?.getData('text/plain'); if (text) { e.preventDefault(); loadText(text, 'the clipboard'); } },
      oninput: (e) => { if (e.target.value.includes('\n')) { const v = e.target.value; e.target.value = ''; loadText(v, 'what you typed'); } },
    });
    el.body.replaceChildren(h('div', { class: 'di-drop' },
      h('div', { class: 'di-drop-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('b', { class: 'di-drop-title' }, 'Paste or drop your data'),
      h('p', {}, 'Copy cells from Excel or Google Sheets and press ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'V'), ' anywhere here, or drop a CSV / JSON file. The first row holds the column names: API names or field labels both work.'),
      ta,
      h('div', { class: 'di-row' }, h('button', { class: 'ghost small', onclick: () => file.click() }, '📂 Choose a file'), file,
        backend.demo ? h('button', { class: 'ghost small', onclick: () => loadText(sampleInsert(), 'a sample') }, 'Try a sample: new Contacts') : null,
        backend.demo ? h('button', { class: 'ghost small', onclick: async () => loadText(await sampleUpdate(), 'a sample') }, 'Try a sample: update Accounts') : null),
      h('ul', { class: 'di-tips' },
        h('li', {}, 'Rows copied from ', h('b', {}, 'Data Export'), ' paste straight in, with their Ids: handy for update, delete and undelete.'),
        h('li', {}, 'Set a lookup by a parent’s field with a column like ', h('code', {}, 'Account.Name__c'), ' or ', h('code', {}, 'Owner.Username'), ' (an external id or unique field).'),
        h('li', {}, 'Failed rows keep their error: fix them right in your sheet, copy the failed rows back, and run again.'))));
  }

  // demo samples
  function sampleInsert() {
    return ['FirstName\tLastName\tEmail\tTitle\tLeadSource\tAccount.Name',
      'Asha\tVerma\tasha.verma@example.com\tCFO\tWeb\tAcme Corp',
      'Rohan\tMehta\trohan.mehta@example.com\tBuyer\tTrade Show\tGlobex Health',
      'Neha\t\tneha@example.com\tAnalyst\tWeb\tAcme Corp',
      'Vikram\tSingh\tvikram.singh@example.com\tCTO\tCold Call\tAcme Corp',
      'Priya\tNair\tpriya.nair@example.com\tManager\tPartner Referral\tNo Such Account'].join('\n');
  }
  async function sampleUpdate() {
    const accs = backend.data.db.Account.slice(0, 6);
    return ['_\tId\tIndustry\tRating', ...accs.map((a, i) => `[Account]\t${a.Id}\t${i === 4 ? 'Space Mining' : ['Banking', 'Technology', 'Retail'][i % 3]}\t${['Hot', 'Warm', 'Cold'][i % 3]}`)].join('\n');
  }

  // ---------- run ----------
  function confirmRun() {
    const why = blocker();
    if (why) { toast(why, 'error'); return; }
    const c = counts();
    const a = ACTIONS[S.action];
    const org = backend.orgLabel?.() || { name: 'this org', sandbox: true };
    const big = S.action === 'delete' && (c.queued >= 50 || !org.sandbox);
    const confirmIn = big ? h('input', { type: 'text', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm', spellcheck: 'false', autocomplete: 'off' }) : null;
    const go = h('button', { class: `primary${S.action === 'delete' ? ' danger' : ''}`, disabled: big }, `${a.verb} ${plural(c.queued, 'record')}`);
    confirmIn?.addEventListener('input', () => { go.disabled = confirmIn.value.trim() !== 'DELETE'; });
    const batches = Math.ceil(c.queued / S.batchSize);
    const m = modal({
      title: `${a.verb} ${plural(c.queued, S.desc.name + ' record')}?`,
      body: h('div', {},
        h('p', {}, `In `, h('b', {}, org.name), org.sandbox ? ' (sandbox)' : h('span', { class: 'di-prod' }, ' · production'), `, as ${num(batches)} batch${batches === 1 ? '' : 'es'} of up to ${S.batchSize}, ${Math.min(S.threads, batches)} at a time.`),
        S.action === 'delete' ? h('p', { class: 'di-muted' }, 'Deleted records go to the Recycle Bin. Related records may be deleted with them, and triggers and flows run.')
          : h('p', { class: 'di-muted' }, 'Triggers, flows and validation rules run for every record, as if a user saved them.'),
        !org.sandbox ? h('p', { class: 'di-prodwarn' }, '⚠ This is a production org. These changes are real.') : null,
        big ? h('label', { class: 'di-confirm' }, 'Type ', h('b', {}, 'DELETE'), ' to confirm', confirmIn) : null),
      actions: [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go],
    });
    go.addEventListener('click', () => { m.close(); runQueued(); });
    confirmIn?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  }

  function headers() {
    const out = {};
    if (S.allowDupes) out['Sforce-Duplicate-Rule-Header'] = 'allowSave=true';
    if (S.noAssign) out['Sforce-Auto-Assign'] = 'FALSE';
    for (const line of S.headers.split('\n')) {
      const m = /^\s*([A-Za-z0-9-]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
    return Object.keys(out).length ? out : undefined;
  }

  let paintT = 0;
  const paintSoon = () => { if (paintT) return; paintT = requestAnimationFrame(() => { paintT = 0; drawBar(); drawRows(); }); };

  async function runQueued() {
    const cols = columns();
    const fieldsByName = new Map(S.desc.fields.map((f) => [f.name.toLowerCase(), f]));
    const tasks = [];
    S.status.forEach((s, i) => {
      if (s !== 'queued') return;
      const b = buildRecord(S.data.rows[i], cols, { action: S.action, object: S.desc.name, fieldsByName, blankToNull: S.blankToNull, matchField: S.matchField });
      if (b.error) { S.status[i] = 'failed'; S.result[i] = { success: false, error: b.error }; } else tasks.push({ i, rec: b.record });
    });
    const batches = chunks(tasks, S.batchSize);
    const job = { cancel: false, ctrl: new AbortController(), total: tasks.length, done: 0, started: Date.now() };
    S.running = job;
    drawAll();
    let next = 0;
    const action = S.action;
    const object = S.desc.name;
    const hdrs = headers();
    const worker = async () => {
      while (!job.cancel && next < batches.length) {
        const b = batches[next++];
        for (const t of b) S.status[t.i] = 'processing';
        paintSoon();
        try {
          const res = await backend.run(action, object, b.map((t) => t.rec), { matchField: S.matchField, headers: hdrs, signal: job.ctrl.signal });
          b.forEach((t, k) => {
            const r = res[k] || { success: false, error: 'Salesforce sent no result for this row' };
            S.status[t.i] = r.success ? 'ok' : 'failed';
            S.result[t.i] = r;
          });
        } catch (e) {
          for (const t of b) { S.status[t.i] = 'failed'; S.result[t.i] = { success: false, error: e.message || String(e) }; }
        }
        job.done += b.length;
        paintSoon();
      }
    };
    await Promise.all(Array.from({ length: Math.min(S.threads, batches.length) }, worker));
    S.running = null;
    const c = counts();
    drawAll();
    const secs = ((Date.now() - job.started) / 1000).toFixed(1);
    if (job.cancel) toast(`Stopped: ${plural(c.queued, 'row')} still queued`, 'info');
    else if (c.failed) toast(`${ACTIONS[action].verb}: ${num(c.ok)} succeeded, ${num(c.failed)} failed (${secs} s)`, 'error');
    else toast(`${ACTIONS[action].verb}: all ${plural(c.ok, 'record')} succeeded in ${secs} s`, 'ok');
    if (c.failed && !job.cancel) { S.show = { queued: true, processing: true, ok: false, failed: true }; drawBar(); drawBody(); }
  }

  // ---------- results out ----------
  function resultTable() {
    const hd = [...S.data.headers, '__Status', '__Id', '__Errors'];
    const rows = view.map((i) => [...S.data.rows[i].map((v) => (v == null ? '' : String(v))), STATUS[S.status[i]], S.result[i]?.id || '', S.result[i]?.error || '']);
    return { hd, rows };
  }
  function copyMenu(anchor) {
    const pop = h('div', { class: 'dx-pop', role: 'menu' },
      [['excel', 'Copy for Excel', 'tab-separated'], ['csv', 'Copy as CSV', 'comma-separated'], ['json', 'Copy as JSON', 'array of rows']].map(([k, label, hint]) => h('button', {
        class: 'dx-mi', role: 'menuitem', onclick: () => { close(); const { hd, rows } = resultTable(); copyText(exportRows(hd, rows, k), `${plural(rows.length, 'row')} copied`); },
      }, h('span', {}, label), h('span', { class: 'dx-mi-hint' }, hint))));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 4}px`;
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    function close() { pop.remove(); document.removeEventListener('pointerdown', outside, true); }
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }
  function download() {
    const { hd, rows } = resultTable();
    const blob = new Blob(['﻿' + exportRows(hd, rows, 'csv')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${S.object || 'import'}-${S.action}-results.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`Downloading ${plural(rows.length, 'row')}`, 'ok');
  }
  function clearData() {
    S.data = null;
    S.map = [];
    S.status = [];
    S.result = [];
    S.actionAuto = true;
    S.show = { queued: true, processing: true, ok: true, failed: true };
    drawAll();
  }

  drawAll();
  loadObjects();

  return {
    setActive(on) { S.active = on; },
  };
}
