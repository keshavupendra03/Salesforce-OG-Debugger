// Data Export view: SOQL editor with org-aware autocomplete, query tabs, saved queries and history,
// a virtualized result table (sort, filter, record-id actions), copy as Excel / CSV / JSON,
// CSV download, stop, and deleting selected records.

import { h } from '../dom.js';
import { resizable, collapsibleSide } from '../layout.js';
import {
  suggest, highlightSoql, mainObject, flatten, cellText, toCsv, toTsv, toJson, filterRows, sortRows, isRecordId,
  stripAttrs, DATE_LITERALS,
} from './soql.js';

const ROW_H = 30;
const FETCH_CAP = 50000; // rows fetched before asking to load more
const HISTORY_MAX = 100;

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const num = (n) => Number(n).toLocaleString();
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const uid = () => Math.random().toString(36).slice(2, 10);

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2600);
}

// One floating menu / popover at a time; closes on outside click, Escape or scroll of its anchor's container.
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener('pointerdown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.key, true);
  openMenu.anchor?.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
function popover(anchor, content, { cls = '', align = 'start' } = {}) {
  closeMenu();
  const el = h('div', { class: `dx-pop ${cls}`, role: 'menu' }, content);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = align === 'end' ? r.right - w : r.left;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  const below = r.bottom + 4;
  el.style.top = `${below + el.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 4) : below}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); anchor.focus?.(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, outside, key, anchor };
  el.querySelector('button')?.focus();
  return el;
}
const menuItem = (label, onclick, { icon, hint, danger } = {}) => h('button', {
  type: 'button', role: 'menuitem', class: `dx-mi${danger ? ' danger' : ''}`, onclick: () => { closeMenu(); onclick(); },
}, icon ? h('span', { class: 'dx-mi-icon', 'aria-hidden': 'true' }, icon) : null, h('span', {}, label), hint ? h('span', { class: 'dx-mi-hint' }, hint) : null);

function modal({ title, body, actions }) {
  const card = h('div', { class: 'dx-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', {}, title), body, h('div', { class: 'dx-modal-actions' }, actions));
  const wrap = h('div', { class: 'dx-modal' }, card);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  (card.querySelector('input') || card.querySelector('.dx-modal-actions button:last-child'))?.focus();
  return { close, card };
}

export function mountData(root, backend) {
  const K = (k) => `ff-dx-${k}:${backend.orgKey}`;
  const S = {
    tabs: store.get(K('tabs'), null) || [],
    active: store.get(K('active'), null),
    saved: store.get(K('saved'), []),
    history: store.get(K('history'), []),
    side: store.get('ff-dx-side', 'history'),
    sideQ: '',
    objects: { false: null, true: null },
    describes: new Map(), // `${tooling}|name` -> describe | null (failed) ; missing = not loaded
    loading: new Set(),
    results: new Map(), // tab id -> result
    sugg: null,
  };
  if (!S.tabs.length) S.tabs.push(newTab());
  if (!S.tabs.some((t) => t.id === S.active)) S.active = S.tabs[0].id;
  const tab = () => S.tabs.find((t) => t.id === S.active);
  const result = () => S.results.get(S.active) || null;

  function newTab(soql = '') {
    return { id: uid(), name: null, soql, tooling: false, all: false };
  }
  const saveTabs = () => { store.set(K('tabs'), S.tabs.map(({ id, name, soql, tooling, all }) => ({ id, name, soql, tooling, all }))); store.set(K('active'), S.active); };

  // ---------- layout ----------
  const el = {};
  root.replaceChildren(
    el.side = h('aside', { class: 'dx-side' }),
    el.main = h('section', { class: 'dx-main' },
      el.tabs = h('div', { class: 'dx-tabs', role: 'tablist', 'aria-label': 'Query tabs' }),
      el.editorCard = h('div', { class: 'dx-editor' }),
      el.results = h('div', { class: 'dx-results' })),
    resizable({
      handle: h('div'), pane: el.side, host: root, cssVar: '--dx-side', edge: 'end',
      min: 220, max: () => root.clientWidth * 0.45, key: 'ff-split-dx', label: 'Resize the sidebar',
    }));
  const side = collapsibleSide({
    host: root, pane: el.side, key: 'ff-side-dx', label: 'saved queries and history',
    rail: () => [h('span', { class: 'side-rail-chip' }, 'Queries'), h('span', { class: 'side-rail-sub' }, `${S.saved.length} saved · ${S.history.length} history`)],
  });

  // ---------- sidebar: saved + history ----------
  function renderSide() {
    const list = S.side === 'saved' ? S.saved : S.history;
    const q = S.sideQ.trim().toLowerCase();
    const shown = q ? list.filter((x) => (x.soql + ' ' + (x.name || '')).toLowerCase().includes(q)) : list;
    const seg = (k, label, n) => h('button', { role: 'tab', 'aria-selected': String(S.side === k), onclick: () => { S.side = k; store.set('ff-dx-side', k); renderSide(); } },
      label, h('span', { class: 'lg-count' }, n));
    const search = h('input', {
      type: 'search', placeholder: S.side === 'saved' ? 'Search saved queries' : 'Search history', value: S.sideQ, 'aria-label': 'Search queries',
      oninput: (e) => { S.sideQ = e.target.value; renderSideList(); },
    });
    el.sideList = h('ul', { class: 'dx-qlist' });
    let armed = false;
    const clearBtn = S.side === 'history' && S.history.length ? h('button', {
      class: 'ghost small', title: 'Remove every query from the history',
      onclick: (e) => {
        if (!armed) {
          armed = true;
          e.currentTarget.classList.add('armed');
          e.currentTarget.textContent = 'Click again to clear';
          setTimeout(() => { if (armed && e.target.isConnected) { armed = false; e.target.classList.remove('armed'); e.target.textContent = 'Clear history'; } }, 3000);
          return;
        }
        S.history = [];
        store.set(K('history'), S.history);
        renderSide();
        side.refresh();
        toast('History cleared', 'ok');
      },
    }, 'Clear history') : null;
    el.side.querySelectorAll(':scope > :not(.side-rail)').forEach((n) => n.remove());
    el.side.prepend(...[
      h('div', { class: 'dx-side-head' },
        h('div', { class: 'lg-seg', role: 'tablist' }, seg('history', 'History', S.history.length), seg('saved', 'Saved', S.saved.length)),
        search),
      el.sideList,
      clearBtn ? h('div', { class: 'dx-side-foot' }, clearBtn) : null].filter(Boolean));
    renderSideList(shown);
  }

  function renderSideList(shown) {
    const list = S.side === 'saved' ? S.saved : S.history;
    const q = S.sideQ.trim().toLowerCase();
    shown ||= q ? list.filter((x) => (x.soql + ' ' + (x.name || '')).toLowerCase().includes(q)) : list;
    if (!shown.length) {
      el.sideList.replaceChildren(h('li', { class: 'dx-qempty' }, list.length ? 'No matches'
        : S.side === 'saved' ? h('span', {}, 'No saved queries yet. Use ', h('b', {}, '☆ Save'), ' (Ctrl+S) above the editor.')
          : 'Queries you run show up here.'));
      return;
    }
    el.sideList.replaceChildren(...shown.map((x) => {
      const obj = x.object || mainObject(x.soql);
      const remove = () => {
        if (S.side === 'saved') { S.saved = S.saved.filter((s) => s !== x); store.set(K('saved'), S.saved); } else { S.history = S.history.filter((s) => s !== x); store.set(K('history'), S.history); }
        renderSide();
        side.refresh();
      };
      return h('li', { class: 'dx-q', tabindex: '0', title: 'Click to open in the editor · double-click to run', onclick: () => loadQuery(x), ondblclick: () => { loadQuery(x); run(); }, onkeydown: (e) => { if (e.key === 'Enter') { loadQuery(x); if (e.ctrlKey || e.metaKey) run(); } } },
        h('div', { class: 'dx-q-head' },
          x.name ? h('b', { class: 'dx-q-name' }, x.name) : obj ? h('span', { class: 'dx-obj' }, obj) : null,
          x.tooling ? h('span', { class: 'dx-tag' }, 'Tooling') : null,
          x.all ? h('span', { class: 'dx-tag' }, 'All rows') : null,
          S.side === 'history' && x.rows != null ? h('span', { class: 'dx-q-meta' }, `${num(x.rows)} row${x.rows === 1 ? '' : 's'}`) : null,
          h('span', { class: 'dx-q-meta' }, ago(x.at)),
          h('span', { class: 'dx-q-acts' },
            h('button', { class: 'dx-icon', title: 'Run in a new tab', 'aria-label': 'Run in a new tab', onclick: (e) => { e.stopPropagation(); openInNewTab(x); } }, '▶'),
            S.side === 'history' ? h('button', { class: 'dx-icon', title: 'Save this query', 'aria-label': 'Save this query', onclick: (e) => { e.stopPropagation(); saveQuery(x.soql, e.currentTarget, x); } }, '☆') : null,
            h('button', { class: 'dx-icon', title: 'Remove', 'aria-label': 'Remove', onclick: (e) => { e.stopPropagation(); remove(); } }, '×'))),
        h('code', { class: 'dx-q-text' }, oneLine(x.soql)));
    }));
  }

  function loadQuery(x) {
    const t = tab();
    t.soql = x.soql;
    t.tooling = !!x.tooling;
    t.all = !!x.all;
    if (x.name) t.name = x.name;
    saveTabs();
    renderTabs();
    loadEditor();
    ed.ta.focus();
  }

  function openInNewTab(x) {
    const t = { ...newTab(x.soql), tooling: !!x.tooling, all: !!x.all, name: x.name || null };
    S.tabs.push(t);
    switchTab(t.id);
    run();
  }

  function saveQuery(soql, anchor, from) {
    if (!soql.trim()) { toast('Write a query first'); return; }
    const input = h('input', { type: 'text', value: from?.name || tab().name || mainObject(soql) || '', placeholder: 'Name', 'aria-label': 'Query name', spellcheck: 'false' });
    const doSave = () => {
      const name = input.value.trim() || mainObject(soql) || 'Query';
      const existing = S.saved.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (existing) Object.assign(existing, { soql, at: Date.now(), tooling: tab().tooling, all: tab().all });
      else S.saved.unshift({ id: uid(), name, soql, at: Date.now(), tooling: tab().tooling, all: tab().all, object: mainObject(soql) });
      store.set(K('saved'), S.saved);
      if (!from) { tab().name = name; saveTabs(); renderTabs(); }
      closeMenu();
      S.side = 'saved';
      store.set('ff-dx-side', 'saved');
      renderSide();
      side.refresh();
      toast(existing ? `Updated “${name}”` : `Saved “${name}”`, 'ok');
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
    const pop = popover(anchor, h('div', { class: 'dx-save' },
      h('label', { class: 'dx-save-label' }, 'Save query as'), input,
      h('div', { class: 'dx-save-acts' }, h('button', { class: 'ghost small', onclick: closeMenu }, 'Cancel'), h('button', { class: 'primary small', onclick: doSave }, 'Save'))), { align: 'end' });
    pop.querySelector('input').select();
  }

  // ---------- tabs ----------
  function renderTabs() {
    el.tabs.replaceChildren(...S.tabs.map((t) => {
      const r = S.results.get(t.id);
      const name = t.name || mainObject(t.soql) || 'New query';
      const close = S.tabs.length > 1 ? h('button', { class: 'dx-tab-x', title: 'Close tab', 'aria-label': `Close ${name}`, onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, '×') : null;
      const b = h('div', {
        class: `dx-tab${t.id === S.active ? ' active' : ''}`, role: 'tab', tabindex: '0', 'aria-selected': String(t.id === S.active), title: `${name}${t.soql ? `\n${oneLine(t.soql).slice(0, 200)}` : ''}\nDouble-click to rename`,
        onclick: () => switchTab(t.id), onkeydown: (e) => { if (e.key === 'Enter') switchTab(t.id); },
        onauxclick: (e) => { if (e.button === 1 && S.tabs.length > 1) closeTab(t.id); },
        ondblclick: () => renameTab(t, b),
      },
      r?.running ? h('span', { class: 'lg-spinner dx-tab-spin', 'aria-label': 'Running' }) : r?.error ? h('span', { class: 'dx-tab-dot err', title: 'Error' }) : null,
      h('span', { class: 'dx-tab-name' }, name),
      r && !r.error && !r.running ? h('span', { class: 'dx-tab-n' }, num(r.count ?? r.rows.length)) : null,
      close);
      return b;
    }), h('button', { class: 'dx-tab-add', title: 'New query tab', 'aria-label': 'New query tab', onclick: () => { const t = newTab(); S.tabs.push(t); switchTab(t.id); ed.ta.focus(); } }, '+'));
    el.tabs.querySelector('.dx-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renameTab(t, node) {
    const input = h('input', { class: 'dx-tab-rename', value: t.name || mainObject(t.soql) || '', 'aria-label': 'Tab name', spellcheck: 'false' });
    const done = (keep) => { if (keep) t.name = input.value.trim() || null; saveTabs(); renderTabs(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
    node.querySelector('.dx-tab-name').replaceWith(input);
    input.select();
  }

  function switchTab(id) {
    if (S.active === id) return;
    const cur = tab();
    if (cur) { cur.caret = ed.ta.selectionStart; cur.scroll = ed.ta.scrollTop; }
    S.active = id;
    saveTabs();
    renderTabs();
    loadEditor();
    renderResult();
  }

  function closeTab(id) {
    const i = S.tabs.findIndex((t) => t.id === id);
    S.results.get(id)?.controller?.abort();
    S.results.delete(id);
    S.tabs.splice(i, 1);
    if (S.active === id) { S.active = null; switchTab(S.tabs[Math.max(0, i - 1)].id); } else { saveTabs(); renderTabs(); }
  }

  // ---------- editor ----------
  const ed = {};
  function buildEditor() {
    ed.hl = h('pre', { class: 'dx-code dx-hl', 'aria-hidden': 'true' });
    ed.mirror = h('div', { class: 'dx-code dx-mirror', 'aria-hidden': 'true' });
    ed.ta = h('textarea', {
      class: 'dx-code dx-ta', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', 'aria-label': 'SOQL query',
      placeholder: 'SELECT Id, Name FROM Account WHERE …   ·   Ctrl+Enter to run · Ctrl+Space for suggestions',
      'aria-autocomplete': 'list', 'aria-controls': 'dx-sugg',
    });
    ed.sugg = h('ul', { class: 'dx-sugg', id: 'dx-sugg', role: 'listbox', hidden: true });
    ed.box = h('div', { class: 'dx-ed' }, ed.hl, ed.mirror, ed.ta, ed.sugg);

    ed.run = h('button', { class: 'primary dx-run', title: 'Run query (Ctrl+Enter). Runs only the selected text when part of the query is selected.', onclick: () => run() },
      h('span', { 'aria-hidden': 'true' }, '▶'), 'Run');
    ed.stop = h('button', { class: 'ghost dx-stop', title: 'Stop the running query', disabled: true, onclick: () => stop() }, h('span', { class: 'dx-stop-sq', 'aria-hidden': 'true' }), 'Stop');
    ed.obj = h('span', { class: 'dx-obj big', hidden: true });
    ed.all = h('label', { class: 'dx-toggle', title: 'queryAll: also return deleted (Recycle Bin) and archived records' }, h('input', { type: 'checkbox', onchange: (e) => { tab().all = e.target.checked; saveTabs(); } }), 'Deleted & archived');
    ed.tooling = h('label', { class: 'dx-toggle', title: 'Query the Tooling API (ApexClass, ApexTrigger, FlowDefinition…)' }, h('input', {
      type: 'checkbox', onchange: (e) => { tab().tooling = e.target.checked; saveTabs(); syncToggles(); loadObjects(); },
    }), 'Tooling API');
    ed.save = h('button', { class: 'ghost small', title: 'Save this query (Ctrl+S)', onclick: (e) => saveQuery(ed.ta.value, e.currentTarget) }, '☆ Save');
    ed.clear = h('button', { class: 'ghost small', title: 'Clear the editor', onclick: () => { setText(''); ed.ta.focus(); } }, 'Clear');

    const ops = [
      ['=', '= '], ['!=', '!= '], ['<', '< '], ['<=', '<= '], ['>', '> '], ['>=', '>= '],
      ['LIKE', "LIKE '%%'", -2], ['IN', "IN ('')", -2], ['NOT IN', "NOT IN ('')", -2], ['INCLUDES', "INCLUDES ('')", -2],
      '|', ['AND', 'AND '], ['OR', 'OR '], ['NOT', 'NOT '], ['( )', '()', -1],
      '|', ['= null', '= null'], ['!= null', '!= null'],
      '|', ['WHERE', 'WHERE '], ['ORDER BY', 'ORDER BY '], ['GROUP BY', 'GROUP BY '], ['LIMIT', 'LIMIT 100'], ['COUNT()', 'COUNT()'],
    ];
    const dates = h('select', {
      class: 'dx-dates', 'aria-label': 'Insert a date literal', title: 'Insert a date literal',
      onchange: (e) => { if (e.target.value) insertAt(e.target.value + ' '); e.target.value = ''; },
    }, h('option', { value: '' }, 'Dates…'), DATE_LITERALS.map((d) => h('option', { value: d }, d)));
    ed.ops = h('div', { class: 'dx-ops', 'aria-label': 'Insert operator' },
      h('span', { class: 'dx-ops-label' }, 'Insert'),
      ops.map((o) => (o === '|' ? h('span', { class: 'dx-ops-sep', 'aria-hidden': 'true' })
        : h('button', { type: 'button', class: 'dx-op', title: `Insert ${o[1].trim()}`, onmousedown: (e) => e.preventDefault(), onclick: () => insertAt(o[1], o[2] || 0) }, o[0]))),
      dates);

    ed.hint = h('span', { class: 'dx-ed-hint' });
    el.editorCard.replaceChildren(
      h('div', { class: 'dx-ed-bar' }, ed.run, ed.stop, ed.obj, h('span', { class: 'dx-grow' }), ed.all, ed.tooling, ed.save, ed.clear),
      ed.box,
      ed.ops,
      h('div', { class: 'dx-ed-grip-row' }, ed.hint),
      resizable({
        handle: h('div', { class: 'dx-ed-grip' }), pane: ed.box, host: root, cssVar: '--dx-ed', axis: 'y', edge: 'end',
        min: 70, max: () => el.main.clientHeight - 220, key: 'ff-split-dx-ed', label: 'Resize the editor',
      }));

    ed.ta.addEventListener('input', () => {
      tab().soql = ed.ta.value;
      paint();
      saveSoon();
      updateSuggest(true);
      if (!tab().name) renderTabsSoon();
    });
    ed.ta.addEventListener('scroll', () => { ed.hl.scrollTop = ed.ta.scrollTop; ed.hl.scrollLeft = ed.ta.scrollLeft; if (S.sugg) placeSuggest(); });
    ed.ta.addEventListener('click', () => hideSuggest());
    ed.ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ed.ta) hideSuggest(); }, 120));
    ed.ta.addEventListener('keydown', onKey);
  }

  let saveT = 0;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(saveTabs, 400); };
  let tabsT = 0;
  const renderTabsSoon = () => { clearTimeout(tabsT); tabsT = setTimeout(renderTabs, 300); };

  function paint() {
    ed.hl.innerHTML = highlightSoql(ed.ta.value);
    ed.hl.scrollTop = ed.ta.scrollTop;
    const obj = mainObject(ed.ta.value);
    ed.obj.hidden = !obj;
    ed.obj.textContent = obj || '';
    // fetch the fields as soon as the object is known, so suggestions are ready when the user goes back to SELECT / WHERE
    if (obj && S.objects[tab().tooling]?.some((o) => o.name.toLowerCase() === obj.toLowerCase())) loadDescribes([obj]);
  }

  function syncToggles() {
    const t = tab();
    ed.tooling.querySelector('input').checked = t.tooling;
    ed.all.querySelector('input').checked = t.all && !t.tooling;
    ed.all.querySelector('input').disabled = t.tooling;
    ed.all.classList.toggle('off', t.tooling);
  }

  function loadEditor() {
    const t = tab();
    ed.ta.value = t.soql;
    paint();
    syncToggles();
    hideSuggest();
    const pos = t.caret ?? t.soql.length;
    ed.ta.setSelectionRange(pos, pos);
    ed.ta.scrollTop = t.scroll || 0;
  }

  function setText(text) {
    ed.ta.focus();
    ed.ta.select();
    if (!document.execCommand('insertText', false, text)) ed.ta.value = text;
    tab().soql = ed.ta.value;
    paint();
    saveTabs();
    hideSuggest();
  }

  // Insert at the caret (keeps undo), with spaces around it as needed.
  function insertAt(text, caret = 0) {
    const ta = ed.ta;
    ta.focus();
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const before = ta.value.slice(0, s);
    const pre = before && !/\s$/.test(before) && !/^[),]/.test(text) ? ' ' : '';
    replaceRange(s, e, pre + text, caret);
  }

  function replaceRange(from, to, text, caret = 0) {
    const ta = ed.ta;
    ta.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, from, to, 'end');
      ta.dispatchEvent(new Event('input'));
    }
    const p = from + text.length + caret;
    ta.setSelectionRange(p, p);
  }

  function onKey(e) {
    const open = S.sugg && !ed.sugg.hidden && S.sugg.items.length;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); hideSuggest(); run(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveQuery(ed.ta.value, ed.save); return; }
    if (e.ctrlKey && e.key === ' ') { e.preventDefault(); updateSuggest(true, true); return; }
    if (!open) {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); replaceRange(ed.ta.selectionStart, ed.ta.selectionEnd, '  '); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = S.sugg.items.length;
      S.sugg.sel = (S.sugg.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      drawSuggest();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(S.sugg.items[S.sugg.sel]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideSuggest();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      hideSuggest();
    }
  }

  // ---------- autocomplete ----------
  const descKey = (name) => `${tab().tooling}|${name.toLowerCase()}`;
  const meta = {
    get objects() { return S.objects[tab().tooling] || []; },
    describe: (name) => (S.describes.has(descKey(name)) ? S.describes.get(descKey(name)) : undefined),
  };

  async function loadObjects() {
    const tooling = tab().tooling;
    if (S.objects[tooling]) return;
    try {
      S.objects[tooling] = await backend.listObjects({ tooling });
      if (document.activeElement === ed.ta && S.sugg) updateSuggest(false);
    } catch (e) {
      S.objects[tooling] = [];
      toast(`Couldn’t load the object list: ${e.message}`, 'error');
    }
  }

  function loadDescribes(names) {
    const tooling = tab().tooling;
    for (const n of names) {
      const k = `${tooling}|${n.toLowerCase()}`;
      if (S.loading.has(k) || S.describes.has(k)) continue;
      S.loading.add(k);
      backend.describe(n, { tooling })
        .then((d) => S.describes.set(k, d))
        .catch(() => S.describes.set(k, null))
        .finally(() => {
          S.loading.delete(k);
          // reopen the list that was waiting for these fields
          if (document.activeElement === ed.ta && (S.sugg || S.waiting)) updateSuggest(true, S.sugg?.manual || S.waiting === 'manual');
        });
    }
  }

  function updateSuggest(typed, manual = false) {
    const ta = ed.ta;
    if (ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
    const pos = ta.selectionStart;
    const r = suggest(ta.value, pos, meta);
    // only pop up on its own while typing a word or right after a space / operator
    const ch = ta.value[pos - 1] || '';
    const wanted = manual || S.sugg?.manual || (typed && /[\w.'( ,=<>]/.test(ch));
    const waiting = wanted && r.need.length ? (manual || S.sugg?.manual ? 'manual' : 'typed') : null;
    if (r.need.length) loadDescribes(r.need);
    // Ctrl+Space in an empty SELECT list (SELECT | FROM WorkOrder): put every field in straight away
    if ((manual || S.waiting === 'manual') && r.allFields) {
      S.sugg = { ...r, sel: 0 };
      accept(r.allFields);
      hideSuggest(); // don't follow up with the FROM suggestion
      toast(`Added ${r.allFields.label.replace(/^All fields \((\d+)\)$/, '$1')} fields of ${mainObject(ta.value) || 'the object'}`, 'ok');
      return;
    }
    if (!wanted || (!r.items.length && !(manual && r.hint))) {
      hideSuggest();
      S.waiting = waiting; // fields still loading: reopen when they arrive
      ed.hint.textContent = r.hint && !r.items.length ? r.hint : '';
      return;
    }
    S.waiting = waiting;
    const prevSel = S.sugg?.items[S.sugg.sel]?.label;
    const sel = Math.max(0, r.items.findIndex((x) => x.label === prevSel));
    S.sugg = { ...r, sel, manual: manual || S.sugg?.manual };
    ed.hint.textContent = '';
    drawSuggest();
    placeSuggest();
  }

  const KIND_ICON = { all: '✱', field: 'F', rel: '→', object: 'O', kw: 'K', value: 'V', date: 'D', fn: 'ƒ', op: '≡', snippet: '⌘' };
  function drawSuggest() {
    const s = S.sugg;
    ed.sugg.hidden = false;
    if (!s.items.length) {
      ed.sugg.replaceChildren(h('li', { class: 'dx-sg-hint' }, s.hint || 'No suggestions'));
      return;
    }
    const partial = ed.ta.value.slice(s.from, ed.ta.selectionStart).toLowerCase();
    ed.sugg.replaceChildren(...s.items.map((it, i) => {
      const l = it.label;
      const at = partial ? l.toLowerCase().indexOf(partial) : -1;
      const label = at >= 0 ? [l.slice(0, at), h('mark', {}, l.slice(at, at + partial.length)), l.slice(at + partial.length)] : l;
      return h('li', {
        role: 'option', id: `dx-sg-${i}`, class: `dx-sg k-${it.kind}${i === s.sel ? ' sel' : ''}`, 'aria-selected': String(i === s.sel),
        onmousedown: (e) => { e.preventDefault(); accept(it); },
      }, h('span', { class: 'dx-sg-icon', 'aria-hidden': 'true' }, KIND_ICON[it.kind] || '·'), h('span', { class: 'dx-sg-label' }, label), it.detail ? h('span', { class: 'dx-sg-detail' }, it.detail) : null);
    }), h('li', { class: 'dx-sg-foot', 'aria-hidden': 'true' }, '↑↓ choose · Enter / Tab insert · Esc close'));
    ed.ta.setAttribute('aria-activedescendant', `dx-sg-${s.sel}`);
    ed.sugg.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  function placeSuggest() {
    const ta = ed.ta;
    const m = ed.mirror;
    m.style.width = `${ta.clientWidth}px`;
    m.textContent = ta.value.slice(0, S.sugg.from);
    const mark = h('span', {}, '​');
    m.append(mark);
    const x = mark.offsetLeft - ta.scrollLeft;
    const y = mark.offsetTop - ta.scrollTop + mark.offsetHeight;
    const boxW = ed.box.clientWidth;
    const w = ed.sugg.offsetWidth || 360;
    ed.sugg.style.left = `${Math.max(4, Math.min(x, boxW - w - 4))}px`;
    ed.sugg.style.top = `${Math.max(0, y + 2)}px`;
  }

  function hideSuggest() {
    S.sugg = null;
    S.waiting = null;
    ed.sugg.hidden = true;
    ed.ta.removeAttribute('aria-activedescendant');
  }

  function accept(it) {
    const s = S.sugg;
    if (!it || !s) return;
    replaceRange(s.from, Math.max(s.to, ed.ta.selectionStart), it.insert, it.caret || 0);
    hideSuggest();
    if (it.again || /[ (.]$/.test(it.insert) || it.kind === 'op') updateSuggest(true);
  }

  // ---------- running ----------
  async function run() {
    const t = tab();
    const ta = ed.ta;
    const selected = ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    const soql = (selected.trim() ? selected : ta.value).trim().replace(/;\s*$/, '');
    if (!soql) { toast('Write a query first'); ta.focus(); return; }
    S.results.get(t.id)?.controller?.abort();
    const controller = new AbortController();
    const r = {
      soql, tooling: t.tooling, all: t.all && !t.tooling, object: mainObject(soql), controller, running: true, started: performance.now(),
      columns: [], rows: [], records: 0, total: null, next: null, error: null, stopped: false, ms: 0,
      sort: { col: null, dir: 0 }, filter: '', filterOpen: false, selected: new Set(),
    };
    S.results.set(t.id, r);
    renderTabs();
    renderResult();
    const opts = { tooling: r.tooling, all: r.all, signal: controller.signal };
    try {
      let page = await backend.query(soql, opts);
      r.total = page.totalSize;
      if (/^\s*select\s+count\(\s*\)\s+from\b/i.test(soql)) r.count = page.totalSize;
      addRecords(r, page.records);
      r.next = page.next;
      while (r.next && r.rows.length < FETCH_CAP) {
        if (S.active === t.id) renderResult(true);
        page = await backend.more(r.next, opts);
        addRecords(r, page.records);
        r.next = page.next;
      }
      pushHistory(r, t);
    } catch (e) {
      if (e?.name === 'AbortError') r.stopped = true;
      else r.error = e.message || String(e);
    }
    r.running = false;
    r.controller = null;
    r.ms = performance.now() - r.started;
    if (S.results.get(t.id) !== r) return;
    renderTabs();
    if (S.active === t.id) renderResult();
  }

  async function loadMore() {
    const r = result();
    if (!r?.next || r.running) return;
    const controller = new AbortController();
    Object.assign(r, { running: true, controller, stopped: false });
    renderTabs();
    renderResult(true);
    const cap = r.rows.length + FETCH_CAP;
    try {
      while (r.next && r.rows.length < cap) {
        const page = await backend.more(r.next, { signal: controller.signal });
        addRecords(r, page.records);
        r.next = page.next;
        if (result() === r) renderResult(true);
      }
    } catch (e) {
      if (e?.name === 'AbortError') r.stopped = true;
      else r.error = e.message;
    }
    r.running = false;
    r.controller = null;
    renderTabs();
    if (result() === r) renderResult();
  }

  function addRecords(r, records) {
    if (!records.length) return;
    const f = flatten(records, r.columns);
    r.columns = f.columns;
    for (const row of f.rows) r.rows.push(row);
  }

  function stop() {
    result()?.controller?.abort();
  }

  function pushHistory(r, t) {
    const e = { soql: r.soql, at: Date.now(), rows: r.count ?? r.total ?? r.rows.length, object: r.object, tooling: r.tooling, all: r.all };
    S.history = [e, ...S.history.filter((x) => oneLine(x.soql) !== oneLine(r.soql) || !!x.tooling !== r.tooling)].slice(0, HISTORY_MAX);
    store.set(K('history'), S.history);
    if (!t.name && r.object) saveTabs();
    renderSide();
    side.refresh();
  }

  // ---------- results ----------
  const tbl = {};
  function renderResult(progressOnly = false) {
    const r = result();
    ed.run.disabled = !!r?.running;
    ed.stop.disabled = !r?.running;
    // same result still on screen (pages streaming in, or the run just finished): update in place, keep the scroll
    const tableCase = r && !r.error && !(r.count != null && !r.columns.length);
    if (tableCase && tbl.r === r && tbl.wrap?.isConnected && el.results.dataset.tab === S.active) {
      refreshTable();
      return;
    }
    if (progressOnly && r) return;
    el.results.dataset.tab = S.active;
    if (!r) { el.results.replaceChildren(emptyState()); tbl.status = null; return; }
    if (r.error) {
      tbl.status = null;
      const at = /Row:(\d+):Column:(\d+)/i.exec(r.error);
      el.results.replaceChildren(h('div', { class: 'dx-error' },
        h('div', { class: 'dx-error-title' }, 'The query failed'),
        h('pre', {}, r.error),
        h('div', { class: 'lg-row' },
          at ? h('button', { class: 'ghost small', onclick: () => goTo(+at[1], +at[2]) }, `Go to row ${at[1]}, column ${at[2]}`) : null,
          h('button', { class: 'ghost small', onclick: () => run() }, 'Run again'))));
      return;
    }
    if (r.count != null && !r.columns.length) {
      tbl.status = null;
      el.results.replaceChildren(h('div', { class: 'dx-count' },
        h('span', { class: 'dx-count-n' }, num(r.count)), h('span', {}, `${r.object || 'records'} match · ${fmtMs(r.ms)}`)));
      return;
    }
    buildTable(r);
  }

  function goTo(row, col) {
    const lines = ed.ta.value.split('\n');
    let p = 0;
    for (let i = 0; i < row - 1 && i < lines.length; i++) p += lines[i].length + 1;
    p += Math.max(0, col - 1);
    ed.ta.focus();
    ed.ta.setSelectionRange(p, p + 1);
  }

  function emptyState() {
    const samples = [
      'SELECT Id, Name, Industry, AnnualRevenue FROM Account ORDER BY Name LIMIT 50',
      'SELECT Id, Name, Email, Account.Name FROM Contact WHERE Email != null LIMIT 100',
      'SELECT Name, (SELECT Name, Email FROM Contacts) FROM Account LIMIT 20',
      'SELECT COUNT() FROM Opportunity WHERE IsClosed = false',
    ];
    return h('div', { class: 'dx-empty' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('p', { class: 'empty-title' }, 'Write a query, then press Ctrl+Enter'),
      h('p', { class: 'empty-sub' }, 'Suggestions for objects, fields, operators and picklist values appear as you type. Ctrl+Space opens them any time.'),
      h('div', { class: 'dx-samples' }, h('span', { class: 'dx-samples-label' }, 'Try one'),
        samples.map((s) => h('button', { class: 'dx-sample', onclick: () => { setText(s); run(); } }, h('code', {}, s)))));
  }

  function statusParts(r) {
    const shown = tbl.view ? tbl.view.length : r.rows.length;
    const parts = [];
    if (r.running) {
      parts.push(h('span', { class: 'lg-spinner' }), h('b', {}, r.rows.length ? `Fetching… ${num(r.rows.length)}${r.total != null ? ` of ${num(r.total)}` : ''}` : 'Running…'));
      if (r.total) parts.push(h('span', { class: 'dx-mini-bar' }, h('span', { style: `width:${Math.min(100, (r.rows.length / r.total) * 100)}%` })));
    } else {
      parts.push(h('b', {}, `${num(r.rows.length)} row${r.rows.length === 1 ? '' : 's'}`));
      if (r.total != null && r.total > r.rows.length) parts.push(h('span', { class: 'dx-muted' }, `of ${num(r.total)}`));
      parts.push(h('span', { class: 'dx-muted' }, `· ${fmtMs(r.ms)}`));
      if (r.stopped) parts.push(h('span', { class: 'dx-warn' }, 'Stopped'));
      if (r.next) parts.push(h('button', { class: 'link', onclick: loadMore }, `Load ${r.total ? num(Math.min(FETCH_CAP, r.total - r.rows.length)) : 'more'} more`));
    }
    if (r.filter && !r.running) parts.push(h('span', { class: 'dx-filter-chip' }, `${num(shown)} match “${r.filter}”`));
    return parts;
  }

  function buildTable(r) {
    tbl.r = r;
    tbl.status = h('div', { class: 'dx-status', 'aria-live': 'polite' });

    const filterIn = h('input', {
      type: 'search', class: 'dx-filter-in', placeholder: 'Filter rows…', value: r.filter, 'aria-label': 'Filter rows', hidden: !r.filterOpen,
      oninput: (e) => { r.filter = e.target.value; clearTimeout(tbl.ft); tbl.ft = setTimeout(() => { computeView(); refreshTable(true); updateToolbar(); }, 120); },
      onkeydown: (e) => { if (e.key === 'Escape') { r.filter = ''; e.target.value = ''; r.filterOpen = false; e.target.hidden = true; computeView(); refreshTable(true); updateToolbar(); } },
    });
    const filterBtn = h('button', {
      class: `ghost small dx-tb${r.filter ? ' on' : ''}`, title: 'Filter rows by text', 'aria-pressed': String(r.filterOpen),
      onclick: () => {
        r.filterOpen = !r.filterOpen;
        filterIn.hidden = !r.filterOpen;
        filterBtn.setAttribute('aria-pressed', String(r.filterOpen));
        if (r.filterOpen) filterIn.focus();
        else if (r.filter) { r.filter = ''; filterIn.value = ''; computeView(); refreshTable(true); updateToolbar(); }
      },
    }, h('span', { 'aria-hidden': 'true' }, '⌕'), 'Filter');
    const copyBtn = h('button', {
      class: 'ghost small dx-tb', title: 'Copy the rows', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => popover(e.currentTarget, [
        menuItem('Copy for Excel', () => copy('excel'), { icon: '⊞', hint: 'tab-separated' }),
        menuItem('Copy as CSV', () => copy('csv'), { icon: ',', hint: 'comma-separated' }),
        menuItem('Copy as JSON', () => copy('json'), { icon: '{}', hint: 'array of rows' }),
      ], { align: 'end' }),
    }, h('span', { 'aria-hidden': 'true' }, '⧉'), 'Copy ▾');
    const dlBtn = h('button', { class: 'ghost small dx-tb', title: 'Download the rows as a CSV file', onclick: download }, h('span', { 'aria-hidden': 'true' }, '⤓'), 'CSV');
    tbl.delBtn = h('button', { class: 'ghost small dx-tb dx-del', hidden: true, onclick: confirmDelete });

    tbl.wrap = h('div', { class: 'dx-tablewrap', tabindex: '0', 'aria-label': 'Query results' });
    el.results.replaceChildren(
      h('div', { class: 'dx-rbar' }, tbl.status, h('span', { class: 'dx-grow' }), filterIn, filterBtn, copyBtn, dlBtn, tbl.delBtn),
      tbl.wrap);
    tbl.updateToolbar = updateToolbar;
    function updateToolbar() {
      filterBtn.classList.toggle('on', !!r.filter);
      tbl.status.replaceChildren(...statusParts(r));
      const n = r.selected.size;
      tbl.delBtn.hidden = !n;
      tbl.delBtn.textContent = `Delete ${num(n)}`;
    }
    computeView();
    drawTableShell();
    updateToolbar();
    tbl.wrap.addEventListener('scroll', () => { cancelAnimationFrame(tbl.raf); tbl.raf = requestAnimationFrame(drawRows); });
    // row checkboxes; shift-click selects a range
    tbl.wrap.addEventListener('click', (e) => {
      const box = e.target.closest?.('input[data-id]');
      if (!box) return;
      const i = +box.dataset.i;
      const on = box.checked;
      const from = e.shiftKey && tbl.lastI != null ? Math.min(tbl.lastI, i) : i;
      const to = e.shiftKey && tbl.lastI != null ? Math.max(tbl.lastI, i) : i;
      for (let k = from; k <= to; k++) {
        const id = tbl.view[k]?.Id;
        if (id) { if (on) r.selected.add(id); else r.selected.delete(id); }
      }
      tbl.lastI = i;
      drawRows();
      tbl.updateToolbar();
    });
  }

  function computeView() {
    const r = tbl.r;
    tbl.view = sortRows(filterRows(r.rows, r.columns, r.filter), r.sort.col, r.sort.dir);
  }

  // called while pages stream in, or after filter/sort
  function refreshTable(scrollTop = false) {
    const r = tbl.r;
    if (!tbl.wrap?.isConnected) return;
    const colsChanged = tbl.cols !== r.columns.join('\n');
    computeView();
    if (colsChanged) drawTableShell();
    if (scrollTop) tbl.wrap.scrollTop = 0;
    drawRows();
    tbl.updateToolbar?.();
  }

  // Column width = widest text in the column (header included), measured with the real fonts, plus padding.
  const COL_PAD = 20 + 1 + 12; // cell padding + border + breathing room
  const COL_MAX = 480; // longer text is cut with … (full value in the tooltip)
  let measureCtx = null;
  function widthOf(c, rows) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(tbl.wrap);
    const sans = getComputedStyle(document.body).fontFamily;
    const mono = cs.getPropertyValue('--mono').trim() || 'monospace';
    const text = (s, font) => { measureCtx.font = font; return measureCtx.measureText(s).width; };
    let max = text(c, `650 12px ${mono}`) + 14; // header, with room for the sort arrow
    // look at every row of small results, a spread of rows of big ones
    const step = Math.max(1, Math.floor(rows.length / 2000));
    for (let i = 0; i < rows.length; i += step) {
      const v = rows[i][c];
      if (v == null) continue;
      let w;
      if (typeof v === 'object' && v.sub) w = text(`${num(v.total)} rows`, `600 11px ${sans}`) + 20;
      else if (typeof v === 'number') w = text(v.toLocaleString(undefined, { maximumFractionDigits: 6 }), `12px ${mono}`);
      else if (typeof v === 'boolean') w = text(String(v), `600 11.5px ${mono}`);
      else {
        const s = cellText(v);
        w = isRecordId(s, c) ? text(s, `12px ${mono}`) : text(s.length > 120 ? s.slice(0, 120) : s, `12.5px ${sans}`);
      }
      if (w > max) max = w;
      if (max >= COL_MAX) break;
    }
    return Math.round(Math.min(COL_MAX, Math.max(48, max + COL_PAD)));
  }

  function drawTableShell() {
    const r = tbl.r;
    tbl.cols = r.columns.join('\n');
    tbl.canDelete = !r.tooling && r.columns.includes('Id');
    const cols = r.columns;
    const colgroup = h('colgroup', {},
      tbl.canDelete ? h('col', { style: 'width:36px' }) : null,
      h('col', { style: `width:${Math.max(40, String(Math.max(r.rows.length, r.total || 0)).length * 8 + 24)}px` }),
      cols.map((c) => h('col', { style: `width:${widthOf(c, r.rows)}px` })),
      h('col', {})); // filler: takes the spare width so the data columns keep their size
    tbl.selAll = tbl.canDelete ? h('input', {
      type: 'checkbox', 'aria-label': 'Select all rows',
      onchange: (e) => {
        for (const row of tbl.view) if (row.Id) { if (e.target.checked) r.selected.add(row.Id); else r.selected.delete(row.Id); }
        drawRows();
        tbl.updateToolbar();
      },
    }) : null;
    const th = (c) => {
      const dir = r.sort.col === c ? r.sort.dir : 0;
      return h('th', {
        scope: 'col', title: `${c}\nClick to sort`, 'aria-sort': dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none',
        onclick: () => {
          const next = r.sort.col !== c ? 1 : r.sort.dir === 1 ? -1 : r.sort.dir === -1 ? 0 : 1;
          r.sort = { col: next ? c : null, dir: next };
          drawTableShell();
          refreshTable();
        },
      }, h('span', { class: 'dx-th' }, h('span', { class: 'dx-th-name' }, c), h('span', { class: 'dx-sort', 'aria-hidden': 'true' }, dir === 1 ? '▲' : dir === -1 ? '▼' : '')));
    };
    tbl.body = h('tbody', {});
    tbl.table = h('table', { class: 'dx-table' }, colgroup,
      h('thead', {}, h('tr', {}, tbl.canDelete ? h('th', { class: 'dx-sel' }, tbl.selAll) : null, h('th', { class: 'dx-rn' }, '#'), cols.map(th), h('th', { class: 'dx-fill', 'aria-hidden': 'true' }))),
      tbl.body);
    tbl.wrap.replaceChildren(tbl.table);
    drawRows();
  }

  function drawRows() {
    const r = tbl.r;
    const view = tbl.view;
    const wrap = tbl.wrap;
    if (!wrap) return;
    if (!view.length) {
      tbl.body.replaceChildren(h('tr', {}, h('td', { class: 'dx-norows', colspan: String(r.columns.length + 3) },
        r.running ? 'Waiting for rows…' : r.filter ? 'No rows match the filter.' : 'The query returned no rows.')));
      return;
    }
    const headH = tbl.table.tHead.offsetHeight || ROW_H;
    const first = Math.max(0, Math.floor((wrap.scrollTop - headH) / ROW_H) - 15);
    const count = Math.ceil(wrap.clientHeight / ROW_H) + 30;
    const last = Math.min(view.length, first + count);
    const cols = r.columns;
    const span = cols.length + (tbl.canDelete ? 3 : 2);
    const frag = [h('tr', { class: 'dx-spacer', style: `height:${first * ROW_H}px` }, h('td', { colspan: String(span) }))];
    for (let i = first; i < last; i++) {
      const row = view[i];
      const sel = tbl.canDelete && row.Id && r.selected.has(row.Id);
      const tr = h('tr', { class: sel ? 'sel' : null },
        tbl.canDelete ? h('td', { class: 'dx-sel' }, row.Id ? h('input', { type: 'checkbox', checked: sel, 'aria-label': `Select row ${i + 1}`, 'data-id': row.Id, 'data-i': i }) : null) : null,
        h('td', { class: 'dx-rn' }, i + 1));
      for (const c of cols) tr.append(cell(row[c], c, row));
      tr.append(h('td', { class: 'dx-fill' }));
      frag.push(tr);
    }
    frag.push(h('tr', { class: 'dx-spacer', style: `height:${(view.length - last) * ROW_H}px` }, h('td', { colspan: String(span) })));
    tbl.body.replaceChildren(...frag);
    if (tbl.selAll) {
      const ids = view.filter((x) => x.Id);
      const n = ids.filter((x) => r.selected.has(x.Id)).length;
      tbl.selAll.checked = n > 0 && n === ids.length;
      tbl.selAll.indeterminate = n > 0 && n < ids.length;
    }
  }

  function cell(v, col, row) {
    if (v == null) return h('td', { class: 'dx-null' }, '');
    if (typeof v === 'object' && v.sub) {
      return h('td', {}, h('button', { class: 'dx-subbtn', title: 'Show the related rows', onclick: (e) => showSub(e.currentTarget, col, v) }, `${num(v.total)} row${v.total === 1 ? '' : 's'}`));
    }
    if (typeof v === 'number') return h('td', { class: 'dx-num' }, v.toLocaleString(undefined, { maximumFractionDigits: 6 }));
    if (typeof v === 'boolean') return h('td', { class: `dx-bool ${v}` }, String(v));
    const s = typeof v === 'object' ? cellText(v) : String(v); // compound fields (addresses, geolocations) as JSON
    if (isRecordId(s, col)) {
      return h('td', {}, h('button', {
        class: 'dx-id', title: 'Record actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onclick: (e) => idMenu(e.currentTarget, s, row),
      }, s));
    }
    return h('td', { title: s.length > 40 ? s.slice(0, 1000) : null }, s.length > 300 ? s.slice(0, 300) + '…' : s);
  }

  function idMenu(anchor, id, row) {
    popover(anchor, [
      h('div', { class: 'dx-pop-head' }, h('code', {}, id), row.__type && row.Id === id ? h('span', { class: 'dx-obj' }, row.__type) : null),
      menuItem('View in Salesforce', () => window.open(backend.recordUrl(id), '_blank', 'noopener'), { icon: '↗', hint: 'new tab' }),
      menuItem('Copy Id', () => copyText(id, 'Id copied'), { icon: '⧉' }),
      row.Id === id && row.__type ? menuItem('All fields of this record', () => {
        const t = { ...newTab(`SELECT FIELDS(ALL) FROM ${row.__type} WHERE Id = '${id}' LIMIT 1`), tooling: tab().tooling };
        S.tabs.push(t);
        switchTab(t.id);
        run();
      }, { icon: '⌕', hint: 'new tab' }) : null,
    ]);
  }

  function showSub(anchor, col, v) {
    const f = flatten(v.sub);
    const cols = f.columns;
    const table = h('table', { class: 'dx-table mini' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, f.rows.slice(0, 100).map((row) => h('tr', {}, cols.map((c) => {
        const s = cellText(row[c]);
        return h('td', { class: row[c] == null ? 'dx-null' : null }, isRecordId(s, c) ? h('code', {}, s) : s);
      })))));
    popover(anchor, [
      h('div', { class: 'dx-pop-head' }, h('b', {}, col), h('span', { class: 'dx-muted' }, `${num(v.total)} row${v.total === 1 ? '' : 's'}${v.total > 100 ? ' · first 100 shown' : ''}`),
        h('span', { class: 'dx-grow' }),
        h('button', { class: 'ghost small', onclick: () => copyText(JSON.stringify(stripAttrs(v.sub), null, 2), 'Copied as JSON') }, 'Copy JSON')),
      h('div', { class: 'dx-sub-scroll' }, table),
    ], { cls: 'dx-subpop' });
  }

  // ---------- copy / download / delete ----------
  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg, 'ok');
    } catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? msg : 'Copy failed: the browser blocked clipboard access', ok ? 'ok' : 'error');
    }
  }

  function exportRows() {
    const r = tbl.r;
    // the selection, if any; otherwise what's shown (filtered + sorted)
    const rows = r.selected.size ? tbl.view.filter((x) => r.selected.has(x.Id)) : tbl.view;
    return { cols: r.columns, rows, what: r.selected.size ? 'selected' : r.filter ? 'filtered' : '' };
  }

  function copy(fmt) {
    const { cols, rows, what } = exportRows();
    const text = fmt === 'excel' ? toTsv(cols, rows) : fmt === 'csv' ? toCsv(cols, rows) : toJson(cols, rows);
    copyText(text, `Copied ${num(rows.length)} ${what ? what + ' ' : ''}row${rows.length === 1 ? '' : 's'} ${fmt === 'excel' ? 'for Excel' : `as ${fmt.toUpperCase()}`}`);
  }

  function download() {
    const { cols, rows, what } = exportRows();
    const r = tbl.r;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `${r.object || 'query'}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
    const blob = new Blob(['﻿' + toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloading ${num(rows.length)} ${what ? what + ' ' : ''}rows · ${name}`, 'ok');
  }

  function confirmDelete() {
    const r = tbl.r;
    const ids = [...r.selected];
    if (!ids.length) return;
    const types = new Map();
    for (const row of r.rows) if (r.selected.has(row.Id)) types.set(row.__type || 'record', (types.get(row.__type || 'record') || 0) + 1);
    const summary = [...types].map(([t, n]) => `${num(n)} ${t}`).join(', ');
    const big = ids.length >= 50;
    const confirmIn = big ? h('input', { type: 'text', placeholder: 'DELETE', 'aria-label': 'Type DELETE to confirm', spellcheck: 'false', autocomplete: 'off' }) : null;
    const go = h('button', { class: 'primary danger', disabled: big }, `Delete ${num(ids.length)} record${ids.length === 1 ? '' : 's'}`);
    confirmIn?.addEventListener('input', () => { go.disabled = confirmIn.value.trim() !== 'DELETE'; });
    const progress = h('div', { class: 'dx-del-progress', hidden: true });
    const m = modal({
      title: `Delete ${num(ids.length)} record${ids.length === 1 ? '' : 's'}?`,
      body: h('div', { class: 'dx-del-body' },
        h('p', {}, h('b', {}, summary), ' will be deleted in ', h('b', {}, backend.orgKey === 'demo' ? 'the demo org' : 'this org'), '.'),
        h('p', { class: 'dx-muted' }, 'Deleted records go to the Recycle Bin. Related records may be deleted with them (cascade), and triggers and flows will run.'),
        big ? h('label', { class: 'dx-del-confirm' }, 'Type ', h('code', {}, 'DELETE'), ' to confirm', confirmIn) : null,
        progress),
      actions: [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go],
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      progress.hidden = false;
      progress.textContent = 'Deleting…';
      let res;
      try {
        res = await backend.deleteRecords(ids, { onProgress: (done, total) => { progress.textContent = `Deleting… ${num(done)} / ${num(total)}`; } });
      } catch (e) {
        progress.replaceChildren(h('span', { class: 'dx-err' }, e.message));
        go.disabled = false;
        return;
      }
      const okIds = new Set(res.filter((x) => x.success).map((x) => x.id));
      const failed = res.filter((x) => !x.success);
      r.rows = r.rows.filter((row) => !okIds.has(row.Id));
      for (const id of okIds) r.selected.delete(id);
      if (r.total != null) r.total -= okIds.size;
      refreshTable();
      renderTabs();
      if (!failed.length) {
        m.close();
        toast(`Deleted ${num(okIds.size)} record${okIds.size === 1 ? '' : 's'}`, 'ok');
        return;
      }
      go.remove();
      m.card.querySelector('h2').textContent = okIds.size ? `Deleted ${num(okIds.size)}, ${num(failed.length)} failed` : `${num(failed.length)} record${failed.length === 1 ? '' : 's'} couldn’t be deleted`;
      progress.replaceChildren(h('ul', { class: 'dx-del-fails' }, failed.slice(0, 50).map((x) => h('li', {}, h('code', {}, x.id), h('span', {}, x.error || 'Unknown error')))));
    });
  }

  // ---------- boot ----------
  buildEditor();
  renderSide();
  renderTabs();
  loadEditor();
  renderResult();
  let booted = false;
  function setActive(on) {
    if (!on) { closeMenu(); hideSuggest(); return; }
    if (!booted) { booted = true; loadObjects(); }
    setTimeout(() => ed.ta.focus(), 0);
  }
  return { setActive };
}
