// OG Explorer: read your org's code like in an IDE. Every class, trigger, LWC, Aura component and
// Visualforce page or component; click a method call to jump to it, Alt+click to peek, back / forward to retrace.

import { h } from '../dom.js';
import { DocStore, DOC_KINDS } from './doc-store.js';
import { apexLinks, componentLinks, linkify, apexRows, apexHandlers, wireLinks, signature } from './code-links.js';
import { foldRegions, enableFolding, selectionHighlighter, markIndent, stickyScroll } from './code-tools.js';
import { syntaxLines } from './syntax.js';
import { resizable, collapsibleSide } from '../layout.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const RECENT_MAX = 15;
// how the code looks: our own, Salesforce's Developer Console, or VS Code (dark). Only the editor changes.
const LOOKS = [
  { id: 'og', label: 'OG', hint: 'This app’s own look', sw: ['#a626a4', '#50a14f', '#2563eb'] },
  { id: 'dc', label: 'Developer Console', hint: 'Like the Salesforce Developer Console', sw: ['#7f0f9e', '#c41a16', '#1a3fc7'] },
  { id: 'vsc', label: 'VS Code', hint: 'Like VS Code’s dark theme', sw: ['#c586c0', '#dcdcaa', '#4ec9b0'], dark: true },
];
const SECTIONS = ['class', 'trigger', 'lwc', 'aura', 'vfpage', 'vfcomp'];

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2200);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg, 'ok');
}

/**
 * opts: { getIndex, sources, orgKey, setupUrl(unit), openCodeFlow(methodId), openExecutor(className), isAsync(type) }
 * Returns { setActive, open(target, { newTab }) }.
 */
export function mountExplorer(root, opts) {
  const K = `og-explorer:${opts.orgKey || 'org'}`;
  const saved = store.get(K, {});
  const S = {
    active: false, docs: null, index: null, q: '', collapsed: new Set(saved.collapsed || ['class', 'trigger', 'lwc', 'aura', 'vfpage', 'vfcomp']),
    tabs: [], cur: -1, back: [], fwd: [], recent: saved.recent || [], line: null, find: null, pending: [],
  };
  const el = {};
  const linkCache = new WeakMap(); // parsed Apex file → links
  const compLinks = new Map(); // doc key → per-file links

  // ---------- layout ----------
  el.side = h('aside', { class: 'cx-side' });
  el.main = h('section', { class: 'cx-main' });
  el.outline = h('aside', { class: 'cx-outline' });
  root.replaceChildren(el.side, el.main, el.outline);
  const setLook = (id) => {
    S.look = LOOKS.some((l) => l.id === id) ? id : 'og';
    for (const l of LOOKS) el.main.classList.toggle(`look-${l.id}`, l.id === S.look);
    store.set('ff-cx-look', S.look);
  };
  setLook(store.get('ff-cx-look', 'og'));
  S.sticky = store.get('ff-cx-sticky', true);
  // both side panes: drag to resize, collapse to a slim rail (the left one also with Ctrl+B)
  root.append(resizable({
    handle: h('div', { class: 'cx-split-side' }), pane: el.side, host: root, cssVar: '--cx-side', edge: 'end',
    min: 180, max: () => root.clientWidth * 0.42, key: 'ff-split-cx-side', label: 'Resize the file list',
  }));
  const side = collapsibleSide({
    host: root, pane: el.side, key: 'ff-side-cx', label: 'the file list',
    rail: () => [h('span', { class: 'side-rail-chip' }, 'Files'), h('span', { class: 'side-rail-label' }, S.docs?.get(S.tabs[S.cur]?.key)?.name || 'Explorer')],
  });
  el.sideRail = el.side.querySelector('.side-rail');
  root.append(resizable({
    handle: h('div', { class: 'cx-split-ol' }), pane: el.outline, host: root, cssVar: '--cx-ol', edge: 'start',
    min: 180, max: () => root.clientWidth * 0.42, key: 'ff-split-cx-ol', label: 'Resize the outline',
  }));
  const setOutline = (closed) => {
    root.classList.toggle('ol-collapsed', closed);
    el.olToggle.setAttribute('aria-expanded', String(!closed));
    el.olToggle.title = `${closed ? 'Show' : 'Hide'} the outline`;
    store.set('ff-cx-ol-collapsed', closed);
  };
  el.olToggle = h('button', { type: 'button', class: 'side-toggle cx-ol-toggle', onclick: () => setOutline(!root.classList.contains('ol-collapsed')) },
    h('span', { class: 'side-toggle-icon', 'aria-hidden': 'true' }, '›'));
  el.olRail = h('button', { type: 'button', class: 'cx-ol-rail', title: 'Show the outline', onclick: () => setOutline(false) },
    h('span', { class: 'side-rail-btn', 'aria-hidden': 'true' }, '‹'), h('span', { class: 'side-rail-sub' }, 'Outline'));
  root.append(el.olToggle);
  setOutline(!!store.get('ff-cx-ol-collapsed', false));
  // selecting text highlights it everywhere in the file
  selectionHighlighter({
    getRoot: () => el.code,
    ignoreCase: () => S.docs?.get(S.tabs[S.cur]?.key)?.file != null, // Apex is case-insensitive
    onCount: (n) => { if (el.selCount) { el.selCount.hidden = n < 2; el.selCount.textContent = `${n} occurrences`; } },
  });
  el.side.replaceChildren(h('div', { class: 'cx-loading' }, h('span', { class: 'lg-spinner' }), 'Reading your code…'));
  drawMain();

  (async () => {
    try {
      S.index = await opts.getIndex();
      S.docs = new DocStore({ index: S.index, sources: opts.sources, setupUrl: opts.setupUrl });
      S.docs.loadApex();
      drawSide();
      restoreTabs();
      S.docs.loadComponents((text) => { if (el.compNote) el.compNote.textContent = text; }).then(() => {
        drawSide();
        if (!S.tabs.length) restoreTabs();
        for (const p of S.pending.splice(0)) open(p.target, p.how);
        if (S.cur >= 0 && /^(lwc|aura|vf)/.test(S.tabs[S.cur].key)) drawMain();
      });
      for (const p of S.pending.splice(0)) open(p.target, p.how);
    } catch (e) {
      el.side.replaceChildren(h('p', { class: 'cx-note err' }, `Couldn’t read the code: ${e.message}`));
    }
  })();

  const save = () => store.set(K, {
    collapsed: [...S.collapsed], recent: S.recent.slice(0, RECENT_MAX),
    tabs: S.tabs.map((t) => ({ key: t.key, file: t.file, line: t.line })), cur: S.cur,
  });
  function restoreTabs() {
    if (S.tabs.length) return;
    for (const t of saved.tabs || []) if (S.docs.get(t.key)) S.tabs.push({ ...t });
    S.cur = Math.min(saved.cur ?? 0, S.tabs.length - 1);
    drawMain();
  }

  // ---------- links ----------
  const linksOfFile = (file) => {
    if (!linkCache.has(file)) linkCache.set(file, apexLinks(S.index, file));
    return linkCache.get(file);
  };
  const methodBy = (cls, name) => {
    const t = (S.index.typesByShortName.get(String(cls).toLowerCase()) || []).find((x) => !x.outer) || null;
    const m = t && (t.methodsByName.get(String(name).toLowerCase()) || [])[0];
    return m?.id || null;
  };
  const typeBy = (name) => ((S.index.typesByShortName.get(String(name).toLowerCase()) || []).find((x) => !x.outer && x.kind !== 'trigger')?.key) || null;
  const linksOfDoc = (doc) => {
    if (doc.file) return [linksOfFile(doc.file)];
    if (!compLinks.has(doc.key)) compLinks.set(doc.key, componentLinks(doc, { method: methodBy, type: typeBy, doc: (k) => !!S.docs.get(k) }));
    return compLinks.get(doc.key);
  };
  const handlers = () => {
    const base = apexHandlers(S.index, { open: (t, how) => open(t, how), linksOf: linksOfFile });
    return {
      ...base,
      describe: (t) => (t.type === 'doc' ? describeDoc(t.key) : base.describe(t)),
      peek: (t) => (t.type === 'doc' ? null : base.peek(t)),
    };
  };
  const describeDoc = (key) => {
    const d = S.docs.get(key);
    if (!d) return null;
    return { title: d.name, sub: d.sub, preview: d.files[0]?.text.split('\n').slice(0, 6) || [], from: 1 };
  };

  // ---------- opening things ----------
  /** Where a target lives: { key, file, line } */
  function locate(t) {
    if (t.type === 'method') {
      const m = S.index.methodsById.get(t.id);
      const d = m && S.docs.docOfUnit(m.file.unit);
      return d ? { key: d.key, file: 0, line: m.startLine, method: m.id } : null;
    }
    if (t.type === 'type') {
      const ty = S.index.types.get(t.key);
      const d = ty && S.docs.docOfUnit(ty.file.unit);
      return d ? { key: d.key, file: 0, line: ty.line || 1 } : null;
    }
    if (t.type === 'doc') return S.docs.get(t.key) ? { key: t.key, file: 0, line: 1 } : null;
    return null;
  }

  function open(target, how = {}) {
    if (!S.docs) { S.pending.push({ target, how }); return; }
    const loc = locate(target);
    if (!loc) {
      if (target.type === 'doc' && !S.docs.componentsLoaded) { S.pending.push({ target, how }); return; }
      toast('That isn’t in your org’s readable code (managed package, or not scanned)', 'error');
      return;
    }
    const here = S.tabs[S.cur];
    if (here) S.back.push({ key: here.key, file: here.file, line: S.line ?? here.line });
    S.fwd = [];
    // following a call: the file you were reading stays open (you were investigating it)
    if (!how.preview && here && here.key !== loc.key) here.temp = false;
    go(loc, how.newTab, how.preview);
  }

  // preview: a glance from the sidebar / Ctrl+P reuses the preview tab, so browsing doesn't pile up tabs
  function go(loc, newTab, preview) {
    let i = S.tabs.findIndex((t) => t.key === loc.key);
    if (i < 0 && !newTab && preview && S.cur >= 0 && S.tabs[S.cur].temp) {
      // a tab you only passed through gets reused: jumping around doesn't pile up tabs
      S.tabs[S.cur] = { key: loc.key, file: loc.file, line: loc.line, temp: true };
      i = S.cur;
    } else if (i < 0) {
      S.tabs.splice(S.cur + 1, 0, { key: loc.key, file: loc.file, line: loc.line, temp: !newTab });
      i = S.cur + 1;
    } else {
      S.tabs[i].file = loc.file;
      S.tabs[i].line = loc.line;
    }
    S.cur = i;
    S.line = loc.line;
    S.recent = [loc.key, ...S.recent.filter((k) => k !== loc.key)].slice(0, RECENT_MAX);
    save();
    drawMain();
    drawSide();
    reveal(loc.line, true);
  }

  function history(dir) {
    const from = dir < 0 ? S.back : S.fwd;
    const to = dir < 0 ? S.fwd : S.back;
    const loc = from.pop();
    if (!loc) return;
    const here = S.tabs[S.cur];
    if (here) to.push({ key: here.key, file: here.file, line: S.line ?? here.line });
    go(loc, false);
  }

  function closeTab(i) {
    S.tabs.splice(i, 1);
    if (S.cur >= S.tabs.length) S.cur = S.tabs.length - 1;
    else if (i < S.cur) S.cur--;
    save();
    drawMain();
  }

  // ---------- side: everything, searchable ----------
  function drawSide() {
    if (!S.docs) return;
    const q = S.q.trim().toLowerCase();
    const match = (d) => !q || d.name.toLowerCase().includes(q);
    const search = h('input', {
      type: 'search', class: 'cx-search', placeholder: 'Filter… (Ctrl+P: go to anything)', value: S.q, spellcheck: 'false', 'aria-label': 'Filter files',
      oninput: (e) => { S.q = e.target.value; const p = e.target.selectionStart; drawSide(); const s = el.side.querySelector('.cx-search'); s.focus(); s.setSelectionRange(p, p); },
    });
    const cur = S.tabs[S.cur]?.key;
    const item = (d) => h('button', { class: `cx-item k-${d.kind}${d.key === cur ? ' sel' : ''}`, title: d.sub, onclick: (e) => openDoc(d.key, e.ctrlKey || e.metaKey) },
      h('span', { class: 'cx-ico', 'aria-hidden': 'true' }, DOC_KINDS[d.kind].icon), h('span', { class: 'cx-item-name' }, d.name));
    const recent = S.recent.map((k) => S.docs.get(k)).filter(Boolean).filter(match).slice(0, 8);
    const sections = SECTIONS.map((kind) => {
      const all = S.docs.list(kind);
      const list = all.filter(match);
      const loading = !S.docs.componentsLoaded && !['class', 'trigger'].includes(kind);
      if (!loading && !all.length) return null;
      const closed = S.collapsed.has(kind) && !q;
      return h('section', { class: 'cx-sec' },
        h('button', {
          class: 'cx-sec-head', 'aria-expanded': String(!closed),
          onclick: () => { if (closed) S.collapsed.delete(kind); else S.collapsed.add(kind); save(); drawSide(); },
        }, h('span', { class: 'cx-chev', 'aria-hidden': 'true' }, '▸'), DOC_KINDS[kind].label,
        h('span', { class: 'cx-n' }, loading ? '…' : q ? `${list.length}/${all.length}` : all.length)),
        closed ? null : loading ? h('p', { class: 'cx-note' }, el.compNote = h('span', {}, 'Reading…')) : h('div', { class: 'cx-items' }, list.slice(0, 400).map(item),
          list.length > 400 ? h('p', { class: 'cx-note' }, `${list.length - 400} more: type to filter`) : null));
    });
    el.side.replaceChildren(...[search,
      recent.length ? h('section', { class: 'cx-sec' }, h('div', { class: 'cx-sec-head static' }, '★ Recent'), h('div', { class: 'cx-items' }, recent.map(item))) : null,
      ...sections, el.sideRail].filter(Boolean));
    side.refresh();
  }
  const openDoc = (key, newTab) => open({ type: 'doc', key }, { newTab, preview: !newTab });

  // ---------- main: tabs, toolbar, code ----------
  // the look menu (top right of the editor): OG / Developer Console / VS Code, and sticky scroll
  function lookMenu() {
    const cur = LOOKS.find((l) => l.id === S.look);
    const sw = (l) => h('span', { class: `cx-look-sw${l.dark ? ' dark' : ''}`, 'aria-hidden': 'true' }, l.sw.map((c) => h('i', { style: `background:${c}` })));
    const btn = h('button', { class: 'cx-look-btn', 'aria-haspopup': 'menu', title: 'How the code looks', onclick: (e) => { e.stopPropagation(); toggle(); } },
      sw(cur), h('span', {}, cur.label), h('span', { class: 'cx-look-caret', 'aria-hidden': 'true' }, '▾'));
    let menu = null;
    const close = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
    const outside = (e) => { if (!menu?.contains(e.target) && !btn.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
    function toggle() {
      if (menu) { close(); return; }
      menu = h('div', { class: 'cx-look-menu', role: 'menu' },
        h('div', { class: 'cx-look-head' }, 'Code look'),
        LOOKS.map((l) => h('button', {
          class: `cx-look-item${l.id === S.look ? ' sel' : ''}`, role: 'menuitemradio', 'aria-checked': String(l.id === S.look),
          onclick: () => { close(); setLook(l.id); drawMain(); },
        }, sw(l), h('span', { class: 'cx-look-txt' }, h('b', {}, l.label), h('small', {}, l.hint)), l.id === S.look ? h('span', { class: 'cx-look-tick' }, '✓') : null)),
        h('label', { class: 'cx-look-opt' },
          h('input', { type: 'checkbox', checked: S.sticky, onchange: (e) => { S.sticky = e.target.checked; store.set('ff-cx-sticky', S.sticky); S.stick?.setEnabled(S.sticky); } }),
          h('span', {}, h('b', {}, 'Sticky scroll'), h('small', {}, 'Keep the class and method you’re in pinned at the top'))));
      document.body.append(menu);
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
      menu.querySelector('.cx-look-item.sel')?.focus();
    }
    return h('div', { class: 'cx-look' }, btn);
  }

  function drawMain() {
    const tabs = h('nav', { class: 'cx-tabs', role: 'tablist' }, S.tabs.map((t, i) => {
      const d = S.docs?.get(t.key);
      return h('div', {
        class: `cx-tab${i === S.cur ? ' active' : ''}${t.temp ? ' temp' : ''}`, role: 'tab', 'aria-selected': String(i === S.cur), title: t.temp ? `${d?.name} (passing through: double-click to keep)` : d?.name,
        onclick: () => { S.cur = i; S.line = t.line; save(); drawMain(); drawSide(); reveal(t.line); },
        ondblclick: () => { t.temp = false; save(); drawMain(); },
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(i); } },
      }, h('span', { class: `cx-ico k-${d?.kind}`, 'aria-hidden': 'true' }, DOC_KINDS[d?.kind]?.icon || '?'), h('span', { class: 'cx-tab-name' }, d?.name || t.key),
      h('button', { class: 'cx-tab-x', 'aria-label': 'Close', title: 'Close (middle-click)', onclick: (e) => { e.stopPropagation(); closeTab(i); } }, '×'));
    }));
    const t = S.tabs[S.cur];
    const d = t && S.docs?.get(t.key);
    if (!d) {
      el.main.replaceChildren(h('div', { class: 'cx-tabrow' }, tabs, lookMenu()), h('div', { class: 'cx-empty' },
        h('div', { class: 'cx-empty-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        h('b', { class: 'cx-empty-title' }, 'Open anything in your org’s code'),
        h('p', {}, 'Pick a class, trigger or component on the left, or press ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'P'), ' and type a name: ', h('code', {}, 'ddmhigh gen'), ' finds ddmHighlightsPanelController.generateOrderOnReplacement.'),
        h('p', {}, 'In the code, click a method call to jump to it, ', h('kbd', {}, 'Alt'), '+click to peek at it in place, ', h('kbd', {}, 'Alt'), '+', h('kbd', {}, '←'), ' to go back.')));
      drawOutline();
      return;
    }
    const file = d.files[t.file] || d.files[0];
    el.crumbs = h('div', { class: 'cx-crumbs' });
    el.methodTools = h('span', { class: 'cx-mtools' });
    const tool = (label, title, fn, disabled) => h('button', { class: 'ghost small', title, disabled: !!disabled, onclick: fn }, label);
    const type = d.file?.types.find((x) => !x.outer);
    el.goto = h('input', { type: 'text', class: 'cx-goto', placeholder: 'Line', hidden: true, 'aria-label': 'Go to line', onkeydown: (e) => {
      if (e.key === 'Enter') { const n = parseInt(e.target.value, 10); if (n) { S.line = n; reveal(n, true); } e.target.hidden = true; }
      if (e.key === 'Escape') e.target.hidden = true;
    } });
    const bar = h('div', { class: 'cx-bar' },
      h('button', { class: 'cx-nav', title: 'Back (Alt+←)', 'aria-label': 'Back', disabled: !S.back.length, onclick: () => history(-1) }, '←'),
      h('button', { class: 'cx-nav', title: 'Forward (Alt+→)', 'aria-label': 'Forward', disabled: !S.fwd.length, onclick: () => history(1) }, '→'),
      el.crumbs, h('span', { class: 'cx-grow' }),
      el.selCount = h('span', { class: 'cx-selcount', hidden: true, title: 'Places the selected text appears in this file' }),
      h('span', { class: 'cx-foldbtns' }, h('button', { class: 'ghost small', title: 'Fold all blocks', 'aria-label': 'Fold all', onclick: () => S.fold?.foldAll() }, '⊟'), h('button', { class: 'ghost small', title: 'Unfold everything', 'aria-label': 'Unfold all', onclick: () => S.fold?.unfoldAll() }, '⊞')),
      h('span', { class: 'cx-ro', title: 'OG Explorer is read-only for now' }, 'Read-only'),
      el.methodTools,
      tool(d.files.length > 1 ? '⧉ Copy file' : `⧉ Copy ${d.kind === 'trigger' ? 'trigger' : d.kind === 'class' ? 'class' : 'file'}`, 'Copy the whole file', () => copyText(file.text, `${file.name} copied`)),
      type && opts.isAsync?.(type) && opts.openExecutor ? tool('▶ Run…', 'Open in The OG Executor', () => opts.openExecutor(type.display)) : null,
      d.link ? h('a', { class: 'cx-setup', href: d.link, target: '_blank', rel: 'noopener' }, 'Setup ↗') : null);
    const fileTabs = d.files.length > 1 ? h('div', { class: 'cx-files' }, d.files.map((f, i) => h('button', {
      class: `cx-file${i === (t.file || 0) ? ' sel' : ''}`, onclick: () => { t.file = i; t.line = 1; S.line = 1; save(); drawMain(); },
    }, f.name))) : null;
    el.findBar = h('div', { class: 'cx-find', hidden: !S.find });
    el.code = h('div', { class: 'cx-code' }, renderFile(d, t.file || 0));
    el.main.replaceChildren(...[h('div', { class: 'cx-tabrow' }, tabs, lookMenu()), bar, fileTabs, el.goto, el.findBar, el.code].filter(Boolean));
    // VS Code's sticky scroll: the class / method / block you're in stays pinned at the top
    const pre = el.code.querySelector(':scope > .src');
    S.stick = stickyScroll(el.code, pre, S.regions, { onPick: (n) => { S.line = n; markLine(n); drawOutline(); refreshCrumbs(); } });
    wireLinks(S.stick.el, linksOfDoc(d)[d.file ? 0 : (t.file || 0)], handlers());
    S.stick.setEnabled(S.sticky);
    if (S.find) drawFind();
    drawCrumbs();
    drawOutline();
  }

  // the breadcrumb and the buttons for the method under the cursor (redrawn without the code)
  function drawCrumbs() {
    const t = S.tabs[S.cur];
    const d = t && S.docs?.get(t.key);
    if (!d || !el.crumbs) return;
    const file = d.files[t.file] || d.files[0];
    const m = currentMethod(d);
    el.crumbs.replaceChildren(...[
      h('span', { class: 'cx-crumb' }, d.name),
      d.files.length > 1 ? h('span', { class: 'cx-crumb-sep' }, '›') : null, d.files.length > 1 ? h('span', { class: 'cx-crumb' }, file.name) : null,
      m ? h('span', { class: 'cx-crumb-sep' }, '›') : null, m ? h('span', { class: 'cx-crumb method' }, m.kind === 'constructor' ? 'constructor' : m.name) : null,
    ].filter(Boolean));
    const tool = (label, title, fn) => h('button', { class: 'ghost small', title, onclick: fn }, label);
    el.methodTools.replaceChildren(...[
      m ? tool('⧉ Copy method', 'Copy this method’s code', () => copyText(file.text.split('\n').slice(m.startLine - 1, m.endLine).join('\n'), `${m.label} copied`)) : null,
      m && opts.openCodeFlow ? tool('⤳ Call tree', 'Who calls this method, in Code Flow', () => opts.openCodeFlow(m.id)) : null,
    ].filter(Boolean));
  }

  function renderFile(d, fi) {
    const file = d.files[fi] || d.files[0];
    const links = linksOfDoc(d)[d.file ? 0 : fi];
    let pre;
    if (d.file) {
      pre = apexRows(d.file, links, 1, Number.MAX_SAFE_INTEGER);
    } else {
      pre = h('pre', { class: 'src' });
      syntaxLines(file.text, file.lang, links).forEach((html, i) => {
        const txt = h('span', { class: 'txt' });
        txt.innerHTML = html;
        pre.append(h('div', { class: 'row', 'data-line': i + 1 }, h('span', { class: 'gutter' }, i + 1), txt));
      });
    }
    pre.classList.add(`lang-${file.lang}`);
    wireLinks(pre, links, handlers());
    // fold arrows in the gutter: methods, if / for / try blocks, classes; tags in markup
    S.regions = foldRegions(file.text, file.lang);
    S.fold = enableFolding(pre, S.regions);
    markIndent(pre);
    pre.addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (!row || e.target.closest('.tk-link') || row.closest('.cl-peek')) return;
      S.line = +row.dataset.line;
      markLine(S.line);
      drawOutline();
      refreshCrumbs();
    });
    return pre;
  }

  const refreshCrumbs = () => drawCrumbs();

  const currentMethod = (d) => {
    if (!d?.file || S.line == null) return null;
    let best = null;
    for (const m of d.file.methods) {
      if (!['method', 'constructor'].includes(m.kind)) continue;
      if (S.line >= m.startLine && S.line <= m.endLine && (!best || m.startLine >= best.startLine)) best = m;
    }
    return best;
  };

  function markLine(n) {
    for (const r of el.code?.querySelectorAll(':scope > .src > .row.cx-cur') || []) r.classList.remove('cx-cur');
    el.code?.querySelector(`:scope > .src > .row[data-line="${n}"]`)?.classList.add('cx-cur');
  }
  function reveal(n, flash) {
    if (!n || !el.code) return;
    S.fold?.reveal(n); // a jump into a folded block opens it
    requestAnimationFrame(() => {
      const row = el.code.querySelector(`:scope > .src > .row[data-line="${n}"]`);
      if (!row) return;
      row.scrollIntoView({ block: 'center' });
      markLine(n);
      if (flash) { row.classList.remove('cx-flash'); void row.offsetWidth; row.classList.add('cx-flash'); }
    });
  }

  // ---------- outline: methods, and who calls / is called by the current one ----------
  function drawOutline() {
    const t = S.tabs[S.cur];
    const d = t && S.docs?.get(t.key);
    if (!d) { el.outline.replaceChildren(h('p', { class: 'cx-note' }, 'Outline'), el.olRail); return; }
    const parts = [];
    if (d.file) {
      const m = currentMethod(d);
      const methods = d.file.methods.filter((x) => ['method', 'constructor', 'property'].includes(x.kind)).sort((a, b) => a.startLine - b.startLine);
      parts.push(h('div', { class: 'cx-ol-head' }, 'Outline', h('span', { class: 'cx-n' }, methods.length)),
        h('div', { class: 'cx-ol' }, methods.map((x) => h('button', {
          class: `cx-ol-item k-${x.kind}${m === x ? ' sel' : ''}`, title: signature(x),
          onclick: () => { S.line = x.startLine; reveal(x.startLine, true); drawOutline(); refreshCrumbs(); },
        }, h('span', { class: 'cx-ol-ico', 'aria-hidden': 'true' }, x.kind === 'property' ? 'p' : x.kind === 'constructor' ? 'c' : 'ƒ'), h('span', {}, x.kind === 'constructor' ? `new ${x.type.name}` : x.name), x.entry && x.entry.kind !== 'test' ? h('span', { class: 'cx-ol-entry' }, x.entry.label) : null))));
      if (m) {
        const callers = S.index.callers(m.id, { possible: false, tests: true });
        const callees = [...new Map((S.index.calleesOf.get(m.id) || []).filter((e) => e.kind !== 'guess' && e.kind !== 'async').map((e) => [e.to, e])).values()];
        const row = (id, sub) => {
          const x = S.index.methodsById.get(id);
          return h('button', { class: 'cx-ol-item', title: signature(x), onclick: (e) => open({ type: 'method', id }, { newTab: e.ctrlKey || e.metaKey }) },
            h('span', { class: 'cx-ol-ico', 'aria-hidden': 'true' }, '↳'), h('span', {}, x.label), sub ? h('span', { class: 'cx-ol-sub' }, sub) : null);
        };
        parts.push(h('div', { class: 'cx-ol-head' }, 'Called by', h('span', { class: 'cx-n' }, callers.length)),
          h('div', { class: 'cx-ol' }, callers.length ? callers.slice(0, 60).map((c) => row(c.from, `line ${c.lines[0]}`)) : h('p', { class: 'cx-note' }, 'Nothing in Apex calls it.')),
          h('div', { class: 'cx-ol-head' }, 'Calls', h('span', { class: 'cx-n' }, callees.length)),
          h('div', { class: 'cx-ol' }, callees.length ? callees.slice(0, 60).map((e) => row(e.to, `line ${e.line}`)) : h('p', { class: 'cx-note' }, 'No calls to your Apex.')));
      } else {
        parts.push(h('p', { class: 'cx-note' }, 'Click inside a method to see who calls it and what it calls.'));
      }
    } else {
      const links = linksOfDoc(d).flatMap((l) => l.list);
      const apex = [...new Map(links.flatMap((l) => l.targets).filter((x) => x.type === 'method').map((x) => [x.id, x])).values()];
      parts.push(h('div', { class: 'cx-ol-head' }, 'Files', h('span', { class: 'cx-n' }, d.files.length)),
        h('div', { class: 'cx-ol' }, d.files.map((f, i) => h('button', { class: `cx-ol-item${i === (t.file || 0) ? ' sel' : ''}`, onclick: () => { t.file = i; S.line = 1; save(); drawMain(); } }, h('span', { class: 'cx-ol-ico', 'aria-hidden': 'true' }, '▤'), h('span', {}, f.name)))),
        h('div', { class: 'cx-ol-head' }, 'Apex it calls', h('span', { class: 'cx-n' }, apex.length)),
        h('div', { class: 'cx-ol' }, apex.length ? apex.map((x) => {
          const mm = S.index.methodsById.get(x.id);
          return h('button', { class: 'cx-ol-item', title: signature(mm), onclick: (e) => open(x, { newTab: e.ctrlKey || e.metaKey }) }, h('span', { class: 'cx-ol-ico', 'aria-hidden': 'true' }, '↳'), h('span', {}, mm.label));
        }) : h('p', { class: 'cx-note' }, 'No Apex calls found.')));
    }
    el.outline.replaceChildren(...parts, el.olRail);
  }

  // ---------- find in file (Ctrl+F) ----------
  function drawFind() {
    S.find ||= { q: '', i: 0 };
    const input = h('input', { type: 'search', value: S.find.q, placeholder: 'Find in this file', 'aria-label': 'Find in this file', oninput: (e) => { S.find.q = e.target.value; S.find.i = 0; runFind(); }, onkeydown: (e) => {
      if (e.key === 'Enter') { S.find.i += e.shiftKey ? -1 : 1; runFind(); }
      if (e.key === 'Escape') { S.find = null; el.findBar.hidden = true; runFind(); }
    } });
    el.findCount = h('span', { class: 'cx-find-n' });
    el.findBar.hidden = false;
    el.findBar.replaceChildren(input, el.findCount, h('button', { class: 'ghost small', onclick: () => { S.find = null; el.findBar.hidden = true; runFind(); } }, '×'));
    setTimeout(() => input.focus());
    runFind();
  }
  function runFind() {
    const rows = [...(el.code?.querySelectorAll(':scope > .src > .row') || [])];
    for (const r of rows) r.classList.remove('cx-hit', 'cx-hit-cur');
    if (!S.find?.q) { if (el.findCount) el.findCount.textContent = ''; return; }
    const q = S.find.q.toLowerCase();
    const hits = rows.filter((r) => r.querySelector('.txt')?.textContent.toLowerCase().includes(q));
    for (const r of hits) r.classList.add('cx-hit');
    el.findCount.textContent = hits.length ? `${((S.find.i % hits.length) + hits.length) % hits.length + 1} / ${hits.length}` : 'No matches';
    const cur = hits[((S.find.i % hits.length) + hits.length) % hits.length];
    if (cur) { cur.classList.add('cx-hit-cur'); cur.scrollIntoView({ block: 'center' }); }
  }

  // ---------- go to anything (Ctrl+P) ----------
  function palette() {
    if (!S.docs || document.querySelector('.cx-pal')) return;
    const items = [];
    for (const d of S.docs.docs.values()) items.push({ label: d.name, sub: DOC_KINDS[d.kind].label.replace(/s$/, ''), kind: d.kind, go: (nt) => openDoc(d.key, nt) });
    for (const m of S.index.methods) {
      if (!['method', 'constructor'].includes(m.kind) || m.type.kind === 'trigger') continue;
      items.push({ label: `${m.type.display}.${m.kind === 'constructor' ? m.type.name : m.name}`, sub: signature(m), kind: 'method', go: (nt) => open({ type: 'method', id: m.id }, { newTab: nt, preview: !nt }) });
    }
    let sel = 0;
    let shown = [];
    const list = h('ul', { class: 'cx-pal-list', role: 'listbox' });
    const input = h('input', { type: 'text', class: 'cx-pal-in', placeholder: 'Class, trigger, component or Class.method… (words in any order)', spellcheck: 'false', 'aria-label': 'Go to anything' });
    const score = (label, words) => {
      const l = label.toLowerCase();
      let s = 0;
      for (const w of words) {
        const i = l.indexOf(w);
        if (i < 0) return -1;
        s += i === 0 ? 0 : l[i - 1] === '.' || l[i - 1] === '_' ? 1 : 3;
      }
      return s + l.length / 200;
    };
    const draw = () => {
      const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = (words.length ? items.map((it) => [score(it.label, words), it]).filter(([s]) => s >= 0).sort((a, b) => a[0] - b[0]).map(([, it]) => it)
        : S.recent.map((k) => S.docs.get(k)).filter(Boolean).map((d) => items.find((it) => it.label === d.name && it.kind === d.kind)).filter(Boolean)).slice(0, 60);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((it, i) => h('li', {
        class: `cx-pal-item${i === sel ? ' sel' : ''}`, role: 'option', onmousedown: (e) => { e.preventDefault(); close(); it.go(e.ctrlKey || e.metaKey); },
      }, h('span', { class: `cx-ico k-${it.kind}`, 'aria-hidden': 'true' }, it.kind === 'method' ? 'ƒ' : DOC_KINDS[it.kind].icon), h('span', { class: 'cx-pal-label' }, it.label), h('span', { class: 'cx-pal-sub' }, it.sub)))
        : [h('li', { class: 'cx-note' }, words.length ? 'Nothing matches.' : 'Type a name.')]));
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const wrap = h('div', { class: 'cx-pal', role: 'dialog', 'aria-label': 'Go to anything' }, h('div', { class: 'cx-pal-card' }, input, list));
    const close = () => wrap.remove();
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); draw(); }
      if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); close(); shown[sel].go(e.ctrlKey || e.metaKey); }
      if (e.key === 'Escape') close();
    });
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
    document.body.append(wrap);
    draw();
    input.focus();
  }

  // ---------- keys ----------
  document.addEventListener('keydown', (e) => {
    if (!S.active || root.closest('[hidden]')) return;
    const typing = e.target.closest?.('input, textarea, select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); palette(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.tabs[S.cur]) { e.preventDefault(); drawFind(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g' && S.tabs[S.cur] && el.goto) { e.preventDefault(); el.goto.hidden = false; el.goto.value = ''; el.goto.focus(); return; }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) { e.preventDefault(); history(e.key === 'ArrowLeft' ? -1 : 1); }
  });
  // mouse back / forward buttons
  root.addEventListener('mouseup', (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); history(e.button === 3 ? -1 : 1); } });

  return {
    setActive(on) { S.active = on; },
    open,
  };
}
