// The code viewer shared by OG Explorer and FBI Search: the code look (OG / Developer Console / VS Code) and
// sticky-scroll preferences, the look menu, and building a code block with colours, links, folding and indent
// guides. Custom-label hovers come for free (src/explorer/labels.js listens on the whole page).

import { h } from '../dom.js';
import { apexRows, wireLinks } from './code-links.js';
import { syntaxLines } from './syntax.js';
import { foldRegions, enableFolding, markIndent, stickyScroll } from './code-tools.js';

// how the code looks: our own, Salesforce's Developer Console, or VS Code (dark). Only the code area changes.
export const LOOKS = [
  { id: 'og', label: 'OG', hint: 'This app’s own look', sw: ['#a626a4', '#50a14f', '#2563eb'] },
  { id: 'dc', label: 'Developer Console', hint: 'Like the Salesforce Developer Console', sw: ['#7f0f9e', '#c41a16', '#1a3fc7'] },
  { id: 'vsc', label: 'VS Code', hint: 'Like VS Code’s dark theme', sw: ['#c586c0', '#dcdcaa', '#4ec9b0'], dark: true },
];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

// one preference for every code view; a change is announced so every open view follows it
export const codePrefs = {
  get look() { const v = store.get('ff-cx-look', 'og'); return LOOKS.some((l) => l.id === v) ? v : 'og'; },
  get sticky() { return store.get('ff-cx-sticky', true) !== false; },
  set(change) {
    if (change.look) store.set('ff-cx-look', change.look);
    if (change.sticky != null) store.set('ff-cx-sticky', !!change.sticky);
    document.dispatchEvent(new CustomEvent('og-codelook', { detail: { look: this.look, sticky: this.sticky } }));
  },
};

/** Puts the current look's class on `host` (look-og / look-dc / look-vsc). */
export function applyLook(host, look = codePrefs.look) {
  for (const l of LOOKS) host.classList.toggle(`look-${l.id}`, l.id === look);
}

/** The look menu button: pick a look, switch sticky scroll on / off. */
export function lookMenu() {
  const cur = LOOKS.find((l) => l.id === codePrefs.look);
  const sw = (l) => h('span', { class: `cx-look-sw${l.dark ? ' dark' : ''}`, 'aria-hidden': 'true' }, l.sw.map((c) => h('i', { style: `background:${c}` })));
  const btn = h('button', { type: 'button', class: 'cx-look-btn', 'aria-haspopup': 'menu', title: 'How the code looks', onclick: (e) => { e.stopPropagation(); toggle(); } },
    sw(cur), h('span', {}, cur.label), h('span', { class: 'cx-look-caret', 'aria-hidden': 'true' }, '▾'));
  let menu = null;
  const close = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (!menu?.contains(e.target) && !btn.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } };
  function toggle() {
    if (menu) { close(); return; }
    const look = codePrefs.look;
    menu = h('div', { class: 'cx-look-menu', role: 'menu' },
      h('div', { class: 'cx-look-head' }, 'Code look'),
      LOOKS.map((l) => h('button', {
        class: `cx-look-item${l.id === look ? ' sel' : ''}`, role: 'menuitemradio', 'aria-checked': String(l.id === look),
        onclick: () => { close(); codePrefs.set({ look: l.id }); },
      }, sw(l), h('span', { class: 'cx-look-txt' }, h('b', {}, l.label), h('small', {}, l.hint)), l.id === look ? h('span', { class: 'cx-look-tick' }, '✓') : null)),
      h('label', { class: 'cx-look-opt' },
        h('input', { type: 'checkbox', checked: codePrefs.sticky, onchange: (e) => codePrefs.set({ sticky: e.target.checked }) }),
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

/**
 * A code block: <pre class="src"> with colours, clickable names, fold arrows and indent guides.
 * file: a parsed Apex file (or null for js / css / markup text); links / handlers as in code-links.js.
 * Returns { pre, regions, fold }.
 */
export function buildCode({ text, lang, file, links, handlers }) {
  let pre;
  if (file) pre = apexRows(file, links, 1, Number.MAX_SAFE_INTEGER);
  else {
    pre = h('pre', { class: 'src' });
    syntaxLines(text, lang, links).forEach((html, i) => {
      const txt = h('span', { class: 'txt' });
      txt.innerHTML = html;
      pre.append(h('div', { class: 'row', 'data-line': i + 1 }, h('span', { class: 'gutter' }, i + 1), txt));
    });
  }
  pre.classList.add(`lang-${lang}`);
  if (links && handlers) wireLinks(pre, links, handlers);
  const regions = foldRegions(text, lang);
  const fold = enableFolding(pre, regions);
  markIndent(pre);
  return { pre, regions, fold };
}

/** Sticky scroll for a code block built by buildCode, inside its scroller. */
export function attachSticky(scroller, built, { links, handlers, onPick } = {}) {
  const stick = stickyScroll(scroller, built.pre, built.regions, { onPick });
  if (links && handlers) wireLinks(stick.el, links, handlers);
  stick.setEnabled(codePrefs.sticky);
  return stick;
}
