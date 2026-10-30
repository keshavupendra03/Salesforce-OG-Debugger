// OG Code Compare: Apex, triggers, Visualforce, LWC and Aura between two orgs this browser is logged into
// (typically one family: production, UAT, preprod…). Lists come first (Apex differences straight from Salesforce's
// checksums), VF / LWC / Aura are checked in the background, and opening an item shows a full diff: side by side
// or inline, moved sections, changed words, methods, both orgs' custom label values on hover.

import { h } from '../dom.js';
import { resizable, collapsibleSide } from '../layout.js';
import { OrgRegistry, DemoOrgRegistry, parseOrgHost, KIND_LABEL, shortName, groupFamilies } from '../informant/orgs.js';
import { OrgCode, DemoOrgCode, demoVariant, KINDS } from './compare-sources.js';
import { lineKeys, diffLines, alignRows, findMoves, wordDiff, unifiedDiff, methodSummary, fingerprint } from './diff.js';
import { highlight } from '../apex/highlight.js';
import { syntaxLines } from '../explorer/syntax.js';
import { parseUnit } from '../apex/parser.js';
import { rangeAt } from '../explorer/code-tools.js';
import { lookMenu, applyLook } from '../explorer/code-view.js';
import { registerOrgLabels } from '../explorer/labels.js';
import { DOC_KINDS } from '../explorer/doc-store.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const KIND_NAME = { class: 'Apex class', trigger: 'Apex trigger', vfpage: 'Visualforce page', vfcomp: 'Visualforce component', lwc: 'Lightning web component', aura: 'Aura component' };
const KIND_TAB = { all: 'All', class: 'Classes', trigger: 'Triggers', vfpage: 'VF pages', vfcomp: 'VF components', lwc: 'LWC', aura: 'Aura' };
const STATUS = {
  diff: { label: 'Changed', pill: '≠ changed' },
  onlyA: { label: 'Only in A', pill: 'A only' },
  onlyB: { label: 'Only in B', pill: 'B only' },
  same: { label: 'Same', pill: '= same' },
  unknown: { label: 'Not checked yet', pill: '…' },
};
const CTX = 3; // unchanged lines kept around a change when "Only changes" is on
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2200);
}

async function copyText(btn, text, done = 'Copied') {
  btn.lastCopied = text; // (tests read it back)
  const was = btn.innerHTML;
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  btn.classList.add('copied');
  btn.textContent = `✓ ${done}`;
  setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = was; }, 1400);
}

/** opts: { demo, currentHost, openInExplorer(target) } */
export function mountCompare(root, opts = {}) {
  const S = {
    reg: opts.demo ? new DemoOrgRegistry() : new OrgRegistry({ currentHost: opts.currentHost }),
    aHost: null, bHost: null, sources: new Map(),
    kind: store.get('ff-cc-kind', 'all'), q: '',
    show: new Set(store.get('ff-cc-show', ['diff', 'onlyA', 'onlyB', 'unknown'])),
    items: [], errs: {}, loading: false, checking: null, run: null,
    sel: null, fileName: null, open: null,
    o: { view: 'split', ignoreWhitespace: true, ignoreCase: false, ignoreComments: false, wrap: true, changesOnly: false, ...store.get('ff-cc-opts', {}) },
    active: false,
    focus: store.get('ff-cc-focus', false), // details (header, org cards, methods) hidden: more room for the diff
  };
  const current = () => opts.currentHost || S.reg.currentHost || null;
  const el = {};

  root.replaceChildren(
    el.top = h('header', { class: 'cc-top' }),
    el.side = h('aside', { class: 'cc-side' }),
    el.main = h('section', { class: 'cc-main' }),
    resizable({ handle: h('div', { class: 'cc-split' }), pane: el.side, host: root, cssVar: '--cc-side', edge: 'end', min: 240, max: () => root.clientWidth * 0.45, key: 'ff-split-cc', label: 'Resize the list' }));
  // the list folds into a slim rail (its edge button, or Ctrl+B) for a wider diff
  const sideFold = collapsibleSide({
    host: root, pane: el.side, key: 'ff-side-cc', label: 'the list',
    rail: () => {
      const n = S.items.filter((it) => it.status === 'diff' || it.status === 'onlyA' || it.status === 'onlyB').length;
      return [n ? h('span', { class: 'side-rail-badge', title: `${n} differences` }, n > 99 ? '99+' : n) : null,
        h('span', { class: 'side-rail-chip' }, 'Compare'),
        h('span', { class: `side-rail-label${S.open ? '' : ' muted'}` }, S.open?.it.name || 'Nothing open')];
    },
  });
  el.sideRail = el.side.querySelector('.side-rail');

  // ---------- orgs ----------
  const org = (host) => S.reg.byHost(host);
  const usable = (o) => o && o.status === 'valid' && (opts.demo || S.reg.token(o.apiHost));
  const orgName = (host) => { const o = org(host); return o ? shortName(o) : host || '—'; };
  function src(host) {
    if (!host) return null;
    if (!S.sources.has(host)) {
      const o = org(host);
      if (!usable(o)) return null;
      const s = opts.demo ? new DemoOrgCode(o, demoVariant(host)) : new OrgCode(o, S.reg.token(host));
      S.sources.set(host, s);
      registerOrgLabels(host, `${shortName(o)} · ${parseOrgHost(host)?.family || host}`, () => s.labels());
    }
    return S.sources.get(host);
  }

  function pickDefaults() {
    const saved = store.get('ff-cc-orgs', {});
    const ok = (h) => usable(org(h));
    const cur = current();
    let a = ok(saved.a) ? saved.a : ok(cur) ? cur : S.reg.orgs.find(usable)?.apiHost || null;
    const fam = parseOrgHost(a)?.family;
    const same = S.reg.orgs.filter((o) => usable(o) && o.apiHost !== a && parseOrgHost(o.apiHost)?.family === fam);
    const aIsSandbox = parseOrgHost(a)?.kind !== 'production';
    let b = ok(saved.b) && saved.b !== a ? saved.b
      : (aIsSandbox ? same.find((o) => parseOrgHost(o.apiHost)?.kind === 'production') : null)?.apiHost || same[0]?.apiHost || null;
    S.aHost = a;
    S.bHost = b;
  }

  function orgPicker(side) {
    const host = side === 'a' ? S.aHost : S.bHost;
    const other = side === 'a' ? S.bHost : S.aHost;
    const o = org(host);
    const p = parseOrgHost(host);
    const btn = h('button', { type: 'button', class: `cc-org-btn side-${side}${o ? '' : ' empty'}`, 'aria-haspopup': 'listbox', onclick: (e) => { e.stopPropagation(); openMenu(btn, side, other); } },
      h('span', { class: `cc-side-badge side-${side}` }, side.toUpperCase()),
      o ? h('span', { class: 'cc-org-txt', title: `${host}${o.user?.name ? `\n${o.user.name}` : ''}` },
        h('span', { class: 'cc-org-line' }, h('b', {}, shortName(o)), h('span', { class: `cc-kind k-${p?.kind || 'other'}` }, KIND_LABEL[p?.kind] || 'Org'), host === current() ? h('span', { class: 'cc-this' }, 'this tab') : null,
          h('small', {}, p?.family || '')))
        : h('span', { class: 'cc-org-txt' }, h('span', { class: 'cc-org-line' }, h('b', {}, 'Pick an org'), h('small', {}, 'any org you’re logged into'))),
      h('span', { class: 'cc-caret', 'aria-hidden': 'true' }, '▾'));
    return btn;
  }

  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; document.removeEventListener('mousedown', outside, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  function openMenu(btn, side, other) {
    if (menu) { closeMenu(); return; }
    const fams = groupFamilies(S.reg.orgs, current());
    const row = (o) => {
      const p = parseOrgHost(o.apiHost);
      const ok = usable(o);
      const taken = o.apiHost === other;
      const st = o.status === 'valid' ? 'ok' : o.status === 'expired' ? 'expired' : o.status === 'signedout' ? 'out' : 'err';
      return h('div', { class: `cc-om-row${ok && !taken ? '' : ' off'}${o.apiHost === (side === 'a' ? S.aHost : S.bHost) ? ' sel' : ''}` },
        h('button', {
          type: 'button', class: 'cc-om-pick', disabled: !ok || taken,
          title: taken ? 'Already on the other side' : ok ? `Compare with ${o.apiHost}` : 'Log in to this org in this browser first',
          onclick: () => { closeMenu(); setOrg(side, o.apiHost); },
        },
        h('span', { class: `cc-dot ${st}`, 'aria-hidden': 'true' }),
        h('span', { class: 'cc-om-main' },
          h('span', { class: 'cc-org-line' }, h('b', {}, shortName(o)), h('span', { class: `cc-kind k-${p?.kind || 'other'}` }, KIND_LABEL[p?.kind] || 'Org'),
            o.apiHost === current() ? h('span', { class: 'cc-this' }, 'this tab') : null, taken ? h('span', { class: 'cc-taken' }, `on side ${side === 'a' ? 'B' : 'A'}`) : null),
          h('small', {}, o.apiHost))),
        !ok ? h('a', { class: 'cc-om-login', href: `https://${o.apiHost}/`, target: '_blank', rel: 'noopener', title: 'Log in, then come back and press Refresh' },
          o.status === 'expired' ? 'Session expired · Log in ↗' : 'Log in ↗') : null);
    };
    menu = h('div', { class: 'cc-om', role: 'listbox' },
      h('div', { class: 'cc-om-head' }, `Org for side ${side.toUpperCase()}`),
      h('div', { class: 'cc-om-list' }, fams.length ? fams.map((f, i) => h('div', { class: 'cc-om-fam' },
        h('div', { class: 'cc-om-famname' }, f.family, i === 0 && parseOrgHost(current())?.family === f.family ? h('span', {}, 'this tab’s family') : null),
        f.orgs.map(row))) : h('p', { class: 'cc-om-none' }, 'No orgs found. Log in to Salesforce in this browser.')),
      h('div', { class: 'cc-om-foot' },
        h('span', {}, 'Don’t see one? Log in to it in this browser (any tab), then refresh.'),
        h('button', { type: 'button', class: 'ghost small', onclick: async (e) => { e.currentTarget.textContent = 'Refreshing…'; await S.reg.refreshAll(); closeMenu(); drawTop(); openMenu(btn, side, other); } }, '↻ Refresh')));
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
    document.addEventListener('mousedown', outside, true);
  }

  function setOrg(side, host) {
    if (side === 'a') S.aHost = host; else S.bHost = host;
    store.set('ff-cc-orgs', { a: S.aHost, b: S.bHost });
    S.sel = null;
    drawTop();
    compareAll();
  }

  function swap() {
    [S.aHost, S.bHost] = [S.bHost, S.aHost];
    store.set('ff-cc-orgs', { a: S.aHost, b: S.bHost });
    drawTop();
    compareAll(true);
  }

  function drawTop() {
    const a = src(S.aHost);
    const b = src(S.bHost);
    el.top.replaceChildren(
      h('div', { class: 'cc-title', title: 'Apex, triggers, Visualforce, LWC and Aura between two orgs' }, h('b', {}, 'OG Code Compare')),
      h('div', { class: 'cc-orgs' },
        orgPicker('a'),
        h('button', { type: 'button', class: 'cc-swap', title: 'Swap A and B', 'aria-label': 'Swap A and B', disabled: !S.aHost || !S.bHost, onclick: swap }, '⇄'),
        orgPicker('b'),
        h('button', { type: 'button', class: 'ghost small cc-reload', title: 'Read both orgs again (after a deployment)', disabled: !a || !b, onclick: () => { a?.reset(); b?.reset(); compareAll(); } }, '↻ Reload')));
  }

  // ---------- comparing the lists ----------
  function statusOf(it) {
    if (!it.a) return 'onlyB';
    if (!it.b) return 'onlyA';
    if (it.fpA && it.fpB) return it.fpA === it.fpB ? 'same' : 'diff';
    if (it.kind === 'class' || it.kind === 'trigger') {
      if (it.a.crc != null && it.b.crc != null) return it.a.crc === it.b.crc && it.a.size === it.b.size ? 'same' : 'diff';
    }
    return 'unknown';
  }

  async function compareAll(keepSel) {
    const A = src(S.aHost);
    const B = src(S.bHost);
    const run = (S.run = {});
    S.items = [];
    S.errs = {};
    if (!keepSel) S.sel = null;
    if (!A || !B) { S.loading = false; drawSide(); drawMain(); return; }
    S.loading = true;
    drawSide();
    drawMain();
    const lists = {};
    for (const kind of KINDS) {
      const [la, lb] = await Promise.all([A.list(kind).catch((e) => ({ err: e })), B.list(kind).catch((e) => ({ err: e }))]);
      if (run !== S.run) return;
      if (la.err || lb.err) S.errs[kind] = (la.err || lb.err).message;
      const byKey = new Map();
      for (const x of Array.isArray(la) ? la : []) byKey.set(x.key, { kind, key: `${kind}:${x.key}`, name: x.name, a: x, b: null });
      for (const x of Array.isArray(lb) ? lb : []) { const it = byKey.get(x.key); if (it) it.b = x; else byKey.set(x.key, { kind, key: `${kind}:${x.key}`, name: x.name, a: null, b: x }); }
      for (const it of byKey.values()) { it.status = statusOf(it); S.items.push(it); }
      lists[kind] = { la: Array.isArray(la) ? la : [], lb: Array.isArray(lb) ? lb : [] };
      drawSide();
    }
    S.loading = false;
    drawSide();
    if (keepSel && S.sel) { const it = S.items.find((x) => x.key === S.sel); if (it) openItem(it); else { S.sel = null; drawMain(); } } else drawMain();
    // VF, LWC and Aura have no checksum (nor Apex, where an org doesn't give one): read their code in the
    // background to see what differs
    for (const kind of KINDS) {
      const { la = [], lb = [] } = lists[kind] || {};
      const both = S.items.filter((it) => it.kind === kind && it.a && it.b);
      const apex = kind === 'class' || kind === 'trigger';
      if (!both.length || (apex && both.every((it) => it.a.crc != null && it.b.crc != null))) continue;
      S.checking = { kind, f: 0 };
      drawSide();
      try {
        const [fa, fb] = await Promise.all([
          A.fingerprints(kind, la.filter((x) => both.some((it) => it.a === x)), (f) => { if (S.checking) { S.checking.f = f / 2; drawProgress(); } }, { bodies: apex }),
          B.fingerprints(kind, lb.filter((x) => both.some((it) => it.b === x)), (f) => { if (S.checking) { S.checking.f = 0.5 + f / 2; drawProgress(); } }, { bodies: apex }),
        ]);
        if (run !== S.run) return;
        for (const it of both) { it.fpA = fa.get(it.a.key) || null; it.fpB = fb.get(it.b.key) || null; it.status = statusOf(it); }
      } catch (e) { S.errs[kind] = e.message; }
      S.checking = null;
      drawSide();
    }
  }

  // ---------- the list ----------
  const visible = () => {
    const q = S.q.trim().toLowerCase();
    return S.items.filter((it) => (S.kind === 'all' || it.kind === S.kind) && (!q || it.name.toLowerCase().includes(q)));
  };

  function drawProgress() {
    const p = el.side.querySelector('.cc-progress');
    if (!p) return;
    p.replaceChildren(...progressBits());
  }
  function progressBits() {
    if (S.loading) return [h('span', { class: 'lg-spinner' }), `Reading ${orgName(S.aHost)} and ${orgName(S.bHost)}…`];
    if (S.checking) return [h('span', { class: 'lg-spinner' }), `Checking ${KIND_TAB[S.checking.kind]}… ${Math.round(S.checking.f * 100)}%`, h('span', { class: 'cc-bar' }, h('i', { style: `width:${Math.round(S.checking.f * 100)}%` }))];
    return [];
  }

  function drawSide() {
    if (!S.aHost || !S.bHost || !src(S.aHost) || !src(S.bHost)) {
      el.side.replaceChildren(h('div', { class: 'cc-side-empty' }, h('b', {}, 'Pick two orgs'), h('p', {}, 'Choose A and B at the top: two orgs you’re logged into in this browser, like production and your UAT sandbox.')), el.sideRail);
      sideFold.refresh();
      return;
    }
    const all = visible();
    const pool = S.items.filter((it) => S.kind === 'all' || it.kind === S.kind);
    const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, all.filter((it) => it.status === k).length]));
    const search = h('input', {
      type: 'search', class: 'cc-search', placeholder: `Filter ${pool.length} by name…`, value: S.q, spellcheck: 'false', 'aria-label': 'Filter by name',
      oninput: (e) => { S.q = e.target.value; const p = e.target.selectionStart; drawSide(); const s = el.side.querySelector('.cc-search'); s.focus(); s.setSelectionRange(p, p); },
    });
    const kinds = h('div', { class: 'cc-kinds', role: 'tablist' }, ['all', ...KINDS].map((k) => {
      const n = S.items.filter((it) => (k === 'all' || it.kind === k) && it.status !== 'same' && it.status !== 'unknown').length;
      const has = k === 'all' || S.items.some((it) => it.kind === k);
      if (!has && !S.loading) return null;
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(S.kind === k), class: 'cc-kind-tab', onclick: () => { S.kind = k; store.set('ff-cc-kind', k); drawSide(); } },
        KIND_TAB[k], n ? h('span', { class: 'cc-n diff' }, n) : null);
    }));
    const chips = h('div', { class: 'cc-chips' }, Object.entries(STATUS).map(([k, s]) => (counts[k] || k !== 'unknown' ? h('button', {
      type: 'button', class: `cc-chip st-${k}`, 'aria-pressed': String(S.show.has(k)),
      onclick: () => { if (S.show.has(k)) S.show.delete(k); else S.show.add(k); store.set('ff-cc-show', [...S.show]); drawSide(); },
    }, s.label, h('span', { class: 'cc-n' }, counts[k])) : null)));
    const shown = all.filter((it) => S.show.has(it.status));
    const order = { diff: 0, onlyA: 1, onlyB: 2, unknown: 3, same: 4 };
    shown.sort((x, y) => KINDS.indexOf(x.kind) - KINDS.indexOf(y.kind) || order[x.status] - order[y.status] || x.name.localeCompare(y.name));
    const list = h('div', { class: 'cc-list', role: 'listbox', 'aria-label': 'What differs' });
    let lastKind = null;
    for (const it of shown.slice(0, 800)) {
      if (S.kind === 'all' && it.kind !== lastKind) { lastKind = it.kind; list.append(h('div', { class: 'cc-group' }, DOC_KINDS[it.kind].label)); }
      list.append(h('button', {
        type: 'button', class: `cc-item st-${it.status}${S.sel === it.key ? ' sel' : ''}`, role: 'option', 'aria-selected': String(S.sel === it.key), 'data-key': it.key,
        title: `${KIND_NAME[it.kind]} · ${STATUS[it.status].label}`, onclick: () => openItem(it),
      }, h('span', { class: `cx-ico k-${it.kind}`, 'aria-hidden': 'true' }, DOC_KINDS[it.kind].icon), h('span', { class: 'cc-item-name' }, it.name),
      h('span', { class: `cc-pill st-${it.status}` }, STATUS[it.status].pill)));
    }
    if (shown.length > 800) list.append(h('p', { class: 'cc-note' }, `${shown.length - 800} more: type to filter`));
    const errs = Object.entries(S.errs);
    el.side.replaceChildren(...[
      kinds, search, chips,
      h('div', { class: 'cc-progress', 'aria-live': 'polite' }, ...progressBits()),
      errs.length ? h('div', { class: 'cc-errs' }, errs.map(([k, m]) => h('p', {}, h('b', {}, `${KIND_TAB[k]}: `), m))) : null,
      !shown.length && !S.loading ? h('div', { class: 'cc-side-empty small' },
        h('b', {}, S.items.length ? (counts.diff + counts.onlyA + counts.onlyB ? 'Nothing matches these filters' : 'No differences 🎉') : 'Nothing to compare'),
        h('p', {}, S.items.length ? (S.show.has('same') ? 'Try another name.' : `${counts.same} identical item${counts.same === 1 ? '' : 's'} hidden: turn on “Same” to see them.`) : 'Neither org has unmanaged code of this kind.')) : null,
      list, el.sideRail].filter(Boolean));
    sideFold.refresh();
  }

  // ---------- one item: the diff ----------
  async function openItem(it) {
    S.sel = it.key;
    for (const b of el.side.querySelectorAll('.cc-item')) { const on = b.dataset.key === it.key; b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on)); }
    const run = (S.openRun = {});
    el.main.replaceChildren(h('div', { class: 'cx-loading' }, h('span', { class: 'lg-spinner' }), `Reading ${it.name} from both orgs…`));
    const A = src(S.aHost);
    const B = src(S.bHost);
    let fa;
    let fb;
    try {
      [fa, fb] = await Promise.all([it.a ? A.files(it.kind, it.a) : [], it.b ? B.files(it.kind, it.b) : []]);
    } catch (e) {
      if (run === S.openRun) el.main.replaceChildren(h('p', { class: 'cc-note err' }, `Couldn’t read ${it.name}: ${e.message}`));
      return;
    }
    if (run !== S.openRun) return;
    // the real answer now that the code is here (a checksum can differ for line endings alone)
    it.fpA = it.a ? fingerprint(fa.map((f) => `${f.name}\n${f.text}`).join('\n\u0000\n')) : null;
    it.fpB = it.b ? fingerprint(fb.map((f) => `${f.name}\n${f.text}`).join('\n\u0000\n')) : null;
    const was = it.status;
    it.status = statusOf(it);
    if (was !== it.status) drawSide();
    const names = [...new Set([...fa.map((f) => f.name), ...fb.map((f) => f.name)])];
    if (!names.includes(S.fileName)) S.fileName = names[0] || null;
    S.open = { it, fa, fb, names };
    drawMain();
  }

  function drawMain() {
    if (!S.sel || !S.open || S.open.it.key !== S.sel) { el.main.replaceChildren(emptyMain()); return; }
    const { it, fa, fb, names } = S.open;
    const fileA = fa.find((f) => f.name === S.fileName) || null;
    const fileB = fb.find((f) => f.name === S.fileName) || null;
    const file = fileA || fileB;
    const lang = file?.lang || 'apex';
    const aText = fileA?.text ?? '';
    const bText = fileB?.text ?? '';
    const D = computeDiff(aText, bText, lang, it, !!fileA, !!fileB);
    S.diff = D;
    const fileTabs = names.length > 1 ? h('div', { class: 'cc-files' }, names.map((n) => {
      const x = fa.find((f) => f.name === n);
      const y = fb.find((f) => f.name === n);
      const st = !x ? 'onlyB' : !y ? 'onlyA' : fingerprint(x.text) === fingerprint(y.text) ? 'same' : 'diff';
      return h('button', { type: 'button', class: `cc-file st-${st}${n === S.fileName ? ' sel' : ''}`, title: STATUS[st].label, onclick: () => { S.fileName = n; drawMain(); } },
        h('span', { class: `cc-dot st-${st}`, 'aria-hidden': 'true' }), n);
    })) : null;
    const host = h('div', { class: 'cc-diffhost' });
    applyLook(host);
    const details = S.focus ? [] : [header(it), sideCards(it, fileA, fileB, D), methodsStrip(D)];
    el.main.replaceChildren(...[...details, fileTabs, toolbar(D, it), banner(it, D, fileA, fileB), host].filter(Boolean));
    sideFold.refresh();
    renderDiff(host, D, lang);
  }

  function emptyMain() {
    const ready = src(S.aHost) && src(S.bHost);
    return h('div', { class: 'cc-empty' },
      h('div', { class: 'cc-empty-art', 'aria-hidden': 'true' }, h('span', { class: 'a' }), h('i', {}, '⇄'), h('span', { class: 'b' })),
      h('b', { class: 'cc-empty-title' }, ready ? 'Pick something on the left to compare' : 'Compare code between two orgs'),
      ready ? h('p', {}, `Comparing ${orgName(S.aHost)} (A) with ${orgName(S.bHost)} (B). Changed items are listed first; Apex differences come straight from Salesforce’s checksums, Visualforce, LWC and Aura are checked in the background.`)
        : h('ol', { class: 'cc-steps' },
          h('li', {}, 'Log in to the orgs you want to compare in this browser: production, UAT, preprod…'),
          h('li', {}, 'Pick them as A and B at the top. Orgs of one family (same My Domain) are grouped together.'),
          h('li', {}, 'Open anything that differs to see the changes line by line, with moved code and changed words marked.')),
      h('div', { class: 'cc-legend' },
        h('span', { class: 'lg-del' }, 'removed (only in A)'), h('span', { class: 'lg-ins' }, 'added (only in B)'),
        h('span', { class: 'lg-chg' }, 'changed words'), h('span', { class: 'lg-mov' }, '↕ moved, not changed')));
  }

  function header(it) {
    const D = S.diff;
    return h('div', { class: 'cc-head' },
      h('span', { class: `cx-ico k-${it.kind}`, 'aria-hidden': 'true' }, DOC_KINDS[it.kind].icon),
      h('div', { class: 'cc-head-name' }, h('b', {}, it.name), h('small', {}, KIND_NAME[it.kind])),
      h('span', { class: `cc-pill big st-${it.status}` }, STATUS[it.status].label),
      h('span', { class: 'cx-grow' }),
      h('button', {
        type: 'button', class: 'ghost small', title: 'Copy the differences as a unified diff (paste into a ticket, Teams or a code review)', disabled: !D?.changes,
        onclick: (e) => copyText(e.currentTarget, unifiedDiff(D.aLines, D.bLines, D.ops, { aName: `${orgName(S.aHost)}/${S.fileName}`, bName: `${orgName(S.bHost)}/${S.fileName}` }), 'Copied diff'),
      }, '⧉ Copy diff'),
      h('button', { type: 'button', class: 'ghost small', title: 'Swap A and B', onclick: swap }, '⇄ Swap'));
  }

  function sideCards(it, fileA, fileB, D) {
    const ma = it.a;
    const mb = it.b;
    const newer = ma?.modified && mb?.modified ? (ma.modified > mb.modified ? 'a' : mb.modified > ma.modified ? 'b' : null) : null;
    const card = (side, meta, file, lines) => {
      const host = side === 'a' ? S.aHost : S.bHost;
      const s = src(host);
      const isApex = it.kind === 'class' || it.kind === 'trigger';
      const firstLine = D.firstChange[side] ?? 1;
      const target = explorerTarget(it, file, firstLine);
      return h('div', { class: `cc-card side-${side}${meta ? '' : ' missing'}` },
        h('div', { class: 'cc-card-head' },
          h('span', { class: `cc-side-badge side-${side}` }, side.toUpperCase()), h('b', {}, orgName(host)),
          host === current() ? h('span', { class: 'cc-this' }, 'this tab') : null,
          newer === side ? h('span', { class: 'cc-newer', title: 'Changed more recently on this side' }, 'newer') : null),
        meta ? h('div', { class: 'cc-card-meta' },
          h('span', {}, `Modified ${fmtDate(meta.modified)}${meta.by ? ` by ${meta.by}` : ''}`),
          h('span', {}, [meta.apiVersion ? `API ${Number(meta.apiVersion).toFixed(1)}` : null, file ? plural(lines, 'line') : 'no such file'].filter(Boolean).join(' · ')))
          : h('div', { class: 'cc-card-meta' }, h('span', {}, `Not in ${orgName(host)}`)),
        meta ? h('div', { class: 'cc-card-acts' }, ...[
          file ? h('button', { type: 'button', class: 'link', title: `Copy ${file.name} as ${orgName(host)} has it`, onclick: (e) => copyText(e.currentTarget, file.text) }, isApex ? `⧉ Copy ${it.kind === 'trigger' ? 'trigger' : 'class'}` : '⧉ Copy file') : null,
          opts.openInExplorer && host === current() && target ? h('button', { type: 'button', class: 'link', title: `Open in OG Explorer${firstLine > 1 ? `, at line ${firstLine}` : ''}`, onclick: () => opts.openInExplorer(target) }, 'Open in OG Explorer') : null,
          s ? h('a', { href: s.setupUrl(it.kind, meta), target: '_blank', rel: 'noopener' }, 'Setup ↗') : null].filter(Boolean)) : null);
    };
    return h('div', { class: 'cc-cards' }, card('a', ma, fileA, D.aLines.length), card('b', mb, fileB, D.bLines.length));
  }

  function explorerTarget(it, file, line) {
    const n = it.name.toLowerCase();
    if (it.kind === 'lwc') return { type: 'doc', key: `lwc:${n}`, fileName: file?.name, line };
    if (it.kind === 'aura') return { type: 'doc', key: `aura:${n}`, fileName: file?.def, line };
    return { type: 'doc', key: `${it.kind}:${n}`, line };
  }

  function toolbar(D, it) {
    const o = S.o;
    const set = (k, v) => { S.o[k] = v; store.set('ff-cc-opts', S.o); drawMain(); };
    const toggle = (k, label, title) => h('label', { class: 'cc-opt', title }, h('input', { type: 'checkbox', checked: !!o[k], onchange: (e) => set(k, e.target.checked) }), label);
    el.pos = h('span', { class: 'cc-pos' }, D.blocks.length ? `${D.blocks.length} change${D.blocks.length === 1 ? '' : 's'}` : 'no changes');
    const focusBtn = h('button', {
      type: 'button', class: `cc-focus${S.focus ? ' on' : ''}`, 'aria-pressed': String(S.focus),
      title: S.focus ? 'Show the name, both orgs’ details and the methods again' : 'Hide the name, both orgs’ details and the methods: more room for the diff',
      onclick: () => { S.focus = !S.focus; store.set('ff-cc-focus', S.focus); drawMain(); },
    }, S.focus ? [h('span', { class: `cx-ico k-${it.kind}`, 'aria-hidden': 'true' }, DOC_KINDS[it.kind].icon), h('b', {}, it.name), h('span', { class: `cc-pill st-${it.status}` }, STATUS[it.status].pill), h('span', { class: 'cc-focus-i' }, '⌄ Details')]
      : [h('span', { class: 'cc-focus-i' }, '⌃ Hide details')]);
    return h('div', { class: 'cc-tools' },
      focusBtn,
      h('div', { class: 'cc-seg', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(o.view === 'split'), onclick: () => set('view', 'split') }, 'Side by side'),
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(o.view === 'unified'), onclick: () => set('view', 'unified') }, 'Inline')),
      h('span', { class: 'cc-ignore' }, h('span', { class: 'cc-ignore-l' }, 'Ignore'),
        toggle('ignoreWhitespace', 'whitespace', 'Indentation and spacing changes don’t count'),
        toggle('ignoreCase', 'case', 'Apex is case-insensitive: “String” and “string” are the same'),
        toggle('ignoreComments', 'comments', 'Changes inside comments don’t count')),
      toggle('wrap', 'Wrap', 'Wrap long lines'),
      toggle('changesOnly', 'Only changes', `Hide unchanged code, keeping ${CTX} lines around each change`),
      h('span', { class: 'cx-grow' }),
      h('span', { class: 'cc-stats' },
        h('span', { class: 'cc-plus' }, `+${D.added}`), h('span', { class: 'cc-minus' }, `−${D.removed}`),
        D.moves.length ? h('span', { class: 'cc-moved', title: plural(D.moves.length, 'moved section') }, `↕ ${D.moves.length} moved`) : null),
      h('span', { class: 'cc-nav' },
        h('button', { type: 'button', class: 'ghost small', title: 'Previous change (Alt+↑ or P)', 'aria-label': 'Previous change', disabled: !D.blocks.length, onclick: () => jump(-1) }, '↑'),
        el.pos,
        h('button', { type: 'button', class: 'ghost small', title: 'Next change (Alt+↓ or N)', 'aria-label': 'Next change', disabled: !D.blocks.length, onclick: () => jump(1) }, '↓')),
      lookMenu());
  }

  function banner(it, D, fileA, fileB) {
    if (!fileA || !fileB) {
      const side = fileA ? 'A' : 'B';
      const host = fileA ? S.aHost : S.bHost;
      const other = fileA ? S.bHost : S.aHost;
      return h('div', { class: 'cc-banner only' }, h('b', {}, `Only in ${side} (${orgName(host)})`), ` · ${it.kind === 'lwc' || it.kind === 'aura' ? 'this file isn’t' : 'it isn’t'} in ${orgName(other)}. Everything below would be ${fileA ? 'missing from' : 'new to'} ${orgName(other)}.`);
    }
    if (!D.changes) {
      return h('div', { class: 'cc-banner same' }, h('b', {}, 'Identical'),
        D.rawSame ? ' · the code is exactly the same in both orgs.' : ` · only ${[S.o.ignoreWhitespace ? 'whitespace' : null, S.o.ignoreCase ? 'letter case' : null, S.o.ignoreComments ? 'comments' : null].filter(Boolean).join(', ')} differ${S.o.ignoreWhitespace + S.o.ignoreCase + S.o.ignoreComments > 1 ? '' : 's'}, which you chose to ignore.`);
    }
    return null;
  }

  function methodsStrip(D) {
    if (!D.methods?.length) return null;
    const changed = D.methods.filter((m) => m.status !== 'same');
    if (!changed.length) return h('div', { class: 'cc-methods' }, h('span', { class: 'cc-methods-label' }, 'Methods'), h('span', { class: 'cc-note' }, `all ${D.methods.length} the same`));
    const label = { changed: 'changed', added: 'added in B', removed: 'removed in B', moved: 'moved', 'moved+changed': 'moved + changed' };
    return h('div', { class: 'cc-methods' },
      h('span', { class: 'cc-methods-label' }, 'Methods'),
      changed.map((m) => h('button', {
        type: 'button', class: `cc-meth st-${m.status.replace('+', '-')}`, title: `${m.label}: ${label[m.status]}`,
        onclick: () => scrollToLine(m.a ? 'a' : 'b', (m.a || m.b).startLine - 1),
      }, h('span', { class: 'cc-meth-name' }, m.label), h('span', { class: 'cc-meth-st' }, label[m.status]))),
      D.methods.length > changed.length ? h('span', { class: 'cc-note' }, `${D.methods.length - changed.length} the same`) : null);
  }

  // ---------- the diff itself ----------
  function computeDiff(aText, bText, lang, it, hasA, hasB) {
    const aLines = hasA ? aText.replace(/\r\n?/g, '\n').split('\n') : [];
    const bLines = hasB ? bText.replace(/\r\n?/g, '\n').split('\n') : [];
    const keyOpts = { ignoreWhitespace: S.o.ignoreWhitespace, ignoreCase: S.o.ignoreCase, ignoreComments: S.o.ignoreComments, lang };
    const ops = diffLines(lineKeys(aLines, keyOpts), lineKeys(bLines, keyOpts));
    const { rows, blocks } = alignRows(ops);
    const mv = findMoves(rows, aLines, bLines);
    const firstChange = { a: null, b: null };
    for (const r of rows) {
      if (r.kind === 'eq') continue;
      if (firstChange.a == null && r.a != null) firstChange.a = r.a + 1;
      if (firstChange.b == null && r.b != null) firstChange.b = r.b + 1;
    }
    let methods = null;
    if (lang === 'apex' && hasA && hasB && (it.kind === 'class' || it.kind === 'trigger')) {
      try {
        const eqA = new Set(ops.filter((x) => x[0] === 0).map((x) => x[1]));
        methods = methodSummary(parseUnit({ name: it.name, kind: it.kind, body: aLines.join('\n') }), parseUnit({ name: it.name, kind: it.kind, body: bLines.join('\n') }), (l) => lineKeys(l, keyOpts), eqA);
      } catch { methods = null; }
    }
    return {
      aLines, bLines, ops, rows, blocks, moves: mv.moves, aMove: mv.aMove, bMove: mv.bMove, methods, firstChange,
      added: ops.filter((x) => x[0] === 2).length, removed: ops.filter((x) => x[0] === 1).length,
      changes: blocks.length, rawSame: aText === bText,
    };
  }

  function lineHtml(lines, lang) {
    if (lang === 'apex') {
      let inBlock = false;
      const st = { depth: 0 };
      return lines.map((l) => { const r = highlight(l, inBlock, null, null, st); inBlock = r.inBlock; return r.html || ' '; });
    }
    return syntaxLines(lines.join('\n'), lang === 'xml' ? 'markup' : lang);
  }

  function renderDiff(host, D, lang) {
    const reg = globalThis.CSS?.highlights;
    reg?.delete('cc-del');
    reg?.delete('cc-ins');
    const ha = lineHtml(D.aLines, lang);
    const hb = lineHtml(D.bLines, lang);
    const orgsA = `${S.aHost},${S.bHost}`;
    const orgsB = `${S.bHost},${S.aHost}`;
    const split = S.o.view === 'split';
    const grid = h('div', { class: `cc-grid ${split ? 'sbs' : 'unified'}${S.o.wrap ? ' wrap' : ''} lang-${lang}` });
    const aCell = new Map();
    const bCell = new Map();
    const blockEl = [];
    const code = (side, idx, html, cls) => {
      const txt = h('span', { class: 'txt' });
      txt.innerHTML = html;
      const mv = side === 'a' ? D.aMove.get(idx) : D.bMove.get(idx);
      const c = h('div', { class: `cc-code ${side}${cls ? ` ${cls}` : ''}${mv ? ' moved' : ''}`, 'data-label-orgs': side === 'a' ? orgsA : orgsB }, txt);
      if (mv && idx === (side === 'a' ? mv.a0 : mv.b0)) {
        const to = side === 'a' ? mv.b0 : mv.a0;
        c.append(h('button', {
          type: 'button', class: 'cc-move', title: `This section was moved, not changed. Click to see where it is in ${side === 'a' ? orgName(S.bHost) : orgName(S.aHost)}.`,
          onclick: () => scrollToLine(side === 'a' ? 'b' : 'a', to, true),
        }, side === 'a' ? `↕ moved to line ${to + 1}` : `↕ moved from line ${to + 1}`));
      }
      (side === 'a' ? aCell : bCell).set(idx, c);
      return c;
    };
    const ln = (n, cls = '') => h('div', { class: `cc-ln ${cls}` }, n == null ? '' : String(n + 1));
    const filler = (side) => h('div', { class: `cc-code ${side} fill` });
    const rowEls = [];
    if (split) {
      D.rows.forEach((r, i) => {
        const kind = r.kind;
        const row = h('div', { class: `cc-row k-${kind}`, 'data-i': i },
          ln(r.a, r.a != null && kind !== 'eq' ? 'del' : ''),
          r.a != null ? code('a', r.a, ha[r.a], kind === 'eq' ? '' : 'del') : filler('a'),
          ln(r.b, r.b != null && kind !== 'eq' ? 'ins' : ''),
          r.b != null ? code('b', r.b, hb[r.b], kind === 'eq' ? '' : 'ins') : filler('b'));
        rowEls.push(row);
        if (r.block >= 0 && blockEl[r.block] == null) blockEl[r.block] = row;
      });
    } else {
      // inline: each change shows its removed lines, then its added lines
      let i = 0;
      while (i < D.rows.length) {
        const r = D.rows[i];
        if (r.kind === 'eq') { rowEls.push(h('div', { class: 'cc-row k-eq', 'data-i': i }, ln(r.a), ln(r.b), code('a', r.a, ha[r.a], ''))); i++; continue; }
        const b = r.block;
        const span = [];
        while (i < D.rows.length && D.rows[i].block === b) span.push(D.rows[i++]);
        let first = null;
        for (const x of span) if (x.a != null) { const el2 = h('div', { class: 'cc-row k-del' }, ln(x.a, 'del'), ln(null), code('a', x.a, ha[x.a], 'del')); first ||= el2; rowEls.push(el2); }
        for (const x of span) if (x.b != null) { const el2 = h('div', { class: 'cc-row k-ins' }, ln(null), ln(x.b, 'ins'), code('b', x.b, hb[x.b], 'ins')); first ||= el2; rowEls.push(el2); }
        blockEl[b] = first;
      }
    }
    const frag = document.createDocumentFragment();
    for (const r of rowEls) frag.append(r);
    grid.append(frag);
    // "Only changes": long unchanged stretches fold into one line you can open
    if (S.o.changesOnly) {
      const isEq = (row) => row.classList.contains('k-eq');
      let k = 0;
      while (k < rowEls.length) {
        if (!isEq(rowEls[k])) { k++; continue; }
        let e = k;
        while (e < rowEls.length && isEq(rowEls[e])) e++;
        const from = k === 0 ? 0 : k + CTX;
        const to = e === rowEls.length ? e : e - CTX;
        if (to - from > 1) {
          const hidden = rowEls.slice(from, to);
          for (const x of hidden) x.classList.add('cc-folded');
          const fold = h('button', { type: 'button', class: 'cc-fold', onclick: () => { for (const x of hidden) x.classList.remove('cc-folded'); fold.remove(); requestAnimationFrame(drawRuler); } },
            h('span', { 'aria-hidden': 'true' }, '⋯'), `${plural(hidden.length, 'unchanged line')} · show`);
          hidden[0].before(fold);
        }
        k = e;
      }
    }
    const scroller = h('div', { class: 'cc-scroll', tabindex: '0' }, grid);
    const ruler = h('div', { class: 'cc-ruler', 'aria-hidden': 'true' });
    host.replaceChildren(scroller, ruler);
    S.view = { scroller, ruler, blockEl, aCell, bCell, cur: -1, D };
    // changed words inside changed lines
    if (reg && typeof Highlight !== 'undefined') {
      const del = [];
      const ins = [];
      for (const r of D.rows) {
        if (r.kind !== 'chg' || D.aMove.has(r.a) || D.bMove.has(r.b)) continue;
        const wd = wordDiff(D.aLines[r.a], D.bLines[r.b]);
        if (!wd.similar) continue;
        const ta = aCell.get(r.a)?.querySelector('.txt');
        const tb = bCell.get(r.b)?.querySelector('.txt');
        for (const [s, e] of wd.a) { const rg = ta && rangeAt(ta, s, e - s); if (rg) del.push(rg); }
        for (const [s, e] of wd.b) { const rg = tb && rangeAt(tb, s, e - s); if (rg) ins.push(rg); }
      }
      if (del.length) reg.set('cc-del', new Highlight(...del));
      if (ins.length) reg.set('cc-ins', new Highlight(...ins));
    }
    requestAnimationFrame(() => {
      drawRuler();
      if (D.blocks.length) jump(1, true);
    });
  }

  function drawRuler() {
    const v = S.view;
    if (!v?.scroller.isConnected) return;
    const total = v.scroller.scrollHeight || 1;
    v.ruler.replaceChildren(...v.D.blocks.map((b, i) => {
      const elx = v.blockEl[i];
      if (!elx || elx.classList.contains('cc-folded')) return null;
      const rows = v.D.rows.slice(b.from, b.to + 1);
      const moved = rows.every((r) => (r.a == null || v.D.aMove.has(r.a)) && (r.b == null || v.D.bMove.has(r.b)));
      const kind = moved ? 'mov' : rows.every((r) => r.kind === 'ins') ? 'ins' : rows.every((r) => r.kind === 'del') ? 'del' : 'chg';
      const top = (elx.offsetTop / total) * 100;
      const hgt = Math.max(0.6, ((rows.length * (elx.offsetHeight || 18)) / total) * 100);
      return h('button', { type: 'button', class: `cc-mark ${kind}`, style: `top:${top}%;height:${hgt}%`, tabindex: '-1', title: `Change ${i + 1}`, onclick: () => go(i) });
    }).filter(Boolean));
  }

  function go(i) {
    const v = S.view;
    if (!v) return;
    v.cur = i;
    const elx = v.blockEl[i];
    if (!elx) return;
    for (const x of v.scroller.querySelectorAll('.cc-cur')) x.classList.remove('cc-cur');
    const b = v.D.blocks[i];
    for (const row of v.scroller.querySelectorAll('.cc-row')) {
      const ri = row.dataset.i;
      if (ri != null && +ri >= b.from && +ri <= b.to) row.classList.add('cc-cur');
    }
    elx.classList.add('cc-cur');
    v.scroller.scrollTop = Math.max(0, elx.offsetTop - v.scroller.clientHeight / 3);
    if (el.pos?.isConnected) el.pos.textContent = `${i + 1} / ${v.D.blocks.length}`;
  }
  function jump(d, first) {
    const v = S.view;
    if (!v?.D.blocks.length) return;
    const n = v.D.blocks.length;
    go(first ? 0 : ((v.cur < 0 ? (d > 0 ? -1 : 0) : v.cur) + d + n) % n);
  }
  function scrollToLine(side, idx, flash) {
    const v = S.view;
    const c = (side === 'a' ? v?.aCell : v?.bCell)?.get(idx);
    if (!c) return;
    const row = c.closest('.cc-row');
    if (row.classList.contains('cc-folded')) { row.parentElement.querySelectorAll('.cc-folded').forEach((x) => x.classList.remove('cc-folded')); row.parentElement.querySelectorAll('.cc-fold').forEach((x) => x.remove()); }
    v.scroller.scrollTop = Math.max(0, row.offsetTop - v.scroller.clientHeight / 3);
    if (flash) { row.classList.remove('cc-flash'); void row.offsetWidth; row.classList.add('cc-flash'); }
  }

  // keys: next / previous change
  document.addEventListener('keydown', (e) => {
    if (!S.active || !S.view?.scroller.isConnected) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    const k = e.key.toLowerCase();
    if ((e.altKey && e.key === 'ArrowDown') || (!e.altKey && !e.ctrlKey && !e.metaKey && k === 'n')) { e.preventDefault(); jump(1); }
    if ((e.altKey && e.key === 'ArrowUp') || (!e.altKey && !e.ctrlKey && !e.metaKey && k === 'p')) { e.preventDefault(); jump(-1); }
  });
  document.addEventListener('og-codelook', () => { if (S.open && S.sel) drawMain(); });
  new ResizeObserver(() => requestAnimationFrame(drawRuler)).observe(el.main);

  // ---------- start ----------
  el.side.replaceChildren(h('div', { class: 'cx-loading' }, h('span', { class: 'lg-spinner' }), 'Finding the orgs you’re logged into…'), el.sideRail);
  el.main.replaceChildren(emptyMain());
  drawTop();
  (async () => {
    try { await S.reg.refreshAll(); } catch { /* the pickers say what's missing */ }
    pickDefaults();
    drawTop();
    compareAll();
  })();

  return {
    setActive(on) { S.active = on; if (on) requestAnimationFrame(drawRuler); },
  };
}
