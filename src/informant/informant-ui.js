// The Informant: an API client in the Postman layout. Collections / Environments / History on the left,
// request tabs on top with the environment picker, the request (Params · Authorization · Headers · Body · Settings),
// the response below, and Code / Info on the right. Everything is kept in this browser (localStorage).

import { h, esc } from '../dom.js';
import { resizable } from '../layout.js';
import {
  METHODS, RAW_TYPES, newRequest, newId, kv, splitUrl, joinUrl, paramsFromUrl, resolve, unresolved, wire, isForbiddenHeader,
  parseCurl, toCurl, SNIPPETS, fromPostman, toPostman, formatBytes, statusText, DYNAMIC_VARS,
} from './core.js';
import { OrgRegistry, DemoOrgRegistry, parseOrgHost, isOrgHost, KIND_LABEL, shortName, switchHost, hostOf, groupFamilies, maskToken } from './orgs.js';

const KEY = 'og-informant:v1';
const HISTORY_MAX = 100;
const PRETTY_MAX = 1.5 * 1024 * 1024;
const DEMO_BASE = 'https://demo.informant.dev';

const clone = (x) => JSON.parse(JSON.stringify(x));
const methodClass = (m) => `m-${String(m).toLowerCase()}`;
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6500 : 2600);
}
async function copyText(text, msg = 'Copied') {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(msg, 'ok');
}

// ---------- menus and dialogs ----------
let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.el.remove();
  document.removeEventListener('pointerdown', openMenu.outside, true);
  document.removeEventListener('keydown', openMenu.key, true);
  openMenu = null;
}
function menu(anchor, items, { align = 'start' } = {}) {
  closeMenu();
  const el = h('div', { class: 'dx-pop inf-menu', role: 'menu' }, items.filter(Boolean).map((it) => (it === '-' ? h('div', { class: 'inf-menu-sep' })
    : h('button', { type: 'button', role: 'menuitem', class: `dx-mi${it.danger ? ' danger' : ''}`, onclick: () => { closeMenu(); it.run(); } },
      h('span', { class: 'dx-mi-icon', 'aria-hidden': 'true' }, it.icon || ''), h('span', {}, it.label), it.hint ? h('span', { class: 'dx-mi-hint' }, it.hint) : null))));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(align === 'end' ? r.right - w : r.left, innerWidth - w - 8))}px`;
  const top = r.bottom + 4;
  el.style.top = `${top + el.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 4) : top}px`;
  const outside = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  openMenu = { el, outside, key };
  el.querySelector('button')?.focus();
}
function modal(title, body, actions, { wide = false } = {}) {
  const card = h('div', { class: `dx-modal-card inf-modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', {}, title), body, actions ? h('div', { class: 'dx-modal-actions' }, actions) : null);
  const wrap = h('div', { class: 'dx-modal' }, card);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.append(wrap);
  setTimeout(() => (card.querySelector('[data-autofocus]') || card.querySelector('input, textarea, select'))?.focus(), 0);
  return { close, card };
}
function prompt(title, value, okLabel = 'Save') {
  return new Promise((resolveP) => {
    const input = h('input', { type: 'text', class: 'inf-in', value, spellcheck: 'false', 'data-autofocus': '' });
    const ok = h('button', { class: 'primary' }, okLabel);
    const m = modal(title, h('div', {}, input), [h('button', { class: 'ghost', onclick: () => { m.close(); resolveP(null); } }, 'Cancel'), ok]);
    const done = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } m.close(); resolveP(v); };
    ok.addEventListener('click', done);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
    setTimeout(() => input.select(), 10);
  });
}

// ---------- the demo server (demo mode only): https://demo.informant.dev ----------
const DEMO_DB = {
  accounts: [
    { Id: '0015g0000000001AAA', Name: 'Acme Corp', Industry: 'Banking', AnnualRevenue: 47900000 },
    { Id: '0015g0000000002AAA', Name: 'Globex Health', Industry: 'Healthcare', AnnualRevenue: 41600000 },
    { Id: '0015g0000000003AAA', Name: 'Initech Energy', Industry: 'Energy', AnnualRevenue: 25400000 },
  ],
};
// a wait that Cancel / timeouts can stop, like a real fetch
const demoWait = (ms, signal) => new Promise((resolveW, reject) => {
  const t = setTimeout(resolveW, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});
async function demoFetch(url, init, ctx = {}) {
  await demoWait(180 + Math.random() * 220, init.signal);
  const u = new URL(url);
  const json = (status, body, extra = {}) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json;charset=UTF-8', 'x-demo-server': 'informant', ...extra } });
  const rawAuth = new Headers(init.headers).get('authorization');
  const auth = rawAuth && !/\{\{/.test(rawAuth) ? rawAuth : null; // an unfilled {{token}} isn't a token
  const path = u.pathname.replace(/\/+$/, '');
  // one of the demo orgs: only its own session token gets in, like a real org
  if (ctx.org) {
    if (!ctx.token || auth !== `Bearer ${ctx.token}`) return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
    const who = { org: ctx.org.name, mydomain: ctx.org.apiHost, instance: ctx.org.instance, sandbox: !!ctx.org.isSandbox };
    if (/\/limits$/.test(path)) return json(200, { DailyApiRequests: { Max: ctx.org.isSandbox ? 5000000 : 15000, Remaining: ctx.org.isSandbox ? 4999810 : 14872 }, DataStorageMB: { Max: ctx.org.isSandbox ? 204800 : 1024, Remaining: 990 }, _org: who });
    if (/\/query$/.test(path)) return json(200, { totalSize: DEMO_DB.accounts.length, done: true, records: DEMO_DB.accounts.map((a) => ({ attributes: { type: 'Account' }, Id: a.Id, Name: `${a.Name}${ctx.org.isSandbox ? ` (${shortName(ctx.org)})` : ''}` })) });
    if (path.includes('/apexrest/')) {
      // the endpoint only exists where it was deployed: a newer version on preprod, none on the developer org
      const name = path.split('/apexrest/')[1];
      if (parseOrgHost(ctx.org.apiHost)?.kind === 'developer') return json(404, [{ errorCode: 'NOT_FOUND', message: `Could not find a match for URL /${name}` }]);
      return json(200, { service: name, version: ctx.org.isSandbox ? '2.4 (in testing)' : '2.3', params: Object.fromEntries(u.searchParams), ...who });
    }
    if (path.startsWith('/services/data')) return json(200, { ...who, path });
    return json(404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
  }
  if (path === '/echo') {
    const headers = Object.fromEntries(new Headers(init.headers));
    let body = init.body;
    if (body instanceof FormData) body = Object.fromEntries(body);
    return json(200, { method: init.method, url, query: Object.fromEntries(u.searchParams), headers, body: typeof body === 'string' && /^\s*[[{]/.test(body) ? safeParse(body) : body ?? null });
  }
  if (path === '/html') return new Response('<!doctype html><h1 style="font-family:sans-serif">Hello from the demo server</h1><p>HTML responses show up in Preview.</p>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (path.startsWith('/accounts')) {
    if (!auth) return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
    const id = path.split('/')[2];
    if (init.method === 'GET' && !id) {
      const limit = Number(u.searchParams.get('limit')) || DEMO_DB.accounts.length;
      return json(200, { totalSize: DEMO_DB.accounts.length, done: true, records: DEMO_DB.accounts.slice(0, limit) });
    }
    if (init.method === 'POST' && !id) {
      const body = safeParse(init.body) || {};
      if (!body.Name) return json(400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] }]);
      const rec = { Id: `0015g000000${String(DEMO_DB.accounts.length + 1).padStart(4, '0')}AAA`, ...body };
      DEMO_DB.accounts.push(rec);
      return json(201, { id: rec.Id, success: true, errors: [] });
    }
    const rec = DEMO_DB.accounts.find((a) => a.Id === id);
    if (!rec) return json(404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]);
    if (init.method === 'GET') return json(200, rec);
    if (init.method === 'PATCH') { Object.assign(rec, safeParse(init.body) || {}); return new Response(null, { status: 204 }); }
    if (init.method === 'DELETE') { DEMO_DB.accounts.splice(DEMO_DB.accounts.indexOf(rec), 1); return new Response(null, { status: 204 }); }
  }
  if (path === '/slow') { await demoWait(4000, init.signal); return json(200, { ok: true }); }
  // a pretend Salesforce org behind {{$sfInstanceUrl}} in demo mode
  if (path.startsWith('/sf/services/')) {
    if (!auth) return json(401, [{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]);
    if (/\/limits$/.test(path)) return json(200, { DailyApiRequests: { Max: 15000, Remaining: 14872 }, DataStorageMB: { Max: 1024, Remaining: 990 }, SingleEmail: { Max: 5000, Remaining: 5000 } });
    if (/\/query$/.test(path)) return json(200, { totalSize: DEMO_DB.accounts.length, done: true, records: DEMO_DB.accounts.map((a) => ({ attributes: { type: 'Account', url: `/services/data/v62.0/sobjects/Account/${a.Id}` }, Id: a.Id, Name: a.Name })) });
    if (/\/describe$/.test(path)) return json(200, { name: 'Account', label: 'Account', fields: [{ name: 'Id', type: 'id' }, { name: 'Name', type: 'string', length: 255 }, { name: 'Industry', type: 'picklist' }] });
    if (path.includes('/apexrest/')) return json(200, { message: 'Hello from Apex REST (demo org)', params: Object.fromEntries(u.searchParams) });
  }
  return json(404, { error: 'Not found', hint: 'Try /accounts, /echo, /html or /slow' });
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// ---------- starter content ----------
function seed(sf) {
  const sfCol = {
    id: newId(), name: 'Salesforce (this org)', open: true, vars: [], auth: { ...newRequest().auth, type: 'sfsession' },
    requests: [
      newRequest({ name: 'Org limits', url: '{{$sfInstanceUrl}}/services/data/{{$sfApiVersion}}/limits' }),
      newRequest({ name: 'SOQL query', url: '{{$sfInstanceUrl}}/services/data/{{$sfApiVersion}}/query?q=SELECT+Id,Name+FROM+Account+LIMIT+5' }),
      newRequest({ name: 'Describe Account', url: '{{$sfInstanceUrl}}/services/data/{{$sfApiVersion}}/sobjects/Account/describe' }),
      newRequest({
        name: 'Apex REST (example)', method: 'GET', url: '{{$sfInstanceUrl}}/services/apexrest/MyService?param=value',
        headers: [kv('Content-Type', 'application/json')],
      }),
    ],
  };
  for (const r of sfCol.requests) r.params = paramsFromUrl(r.url);
  const demoCol = {
    id: newId(), name: 'OG samples (demo server)', open: !sf, vars: [kv('base', DEMO_BASE)], auth: { ...newRequest().auth, type: 'bearer', bearer: '{{token}}' },
    requests: [
      newRequest({ name: 'List accounts', url: '{{base}}/accounts?limit=2' }),
      newRequest({ name: 'Create account', method: 'POST', url: '{{base}}/accounts', body: { ...newRequest().body, mode: 'raw', rawType: 'json', raw: '{\n  "Name": "Stark Labs",\n  "Industry": "Technology"\n}' } }),
      newRequest({ name: 'Get account', url: '{{base}}/accounts/{{accountId}}' }),
      newRequest({ name: 'Echo (see what was sent)', method: 'POST', url: '{{base}}/echo?from=informant', headers: [kv('X-Trace-Id', '{{$guid}}')], body: { ...newRequest().body, mode: 'urlencoded', urlencoded: [kv('grant_type', 'password'), kv('username', 'keshav@example.com')] } }),
      newRequest({ name: 'HTML preview', url: '{{base}}/html' }),
      newRequest({ name: 'Slow request (try Cancel)', url: '{{base}}/slow' }),
    ],
  };
  for (const r of demoCol.requests) r.params = paramsFromUrl(r.url);
  // the demo server's token lives in the OG samples collection itself, so no environment is needed by default
  demoCol.vars.push(kv('token', 'demo-token-123'), kv('accountId', '0015g0000000001AAA'));
  const envs = [{ id: newId(), name: 'My variables', vars: [] }];
  return { v: 2, collections: sf ? [sfCol, demoCol] : [demoCol, sfCol], envs, globals: [], activeEnv: null, activeOrg: null, history: [], tabs: [], activeTab: null, side: 'collections', right: null, snippet: 'curl', resolveSnippet: false };
}

// v1 seeded a "Demo" environment (token demo-token-123) and selected it, even in real orgs: move it into the samples
function migrate(D) {
  if ((D.v || 1) >= 2) return D;
  const demoEnv = D.envs.find((e) => e.name === 'Demo' && e.vars.some((x) => x.v === 'demo-token-123'));
  const samples = D.collections.find((c) => /OG samples/.test(c.name));
  if (demoEnv && samples) {
    for (const x of demoEnv.vars) if (!samples.vars.some((y) => y.k === x.k)) samples.vars.push(x);
    D.envs = D.envs.filter((e) => e !== demoEnv);
    if (D.activeEnv === demoEnv.id) D.activeEnv = null;
  }
  D.v = 2;
  return D;
}

// ---------- mount ----------
export function mountInformant(root, { getSalesforce, demo }) {
  let D;
  try { D = JSON.parse(localStorage.getItem(KEY)); } catch { D = null; }
  if (!D || !Array.isArray(D.collections)) D = seed(!demo);
  D = migrate(D);
  D.tabs ||= [];

  // every org this browser is logged into; the one this tab was opened from starts selected
  const current = demo ? null : getSalesforce?.();
  const orgs = demo ? new DemoOrgRegistry() : new OrgRegistry({ currentHost: current?.apiHost });
  if (current?.apiHost) orgs.tokens.set(current.apiHost.toLowerCase(), current.sessionId); // usable before discovery finishes
  D.activeOrg = orgs.currentHost || D.activeOrg || null;
  // find the orgs once the view is built (the list can arrive right away)
  setTimeout(() => {
    orgs.onChange(() => { if (root.isConnected) { drawOrgPick(); drawOrgBits(); } });
    orgs.refreshAll().then(() => {
      if (!D.activeOrg && orgs.orgs[0]) D.activeOrg = orgs.orgs[0].apiHost;
      drawOrgPick(); drawEditor(); drawRight();
    });
  }, 0);
  const live = new Map(); // tab id -> { response, sending, controller } (not saved)
  const el = {};
  let saveT = 0;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(D)); } catch (e) { toast(`Couldn’t save to this browser: ${e.message}`, 'error'); }
    }, 250);
  };

  // the selected org: {{$sfInstanceUrl}}, {{$sfApiVersion}} and {{$sfSessionId}} point at it
  const activeOrg = () => orgs.byHost(D.activeOrg) || (D.activeOrg ? { apiHost: D.activeOrg, status: 'unknown' } : null);
  const sfExtra = () => {
    const o = activeOrg();
    if (!o) return {};
    return { $sfInstanceUrl: `https://${o.apiHost}`, $sfApiVersion: o.version || current?.version || 'v62.0', $sfSessionId: orgs.token(o.apiHost) || '' };
  };
  // the org a request goes to: its URL's host when that's a known org, otherwise the selected one
  const orgOfTab = (t) => {
    if (!t) return activeOrg();
    const host = hostOf(resolve(t.draft.url, scopes(t), sfExtra()));
    return orgs.byHost(host) || (isOrgHost(host) ? { apiHost: host, status: 'unknown' } : activeOrg());
  };
  // "Salesforce session" auth sends the token of the org the request goes to, never another org's
  const sfFor = (t) => {
    const o = orgOfTab(t);
    return o ? { sessionId: orgs.token(o.apiHost), apiHost: o.apiHost, version: o.version, org: o } : null;
  };
  const sf = () => sfFor(tab());
  const colOf = (id) => D.collections.find((c) => c.id === id) || null;
  const envOf = (id) => D.envs.find((e) => e.id === id) || null;
  const tab = () => D.tabs.find((t) => t.id === D.activeTab) || null;
  const scopes = (t) => [envOf(D.activeEnv)?.vars, colOf(t?.colId)?.vars, D.globals].filter(Boolean);
  const resolver = (t) => (s) => resolve(s, scopes(t), sfExtra());
  const inherited = (t) => colOf(t?.colId)?.auth || { type: 'none' };
  const isDirty = (t) => t.saved !== JSON.stringify(stripId(t.draft));
  const stripId = (r) => { const { id, ...rest } = r; void id; return rest; };

  // ---------- layout ----------
  root.replaceChildren(
    el.rail = h('nav', { class: 'inf-rail', 'aria-label': 'The Informant sidebar' }),
    el.side = h('aside', { class: 'inf-side' }),
    el.main = h('section', { class: 'inf-main' },
      h('div', { class: 'inf-tabbar' },
        el.tabs = h('div', { class: 'inf-tabs', role: 'tablist' }),
        h('button', { class: 'inf-tab-add', title: 'New request', 'aria-label': 'New request', onclick: () => openRequest(newRequest(), null) }, '+'),
        h('span', { class: 'inf-grow' }),
        el.orgPick = h('button', { class: 'inf-orgpick', 'aria-haspopup': 'dialog', title: 'Salesforce orgs you’re logged into', onclick: (e) => openOrgs(e.currentTarget) }),
        el.envPick = h('select', { class: 'inf-envpick', 'aria-label': 'Environment', onchange: (e) => { D.activeEnv = e.target.value || null; save(); drawEnvPick(); drawEditor(); drawRight(); drawSide(); } }),
        el.envEye = h('button', { class: 'inf-iconbtn', title: 'Quick look at the variables', 'aria-label': 'Quick look', onclick: (e) => quickLook(e.currentTarget) }, '👁')),
      el.work = h('div', { class: 'inf-work' })),
    el.right = h('aside', { class: 'inf-rpanel', hidden: true }),
    el.rrail = h('nav', { class: 'inf-rrail', 'aria-label': 'Tools' }));
  root.append(resizable({
    handle: h('div', { class: 'inf-split-side' }), pane: el.side, host: root, cssVar: '--inf-side', edge: 'end',
    min: 220, max: () => root.clientWidth * 0.4, key: 'ff-split-inf-side', label: 'Resize the sidebar',
  }));

  // ---------- left rail + sidebar ----------
  function drawRail() {
    const b = (k, icon, label) => h('button', {
      class: 'inf-rail-btn', 'aria-pressed': String(D.side === k), title: label,
      onclick: () => { D.side = D.side === k && !el.side.hidden ? k : k; el.side.hidden = false; save(); drawRail(); drawSide(); },
    }, h('span', { class: 'inf-rail-i', 'aria-hidden': 'true' }, icon), h('span', { class: 'inf-rail-t' }, label));
    el.rail.replaceChildren(
      h('div', { class: 'inf-brand', title: 'The Informant: an API client for Salesforce developers' }, h('span', { 'aria-hidden': 'true' }, '🕴️')),
      b('collections', '▤', 'Collections'), b('envs', '⊙', 'Environments'), b('history', '⟲', 'History'));
  }

  function drawSide() {
    const k = D.side;
    if (k === 'collections') drawCollections();
    else if (k === 'envs') drawEnvs();
    else drawHistory();
  }

  let filter = '';
  function sideHead(title, tools, withFilter = true) {
    const f = withFilter ? h('input', {
      type: 'search', class: 'inf-filter', placeholder: 'Filter', value: filter, 'aria-label': 'Filter',
      oninput: (e) => { filter = e.target.value; drawSide(); setTimeout(() => el.side.querySelector('.inf-filter')?.focus(), 0); },
    }) : null;
    return h('div', { class: 'inf-side-head' },
      h('div', { class: 'inf-side-title' }, h('b', {}, title), h('span', { class: 'inf-grow' }), tools),
      f);
  }

  function drawCollections() {
    const q = filter.trim().toLowerCase();
    const list = h('div', { class: 'inf-tree', role: 'tree' });
    for (const c of D.collections) {
      const reqs = c.requests.filter((r) => !q || `${r.name} ${r.url} ${r.method}`.toLowerCase().includes(q));
      if (q && !reqs.length && !c.name.toLowerCase().includes(q)) continue;
      const open = c.open || !!q;
      const head = h('div', { class: 'inf-col', role: 'treeitem', 'aria-expanded': String(open), tabindex: '0',
        onclick: () => { c.open = !c.open; save(); drawSide(); },
        onkeydown: (e) => { if (e.key === 'Enter') { c.open = !c.open; save(); drawSide(); } } },
      h('span', { class: 'inf-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      h('span', { class: 'inf-col-name' }, c.name),
      c.auth?.type === 'sfsession' ? h('span', { class: 'inf-sf', title: 'Requests use your Salesforce session' }, 'SF') : null,
      h('button', { class: 'inf-dots', title: 'More', 'aria-label': `More for ${c.name}`, onclick: (e) => { e.stopPropagation(); colMenu(e.currentTarget, c); } }, '⋯'));
      list.append(head);
      if (!open) continue;
      const items = h('div', { class: 'inf-col-items', role: 'group' });
      for (const r of reqs) {
        const active = tab()?.reqId === r.id;
        items.append(h('div', {
          class: `inf-req${active ? ' active' : ''}`, role: 'treeitem', tabindex: '0', title: r.url,
          onclick: () => openSaved(c, r), onkeydown: (e) => { if (e.key === 'Enter') openSaved(c, r); },
        }, h('span', { class: `inf-m ${methodClass(r.method)}` }, r.method === 'DELETE' ? 'DEL' : r.method === 'OPTIONS' ? 'OPT' : r.method),
        h('span', { class: 'inf-req-name' }, r.name),
        h('button', { class: 'inf-dots', title: 'More', 'aria-label': `More for ${r.name}`, onclick: (e) => { e.stopPropagation(); reqMenu(e.currentTarget, c, r); } }, '⋯')));
      }
      if (!c.requests.length) items.append(h('button', { class: 'inf-empty-add', onclick: () => openRequest(newRequest(), c.id) }, 'This collection is empty. Add a request'));
      list.append(items);
    }
    if (!list.childElementCount) list.append(h('p', { class: 'inf-side-empty' }, q ? 'Nothing matches.' : 'No collections yet.'));
    el.side.replaceChildren(
      sideHead('Collections', [
        h('button', { class: 'inf-iconbtn', title: 'New collection', 'aria-label': 'New collection', onclick: newCollection }, '+'),
        h('button', { class: 'ghost small', onclick: () => openImport() }, 'Import'),
      ]),
      list);
  }

  async function newCollection() {
    const name = await prompt('New collection', 'New Collection', 'Create');
    if (!name) return;
    D.collections.push({ id: newId(), name, open: true, vars: [], auth: { ...newRequest().auth, type: 'none' }, requests: [] });
    save(); drawSide();
  }

  function colMenu(anchor, c) {
    menu(anchor, [
      { icon: '+', label: 'Add request', run: () => openRequest(newRequest(), c.id) },
      { icon: '✎', label: 'Rename', run: async () => { const n = await prompt('Rename collection', c.name); if (n) { c.name = n; save(); drawSide(); } } },
      { icon: '{}', label: 'Variables', hint: String(c.vars.length), run: () => editVars(`Variables of ${c.name}`, c.vars, (v) => { c.vars = v; }) },
      { icon: '🔑', label: 'Authorization', hint: authLabel(c.auth), run: () => editCollectionAuth(c) },
      '-',
      { icon: '⧉', label: 'Duplicate', run: () => { const copy = clone(c); copy.id = newId(); copy.name = `${c.name} copy`; for (const r of copy.requests) r.id = newId(); D.collections.push(copy); save(); drawSide(); } },
      { icon: '⤓', label: 'Export (Postman v2.1)', run: () => download(`${c.name}.postman_collection.json`, JSON.stringify(toPostman(c), null, 2)) },
      { icon: '⧉', label: 'Copy as Postman JSON', run: () => copyText(JSON.stringify(toPostman(c), null, 2), 'Collection copied: paste it into Postman or another Informant') },
      '-',
      { icon: '🗑', label: 'Delete', danger: true, run: () => confirmDo(`Delete “${c.name}”?`, `Its ${c.requests.length} request${c.requests.length === 1 ? '' : 's'} will be deleted too.`, () => {
        D.collections = D.collections.filter((x) => x !== c);
        for (const t of D.tabs) if (t.colId === c.id) { t.colId = null; t.reqId = null; t.saved = ''; }
        save(); drawAll();
      }) },
    ]);
  }

  function reqMenu(anchor, c, r) {
    menu(anchor, [
      { icon: '↗', label: 'Open in a new tab', run: () => openSaved(c, r, true) },
      { icon: '✎', label: 'Rename', run: async () => { const n = await prompt('Rename request', r.name); if (n) { r.name = n; for (const t of D.tabs) if (t.reqId === r.id) { t.draft.name = n; t.saved = JSON.stringify(stripId(r)); } save(); drawAll(); } } },
      { icon: '⧉', label: 'Duplicate', run: () => { const copy = { ...clone(r), id: newId(), name: `${r.name} copy` }; c.requests.splice(c.requests.indexOf(r) + 1, 0, copy); save(); drawSide(); } },
      { icon: '⌘', label: 'Copy as cURL', run: () => copyText(toCurl(r, (s) => s, { inheritedAuth: c.auth }), 'cURL copied') },
      '-',
      { icon: '🗑', label: 'Delete', danger: true, run: () => confirmDo(`Delete “${r.name}”?`, null, () => {
        c.requests = c.requests.filter((x) => x !== r);
        for (const t of D.tabs) if (t.reqId === r.id) { t.reqId = null; t.colId = null; t.saved = ''; }
        save(); drawAll();
      }) },
    ]);
  }

  function confirmDo(title, text, run) {
    const go = h('button', { class: 'primary danger', 'data-autofocus': '' }, 'Delete');
    const m = modal(title, text ? h('p', { class: 'dx-muted' }, text) : h('div'), [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go]);
    go.addEventListener('click', () => { m.close(); run(); });
  }

  function drawEnvs() {
    const q = filter.trim().toLowerCase();
    const row = (env, isGlobals) => {
      const active = !isGlobals && D.activeEnv === env.id;
      return h('div', { class: `inf-env${active ? ' active' : ''}`, tabindex: '0', title: isGlobals ? 'Available in every request' : 'Click to edit its variables',
        onclick: () => editVars(isGlobals ? 'Globals' : env.name, isGlobals ? D.globals : env.vars, (v) => { if (isGlobals) D.globals = v; else env.vars = v; }),
        onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); } },
      h('span', { class: 'inf-env-i', 'aria-hidden': 'true' }, isGlobals ? '🌐' : '⊙'),
      h('span', { class: 'inf-env-name' }, isGlobals ? 'Globals' : env.name),
      h('span', { class: 'inf-env-n' }, (isGlobals ? D.globals : env.vars).length),
      isGlobals ? null : h('button', {
        class: `inf-env-use${active ? ' on' : ''}`, title: active ? 'Active environment' : 'Use this environment', 'aria-label': active ? 'Active' : 'Use',
        onclick: (e) => { e.stopPropagation(); D.activeEnv = active ? null : env.id; save(); drawEnvPick(); drawSide(); drawEditor(); drawRight(); },
      }, '✓'),
      isGlobals ? null : h('button', { class: 'inf-dots', title: 'More', 'aria-label': `More for ${env.name}`, onclick: (e) => { e.stopPropagation(); envMenu(e.currentTarget, env); } }, '⋯'));
    };
    el.side.replaceChildren(
      sideHead('Environments', [h('button', { class: 'inf-iconbtn', title: 'New environment', 'aria-label': 'New environment', onclick: newEnv }, '+')]),
      h('div', { class: 'inf-tree' },
        row(null, true),
        ...D.envs.filter((e) => !q || e.name.toLowerCase().includes(q)).map((e) => row(e, false)),
        D.envs.length ? null : h('p', { class: 'inf-side-empty' }, 'No environments yet. Use one to switch between sandboxes and production with the same requests.'),
        h('p', { class: 'inf-side-tip' }, 'Built-in: ', [...DYNAMIC_VARS, ...Object.keys(sfExtra())].map((n) => h('code', {}, `{{${n}}}`)))));
  }

  async function newEnv() {
    const name = await prompt('New environment', 'New Environment', 'Create');
    if (!name) return;
    const env = { id: newId(), name, vars: [] };
    D.envs.push(env);
    if (!D.activeEnv) D.activeEnv = env.id;
    save(); drawSide(); drawEnvPick();
    editVars(name, env.vars, (v) => { env.vars = v; });
  }

  function envMenu(anchor, env) {
    menu(anchor, [
      { icon: '✎', label: 'Rename', run: async () => { const n = await prompt('Rename environment', env.name); if (n) { env.name = n; save(); drawSide(); drawEnvPick(); } } },
      { icon: '⧉', label: 'Duplicate', run: () => { D.envs.push({ ...clone(env), id: newId(), name: `${env.name} copy` }); save(); drawSide(); drawEnvPick(); } },
      { icon: '⤓', label: 'Export', run: () => download(`${env.name}.postman_environment.json`, JSON.stringify({ name: env.name, values: env.vars.map((x) => ({ key: x.k, value: x.v, enabled: x.on })) }, null, 2)) },
      '-',
      { icon: '🗑', label: 'Delete', danger: true, run: () => confirmDo(`Delete “${env.name}”?`, null, () => { D.envs = D.envs.filter((x) => x !== env); if (D.activeEnv === env.id) D.activeEnv = null; save(); drawSide(); drawEnvPick(); drawEditor(); }) },
    ]);
  }

  function drawHistory() {
    const q = filter.trim().toLowerCase();
    const items = D.history.filter((x) => !q || `${x.method} ${x.url}`.toLowerCase().includes(q));
    const groups = new Map();
    for (const x of items) {
      const day = new Date(x.at).toDateString() === new Date().toDateString() ? 'Today' : new Date(x.at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(x);
    }
    let armed = false;
    el.side.replaceChildren(
      sideHead('History', [D.history.length ? h('button', {
        class: 'ghost small', title: 'Remove every entry',
        onclick: (e) => {
          if (!armed) { armed = true; e.currentTarget.textContent = 'Sure?'; e.currentTarget.classList.add('armed'); setTimeout(() => { armed = false; if (e.target.isConnected) { e.target.textContent = 'Clear'; e.target.classList.remove('armed'); } }, 2500); return; }
          D.history = []; save(); drawSide();
        },
      }, 'Clear') : null]),
      h('div', { class: 'inf-tree' },
        ...[...groups].map(([day, list]) => [h('div', { class: 'inf-hday' }, day), ...list.map((x) => h('div', {
          class: 'inf-req inf-hist', tabindex: '0', title: `${x.url}\n${new Date(x.at).toLocaleString()}`,
          onclick: () => openRequest({ ...clone(x.req), id: newId() }, null), onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); },
        }, h('span', { class: `inf-m ${methodClass(x.method)}` }, x.method === 'DELETE' ? 'DEL' : x.method),
        h('span', { class: 'inf-req-name' }, x.url.replace(/^https?:\/\//, '')),
        h('span', { class: `inf-hstatus s${String(x.status || 0)[0]}` }, x.status || '—')))]).flat(),
        items.length ? null : h('p', { class: 'inf-side-empty' }, q ? 'Nothing matches.' : 'Requests you send show up here.')));
  }

  // ---------- tabs ----------
  function openRequest(req, colId) {
    const t = { id: newId(), colId, reqId: null, draft: req, saved: '', sub: 'params', resTab: 'body', resView: 'pretty' };
    if (colId) {
      const c = colOf(colId);
      c.requests.push(req);
      t.reqId = req.id;
      t.saved = JSON.stringify(stripId(req));
      c.open = true;
    }
    D.tabs.push(t);
    D.activeTab = t.id;
    save();
    drawAll();
    setTimeout(() => el.work.querySelector('.inf-url-in')?.focus(), 0);
  }

  function openSaved(c, r, forceNew = false) {
    const existing = !forceNew && D.tabs.find((t) => t.reqId === r.id);
    if (existing) { D.activeTab = existing.id; save(); drawAll(); return; }
    const t = { id: newId(), colId: c.id, reqId: r.id, draft: clone(r), saved: JSON.stringify(stripId(r)), sub: 'params', resTab: 'body', resView: 'pretty' };
    D.tabs.push(t);
    D.activeTab = t.id;
    save();
    drawAll();
  }

  function closeTab(t) {
    const go = () => {
      const i = D.tabs.indexOf(t);
      live.get(t.id)?.controller?.abort();
      live.delete(t.id);
      D.tabs.splice(i, 1);
      if (D.activeTab === t.id) D.activeTab = D.tabs[Math.min(i, D.tabs.length - 1)]?.id || null;
      save(); drawAll();
    };
    if (!isDirty(t) || !t.draft.url && !t.reqId) { go(); return; }
    const m = modal('Close without saving?', h('p', { class: 'dx-muted' }, `“${t.draft.name}” has changes that aren’t saved.`), [
      h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'ghost danger-text', onclick: () => { m.close(); go(); } }, 'Don’t save'),
      h('button', { class: 'primary', onclick: async () => { m.close(); if (await saveTab(t)) go(); } }, 'Save'),
    ]);
  }

  function drawTabs() {
    el.tabs.replaceChildren(...D.tabs.map((t) => {
      const dirty = isDirty(t);
      const sending = live.get(t.id)?.sending;
      const node = h('div', {
        class: `inf-tab${t.id === D.activeTab ? ' active' : ''}`, role: 'tab', tabindex: '0', 'aria-selected': String(t.id === D.activeTab), title: t.draft.url || t.draft.name,
        onclick: () => { D.activeTab = t.id; save(); drawAll(); },
        onauxclick: (e) => { if (e.button === 1) closeTab(t); },
        onkeydown: (e) => { if (e.key === 'Enter') e.currentTarget.click(); },
      },
      h('span', { class: `inf-m ${methodClass(t.draft.method)}` }, t.draft.method),
      h('span', { class: 'inf-tab-name' }, t.draft.name || 'Untitled request'),
      sending ? h('span', { class: 'lg-spinner inf-tab-spin' }) : dirty ? h('span', { class: 'inf-dirty', title: 'Not saved' }) : null,
      h('button', { class: 'inf-tab-x', title: 'Close', 'aria-label': `Close ${t.draft.name}`, onclick: (e) => { e.stopPropagation(); closeTab(t); } }, '×'));
      return node;
    }));
    el.tabs.querySelector('.inf-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function drawEnvPick() {
    el.envPick.replaceChildren(h('option', { value: '' }, 'No environment'), ...D.envs.map((e) => h('option', { value: e.id, selected: e.id === D.activeEnv }, e.name)));
    el.envPick.value = D.activeEnv || '';
  }

  // ---------- orgs: picker, drawer, URL switcher ----------
  const STATUS = { valid: ['ok', 'Session active'], expired: ['bad', 'Session expired: log in again'], signedout: ['off', 'Not logged in in this browser'], error: ['warn', 'Couldn’t check the session'], unknown: ['wait', 'Checking…'] };
  const orgDot = (o) => h('span', { class: `inf-odot ${STATUS[o?.status || 'unknown'][0]}`, title: STATUS[o?.status || 'unknown'][1] });
  const kindOf = (o) => parseOrgHost(o.apiHost)?.kind || 'other';
  const kindTag = (o) => h('span', { class: `inf-okind k-${kindOf(o)}` }, KIND_LABEL[kindOf(o)] || 'Org');

  function drawOrgPick() {
    if (!el.orgPick) return;
    const t = tab();
    const o = orgOfTab(t);
    el.orgPick.replaceChildren(...(o
      ? [orgDot(o), h('span', { class: 'inf-orgpick-name' }, shortName(o)), h('span', { class: 'inf-orgpick-fam' }, parseOrgHost(o.apiHost)?.family || o.apiHost), h('span', { 'aria-hidden': 'true' }, '▾')]
      : [h('span', { class: 'inf-orgpick-name' }, orgs.orgs.length ? 'Pick an org' : 'No Salesforce org'), h('span', { 'aria-hidden': 'true' }, '▾')]));
    el.orgPick.title = o ? `${o.name || o.apiHost} · ${STATUS[o.status || 'unknown'][1]}` : 'Salesforce orgs you’re logged into';
  }

  function drawOrgBits() {
    if (!tab() || !el.urlIn?.isConnected) return;
    drawUrlChip();
    drawTokenBanner();
    if (tab().sub === 'auth') drawSub();
    drawRight();
  }

  // pick an org for the open request: a Salesforce URL moves to that org's My Domain; the token follows
  function useOrg(host, { quiet = false } = {}) {
    const t = tab();
    D.activeOrg = host;
    if (t && isOrgHost(hostOf(t.draft.url)) && hostOf(t.draft.url) !== host) {
      t.draft.url = switchHost(t.draft.url, host);
      if (!quiet) toast(`Now sending to ${shortName({ apiHost: host })} (${host})`, 'ok');
    }
    save();
    drawTabs(); drawOrgPick(); drawEditor(); drawRight();
  }

  function openOrgs(anchor) {
    closeMenu();
    let sel = orgOfTab(tab())?.apiHost || D.activeOrg;
    let reveal = false;
    let q = '';
    const pop = h('div', { class: 'dx-pop inf-orgs', role: 'dialog', 'aria-label': 'Salesforce orgs' });
    const draw = () => {
      const o = orgs.byHost(sel);
      const tok = o && orgs.token(o.apiHost);
      const fams = groupFamilies(orgs.orgs.filter((x) => !q || `${x.apiHost} ${x.name || ''} ${x.user?.username || ''}`.toLowerCase().includes(q)), sel);
      const detail = o ? h('section', { class: 'inf-odetail' },
        h('div', { class: 'inf-odetail-head' },
          orgDot(o),
          h('div', {}, h('b', {}, o.name || shortName(o)), h('div', { class: 'inf-omuted' }, o.apiHost)),
          h('span', { class: 'inf-grow' }), kindTag(o)),
        h('dl', { class: 'inf-odl' },
          o.user ? [h('dt', {}, 'User'), h('dd', {}, o.user.name || '', o.user.username ? h('span', { class: 'inf-omuted' }, ` · ${o.user.username}`) : null)] : null,
          [h('dt', {}, 'Org'), h('dd', {}, [o.orgType, o.instance].filter(Boolean).join(' · ') || '—', o.orgId ? h('span', { class: 'inf-omuted' }, ` · ${o.orgId}`) : null)],
          [h('dt', {}, 'API'), h('dd', {}, o.version || '—')],
          [h('dt', {}, 'Status'), h('dd', {}, STATUS[o.status || 'unknown'][1], o.checkedAt ? h('span', { class: 'inf-omuted' }, ` · checked ${ago(o.checkedAt)}`) : null)]),
        h('div', { class: 'inf-otoken' },
          h('span', { class: 'inf-otoken-label' }, 'Access token'),
          h('code', { class: 'inf-otoken-val' }, tok ? (reveal ? tok : maskToken(tok)) : 'no session'),
          tok ? h('button', { class: 'inf-iconbtn', title: reveal ? 'Hide' : 'Show the whole token', 'aria-label': reveal ? 'Hide token' : 'Show token', onclick: () => { reveal = !reveal; draw(); } }, reveal ? '🙈' : '👁') : null,
          tok ? h('button', { class: 'inf-iconbtn', title: 'Copy the token', 'aria-label': 'Copy the token', onclick: () => copyText(tok, `Token for ${shortName(o)} copied. It’s your live session: don’t share it`) }, '⧉') : null),
        h('div', { class: 'inf-oacts' },
          h('button', { class: 'primary small', onclick: async (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Refreshing…'; await orgs.refresh(o.apiHost); toast(orgs.byHost(o.apiHost)?.status === 'valid' ? `Token for ${shortName(o)} is fresh` : `Couldn’t refresh: ${STATUS[orgs.byHost(o.apiHost)?.status || 'unknown'][1]}`, orgs.byHost(o.apiHost)?.status === 'valid' ? 'ok' : 'error'); draw(); drawOrgBits(); drawOrgPick(); } }, '↻ Refresh token'),
          o.status !== 'valid' ? h('button', { class: 'ghost small', title: 'Log in in a new tab, then come back and Refresh', onclick: () => openTab(`https://${o.apiHost}/`) }, 'Log in ↗') : h('button', { class: 'ghost small', onclick: () => openTab(`https://${o.apiHost}/`) }, 'Open org ↗'),
          h('span', { class: 'inf-grow' }),
          D.activeOrg === o.apiHost && orgOfTab(tab())?.apiHost === o.apiHost ? h('span', { class: 'inf-ousing' }, '✓ In use') : h('button', { class: 'ghost small', onclick: () => { useOrg(o.apiHost); closeMenu(); } }, 'Use this org'),
          h('button', { class: 'inf-iconbtn', title: 'Forget this org', 'aria-label': 'Forget this org', onclick: () => { orgs.forget(o.apiHost); sel = orgs.orgs[0]?.apiHost; draw(); drawOrgPick(); } }, '🗑'))) : null;
      pop.replaceChildren(...[
        h('div', { class: 'inf-orgs-head' }, h('b', {}, 'Salesforce orgs'), h('span', { class: 'inf-omuted' }, `${orgs.orgs.length} in this browser`), h('span', { class: 'inf-grow' }),
          h('button', { class: 'ghost small', title: 'Look for orgs you logged into since, and check every session', onclick: async (e) => { e.currentTarget.textContent = 'Checking…'; await orgs.refreshAll(); draw(); drawOrgPick(); } }, '↻ Refresh all')),
        orgs.orgs.length > 5 ? h('input', { type: 'search', class: 'inf-filter', placeholder: 'Filter orgs', value: q, oninput: (e) => { q = e.target.value.toLowerCase(); draw(); setTimeout(() => pop.querySelector('.inf-filter')?.focus(), 0); } }) : null,
        detail,
        h('div', { class: 'inf-fams' }, fams.map((f) => h('div', { class: 'inf-fam' },
          h('div', { class: 'inf-fam-head' }, h('span', { class: 'inf-fam-i', 'aria-hidden': 'true' }, '☁'), h('b', {}, f.family), h('span', { class: 'inf-omuted' }, `${f.orgs.length} org${f.orgs.length === 1 ? '' : 's'}`)),
          f.orgs.map((x) => h('button', {
            class: `inf-orow${x.apiHost === sel ? ' sel' : ''}`, title: x.apiHost,
            onclick: () => { sel = x.apiHost; reveal = false; draw(); },
            ondblclick: () => { useOrg(x.apiHost); closeMenu(); },
          }, orgDot(x), h('span', { class: 'inf-orow-name' }, shortName(x)), kindTag(x),
          h('span', { class: 'inf-orow-user' }, x.user?.username || x.name || ''),
          D.activeOrg === x.apiHost ? h('span', { class: 'inf-ousing', title: 'Selected' }, '✓') : null))))),
        orgs.orgs.length ? null : h('p', { class: 'inf-side-empty' }, 'Log in to a Salesforce org in this browser, then click Refresh all.'),
        h('p', { class: 'inf-orgs-tip' }, 'Tokens are your live browser sessions. They’re read fresh each time and never saved. Double-click an org to use it.')].filter(Boolean));
    };
    draw();
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    const key = (e) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    openMenu = { el: pop, outside, key };
  }

  // the chip inside the URL bar: which org this request hits, and a quick switch to its prod/sandboxes
  function drawUrlChip() {
    if (!el.urlChip) return;
    const t = tab();
    const raw = t.draft.url;
    const viaVar = /\{\{\s*\$sfInstanceUrl\s*\}\}/.test(raw);
    const host = hostOf(resolve(raw, scopes(t), sfExtra()));
    const o = orgs.byHost(host) || (isOrgHost(host) ? { apiHost: host, status: 'unknown' } : null);
    el.urlChip.hidden = !o;
    if (!o) return;
    el.urlChip.className = `inf-urlchip k-${kindOf(o)}`;
    el.urlChip.replaceChildren(orgDot(o), h('span', {}, shortName(o)), h('span', { 'aria-hidden': 'true' }, '▾'));
    el.urlChip.title = `${viaVar ? '{{$sfInstanceUrl}} → ' : ''}${o.apiHost} · ${STATUS[o.status || 'unknown'][1]}\nClick to send this request to another org`;
    el.urlChip.onclick = (e) => {
      const fam = parseOrgHost(o.apiHost)?.family;
      const fams = groupFamilies(orgs.orgs, o.apiHost);
      const same = fams.find((f) => f.family === fam)?.orgs || [];
      menu(e.currentTarget, [
        ...fams.flatMap((f, i) => [
          i ? '-' : null,
          { icon: '☁', label: f.family === fam ? `${f.family} (this family)` : f.family, run: () => {}, hint: '' },
          ...f.orgs.map((x) => ({ icon: x.apiHost === o.apiHost ? '✓' : '', label: `   ${shortName(x)} · ${KIND_LABEL[kindOf(x)] || ''}`, hint: x.status === 'valid' ? 'session ok' : STATUS[x.status || 'unknown'][1].split(':')[0], run: () => useOrg(x.apiHost) })),
        ]).filter(Boolean).filter((it) => it === '-' || it.label),
        '-',
        same.length > 1 ? { icon: '⇉', label: `Send to all ${same.length} ${fam} orgs`, hint: 'compare', run: () => sendToFamily(same) } : null,
        { icon: '⚙', label: 'Manage orgs and tokens…', run: () => openOrgs(el.orgPick) },
      ]);
      // family headers are labels, not actions
      for (const b of openMenu?.el.querySelectorAll('.dx-mi') || []) if (b.textContent.startsWith('☁')) { b.disabled = true; b.classList.add('inf-mi-head'); }
    };
  }

  // a cURL pasted from Postman often carries a hard-coded session token: offer the live one for that org
  function drawTokenBanner() {
    if (!el.tokenBanner) return;
    const t = tab();
    const host = hostOf(resolve(t.draft.url, scopes(t), sfExtra()));
    const o = orgs.byHost(host);
    const pasted = t.draft.headers.find((x) => x.on && /^authorization$/i.test(x.k) && /^Bearer\s+00D/i.test(x.v)) || (t.draft.auth.type === 'bearer' && /^00D/.test(t.draft.auth.bearer) ? 'auth' : null);
    el.tokenBanner.hidden = !(o && pasted);
    if (el.tokenBanner.hidden) return;
    el.tokenBanner.replaceChildren(
      h('span', { 'aria-hidden': 'true' }, '🔑'),
      h('span', {}, 'This request has a pasted session token. Use your live session for ', h('b', {}, shortName(o)), ' instead? It refreshes itself and follows the org you pick.'),
      h('button', { class: 'primary small', onclick: () => {
        if (pasted !== 'auth') pasted.on = false;
        t.draft.auth = { ...t.draft.auth, type: 'sfsession' };
        save(); drawEditor(); drawTabs();
        toast('Using your live Salesforce session', 'ok');
      } }, 'Use live session'));
  }

  // the same request against every org of a family (prod + sandboxes), side by side
  async function sendToFamily(list) {
    const t = tab();
    const rows = list.map((o) => ({ o, status: null }));
    const body = h('div', { class: 'inf-cmp' });
    const pre = h('pre', { class: 'inf-code raw inf-cmp-body' }, 'Click a row to see its response.');
    const draw = () => body.replaceChildren(h('table', { class: 'inf-hdrs inf-cmp-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Org'), h('th', {}, 'Status'), h('th', {}, 'Time'), h('th', {}, 'Size'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.resp ? 'can' : null, onclick: () => { if (r.resp) pre.textContent = prettyMaybe(r.resp.text || r.resp.message || ''); } },
        h('td', {}, orgDot(r.o), ' ', shortName(r.o), ' ', kindTag(r.o)),
        h('td', {}, r.resp ? h('span', { class: `inf-status ${r.resp.status ? `s${String(r.resp.status)[0]}` : 's5'}` }, r.resp.status ? `${r.resp.status} ${r.resp.statusText || ''}` : r.resp.error) : r.status === 'sending' ? h('span', { class: 'lg-spinner' }) : '…'),
        h('td', {}, r.resp?.ms != null ? `${Math.round(r.resp.ms)} ms` : ''),
        h('td', {}, r.resp?.size != null ? formatBytes(r.resp.size) : ''))))), pre);
    draw();
    const title = t.draft.name.startsWith(t.draft.method) ? t.draft.name : `${t.draft.method} ${t.draft.name}`;
    modal(`${title} · every ${parseOrgHost(list[0].apiHost)?.family} org`, body, null, { wide: true });
    for (const r of rows) {
      r.status = 'sending'; draw();
      const url = switchHost(resolve(t.draft.url, scopes(t), { ...sfExtra(), $sfInstanceUrl: `https://${r.o.apiHost}` }), r.o.apiHost);
      r.resp = await sendOnce({ ...t.draft, url }, t, r.o);
      r.status = 'done'; draw();
    }
    const first = rows.find((r) => r.resp?.text);
    if (first) pre.textContent = prettyMaybe(first.resp.text);
  }
  const prettyMaybe = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

  function quickLook(anchor) {
    const env = envOf(D.activeEnv);
    const t = tab();
    const c = colOf(t?.colId);
    const sec = (title, vars, editTarget) => h('div', { class: 'inf-ql-sec' },
      h('div', { class: 'inf-ql-head' }, h('b', {}, title), editTarget ? h('button', { class: 'link', onclick: () => { closeMenu(); editTarget(); } }, 'Edit') : null),
      vars?.length ? h('table', { class: 'inf-ql' }, vars.map((v) => h('tr', { class: v.on ? null : 'off' }, h('td', {}, v.k), h('td', {}, v.v))))
        : h('p', { class: 'inf-ql-none' }, 'No variables'));
    closeMenu();
    const pop = h('div', { class: 'dx-pop inf-quick' },
      sec(env ? env.name : 'No environment selected', env?.vars, env ? () => editVars(env.name, env.vars, (v) => { env.vars = v; }) : null),
      c ? sec(`Collection · ${c.name}`, c.vars, () => editVars(`Variables of ${c.name}`, c.vars, (v) => { c.vars = v; })) : null,
      sec('Globals', D.globals, () => editVars('Globals', D.globals, (v) => { D.globals = v; })));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`;
    pop.style.top = `${r.bottom + 6}px`;
    const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
    const key = (e) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    openMenu = { el: pop, outside, key };
  }

  // ---------- key/value tables ----------
  function kvTable(list, onChange, { desc = true, keyPh = 'Key', valPh = 'Value', warn } = {}) {
    let bulk = false;
    const box = h('div', { class: 'inf-kv' });
    const draw = () => {
      if (bulk) {
        const ta = h('textarea', { class: 'inf-bulk', spellcheck: 'false', placeholder: 'key:value — one per line. Start a line with // to disable it.' });
        ta.value = list.map((x) => `${x.on ? '' : '//'}${x.k}:${x.v}`).join('\n');
        ta.addEventListener('input', () => {
          const next = ta.value.split('\n').filter((l) => l.trim()).map((l) => {
            const off = l.trim().startsWith('//');
            const s = off ? l.trim().slice(2) : l;
            const c = s.indexOf(':');
            return kv(c >= 0 ? s.slice(0, c).trim() : s.trim(), c >= 0 ? s.slice(c + 1).trim() : '', !off);
          });
          list.splice(0, list.length, ...next);
          onChange();
        });
        box.replaceChildren(h('div', { class: 'inf-kv-tools' }, h('button', { class: 'link', onclick: () => { bulk = false; draw(); } }, 'Key-Value Edit')), ta);
        return;
      }
      const row = (x, i) => {
        const isNew = !x;
        const item = x || kv();
        const set = (field, value) => {
          item[field] = value;
          if (isNew) {
            // the empty last row became a real one: redraw and keep typing where you were
            list.push(item); onChange(); draw();
            const input = box.querySelectorAll('.inf-kv-row')[i]?.querySelector(field === 'k' ? '.inf-kv-k' : field === 'v' ? '.inf-kv-v' : '.inf-kv-d');
            input?.focus();
            input?.setSelectionRange(input.value.length, input.value.length);
            return;
          }
          onChange();
        };
        const keyIn = h('input', { class: 'inf-kv-k', value: item.k, placeholder: keyPh, spellcheck: 'false', 'aria-label': keyPh, oninput: (e) => set('k', e.target.value) });
        const valIn = h('input', { class: 'inf-kv-v', value: item.v, placeholder: valPh, spellcheck: 'false', 'aria-label': valPh, oninput: (e) => set('v', e.target.value) });
        const w = !isNew && warn?.(item);
        return h('div', { class: `inf-kv-row${isNew ? ' new' : ''}${!isNew && !item.on ? ' off' : ''}${w ? ' warn' : ''}`, title: w || null },
          h('span', { class: 'inf-kv-c' }, isNew ? null : h('input', { type: 'checkbox', checked: item.on, 'aria-label': 'Enabled', onchange: (e) => { item.on = e.target.checked; onChange(); draw(); } })),
          keyIn, valIn,
          desc ? h('input', { class: 'inf-kv-d', value: item.desc || '', placeholder: 'Description', 'aria-label': 'Description', oninput: (e) => set('desc', e.target.value) }) : null,
          h('span', { class: 'inf-kv-x' }, isNew ? null : h('button', { class: 'inf-iconbtn', title: 'Remove', 'aria-label': 'Remove', onclick: () => { list.splice(i, 1); onChange(); draw(); } }, '×')),
          w ? h('span', { class: 'inf-kv-warn', 'aria-hidden': 'true' }, '!') : null);
      };
      box.replaceChildren(
        h('div', { class: `inf-kv-head${desc ? '' : ' nodesc'}` }, h('span'), h('span', {}, keyPh), h('span', {}, valPh), desc ? h('span', {}, 'Description') : null,
          h('span', { class: 'inf-kv-bulk' }, h('button', { class: 'link', onclick: () => { bulk = true; draw(); } }, 'Bulk Edit'))),
        ...list.map((x, i) => row(x, i)), row(null, list.length));
      if (!desc) box.classList.add('nodesc');
    };
    draw();
    box.redraw = draw;
    return box;
  }

  // ---------- the request editor ----------
  function drawEditor() {
    const t = tab();
    if (!t) {
      el.work.replaceChildren(h('div', { class: 'inf-welcome' },
        h('div', { class: 'inf-welcome-art', 'aria-hidden': 'true' }, '🕴️'),
        h('b', {}, 'The Informant'),
        h('p', {}, 'Ask any API a question, and it tells you everything. Collections, environments, cURL import and your Salesforce session built in.'),
        h('div', { class: 'inf-welcome-acts' },
          h('button', { class: 'primary', onclick: () => openRequest(newRequest(), null) }, '+ New request'),
          h('button', { class: 'ghost', onclick: () => openImport() }, 'Import cURL or a collection')),
        h('p', { class: 'inf-welcome-keys' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' sends · ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'S'), ' saves')));
      return;
    }
    const req = t.draft;
    const c = colOf(t.colId);
    const changed = () => { save(); drawTabs(); drawUrlHl(); drawUrlChip(); drawTokenBanner(); drawOrgPick(); drawSubCounts(); drawRight(); drawDirtyBits(); };

    // breadcrumb + save / share (like Postman's row above the URL)
    el.crumb = h('div', { class: 'inf-crumb' },
      h('span', { class: 'inf-crumb-col' }, c ? c.name : 'Not saved'),
      h('span', { class: 'inf-crumb-sep', 'aria-hidden': 'true' }, '/'),
      el.nameIn = h('input', { class: 'inf-name', value: req.name, 'aria-label': 'Request name', spellcheck: 'false', oninput: (e) => { req.name = e.target.value; changed(); } }),
      h('span', { class: 'inf-grow' }),
      el.saveBtn = h('button', { class: 'ghost small inf-save', title: 'Save (Ctrl+S)', onclick: () => saveTab(t) }, '💾 Save'),
      h('button', { class: 'ghost small', title: 'Share this request', 'aria-haspopup': 'menu', onclick: (e) => shareMenu(e.currentTarget, t) }, 'Share ▾'));

    // method + URL + Send
    const methodSel = h('select', { class: `inf-method ${methodClass(req.method)}`, 'aria-label': 'Method', onchange: (e) => { req.method = e.target.value; methodSel.className = `inf-method ${methodClass(req.method)}`; changed(); drawSub(); } },
      METHODS.map((m) => h('option', { value: m, selected: m === req.method }, m)));
    el.urlIn = h('input', {
      class: 'inf-url-in', value: req.url, placeholder: 'Enter URL or paste a cURL command', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Request URL',
      oninput: (e) => {
        const v = e.target.value;
        // pasting a whole cURL command into the URL bar imports it, like Postman
        if (/^\s*curl\s/i.test(v)) {
          try {
            const { req: parsed, notes } = parseCurl(v);
            Object.assign(req, { ...parsed, id: req.id, name: req.name && req.name !== 'New request' ? req.name : parsed.name });
            toast(notes.length ? `cURL imported · ${notes[0]}` : 'cURL imported', notes.length ? 'info' : 'ok');
            changed(); drawEditor(); return;
          } catch { /* not a full command yet */ }
        }
        req.url = v;
        req.params = paramsFromUrl(v, req.params);
        if (t.sub === 'params') el.subBody.querySelector('.inf-kv')?.redraw?.();
        changed();
      },
      onscroll: () => { el.urlHl.scrollLeft = el.urlIn.scrollLeft; },
      onkeydown: (e) => { if (e.key === 'Enter') send(); },
    });
    el.urlHl = h('div', { class: 'inf-url-hl', 'aria-hidden': 'true' });
    el.urlWarn = h('div', { class: 'inf-url-warn', hidden: true });
    el.urlChip = h('button', { type: 'button', class: 'inf-urlchip', hidden: true, 'aria-haspopup': 'menu' });
    el.tokenBanner = h('div', { class: 'inf-tokbanner', hidden: true, role: 'note' });
    const l = live.get(t.id);
    el.sendBtn = l?.sending
      ? h('button', { class: 'ghost inf-send cancel', onclick: () => l.controller?.abort() }, 'Cancel')
      : h('button', { class: 'primary inf-send', title: 'Send (Ctrl+Enter)', onclick: send }, 'Send');

    // sub-tabs: Params · Authorization · Headers · Body · Settings
    el.subTabs = h('div', { class: 'inf-subtabs', role: 'tablist' });
    el.subBody = h('div', { class: 'inf-subbody' });
    el.resp = h('section', { class: 'inf-resp', 'aria-label': 'Response' });
    el.reqPane = h('div', { class: 'inf-reqpane' },
      el.crumb,
      h('div', { class: 'inf-bar' }, methodSel, h('div', { class: 'inf-url' }, el.urlHl, el.urlIn), el.urlChip, el.sendBtn),
      el.urlWarn,
      el.tokenBanner,
      el.subTabs, el.subBody);
    el.work.replaceChildren(el.reqPane, resizable({
      handle: h('div', { class: 'inf-split-v' }), pane: el.reqPane, host: el.work, cssVar: '--inf-req', axis: 'y', edge: 'end',
      min: 160, max: () => el.work.clientHeight - 120, key: 'ff-split-inf-req', label: 'Resize request and response',
    }), el.resp);
    drawUrlHl();
    drawUrlChip();
    drawTokenBanner();
    drawOrgPick();
    drawSub();
    drawResponse();
    drawDirtyBits();
  }

  function drawDirtyBits() {
    const t = tab();
    if (!t || !el.saveBtn?.isConnected) return;
    el.saveBtn.classList.toggle('dirty', isDirty(t));
  }

  function drawUrlHl() {
    const t = tab();
    if (!t || !el.urlHl?.isConnected) return;
    const known = new Set([...scopes(t).flat().filter((x) => x.on !== false).map((x) => x.k), ...DYNAMIC_VARS, ...Object.keys(sfExtra())]);
    el.urlHl.innerHTML = esc(t.draft.url).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, n) => `<span class="${known.has(n) ? 'inf-var' : 'inf-var bad'}">${m}</span>`) + ' ';
    el.urlHl.scrollLeft = el.urlIn.scrollLeft;
    const missing = unresolved(t.draft, scopes(t), sfExtra(), inherited(t));
    el.urlWarn.hidden = !missing.length;
    if (missing.length) el.urlWarn.replaceChildren(h('span', { 'aria-hidden': 'true' }, '⚠'), ` ${missing.map((n) => `{{${n}}}`).join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} defined in `, h('b', {}, envOf(D.activeEnv)?.name || 'any environment'), '. ', h('button', { class: 'link', onclick: (e) => quickLook(e.currentTarget) }, 'Look at the variables'));
  }

  const SUBS = [['params', 'Params'], ['auth', 'Authorization'], ['headers', 'Headers'], ['body', 'Body'], ['settings', 'Settings']];
  function drawSubCounts() {
    const t = tab();
    if (!t || !el.subTabs?.isConnected) return;
    const req = t.draft;
    const count = {
      params: req.params.filter((p) => p.on && p.k).length,
      headers: req.headers.filter((p) => p.on && p.k).length,
      auth: (req.auth.type === 'inherit' ? inherited(t).type : req.auth.type) !== 'none' ? '●' : '',
      body: req.body.mode !== 'none' && req.method !== 'GET' ? '●' : '',
      settings: req.settings.timeout || req.settings.cookies ? '●' : '',
    };
    el.subTabs.replaceChildren(...SUBS.map(([k, label]) => h('button', {
      role: 'tab', 'aria-selected': String(t.sub === k), onclick: () => { t.sub = k; save(); drawSub(); },
    }, label, count[k] ? h('span', { class: `inf-subn${count[k] === '●' ? ' dot' : ''}` }, count[k] === '●' ? '' : count[k]) : null)));
  }

  function drawSub() {
    const t = tab();
    const req = t.draft;
    const changed = () => { save(); drawTabs(); drawUrlHl(); drawUrlChip(); drawTokenBanner(); drawOrgPick(); drawSubCounts(); drawRight(); drawDirtyBits(); };
    drawSubCounts();
    let body;
    if (t.sub === 'params') {
      body = [h('div', { class: 'inf-sec-title' }, 'Query Params'), kvTable(req.params, () => {
        const { base, hash } = splitUrl(req.url);
        req.url = joinUrl(base, req.params, hash);
        el.urlIn.value = req.url;
        changed();
      })];
    } else if (t.sub === 'headers') {
      const x = wire(req, resolver(t), { sf: sf(), inheritedAuth: inherited(t) });
      const mine = new Set(req.headers.filter((p) => p.on && p.k).map((p) => p.k.toLowerCase()));
      const auto = x.headers.filter(([k]) => !mine.has(k.toLowerCase()));
      let showAuto = false;
      const autoBox = h('div', { class: 'inf-auto', hidden: true }, auto.map(([k, v]) => h('div', { class: 'inf-auto-row' }, h('span', {}, k), h('span', {}, /^authorization$/i.test(k) ? `${v.slice(0, 18)}…` : v), h('em', {}, 'from ', /^authorization$/i.test(k) ? 'Authorization' : 'Body'))));
      body = [
        h('div', { class: 'inf-sec-title' }, 'Headers',
          auto.length ? h('button', { class: 'link inf-autobtn', onclick: (e) => { showAuto = !showAuto; autoBox.hidden = !showAuto; e.currentTarget.textContent = showAuto ? `Hide auto-generated` : `${auto.length} auto-generated`; } }, `${auto.length} auto-generated`) : null),
        autoBox,
        // no redraw while typing (it would steal focus); warnings refresh when the table redraws (toggle, remove, tab switch)
        kvTable(req.headers, changed, { warn: (x) => (x.on && isForbiddenHeader(x.k) ? `Browsers don’t let extensions set “${x.k}”, so it’s skipped.${/^cookie$/i.test(x.k) ? ' Turn on “Send browser cookies” in Settings instead.' : ''}` : null) }),
      ];
      if (req.headers.some((x) => x.on && isForbiddenHeader(x.k))) body.push(h('p', { class: 'inf-note' }, '! Headers marked with ! are dropped by the browser.'));
    } else if (t.sub === 'auth') {
      body = authEditor(req.auth, () => { changed(); drawSub(); }, { allowInherit: true, inheritedFrom: colOf(t.colId), tabRef: t });
    } else if (t.sub === 'body') {
      body = bodyEditor(req, changed);
    } else {
      body = [h('div', { class: 'inf-settings' },
        h('label', { class: 'inf-set' }, h('span', {}, h('b', {}, 'Request timeout'), h('small', {}, 'Stop waiting after this many milliseconds. 0 waits as long as the browser does.')),
          h('input', { type: 'number', min: '0', step: '1000', class: 'inf-in small', value: String(req.settings.timeout || 0), oninput: (e) => { req.settings.timeout = Math.max(0, Number(e.target.value) || 0); changed(); } })),
        h('label', { class: 'inf-set' }, h('span', {}, h('b', {}, 'Send browser cookies'), h('small', {}, 'Include the cookies this browser has for the site (its own login session). Browsers don’t allow a Cookie header, so this is the way to send them.')),
          h('input', { type: 'checkbox', checked: !!req.settings.cookies, onchange: (e) => { req.settings.cookies = e.target.checked; changed(); } })))];
    }
    el.subBody.replaceChildren(...[body].flat().filter(Boolean));
  }

  const AUTHS = [['inherit', 'Inherit auth from parent'], ['none', 'No Auth'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth'], ['apikey', 'API Key'], ['sfsession', 'Salesforce session']];
  const authLabel = (a) => AUTHS.find(([k]) => k === a?.type)?.[1] || 'No Auth';

  function authEditor(auth, onChange, { allowInherit, inheritedFrom } = {}) {
    const sel = h('select', { class: 'inf-in', 'aria-label': 'Auth type', onchange: (e) => { auth.type = e.target.value; onChange(); } },
      AUTHS.filter(([k]) => allowInherit || k !== 'inherit').map(([k, label]) => h('option', { value: k, selected: k === auth.type }, label)));
    const field = (label, input) => h('label', { class: 'inf-field' }, h('span', {}, label), input);
    // typing in a field saves without redrawing (keeps focus); only the type select redraws
    const text = (value, set, ph, type = 'text') => h('input', { type, class: 'inf-in', value: value || '', placeholder: ph, spellcheck: 'false', oninput: (e) => { set(e.target.value); save(); drawRight(); drawTabs(); drawDirtyBits(); } });
    let fields;
    let help;
    const s = sf();
    switch (auth.type) {
      case 'inherit': {
        const pa = inheritedFrom?.auth;
        fields = [h('p', { class: 'inf-auth-note' }, inheritedFrom ? ['Uses the collection’s authorization: ', h('b', {}, authLabel(pa)), '. ', h('button', { class: 'link', onclick: () => editCollectionAuth(inheritedFrom) }, 'Change it')] : 'This request isn’t in a collection yet, so nothing is inherited.')];
        help = 'Set auth once on the collection, and every request in it uses it.';
        break;
      }
      case 'none': fields = []; help = 'This request doesn’t send any authorization.'; break;
      case 'bearer':
        fields = [field('Token', text(auth.bearer, (v) => { auth.bearer = v; }, 'Token, or {{token}}'))];
        help = 'Sent as Authorization: Bearer <token>. Use a variable to keep the token out of shared collections.';
        break;
      case 'basic':
        fields = [field('Username', text(auth.basic.u, (v) => { auth.basic.u = v; }, 'Username')), field('Password', text(auth.basic.p, (v) => { auth.basic.p = v; }, 'Password', 'password'))];
        help = 'Sent as Authorization: Basic <base64 of username:password>.';
        break;
      case 'apikey':
        fields = [
          field('Key', text(auth.apikey.k, (v) => { auth.apikey.k = v; }, 'e.g. x-api-key')),
          field('Value', text(auth.apikey.v, (v) => { auth.apikey.v = v; }, 'Value')),
          field('Add to', h('select', { class: 'inf-in', onchange: (e) => { auth.apikey.in = e.target.value; onChange(); } }, h('option', { value: 'header', selected: auth.apikey.in === 'header' }, 'Header'), h('option', { value: 'query', selected: auth.apikey.in === 'query' }, 'Query Params'))),
        ];
        help = 'The key and value go into a header or the URL.';
        break;
      case 'sfsession': {
        // the org this request goes to (its URL), and that org's live session
        const o = s?.org ? orgs.byHost(s.org.apiHost) || s.org : null;
        const tok = s?.sessionId;
        fields = [h('div', { class: `inf-sfcard${o && tok ? '' : ' off'}` },
          h('span', { class: 'inf-sf big' }, 'SF'),
          h('div', { class: 'inf-sfcard-main' },
            h('b', {}, o ? `${shortName(o)} · ${o.name || o.apiHost}` : 'No Salesforce org'),
            h('small', {}, o ? [orgDot(o), ' ', STATUS[o.status || 'unknown'][1], o.user?.username ? ` · ${o.user.username}` : ''] : 'Log in to an org in this browser, or pick one at the top right.'),
            o ? h('div', { class: 'inf-otoken small' },
              h('code', { class: 'inf-otoken-val' }, tok ? maskToken(tok) : 'no session'),
              tok ? h('button', { class: 'inf-iconbtn', title: 'Copy the token', 'aria-label': 'Copy the token', onclick: () => copyText(tok, `Token for ${shortName(o)} copied. It’s your live session: don’t share it`) }, '⧉') : null,
              h('button', { class: 'ghost small', onclick: async (e) => { e.currentTarget.textContent = 'Refreshing…'; await orgs.refresh(o.apiHost); drawOrgBits(); drawOrgPick(); } }, '↻ Refresh'),
              !tok || o.status === 'expired' ? h('button', { class: 'link', onclick: () => openTab(`https://${o.apiHost}/`) }, 'Log in ↗') : null) : null))];
        help = 'No token to paste: the request sends your live session for the org in its URL, so a sandbox token never goes to production. Switch orgs with the chip in the URL bar; {{$sfInstanceUrl}} and {{$sfApiVersion}} follow the org picked at the top right.';
        break;
      }
      default: fields = [];
    }
    return [h('div', { class: 'inf-auth' },
      h('div', { class: 'inf-auth-l' }, h('div', { class: 'inf-sec-title' }, 'Auth Type'), sel, h('p', { class: 'inf-auth-help' }, help)),
      h('div', { class: 'inf-auth-r' }, fields))];
  }

  function editCollectionAuth(c) {
    const auth = clone(c.auth || { ...newRequest().auth, type: 'none' });
    const box = h('div', { class: 'inf-modal-auth' });
    const draw = () => box.replaceChildren(...authEditor(auth, draw, { allowInherit: false }));
    draw();
    const m = modal(`Authorization · ${c.name}`, box, [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: () => { c.auth = auth; save(); m.close(); drawAll(); toast('Collection auth saved', 'ok'); } }, 'Save')], { wide: true });
  }

  function bodyEditor(req, changed) {
    const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw']];
    const getHint = req.method === 'GET' || req.method === 'HEAD' ? h('p', { class: 'inf-note' }, `${req.method} requests don’t send a body. Switch the method to send one.`) : null;
    const top = h('div', { class: 'inf-bodymodes', role: 'radiogroup' },
      modes.map(([k, label]) => h('label', { class: `inf-radio${req.body.mode === k ? ' on' : ''}` },
        h('input', { type: 'radio', name: 'inf-bodymode', checked: req.body.mode === k, onchange: () => { req.body.mode = k; changed(); drawSub(); } }), label)),
      req.body.mode === 'raw' ? h('select', { class: 'inf-rawtype', 'aria-label': 'Raw type', onchange: (e) => { req.body.rawType = e.target.value; changed(); } },
        Object.keys(RAW_TYPES).map((k) => h('option', { value: k, selected: k === req.body.rawType }, { json: 'JSON', text: 'Text', xml: 'XML', html: 'HTML', javascript: 'JavaScript' }[k]))) : null,
      req.body.mode === 'raw' && req.body.rawType === 'json' ? h('button', { class: 'link inf-beautify', onclick: () => {
        try { req.body.raw = JSON.stringify(JSON.parse(req.body.raw), null, 2); changed(); drawSub(); } catch (e) { toast(`Not valid JSON: ${e.message}`, 'error'); }
      } }, 'Beautify') : null);
    let editor = null;
    if (req.body.mode === 'none') editor = h('p', { class: 'inf-muted-c' }, 'This request does not have a body');
    else if (req.body.mode === 'urlencoded') editor = kvTable(req.body.urlencoded, changed);
    else if (req.body.mode === 'formdata') editor = [kvTable(req.body.formdata, changed), h('p', { class: 'inf-note' }, 'Text fields only: file uploads aren’t supported here.')];
    else {
      const ta = h('textarea', { class: 'inf-raw', spellcheck: 'false', placeholder: req.body.rawType === 'json' ? '{\n  "key": "value"\n}' : '', 'aria-label': 'Raw body' });
      ta.value = req.body.raw;
      const status = h('div', { class: 'inf-raw-status' });
      const check = () => {
        if (req.body.rawType !== 'json' || !req.body.raw.trim()) { status.textContent = ''; status.className = 'inf-raw-status'; return; }
        // {{vars}} outside strings aren't JSON yet; check what it becomes
        const probe = req.body.raw.replace(/\{\{[^{}]+\}\}/g, '0');
        try { JSON.parse(probe); status.textContent = '✓ Valid JSON'; status.className = 'inf-raw-status ok'; } catch (e) { status.textContent = `⚠ ${e.message.replace(/^JSON\.parse: /, '')}`; status.className = 'inf-raw-status bad'; }
      };
      ta.addEventListener('input', () => { req.body.raw = ta.value; check(); changed(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      });
      check();
      editor = h('div', { class: 'inf-rawbox' }, ta, status);
    }
    return [top, getHint, editor].flat().filter(Boolean);
  }

  function editVars(title, vars, set) {
    const copy = clone(vars || []);
    const table = kvTable(copy, () => {}, { desc: false, keyPh: 'Variable', valPh: 'Value' });
    const m = modal(title, h('div', { class: 'inf-varsbox' },
      h('p', { class: 'dx-muted' }, 'Use them anywhere as ', h('code', {}, '{{variable}}'), ': URL, params, headers, body and auth.'),
      table), [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'primary', onclick: () => { set(copy.filter((x) => x.k)); save(); m.close(); drawAll(); toast('Variables saved', 'ok'); } }, 'Save')], { wide: true });
  }

  // ---------- save / share / import ----------
  async function saveTab(t) {
    if (t.reqId && colOf(t.colId)) {
      const c = colOf(t.colId);
      const i = c.requests.findIndex((r) => r.id === t.reqId);
      if (i >= 0) {
        c.requests[i] = clone({ ...t.draft, id: t.reqId });
        t.saved = JSON.stringify(stripId(t.draft));
        save(); drawAll();
        toast(`Saved to ${c.name}`, 'ok');
        return true;
      }
    }
    // first save: pick a name and a collection
    const name = h('input', { type: 'text', class: 'inf-in', value: t.draft.name, spellcheck: 'false', 'data-autofocus': '' });
    const sel = h('select', { class: 'inf-in' }, D.collections.map((c) => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, '+ New collection…'));
    const newName = h('input', { type: 'text', class: 'inf-in', placeholder: 'Collection name', hidden: !!D.collections.length });
    if (!D.collections.length) sel.value = '__new';
    sel.addEventListener('change', () => { newName.hidden = sel.value !== '__new'; if (!newName.hidden) newName.focus(); });
    return new Promise((done) => {
      const ok = h('button', { class: 'primary' }, 'Save');
      const m = modal('Save request', h('div', { class: 'inf-form' },
        h('label', { class: 'inf-field' }, h('span', {}, 'Request name'), name),
        h('label', { class: 'inf-field' }, h('span', {}, 'Save to'), sel), newName),
      [h('button', { class: 'ghost', onclick: () => { m.close(); done(false); } }, 'Cancel'), ok]);
      ok.addEventListener('click', () => {
        let c;
        if (sel.value === '__new') {
          if (!newName.value.trim()) { newName.focus(); return; }
          c = { id: newId(), name: newName.value.trim(), open: true, vars: [], auth: { ...newRequest().auth, type: 'none' }, requests: [] };
          D.collections.push(c);
        } else c = colOf(sel.value);
        t.draft.name = name.value.trim() || t.draft.name;
        const r = clone({ ...t.draft, id: newId() });
        c.requests.push(r);
        c.open = true;
        t.colId = c.id;
        t.reqId = r.id;
        t.saved = JSON.stringify(stripId(t.draft));
        save(); m.close(); drawAll();
        toast(`Saved to ${c.name}`, 'ok');
        done(true);
      });
    });
  }

  function shareMenu(anchor, t) {
    // shared copies keep {{$sfSessionId}}; only "filled in" puts the live token in
    const opts = { inheritedAuth: inherited(t) };
    const filled = { sf: sf(), inheritedAuth: inherited(t) };
    const keep = (s) => s;
    const col = colOf(t.colId);
    menu(anchor, [
      { icon: '⌘', label: 'Copy as cURL', hint: 'variables kept', run: () => copyText(toCurl(t.draft, keep, opts), 'cURL copied') },
      { icon: '⌘', label: 'Copy as cURL, variables filled in', hint: 'may include secrets', run: () => copyText(toCurl(t.draft, resolver(t), filled), 'cURL copied with values filled in. It may contain tokens: share carefully') },
      { icon: '{}', label: 'Copy as JavaScript fetch', run: () => copyText(SNIPPETS.find(([k]) => k === 'fetch')[2](t.draft, keep, opts), 'Copied') },
      { icon: '◆', label: 'Copy as Apex', run: () => copyText(SNIPPETS.find(([k]) => k === 'apex')[2](t.draft, keep, opts), 'Apex copied') },
      '-',
      col ? { icon: '⤓', label: `Export “${col.name}”`, hint: 'Postman v2.1', run: () => download(`${col.name}.postman_collection.json`, JSON.stringify(toPostman(col), null, 2)) } : null,
    ], { align: 'end' });
  }

  function openImport() {
    const ta = h('textarea', { class: 'inf-import-ta', spellcheck: 'false', 'data-autofocus': '', placeholder: 'Paste a cURL command or a Postman collection (v2.1 JSON)…\n\ncurl --location \'https://…\' \\\n--header \'Authorization: Bearer …\'' });
    const file = h('input', { type: 'file', accept: '.json,.txt,.sh,application/json,text/plain', hidden: true });
    const status = h('p', { class: 'inf-import-status' });
    const detect = () => {
      const s = ta.value.trim();
      status.className = 'inf-import-status';
      if (!s) { status.textContent = ''; return null; }
      if (/^curl\s/i.test(s)) {
        try { const { req, notes } = parseCurl(s); status.textContent = `✓ cURL: ${req.method} ${req.url.slice(0, 70)}${notes.length ? ` · ${notes.join(' ')}` : ''}`; status.classList.add('ok'); return { kind: 'curl', req }; } catch (e) { status.textContent = `⚠ ${e.message}`; status.classList.add('bad'); return null; }
      }
      try {
        const col = fromPostman(s);
        status.textContent = `✓ Postman collection “${col.name}” · ${col.requests.length} request${col.requests.length === 1 ? '' : 's'}`;
        status.classList.add('ok');
        return { kind: 'collection', col };
      } catch (e) { status.textContent = `⚠ ${/JSON/.test(e.message) ? 'That’s neither a cURL command nor a Postman collection.' : e.message}`; status.classList.add('bad'); return null; }
    };
    ta.addEventListener('input', detect);
    file.addEventListener('change', async () => { const f = file.files[0]; if (f) { ta.value = await f.text(); detect(); } });
    const go = h('button', { class: 'primary' }, 'Import');
    const m = modal('Import', h('div', { class: 'inf-import' },
      ta,
      h('div', { class: 'inf-import-row' }, h('button', { class: 'ghost small', onclick: () => file.click() }, '📂 Choose a file'), file, status)),
    [h('button', { class: 'ghost', onclick: () => m.close() }, 'Cancel'), go], { wide: true });
    go.addEventListener('click', () => {
      const x = detect();
      if (!x) { ta.focus(); return; }
      m.close();
      if (x.kind === 'curl') { openRequest(x.req, null); toast('cURL imported into a new tab', 'ok'); return; }
      D.collections.push({ id: newId(), name: x.col.name, open: true, vars: x.col.vars, auth: x.col.auth, requests: x.col.requests });
      D.side = 'collections';
      save(); drawAll();
      toast(`Imported “${x.col.name}”`, 'ok');
    });
  }

  function download(name, text, type = 'application/json') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name.replace(/[\\/:*?"<>|]+/g, '_') });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- sending ----------
  async function send() {
    const t = tab();
    if (!t || live.get(t.id)?.sending) return;
    const req = t.draft;
    const controller = new AbortController();
    const state = { sending: true, controller, started: performance.now(), response: live.get(t.id)?.response || null };
    live.set(t.id, state);
    drawTabs(); drawEditor();
    const resp = await sendOnce(req, t, null, state);
    if (resp.error === 'badurl') { live.set(t.id, { response: state.response }); drawTabs(); drawEditor(); toast('Enter a full URL, starting with https://', 'error'); el.urlIn?.focus(); return; }
    setResponse(t, resp);
    if (resp.sent) {
      D.history.unshift({ id: newId(), at: Date.now(), method: resp.sent.method, url: resp.sent.url.replace(/([?&](?:access_token|token|sid|password)=)[^&]+/gi, '$1…'), status: resp.status || 0, ms: Math.round(resp.ms || 0), req: clone(req) });
      D.history.length = Math.min(D.history.length, HISTORY_MAX);
      save();
      if (D.side === 'history') drawSide();
    }
  }

  /**
   * Send one request and return its response object (no drawing). org: send to this org instead
   * (used by "Send to all"); state: { controller, timedOut } for Cancel / timeouts.
   */
  async function sendOnce(req, t, org = null, state = { controller: new AbortController() }) {
    const extra = org ? { ...sfExtra(), $sfInstanceUrl: `https://${org.apiHost}`, $sfApiVersion: org.version || 'v62.0', $sfSessionId: orgs.token(org.apiHost) || '' } : sfExtra();
    const r = (s) => resolve(s, scopes(t), extra);
    const target = org || orgs.byHost(hostOf(r(req.url))) || (isOrgHost(hostOf(r(req.url))) ? { apiHost: hostOf(r(req.url)) } : sfFor(t)?.org);
    const sfs = target ? { sessionId: orgs.token(target.apiHost), apiHost: target.apiHost } : null;
    const x = wire(req, r, { sf: sfs, inheritedAuth: inherited(t) });
    let u;
    try { u = new URL(x.url); } catch { return { error: 'badurl' }; }
    // "Salesforce session" for an org this browser isn't logged into: say so instead of sending a broken token
    const usesSession = (req.auth.type === 'inherit' ? inherited(t) : req.auth).type === 'sfsession';
    if (usesSession && !sfs?.sessionId) {
      return { error: 'nosession', org: target, message: `You’re not logged in to ${target?.apiHost || 'this org'} in this browser, so there’s no session to send. Log in, then Refresh the token.` };
    }
    const demoOrg = demo ? orgs.byHost(u.host) : null;
    const local = u.origin === DEMO_BASE || !!demoOrg;
    // the browser asks once per site before an extension may call it (Salesforce is already allowed)
    if (!local && globalThis.chrome?.permissions?.contains) {
      let ok = false;
      try { ok = await chrome.permissions.contains({ origins: [`${u.origin}/*`] }); } catch { ok = false; }
      if (!ok) { try { ok = await chrome.permissions.request({ origins: [`${u.origin}/*`] }); } catch { ok = false; } }
      if (!ok) return { error: 'permission', message: `The Informant needs your OK to talk to ${u.host}. Click Send again and choose Allow.` };
    }
    const headers = new Headers();
    const bad = [];
    for (const [k, v] of x.headers) {
      if (isForbiddenHeader(k)) continue;
      try { headers.append(k, v); } catch { bad.push(k); }
    }
    let body;
    if (typeof x.body === 'string') body = x.body;
    else if (x.body?.formdata) { body = new FormData(); for (const [k, v] of x.body.formdata) body.append(k, v); }
    const started = performance.now();
    let timer = 0;
    if (req.settings.timeout) timer = setTimeout(() => { state.timedOut = true; state.controller.abort(); }, req.settings.timeout);
    let resp;
    try {
      const init = { method: x.method, headers, body, signal: state.controller.signal, credentials: req.settings.cookies ? 'include' : 'omit', redirect: 'follow', cache: 'no-store' };
      const res = local ? await demoFetch(x.url, init, demoOrg ? { org: demoOrg, token: orgs.token(demoOrg.apiHost) } : {}) : await fetch(x.url, init);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder().decode(buf);
      resp = { status: res.status, statusText: res.statusText || statusText(res.status), ms: performance.now() - started, size: buf.byteLength, headers: [...res.headers], text, type: res.headers.get('content-type') || '', url: res.url || x.url, redirected: res.redirected, sent: { ...x, body: typeof x.body === 'string' ? x.body : x.body ? '(form-data)' : null }, skipped: x.skipped, bad, org: target };
      // a Salesforce 401 with the session token: the session ended, so mark the org and say what to do
      if (res.status === 401 && usesSession && target) {
        const o = orgs.byHost(target.apiHost);
        if (o && o.status === 'valid') { o.status = 'expired'; orgs.emit(); }
        resp.hint = `Your session for ${shortName(target)} looks expired. Log in to the org again, then Refresh the token (top right).`;
      }
    } catch (e) {
      const ms = performance.now() - started;
      resp = e?.name === 'AbortError'
        ? { error: state.timedOut ? 'timeout' : 'cancelled', message: state.timedOut ? `No answer within ${req.settings.timeout} ms (Settings → Request timeout).` : 'You cancelled the request.', ms }
        : { error: 'network', message: `Couldn’t reach ${u.host}. Check the URL, your network or VPN. Sites that only allow requests from their own pages can also refuse.`, detail: e?.message, ms };
    }
    clearTimeout(timer);
    return resp;
  }

  function setResponse(t, resp) {
    const st = live.get(t.id) || {};
    st.response = resp;
    st.sending = false;
    live.set(t.id, st);
    if (tab() === t) { drawTabs(); drawEditor(); drawRight(); } else drawTabs();
  }

  // ---------- response ----------
  function drawResponse() {
    const t = tab();
    const st = live.get(t.id);
    const r = st?.response;
    if (st?.sending) {
      el.resp.replaceChildren(h('div', { class: 'inf-resp-wait' }, h('span', { class: 'lg-spinner' }), h('b', {}, 'Sending request…'), h('button', { class: 'ghost small', onclick: () => st.controller?.abort() }, 'Cancel')));
      return;
    }
    if (!r) {
      el.resp.replaceChildren(h('div', { class: 'inf-resp-head' }, h('b', {}, 'Response')),
        h('div', { class: 'inf-resp-empty' },
          h('div', { class: 'inf-resp-art', 'aria-hidden': 'true' }, '🛰️'),
          h('p', {}, 'Click ', h('b', {}, 'Send'), ' to get a response'),
          h('p', { class: 'inf-resp-tips' }, 'Paste a cURL into the URL bar to import it · Ctrl+Enter sends')));
      return;
    }
    if (r.error) {
      el.resp.replaceChildren(h('div', { class: 'inf-resp-head' }, h('b', {}, 'Response')),
        h('div', { class: `inf-resp-err ${r.error}` },
          h('div', { class: 'inf-resp-err-i', 'aria-hidden': 'true' }, { cancelled: '✋', timeout: '⏱', permission: '🔐', nosession: '🔑' }[r.error] || '📡'),
          h('b', {}, { cancelled: 'Request cancelled', timeout: 'Timed out', permission: 'Permission needed', network: 'Could not send request', nosession: 'Not logged in to this org' }[r.error]),
          h('p', {}, r.message),
          r.detail ? h('code', {}, r.detail) : null,
          h('div', { class: 'lg-row' },
            r.error === 'nosession' && r.org ? h('button', { class: 'primary small', onclick: () => openTab(`https://${r.org.apiHost}/`) }, 'Log in ↗') : null,
            r.error === 'nosession' && r.org ? h('button', { class: 'ghost small', onclick: async () => { await orgs.refresh(r.org.apiHost); send(); } }, '↻ Refresh token and send') : null,
            r.error !== 'nosession' ? h('button', { class: 'ghost small', onclick: send }, 'Try again') : null)));
      return;
    }
    const ok = r.status < 300 ? 's2' : r.status < 400 ? 's3' : r.status < 500 ? 's4' : 's5';
    const isJson = /json/i.test(r.type) || /^\s*[[{]/.test(r.text);
    const isHtml = /html/i.test(r.type);
    const tabs = [['body', 'Body'], ['headers', `Headers (${r.headers.length})`]];
    const views = [['pretty', 'Pretty'], ['raw', 'Raw'], ...(isHtml ? [['preview', 'Preview']] : [])];
    if (!views.some(([k]) => k === t.resView)) t.resView = 'pretty';
    const content = h('div', { class: 'inf-resp-body' });
    if (t.resTab === 'headers') {
      content.append(h('table', { class: 'inf-hdrs' }, h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'))), h('tbody', {}, r.headers.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))));
      if (r.skipped?.length) content.append(h('p', { class: 'inf-note' }, `Not sent (the browser doesn’t allow them): ${r.skipped.join(', ')}`));
    } else if (!r.text) {
      content.append(h('p', { class: 'inf-muted-c' }, r.status === 204 ? 'No content (204): the request worked and there’s nothing to show.' : 'The response has no body.'));
    } else if (t.resView === 'preview' && isHtml) {
      content.append(h('iframe', { class: 'inf-preview', sandbox: '', srcdoc: r.text, title: 'Response preview' }));
    } else if (t.resView === 'raw' || r.size > PRETTY_MAX) {
      content.append(h('pre', { class: 'inf-code raw' }, r.text));
      if (r.size > PRETTY_MAX && t.resView !== 'raw') content.append(h('p', { class: 'inf-note' }, 'Large response: shown as raw text.'));
    } else {
      let pretty = r.text;
      let html;
      if (isJson) { try { pretty = JSON.stringify(JSON.parse(r.text), null, 2); html = jsonHtml(pretty); } catch { /* not JSON after all */ } }
      if (!html) html = esc(/<\w/.test(pretty) && /xml|html/i.test(r.type) ? prettyXml(pretty) : pretty);
      const lines = html.split('\n');
      const pre = h('pre', { class: 'inf-code' });
      pre.innerHTML = lines.map((l, i) => `<span class="inf-ln"><i>${i + 1}</i>${l || ' '}</span>`).join('');
      content.append(pre);
    }
    el.resp.replaceChildren(...[ // (filter: replaceChildren would print a null as "null")
      h('div', { class: 'inf-resp-head' },
        h('div', { class: 'inf-resp-tabs', role: 'tablist' }, tabs.map(([k, label]) => h('button', { role: 'tab', 'aria-selected': String(t.resTab === k), onclick: () => { t.resTab = k; drawResponse(); } }, label))),
        h('span', { class: 'inf-grow' }),
        r.org && isOrgHost(r.org.apiHost) ? h('span', { class: `inf-via k-${kindOf(r.org)}`, title: r.org.apiHost }, 'via ', h('b', {}, shortName(r.org))) : null,
        h('span', { class: `inf-status ${ok}`, title: r.url }, `${r.status} ${r.statusText || statusText(r.status)}`),
        h('span', { class: 'inf-meta', title: 'Time to the full response' }, `${Math.round(r.ms)} ms`),
        h('span', { class: 'inf-meta', title: 'Body size' }, formatBytes(r.size)),
        h('button', { class: 'inf-iconbtn', title: 'Copy the body', 'aria-label': 'Copy the body', onclick: () => copyText(r.text, 'Response copied') }, '⧉'),
        h('button', { class: 'inf-iconbtn', title: 'Save the body to a file', 'aria-label': 'Save the body', onclick: () => download(`response-${r.status}.${isJson ? 'json' : isHtml ? 'html' : 'txt'}`, r.text, r.type || 'text/plain') }, '⤓')),
      r.hint ? h('div', { class: 'inf-resp-hint' }, h('span', { 'aria-hidden': 'true' }, '🔑'), r.hint, h('button', { class: 'link', onclick: () => openOrgs(el.orgPick) }, 'Open orgs')) : null,
      t.resTab === 'body' ? h('div', { class: 'inf-views' }, views.map(([k, label]) => h('button', { class: t.resView === k ? 'on' : '', onclick: () => { t.resView = k; drawResponse(); } }, label)),
        isJson ? h('span', { class: 'inf-type' }, 'JSON') : isHtml ? h('span', { class: 'inf-type' }, 'HTML') : r.type ? h('span', { class: 'inf-type' }, r.type.split(';')[0]) : null) : null,
      content].filter(Boolean));
  }

  // ---------- right side: Code / Info ----------
  function drawRRail() {
    const b = (k, icon, label) => h('button', {
      class: 'inf-rail-btn', 'aria-pressed': String(D.right === k), title: label, 'aria-label': label,
      onclick: () => { D.right = D.right === k ? null : k; save(); drawRRail(); drawRight(); },
    }, h('span', { class: 'inf-rail-i', 'aria-hidden': 'true' }, icon));
    el.rrail.replaceChildren(b('code', '</>', 'Code snippet'), b('info', 'ⓘ', 'Request info'));
  }

  function drawRight() {
    el.right.hidden = !D.right;
    root.classList.toggle('inf-has-right', !!D.right);
    if (!D.right) return;
    const t = tab();
    const close = h('button', { class: 'inf-iconbtn', title: 'Close', 'aria-label': 'Close', onclick: () => { D.right = null; save(); drawRRail(); drawRight(); } }, '×');
    if (!t) { el.right.replaceChildren(h('div', { class: 'inf-rhead' }, h('b', {}, D.right === 'code' ? 'Code snippet' : 'Info'), h('span', { class: 'inf-grow' }), close), h('p', { class: 'inf-side-empty' }, 'Open a request first.')); return; }
    if (D.right === 'code') {
      const gen = SNIPPETS.find(([k]) => k === D.snippet) || SNIPPETS[0];
      const code = gen[2](t.draft, D.resolveSnippet ? resolver(t) : (s) => s, { sf: D.resolveSnippet ? sf() : null, inheritedAuth: inherited(t) });
      el.right.replaceChildren(
        h('div', { class: 'inf-rhead' }, h('b', {}, 'Code snippet'), h('span', { class: 'inf-grow' }), close),
        h('div', { class: 'inf-rtools' },
          h('select', { class: 'inf-in', 'aria-label': 'Language', onchange: (e) => { D.snippet = e.target.value; save(); drawRight(); } }, SNIPPETS.map(([k, label]) => h('option', { value: k, selected: k === gen[0] }, label))),
          h('button', { class: 'inf-iconbtn', title: 'Copy', 'aria-label': 'Copy the snippet', onclick: () => copyText(code, `${gen[1]} copied`) }, '⧉')),
        h('label', { class: 'inf-resolve', title: 'Fill in {{variables}} with their values (the snippet may then contain tokens)' },
          h('input', { type: 'checkbox', checked: !!D.resolveSnippet, onchange: (e) => { D.resolveSnippet = e.target.checked; save(); drawRight(); } }), 'Fill in variables'),
        h('pre', { class: 'inf-snippet' }, code));
    } else {
      const c = colOf(t.colId);
      const r = live.get(t.id)?.response;
      const row = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : null);
      el.right.replaceChildren(
        h('div', { class: 'inf-rhead' }, h('b', {}, 'Request info'), h('span', { class: 'inf-grow' }), close),
        h('dl', { class: 'inf-info' },
          row('Name', t.draft.name), row('Collection', c ? c.name : 'not saved'), row('Method', t.draft.method),
          row('Auth', authLabel(t.draft.auth.type === 'inherit' ? inherited(t) : t.draft.auth)),
          row('Environment', envOf(D.activeEnv)?.name || 'none'),
          r && !r.error ? row('Last response', `${r.status} · ${Math.round(r.ms)} ms · ${formatBytes(r.size)}`) : null),
        h('p', { class: 'inf-side-tip' }, 'Saved in this browser only. Export a collection to share it, or copy a request as cURL.'));
    }
  }

  // ---------- JSON / XML pretty ----------
  const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  function jsonHtml(text) {
    return esc(text).replace(JSON_TOKEN, (m, str, colon, lit, n) => (str ? `<span class="${colon ? 'j-k' : 'j-s'}">${str}</span>${colon || ''}` : lit ? `<span class="j-b">${lit}</span>` : `<span class="j-n">${n}</span>`));
  }
  function prettyXml(xml) {
    let depth = 0;
    return xml.replace(/>\s*</g, '>\n<').split('\n').map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/][^>]*[^/]>$/.test(line) && !/<\/.+>$/.test(line)) depth++;
      return out;
    }).join('\n');
  }

  function drawAll() { drawRail(); drawSide(); drawTabs(); drawEnvPick(); drawEditor(); drawRRail(); drawRight(); }

  // keyboard: Ctrl+Enter send, Ctrl+S save (only while this view is showing)
  document.addEventListener('keydown', (e) => {
    if (!root.isConnected || root.closest('[hidden]') || document.querySelector('.dx-modal')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); const t = tab(); if (t) saveTab(t); }
  });

  if (!D.tabs.length && D.collections[0]?.requests[0]) openSaved(D.collections[0], D.collections[0].requests[0]);
  else drawAll();
  return { setActive(on) { if (on) drawAll(); } };
}
