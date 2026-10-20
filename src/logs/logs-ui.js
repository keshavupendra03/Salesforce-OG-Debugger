// Debug Logs view: trace flags on users, a live log list, and a log viewer with analysis tabs.

import { h, esc } from '../dom.js';
import { parseLog, mergeLogs, summarize, groupQueries, queryKey, errorPaths, CATS, CONT, LINE_RE } from './log-parser.js';
import { LEVEL_FIELDS, LOG_LEVELS, LEVEL_PRESETS } from './log-backend.js';
import { parseUnit } from '../apex/parser.js';
import { highlight } from '../apex/highlight.js';
import { resizable, codeDetails, collapsibleSide } from '../layout.js';
import { groupSessions, isBogusDuration } from './sessions.js';
import { traceField, staticMethodFor, linesRun, objectsInLog, fieldsInLog } from './field-trace.js';

const ROW_H = 20;
const POLL_MS = 5000;
const MAX_CACHED = 8;
const PAGE = 300;

const RAW_CATS = ['unit', 'method', 'soql', 'dml', 'debug', 'error', 'limit', 'rule', 'callout', 'system'];
const CAT_LABEL = {
  unit: 'Code units', method: 'Methods', soql: 'SOQL', dml: 'DML', debug: 'Debug', error: 'Errors',
  limit: 'Limits', rule: 'Flow & rules', callout: 'Callouts', system: 'System', other: 'Other',
};
const KIND_LABEL = {
  tx: 'Transaction', execution: 'Execution', unit: 'Code unit', trigger: 'Trigger', validation: 'Validation', workflow: 'Workflow',
  flow: 'Flow', flowel: 'Flow step', method: 'Method', soql: 'SOQL', dml: 'DML', callout: 'Callout',
  debug: 'Debug', error: 'Error',
};
const LEAF_KINDS = new Set(['debug', 'error', 'validation']);
const DEBUG_LEVELS = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];
const LEVEL_SHORT = {
  ApexCode: 'Apex', ApexProfiling: 'Profiling', Callout: 'Callout', Database: 'DB', System: 'System',
  Validation: 'Validation', Visualforce: 'VF', Workflow: 'Workflow', Wave: 'Analytics', Nba: 'NBA',
};
const PRESET_LABEL = { standard: 'Standard', detailed: 'Detailed', light: 'Light' };

// ---------- formatting ----------

const parseSfDate = (s) => new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
// Long spans read as "2m 05s" / "35h 26m" rather than thousands of seconds.
function fmtLong(ms) {
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}
const fmtMs = (ms) => (ms == null || Number.isNaN(ms) ? '—'
  : ms < 1 ? `${ms.toFixed(2)} ms` : ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)} ms`
    : ms < 60000 ? `${(ms / 1000).toFixed(2)} s` : fmtLong(ms));
const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const fmtWhen = (d) => d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pad2 = (n) => String(n).padStart(2, '0');
// 24-hour local time: "16/10/2026 10:41:07" and "10:41:07"
const fmtClock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDate = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
const fmtFull = (d) => `${fmtDate(d)} ${fmtClock(d)}`;
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const num = (n) => (n == null ? '—' : n.toLocaleString());
const humanize = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pctOf = (l) => (l && l.max ? (l.used / l.max) * 100 : 0);
const toneOf = (pct) => (pct >= 80 ? 'bad' : pct >= 50 ? 'warn' : 'ok');
const tick = () => new Promise((r) => setTimeout(r, 0));

function fmtAgo(d) {
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return fmtWhen(d);
}

// Offset from the start of a session.
const fmtAt = (ms) => (ms < 1 ? 'start'
  : `+${ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s` : fmtLong(ms)}`);

function fmtSpan(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function toLocalInput(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
}

function hi(s, re) {
  if (!re) return esc(s);
  let out = '';
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
    if (!m[0]) re.lastIndex++;
  }
  return out + esc(s.slice(last));
}

const SOQL_KW = /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|LIKE|LIMIT|OFFSET|ORDER BY|GROUP BY|HAVING|ASC|DESC|NULLS FIRST|NULLS LAST|INCLUDES|EXCLUDES|WITH|FOR UPDATE|TYPEOF|WHEN|THEN|ELSE|END|FIND|RETURNING|ALL ROWS|COUNT|NULL|TRUE|FALSE)\b/gi;
const soqlHtml = (q) => esc(q).replace(SOQL_KW, '<b>$1</b>').replace(/(:\w+)/g, '<i>$1</i>');

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const jsonHtml = (text) => esc(text).replace(JSON_TOKEN, (m, str, colon, lit, n) => (str
  ? `<span class="${colon ? 'j-k' : 'j-s'}">${str}</span>${colon || ''}`
  : lit ? `<span class="j-b">${lit}</span>` : `<span class="j-n">${n}</span>`));

function prettyJson(msg) {
  const t = msg.trim();
  if (!/^[[{]/.test(t)) return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
}

function rawHtml(tag, cls, markup) {
  const el = document.createElement(tag);
  el.className = cls;
  el.innerHTML = markup;
  return el;
}

function lineHtml(line, cat, re) {
  if (line.length > 4000) line = line.slice(0, 4000) + ' …';
  if (!(cat & CONT)) {
    const m = LINE_RE.exec(line);
    if (m) {
      return `<span class="lt-t">${hi(`${m[1]} (${m[2]})`, re)}</span>|<span class="lt-e">${hi(m[3], re)}</span>${m[4] != null ? '|' + hi(m[4], re) : ''}`;
    }
  }
  return hi(line, re) || ' ';
}

const barStyle = (n, t0, total) => {
  const left = Math.min(99.7, ((n.start - t0) / total) * 100);
  return `left:${left}%;width:${Math.min(100 - left, Math.max(0.3, ((n.end - n.start) / total) * 100))}%`;
};

// ---------- execution path helpers ----------

const FRAME_KINDS = new Set(['tx', 'unit', 'method', 'dml', 'flow']);
// Children that are code frames or errors; other nodes (execution, flow steps, workflow, callouts) are see-through.
const codeKids = (n) => n.children.flatMap((c) => (c.kind === 'error' ? (c.dupe ? [] : [c]) : FRAME_KINDS.has(c.kind) ? [c] : codeKids(c)));
const srcFrameOf = (n) => { for (let x = n; x && x.kind !== 'root'; x = x.parent) if (x.src) return x; return null; };
const firstLine = (s) => String(s).split('\n')[0].trim();

function splitErr(head) {
  const m = /^([\w.]+(?:Exception|Error)):\s*([\s\S]*)$/.exec(firstLine(head));
  return m ? [m[1], m[2]] : [firstLine(head), ''];
}

function splitArgs(sig) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of sig) {
    if (c === '<') depth++;
    else if (c === '>') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function displayName(n) {
  if (n.kind === 'tx') return n.meta.Operation || `Transaction ${n.tx}`;
  if (n.kind === 'unit') {
    let m = /^(\w+) on (\w+) trigger event (\w+)/i.exec(n.label);
    if (m) return `${m[1]} · ${m[3].replace(/([a-z])([A-Z])/g, '$1 $2')}`;
    m = /^apex:\/\/([\w.]+)\/ACTION\$(\w+)/i.exec(n.label);
    if (m) return `${m[1]}.${m[2]}()`;
    m = /^(Validation|Workflow|Flow):(\w+)/i.exec(n.label);
    if (m) return `${m[2]} ${{ validation: 'validation rules', workflow: 'workflow rules', flow: 'flows' }[m[1].toLowerCase()]}`;
    if (n.label === 'execute_anonymous_apex') return 'Anonymous Apex';
  }
  return n.label;
}

const REF_KIND = { call: 'method', dml: 'dml', soql: 'soql', error: 'error', debug: 'debug', callout: 'callout', write: 'write', read: 'read', assign: 'assign', idle: 'idle' };
const REF_LABEL = { call: 'calls', dml: 'DML', soql: 'SOQL', error: 'throws', debug: 'debug', callout: 'callout', write: 'writes', read: 'reads', assign: 'value', idle: 'didn’t run' };
const REF_SEVERITY = { idle: -1, debug: 0, call: 1, soql: 2, dml: 2, callout: 2, read: 3, assign: 7, write: 8, error: 9 };
const ROW_CLASS = { error: 'hl-err', call: 'hl-call', write: 'hl-write', assign: 'hl-write', idle: 'hl-idle' };
const FIELD_HOW = {
  soql: 'SOQL', field: 'field access', schema: 'schema reference', dynamic: 'dynamic get/put',
  'dynamic-soql': 'dynamic SOQL', constructor: 'constructor', string: 'string literal',
};
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const txChip = (x) => (x.tx ? h('span', { class: 'lv-tx', title: `Transaction ${x.tx}` }, `T${x.tx}`) : null);
const txOf = (n) => { for (let x = n; x; x = x.parent) if (x.kind === 'tx') return x; return null; };

// Lines inside a frame's own source that the log points at: calls, DML, SOQL, debug output, exceptions.
function markLines(frame) {
  const out = new Map();
  for (const c of frame.children) {
    const kind = c.kind === 'method' ? 'call' : c.kind;
    if (c.line == null || !(kind in REF_KIND)) continue;
    if (!out.has(c.line)) out.set(c.line, []);
    out.get(c.line).push({ kind, node: c });
  }
  return out;
}

function refText({ kind, node }) {
  if (kind === 'call') return displayName(node);
  // the whole line (all of a multi-line debug), capped only so a huge serialized blob can't freeze the pane
  return clip(String(node.label || '').trim(), 5000);
}

// ---------- small shared widgets ----------

// Waiting animation shown while logs download: frames in this order, WAIT_MS each, looping.
const WAIT_FRAMES = ['1_1', '1_2', '1_3', '1_4', '2_1', '2_2', '2_3', '3_1', '3_2', '3_3', '3_4']
  .map((n) => `src/waiting_images/waiting_${n}.png`);
const WAIT_MS = 1000;
let waitCache = null; // keeps the preloaded frames alive so swapping src never refetches

/**
 * Download screen: the waiting animation, then one progress bar per log (plus an overall bar for a session).
 * items: [{ label, sub, total }] where total is the expected size in bytes (may be 0/unknown).
 */
function loadingView(items) {
  if (!waitCache) waitCache = WAIT_FRAMES.map((src) => Object.assign(new Image(), { src }));
  const img = h('img', { class: 'ld-frame', src: WAIT_FRAMES[0], alt: '' });
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let f = 0;
  const timer = still ? null : setInterval(() => {
    if (!img.isConnected) { clearInterval(timer); return; }
    f = (f + 1) % WAIT_FRAMES.length;
    img.src = WAIT_FRAMES[f];
  }, WAIT_MS);

  const bar = () => {
    const fill = h('span', { class: 'ld-fill' });
    return { box: h('div', { class: 'ld-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill), fill };
  };
  const setBar = (b, pct) => {
    b.fill.style.width = `${pct}%`;
    b.box.setAttribute('aria-valuenow', String(Math.round(pct)));
  };
  const title = h('div', { class: 'ld-title' }, items.length > 1 ? `Downloading ${items.length} logs…` : 'Downloading log…');
  const multi = items.length > 1;
  const overall = multi ? bar() : null;
  const rows = items.map((it, i) => {
    const b = bar();
    const size = h('span', { class: 'ld-size' }, it.total ? fmtBytes(it.total) : '');
    const box = h('li', { class: 'ld-row waiting' },
      h('div', { class: 'ld-row-head' },
        multi ? h('span', { class: 'ld-n' }, `${i + 1}/${items.length}`) : null,
        h('span', { class: 'ld-label', title: it.label }, it.label),
        it.sub ? h('span', { class: 'ld-sub' }, it.sub) : null,
        size),
      b.box);
    return { ...it, got: 0, done: false, b, box, size };
  });
  const root = h('div', { class: 'ld-wrap', 'aria-live': 'polite' },
    h('div', { class: 'ld-stage' }, img),
    title,
    overall ? overall.box : null,
    h('ul', { class: 'ld-rows' }, rows.map((r) => r.box)));

  const refreshOverall = () => {
    const n = rows.filter((r) => r.done).length;
    if (!multi) return;
    const sum = rows.reduce((s, r) => s + (r.total || 0), 0);
    const got = rows.reduce((s, r) => s + (r.done ? r.total || 0 : Math.min(r.got, r.total || 0)), 0);
    setBar(overall, sum ? (got / sum) * 100 : (n / rows.length) * 100);
    title.textContent = n < rows.length ? `Downloading logs… ${n} of ${rows.length} done` : 'All logs downloaded';
  };
  return {
    el: root,
    progress(i, got, total) {
      const r = rows[i];
      if (!r || r.done) return;
      if (!r.total && total) r.total = total;
      r.got = got;
      r.box.classList.remove('waiting');
      // the size from the log list is the real body length; keep the bar below 100 % until the body is complete
      setBar(r.b, r.total ? Math.min(99, (got / r.total) * 100) : 50);
      r.size.textContent = r.total ? `${fmtBytes(Math.min(got, r.total))} / ${fmtBytes(r.total)}` : fmtBytes(got);
      refreshOverall();
    },
    done(i, cached) {
      const r = rows[i];
      if (!r) return;
      r.done = true;
      r.box.classList.remove('waiting');
      r.box.classList.add('done');
      setBar(r.b, 100);
      r.size.textContent = cached ? 'already downloaded' : r.total ? fmtBytes(r.total) : '✓';
      refreshOverall();
    },
    status(text) { title.textContent = text; },
  };
}

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6500 : 3000);
}

// Two-step destructive buttons: first click arms, second click (within 3s) confirms.
function armConfirm(btn, confirmLabel, action) {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    return action();
  }
  const old = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = confirmLabel;
  btn.classList.add('armed');
  setTimeout(() => {
    if (!btn.dataset.armed) return;
    delete btn.dataset.armed;
    btn.classList.remove('armed');
    btn.textContent = old;
  }, 3000);
}

function virtualList(box, rowH, renderRow) {
  const inner = h('div', { class: 'vl-inner' });
  box.append(inner);
  let n = 0;
  let queued = false;
  const draw = () => {
    queued = false;
    const top = box.scrollTop;
    const height = box.clientHeight || 800;
    const first = Math.max(0, Math.floor(top / rowH) - 30);
    const last = Math.min(n, Math.ceil((top + height) / rowH) + 30);
    let html = '';
    for (let r = first; r < last; r++) html += renderRow(r);
    inner.innerHTML = html;
  };
  box.addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(draw); } });
  return {
    draw,
    setCount(c) { n = c; inner.style.height = `${c * rowH}px`; draw(); },
    scrollTo(r) { box.scrollTop = Math.max(0, r * rowH - box.clientHeight / 2 + rowH / 2); draw(); },
  };
}

function table(cols, rows, state, redraw) {
  const col = cols.find((c) => c.key === state.sort);
  const sorted = [...rows];
  if (col?.sort) {
    sorted.sort((a, b) => {
      const x = col.sort(a);
      const y = col.sort(b);
      return (x < y ? -1 : x > y ? 1 : 0) * state.dir;
    });
  }
  return h('table', { class: 'lv-table' },
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {
      class: [c.num ? 'num' : '', c.sort ? 'sortable' : ''].join(' ').trim() || null,
      'aria-sort': state.sort === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : null,
      onclick: c.sort ? () => {
        if (state.sort === c.key) state.dir *= -1;
        else { state.sort = c.key; state.dir = c.num ? -1 : 1; }
        redraw();
      } : null,
    }, c.label)))),
    h('tbody', {}, sorted.map((r) => h('tr', {
      class: r._cls || null,
      onclick: (e) => e.currentTarget.classList.toggle('open'),
    }, cols.map((c) => h('td', { class: c.num ? 'num' : c.cls || null }, c.render(r)))))));
}

const stat = (value, label, tone) => h('span', { class: `lv-stat${tone ? ' ' + tone : ''}` }, h('b', {}, value), label);
const emptyTab = (title, sub) => h('div', { class: 'lv-empty' }, h('b', {}, title), sub);
const field = (label, control, aside, ...more) => h('div', { class: 'lg-field' },
  h('div', { class: 'lg-label' }, h('span', {}, label), aside), control, ...more);

function limitRow(name, used, max) {
  const pct = max ? (used / max) * 100 : 0;
  return h('div', { class: `lm ${toneOf(pct)}${used ? '' : ' zero'}` },
    h('span', { class: 'lm-name', title: name }, name),
    h('div', { class: 'lm-bar' }, h('i', { style: `width:${Math.min(100, pct)}%` })),
    h('span', { class: 'lm-val' }, h('b', {}, num(used)), ` / ${num(max)}`),
    h('span', { class: 'lm-pct' }, used && pct < 1 ? '<1%' : `${Math.round(pct)}%`));
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('ff-logs-prefs')) || {}; } catch { return {}; }
}
function savePrefs(patch) {
  try { localStorage.setItem('ff-logs-prefs', JSON.stringify({ ...loadPrefs(), ...patch })); } catch { /* storage blocked */ }
}

// ---------- view ----------

// sources: { getSource({ kind, id, name }) -> Promise<{ id, name, kind, body, managed } | null>, setupUrl(unit) }
export function mountLogs(root, backend, sources = {}) {
  const prefs = loadPrefs();
  const S = {
    me: null, meUser: null, users: new Map(), levels: [], flags: [], logs: [], knownIds: null, fresh: new Set(),
    selectedId: null, openMeta: null, bodies: new Map(), parsed: new Map(),
    filter: { q: '', user: '', errors: false },
    tab: 'details', live: prefs.live ?? true, active: false, timer: null, tickTimer: null, loadingLogs: false,
    form: { user: null, levelId: prefs.levelId || '', hours: prefs.hours || 1, editingFlagId: null },
    raw: { q: '', cats: new Set(), hideNoise: false, matchPos: -1, flash: null },
    qv: { group: false, sort: 'order', dir: 1, q: '' },
    dmlv: { sort: 'order', dir: 1, q: '' },
    dv: { q: '', levels: new Set(), pretty: true, shown: PAGE },
    tree: { methods: true },
    xp: { mode: null, selKey: null, focus: 0 },
    // pick: explicit include/exclude per log; expanded: explicit open/closed per session (keyed by its first log).
    // Without an explicit choice only the latest session is ticked and expanded.
    sess: { on: !!prefs.sessions, users: prefs.sessUsers || null, gap: prefs.gap || 10, pick: new Map(), expanded: new Map(), latest: null },
    apUser: null,
    headCompact: !!prefs.headCompact,
    ft: { object: prefs.ftObject || '', field: prefs.ftField || '', view: 'paths', possible: false },
    ftResult: null, ftIndex: null,
    lv: { hideUnused: true },
    ov: { q: '', sort: 'pct' },
    orgLimits: null, orgLimitsAt: null, jump: null,
  };
  const el = {};

  root.replaceChildren(
    el.side = h('aside', { class: 'lg-side' },
      el.trace = h('section', { class: 'lg-card lg-trace' }),
      el.flags = h('section', { class: 'lg-card lg-flags' }),
      el.logsBox = h('section', { class: 'lg-card lg-logs' })),
    el.main = h('section', { class: 'lg-main' }),
    resizable({
      handle: h('div'), pane: el.side, host: root, cssVar: '--lg-side', edge: 'end',
      min: 260, max: () => root.clientWidth * 0.55, key: 'ff-split-logs', label: 'Resize the sidebar',
    }));
  const side = collapsibleSide({ host: root, pane: el.side, key: 'ff-side-logs', label: 'the log list', rail: logsRail });

  // What the collapsed sidebar shows: live state, new logs since you last looked, and what's open.
  function logsRail() {
    const open = S.selectedId ? S.openMeta : null;
    const fresh = S.fresh.size;
    return [
      S.live ? h('span', { class: 'side-rail-dot', title: 'Live: the list refreshes every 5 seconds' }) : null,
      fresh ? h('span', { class: 'side-rail-badge', title: `${fresh} new log${fresh === 1 ? '' : 's'}` }, fresh > 99 ? '99+' : fresh) : null,
      h('span', { class: 'side-rail-chip' }, S.sess.on ? 'Sessions' : 'Logs'),
      h('span', { class: `side-rail-label${open ? '' : ' muted'}`, title: open?.Operation || '' },
        open ? (open.merged ? open.Operation : `${open.Operation} · ${open.LogUser?.Name || ''}`) : 'No log open'),
    ];
  }

  buildTrace();
  buildLogsBox();
  renderFlags();
  renderEmptyMain();

  document.addEventListener('keydown', (e) => {
    if (!S.active || S.tab !== 'raw' || !el.rawSearch?.isConnected) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); el.rawSearch.focus(); el.rawSearch.select(); }
  });
  // F: open the code pane's step full screen (Execution Path, Field Trace)
  document.addEventListener('keydown', (e) => {
    if (!S.active || e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.fx, .bmc, .dx-modal')) return;
    if ((S.tab === 'path' || S.tab === 'field') && el.xpCode?.isConnected && el.xpCode.querySelector('.code-expand')) {
      e.preventDefault();
      el.xpCode.focusOpen?.();
    }
  });

  // ---------- trace flag form ----------

  function buildTrace() {
    el.userInput = h('input', { type: 'search', placeholder: 'Search users by name or username', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'User to trace' });
    el.userDrop = h('ul', { class: 'lg-drop', role: 'listbox', hidden: true });
    el.levelSel = h('select', { 'aria-label': 'Debug level' });
    el.levelPreview = h('div', { class: 'lg-levels' });
    el.levelEditor = h('div', { class: 'lg-editor', hidden: true });
    el.start = h('input', { type: 'datetime-local', 'aria-label': 'Start time' });
    el.hours = h('input', { type: 'number', min: '1', max: '24', step: '1', 'aria-label': 'Hours' });
    el.hourChips = h('div', { class: 'lg-quick' }, [1, 2, 4, 8, 24].map((n) => h('button', { type: 'button', 'data-h': n, onclick: () => setHours(n) }, `${n}h`)));
    el.until = h('div', { class: 'lg-until' });
    el.submit = h('button', { class: 'primary lg-submit', type: 'submit' }, 'Start logging');
    el.cancelEdit = h('button', { type: 'button', class: 'ghost', hidden: true, onclick: cancelEdit }, 'Cancel');
    el.formTitle = h('span', {}, 'Trace a user');
    el.traceToggle = h('button', { class: 'lg-collapse', 'aria-expanded': 'true', 'aria-label': 'Collapse', onclick: () => toggleTrace() }, '▾');

    const form = h('form', { class: 'lg-form', onsubmit: (e) => { e.preventDefault(); submitFlag(); } },
      field('User', h('div', { class: 'lg-combo' }, el.userInput, el.userDrop),
        h('span', { class: 'lg-label-links' },
          h('button', { type: 'button', class: 'link', onclick: () => pickUser(S.meUser) }, 'Me'),
          h('button', { type: 'button', class: 'link', title: 'The system user that runs platform-event triggers and some flows', onclick: pickAutomatedProcess }, 'Automated Process'))),
      field('Debug level',
        h('div', { class: 'lg-row' }, el.levelSel, h('button', { type: 'button', class: 'ghost small', onclick: openLevelEditor }, '+ New')),
        null, el.levelPreview, el.levelEditor),
      h('div', { class: 'lg-row2' },
        field('Start', el.start, h('button', { type: 'button', class: 'link', onclick: () => { el.start.value = toLocalInput(new Date()); updateUntil(); } }, 'Now')),
        field('Hours', el.hours)),
      el.hourChips,
      el.until,
      h('div', { class: 'lg-row' }, el.submit, el.cancelEdit));

    el.traceBody = h('div', { class: 'lg-card-body' }, form);
    el.trace.append(h('header', { class: 'lg-card-head' }, el.formTitle, el.traceToggle), el.traceBody);

    el.start.value = toLocalInput(new Date());
    el.hours.value = S.form.hours;
    el.start.addEventListener('input', updateUntil);
    el.hours.addEventListener('input', () => { if (+el.hours.value) { S.form.hours = clampHours(+el.hours.value); updateUntil(); } });
    el.hours.addEventListener('change', () => setHours(+el.hours.value || 1));
    el.levelSel.addEventListener('change', () => { S.form.levelId = el.levelSel.value; savePrefs({ levelId: S.form.levelId }); renderLevelPreview(); });
    bindUserCombo();
    renderLevels();
    updateUntil();
    if (prefs.traceCollapsed) toggleTrace(false);
  }

  function toggleTrace(open = el.traceBody.hidden) {
    el.traceBody.hidden = !open;
    el.traceToggle.setAttribute('aria-expanded', String(open));
    el.traceToggle.setAttribute('aria-label', open ? 'Collapse' : 'Expand');
    savePrefs({ traceCollapsed: !open });
  }

  const clampHours = (n) => Math.min(24, Math.max(1, Math.round(n)));

  function setHours(n) {
    S.form.hours = clampHours(n);
    el.hours.value = S.form.hours;
    savePrefs({ hours: S.form.hours });
    updateUntil();
  }

  function updateUntil() {
    const start = el.start.value ? new Date(el.start.value) : new Date();
    const end = new Date(start.getTime() + S.form.hours * 3600e3);
    el.until.replaceChildren(
      h('span', {}, start.getTime() <= Date.now() + 60000 ? 'Starts now' : `Starts ${fmtWhen(start)}`),
      h('span', { class: 'lg-arrow' }, '→'),
      h('b', {}, `ends ${fmtWhen(end)}`));
    for (const b of el.hourChips.children) b.setAttribute('aria-pressed', String(+b.dataset.h === S.form.hours));
  }

  function bindUserCombo() {
    let timer = null;
    let seq = 0;
    let results = [];
    let active = -1;
    const render = () => {
      if (document.activeElement !== el.userInput) return;
      el.userDrop.replaceChildren(...(results.length ? results.map((u, i) => h('li', {
        role: 'option', 'aria-selected': String(i === active),
        onmousedown: (e) => { e.preventDefault(); pickUser(u); el.userInput.blur(); },
      }, h('span', { class: 'lg-avatar' }, initials(u.Name)),
      h('span', { class: 'lg-u' }, h('b', {}, u.Name, u.Id === S.me ? h('em', {}, ' · you') : null), h('small', {}, u.Username))))
        : [h('li', { class: 'lg-drop-note' }, 'No active users match')]));
      el.userDrop.hidden = false;
      el.userDrop.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    const search = async () => {
      const q = el.userInput.value.trim();
      const mine = ++seq;
      try {
        const res = await backend.searchUsers(q === (S.form.user?.Name || '') ? '' : q);
        if (mine !== seq) return;
        results = res;
        active = res.length ? 0 : -1;
        for (const u of res) S.users.set(u.Id, u);
        render();
      } catch (e) { toast(e.message, 'error'); }
    };
    el.userInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 220); });
    el.userInput.addEventListener('focus', () => { el.userInput.select(); search(); });
    el.userInput.addEventListener('blur', () => setTimeout(() => {
      el.userDrop.hidden = true;
      el.userInput.value = S.form.user?.Name || '';
    }, 120));
    el.userInput.addEventListener('keydown', (e) => {
      if (el.userDrop.hidden || !results.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        render();
      } else if (e.key === 'Enter' && results[active]) {
        e.preventDefault();
        pickUser(results[active]);
        el.userInput.blur();
      } else if (e.key === 'Escape') {
        el.userDrop.hidden = true;
      }
    });
  }

  async function pickAutomatedProcess() {
    try { S.apUser ||= await backend.automatedProcessUser(); } catch (e) { return toast(e.message, 'error'); }
    if (!S.apUser) return toast('This org has no Automated Process user', 'error');
    pickUser(S.apUser);
  }

  function pickUser(u) {
    if (!u) return;
    S.form.user = u;
    S.users.set(u.Id, u);
    el.userInput.value = u.Name;
    el.userDrop.hidden = true;
  }

  function renderLevels() {
    if (!S.levels.some((l) => l.Id === S.form.levelId)) {
      S.form.levelId = (S.levels.find((l) => l.DeveloperName === 'SFDC_DevConsole') || S.levels[0])?.Id || '';
    }
    el.levelSel.replaceChildren(...(S.levels.length
      ? S.levels.map((l) => h('option', { value: l.Id }, l.DeveloperName))
      : [h('option', { value: '' }, 'No debug levels yet — create one')]));
    el.levelSel.value = S.form.levelId;
    renderLevelPreview();
  }

  function renderLevelPreview() {
    const l = S.levels.find((x) => x.Id === S.form.levelId);
    el.levelPreview.replaceChildren(...(l ? LEVEL_FIELDS.filter((f) => l[f] && l[f] !== 'NONE').map((f) => h('span', {
      class: `lg-lvl v-${l[f].toLowerCase()}`, title: `${humanize(f)}: ${l[f]}`,
    }, h('i', {}, LEVEL_SHORT[f]), l[f])) : []));
  }

  function openLevelEditor() {
    const sels = {};
    const name = h('input', { type: 'text', placeholder: 'Name, e.g. My_Detailed_Logs', maxlength: '80', spellcheck: 'false' });
    const err = h('div', { class: 'lg-err', hidden: true });
    const apply = (preset) => { for (const f of LEVEL_FIELDS) sels[f].value = preset[f] || 'NONE'; };
    const grid = h('div', { class: 'lg-grid' }, LEVEL_FIELDS.map((f) => [
      h('span', {}, humanize(f)),
      sels[f] = h('select', { 'aria-label': humanize(f) }, LOG_LEVELS.map((v) => h('option', { value: v }, v))),
    ]));
    const save = async (e) => {
      const n = name.value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(n) || /__|_$/.test(n)) {
        err.textContent = 'Start with a letter; use letters, numbers and single underscores (not at the end).';
        err.hidden = false;
        name.focus();
        return;
      }
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const id = await backend.createDebugLevel(n, Object.fromEntries(LEVEL_FIELDS.map((f) => [f, sels[f].value])));
        S.levels = await backend.listDebugLevels();
        S.form.levelId = id;
        savePrefs({ levelId: id });
        renderLevels();
        el.levelEditor.hidden = true;
        toast(`Debug level ${n} created`, 'ok');
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
        btn.disabled = false;
      }
    };
    el.levelEditor.replaceChildren(
      h('div', { class: 'lg-editor-head' }, h('b', {}, 'New debug level'),
        h('div', { class: 'lg-presets' }, Object.entries(LEVEL_PRESETS).map(([k, v]) => h('button', { type: 'button', class: 'ghost small', onclick: () => apply(v) }, PRESET_LABEL[k])))),
      name, grid, err,
      h('div', { class: 'lg-row' },
        h('button', { type: 'button', class: 'primary small', onclick: save }, 'Create level'),
        h('button', { type: 'button', class: 'ghost small', onclick: () => { el.levelEditor.hidden = true; } }, 'Cancel')));
    apply(LEVEL_PRESETS.standard);
    el.levelEditor.hidden = false;
    name.focus();
  }

  async function submitFlag() {
    const u = S.form.user;
    if (!u) { el.userInput.focus(); return toast('Pick a user to trace', 'error'); }
    if (!S.form.levelId) return toast('Pick or create a debug level first', 'error');
    const start = el.start.value ? new Date(el.start.value) : new Date();
    const end = new Date(start.getTime() + S.form.hours * 3600e3);
    if (end <= new Date()) return toast('That time window has already ended. Move the start time forward.', 'error');
    const existing = S.form.editingFlagId || S.flags.find((f) => f.TracedEntityId === u.Id)?.Id;
    el.submit.disabled = true;
    try {
      await backend.saveTraceFlag({ id: existing, userId: u.Id, debugLevelId: S.form.levelId, start, end });
      toast(existing ? `Updated logging for ${u.Name} until ${fmtWhen(end)}` : `Logging ${u.Name} until ${fmtWhen(end)}`, 'ok');
      cancelEdit();
      await loadFlags();
      if (!S.live) setLive(true);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      el.submit.disabled = false;
    }
  }

  function editFlag(f) {
    S.form.editingFlagId = f.Id;
    const u = S.users.get(f.TracedEntityId);
    if (u) pickUser(u);
    if (S.levels.some((l) => l.Id === f.DebugLevelId)) {
      S.form.levelId = f.DebugLevelId;
      el.levelSel.value = f.DebugLevelId;
      renderLevelPreview();
    }
    const s = parseSfDate(f.StartDate);
    const e = parseSfDate(f.ExpirationDate);
    const start = s < new Date() ? new Date() : s;
    el.start.value = toLocalInput(start);
    setHours(Math.round((e - start) / 3600e3) || 1);
    el.formTitle.textContent = 'Edit trace flag';
    el.submit.textContent = 'Save changes';
    el.cancelEdit.hidden = false;
    toggleTrace(true);
  }

  function cancelEdit() {
    S.form.editingFlagId = null;
    el.formTitle.textContent = 'Trace a user';
    el.submit.textContent = 'Start logging';
    el.cancelEdit.hidden = true;
    el.start.value = toLocalInput(new Date());
    updateUntil();
  }

  // ---------- active trace flags ----------

  async function loadFlags() {
    try {
      S.flags = await backend.listTraceFlags();
      const missing = [...new Set(S.flags.map((f) => f.TracedEntityId))].filter((id) => !S.users.has(id));
      if (missing.length) for (const u of await backend.getUsers(missing)) S.users.set(u.Id, u);
    } catch (e) {
      toast(e.message, 'error');
    }
    renderFlags();
    if (!S.flagsLoaded) { S.flagsLoaded = true; if (S.sess.on) renderLogs(); }
  }

  function renderFlags() {
    const now = Date.now();
    const flags = S.flags.filter((f) => parseSfDate(f.ExpirationDate) > now);
    el.flags.replaceChildren(h('header', { class: 'lg-card-head' },
      h('span', {}, 'Active trace flags'), h('span', { class: 'lg-count' }, flags.length)));
    if (!flags.length) {
      el.flags.append(h('p', { class: 'lg-none' }, 'No users are being traced right now.'));
      return;
    }
    const ul = h('ul', { class: 'lg-flag-list' });
    for (const f of flags) {
      const s = parseSfDate(f.StartDate);
      const e = parseSfDate(f.ExpirationDate);
      const scheduled = s > now;
      const pct = scheduled ? 0 : Math.min(100, ((now - s) / (e - s)) * 100);
      const u = S.users.get(f.TracedEntityId);
      const lvl = S.levels.find((l) => l.Id === f.DebugLevelId);
      ul.append(h('li', { class: `lg-flag${scheduled ? ' scheduled' : ''}${e - now < 15 * 60e3 ? ' ending' : ''}` },
        h('span', { class: 'lg-avatar' }, initials(u?.Name)),
        h('div', { class: 'lg-flag-main' },
          h('div', { class: 'lg-flag-top' }, h('b', { title: u?.Username || '' }, u?.Name || f.TracedEntityId),
            lvl ? h('span', { class: 'lg-chip' }, lvl.DeveloperName) : null),
          h('div', { class: 'lg-flag-sub' }, h('span', { class: 'lg-live-dot' }),
            scheduled ? `Starts in ${fmtSpan(s - now)}` : `${fmtSpan(e - now)} left`,
            h('span', { class: 'lg-faint' }, `· until ${fmtTime(e)}`)),
          h('div', { class: 'lg-progress', title: `${Math.round(pct)}% elapsed` }, h('i', { style: `width:${pct}%` }))),
        h('div', { class: 'lg-flag-actions' },
          h('button', { class: 'ghost small', onclick: () => editFlag(f) }, 'Edit'),
          h('button', { class: 'ghost small danger-text', onclick: (ev) => armConfirm(ev.currentTarget, 'Stop?', () => stopFlag(f)) }, 'Stop'))));
    }
    el.flags.append(ul);
  }

  async function stopFlag(f) {
    try {
      await backend.deleteTraceFlag(f.Id);
      toast(`Stopped logging for ${S.users.get(f.TracedEntityId)?.Name || 'user'}`, 'ok');
      if (S.form.editingFlagId === f.Id) cancelEdit();
    } catch (e) {
      toast(e.message, 'error');
    }
    loadFlags();
  }

  // ---------- log list ----------

  function buildLogsBox() {
    el.logCount = h('span', { class: 'lg-count' }, '0');
    el.liveBtn = h('button', { class: 'lg-switch', role: 'switch', 'aria-checked': String(S.live), title: 'Refresh the list every 5 seconds', onclick: () => setLive(!S.live) }, h('i'), 'Live');
    el.refreshBtn = h('button', { class: 'ghost small lg-icon-btn', title: 'Refresh now', 'aria-label': 'Refresh', onclick: () => loadLogs(true) }, '↻');
    el.delAll = h('button', { class: 'ghost small danger-text', onclick: (e) => armConfirm(e.currentTarget, 'Confirm', deleteFiltered) }, 'Delete all');
    el.search = h('input', { type: 'search', placeholder: 'Filter by operation, user or status', spellcheck: 'false', 'aria-label': 'Filter logs' });
    el.userFilter = h('select', { 'aria-label': 'Filter by user' });
    el.errorsOnly = h('button', { class: 'lg-toggle', 'aria-pressed': 'false', onclick: () => {
      S.filter.errors = !S.filter.errors;
      el.errorsOnly.setAttribute('aria-pressed', String(S.filter.errors));
      renderLogs();
    } }, 'Errors only');
    el.logList = h('ul', { class: 'lg-log-list', tabindex: '0', role: 'listbox', 'aria-label': 'Debug logs' });
    el.modeBtns = ['list', 'sessions'].map((m) => h('button', {
      type: 'button', role: 'tab', 'data-mode': m,
      title: m === 'sessions' ? 'Group logs that ran close together into one session' : 'Every log on its own',
      onclick: () => setSessionMode(m === 'sessions'),
    }, m === 'list' ? 'List' : 'Sessions'));
    el.scope = h('div', { class: 'lg-scope', hidden: true });

    el.logsBox.append(
      h('header', { class: 'lg-card-head' }, h('span', {}, 'Debug logs'), el.logCount,
        h('div', { class: 'lg-head-tools' }, el.liveBtn, el.refreshBtn)),
      h('div', { class: 'lg-filters' },
        h('div', { class: 'lg-seg', role: 'tablist', 'aria-label': 'Log list mode' }, el.modeBtns),
        el.scope,
        el.search,
        h('div', { class: 'lg-row' }, el.userFilter, el.errorsOnly, el.delAll)),
      el.logList);

    el.search.addEventListener('input', () => { S.filter.q = el.search.value; renderLogs(); });
    el.userFilter.addEventListener('change', () => { S.filter.user = el.userFilter.value; renderLogs(); });
    el.logList.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = filteredLogs();
      const i = list.findIndex((l) => l.Id === S.selectedId);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next && next.Id !== S.selectedId) openLog(next.Id);
    });
  }

  const isError = (l) => !!l.Status && l.Status !== 'Success';

  function matchesQuery(l) {
    const q = S.filter.q.trim().toLowerCase();
    return !q || [l.Operation, l.LogUser?.Name, l.Status, l.Request, l.Location, l.Application]
      .some((v) => v && String(v).toLowerCase().includes(q));
  }

  // In Sessions mode filters apply to whole sessions, so a session is never split by a filter.
  function visibleSessions() {
    return buildSessions(S.logs).filter((g) => (!S.filter.errors || g.logs.some(isError)) && g.logs.some(matchesQuery));
  }

  function filteredLogs() {
    if (S.sess.on) return visibleSessions().flatMap((g) => [...g.logs].reverse());
    return S.logs.filter((l) => (!S.filter.user || l.LogUserId === S.filter.user)
      && (!S.filter.errors || isError(l)) && matchesQuery(l));
  }

  async function loadLogs(manual) {
    if (S.loadingLogs) return;
    S.loadingLogs = true;
    if (manual) el.refreshBtn.classList.add('spin');
    try {
      const logs = await backend.listLogs();
      if (S.knownIds) for (const l of logs) if (!S.knownIds.has(l.Id)) S.fresh.add(l.Id);
      S.knownIds = new Set(logs.map((l) => l.Id));
      S.logs = logs;
      renderLogs();
    } catch (e) {
      if (manual) toast(e.message, 'error');
      if (!S.logs.length) el.logList.replaceChildren(h('li', { class: 'lg-empty err' }, e.message));
    } finally {
      S.loadingLogs = false;
      el.refreshBtn.classList.remove('spin');
    }
  }

  function renderLogs() {
    side.refresh();
    const users = [...new Map(S.logs.map((l) => [l.LogUserId, l.LogUser?.Name || l.LogUserId])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    if (S.filter.user && !users.some(([id]) => id === S.filter.user)) S.filter.user = '';
    el.userFilter.replaceChildren(h('option', { value: '' }, 'All users'), ...users.map(([id, name]) => h('option', { value: id }, name)));
    el.userFilter.value = S.filter.user;
    for (const b of el.modeBtns) b.setAttribute('aria-selected', String((b.dataset.mode === 'sessions') === S.sess.on));
    el.userFilter.hidden = S.sess.on;
    if (S.sess.on) ensureScope();
    renderScope();

    const list = filteredLogs();
    const filtered = list.length !== S.logs.length;
    el.logCount.textContent = filtered ? `${list.length} / ${S.logs.length}` : String(S.logs.length);
    if (!el.delAll.dataset.armed) el.delAll.textContent = filtered ? `Delete ${list.length}` : 'Delete all';
    el.delAll.disabled = !list.length;
    if (!list.length) {
      el.logList.replaceChildren(h('li', { class: 'lg-empty' }, S.logs.length
        ? (S.sess.on ? 'No logs from these users. Add a user above.' : 'No logs match these filters.')
        : S.flags.length ? 'Waiting for logs… use Salesforce as a traced user and they’ll show up here.'
          : 'No logs yet. Start a trace flag above, then use Salesforce as that user.'));
      return;
    }
    if (S.sess.on) {
      const latest = buildSessions(S.logs)[0];
      S.sess.latest = latest ? { id: latest.logs[0].Id, ids: new Set(latest.logs.map((l) => l.Id)) } : null;
    }
    el.logList.replaceChildren(...(S.sess.on ? visibleSessions().map(sessionRow) : list.map((l) => logRow(l))));
  }

  const isIncluded = (l) => (S.sess.pick.has(l.Id) ? S.sess.pick.get(l.Id) : !!S.sess.latest?.ids.has(l.Id));

  function logRow(l, o = {}) {
    const d = parseSfDate(l.StartTime);
    const err = isError(l);
    const included = isIncluded(l);
    const check = o.check ? h('input', {
      type: 'checkbox', class: 'lg-check', 'aria-label': 'Include in merged session',
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { S.sess.pick.set(l.Id, e.target.checked); renderLogs(); },
    }) : null;
    if (check) check.checked = included;
    return h('li', {
      class: `lg-log${err ? ' err' : ''}${S.fresh.has(l.Id) ? ' fresh' : ''}${o.check && !included ? ' excluded' : ''}`,
      role: 'option', 'aria-selected': String(l.Id === S.selectedId), 'data-id': l.Id,
      onclick: () => openLog(l.Id),
    },
    check,
    h('div', { class: 'lg-log-body' },
      h('div', { class: 'lg-log-r1' },
        h('span', { class: 'lg-op', title: l.Operation }, l.Operation || '(unknown operation)'),
        isBogusDuration(l.DurationMilliseconds)
          ? h('span', { class: 'lg-dur bogus', title: `Salesforce reports ${fmtMs(l.DurationMilliseconds)} for this log. For async jobs this usually includes time waiting in the queue, so it's ignored when grouping sessions.` }, `${fmtMs(l.DurationMilliseconds)}*`)
          : h('span', { class: 'lg-dur' }, fmtMs(l.DurationMilliseconds))),
      h('div', { class: 'lg-log-time' },
        h('time', { datetime: l.StartTime, title: `Started ${fmtFull(d)}` }, h('span', { class: 'lg-date' }, fmtDate(d)), ' ', h('b', {}, fmtClock(d))),
        o.offset != null
          ? h('span', { class: 'lg-offset', title: 'Time since the first log of this session' }, fmtAt(o.offset))
          : h('span', { class: 'lg-ago' }, fmtAgo(d))),
      h('div', { class: 'lg-log-r2' },
        h('span', { class: 'lg-user' }, l.LogUser?.Name || ''),
        h('span', { class: 'lg-size' }, fmtBytes(l.LogLength || 0))),
      err ? h('div', { class: 'lg-log-err', title: l.Status }, l.Status) : null));
  }

  // ---------- sessions: logs that ran close together, from the chosen users ----------

  const startMs = (l) => +parseSfDate(l.StartTime);
  const sessionKey = (logs) => `session:${logs.map((l) => l.Id).join(',')}`;
  const userName = (id) => S.users.get(id)?.Name || S.logs.find((l) => l.LogUserId === id)?.LogUser?.Name || id;

  function setSessionMode(on) {
    S.sess.on = on;
    saveSessPrefs();
    renderLogs();
  }

  // Default scope: the users being traced right now, else the user picked in the trace form.
  function ensureScope() {
    if (S.sess.users || !S.flagsLoaded) return;
    const now = Date.now();
    const traced = S.flags.filter((f) => parseSfDate(f.ExpirationDate) > now).map((f) => f.TracedEntityId);
    const ids = [...new Set(traced.length ? traced : [S.form.user?.Id || S.logs[0]?.LogUserId].filter(Boolean))];
    if (!ids.length) return;
    S.sess.users = ids;
    saveSessPrefs();
  }

  function saveSessPrefs() {
    savePrefs({ sessions: S.sess.on, sessUsers: S.sess.users, gap: S.sess.gap });
  }

  const buildSessions = (logs) => groupSessions(logs, { gapSec: S.sess.gap, users: S.sess.users });

  function sessionRow(g) {
    const gid = g.logs[0].Id;
    const latest = S.sess.latest?.id === gid;
    if (g.logs.length === 1) {
      const row = logRow(g.logs[0]);
      if (latest) row.querySelector('.lg-log-r1').append(h('span', { class: 'lg-latest' }, 'Latest'));
      return row;
    }
    const expanded = S.sess.expanded.has(gid) ? S.sess.expanded.get(gid) : latest;
    const sel = g.logs.filter(isIncluded);
    const n = g.logs.length;
    const errs = g.logs.filter(isError).length;
    const users = [...new Set(g.logs.map((l) => l.LogUser?.Name || l.LogUserId))];
    const start = new Date(g.start);
    const end = new Date(g.end);
    const toggle = () => { S.sess.expanded.set(gid, !expanded); renderLogs(); };

    const all = h('input', { type: 'checkbox', class: 'lg-check', 'aria-label': 'Include all logs of this session', onclick: (e) => e.stopPropagation() });
    all.checked = sel.length === n;
    all.indeterminate = sel.length > 0 && sel.length < n;
    all.addEventListener('change', () => {
      for (const l of g.logs) S.sess.pick.set(l.Id, all.checked);
      renderLogs();
    });
    const ids = (sel.length ? sel : g.logs).map((l) => l.Id);
    const open = h('button', {
      class: 'primary small',
      title: sel.length ? 'Open the ticked logs as one execution' : 'Nothing is ticked: open every log of this session',
      onclick: (e) => { e.stopPropagation(); openSession(ids); },
    }, !sel.length ? `Open all ${n}` : sel.length === 1 ? 'Open log' : sel.length === n ? `Open ${n} as one` : `Open ${sel.length} of ${n}`);
    const range = fmtDate(start) === fmtDate(end) ? `${fmtFull(start)} → ${fmtClock(end)}` : `${fmtFull(start)} → ${fmtFull(end)}`;

    return h('li', { class: `lg-sess${errs ? ' err' : ''}${latest ? ' latest' : ''}${expanded ? ' expanded' : ''}${S.selectedId === sessionKey(sel.length ? sel : g.logs) ? ' open' : ''}` },
      h('div', { class: 'lg-sess-head', onclick: toggle },
        h('button', { type: 'button', class: 'lg-sess-caret', 'aria-expanded': String(expanded), 'aria-label': expanded ? 'Hide the logs of this session' : 'Show the logs of this session', onclick: (e) => { e.stopPropagation(); toggle(); } }, '▸'),
        all,
        h('div', { class: 'lg-sess-info' },
          h('div', { class: 'lg-sess-line' },
            h('b', {}, `${n} logs`, h('span', {}, ` · ${fmtMs(g.end - g.start)}`)),
            latest ? h('span', { class: 'lg-latest' }, 'Latest') : null,
            errs ? h('span', { class: 'lg-sess-err push', title: `${errs} log${errs === 1 ? '' : 's'} with errors` }, `✕ ${errs}`) : null),
          h('div', { class: 'lg-sess-line lg-sess-range', title: 'First log started → last log ended' }, range),
          h('div', { class: 'lg-sess-line' },
            h('small', { title: users.join(', ') }, `${fmtAgo(start)} · ${users.join(', ')}`),
            h('span', { class: 'push' }, open)))),
      expanded ? h('ul', { class: 'lg-sess-logs' }, g.logs.map((l) => logRow(l, { check: true, offset: startMs(l) - g.start }))) : null);
  }

  function renderScope() {
    el.scope.hidden = !S.sess.on;
    if (!S.sess.on) return;
    const scope = S.sess.users || [];
    const known = new Map();
    const note = (id, name) => { if (id && !scope.includes(id) && !known.has(id)) known.set(id, name); };
    for (const f of S.flags) note(f.TracedEntityId, userName(f.TracedEntityId));
    for (const l of S.logs) note(l.LogUserId, l.LogUser?.Name || l.LogUserId);
    if (S.meUser) note(S.meUser.Id, S.meUser.Name);
    const isAp = (id, name) => id === S.apUser?.Id || name === 'Automated Process';
    const apIn = scope.some((id) => isAp(id, userName(id)));
    const add = h('select', { class: 'lg-scope-add', 'aria-label': 'Add a user to the session' },
      h('option', { value: '' }, '+ Add user'),
      apIn ? null : h('option', { value: '__ap__' }, 'Automated Process (system)'),
      [...known].filter(([id, name]) => !isAp(id, name)).sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => h('option', { value: id }, name)));
    add.addEventListener('change', async () => {
      let id = add.value;
      if (id === '__ap__') {
        try { S.apUser ||= await backend.automatedProcessUser(); } catch (e) { toast(e.message, 'error'); }
        if (!S.apUser) { toast('This org has no Automated Process user', 'error'); renderLogs(); return; }
        S.users.set(S.apUser.Id, S.apUser);
        id = S.apUser.Id;
      }
      if (id && !scope.includes(id)) { S.sess.users = [...scope, id]; saveSessPrefs(); }
      renderLogs();
    });
    const gap = h('select', { class: 'lg-scope-gap', 'aria-label': 'Gap between logs', title: 'Logs closer together than this belong to the same session' },
      [2, 5, 10, 30, 60].map((s) => h('option', { value: s }, `${s}s gap`)));
    gap.value = String(S.sess.gap);
    gap.addEventListener('change', () => { S.sess.gap = +gap.value; saveSessPrefs(); renderLogs(); });
    el.scope.replaceChildren(
      h('div', { class: 'lg-scope-chips' },
        scope.map((id, i) => h('span', { class: `lg-ucchip${i === 0 ? ' target' : ''}`, title: i === 0 ? 'Target user' : 'Also included' },
          h('span', { class: 'lg-avatar' }, initials(userName(id))),
          userName(id),
          h('button', {
            type: 'button', 'aria-label': `Remove ${userName(id)}`,
            onclick: () => { S.sess.users = scope.filter((x) => x !== id); saveSessPrefs(); renderLogs(); },
          }, '×'))),
        add),
      gap);
  }

  async function openSession(ids) {
    const metas = ids.map((id) => S.logs.find((l) => l.Id === id)).filter(Boolean).sort((a, b) => startMs(a) - startMs(b));
    if (metas.length === 1) return openLog(metas[0].Id);
    const key = sessionKey(metas);
    S.selectedId = key;
    for (const li of el.logList.querySelectorAll('[aria-selected="true"]')) li.setAttribute('aria-selected', 'false');
    for (const li of el.logList.querySelectorAll('.lg-sess.open')) li.classList.remove('open');
    if (!S.parsed.has(key)) {
      const ld = loadingView(metas.map((m) => ({
        label: m.Operation || 'Log', sub: `${fmtClock(parseSfDate(m.StartTime))} · ${m.LogUser?.Name || ''}`, total: m.LogLength || 0,
      })));
      el.main.replaceChildren(ld.el);
      try {
        const bodies = await Promise.all(metas.map(async (m, i) => {
          const cached = S.bodies.get(m.Id);
          const b = cached ?? await backend.getLogBody(m.Id, { onProgress: (got, total) => ld.progress(i, got, total) });
          ld.done(i, cached != null);
          return b;
        }));
        if (S.selectedId !== key) return;
        ld.status('Merging…');
        await tick();
        const p = mergeLogs(metas.map((meta, i) => ({ meta, body: bodies[i] })));
        p.summary = summarize(p);
        p.paths = errorPaths(p);
        const span = p.durationNs / 1e6;
        p.meta = {
          Id: key, merged: true, Operation: `Session · ${metas.length} logs`, StartTime: metas[0].StartTime,
          LogUser: { Name: [...new Set(metas.map((m) => m.LogUser?.Name || m.LogUserId))].join(', ') },
          DurationMilliseconds: span, LogLength: metas.reduce((t, m) => t + (m.LogLength || 0), 0),
          Request: `${metas.length} transactions`, Status: metas.some(isError) ? 'Errors in this session' : 'Success',
        };
        S.bodies.set(key, p.lines.join('\n'));
        S.parsed.set(key, p);
        while (S.parsed.size > MAX_CACHED) {
          const old = S.parsed.keys().next().value;
          S.parsed.delete(old);
          S.bodies.delete(old);
        }
        updateMem();
      } catch (e) {
        if (S.selectedId !== key) return;
        el.main.replaceChildren(h('div', { class: 'lg-welcome' },
          h('p', { class: 'empty-title' }, 'Couldn’t open this session'), h('p', { class: 'lv-errtext' }, e.message)));
        return;
      }
      if (S.selectedId !== key) return;
    }
    renderLogs();
    S.openMeta = S.parsed.get(key).meta;
    S.raw.matchPos = -1;
    S.dv.shown = PAGE;
    S.xp = { mode: null, selKey: null, focus: 0 };
    renderViewer();
  }

  // ---------- memory: what the opened logs and sessions hold, and a way to let it go ----------
  // Rough size in the browser: the raw text (strings are 2 bytes a char), the split lines again,
  // plus per-line bookkeeping (category byte, tree nodes, queries, DML…).
  const MEM_HEAVY = 60 * 1024 * 1024;
  const sizeOfParsed = (p) => {
    if (p.memBytes == null) {
      let chars = 0;
      for (const l of p.lines) chars += l.length;
      p.memBytes = chars * 2 + p.lines.length * 90;
    }
    return p.memBytes;
  };
  function memStats() {
    let bytes = 0;
    for (const b of S.bodies.values()) bytes += (b?.length || 0) * 2;
    let logs = 0;
    let sessions = 0;
    for (const p of S.parsed.values()) {
      bytes += sizeOfParsed(p);
      if (p.merged) sessions++; else logs++;
    }
    return { bytes, logs, sessions };
  }
  const memText = (b) => (b >= 1024 * 1024 ? `${Math.round(b / 1024 / 1024)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  // the button lives in the open log's header, next to Download / Copy
  function memButton() {
    el.memBtn = h('button', {
      class: 'ghost small lg-mem', hidden: true, 'aria-describedby': 'lg-mem-tip',
      onclick: freeMemory, onpointerenter: showMemTip, onpointerleave: hideMemTip, onfocus: showMemTip, onblur: hideMemTip,
    }, h('span', { class: 'lg-mem-icon', 'aria-hidden': 'true' }, '🧹'), h('span', { class: 'lg-mem-label' }, 'Free memory'));
    return el.memBtn;
  }

  function updateMem() {
    if (!el.memBtn?.isConnected) return;
    const m = memStats();
    const any = m.logs + m.sessions > 0;
    el.memBtn.hidden = !any;
    if (!any) { el.memBtn.classList.remove('heavy'); S.memHeavy = false; return; }
    // an estimate from the loaded text, hence the "~"
    el.memBtn.querySelector('.lg-mem-label').textContent = `Free memory · ~${memText(m.bytes)}`;
    el.memBtn.setAttribute('aria-label', `Free memory: unload ${m.logs + m.sessions} opened log${m.logs + m.sessions === 1 ? '' : 's'}, roughly ${memText(m.bytes)}`);
    // heavy: lots of text in memory, or a big merged session
    const bigSession = [...S.parsed.values()].some((p) => p.merged && p.txs?.length >= 6);
    const heavy = m.bytes >= MEM_HEAVY || bigSession;
    el.memBtn.classList.toggle('heavy', heavy);
    if (heavy && !S.memHeavy) {
      // one soft sheen when it first gets heavy, never a loop
      el.memBtn.classList.remove('shine');
      void el.memBtn.offsetWidth;
      el.memBtn.classList.add('shine');
      setTimeout(() => el.memBtn?.classList.remove('shine'), 1600);
    }
    S.memHeavy = heavy;
    if (S.memTip) showMemTip();
  }

  function showMemTip() {
    const m = memStats();
    const n = m.logs + m.sessions;
    const what = [m.logs ? `${m.logs} log${m.logs === 1 ? '' : 's'}` : null, m.sessions ? `${m.sessions} session${m.sessions === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
    S.memTip ||= document.body.appendChild(h('div', { class: 'lg-mem-tip', id: 'lg-mem-tip', role: 'tooltip' }));
    // Chrome/Edge report the page's real JavaScript memory; other browsers don't
    const heap = performance.memory?.usedJSHeapSize;
    S.memTip.replaceChildren(
      h('b', {}, S.memHeavy ? 'Things are getting heavy' : 'Free up memory'),
      h('span', {}, `${what} you opened ${n === 1 ? 'is' : 'are'} kept in memory, so switching back is instant. `,
        'Big sessions can slow down the whole tool, including Code Flow and Data Export.'),
      h('dl', { class: 'lg-mem-nums' },
        h('dt', {}, 'Opened logs'), h('dd', {}, `~${memText(m.bytes)}`, h('small', {}, ' estimated from their text')),
        heap ? [h('dt', {}, 'Whole page now'), h('dd', {}, memText(heap), h('small', {}, ' measured by the browser'))] : null),
      h('span', { class: 'lg-mem-tip-s' }, 'Click to unload them. The list stays; opening a log again just downloads it again.'));
    const r = el.memBtn.getBoundingClientRect();
    const w = 290;
    S.memTip.style.width = `${w}px`;
    S.memTip.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    S.memTip.style.top = `${r.bottom + 8}px`;
  }
  function hideMemTip() {
    S.memTip?.remove();
    S.memTip = null;
  }

  function freeMemory() {
    const m = memStats();
    if (!m.logs && !m.sessions) return;
    hideMemTip();
    if (document.querySelector('.fx')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // close the full-screen view
    S.parsed.clear();
    S.bodies.clear();
    S.selectedId = null;
    S.openMeta = null;
    S.ftResult = null;
    S.ftIndex = null;
    S.xp = { mode: null, selKey: null, focus: 0 };
    renderEmptyMain(); // drops the viewer's DOM too
    renderLogs();
    side.refresh();
    updateMem();
    const what = [m.logs ? `${m.logs} log${m.logs === 1 ? '' : 's'}` : null, m.sessions ? `${m.sessions} session${m.sessions === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
    toast(`Unloaded ${what} · roughly ${memText(m.bytes)} freed`, 'ok');
  }

  // ---------- Rescan Apex: the class was fixed in the Developer Console, bring the new code in ----------
  async function rescanApex(btn) {
    const label = btn?.querySelector('.lg-rescan-label');
    if (btn) { btn.disabled = true; btn.classList.add('busy'); label.textContent = 'Rescanning…'; }
    try {
      const r = await sources.rescan();
      // Field Trace results came from the old code scan
      for (const p of S.parsed.values()) p.ftCache?.clear();
      S.ftIndex = null;
      // re-open what's on screen with the fresh code (the full-screen view too, if it was open)
      const fx = !!document.querySelector('.fx');
      if (fx) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if (S.tab === 'field') showTab('field');
      else if (S.lastOpen && el.xpCode?.isConnected) {
        await openFrame(S.lastOpen);
        if (fx) el.xpCode.focusOpen?.();
      }
      const names = (list) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} +${list.length - 3}` : list.join(', '));
      const parts = [
        r.changed.length ? `${r.changed.length} changed (${names(r.changed)})` : null,
        r.added.length ? `${r.added.length} new (${names(r.added)})` : null,
        r.removed.length ? `${r.removed.length} deleted` : null,
      ].filter(Boolean);
      toast(parts.length ? `Apex refreshed: ${parts.join(' · ')}` : 'Apex is up to date: nothing changed since the last scan', 'ok');
    } catch (e) {
      toast(`Couldn’t rescan the Apex: ${e.message}`, 'error');
    } finally {
      if (btn?.isConnected) { btn.disabled = false; btn.classList.remove('busy'); label.textContent = 'Rescan Apex'; }
    }
  }

  // Which code is on screen when the class changed after this log ran
  function versionNote(unit, onLatest) {
    const v = unit.version;
    if (!v) return null;
    const when = fmtFull(parseSfDate(v.changedAt));
    if (v.kind === 'older') {
      return h('div', { class: 'code-ver older', role: 'note' },
        h('span', { 'aria-hidden': 'true' }, '🕰'),
        h('span', {}, h('b', {}, 'The code this log ran. '), `${unit.name} was changed after it (${when}).`),
        onLatest ? h('button', { class: 'link', onclick: onLatest }, 'Show latest') : null);
    }
    return h('div', { class: 'code-ver newer', role: 'note' },
      h('span', { 'aria-hidden': 'true' }, '⚠'),
      h('span', {}, h('b', {}, `${unit.name} changed after this log ran `), `(${when}). Line numbers may not match. Run it again for a new log.`));
  }

  async function deleteLogs(ids) {
    if (!ids.length) return;
    try {
      await backend.deleteLogs(ids);
      const gone = new Set(ids);
      S.logs = S.logs.filter((l) => !gone.has(l.Id));
      for (const id of ids) { S.bodies.delete(id); S.parsed.delete(id); }
      updateMem();
      if (gone.has(S.selectedId)) { S.selectedId = null; renderEmptyMain(); }
      renderLogs();
      toast(`Deleted ${ids.length} log${ids.length === 1 ? '' : 's'}`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
      loadLogs(false);
    }
  }

  const deleteFiltered = () => deleteLogs(filteredLogs().map((l) => l.Id));

  function setLive(on) {
    S.live = on;
    savePrefs({ live: on });
    el.liveBtn.setAttribute('aria-checked', String(on));
    schedule();
  }

  function schedule() {
    clearInterval(S.timer);
    S.timer = S.active && S.live ? setInterval(() => { if (!document.hidden) loadLogs(false); }, POLL_MS) : null;
  }

  // ---------- log viewer ----------

  function renderEmptyMain() {
    el.main.replaceChildren(h('div', { class: 'lg-welcome' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('p', { class: 'empty-title' }, 'Pick a log to inspect it'),
      h('p', { class: 'empty-sub' }, 'Every log is broken down into queries, DML, debug output, the order of execution and governor limits.'),
      h('div', { class: 'lg-steps' },
        h('div', {}, h('b', {}, '1 · Trace'), h('span', {}, 'Pick a user, a debug level and how long to log.')),
        h('div', {}, h('b', {}, '2 · Reproduce'), h('span', {}, 'Use Salesforce as that user. With Live on, logs appear on their own.')),
        h('div', {}, h('b', {}, '3 · Inspect'), h('span', {}, 'Open a log. Use ↑ ↓ in the list to step through logs.')))));
  }

  async function openLog(id) {
    S.selectedId = id;
    S.fresh.delete(id);
    for (const li of el.logList.children) {
      li.setAttribute('aria-selected', String(li.dataset.id === id));
      if (li.dataset.id === id) { li.classList.remove('fresh'); li.scrollIntoView({ block: 'nearest' }); }
    }
    const meta = S.logs.find((l) => l.Id === id) || S.extraLogs?.get(id);
    if (!S.parsed.has(id)) {
      const ld = loadingView([{
        label: meta?.Operation || 'Log', sub: meta ? `${fmtClock(parseSfDate(meta.StartTime))} · ${meta.LogUser?.Name || ''}` : '', total: meta?.LogLength || 0,
      }]);
      el.main.replaceChildren(ld.el);
      try {
        const cached = S.bodies.get(id);
        const body = cached ?? await backend.getLogBody(id, { onProgress: (got, total) => ld.progress(0, got, total) });
        if (S.selectedId !== id) return;
        ld.done(0, cached != null);
        ld.status('Analysing…');
        await tick();
        const p = parseLog(body);
        p.summary = summarize(p);
        p.paths = errorPaths(p);
        S.bodies.set(id, body);
        S.parsed.set(id, p);
        while (S.parsed.size > MAX_CACHED) {
          const old = S.parsed.keys().next().value;
          S.parsed.delete(old);
          S.bodies.delete(old);
        }
        updateMem();
      } catch (e) {
        if (S.selectedId !== id) return;
        el.main.replaceChildren(h('div', { class: 'lg-welcome' },
          h('p', { class: 'empty-title' }, 'Couldn’t load this log'), h('p', { class: 'lv-errtext' }, e.message)));
        return;
      }
      if (S.selectedId !== id) return;
    }
    S.openMeta = meta || S.openMeta;
    S.raw.matchPos = -1;
    S.dv.shown = PAGE;
    S.xp = { mode: null, selKey: null, focus: 0 };
    renderViewer();
  }

  function renderViewer() {
    const p = S.parsed.get(S.selectedId);
    const log = S.openMeta;
    const s = p.summary;
    const err = isError(log) || !!s.fatal;
    const tabs = [
      ['details', 'Log Details', null],
      ['path', 'Execution Path', p.paths.length ? `${p.paths.length} ✕` : null, p.paths.length ? 'bad' : ''],
      ['field', 'Field Trace', null],
      ['raw', 'Debug Log', null],
      ['queries', 'Queries', s.soql],
      ['debug', 'User Debug', s.debugs],
      ['order', 'Order of Execution', null],
      ['dml', 'DML', s.dml],
      ['limits', 'Governor Limits', s.cpu && pctOf(s.cpu) >= 50 ? '!' : null],
      ['org', 'Org Limits', null],
    ];
    el.vTabs = h('nav', { class: 'lv-tabs', role: 'tablist' }, tabs.map(([k, label, n, tone]) => h('button', {
      role: 'tab', 'data-tab': k, 'aria-selected': String(S.tab === k), onclick: () => showTab(k),
    }, label, n ? h('span', { class: `lv-n${n === '!' || tone === 'bad' ? ' bad' : ''}` }, n) : null)));
    el.vBody = h('div', { class: 'lv-body' });
    const metaItem = (label, value) => (value ? h('span', {}, `${label} `, h('b', {}, value)) : null);
    // one-line summary shown instead of the meta line and transaction strip when the header is collapsed
    const inline = [
      fmtMs(log.DurationMilliseconds),
      fmtBytes(log.LogLength || 0),
      p.merged ? `${p.txs.length} transactions` : null,
      log.LogUser?.Name,
    ].filter(Boolean).join(' · ');
    const lv = h('div', { class: `lv${S.headCompact ? ' head-compact' : ''}` });
    const headToggle = h('button', {
      class: 'ghost small lv-head-toggle', 'aria-expanded': String(!S.headCompact),
      onclick: () => {
        S.headCompact = !S.headCompact;
        savePrefs({ headCompact: S.headCompact });
        lv.classList.toggle('head-compact', S.headCompact);
        headToggle.setAttribute('aria-expanded', String(!S.headCompact));
        headToggle.title = S.headCompact ? 'Show log details and transactions' : 'Collapse this header to make room';
      },
      title: S.headCompact ? 'Show log details and transactions' : 'Collapse this header to make room',
      'aria-label': 'Toggle header details',
    }, h('span', { class: 'lv-head-chev', 'aria-hidden': 'true' }, '▴'));
    el.main.replaceChildren(lv);
    lv.append(
      h('header', { class: 'lv-head' },
        h('div', { class: 'lv-title' },
          h('span', { class: `lv-status ${err ? 'bad' : 'ok'}` }, err ? 'Error' : 'Success'),
          h('h2', { title: log.Operation }, log.Operation || 'Debug log'),
          p.merged ? h('span', { class: 'lv-merged', title: 'Several logs shown as one execution' }, `${p.txs.length} logs merged`) : null,
          h('span', { class: 'lv-inline-meta', title: `Started ${fmtFull(parseSfDate(log.StartTime))}` }, inline),
          h('div', { class: 'lv-actions' },
            memButton(),
            sources.rescan ? h('button', {
              class: 'ghost small lg-rescan', onclick: (e) => rescanApex(e.currentTarget),
              title: 'Fixed a class in the Developer Console? Fetch the latest Apex from the org (only what changed).\nLogs written before your change keep showing the code they ran.',
            }, h('span', { class: 'lg-rescan-i', 'aria-hidden': 'true' }, '↻'), h('span', { class: 'lg-rescan-label' }, 'Rescan Apex')) : null,
            h('button', { class: 'ghost small', onclick: () => download(log, S.bodies.get(log.Id)) }, '⤓ Download'),
            h('button', { class: 'ghost small', onclick: () => copyText(S.bodies.get(log.Id)) }, 'Copy'),
            p.merged || log.local ? null : h('button', { class: 'ghost small danger-text', onclick: (e) => armConfirm(e.currentTarget, 'Confirm delete', () => deleteLogs([log.Id])) }, 'Delete'),
            headToggle)),
        h('div', { class: 'lv-meta' },
          metaItem(p.merged ? 'Users' : 'User', log.LogUser?.Name),
          metaItem('Started', fmtFull(parseSfDate(log.StartTime))),
          metaItem(p.merged ? 'Span' : 'Duration', fmtMs(log.DurationMilliseconds)),
          metaItem('Size', fmtBytes(log.LogLength || 0)),
          metaItem('Lines', num(p.lines.length)),
          metaItem(p.merged ? 'Transactions' : 'Request', p.merged ? String(p.txs.length) : log.Request))),
      ...(p.merged ? [txStrip(p)] : []), // append() would print a null as the text "null"
      el.vTabs, el.vBody);
    showTab(S.tab);
    side.refresh();
    updateMem();
  }

  function showTab(k) {
    S.tab = k;
    for (const b of el.vTabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === k));
    const p = S.parsed.get(S.selectedId);
    el.vBody.replaceChildren();
    el.vBody.className = `lv-body t-${k}`;
    el.vBody.scrollTop = 0;
    ({ details: renderDetails, path: renderPath, field: renderFieldTrace, raw: renderRaw, queries: renderQueries, debug: renderDebugs, order: renderOrder, dml: renderDml, limits: renderLimits, org: renderOrgLimits })[k](p);
  }

  function jumpTo(li) {
    S.jump = li;
    showTab('raw');
  }

  function lineLink(item) {
    return h('button', {
      class: 'lv-ln', title: `Show in Debug Log (log line ${item.li + 1})`,
      onclick: (e) => { e.stopPropagation(); jumpTo(item.li); },
    }, item.line != null ? `L${item.line}` : `#${item.li + 1}`);
  }

  // One chip per transaction in a merged session, laid out on the session's timeline.
  function txStrip(p) {
    const total = Math.max(1, p.root.end);
    return h('div', { class: 'tx-strip', role: 'list', 'aria-label': 'Transactions in this session' }, p.txs.map((t) => {
      const err = isError(t.meta);
      const unit = codeKids(t.node).find((n) => n.kind === 'unit');
      const entry = unit ? entryOf(unit) : null;
      return h('button', {
        class: `tx-chip${err ? ' err' : ''}`, role: 'listitem',
        title: `${t.meta.Operation} · ${t.meta.LogUser?.Name || ''} · ${fmtMs(t.meta.DurationMilliseconds)}${err ? ` · ${t.meta.Status}` : ''}\nClick to jump to this transaction in the Debug Log`,
        onclick: () => jumpTo(t.node.li),
      },
      h('span', { class: 'tx-n' }, `T${t.tx}`),
      entry ? h('span', { class: 'entry', style: `--e:${entry[1]}` }, entry[0]) : null,
      h('span', { class: 'tx-name' }, unit ? displayName(unit) : t.meta.Operation),
      h('span', { class: 'tx-at' }, fmtAt(t.node.start / 1e6)),
      err ? h('span', { class: 'xp-x' }, '✕') : null,
      h('i', { class: 'tx-bar', style: barStyle(t.node, 0, total) }));
    }));
  }

  function download(log, text) {
    const stamp = String(log.StartTime || '').slice(0, 19).replace(/[:T]/g, '-');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = h('a', { href: url, download: log.merged ? `apex-session-${stamp}.log` : `apex-log-${stamp}-${log.Id}.log` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); } catch { toast('Couldn’t access the clipboard', 'error'); }
  }

  // ---------- tab: details ----------

  function renderDetails(p) {
    const s = p.summary;
    const log = S.openMeta;
    const body = el.vBody;
    const seen = new Set();
    const alerts = [...p.errors.filter((e) => e.fatal), ...p.errors.filter((e) => !e.fatal)]
      .filter((e) => { const k = e.msg.split('\n')[0]; if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 4);
    for (const e of alerts) {
      body.append(h('div', { class: `lv-alert${e.fatal ? '' : ' warn'}` },
        h('b', {}, e.fatal ? 'Fatal error' : 'Exception'),
        h('pre', {}, e.msg),
        h('div', { class: 'lv-alert-foot' },
          e.context ? h('span', {}, `in ${e.context}`) : null,
          e.line ? h('span', {}, `line ${e.line}`) : null,
          h('button', { class: 'link', onclick: () => jumpTo(e.li) }, 'Show in log'),
          h('button', { class: 'link', onclick: () => openPathFor(e) }, 'View execution path →'))));
    }

    const limSub = (l) => (l ? `${l.used && pctOf(l) < 1 ? '<1' : Math.round(pctOf(l))}% of ${num(l.max)}` : null);
    const tile = (label, value, sub, tone, onclick) => h(onclick ? 'button' : 'div', { class: `lv-tile${tone ? ' ' + tone : ''}`, onclick },
      h('span', { class: 'lv-tile-l' }, label), h('b', {}, value), sub ? h('span', { class: 'lv-tile-s' }, sub) : null);
    body.append(h('div', { class: 'lv-tiles' },
      tile(p.merged ? 'Session span' : 'Duration', fmtMs(s.durationMs), p.merged ? `${p.txs.length} transactions` : `${num(p.lines.length)} log lines`),
      tile(p.merged ? 'CPU time (worst tx)' : 'CPU time', s.cpu ? `${num(s.cpu.used)} ms` : '—', limSub(s.cpu), s.cpu && toneOf(pctOf(s.cpu)) !== 'ok' ? toneOf(pctOf(s.cpu)) : null, () => showTab('limits')),
      tile('SOQL queries', num(s.soql), `${num(s.rows)} rows${s.repeated ? ` · ${s.repeated} repeated` : ''}`, s.repeated ? 'warn' : null, () => showTab('queries')),
      tile('DML statements', num(s.dml), `${num(s.dmlRows)} rows`, null, () => showTab('dml')),
      tile('Debug statements', num(s.debugs), null, null, () => showTab('debug')),
      tile('Exceptions', num(s.errors), s.fatal ? 'includes a fatal error' : null, s.errors ? 'bad' : null, s.errors ? () => jumpTo(p.errors[0].li) : null),
      tile('Heap', s.heap ? fmtBytes(s.heap.used) : '—', limSub(s.heap), s.heap && toneOf(pctOf(s.heap)) !== 'ok' ? toneOf(pctOf(s.heap)) : null),
      tile('Callouts', num(s.callouts), s.callouts ? fmtMs(p.callouts.reduce((t, c) => t + (c.dur || 0), 0) / 1e6) : null)));

    const dl = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
    const levelName = (c) => c.charAt(0) + c.slice(1).toLowerCase().replace(/_/g, ' ');
    if (p.merged) {
      body.append(h('section', { class: 'lv-panel lv-txs' },
        h('h3', {}, `Transactions · ${p.txs.length}`, h('span', { class: 'lv-muted' }, ' · governor limits apply to each one separately')),
        h('div', { class: 'lv-table-wrap flat' }, h('table', { class: 'lv-table' },
          h('thead', {}, h('tr', {}, ['#', 'Started', 'Operation', 'User', 'Duration', 'CPU', 'Status', ''].map((c, i) => h('th', { class: [1, 4, 5].includes(i) ? 'num' : null }, c)))),
          h('tbody', {}, p.txs.map((t) => {
            const err = isError(t.meta);
            return h('tr', { class: err ? 'warn' : null, onclick: () => jumpTo(t.node.li) },
              h('td', {}, h('span', { class: 'lv-tx' }, `T${t.tx}`)),
              h('td', { class: 'num' }, fmtAt(t.node.start / 1e6)),
              h('td', {}, h('span', { class: 'mono' }, t.meta.Operation || '—')),
              h('td', {}, t.meta.LogUser?.Name || ''),
              h('td', { class: 'num' }, fmtMs(t.meta.DurationMilliseconds)),
              h('td', { class: 'num' }, t.summary.cpu ? `${num(t.summary.cpu.used)} ms` : '—'),
              h('td', {}, err ? h('span', { class: 'lv-txerr', title: t.meta.Status }, clip(t.meta.Status, 70)) : h('span', { class: 'lv-txok' }, 'Success')),
              h('td', {}, h('button', { class: 'link', onclick: (e) => { e.stopPropagation(); openLog(t.meta.Id); } }, 'Open alone')));
          }))))));
    }

    body.append(h('div', { class: 'lv-cols' },
      p.merged ? null : h('section', { class: 'lv-panel' }, h('h3', {}, 'Log info'), h('dl', { class: 'lv-dl' },
        dl('Log ID', log.Id), dl('User', log.LogUser?.Name), dl('Operation', log.Operation), dl('Request', log.Request),
        dl('Application', log.Application), dl('Location', log.Location), dl('Status', log.Status),
        dl('Started', fmtFull(parseSfDate(log.StartTime))), dl('Size', fmtBytes(log.LogLength || 0)), dl('API version', p.apiVersion))),
      h('section', { class: 'lv-panel' }, h('h3', {}, 'Log levels'),
        p.levels.length
          ? h('div', { class: 'lg-levels big' }, p.levels.map((l) => h('span', { class: `lg-lvl v-${l.level.toLowerCase()}` }, h('i', {}, levelName(l.cat)), l.level)))
          : h('p', { class: 'lv-muted' }, 'This log has no level header.'))));

    if (p.units.length) {
      const total = Math.max(1, p.root.end - p.root.start);
      body.append(h('section', { class: 'lv-panel lv-units-panel' },
        h('h3', {}, `Code units · ${p.units.length}`),
        h('div', { class: 'lv-units' }, p.units.slice(0, 100).map((u) => h('button', {
          class: `lv-unit k-${u.sub}`, title: 'Show in Debug Log', onclick: () => jumpTo(u.li),
        },
        h('span', { class: 'lv-unit-name', style: `--d:${u.ud}` }, h('span', { class: 'ot-kind' }, KIND_LABEL[u.sub]), h('span', { class: 'lv-unit-label' }, u.label)),
        h('span', { class: 'ot-dur' }, fmtMs((u.end - u.start) / 1e6)),
        h('span', { class: 'ot-tl' }, h('i', { style: barStyle(u, p.root.start, total) })))))));
    }
  }

  // ---------- tab: execution path ----------

  function openPathFor(err) {
    const p = S.parsed.get(S.selectedId);
    const i = p.paths.findIndex((x) => x.at === err || x.head === firstLine(err.msg));
    S.xp = { mode: 'errors', selKey: null, focus: Math.max(0, i) };
    showTab('path');
  }

  function renderPath(p) {
    const X = S.xp;
    const top = codeKids(p.root);
    if (!top.length && !p.paths.length) {
      el.vBody.className = 'lv-body';
      return el.vBody.append(emptyTab('No Apex execution in this log', 'There are no code units, methods or DML to show.'));
    }
    if (!X.mode) X.mode = p.paths.length ? 'errors' : 'tree';
    const left = h('div', { class: 'xp-left' });
    el.xpCode = h('section', { class: 'code xp-code' }, h('div', { class: 'code-empty' }, 'Select a step to see its Apex source'));
    el.vBody.append(left, el.xpCode, resizable({
      handle: h('div'), pane: el.xpCode, host: el.vBody, cssVar: '--xp-code', edge: 'start',
      min: 280, max: () => el.vBody.clientWidth - 260, key: 'ff-split-xp', label: 'Resize the source panel',
    }));

    const modeBtn = (mode, label, disabled) => h('button', {
      role: 'tab', 'aria-selected': String(X.mode === mode), disabled,
      onclick: () => { if (X.mode !== mode) { S.xp = { mode, selKey: null, focus: 0 }; showTab('path'); } },
    }, label);
    left.append(h('div', { class: 'xp-top' },
      h('div', { class: 'xp-modes', role: 'tablist' },
        modeBtn('errors', p.paths.length ? `Error paths · ${p.paths.length}` : 'No errors', !p.paths.length),
        modeBtn('tree', 'Call tree')),
      h('span', { class: 'lv-muted' }, X.mode === 'errors'
        ? 'From the entry point down to the line that failed. Click any step to open its code.'
        : 'Code units, methods and DML in the order they ran. Paths that hit an error are expanded.')));

    const apexLevel = p.levels.find((l) => l.cat === 'APEX_CODE')?.level;
    if (apexLevel && !['FINE', 'FINER', 'FINEST'].includes(apexLevel)) {
      left.append(h('div', { class: 'xp-note' }, h('b', {}, 'Method calls weren’t logged. '),
        `This log used Apex Code = ${apexLevel}; methods only appear at FINE or finer, so paths show code units, DML and errors. Trace again with Apex Code = FINEST for full paths.`));
    }
    if (X.mode === 'errors') renderErrorPaths(left, p);
    else renderCallTree(left, p);
  }

  function renderErrorPaths(left, p) {
    let focusCard = null;
    p.paths.forEach((e, i) => {
      const [type, text] = splitErr(e.head);
      const card = h('article', { class: `xp-err${e.fatal ? ' fatal' : ''}` },
        h('header', { class: 'xp-err-head' },
          h('span', { class: 'xp-err-icon', 'aria-hidden': 'true' }, e.fatal ? '✕' : '!'),
          h('div', { class: 'xp-err-title' }, h('b', {}, type), text ? h('span', {}, text) : null),
          h('div', { class: 'xp-tags' },
            e.rootCause ? h('span', { class: 'xp-tag root', title: 'A later error was caused by this one' }, 'Root cause') : null,
            h('span', { class: `xp-tag ${e.fatal ? 'bad' : 'warn'}`, title: e.fatal ? 'Not caught: the transaction failed' : 'Thrown, but the log doesn’t show it ending the transaction (it may have been caught)' },
              e.fatal ? 'Uncaught' : e.count > 1 ? `Thrown ×${e.count}` : 'Thrown'))),
        p.merged ? sessionTrail(p, e) : null,
        chainList(e),
        e.stack.length ? stackBox(e) : null);
      left.append(card);
      if (i === S.xp.focus) focusCard = card;
    });
    const e = p.paths[Math.min(S.xp.focus, p.paths.length - 1)];
    select(e.chain[e.chain.length - 1], null, e);
    if (focusCard && S.xp.focus > 0) requestAnimationFrame(() => { left.scrollTop = focusCard.offsetTop - 12; });
  }

  // What ran earlier in the session, leading up to the transaction that failed.
  function sessionTrail(p, e) {
    const failTx = txOf(e.at.node)?.tx;
    const upTo = p.txs.filter((t) => t.tx <= failTx);
    const later = p.txs.length - upTo.length;
    return h('div', { class: 'xp-trail' },
      h('span', { class: 'xp-trail-label' }, 'In this session'),
      upTo.map((t, i) => {
        const unit = codeKids(t.node).find((n) => n.kind === 'unit');
        return [
          i ? h('span', { class: 'xp-trail-arrow' }, '→') : null,
          h('button', {
            class: `xp-trail-chip${t.tx === failTx ? ' fail' : ''}`, title: `${t.meta.Operation} · ${fmtAt(t.node.start / 1e6)}`,
            onclick: () => select(t.node),
          }, h('b', {}, `T${t.tx}`), unit ? displayName(unit) : t.meta.Operation, h('small', {}, fmtAt(t.node.start / 1e6))),
        ];
      }),
      later ? h('span', { class: 'lv-muted' }, `+${later} later`) : null);
  }

  function chainList(e) {
    const ol = h('ol', { class: 'xp-chain' });
    e.chain.forEach((n, i) => {
      const prev = e.chain[i - 1];
      const next = e.chain[i + 1];
      const fail = next?.kind === 'error';
      ol.append(h('li', { class: `xp-step${fail ? ' fail' : ''}${n.kind === 'error' ? ' err' : ''}${i === 0 ? ' first' : ''}` },
        prev ? h('div', { class: 'xp-cap' }, caption(prev, n, e)) : null,
        frameCard(n, { next, err: e, fail, short: true })));
    });
    return ol;
  }

  function caption(prev, n, e) {
    const at = prev.src && n.line != null ? ` · line ${n.line}` : '';
    if (n.kind === 'error') {
      const line = n.line ?? e?.stack[0]?.line;
      return `throws${line != null ? ` · line ${line}` : ''}`;
    }
    if (n.kind === 'dml') return `runs DML${at}`;
    if (n.kind === 'unit') return prev.kind === 'dml' ? (n.sub === 'trigger' ? 'fires trigger' : `runs ${n.sub === 'unit' ? 'code' : n.sub}`) : 'starts';
    if (n.kind === 'flow') return 'runs flow';
    return `calls${at}`;
  }

  function stackBox(e) {
    return h('details', { class: 'xp-stack' },
      h('summary', {}, `Stack trace · ${e.stack.length} frame${e.stack.length === 1 ? '' : 's'}`),
      h('ol', {}, e.stack.map((sf) => h('li', {},
        h('button', { class: 'xp-sf', onclick: () => openStackFrame(sf, e) },
          h('span', { class: 'mono' }, `${sf.kind === 'trigger' ? 'Trigger' : 'Class'}.${sf.qual}`),
          h('span', { class: 'lv-muted' }, `line ${sf.line}, column ${sf.col}`))))));
  }

  function openStackFrame(sf, e) {
    const parts = sf.qual.split('.');
    const trigger = sf.kind === 'trigger';
    const frame = {
      kind: trigger ? 'unit' : 'method', sub: trigger ? 'trigger' : 'method', li: e.at.li, children: [], n: {}, start: 0, end: 0,
      label: trigger ? sf.qual : `${sf.qual}()`,
      src: trigger ? { kind: 'trigger', name: parts[0], qual: parts[0] }
        : { kind: 'class', name: parts[0], qual: parts.length > 1 ? parts.slice(0, -1).join('.') : parts[0], method: parts.length > 1 ? parts[parts.length - 1] : null },
    };
    S.xp.selKey = null;
    for (const c of el.vBody.querySelectorAll('.xp-card.selected')) c.classList.remove('selected');
    openFrame({ frame, N: frame, focus: { kind: 'error', line: sf.line, label: e.head }, focusLine: sf.line, err: e });
  }

  function renderCallTree(left, p) {
    const ul = h('ul', { class: 'tree xp-tree' });
    let budget = 80;
    let firstErr = null;
    const build = (n, depth) => {
      const ch = codeKids(n);
      const li = h('li', {});
      const caret = h('button', { class: `caret${ch.length ? '' : ' none'}`, 'aria-expanded': 'false', 'aria-label': 'Show calls', tabindex: ch.length ? '0' : '-1' }, '▸');
      const next = ch.find((c) => c.kind === 'error') || ch.find((c) => c.n.error);
      li.append(frameCard(n, { caret, next, tree: true }));
      if (n.kind === 'error' && !firstErr) firstErr = n;
      const cap = h('div', { class: 'via-caption', hidden: true }, n.kind === 'dml' ? 'fires' : n.kind === 'tx' ? 'runs' : 'calls');
      const sub = h('ul', { hidden: true });
      li.append(cap, sub);
      let built = false;
      const toggle = (open = sub.hidden) => {
        if (!ch.length) return;
        if (open && !built) {
          built = true;
          appendPage(sub, ch, depth + 1, 0);
        }
        sub.hidden = !open;
        cap.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
      };
      caret.addEventListener('click', (ev) => { ev.stopPropagation(); toggle(); });
      if (ch.length && (n.n.error || budget > 0)) { budget -= ch.length; toggle(true); }
      return li;
    };
    const appendPage = (list, ch, depth, from) => {
      const to = Math.min(ch.length, from + PAGE);
      for (let i = from; i < to; i++) list.append(build(ch[i], depth));
      if (to < ch.length) {
        const more = h('li', {}, h('button', { class: 'ghost small', onclick: () => { more.remove(); appendPage(list, ch, depth, to); } }, `Show ${Math.min(PAGE, ch.length - to)} more of ${num(ch.length - to)}`));
        list.append(more);
      }
    };
    const top = codeKids(p.root);
    appendPage(ul, top, 0, 0);
    left.append(ul);
    const firstWithSource = (list) => {
      for (const n of list) { if (n.src) return n; const hit = firstWithSource(codeKids(n)); if (hit) return hit; }
      return null;
    };
    const first = firstErr || firstWithSource(top) || top[0];
    if (first) select(first, null, p.paths.find((x) => x.at.node === first));
  }

  function frameCard(n, o = {}) {
    const isErr = n.kind === 'error';
    const key = `n${n.li}`;
    const entry = entryOf(n);
    const errLine = isErr ? n.line ?? o.err?.stack[0]?.line ?? null : null;
    const badge = isErr ? h('span', { class: 'xp-x', 'aria-hidden': 'true' }, '✕')
      : n.kind === 'tx' ? h('span', { class: 'lv-tx big' }, `T${n.tx}`)
        : entry ? h('span', { class: 'entry', style: `--e:${entry[1]}` }, entry[0])
        : n.kind === 'dml' ? h('span', { class: 'ot-kind k-dml' }, 'DML')
          : n.kind === 'flow' ? h('span', { class: 'ot-kind k-flow' }, 'Flow') : null;
    const name = isErr ? (o.short ? splitErr(n.label)[0] : clip(n.label, 90)) : displayName(n);
    const roll = o.tree && !isErr && n.children.length ? [
      n.n.soql ? h('span', { class: 'meta' }, `${n.n.soql} SOQL`) : null,
      n.n.dml && n.kind !== 'dml' ? h('span', { class: 'meta' }, `${n.n.dml} DML`) : null,
    ] : null;
    const card = h('div', {
      class: `card xp-card${isErr ? ' xp-errcard' : ''}${o.fail ? ' fail' : ''}${!isErr && n.n.error ? ' onpath' : ''}${key === S.xp.selKey ? ' selected' : ''}`,
      'data-key': key, tabindex: '0', role: 'button', title: n.label,
    },
    o.caret || null, badge,
    h('span', { class: 'name' }, name),
    errLine != null ? h('span', { class: 'meta' }, `line ${errLine}`) : null,
    o.fail ? h('span', { class: 'badge xp-fails' }, 'fails here') : null,
    n.kind === 'tx' ? h('span', { class: 'meta' }, `${fmtAt(n.start / 1e6)} · ${n.meta.LogUser?.Name || ''}`) : null,
    !isErr ? h('span', { class: 'meta' }, fmtMs((n.end - n.start) / 1e6)) : null,
    roll,
    o.tree && !isErr && n.n.error ? h('span', { class: 'badge xp-fails ghosted', title: 'An error happened inside this step' }, '⚠ error') : null,
    o.badges || null);
    const go = () => select(n, o.next, o.err);
    card.addEventListener('click', (ev) => { if (o.caret?.contains(ev.target)) return; go(); });
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } });
    return card;
  }

  function select(n, next, err) {
    S.xp.selKey = `n${n.li}`;
    for (const c of el.vBody.querySelectorAll('.xp-card.selected')) c.classList.remove('selected');
    for (const c of el.vBody.querySelectorAll(`.xp-card[data-key="n${n.li}"]`)) c.classList.add('selected');
    const frame = srcFrameOf(n);
    if (!frame) { el.xpCode.replaceChildren(infoPane(n)); return; }
    // what to point at inside the frame: the selected step itself, the next step on the error path, or the error below it
    const extra = S.tab === 'field' ? fieldMarks(frame) : [];
    const focus = n !== frame ? n
      : next || (extra.length ? null : frame.children.find((c) => c.kind === 'error') || frame.children.find((c) => c.n?.error && c.line != null)) || null;
    let focusLine = focus ? focus.line ?? (focus.kind === 'error' ? err?.stack[0]?.line ?? null : null) : null;
    if (focusLine == null && extra.length) {
      focusLine = (extra.find((x) => x.kind === 'write' || x.kind === 'assign') || extra.find((x) => x.kind === 'read') || extra[0]).line;
    }
    openFrame({ frame, N: n, focus, focusLine, err, extra });
  }

  // Field Trace: the traced field's write/read lines and logged values inside this frame's source.
  function fieldMarks(frame) {
    const r = S.ftResult;
    if (!r) return [];
    const out = [];
    const touch = r.touches.find((t) => t.node === frame);
    const method = touch?.method || staticMethodFor(frame, S.ftIndex);
    // reads/writes come from the code scan; with statement-level logging we also know whether each line ran
    const run = touch?.run || linesRun(S.parsed.get(S.selectedId), frame);
    for (const ref of (method && r.refsByMethod.get(method.id)) || []) {
      const ran = run.lines.has(ref.line);
      const idle = run.full && !ran;
      const note = idle ? ` · ${ref.access}, not executed in this log` : !run.full && !ran ? ' · from code scan' : '';
      out.push({
        kind: idle ? 'idle' : ref.access, line: ref.line,
        node: { li: frame.li, label: `${r.object}.${r.field} · ${FIELD_HOW[ref.how] || ref.how}${ref.confidence === 'possible' ? ' (possible)' : ''}${note}` },
      });
    }
    for (const ev of r.assignsByFrame.get(frame) || []) {
      if (ev.line != null) out.push({ kind: 'assign', line: ev.line, node: { li: ev.li, label: ev.text } });
    }
    return out;
  }

  let srcSeq = 0;
  async function openFrame(o) {
    const { frame, N } = o;
    const pane = el.xpCode;
    const seq = ++srcSeq;
    const p = S.parsed.get(S.selectedId);
    S.lastOpen = o; // what Rescan Apex re-opens
    pane.replaceChildren(h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), `Loading ${frame.src.qual || frame.src.name}…`));
    let unit;
    try {
      const anon = frame.src.lines || p.anon;
      // when this log ran: a class changed after that is shown in the version the log ran, when we have it
      const at = +parseSfDate((txOf(frame)?.meta || S.openMeta)?.StartTime);
      unit = frame.src.kind === 'anon'
        ? (anon.length ? { name: 'Anonymous', kind: 'anon', body: anon.join('\n') } : null)
        : await sources.getSource?.(frame.src, { at });
    } catch (e) {
      if (seq === srcSeq) pane.replaceChildren(msgPane('Couldn’t load the Apex source', e.message, N));
      return;
    }
    if (seq !== srcSeq) return;
    if (!unit || unit.managed) {
      pane.replaceChildren(msgPane(`Source for ${frame.src.qual || frame.src.name} isn’t available`,
        unit?.managed ? 'It belongs to a managed package, so Salesforce hides its code.'
          : 'It may be in a managed package, or it was renamed or deleted after this log was written.', N));
      return;
    }
    const marks = markLines(frame);
    for (const x of o.extra || []) {
      if (!marks.has(x.line)) marks.set(x.line, []);
      marks.get(x.line).push(x);
    }
    renderSource({ ...o, unit, marks, whole: false });
  }

  // What a frame's source view shows: the line range, the highlighted rows and the Line details entries.
  function sourceModel(o) {
    const { unit, frame, focus, focusLine, marks, err } = o;
    const lines = unit.body.split('\n');
    let range = [1, lines.length];
    const canNarrow = frame.kind === 'method' && unit.kind === 'class';
    if (canNarrow && !o.whole) {
      const m = findMethod(unit, frame.src, focusLine);
      if (m) range = [m.startLine, Math.min(m.endLine, lines.length)];
    }
    if (focusLine && (focusLine < range[0] || focusLine > range[1])) range = [1, lines.length];
    const rowCls = new Map();
    const refs = []; // { ln, kind, text, count, focus }
    for (const [ln, items] of [...marks].sort((a, b) => a[0] - b[0])) {
      if (ln < range[0] || ln > range[1]) continue;
      const worst = items.reduce((a, b) => (REF_SEVERITY[b.kind] > REF_SEVERITY[a.kind] ? b : a));
      rowCls.set(ln, ROW_CLASS[worst.kind] || 'hl-ref');
      const groups = new Map();
      for (const it of items) {
        const k = `${it.kind}|${refText(it)}`;
        groups.set(k, { ...it, count: (groups.get(k)?.count || 0) + 1 });
      }
      for (const g of groups.values()) refs.push({ ln, kind: g.kind, text: refText(g), count: g.count, focus: g.node === focus });
    }
    if (focusLine && !rowCls.has(focusLine)) rowCls.set(focusLine, focus?.kind === 'error' ? 'hl-err' : 'hl-call');
    return {
      lines, range, canNarrow, rowCls, refs,
      ext: unit.kind === 'trigger' ? 'trigger' : unit.kind === 'anon' ? 'apex' : 'cls',
      url: unit.id ? sources.setupUrl?.(unit) : null,
      entry: entryOf(frame),
      errText: focus?.kind === 'error' ? (err?.msg || focus.label) : null,
      title: frame.kind === 'method' ? frame.label : displayName(frame),
    };
  }

  function refsList(m, onPick) {
    return h('ul', { class: 'code-refs' }, m.refs.map((r) => h('li', { class: r.focus ? 'focus' : null, onclick: () => onPick(r.ln) },
      h('span', { class: 'ln' }, `L${r.ln}`),
      h('span', { class: `badge xp-b k-${REF_KIND[r.kind]}` }, REF_LABEL[r.kind]),
      h('span', { class: 'xp-ref-text' }, r.text),
      r.count > 1 ? h('span', { class: 'lv-muted' }, `×${r.count}`) : null)));
  }

  const errBox = (text) => h('pre', { class: 'xp-errbox' }, text.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n'));

  function sourcePre(m, focusLine) {
    const pre = h('pre', { class: 'src' });
    let inBlock = false;
    for (let n = 1; n < m.range[0]; n++) inBlock = highlight(m.lines[n - 1], inBlock).inBlock;
    for (let n = m.range[0]; n <= m.range[1]; n++) {
      const r = highlight(m.lines[n - 1] ?? '', inBlock);
      inBlock = r.inBlock;
      const txt = h('span', { class: 'txt' });
      txt.innerHTML = r.html || ' ';
      const cls = m.rowCls.get(n);
      pre.append(h('div', { class: `row${cls ? ' ' + cls : ''}${n === focusLine ? ' hl-focus' : ''}`, 'data-line': n },
        h('span', { class: 'gutter' }, n), txt));
    }
    return pre;
  }

  function renderSource(o) {
    const { unit, frame, N, focus, focusLine, marks } = o;
    const pane = el.xpCode;
    const m = sourceModel(o);
    const scroller = h('div', { class: 'code-scroll' });
    const refs = m.refs.length ? refsList(m, (ln) => scrollToRow(scroller, ln)) : null;
    const head = h('div', { class: 'code-head' },
      h('div', { class: 'code-title-row' },
        h('div', { class: 'code-title' }, m.title),
        h('button', {
          class: 'code-expand', title: 'Expand: source and log side by side, full screen (F)', 'aria-label': 'Expand to full screen',
          onclick: () => openFocusView(o),
        }, h('span', { 'aria-hidden': 'true' }, '⤢'), 'Expand')),
      h('div', { class: 'code-sub' },
        h('span', {}, `${unit.name}.${m.ext} · lines ${m.range[0]}–${m.range[1]}`),
        m.entry ? h('span', { class: 'entry', style: `--e:${m.entry[1]}` }, m.entry[0]) : null,
        m.canNarrow ? h('button', { class: 'link', onclick: () => renderSource({ ...o, whole: !o.whole }) }, o.whole ? 'Method only' : 'Whole class') : null,
        h('button', { class: 'link', onclick: () => jumpTo((focus || N).li) }, `Log line ${(focus || N).li + 1}`),
        m.url ? h('a', { href: m.url, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null),
      versionNote(unit, unit.version?.latest ? () => renderSource({ ...o, unit: unit.version.latest }) : null),
      m.errText || refs ? codeDetails([m.errText ? errBox(m.errText) : null, refs], detailsSummary(marks, m.range, !!m.errText)) : null);
    scroller.append(sourcePre(m, focusLine));
    pane.replaceChildren(head, scroller);
    pane.dataset.frame = String(frame.li);
    el.xpCode.focusOpen = () => openFocusView(o);
    scrollToRow(scroller, focusLine || [...m.rowCls.keys()][0] || m.range[0]);
  }

  // ---------- focus view: source + this step's log, full screen ----------
  const FX_ROW = 20;
  function openFocusView(o) {
    if (document.querySelector('.fx')) return;
    const { frame, N, focus, focusLine, marks } = o;
    const p = S.parsed.get(S.selectedId);
    let whole = !!o.whole;
    const prefs = loadPrefs();
    let collapsed = prefs.fxCollapsed || null; // 'src' | 'log' | null
    let tab = prefs.fxTab || 'details';

    // this step's log lines; "own" lines belong to this frame, the rest to methods it called
    const nested = [];
    (function collect(n) { for (const c of n.children) { if (c.src) nested.push(c); else collect(c); } })(frame);
    // own[i]: 1 = written by this step, 2 = entry/exit of a method it called (the [line] is the call site here),
    // 0 = inside a called method
    const own = new Uint8Array(frame.endLi - frame.li + 1);
    {
      let k = 0;
      for (let i = frame.li; i <= frame.endLi; i++) {
        while (k < nested.length && nested[k].endLi < i) k++;
        const c = k < nested.length && nested[k].li <= i && i <= nested[k].endLi ? nested[k] : null;
        own[i - frame.li] = !c ? 1 : i === c.li || i === c.endLi ? 2 : 0;
      }
    }
    const lineNo = (i) => {
      const s = p.lines[i];
      if (!s || !s.includes('|[')) return null;
      const mm = LINE_RE.exec(s);
      const v = mm && /^\[(\d+)\]$/.exec((mm[4] || '').split('|')[0]);
      return v ? +v[1] : null;
    };
    // the source line of this step that a log line points at (its own entry/exit lines point at the caller)
    const srcLineOf = (i) => (i === frame.li || i === frame.endLi || !own[i - frame.li] ? null : lineNo(i));
    const logBySrc = new Map(); // source line -> first log line it wrote
    for (let i = frame.li; i <= frame.endLi; i++) {
      const ln = srcLineOf(i);
      if (ln != null && !logBySrc.has(ln)) logBySrc.set(ln, i);
    }
    const L = { q: '', ownOnly: !!prefs.fxOwnOnly, view: [], flash: null };

    // ---- left: source ----
    const srcBody = h('div', { class: 'fx-pane-body' });
    const srcSub = h('span', { class: 'fx-sub' });
    const wholeBtn = h('button', { class: 'link' });
    let srcScroller = null;
    function drawSource(scrollTo) {
      const m = sourceModel({ ...o, whole });
      srcSub.textContent = `${o.unit.name}.${m.ext} · lines ${m.range[0]}–${m.range[1]}`;
      wholeBtn.hidden = !m.canNarrow;
      wholeBtn.textContent = whole ? 'Method only' : 'Whole class';
      srcScroller = h('div', { class: 'code-scroll fx-src' });
      const pre = sourcePre(m, focusLine);
      // click a source line: show the log line it produced
      pre.addEventListener('click', (e) => {
        const row = e.target.closest('.row');
        if (!row) return;
        const ln = +row.dataset.line;
        markSrc(ln);
        const li = logBySrc.get(ln);
        if (li != null) { setTab('log'); revealLog(li); } else toastNoLog(ln);
      });
      srcScroller.append(pre);
      srcBody.replaceChildren(srcScroller);
      scrollToRow(srcScroller, scrollTo || focusLine || [...m.rowCls.keys()][0] || m.range[0]);
      return m;
    }
    function markSrc(ln) {
      for (const r of srcScroller.querySelectorAll('.row.fx-pick')) r.classList.remove('fx-pick');
      const row = srcScroller.querySelector(`.row[data-line="${ln}"]`);
      if (!row) return false;
      row.classList.add('fx-pick');
      return true;
    }
    function revealSrc(ln) {
      if (!srcScroller.querySelector(`.row[data-line="${ln}"]`) && !whole) { whole = true; drawSource(ln); }
      if (markSrc(ln)) scrollToRow(srcScroller, ln);
    }
    let noLogT = 0;
    function toastNoLog(ln) {
      clearTimeout(noLogT);
      hint.textContent = `Line ${ln} didn’t write anything to the log in this step.`;
      hint.hidden = false;
      noLogT = setTimeout(() => { hint.hidden = true; }, 2600);
    }
    wholeBtn.addEventListener('click', () => { whole = !whole; drawSource(); });

    // ---- right: Line details / Log lines ----
    const tabsEl = h('div', { class: 'fx-tabs', role: 'tablist' });
    const detailsBody = h('div', { class: 'fx-details', role: 'tabpanel' });
    const logFilter = h('input', {
      type: 'search', placeholder: 'Filter these log lines…', 'aria-label': 'Filter log lines',
      oninput: (e) => { L.q = e.target.value; computeLog(); drawLog(true); },
    });
    const ownToggle = h('label', { class: 'fx-own', title: 'Hide the lines written by methods this step called' },
      h('input', { type: 'checkbox', checked: L.ownOnly, onchange: (e) => { L.ownOnly = e.target.checked; savePrefs({ fxOwnOnly: L.ownOnly }); computeLog(); drawLog(true); } }),
      'Only this method');
    const logCount = h('span', { class: 'fx-count' });
    const logScroll = h('div', { class: 'fx-log', tabindex: '0', 'aria-label': 'Log lines of this step' });
    const logInner = h('div', { class: 'fx-log-inner' });
    logScroll.append(logInner);
    const logPanel = h('div', { class: 'fx-logpanel', role: 'tabpanel' },
      h('div', { class: 'fx-log-tools' }, logFilter, ownToggle, logCount), logScroll);
    function computeLog() {
      const q = L.q.trim().toLowerCase();
      L.view = [];
      for (let i = frame.li; i <= frame.endLi; i++) {
        if (L.ownOnly && !own[i - frame.li]) continue;
        if (q && !p.lines[i].toLowerCase().includes(q)) continue;
        L.view.push(i);
      }
      logCount.textContent = `${num(L.view.length)} line${L.view.length === 1 ? '' : 's'}`;
    }
    function drawLog(reset) {
      if (reset) logScroll.scrollTop = 0;
      logInner.style.height = `${L.view.length * FX_ROW}px`;
      const first = Math.max(0, Math.floor(logScroll.scrollTop / FX_ROW) - 20);
      const last = Math.min(L.view.length, first + Math.ceil((logScroll.clientHeight || 600) / FX_ROW) + 40);
      let html = '';
      const re = L.q.trim() ? new RegExp(escRe(L.q.trim()), 'gi') : null;
      for (let r = first; r < last; r++) {
        const i = L.view[r];
        const cat = p.lineCat[i];
        const mine = own[i - frame.li];
        const ln = srcLineOf(i);
        const cls = `lr c-${CATS[cat & 0x7f]}${cat & CONT ? ' cont' : ''}${i === L.flash ? ' flash cur' : ''}${mine ? '' : ' fx-nested'}${ln != null ? ' fx-link' : ''}`;
        html += `<div class="${cls}" style="top:${r * FX_ROW}px" data-i="${i}"${ln != null ? ` data-src="${ln}" title="Show source line ${ln}"` : ''}><span class="ln">${i + 1}</span><span class="lt">${lineHtml(p.lines[i], cat, re)}</span></div>`;
      }
      logInner.innerHTML = html;
    }
    function revealLog(i) {
      if (!L.view.includes(i)) { L.q = ''; logFilter.value = ''; if (!own[i - frame.li]) L.ownOnly = false; ownToggle.querySelector('input').checked = L.ownOnly; computeLog(); }
      L.flash = i;
      const r = L.view.indexOf(i);
      logScroll.scrollTop = Math.max(0, r * FX_ROW - logScroll.clientHeight / 2);
      drawLog();
    }
    logScroll.addEventListener('scroll', () => { cancelAnimationFrame(L.raf); L.raf = requestAnimationFrame(() => drawLog()); });
    logScroll.addEventListener('click', (e) => {
      const row = e.target.closest('.lr');
      if (!row) return;
      L.flash = +row.dataset.i;
      drawLog();
      if (row.dataset.src) revealSrc(+row.dataset.src);
    });
    logScroll.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.lr');
      if (row) { close(); jumpTo(+row.dataset.i); }
    });

    function drawDetails() {
      const m = sourceModel({ ...o, whole: true });
      const sum = detailsSummary(marks, m.range, !!m.errText);
      detailsBody.replaceChildren(...[ // (filter: replaceChildren would print a null as "null")
        sum.badges.length ? h('div', { class: 'cd-badges fx-badges' }, sum.badges.map(([t, k]) => h('span', { class: `cd-badge ${k || ''}` }, t))) : null,
        m.errText ? errBox(m.errText) : null,
        m.refs.length ? refsList(m, (ln) => revealSrc(ln)) : h('p', { class: 'lv-muted fx-none' }, 'The log doesn’t point at any line of this step.')].filter(Boolean));
    }
    function setTab(k) {
      tab = k;
      savePrefs({ fxTab: k });
      tabsEl.replaceChildren(
        h('button', { role: 'tab', 'aria-selected': String(k === 'details'), onclick: () => setTab('details') }, 'Line details', m0.refs.length ? h('span', { class: 'lv-n' }, m0.refs.length) : null),
        h('button', { role: 'tab', 'aria-selected': String(k === 'log'), onclick: () => setTab('log') }, 'Log lines', h('span', { class: 'lv-n' }, num(frame.endLi - frame.li + 1))));
      detailsBody.hidden = k !== 'details';
      logPanel.hidden = k !== 'log';
      if (k === 'log') requestAnimationFrame(() => drawLog());
    }

    // ---- frame ----
    const hint = h('div', { class: 'fx-hint', hidden: true, role: 'status' });
    const paneHead = (side, title, extra) => h('div', { class: 'fx-pane-head' },
      h('span', { class: 'fx-pane-title' }, title), extra,
      h('button', { class: 'fx-collapse', title: `Collapse ${side === 'src' ? 'the source' : 'the log panel'}`, 'aria-label': 'Collapse', onclick: () => setCollapsed(side) }, side === 'src' ? '‹' : '›'));
    const rail = (side, label) => h('button', { class: `fx-rail fx-rail-${side}`, title: `Show ${label}`, onclick: () => setCollapsed(null) },
      h('span', { 'aria-hidden': 'true' }, side === 'src' ? '›' : '‹'), h('span', { class: 'fx-rail-label' }, label));
    const left = h('section', { class: 'fx-pane fx-left' },
      paneHead('src', 'Apex', h('span', { class: 'fx-head-extra' }, srcSub, wholeBtn, o.unit.id && sources.setupUrl ? h('a', { href: sources.setupUrl(o.unit), target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null)),
      versionNote(o.unit, null), srcBody, rail('src', 'Apex source'));
    const right = h('section', { class: 'fx-pane fx-right' },
      paneHead('log', 'From the log', tabsEl), detailsBody, logPanel, rail('log', 'Log details'));
    const grid = h('div', { class: 'fx-grid' }, left, right);
    const split = resizable({
      handle: h('div', { class: 'fx-split' }), pane: left, host: grid, cssVar: '--fx-left', edge: 'end',
      min: 280, max: () => grid.clientWidth - 300, key: 'ff-split-fx', label: 'Resize source and log',
    });
    grid.append(split);
    function setCollapsed(side) {
      collapsed = side && collapsed === side ? null : side;
      savePrefs({ fxCollapsed: collapsed });
      grid.dataset.collapsed = collapsed || '';
      if (collapsed !== 'log' && tab === 'log') requestAnimationFrame(() => drawLog());
    }

    const entry = entryOf(frame);
    const card = h('div', { class: 'fx-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${displayName(frame)}: source and log`, tabindex: '-1' },
      h('header', { class: 'fx-head' },
        h('div', { class: 'fx-title' },
          h('b', {}, frame.kind === 'method' ? frame.label : displayName(frame)),
          entry ? h('span', { class: 'entry', style: `--e:${entry[1]}` }, entry[0]) : null,
          h('span', { class: 'fx-meta' }, `log lines ${num(frame.li + 1)}–${num(frame.endLi + 1)} · ${fmtMs((frame.end - frame.start) / 1e6)}`)),
        h('span', { class: 'fx-keys' }, 'Click a line on either side to find it on the other · Esc to close'),
        h('button', { class: 'ghost small', title: 'Open this step in the Debug Log tab', onclick: () => { close(); jumpTo((focus || N).li); } }, 'Show in Debug Log'),
        h('button', { class: 'fx-x', 'aria-label': 'Close full screen', title: 'Close (Esc)', onclick: () => close() }, '×')),
      grid, hint);
    const wrap = h('div', { class: 'fx' }, card);
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        if (document.activeElement === logFilter && logFilter.value) return; // let Esc clear the filter first
        e.preventDefault();
        close();
      }
    };
    function close() {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      el.xpCode.querySelector('.code-expand')?.focus();
    }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
    document.body.append(wrap);

    const m0 = drawSource();
    drawDetails();
    computeLog();
    grid.dataset.collapsed = collapsed || '';
    setTab(tab);
    // start the log at the focused line
    const start = (focus && focus.li >= frame.li && focus.li <= frame.endLi) ? focus.li : (focusLine != null ? logBySrc.get(focusLine) : null);
    if (start != null) requestAnimationFrame(() => { L.flash = start; const r = L.view.indexOf(start); if (r >= 0) logScroll.scrollTop = Math.max(0, r * FX_ROW - logScroll.clientHeight / 2); drawLog(); });
    card.focus();
  }

  // Header of the details panel: what the log points at inside the shown lines, e.g. "2 calls · 3 debug · error".
  function detailsSummary(marks, range, hasErr) {
    const counts = {};
    for (const [ln, items] of marks) {
      if (ln < range[0] || ln > range[1]) continue;
      for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    }
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const badges = [
      hasErr || counts.error ? ['error', 'err'] : null,
      counts.write ? [plural(counts.write, 'write'), 'dml'] : null,
      counts.assign ? [plural(counts.assign, 'value'), 'debug'] : null,
      counts.read ? [plural(counts.read, 'read'), 'ref'] : null,
      counts.idle ? [`${counts.idle} didn’t run`, 'idle'] : null,
      counts.call ? [plural(counts.call, 'call'), 'call'] : null,
      counts.dml ? [`${counts.dml} DML`, 'dml'] : null,
      counts.soql ? [`${counts.soql} SOQL`, 'soql'] : null,
      counts.debug ? [`${counts.debug} debug`, 'debug'] : null,
      counts.callout ? [plural(counts.callout, 'callout'), 'callout'] : null,
    ].filter(Boolean);
    return { title: 'Line details', badges, alert: hasErr || !!counts.error };
  }

  function scrollToRow(scroller, ln) {
    const row = scroller.querySelector(`.row[data-line="${ln}"]`);
    if (row) scroller.scrollTop = Math.max(0, row.offsetTop - scroller.clientHeight / 2 + row.offsetHeight / 2);
  }

  function txPane(t) {
    const m = t.meta;
    const err = isError(m);
    const dl = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
    return h('div', { class: 'xp-info xp-txinfo' },
      h('span', { class: 'lv-tx big' }, `Transaction ${t.tx}`),
      h('b', {}, m.Operation || 'Debug log'),
      h('dl', { class: 'lv-dl' },
        dl('User', m.LogUser?.Name), dl('Started', `${fmtFull(parseSfDate(m.StartTime))} (${fmtAt(t.start / 1e6)})`),
        dl('Duration', fmtMs(m.DurationMilliseconds)), dl('Status', m.Status), dl('Log ID', m.Id)),
      err ? h('p', { class: 'lv-errtext' }, clip(m.Status, 200)) : null,
      h('div', { class: 'lg-row' },
        h('button', { class: 'ghost small', onclick: () => openLog(m.Id) }, 'Open this log alone'),
        h('button', { class: 'link', onclick: () => jumpTo(t.li) }, 'Show in Debug Log →')));
  }

  function infoPane(n) {
    if (n.kind === 'tx') return txPane(n);
    const entry = entryOf(n);
    const what = /^apex:\/\//i.test(n.label) ? 'The request started in the browser: a Lightning component (LWC or Aura) called an @AuraEnabled method. Select the next step to see its Apex.'
      : n.sub === 'flow' || n.kind === 'flow' ? 'A Flow ran here. Flows are declarative, so there’s no Apex to show.'
        : n.sub === 'validation' ? 'Validation rules were checked here.'
          : n.sub === 'workflow' ? 'Workflow rules were evaluated here.'
            : 'This step has no Apex source.';
    return h('div', { class: 'xp-info' },
      entry ? h('span', { class: 'entry', style: `--e:${entry[1]}` }, entry[0]) : null,
      h('b', {}, displayName(n)), h('p', {}, what),
      h('button', { class: 'link', onclick: () => jumpTo(n.li) }, 'Show in Debug Log →'));
  }

  function msgPane(title, sub, n) {
    return h('div', { class: 'xp-info' }, h('b', {}, title), h('p', {}, sub),
      h('button', { class: 'link', onclick: () => jumpTo(n.li) }, 'Show in Debug Log →'));
  }

  function entryOf(n) {
    if (n.kind !== 'unit') return null;
    const l = n.label;
    const op = (txOf(n)?.meta || S.openMeta)?.Operation || '';
    if (n.sub === 'trigger') return ['Trigger', 'var(--e-trigger)'];
    if (n.sub === 'flow') return ['Flow', 'var(--e-flow)'];
    if (n.sub === 'validation') return ['Validation', 'var(--c-rule)'];
    if (n.sub === 'workflow') return ['Workflow', 'var(--warn)'];
    if (/^apex:\/\//i.test(l)) return ['LWC / Aura', 'var(--e-lwc)'];
    if (/^VF:/i.test(l)) return ['Visualforce', 'var(--e-vf)'];
    if (n.src?.kind === 'anon') return ['Anonymous', 'var(--e-soap)'];
    if (n.src) {
      if (/batch/i.test(op)) return ['Batch', 'var(--e-batch)'];
      if (/queue/i.test(op)) return ['Queueable', 'var(--e-queueable)'];
      if (/sched/i.test(op)) return ['Scheduled', 'var(--e-schedule)'];
      if (/future/i.test(op)) return ['@future', 'var(--e-future)'];
      if (/apexrest/i.test(op)) return ['REST', 'var(--e-rest)'];
      return ['Apex', 'var(--c-unit)'];
    }
    return ['Code unit', 'var(--c-unit)'];
  }

  const parsedUnits = new WeakMap();
  function findMethod(unit, src, line) {
    let file = parsedUnits.get(unit);
    if (!file) { file = parseUnit(unit); parsedUnits.set(unit, file); }
    const callable = file.methods.filter((m) => m.kind === 'method' || m.kind === 'constructor');
    const within = (m) => line != null && m.startLine <= line && line <= m.endLine;
    if (src.method) {
      const qual = (src.qual || '').toLowerCase();
      const lname = src.method.toLowerCase();
      const cands = callable.filter((m) => m.lname === lname && m.type.display.toLowerCase() === qual
        && (src.ctor ? m.kind === 'constructor' : true));
      if (cands.length === 1) return cands[0];
      if (cands.length > 1) {
        const argc = src.sig ? splitArgs(src.sig).length : 0;
        return cands.find(within) || cands.find((m) => m.paramCount === argc) || cands[0];
      }
    }
    return callable.filter(within).sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] || null;
  }

  // ---------- tab: field trace ----------

  const objectCache = { list: null };
  const fieldCache = new Map();

  function renderFieldTrace(p) {
    const T = S.ft;
    S.ftResult = null;
    const left = h('div', { class: 'xp-left ft-left' });
    el.xpCode = h('section', { class: 'code xp-code' }, h('div', { class: 'code-empty' }, 'Trace a field, then click any step to see its Apex'));
    el.vBody.append(left, el.xpCode, resizable({
      handle: h('div'), pane: el.xpCode, host: el.vBody, cssVar: '--xp-code', edge: 'start',
      min: 280, max: () => el.vBody.clientWidth - 260, key: 'ff-split-xp', label: 'Resize the source panel',
    }));

    const objIn = h('input', { type: 'text', list: 'ft-objects', placeholder: 'e.g. Account', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Object API name' });
    const fieldIn = h('input', { type: 'text', list: 'ft-fields', placeholder: 'e.g. Industry', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Field API name' });
    objIn.value = T.object;
    fieldIn.value = T.field;
    const objList = h('datalist', { id: 'ft-objects' });
    const fieldList = h('datalist', { id: 'ft-fields' });
    const quick = h('div', { class: 'ft-quick' });
    const results = h('div', { class: 'ft-results' });
    left.append(
      h('form', { class: 'ft-pick', onsubmit: (e) => { e.preventDefault(); run(); } },
        h('div', { class: 'ft-pick-head' }, h('b', {}, 'Trace a field in this execution'),
          h('span', { class: 'lv-muted' }, 'See where it was written, saved and read, step by step.')),
        h('div', { class: 'ft-inputs' },
          h('label', { class: 'ft-in' }, h('span', {}, 'Object'), objIn),
          h('span', { class: 'ft-dot', 'aria-hidden': 'true' }, '.'),
          h('label', { class: 'ft-in' }, h('span', {}, 'Field'), fieldIn),
          h('button', { class: 'primary small ft-go', type: 'submit' }, 'Trace')),
        objList, fieldList, quick),
      results);

    // autocomplete from the org (objects once, fields per object)
    (objectCache.list ? Promise.resolve(objectCache.list) : sources.listObjects?.()?.then((l) => (objectCache.list = l)))
      ?.then((list) => objList.replaceChildren(...(list || []).map((o) => h('option', { value: o.name }, o.label))))
      .catch(() => {});
    const loadFields = async (obj) => {
      if (!obj || !sources.listFields) return;
      const key = obj.toLowerCase();
      if (!fieldCache.has(key)) fieldCache.set(key, sources.listFields(obj).catch(() => []));
      const list = await fieldCache.get(key);
      if (objIn.value.trim().toLowerCase() === key) fieldList.replaceChildren(...list.map((f) => h('option', { value: f.name }, `${f.label} · ${f.type}`)));
    };
    let objTimer;
    objIn.addEventListener('input', () => { clearTimeout(objTimer); objTimer = setTimeout(() => { loadFields(objIn.value.trim()); renderQuick(); }, 250); });

    function renderQuick() {
      const objs = objectsInLog(p);
      const obj = objIn.value.trim();
      const fields = obj ? fieldsInLog(p, obj) : [];
      const chip = (label, active, onclick, title) => h('button', { type: 'button', class: `ft-chip${active ? ' active' : ''}`, title, onclick }, label);
      quick.replaceChildren(...[
        objs.length ? h('div', { class: 'ft-quick-row' }, h('span', { class: 'ft-quick-label' }, 'Objects in this log'),
          objs.slice(0, 12).map((o) => chip(o, o.toLowerCase() === obj.toLowerCase(), () => {
            objIn.value = o; fieldIn.value = ''; loadFields(o); renderQuick(); fieldIn.focus();
          }, `Pick ${o}`))) : null,
        fields.length ? h('div', { class: 'ft-quick-row' }, h('span', { class: 'ft-quick-label' }, `Queried ${obj} fields`),
          fields.slice(0, 16).map((f) => chip(f, f.toLowerCase() === fieldIn.value.trim().toLowerCase(), () => { fieldIn.value = f; run(); }, `Trace ${obj}.${f}`))) : null,
      ].filter(Boolean));
    }

    async function run() {
      const O = objIn.value.trim();
      const F = fieldIn.value.trim();
      if (!O) { objIn.focus(); return; }
      if (!F) { fieldIn.focus(); return; }
      if (!/^\w+$/.test(O) || !/^\w+$/.test(F)) {
        results.replaceChildren(h('div', { class: 'xp-note' }, 'Use API names, e.g. Account and Industry or My_Field__c.'));
        return;
      }
      T.object = O;
      T.field = F;
      savePrefs({ ftObject: O, ftField: F });
      renderQuick();
      results.replaceChildren(h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), `Tracing ${O}.${F}…`));
      let index = null;
      let indexErr = null;
      try { index = (await sources.getIndex?.()) || null; } catch (e) { indexErr = e; }
      await tick();
      if (!results.isConnected) return;
      p.ftCache ||= new Map();
      const key = `${O}.${F}|${T.possible}`.toLowerCase();
      if (!p.ftCache.has(key)) p.ftCache.set(key, traceField(p, index, O, F, { possible: T.possible }));
      S.ftResult = p.ftCache.get(key);
      S.ftIndex = index;
      renderFieldResults(p, results, index ? null : indexErr?.message || 'The Apex code scan isn’t available yet.');
    }

    loadFields(T.object);
    renderQuick();
    if (T.object && T.field) run();
    else results.append(h('div', { class: 'ft-empty' },
      h('b', {}, 'Which field changed unexpectedly?'),
      h('p', {}, 'Pick its object and field above. You’ll see every step of this execution that wrote, saved or read it, with the Apex lines and the values from the log.')));
  }

  function renderFieldResults(p, box, indexProblem) {
    const r = S.ftResult;
    const T = S.ft;
    const name = `${r.object}.${r.field}`;
    const nothing = !r.touches.length && !r.dmls.length && !r.evidence.length;
    const apexLevel = p.levels.find((l) => l.cat === 'APEX_CODE')?.level;
    const notes = [
      indexProblem ? h('div', { class: 'xp-note' }, h('b', {}, 'Using log lines only. '), `${indexProblem} Apex methods that read or write the field are found by the Code Flow scan.`) : null,
      !r.stats.assigns && apexLevel && apexLevel !== 'FINEST' && !nothing
        ? h('div', { class: 'xp-note' }, h('b', {}, 'No values shown. '), `Assigned values come from VARIABLE_ASSIGNMENT lines, which are only logged when Apex Code is FINEST (this log: ${apexLevel}).`) : null,
    ];
    if (nothing) {
      box.replaceChildren(...notes.filter(Boolean), h('div', { class: 'ft-empty' },
        h('b', {}, `${name} isn’t touched in this execution`),
        h('p', {}, 'No Apex that ran here reads or writes it, there’s no DML on the object, and no log line mentions it. Check the API name, or that the right logs are in this session.')));
      return;
    }
    const stat = (n, label, kind, tip) => h('span', { class: `chip ${kind}`, title: tip }, h('b', {}, n), label);
    const views = [['paths', 'Paths'], ['tree', 'Call tree'], ['timeline', `Timeline · ${r.evidence.length + r.touches.length}`]];
    const content = h('div', { class: 'ft-content' });
    const viewBtns = views.map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(T.view === k),
      onclick: () => { T.view = k; for (const b of viewBtns) b.setAttribute('aria-selected', String(b === viewBtns[views.findIndex(([v]) => v === k)])); drawView(); },
    }, label));
    box.replaceChildren(...notes.filter(Boolean),
      h('div', { class: 'ft-summary' },
        h('span', { class: 'ft-name' }, name),
        stat(r.stats.writers, r.stats.writers === 1 ? 'writer' : 'writers', 'write', 'Steps that ran and assign the field (code or logged value)'),
        stat(r.stats.dml, `DML on ${r.object}`, 'entries', `${r.object} records saved in this execution`),
        stat(r.stats.readers, r.stats.readers === 1 ? 'reader' : 'readers', 'read', 'Steps that ran and only read the field'),
        r.stats.assigns ? stat(r.stats.assigns, r.stats.assigns === 1 ? 'value logged' : 'values logged', 'entries', 'VARIABLE_ASSIGNMENT lines for the field') : null),
      h('div', { class: 'ft-tools' },
        h('div', { class: 'xp-modes', role: 'tablist' }, viewBtns),
        h('button', {
          class: 'lg-toggle', 'aria-pressed': String(T.possible), title: 'Also count references whose record type could not be confirmed (SObject, dynamic Apex)',
          onclick: () => { T.possible = !T.possible; showTab('field'); },
        }, 'Include possible')),
      content);

    function drawView() {
      content.replaceChildren();
      if (T.view === 'tree') drawTree(content, r);
      else if (T.view === 'timeline') drawTimeline(content, r);
      else drawPaths(content, r);
    }
    drawView();
    const first = r.paths[0]?.node || r.evidence[0]?.frame;
    if (first) select(first);
  }

  const FT_KIND = {
    write: ['Writes', 'write'], read: ['Reads', 'read'], dml: ['Saves', 'dml'], idle: ['Not run', 'idle'],
  };

  function drawPaths(box, r) {
    const sections = [['write', 'Where it’s written'], ['dml', `Where ${r.object} is saved`], ['read', 'Where it’s read'],
      ['idle', 'Ran, but the lines that use the field didn’t']];
    for (const [kind, title] of sections) {
      const list = r.paths.filter((g) => g.kind === kind);
      if (!list.length) continue;
      box.append(h('div', { class: 'group-title ft-group' }, `${title} · ${list.length}`));
      for (const g of list.slice(0, 80)) box.append(pathCard(g, r));
      if (list.length > 80) box.append(h('p', { class: 'lv-muted' }, `+${list.length - 80} more paths`));
    }
    if (!r.paths.length) {
      box.append(h('div', { class: 'ft-empty' }, h('b', {}, 'No Apex path touches it'), h('p', {}, 'The log still mentions the field: see the Timeline.')));
    }
  }

  function pathCard(g, r) {
    const [label, kind] = FT_KIND[g.kind];
    const t = g.touch;
    const ran = (x) => g.kind === 'idle' || !t.run?.full || t.run.lines.has(x.line);
    const lines = t ? [...new Set(t.refs.filter((x) => (g.kind !== 'write' || x.access === 'write') && ran(x)).map((x) => x.line))] : [];
    const values = t ? [...new Set(t.assigns.map((a) => a.value))].slice(0, 3) : [];
    const ol = h('ol', { class: 'xp-chain' });
    g.chain.forEach((n, i) => {
      const prev = g.chain[i - 1];
      ol.append(h('li', { class: `xp-step${i === 0 ? ' first' : ''}${n === g.node ? ' ft-hit' : ''}` },
        prev ? h('div', { class: 'xp-cap' }, caption(prev, n)) : null,
        frameCard(n, { next: g.chain[i + 1], short: true })));
    });
    ol.append(h('li', { class: 'xp-step ft-end' },
      h('div', { class: 'xp-cap' }, g.kind === 'dml' ? 'saves record' : g.kind === 'write' ? 'writes field' : g.kind === 'idle' ? 'skipped' : 'reads field'),
      h('div', {
        class: `card ft-terminal k-${kind}`, tabindex: '0', role: 'button', title: 'Show the code',
        onclick: () => select(g.node), onkeydown: (e) => { if (e.key === 'Enter') select(g.node); },
      },
      h('span', { class: 'ft-term-icon', 'aria-hidden': 'true' }, g.kind === 'dml' ? '⛁' : g.kind === 'write' ? '✎' : g.kind === 'idle' ? '○' : '◉'),
      h('span', { class: 'name' }, g.kind === 'dml' ? g.node.label : `${r.object}.${r.field}`),
      lines.length ? h('span', { class: 'meta' }, `line ${lines.slice(0, 4).join(', ')}`) : null,
      values.length ? h('span', { class: 'ft-val', title: 'Value assigned in the log' }, `= ${values.join(' · ')}`) : null)));
    const tx = txOf(g.node);
    return h('article', { class: `ft-path k-${kind}` },
      h('header', { class: 'ft-path-head' },
        h('span', { class: `ft-kind k-${kind}` }, label),
        h('b', {}, g.kind === 'dml' ? g.node.label : displayName(g.node)),
        tx ? h('span', { class: 'lv-tx' }, `T${tx.tx}`) : null,
        g.items.length > 1 ? h('span', { class: 'lv-x', title: `This path ran ${g.items.length} times` }, `×${g.items.length}`) : null,
        h('span', { class: 'ft-path-at' }, fmtAt(g.node.start / 1e6))),
      ol);
  }

  function drawTree(box, r) {
    const relevant = new Set();
    for (const g of r.paths) for (const n of g.chain) relevant.add(n);
    const touchOf = new Map(r.touches.map((t) => [t.node, t]));
    const dmlSet = new Set(r.dmls);
    const ul = h('ul', { class: 'tree xp-tree' });
    let budget = 400;
    const build = (n) => {
      const kids = codeKids(n).filter((c) => relevant.has(c));
      const t = touchOf.get(n);
      const badges = [
        t?.write ? h('span', { class: 'badge write' }, 'writes') : null,
        t?.read && !t.write ? h('span', { class: 'badge read' }, 'reads') : null,
        t?.idle ? h('span', { class: 'badge idle', title: 'The field lines in this method didn’t run' }, 'didn’t run') : null,
        t?.assigns.length ? h('span', { class: 'ft-val' }, `= ${t.assigns[t.assigns.length - 1].value}`) : null,
        dmlSet.has(n) ? h('span', { class: 'badge soql' }, `saves ${r.object}`) : null,
      ];
      const caret = h('button', { class: `caret${kids.length ? '' : ' none'}`, 'aria-expanded': 'true', tabindex: kids.length ? '0' : '-1', 'aria-label': 'Toggle' }, '▸');
      const li = h('li', {}, frameCard(n, { caret, tree: true, badges }));
      if (kids.length) {
        const sub = h('ul', {});
        const cap = h('div', { class: 'via-caption' }, n.kind === 'dml' ? 'fires' : n.kind === 'tx' ? 'runs' : 'calls');
        for (const c of kids) if (budget-- > 0) sub.append(build(c));
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = sub.hidden;
          sub.hidden = !open;
          cap.hidden = !open;
          caret.setAttribute('aria-expanded', String(open));
        });
        li.append(cap, sub);
      }
      return li;
    };
    for (const n of codeKids(r.paths.length ? S.parsed.get(S.selectedId).root : { children: [] }).filter((c) => relevant.has(c))) ul.append(build(n));
    box.append(ul.childElementCount ? ul : h('p', { class: 'lv-muted' }, 'No Apex steps touch this field. See the Timeline for log lines.'));
  }

  const EV_LABEL = {
    assign: ['value', 'write'], workflow: ['workflow', 'dml'], flow: ['flow', 'soql'], validation: ['validation', 'read'],
    soql: ['SOQL', 'soql'], debug: ['debug', 'entries'], write: ['writes', 'write'], read: ['reads', 'read'], idle: ['didn’t run', 'idle'],
  };

  function drawTimeline(box, r) {
    const rows = [
      ...r.touches.map((t) => ({ li: t.node.li, kind: t.write ? 'write' : t.read ? 'read' : 'idle', frame: t.node, text: `${displayName(t.node)} ran`, at: t.node.start })),
      ...r.evidence.map((e) => ({ li: e.li, kind: e.kind, frame: e.frame, text: e.text, at: (e.node || {}).start, ev: e })),
    ].sort((a, b) => a.li - b.li);
    const ol = h('ol', { class: 'ft-timeline' });
    for (const row of rows.slice(0, 1000)) {
      const [label, tone] = EV_LABEL[row.kind] || [row.kind, 'entries'];
      const tx = row.frame ? txOf(row.frame) : null;
      ol.append(h('li', {
        class: `ft-ev k-${tone}`, tabindex: '0', role: 'button',
        title: row.frame ? 'Show the code' : 'Show in Debug Log',
        onclick: () => (row.frame ? select(row.frame) : jumpTo(row.li)),
        onkeydown: (e) => { if (e.key === 'Enter') (row.frame ? select(row.frame) : jumpTo(row.li)); },
      },
      h('span', { class: 'ft-ev-at' }, row.at != null ? fmtAt(row.at / 1e6) : ''),
      tx ? h('span', { class: 'lv-tx' }, `T${tx.tx}`) : null,
      h('span', { class: `badge ft-ev-kind k-${tone}` }, label),
      h('span', { class: 'ft-ev-text', title: row.text }, clip(row.text || '', 160)),
      row.frame && row.ev ? h('span', { class: 'ft-ev-in' }, `in ${displayName(row.frame)}`) : null,
      h('button', { class: 'lv-ln', title: 'Show in Debug Log', onclick: (e) => { e.stopPropagation(); jumpTo(row.li); } }, `#${row.li + 1}`)));
    }
    box.append(ol);
    if (rows.length > 1000) box.append(h('p', { class: 'lv-muted' }, `Showing the first 1,000 of ${num(rows.length)} entries.`));
  }

  // ---------- tab: raw debug log ----------

  function renderRaw(p) {
    const R = S.raw;
    if (S.jump != null) { R.cats.clear(); R.hideNoise = false; }
    const search = el.rawSearch = h('input', { type: 'search', placeholder: 'Search the log (Ctrl+F)', spellcheck: 'false', 'aria-label': 'Search the log' });
    search.value = R.q;
    const count = h('span', { class: 'lr-count' });
    const noise = h('input', { type: 'checkbox' });
    noise.checked = R.hideNoise;
    const chips = h('div', { class: 'lr-chips' }, RAW_CATS.filter((c) => p.catCounts[CATS.indexOf(c)]).map((c) => h('button', {
      class: `lr-chip c-${c}`, 'aria-pressed': String(R.cats.has(c)), title: `Show only ${CAT_LABEL[c].toLowerCase()} (combine several)`,
      onclick: (e) => {
        if (R.cats.has(c)) R.cats.delete(c); else R.cats.add(c);
        e.currentTarget.setAttribute('aria-pressed', String(R.cats.has(c)));
        rebuild();
      },
    }, CAT_LABEL[c], h('small', {}, num(p.catCounts[CATS.indexOf(c)])))));
    const box = h('div', { class: 'lr-box', tabindex: '0', 'aria-label': 'Debug log lines' });
    el.vBody.append(h('div', { class: 'lr-tools' },
      h('div', { class: 'lr-search' }, search, count,
        h('button', { class: 'ghost small', title: 'Previous match (Shift+Enter)', onclick: () => step(-1) }, '↑'),
        h('button', { class: 'ghost small', title: 'Next match (Enter)', onclick: () => step(1) }, '↓')),
      chips,
      h('label', { class: 'lr-noise', title: 'Hides heap, statement, variable and system-method lines' }, noise, 'Hide noise')), box);

    let view = null;
    let re = null;
    let matches = [];
    const lineAt = (r) => (view ? view[r] : r);
    const vl = virtualList(box, ROW_H, (r) => {
      const i = lineAt(r);
      const cat = p.lineCat[i];
      const cls = `lr c-${CATS[cat & 0x7f]}${cat & CONT ? ' cont' : ''}${i === R.flash ? ' flash' : ''}${re && r === matches[R.matchPos] ? ' cur' : ''}`;
      return `<div class="${cls}" style="top:${r * ROW_H}px"><span class="ln">${i + 1}</span><span class="lt">${lineHtml(p.lines[i], cat, re)}</span></div>`;
    });

    function rebuild() {
      if (!R.cats.size && !R.hideNoise) view = null;
      else {
        const allow = CATS.map((c) => (R.cats.size ? R.cats.has(c) : true));
        if (R.hideNoise) allow[CATS.indexOf('system')] = false;
        allow[CATS.indexOf('session')] = true;
        view = [];
        for (let i = 0; i < p.lines.length; i++) if (allow[p.lineCat[i] & 0x7f]) view.push(i);
      }
      vl.setCount(view ? view.length : p.lines.length);
      runSearch(false);
    }

    function runSearch(jump) {
      const q = R.q.trim();
      re = q ? new RegExp(escRe(q), 'gi') : null;
      matches = [];
      if (re) {
        const t = new RegExp(escRe(q), 'i');
        const n = view ? view.length : p.lines.length;
        for (let r = 0; r < n; r++) if (t.test(p.lines[lineAt(r)])) matches.push(r);
      }
      if (jump || R.matchPos < 0 || R.matchPos >= matches.length) R.matchPos = matches.length ? 0 : -1;
      updateCount();
      if (jump && matches.length) vl.scrollTo(matches[R.matchPos]); else vl.draw();
    }

    function updateCount() {
      count.textContent = re ? (matches.length ? `${R.matchPos + 1} / ${num(matches.length)}` : 'No matches') : '';
      count.classList.toggle('none', !!re && !matches.length);
    }

    function step(d) {
      if (!matches.length) return;
      R.matchPos = (R.matchPos + d + matches.length) % matches.length;
      updateCount();
      vl.scrollTo(matches[R.matchPos]);
    }

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { R.q = search.value; runSearch(true); }, 160); });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(timer);
      if (R.q !== search.value) { R.q = search.value; runSearch(true); } else step(e.shiftKey ? -1 : 1);
    });
    noise.addEventListener('change', () => { R.hideNoise = noise.checked; rebuild(); });

    rebuild();
    if (S.jump != null) {
      const li = S.jump;
      S.jump = null;
      R.flash = li;
      vl.scrollTo(li);
      setTimeout(() => { if (R.flash === li) { R.flash = null; if (box.isConnected) vl.draw(); } }, 1800);
    }
  }

  // ---------- tab: queries ----------

  function renderQueries(p) {
    if (!p.queries.length) return el.vBody.append(emptyTab('No SOQL or SOSL queries in this log', 'Queries are logged when the Database category is INFO or finer.'));
    const Q = S.qv;
    const groups = groupQueries(p.queries);
    const countOf = new Map(groups.map((g) => [g.key, g.items.length]));
    const repeated = groups.filter((g) => g.items.length > 1).length;
    const totalNs = p.queries.reduce((t, q) => t + (q.dur || 0), 0);
    const maxNs = Math.max(1, ...p.queries.map((q) => q.dur || 0), ...groups.map((g) => g.dur));
    const search = h('input', { type: 'search', placeholder: 'Filter by query text or method', spellcheck: 'false' });
    search.value = Q.q;
    const groupBtn = h('button', { class: 'lg-toggle', 'aria-pressed': String(Q.group), title: 'Collapse identical queries into one row' }, 'Group identical');
    const wrap = h('div', { class: 'lv-table-wrap' });
    el.vBody.append(
      h('div', { class: 'lv-sum' },
        stat(num(p.queries.length), 'queries'), stat(num(p.summary.rows), 'rows'), stat(fmtMs(totalNs / 1e6), 'total time'),
        repeated ? h('span', { class: 'lv-stat warn', title: 'The same query ran more than once — often a query inside a loop' }, h('b', {}, repeated), `repeated ${repeated === 1 ? 'query' : 'queries'}`) : null),
      h('div', { class: 'lv-tools' }, search, groupBtn), wrap);

    const timeCell = (ns) => h('span', { class: 'lv-bar', style: `--w:${((ns || 0) / maxNs) * 100}%` }, fmtMs(ns == null ? null : ns / 1e6));
    const queryCell = (q, n) => h('div', { class: 'lv-q' }, rawHtml('code', 'soql', soqlHtml(q.query)),
      n > 1 ? h('span', { class: 'lv-x', title: `Ran ${n} times in this log` }, `×${n}`) : null);

    const draw = () => {
      const f = Q.q.trim().toLowerCase();
      const ok = (q) => !f || q.query.toLowerCase().includes(f) || (q.context || '').toLowerCase().includes(f);
      if (Q.group) {
        wrap.replaceChildren(table([
          { key: 'count', label: 'Runs', num: true, sort: (g) => g.items.length, render: (g) => num(g.items.length) },
          { key: 'query', label: 'Query', cls: 'q', render: (g) => queryCell(g.items[0], g.items.length) },
          { key: 'object', label: 'Object', sort: (g) => g.items[0].object || '', render: (g) => g.items[0].object || '—' },
          { key: 'rows', label: 'Rows', num: true, sort: (g) => g.rows, render: (g) => num(g.rows) },
          { key: 'dur', label: 'Time', num: true, sort: (g) => g.dur, render: (g) => timeCell(g.dur) },
          { key: 'order', label: 'Lines', sort: (g) => g.items[0].li, render: (g) => h('div', { class: 'lv-lns' }, g.items.slice(0, 6).map(lineLink), g.items.length > 6 ? `+${g.items.length - 6}` : null) },
        ], groups.filter((g) => ok(g.items[0])).map((g) => ({ ...g, _cls: g.items.length > 1 ? 'warn' : null })), Q, draw));
      } else {
        wrap.replaceChildren(table([
          { key: 'order', label: '#', num: true, sort: (q) => q.idx, render: (q) => String(q.idx + 1) },
          { key: 'query', label: 'Query', cls: 'q', render: (q) => queryCell(q, countOf.get(queryKey(q))) },
          { key: 'object', label: 'Object', sort: (q) => q.object || '', render: (q) => q.object || (q.sosl ? 'SOSL' : '—') },
          { key: 'rows', label: 'Rows', num: true, sort: (q) => q.rows ?? -1, render: (q) => num(q.rows) },
          { key: 'dur', label: 'Time', num: true, sort: (q) => q.dur ?? -1, render: (q) => timeCell(q.dur) },
          { key: 'ctx', label: 'Called from', sort: (q) => `${q.tx || ''}${q.context || ''}`, render: (q) => h('span', { class: 'lv-ctx' }, txChip(q), q.context || '—') },
          { key: 'line', label: 'Line', render: lineLink },
        ], p.queries.filter(ok).map((q) => ({ ...q, _cls: countOf.get(queryKey(q)) > 1 ? 'warn' : null })), Q, draw));
      }
    };
    search.addEventListener('input', () => { Q.q = search.value; draw(); });
    groupBtn.addEventListener('click', () => {
      Q.group = !Q.group;
      Q.sort = Q.group ? 'count' : 'order';
      Q.dir = Q.group ? -1 : 1;
      groupBtn.setAttribute('aria-pressed', String(Q.group));
      draw();
    });
    draw();
  }

  // ---------- tab: user debug ----------

  function renderDebugs(p) {
    if (!p.debugs.length) return el.vBody.append(emptyTab('No System.debug output in this log', 'Debug statements are logged when Apex Code is DEBUG or finer.'));
    const D = S.dv;
    const present = DEBUG_LEVELS.filter((l) => p.debugs.some((d) => d.level === l));
    const search = h('input', { type: 'search', placeholder: 'Search debug messages', spellcheck: 'false' });
    search.value = D.q;
    const prettyBtn = h('button', { class: 'lg-toggle', 'aria-pressed': String(D.pretty), title: 'Pretty-print JSON messages' }, 'Format JSON');
    const chips = h('div', { class: 'lr-chips' }, present.map((l) => h('button', {
      class: `lr-chip l-${l.toLowerCase()}`, 'aria-pressed': String(D.levels.has(l)),
      onclick: (e) => {
        if (D.levels.has(l)) D.levels.delete(l); else D.levels.add(l);
        e.currentTarget.setAttribute('aria-pressed', String(D.levels.has(l)));
        D.shown = PAGE;
        draw();
      },
    }, l, h('small', {}, num(p.debugs.filter((d) => d.level === l).length)))));
    const list = h('div', { class: 'ud-list' });
    el.vBody.append(h('div', { class: 'lv-tools' }, search, chips, prettyBtn), list);

    const t0 = p.firstNs ?? 0;
    function draw() {
      const q = D.q.trim();
      const re = q ? new RegExp(escRe(q), 'gi') : null;
      const t = q ? new RegExp(escRe(q), 'i') : null;
      const items = p.debugs.filter((d) => (!D.levels.size || D.levels.has(d.level)) && (!t || t.test(d.msg) || t.test(d.context || '')));
      list.replaceChildren(...items.slice(0, D.shown).map((d) => {
        const pretty = D.pretty ? prettyJson(d.msg) : null;
        const text = pretty ?? d.msg;
        return h('article', { class: `ud l-${d.level.toLowerCase()}` },
          h('header', { class: 'ud-head' },
            h('span', { class: 'ud-lvl' }, d.level),
            lineLink(d),
            txChip(d),
            d.context ? h('span', { class: 'lv-ctx' }, d.context) : null,
            h('span', { class: 'ud-time', title: 'Time since the start of the log' }, `+${fmtMs((d.ns - t0) / 1e6)}`),
            h('button', { class: 'ghost small ud-copy', onclick: () => copyText(text) }, 'Copy')),
          rawHtml('pre', pretty ? 'json' : '', re || !pretty ? hi(text, re) : jsonHtml(text)));
      }));
      if (!items.length) list.append(h('p', { class: 'lv-muted' }, 'No debug messages match.'));
      if (items.length > D.shown) {
        list.append(h('button', { class: 'ghost ud-more', onclick: () => { D.shown += PAGE; draw(); } }, `Show ${Math.min(PAGE, items.length - D.shown)} more of ${num(items.length - D.shown)}`));
      }
    }
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { D.q = search.value; D.shown = PAGE; draw(); }, 120); });
    prettyBtn.addEventListener('click', () => { D.pretty = !D.pretty; prettyBtn.setAttribute('aria-pressed', String(D.pretty)); draw(); });
    draw();
  }

  // ---------- tab: order of execution ----------

  function renderOrder(p) {
    const T = S.tree;
    const t0 = p.root.start;
    const total = Math.max(1, p.root.end - t0);
    const wrap = h('div', { class: 'ot', role: 'tree' });
    const kids = (n) => (T.methods ? n.children : n.children.flatMap((c) => (c.kind === 'method' ? kids(c) : [c])));
    el.vBody.append(
      h('div', { class: 'lv-tools' },
        h('button', { class: 'ghost small', onclick: () => expand(wrap, 3000, true) }, 'Expand all'),
        h('button', { class: 'ghost small', onclick: () => { for (const nd of wrap.querySelectorAll('.ot-node')) nd._toggle(false); } }, 'Collapse all'),
        h('button', { class: 'lg-toggle', 'aria-pressed': String(T.methods), title: 'Hide method calls to see only triggers, flows, SOQL and DML', onclick: () => { T.methods = !T.methods; showTab('order'); } }, 'Show methods'),
        h('span', { class: 'lv-muted ot-hint' }, 'Click a row to expand · the number on the right opens that line in the log')),
      h('div', { class: 'ot-head' }, h('span', {}, 'Step'), h('span', { class: 'num' }, 'Duration'), h('span', {}, 'Timeline'), h('span', {})),
      wrap);

    function row(n, depth) {
      const ch = kids(n);
      const k = n.sub || n.kind;
      const caret = h('button', { class: `caret${ch.length ? '' : ' none'}`, 'aria-expanded': 'false', tabindex: ch.length ? null : '-1', 'aria-label': 'Toggle' }, '▸');
      const roll = n.children.length ? [
        n.n.soql ? h('span', { title: 'SOQL queries inside' }, `${n.n.soql} SOQL`) : null,
        n.n.dml ? h('span', { title: 'DML statements inside' }, `${n.n.dml} DML`) : null,
        n.n.error ? h('span', { class: 'e', title: 'Errors inside' }, `⚠ ${n.n.error}`) : null,
      ] : [];
      const r = h('div', { class: `ot-row k-${k}`, role: 'treeitem' },
        h('div', { class: 'ot-main', style: `--d:${depth}` }, caret,
          h('span', { class: 'ot-kind' }, KIND_LABEL[k] || k),
          h('span', { class: 'ot-label', title: n.label }, n.label),
          h('span', { class: 'ot-roll' }, roll)),
        h('span', { class: 'ot-dur' }, LEAF_KINDS.has(n.kind) ? '' : fmtMs((n.end - n.start) / 1e6)),
        h('span', { class: 'ot-tl' }, h('i', { style: barStyle(n, t0, total) })),
        h('button', { class: 'lv-ln', title: 'Show in Debug Log', onclick: (e) => { e.stopPropagation(); jumpTo(n.li); } }, `#${n.li + 1}`));
      const box = h('div', { class: 'ot-kids', role: 'group', hidden: true });
      let built = false;
      const node = h('div', { class: 'ot-node' }, r, box);
      node._kids = ch;
      node._toggle = (open = box.hidden) => {
        if (!ch.length) return;
        if (open && !built) { built = true; appendKids(box, ch, depth + 1, 0); }
        box.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
      };
      r.addEventListener('click', () => node._toggle());
      return node;
    }

    function appendKids(box, ch, depth, from) {
      const to = Math.min(ch.length, from + PAGE);
      for (let i = from; i < to; i++) box.append(row(ch[i], depth));
      if (to < ch.length) {
        const more = h('button', { class: 'ghost small ot-more', style: `--d:${depth}`, onclick: () => { more.remove(); appendKids(box, ch, depth, to); } }, `Show ${Math.min(PAGE, ch.length - to)} more of ${num(ch.length - to)}`);
        box.append(more);
      }
    }

    function expand(container, budget) {
      let frontier = [...container.querySelectorAll(':scope > .ot-node')];
      while (frontier.length && budget > 0) {
        const next = [];
        for (const nd of frontier) {
          if (budget <= 0) break;
          if (!nd._kids.length) continue;
          nd._toggle(true);
          budget -= Math.min(nd._kids.length, PAGE);
          next.push(...nd.querySelectorAll(':scope > .ot-kids > .ot-node'));
        }
        frontier = next;
      }
    }

    const top = kids(p.root);
    if (!top.length) return el.vBody.replaceChildren(emptyTab('Nothing to show', 'This log has no code units, methods, queries or DML.'));
    appendKids(wrap, top, 0, 0);
    expand(wrap, 250);
  }

  // ---------- tab: DML ----------

  function renderDml(p) {
    if (!p.dml.length) return el.vBody.append(emptyTab('No DML in this log', 'DML statements are logged when the Database category is INFO or finer.'));
    const V = S.dmlv;
    const byObj = new Map();
    for (const d of p.dml) byObj.set(d.object, (byObj.get(d.object) || 0) + 1);
    const maxNs = Math.max(1, ...p.dml.map((d) => d.dur || 0));
    const totalNs = p.dml.reduce((t, d) => t + (d.dur || 0), 0);
    const search = h('input', { type: 'search', placeholder: 'Filter by object, operation or method', spellcheck: 'false' });
    search.value = V.q;
    const wrap = h('div', { class: 'lv-table-wrap' });
    el.vBody.append(
      h('div', { class: 'lv-sum' },
        stat(num(p.dml.length), 'statements'), stat(num(p.summary.dmlRows), 'rows'), stat(fmtMs(totalNs / 1e6), 'total time'),
        ...[...byObj].map(([o, n]) => h('span', { class: 'lv-stat obj' }, o, h('b', {}, `×${n}`)))),
      h('div', { class: 'lv-tools' }, search),
      wrap);
    const draw = () => {
      const f = V.q.trim().toLowerCase();
      const rows = p.dml.filter((d) => !f || [d.op, d.object, d.context].some((v) => v && v.toLowerCase().includes(f)));
      wrap.replaceChildren(table([
        { key: 'order', label: '#', num: true, sort: (d) => d.idx, render: (d) => String(d.idx + 1) },
        { key: 'op', label: 'Operation', sort: (d) => d.op, render: (d) => h('span', { class: `op op-${d.op.toLowerCase()}` }, d.op) },
        { key: 'object', label: 'Object', sort: (d) => d.object, render: (d) => h('b', { class: 'mono' }, d.object) },
        { key: 'rows', label: 'Rows', num: true, sort: (d) => d.rows ?? -1, render: (d) => num(d.rows) },
        { key: 'dur', label: 'Time', num: true, sort: (d) => d.dur ?? -1, render: (d) => h('span', { class: 'lv-bar', style: `--w:${((d.dur || 0) / maxNs) * 100}%` }, fmtMs(d.dur == null ? null : d.dur / 1e6)) },
        { key: 'ctx', label: 'Called from', sort: (d) => d.context || '', render: (d) => h('span', { class: 'lv-ctx' }, txChip(d), d.context || 'Flow / declarative') },
        { key: 'line', label: 'Line', render: lineLink },
      ], rows, V, draw));
    };
    search.addEventListener('input', () => { V.q = search.value; draw(); });
    draw();
  }

  // ---------- tab: governor limits ----------

  function renderLimits(p) {
    if (!p.limits.size) return el.vBody.append(emptyTab('No governor limit usage in this log', 'Limit usage is logged at the end of the transaction when Apex Profiling is INFO or finer.'));
    const L = S.lv;
    const btn = h('button', { class: 'lg-toggle', 'aria-pressed': String(L.hideUnused), onclick: () => { L.hideUnused = !L.hideUnused; showTab('limits'); } }, 'Hide unused');
    el.vBody.append(h('div', { class: 'lv-tools' }, btn, h('span', { class: 'lv-muted' }, 'Cumulative usage at the end of the transaction.')));
    for (const [ns, list] of p.limits) {
      const rows = list.filter((l) => !L.hideUnused || l.used > 0);
      const hot = list.filter((l) => pctOf(l) >= 50).length;
      el.vBody.append(h('section', { class: 'lm-section' },
        h('h3', {}, p.merged ? ns : ns === '(default)' ? 'Your code' : `Namespace ${ns}`,
          h('span', { class: 'lv-muted' }, ` · ${list.filter((l) => l.used).length} of ${list.length} in use`),
          hot ? h('span', { class: 'lv-stat warn' }, h('b', {}, hot), 'at 50% or more') : null),
        h('div', { class: 'lm-list' }, rows.length ? rows.map((l) => limitRow(l.name, l.used, l.max)) : h('p', { class: 'lv-muted lm-none' }, 'Nothing used.'))));
    }
  }

  // ---------- tab: org limits ----------

  async function renderOrgLimits() {
    const O = S.ov;
    const search = h('input', { type: 'search', placeholder: 'Filter limits', spellcheck: 'false' });
    search.value = O.q;
    const sortSel = h('select', { 'aria-label': 'Sort' }, h('option', { value: 'pct' }, 'Most used first'), h('option', { value: 'name' }, 'Name'));
    sortSel.value = O.sort;
    const asOf = h('span', { class: 'lv-muted' });
    const refresh = h('button', { class: 'ghost small', onclick: async () => { refresh.disabled = true; await load(); refresh.disabled = false; draw(); } }, '↻ Refresh');
    const wrap = h('div', { class: 'lm-list' });
    el.vBody.append(h('div', { class: 'lv-tools' }, search, sortSel, refresh, asOf), wrap);
    search.addEventListener('input', () => { O.q = search.value; draw(); });
    sortSel.addEventListener('change', () => { O.sort = sortSel.value; draw(); });

    async function load() {
      try {
        S.orgLimits = await backend.orgLimits();
        S.orgLimitsAt = new Date();
      } catch (e) {
        if (wrap.isConnected) wrap.replaceChildren(h('p', { class: 'lv-errtext lm-none' }, e.message));
      }
    }
    function draw() {
      if (!S.orgLimits || !wrap.isConnected) return;
      const f = O.q.trim().toLowerCase();
      const rows = Object.entries(S.orgLimits)
        .filter(([, v]) => v && typeof v.Max === 'number' && typeof v.Remaining === 'number')
        .map(([k, v]) => ({ name: humanize(k), used: v.Max - v.Remaining, max: v.Max }))
        .filter((r) => !f || r.name.toLowerCase().includes(f));
      rows.sort(O.sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => (b.max ? b.used / b.max : 0) - (a.max ? a.used / a.max : 0) || a.name.localeCompare(b.name));
      wrap.replaceChildren(...(rows.length ? rows.map((r) => limitRow(r.name, r.used, r.max)) : [h('p', { class: 'lv-muted lm-none' }, 'No limits match.')]));
      asOf.textContent = `Live from your org · updated ${fmtTime(S.orgLimitsAt)}`;
    }
    if (!S.orgLimits) {
      wrap.replaceChildren(h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), 'Loading org limits…'));
      await load();
    }
    draw();
  }

  // ---------- lifecycle ----------

  async function boot() {
    el.logList.replaceChildren(h('li', { class: 'lg-empty' }, 'Loading logs…'));
    const [me, levels] = await Promise.all([
      backend.currentUserId().catch(() => null),
      backend.listDebugLevels().catch((e) => { toast(e.message, 'error'); return []; }),
    ]);
    S.me = me;
    S.levels = levels;
    renderLevels();
    if (me) {
      try {
        const [u] = await backend.getUsers([me]);
        if (u) { S.meUser = u; if (!S.form.user) pickUser(u); }
      } catch { /* the user can still search */ }
    }
    await Promise.all([loadFlags(), loadLogs(true)]);
  }

  let booted = false;
  function setActive(on) {
    S.active = on;
    if (on && !booted) { booted = true; boot(); } else if (on) { loadLogs(false); loadFlags(); }
    schedule();
    clearInterval(S.tickTimer);
    S.tickTimer = on ? setInterval(() => { renderFlags(); renderLogs(); updateUntil(); }, 30000) : null;
  }

  // ---------- opened from another view (The OG Executor) ----------
  // an org log by id: refresh the list first if it's newer than what we have
  async function showLog(id) {
    if (!S.logs.some((l) => l.Id === id)) await loadLogs(false);
    openLog(id);
  }
  // a log that isn't stored in the org (an Anonymous Apex run's log comes back with the call): shown as-is
  function showText(meta, body) {
    S.extraLogs ||= new Map();
    S.extraLogs.set(meta.Id, { ...meta, local: true });
    S.parsed.delete(meta.Id);
    S.bodies.set(meta.Id, body);
    openLog(meta.Id);
  }

  return { setActive, showLog, showText };
}
