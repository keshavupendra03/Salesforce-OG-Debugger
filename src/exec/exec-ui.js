// The OG Executor: pick an async Apex class (Batch / Queueable / Schedulable are detected from the code),
// fill in its constructor, get ready-to-run Anonymous Apex, edit it, execute it, and follow the jobs it
// started: status, progress, errors, and their debug logs. Or just write Anonymous Apex, with suggestions.

import { h } from '../dom.js';
import { highlight } from '../apex/highlight.js';
import { resizable, collapsibleSide } from '../layout.js';
import { parseLog, summarize } from '../logs/log-parser.js';
import {
  KINDS, asyncClasses, paramsOf, defaultValue, generate, jobName, CRON_PRESETS, describeCron, idsFromDebug, parseStack, TERMINAL,
} from './exec-core.js';
import { suggest, SNIPPETS, CARET } from './apex-complete.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
const DRAFT_KEY = 'og-exec-draft';
const HIST_KEY = 'og-exec-history:v1';
const PREFS_KEY = 'og-exec-prefs';
const HIST_MAX = 40;
const POLL_MS = 3000;

const STARTER = `// The OG Executor · Anonymous Apex
// Pick a Batch, Queueable or Schedulable class on the left to generate the code that runs it,
// or write anything here. Ctrl+Enter executes, Ctrl+Space suggests, type "debug" + Tab for System.debug.

List<Account> accounts = [SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 5];
System.debug('Latest accounts: ' + accounts.size());
`;

const sfDate = (s) => (s ? new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null);
const sfIso = (ms) => new Date(ms).toISOString().replace('Z', '+0000');
const fmtTime = (d) => (d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2600);
}
async function copyText(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg, 'ok');
}

/**
 * opts: {
 *   backend: SfExecBackend | DemoExecBackend,
 *   getIndex: () => Promise<CodeIndex>, listObjects: () => Promise<[{name,label}]>, listFields: (name) => Promise<[...]>,
 *   openLog: ({ id } | { meta, body }) => void, setupUrl: (path) => string | null,
 * }
 */
export function mountExecutor(root, opts) {
  const { backend } = opts;
  const prefs = store.get(PREFS_KEY, {});
  const S = {
    active: false, classes: null, scanErr: null, q: '', kind: 'all', side: prefs.side || 'classes',
    sel: null, cfg: null, generated: null,
    running: null, run: null, resTab: 'result',
    history: store.get(HIST_KEY, []),
    preset: prefs.preset || 'detail',
    me: null, traceUntil: null,
    objects: [], fields: new Map(), meta: { classes: [], objects: [] },
    sugg: null,
  };
  const el = {};
  S.runnerOpen = prefs.runnerOpen;
  const savePrefs = () => store.set(PREFS_KEY, { side: S.side, preset: S.preset, runnerOpen: S.runnerOpen });

  // ---------- layout ----------
  el.side = h('aside', { class: 'ox-side' });
  el.main = h('section', { class: 'ox-main' });
  root.replaceChildren(el.side, el.main);
  root.append(resizable({
    handle: h('div', { class: 'ox-split' }), pane: el.side, host: root, cssVar: '--ox-side', edge: 'end',
    min: 220, max: () => root.clientWidth * 0.45, key: 'ff-split-ox', label: 'Resize the class list',
  }));
  const side = collapsibleSide({
    host: root, pane: el.side, key: 'ff-side-ox', label: 'the class list',
    rail: () => [h('span', { class: 'side-rail-chip' }, 'Class'), h('span', { class: `side-rail-label${S.sel ? '' : ' muted'}` }, S.sel?.display || 'Anonymous Apex')],
  });

  // ---------- classes (from the Code Flow scan) ----------
  async function loadClasses() {
    try {
      const index = await opts.getIndex();
      S.classes = asyncClasses(index);
      buildMeta(index);
    } catch (e) {
      S.scanErr = e.message || String(e);
    }
    drawSide();
  }

  // what the editor's suggestions know about the org's Apex
  function buildMeta(index) {
    const kindsBy = new Map((S.classes || []).map((c) => [c.key, c.kinds.map((k) => KINDS[k].short)]));
    const pub = (m) => !m.mods.has('private') && m.kind === 'method';
    S.meta.classes = [...(index?.types?.values?.() || [])].filter((t) => t.kind === 'class' && !t.outer && !t.isTest).map((t) => ({
      name: t.name, kinds: kindsBy.get(t.key) || [],
      statics: t.methods.filter((m) => pub(m) && m.isStatic).map((m) => ({ name: m.name, params: paramsOf(m) })),
      methods: t.methods.filter((m) => pub(m) && !m.isStatic).map((m) => ({ name: m.name, params: paramsOf(m) })),
    }));
    opts.listObjects?.().then((list) => { S.objects = list || []; S.meta.objects = S.objects; }).catch(() => {});
  }
  S.meta.fields = (name) => {
    const k = name.toLowerCase();
    if (S.fields.has(k)) return S.fields.get(k);
    S.fields.set(k, undefined);
    opts.listFields?.(name).then((f) => { S.fields.set(k, f || null); if (S.sugg && document.activeElement === el.ta) updateSuggest(false); })
      .catch(() => S.fields.set(k, null));
    return undefined;
  };

  function drawSide() {
    const tabs = h('div', { class: 'ox-sidetabs', role: 'tablist' },
      ['classes', 'history'].map((k) => h('button', {
        role: 'tab', 'aria-selected': String(S.side === k), onclick: () => { S.side = k; savePrefs(); drawSide(); },
      }, k === 'classes' ? 'Async classes' : 'History', k === 'history' && S.history.length ? h('span', { class: 'ox-n' }, S.history.length) : null)));
    el.side.replaceChildren(...[tabs, S.side === 'classes' ? classesPane() : historyPane(), el.side.querySelector('.side-rail')].filter(Boolean));
    side.refresh();
  }

  function classesPane() {
    const blank = h('button', { class: `ox-blank${!S.sel ? ' sel' : ''}`, onclick: () => pickClass(null) },
      h('span', { class: 'ox-blank-i', 'aria-hidden': 'true' }, '✎'),
      h('span', {}, h('b', {}, 'Anonymous Apex'), h('small', {}, 'Write and run any code')));
    if (S.scanErr) return h('div', { class: 'ox-pane' }, blank, h('p', { class: 'ox-note err' }, `Couldn’t read your Apex: ${S.scanErr}`));
    if (!S.classes) {
      return h('div', { class: 'ox-pane' }, blank, h('div', { class: 'ox-scanning' }, h('span', { class: 'lg-spinner' }), h('span', {}, 'Reading your Apex classes…', h('small', {}, 'Same scan as Code Flow: cached, only changes are fetched'))));
    }
    const counts = { all: S.classes.length };
    for (const k of Object.keys(KINDS)) counts[k] = S.classes.filter((c) => c.kinds.includes(k)).length;
    const q = S.q.trim().toLowerCase();
    const list = S.classes.filter((c) => (S.kind === 'all' || c.kinds.includes(S.kind)) && (!q || c.display.toLowerCase().includes(q)));
    const search = h('input', {
      type: 'search', class: 'ox-search', placeholder: `Search ${counts.all} async classes`, value: S.q, 'aria-label': 'Search classes', spellcheck: 'false',
      oninput: (e) => { S.q = e.target.value; const pos = e.target.selectionStart; drawSide(); const s = el.side.querySelector('.ox-search'); s.focus(); s.setSelectionRange(pos, pos); },
      onkeydown: (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); el.side.querySelector('.ox-cls')?.focus(); } if (e.key === 'Enter' && list[0]) pickClass(list[0]); },
    });
    const chips = h('div', { class: 'ox-kinds', role: 'radiogroup', 'aria-label': 'Filter by kind' },
      ['all', ...Object.keys(KINDS)].map((k) => h('button', {
        role: 'radio', 'aria-checked': String(S.kind === k), class: `ox-kind-chip k-${k}`, disabled: k !== 'all' && !counts[k],
        onclick: () => { S.kind = k; drawSide(); },
      }, k === 'all' ? 'All' : KINDS[k].short, h('span', { class: 'ox-n' }, counts[k]))));
    const items = list.map((c) => h('button', {
      class: `ox-cls${S.sel?.key === c.key ? ' sel' : ''}`, title: c.display,
      onclick: () => pickClass(c),
      onkeydown: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = [...el.side.querySelectorAll('.ox-cls')];
          all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      },
    },
    h('span', { class: 'ox-cls-name' }, c.display),
    h('span', { class: 'ox-cls-tags' }, c.kinds.map((k) => h('span', { class: `ox-tag k-${k}` }, KINDS[k].short))),
    h('span', { class: 'ox-cls-sub' }, ctorHint(c))));
    return h('div', { class: 'ox-pane' }, blank, search, chips,
      h('div', { class: 'ox-list', role: 'list' }, items.length ? items : h('p', { class: 'ox-note' }, S.classes.length ? 'No class matches.' : 'No Batch, Queueable or Schedulable classes found in your org’s Apex.')));
  }

  const ctorHint = (c) => {
    const min = Math.min(...c.ctors.map((k) => k.params.length));
    const many = c.ctors.length > 1;
    if (!c.ctors.length) return 'private constructor';
    return `${min ? `needs ${plural(min, 'argument')}` : 'no arguments'}${many ? ` · ${c.ctors.length} constructors` : ''}${c.callouts ? ' · callouts' : ''}`;
  };

  function historyPane() {
    if (!S.history.length) return h('div', { class: 'ox-pane' }, h('p', { class: 'ox-note' }, 'Runs you execute show up here. Click one to load its code again.'));
    return h('div', { class: 'ox-pane' },
      h('div', { class: 'ox-list' }, S.history.map((x) => h('button', {
        class: 'ox-hist', title: 'Load this code into the editor',
        onclick: () => { setCode(x.code, true); if (x.cls) S.sel = null; drawRunner(); toast('Loaded into the editor', 'ok'); },
      },
      h('span', { class: `ox-dot ${x.ok ? 'ok' : 'bad'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'ox-hist-main' },
        h('b', {}, x.title),
        h('small', {}, [ago(x.at), x.jobs ? plural(x.jobs, 'job') : null, x.ok ? null : x.msg].filter(Boolean).join(' · '))))),
      h('button', { class: 'link ox-clearhist', onclick: () => { S.history = []; store.set(HIST_KEY, []); drawSide(); } }, 'Clear history')));
  }

  // ---------- picking a class: the runner ----------
  function pickClass(c) {
    S.sel = c;
    if (c) {
      const kind = c.kinds[0];
      const ctorIdx = Math.max(0, c.ctors.findIndex((k) => !k.params.length));
      S.cfg = { kind, ctorIdx: c.ctors.length ? ctorIdx : 0, args: {}, batchSize: 200, cron: CRON_PRESETS[1][0], jobName: jobName(c.display), delay: 0, runNow: false };
      fillDefaults();
      regenerate(true);
    }
    drawSide();
    drawRunner();
    el.ta.focus();
  }

  const isSObject = (n) => S.objects.some((o) => o.name.toLowerCase() === n.toLowerCase()) || /__c$/i.test(n) || /^(account|contact|lead|opportunity|case|user|task|event|campaign|product2|order|contract|asset|workorder)$/i.test(n);
  function fillDefaults() {
    const ctor = S.sel?.ctors[S.cfg.ctorIdx];
    for (const p of ctor?.params || []) if (S.cfg.args[p.name] == null) S.cfg.args[p.name] = defaultValue(p.type, isSObject);
  }

  function regenerate(force) {
    if (!S.sel) return;
    const code = generate({ cls: S.sel.display, kind: S.cfg.kind, ctor: S.sel.ctors[S.cfg.ctorIdx], ...S.cfg });
    const edited = S.generated != null && el.ta.value !== S.generated;
    if (edited && !force) { el.edited.hidden = false; S.pending = code; return; }
    S.generated = code;
    S.pending = null;
    setCode(code, true);
    el.edited.hidden = true;
  }

  function drawRunner() {
    const c = S.sel;
    el.runner.hidden = !c;
    if (!c) { el.runner.replaceChildren(); return; }
    const cfg = S.cfg;
    const change = (fn) => (e) => { fn(e); regenerate(false); drawRunner(); };
    const kindSwitch = c.kinds.length > 1
      ? h('div', { class: 'ox-seg', role: 'radiogroup', 'aria-label': 'Run as' }, h('span', { class: 'ox-seg-l' }, 'Run as'),
        c.kinds.map((k) => h('button', { role: 'radio', 'aria-checked': String(cfg.kind === k), class: `k-${k}`, onclick: change(() => { cfg.kind = k; }) }, KINDS[k].label)))
      : h('span', { class: `ox-tag big k-${cfg.kind}` }, KINDS[cfg.kind].label);
    const ctor = c.ctors[cfg.ctorIdx];
    const fields = [];
    if (c.ctors.length > 1) {
      fields.push(h('label', { class: 'ox-field wide' }, h('span', { class: 'ox-label' }, 'Constructor'),
        h('select', { onchange: change((e) => { cfg.ctorIdx = +e.target.value; fillDefaults(); }) },
          c.ctors.map((k, i) => h('option', { value: i, selected: i === cfg.ctorIdx }, `new ${c.name}(${k.params.map((p) => `${p.type} ${p.name}`).join(', ')})`)))));
    }
    for (const p of ctor?.params || []) {
      const input = h('input', {
        class: 'ox-mono', value: cfg.args[p.name] ?? '', spellcheck: 'false', 'aria-label': `Value for ${p.name}`, title: cfg.args[p.name] ?? '',
        oninput: (e) => { cfg.args[p.name] = e.target.value; e.target.title = e.target.value; regenerate(false); },
      });
      // quick values sit next to the input, so each parameter takes one line
      const quick = quickValues(p.type).filter((v) => v !== cfg.args[p.name]).slice(0, 2);
      fields.push(h('div', { class: 'ox-field ox-param' },
        h('span', { class: 'ox-label' }, h('code', {}, p.name), h('span', { class: 'ox-type', title: p.type }, p.type)),
        h('div', { class: 'ox-param-row' }, input,
          quick.map((v) => h('button', { type: 'button', class: 'ox-qv', title: `Use ${v}`, onclick: change(() => { cfg.args[p.name] = v; }) }, v.length > 14 ? `${v.slice(0, 12)}…` : v)))));
    }
    if (cfg.kind === 'batch') {
      const sizes = [1, 50, 100, 200, 2000];
      fields.push(h('div', { class: 'ox-field wide' },
        h('span', { class: 'ox-label' }, 'Batch size', h('span', { class: 'ox-help', title: 'Records per execute() call: 1–2000. Default 200.' }, 'ⓘ')),
        h('div', { class: 'ox-row' },
          h('input', { type: 'number', min: 1, max: 2000, value: cfg.batchSize, class: 'ox-num', 'aria-label': 'Batch size', oninput: (e) => { cfg.batchSize = +e.target.value || 200; regenerate(false); paintBatchWarn(); } }),
          h('div', { class: 'ox-quick' }, sizes.map((n) => h('button', { type: 'button', 'aria-pressed': String(+cfg.batchSize === n), onclick: change(() => { cfg.batchSize = n; }) }, n)))),
        el.batchWarn = h('small', { class: 'ox-warn', hidden: true })));
    }
    if (cfg.kind === 'queueable') {
      fields.push(h('label', { class: 'ox-field' }, h('span', { class: 'ox-label' }, 'Start'),
        h('select', { onchange: change((e) => { cfg.delay = +e.target.value; }) },
          [[0, 'Right away'], [1, 'In 1 minute'], [5, 'In 5 minutes'], [10, 'In 10 minutes']].map(([v, l]) => h('option', { value: v, selected: cfg.delay === v }, l)))));
    }
    if (cfg.kind === 'schedulable') {
      fields.push(h('div', { class: 'ox-field wide' }, h('span', { class: 'ox-label' }, 'How'),
        h('div', { class: 'ox-seg small', role: 'radiogroup' },
          h('button', { role: 'radio', 'aria-checked': String(!cfg.runNow), onclick: change(() => { cfg.runNow = false; }) }, '⏰ Schedule it'),
          h('button', { role: 'radio', 'aria-checked': String(cfg.runNow), onclick: change(() => { cfg.runNow = true; }) }, '▶ Run execute() once now'))));
      if (!cfg.runNow) {
        const custom = !CRON_PRESETS.some(([x]) => x === cfg.cron);
        const cronIn = h('input', { class: 'ox-mono', value: cfg.cron, spellcheck: 'false', 'aria-label': 'Cron expression', oninput: (e) => { cfg.cron = e.target.value; desc.textContent = describeCron(cfg.cron); regenerate(false); } });
        const desc = h('small', { class: 'ox-cron-desc' }, describeCron(cfg.cron));
        fields.push(
          h('label', { class: 'ox-field' }, h('span', { class: 'ox-label' }, 'When'),
            h('select', { onchange: change((e) => { if (e.target.value) cfg.cron = e.target.value; else cfg.cron = '0 0 * * * ?'; }) },
              CRON_PRESETS.map(([x, l]) => h('option', { value: x, selected: x === cfg.cron }, l)), h('option', { value: '', selected: custom }, 'Custom…'))),
          h('div', { class: 'ox-field' }, h('span', { class: 'ox-label' }, 'Cron expression', h('span', { class: 'ox-help', title: 'seconds minutes hours day-of-month month day-of-week [year] · use ? in one of the day fields' }, 'ⓘ')), cronIn, desc),
          h('label', { class: 'ox-field wide' }, h('span', { class: 'ox-label' }, 'Job name', h('span', { class: 'ox-help', title: 'Must be unique among scheduled jobs' }, 'ⓘ')),
            h('input', { value: cfg.jobName, oninput: (e) => { cfg.jobName = e.target.value; regenerate(false); } })));
      }
    }
    const open = S.runnerOpen !== false;
    const nArgs = ctor?.params.length || 0;
    // what the collapsed card still tells you
    const summary = [
      nArgs ? plural(nArgs, 'argument') : 'no arguments',
      cfg.kind === 'batch' ? `batch size ${cfg.batchSize}` : null,
      cfg.kind === 'queueable' ? (cfg.delay ? `starts in ${cfg.delay} min` : 'starts right away') : null,
      cfg.kind === 'schedulable' ? (cfg.runNow ? 'runs execute() once now' : describeCron(cfg.cron)) : null,
    ].filter(Boolean).join(' · ');
    const toggle = () => { S.runnerOpen = !open; savePrefs(); drawRunner(); };
    el.runner.classList.toggle('collapsed', !open);
    el.runner.replaceChildren(...[ // (filter: replaceChildren would print a null as "null")
      h('div', { class: 'ox-runner-head' },
        h('button', { class: 'ox-collapse', 'aria-expanded': String(open), title: open ? 'Collapse the settings' : 'Show the settings', 'aria-label': open ? 'Collapse the settings' : 'Show the settings', onclick: toggle }, '▾'),
        h('span', { class: 'ox-runner-i', 'aria-hidden': 'true' }, { batch: '⚙', queueable: '⇶', schedulable: '⏱' }[cfg.kind]),
        h('div', { class: 'ox-runner-title', onclick: toggle },
          h('b', {}, c.display),
          h('small', {}, open ? `implements ${c.kinds.map((k) => KINDS[k].iface).join(', ')}${c.callouts ? ', Database.AllowsCallouts' : ''}${c.stateful ? ', Database.Stateful' : ''}` : summary)),
        kindSwitch,
        h('button', { class: 'ghost small', title: 'Back to plain Anonymous Apex', onclick: () => pickClass(null) }, '×')),
      open ? (fields.length ? h('div', { class: 'ox-fields' }, fields) : h('p', { class: 'ox-note' }, 'No constructor arguments needed. The code below is ready: press Execute.')) : null].filter(Boolean));
    paintBatchWarn();
  }
  function paintBatchWarn() {
    if (!el.batchWarn?.isConnected) return;
    const n = +S.cfg.batchSize;
    const msg = n > 2000 || n < 1 ? 'Batch size must be between 1 and 2000.'
      : S.sel.callouts && n > 100 ? `This class makes callouts: each execute() can make at most 100, so with ${n} records per batch it may fail with “Too many callouts”. Try 100 or less.`
        : '';
    el.batchWarn.hidden = !msg;
    el.batchWarn.textContent = msg;
  }

  function quickValues(type) {
    const t = type.toLowerCase();
    const out = [];
    const gen = /^list<\s*([\w.]+)\s*>$/i.exec(type);
    if (gen && isSObject(gen[1])) out.push(`[SELECT Id FROM ${gen[1]} LIMIT 200]`, `new List<${gen[1]}>()`);
    if (t === 'date') out.push('Date.today()', 'Date.today().addDays(-30)');
    if (t === 'datetime') out.push('Datetime.now()');
    if (t === 'boolean') out.push('true', 'false');
    if (t === 'id' || t === 'string') out.push("''");
    out.push('null');
    return [...new Set(out)];
  }

  // ---------- main: header, runner, editor, results ----------
  function buildMain() {
    el.trace = h('div', { class: 'ox-trace' });
    el.preset = h('select', {
      class: 'ox-preset', title: 'How much the debug log of this run records', 'aria-label': 'Log detail',
      onchange: (e) => { S.preset = e.target.value; savePrefs(); },
    }, h('option', { value: 'detail', selected: S.preset === 'detail' }, 'Log: detailed'), h('option', { value: 'debug', selected: S.preset === 'debug' }, 'Log: debug only'));
    const head = h('header', { class: 'ox-head' },
      h('div', { class: 'ox-title' }, h('h1', {}, 'The OG Executor'), h('p', {}, 'Run Batch, Queueable and Schedulable Apex, or any Anonymous Apex, and watch what happens.')),
      h('span', { class: 'ox-grow' }), el.trace);

    el.runner = h('section', { class: 'ox-runner', hidden: true, 'aria-label': 'Run a class' });

    // editor: gutter + highlight layer + transparent textarea, like the SOQL editor
    el.gutter = h('pre', { class: 'ox-gutter', 'aria-hidden': 'true' });
    el.hl = h('pre', { class: 'ox-code ox-hl', 'aria-hidden': 'true' });
    el.mirror = h('div', { class: 'ox-code ox-mirror', 'aria-hidden': 'true' });
    el.ta = h('textarea', {
      class: 'ox-code ox-ta', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off',
      'aria-label': 'Anonymous Apex', 'aria-autocomplete': 'list', 'aria-controls': 'ox-sugg',
    });
    el.sugg = h('ul', { class: 'dx-sugg ox-sugg', id: 'ox-sugg', role: 'listbox', hidden: true });
    el.edwrap = h('div', { class: 'ox-edwrap' }, el.hl, el.mirror, el.ta, el.sugg);
    el.ed = h('div', { class: 'ox-ed' }, el.gutter, el.edwrap);

    el.exec = h('button', { class: 'primary ox-exec', title: 'Execute (Ctrl+Enter). With text selected, runs only the selection.', onclick: () => execute() },
      h('span', { class: 'ox-exec-i', 'aria-hidden': 'true' }, '▶'), h('span', { class: 'ox-exec-l' }, 'Execute'));
    el.stop = h('button', { class: 'ghost ox-stop', hidden: true, onclick: () => S.running?.abort() }, 'Stop waiting');
    el.edited = h('span', { class: 'ox-edited', hidden: true },
      'You edited the code · ', h('button', { class: 'link', onclick: () => { if (S.pending) { S.generated = null; regenerate(true); } } }, 'Replace with the new settings'));
    const tmpl = h('button', {
      class: 'ghost small', 'aria-haspopup': 'menu', title: 'Insert a ready-made snippet',
      onclick: (e) => menu(e.currentTarget, SNIPPETS.map(([name, body, detail]) => ({ label: detail, hint: name, run: () => insertSnippet(body) }))),
    }, '⧉ Snippets ▾');
    el.edbar = h('div', { class: 'ox-edbar' }, el.exec, el.stop, tmpl, el.preset, h('span', { class: 'ox-grow' }), el.edited,
      h('button', { class: 'ghost small', title: 'Copy the code', onclick: () => copyText(el.ta.value, 'Code copied') }, 'Copy'),
      h('button', { class: 'ghost small', title: 'Clear the editor', onclick: () => { setCode('', true); el.ta.focus(); } }, 'Clear'));
    el.hint = h('div', { class: 'ox-ed-hint' }, 'Ctrl+Enter execute · Ctrl+Space suggestions · Ctrl+/ comment · Tab indent');
    el.edcard = h('section', { class: 'ox-edcard' }, el.edbar, el.ed, el.hint);

    el.results = h('section', { class: 'ox-results', 'aria-label': 'Results' });
    el.work = h('div', { class: 'ox-work' }, el.runner, el.edcard,
      resizable({
        handle: h('div', { class: 'ox-ed-grip' }), pane: el.ed, host: root, cssVar: '--ox-ed', axis: 'y', edge: 'end',
        min: 120, max: () => el.main.clientHeight - 200, key: 'ff-split-ox-ed', label: 'Resize the editor',
      }),
      el.results);
    el.main.replaceChildren(head, el.work);

    el.ta.addEventListener('input', () => { paint(); saveDraft(); updateSuggest(true); });
    el.ta.addEventListener('scroll', syncScroll);
    el.ta.addEventListener('click', () => hideSuggest());
    el.ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== el.ta) hideSuggest(); }, 150));
    el.ta.addEventListener('keydown', onKey);
    el.ta.addEventListener('select', paintExecLabel);
    el.ta.addEventListener('keyup', paintExecLabel);
    el.ta.addEventListener('mouseup', paintExecLabel);

    setCode(store.get(DRAFT_KEY, null) ?? STARTER, false);
    drawResults();
  }

  let draftT = 0;
  const saveDraft = () => { clearTimeout(draftT); draftT = setTimeout(() => store.set(DRAFT_KEY, el.ta.value), 300); };

  function setCode(text, undoable) {
    if (undoable) {
      el.ta.focus();
      el.ta.select();
      if (!document.execCommand('insertText', false, text)) el.ta.value = text;
      el.ta.setSelectionRange(0, 0);
      el.ta.scrollTop = 0;
    } else el.ta.value = text;
    S.errLine = null;
    paint();
    saveDraft();
  }

  function paint() {
    const lines = el.ta.value.split('\n');
    let inBlock = false;
    let html = '';
    lines.forEach((line, i) => {
      const r = highlight(line, inBlock);
      inBlock = r.inBlock;
      html += `<span class="ox-line${S.errLine === i + 1 ? ' err' : ''}">${r.html || ' '}</span>`;
    });
    el.hl.innerHTML = html;
    el.gutter.textContent = lines.map((_, i) => i + 1).join('\n');
    if (S.errLine) el.gutter.innerHTML = lines.map((_, i) => (i + 1 === S.errLine ? `<b class="err">${i + 1}</b>` : i + 1)).join('\n');
    syncScroll();
    paintExecLabel();
  }
  function syncScroll() {
    el.hl.scrollTop = el.ta.scrollTop;
    el.hl.scrollLeft = el.ta.scrollLeft;
    el.gutter.scrollTop = el.ta.scrollTop;
    if (S.sugg) placeSuggest();
  }
  function paintExecLabel() {
    const sel = el.ta.selectionStart !== el.ta.selectionEnd;
    el.exec.querySelector('.ox-exec-l').textContent = S.running ? 'Executing…' : sel ? 'Execute selection' : 'Execute';
  }

  function goToLine(n, col) {
    const lines = el.ta.value.split('\n');
    if (!n || n > lines.length) return;
    let pos = 0;
    for (let i = 0; i < n - 1; i++) pos += lines[i].length + 1;
    el.ta.focus();
    el.ta.setSelectionRange(pos + Math.max(0, (col || 1) - 1), pos + lines[n - 1].length);
    const lh = parseFloat(getComputedStyle(el.ta).lineHeight) || 20;
    el.ta.scrollTop = Math.max(0, (n - 4) * lh);
    syncScroll();
  }

  // ---------- editing keys ----------
  function onKey(e) {
    const open = S.sugg && !el.sugg.hidden && S.sugg.items.length;
    const ta = el.ta;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); hideSuggest(); execute(); return; }
    if (e.ctrlKey && e.key === ' ') { e.preventDefault(); updateSuggest(true, true); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = S.sugg.items.length;
        S.sugg.sel = (S.sugg.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        drawSuggest();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(S.sugg.items[S.sugg.sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSuggest(); return; }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      if (s === en && !e.shiftKey) { insertText('    '); return; }
      // indent / outdent the selected lines
      const v = ta.value;
      const a = v.lastIndexOf('\n', s - 1) + 1;
      const block = v.slice(a, en);
      const out = e.shiftKey ? block.replace(/^( {1,4}|\t)/gm, '') : block.replace(/^/gm, '    ');
      ta.setSelectionRange(a, en);
      insertText(out);
      ta.setSelectionRange(a, a + out.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // keep the indentation, one level more after "{"
      e.preventDefault();
      const s = ta.selectionStart;
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
      const opens = /\{\s*$/.test(v.slice(lineStart, s));
      const closes = /^\s*\}/.test(v.slice(s));
      if (opens && closes) {
        insertText(`\n${indent}    \n${indent}`);
        const p = s + 1 + indent.length + 4;
        ta.setSelectionRange(p, p);
      } else insertText(`\n${indent}${opens ? '    ' : ''}`);
      return;
    }
    if (e.key === '}') {
      // "}" on an otherwise empty line goes back one level
      const s = ta.selectionStart;
      const v = ta.value;
      const lineStart = v.lastIndexOf('\n', s - 1) + 1;
      const before = v.slice(lineStart, s);
      if (/^ {4,}$/.test(before)) {
        e.preventDefault();
        ta.setSelectionRange(s - 4, s);
        insertText('}');
      }
    }
  }
  function insertText(text) {
    if (!document.execCommand('insertText', false, text)) {
      const s = el.ta.selectionStart;
      el.ta.setRangeText(text, s, el.ta.selectionEnd, 'end');
      el.ta.dispatchEvent(new Event('input'));
    }
  }
  function toggleComment() {
    const ta = el.ta;
    const v = ta.value;
    const a = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let b = v.indexOf('\n', Math.max(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0), a));
    if (b < 0) b = v.length;
    const block = v.slice(a, b);
    const all = block.split('\n').filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
    const out = all ? block.replace(/^(\s*)\/\/ ?/gm, '$1') : block.replace(/^(\s*)(?=\S)/gm, '$1// ');
    ta.setSelectionRange(a, b);
    insertText(out);
    ta.setSelectionRange(a, a + out.length);
  }
  // insert a snippet at the caret, indented like the current line, caret where ⟂ is
  function insertSnippet(body, from = el.ta.selectionStart, to = el.ta.selectionEnd) {
    const v = el.ta.value;
    const lineStart = v.lastIndexOf('\n', from - 1) + 1;
    const indent = /^[ \t]*/.exec(v.slice(lineStart))[0];
    const text = body.replace(/\n/g, `\n${indent}`);
    const caret = text.indexOf(CARET);
    const clean = text.replace(CARET, '');
    el.ta.focus();
    el.ta.setSelectionRange(from, to);
    insertText(clean);
    const p = from + (caret < 0 ? clean.length : caret);
    el.ta.setSelectionRange(p, p);
    paintExecLabel();
  }

  // ---------- suggestions ----------
  const ICON = { snippet: '⌘', method: 'ƒ', field: 'F', class: 'C', object: 'O', var: 'v', kw: 'K', type: 'T' };
  function updateSuggest(typed, manual = false) {
    const ta = el.ta;
    if (ta.selectionStart !== ta.selectionEnd) { hideSuggest(); return; }
    const pos = ta.selectionStart;
    const r = suggest(ta.value, pos, S.meta);
    const ch = ta.value[pos - 1] || '';
    const word = ta.value.slice(r.from, pos);
    // pop up on its own after a "." or "new ", or once a word has 2 letters
    const wanted = manual || S.sugg?.manual || (typed && (ch === '.' || (/\w/.test(ch) && word.length >= 2) || /\bnew\s$/.test(ta.value.slice(0, pos))));
    if (!wanted || !r.items.length) { hideSuggest(); return; }
    const prev = S.sugg?.items[S.sugg.sel]?.label;
    S.sugg = { ...r, sel: Math.max(0, r.items.findIndex((x) => x.label === prev)), manual: manual || S.sugg?.manual };
    drawSuggest();
    placeSuggest();
  }
  function drawSuggest() {
    const s = S.sugg;
    el.sugg.hidden = false;
    const partial = el.ta.value.slice(s.from, el.ta.selectionStart).toLowerCase();
    el.sugg.replaceChildren(...s.items.map((it, i) => {
      const l = it.label;
      const at = partial ? l.toLowerCase().indexOf(partial) : -1;
      return h('li', {
        role: 'option', id: `ox-sg-${i}`, class: `dx-sg k-${it.kind === 'class' ? 'object' : it.kind === 'method' ? 'fn' : it.kind === 'var' ? 'rel' : it.kind}${i === s.sel ? ' sel' : ''}`,
        'aria-selected': String(i === s.sel), onmousedown: (e) => { e.preventDefault(); accept(it); },
      }, h('span', { class: 'dx-sg-icon', 'aria-hidden': 'true' }, ICON[it.kind] || '·'),
      h('span', { class: 'dx-sg-label' }, at >= 0 ? [l.slice(0, at), h('mark', {}, l.slice(at, at + partial.length)), l.slice(at + partial.length)] : l),
      it.detail ? h('span', { class: 'dx-sg-detail' }, it.detail) : null);
    }), h('li', { class: 'dx-sg-foot', 'aria-hidden': 'true' }, '↑↓ choose · Enter / Tab insert · Esc close'));
    el.ta.setAttribute('aria-activedescendant', `ox-sg-${s.sel}`);
    el.sugg.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function placeSuggest() {
    const ta = el.ta;
    el.mirror.style.width = `${ta.scrollWidth}px`;
    el.mirror.textContent = ta.value.slice(0, S.sugg.from);
    const mark = h('span', {}, '​');
    el.mirror.append(mark);
    const x = mark.offsetLeft - ta.scrollLeft;
    const y = mark.offsetTop - ta.scrollTop + mark.offsetHeight;
    const w = el.sugg.offsetWidth || 360;
    el.sugg.style.left = `${Math.max(4, Math.min(x, el.edwrap.clientWidth - w - 4))}px`;
    el.sugg.style.top = `${Math.max(0, y + 2)}px`;
  }
  function hideSuggest() {
    S.sugg = null;
    el.sugg.hidden = true;
    el.ta.removeAttribute('aria-activedescendant');
  }
  function accept(it) {
    const s = S.sugg;
    if (!it || !s) return;
    hideSuggest();
    insertSnippet(it.insert, s.from, Math.max(s.to, el.ta.selectionStart));
    if (/\.$/.test(it.insert)) updateSuggest(true);
  }

  // ---------- small menu ----------
  let openMenu = null;
  function menu(anchor, items) {
    closeMenu();
    const pop = h('div', { class: 'dx-pop ox-menu', role: 'menu' }, items.map((it) => h('button', {
      class: 'dx-mi', role: 'menuitem', onclick: () => { closeMenu(); it.run(); },
    }, h('span', {}, it.label), it.hint ? h('code', { class: 'dx-mi-hint' }, it.hint) : null)));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 4}px`;
    const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) closeMenu(); };
    const key = (e) => { if (e.key === 'Escape') closeMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    document.addEventListener('keydown', key, true);
    openMenu = { pop, outside, key };
  }
  function closeMenu() {
    if (!openMenu) return;
    openMenu.pop.remove();
    document.removeEventListener('pointerdown', openMenu.outside, true);
    document.removeEventListener('keydown', openMenu.key, true);
    openMenu = null;
  }

  // ---------- executing ----------
  async function execute() {
    if (S.running) return;
    const ta = el.ta;
    const selected = ta.selectionStart !== ta.selectionEnd;
    const code = selected ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
    // line numbers in errors are relative to what ran: shift them back for a selection
    const offset = selected ? ta.value.slice(0, ta.selectionStart).split('\n').length - 1 : 0;
    if (!code.trim()) { toast('Nothing to execute: write some Apex first', 'error'); ta.focus(); return; }
    const start = Date.now();
    const controller = new AbortController();
    S.running = controller;
    S.errLine = null;
    paint();
    el.exec.disabled = true;
    el.exec.classList.add('busy');
    el.stop.hidden = false;
    paintExecLabel();
    const run = {
      id: start, at: start, code, offset, cls: S.sel?.display || null, kind: S.sel ? S.cfg.kind : null,
      result: null, error: null, debugs: [], parsed: null, jobIds: [], cronIds: [], jobs: new Map(), crons: new Map(), logs: [], ms: 0,
    };
    S.run = run;
    drawResults();
    try {
      S.me ||= await backend.me().catch(() => null);
      // your recent jobs before running: afterwards, the new ones are this run's (even from hand-written code).
      // A 10-minute window absorbs a browser clock that's off from Salesforce's.
      const [before, oldLogs] = await Promise.all([
        backend.recentJobs(start - 600000, S.me?.id).then((l) => new Set(l.map((j) => j.Id)), () => null),
        backend.logsSince(start - 600000, S.me?.id).then((l) => new Set(l.map((x) => x.Id)), () => new Set()),
      ]);
      run.oldLogs = oldLogs;
      const r = await backend.execute(code, { preset: S.preset, signal: controller.signal });
      run.ms = Date.now() - start;
      run.result = r;
      if (r.log) {
        const p = parseLog(r.log);
        p.summary = summarize(p);
        run.parsed = p;
        run.debugs = p.debugs;
      }
      if (!r.compiled || !r.success) {
        S.errLine = r.line ? r.line + offset : null;
        if (!r.compiled) S.errLine ||= null;
        paint();
      }
      const ids = idsFromDebug(run.debugs.map((d) => d.msg));
      run.jobIds = ids.jobs;
      run.cronIds = ids.crons;
      if (r.success && before) {
        // jobs started by hand-written code too (no OG_JOB_ID line)
        try {
          const recent = await backend.recentJobs(start - 600000, S.me?.id);
          for (const j of recent) if (!before.has(j.Id) && !run.jobIds.includes(j.Id) && j.JobType !== 'ScheduledApex') run.jobIds.push(j.Id);
        } catch { /* the job ids from the log are enough */ }
      }
      S.resTab = !r.compiled || !r.success ? 'result' : run.jobIds.length || run.cronIds.length ? 'jobs' : run.debugs.length ? 'output' : 'result';
      remember(run);
    } catch (e) {
      run.error = e.name === 'AbortError' ? 'Stopped waiting. The code may still be running in Salesforce.' : e.message || String(e);
      S.resTab = 'result';
    } finally {
      S.running = null;
      el.exec.disabled = false;
      el.exec.classList.remove('busy');
      el.stop.hidden = true;
      paintExecLabel();
    }
    drawResults();
    if (run.jobIds.length || run.cronIds.length) poll(run, true);
  }

  function remember(run) {
    const r = run.result;
    const title = run.cls ? `${run.cls} · ${KINDS[run.kind]?.short || ''}` : (run.code.split('\n').find((l) => l.trim() && !/^\s*\/\//.test(l)) || 'Anonymous Apex').trim().slice(0, 80);
    S.history.unshift({
      at: run.at, code: run.code, title, ok: r.compiled && r.success, jobs: run.jobIds.length + run.cronIds.length,
      msg: !r.compiled ? 'compile error' : !r.success ? (r.exceptionMessage || 'exception').split(':')[0] : null,
    });
    S.history = S.history.slice(0, HIST_MAX);
    store.set(HIST_KEY, S.history);
    if (S.side === 'history') drawSide();
  }

  // ---------- following the jobs ----------
  let pollT = 0;
  async function poll(run, first) {
    clearTimeout(pollT);
    if (run !== S.run) return;
    try {
      const [jobs, crons] = await Promise.all([backend.jobs(run.jobIds), backend.crons(run.cronIds)]);
      for (const j of jobs) {
        const was = run.jobs.get(j.Id)?.Status;
        run.jobs.set(j.Id, j);
        if (was && was !== j.Status && TERMINAL.has(j.Status)) announce(j);
      }
      for (const c of crons) run.crons.set(c.Id, c);
      run.logs = await backend.logsSince(run.at - 600000, S.me?.id).then((l) => l.filter((x) => !run.oldLogs?.has(x.Id)), () => run.logs);
      if (first && run.traceKnown == null) {
        S.traceUntil = await backend.traceUntil(S.me?.id).catch(() => null);
        run.traceKnown = true;
        drawTrace();
      }
    } catch (e) {
      run.pollErr = e.message;
    }
    if (run !== S.run) return;
    drawResults(true);
    const live = [...run.jobs.values()].some((j) => !TERMINAL.has(j.Status) && j.JobType !== 'ScheduledApex');
    // keep watching a little after the last job ends: its debug logs arrive a moment later
    if (live || (run.tail = (run.tail ?? 3) - (live ? 0 : 1)) > 0) pollT = setTimeout(() => poll(run), S.active ? POLL_MS : POLL_MS * 4);
  }
  function announce(j) {
    const name = j.ApexClass?.Name || 'Job';
    if (j.Status === 'Completed' && !j.NumberOfErrors) toast(`${name} completed`, 'ok');
    else if (j.Status === 'Completed') toast(`${name} finished with ${j.NumberOfErrors} failed ${j.NumberOfErrors === 1 ? 'batch' : 'batches'}`, 'error');
    else if (j.Status === 'Failed') toast(`${name} failed: ${j.ExtendedStatus || 'see its log'}`, 'error');
  }

  // ---------- trace status (async logs need it) ----------
  async function refreshTrace() {
    try {
      S.me ||= await backend.me();
      S.traceUntil = await backend.traceUntil(S.me?.id);
    } catch { S.traceUntil = null; }
    drawTrace();
  }
  function drawTrace() {
    const on = S.traceUntil && S.traceUntil > Date.now();
    el.trace.replaceChildren(on
      ? h('span', { class: 'ox-trace-on', title: 'Your USER_DEBUG trace flag is on: batch and queueable jobs write debug logs' }, h('span', { class: 'ox-dot ok' }), `Async logs on · until ${fmtTime(new Date(S.traceUntil))}`)
      : h('button', { class: 'ghost small ox-trace-btn', title: 'Batch and queueable jobs run later in their own transactions. They only write debug logs while you have a trace flag.', onclick: traceMe },
        h('span', { class: 'ox-dot' }), 'Async logs off · ', h('b', {}, 'Trace me for 1 hour')));
  }
  async function traceMe(e) {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try {
      S.me ||= await backend.me();
      S.traceUntil = await backend.traceMe(S.me.id, 60);
      toast('Tracing you for 1 hour: async jobs will write debug logs', 'ok');
    } catch (err) {
      toast(`Couldn’t start a trace flag: ${err.message}`, 'error');
    }
    drawTrace();
    drawResults(true);
  }

  // ---------- results ----------
  function drawResults(keepScroll) {
    const run = S.run;
    const scrollTop = keepScroll ? el.results.querySelector('.ox-rbody')?.scrollTop : 0;
    if (!run) {
      el.results.replaceChildren(h('div', { class: 'ox-empty' },
        h('div', { class: 'ox-empty-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
        h('b', { class: 'ox-empty-title' }, 'Ready when you are'),
        h('p', {}, 'Execute the code above. The result, System.debug output, the jobs it starts and their debug logs show up here.')));
      return;
    }
    const r = run.result;
    const jobsN = run.jobIds.length + run.cronIds.length;
    const tabs = [
      ['result', 'Result', null, run.error || (r && (!r.compiled || !r.success)) ? 'bad' : ''],
      ['output', 'Debug output', run.debugs.length],
      ['jobs', 'Jobs', jobsN || null, [...run.jobs.values()].some((j) => j.Status === 'Failed' || j.NumberOfErrors) ? 'bad' : ''],
      ['logs', 'Logs', (run.parsed ? 1 : 0) + run.logs.length || null],
    ];
    const tabbar = h('nav', { class: 'ox-rtabs', role: 'tablist' }, tabs.map(([k, label, n, tone]) => h('button', {
      role: 'tab', 'aria-selected': String(S.resTab === k), onclick: () => { S.resTab = k; drawResults(); },
    }, label, n ? h('span', { class: `ox-n${tone ? ` ${tone}` : ''}` }, n) : tone ? h('span', { class: `ox-dot ${tone}` }) : null)));
    const body = h('div', { class: 'ox-rbody' });
    if (!r && !run.error) body.append(h('div', { class: 'ox-wait' }, h('span', { class: 'lg-spinner' }), h('b', {}, 'Executing…'), h('small', {}, 'Compiling and running in your org')));
    else ({ result: resultTab, output: outputTab, jobs: jobsTab, logs: logsTab })[S.resTab](body, run);
    el.results.replaceChildren(tabbar, body);
    if (keepScroll) body.scrollTop = scrollTop;
  }

  function resultTab(body, run) {
    const r = run.result;
    if (run.error) {
      body.append(h('div', { class: 'ox-banner bad' }, h('span', { class: 'ox-banner-i' }, '!'), h('div', {}, h('b', { class: 'ox-banner-t' }, 'Couldn’t execute'), h('p', {}, run.error))));
      return;
    }
    const sum = run.parsed?.summary;
    const facts = [
      fmtMs(run.ms),
      run.debugs.length ? plural(run.debugs.length, 'debug line') : null,
      run.jobIds.length ? plural(run.jobIds.length, 'job') + ' started' : null,
      run.cronIds.length ? plural(run.cronIds.length, 'schedule') + ' created' : null,
      sum?.soql ? `${sum.soql} SOQL` : null,
      sum?.dml ? `${sum.dml} DML` : null,
    ].filter(Boolean).join(' · ');
    if (!r.compiled) {
      const line = r.line ? r.line + run.offset : null;
      const src = line ? el.ta.value.split('\n')[line - 1] : null;
      body.append(h('div', { class: 'ox-banner bad compile' },
        h('span', { class: 'ox-banner-i' }, '✗'),
        h('div', {},
          h('b', { class: 'ox-banner-t' }, 'Compile error', line ? ` · line ${line}${r.column ? `, column ${r.column}` : ''}` : ''),
          h('p', { class: 'ox-errmsg' }, r.compileProblem),
          src != null ? h('pre', { class: 'ox-excerpt' }, h('span', { class: 'ox-excerpt-n' }, line), src, r.column ? `\n${' '.repeat(String(line).length + 1 + Math.max(0, r.column - 1))}^` : '') : null,
          line ? h('button', { class: 'ghost small', onclick: () => goToLine(line, r.column) }, `Go to line ${line}`) : null)));
      return;
    }
    if (!r.success) {
      const stack = parseStack(r.exceptionStackTrace);
      body.append(h('div', { class: 'ox-banner bad' },
        h('span', { class: 'ox-banner-i' }, '✗'),
        h('div', {},
          h('b', { class: 'ox-banner-t ox-exc-title' }, 'Exception'),
          h('p', { class: 'ox-errmsg' }, r.exceptionMessage),
          stack.length ? h('ul', { class: 'ox-stack' }, stack.map((f) => h('li', {},
            f.anon && f.line ? h('button', { class: 'link', onclick: () => goToLine(f.line + run.offset, f.column) }, `Your code: line ${f.line + run.offset}`) : h('code', {}, f.where + (f.line ? `: line ${f.line}` : ''))))) : null,
          h('small', { class: 'ox-facts' }, facts),
          h('div', { class: 'ox-row' }, logButtons(run)))));
      return;
    }
    const n = run.jobIds.length + run.cronIds.length;
    body.append(h('div', { class: 'ox-banner ok' },
      h('span', { class: 'ox-banner-i' }, '✓'),
      h('div', {},
        h('b', { class: 'ox-banner-t ox-ok-title' }, n ? `Executed · ${plural(n, run.cronIds.length && !run.jobIds.length ? 'schedule' : 'job')} started` : 'Executed successfully'),
        h('small', { class: 'ox-facts' }, facts),
        h('div', { class: 'ox-row' },
          n ? h('button', { class: 'primary small', onclick: () => { S.resTab = 'jobs'; drawResults(); } }, `Watch ${n === 1 ? 'the job' : 'the jobs'} →`) : null,
          run.debugs.length ? h('button', { class: 'ghost small', onclick: () => { S.resTab = 'output'; drawResults(); } }, 'Debug output') : null,
          logButtons(run)))));
  }

  function logButtons(run) {
    if (!run.result?.log) return null;
    return [
      h('button', { class: 'ghost small', title: 'Open this run’s log in Debug Logs: execution path, queries, limits…', onclick: () => openAnonLog(run) }, 'Open log in Debug Logs ↗'),
      h('button', { class: 'ghost small', onclick: () => copyText(run.result.log, 'Log copied') }, 'Copy log'),
    ];
  }
  function anonMeta(run) {
    const r = run.result;
    return {
      Id: `og-exec-${run.at}`, local: true, LogUserId: S.me?.id, LogUser: { Name: S.me?.name || 'You' },
      Operation: run.cls ? `Anonymous Apex · ${run.cls}` : 'Anonymous Apex · OG Executor', Request: 'API',
      Status: !r.compiled ? 'Compile error' : !r.success ? r.exceptionMessage : 'Success',
      LogLength: r.log.length, DurationMilliseconds: run.ms, StartTime: sfIso(run.at), Application: 'OG Executor', Location: 'OG Executor',
    };
  }
  const openAnonLog = (run) => opts.openLog?.({ meta: anonMeta(run), body: run.result.log });

  function outputTab(body, run) {
    if (!run.debugs.length) {
      body.append(h('div', { class: 'ox-none' }, h('b', {}, 'No System.debug output'), h('p', {}, 'Type ', h('code', {}, 'debug'), ' + Tab in the editor for System.debug, or ', h('code', {}, 'debugjson'), ' to print anything as JSON.')));
      return;
    }
    let q = '';
    const list = h('ol', { class: 'ox-debugs' });
    const draw = () => {
      const s = q.trim().toLowerCase();
      const rows = run.debugs.filter((d) => !s || d.msg.toLowerCase().includes(s));
      list.replaceChildren(...rows.map((d) => {
        let msg = d.msg;
        let json = false;
        if (/^\s*[[{]/.test(msg)) { try { msg = JSON.stringify(JSON.parse(msg), null, 2); json = true; } catch { /* not JSON */ } }
        const line = d.line ? d.line + run.offset : null;
        return h('li', { class: `ox-debug lv-${d.level.toLowerCase()}` },
          line ? h('button', { class: 'ox-debug-ln', title: `Go to line ${line}`, onclick: () => goToLine(line) }, `L${line}`) : h('span', { class: 'ox-debug-ln' }, ''),
          h('span', { class: 'ox-debug-lv' }, d.level),
          h('pre', { class: `ox-debug-msg${json ? ' json' : ''}` }, msg),
          h('button', { class: 'ox-copy', title: 'Copy', 'aria-label': 'Copy this line', onclick: () => copyText(d.msg, 'Copied') }, '⧉'));
      }));
      if (!rows.length) list.append(h('li', { class: 'ox-note' }, 'Nothing matches.'));
    };
    body.append(h('div', { class: 'ox-rtools' },
      h('input', { type: 'search', placeholder: 'Filter debug output…', 'aria-label': 'Filter debug output', oninput: (e) => { q = e.target.value; draw(); } }),
      h('span', { class: 'ox-grow' }),
      h('button', { class: 'ghost small', onclick: () => copyText(run.debugs.map((d) => d.msg).join('\n'), 'Debug output copied') }, 'Copy all'),
      logButtons(run)?.[0]), list);
    draw();
  }

  function jobsTab(body, run) {
    if (!run.jobIds.length && !run.cronIds.length) {
      body.append(h('div', { class: 'ox-none' }, h('b', {}, 'No async jobs started'), h('p', {}, 'Batch, Queueable and scheduled jobs started by this run show up here, with live status.')));
      return;
    }
    const traced = S.traceUntil && S.traceUntil > Date.now();
    if (!traced && run.jobIds.length) {
      body.append(h('div', { class: 'ox-tip' }, h('span', { 'aria-hidden': 'true' }, '💡'),
        h('span', {}, 'Jobs run later, in their own transactions, and only write debug logs while you’re traced. '),
        h('button', { class: 'ghost small', onclick: traceMe }, 'Trace me for 1 hour')));
    }
    const live = [...run.jobs.values()].some((j) => !TERMINAL.has(j.Status) && j.JobType !== 'ScheduledApex');
    body.append(h('div', { class: 'ox-rtools' },
      h('span', { class: 'ox-live' }, live ? [h('span', { class: 'ox-pulse' }), 'Live · refreshing every 3 s'] : 'Not running'),
      h('span', { class: 'ox-grow' }),
      h('button', { class: 'ghost small', onclick: () => poll(run) }, '↻ Refresh'),
      opts.setupUrl?.('/lightning/setup/AsyncApexJobs/home') ? h('button', { class: 'ghost small', onclick: () => window.open(opts.setupUrl('/lightning/setup/AsyncApexJobs/home'), '_blank', 'noopener') }, 'Apex Jobs in Setup ↗') : null));
    for (const id of run.cronIds) body.append(cronCard(run, run.crons.get(id), id));
    for (const id of run.jobIds) {
      const j = run.jobs.get(id);
      if (j?.JobType === 'ScheduledApex' && run.cronIds.includes(j.CronTriggerId)) continue;
      body.append(jobCard(run, j, id));
    }
  }

  const STATUS = {
    Holding: ['wait', 'Holding'], Queued: ['wait', 'Queued'], Preparing: ['run', 'Preparing'], Processing: ['run', 'Processing'],
    Completed: ['ok', 'Completed'], Failed: ['bad', 'Failed'], Aborted: ['off', 'Aborted'],
  };
  function jobCard(run, j, id) {
    if (!j) return h('div', { class: 'ox-job' }, h('div', { class: 'ox-job-head' }, h('code', {}, id), h('span', { class: 'ox-st wait' }, 'Looking it up…')));
    const [tone, label] = STATUS[j.Status] || ['wait', j.Status];
    const tone2 = j.Status === 'Completed' && j.NumberOfErrors ? 'warn' : tone;
    const total = j.TotalJobItems || 0;
    const done = j.JobItemsProcessed || 0;
    const pct = total ? Math.round((done / total) * 100) : TERMINAL.has(j.Status) ? 100 : 0;
    const created = sfDate(j.CreatedDate);
    const ended = sfDate(j.CompletedDate);
    const logs = run.logs.filter((l) => /batch|queue/i.test(l.Operation || '') || l.Request === 'Batch');
    const steps = j.JobType === 'BatchApex' ? ['Queued', 'Preparing', 'Processing', 'Completed'] : ['Queued', 'Processing', 'Completed'];
    const at = j.Status === 'Holding' ? 0 : Math.max(0, steps.indexOf(j.Status === 'Failed' || j.Status === 'Aborted' ? 'Completed' : j.Status));
    return h('article', { class: `ox-job t-${tone2}` },
      h('div', { class: 'ox-job-head' },
        h('span', { class: `ox-tag k-${j.JobType === 'BatchApex' ? 'batch' : j.JobType === 'Queueable' ? 'queueable' : 'schedulable'}` }, { BatchApex: 'Batch', Queueable: 'Queueable', ScheduledApex: 'Scheduled', Future: '@future' }[j.JobType] || j.JobType),
        h('b', { class: 'ox-job-name' }, j.ApexClass?.Name || 'Job'),
        h('span', { class: `ox-st ${tone2}` }, tone === 'run' ? h('span', { class: 'ox-pulse' }) : null, j.Status === 'Completed' && j.NumberOfErrors ? 'Completed with errors' : label),
        h('span', { class: 'ox-grow' }),
        h('button', { class: 'ox-idchip', title: 'Copy the job Id', onclick: () => copyText(j.Id, 'Job Id copied') }, h('code', {}, j.Id), ' ⧉')),
      h('ol', { class: 'ox-steps', 'aria-label': 'Job stages' }, steps.map((s, i) => h('li', {
        class: i < at || (i === at && TERMINAL.has(j.Status)) ? 'done' : i === at ? 'now' : '',
      }, i === steps.length - 1 && TERMINAL.has(j.Status) ? label : s))),
      j.JobType === 'BatchApex' ? h('div', { class: 'ox-progress' },
        h('div', { class: 'ox-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total, 'aria-valuenow': done },
          h('span', { style: `width:${pct}%` }), j.NumberOfErrors ? h('span', { class: 'err', style: `width:${total ? Math.round((j.NumberOfErrors / total) * 100) : 0}%` }) : null),
        h('span', { class: 'ox-bar-l' }, total ? `${done} / ${total} ${total === 1 ? 'batch' : 'batches'}` : j.Status === 'Preparing' ? 'Counting records…' : '—',
          j.NumberOfErrors ? h('b', { class: 'bad' }, ` · ${j.NumberOfErrors} failed`) : null)) : null,
      j.ExtendedStatus ? h('pre', { class: 'ox-job-err' }, j.ExtendedStatus) : null,
      h('div', { class: 'ox-job-foot' },
        h('span', {}, `Started ${fmtTime(created)}`, ended ? ` · finished ${fmtTime(ended)} · took ${fmtMs(ended - created)}` : ''),
        h('span', { class: 'ox-grow' }),
        logs.length ? h('button', { class: 'ghost small', onclick: () => { S.resTab = 'logs'; drawResults(); } }, `${plural(logs.length, 'log')} →`) : null,
        !TERMINAL.has(j.Status) ? h('button', { class: 'ghost small danger-text', onclick: (e) => abort(e.currentTarget, j.Id, run) }, 'Abort') : null));
  }

  function cronCard(run, c, id) {
    if (!c) return h('div', { class: 'ox-job' }, h('div', { class: 'ox-job-head' }, h('code', {}, id), h('span', { class: 'ox-st wait' }, 'Looking it up…')));
    const gone = c.State === 'DELETED';
    return h('article', { class: `ox-job ox-cron t-${gone ? 'off' : 'ok'}` },
      h('div', { class: 'ox-job-head' },
        h('span', { class: 'ox-tag k-schedulable' }, 'Scheduled'),
        h('b', { class: 'ox-job-name' }, c.CronJobDetail?.Name || 'Schedule'),
        h('span', { class: `ox-st ${gone ? 'off' : 'ok'}` }, gone ? 'Unscheduled' : c.State === 'WAITING' ? 'Waiting' : c.State),
        h('span', { class: 'ox-grow' }),
        h('button', { class: 'ox-idchip', title: 'Copy the CronTrigger Id', onclick: () => copyText(c.Id, 'Id copied') }, h('code', {}, c.Id), ' ⧉')),
      h('dl', { class: 'ox-dl' },
        h('dt', {}, 'When'), h('dd', {}, h('code', {}, c.CronExpression), ` · ${describeCron(c.CronExpression)}`),
        h('dt', {}, 'Next run'), h('dd', {}, gone ? '—' : c.NextFireTime ? sfDate(c.NextFireTime).toLocaleString() : '—'),
        h('dt', {}, 'Runs so far'), h('dd', {}, String(c.TimesTriggered ?? 0))),
      h('div', { class: 'ox-job-foot' },
        h('span', { class: 'ox-grow' }),
        opts.setupUrl?.('/lightning/setup/ScheduledJobs/home') ? h('button', { class: 'ghost small', onclick: () => window.open(opts.setupUrl('/lightning/setup/ScheduledJobs/home'), '_blank', 'noopener') }, 'Scheduled Jobs in Setup ↗') : null,
        !gone ? h('button', { class: 'ghost small danger-text', onclick: (e) => abort(e.currentTarget, c.Id, run) }, 'Unschedule') : null));
  }

  async function abort(btn, id, run) {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      const was = btn.textContent;
      btn.textContent = 'Click again to confirm';
      setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = was; } }, 3000);
      return;
    }
    btn.disabled = true;
    try {
      await backend.abort(id);
      toast('Stopped', 'ok');
    } catch (e) {
      toast(`Couldn’t stop it: ${e.message}`, 'error');
    }
    run.tail = 1;
    poll(run);
  }

  function logsTab(body, run) {
    const rows = [];
    if (run.parsed) {
      const r = run.result;
      rows.push(h('li', { class: 'ox-log' },
        h('span', { class: `ox-dot ${r.success ? 'ok' : 'bad'}` }),
        h('span', { class: 'ox-log-main' }, h('b', {}, 'This run (Anonymous Apex)'), h('small', {}, `${fmtTime(new Date(run.at))} · ${Math.max(1, Math.round(r.log.length / 1024))} KB · ${r.success ? 'Success' : !r.compiled ? 'Compile error' : r.exceptionMessage}`)),
        h('button', { class: 'ghost small', onclick: () => openAnonLog(run) }, 'Open ↗')));
    }
    for (const l of run.logs) {
      rows.push(h('li', { class: 'ox-log' },
        h('span', { class: `ox-dot ${l.Status === 'Success' ? 'ok' : 'bad'}` }),
        h('span', { class: 'ox-log-main' }, h('b', {}, l.Operation || 'Log'), h('small', {}, `${fmtTime(sfDate(l.StartTime))} · ${Math.max(1, Math.round((l.LogLength || 0) / 1024))} KB · ${l.Status}`)),
        h('button', { class: 'ghost small', onclick: (e) => openAsyncLog(e.currentTarget, l) }, 'Open ↗')));
    }
    const traced = S.traceUntil && S.traceUntil > Date.now();
    body.append(h('ul', { class: 'ox-logs' }, rows));
    if (run.jobIds.length && !run.logs.length) {
      body.append(h('div', { class: 'ox-tip' }, h('span', { 'aria-hidden': 'true' }, traced ? '⏳' : '💡'),
        h('span', {}, traced ? 'Job logs appear here as the jobs run.' : 'No job logs: async jobs only write debug logs while you’re traced. '),
        traced ? null : h('button', { class: 'ghost small', onclick: traceMe }, 'Trace me for 1 hour')));
    }
  }
  async function openAsyncLog(btn, l) {
    if (!backend.demo) { opts.openLog?.({ id: l.Id }); return; }
    btn.disabled = true;
    try { opts.openLog?.({ meta: { ...l, local: true }, body: await backend.getLogBody(l.Id) }); } finally { btn.disabled = false; }
  }

  // start (after every helper above is defined)
  buildMain();
  drawSide();
  loadClasses();

  return {
    setActive(on) {
      S.active = on;
      if (on) {
        if (S.traceUntil == null) refreshTrace();
        else drawTrace();
        if (!S.classes && S.scanErr) { S.scanErr = null; loadClasses(); }
      }
    },
  };
}
