// The OG panel: opened from the edge handle on Salesforce pages (content.js) in a small frame.
// Tabs: Record (the record on the page → All data), Users (search, Login as, Setup links), Tools.
// It's an extension page, so it reuses the browser's Salesforce session like the rest of the tool.

import { h } from '../dom.js';
import { getSession } from '../session.js';
import { SfApi } from '../sf-api.js';
import { SfRecordBackend, DemoRecordBackend } from '../record/record-backend.js';
import {
  recordIdFromUrl, objectFromUrl, lightningHost, userDetailUrl, permSetAssignUrl, permSetUrl, permSetGroupUrl,
  objectManagerUrl, loginAsUrl, frontdoorUrl,
} from '../record/sf-urls.js';

const params = new URLSearchParams(location.search);
const HOST = params.get('host') || '';
// demo: ?demo=1, or a local test page standing in for Salesforce (never a real org's host)
const DEMO = params.has('demo') || /^(localhost|127\.0\.0\.1)$/.test(HOST);
const root = document.getElementById('og');
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
};

const S = {
  tab: store.get('og-panel-tab', 'record'),
  pageUrl: params.get('url') || '',
  session: null, api: null, records: null, ui: '',
  me: null, users: null, q: '', open: null, perm: new Map(), rec: null,
};

// ---------- talking to the Salesforce page around us (content.js) ----------
const parentOrigin = HOST ? `https://${HOST}` : '*';
const tellPage = (msg) => window.parent?.postMessage({ source: 'og-panel', ...msg }, DEMO ? '*' : parentOrigin);
window.addEventListener('message', (e) => {
  if (!DEMO && e.origin !== parentOrigin) return;
  if (e.data?.source !== 'og-page') return;
  if (e.data.type === 'ping') { tellPage({ type: 'pong', at: e.data.at }); return; }
  if (e.data.type === 'url') {
    const was = S.apiNames;
    S.apiNames = !!e.data.apiNames;
    if (e.data.url !== S.pageUrl) {
      S.pageUrl = e.data.url;
      if (S.tab === 'record') renderRecord();
    } else if (was !== S.apiNames) paintApiNames();
  }
  if (e.data.type === 'api-names') {
    S.apiNames = !!e.data.on;
    S.apiCount = e.data.count;
    paintApiNames();
  }
  if (e.data.type === 'opened' && S.tab === 'users') el.search?.focus();
  if (e.data.type === 'hard-reload-failed') freshDone(e.data.error);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) tellPage({ type: 'close' }); });

const openTab = (url) => {
  if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
};

function toast(msg, kind = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts og-toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 2400);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg, 'ok');
}
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const hue = (s = '') => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const ago = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(String(iso).replace(/\+0000$/, 'Z'))) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return new Date(String(iso).replace(/\+0000$/, 'Z')).toLocaleDateString();
};
const soqlStr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// ---------- startup ----------

const el = {};
async function start() {
  render();
  tellPage({ type: 'ready' }); // the page shows this frame now (until then: a spinner, never a blank box)
  try {
    if (DEMO) {
      S.records = new DemoRecordBackend();
      S.ui = 'demo.example.lightning.force.com';
      S.session = { orgId: '00D5g000000DEMO', apiHost: 'demo.example.my.salesforce.com', sessionId: 'demo' };
      S.pageUrl ||= `https://${S.ui}/lightning/r/Account/${S.records.sampleId('Account')}/view`;
    } else {
      if (!HOST) throw new Error('Open this panel from a Salesforce tab.');
      S.session = await getSession(HOST);
      S.api = new SfApi(S.session);
      await S.api.init();
      S.records = new SfRecordBackend(S.api, S.session);
      S.ui = lightningHost(S.session);
    }
    el.org.textContent = orgLabel();
    el.org.title = `${S.session.apiHost} · org ${S.session.orgId}`;
    S.me = await currentUser();
    showTab(S.tab);
  } catch (e) {
    el.body.replaceChildren(h('div', { class: 'og-empty err' },
      h('div', { class: 'og-empty-icon', 'aria-hidden': 'true' }, '🔌'),
      h('b', {}, 'Couldn’t connect to this org'),
      h('p', {}, e.message),
      h('button', { class: 'ghost small', onclick: () => location.reload() }, 'Try again')));
  }
}

function orgLabel() {
  const host = S.session?.apiHost || HOST;
  const m = /^([\w-]+?)(?:--([\w-]+))?\.(sandbox\.)?my\.salesforce\.com$/i.exec(host);
  if (!m) return host;
  return m[2] ? `${m[1]} · ${m[2]}` : m[1];
}

// ---------- shell ----------

function render() {
  const tabBtn = (k, label) => h('button', { role: 'tab', 'data-tab': k, 'aria-selected': String(S.tab === k), onclick: () => showTab(k) }, label);
  root.replaceChildren(
    h('header', { class: 'og-head' },
      h('span', { class: 'og-logo', 'aria-hidden': 'true' }),
      h('div', { class: 'og-brand' }, h('b', {}, 'OG Debugger'), el.org = h('span', { class: 'og-org' }, DEMO ? 'demo org' : HOST || '…')),
      h('button', { class: 'og-x', title: 'Close (Esc)', 'aria-label': 'Close the panel', onclick: () => tellPage({ type: 'close' }) }, '×')),
    el.tabs = h('nav', { class: 'og-tabs', role: 'tablist' }, tabBtn('record', 'Record'), tabBtn('users', 'Users'), tabBtn('tools', 'Tools')),
    el.body = h('main', { class: 'og-main' }, h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), 'Connecting…')));
  root.querySelector('.og-logo').innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="6" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="12" r="2.8"/><path d="M7.2 6.8 16.4 11M7.2 17.2 16.4 13" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>';
}

function showTab(k) {
  S.tab = k;
  store.set('og-panel-tab', k);
  for (const b of el.tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === k));
  if (!S.session) return;
  if (k === 'record') renderRecord();
  else if (k === 'users') renderUsers();
  else renderTools();
}

// ---------- Record tab ----------

let recSeq = 0;
async function renderRecord() {
  const seq = ++recSeq;
  const id = recordIdFromUrl(S.pageUrl);
  if (!id) {
    const input = h('input', { type: 'text', placeholder: 'Paste a record id (15 or 18 characters)', spellcheck: 'false', 'aria-label': 'Record id' });
    const goBtn = h('button', { class: 'primary small', onclick: () => openAllData(input.value.trim()) }, 'Show all data');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') goBtn.click(); });
    el.body.replaceChildren(h('div', { class: 'og-empty' },
      h('div', { class: 'og-empty-icon', 'aria-hidden': 'true' }, '📄'),
      h('b', {}, 'No record on this page'),
      h('p', {}, 'Open any record in Salesforce and it shows up here. Or look one up by its id:'),
      h('div', { class: 'og-idrow' }, input, goBtn)), freshCard());
    return;
  }
  el.body.replaceChildren(h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), 'Reading this record…'));
  try {
    const obj = objectFromUrl(S.pageUrl) || await S.records.objectForId(id);
    if (!obj) throw new Error('This page’s id doesn’t belong to an object your user can see.');
    const [desc, rec] = await Promise.all([S.records.describe(obj), S.records.get(obj, id)]);
    if (seq !== recSeq) return;
    S.rec = { obj, id, desc, rec };
    const nameF = desc.fields.find((f) => f.nameField);
    const name = (nameF && rec[nameF.name]) || rec.Name || id;
    const filled = desc.fields.filter((f) => rec[f.name] != null && rec[f.name] !== '').length;
    const fact = (label, v) => (v ? [h('dt', {}, label), h('dd', {}, v)] : null);
    el.body.replaceChildren(
      h('section', { class: 'og-card og-rec' },
        h('div', { class: 'og-rec-kicker' }, h('span', { class: 'og-obj' }, desc.label), h('code', {}, obj)),
        h('h2', { class: 'og-rec-name', title: name }, name),
        h('button', { class: 'og-idchip', title: 'Copy the record id', onclick: () => copyText(id, 'Id copied') }, h('code', {}, id), h('span', { 'aria-hidden': 'true' }, '⧉')),
        h('dl', { class: 'og-facts' },
          fact('Fields', `${desc.fields.length} · ${filled} with a value`),
          fact('Created', rec.CreatedDate ? ago(rec.CreatedDate) : null),
          fact('Modified', rec.LastModifiedDate ? ago(rec.LastModifiedDate) : null),
          fact('Record type', rec.RecordTypeId || null)),
        h('button', { class: 'og-primary', onclick: () => openAllData(id) },
          h('span', { class: 'og-primary-icon', 'aria-hidden': 'true' }, '▤'),
          h('span', {}, h('b', {}, 'Show all data'), h('small', {}, 'Every field with its label, type and value · edit, clone, export'))),
        el.apiBtn = h('button', {
          class: 'og-apinames', role: 'switch', 'aria-checked': String(!!S.apiNames),
          onclick: () => {
            S.apiCount = null;
            tellPage({ type: 'api-names', on: !S.apiNames, object: obj, fields: desc.fields.map((f) => ({ name: f.name, label: f.label })) });
            if (DEMO) { S.apiNames = !S.apiNames; paintApiNames(); }
          },
        },
        h('span', { class: 'og-apinames-i', 'aria-hidden': 'true' }, '🏷'),
        h('span', { class: 'og-apinames-text' }, h('b', {}, 'Show field API names'), el.apiSub = h('small', {}, 'Under each label on the page · click a name to copy it')),
        h('span', { class: 'og-switch', 'aria-hidden': 'true' }, h('i'))),
        h('div', { class: 'og-row' },
          h('button', { class: 'ghost small', onclick: () => copyText(JSON.stringify(Object.fromEntries(desc.fields.map((f) => [f.name, rec[f.name] ?? null])), null, 2), 'Copied as JSON') }, '{ } Copy JSON'),
          h('button', { class: 'ghost small', title: `Fields and relationships of ${obj} in Setup`, onclick: () => openTab(objectManagerUrl(S.ui, obj)) }, 'Object in Setup ↗'))),
      freshCard());
    paintApiNames();
  } catch (e) {
    if (seq !== recSeq) return;
    el.body.replaceChildren(h('div', { class: 'og-empty err' }, h('div', { class: 'og-empty-icon', 'aria-hidden': 'true' }, '🙈'), h('b', {}, 'Couldn’t read this record'), h('p', {}, e.message)), freshCard());
  }
}

// ---------- Empty cache & hard reload ----------
// The LWC you just deployed still looks old after a reload? Lightning serves component files from the
// browser cache. This empties this org's cache and reloads, skipping it: DevTools' "Empty cache and hard reload"
// in one click, without opening DevTools. The page (with this panel) reloads.
function freshCard() {
  const deep = store.get('og-fresh-deep', false);
  el.freshBtn = h('button', { class: 'og-fresh-btn', onclick: () => hardReload() },
    h('span', { class: 'og-fresh-i', 'aria-hidden': 'true' }, '⟳'),
    h('span', { class: 'og-fresh-text' }, h('b', {}, 'Empty cache & hard reload'), h('small', {}, 'Deployed an LWC change but still see the old one? Fix it in one click')));
  const link = (label, path) => h('button', { class: 'link', onclick: () => openTab(`https://${S.ui}${path}`) }, label);
  return h('section', { class: 'og-card og-fresh' },
    el.freshBtn,
    h('label', { class: 'og-fresh-opt', title: 'Also clears IndexedDB for this org, where Lightning keeps component definitions and cached data' },
      h('input', { type: 'checkbox', checked: deep, onchange: (e) => store.set('og-fresh-deep', e.target.checked) }),
      h('span', {}, 'Deep clean: also clear Lightning’s stored data', h('small', {}, 'For stubborn cases. The first load after is a little slower.'))),
    h('details', { class: 'og-fresh-more' },
      h('summary', {}, 'What it does · still stale?'),
      h('ul', {},
        h('li', {}, 'Empties the browser cache of ', h('b', {}, 'this org only'), ' (Lightning, My Domain, Setup, Visualforce and files), then reloads the page skipping the cache. Same as DevTools → Empty cache and hard reload.'),
        h('li', {}, 'You stay logged in. Cookies and other sites aren’t touched.'),
        h('li', {}, 'Still the old version? Check the deploy finished, then turn off ', h('i', {}, 'Enable secure and persistent browser caching'), ' while you develop: ', link('Session Settings ↗', '/lightning/setup/SecuritySession/home')),
        h('li', {}, 'Readable LWC errors while you debug: ', link('Debug Mode for your user ↗', '/lightning/setup/UserDebugMode/home'), ' (pages get slower, turn it off after).'))));
}

let freshTimer = 0;
function hardReload() {
  const btn = el.freshBtn;
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.querySelector('b').textContent = 'Emptying cache…';
  btn.querySelector('small').textContent = 'The page reloads in a moment';
  const deep = store.get('og-fresh-deep', false);
  if (DEMO) {
    freshTimer = setTimeout(() => { freshDone(); toast(`Demo: on a Salesforce page this empties the org’s cache${deep ? ' and Lightning’s stored data' : ''}, then reloads`, 'ok'); }, 900);
    return;
  }
  tellPage({ type: 'hard-reload', deep });
  // the page normally reloads (and this panel with it); if nothing happens, say so
  freshTimer = setTimeout(() => { freshDone(); toast('The page didn’t reload. Try again, or press Ctrl+Shift+R.', 'error'); }, 10000);
}
function freshDone(error) {
  clearTimeout(freshTimer);
  const btn = el.freshBtn;
  if (!btn?.isConnected) return;
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.querySelector('b').textContent = 'Empty cache & hard reload';
  btn.querySelector('small').textContent = 'Deployed an LWC change but still see the old one? Fix it in one click';
  if (error) toast(`Couldn’t empty the cache: ${error}`, 'error');
}

function paintApiNames() {
  if (!el.apiBtn?.isConnected) return;
  el.apiBtn.setAttribute('aria-checked', String(!!S.apiNames));
  el.apiSub.textContent = !S.apiNames ? 'Under each label on the page · click a name to copy it'
    : S.apiCount == null ? 'On · click a name on the page to copy it'
      : S.apiCount ? `On · ${S.apiCount} field${S.apiCount === 1 ? '' : 's'} tagged · more appear as sections open`
        : 'On · no field labels found yet. Open the Details tab, they appear as it loads';
}

function openAllData(id) {
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id || '')) { toast('That doesn’t look like a record id', 'error'); return; }
  const q = DEMO ? { demo: '1', id } : { host: HOST, id };
  openTab(`${globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL('record.html') : '/record.html'}?${new URLSearchParams(q)}`);
}

// ---------- Users tab ----------

const USER_FIELDS = 'Id, Name, Username, Email, Alias, IsActive, UserType, LanguageLocaleKey, LocaleSidKey, TimeZoneSidKey, LastLoginDate, Profile.Name, UserRole.Name';

async function currentUser() {
  if (DEMO) return demoUsers()[0];
  let id = null;
  try { id = (await S.api.request('/services/oauth2/userinfo')).user_id; } catch { /* try Chatter */ }
  if (!id) { try { id = (await S.api.request(`/services/data/${S.api.version}/chatter/users/me`)).id; } catch { /* unknown */ } }
  if (!id) return null;
  const [u] = await S.api.query(`SELECT ${USER_FIELDS} FROM User WHERE Id = '${id}'`);
  return u || null;
}

function demoUsers() {
  const roles = ['CEO', 'Sales Manager', 'Sales Rep', null, null, 'Support'];
  const profiles = ['System Administrator', 'Sales User', 'Standard User', 'Integration User', 'Automated Process', 'Standard User'];
  return S.records.db.User.map((u, i) => ({
    ...u, Alias: u.Name.split(' ').map((w) => w.slice(0, 3)).join('').slice(0, 6).toLowerCase(),
    LanguageLocaleKey: 'en_US', LocaleSidKey: i % 2 ? 'en_IN' : 'en_US', TimeZoneSidKey: 'Asia/Kolkata',
    LastLoginDate: new Date(Date.now() - i * 86400000 * 3).toISOString(),
    Profile: { Name: profiles[i] }, UserRole: roles[i] ? { Name: roles[i] } : null,
  }));
}

async function searchUsers(q) {
  if (DEMO) {
    const s = q.toLowerCase();
    return demoUsers().filter((u) => !s || [u.Name, u.Username, u.Email, u.Alias].some((x) => x?.toLowerCase().includes(s)));
  }
  const like = `'%${soqlStr(q)}%'`;
  const where = q ? `WHERE Name LIKE ${like} OR Username LIKE ${like} OR Email LIKE ${like} OR Alias LIKE ${like}` : 'WHERE IsActive = true';
  return S.api.query(`SELECT ${USER_FIELDS} FROM User ${where} ORDER BY IsActive DESC, LastLoginDate DESC NULLS LAST, Name LIMIT 30`);
}

function renderUsers() {
  el.search = h('input', {
    type: 'search', class: 'og-search', placeholder: 'Search by name, username, email or alias', spellcheck: 'false', autocomplete: 'off', value: S.q, 'aria-label': 'Search users',
    oninput: (e) => { S.q = e.target.value; clearTimeout(el.searchT); el.searchT = setTimeout(runSearch, 220); },
    onkeydown: (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); el.list.querySelector('.og-user-row')?.focus(); } },
  });
  el.list = h('div', { class: 'og-users' });
  el.body.replaceChildren(h('div', { class: 'og-searchbox' }, h('span', { class: 'og-search-icon', 'aria-hidden': 'true' }, '⌕'), el.search), el.list);
  if (S.users) drawUsers(); else runSearch();
  el.search.focus();
}

let searchSeq = 0;
async function runSearch() {
  const seq = ++searchSeq;
  el.list.classList.add('busy');
  try {
    const list = await searchUsers(S.q.trim());
    if (seq !== searchSeq) return;
    S.users = list;
    drawUsers();
  } catch (e) {
    el.list.replaceChildren(h('p', { class: 'og-note err' }, e.message));
  } finally {
    if (seq === searchSeq) el.list.classList.remove('busy');
  }
}

function drawUsers() {
  const me = S.me;
  const others = (S.users || []).filter((u) => u.Id !== me?.Id);
  const showMe = me && (!S.q.trim() || (S.users || []).some((u) => u.Id === me.Id));
  el.list.replaceChildren(
    showMe ? h('div', { class: 'og-group' }, 'You') : null,
    showMe ? userRow(me, true) : null,
    others.length ? h('div', { class: 'og-group' }, S.q.trim() ? `${others.length} match${others.length === 1 ? '' : 'es'}` : 'Active users · recently logged in') : null,
    ...others.map((u) => userRow(u, false)),
    !others.length && S.q.trim() && !showMe ? h('p', { class: 'og-note' }, `No user matches “${S.q.trim()}”.`) : null);
}

function avatar(u, big) {
  return h('span', { class: `og-avatar${big ? ' big' : ''}${u.IsActive === false ? ' off' : ''}`, style: `--h:${hue(u.Id)}`, 'aria-hidden': 'true' }, initials(u.Name));
}

function userRow(u, isMe) {
  const open = S.open === u.Id || (isMe && S.open == null);
  const head = h('button', {
    class: 'og-user-row', 'aria-expanded': String(open),
    onclick: () => { S.open = open ? '' : u.Id; drawUsers(); },
    onkeydown: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...el.list.querySelectorAll('.og-user-row')];
        rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    },
  },
  avatar(u),
  h('span', { class: 'og-user-main' },
    h('span', { class: 'og-user-name' }, u.Name, isMe ? h('span', { class: 'og-pill you' }, 'you') : null, u.IsActive === false ? h('span', { class: 'og-pill off' }, 'inactive') : null),
    h('span', { class: 'og-user-sub' }, u.Username)),
  h('span', { class: 'og-chev', 'aria-hidden': 'true' }, '▸'));
  return h('div', { class: `og-user${open ? ' open' : ''}` }, head, open ? userCard(u, isMe) : null);
}

function userCard(u, isMe) {
  const row = (k, v, copy) => (v ? [h('dt', {}, k), h('dd', {}, v, copy ? h('button', { class: 'og-copy', title: `Copy ${k.toLowerCase()}`, 'aria-label': `Copy ${k}`, onclick: () => copyText(copy, `${k} copied`) }, '⧉') : null)] : null);
  const lang = [u.LanguageLocaleKey, u.LocaleSidKey && u.LocaleSidKey !== u.LanguageLocaleKey ? u.LocaleSidKey : null].filter(Boolean).join(' · ');
  const can = !isMe && u.IsActive !== false;
  const why = isMe ? 'This is you' : u.IsActive === false ? 'Inactive users can’t be logged in as' : '';
  const pset = h('button', { class: 'og-act', title: 'Permission sets assigned to this user, in Setup', onclick: () => openTab(permSetAssignUrl(S.ui, u.Id)) }, h('span', { class: 'og-act-i', 'aria-hidden': 'true' }, '🛡'), 'PSet', h('span', { class: 'og-count', 'data-k': 'ps' }, '…'));
  const psetg = h('button', { class: 'og-act', title: 'Permission set groups assigned to this user: the user’s page in Setup lists them', onclick: () => openTab(userDetailUrl(S.ui, u.Id)) }, h('span', { class: 'og-act-i', 'aria-hidden': 'true' }, '🗂'), 'PSetG', h('span', { class: 'og-count', 'data-k': 'psg' }, '…'));
  const peek = h('div', { class: 'og-perm', hidden: true });
  const card = h('div', { class: 'og-ucard' },
    h('dl', { class: 'og-facts' },
      row('Username', u.Username, u.Username),
      row('Email', u.Email),
      row('Id', h('code', {}, u.Id), u.Id),
      row('Profile', u.Profile?.Name),
      row('Role', u.UserRole?.Name),
      row('Alias', u.Alias),
      row('Language', lang),
      row('Last login', ago(u.LastLoginDate))),
    h('div', { class: 'og-login' },
      h('button', { class: 'og-login-btn', disabled: !can, title: why || `Log in as ${u.Name} in this tab`, onclick: () => loginAs(u, false) },
        h('span', { class: 'og-act-i', 'aria-hidden': 'true' }, '↪'), h('span', {}, h('b', {}, 'Login as'), h('small', {}, 'in this tab'))),
      h('button', { class: 'og-login-btn incog', disabled: !can, title: why || `Log in as ${u.Name} in a private window, and stay logged in as yourself here`, onclick: () => loginAs(u, true) },
        h('span', { class: 'og-act-i', 'aria-hidden': 'true' }, '🕶'), h('span', {}, h('b', {}, 'Login in Incognito'), h('small', {}, 'you stay logged in here')))),
    h('div', { class: 'og-acts' },
      h('button', { class: 'og-act', title: 'This user’s page in Setup', onclick: () => openTab(userDetailUrl(S.ui, u.Id)) }, h('span', { class: 'og-act-i', 'aria-hidden': 'true' }, '👤'), 'Details'),
      pset, psetg,
      h('button', { class: 'og-act ghostly', title: 'Show the assigned permission sets and groups here', 'aria-expanded': 'false', onclick: (e) => togglePeek(u, peek, e.currentTarget) }, '▾')),
    peek);
  loadPermCounts(u, card);
  return card;
}

async function permsOf(u) {
  if (S.perm.has(u.Id)) return S.perm.get(u.Id);
  const p = (async () => {
    if (DEMO) {
      return {
        sets: [{ id: '0PS5g0000000001', name: 'Sales_Cloud_User', label: 'Sales Cloud User' }, { id: '0PS5g0000000002', name: 'API_Access', label: 'API Access' }].slice(0, u.Id.endsWith('1AAA') ? 2 : 1),
        groups: u.Id.endsWith('1AAA') ? [{ id: '0PG5g0000000001', name: 'Field_Service_Admins', label: 'Field Service Admins' }] : [],
      };
    }
    const rows = await S.api.query(`SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel
      FROM PermissionSetAssignment WHERE AssigneeId = '${u.Id}' AND PermissionSet.IsOwnedByProfile = false`);
    const sets = [];
    const groups = new Map();
    for (const r of rows) {
      if (r.PermissionSetGroupId) groups.set(r.PermissionSetGroupId, { id: r.PermissionSetGroupId, name: r.PermissionSetGroup?.DeveloperName, label: r.PermissionSetGroup?.MasterLabel });
      else sets.push({ id: r.PermissionSetId, name: r.PermissionSet?.Name, label: r.PermissionSet?.Label });
    }
    return { sets, groups: [...groups.values()] };
  })();
  S.perm.set(u.Id, p);
  p.catch(() => S.perm.delete(u.Id));
  return p;
}

async function loadPermCounts(u, card) {
  try {
    const { sets, groups } = await permsOf(u);
    card.querySelector('[data-k="ps"]').textContent = sets.length;
    card.querySelector('[data-k="psg"]').textContent = groups.length;
  } catch {
    for (const c of card.querySelectorAll('.og-count')) { c.textContent = '?'; c.title = 'Couldn’t count them (no access to PermissionSetAssignment?)'; }
  }
}

async function togglePeek(u, box, btn) {
  const open = box.hidden;
  box.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '▴' : '▾';
  if (!open) return;
  box.replaceChildren(h('div', { class: 'lg-loading' }, h('span', { class: 'lg-spinner' }), 'Loading…'));
  try {
    const { sets, groups } = await permsOf(u);
    const list = (title, items, url, empty) => h('div', { class: 'og-perm-sec' },
      h('div', { class: 'og-perm-title' }, title, h('span', { class: 'og-count' }, items.length)),
      items.length ? h('ul', {}, items.map((x) => h('li', {}, h('button', { class: 'link', title: x.name, onclick: () => openTab(url(S.ui, x.id)) }, x.label || x.name, ' ↗')))) : h('p', { class: 'og-note' }, empty));
    box.replaceChildren(
      list('Permission sets', sets, permSetUrl, 'None assigned directly.'),
      list('Permission set groups', groups, permSetGroupUrl, 'None assigned.'));
  } catch (e) {
    box.replaceChildren(h('p', { class: 'og-note err' }, e.message));
  }
}

function loginAs(u, incognito) {
  const url = loginAsUrl(S.session.apiHost, S.session.orgId, u.Id);
  if (DEMO) { toast(`Demo: this would log you in as ${u.Name}${incognito ? ' in a private window' : ''}`, 'ok'); return; }
  if (!incognito) { tellPage({ type: 'navigate', url }); return; }
  const go = () => chrome.windows.create({ url: frontdoorUrl(S.session.apiHost, S.session.sessionId, url.replace(/^https:\/\/[^/]+/, '')), incognito: true });
  if (!chrome.extension?.isAllowedIncognitoAccess) { go(); return; }
  chrome.extension.isAllowedIncognitoAccess((allowed) => {
    if (allowed) { go(); return; }
    // the extension isn't allowed in private windows yet: explain once, with a shortcut to the setting
    const card = el.list.querySelector('.og-user.open .og-ucard');
    card?.querySelector('.og-incog-help')?.remove();
    card?.append(h('div', { class: 'og-incog-help', role: 'note' },
      h('b', {}, 'One-time setup'),
      h('span', {}, 'Let OG Debugger run in Incognito: open its Details page and turn on “Allow in Incognito”. Then click the button again.'),
      h('button', { class: 'ghost small', onclick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }) }, 'Open extension settings ↗')));
  });
}

// ---------- Tools tab ----------

function renderTools() {
  const tool = (view, icon, title, sub) => h('button', {
    class: 'og-tool', onclick: () => openTab(`${globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL('app.html') : '/app.html'}?${new URLSearchParams(DEMO ? { demo: '1', view } : { host: HOST, view })}`),
  }, h('span', { class: 'og-tool-i', 'aria-hidden': 'true' }, icon), h('span', {}, h('b', {}, title), h('small', {}, sub)), h('span', { class: 'og-chev', 'aria-hidden': 'true' }, '↗'));
  el.body.replaceChildren(
    h('p', { class: 'og-lede' }, 'Open the full tool for this org in a new tab.'),
    h('div', { class: 'og-tools' },
      tool('flow', '🧭', 'Code Flow', 'Which Apex reads or writes a field, and how it gets there'),
      tool('logs', '🪵', 'Debug Logs', 'Trace a user, merge sessions, follow execution paths'),
      tool('data', '🗃', 'Data Export', 'SOQL with suggestions, export, edit and delete rows'),
      tool('import', '📥', 'Data Import', 'Paste from Excel, CSV or JSON: insert, update, upsert, delete, undelete'),
      tool('search', '🔎', 'FBI Search', 'Full-Base Inspector: got an error on this page? Find which Apex, flow or rule says it'),
      tool('api', '🕴️', 'The Informant', 'API client: collections, environments, cURL import, your Salesforce session'),
      tool('explorer', '🗂', 'OG Explorer', 'Read classes, triggers, LWC, Aura and Visualforce; click a call to jump to it'),
      tool('exec', '😎', 'The OG Executor', 'Run Batch, Queueable and Schedulable Apex or any Anonymous Apex, and watch the jobs')));
}

start();
