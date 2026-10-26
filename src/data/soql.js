// SOQL helpers for the Data Export view: tokenizer (highlighting), context-aware autocomplete,
// record ID detection, flattening query results into table rows, and CSV / TSV / JSON export.
// Pure functions: no DOM, no network, so they run in the tests too.

export const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE', 'INCLUDES', 'EXCLUDES', 'ORDER', 'BY', 'GROUP', 'HAVING',
  'LIMIT', 'OFFSET', 'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'NULL', 'TRUE', 'FALSE', 'WITH', 'SECURITY_ENFORCED',
  'USER_MODE', 'SYSTEM_MODE', 'FOR', 'VIEW', 'REFERENCE', 'UPDATE', 'TRACKING', 'VIEWSTAT', 'ALL', 'ROWS', 'TYPEOF',
  'WHEN', 'THEN', 'ELSE', 'END', 'USING', 'SCOPE', 'ROLLUP', 'CUBE', 'FORMAT',
];
const KW = new Set(KEYWORDS);

export const FUNCTIONS = ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX', 'FIELDS', 'toLabel', 'FORMAT', 'convertCurrency',
  'CALENDAR_MONTH', 'CALENDAR_YEAR', 'CALENDAR_QUARTER', 'DAY_ONLY', 'DAY_IN_MONTH', 'DAY_IN_WEEK', 'FISCAL_YEAR', 'HOUR_IN_DAY', 'WEEK_IN_YEAR'];

export const DATE_LITERALS = [
  'TODAY', 'YESTERDAY', 'TOMORROW', 'THIS_WEEK', 'LAST_WEEK', 'NEXT_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'NEXT_MONTH',
  'LAST_90_DAYS', 'NEXT_90_DAYS', 'THIS_QUARTER', 'LAST_QUARTER', 'NEXT_QUARTER', 'THIS_YEAR', 'LAST_YEAR', 'NEXT_YEAR',
  'THIS_FISCAL_QUARTER', 'LAST_FISCAL_QUARTER', 'THIS_FISCAL_YEAR', 'LAST_FISCAL_YEAR',
  'LAST_N_DAYS:7', 'NEXT_N_DAYS:7', 'LAST_N_WEEKS:4', 'LAST_N_MONTHS:3', 'NEXT_N_MONTHS:3', 'LAST_N_YEARS:1',
];
const DATE_RE = /^(TODAY|YESTERDAY|TOMORROW|(THIS|LAST|NEXT)_(WEEK|MONTH|QUARTER|YEAR|FISCAL_QUARTER|FISCAL_YEAR)|(LAST|NEXT)_90_DAYS|(LAST|NEXT)_N_[A-Z_]+(:\d*)?)$/i;

export const OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'IN', 'NOT IN', 'INCLUDES', 'EXCLUDES'];

// ---------- tokenizer ----------

/** Splits SOQL into tokens: { t: kind, v: text, s: start }. Kinds: kw fn str num date bind op punc id ws comment. */
export function tokenize(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const s = i;
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(text[i])) i++;
      out.push({ t: 'ws', v: text.slice(s, i), s });
    } else if (c === "'") {
      i++;
      while (i < n && text[i] !== "'") i += text[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
      out.push({ t: 'str', v: text.slice(s, i), s });
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      out.push({ t: 'comment', v: text.slice(s, i), s });
    } else if (c === ':' && /[A-Za-z_]/.test(text[i + 1] || '')) {
      i++;
      while (i < n && /\w/.test(text[i])) i++;
      out.push({ t: 'bind', v: text.slice(s, i), s });
    } else if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(text[i + 1] || '') && !/[\w)]$/.test(prevSolid(out)))) {
      i++;
      // numbers, and date/datetime literals like 2024-01-31 or 2024-01-31T10:00:00Z
      while (i < n && /[0-9.:\-+TZ]/.test(text[i])) i++;
      const v = text.slice(s, i);
      out.push({ t: /^\d{4}-\d{2}-\d{2}/.test(v) ? 'date' : 'num', v, s });
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[\w.:]/.test(text[i])) {
        if (text[i] === ':' && !/^(LAST|NEXT)_N_\w+$/i.test(text.slice(s, i))) break;
        i++;
      }
      const v = text.slice(s, i);
      const up = v.toUpperCase();
      // right after FROM it's always an object, even one named like a keyword (Order, Group)
      const afterFrom = prevSolidToken(out)?.t === 'kw' && prevSolidToken(out).v.toUpperCase() === 'FROM';
      const t = KW.has(up) && !afterFrom ? 'kw'
        : DATE_RE.test(v) ? 'date'
          : text[i] === '(' && FUNCTIONS.some((f) => f.toUpperCase() === up) ? 'fn' : 'id';
      out.push({ t, v, s });
    } else if ('<>!='.includes(c)) {
      i++;
      if (text[i] === '=' || (c === '<' && text[i] === '>')) i++;
      out.push({ t: 'op', v: text.slice(s, i), s });
    } else {
      i++;
      out.push({ t: 'punc', v: c, s });
    }
  }
  return out;
}

function prevSolid(tokens) {
  return prevSolidToken(tokens)?.v || '';
}

function prevSolidToken(tokens) {
  for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].t !== 'ws' && tokens[k].t !== 'comment') return tokens[k];
  return null;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML for the editor's highlight layer. */
export function highlightSoql(text) {
  let html = '';
  for (const tk of tokenize(text)) {
    const v = escHtml(tk.v);
    html += tk.t === 'ws' || tk.t === 'id' || tk.t === 'punc' ? v : `<span class="sq-${tk.t}">${v}</span>`;
  }
  // a trailing newline needs content after it, or the highlight layer ends one line short of the textarea
  return html + (text.endsWith('\n') ? ' ' : '');
}

// ---------- query structure ----------

/** The object in the outermost FROM (null when not typed yet). */
export function mainObject(text) {
  let depth = 0;
  const toks = tokenize(text).filter((t) => t.t !== 'ws' && t.t !== 'comment');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.v === '(') depth++;
    else if (t.v === ')') depth--;
    else if (depth === 0 && t.t === 'kw' && t.v.toUpperCase() === 'FROM' && toks[k + 1]?.t === 'id') return toks[k + 1].v;
  }
  return null;
}

// The SELECT block (outer query or sub-query) that `pos` sits in: its token range and FROM object.
function scopeAt(toks, pos) {
  const stack = [{ start: 0, sub: false }];
  for (const t of toks) {
    if (t.s >= pos) break;
    if (t.v === '(') stack.push({ start: t.s + 1, sub: false, paren: true });
    else if (t.v === ')' && stack.length > 1) stack.pop();
    else if (t.t === 'kw' && t.v.toUpperCase() === 'SELECT' && stack[stack.length - 1].paren) stack[stack.length - 1].sub = true;
  }
  // the innermost sub-query (plain parens for value lists or grouping don't start a block)
  const top = [...stack].reverse().find((f) => f.sub) || stack[0];
  // the FROM of this block: scan from the block start at the same depth (also past the cursor)
  let depth = 0;
  let from = null;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.s < top.start) continue;
    if (t.v === '(') depth++;
    else if (t.v === ')') { if (depth === 0) break; depth--; } else if (depth === 0 && t.t === 'kw' && t.v.toUpperCase() === 'FROM' && toks[k + 1]?.t === 'id') {
      from = toks[k + 1].v;
      break;
    }
  }
  return { ...top, from };
}

// ---------- autocomplete ----------

/**
 * What to suggest at `pos`.
 * meta: { objects: [{name,label}], describe(name) -> {fields:[{name,label,type,relationshipName,referenceTo,picklist:[{value,label}]}], children:[{name, object}]} | null }
 * Returns { from, to, items: [{ label, insert, kind, detail, caret? }], need: [objectNames to describe], hint }.
 */
export function suggest(text, pos, meta) {
  const all = tokenize(text);
  const toks = all.filter((t) => t.t !== 'ws' && t.t !== 'comment');
  // inside a string or comment: values only (picklists are offered when the quote opens)
  const at = all.find((t) => t.s < pos && pos <= t.s + t.v.length && (t.t === 'str' || t.t === 'comment'));
  if (at?.t === 'comment' || (at?.t === 'str' && pos === at.s + at.v.length && at.v.length > 1 && at.v.endsWith("'"))) return none(pos);

  const before = text.slice(0, pos);
  const wm = /[\w.]*$/.exec(before);
  const word = wm[0];
  const wordStart = pos - word.length;
  let after = /^\w*/.exec(text.slice(pos))[0];
  if (!word && KW.has(after.toUpperCase())) after = ''; // "SELECT |FROM": FROM isn't the word being typed
  const dot = word.lastIndexOf('.');
  const path = dot >= 0 ? word.slice(0, dot).split('.') : [];
  const partial = dot >= 0 ? word.slice(dot + 1) : word;
  const from = wordStart + (dot + 1);
  const to = pos + after.length;
  const prev = toks.filter((t) => t.s + t.v.length <= wordStart);
  const last = prev[prev.length - 1];
  const scope = scopeAt(toks, pos);
  const need = [];

  const clause = clauseOf(prev, scope.start);
  const res = (items, hint) => ({ from, to, items: rank(items, partial), need, hint });

  // what object do field names refer to here?
  let objName = scope.from;
  if (scope.sub && scope.from) {
    // a sub-query's FROM is a child relationship of the outer object
    const outer = mainObject(text);
    const d = outer && describeOr(meta, outer, need);
    const child = d?.children?.find((c) => c.name.toLowerCase() === scope.from.toLowerCase());
    objName = child ? child.object : null;
  }

  if (!clause) {
    if (/^\s*$/.test(text.slice(0, wordStart))) {
      return res([
        { label: 'SELECT … FROM …', insert: 'SELECT Id, Name FROM ', kind: 'snippet', detail: 'query template' },
        kwItem('SELECT'),
      ]);
    }
    return none(pos);
  }

  if (clause === 'FROM') {
    if (last && last.t === 'kw' && last.v.toUpperCase() === 'FROM') {
      if (scope.sub) {
        const outer = mainObject(text);
        const d = outer && describeOr(meta, outer, need);
        return res((d?.children || []).map((c) => ({ label: c.name, insert: c.name + ' ', kind: 'object', detail: c.object })),
          d ? null : 'Loading relationships…');
      }
      return res(meta.objects.map((o) => ({ label: o.name, insert: o.name + ' ', kind: 'object', detail: o.label })));
    }
    return res(['WHERE', 'ORDER BY', 'LIMIT', 'GROUP BY', 'WITH SECURITY_ENFORCED', 'OFFSET', 'FOR VIEW'].map(kwItem));
  }

  if (clause === 'LIMIT' || clause === 'OFFSET') {
    if (last?.t === 'num') return res((clause === 'LIMIT' ? ['OFFSET'] : []).concat(['FOR VIEW', 'FOR UPDATE']).map(kwItem));
    return none(pos);
  }

  if (!objName) {
    return { ...none(pos), hint: scope.sub ? null : 'Add FROM <Object> to get field suggestions' };
  }

  // fields (with relationship traversal) of the object in scope
  const fieldItems = (selectCtx) => {
    let d = describeOr(meta, objName, need);
    if (!d) return null;
    for (const seg of path) {
      const ref = d.fields.find((f) => f.relationshipName && f.relationshipName.toLowerCase() === seg.toLowerCase());
      const target = ref?.referenceTo?.[0];
      if (!target) return [];
      d = describeOr(meta, target, need);
      if (!d) return null;
    }
    const items = [];
    for (const f of d.fields) {
      items.push({ label: f.name, insert: f.name, kind: 'field', detail: `${f.label} · ${f.type}`, field: f });
      if (f.relationshipName && f.referenceTo?.length) {
        items.push({ label: `${f.relationshipName}.`, insert: `${f.relationshipName}.`, kind: 'rel', detail: `→ ${f.referenceTo.join(', ')}`, again: true });
      }
    }
    if (selectCtx && !path.length) {
      items.push(
        { label: 'COUNT()', insert: 'COUNT()', kind: 'fn', detail: 'number of rows' },
        { label: 'FIELDS(ALL)', insert: 'FIELDS(ALL)', kind: 'fn', detail: 'all fields · needs LIMIT 200' },
        { label: 'FIELDS(STANDARD)', insert: 'FIELDS(STANDARD)', kind: 'fn', detail: 'standard fields' },
        { label: 'FIELDS(CUSTOM)', insert: 'FIELDS(CUSTOM)', kind: 'fn', detail: 'custom fields · needs LIMIT 200' },
      );
      if (!scope.sub) items.push({ label: '(SELECT … FROM child)', insert: '(SELECT Id FROM )', caret: -1, kind: 'snippet', detail: 'sub-query' });
      for (const fn of ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX']) items.push({ label: `${fn}()`, insert: `${fn}()`, caret: -1, kind: 'fn', detail: 'aggregate' });
      // child relationships: picking one writes the whole sub-query and leaves the caret on its field list
      if (!scope.sub) {
        for (const c of d.children || []) {
          const tail = `Id FROM ${c.name})`;
          items.push({ label: c.name, insert: `(SELECT ${tail}`, caret: -tail.length, kind: 'child', detail: `child records · ${c.object}`, again: true });
        }
      }
    }
    return items;
  };

  if (clause === 'SELECT') {
    // right after a complete field + space: offer FROM / a comma is typed by the user
    if (!word && last && (last.t === 'id' || last.v === ')') && /\s$/.test(before)) return res([kwItem('FROM')]);
    const items = fieldItems(true);
    if (!items) return { ...none(pos), hint: loadingHint(meta, objName), need };
    if (path.length) return res(items);
    // "All fields": every field of the object, or the ones not in this SELECT list yet
    const chosen = selectedFields(toks, scope.start, wordStart, pos);
    const missing = chosen && items.filter((it) => it.kind === 'field' && !chosen.has(it.label.toLowerCase())).map((it) => it.label);
    if (!missing?.length) return res(items);
    const empty = chosen.size === 0;
    const all = {
      label: empty ? `All fields (${missing.length})` : `All remaining fields (${missing.length})`,
      insert: missing.join(', ') + (/^from\b/i.test(text.slice(to)) ? ' ' : ''),
      kind: 'all', detail: `of ${objName}`, pin: true,
    };
    // after "Id, " only the missing ones are added; after "Id" (no comma yet) start with one
    const prevTok = toks.filter((t) => t.s + t.v.length <= wordStart).pop();
    if (!empty && prevTok && prevTok.v !== ',') all.insert = ', ' + all.insert;
    const out = res([all, ...items]);
    if (empty && !word) out.allFields = all;
    return out;
  }

  if (clause === 'WHERE' || clause === 'HAVING') {
    const lastUp = last?.v.toUpperCase();
    // value position: after an operator
    if (last && (last.t === 'op' || ['LIKE', 'IN', 'INCLUDES', 'EXCLUDES'].includes(lastUp) || (last.v === '(' && isListOp(prev)) || (last.v === ',' && isListOp(prev)))) {
      const fieldTok = fieldBeforeOperator(prev);
      const f = fieldTok && fieldInfo(meta, objName, fieldTok.v, need);
      const inQuote = text[wordStart - 1] === "'";
      const items = valueItems(f, lastUp, inQuote);
      // typing inside an open quote: close it when the user picks a value
      if (inQuote && text[to] !== "'") for (const it of items) it.insert += "'";
      return res(items);
    }
    // after a field: operators
    if (!word && last && last.t === 'id' && /\s$/.test(before)) {
      return res(OPERATORS.map((op) => ({ label: op, insert: op + ' ', kind: 'op', detail: OP_HELP[op] })));
    }
    // after a value: logical operators / next clauses
    if (!word && last && (['str', 'num', 'date', 'bind'].includes(last.t) || ['NULL', 'TRUE', 'FALSE'].includes(lastUp) || (last.v === ')' && /\s$/.test(before)))) {
      return res(['AND', 'OR', 'ORDER BY', 'LIMIT', 'GROUP BY'].map(kwItem));
    }
    const items = fieldItems(false);
    if (!items) return { ...none(pos), hint: loadingHint(meta, objName), need };
    return res(path.length ? items : items.concat(['NOT'].map(kwItem)));
  }

  if (clause === 'ORDER BY' || clause === 'GROUP BY') {
    if (!word && last && last.t === 'id' && /\s$/.test(before)) {
      return res((clause === 'ORDER BY' ? ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'LIMIT'] : ['HAVING', 'ORDER BY', 'LIMIT']).map(kwItem));
    }
    if (!word && last && last.t === 'kw' && ['ASC', 'DESC', 'FIRST', 'LAST'].includes(last.v.toUpperCase())) {
      return res(['LIMIT', 'NULLS FIRST', 'NULLS LAST', 'OFFSET'].map(kwItem));
    }
    const items = fieldItems(false);
    return items ? res(items) : { ...none(pos), hint: loadingHint(meta, objName), need };
  }
  return none(pos);
}

const OP_HELP = {
  '=': 'equals', '!=': 'not equal', '<': 'less than', '<=': 'at most', '>': 'greater than', '>=': 'at least',
  LIKE: "pattern, e.g. 'Acme%'", IN: "in a list ('a','b')", 'NOT IN': 'not in a list', INCLUDES: 'multi-select picklist has', EXCLUDES: 'multi-select picklist lacks',
};

const loadingHint = (meta, obj) => (meta.describe(obj) === null ? `Couldn’t load the fields of ${obj} (is the object name right?)` : 'Loading fields…');

function none(pos) { return { from: pos, to: pos, items: [], need: [] }; }
const kwItem = (k) => ({ label: k, insert: k + ' ', kind: 'kw' });

function describeOr(meta, name, need) {
  const d = meta.describe(name);
  if (d === undefined && !need.includes(name)) need.push(name);
  return d || null;
}

function fieldInfo(meta, objName, dotted, need) {
  let d = describeOr(meta, objName, need);
  const segs = dotted.split('.');
  for (let k = 0; d && k < segs.length - 1; k++) {
    const ref = d.fields.find((f) => f.relationshipName?.toLowerCase() === segs[k].toLowerCase());
    d = ref?.referenceTo?.[0] ? describeOr(meta, ref.referenceTo[0], need) : null;
  }
  return d?.fields.find((f) => f.name.toLowerCase() === segs[segs.length - 1].toLowerCase()) || null;
}

function isListOp(prev) {
  let depth = 0;
  for (let k = prev.length - 1; k >= 0; k--) {
    const t = prev[k];
    if (t.v === ')') depth++;
    else if (t.v === '(') {
      if (depth === 0) {
        const op = prev[k - 1]?.v.toUpperCase();
        return op === 'IN' || op === 'INCLUDES' || op === 'EXCLUDES';
      }
      depth--;
    }
  }
  return false;
}

function fieldBeforeOperator(prev) {
  for (let k = prev.length - 1; k >= 0; k--) {
    const t = prev[k];
    if (t.t === 'id') return t;
    if (t.t === 'kw' && ['AND', 'OR', 'WHERE', 'HAVING'].includes(t.v.toUpperCase())) return null;
  }
  return null;
}

function valueItems(f, op, inQuote) {
  const items = [];
  const type = f?.type;
  if (f?.picklist?.length) {
    // the API name is what SOQL needs; the label is what people recognise from the UI
    for (const p of f.picklist) {
      const v = typeof p === 'string' ? p : p.value;
      const lbl = typeof p === 'string' ? null : p.label;
      items.push({
        label: v, insert: inQuote ? v : `'${v.replace(/'/g, "\\'")}'`, kind: 'value',
        detail: lbl && lbl !== v ? lbl : 'picklist value', valueLabel: lbl && lbl !== v ? lbl : null,
      });
    }
  }
  if (inQuote) return items;
  if (op === 'IN' || op === 'NOT' || op === 'INCLUDES' || op === 'EXCLUDES') items.unshift({ label: "( '…' )", insert: "('')", caret: -2, kind: 'snippet', detail: 'list' });
  if (type === 'boolean') items.push(kwItem('true'), kwItem('false'));
  if (type === 'date' || type === 'datetime') {
    for (const d of DATE_LITERALS) items.push({ label: d, insert: d + ' ', kind: 'date', detail: 'date literal' });
    const today = new Date().toISOString().slice(0, 10);
    items.push({ label: type === 'date' ? today : `${today}T00:00:00Z`, insert: (type === 'date' ? today : `${today}T00:00:00Z`) + ' ', kind: 'date', detail: 'literal' });
  }
  if (op === 'LIKE') items.push({ label: "'%…%'", insert: "'%%'", caret: -2, kind: 'snippet', detail: 'contains' });
  if (!type || ['string', 'textarea', 'email', 'phone', 'url', 'picklist', 'id', 'reference', 'combobox'].includes(type)) {
    if (!items.some((x) => x.kind === 'snippet')) items.push({ label: "'…'", insert: "''", caret: -1, kind: 'snippet', detail: 'text' });
  }
  items.push(kwItem('null'));
  return items;
}

// Plain field names already in the SELECT list of the block starting at `blockStart` (lower-cased),
// leaving out the word being typed. Null when the list uses FIELDS() / aggregates, where "all fields" makes no sense.
function selectedFields(toks, blockStart, wordStart, pos) {
  let k = toks.findIndex((t) => t.s >= blockStart && t.t === 'kw' && t.v.toUpperCase() === 'SELECT');
  if (k < 0) return null;
  const out = new Set();
  let depth = 0;
  for (k++; k < toks.length; k++) {
    const t = toks[k];
    if (t.v === '(') { depth++; continue; }
    if (t.v === ')') { depth--; continue; }
    if (depth) continue;
    if (t.t === 'kw' && t.v.toUpperCase() === 'FROM') break;
    if (t.t === 'fn') return null;
    if (t.t === 'id' && !(t.s <= pos && t.s + t.v.length >= wordStart && t.s >= wordStart)) out.add(t.v.toLowerCase());
  }
  return out;
}

// The clause keyword in effect at the end of `prev` within the current SELECT block.
function clauseOf(prev, blockStart) {
  let depth = 0;
  for (let k = prev.length - 1; k >= 0; k--) {
    const t = prev[k];
    if (t.s < blockStart) break;
    if (t.v === ')') { depth++; continue; }
    // an open paren we're inside: a value list or grouping (sub-queries are cut off by blockStart)
    if (t.v === '(') { if (depth) depth--; continue; }
    if (depth || t.t !== 'kw') continue;
    const up = t.v.toUpperCase();
    if (up === 'BY') {
      const p = prev[k - 1]?.v.toUpperCase();
      if (p === 'ORDER') return 'ORDER BY';
      if (p === 'GROUP') return 'GROUP BY';
    }
    if (['SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET'].includes(up)) return up;
    if (up === 'WITH' || up === 'FOR' || up === 'USING') return 'FROM';
  }
  return null;
}

function rank(items, partial) {
  const p = partial.toLowerCase();
  const scored = [];
  for (const it of items) {
    const l = it.label.toLowerCase();
    const d = (it.detail || '').toLowerCase();
    let s;
    if (it.pin) { if (p) continue; s = -2; } else if (!p) s = 0;
    else if (l === p) s = -1;
    else if (l.startsWith(p)) s = 1;
    else if (l.includes(p)) s = 3;
    else if (d.includes(p)) s = 4;
    else continue;
    if (it.kind === 'rel' || it.kind === 'child') s += 0.5;
    scored.push([s, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || (KIND_ORDER[a[1].kind] ?? 5) - (KIND_ORDER[b[1].kind] ?? 5));
  return scored.slice(0, 80).map(([, it]) => it);
}
const KIND_ORDER = { snippet: 0, object: 1, field: 1, value: 1, op: 1, rel: 2, child: 2, kw: 3, date: 2, fn: 4 };

// ---------- record ids ----------

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** 15-char id -> 18-char id (case-safe suffix). */
export function to18(id) {
  if (!/^[a-zA-Z0-9]{15}$/.test(id)) return id;
  let suffix = '';
  for (let b = 0; b < 3; b++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const c = id[b * 5 + i];
      if (c >= 'A' && c <= 'Z') flags |= 1 << i;
    }
    suffix += ID_CHARS[flags];
  }
  return id + suffix;
}

/** True for a real 18-char record id (checksum matches) or any 15-char id in an Id-ish column. */
export function isRecordId(v, column = '') {
  if (typeof v !== 'string') return false;
  if (v.length === 18) return /^[a-zA-Z0-9]{18}$/.test(v) && to18(v.slice(0, 15)) === v && !/^0{3}/.test(v);
  return v.length === 15 && /^[a-zA-Z0-9]{15}$/.test(v) && /(^|\.)id$|id$/i.test(column);
}

// ---------- results ----------

const isRelObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'attributes' in v;
const isSub = (v) => !!v && typeof v === 'object' && Array.isArray(v.sub);
const isSubquery = (v) => v && typeof v === 'object' && Array.isArray(v.records) && 'totalSize' in v;

/** Flatten API records into { columns, rows } (relationship fields become "Account.Name"). */
export function flatten(records, columns = []) {
  const cols = new Set(columns);
  const nullRel = new Set();
  const rows = records.map((r) => {
    const row = {};
    const walk = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'attributes') continue;
        const key = prefix + k;
        if (isSubquery(v)) { row[key] = { sub: v.records, total: v.totalSize }; cols.add(key); } else if (isRelObj(v)) walk(v, key + '.');
        else {
          if (v === null) nullRel.add(key);
          row[key] = v;
          cols.add(key);
        }
      }
    };
    walk(r, '');
    row.__type = r.attributes?.type || null;
    return row;
  });
  // "Account": null on rows where the lookup is empty, while other rows have Account.Name: drop the bare column
  const list = [...cols];
  const out = list.filter((c) => !(nullRel.has(c) && list.some((o) => o.startsWith(c + '.'))));
  return { columns: out, rows };
}

export function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') return isSub(v) ? `${v.total} row${v.total === 1 ? '' : 's'}` : JSON.stringify(v);
  return String(v);
}

const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(columns, rows) {
  const lines = [columns.map(csvCell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(exportText(r[c]))).join(','));
  return lines.join('\r\n');
}

/** Tab-separated, pastes straight into Excel / Sheets. */
export function toTsv(columns, rows) {
  const clean = (s) => s.replace(/[\t\r\n]+/g, ' ');
  return [columns.join('\t'), ...rows.map((r) => columns.map((c) => clean(exportText(r[c]))).join('\t'))].join('\n');
}

export function toJson(columns, rows) {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c, isSub(r[c]) ? r[c].sub.map(stripAttrs) : r[c] ?? null]))), null, 2);
}

function exportText(v) {
  if (isSub(v)) return JSON.stringify(v.sub.map(stripAttrs));
  return cellText(v);
}

export function stripAttrs(rec) {
  if (Array.isArray(rec)) return rec.map(stripAttrs);
  if (!rec || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'attributes') continue;
    out[k] = isSubquery(v) ? v.records.map(stripAttrs) : stripAttrs(v);
  }
  return out;
}

/** Rows containing `q` (case-insensitive) in any column. */
export function filterRows(rows, columns, q) {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => columns.some((c) => cellText(r[c]).toLowerCase().includes(s)));
}

export function sortRows(rows, column, dir) {
  if (!column || !dir) return rows;
  const val = (r) => r[column];
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // nulls last either way
    if (y == null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return cellText(x).localeCompare(cellText(y), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

/** A short title for a query, e.g. "Account" or "Account · 3 filters". */
export function queryTitle(soql) {
  return mainObject(soql) || 'Query';
}
