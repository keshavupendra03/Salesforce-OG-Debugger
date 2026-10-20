import { parseUnit } from './apex/parser.js';
import { CodeIndex, ROOT_ENTRY_KINDS } from './apex/analyzer.js';
import { getSession } from './session.js';
import { SfApi } from './sf-api.js';
import { loadOrgCode, clearCache } from './code-loader.js';
import { DEMO_UNITS, DEMO_OBJECTS, DEMO_FIELDS } from './demo-data.js';
import { h } from './dom.js';
import { highlight } from './apex/highlight.js';
import { resizable, codeDetails, collapsibleSide } from './layout.js';
import { setupCoffee } from './coffee.js';
import { setupFeedback } from './feedback.js';
import { setupFun } from './fun.js';
import { ApexVersions } from './logs/apex-versions.js';

const $ = (s) => document.querySelector(s);

const state = {
  mode: null, // 'org' | 'demo'
  session: null,
  api: null,
  objects: [],
  fields: [],
  object: null,
  field: null,
  index: null,
  indexPromise: null,
  analysis: null,
  appView: 'flow', // 'flow' | 'logs' | 'data'
  logsView: null,
  dataView: null,
  searchView: null,
  apiView: null,
  execView: null,
  importView: null,
  demoData: null, // one pretend org for Data Export and Data Import
  pick: 'field', // 'field' | 'method' (left panel tab)
  cls: null, // type key
  methodId: null,
  view: 'tree',
  opts: { possible: false, tests: false },
  selectedKey: null,
  codeWhole: false, // code panel: the whole class instead of just the method
  codeShown: null,
};

// ---------- small helpers ----------

const tick = () => new Promise((r) => setTimeout(r, 0));
const plural = (n, word) => `${n} ${n === 1 ? word : /(s|ch)$/.test(word) ? word + 'es' : word + 's'}`;

function setScan(text, stateName, fraction) {
  $('#scan').dataset.state = stateName;
  $('#scan-text').textContent = text;
  $('#scan-bar-fill').style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

function showOverlay(kind, message) {
  const card = $('#overlay-card');
  card.replaceChildren();
  const demoBtn = h('a', { class: 'primary', href: 'app.html?demo=1' }, 'Explore the demo org');
  if (kind === 'landing') {
    card.append(
      h('h2', {}, 'Open Salesforce OG Debugger from a Salesforce tab'),
      h('p', {}, 'Salesforce OG Debugger uses the Salesforce session you already have — no extra login.'),
      h('ol', {},
        h('li', {}, 'Log in to your org in this browser.'),
        h('li', {}, 'With a Salesforce tab active, click the Salesforce OG Debugger icon in the toolbar.')),
      h('div', { class: 'overlay-actions' }, demoBtn),
    );
  } else {
    card.append(
      h('h2', {}, 'Couldn’t connect to Salesforce'),
      h('p', { class: 'err' }, message),
      h('div', { class: 'overlay-actions' },
        h('button', { class: 'ghost', onclick: () => location.reload() }, 'Try again'), demoBtn),
    );
  }
  $('#overlay').hidden = false;
}

// ---------- startup ----------

async function init() {
  const manifest = globalThis.chrome?.runtime?.getManifest?.();
  if (manifest) $('#app-version').textContent = `v${manifest.version}`;
  setupCoffee($('.credits-links'));
  setupFeedback($('.credits-links'));
  setupFun($('.topbar'));
  bindUi();
  setupSplitters();
  renderClasses();
  renderMethods();
  const params = new URLSearchParams(location.search);
  const startView = ['logs', 'data', 'import', 'search', 'api', 'exec'].includes(params.get('view')) ? params.get('view') : null;
  if (params.has('demo')) {
    if (startView) { state.mode = 'demo'; enableViews(); switchView(startView); }
    return startDemo();
  }
  const host = params.get('host');
  if (!host) return showOverlay('landing');
  try {
    await startOrg(host);
    if (startView) switchView(startView);
  } catch (e) {
    setScan('Not connected', 'error');
    showOverlay('error', e.message);
  }
}

function setupSplitters() {
  const layout = $('#view-flow');
  const picker = $('.picker');
  const W = () => layout.clientWidth;
  layout.append(
    resizable({
      handle: h('div', { class: 'cf-left' }), pane: picker, host: layout, cssVar: '--cf-left', edge: 'end',
      min: 200, max: () => W() * 0.4, key: 'ff-split-cf-left', label: 'Resize the picker',
    }),
    resizable({
      handle: h('div', { class: 'cf-right' }), pane: $('#code'), host: layout, cssVar: '--cf-right', edge: 'start',
      min: 300, max: () => Math.min(W() * 0.65, W() - picker.offsetWidth - 300), key: 'ff-split-cf-right', label: 'Resize the source panel',
    }));
  for (const top of document.querySelectorAll('.pick-top')) {
    top.append(resizable({
      handle: h('div'), pane: top, host: picker, cssVar: '--pick-top', axis: 'y', edge: 'end',
      min: 120, max: () => top.parentElement.clientHeight - 140, key: 'ff-split-pick', label: 'Resize the lists',
    }));
  }
  collapsibleSide({ host: layout, pane: picker, key: 'ff-side-flow', label: 'the picker', rail: flowRail });
}

// What the collapsed picker shows: the current Object.Field or Class.method.
function flowRail() {
  const method = state.pick === 'method';
  const m = method && state.methodId ? state.index?.methodsById.get(state.methodId) : null;
  const label = method
    ? m?.label || (state.cls && state.index?.types.get(state.cls)?.display)
    : state.field ? `${state.object}.${state.field.name}` : state.object;
  return [
    h('span', { class: 'side-rail-chip' }, method ? 'Method' : 'Field'),
    h('span', { class: `side-rail-label${label ? '' : ' muted'}`, title: label || '' }, label || (method ? 'Pick a method' : 'Pick a field')),
  ];
}

// ---------- top-level views ----------

async function switchView(view) {
  if (state.appView === view) return;
  state.appView = view;
  for (const b of document.querySelectorAll('.views button')) b.setAttribute('aria-selected', String(b.dataset.appView === view));
  $('#view-flow').hidden = view !== 'flow';
  $('#view-logs').hidden = view !== 'logs';
  $('#view-data').hidden = view !== 'data';
  $('#view-search').hidden = view !== 'search';
  $('#view-api').hidden = view !== 'api';
  $('#view-exec').hidden = view !== 'exec';
  $('#view-import').hidden = view !== 'import';
  $('#rescan').hidden = view !== 'flow' || state.mode !== 'org';
  if (view === 'logs') state.logsView ||= loadLogsView();
  if (view === 'data') state.dataView ||= loadDataView();
  if (view === 'search') state.searchView ||= loadSearchView();
  if (view === 'api') state.apiView ||= loadApiView();
  if (view === 'exec') state.execView ||= loadExecView();
  if (view === 'import') state.importView ||= loadImportView();
  if (state.logsView) (await state.logsView).setActive(state.appView === 'logs');
  if (state.dataView) (await state.dataView).setActive(state.appView === 'data');
  if (state.searchView) (await state.searchView).setActive(state.appView === 'search');
  if (state.apiView) (await state.apiView).setActive(state.appView === 'api');
  if (state.execView) (await state.execView).setActive(state.appView === 'exec');
  if (state.importView) (await state.importView).setActive(state.appView === 'import');
}

async function demoData() {
  state.demoData ||= new (await import('./data/demo-data-backend.js')).DemoDataBackend();
  return state.demoData;
}

async function loadImportView() {
  const { mountImport } = await import('./import/import-ui.js');
  const backend = state.mode === 'demo'
    ? new (await import('./import/demo-import.js')).DemoImportBackend(await demoData())
    : new (await import('./import/import-backend.js')).SfImportBackend(state.api, state.session);
  return mountImport($('#view-import'), backend);
}

async function loadExecView() {
  const { mountExecutor } = await import('./exec/exec-ui.js');
  const demo = state.mode === 'demo';
  const backend = demo
    ? new (await import('./exec/demo-exec.js')).DemoExecBackend()
    : new (await import('./exec/exec-backend.js')).SfExecBackend(state.api, state.session, new (await import('./logs/log-backend.js')).SfLogBackend(state.api));
  return mountExecutor($('#view-exec'), {
    backend,
    // the classes come from the Code Flow scan (cached, only changes fetched)
    getIndex: () => state.indexPromise,
    listObjects: async () => (demo ? DEMO_OBJECTS : state.objects.length ? state.objects : state.api.listObjects()),
    listFields: async (name) => (demo ? DEMO_FIELDS[name] || [] : state.api.listFields(name)),
    setupUrl: (path) => (state.mode === 'org' ? `https://${state.session.apiHost.replace(/\.my\.salesforce\.com$/i, '.lightning.force.com')}${path}` : null),
    // a log from the Executor opens in Debug Logs: an org log by id, or the text of an anonymous run
    openLog: async (log) => {
      await switchView('logs');
      const lv = await state.logsView;
      if (log.id) lv.showLog(log.id);
      else lv.showText(log.meta, log.body);
    },
  });
}

async function loadApiView() {
  const { mountInformant } = await import('./informant/informant-ui.js');
  return mountInformant($('#view-api'), {
    demo: state.mode === 'demo',
    // "Salesforce session" auth and {{$sfInstanceUrl}} use the org this tab is connected to
    getSalesforce: () => (state.session && state.api ? { sessionId: state.session.sessionId, apiHost: state.session.apiHost, version: state.api.version } : null),
  });
}

function enableViews() {
  $('#nav-logs').disabled = false;
  $('#nav-data').disabled = false;
  $('#nav-search').disabled = false;
  $('#nav-api').disabled = false;
  $('#nav-exec').disabled = false;
  $('#nav-import').disabled = false;
}

async function loadSearchView() {
  const { mountSearch } = await import('./search/search-ui.js');
  const sources = state.mode === 'demo'
    ? new (await import('./search/demo-search.js')).DemoSearchSources()
    : new (await import('./search/search-sources.js')).SfSearchSources(state.api, state.session, {
      // Apex comes from the Code Flow scan (already running, cached on disk), so it's never downloaded twice
      getApexUnits: async () => (await state.indexPromise).files.map((f) => f.unit),
    });
  return mountSearch($('#view-search'), sources);
}

async function loadDataView() {
  const { mountData } = await import('./data/data-ui.js');
  const backend = state.mode === 'demo'
    ? await demoData()
    : new (await import('./data/data-backend.js')).SfDataBackend(state.api, state.session);
  return mountData($('#view-data'), backend);
}

async function loadLogsView() {
  const { mountLogs } = await import('./logs/logs-ui.js');
  const backend = state.mode === 'demo'
    ? new (await import('./logs/demo-logs.js')).DemoLogBackend()
    : new (await import('./logs/log-backend.js')).SfLogBackend(state.api);
  return mountLogs($('#view-logs'), backend, {
    getSource: getApexSource,
    rescan: rescanApex,
    setupUrl,
    // the Code Flow scan of the org's Apex, used by Field Trace
    getIndex: () => state.indexPromise,
    listObjects: async () => (state.mode === 'demo' ? DEMO_OBJECTS : state.objects.length ? state.objects : state.api.listObjects()),
    listFields: async (name) => (state.mode === 'demo' ? DEMO_FIELDS[name] || [] : state.api.listFields(name)),
  });
}

// ---------- Apex source for the log viewer ----------

const sourceCache = new Map();
const apexVersions = new ApexVersions();

// src: { kind: 'class' | 'trigger', id?, name } as found in a debug log.
// at: when the log ran (ms). A class changed since then comes back in the version that log ran, when known.
async function getApexSource(src, { at } = {}) {
  const key = `${src.kind}:${src.id?.slice(0, 15) || src.name.toLowerCase()}`;
  if (!sourceCache.has(key)) {
    sourceCache.set(key, loadApexSource(src).catch((e) => { sourceCache.delete(key); throw e; }));
  }
  const unit = await sourceCache.get(key);
  apexVersions.note(unit);
  return apexVersions.pick(key, unit, at);
}

// Debug Logs → Rescan Apex: fetch what changed (the scan cache only re-downloads classes whose
// LastModifiedDate moved), keep the old bodies for older logs, and say what changed.
async function rescanApex() {
  if (state.mode === 'demo') {
    await new Promise((r) => setTimeout(r, 500));
    return { changed: [], added: [], removed: [] };
  }
  try { await state.indexPromise; } catch { /* a failed scan is retried below */ }
  const before = new Map((state.index?.files || []).map(({ unit }) => [unit.id, unit]));
  for (const { unit } of state.index?.files || []) apexVersions.note(unit);
  // classes opened one by one (before the scan finished) count as "before" too
  for (const p of sourceCache.values()) {
    const u = await p.catch(() => null);
    if (u?.id && !before.has(u.id)) before.set(u.id, u);
    apexVersions.note(u);
  }
  state.indexPromise = scanOrg();
  const index = await state.indexPromise;
  sourceCache.clear();
  const now = new Set();
  const changed = [];
  const added = [];
  for (const { unit } of index.files) {
    now.add(unit.id);
    const old = before.get(unit.id);
    if (!old) { if (before.size) added.push(unit.name); } else if (old.lastModified !== unit.lastModified || old.body !== unit.body) changed.push(unit.name);
    apexVersions.note(unit);
  }
  const removed = [...before.values()].filter((u) => !now.has(u.id) && index.files.length).map((u) => u.name);
  return { changed, added, removed };
}

async function loadApexSource({ kind, id, name }) {
  const lname = name?.toLowerCase();
  if (state.mode === 'demo') return DEMO_UNITS.find((u) => u.kind === kind && u.name.toLowerCase() === lname) || null;
  const id15 = id?.slice(0, 15);
  const scanned = state.index?.files.find(({ unit: u }) => u.kind === kind
    && ((id15 && u.id.slice(0, 15) === id15) || (!id15 && u.name.toLowerCase() === lname)));
  if (scanned) return scanned.unit;
  let where;
  if (id && /^[a-zA-Z0-9]{15,18}$/.test(id)) where = `Id = '${id}'`;
  else if (name && /^\w+$/.test(name)) where = `Name = '${name}' AND NamespacePrefix = null`;
  else return null;
  const sobject = kind === 'trigger' ? 'ApexTrigger' : 'ApexClass';
  const [r] = await state.api.query(`SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ${sobject} WHERE ${where}`, { tooling: true });
  if (!r) return null;
  return { id: r.Id, name: r.Name, kind, body: r.Body || '', lastModified: r.LastModifiedDate, managed: !!r.NamespacePrefix || r.Body === '(hidden)' };
}

async function startDemo() {
  state.mode = 'demo';
  enableViews();
  $('#org').textContent = 'Demo org · sample Apex';
  state.objects = DEMO_OBJECTS;
  renderObjects();
  setScan('Parsing sample code…', 'busy', 0.5);
  state.indexPromise = buildIndex(DEMO_UNITS);
  state.index = await state.indexPromise;
  scanDone();
  await selectObject('Account');
  await selectField('Industry');
}

async function startOrg(host) {
  state.mode = 'org';
  setScan('Connecting…', 'busy', 0.05);
  state.session = await getSession(host);
  state.api = new SfApi(state.session);
  await state.api.init();
  enableViews();
  $('#org').textContent = state.session.apiHost;
  $('#org').title = `Org ${state.session.orgId} · API ${state.api.version}`;
  $('#rescan').hidden = state.appView !== 'flow';
  $('#clear-cache').hidden = false;
  state.indexPromise = scanOrg();
  state.objects = await state.api.listObjects();
  renderObjects();
  $('#obj-search').focus();
}

async function scanOrg() {
  try {
    const t0 = performance.now();
    const { units, downloaded } = await loadOrgCode(state.api, state.session.orgId, (text, f) => setScan(text, 'busy', f));
    const index = await buildIndex(units);
    state.index = index;
    scanDone(downloaded, performance.now() - t0);
    if (state.field) runAnalysis();
    else if (state.pick === 'method') rerender(true);
    return index;
  } catch (e) {
    setScan(`Scan failed: ${e.message}`, 'error');
    throw e;
  }
}

async function buildIndex(units) {
  const files = [];
  for (let i = 0; i < units.length; i++) {
    files.push(parseUnit(units[i]));
    if (i % 40 === 39) {
      setScan(`Parsing code… ${i + 1} / ${units.length}`, 'busy', (i + 1) / units.length);
      await tick();
    }
  }
  setScan('Building call graph…', 'busy', 1);
  await tick();
  return new CodeIndex(files);
}

function scanDone(downloaded, ms) {
  const s = state.index.stats;
  let text = `${plural(s.classes, 'class')} · ${plural(s.triggers, 'trigger')}`;
  if (state.mode === 'demo') text += ' · demo';
  else if (downloaded != null) text += downloaded ? ` · ${downloaded} fetched` : ' · from cache';
  setScan(text, 'ready', 1);
  $('#scan').title = `${s.methods} methods, ${s.edges} call edges${ms ? `, ${(ms / 1000).toFixed(1)}s` : ''}`;
  // a rescan rebuilds the index, so drop selections that no longer exist
  if (state.cls && !state.index.types.has(state.cls)) state.cls = null;
  if (state.methodId && !state.index.methodsById.has(state.methodId)) state.methodId = null;
  renderClasses();
  renderMethods();
}

// ---------- pickers ----------

function bindUi() {
  $('#obj-search').addEventListener('input', renderObjects);
  $('#field-search').addEventListener('input', renderFields);
  $('#class-search').addEventListener('input', renderClasses);
  $('#method-search').addEventListener('input', renderMethods);
  $('#opt-possible').addEventListener('change', (e) => { state.opts.possible = e.target.checked; rerender(); });
  $('#opt-tests').addEventListener('change', (e) => { state.opts.tests = e.target.checked; renderClasses(); rerender(); });
  for (const b of document.querySelectorAll('.mode-tabs button')) {
    b.addEventListener('click', () => switchPick(b.dataset.pick));
  }
  for (const b of document.querySelectorAll('.views button')) {
    b.addEventListener('click', () => switchView(b.dataset.appView));
  }
  $('#rescan').addEventListener('click', () => { state.indexPromise = scanOrg(); });
  $('#clear-cache').addEventListener('click', async () => {
    await clearCache(state.session.orgId);
    state.indexPromise = scanOrg();
  });
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => { state.view = b.dataset.view; rerender(); });
  }
  $('#expand-all').addEventListener('click', () => expandAll(800));
  $('#collapse-all').addEventListener('click', () => {
    for (const ul of document.querySelectorAll('.tree li ul.callers')) ul.parentElement.querySelector('.caret')?.click();
  });
}

function renderList(listEl, items, selected, onPick, empty) {
  listEl.replaceChildren();
  if (!items.length) { listEl.append(h('li', { class: 'l-note' }, empty)); return; }
  const shown = items.slice(0, 300);
  for (const it of shown) {
    listEl.append(h('li', {
      role: 'option',
      'aria-selected': String(it.name === selected),
      title: `${it.label} (${it.api ?? it.name})`,
      onclick: () => onPick(it.name),
    }, h('span', { class: 'l-label' }, it.label), h('span', { class: 'l-api' }, it.api ?? it.name)));
  }
  if (items.length > shown.length) listEl.append(h('li', { class: 'l-note' }, `${items.length - shown.length} more — refine your search`));
}

const matches = (it, q) => !q || it.label.toLowerCase().includes(q) || (it.api ?? it.name).toLowerCase().includes(q);

function switchPick(pick) {
  if (state.pick === pick) return;
  state.pick = pick;
  for (const b of document.querySelectorAll('.mode-tabs button')) b.setAttribute('aria-selected', String(b.dataset.pick === pick));
  $('#panel-field').hidden = pick !== 'field';
  $('#panel-method').hidden = pick !== 'method';
  if (pick === 'method') (state.cls ? $('#method-search') : $('#class-search')).focus();
  else (state.object ? $('#field-search') : $('#obj-search')).focus();
  rerender(true);
}

// ---------- class / method pickers ----------

const isCallable = (m) => m.kind === 'method' || m.kind === 'constructor';

function renderClasses() {
  const listEl = $('#class-list');
  if (!state.index) { listEl.replaceChildren(h('li', { class: 'l-note' }, 'Waiting for the code scan to finish…')); return; }
  const q = $('#class-search').value.trim().toLowerCase();
  const items = [...state.index.types.values()]
    .filter((t) => t.kind !== 'trigger' && (state.opts.tests || !t.isTest) && t.methods.some(isCallable))
    .map((t) => ({
      name: t.key,
      label: t.display,
      api: t.kind === 'interface' ? 'interface' : plural(t.methods.filter(isCallable).length, 'method'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  renderList(listEl, items.filter((it) => matches(it, q)), state.cls, selectClass, 'No matching classes');
}

function paramSig(m) {
  if (m.paramOpen < 0) return '';
  const groups = [[]];
  let depth = 0;
  for (const t of m.file.toks.slice(m.paramOpen + 1, m.paramClose)) {
    if (t.v === '<') depth++;
    else if (t.v === '>') depth--;
    if (t.v === ',' && depth === 0) groups.push([]);
    else if (t.type !== 'annot' && t.lv !== 'final') groups[groups.length - 1].push(t);
  }
  return groups.filter((g) => g.length > 1)
    .map((g) => g.slice(0, -1).map((t, i) => (i && t.type === 'id' && g[i - 1].type === 'id' ? ' ' : '') + t.v + (t.v === ',' ? ' ' : '')).join(''))
    .join(', ');
}

function renderMethods() {
  const listEl = $('#method-list');
  const type = state.cls && state.index?.types.get(state.cls);
  if (!type) {
    $('#method-of').textContent = '';
    $('#method-search').disabled = true;
    listEl.replaceChildren(h('li', { class: 'l-note' }, 'Pick a class first'));
    return;
  }
  const q = $('#method-search').value.trim().toLowerCase();
  const items = type.methods.filter(isCallable).map((m) => ({
    name: m.id,
    label: `${m.kind === 'constructor' ? type.name : m.name}(${paramSig(m)})`,
    api: `${m.entry && m.entry.kind !== 'test' ? m.entry.label + ' · ' : ''}L${m.startLine}`,
  })).sort((a, b) => a.label.localeCompare(b.label));
  renderList(listEl, items.filter((it) => matches(it, q)), state.methodId, selectMethod, 'No matching methods');
}

function selectClass(key) {
  state.cls = key;
  renderClasses();
  $('#method-of').textContent = state.index.types.get(key).display;
  $('#method-search').disabled = false;
  $('#method-search').value = '';
  renderMethods();
  $('#method-search').focus();
}

function selectMethod(id) {
  state.methodId = id;
  state.selectedKey = null;
  renderMethods();
  rerender(true);
}

function renderObjects() {
  const q = $('#obj-search').value.trim().toLowerCase();
  renderList($('#obj-list'), state.objects.filter((o) => matches(o, q)), state.object, selectObject, 'No matching objects');
}

function renderFields() {
  const q = $('#field-search').value.trim().toLowerCase();
  renderList($('#field-list'), state.fields.filter((f) => matches(f, q)), state.field?.name, selectField, state.object ? 'No matching fields' : 'Pick an object first');
}

async function selectObject(name) {
  state.object = name;
  state.field = null;
  renderObjects();
  $('#field-of').textContent = name;
  $('#field-search').disabled = false;
  $('#field-search').value = '';
  $('#field-list').replaceChildren(h('li', { class: 'l-note' }, 'Loading fields…'));
  try {
    state.fields = state.mode === 'demo' ? DEMO_FIELDS[name] || [] : await state.api.listFields(name);
  } catch (e) {
    state.fields = [];
    $('#field-list').replaceChildren(h('li', { class: 'l-note' }, e.message));
    return;
  }
  if (state.object !== name) return;
  renderFields();
  $('#field-search').focus();
}

async function selectField(name) {
  state.field = state.fields.find((f) => f.name === name);
  state.selectedKey = null;
  renderFields();
  if (!state.index) {
    $('#flow-head').hidden = true;
    $('#flow-body').replaceChildren(h('div', { class: 'loading' }, 'Waiting for the code scan to finish…'));
    try { await state.indexPromise; } catch { return; }
    return; // scanOrg() re-runs the analysis when done
  }
  runAnalysis();
}

// ---------- analysis ----------

function runAnalysis() {
  if (!state.index || !state.field) return;
  state.analysis = state.index.analyzeField(state.object, state.field.name);
  rerender(true);
}

function rootsFor(analysis) {
  const roots = [];
  let hiddenPossible = 0;
  for (const { method, refs } of analysis.values()) {
    if (method.isTest && !state.opts.tests) continue;
    const sure = refs.filter((r) => r.confidence === 'sure');
    if (!sure.length && !state.opts.possible) { hiddenPossible++; continue; }
    const used = state.opts.possible ? refs : sure;
    roots.push({
      method,
      refs: used,
      write: used.some((r) => r.access === 'write'),
      read: used.some((r) => r.access === 'read'),
      possibleOnly: !sure.length,
    });
  }
  roots.sort((a, b) => (b.write - a.write) || (a.possibleOnly - b.possibleOnly) || a.method.label.localeCompare(b.method.label));
  return { roots, hiddenPossible };
}

function showFlowEmpty() {
  $('#flow-head').hidden = true;
  const [title, sub] = state.pick === 'method'
    ? ['Pick a class, then a method', 'You’ll see every Apex code path that calls it, back to its entry points.']
    : ['Pick an object, then a field', 'You’ll see every Apex method that reads or writes it, and the code paths that lead there.'];
  $('#flow-body').replaceChildren(h('div', { class: 'empty' },
    h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
    h('p', { class: 'empty-title' }, title),
    h('p', { class: 'empty-sub' }, sub)));
  showCodeEmpty();
}

function syncFlowTools() {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  $('#expand-all').hidden = $('#collapse-all').hidden = state.view !== 'tree';
}

function rerender(autoExpand = false) {
  if (state.pick === 'method') return renderMethodFlow(autoExpand);
  if (!state.analysis) return showFlowEmpty();
  const { roots, hiddenPossible } = rootsFor(state.analysis);
  const { paths, truncated } = state.index.entryPaths(roots.map((r) => r.method.id), state.opts);
  renderHead(roots, paths, hiddenPossible);
  const body = $('#flow-body');
  body.replaceChildren();
  if (!roots.length) {
    body.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'No Apex references found'),
      h('p', { class: 'empty-sub' }, hiddenPossible
        ? `${plural(hiddenPossible, 'possible match')} hidden — turn on “Show possible matches” to review them.`
        : 'This field isn’t referenced by unmanaged Apex. It may still be used by Flows, formulas, validation rules or LWC.')));
    showCodeEmpty();
    return;
  }
  if (state.view === 'tree') {
    body.append(renderTree(roots));
    expandAll(60); // small trees open fully; big ones show the first levels
  } else {
    body.append(renderPaths(paths, new Map(roots.map((r) => [r.method.id, r])), truncated));
  }
  if (autoExpand) selectNode(`ref:${roots[0].method.id}`, roots[0].method.id, { refs: roots[0].refs });
  else restoreSelection();
}

function renderMethodFlow(autoExpand) {
  const m = state.methodId && state.index?.methodsById.get(state.methodId);
  if (!m) return showFlowEmpty();
  const { paths, truncated } = state.index.entryPaths([m.id], state.opts);
  renderMethodHead(m, paths);
  const body = $('#flow-body');
  body.replaceChildren();
  if (state.view === 'tree') {
    body.append(h('ul', { class: 'tree' }, methodNode(m.id, [m.id], { self: true })));
    expandAll(60);
  } else {
    body.append(renderPaths(paths, null, truncated));
  }
  if (autoExpand) selectNode(`self:${m.id}`, m.id, { self: true });
  else restoreSelection();
}

function renderMethodHead(m, paths) {
  $('#flow-head').hidden = false;
  $('#flow-title').textContent = m.label;
  $('#flow-type').textContent = [m.isStatic ? 'static' : null, m.kind].filter(Boolean).join(' ');
  const callers = state.index.callers(m.id, state.opts);
  const entries = new Set(paths.filter((p) => p.end === 'entry').map((p) => p.ids[0]));
  const chips = $('#chips');
  chips.replaceChildren(
    h('span', { class: 'chip read' }, h('b', {}, callers.length), callers.length === 1 ? 'direct caller' : 'direct callers'),
    h('span', { class: 'chip entries' }, h('b', {}, entries.size), entries.size === 1 ? 'entry point' : 'entry points'),
    h('span', { class: 'chip entries' }, h('b', {}, paths.length), paths.length === 1 ? 'path' : 'paths'),
  );
  if (!state.opts.possible) {
    const hidden = state.index.callers(m.id, { ...state.opts, possible: true }).length - callers.length;
    if (hidden > 0) {
      chips.append(h('button', {
        class: 'chip',
        title: 'Callers matched only by method name, because the receiver type could not be determined',
        onclick: () => { $('#opt-possible').checked = true; state.opts.possible = true; rerender(); },
      }, `+ ${plural(hidden, 'possible caller')}`));
    }
  }
  syncFlowTools();
}

function renderHead(roots, paths, hiddenPossible) {
  $('#flow-head').hidden = false;
  $('#flow-title').textContent = `${state.object}.${state.field.name}`;
  $('#flow-type').textContent = state.field.type;
  const writers = roots.filter((r) => r.write).length;
  const readers = roots.filter((r) => r.read && !r.write).length;
  const entries = new Set(paths.filter((p) => p.end === 'entry').map((p) => p.ids[0]));
  const chips = $('#chips');
  chips.replaceChildren(
    h('span', { class: 'chip write' }, h('b', {}, writers), writers === 1 ? 'method writes' : 'methods write'),
    h('span', { class: 'chip read' }, h('b', {}, readers), readers === 1 ? 'method only reads' : 'methods only read'),
    h('span', { class: 'chip entries' }, h('b', {}, entries.size), entries.size === 1 ? 'entry point' : 'entry points'),
  );
  if (hiddenPossible) {
    chips.append(h('button', {
      class: 'chip',
      title: 'References where the record type could not be determined (SObject, dynamic Apex, unknown receivers)',
      onclick: () => { $('#opt-possible').checked = true; state.opts.possible = true; rerender(); },
    }, `+ ${plural(hiddenPossible, 'possible match')}`));
  }
  syncFlowTools();
}

// ---------- badges ----------

function entryBadge(entry) {
  if (!entry || entry.kind === 'test' && !state.opts.tests) return null;
  return h('span', { class: 'entry', style: `--e: var(--e-${entry.kind})`, title: entry.detail || entry.label }, entry.label);
}

function accessBadges(refs) {
  const out = [];
  if (refs.some((r) => r.access === 'write')) out.push(h('span', { class: 'badge write' }, 'writes'));
  if (refs.some((r) => r.access === 'read')) out.push(h('span', { class: 'badge read' }, 'reads'));
  if (refs.some((r) => r.how === 'soql' || r.how === 'dynamic-soql')) out.push(h('span', { class: 'badge soql' }, 'SOQL'));
  if (refs.every((r) => r.confidence === 'possible')) out.push(h('span', { class: 'badge possible', title: 'The record type could not be confirmed' }, 'possible'));
  return out;
}

const KIND_LABEL = { dispatch: 'virtual', async: 'async', guess: 'name match', new: 'constructor' };
const ENTRY_ORDER = ['trigger', 'lwc', 'flow', 'rest', 'soap', 'vf', 'batch', 'schedule', 'queueable'];
const entryRank = (m) => { const i = ENTRY_ORDER.indexOf(m.entry?.kind); return i < 0 ? 99 : i; };

// ---------- tree view ----------

function renderTree(roots) {
  const fieldCard = h('div', { class: 'card root-card' }, `${state.object}.${state.field.name}`);
  const list = h('ul', {});
  for (const r of roots) list.append(methodNode(r.method.id, [r.method.id], { refs: r.refs }));
  return h('ul', { class: 'tree' },
    h('li', {}, fieldCard, h('div', { class: 'via-caption' }, 'used in'), list));
}

function methodNode(id, ancestry, info) {
  const m = state.index.methodsById.get(id);
  const callers = state.index.callers(id, state.opts);
  const key = info.refs ? `ref:${id}` : info.self ? `self:${id}` : `call:${id}<${info.childId}@${ancestry.length}:${ancestry.join('/')}`;
  const li = h('li', { 'data-id': id });
  const caret = h('button', {
    class: `caret${callers.length ? '' : ' none'}`,
    'aria-expanded': 'false',
    'aria-label': 'Show callers',
    tabindex: callers.length ? '0' : '-1',
  }, '▸');

  const meta = [];
  if (info.via) {
    const kinds = [...info.via.kinds].map((k) => KIND_LABEL[k]).filter(Boolean);
    meta.push(h('span', { class: 'meta' }, `calls at line ${[...new Set(info.via.lines)].join(', ')}`));
    for (const k of kinds) meta.push(h('span', { class: 'badge kind' }, k));
  }
  if (!callers.length && !(m.entry && ROOT_ENTRY_KINDS.has(m.entry.kind))) {
    meta.push(h('span', { class: 'entry orphan', title: 'Nothing in unmanaged Apex calls this. It may be invoked from a Flow, Visualforce page, anonymous Apex or a managed package.' }, 'no Apex callers'));
  } else if (callers.length) {
    meta.push(h('span', { class: 'meta' }, plural(callers.length, 'caller')));
  }

  const isPossible = info.refs ? info.refs.every((r) => r.confidence === 'possible')
    : !info.self && [...(info.via?.kinds || [])].every((k) => k === 'guess');
  const card = h('div', { class: `card${isPossible ? ' possible' : ''}${info.self ? ' target' : ''}`, 'data-key': key },
    caret,
    h('span', { class: 'name' }, m.label),
    info.refs ? accessBadges(info.refs) : null,
    entryBadge(m.entry),
    meta);
  card.addEventListener('click', (e) => {
    if (e.target === caret) return;
    selectNode(key, id, info);
  });
  caret.addEventListener('click', () => toggle(li, caret, id, ancestry, callers));
  li.append(card);
  li._expand = () => { if (caret.getAttribute('aria-expanded') === 'false' && callers.length) toggle(li, caret, id, ancestry, callers); };
  return li;
}

function toggle(li, caret, id, ancestry, callers) {
  const open = caret.getAttribute('aria-expanded') === 'true';
  if (open) {
    li.querySelector(':scope > ul.callers')?.remove();
    li.querySelector(':scope > .via-caption')?.remove();
    caret.setAttribute('aria-expanded', 'false');
    return;
  }
  const ul = h('ul', { class: 'callers' });
  for (const c of callers) {
    if (ancestry.includes(c.from)) {
      const m = state.index.methodsById.get(c.from);
      ul.append(h('li', {}, h('div', { class: 'card possible' },
        h('span', { class: 'caret none' }, '▸'), h('span', { class: 'name' }, m.label), h('span', { class: 'recursion' }, '↻ recursive call'))));
      continue;
    }
    ul.append(methodNode(c.from, [...ancestry, c.from], { via: c, childId: id }));
  }
  li.append(h('div', { class: 'via-caption' }, 'called by'), ul);
  caret.setAttribute('aria-expanded', 'true');
}

function expandAll(limit) {
  let budget = limit;
  let frontier = [...document.querySelectorAll('.tree li')];
  while (frontier.length && budget > 0) {
    const next = [];
    for (const li of frontier) {
      if (!li._expand || budget <= 0) continue;
      const before = li.querySelectorAll(':scope > ul.callers > li').length;
      li._expand();
      const kids = [...li.querySelectorAll(':scope > ul.callers > li')];
      budget -= kids.length - before;
      next.push(...kids);
    }
    frontier = next;
  }
}

// ---------- paths view ----------

// rootInfo: Map<methodId, { refs }> in field mode, null when the target is a method.
function renderPaths(paths, rootInfo, truncated) {
  const wrap = h('div', { class: 'paths' });
  const ordered = orderPaths(paths);
  wrap.append(h('div', { class: 'paths-tools' },
    h('span', {}, `${ordered.length} path${ordered.length === 1 ? '' : 's'}${truncated ? ' (the first 400)' : ''}`),
    h('button', {
      class: 'ghost small path-copy-all', title: 'Copy every path as plain text, ready to paste into Teams, an email or ChatGPT',
      onclick: (e) => copyPaths(e.currentTarget, allPathsText(ordered, rootInfo, truncated), 'Copied all paths'),
    }, h('span', { 'aria-hidden': 'true' }, '⧉'), ' Copy all paths')));
  let group = null;
  ordered.forEach((p, n) => {
    if (p.end !== group) {
      group = p.end;
      wrap.append(h('div', { class: 'group-title' }, `${PATH_GROUPS[group]} · ${ordered.filter((x) => x.end === group).length}`));
    }
    const row = h('div', { class: 'path' });
    const first = state.index.methodsById.get(p.ids[0]);
    row.append(p.end === 'entry' ? entryBadge(first.entry) : h('span', { class: 'entry orphan' }, p.end === 'orphan' ? 'unknown entry' : '…'));
    p.ids.forEach((id, i) => {
      const m = state.index.methodsById.get(id);
      const last = i === p.ids.length - 1;
      let info, key;
      if (!last) { info = { via: viaFor(id, p.ids[i + 1]), childId: p.ids[i + 1] }; key = `path:${id}>${p.ids[i + 1]}`; }
      else if (rootInfo) { info = { refs: rootInfo.get(id).refs }; key = `ref:${id}`; }
      else { info = { self: true }; key = `self:${id}`; }
      row.append(h('button', { class: 'step-chip', 'data-key': key, onclick: () => selectNode(key, id, info) }, m.label));
      if (!last || rootInfo) row.append(h('span', { class: 'arrow' }, '→'));
    });
    if (rootInfo) {
      const r = rootInfo.get(p.ids[p.ids.length - 1]);
      row.append(...accessBadges(r.refs), h('span', { class: 'field-end' }, state.field.name));
    }
    row.append(h('button', {
      class: 'path-copy', title: 'Copy this path as plain text', 'aria-label': `Copy path ${n + 1}`,
      onclick: (e) => copyPaths(e.currentTarget, [pathsHeading(1), '', ...pathText(p, n, ordered.length, rootInfo), '', COPY_FOOTER].join('\n'), 'Copied'),
    }, '⧉'));
    wrap.append(row);
  });
  if (truncated) wrap.append(h('p', { class: 'paths-note' }, 'Showing the first 400 paths. Use the call tree to explore the rest.'));
  return wrap;
}

// ---------- entry paths as text (to share in Teams, an email, ChatGPT…) ----------

const PATH_GROUPS = {
  entry: 'From an entry point',
  orphan: 'No Apex caller found (Flow, Visualforce, anonymous Apex or managed code?)',
  depth: 'Stopped at max depth',
};
const COPY_FOOTER = '(Copied from Salesforce OG Debugger · Code Flow)';

// the order they're shown in: entry paths first, by entry kind, then name, then length
function orderPaths(paths) {
  const M = (p) => state.index.methodsById.get(p.ids[0]);
  return Object.keys(PATH_GROUPS).flatMap((end) => paths.filter((p) => p.end === end)
    .sort((a, b) => entryRank(M(a)) - entryRank(M(b)) || M(a).label.localeCompare(M(b).label) || a.ids.length - b.ids.length));
}

// "AccountService.normalizeIndustry(List<Account> accounts)"
function signatureOf(m) {
  if (m.kind === 'trigger') return m.label;
  const name = m.kind === 'constructor' ? `new ${m.type.display}` : `${m.type.display}.${m.name}`;
  return `${name}(${paramSig(m)})`;
}
const whereOf = (m) => `${m.file.unit.name}.${m.file.unit.kind === 'trigger' ? 'trigger' : 'cls'}, line ${m.startLine}`;
const lineList = (lines) => {
  const u = [...new Set(lines)].sort((a, b) => a - b);
  return u.length ? `line${u.length === 1 ? '' : 's'} ${u.join(', ')}` : 'an unknown line';
};

function pathsHeading(count) {
  const target = state.pick === 'method' && state.methodId
    ? `Who calls ${signatureOf(state.index.methodsById.get(state.methodId))}`
    : `How Apex reaches ${state.object}.${state.field?.name}`;
  const org = state.mode === 'demo' ? 'demo org' : state.session?.apiHost;
  return `${target}\n${count === 1 ? 'One Apex code path' : `${count} Apex code paths`}, from the entry point down${org ? ` · ${org}` : ''}`;
}

// one path: numbered steps, where each step calls the next, and what the last step does
function pathText(p, n, total, rootInfo) {
  const first = state.index.methodsById.get(p.ids[0]);
  const e = first.entry;
  const start = p.end === 'entry' ? `${e?.label || 'Entry point'}${e?.detail && e.detail !== e.label ? ` (${e.detail})` : ''}`
    : p.end === 'orphan' ? 'No Apex caller found: may run from a Flow, Visualforce page, anonymous Apex or a managed package'
      : 'Stopped at max depth: there are more callers above this';
  const out = [`Path ${n + 1}${total > 1 ? ` of ${total}` : ''} · ${start}`];
  p.ids.forEach((id, i) => {
    const m = state.index.methodsById.get(id);
    const last = i === p.ids.length - 1;
    const tag = i === 0 && p.end === 'entry' && e ? `  [${e.label}]` : '';
    out.push(`  ${i + 1}. ${signatureOf(m)}${tag}`);
    out.push(`       ${whereOf(m)}`);
    if (!last) {
      const via = viaFor(id, p.ids[i + 1]);
      const kinds = [...(via.kinds || [])].map((k) => KIND_LABEL[k]).filter(Boolean);
      out.push(`       ↓ calls the next step at ${lineList(via.lines)}${kinds.length ? ` (${kinds.join(', ')})` : ''}`);
    } else if (rootInfo) {
      const refs = rootInfo.get(id).refs;
      for (const access of ['write', 'read']) {
        const rs = refs.filter((r) => r.access === access);
        if (!rs.length) continue;
        const how = [...new Set(rs.map((r) => HOW_LABEL[r.how] || r.how))].join(', ');
        const possible = rs.every((r) => r.confidence === 'possible') ? ' (possible: the record type couldn’t be confirmed)' : '';
        out.push(`       ★ ${access === 'write' ? 'WRITES' : 'READS'} ${state.object}.${state.field.name} at ${lineList(rs.map((r) => r.line))} (${how})${possible}`);
      }
    } else {
      out.push('       ★ the method you picked');
    }
  });
  return out;
}

function allPathsText(ordered, rootInfo, truncated) {
  const lines = [pathsHeading(ordered.length)];
  let group = null;
  ordered.forEach((p, n) => {
    if (p.end !== group) {
      group = p.end;
      lines.push('', `=== ${PATH_GROUPS[group]} (${ordered.filter((x) => x.end === group).length}) ===`);
    }
    lines.push('', ...pathText(p, n, ordered.length, rootInfo));
  });
  if (truncated) lines.push('', 'Only the first 400 paths are listed.');
  lines.push('', COPY_FOOTER);
  return lines.join('\n');
}

async function copyPaths(btn, text, done) {
  btn.lastCopied = text; // (tests read it back)
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const was = btn.innerHTML;
  btn.classList.add('copied');
  btn.textContent = btn.classList.contains('path-copy') ? '✓' : `✓ ${done}`;
  setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = was; }, 1400);
}

function viaFor(fromId, toId) {
  return state.index.callers(toId, state.opts).find((c) => c.from === fromId) || { kinds: new Set(), lines: [] };
}

// ---------- code view ----------

function selectNode(key, id, info) {
  state.selectedKey = key;
  state.selectedInfo = { id, info };
  for (const el of document.querySelectorAll('.card.selected, .step-chip.selected')) el.classList.remove('selected');
  for (const el of document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) el.classList.add('selected');
  showCode(id, info);
}

function restoreSelection() {
  if (!state.selectedKey) return showCodeEmpty();
  for (const el of document.querySelectorAll(`[data-key="${CSS.escape(state.selectedKey)}"]`)) el.classList.add('selected');
  showCode(state.selectedInfo.id, state.selectedInfo.info);
}

function showCodeEmpty() {
  state.codeShown = null;
  $('#code').replaceChildren(h('div', { class: 'code-empty' }, 'Select a node to see its source'));
}

function setupUrl(unit) {
  if (state.mode !== 'org') return null;
  const page = unit.kind === 'trigger' ? 'ApexTriggers' : 'ApexClasses';
  const host = state.session.apiHost.replace(/\.my\.salesforce\.com$/i, '.lightning.force.com');
  return `https://${host}/lightning/setup/${page}/page?address=${encodeURIComponent('/' + unit.id)}`;
}

const HOW_LABEL = {
  soql: 'SOQL', field: 'field access', schema: 'schema reference', dynamic: 'dynamic get/put',
  'dynamic-soql': 'dynamic SOQL', constructor: 'constructor', string: 'string literal',
};

// What a node highlights in its source: the lines, the exact field tokens, and the Details entries.
function codeMarks(m, info) {
  const hlLines = new Set();
  const hlCols = new Map(); // line -> columns of the exact field tokens
  let hlClass = 'hl-ref';
  const items = []; // { ln, parts: () => [nodes] }
  if (info.refs) {
    for (const r of info.refs) {
      hlLines.add(r.line);
      if (!hlCols.has(r.line)) hlCols.set(r.line, new Set());
      hlCols.get(r.line).add(r.col);
      items.push({
        ln: r.line,
        parts: () => [h('span', { class: `badge ${r.access}` }, r.access), h('span', {}, HOW_LABEL[r.how] || r.how),
          r.confidence === 'possible' ? h('span', { class: 'badge possible' }, 'possible') : null],
      });
    }
  } else if (info.via) {
    hlClass = 'hl-call';
    const callee = state.index.methodsById.get(info.childId);
    for (const ln of new Set(info.via.lines)) {
      hlLines.add(ln);
      items.push({ ln, parts: () => [h('span', {}, `calls ${callee.label}`)] });
    }
  } else if (info.self) {
    hlClass = 'hl-call';
    const ln = m.file.toks[m.nameTok]?.line ?? m.startLine;
    hlLines.add(ln);
    items.push({ ln, parts: () => [h('span', {}, 'declaration')] });
  }
  return { hlLines, hlCols, hlClass, items };
}

function refsList(items, onPick) {
  return h('ul', { class: 'code-refs' }, items.map((it) => h('li', { onclick: () => onPick(it.ln) },
    h('span', { class: 'ln' }, `L${it.ln}`), ...it.parts())));
}

// the source rows for a line range; in the whole class, the selected method's lines are marked
function sourcePre(lines, range, marks, method) {
  const pre = h('pre', { class: 'src' });
  let inBlock = false;
  for (let n = 1; n < range[0]; n++) inBlock = highlight(lines[n - 1] ?? '', inBlock).inBlock;
  for (let n = range[0]; n <= range[1]; n++) {
    const { html, inBlock: ib } = highlight(lines[n - 1] ?? '', inBlock, marks.hlCols.get(n));
    inBlock = ib;
    const txt = h('span', { class: 'txt' });
    txt.innerHTML = html || ' ';
    const inMethod = method && n >= method[0] && n <= method[1];
    pre.append(h('div', { class: `row${marks.hlLines.has(n) ? ' ' + marks.hlClass : ''}${inMethod ? ' in-method' : ''}`, 'data-line': n },
      h('span', { class: 'gutter' }, n), txt));
  }
  return pre;
}

// what the code panel can show of a method: just it, or its whole class (a trigger is always whole)
function codeScope(m) {
  const unit = m.file.unit;
  const lines = unit.body.split('\n');
  const canWhole = m.kind !== 'trigger' && (m.startLine > 1 || m.endLine < lines.length);
  const whole = canWhole && state.codeWhole;
  const method = [m.startLine, Math.min(m.endLine, lines.length)];
  const ext = unit.kind === 'trigger' ? 'trigger' : 'cls';
  const what = unit.kind === 'trigger' ? 'trigger' : 'class';
  return {
    unit, lines, canWhole, whole, method, ext,
    range: whole ? [1, lines.length] : method,
    copyLabel: whole || !canWhole ? `Copy ${what}` : m.kind === 'constructor' ? 'Copy constructor' : 'Copy method',
    copyText: whole || !canWhole ? unit.body : lines.slice(method[0] - 1, method[1]).join('\n'),
    copyDone: whole || !canWhole ? `${unit.name}.${ext} copied` : `${m.label} copied`,
  };
}

function copyButton(sc) {
  return h('button', {
    class: 'ghost small code-copy', title: sc.whole || !sc.canWhole ? `Copy the whole ${sc.unit.name}.${sc.ext}` : 'Copy this method’s code',
    onclick: (e) => copyCode(e.currentTarget, sc.copyText),
  }, h('span', { 'aria-hidden': 'true' }, '⧉'), ` ${sc.copyLabel}`);
}

async function copyCode(btn, text) {
  btn.lastCopied = text; // (tests read it back)
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const was = btn.innerHTML;
  btn.classList.add('copied');
  btn.textContent = '✓ Copied';
  setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = was; }, 1400);
}

function showCode(id, info) {
  state.codeShown = { id, info };
  const m = state.index.methodsById.get(id);
  const marks = codeMarks(m, info);
  const sc = codeScope(m);
  const url = setupUrl(sc.unit);
  const toggle = () => { state.codeWhole = !state.codeWhole; showCode(id, info); };
  const head = h('div', { class: 'code-head' },
    h('div', { class: 'code-title-row' },
      h('div', { class: 'code-title' }, m.label),
      h('button', { class: 'code-expand', title: 'Expand: source and details side by side, full screen (F)', 'aria-label': 'Expand to full screen', onclick: () => openCodeFocus(id, info) },
        h('span', { 'aria-hidden': 'true' }, '⤢'), 'Expand')),
    h('div', { class: 'code-sub' },
      h('span', {}, `${sc.unit.name}.${sc.ext} · lines ${sc.range[0]}–${sc.range[1]}`),
      entryBadge(m.entry),
      sc.canWhole ? h('button', { class: 'link', onclick: toggle }, sc.whole ? 'Method only' : 'Whole class') : null,
      copyButton(sc),
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null),
    marks.items.length ? codeDetails(refsList(marks.items, scrollToLine), codeSummary(info, marks.items.length)) : null);
  const scroller = h('div', { class: 'code-scroll' }, sourcePre(sc.lines, sc.range, marks, sc.whole ? sc.method : null));
  $('#code').replaceChildren(head, scroller);
  const first = Math.min(...marks.hlLines);
  scrollToLine(Number.isFinite(first) ? first : sc.method[0]);
}

// ---------- expanded: source and details full screen (like Debug Logs) ----------
function openCodeFocus(id, info) {
  if (document.querySelector('.fx')) return;
  const m = state.index.methodsById.get(id);
  const marks = codeMarks(m, info);
  const opener = document.activeElement;
  const srcSub = h('span', { class: 'fx-sub' });
  const tools = h('span', { class: 'fx-head-extra' });
  const srcBody = h('div', { class: 'fx-pane-body' });
  let scroller = null;
  const pick = (ln) => {
    for (const r of scroller.querySelectorAll('.row.fx-pick')) r.classList.remove('fx-pick');
    const row = scroller.querySelector(`.row[data-line="${ln}"]`);
    if (row) { row.classList.add('fx-pick'); row.scrollIntoView({ block: 'center' }); }
  };
  function drawSource() {
    const sc = codeScope(m);
    srcSub.textContent = `${sc.unit.name}.${sc.ext} · lines ${sc.range[0]}–${sc.range[1]}`;
    const url = setupUrl(sc.unit);
    tools.replaceChildren(...[srcSub, // (filter: replaceChildren would print a null as "null")
      sc.canWhole ? h('button', { class: 'link', onclick: () => { state.codeWhole = !state.codeWhole; drawSource(); if (state.codeShown) showCode(state.codeShown.id, state.codeShown.info); } }, sc.whole ? 'Method only' : 'Whole class') : null,
      copyButton(sc),
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null].filter(Boolean));
    scroller = h('div', { class: 'code-scroll fx-src' }, sourcePre(sc.lines, sc.range, marks, sc.whole ? sc.method : null));
    srcBody.replaceChildren(scroller);
    const first = Math.min(...marks.hlLines);
    requestAnimationFrame(() => scroller.querySelector(`.row[data-line="${Number.isFinite(first) ? first : sc.method[0]}"]`)?.scrollIntoView({ block: 'center' }));
  }
  const sum = codeSummary(info, marks.items.length);
  const details = h('div', { class: 'fx-details' },
    sum.badges.length ? h('div', { class: 'cd-badges fx-badges' }, sum.badges.map(([t, k]) => h('span', { class: `cd-badge ${k || ''}` }, t))) : null,
    marks.items.length ? refsList(marks.items, pick) : h('p', { class: 'lv-muted fx-none' }, 'Nothing to point at in this step.'));
  const left = h('section', { class: 'fx-pane fx-left' },
    h('div', { class: 'fx-pane-head' }, h('span', { class: 'fx-pane-title' }, 'Apex'), tools), srcBody);
  const right = h('section', { class: 'fx-pane fx-right' },
    h('div', { class: 'fx-pane-head' }, h('span', { class: 'fx-pane-title' }, sum.title)), details);
  const grid = h('div', { class: 'fx-grid' }, left, right);
  grid.append(resizable({
    handle: h('div', { class: 'fx-split' }), pane: left, host: grid, cssVar: '--fx-left', edge: 'end',
    min: 280, max: () => grid.clientWidth - 300, key: 'ff-split-fx-cf', label: 'Resize source and details',
  }));
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); opener?.focus?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const card = h('div', { class: 'fx-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${m.label}: source and details`, tabindex: '-1' },
    h('header', { class: 'fx-head' },
      h('div', { class: 'fx-title' }, h('b', {}, m.label), entryBadge(m.entry)),
      h('span', { class: 'fx-keys' }, 'Click a line in Details to find it in the code · Esc to close'),
      h('button', { class: 'fx-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => close() }, '×')),
    grid);
  const wrap = h('div', { class: 'fx' }, card);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(wrap);
  drawSource();
  card.focus();
}

// F opens the expanded view of what the code panel shows (not while typing)
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey || e.altKey || state.appView !== 'flow' || !state.codeShown) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.fx, .overlay:not([hidden])')) return;
  if (!$('#code .code-head')) return;
  e.preventDefault();
  openCodeFocus(state.codeShown.id, state.codeShown.info);
});

function codeSummary(info, n) {
  if (info.refs) {
    const writes = info.refs.filter((r) => r.access === 'write').length;
    const reads = info.refs.length - writes;
    return {
      title: `References to ${state.field?.name || 'the field'}`,
      badges: [writes ? [`${writes} write${writes === 1 ? '' : 's'}`, 'dml'] : null, reads ? [`${reads} read${reads === 1 ? '' : 's'}`, 'call'] : null].filter(Boolean),
    };
  }
  return { title: 'Call sites', badges: [[`${n} line${n === 1 ? '' : 's'}`, 'call']] };
}

function scrollToLine(n) {
  const row = document.querySelector(`#code .row[data-line="${n}"]`);
  if (row) row.scrollIntoView({ block: 'center' });
}

init();
