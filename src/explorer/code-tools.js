// Editor comforts for read-only code views: folding blocks from the gutter, and highlighting every other
// occurrence of the selected text (like VS Code). Works on the `.src > .row[data-line] > .gutter + .txt` rows
// every code view here renders.

// ---------- folding ----------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/**
 * Foldable blocks: Map(start line → end line). The lines between them can be hidden; the end line stays.
 * Code (Apex, JS, CSS): { … } blocks, skipping strings and comments. Markup: multi-line elements.
 */
export function foldRegions(text, lang) {
  const out = new Map();
  const keep = (s, e) => { if (e - s >= 2 && (!out.has(s) || out.get(s) < e)) out.set(s, e); };
  if (lang === 'markup') {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const lineAt = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
    const clean = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
    const stack = [];
    for (const m of clean.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
      const [, close, rawName, , self] = m;
      const name = rawName.toLowerCase();
      if (self || VOID.has(name)) continue;
      if (!close) { stack.push({ name, line: lineAt(m.index) }); continue; }
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name !== name) continue;
        keep(stack[k].line, lineAt(m.index));
        stack.length = k;
        break;
      }
    }
    return out;
  }
  const stack = [];
  let block = false;
  text.split('\n').forEach((line, li) => {
    const n = line.length;
    let i = 0;
    while (i < n) {
      if (block) { const e = line.indexOf('*/', i); if (e < 0) break; block = false; i = e + 2; continue; }
      const c = line[i];
      if (c === '/' && line[i + 1] === '/') break;
      if (c === '/' && line[i + 1] === '*') { block = true; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        i++;
        while (i < n && line[i] !== c) i += line[i] === '\\' ? 2 : 1;
        i++;
        continue;
      }
      if (c === '{') stack.push(li + 1);
      else if (c === '}') { const s = stack.pop(); if (s) keep(s, li + 1); }
      i++;
    }
  });
  return out;
}

/**
 * Fold arrows in the gutter of `pre`. Returns { foldAll, unfoldAll, reveal(line), count }.
 * A folded block shows ⋯ at the end of its first line (click it, or the arrow, to open it again).
 */
export function enableFolding(pre, regions) {
  const rows = new Map();
  for (const r of pre.querySelectorAll(':scope > .row[data-line]')) rows.set(+r.dataset.line, r);
  const folded = new Set();
  const apply = () => {
    const hidden = new Set();
    for (const s of folded) for (let n = s + 1; n < regions.get(s); n++) hidden.add(n);
    for (const [n, r] of rows) {
      r.classList.toggle('fold-hidden', hidden.has(n));
      const on = folded.has(n);
      r.classList.toggle('folded', on);
      const btn = r.querySelector(':scope > .gutter > .fold');
      if (btn) { btn.setAttribute('aria-expanded', String(!on)); btn.title = on ? 'Unfold' : 'Fold'; }
      const dots = r.querySelector(':scope > .txt > .fold-dots');
      if (on && !dots) {
        r.querySelector(':scope > .txt')?.append(Object.assign(document.createElement('span'), { className: 'fold-dots', title: `Unfold (${regions.get(n) - n - 1} lines)`, textContent: '⋯' }));
      } else if (!on && dots) dots.remove();
    }
    pre.dispatchEvent(new Event('og-fold')); // the layout changed (sticky scroll listens)
  };
  const toggle = (s) => { if (folded.has(s)) folded.delete(s); else folded.add(s); apply(); };
  for (const [s] of regions) {
    const r = rows.get(s);
    const g = r?.querySelector(':scope > .gutter');
    if (!g) continue;
    r.classList.add('foldable');
    const b = document.createElement('button');
    b.className = 'fold';
    b.type = 'button';
    b.setAttribute('aria-expanded', 'true');
    b.setAttribute('aria-label', `Fold lines ${s + 1} to ${regions.get(s) - 1}`);
    b.title = 'Fold';
    g.prepend(b);
  }
  pre.addEventListener('click', (e) => {
    const t = e.target.closest?.('.fold, .fold-dots');
    if (!t || t.closest('.src') !== pre) return;
    e.stopPropagation();
    toggle(+t.closest('.row').dataset.line);
  });
  return {
    count: regions.size,
    foldAll() { for (const [s] of regions) folded.add(s); apply(); },
    unfoldAll() { folded.clear(); apply(); },
    // jumping to a hidden line opens the blocks around it
    reveal(line) {
      let changed = false;
      for (const s of [...folded]) if (line > s && line < regions.get(s)) { folded.delete(s); changed = true; }
      if (changed) apply();
    },
  };
}

// ---------- the same text, everywhere in the file ----------

export function rangeAt(el, start, len) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0;
  let begun = false;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const l = n.nodeValue.length;
    if (!begun && start < pos + l) { r.setStart(n, start - pos); begun = true; }
    if (begun && start + len <= pos + l) { r.setEnd(n, start + len - pos); return r; }
    pos += l;
  }
  return null;
}

/**
 * Selecting text in the code highlights every other place it appears in the same view.
 * getRoot() → the element holding the rows (re-read each time: views are re-rendered); ignoreCase() for Apex.
 * onCount(n) gets the number of occurrences (0 when nothing is selected).
 */
let sameOwner = null; // the highlighter whose ranges are showing

export function selectionHighlighter({ getRoot, ignoreCase = () => false, onCount = () => {} }) {
  const reg = globalThis.CSS?.highlights;
  if (!reg || typeof Highlight === 'undefined') return;
  let t = 0;
  const me = {};
  const run = () => {
    const root = getRoot();
    const sel = document.getSelection();
    const raw = sel && !sel.isCollapsed ? sel.toString() : '';
    const text = raw.replace(/\r/g, '');
    // several views highlight (OG Explorer, FBI Search): each only clears what it set itself
    if (sameOwner === me) { reg.delete('og-same'); sameOwner = null; }
    if (!root?.isConnected || !text.trim() || text.length < 2 || text.length > 300 || text.includes('\n') || !root.contains(sel.anchorNode)) { onCount(0); return; }
    reg.delete('og-same');
    sameOwner = me;
    const ic = ignoreCase();
    const needle = ic ? text.toLowerCase() : text;
    const ranges = [];
    for (const txt of root.querySelectorAll(':scope > .src > .row > .txt')) { // not the sticky copies
      const hay = ic ? txt.textContent.toLowerCase() : txt.textContent;
      for (let i = hay.indexOf(needle); i >= 0 && ranges.length < 5000; i = hay.indexOf(needle, i + needle.length)) {
        const r = rangeAt(txt, i, needle.length);
        if (r) ranges.push(r);
      }
    }
    if (ranges.length) reg.set('og-same', new Highlight(...ranges));
    onCount(ranges.length);
  };
  document.addEventListener('selectionchange', () => { clearTimeout(t); t = setTimeout(run, 90); });
}

// ---------- indent guides ----------

/**
 * Wraps each row's leading indentation in <span class="tk-ind"> (themes draw guide lines on it). Blank rows get an
 * empty one as wide as the indentation around them, so the guides run through blank lines like in VS Code.
 */
export function markIndent(pre, tabSize = 4) {
  const rows = [...pre.querySelectorAll(':scope > .row > .txt')];
  const width = (s) => [...s].reduce((w, c) => w + (c === '\t' ? tabSize - (w % tabSize) : 1), 0);
  const ind = rows.map((t) => (t.textContent.trim() ? width(/^[ \t]*/.exec(t.textContent)[0]) : -1));
  // the file's indent step (2 in most LWC, 4 in most Apex): guides go at each step
  const steps = new Map();
  let before = 0;
  for (const w of ind) {
    if (w < 0) continue;
    const d = w - before;
    if (d > 0 && d <= 8) steps.set(d, (steps.get(d) || 0) + 1);
    before = w;
  }
  const unit = [...steps].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || tabSize;
  pre.style.setProperty('--ind', `${unit}ch`);
  rows.forEach((txt, i) => {
    if (ind[i] < 0) {
      let a = -1, b = -1;
      for (let k = i - 1; k >= 0 && a < 0; k--) a = ind[k];
      for (let k = i + 1; k < rows.length && b < 0; k++) b = ind[k];
      const w = Math.max(0, Math.min(a, b));
      if (w) txt.prepend(Object.assign(document.createElement('span'), { className: 'tk-ind blank', style: `width:${w}ch` }));
      return;
    }
    if (!ind[i]) return;
    const walker = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const lead = node && /^[ \t]+/.exec(node.nodeValue);
    if (!lead) return;
    const rest = node.splitText(lead[0].length);
    const span = Object.assign(document.createElement('span'), { className: 'tk-ind' });
    rest.parentNode.insertBefore(span, rest);
    span.append(node);
  });
}

// ---------- sticky scroll (VS Code): the class and method you're in stay pinned at the top ----------

/**
 * Pins the first line of each block the top of the view is inside (class, method, if, for… up to `max`), above
 * the code in `scroller`. A block's line slides up as its closing line reaches it. Click a pinned line to go to it.
 * Returns { update, setEnabled(on), el } (el: the pinned rows' container, for wiring links).
 */
export function stickyScroll(scroller, pre, regions, { max = 5, onPick } = {}) {
  const box = document.createElement('div');
  box.className = 'cx-sticky';
  const inner = document.createElement('div');
  inner.className = `src cx-sticky-in ${[...pre.classList].filter((c) => c.startsWith('lang-')).join(' ')}`;
  inner.style.cssText = pre.style.cssText; // the indent step for guides
  box.append(inner);
  scroller.prepend(box);
  const regs = [...regions].map(([s, e]) => ({ s, e })).sort((a, b) => a.s - b.s);
  const rowOf = new Map();
  for (const r of pre.querySelectorAll(':scope > .row[data-line]')) rowOf.set(+r.dataset.line, r);
  let visible = null; // rows on screen in order (cache; folding and peeks clear it)
  const rows = () => (visible ||= [...rowOf.values()].filter((r) => r.offsetParent));
  const top = (n) => rowOf.get(n)?.offsetTop ?? 0;
  const lineAt = (y) => {
    const v = rows();
    let lo = 0, hi = v.length - 1, best = v[0];
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (v[mid].offsetTop <= y) { best = v[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best ? +best.dataset.line : 1;
  };
  let enabled = true;
  let shown = '';
  let picked = [];
  const clone = (n) => {
    const r = rowOf.get(n).cloneNode(true);
    r.classList.remove('cx-cur', 'cx-flash', 'cx-hit', 'cx-hit-cur', 'folded', 'foldable', 'fold-hidden', 'in-method');
    for (const x of r.querySelectorAll('.fold, .fold-dots')) x.remove();
    return r;
  };
  function update() {
    if (!enabled || !regs.length) { if (shown) { inner.replaceChildren(); shown = ''; picked = []; inner.style.height = '0px'; box.classList.remove('on'); } return; }
    const lh = rows()[0]?.offsetHeight || 19;
    const y0 = scroller.scrollTop - pre.offsetTop;
    const pick = [];
    while (pick.length < max) {
      const yk = y0 + pick.length * lh;
      const line = lineAt(yk);
      const last = pick[pick.length - 1];
      const next = regs.find((r) => r.s < line && line <= r.e && (!last || r.s > last.s) && r.e <= (last?.e ?? Infinity) && rowOf.get(r.s)?.offsetParent);
      if (!next || top(next.s) >= yk) break;
      pick.push(next);
    }
    const key = pick.map((r) => r.s).join(',');
    if (key !== shown) { inner.replaceChildren(...pick.map((r) => clone(r.s))); shown = key; picked = pick; }
    let off = 0;
    let bottom = 0; // the lowest pinned line still showing (a line sliding away goes under the one above)
    [...inner.children].forEach((row, i) => {
      off = Math.min(off, top(pick[i].e) - (y0 + (i + 1) * lh));
      row.style.transform = off ? `translateY(${off}px)` : '';
      row.style.zIndex = String(max - i);
      bottom = Math.max(bottom, (i + 1) * lh + off);
    });
    inner.style.height = `${Math.max(0, bottom)}px`;
    inner.style.width = `${pre.scrollWidth}px`;
    box.classList.toggle('on', pick.length > 0);
  }
  inner.addEventListener('click', (e) => {
    if (e.target.closest('.tk-link')) return;
    const row = e.target.closest('.row');
    if (!row) return;
    const i = [...inner.children].indexOf(row);
    const n = +row.dataset.line;
    const lh = rows()[0]?.offsetHeight || 19;
    scroller.scrollTop = pre.offsetTop + top(n) - i * lh;
    onPick?.(n);
  });
  scroller.addEventListener('scroll', update, { passive: true });
  pre.addEventListener('og-fold', () => { visible = null; update(); });
  new MutationObserver(() => { visible = null; update(); }).observe(pre, { childList: true });
  // next frame: updating inside the callback resizes the pinned lines, which would loop the observer
  new ResizeObserver(() => { visible = null; requestAnimationFrame(update); }).observe(scroller);
  return { update, setEnabled(on) { enabled = on; update(); }, el: inner, get lines() { return picked.map((r) => r.s); } };
}
