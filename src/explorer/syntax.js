// Syntax colours for the non-Apex files OG Explorer shows: LWC / Aura JavaScript, CSS, and markup (LWC and Aura
// templates, Visualforce). Same token classes as the Apex highlighter (src/apex/highlight.js) plus tk-tag,
// tk-tagp (< / > around tags), tk-attr and tk-expr ({binding} / {!expression}), so every code theme styles them all.
// Clickable names (from code-links.js) are wrapped around the coloured text: <span class="tk-link" data-link>.

import { esc } from '../dom.js';

const JS_KW = new Set(('async await break case catch class const continue debugger default delete do else export extends ' +
  'finally for from function get if import in instanceof let new of return set static super switch this throw try ' +
  'typeof var void while with yield null undefined true false').split(' '));
const JS_LIT = new Set(['null', 'undefined', 'true', 'false']);
const JS_DECL = new Set(['const', 'let', 'var', 'class', 'function']);

function jsLine(line, st) {
  const segs = [];
  let i = 0;
  const n = line.length;
  if (st.block) {
    const e = line.indexOf('*/');
    if (e < 0) return [[0, n, 'tk-com']];
    segs.push([0, e + 2, 'tk-com']); i = e + 2; st.block = false;
  }
  if (st.tpl) {
    const e = closing(line, 0, '`');
    if (e < 0) return [[0, n, 'tk-str']];
    segs.push([0, e + 1, 'tk-str']); i = e + 1; st.tpl = false;
  }
  let prev = '';
  const re = /(\/\/.*$)|(\/\*)|('(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?)|(`)|(@[A-Za-z_]\w*)|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|([()[\]{}])|(\s+|.)/g;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(line))) {
    const s = m.index;
    if (m[1]) segs.push([s, n, 'tk-com']);
    else if (m[2]) {
      const e = line.indexOf('*/', s + 2);
      if (e < 0) { segs.push([s, n, 'tk-com']); st.block = true; break; }
      segs.push([s, e + 2, 'tk-com']); re.lastIndex = e + 2;
    } else if (m[3]) segs.push([s, re.lastIndex, 'tk-str']);
    else if (m[4]) {
      const e = closing(line, s + 1, '`');
      if (e < 0) { segs.push([s, n, 'tk-str']); st.tpl = true; break; }
      segs.push([s, e + 1, 'tk-str']); re.lastIndex = e + 1;
    } else if (m[5]) segs.push([s, re.lastIndex, 'tk-annot']);
    else if (m[6]) {
      const w = m[6];
      const next = /^\s*(.?)/.exec(line.slice(re.lastIndex))[1];
      const cls = JS_KW.has(w) ? `tk-kw${JS_LIT.has(w) ? ' tk-lit' : ''}`
        : next === '(' ? 'tk-fn'
          : JS_DECL.has(prev) ? 'tk-def'
            : /^[A-Z]/.test(w) ? 'tk-type' : '';
      if (cls) segs.push([s, re.lastIndex, cls]);
      prev = w;
      continue;
    } else if (m[7]) segs.push([s, re.lastIndex, 'tk-num']);
    else if (m[8]) segs.push([s, s + 1, bracket(m[8], st)]);
    if (!/^\s+$/.test(m[0])) prev = m[0];
  }
  return segs;
}

function closing(line, from, q) {
  for (let k = from; k < line.length; k++) {
    if (line[k] === '\\') { k++; continue; }
    if (line[k] === q) return k;
  }
  return -1;
}

function bracket(br, st) {
  const open = '([{'.includes(br);
  if (!open) st.depth = Math.max(0, st.depth - 1);
  const cls = `tk-b${st.depth % 3}`;
  if (open) st.depth++;
  return cls;
}

function markupLine(line, st) {
  const segs = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (st.comment) {
      const e = line.indexOf('-->', i);
      if (e < 0) { segs.push([i, n, 'tk-com']); return segs; }
      segs.push([i, e + 3, 'tk-com']); i = e + 3; st.comment = false; continue;
    }
    if (st.quote) {
      const e = line.indexOf(st.quote, i);
      if (e < 0) { segs.push([i, n, 'tk-str']); return segs; }
      segs.push([i, e + 1, 'tk-str']); i = e + 1; st.quote = null; continue;
    }
    if (st.tag) {
      const c = line[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '>' || (c === '/' && line[i + 1] === '>')) {
        const e = c === '>' ? i + 1 : i + 2;
        segs.push([i, e, 'tk-tagp']); i = e; st.tag = false; continue;
      }
      if (c === '"' || c === "'") {
        const e = line.indexOf(c, i + 1);
        if (e < 0) { segs.push([i, n, 'tk-str']); st.quote = c; return segs; }
        segs.push([i, e + 1, 'tk-str']); i = e + 1; continue;
      }
      if (c === '{') {
        const e = line.indexOf('}', i);
        const end = e < 0 ? n : e + 1;
        segs.push([i, end, 'tk-expr']); i = end; continue;
      }
      if (c === '=') { i++; continue; }
      const a = /^[^\s=>/"'{]+/.exec(line.slice(i));
      if (a) { segs.push([i, i + a[0].length, 'tk-attr']); i += a[0].length; continue; }
      i++; continue;
    }
    // text
    if (line.startsWith('<!--', i)) { st.comment = true; continue; }
    const t = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(line.slice(i));
    if (t) {
      const p = 1 + t[1].length;
      segs.push([i, i + p, 'tk-tagp'], [i + p, i + t[0].length, 'tk-tag']);
      i += t[0].length; st.tag = true; continue;
    }
    if (line[i] === '{') {
      const e = line.indexOf('}', i);
      if (e > i) { segs.push([i, e + 1, 'tk-expr']); i = e + 1; continue; }
    }
    i++;
  }
  return segs;
}

function cssLine(line, st) {
  const segs = [];
  let i = 0;
  const n = line.length;
  if (st.block) {
    const e = line.indexOf('*/');
    if (e < 0) return [[0, n, 'tk-com']];
    segs.push([0, e + 2, 'tk-com']); i = e + 2; st.block = false;
  }
  const re = /(\/\*)|('[^']*'?|"[^"]*"?)|(@[\w-]+)|(#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:[a-z%]+)?)|([.#][\w-]+)|(::?[\w-]+)|([\w-]+)|([{}()])|(\s+|.)/g;
  re.lastIndex = i;
  let m;
  while ((m = re.exec(line))) {
    const s = m.index;
    const e = re.lastIndex;
    if (m[1]) {
      const end = line.indexOf('*/', s + 2);
      if (end < 0) { segs.push([s, n, 'tk-com']); st.block = true; break; }
      segs.push([s, end + 2, 'tk-com']); re.lastIndex = end + 2;
    } else if (m[2]) segs.push([s, e, 'tk-str']);
    else if (m[3]) segs.push([s, e, 'tk-kw']);
    else if (m[4]) segs.push([s, e, 'tk-num']);
    else if (m[5]) segs.push([s, e, st.depth ? '' : 'tk-type']);
    else if (m[6]) segs.push([s, e, st.depth ? '' : 'tk-annot']);
    else if (m[7]) {
      const next = /^\s*(.?)/.exec(line.slice(e))[1];
      segs.push([s, e, next === '(' ? 'tk-fn' : st.depth ? (next === ':' ? 'tk-attr' : '') : 'tk-tag']);
    } else if (m[8]) segs.push([s, s + 1, bracket(m[8], st)]);
  }
  return segs;
}

// custom labels: LWC `@salesforce/label/c.Name`, Aura `$Label.c.Name`, Visualforce `$Label.Name`
const LABEL_RE = { js: /@salesforce\/label\/(\w+)\.(\w+)/g, markup: /\$Label\.(?:(\w+)\.)?(\w+)/g };
function labelsIn(line, lang) {
  const re = LABEL_RE[lang];
  if (!re || !line.includes('abel')) return [];
  return [...line.matchAll(re)].map((m) => {
    const name = m[2];
    const ns = m[1] && m[1] !== 'c' ? m[1] : '';
    return { col: m.index + m[0].length - name.length, len: name.length, name: ns ? `${ns}__${name}` : name };
  });
}

function render(line, segs, cols, list, labs = []) {
  if (!line) return ' ';
  const cls = new Array(line.length).fill('');
  for (const [s, e, c] of segs) for (let k = s; k < e && k < line.length; k++) cls[k] = c;
  const link = new Array(line.length).fill(-1);
  for (const [col, id] of cols || []) {
    const len = list[id]?.len || 0;
    for (let k = col; k < col + len && k < line.length; k++) if (link[k] < 0) link[k] = id;
  }
  const lab = new Array(line.length).fill(-1);
  labs.forEach((x, n) => { for (let k = x.col; k < x.col + x.len && k < line.length; k++) lab[k] = n; });
  let out = '';
  for (let k = 0; k < line.length;) {
    const L = link[k];
    const B = lab[k];
    let j = k;
    while (j < line.length && link[j] === L && lab[j] === B) j++;
    let inner = '';
    for (let a = k; a < j;) {
      let b = a;
      while (b < j && cls[b] === cls[a]) b++;
      const t = esc(line.slice(a, b));
      inner += cls[a] ? `<span class="${cls[a]}">${t}</span>` : t;
      a = b;
    }
    if (B >= 0) inner = `<span class="tk-label" data-label="${esc(labs[B].name)}">${inner}</span>`;
    out += L >= 0 ? `<span class="tk-link" data-link="${L}">${inner}</span>` : inner;
    k = j;
  }
  return out;
}

/** HTML for each line of `text` (lang: js, css or markup), with the clickable names in `links`. */
export function syntaxLines(text, lang, links) {
  const st = { depth: 0 };
  const fn = lang === 'js' ? jsLine : lang === 'css' ? cssLine : markupLine;
  return text.split('\n').map((line, i) => render(line, fn(line, st), links?.byLine.get(i + 1), links?.list || [], labelsIn(line, lang)));
}
