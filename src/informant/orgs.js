// Salesforce orgs for The Informant: every org this browser is logged into, grouped into families
// (a production org and its sandboxes share a My Domain), with the session token of the logged-in user.
// Tokens come from the browser's own Salesforce login cookies and are never saved to storage.

import { SfApi } from '../sf-api.js';

// ---------- hosts (pure) ----------

const SUFFIXES = [
  [/^([a-z0-9-]+?)--([a-z0-9]+)\.sandbox\.my\.salesforce\.com$/i, 'sandbox'],
  [/^([a-z0-9-]+?)--([a-z0-9]+)\.sandbox\.my\.salesforce\.mil$/i, 'sandbox'],
  [/^([a-z0-9-]+?)(?:--([a-z0-9]+))?\.scratch\.my\.salesforce\.com$/i, 'scratch'],
  [/^([a-z0-9-]+?)(?:--([a-z0-9]+))?\.develop\.my\.salesforce\.com$/i, 'developer'],
  [/^([a-z0-9-]+?)(?:--([a-z0-9]+))?\.trailblaze\.my\.salesforce\.com$/i, 'trailhead'],
  [/^([a-z0-9-]+?)(?:--([a-z0-9]+))?\.demo\.my\.salesforce\.com$/i, 'demo'],
  [/^([a-z0-9-]+?)--([a-z0-9]+)\.(?:cs\d+\.)?my\.salesforce\.com$/i, 'sandbox'], // older sandbox My Domains
  [/^([a-z0-9-]+?)\.my\.salesforce\.com$/i, 'production'],
  [/^([a-z0-9-]+?)\.my\.salesforce\.mil$/i, 'production'],
];

/** "acme--uat.sandbox.my.salesforce.com" → { host, family: "acme", kind: "sandbox", sandbox: "uat" }, or null. */
export function parseOrgHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  for (const [re, kind] of SUFFIXES) {
    const m = re.exec(h);
    if (m) {
      // dev edition My Domains often end in "-dev-ed": that's a developer org even on .my.salesforce.com
      const k = kind === 'production' && /-dev-ed$/.test(m[1]) ? 'developer' : kind;
      return { host: h, family: m[1], kind: k, sandbox: m[2] || null };
    }
  }
  return null;
}

export const isOrgHost = (host) => !!parseOrgHost(host);

export const KIND_LABEL = { production: 'Production', sandbox: 'Sandbox', developer: 'Developer', scratch: 'Scratch', trailhead: 'Trailhead', demo: 'Demo' };

/** Short name for pickers: "preprod", "production", or the family for developer orgs. */
export function shortName(o) {
  const p = parseOrgHost(o.apiHost);
  if (!p) return o.name || o.apiHost;
  if (p.kind === 'sandbox' || p.sandbox) return p.sandbox;
  if (p.kind === 'production') return 'production';
  return p.family;
}

/** The URL with its host swapped for another org's (path, query and hash kept). */
export function switchHost(url, newHost) {
  return String(url).replace(/^(https?:\/\/)[^/?#]+/i, `$1${newHost}`);
}

/** The host of a (resolved) URL, or ''. */
export const hostOf = (url) => { try { return new URL(url).host.toLowerCase(); } catch { return ''; } };

/** Families: [{ family, orgs: [production first, then sandboxes by name] }], current family first. */
export function groupFamilies(orgs, currentHost) {
  const map = new Map();
  for (const o of orgs) {
    const p = parseOrgHost(o.apiHost);
    const key = p?.family || o.apiHost;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  }
  const rank = { production: 0, sandbox: 1, developer: 2, scratch: 3, trailhead: 4, demo: 5 };
  const fams = [...map].map(([family, list]) => ({
    family,
    orgs: list.sort((a, b) => (rank[parseOrgHost(a.apiHost)?.kind] ?? 9) - (rank[parseOrgHost(b.apiHost)?.kind] ?? 9) || shortName(a).localeCompare(shortName(b))),
  }));
  const cur = parseOrgHost(currentHost)?.family;
  return fams.sort((a, b) => Number(b.family === cur) - Number(a.family === cur) || a.family.localeCompare(b.family));
}

/** A token is shown as 00D5g…AbCd unless revealed. */
export const maskToken = (t) => (t ? `${t.slice(0, 15)}…${t.slice(-4)}` : '');

// ---------- the registry: real browser sessions ----------

const REG_KEY = 'og-informant-orgs:v1';
const loadReg = () => { try { return JSON.parse(localStorage.getItem(REG_KEY)) || []; } catch { return []; } };
const saveReg = (list) => { try { localStorage.setItem(REG_KEY, JSON.stringify(list)); } catch { /* storage blocked */ } };

/**
 * orgs: [{ apiHost, orgId, name, kind, isSandbox, instance, orgType, version, user: { id, name, username }, status, checkedAt, lastSeen }]
 * status: 'valid' | 'expired' | 'signedout' | 'error' | 'unknown'. Tokens stay in memory only.
 */
export class OrgRegistry {
  constructor({ currentHost } = {}) {
    this.orgs = loadReg();
    this.tokens = new Map();
    this.currentHost = currentHost || null;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { saveReg(this.orgs); for (const fn of this.listeners) fn(); }
  byHost(host) { return this.orgs.find((o) => o.apiHost === String(host || '').toLowerCase()) || null; }
  token(host) { return this.tokens.get(String(host || '').toLowerCase()) || null; }

  /** Find every org this browser is logged into (sid cookies on My Domain hosts). */
  async discover() {
    if (!globalThis.chrome?.cookies?.getAll) return this.orgs;
    let cookies = [];
    try { cookies = await chrome.cookies.getAll({ name: 'sid' }); } catch { cookies = []; }
    const seen = new Set();
    for (const c of cookies) {
      const host = c.domain.replace(/^\./, '').toLowerCase();
      if (!isOrgHost(host) || !c.value || !/^00D/.test(c.value)) continue;
      seen.add(host);
      this.tokens.set(host, c.value);
      let o = this.byHost(host);
      if (!o) { o = { apiHost: host, orgId: c.value.split('!')[0], status: 'unknown', lastSeen: Date.now() }; this.orgs.push(o); }
      o.lastSeen = Date.now();
      if (o.status === 'signedout') o.status = 'unknown';
    }
    // remembered orgs with no cookie now are signed out
    for (const o of this.orgs) if (!seen.has(o.apiHost)) { o.status = 'signedout'; this.tokens.delete(o.apiHost); }
    this.emit();
    return this.orgs;
  }

  /** Re-read the token and check it with Salesforce: who you are, which org, sandbox or not, API version. */
  async refresh(host) {
    host = host.toLowerCase();
    if (globalThis.chrome?.cookies?.get) {
      try {
        const c = await chrome.cookies.get({ url: `https://${host}/`, name: 'sid' });
        if (c?.value) this.tokens.set(host, c.value); else this.tokens.delete(host);
      } catch { /* keep what we had */ }
    }
    let o = this.byHost(host);
    if (!o) { o = { apiHost: host, status: 'unknown' }; this.orgs.push(o); }
    const tok = this.token(host);
    o.checkedAt = Date.now();
    if (!tok) { o.status = 'signedout'; this.emit(); return o; }
    const api = new SfApi({ apiHost: host, sessionId: tok });
    try {
      await api.init();
      const info = await api.request('/services/oauth2/userinfo').catch(() => null);
      const [org] = await api.query('SELECT Name, IsSandbox, InstanceName, OrganizationType FROM Organization').catch(() => []);
      Object.assign(o, {
        orgId: tok.split('!')[0], version: api.version, status: 'valid',
        name: org?.Name || o.name || null, isSandbox: org?.IsSandbox ?? o.isSandbox, instance: org?.InstanceName || o.instance || null, orgType: org?.OrganizationType || o.orgType || null,
        user: info ? { id: info.user_id, name: info.name, username: info.preferred_username } : o.user || null,
      });
    } catch (e) {
      o.status = e?.status === 401 ? 'expired' : 'error';
      o.error = e?.message || String(e);
    }
    this.emit();
    return o;
  }

  async refreshAll() {
    await this.discover();
    await Promise.all(this.orgs.filter((o) => o.status !== 'signedout').map((o) => this.refresh(o.apiHost)));
    return this.orgs;
  }

  forget(host) {
    this.orgs = this.orgs.filter((o) => o.apiHost !== host);
    this.tokens.delete(host);
    this.emit();
  }
}

// ---------- demo: pretend this browser is logged into five orgs ----------

const DEMO_ORGS = [
  { apiHost: 'acme.my.salesforce.com', name: 'Acme Corp', isSandbox: false, instance: 'AP24', orgType: 'Enterprise Edition', user: { name: 'Priya Sharma', username: 'priya.sharma@acme.com' } },
  { apiHost: 'acme--preprod.sandbox.my.salesforce.com', name: 'Acme Corp', isSandbox: true, instance: 'CS117', orgType: 'Enterprise Edition', user: { name: 'Priya Sharma', username: 'priya.sharma@acme.com.preprod' } },
  { apiHost: 'acme--uat.sandbox.my.salesforce.com', name: 'Acme Corp', isSandbox: true, instance: 'CS119', orgType: 'Enterprise Edition', user: { name: 'Priya Sharma', username: 'priya.sharma@acme.com.uat' }, expired: true },
  { apiHost: 'kyadav-dev-ed.develop.my.salesforce.com', name: 'Keshav Dev Org', isSandbox: false, instance: 'AP15', orgType: 'Developer Edition', user: { name: 'Keshav Yadav', username: 'keshav@dev.org' } },
  { apiHost: 'globex.my.salesforce.com', name: 'Globex', isSandbox: false, instance: 'NA231', orgType: 'Unlimited Edition', user: { name: 'Priya Sharma', username: 'priya@globex.com' } },
];

export class DemoOrgRegistry extends OrgRegistry {
  constructor() {
    super({ currentHost: DEMO_ORGS[1].apiHost });
    this.orgs = [];
  }

  emit() { for (const fn of this.listeners) fn(); } // the demo never touches storage

  async discover() {
    this.orgs = DEMO_ORGS.map((d, i) => ({
      apiHost: d.apiHost, orgId: `00D5g00000${String(i + 1).padStart(5, '0')}`, name: d.name, isSandbox: d.isSandbox, instance: d.instance,
      orgType: d.orgType, version: 'v62.0', user: { id: `0055g0000000${i + 1}AAA`, ...d.user },
      status: d.expired ? 'expired' : 'valid', checkedAt: Date.now(), lastSeen: Date.now(),
    }));
    for (const [i, d] of DEMO_ORGS.entries()) if (!d.expired) this.tokens.set(d.apiHost, `00D5g00000${String(i + 1).padStart(5, '0')}!AQ${'x'.repeat(20)}demo${i + 1}`);
    this.emit();
    return this.orgs;
  }

  async refresh(host) {
    await new Promise((r) => setTimeout(r, 300));
    const o = this.byHost(host);
    if (!o) return null;
    // refreshing an expired demo session "logs back in"
    if (o.status !== 'valid') {
      const i = this.orgs.indexOf(o);
      this.tokens.set(host, `00D5g00000${String(i + 1).padStart(5, '0')}!AQ${'y'.repeat(20)}fresh${i + 1}`);
    }
    Object.assign(o, { status: 'valid', checkedAt: Date.now() });
    this.emit();
    return o;
  }

  async refreshAll() { if (!this.orgs.length) await this.discover(); return this.orgs; }
  forget(host) { this.orgs = this.orgs.filter((o) => o.apiHost !== host); this.tokens.delete(host); this.emit(); }
}
