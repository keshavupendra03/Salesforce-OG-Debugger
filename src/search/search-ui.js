// FBI Search (Full-Base Inspector): find a text (usually an error message seen on a record page) across Apex, flows, Process Builder,
// validation rules, Visualforce, LWC, Aura and custom labels. Sources load on demand, search runs in memory,
// and "Free memory" drops everything once you're done.

import { h, esc } from '../dom.js';
import { resizable } from '../layout.js';
import { KINDS, trimErrorText, makeMatcher, matchRanges, search, docsBytes } from './search-engine.js';

// what the user picks (a source group can hold several kinds of docs)
const GROUPS = [
  { key: 'apex', label: 'Apex', icon: '⌁', kinds: ['apex', 'trigger'], hint: 'classes and triggers' },
  { key: 'flow', label: 'Flows & Process Builder', icon: '⤳', kinds: ['flow', 'process'], hint: 'active versions' },
  { key: 'validation', label: 'Validation rules', icon: '✓', kinds: ['validation'], hint: 'message, formula, description' },
  { key: 'vf', label: 'Visualforce', icon: '◧', kinds: ['vf'], hint: 'pages and components' },
  { key: 'lwc', label: 'LWC', icon: '◇', kinds: ['lwc'], hint: 'JavaScript and HTML' },
  { key: 'aura', label: 'Aura', icon: '◈', kinds: ['aura'], hint: 'markup and controllers' },
  { key: 'label', label: 'Custom labels', icon: '🏷', kinds: ['label'], hint: 'error text often lives here' },
];
const KIND_ORDER = GROUPS.flatMap((g) => g.kinds);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
};
const mb = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(b >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const num = (n) => Number(n).toLocaleString();

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2600);
}

// text with the matches wrapped in <mark>, cut down around the first match when it's long
function marked(m, text, max = 0) {
  let s = text;
  if (max && s.length > max) {
    const first = matchRanges(m, s)[0];
    const start = first ? Math.max(0, first.start - Math.floor(max / 3)) : 0;
    s = (start ? '…' : '') + s.slice(start, start + max) + (start + max < text.length ? '…' : '');
  }
  const ranges = matchRanges(m, s);
  let html = '';
  let last = 0;
  for (const r of ranges) { html += esc(s.slice(last, r.start)) + `<mark>${esc(s.slice(r.start, r.end))}</mark>`; last = r.end; }
  return html + esc(s.slice(last));
}

export function mountSearch(root, sources) {
  const S = {
    q: store.get('ff-sx-q', ''), opts: store.get('ff-sx-opts', { caseSensitive: false, wholeWord: false, regex: false, trim: true }),
    on: new Set(store.get('ff-sx-groups', GROUPS.map((g) => g.key))),
    docs: new Map(), // group -> docs
    loading: new Map(), // group -> { text, f }
    errors: new Map(),
    result: null, sel: null, matcher: null, effective: '',
  };
  const el = {};

  root.replaceChildren(
    h('header', { class: 'sx-head' },
      h('div', { class: 'sx-title' },
        h('h1', {}, 'Full-Base Inspector', h('span', { class: 'sx-badge', title: 'FBI Search' }, 'FBI Search')),
        h('p', {}, 'Saw an error on a record page? Paste it here to find where it comes from: Apex, flows, Process Builder, validation rules, Visualforce, LWC, Aura or custom labels.')),
      el.form = h('form', { class: 'sx-form', role: 'search' },
        h('div', { class: 'sx-inputbox' },
          h('span', { class: 'sx-input-icon', 'aria-hidden': 'true' }, '⌕'),
          el.input = h('input', { type: 'search', class: 'sx-input', placeholder: 'Paste an error message or type any text…', value: S.q, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Search text' }),
          el.optBtns = h('div', { class: 'sx-opts', role: 'group', 'aria-label': 'Match options' },
            optBtn('caseSensitive', 'Aa', 'Match case'), optBtn('wholeWord', 'ab', 'Whole word'), optBtn('regex', '.*', 'Regular expression'))),
        el.go = h('button', { class: 'primary sx-go', type: 'submit' }, 'Search')),
      el.note = h('div', { class: 'sx-note', hidden: true }),
      h('div', { class: 'sx-sources' },
        el.chips = h('div', { class: 'sx-chips', role: 'group', 'aria-label': 'Where to search' }),
        h('span', { class: 'sx-grow' }),
        el.mem = h('button', { class: 'ghost small sx-mem', hidden: true, onclick: freeMemory, title: 'Unload everything FBI Search loaded. Cached copies on disk stay, so the next load is quick.' }),
        el.refresh = h('button', { class: 'ghost small', hidden: true, title: 'Load the sources again from Salesforce', onclick: refreshSources }, '↻ Refresh'))),
    el.body = h('div', { class: 'sx-body' },
      el.list = h('section', { class: 'sx-list', 'aria-label': 'Results' }),
      el.preview = h('section', { class: 'sx-preview', 'aria-label': 'Preview' })));
  el.body.append(resizable({
    handle: h('div'), pane: el.list, host: el.body, cssVar: '--sx-list', edge: 'end',
    min: 300, max: () => el.body.clientWidth - 320, key: 'ff-split-sx', label: 'Resize results and preview',
  }));

  function optBtn(k, text, title) {
    return h('button', {
      type: 'button', class: 'sx-opt', 'aria-pressed': String(!!S.opts[k]), title,
      onclick: (e) => { S.opts[k] = !S.opts[k]; e.currentTarget.setAttribute('aria-pressed', String(S.opts[k])); store.set('ff-sx-opts', S.opts); runSearch(); },
    }, text);
  }

  el.form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  let typeT = 0;
  el.input.addEventListener('input', () => {
    S.q = el.input.value;
    store.set('ff-sx-q', S.q);
    clearTimeout(typeT);
    // searching what's already loaded is instant; loading needs Enter / Search
    if (S.docs.size) typeT = setTimeout(runSearch, 160);
  });

  // ---------- sources ----------
  function drawChips() {
    el.chips.replaceChildren(...GROUPS.map((g) => {
      const on = S.on.has(g.key);
      const docs = S.docs.get(g.key);
      const ld = S.loading.get(g.key);
      const err = S.errors.get(g.key);
      const state = ld ? h('span', { class: 'sx-chip-state busy' }, h('span', { class: 'lg-spinner' }), ld.f != null ? `${Math.round(ld.f * 100)}%` : '…')
        : err ? h('span', { class: 'sx-chip-state err', title: err }, '!')
          : docs ? h('span', { class: 'sx-chip-state' }, num(docs.length)) : null;
      return h('button', {
        type: 'button', class: `sx-chip${on ? ' on' : ''}${docs ? ' loaded' : ''}`, 'aria-pressed': String(on),
        title: `${g.label}: ${g.hint}${err ? `\nCouldn’t load: ${err}` : docs ? `\n${docs.length} items loaded` : '\nNot loaded yet: loads when you search'}`,
        onclick: () => { if (on) S.on.delete(g.key); else S.on.add(g.key); store.set('ff-sx-groups', [...S.on]); drawChips(); if (S.matcher) runSearch(); },
      }, h('span', { class: 'sx-chip-i', 'aria-hidden': 'true' }, g.icon), g.label, state);
    }));
    const all = [...S.docs.values()].flat();
    el.mem.hidden = !all.length;
    el.refresh.hidden = !all.length;
    if (all.length) el.mem.textContent = `🧹 Free memory · ~${mb(docsBytes(all))}`;
  }

  async function ensureLoaded(keys) {
    const todo = keys.filter((k) => !S.docs.has(k) && !S.loading.has(k));
    await Promise.all(todo.map(async (k) => {
      S.loading.set(k, { text: '', f: null });
      S.errors.delete(k);
      drawChips();
      try {
        const docs = await sources.load(k, (text, f) => { S.loading.set(k, { text, f: f ?? null }); drawChips(); drawLoading(); });
        S.docs.set(k, docs);
      } catch (e) {
        S.errors.set(k, e.message || String(e));
      }
      S.loading.delete(k);
      drawChips();
    }));
  }

  async function refreshSources() {
    const keys = [...S.docs.keys()];
    S.docs.clear();
    drawChips();
    await ensureLoaded(keys);
    runSearch();
    toast('Sources reloaded', 'ok');
  }

  function freeMemory() {
    const bytes = docsBytes([...S.docs.values()].flat());
    S.docs.clear();
    S.result = null;
    S.sel = null;
    S.matcher = null;
    drawChips();
    drawEmpty();
    el.preview.replaceChildren(previewEmpty());
    toast(`Freed about ${mb(bytes)} · sources load again on your next search`, 'ok');
  }

  // ---------- searching ----------
  async function go() {
    S.q = el.input.value;
    if (!S.q.trim()) { el.input.focus(); return; }
    const keys = GROUPS.filter((g) => S.on.has(g.key)).map((g) => g.key);
    if (!keys.length) { toast('Pick at least one place to search', 'error'); return; }
    el.go.disabled = true;
    if (keys.some((k) => !S.docs.has(k))) drawLoading();
    await ensureLoaded(keys);
    el.go.disabled = false;
    runSearch();
  }

  function effectiveQuery() {
    const raw = S.q.trim();
    if (S.opts.regex || !S.opts.trim) return { q: raw, trimmed: null };
    const t = trimErrorText(raw);
    return t ? { q: t, trimmed: raw } : { q: raw, trimmed: null };
  }

  function runSearch() {
    if (!S.q.trim()) { S.result = null; S.matcher = null; el.note.hidden = true; drawEmpty(); return; }
    const { q, trimmed } = effectiveQuery();
    const m = makeMatcher(q, S.opts);
    S.effective = q;
    if (!m || m.error) { S.matcher = null; drawNote(m?.error ? `That regular expression isn’t valid: ${m.error}` : '', true); return; }
    S.matcher = m;
    drawNote(trimmed);
    const keys = GROUPS.filter((g) => S.on.has(g.key) && S.docs.has(g.key)).map((g) => g.key);
    const docs = keys.flatMap((k) => S.docs.get(k));
    if (!docs.length) { drawEmpty(); return; }
    const t0 = performance.now();
    S.result = search(docs, m);
    S.result.ms = performance.now() - t0;
    S.result.searched = docs.length;
    S.result.notLoaded = GROUPS.filter((g) => S.on.has(g.key) && !S.docs.has(g.key)).map((g) => g.label);
    drawResults();
  }

  function drawNote(trimmed, isErr) {
    if (isErr) {
      el.note.hidden = false;
      el.note.className = 'sx-note err';
      el.note.replaceChildren(trimmed);
      return;
    }
    el.note.hidden = !trimmed;
    if (!trimmed) return;
    el.note.className = 'sx-note';
    el.note.replaceChildren(
      h('span', { class: 'sx-note-i', 'aria-hidden': 'true' }, '✂'),
      h('span', {}, 'Searching for ', h('b', {}, `“${S.effective}”`), ': the error code and field list are left out, since only the message is written in your org.'),
      h('button', { type: 'button', class: 'link', onclick: () => { S.opts.trim = false; store.set('ff-sx-opts', S.opts); runSearch(); } }, 'Search the full text'));
  }

  // ---------- results ----------
  function drawLoading() {
    if (S.docs.size && !S.loading.size) return;
    const rows = GROUPS.filter((g) => S.loading.has(g.key)).map((g) => {
      const ld = S.loading.get(g.key);
      return h('li', {}, h('span', { class: 'sx-chip-i', 'aria-hidden': 'true' }, g.icon), h('b', {}, g.label), h('span', { class: 'sx-load-text' }, ld.text || 'Starting…'),
        h('span', { class: 'sx-load-bar' }, h('span', { style: `width:${Math.round((ld.f ?? 0.08) * 100)}%` })));
    });
    if (!rows.length) return;
    el.list.replaceChildren(h('div', { class: 'sx-loading' },
      h('b', {}, 'Loading what to search…'),
      h('p', {}, 'The first time takes a moment: flows and validation rules are read one by one. They’re cached after that.'),
      h('ul', {}, rows)));
  }

  function drawEmpty() {
    const loaded = [...S.docs.values()].flat().length;
    el.list.replaceChildren(h('div', { class: 'sx-empty' },
      h('div', { class: 'sx-empty-art', 'aria-hidden': 'true' }, '🔎'),
      h('b', {}, loaded ? `${num(loaded)} items ready to search` : 'Where does that error come from?'),
      h('ol', { class: 'sx-steps' },
        h('li', {}, 'Copy the error from the record page, the toast or the debug log.'),
        h('li', {}, 'Paste it above and press ', h('kbd', {}, 'Enter'), '. Error codes and field lists are trimmed for you.'),
        h('li', {}, 'Open a result to see the exact line, then jump to it in Setup.')),
      h('div', { class: 'sx-try' }, h('span', {}, 'Try'),
        ['Close Reason is required', 'Insufficient access', 'required'].map((t) => h('button', { type: 'button', class: 'sx-try-chip', onclick: () => { el.input.value = t; S.q = t; go(); } }, t)))));
  }

  function drawResults() {
    const r = S.result;
    const byKind = new Map();
    for (const x of r.results) {
      if (!byKind.has(x.doc.kind)) byKind.set(x.doc.kind, []);
      byKind.get(x.doc.kind).push(x);
    }
    // groups in order of their best result (results are already sorted), so the likely source comes first
    const kinds = [...byKind.keys()].sort((a, b) => byKind.get(b)[0].score - byKind.get(a)[0].score || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
    const summary = h('div', { class: 'sx-summary' },
      h('b', {}, r.docsHit ? `${num(r.docsHit)} item${r.docsHit === 1 ? '' : 's'}` : 'No matches'),
      r.docsHit ? h('span', {}, ` · ${num(r.linesHit)} matching line${r.linesHit === 1 ? '' : 's'}${r.capped ? ' (first ones shown)' : ''}`) : null,
      h('span', { class: 'sx-muted' }, ` · searched ${num(r.searched)} items in ${r.ms < 1 ? '<1' : Math.round(r.ms)} ms`),
      r.notLoaded.length ? h('span', { class: 'sx-warn' }, ` · not loaded: ${r.notLoaded.join(', ')} (press Search)`) : null);
    if (!r.docsHit) {
      el.list.replaceChildren(summary, h('div', { class: 'sx-empty small' },
        h('div', { class: 'sx-empty-art', 'aria-hidden': 'true' }, '🌵'),
        h('b', {}, 'Nothing found'),
        h('p', {}, 'Messages often contain values that change (record names, numbers). Try a shorter, fixed part of the text, or search in more places.')));
      el.preview.replaceChildren(previewEmpty());
      return;
    }
    const groups = kinds.map((k) => {
      const list = byKind.get(k);
      const g = KINDS[k];
      return h('div', { class: 'sx-group' },
        h('div', { class: 'sx-group-head' }, h('span', { class: `sx-kind k-${k}`, 'aria-hidden': 'true' }, g.icon), g.label, h('span', { class: 'sx-count' }, list.length)),
        list.map((x) => resultRow(x)));
    });
    el.list.replaceChildren(summary, h('div', { class: 'sx-groups', role: 'listbox', 'aria-label': 'Results' }, groups));
    const first = (S.sel && r.results.find((x) => x.doc === S.sel)) || r.results[0];
    select(first);
  }

  function resultRow(x) {
    const d = x.doc;
    const row = h('div', {
      class: `sx-row${d.inactive ? ' inactive' : ''}`, role: 'option', tabindex: '0', 'aria-selected': 'false',
      onclick: () => select(x),
      onkeydown: (e) => {
        if (e.key === 'Enter') select(x);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const rows = [...el.list.querySelectorAll('.sx-row')];
          const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
          next?.focus();
          next?.click();
        }
      },
    },
    h('div', { class: 'sx-row-head' },
      h('b', { class: 'sx-name' }, d.name),
      d.inactive ? h('span', { class: 'sx-pill' }, 'inactive') : null,
      h('span', { class: 'sx-sub' }, (d.sub || '').replace(/ · inactive$/, '')), // the pill already says it
      h('span', { class: 'sx-hits', title: `${x.total} matching line${x.total === 1 ? '' : 's'}` }, x.total || 'name')),
    h('ul', { class: 'sx-snips' }, x.hits.slice(0, 3).map((hit) => {
      const li = h('li', {}, h('span', { class: 'sx-where' }, hit.label ? hit.label.replace(/^.*› /, '') : `L${hit.i + 1}`));
      li.append(Object.assign(h('span', { class: 'sx-snip' }), { innerHTML: marked(S.matcher, hit.text.trim(), 140) }));
      return li;
    }), x.total > 3 ? h('li', { class: 'sx-more' }, `+${x.total - 3} more`) : null));
    row.dataset.key = `${d.kind}:${d.id}`;
    return row;
  }

  // ---------- preview ----------
  function previewEmpty() {
    return h('div', { class: 'sx-pv-empty' }, h('span', { 'aria-hidden': 'true' }, '◧'), 'Select a result to see where the text sits');
  }

  function select(x) {
    if (!x) return;
    S.sel = x.doc;
    for (const r of el.list.querySelectorAll('.sx-row')) r.setAttribute('aria-selected', String(r.dataset.key === `${x.doc.kind}:${x.doc.id}`));
    const d = x.doc;
    const g = KINDS[d.kind];
    const hitSet = new Set(x.hits.map((hh) => hh.i));
    const labeled = d.lines.some((l) => l.label);
    const body = h('div', { class: `sx-pv-body${labeled ? ' labeled' : ' code'}` });
    const m = S.matcher;
    // big docs: show the matching lines with a little context instead of every line
    const ctx = d.lines.length > 600 && !labeled ? 3 : Infinity;
    let lastShown = -1;
    let html = '';
    for (let i = 0; i < d.lines.length; i++) {
      const near = ctx === Infinity || x.hits.some((hh) => Math.abs(hh.i - i) <= ctx);
      if (!near) continue;
      if (lastShown >= 0 && i > lastShown + 1) html += '<div class="sx-gap">⋯</div>';
      lastShown = i;
      const ln = d.lines[i];
      const hit = hitSet.has(i) || (m.test(ln.text) || (ln.label && m.test(ln.label)));
      html += labeled
        ? `<div class="sx-ln${hit ? ' hit' : ''}" data-i="${i}"><span class="sx-ln-label">${esc(ln.label || '')}</span><span class="sx-ln-text">${hit ? marked(m, ln.text) : esc(ln.text) || '&nbsp;'}</span></div>`
        : `<div class="sx-ln${hit ? ' hit' : ''}" data-i="${i}"><span class="sx-ln-no">${i + 1}</span><span class="sx-ln-text">${hit ? marked(m, ln.text) : esc(ln.text) || '&nbsp;'}</span></div>`;
    }
    body.innerHTML = html || '<div class="sx-gap">The name matches; the text doesn’t.</div>';
    const hitsAll = [...body.querySelectorAll('.sx-ln.hit')];
    let cur = 0;
    const jump = (k) => {
      if (!hitsAll.length) return;
      cur = (k + hitsAll.length) % hitsAll.length;
      for (const n of hitsAll) n.classList.remove('cur');
      hitsAll[cur].classList.add('cur');
      hitsAll[cur].scrollIntoView({ block: 'center' });
      pos.textContent = `${cur + 1} / ${hitsAll.length}`;
    };
    const pos = h('span', { class: 'sx-pos' });
    el.preview.replaceChildren(
      h('header', { class: 'sx-pv-head' },
        h('div', { class: 'sx-pv-title' },
          h('span', { class: `sx-kind k-${d.kind}`, 'aria-hidden': 'true' }, g.icon),
          h('div', {},
            h('div', { class: 'sx-pv-kicker' }, g.label, d.inactive ? h('span', { class: 'sx-pill' }, 'inactive') : null),
            h('b', { title: d.name }, d.name),
            h('div', { class: 'sx-pv-sub' }, [d.title && d.title !== d.name ? d.title : null, (d.sub || '').replace(/ · inactive$/, '')].filter(Boolean).join(' · ')))),
        h('div', { class: 'sx-pv-acts' },
          hitsAll.length > 1 ? h('span', { class: 'sx-nav' },
            h('button', { class: 'ghost small', title: 'Previous match', 'aria-label': 'Previous match', onclick: () => jump(cur - 1) }, '↑'), pos,
            h('button', { class: 'ghost small', title: 'Next match', 'aria-label': 'Next match', onclick: () => jump(cur + 1) }, '↓')) : null,
          h('button', { class: 'ghost small', onclick: () => navigator.clipboard?.writeText(d.name).then(() => toast('Name copied', 'ok')) }, 'Copy name'),
          d.link ? h('a', { class: 'ghost small sx-open', href: d.link, target: '_blank', rel: 'noopener' }, 'Open in Salesforce ↗') : null)),
      body);
    requestAnimationFrame(() => jump(0));
  }

  // ---------- boot ----------
  drawChips();
  drawEmpty();
  el.preview.replaceChildren(previewEmpty());
  return {
    setActive(on) {
      if (!on) return;
      setTimeout(() => { el.input.focus(); el.input.select(); }, 0);
    },
  };
}
