// Minimal Apex tokenizer. Comments are dropped, strings are kept (dynamic SOQL / get('Field')),
// and every token carries a lowercase copy because Apex is case-insensitive.

const MULTI_OPS = ['===', '!==', '?.', '??', '==', '!=', '<=', '>=', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '&=', '|=', '^=', '=>'];
// '>>' is deliberately NOT combined so nested generics like List<Map<Id,Account>> parse cleanly.

const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdPart = (c) => isIdStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';

export function lex(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let ls = 0; // offset where the current line starts
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; ls = i; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') { line++; ls = i + 1; } i++; }
      i += 2;
      continue;
    }
    if (c === "'") {
      const startLine = line;
      const col = i - ls;
      let val = '';
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) { val += src[i + 1]; i += 2; continue; }
        if (src[i] === '\n') { line++; ls = i + 1; }
        val += src[i++];
      }
      i++;
      toks.push({ type: 'str', v: val, lv: val.toLowerCase(), line: startLine, col });
      continue;
    }
    if (c === '@' && isIdStart(src[i + 1] || '')) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      const v = src.slice(i + 1, j);
      toks.push({ type: 'annot', v, lv: v.toLowerCase(), line, col: i - ls });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      const v = src.slice(i, j);
      toks.push({ type: 'id', v, lv: v.toLowerCase(), line, col: i - ls });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.' && isDigit(src[j + 1] || '')) { j++; while (j < n && isDigit(src[j])) j++; }
      if (/[lLdD]/.test(src[j] || '')) j++;
      toks.push({ type: 'num', v: src.slice(i, j), lv: src.slice(i, j), line });
      i = j;
      continue;
    }
    let op = null;
    for (const m of MULTI_OPS) if (src.startsWith(m, i)) { op = m; break; }
    if (op) {
      const v = op === '?.' ? '.' : op; // treat safe navigation like a normal member access
      toks.push({ type: 'op', v, lv: v, line });
      i += op.length;
      continue;
    }
    toks.push({ type: 'op', v: c, lv: c, line });
    i++;
  }
  return toks;
}

// Pairs (), [] and {} so later passes can jump over whole blocks. Unmatched = -1.
export function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  const OPEN_FOR = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'op') continue;
    if (t.v === '(' || t.v === '[' || t.v === '{') stack.push(i);
    else if (OPEN_FOR[t.v]) {
      for (let s = stack.length - 1; s >= 0; s--) {
        if (toks[stack[s]].v === OPEN_FOR[t.v]) {
          match[i] = stack[s];
          match[stack[s]] = i;
          stack.length = s;
          break;
        }
      }
    }
  }
  return match;
}
