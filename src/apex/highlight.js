// Line-by-line Apex syntax highlighter. Returns HTML plus whether a /* block comment */ is still open.
// `cols` (optional Set of column offsets) marks exact tokens to emphasise.
// `links` (optional Map column → link id) makes identifiers clickable: <span class="tk-link" data-link="id">.
// `st` (optional { depth }) carries the bracket depth from line to line, for bracket-pair colours.
//
// Token classes: tk-kw (tk-lit for null / true / false), tk-str, tk-com, tk-annot, tk-num, tk-fn (a call or a
// method name), tk-type (a capitalised name), tk-bt (a built-in type), tk-def (a variable or parameter being
// declared), tk-b0..2 (brackets by depth). The default look only styles kw / str / com / annot; the code
// themes (Developer Console, VS Code) style the rest.

import { esc } from '../dom.js';

const KW = new Set(('abstract break catch class continue do else enum extends final finally for global if implements ' +
  'instanceof interface new null override private protected public return static super switch this throw ' +
  'transient true false try virtual void webservice when while with without sharing inherited trigger on ' +
  'insert update upsert delete undelete merge before after select from where and or not in like limit order by ' +
  'group having asc desc nulls first last includes excludes typeof').split(' '));
const LIT = new Set(['null', 'true', 'false']);
const BUILTIN = new Set(('string integer long double decimal boolean date datetime time id blob object list set map ' +
  'sobject type').split(' '));

export function highlight(line, inBlock, cols, links, st) {
  const mark = (idx) => (cols?.has(idx) ? ' tk-field' : '');
  const state = st || { depth: 0 };
  let out = '';
  let i = 0;
  if (inBlock) {
    const end = line.indexOf('*/');
    if (end < 0) return { html: `<span class="tk-com">${esc(line)}</span>`, inBlock: true };
    out += `<span class="tk-com">${esc(line.slice(0, end + 2))}</span>`;
    i = end + 2;
  }
  // what came before the current word: 'id' (a plain name), 'kw', or the last punctuation; and whether a
  // space separates them. `Type name` and `List<X> name` declare `name`.
  let prev = null;
  let spaced = false;
  // `Label.Name` / `System.Label.Name`: the name after `Label.` is a custom label (hover shows its value)
  let lastWord = null;
  let labelNext = false;
  const re = /(\/\/.*$)|(\/\*)|('(?:\\.|[^'\\])*'?)|(@[A-Za-z_]\w*)|([A-Za-z_]\w*)|([^A-Za-z_'@/]+|\/)/g;
  re.lastIndex = i;
  let mt;
  while ((mt = re.exec(line))) {
    if (mt[1]) out += `<span class="tk-com">${esc(mt[1])}</span>`;
    else if (mt[2]) {
      const end = line.indexOf('*/', mt.index + 2);
      if (end < 0) { out += `<span class="tk-com">${esc(line.slice(mt.index))}</span>`; return { html: out, inBlock: true }; }
      out += `<span class="tk-com">${esc(line.slice(mt.index, end + 2))}</span>`;
      re.lastIndex = end + 2;
    } else if (mt[3]) {
      out += `<span class="tk-str${mark(mt.index)}">${esc(mt[3])}</span>`;
      prev = 'str'; spaced = false;
    } else if (mt[4]) { out += `<span class="tk-annot">${esc(mt[4])}</span>`; prev = 'kw'; spaced = false; }
    else if (mt[5]) {
      const word = mt[5];
      const lw = word.toLowerCase();
      const next = /^\s*(.?)/.exec(line.slice(re.lastIndex))[1];
      let tok;
      if (mark(mt.index)) tok = `<span class="tk-field">${esc(word)}</span>`;
      else if (KW.has(lw)) tok = `<span class="tk-kw${LIT.has(lw) ? ' tk-lit' : ''}">${esc(word)}</span>`;
      else {
        const cls = next === '(' ? 'tk-fn'
          : spaced && (prev === 'id' || prev === '>' || prev === ']') && next !== '.' ? 'tk-def'
            : BUILTIN.has(lw) ? 'tk-bt'
              : /^[A-Z]/.test(word) ? 'tk-type' : '';
        tok = cls ? `<span class="${cls}">${esc(word)}</span>` : esc(word);
      }
      if (labelNext) tok = `<span class="tk-label" data-label="${esc(word)}">${tok}</span>`;
      const link = links?.get(mt.index);
      out += link != null ? `<span class="tk-link" data-link="${link}">${tok}</span>` : tok;
      prev = KW.has(lw) ? 'kw' : 'id';
      spaced = false;
      labelNext = false;
      lastWord = lw;
    } else {
      const chunk = mt[0];
      out += chunk.replace(/(\d+(?:\.\d+)?[lLdD]?)|([()[\]{}])|([^\d()[\]{}]+)/g, (m, num, br, rest) => {
        if (num) return `<span class="tk-num">${num}</span>`;
        if (br) {
          const open = '([{'.includes(br);
          if (!open) state.depth = Math.max(0, state.depth - 1);
          const html = `<span class="tk-b${state.depth % 3}">${br}</span>`;
          if (open) state.depth++;
          return html;
        }
        return esc(rest);
      });
      const t = chunk.trimEnd();
      if (t) {
        const last = t[t.length - 1];
        // `>` right after a name is a generic (`List<X> name`); with a space before it, a comparison
        prev = last === '>' ? (chunk[0] === ' ' ? 'gt' : '>') : last;
      }
      spaced = /\s$/.test(chunk);
      labelNext = lastWord === 'label' && chunk.trim() === '.';
      lastWord = null;
    }
    if (mt[0] === '') re.lastIndex++;
  }
  return { html: out, inBlock: false };
}
