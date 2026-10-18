// Line-by-line Apex syntax highlighter. Returns HTML plus whether a /* block comment */ is still open.
// `cols` (optional Set of column offsets) marks exact tokens to emphasise.

import { esc } from '../dom.js';

const KW = new Set(('abstract break catch class continue do else enum extends final finally for global if implements ' +
  'instanceof interface new null override private protected public return static super switch this throw ' +
  'transient true false try virtual void webservice when while with without sharing inherited trigger on ' +
  'insert update upsert delete undelete merge before after select from where and or not in like limit order by ' +
  'group having asc desc nulls first last includes excludes typeof').split(' '));

export function highlight(line, inBlock, cols) {
  const mark = (idx) => (cols?.has(idx) ? ' tk-field' : '');
  let out = '';
  let i = 0;
  if (inBlock) {
    const end = line.indexOf('*/');
    if (end < 0) return { html: `<span class="tk-com">${esc(line)}</span>`, inBlock: true };
    out += `<span class="tk-com">${esc(line.slice(0, end + 2))}</span>`;
    i = end + 2;
  }
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
    } else if (mt[4]) out += `<span class="tk-annot">${esc(mt[4])}</span>`;
    else if (mt[5]) {
      const lw = mt[5].toLowerCase();
      if (mark(mt.index)) out += `<span class="tk-field">${esc(mt[5])}</span>`;
      else if (KW.has(lw)) out += `<span class="tk-kw">${esc(mt[5])}</span>`;
      else out += esc(mt[5]);
    } else out += esc(mt[0]);
    if (mt[0] === '') re.lastIndex++;
  }
  return { html: out, inBlock: false };
}
