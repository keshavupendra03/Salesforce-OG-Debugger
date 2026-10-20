// All data: every field of one record (API name, label, type, value) with a filter,
// inline editing (double-click a value), Edit / Clone / Delete / Export, and links between related records.
// Opened from the OG panel on a Salesforce record page: record.html?host=<salesforce host>&id=<record id>.

import { h } from '../dom.js';
import { getSession } from '../session.js';
import { SfApi } from '../sf-api.js';
import { SfRecordBackend, DemoRecordBackend } from './record-backend.js';
import { fieldTypeText, fieldFlags } from './sf-urls.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const root = $('#rd');

const S = {
  backend: null, id: params.get('id'), obj: null, desc: null, rec: null,
  pending: new Map(), editing: new Set(), errors: new Map(), editAll: false,
  q: '', hideEmpty: false, sort: { col: 'name', dir: 1 }, deleted: false, saving: false,
};

// ---------- small helpers ----------

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6500 : 2600);
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? msg : 'The browser blocked the clipboard', ok ? 'ok' : 'error');
  }
}

let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener('pointerdown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.key, true);
  openMenu = null;
}
function menu(anchor, items) {
  closeMenu();
  const el = h('div', { class: 'dx-pop', role: 'menu' }, items.filter(Boolean).map(([icon, label, fn, hint]) => h('button', {
    type: 'button', role: 'menuitem', class: 'dx-mi', onclick: () => { closeMenu(); fn(); },
  }, h('span', { class: 'dx-mi-icon', 'aria-hidden': 'true' }, icon), h('span', {}, label), hint ? h('span', { class: 'dx-mi-hint' }, hint) : null)));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.right - el.offsetWidth, innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${r.bottom + 4}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  openMenu = { el, outside, key };
  el.querySelector('button')?.focus();
}

function modal(title, body, actions) {
  const card = h('div', { class: 'dx-modal-card rd-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', {}, title), body, h('div', { class: 'dx-modal-actions' }, actions));
  const wrap = h('div', { class: 'dx-modal' }, card);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  (card.querySelector('input:not([type=checkbox]), textarea') || card.querySelector('.dx-modal-actions button:last-child'))?.focus();
  return { close, card };
}

const isEmpty = (v) => v == null || v === '';
const fieldOf = (name) => S.desc.fields.find((f) => f.name === name);
const valueOf = (name) => (S.pending.has(name) ? S.pending.get(name) : S.rec?.[name]);
const editable = (f) => !S.deleted && f.updateable && !f.calculated;
const recordName = () => {
  const nf = S.desc.fields.find((f) => f.nameField);
  return (nf && S.rec?.[nf.name]) || S.rec?.Name || S.id;
};

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ISO datetime <-> the value of an <input type="datetime-local"> (local time)
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(String(iso).replace(/\+0000$/, 'Z'));
  if (Number.isNaN(+d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (s) => (s ? new Date(s).toISOString().replace(/\.\d{3}Z$/, '.000Z') : null);

// ---------- startup ----------

async function start() {
  try {
    if (params.has('demo')) {
      S.backend = new DemoRecordBackend();
      S.id ||= S.backend.sampleId('Account');
      document.documentElement.dataset.demo = '1';
    } else {
      const host = params.get('host');
      if (!host || !S.id) throw new Error('Open this page from the OG panel on a Salesforce record.');
      const session = await getSession(host);
      const api = new SfApi(session);
      await api.init();
      S.backend = new SfRecordBackend(api, session);
    }
    // keep the id in the address, so Back returns here after following a lookup
    history.replaceState({ id: S.id }, '', `?${new URLSearchParams({ ...Object.fromEntries(params), id: S.id })}`);
    await load(S.id);
  } catch (e) {
    showError('Couldn’t open this record', e.message);
  }
}

async function load(id, { keepScroll = false } = {}) {
  S.id = id;
  S.pending.clear();
  S.editing.clear();
  S.errors.clear();
  S.editAll = false;
  S.deleted = false;
  if (!keepScroll) root.replaceChildren(h('div', { class: 'lg-loading rd-loading' }, h('span', { class: 'lg-spinner' }), 'Loading record…'));
  try {
    S.obj = await S.backend.objectForId(id);
    if (!S.obj) throw new Error(`No object uses the id prefix “${id.slice(0, 3)}”, or your user can’t see it.`);
    const [desc, rec] = await Promise.all([S.backend.describe(S.obj), S.backend.get(S.obj, id)]);
    S.desc = desc;
    S.rec = rec;
    document.title = `${recordName()} · ${desc.label} · All data`;
    render();
  } catch (e) {
    showError('Couldn’t load this record', e.message);
  }
}

function showError(title, msg) {
  root.replaceChildren(h('div', { class: 'rd-error' },
    h('div', { class: 'empty-title' }, title),
    h('pre', {}, msg),
    h('div', { class: 'lg-row' }, h('button', { class: 'ghost small', onclick: () => location.reload() }, 'Try again'))));
}

// ---------- page ----------

const el = {};
function render() {
  const d = S.desc;
  const filled = d.fields.filter((f) => !isEmpty(S.rec[f.name])).length;
  el.filter = h('input', {
    type: 'search', class: 'rd-filter', placeholder: 'Filter by API name, label, type or value…   ( / )', value: S.q, 'aria-label': 'Filter fields', spellcheck: 'false',
    oninput: (e) => { S.q = e.target.value; drawRows(); },
  });
  el.count = h('span', { class: 'rd-count' });
  el.hide = h('label', { class: 'dx-toggle', title: 'Hide fields without a value' }, h('input', { type: 'checkbox', checked: S.hideEmpty, onchange: (e) => { S.hideEmpty = e.target.checked; drawRows(); } }), 'Hide empty');
  el.editBtn = h('button', { class: 'ghost small', title: 'Make every editable field editable at once', onclick: toggleEditAll }, '✎ Edit');
  el.body = h('tbody', {});
  el.saveBar = h('div', { class: 'rd-savebar', hidden: true, role: 'region', 'aria-label': 'Unsaved changes' });
  el.banner = h('div', { class: 'rd-banner', hidden: true, role: 'alert' });

  const th = (col, label) => h('th', {
    scope: 'col', class: `rd-th-${col}`, 'aria-sort': S.sort.col === col ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none',
    onclick: () => { S.sort = { col, dir: S.sort.col === col ? -S.sort.dir : 1 }; render(); },
  }, label, h('span', { class: 'rd-sort', 'aria-hidden': 'true' }, S.sort.col === col ? (S.sort.dir > 0 ? '▲' : '▼') : ''));

  root.replaceChildren(
    h('header', { class: 'rd-head' },
      h('div', { class: 'rd-brand', title: 'Salesforce OG Debugger' },
        h('svg', {}), h('span', {}, 'All data')),
      h('div', { class: 'rd-titlebox' },
        h('div', { class: 'rd-kicker' }, h('span', { class: 'rd-obj' }, d.label), h('code', {}, d.name)),
        h('h1', { title: recordName() }, recordName()),
        h('div', { class: 'rd-sub' },
          h('button', { class: 'rd-id', title: 'Copy the record id', onclick: () => copyText(S.id, 'Id copied') }, h('code', {}, S.id), h('span', { 'aria-hidden': 'true' }, '⧉')),
          h('span', {}, `${d.fields.length} fields · ${filled} with a value`))),
      h('div', { class: 'rd-actions' },
        h('a', { class: 'ghost small rd-link', href: S.backend.recordUrl(S.obj, S.id), target: '_blank', rel: 'noopener' }, 'Open in Salesforce ↗'),
        el.editBtn,
        h('button', { class: 'ghost small', disabled: !d.createable, title: 'Create a copy of this record', onclick: openClone }, '⧉ Clone'),
        h('button', { class: 'ghost small', title: 'Copy or download this record', 'aria-haspopup': 'menu', onclick: (e) => exportMenu(e.currentTarget) }, '⤓ Export ▾'),
        h('button', { class: 'ghost small danger-text', disabled: !d.deletable, onclick: confirmDelete }, 'Delete'),
        h('button', { class: 'ghost small rd-icon', title: 'Reload from Salesforce', 'aria-label': 'Reload', onclick: () => reload() }, '↻'))),
    el.banner,
    h('div', { class: 'rd-tools' }, el.filter, el.count, el.hide),
    h('div', { class: 'rd-tablewrap' },
      h('table', { class: 'rd-table' },
        h('colgroup', {}, h('col', { class: 'c-name' }), h('col', { class: 'c-label' }), h('col', { class: 'c-type' }), h('col', { class: 'c-value' })),
        h('thead', {}, h('tr', {}, th('name', 'Field API name'), th('label', 'Label'), th('type', 'Type'), th('value', 'Value'))),
        el.body)),
    el.saveBar);
  root.querySelector('.rd-brand svg').outerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="6" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="12" r="2.8"/><path d="M7.2 6.8 16.4 11M7.2 17.2 16.4 13" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>';
  drawRows();
  drawSaveBar();
  if (S.deleted) showBanner('deleted');
  // the sticky toolbar and column headers sit right under the (variable-height) header
  const head = root.querySelector('.rd-head');
  const tools = root.querySelector('.rd-tools');
  const place = () => { root.style.setProperty('--rd-h', `px`); root.style.setProperty('--rd-t', `px`); };
  S.ro?.disconnect();
  S.ro = new ResizeObserver(place);
  S.ro.observe(head);
  place();
}

function rowsToShow() {
  const q = S.q.trim().toLowerCase();
  let list = S.desc.fields.filter((f) => {
    if (S.hideEmpty && isEmpty(valueOf(f.name)) && !S.pending.has(f.name)) return false;
    if (!q) return true;
    return [f.name, f.label, fieldTypeText(f), fieldFlags(f).join(' '), text(valueOf(f.name)),
      ...(f.picklist || []).filter((p) => p.value === valueOf(f.name)).map((p) => p.label)].some((s) => String(s).toLowerCase().includes(q));
  });
  const key = { name: (f) => f.name, label: (f) => f.label, type: (f) => fieldTypeText(f), value: (f) => text(valueOf(f.name)) }[S.sort.col];
  list = [...list].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: 'base' }) * S.sort.dir);
  return list;
}

function drawRows() {
  const list = rowsToShow();
  el.count.textContent = list.length === S.desc.fields.length ? `${list.length} fields` : `${list.length} of ${S.desc.fields.length} fields`;
  if (!list.length) {
    el.body.replaceChildren(h('tr', {}, h('td', { colspan: '4', class: 'rd-none' }, S.q ? `No field matches “${S.q}”.` : 'Nothing to show.')));
    return;
  }
  el.body.replaceChildren(...list.map(row));
}

function row(f) {
  const changed = S.pending.has(f.name);
  const err = S.errors.get(f.name);
  const editingNow = S.editAll ? editable(f) : S.editing.has(f.name);
  const flags = fieldFlags(f);
  const valueCell = h('td', {
    class: `rd-val${editable(f) ? ' can-edit' : ''}`,
    title: editable(f) && !editingNow ? 'Double-click to edit' : null,
    ondblclick: () => { if (editable(f) && !editingNow) { S.editing.add(f.name); redrawRow(f); } },
  }, editingNow ? editor(f) : valueView(f));
  return h('tr', { class: `${changed ? 'changed' : ''}${err ? ' has-err' : ''}`, 'data-f': f.name },
    h('td', { class: 'rd-name' }, h('code', { class: f.calculated ? 'calc' : null }, f.name), f.inlineHelpText ? h('span', { class: 'rd-help', title: f.inlineHelpText, 'aria-label': f.inlineHelpText }, 'ⓘ') : null),
    h('td', { class: 'rd-label' }, f.label),
    h('td', { class: 'rd-type' }, h('span', { class: 'rd-type-t' }, fieldTypeText(f)), flags.map((x) => h('span', { class: `rd-flag f-${x.replace(/\s+/g, '-')}` }, x))),
    valueCell,
  );
}

function redrawRow(f) {
  const tr = el.body.querySelector(`tr[data-f="${CSS.escape(f.name)}"]`);
  if (!tr) return;
  const fresh = row(f);
  tr.replaceWith(fresh);
  fresh.querySelector('.rd-editor')?.focus();
  fresh.querySelector('.rd-editor')?.select?.();
}

function valueView(f) {
  const v = valueOf(f.name);
  const err = S.errors.get(f.name);
  const wrap = (node) => (err ? [node, h('div', { class: 'rd-fielderr' }, err)] : node);
  if (isEmpty(v)) return wrap(h('span', { class: 'rd-empty' }, 'empty'));
  if (typeof v === 'boolean') return wrap(h('span', { class: `rd-bool ${v}` }, String(v)));
  if (typeof v === 'object') return wrap(h('pre', { class: 'rd-json' }, JSON.stringify(v, null, 2)));
  const s = String(v);
  if (f.type === 'reference' || (f.type === 'id' && f.name !== 'Id')) {
    return wrap(h('span', { class: 'rd-ref' },
      h('a', { href: `?${new URLSearchParams({ ...Object.fromEntries(params), id: s })}`, title: `Open all data of this ${f.referenceTo?.join(' / ') || 'record'}`, onclick: (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); go(s); } }, s),
      f.referenceTo?.length ? h('span', { class: 'rd-ref-obj' }, f.referenceTo.join(' / ')) : null,
      h('button', { class: 'rd-mini', title: 'Copy id', 'aria-label': 'Copy id', onclick: () => copyText(s, 'Id copied') }, '⧉')));
  }
  if (f.type === 'id') return wrap(h('span', { class: 'rd-ref' }, h('code', {}, s), h('button', { class: 'rd-mini', title: 'Copy id', 'aria-label': 'Copy id', onclick: () => copyText(s, 'Id copied') }, '⧉')));
  if (f.type === 'url') return wrap(h('a', { href: /^https?:/i.test(s) ? s : `https://${s}`, target: '_blank', rel: 'noopener noreferrer' }, s));
  if (f.type === 'email') return wrap(h('a', { href: `mailto:${s}` }, s));
  if (f.type === 'picklist' || f.type === 'multipicklist') {
    const labels = s.split(';').map((x) => f.picklist?.find((p) => p.value === x)?.label).filter((l, i, a) => l && l !== s.split(';')[i]);
    return wrap([h('span', {}, s), labels.length ? h('span', { class: 'rd-plabel' }, labels.join('; ')) : null]);
  }
  if (f.type === 'datetime') {
    const d = new Date(s.replace(/\+0000$/, 'Z'));
    return wrap([h('span', {}, s), Number.isNaN(+d) ? null : h('span', { class: 'rd-when' }, d.toLocaleString())]);
  }
  if (f.type === 'textarea' || s.length > 120 || s.includes('\n')) return wrap(h('div', { class: 'rd-long' }, s));
  return wrap(h('span', {}, s));
}

// the right input for the field's type; changes go into S.pending
function editor(f) {
  const v = valueOf(f.name);
  const set = (val) => {
    const orig = S.rec[f.name] ?? null;
    const norm = val === '' ? null : val;
    if ((orig ?? null) === norm || (orig != null && norm != null && String(orig) === String(norm))) S.pending.delete(f.name);
    else S.pending.set(f.name, norm);
    S.errors.delete(f.name);
    const tr = el.body.querySelector(`tr[data-f="${CSS.escape(f.name)}"]`);
    tr?.classList.toggle('changed', S.pending.has(f.name));
    drawSaveBar();
  };
  const done = () => { if (!S.editAll) { S.editing.delete(f.name); redrawRow(f); } };
  const cancel = () => { S.pending.delete(f.name); S.errors.delete(f.name); drawSaveBar(); S.editing.delete(f.name); redrawRow(f); };
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); done(); }
  };
  let input;
  if (f.type === 'boolean') {
    input = h('input', { type: 'checkbox', class: 'rd-editor', checked: !!v, onchange: (e) => set(e.target.checked) });
    return h('label', { class: 'rd-check' }, input, h('span', {}, 'true'));
  }
  if (f.type === 'picklist') {
    input = h('select', { class: 'rd-editor', onchange: (e) => set(e.target.value) },
      h('option', { value: '' }, '— None —'),
      (f.picklist || []).map((p) => h('option', { value: p.value, selected: p.value === v }, p.label && p.label !== p.value ? `${p.value}  ·  ${p.label}` : p.value)),
      v && !(f.picklist || []).some((p) => p.value === v) ? h('option', { value: v, selected: true }, `${v} (not in the list)`) : null);
  } else if (f.type === 'multipicklist') {
    const cur = new Set(String(v || '').split(';').filter(Boolean));
    input = h('select', { class: 'rd-editor', multiple: true, size: String(Math.min(6, Math.max(3, (f.picklist || []).length))), onchange: (e) => set([...e.target.selectedOptions].map((o) => o.value).join(';')) },
      (f.picklist || []).map((p) => h('option', { value: p.value, selected: cur.has(p.value) }, p.label && p.label !== p.value ? `${p.value} · ${p.label}` : p.value)));
  } else if (f.type === 'date') {
    input = h('input', { type: 'date', class: 'rd-editor', value: v || '', oninput: (e) => set(e.target.value) });
  } else if (f.type === 'datetime') {
    input = h('input', { type: 'datetime-local', class: 'rd-editor', value: toLocalInput(v), oninput: (e) => set(fromLocalInput(e.target.value)) });
  } else if (['int', 'double', 'currency', 'percent'].includes(f.type)) {
    input = h('input', { type: 'number', step: 'any', class: 'rd-editor', value: v ?? '', oninput: (e) => set(e.target.value === '' ? null : Number(e.target.value)) });
  } else if (f.type === 'textarea' || (typeof v === 'string' && v.length > 120)) {
    input = h('textarea', { class: 'rd-editor', rows: String(Math.min(8, Math.max(2, String(v || '').split('\n').length + 1))), oninput: (e) => set(e.target.value) });
    input.value = v ?? '';
  } else {
    input = h('input', { type: 'text', class: 'rd-editor', value: v ?? '', spellcheck: 'false', maxlength: f.length ? String(f.length) : null, oninput: (e) => set(e.target.value) });
  }
  input.addEventListener('keydown', keys);
  const err = S.errors.get(f.name);
  return [input, S.editAll ? null : h('span', { class: 'rd-edit-hint' }, f.type === 'textarea' ? 'Ctrl+Enter done · Esc undo' : 'Enter done · Esc undo'), err ? h('div', { class: 'rd-fielderr' }, err) : null];
}

function toggleEditAll() {
  S.editAll = !S.editAll;
  S.editing.clear();
  el.editBtn.textContent = S.editAll ? '✓ Done editing' : '✎ Edit';
  el.editBtn.classList.toggle('on', S.editAll);
  drawRows();
  if (S.editAll) el.body.querySelector('.rd-editor')?.focus();
}

function drawSaveBar() {
  const n = S.pending.size;
  el.saveBar.hidden = !n;
  if (!n) return;
  const names = [...S.pending.keys()];
  el.saveBar.replaceChildren(
    h('div', { class: 'rd-save-what' },
      h('b', {}, `${n} unsaved change${n === 1 ? '' : 's'}`),
      h('span', {}, names.slice(0, 4).join(', ') + (n > 4 ? ` +${n - 4} more` : ''))),
    h('div', { class: 'rd-save-acts' },
      h('button', { class: 'ghost small', disabled: S.saving, onclick: discard }, 'Discard'),
      h('button', { class: 'primary small', disabled: S.saving, onclick: save, title: 'Save (Ctrl+S)' }, S.saving ? 'Saving…' : `Save ${n === 1 ? 'change' : `${n} changes`}`)));
}

function discard() {
  S.pending.clear();
  S.errors.clear();
  S.editing.clear();
  if (!S.deleted) el.banner.hidden = true;
  drawRows();
  drawSaveBar();
}

async function save() {
  if (!S.pending.size || S.saving) return;
  S.saving = true;
  drawSaveBar();
  const fields = Object.fromEntries(S.pending);
  try {
    await S.backend.update(S.obj, S.id, fields);
    const n = S.pending.size;
    S.rec = await S.backend.get(S.obj, S.id);
    S.pending.clear();
    S.errors.clear();
    S.editing.clear();
    S.saving = false;
    if (S.editAll) toggleEditAll(); else drawRows();
    drawSaveBar();
    el.banner.hidden = true;
    toast(`Saved ${n} field${n === 1 ? '' : 's'}`, 'ok');
  } catch (e) {
    S.saving = false;
    const msg = e.message || String(e);
    for (const name of e.fields || []) S.errors.set(name, msg.replace(/^\w+:\s*/, ''));
    showBanner('error', msg);
    drawRows();
    drawSaveBar();
  }
}

function showBanner(kind, msg) {
  el.banner.hidden = false;
  el.banner.className = `rd-banner ${kind}`;
  if (kind === 'deleted') {
    el.banner.replaceChildren(h('b', {}, 'This record was deleted.'), h('span', {}, 'It’s in the Recycle Bin for 15 days. The values below are what it had.'));
  } else {
    el.banner.replaceChildren(h('b', {}, 'Salesforce didn’t save it'), h('pre', {}, msg), h('button', { class: 'link', onclick: () => { el.banner.hidden = true; } }, 'Dismiss'));
  }
}

async function reload() {
  if (S.pending.size && !confirm('Discard your unsaved changes and reload?')) return;
  await load(S.id, { keepScroll: true });
  toast('Reloaded', 'ok');
}

function go(id) {
  if (S.pending.size && !confirm('You have unsaved changes. Leave this record anyway?')) return;
  history.pushState({ id }, '', `?${new URLSearchParams({ ...Object.fromEntries(params), id })}`);
  load(id);
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('id');
  if (id && id !== S.id) load(id);
});

// ---------- export ----------

function exportMenu(anchor) {
  const clean = () => {
    const out = {};
    for (const f of S.desc.fields) out[f.name] = S.rec[f.name] ?? null;
    return out;
  };
  const rows = () => S.desc.fields.map((f) => [f.name, f.label, fieldTypeText(f), text(S.rec[f.name])]);
  const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = ['Field API name', 'Label', 'Type', 'Value'];
  menu(anchor, [
    ['{}', 'Copy as JSON', () => copyText(JSON.stringify(clean(), null, 2), 'Copied as JSON'), 'all fields'],
    ['⊞', 'Copy for Excel', () => copyText([header, ...rows()].map((r) => r.map((c) => String(c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n'), 'Copied for Excel'), 'one row per field'],
    [',', 'Copy as CSV', () => copyText([header, ...rows()].map((r) => r.map((c) => csvCell(String(c))).join(',')).join('\r\n'), 'Copied as CSV')],
    ['⤓', 'Download JSON', () => {
      const blob = new Blob([JSON.stringify(clean(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${S.obj}_${S.id}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }],
  ]);
}

// ---------- clone / delete ----------

function openClone() {
  // everything that can be set on a new record and has a value; unique / external ids start unticked
  const fields = S.desc.fields.filter((f) => f.createable && !f.calculated && (!isEmpty(S.rec[f.name]) || (!f.nillable && !f.defaultedOnCreate && f.type !== 'boolean')));
  const pick = new Map(fields.map((f) => [f.name, { on: !(f.unique || f.externalId), value: S.rec[f.name] }]));
  const list = h('div', { class: 'rd-clone-list' }, fields.map((f) => {
    const st = pick.get(f.name);
    const required = !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean';
    const val = f.type === 'boolean'
      ? h('input', { type: 'checkbox', checked: !!st.value, onchange: (e) => { st.value = e.target.checked; } })
      : h('input', { type: 'text', value: st.value == null ? '' : typeof st.value === 'object' ? JSON.stringify(st.value) : String(st.value), spellcheck: 'false', oninput: (e) => { st.value = e.target.value; } });
    return h('label', { class: `rd-clone-row${required ? ' req' : ''}` },
      h('input', { type: 'checkbox', checked: st.on || required, disabled: required, title: required ? 'Required on a new record' : 'Copy this field', onchange: (e) => { st.on = e.target.checked; } }),
      h('code', {}, f.name), h('span', { class: 'rd-clone-label' }, f.label, f.unique || f.externalId ? h('em', {}, ' unique') : null), val);
  }));
  const status = h('p', { class: 'rd-clone-status', role: 'status' });
  const go2 = h('button', { class: 'primary' }, `Create ${S.desc.label}`);
  const m = modal(`Clone ${recordName()}`, h('div', { class: 'rd-clone' },
    h('p', { class: 'dx-muted' }, 'A new record gets these values. Untick a field to leave it out; unique fields start unticked.'),
    list, status), [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go2]);
  go2.addEventListener('click', async () => {
    const body = {};
    for (const f of fields) {
      const st = pick.get(f.name);
      const required = !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean';
      if (!st.on && !required) continue;
      let v = st.value;
      if (v === '') v = null;
      else if (typeof v === 'string' && ['int', 'double', 'currency', 'percent'].includes(f.type)) v = Number(v);
      else if (typeof v === 'string' && ['address', 'location'].includes(f.type)) continue; // compound fields are set through their parts
      body[f.name] = v;
    }
    go2.disabled = true;
    status.textContent = 'Creating…';
    status.className = 'rd-clone-status';
    try {
      const newId = await S.backend.create(S.obj, body);
      m.close();
      toast(`Created a copy · ${newId}`, 'ok');
      go(newId);
    } catch (e) {
      go2.disabled = false;
      status.className = 'rd-clone-status err';
      status.textContent = e.message;
    }
  });
}

function confirmDelete() {
  const go2 = h('button', { class: 'primary danger' }, 'Delete');
  const status = h('p', { class: 'rd-clone-status', role: 'status' });
  const m = modal(`Delete ${recordName()}?`, h('div', {},
    h('p', {}, h('b', {}, `${S.desc.label} ${S.id}`), ' will be deleted.'),
    h('p', { class: 'dx-muted' }, 'It goes to the Recycle Bin. Related records may be deleted with it, and triggers and flows will run.'),
    status), [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go2]);
  go2.addEventListener('click', async () => {
    go2.disabled = true;
    status.textContent = 'Deleting…';
    try {
      await S.backend.remove(S.obj, S.id);
      m.close();
      S.deleted = true;
      S.pending.clear();
      S.editAll = false;
      render();
      toast('Deleted', 'ok');
    } catch (e) {
      go2.disabled = false;
      status.className = 'rd-clone-status err';
      status.textContent = e.message;
    }
  });
}

// ---------- keys ----------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.key === '/' && !e.target.closest('input, textarea, select') && el.filter) { e.preventDefault(); el.filter.focus(); el.filter.select(); }
});
window.addEventListener('beforeunload', (e) => { if (S.pending.size) { e.preventDefault(); e.returnValue = ''; } });

start();
