import { parseUnit, implementsOf } from './apex/parser.js';
import { apexLinks, apexHandlers, wireLinks, componentLinks } from './explorer/code-links.js';
import { CodeIndex, ROOT_ENTRY_KINDS } from './apex/analyzer.js';
import { getSession } from './session.js';
import { SfApi } from './sf-api.js';
import { loadOrgCode, clearCache } from './code-loader.js';
import { DEMO_UNITS, DEMO_FRAMEWORK_UNITS, DEMO_OBJECTS, DEMO_FIELDS } from './demo-data.js';

// app.html?demo=framework adds a sample trigger framework (dispatcher + handlers picked at run time)
const demoUnits = () => (new URLSearchParams(location.search).get('demo') === 'framework' ? [...DEMO_UNITS, ...DEMO_FRAMEWORK_UNITS] : DEMO_UNITS);
import { h } from './dom.js';
import { highlight } from './apex/highlight.js';
import { resizable, codeDetails, collapsibleSide } from './layout.js';
import { setupCoffee } from './coffee.js';
import { setupFeedback } from './feedback.js';
import { setupFun } from './fun.js';
import { ApexVersions } from './logs/apex-versions.js';
import { triggerFacts, handlerMatch, buildDispatchMap, dispatchMetadataTypes } from './apex/dispatch.js';
import { fieldUsages, methodUsages, USAGE_LABEL } from './usage/usage.js';
import { installLabelHover, resetLabels } from './explorer/labels.js';

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
  explorerView: null,
  demoData: null, // one pretend org for Data Export and Data Import
  pick: 'field', // 'field' | 'method' (left panel tab)
  cls: null, // type key
  methodId: null,
  view: 'tree',
  opts: { possible: false, tests: false },
  // field trace: which paths to show, by what the code does with the field ('all' | 'write' | 'read' | 'outside')
  access: (() => { try { return localStorage.getItem('ff-cf-access') || 'all'; } catch { return 'all'; } })(),
  selectedKey: null,
  codeWhole: false, // code panel: the whole class instead of just the method
  codeShown: null,
  dispatchMap: null, // custom metadata: which handler class each trigger-framework key names
  usage: null, // Flows, validation rules, LWC, Aura, Visualforce: { status, src, note }
  searchSources: null,
  formulas: new Map(), // object (lower) → its formula fields, or a promise of them
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
  // hover a custom label in any code view to see its value (read once, on the first hover)
  installLabelHover(async () => (await searchSources()).load('label'));
  setupTabScroller($('.views'));
  bindUi();
  setupSplitters();
  renderClasses();
  renderMethods();
  const params = new URLSearchParams(location.search);
  const startView = ['logs', 'data', 'import', 'search', 'api', 'exec', 'explorer', 'compare'].includes(params.get('view')) ? params.get('view') : null;
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

// Many tabs, narrow window: ‹ › buttons and soft edges show there is more, the wheel scrolls sideways.
function setupTabScroller(nav) {
  if (!nav) return;
  const wrap = document.createElement('div');
  wrap.className = 'views-wrap';
  nav.before(wrap);
  const arrow = (dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `views-arrow views-${dir < 0 ? 'prev' : 'next'}`;
    b.textContent = dir < 0 ? '‹' : '›';
    b.title = dir < 0 ? 'More tabs on the left' : 'More tabs on the right';
    b.setAttribute('aria-label', b.title);
    b.tabIndex = -1;
    b.addEventListener('click', () => nav.scrollBy({ left: dir * Math.max(120, nav.clientWidth * 0.6), behavior: 'smooth' }));
    return b;
  };
  const prev = arrow(-1), next = arrow(1);
  wrap.append(prev, nav, next);
  const update = () => {
    const max = nav.scrollWidth - nav.clientWidth;
    const atStart = nav.scrollLeft <= 1, atEnd = nav.scrollLeft >= max - 1;
    wrap.classList.toggle('overflowing', max > 1);
    wrap.classList.toggle('more-left', max > 1 && !atStart);
    wrap.classList.toggle('more-right', max > 1 && !atEnd);
    prev.disabled = atStart;
    next.disabled = atEnd;
  };
  nav.addEventListener('scroll', update, { passive: true });
  nav.addEventListener('wheel', (e) => {
    if (nav.scrollWidth <= nav.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    nav.scrollLeft += e.deltaY;
  }, { passive: false });
  new ResizeObserver(() => requestAnimationFrame(update)).observe(nav); // next frame: showing the arrows resizes the bar
  update();
}

async function switchView(view) {
  if (state.appView === view) return;
  state.appView = view;
  // the address follows the tab you're on, so a refresh (or a copied link) comes back to it, not to the
  // tool the OG panel first opened
  try {
    const u = new URL(location.href);
    if (view === 'flow') u.searchParams.delete('view');
    else u.searchParams.set('view', view);
    if (u.href !== location.href) history.replaceState(history.state, '', u);
  } catch { /* the address can't be changed here: nothing lost */ }
  for (const b of document.querySelectorAll('.views button')) b.setAttribute('aria-selected', String(b.dataset.appView === view));
  document.querySelector(`.views button[data-app-view="${view}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  $('#view-flow').hidden = view !== 'flow';
  $('#view-logs').hidden = view !== 'logs';
  $('#view-data').hidden = view !== 'data';
  $('#view-search').hidden = view !== 'search';
  $('#view-api').hidden = view !== 'api';
  $('#view-exec').hidden = view !== 'exec';
  $('#view-import').hidden = view !== 'import';
  $('#view-explorer').hidden = view !== 'explorer';
  $('#view-compare').hidden = view !== 'compare';
  $('#rescan').hidden = view !== 'flow' || state.mode !== 'org';
  if (view === 'logs') state.logsView ||= loadLogsView();
  if (view === 'data') state.dataView ||= loadDataView();
  if (view === 'search') state.searchView ||= loadSearchView();
  if (view === 'api') state.apiView ||= loadApiView();
  if (view === 'exec') state.execView ||= loadExecView();
  if (view === 'import') state.importView ||= loadImportView();
  if (view === 'explorer') state.explorerView ||= loadExplorerView();
  if (view === 'compare') state.compareView ||= loadCompareView();
  if (state.logsView) (await state.logsView).setActive(state.appView === 'logs');
  if (state.dataView) (await state.dataView).setActive(state.appView === 'data');
  if (state.searchView) (await state.searchView).setActive(state.appView === 'search');
  if (state.apiView) (await state.apiView).setActive(state.appView === 'api');
  if (state.execView) (await state.execView).setActive(state.appView === 'exec');
  if (state.importView) (await state.importView).setActive(state.appView === 'import');
  if (state.explorerView) (await state.explorerView).setActive(state.appView === 'explorer');
  if (state.compareView) (await state.compareView).setActive(state.appView === 'compare');
}

// OG Code Compare: code of any two orgs this browser is logged into (The Informant's org registry)
async function loadCompareView() {
  const { mountCompare } = await import('./compare/compare-ui.js');
  return mountCompare($('#view-compare'), {
    demo: state.mode === 'demo',
    currentHost: state.mode === 'demo' ? null : state.session?.apiHost,
    // only the org this tab is connected to has OG Explorer
    openInExplorer: (target) => openInExplorer(target, { newTab: true }),
  });
}

async function loadExplorerView() {
  const { mountExplorer } = await import('./explorer/explorer-ui.js');
  return mountExplorer($('#view-explorer'), {
    getIndex: () => state.indexPromise,
    sources: await searchSources(),
    orgKey: state.session?.orgId || 'demo',
    setupUrl,
    // a method's call tree in Code Flow
    openCodeFlow: async (id) => {
      const m = state.index.methodsById.get(id);
      if (!m) return;
      await switchView('flow');
      switchPick('method');
      selectClass(m.type.key);
      selectMethod(m.id);
    },
    openExecutor: () => switchView('exec'),
    isAsync: (type) => [...implementsOf(type)].some((i) => /^(batchable|queueable|schedulable)/.test(i)),
  });
}

// any code link (Code Flow, Debug Logs): continue reading in OG Explorer
async function openInExplorer(target, how = {}) {
  await switchView('explorer');
  (await state.explorerView).open(target, how);
}

// links of a parsed Apex file, and what hovering / clicking / Alt+clicking them does
const fileLinks = new WeakMap();
function linksFor(file) {
  if (!fileLinks.has(file)) fileLinks.set(file, apexLinks(state.index, file));
  return fileLinks.get(file);
}
const codeLinkHandlers = () => apexHandlers(state.index, { open: (t, how) => openInExplorer(t, how), linksOf: linksFor });

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
  $('#nav-explorer').disabled = false;
  $('#nav-compare').disabled = false;
}

async function searchSources() {
  state.searchSources ||= state.mode === 'demo'
    ? new (await import('./search/demo-search.js')).DemoSearchSources()
    : new (await import('./search/search-sources.js')).SfSearchSources(state.api, state.session, {
      // Apex comes from the Code Flow scan (already running, cached on disk), so it's never downloaded twice
      getApexUnits: async () => (await state.indexPromise).files.map((f) => f.unit),
    });
  return state.searchSources;
}

async function loadSearchView() {
  const { mountSearch } = await import('./search/search-ui.js');
  return mountSearch($('#view-search'), await searchSources(), searchCodeSupport());
}

// what FBI Search's code preview needs to work like OG Explorer: the parsed Apex, its links, and where a click goes
function searchCodeSupport() {
  const byId = new WeakMap();
  const methodBy = (cls, name) => {
    const t = (state.index?.typesByShortName.get(String(cls).toLowerCase()) || []).find((x) => !x.outer);
    return (t && (t.methodsByName.get(String(name).toLowerCase()) || [])[0]?.id) || null;
  };
  const typeBy = (name) => ((state.index?.typesByShortName.get(String(name).toLowerCase()) || []).find((x) => !x.outer && x.kind !== 'trigger')?.key) || null;
  return {
    ready: () => state.indexPromise,
    apexFile: (doc) => {
      const idx = state.index;
      if (!idx) return null;
      if (!byId.has(idx)) byId.set(idx, new Map(idx.files.map((f) => [f.unit.id, f])));
      return byId.get(idx).get(doc.id) || null;
    },
    apexLinks: (file) => linksFor(file),
    componentLinks: (bundle, has) => (state.index ? componentLinks(bundle, { method: methodBy, type: typeBy, doc: has }) : []),
    handlers: () => {
      const base = codeLinkHandlers();
      return { ...base, describe: (t) => (t.type === 'doc' ? null : base.describe(t)), peek: (t) => (t.type === 'doc' ? null : base.peek(t)) };
    },
    openInExplorer: (target) => openInExplorer(target, { newTab: true }),
  };
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
    // clickable calls in the code panel, when the shown source is the scanned one
    codeLinks: (unit) => {
      const file = state.index?.files.find((f) => f.unit.id === unit.id && f.unit.body === unit.body);
      if (!file) return null;
      const L = linksFor(file);
      return { byLine: L.byLine, wire: (pre) => wireLinks(pre, L, codeLinkHandlers()) };
    },
    setupUrl,
    // the Code Flow scan of the org's Apex, used by Field Trace
    getIndex: () => state.indexPromise,
    // Execution Path → Entry paths: Code Flow's entry paths of a step's method
    entryPaths: logEntryPaths,
    // the code panels' "Open in OG Explorer": the class / trigger in a new Explorer tab, at that line
    openInExplorer: (unit, line) => openInExplorer({ type: 'doc', key: `${unit.kind === 'trigger' ? 'trigger' : 'class'}:${unit.name.toLowerCase()}`, line }, { newTab: true }),
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
  resetLabels(); // label values may have changed too
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
  if (state.mode === 'demo') return demoUnits().find((u) => u.kind === kind && u.name.toLowerCase() === lname) || null;
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
  state.indexPromise = buildIndex(demoUnits());
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
    loadDispatchMap(units);
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
  $('#rescan').addEventListener('click', () => { resetLabels(); state.indexPromise = scanOrg(); });
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
  loadUsage();
  loadFormulas(state.object);
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
  const { roots: allRoots, hiddenPossible } = rootsFor(state.analysis);
  const allUses = fieldUses();
  // the Writes / Reads / Outside Apex filter: only the paths that end in that kind of use
  const f = state.access;
  const roots = f === 'outside' ? [] : f === 'write' ? allRoots.filter((r) => r.write) : f === 'read' ? allRoots.filter((r) => r.read) : allRoots;
  const uses = f === 'all' || f === 'outside' ? allUses : allUses.filter((u) => u.refs.some((r) => r.access === f));
  const { paths, truncated } = withUsages(classifyPaths(state.index.entryPaths(roots.map((r) => r.method.id), pathOpts())), uses);
  renderHead(allRoots, paths, hiddenPossible, allUses);
  const body = $('#flow-body');
  body.replaceChildren();
  if (f !== 'all' && !roots.length && !uses.length && (allRoots.length || allUses.length)) {
    const what = { write: 'writes', read: 'reads', outside: 'uses' }[f];
    body.append(h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, f === 'outside' ? 'Nothing outside Apex uses this field' : `No code ${what} this field`),
      h('p', { class: 'empty-sub' }, f === 'outside' && state.usage?.status !== 'ready' ? 'Still looking in Flows, validation rules, formulas, LWC, Aura and Visualforce…' : 'Other code uses it in other ways.'),
      h('button', { class: 'ghost small', onclick: () => setAccess('all') }, 'Show all paths')));
    showCodeEmpty();
    return;
  }
  if (!roots.length && !uses.length) {
    body.append(...[h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, state.usage?.status === 'ready' ? 'Not used anywhere we can see' : 'No Apex references found'),
      h('p', { class: 'empty-sub' }, hiddenPossible
        ? `${plural(hiddenPossible, 'possible match')} hidden — turn on “Show possible matches” to review them.`
        : state.usage?.status === 'ready' ? 'Nothing in unmanaged Apex, Flows, Process Builder, validation rules, formula fields, LWC, Aura or Visualforce uses this field.'
          : 'This field isn’t referenced by unmanaged Apex. Still looking in Flows, validation rules, formulas, LWC, Aura and Visualforce…')),
    usageNote()].filter(Boolean)); // (append would print a null as "null")
    showCodeEmpty();
    return;
  }
  const note = usageNote();
  if (note) body.append(note);
  if (state.view === 'tree') {
    body.append(renderTree(roots, uses));
    expandAll(60); // small trees open fully; big ones show the first levels
  } else {
    body.append(renderPaths(paths, new Map(roots.map((r) => [r.method.id, r])), truncated));
  }
  if (autoExpand && roots.length) selectNode(`ref:${roots[0].method.id}`, roots[0].method.id, { refs: roots[0].refs });
  else if (autoExpand && uses.length) selectNode(`use:${uses[0].key}`, null, { usage: uses[0] });
  else restoreSelection();
}

function renderMethodFlow(autoExpand) {
  const m = state.methodId && state.index?.methodsById.get(state.methodId);
  if (!m) return showFlowEmpty();
  loadUsage();
  const { paths, truncated } = withUsages(classifyPaths(state.index.entryPaths([m.id], pathOpts())));
  renderMethodHead(m, paths);
  const body = $('#flow-body');
  body.replaceChildren(...[usageNote()].filter(Boolean));
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
  const real = paths.filter((p) => p.end !== 'dispatch'); // not the ones only a trigger framework could take
  $('#flow-head').hidden = false;
  $('#flow-title').textContent = m.label;
  $('#flow-type').textContent = [m.isStatic ? 'static' : null, m.kind].filter(Boolean).join(' ');
  const callers = state.index.callers(m.id, state.opts);
  const outside = methodUses(m).length;
  const entries = new Set(paths.filter((p) => p.end === 'entry').map(entryKey));
  const chips = $('#chips');
  const direct = callers.length + outside;
  chips.replaceChildren(
    h('span', { class: 'chip read' }, h('b', {}, direct), direct === 1 ? 'direct caller' : 'direct callers'),
    h('span', { class: 'chip entries' }, h('b', {}, entries.size), entries.size === 1 ? 'entry point' : 'entry points'),
    h('span', { class: 'chip entries' }, h('b', {}, real.length), real.length === 1 ? 'path' : 'paths'),
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

function renderHead(roots, paths, hiddenPossible, uses = []) {
  $('#flow-head').hidden = false;
  $('#flow-title').textContent = `${state.object}.${state.field.name}`;
  $('#flow-type').textContent = state.field.type;
  const writers = roots.filter((r) => r.write).length;
  const readers = roots.filter((r) => r.read && !r.write).length;
  const entries = new Set(paths.filter((p) => p.end === 'entry').map(entryKey));
  const chips = $('#chips');
  // Show: All · Writes · Reads · Outside Apex (filters the call tree and the entry paths)
  const readersAll = roots.filter((r) => r.read).length;
  const outside = state.usage?.status === 'ready' ? uses.length : null;
  const opt = (k, label, n, title) => h('button', {
    type: 'button', role: 'radio', class: `af-opt k-${k}`, 'aria-checked': String(state.access === k), title,
    onclick: () => setAccess(k),
  }, label, n != null ? h('span', { class: 'af-n' }, n) : null);
  const filter = h('div', { class: 'access-filter', role: 'radiogroup', 'aria-label': 'Show paths to code that' },
    h('span', { class: 'af-label' }, 'Show'),
    opt('all', 'All', null, 'Every path, whatever the code does with the field'),
    opt('write', 'Writes', writers, 'Only paths to code that writes (sets) the field'),
    opt('read', 'Reads', readersAll, 'Only paths to code that reads the field (in SOQL or in code), including code that also writes it'),
    opt('outside', 'Outside Apex', outside, 'Only Flows, Process Builder, validation rules, formulas, LWC, Aura and Visualforce'));
  chips.replaceChildren(
    h('span', { class: 'chip write' }, h('b', {}, writers), writers === 1 ? 'method writes' : 'methods write'),
    h('span', { class: 'chip read' }, h('b', {}, readers), readers === 1 ? 'method only reads' : 'methods only read'),
    state.usage?.status === 'ready'
      ? h('span', { class: 'chip outside', title: 'Flows, Process Builder, validation rules, formula fields, LWC, Aura and Visualforce' }, h('b', {}, uses.length), uses.length === 1 ? 'use outside Apex' : 'uses outside Apex')
      : h('span', { class: 'chip outside', title: 'Reading Flows, validation rules, formula fields, LWC, Aura and Visualforce' }, 'checking outside Apex…'),
    h('span', { class: 'chip entries' }, h('b', {}, entries.size), entries.size === 1 ? 'entry point' : 'entry points'),
    filter,
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

function setAccess(k) {
  state.access = k;
  try { localStorage.setItem('ff-cf-access', k); } catch { /* storage blocked */ }
  rerender();
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

// ---------- outside Apex: Flows, Process Builder, validation rules, formula fields, LWC, Aura, Visualforce ----------
// The same sources FBI Search reads (and caches on disk), loaded once when Code Flow first needs them.
const USAGE_GROUPS = ['flow', 'validation', 'lwc', 'aura', 'vf'];
const USAGE_NAMES = { flow: 'Flows', validation: 'validation rules', lwc: 'LWC', aura: 'Aura', vf: 'Visualforce' };

function loadUsage() {
  if (state.usage) return state.usage.promise;
  const u = { status: 'loading', src: {}, note: 'Also looking in Flows, validation rules, LWC, Aura and Visualforce…', failed: [] };
  state.usage = u;
  u.promise = (async () => {
    const sources = await searchSources();
    for (const g of USAGE_GROUPS) {
      try {
        u.src[g] = await sources.load(g, (text) => { u.note = `Also looking outside Apex: ${text}`; paintUsageNote(); });
      } catch (e) {
        u.src[g] = [];
        u.failed.push(`${USAGE_NAMES[g]} (${e.message})`);
      }
    }
    u.status = 'ready';
    if (state.appView === 'flow' && (state.field || state.methodId)) rerender();
  })();
  return u.promise;
}

// formula fields of an object: from its describe (calculatedFormula)
function loadFormulas(object) {
  const k = String(object || '').toLowerCase();
  if (!k || state.formulas.has(k) || state.mode !== 'org') return;
  const p = state.api.request(`/services/data/${state.api.version}/sobjects/${encodeURIComponent(object)}/describe/`)
    .then((d) => d.fields.filter((f) => f.calculated && f.calculatedFormula).map((f) => ({
      name: f.name, label: f.label, formula: f.calculatedFormula,
      link: `https://${state.session.apiHost.replace(/\.my\.salesforce\.com$/i, '.lightning.force.com')}/lightning/setup/ObjectManager/${object}/FieldsAndRelationships/view`,
    })))
    .catch(() => []);
  state.formulas.set(k, p);
  p.then((list) => {
    state.formulas.set(k, list);
    if (list.length && state.appView === 'flow' && state.object?.toLowerCase() === k && state.field) rerender();
  });
}

function fieldUses() {
  if (state.usage?.status !== 'ready' || !state.field) return [];
  const f = state.formulas.get(state.object.toLowerCase());
  return fieldUsages(state.usage.src, state.object, state.field.name, Array.isArray(f) ? f : []);
}

const useCache = new WeakMap(); // usage state → Map(method id → usages)
function methodUses(m) {
  if (state.usage?.status !== 'ready' || !m || m.kind !== 'method' || m.type.outer) return [];
  let c = useCache.get(state.usage);
  if (!c) { c = new Map(); useCache.set(state.usage, c); }
  if (!c.has(m.id)) c.set(m.id, methodUsages(state.usage.src, { className: m.type.name, name: m.name, annots: m.annots }));
  return c.get(m.id);
}

// Apex paths that start at a method a component / flow calls start at that component instead;
// in Field mode, Flows and components that use the field directly are paths of their own
function withUsages(result, fieldDirect = []) {
  if (state.usage?.status !== 'ready') return result;
  const out = fieldDirect.map((u) => ({ ids: [], end: 'entry', usage: u }));
  const seen = new Set();
  const addUse = (u, ids, p) => {
    const k = `${u.key}|${ids.join('>')}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...p, ids, end: 'entry', usage: u, dispatch: null });
  };
  for (const p of result.paths) {
    if (p.end === 'dispatch' || !p.ids.length) { out.push(p); continue; }
    const first = methodUses(state.index.methodsById.get(p.ids[0]));
    if (first.length) for (const u of first) addUse(u, p.ids, p);
    else out.push(p);
    // a component / flow that calls a method further down starts a shorter path there
    for (let i = 1; i < p.ids.length; i++) for (const u of methodUses(state.index.methodsById.get(p.ids[i]))) addUse(u, p.ids.slice(i), p);
  }
  // the picked method itself, called straight from a component / flow
  if (state.pick === 'method' && state.methodId) {
    for (const u of methodUses(state.index.methodsById.get(state.methodId))) addUse(u, [state.methodId], { end: 'entry' });
  }
  return { ...result, paths: out };
}
const entryKey = (p) => (p.usage ? `use:${p.usage.key}` : p.ids[0]);

function usageNote() {
  const u = state.usage;
  if (!u || (u.status === 'ready' && !u.failed.length)) return null;
  return h('div', { class: `usage-note${u.status === 'ready' ? ' warn' : ''}` },
    u.status === 'ready' ? h('span', {}, `Couldn’t read ${u.failed.join(', ')}: those aren’t shown.`) : [h('span', { class: 'lg-spinner' }), h('span', { class: 'usage-note-t' }, u.note)]);
}
function paintUsageNote() {
  const t = document.querySelector('#flow-body .usage-note-t');
  if (t && state.usage) t.textContent = state.usage.note;
}

const USE_ACCESS = { write: ['writes', 'write'], read: ['reads', 'read'], uses: ['uses', 'uses'] };
function useBadges(refs) {
  const out = [];
  for (const k of ['write', 'read', 'uses']) if (refs.some((r) => r.access === k)) out.push(h('span', { class: `badge ${USE_ACCESS[k][1]}` }, USE_ACCESS[k][0]));
  if (refs.length && refs.every((r) => r.possible)) out.push(h('span', { class: 'badge possible', title: 'Matched by the field name next to this object, not by an exact reference' }, 'possible'));
  return out;
}

// a Flow / rule / component in the tree: a leaf (it's where things start)
function usageNode(u, childId) {
  const key = `use:${u.key}`;
  const calls = u.refs.filter((r) => r.access === 'calls');
  const card = h('div', { class: `card use-card${u.inactive ? ' inactive' : ''}`, 'data-key': key, title: u.sub },
    h('span', { class: 'caret none' }, '▸'),
    h('span', { class: 'name' }, u.name),
    u.title && u.title !== u.name ? h('span', { class: 'meta' }, u.title) : null,
    childId ? null : useBadges(u.refs),
    entryBadge(u.entry),
    u.inactive ? h('span', { class: 'badge possible' }, 'inactive') : null,
    calls.length ? h('span', { class: 'meta' }, `calls it at ${calls.map((c) => c.where).join(', ')}`) : null);
  card.addEventListener('click', () => selectNode(key, null, { usage: u }));
  return h('li', { 'data-use': u.key }, card);
}

const USE_LINK = { flow: 'Open in Flow Builder ↗', process: 'Process Automation ↗', validation: 'Open the rule ↗', formula: 'Fields & Relationships ↗', lwc: 'Lightning Components ↗', aura: 'Lightning Components ↗', vf: 'Open in Setup ↗' };
// the code panel for a Flow / rule / component: what it does with the field (or which call), and its source
function showUsage(u) {
  state.codeShown = null;
  const refs = h('ul', { class: 'code-refs' }, u.refs.map((r) => h('li', { onclick: () => r.line && scrollToLine(r.line) },
    h('span', { class: 'ln' }, r.line ? `L${r.line}` : '·'),
    h('span', { class: `badge ${r.access === 'calls' ? 'kind' : USE_ACCESS[r.access]?.[1] || 'read'}` }, r.access === 'calls' ? 'calls' : USE_ACCESS[r.access]?.[0] || r.access),
    h('span', {}, r.where),
    r.possible ? h('span', { class: 'badge possible' }, 'possible') : null)));
  const head = h('div', { class: 'code-head' },
    h('div', { class: 'code-title' }, u.name),
    h('div', { class: 'code-sub' },
      h('span', {}, u.title && u.title !== u.name ? `${u.title} · ${u.sub}` : u.sub),
      entryBadge(u.entry),
      u.inactive ? h('span', { class: 'badge possible' }, 'inactive') : null,
      u.link ? h('a', { href: u.link, target: '_blank', rel: 'noopener' }, USE_LINK[u.kind] || 'Open ↗') : null),
    codeDetails(refs, { title: u.refs.some((r) => r.access === 'calls') ? 'Calls' : `Uses of ${state.field?.name || 'the field'}`, badges: [[`${u.refs.length} place${u.refs.length === 1 ? '' : 's'}`, 'call']] }));
  const hl = new Set(u.refs.map((r) => r.line).filter(Boolean));
  const pre = h('pre', { class: 'src' });
  // a file's lines; the first file shown answers scrollToLine(n) (Details clicks), the others are labelled
  const addLines = (text, label, marks, first) => {
    if (label) pre.append(h('div', { class: 'row file-row' }, h('span', { class: 'gutter' }), h('span', { class: 'txt' }, label)));
    String(text).split('\n').forEach((t, i) => pre.append(h('div', { class: `row${marks.has(i + 1) ? ' hl-ref' : ''}`, 'data-line': first ? i + 1 : `${label}:${i + 1}` },
      h('span', { class: 'gutter' }, i + 1), h('span', { class: 'txt' }, t || ' '))));
  };
  if (u.source) addLines(u.source, null, hl, true);
  else if (u.files) {
    // only the files that mention it, each with its own marked lines
    const marksOf = (f) => new Set(u.refs.filter((r) => u.files.length === 1 || r.where.startsWith(`${f.name},`)).map((r) => r.line).filter(Boolean));
    u.files.filter((f) => marksOf(f).size).forEach((f, i) => addLines(f.text, u.files.length > 1 ? f.name : null, marksOf(f), i === 0));
  } else {
    pre.append(h('div', { class: 'row' }, h('span', { class: 'gutter' }), h('span', { class: 'txt muted' },
      `${USAGE_LABEL[u.kind]}: the elements above use it. Open it in ${u.kind === 'process' ? 'Process Builder' : 'Flow Builder'} to see them.`)));
  }
  $('#code').replaceChildren(head, h('div', { class: 'code-scroll' }, pre));
  const first = Math.min(...hl);
  if (Number.isFinite(first)) scrollToLine(first);
}

// a path that starts at a Flow / component: it first, then the Apex steps
function usagePathText(p, n, total, rootInfo) {
  const u = p.usage;
  const out = [`Path ${n + 1}${total > 1 ? ` of ${total}` : ''} · ${u.entry.label}${u.sub ? ` (${u.sub})` : ''}${u.inactive ? ' · inactive' : ''}`];
  out.push(`  1. ${u.entry.label}: ${u.name}${u.title && u.title !== u.name ? ` (${u.title})` : ''}`);
  if (!p.ids.length) {
    for (const k of ['write', 'read', 'uses']) {
      const rs = u.refs.filter((r) => r.access === k);
      if (rs.length) out.push(`       ★ ${USE_ACCESS[k][0].toUpperCase()} ${state.object}.${state.field.name} in ${rs.map((r) => r.where).join('; ')}${rs.every((r) => r.possible) ? ' (possible)' : ''}`);
    }
    return out;
  }
  out.push(`       ↓ calls the next step in ${u.refs.map((r) => r.where).join('; ')}`);
  const rest = pathText({ ...p, usage: null, end: 'entry' }, n, total, rootInfo).slice(1)
    .map((l) => l.replace(/^ {2}(\d+)\. /, (_, k) => `  ${+k + 1}. `));
  return [...out, ...rest];
}

function renderTree(roots, uses = []) {
  const fieldCard = h('div', { class: 'card root-card' }, `${state.object}.${state.field.name}`);
  const list = h('ul', {});
  for (const r of roots) list.append(methodNode(r.method.id, [r.method.id], { refs: r.refs }));
  for (const u of uses) list.append(usageNode(u));
  return h('ul', { class: 'tree' },
    h('li', {}, fieldCard, h('div', { class: 'via-caption' }, 'used in'), list));
}

function methodNode(id, ancestry, info) {
  const m = state.index.methodsById.get(id);
  const all = state.index.callers(id, state.opts);
  // triggers whose framework picks another handler for them don't really call down this branch
  const { likely: callers, unlikely } = splitCallers(id, ancestry, all);
  const outside = methodUses(m); // LWC, Aura, Visualforce, Flows calling it
  const key = info.refs ? `ref:${id}` : info.self ? `self:${id}` : `call:${id}<${info.childId}@${ancestry.length}:${ancestry.join('/')}`;
  const li = h('li', { 'data-id': id });
  const caret = h('button', {
    class: `caret${all.length || outside.length ? '' : ' none'}`,
    'aria-expanded': 'false',
    'aria-label': 'Show callers',
    tabindex: all.length || outside.length ? '0' : '-1',
  }, '▸');

  const meta = [];
  if (info.via) {
    const kinds = [...info.via.kinds].map((k) => KIND_LABEL[k]).filter(Boolean);
    meta.push(h('span', { class: 'meta' }, `calls at line ${[...new Set(info.via.lines)].join(', ')}`));
    for (const k of kinds) meta.push(h('span', { class: 'badge kind' }, k));
  }
  if (!all.length && !outside.length && !(m.entry && ROOT_ENTRY_KINDS.has(m.entry.kind))) {
    meta.push(h('span', { class: 'entry orphan', title: 'Nothing in unmanaged Apex calls this. It may be invoked from a Flow, Visualforce page, anonymous Apex or a managed package.' }, 'no Apex callers'));
  } else if (all.length || outside.length) {
    meta.push(h('span', { class: 'meta' }, plural(callers.length + outside.length, 'caller')));
    if (unlikely.length) meta.push(h('span', { class: 'meta via-fw', title: 'Triggers that reach this only if their trigger framework picked the handler below. It picks a different one for them.' }, `+ ${unlikely.length} via trigger framework`));
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
  caret.addEventListener('click', () => toggle(li, caret, id, ancestry, callers, unlikely));
  li.append(card);
  li._expand = () => { if (caret.getAttribute('aria-expanded') === 'false' && (callers.length || outside.length)) toggle(li, caret, id, ancestry, callers, unlikely); };
  return li;
}

// Callers of `id` in this branch of the tree (ancestry: from the root up to id). A trigger that gets here
// only through a framework call to an interface / virtual method (the handler is picked at run time) counts
// only if its framework picks the handler further down this branch. Same rules as the entry paths.
function splitCallers(id, ancestry, callers) {
  const likely = [];
  const unlikely = [];
  const M = (x) => state.index.methodsById.get(x);
  const down = [...ancestry].reverse(); // id first, the root last
  for (const c of callers) {
    const t = M(c.from);
    if (t?.kind !== 'trigger') { likely.push(c); continue; }
    const chain = [c.from, ...down];
    const hop = chain.findIndex((x, i) => i < chain.length - 1 && (i === 0 ? c.kinds : viaFor(x, chain[i + 1]).kinds)?.has('dispatch'));
    if (hop < 0) { likely.push(c); continue; }
    const handler = M(chain[hop + 1]).type;
    const r = handlerMatch(factsOf(t), handler, state.index, state.dispatchMap);
    if (r.ok) likely.push(c); else unlikely.push({ ...c, why: r.detail, handler: handler.display });
  }
  return { likely, unlikely };
}

function toggle(li, caret, id, ancestry, callers, unlikely = []) {
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
  for (const u of methodUses(state.index.methodsById.get(id))) ul.append(usageNode(u, id));
  if (unlikely.length) {
    // folded: built only when asked, so Expand all doesn't open them
    const more = h('li', { class: 'tree-fw' });
    const show = () => {
      const list = h('ul', { class: 'callers fw-list' });
      for (const c of unlikely) {
        const node = methodNode(c.from, [...ancestry, c.from], { via: c, childId: id });
        node.classList.add('fw-unlikely');
        node.querySelector('.card').append(h('span', { class: 'meta fw-why', title: c.why }, c.why));
        node._expand = null;
        list.append(node);
      }
      more.replaceChildren(h('div', { class: 'tree-fw-head' },
        h('span', {}, `${plural(unlikely.length, 'trigger')} that reach this only if the trigger framework picked ${unlikely[0].handler}`),
        h('button', { class: 'link', onclick: hide }, 'Hide')), list);
    };
    const hide = () => more.replaceChildren(h('button', { class: 'tree-fw-btn', onclick: show },
      h('span', { 'aria-hidden': 'true' }, '+'), ` ${plural(unlikely.length, 'more trigger')} · only if the trigger framework picked ${unlikely[0].handler}`,
      h('span', { class: 'tree-fw-show' }, 'Show')));
    hide();
    ul.append(more);
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
// ---------- trigger frameworks: keep the paths a trigger can really take ----------
// A path that starts at a trigger and then goes through an interface / virtual call reaches every handler
// class in the code; at run time the framework picks one per trigger. Paths to a handler this trigger doesn't
// use move to the "dispatch" group (still shown, collapsed). See src/apex/dispatch.js.
const factsCache = new WeakMap();
// what a trigger says about its handler, read once per scan
function factsOf(trigger) {
  let facts = factsCache.get(state.index);
  if (!facts) { facts = new Map(); factsCache.set(state.index, facts); }
  if (!facts.has(trigger.id)) facts.set(trigger.id, triggerFacts(trigger, state.index));
  return facts.get(trigger.id);
}
function classifyPath(p) {
  const M = (id) => state.index.methodsById.get(id);
  if (p.end !== 'entry' || M(p.ids[0]).kind !== 'trigger') return p;
  const hop = p.ids.findIndex((id, i) => i < p.ids.length - 1 && viaFor(id, p.ids[i + 1]).kinds?.has('dispatch'));
  if (hop < 0) return p;
  const trigger = M(p.ids[0]);
  const handler = M(p.ids[hop + 1]).type;
  const r = handlerMatch(factsOf(trigger), handler, state.index, state.dispatchMap);
  return r.ok ? p : { ...p, end: 'dispatch', dispatch: { ...r, handler: handler.display, via: M(p.ids[hop]).label } };
}
function classifyPaths(result) {
  return { ...result, paths: result.paths.map(classifyPath) };
}
// the entry-path search options: a path a trigger framework can't take doesn't use up the path budget
const pathOpts = () => ({ ...state.opts, isUnlikely: (ids) => classifyPath({ ids, end: 'entry' }).end === 'dispatch' });

// custom metadata that trigger dispatchers read handler class names from (e.g. TriggerSettings__mdt)
async function loadDispatchMap(units) {
  if (state.mode !== 'org') return;
  const types = dispatchMetadataTypes(units);
  if (!types.length) return;
  const classNames = new Set(units.filter((u) => u.kind === 'class').map((u) => u.name.toLowerCase()));
  const records = [];
  for (const t of types) {
    try {
      const d = await state.api.request(`/services/data/${state.api.version}/sobjects/${t}/describe/`);
      const text = d.fields.filter((f) => ['string', 'textarea', 'picklist'].includes(f.type) && f.name !== 'Language').map((f) => f.name);
      if (!text.length) continue;
      records.push(...await state.api.query(`SELECT ${[...new Set(['DeveloperName', 'MasterLabel', ...text])].join(', ')} FROM ${t}`));
    } catch { /* not readable: names are the fallback */ }
  }
  const map = buildDispatchMap(records, classNames);
  if (!map.size) return;
  state.dispatchMap = map;
  if (state.appView === 'flow' && (state.field || state.methodId)) rerender();
}

// o: { onStep(key, id, info), heading(count), footer } for other screens (Debug Logs); Code Flow's by default
function renderPaths(paths, rootInfo, truncated, o = {}) {
  const wrap = h('div', { class: 'paths' });
  const onStep = o.onStep || selectNode;
  const ordered = orderPaths(paths);
  wrap.append(h('div', { class: 'paths-tools' },
    h('span', {}, (() => {
      const real = ordered.filter((p) => p.end !== 'dispatch').length;
      const unlikely = ordered.length - real;
      return `${real} path${real === 1 ? '' : 's'}${unlikely ? ` · ${unlikely} unlikely (trigger framework)` : ''}${truncated ? ' · not all listed' : ''}`;
    })()),
    h('button', {
      class: 'ghost small path-copy-all', title: 'Copy every path as plain text, ready to paste into Teams, an email or ChatGPT',
      onclick: (e) => copyPaths(e.currentTarget, allPathsText(ordered, rootInfo, truncated, o), 'Copied all paths'),
    }, h('span', { 'aria-hidden': 'true' }, '⧉'), ' Copy all paths')));
  let group = null;
  let fold = null; // the rows of the collapsed "only if the framework picked this handler" group
  ordered.forEach((p, n) => {
    if (p.end !== group) {
      group = p.end;
      const count = ordered.filter((x) => x.end === group).length;
      fold = null;
      if (group === 'dispatch') {
        fold = h('div', { class: 'paths-fold', hidden: !state.showDispatch });
        const btn = h('button', { class: 'link', onclick: () => { state.showDispatch = !state.showDispatch; fold.hidden = !state.showDispatch; btn.textContent = state.showDispatch ? 'Hide' : 'Show them'; } }, state.showDispatch ? 'Hide' : 'Show them');
        wrap.append(h('div', { class: 'group-title' }, `${PATH_GROUPS[group]} · ${count}`),
          h('div', { class: 'paths-dispatch-note' },
            h('span', {}, `These triggers reach this code only through a trigger framework call (like ${p.dispatch.via}) that picks one handler per trigger at run time, and each of them uses a different handler. Each path says why.`),
            btn),
          fold);
      } else {
        wrap.append(h('div', { class: 'group-title' }, `${PATH_GROUPS[group]} · ${count}`));
      }
    }
    const row = h('div', { class: `path${p.usage?.inactive ? ' inactive' : ''}` });
    const first = state.index.methodsById.get(p.ids[0]);
    if (p.usage) {
      const u = p.usage;
      row.append(...[entryBadge(u.entry), h('button', { class: 'step-chip use-chip', 'data-key': `use:${u.key}`, title: u.sub, onclick: () => selectNode(`use:${u.key}`, null, { usage: u }) }, u.name),
        u.inactive ? h('span', { class: 'badge possible' }, 'inactive') : null].filter(Boolean)); // (append would print a null)
      if (p.ids.length) row.append(h('span', { class: 'arrow' }, '→'));
      else if (rootInfo) row.append(...useBadges(u.refs), h('span', { class: 'field-end' }, state.field.name));
    } else {
      row.append(p.end === 'entry' || p.end === 'dispatch' ? entryBadge(first.entry) : h('span', { class: 'entry orphan' }, p.end === 'orphan' ? 'unknown entry' : '…'));
    }
    p.ids.forEach((id, i) => {
      const m = state.index.methodsById.get(id);
      const last = i === p.ids.length - 1;
      let info, key;
      if (!last) { info = { via: viaFor(id, p.ids[i + 1]), childId: p.ids[i + 1] }; key = `path:${id}>${p.ids[i + 1]}`; }
      else if (rootInfo) { info = { refs: rootInfo.get(id).refs }; key = `ref:${id}`; }
      else { info = { self: true }; key = `self:${id}`; }
      row.append(h('button', { class: 'step-chip', 'data-key': key, onclick: () => onStep(key, id, info) }, m.label));
      if (!last || rootInfo) row.append(h('span', { class: 'arrow' }, '→'));
    });
    if (rootInfo && p.ids.length) {
      const r = rootInfo.get(p.ids[p.ids.length - 1]);
      row.append(...accessBadges(r.refs), h('span', { class: 'field-end' }, state.field.name));
    }
    if (p.dispatch) row.append(h('span', { class: 'path-why', title: p.dispatch.detail }, p.dispatch.detail));
    row.append(h('button', {
      class: 'path-copy', title: 'Copy this path as plain text', 'aria-label': `Copy path ${n + 1}`,
      onclick: (e) => copyPaths(e.currentTarget, [(o.heading || pathsHeading)(1), '', ...pathText(p, n, ordered.length, rootInfo), '', o.footer || COPY_FOOTER].join('\n'), 'Copied'),
    }, '⧉'));
    (fold || wrap).append(row);
  });
  if (truncated) wrap.append(h('p', { class: 'paths-note' }, 'Some methods are reached by more paths than are listed here. Use the call tree to explore the rest.'));
  return wrap;
}

// ---------- entry paths as text (to share in Teams, an email, ChatGPT…) ----------

const PATH_GROUPS = {
  entry: 'From an entry point',
  orphan: 'No Apex caller found (Flow, Visualforce, anonymous Apex or managed code?)',
  depth: 'Stopped at max depth',
  dispatch: 'Only if the trigger framework picked this handler',
};
const COPY_FOOTER = '(Copied from Salesforce OG Debugger · Code Flow)';

// the order they're shown in: entry paths first, by entry kind, then name, then length
function orderPaths(paths) {
  const M = (p) => state.index.methodsById.get(p.ids[0]);
  // straight from a Flow / component to the field first, then Apex paths (with the component that starts them)
  const rank = (p) => (p.usage && !p.ids.length ? -2 : p.usage ? -1 : entryRank(M(p)));
  const name = (p) => (p.ids.length ? M(p).label : '') + (p.usage ? ` ${p.usage.name}` : '');
  return Object.keys(PATH_GROUPS).flatMap((end) => paths.filter((p) => p.end === end)
    .sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)) || a.ids.length - b.ids.length));
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
    : `How Apex reaches ${state.object}.${state.field?.name}${{ write: " (only code that writes it)", read: " (only code that reads it)", outside: " (only uses outside Apex)" }[state.access] || ""}`;
  const org = state.mode === 'demo' ? 'demo org' : state.session?.apiHost;
  return `${target}\n${count === 1 ? 'One code path' : `${count} code paths`}, from the entry point down${org ? ` · ${org}` : ''}`;
}

// one path: numbered steps, where each step calls the next, and what the last step does
function pathText(p, n, total, rootInfo) {
  if (p.usage) return usagePathText(p, n, total, rootInfo);
  const first = state.index.methodsById.get(p.ids[0]);
  const e = first.entry;
  const start = p.end === 'entry' || p.end === 'dispatch' ? `${e?.label || 'Entry point'}${e?.detail && e.detail !== e.label ? ` (${e.detail})` : ''}${p.dispatch ? ` · unlikely: ${p.dispatch.detail}` : ''}`
    : p.end === 'orphan' ? 'No Apex caller found: may run from a Flow, Visualforce page, anonymous Apex or a managed package'
      : 'Stopped at max depth: there are more callers above this';
  const out = [`Path ${n + 1}${total > 1 ? ` of ${total}` : ''} · ${start}`];
  p.ids.forEach((id, i) => {
    const m = state.index.methodsById.get(id);
    const last = i === p.ids.length - 1;
    const tag = i === 0 && (p.end === 'entry' || p.end === 'dispatch') && e ? `  [${e.label}]` : '';
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

function allPathsText(all, rootInfo, truncated, o = {}) {
  const ordered = all.filter((p) => p.end !== 'dispatch');
  const unlikely = all.filter((p) => p.end === 'dispatch');
  const lines = [(o.heading || pathsHeading)(ordered.length)];
  let group = null;
  ordered.forEach((p, n) => {
    if (p.end !== group) {
      group = p.end;
      lines.push('', `=== ${PATH_GROUPS[group]} (${ordered.filter((x) => x.end === group).length}) ===`);
    }
    lines.push('', ...pathText(p, n, ordered.length, rootInfo));
  });
  if (unlikely.length) {
    const d = unlikely[0].dispatch;
    const names = [...new Set(unlikely.map((p) => state.index.methodsById.get(p.ids[0]).label))];
    lines.push('', `=== Not counted (${unlikely.length}): only if the trigger framework picked ${d.handler} ===`,
      `These triggers reach it only through ${d.via}, which picks the handler at run time; they use other handlers:`,
      `  ${names.join(', ')}`);
  }
  if (truncated) lines.push('', 'Not every path is listed: some methods are reached by more paths than this.');
  lines.push('', o.footer || COPY_FOOTER);
  return lines.join('\n');
}

// src: a step of a debug log, { kind: 'class' | 'trigger', name, qual, method }. The Code Flow scan's methods
// with that name (every overload: the log doesn't say which one ran).
function methodIdsOfLogStep(src) {
  const idx = state.index;
  if (!idx || !src) return [];
  if (src.kind === 'trigger') {
    const m = idx.methods.find((x) => x.kind === 'trigger' && x.file.unit.name.toLowerCase() === String(src.name).toLowerCase());
    return m ? [m.id] : [];
  }
  const qual = String(src.qual || src.name || '').toLowerCase();
  const short = qual.split('.').pop();
  const types = (idx.typesByShortName.get(short) || []).filter((t) => t.kind !== 'trigger');
  const type = types.find((t) => t.display.toLowerCase() === qual) || types[0];
  if (!type) return [];
  const name = String(src.method || type.name).toLowerCase();
  return (type.methodsByName.get(name) || []).map((m) => m.id);
}

// The entry paths view of Code Flow for one method, for Debug Logs: same cards and copy buttons;
// clicking a step calls onStep({ kind, name, qual, method, line }) so the log's code panel shows it.
async function logEntryPaths(src, onStep) {
  try { await state.indexPromise; } catch { return { error: 'The Apex scan didn’t finish, so the callers aren’t known.' }; }
  const ids = methodIdsOfLogStep(src);
  if (!ids.length) return { error: 'This step isn’t in the scanned Apex (managed package, or changed since the scan).' };
  const { paths, truncated } = classifyPaths(state.index.entryPaths(ids, pathOpts()));
  const m = state.index.methodsById.get(ids[0]);
  const org = state.mode === 'demo' ? 'demo org' : state.session?.apiHost;
  const heading = (count) => `Who calls ${signatureOf(m)}${ids.length > 1 ? ` (${ids.length} overloads)` : ''}\n${count === 1 ? 'One code path' : `${count} code paths`}, from the entry point down${org ? ` · ${org}` : ''}`;
  const stepOf = (id, info) => {
    const x = state.index.methodsById.get(id);
    const unit = x.file.unit;
    const line = info?.via?.lines?.length ? Math.min(...info.via.lines) : x.startLine;
    return unit.kind === 'trigger'
      ? { kind: 'trigger', name: unit.name, qual: unit.name, line }
      : { kind: 'class', name: unit.name, qual: x.type.display, method: x.kind === 'constructor' ? x.type.name : x.name, line, label: x.label };
  };
  const el = renderPaths(paths, null, truncated, {
    heading,
    footer: '(Copied from Salesforce OG Debugger · Debug Logs)',
    onStep: (key, id, info) => {
      for (const c of el.querySelectorAll('.step-chip.selected')) c.classList.remove('selected');
      for (const c of el.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) c.classList.add('selected');
      onStep(stepOf(id, info));
    },
  });
  return { el, count: paths.filter((p) => p.end !== 'dispatch').length, label: m.label, overloads: ids.length };
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
function sourcePre(lines, range, marks, method, file) {
  const links = file && state.index ? linksFor(file) : null;
  const pre = h('pre', { class: 'src' });
  let inBlock = false;
  for (let n = 1; n < range[0]; n++) inBlock = highlight(lines[n - 1] ?? '', inBlock).inBlock;
  for (let n = range[0]; n <= range[1]; n++) {
    const { html, inBlock: ib } = highlight(lines[n - 1] ?? '', inBlock, marks.hlCols.get(n), links?.byLine.get(n));
    inBlock = ib;
    const txt = h('span', { class: 'txt' });
    txt.innerHTML = html || ' ';
    const inMethod = method && n >= method[0] && n <= method[1];
    pre.append(h('div', { class: `row${marks.hlLines.has(n) ? ' ' + marks.hlClass : ''}${inMethod ? ' in-method' : ''}`, 'data-line': n },
      h('span', { class: 'gutter' }, n), txt));
  }
  if (links) wireLinks(pre, links, codeLinkHandlers());
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

// the class in OG Explorer, at this method (with back / forward, outline, links, the code looks…)
function explorerButton(m, before) {
  return h('button', {
    class: 'link code-explorer', title: `Open ${m.file.unit.name} in OG Explorer, at ${m.name}`,
    onclick: () => { before?.(); openInExplorer({ type: 'method', id: m.id }, { newTab: true }); },
  }, 'Open in OG Explorer');
}

function showCode(id, info) {
  if (info?.usage) { showUsage(info.usage); return; }
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
      explorerButton(m),
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null),
    marks.items.length ? codeDetails(refsList(marks.items, scrollToLine), codeSummary(info, marks.items.length)) : null);
  const scroller = h('div', { class: 'code-scroll' }, sourcePre(sc.lines, sc.range, marks, sc.whole ? sc.method : null, m.file));
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
      explorerButton(m, () => close()),
      url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null].filter(Boolean));
    scroller = h('div', { class: 'code-scroll fx-src' }, sourcePre(sc.lines, sc.range, marks, sc.whole ? sc.method : null, m.file));
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
