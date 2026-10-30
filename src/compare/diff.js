// OG Code Compare: the diff engine. Pure functions (no DOM, no network), so they run in the tests too.
//
//  lineKeys(lines, opts)        what two lines are compared by (ignore whitespace / case / comments)
//  diffLines(aKeys, bKeys)      [[op, ai, bi]]: op 0 = same, 1 = only in A (removed), 2 = only in B (added)
//                               patience diff (unique lines anchor the match) + an exact LCS for the gaps
//  alignRows(ops)               rows for a side-by-side view, with change blocks
//  findMoves(rows, aKeys, bKeys) sections removed in one place and added in another: "moved", not changed
//  wordDiff(a, b)               the changed character ranges inside a pair of changed lines
//  unifiedDiff(...)             the classic "--- a / +++ b / @@" text, for sharing
//  methodSummary(aFile, bFile)  Apex: methods added / removed / changed / moved

// ---------- what lines are compared by ----------

/** opts: { ignoreWhitespace, ignoreCase, ignoreComments, lang: 'apex' | 'js' | 'css' | 'markup' } */
export function lineKeys(lines, opts = {}) {
  let block = false;
  return lines.map((raw) => {
    let s = raw.replace(/\r$/, '');
    if (opts.ignoreComments) {
      const r = stripComments(s, block, opts.lang);
      s = r.text;
      block = r.block;
    }
    s = opts.ignoreWhitespace ? s.replace(/\s+/g, ' ').trim() : s.replace(/\s+$/, '');
    return opts.ignoreCase ? s.toLowerCase() : s;
  });
}

function stripComments(line, block, lang) {
  if (lang === 'markup') {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (block) { const e = line.indexOf('-->', i); if (e < 0) return { text: out, block: true }; i = e + 3; block = false; continue; }
      const s = line.indexOf('<!--', i);
      if (s < 0) { out += line.slice(i); break; }
      out += line.slice(i, s);
      i = s + 4;
      block = true;
    }
    return { text: out, block };
  }
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (block) { const e = line.indexOf('*/', i); if (e < 0) return { text: out, block: true }; i = e + 2; block = false; continue; }
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') { // strings stay (a // inside a string isn't a comment)
      let j = i + 1;
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
      out += line.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '/' && line[i + 1] === '*') { block = true; i += 2; continue; }
    out += c;
    i++;
  }
  return { text: out, block };
}

// ---------- the line diff ----------

const LCS_CELLS = 2_000_000; // bigger gaps (rare after patience anchors) fall back to remove-all / add-all

export function diffLines(aKeys, bKeys) {
  const ids = new Map();
  const id = (k) => { let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
  const A = aKeys.map(id);
  const B = bKeys.map(id);
  const out = [];
  const rec = (a0, a1, b0, b1) => {
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) { out.push([0, a0, b0]); a0++; b0++; }
    const tail = [];
    while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) { a1--; b1--; tail.push([0, a1, b1]); }
    if (a0 === a1) for (let j = b0; j < b1; j++) out.push([2, null, j]);
    else if (b0 === b1) for (let i = a0; i < a1; i++) out.push([1, i, null]);
    else {
      const anchors = uniqueAnchors(A, B, a0, a1, b0, b1);
      if (anchors.length) {
        let pa = a0;
        let pb = b0;
        for (const [i, j] of anchors) { rec(pa, i, pb, j); out.push([0, i, j]); pa = i + 1; pb = j + 1; }
        rec(pa, a1, pb, b1);
      } else lcs(A, B, a0, a1, b0, b1, out);
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
  };
  rec(0, A.length, 0, B.length);
  return out;
}

// lines that appear exactly once on both sides, in an order both sides agree on (longest increasing run)
function uniqueAnchors(A, B, a0, a1, b0, b1) {
  const ca = new Map();
  for (let i = a0; i < a1; i++) { const v = ca.get(A[i]); ca.set(A[i], v === undefined ? i : -1); }
  const cb = new Map();
  for (let j = b0; j < b1; j++) { const v = cb.get(B[j]); cb.set(B[j], v === undefined ? j : -1); }
  const pairs = [];
  for (let i = a0; i < a1; i++) {
    const ai = ca.get(A[i]);
    const bj = cb.get(A[i]);
    if (ai === i && bj !== undefined && bj >= 0) pairs.push([i, bj]);
  }
  if (!pairs.length) return [];
  // longest increasing subsequence on j (patience sorting)
  const tails = [];
  const prev = new Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const res = [];
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) res.push(pairs[k]);
  return res.reverse();
}

function lcs(A, B, a0, a1, b0, b1, out) {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n * m > LCS_CELLS) {
    for (let i = a0; i < a1; i++) out.push([1, i, null]);
    for (let j = b0; j < b1; j++) out.push([2, null, j]);
    return;
  }
  const w = m + 1;
  const L = new Int32Array((n + 1) * w); // L[i][j]: LCS of A[a0+i..] and B[b0+j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[a0 + i] === B[b0 + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[a0 + i] === B[b0 + j]) { out.push([0, a0 + i, b0 + j]); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { out.push([1, a0 + i, null]); i++; }
    else { out.push([2, null, b0 + j]); j++; }
  }
  for (; i < n; i++) out.push([1, a0 + i, null]);
  for (; j < m; j++) out.push([2, null, b0 + j]);
}

// ---------- rows for the view ----------

/**
 * rows: [{ kind: 'eq' | 'chg' | 'del' | 'ins', a, b, block }] (a / b: 0-based line index or null)
 * blocks: [{ id, from, to }] row ranges of each change. Removed and added lines of one change sit side by side.
 */
export function alignRows(ops) {
  const rows = [];
  const blocks = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === 0) { rows.push({ kind: 'eq', a: ops[k][1], b: ops[k][2], block: -1 }); k++; continue; }
    const dels = [];
    const ins = [];
    while (k < ops.length && ops[k][0] !== 0) { if (ops[k][0] === 1) dels.push(ops[k][1]); else ins.push(ops[k][2]); k++; }
    const id = blocks.length;
    const from = rows.length;
    const n = Math.max(dels.length, ins.length);
    for (let i = 0; i < n; i++) {
      const a = i < dels.length ? dels[i] : null;
      const b = i < ins.length ? ins[i] : null;
      rows.push({ kind: a != null && b != null ? 'chg' : a != null ? 'del' : 'ins', a, b, block: id });
    }
    blocks.push({ id, from, to: rows.length - 1 });
  }
  return { rows, blocks };
}

// ---------- moved sections ----------

const TRIVIAL = /^[\s{}()[\];,]*$|^(else|try|finally|return;?|break;|continue;)$/i;

/**
 * Sections removed in one place and added in another (compared with whitespace ignored, so a re-indented block
 * still counts). Returns { moves: [{ id, a0, a1, b0, b1 }], aMove: Map(aLine → move), bMove: Map(bLine → move) }.
 * A section counts when it has 2+ meaningful lines, or 1 long one (30+ characters).
 */
export function findMoves(rows, aLines, bLines) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const removed = new Set();
  const added = new Set();
  const blockA = new Map(); // which change a line belongs to: a line edited in place isn't "moved"
  const blockB = new Map();
  for (const r of rows) {
    if (r.kind === 'del' || r.kind === 'chg') { removed.add(r.a); blockA.set(r.a, r.block); }
    if (r.kind === 'ins' || r.kind === 'chg') { added.add(r.b); blockB.set(r.b, r.block); }
  }
  // candidates are found by a line's first two words, so a moved line that was also edited a little
  // (a renamed variable, an added argument) still matches
  const head = (k) => (k.match(/[\w$.@]+|[^\s\w]/g) || []).slice(0, 2).join(' ');
  const byHead = new Map();
  for (const j of [...added].sort((x, y) => x - y)) {
    const k = norm(bLines[j]);
    if (!k || TRIVIAL.test(k)) continue;
    const hk = head(k);
    if (!byHead.has(hk)) byHead.set(hk, []);
    byHead.get(hk).push(j);
  }
  const alike = (x, y) => x === y || (!TRIVIAL.test(x) && !TRIVIAL.test(y) && similarity(x, y) >= 0.75);
  const usedB = new Set();
  const moves = [];
  const aMove = new Map();
  const bMove = new Map();
  const aSorted = [...removed].sort((x, y) => x - y);
  for (let p = 0; p < aSorted.length;) {
    const i = aSorted[p];
    const k = norm(aLines[i]);
    let best = null;
    if (k && !TRIVIAL.test(k)) {
      for (const j of byHead.get(head(k)) || []) {
        if (usedB.has(j) || blockB.get(j) === blockA.get(i) || !alike(k, norm(bLines[j]))) continue;
        let len = 0;
        let meaningful = 0;
        let exact = 0; // a moved section keeps at least one meaningful line exactly as it was
        let chars = 0;
        while (removed.has(i + len) && added.has(j + len) && !usedB.has(j + len) && alike(norm(aLines[i + len] ?? '\0'), norm(bLines[j + len] ?? '\u0001'))) {
          const t = norm(aLines[i + len]);
          if (t && !TRIVIAL.test(t)) { meaningful++; chars += t.length; if (t === norm(bLines[j + len])) exact++; }
          len++;
        }
        if (len && exact && (!best || exact > best.exact || (exact === best.exact && meaningful > best.meaningful))) best = { j, len, meaningful, chars, exact };
      }
    }
    if (best && (best.meaningful >= 2 || best.chars >= 30)) {
      const mv = { id: moves.length, a0: i, a1: i + best.len - 1, b0: best.j, b1: best.j + best.len - 1 };
      moves.push(mv);
      for (let d = 0; d < best.len; d++) { aMove.set(i + d, mv); bMove.set(best.j + d, mv); usedB.add(best.j + d); }
      while (p < aSorted.length && aSorted[p] <= mv.a1) p++;
    } else p++;
  }
  return { moves, aMove, bMove };
}

// how alike two lines are: shared words and symbols (Dice coefficient, 0..1)
export function similarity(x, y) {
  const tx = x.match(/\w+|[^\s\w]/g) || [];
  const ty = y.match(/\w+|[^\s\w]/g) || [];
  if (!tx.length || !ty.length) return 0;
  const count = new Map();
  for (const t of tx) count.set(t, (count.get(t) || 0) + 1);
  let common = 0;
  for (const t of ty) { const c = count.get(t); if (c) { common++; count.set(t, c - 1); } }
  return (2 * common) / (tx.length + ty.length);
}

// ---------- words inside a changed line ----------

/** { a: [[start, end]], b: [[start, end]], similar } character ranges that differ; similar = the lines share most of their text. */
export function wordDiff(a, b) {
  const ta = a.match(/\w+|\s+|[^\w\s]/g) || [];
  const tb = b.match(/\w+|\s+|[^\w\s]/g) || [];
  if (ta.length * tb.length > 160_000) return { a: [[0, a.length]], b: [[0, b.length]], similar: false };
  const n = ta.length;
  const m = tb.length;
  const w = m + 1;
  const L = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = ta[i] === tb[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const ra = [];
  const rb = [];
  const push = (list, s, e) => { if (e <= s) return; const last = list[list.length - 1]; if (last && last[1] === s) last[1] = e; else list.push([s, e]); };
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let same = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { same += ta[i].trim() ? ta[i].length : 0; pa += ta[i].length; pb += tb[j].length; i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) { push(ra, pa, pa + ta[i].length); pa += ta[i].length; i++; }
    else { push(rb, pb, pb + tb[j].length); pb += tb[j].length; j++; }
  }
  for (; i < n; i++) { push(ra, pa, pa + ta[i].length); pa += ta[i].length; }
  for (; j < m; j++) { push(rb, pb, pb + tb[j].length); pb += tb[j].length; }
  const total = Math.max(1, a.replace(/\s/g, '').length + b.replace(/\s/g, '').length);
  return { a: ra, b: rb, similar: (2 * same) / total >= 0.35 };
}

// ---------- unified diff text ----------

/** The classic unified diff ("--- a" / "+++ b" / "@@ -1,4 +1,5 @@"), `context` lines around each change. */
export function unifiedDiff(aLines, bLines, ops, { aName = 'a', bName = 'b', context = 3 } = {}) {
  const out = [`--- ${aName}`, `+++ ${bName}`];
  const changed = ops.map((o) => o[0] !== 0);
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) { k++; continue; }
    let start = Math.max(0, k - context);
    let end = k;
    // extend the hunk while the next change is within 2 × context lines
    for (;;) {
      while (end < ops.length && changed[end]) end++;
      let next = end;
      while (next < ops.length && !changed[next] && next - end < 2 * context) next++;
      if (next < ops.length && changed[next]) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, stop);
    const aStart = hunk.find((o) => o[1] != null)?.[1] ?? 0;
    const bStart = hunk.find((o) => o[2] != null)?.[2] ?? 0;
    const aCount = hunk.filter((o) => o[0] !== 2).length;
    const bCount = hunk.filter((o) => o[0] !== 1).length;
    out.push(`@@ -${aCount ? aStart + 1 : aStart},${aCount} +${bCount ? bStart + 1 : bStart},${bCount} @@`);
    for (const [op, a, b] of hunk) out.push(op === 0 ? ` ${aLines[a]}` : op === 1 ? `-${aLines[a]}` : `+${bLines[b]}`);
    k = stop;
    start = stop;
  }
  return out.join('\n');
}

// ---------- Apex: what happened to each method ----------

const sigKey = (m) => `${m.type?.display || ''}.${m.kind === 'constructor' ? '<init>' : m.name}(${(m.paramTypes || []).join(',')})`.toLowerCase();

/**
 * aFile / bFile: parsed Apex files (src/apex/parser.js). keyOf(lines) → comparable text of a method body.
 * eqA (optional): A's 0-based lines the line diff matched as unchanged; the methods kept in place are the ones
 * with most of those (so the one that really moved is the one called "moved").
 * Returns [{ key, label, status: 'same' | 'changed' | 'added' | 'removed' | 'moved' | 'moved+changed', a, b }],
 * a / b: { startLine, endLine } (1-based) on each side.
 */
export function methodSummary(aFile, bFile, keyOf, eqA = null) {
  const callable = (f) => (f?.methods || []).filter((m) => m.kind === 'method' || m.kind === 'constructor')
    .map((m) => ({ m, key: sigKey(withTypes(m)) }));
  const A = callable(aFile);
  const B = callable(bFile);
  const bByKey = new Map(B.map((x) => [x.key, x]));
  const aByKey = new Map(A.map((x) => [x.key, x]));
  const body = (f, m) => keyOf(f.unit.body.split('\n').slice(m.startLine - 1, m.endLine)).join('\n');
  // order: methods present on both sides that are out of order are "moved"
  const common = A.filter((x) => bByKey.has(x.key));
  const order = common.map((x) => B.indexOf(bByKey.get(x.key)));
  const weight = common.map((x) => {
    if (!eqA) return 1;
    let n = 1;
    for (let l = x.m.startLine - 1; l < x.m.endLine; l++) if (eqA.has(l)) n++;
    return n;
  });
  const keep = new Set(heaviestIncreasing(order, weight).map((i) => common[i].key));
  const out = [];
  const label = (m) => (m.kind === 'constructor' ? `new ${m.type?.display || ''}()` : `${m.name}(${(m.paramTypes || []).join(', ')})`);
  for (const x of A) {
    const y = bByKey.get(x.key);
    const span = (m) => ({ startLine: m.startLine, endLine: m.endLine });
    if (!y) { out.push({ key: x.key, label: label(x.m), status: 'removed', a: span(x.m), b: null }); continue; }
    const changed = body(aFile, x.m) !== body(bFile, y.m);
    const moved = !keep.has(x.key);
    out.push({ key: x.key, label: label(x.m), status: moved ? (changed ? 'moved+changed' : 'moved') : changed ? 'changed' : 'same', a: span(x.m), b: span(y.m) });
  }
  for (const y of B) if (!aByKey.has(y.key)) out.push({ key: y.key, label: label(y.m), status: 'added', a: null, b: { startLine: y.m.startLine, endLine: y.m.endLine } });
  return out;
}

// parameter types of a method, from its tokens (names dropped: renaming a parameter isn't a new method)
function withTypes(m) {
  if (m.paramTypes) return m;
  const toks = m.file?.toks?.slice(m.paramOpen + 1, m.paramClose) || [];
  const types = [];
  let cur = [];
  let depth = 0;
  for (const t of toks) {
    if (t.v === '<') depth++;
    if (t.v === '>') depth--;
    if (t.v === ',' && depth === 0) { types.push(cur); cur = []; continue; }
    if (t.type === 'annot' || t.lv === 'final') continue;
    cur.push(t.v);
  }
  if (cur.length) types.push(cur);
  m.paramTypes = types.map((p) => p.slice(0, -1).join('')).filter(Boolean); // the last token is the parameter's name
  return m;
}

// the increasing subsequence of `arr` with the largest total weight (methods are few: O(n²) is fine)
function heaviestIncreasing(arr, weight) {
  const best = arr.map((_, k) => weight[k]);
  const prev = arr.map(() => -1);
  for (let k = 0; k < arr.length; k++) {
    for (let i = 0; i < k; i++) if (arr[i] < arr[k] && best[i] + weight[k] > best[k]) { best[k] = best[i] + weight[k]; prev[k] = i; }
  }
  let end = -1;
  for (let k = 0; k < arr.length; k++) if (end < 0 || best[k] > best[end]) end = k;
  const res = [];
  for (let k = end; k >= 0; k = prev[k]) res.push(k);
  return res.reverse();
}

// ---------- fingerprints (is it the same code?) ----------

/** A short hash of a text, line endings and trailing spaces ignored. */
export function fingerprint(text) {
  const s = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ':' + s.length;
}
