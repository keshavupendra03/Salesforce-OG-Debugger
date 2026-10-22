// Clickable code: which names in a file go somewhere (a method it calls, a class it uses, a component it
// includes) and what happens when you hover, click, Ctrl+click or Alt+click one. Shared by OG Explorer and
// the code panels of Code Flow and Debug Logs, so the code behaves the same everywhere.
//
// link: { id, line, col, len, kind, possible, targets: [target] }
// target: { type: 'method', id } | { type: 'type', key } | { type: 'doc', key }   (doc keys: 'lwc:name', 'aura:name', 'vfcomp:name')

import { h, esc } from '../dom.js';
import { highlight } from '../apex/highlight.js';

const TYPE_SKIP_BEFORE = new Set(['class', 'interface', 'enum', '.']);

function table(entries) {
  const list = [];
  const byLine = new Map();
  for (const l of entries) {
    l.id = list.length;
    list.push(l);
    if (!byLine.has(l.line)) byLine.set(l.line, new Map());
    byLine.get(l.line).set(l.col, l.id);
  }
  return { list, byLine };
}

/** Links in a parsed Apex file, from the call graph (the same resolution Code Flow uses) plus type names. */
export function apexLinks(index, file) {
  const toks = file.toks;
  const byTok = new Map();
  for (const m of file.methods) {
    for (const e of index.calleesOf.get(m.id) || []) {
      if (e.kind === 'async') continue; // new MyJob(): the constructor, not the platform's execute()
      let l = byTok.get(e.tok);
      if (!l) byTok.set(e.tok, (l = { kind: e.kind === 'new' ? 'new' : 'call', targets: [], possible: true }));
      if (!l.targets.some((t) => t.id === e.to)) l.targets.push({ type: 'method', id: e.to, dispatch: e.kind === 'dispatch' });
      if (e.kind !== 'guess') l.possible = false;
    }
  }
  // class names: Foo.bar(), new Foo(), Foo x, List<Foo>, extends / implements Foo, (Foo) casts
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'id' || byTok.has(i) || file.inSoql?.[i]) continue;
    const types = (index.typesByShortName.get(t.lv) || []).filter((x) => x.kind !== 'trigger');
    if (!types.length) continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (prev && TYPE_SKIP_BEFORE.has(prev.lv ?? prev.v)) continue;
    const ok = next?.v === '.' || ['new', 'extends', 'implements'].includes(prev?.lv)
      || (next?.type === 'id' && !['instanceof'].includes(next.lv))
      || ((prev?.v === '<' || prev?.v === ',') && (next?.v === '>' || next?.v === ','))
      || (prev?.v === '(' && next?.v === ')') || next?.v === '[';
    if (!ok) continue;
    const top = types.filter((x) => !x.outer);
    byTok.set(i, { kind: 'type', possible: false, targets: (top.length ? top : types).slice(0, 8).map((x) => ({ type: 'type', key: x.key })) });
  }
  return table([...byTok].map(([tok, l]) => ({ ...l, line: toks[tok].line, col: toks[tok].col, len: toks[tok].v.length })));
}

/**
 * Links in LWC / Aura / Visualforce files. doc: { kind: 'lwc' | 'aura' | 'vfpage' | 'vfcomp', files: [{ name, text }] }
 * ctx: { method(className, name) → id | null, type(name) → key | null, doc(key) → bool }
 * Returns one table per file (same order as doc.files).
 */
export function componentLinks(doc, ctx) {
  const all = doc.files.map((f) => f.text).join('\n');
  // the Apex classes behind an Aura component / Visualforce page
  const controllers = [];
  for (const m of all.matchAll(/\b(controller|extensions)\s*=\s*["']([^"']+)["']/gi)) {
    for (const c of m[2].split(',')) controllers.push(c.trim().split('.').pop());
  }
  const inController = (name) => {
    for (const c of controllers) {
      const id = ctx.method(c, name) || (/^[a-z]/.test(name) ? ctx.method(c, `get${name[0].toUpperCase()}${name.slice(1)}`) : null);
      if (id) return id;
    }
    return null;
  };
  return doc.files.map((f) => {
    const entries = [];
    f.text.split('\n').forEach((line, i) => {
      const add = (col, len, targets, kind) => { if (targets.length) entries.push({ line: i + 1, col, len, kind, possible: false, targets }); };
      const scan = (re, fn) => { for (const m of line.matchAll(re)) fn(m); };
      // LWC: import x from '@salesforce/apex/Class.method'  ·  import Child from 'c/child'  ·  <c-child-card>
      scan(/@salesforce\/apex\/(?:\w+\.)?(\w+)\.(\w+)/g, (m) => {
        const id = ctx.method(m[1], m[2]);
        add(m.index + m[0].length - m[1].length - m[2].length - 1, m[1].length + 1 + m[2].length, id ? [{ type: 'method', id }] : [], 'apex');
      });
      scan(/from\s+['"]c\/(\w+)['"]/g, (m) => { if (ctx.doc(`lwc:${m[1].toLowerCase()}`)) add(m.index + m[0].indexOf('c/') + 2, m[1].length, [{ type: 'doc', key: `lwc:${m[1].toLowerCase()}` }], 'component'); });
      scan(/<c-([a-z0-9-]+)/g, (m) => {
        const name = m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()).toLowerCase();
        if (ctx.doc(`lwc:${name}`)) add(m.index + 1, m[1].length + 2, [{ type: 'doc', key: `lwc:${name}` }], 'component');
      });
      // Aura / Visualforce: <c:Comp>, controller="X", extensions="X,Y", c.method, {!method}
      scan(/<c:(\w+)/g, (m) => {
        const key = doc.kind === 'aura' ? `aura:${m[1].toLowerCase()}` : `vfcomp:${m[1].toLowerCase()}`;
        if (ctx.doc(key)) add(m.index + 3, m[1].length, [{ type: 'doc', key }], 'component');
      });
      scan(/\b(controller|extensions)\s*=\s*["']([^"']+)["']/gi, (m) => {
        let pos = m.index + m[0].indexOf(m[2]);
        for (const part of m[2].split(',')) {
          const name = part.trim();
          const key = ctx.type(name.split('.').pop());
          if (key) add(pos + part.indexOf(name), name.length, [{ type: 'type', key }], 'type');
          pos += part.length + 1;
        }
      });
      if (doc.kind === 'aura') scan(/["']c\.(\w+)["']/g, (m) => { const id = inController(m[1]); if (id) add(m.index + 3, m[1].length, [{ type: 'method', id }], 'call'); });
      if (doc.kind === 'vfpage' || doc.kind === 'vfcomp') scan(/\{!\s*(\w+)\s*(?=[}(.])/g, (m) => { const id = inController(m[1]); if (id) add(m.index + m[0].indexOf(m[1]), m[1].length, [{ type: 'method', id }], 'call'); });
    });
    return table(entries);
  });
}

/** One line of plain (non-Apex) code with its links (cols: Map col → link id, list: the links): HTML. */
export function linkify(text, cols, list) {
  if (!cols?.size) return esc(text) || ' ';
  let out = '';
  let pos = 0;
  for (const [col, id] of [...cols].sort((a, b) => a[0] - b[0])) {
    if (col < pos) continue;
    const len = list[id].len;
    out += esc(text.slice(pos, col));
    out += `<span class="tk-link" data-link="${id}">${esc(text.substr(col, len))}</span>`;
    pos = col + len;
  }
  return out + esc(text.slice(pos)) || ' ';
}

// ---------- describing and peeking Apex targets ----------

/** "normalizeIndustry(List<Account> accounts)" */
export function signature(m) {
  if (m.paramOpen < 0) return m.label;
  // tokens back to text: a space between two words, and after '>' / ']' before a word (List<Account> accounts)
  let params = '';
  let prev = null;
  for (const t of m.file.toks.slice(m.paramOpen + 1, m.paramClose)) {
    if (t.type === 'annot' || t.lv === 'final') continue;
    const word = t.type === 'id';
    if (t.v === ',') params += ', ';
    else params += (prev && word && (prev.type === 'id' || prev.v === '>' || prev.v === ']') ? ' ' : '') + t.v;
    prev = t;
  }
  const name = m.kind === 'constructor' ? `new ${m.type.display}` : `${m.type.display}.${m.name}`;
  return `${name}(${params})`;
}

/** Highlighted Apex rows for a line range, links included (wired by the caller). */
export function apexRows(file, links, from, to, rowClass = () => '') {
  const lines = file.unit.body.split('\n');
  const pre = h('pre', { class: 'src' });
  let inBlock = false;
  const st = { depth: 0 };
  for (let n = 1; n < from; n++) inBlock = highlight(lines[n - 1] ?? '', inBlock, null, null, st).inBlock;
  for (let n = from; n <= Math.min(to, lines.length); n++) {
    const r = highlight(lines[n - 1] ?? '', inBlock, null, links?.byLine.get(n), st);
    inBlock = r.inBlock;
    const txt = h('span', { class: 'txt' });
    txt.innerHTML = r.html || ' ';
    pre.append(h('div', { class: `row${rowClass(n) ? ` ${rowClass(n)}` : ''}`, 'data-line': n }, h('span', { class: 'gutter' }, n), txt));
  }
  return pre;
}

/**
 * Hover / click / peek for Apex targets, given the index. open(target, { newTab }) is the caller's navigation.
 * describe(target) → { title, sub, preview: [lines], from }; peek(target) → element or null.
 */
export function apexHandlers(index, { open, linksOf }) {
  const M = (id) => index.methodsById.get(id);
  const T = (key) => index.types.get(key);
  const where = (unit, line) => `${unit.name}.${unit.kind === 'trigger' ? 'trigger' : 'cls'}, line ${line}`;
  const handlers = {
    open,
    describe(t) {
      if (t.type === 'method') {
        const m = M(t.id);
        if (!m) return null;
        const lines = m.file.unit.body.split('\n');
        return { title: signature(m), sub: `${where(m.file.unit, m.startLine)}${t.dispatch ? ' · through an interface / virtual call' : ''}`, preview: lines.slice(m.startLine - 1, m.startLine + 5), from: m.startLine };
      }
      if (t.type === 'type') {
        const ty = T(t.key);
        if (!ty) return null;
        const lines = ty.file.unit.body.split('\n');
        return { title: `${ty.kind} ${ty.display}`, sub: where(ty.file.unit, ty.line || 1), preview: lines.slice((ty.line || 1) - 1, (ty.line || 1) + 5), from: ty.line || 1 };
      }
      return null;
    },
    peek(t) {
      const m = t.type === 'method' ? M(t.id) : null;
      const ty = t.type === 'type' ? T(t.key) : null;
      const file = m?.file || ty?.file;
      if (!file) return null;
      const from = m ? m.startLine : ty.line || 1;
      const to = m ? Math.min(m.endLine, m.startLine + 80) : Math.min(from + 40, file.unit.body.split('\n').length);
      const pre = apexRows(file, linksOf(file), from, to);
      wireLinks(pre, linksOf(file), handlers);
      return pre;
    },
  };
  return handlers;
}

// ---------- the interactions ----------

let card = null;
let cardT = 0;
const hideCard = () => { clearTimeout(cardT); card?.remove(); card = null; };
let menu = null;
const closeMenu = () => { menu?.remove(); menu = null; };

function showCard(el, link, handlers) {
  hideCard();
  const infos = link.targets.map((t) => handlers.describe?.(t)).filter(Boolean);
  if (!infos.length) return;
  const one = infos[0];
  card = h('div', { class: 'cl-card', role: 'tooltip' },
    infos.length > 1
      ? [h('b', {}, `${infos.length} possible targets`), h('small', {}, 'Called through an interface or a virtual method. Click to choose.'),
        h('ul', {}, infos.slice(0, 6).map((x) => h('li', {}, x.title)))]
      : [h('b', {}, one.title), h('small', {}, one.sub), one.preview?.length ? h('pre', {}, one.preview.join('\n')) : null],
    link.possible ? h('small', { class: 'cl-possible' }, 'Matched by name only: the receiver’s type isn’t known') : null,
    h('small', { class: 'cl-keys' }, 'Click to open · Alt+click to peek here · Ctrl+click in a new tab'));
  document.body.append(card);
  const r = el.getBoundingClientRect();
  const w = card.offsetWidth;
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  const below = r.bottom + 6 + card.offsetHeight < innerHeight;
  card.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - card.offsetHeight - 6)}px`;
}

function choose(el, link, handlers, then) {
  closeMenu();
  menu = h('div', { class: 'dx-pop cl-menu', role: 'menu' },
    h('div', { class: 'cl-menu-head' }, 'Which one?'),
    link.targets.map((t) => {
      const d = handlers.describe?.(t);
      return h('button', { class: 'dx-mi', role: 'menuitem', onclick: () => { closeMenu(); then(t); } }, h('span', {}, d?.title || 'target'), h('span', { class: 'dx-mi-hint' }, d?.sub || ''));
    }));
  document.body.append(menu);
  const r = el.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 4}px`;
  setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!menu?.contains(e.target)) closeMenu(); }, { once: true, capture: true }));
}

function togglePeek(el, link, target, handlers) {
  const row = el.closest('.row');
  if (!row) return;
  const key = `${target.type}:${target.id || target.key}`;
  const next = row.nextElementSibling;
  if (next?.classList.contains('cl-peek')) {
    const same = next.dataset.key === key;
    next.remove();
    if (same) return;
  }
  const body = handlers.peek?.(target);
  if (!body) { handlers.open?.(target, {}); return; }
  const d = handlers.describe?.(target);
  const box = h('div', { class: 'cl-peek', 'data-key': key },
    h('div', { class: 'cl-peek-head' },
      h('b', {}, d?.title || ''), h('small', {}, d?.sub || ''), h('span', { class: 'cl-grow' }),
      h('button', { class: 'ghost small', onclick: () => handlers.open?.(target, {}) }, 'Open'),
      h('button', { class: 'cl-x', title: 'Close the peek', 'aria-label': 'Close the peek', onclick: () => box.remove() }, '×')),
    h('div', { class: 'cl-peek-body' }, body));
  row.after(box);
}

/** Hover, click, Ctrl+click and Alt+click on the links inside `container`. Safe to call once per render. */
export function wireLinks(container, links, handlers) {
  if (!links?.list.length || container.dataset.linked) return;
  container.dataset.linked = '1';
  const linkOf = (el) => links.list[+el.dataset.link];
  // a peek's own code is wired separately and handles its links first (stopPropagation), so each
  // listener only ever sees links of its own block
  container.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.tk-link');
    if (!el) return;
    e.stopPropagation();
    clearTimeout(cardT);
    cardT = setTimeout(() => showCard(el, linkOf(el), handlers), 380);
  });
  container.addEventListener('mouseout', (e) => { if (e.target.closest?.('.tk-link')) { clearTimeout(cardT); setTimeout(() => { if (!card?.matches(':hover')) hideCard(); }, 120); } });
  container.addEventListener('click', (e) => {
    const el = e.target.closest?.('.tk-link');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    hideCard();
    const link = linkOf(el);
    const go = (t) => {
      if (e.altKey) togglePeek(el, link, t, handlers);
      else handlers.open?.(t, { newTab: e.ctrlKey || e.metaKey });
    };
    if (link.targets.length > 1) choose(el, link, handlers, go);
    else go(link.targets[0]);
  });
  container.addEventListener('auxclick', (e) => {
    const el = e.target.closest?.('.tk-link');
    if (!el || e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    handlers.open?.(linkOf(el).targets[0], { newTab: true });
  });
}
