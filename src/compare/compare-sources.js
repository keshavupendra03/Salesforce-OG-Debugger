// OG Code Compare: reading code from any org this browser is logged into (an SfApi per org, from The Informant's
// org registry), and a demo with production / preprod variants of the demo code.
//
// kinds: class, trigger, vfpage, vfcomp, lwc, aura
// list(kind)      → [{ key, name, id, modified, by, apiVersion, crc, size }]   (no bodies: quick)
// files(kind, it) → [{ name, text, lang, def? }]                              (one item's code)
// fingerprints(kind, items, progress) → Map(key → fingerprint)                 (VF / LWC / Aura: reads all bodies)
// labels()        → custom labels, in the shape labels.js expects

import { SfApi } from '../sf-api.js';
import { fingerprint } from './diff.js';
import { DEMO_UNITS } from '../demo-data.js';

export const KINDS = ['class', 'trigger', 'vfpage', 'vfcomp', 'lwc', 'aura'];
const AURA_EXT = { COMPONENT: '.cmp', APPLICATION: '.app', EVENT: '.evt', INTERFACE: '.intf', TOKENS: '.tokens', CONTROLLER: 'Controller.js', HELPER: 'Helper.js', RENDERER: 'Renderer.js', STYLE: '.css', DOCUMENTATION: '.auradoc', DESIGN: '.design', SVG: '.svg' };
const AURA_ORDER = Object.keys(AURA_EXT);
const LWC_ORDER = ['js', 'html', 'css', 'svg', 'xml'];
export const langOfFile = (name) => (/\.(cls|trigger|apex)$/i.test(name) ? 'apex' : /\.(js|ts)$/i.test(name) ? 'js' : /\.css$/i.test(name) ? 'css' : 'markup');
const inList = (ids) => ids.map((x) => `'${x}'`).join(',');
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const keyOf = (name) => String(name).toLowerCase();

export class OrgCode {
  constructor(org, sessionId) {
    this.org = org;
    this.host = org.apiHost;
    this.api = new SfApi({ apiHost: org.apiHost, sessionId });
    if (org.version) this.api.version = org.version;
    this.lists = new Map();
    this.bodies = new Map();
  }

  async ready() { if (!this.org.version) await this.api.init(); }

  // REST or Tooling, retrying without "LastModifiedBy.Name" where an object doesn't allow it
  async q(soql, tooling) {
    try { return await this.api.query(soql, { tooling }); } catch (e) {
      if (/LastModifiedBy\.Name/.test(soql) && /INVALID_FIELD|No such column|relationship/i.test(e.message)) return this.api.query(soql.replace(', LastModifiedBy.Name', ''), { tooling });
      throw e;
    }
  }

  async list(kind) {
    if (this.lists.has(kind)) return this.lists.get(kind);
    const p = this.loadList(kind).catch((e) => { this.lists.delete(kind); throw e; });
    this.lists.set(kind, p);
    return p;
  }

  async loadList(kind) {
    await this.ready();
    const meta = (r, name) => ({ key: keyOf(name), name, id: r.Id, modified: r.LastModifiedDate || null, by: r.LastModifiedBy?.Name || null, apiVersion: r.ApiVersion ?? null });
    if (kind === 'class' || kind === 'trigger') {
      const obj = kind === 'class' ? 'ApexClass' : 'ApexTrigger';
      let rows;
      try {
        rows = await this.q(`SELECT Id, Name, BodyCrc, ApiVersion, LengthWithoutComments, LastModifiedDate, LastModifiedBy.Name FROM ${obj} WHERE NamespacePrefix = null ORDER BY Name`);
      } catch {
        // no checksum here: the bodies are compared instead (fingerprints below)
        rows = await this.q(`SELECT Id, Name, ApiVersion, LastModifiedDate, LastModifiedBy.Name FROM ${obj} WHERE NamespacePrefix = null ORDER BY Name`);
      }
      return rows.map((r) => ({ ...meta(r, r.Name), crc: r.BodyCrc ?? null, size: r.LengthWithoutComments ?? null }));
    }
    if (kind === 'vfpage' || kind === 'vfcomp') {
      const obj = kind === 'vfpage' ? 'ApexPage' : 'ApexComponent';
      const rows = await this.q(`SELECT Id, Name, ApiVersion, LastModifiedDate, LastModifiedBy.Name FROM ${obj} WHERE NamespacePrefix = null ORDER BY Name`);
      return rows.map((r) => meta(r, r.Name));
    }
    const obj = kind === 'lwc' ? 'LightningComponentBundle' : 'AuraDefinitionBundle';
    const rows = await this.q(`SELECT Id, DeveloperName, ApiVersion, LastModifiedDate, LastModifiedBy.Name FROM ${obj} WHERE NamespacePrefix = null ORDER BY DeveloperName`, true);
    return rows.map((r) => meta(r, r.DeveloperName));
  }

  async files(kind, item) {
    const k = `${kind}:${item.id}`;
    if (!this.bodies.has(k)) this.bodies.set(k, this.loadFiles(kind, item).catch((e) => { this.bodies.delete(k); throw e; }));
    return this.bodies.get(k);
  }

  async loadFiles(kind, item) {
    if (kind === 'class' || kind === 'trigger') {
      const [r] = await this.q(`SELECT Body FROM ${kind === 'class' ? 'ApexClass' : 'ApexTrigger'} WHERE Id = '${item.id}'`);
      return [{ name: `${item.name}.${kind === 'class' ? 'cls' : 'trigger'}`, text: r?.Body || '', lang: 'apex' }];
    }
    if (kind === 'vfpage' || kind === 'vfcomp') {
      const [r] = await this.q(`SELECT Markup FROM ${kind === 'vfpage' ? 'ApexPage' : 'ApexComponent'} WHERE Id = '${item.id}'`);
      return [{ name: `${item.name}.${kind === 'vfpage' ? 'page' : 'component'}`, text: r?.Markup || '', lang: 'markup' }];
    }
    return (await this.bundleFiles(kind, [item.id])).get(item.id) || [];
  }

  // LWC / Aura bundles: every file of the given bundles
  async bundleFiles(kind, ids) {
    const out = new Map(ids.map((id) => [id, []]));
    for (const part of chunks(ids, 50)) {
      if (kind === 'lwc') {
        const rows = await this.q(`SELECT FilePath, Source, LightningComponentBundleId FROM LightningComponentResource WHERE LightningComponentBundleId IN (${inList(part)})`, true);
        for (const r of rows) {
          const name = String(r.FilePath || '').split('/').pop();
          out.get(r.LightningComponentBundleId)?.push({ name, text: r.Source || '', lang: langOfFile(name), order: LWC_ORDER.indexOf(name.split('.').pop()) });
        }
      } else {
        const rows = await this.q(`SELECT DefType, Source, AuraDefinitionBundleId, AuraDefinitionBundle.DeveloperName FROM AuraDefinition WHERE AuraDefinitionBundleId IN (${inList(part)})`, true);
        for (const r of rows) {
          const bundle = r.AuraDefinitionBundle?.DeveloperName || 'bundle';
          const name = `${bundle}${AURA_EXT[r.DefType] || `.${String(r.DefType).toLowerCase()}`}`;
          out.get(r.AuraDefinitionBundleId)?.push({ name, def: String(r.DefType).toLowerCase(), text: r.Source || '', lang: langOfFile(name), order: AURA_ORDER.indexOf(r.DefType) });
        }
      }
    }
    for (const files of out.values()) files.sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order) || a.name.localeCompare(b.name));
    return out;
  }

  /** Fingerprints of every item of a kind (Apex: Salesforce's own checksum, no download). */
  async fingerprints(kind, items, progress = () => {}, { bodies = false } = {}) {
    const out = new Map();
    if (kind === 'class' || kind === 'trigger') {
      if (!bodies && items.every((it) => it.crc != null)) { for (const it of items) out.set(it.key, `crc:${it.crc}:${it.size}`); return out; }
      const obj = kind === 'class' ? 'ApexClass' : 'ApexTrigger';
      let done = 0;
      for (const part of chunks(items, 200)) {
        const rows = await this.q(`SELECT Id, Name, Body FROM ${obj} WHERE Id IN (${inList(part.map((it) => it.id))})`);
        for (const r of rows) {
          out.set(keyOf(r.Name), fingerprint(r.Body));
          this.bodies.set(`${kind}:${r.Id}`, Promise.resolve([{ name: `${r.Name}.${kind === 'class' ? 'cls' : 'trigger'}`, text: r.Body || '', lang: 'apex' }]));
        }
        done += part.length;
        progress(done / Math.max(1, items.length));
      }
      return out;
    }
    if (kind === 'vfpage' || kind === 'vfcomp') {
      const rows = await this.q(`SELECT Id, Name, Markup FROM ${kind === 'vfpage' ? 'ApexPage' : 'ApexComponent'} WHERE NamespacePrefix = null`);
      for (const r of rows) {
        out.set(keyOf(r.Name), fingerprint(r.Markup));
        this.bodies.set(`${kind}:${r.Id}`, Promise.resolve([{ name: `${r.Name}.${kind === 'vfpage' ? 'page' : 'component'}`, text: r.Markup || '', lang: 'markup' }]));
      }
      return out;
    }
    const ids = items.map((it) => it.id);
    let done = 0;
    for (const part of chunks(ids, 50)) {
      const files = await this.bundleFiles(kind, part);
      for (const [id, list] of files) {
        const it = items.find((x) => x.id === id);
        out.set(it.key, fingerprint(list.map((f) => `${f.name}\n${f.text}`).join('\n\u0000\n')));
        this.bodies.set(`${kind}:${id}`, Promise.resolve(list));
      }
      done += part.length;
      progress(done / Math.max(1, ids.length));
    }
    return out;
  }

  async labels() {
    await this.ready();
    const rows = await this.q('SELECT Id, Name, Value, MasterLabel, Category FROM ExternalString WHERE NamespacePrefix = null', true);
    return rows.map((l) => ({ name: l.Name, sub: l.Category || '', lines: [{ label: 'Value', text: l.Value || '' }, { label: 'Short description', text: l.MasterLabel || '' }], link: setupLink(this.host, 'ExternalStrings', l.Id) }));
  }

  setupUrl(kind, item) {
    const page = { class: 'ApexClasses', trigger: 'ApexTriggers', vfpage: 'ApexPages', vfcomp: 'ApexComponents' }[kind];
    if (page) return setupLink(this.host, page, item.id);
    return `https://${this.host}/lightning/setup/LightningComponentBundles/home`;
  }

  reset() { this.lists.clear(); this.bodies.clear(); }
}

const setupLink = (host, page, id) => `https://${host}/lightning/setup/${page}/page?address=${encodeURIComponent(`/${id}`)}`;

// ---------- demo: the demo code, as preprod has it (this tab's org), and older / different copies ----------

const day = (d) => new Date(Date.UTC(2026, 9, d, 9, 30)).toISOString();

// production is a release behind preprod: methods in another order, an older line or two, a class not yet deployed
const PROD_EDITS = {
  AccountTriggerHandler: (b) => {
    const ins = /\n    protected override void beforeInsert\(\) \{[\s\S]*?\n    \}\n/.exec(b);
    const upd = /\n    protected override void beforeUpdate\(\) \{[\s\S]*?\n    \}\n/.exec(b);
    if (!ins || !upd) return b;
    // beforeUpdate came first in production; preprod moved beforeInsert above it
    return b.replace(ins[0], '\n').replace(upd[0], `${upd[0]}${ins[0]}`).replace(/\n\n\n/g, '\n\n');
  },
  AccountService: (b) => b.replace('acc.Industry.trim().toLowerCase()', 'acc.Industry.toLowerCase()').replace(/\n\s*System\.debug\(JSON\.serialize[^\n]*/, ''),
  OpportunityService: (b) => b.replace(/\n\n    public static String closeReasonMessage\(\) \{[\s\S]*?\n    \}/, ''),
};
const PROD_ONLY = [{ name: 'LegacyAccountSync', kind: 'class', body: `public with sharing class LegacyAccountSync {
    // Replaced by AccountService.normalizeIndustry in the spring release
    public static void sync(List<Account> accounts) {
        for (Account a : accounts) {
            a.Description = 'Synced ' + System.now();
        }
        update accounts;
    }
}` }];
const NOT_IN_PROD = new Set(['LeadConversionService']);

export class DemoOrgCode {
  constructor(org, variant) {
    this.org = org;
    this.host = org.apiHost;
    this.variant = variant; // 'preprod' (this tab's org, = the demo code), 'production', 'dev', 'globex'
    this.cache = null;
  }

  async data() {
    if (this.cache) return this.cache;
    const { DemoSearchSources } = await import('../search/demo-search.js');
    const src = new DemoSearchSources();
    const [vf, lwc, aura, labels] = await Promise.all(['vf', 'lwc', 'aura', 'label'].map((g) => src.load(g)));
    const v = this.variant;
    const items = Object.fromEntries(['class', 'trigger', 'vfpage', 'vfcomp', 'lwc', 'aura'].map((k) => [k, []]));
    const add = (kind, name, files, modified, by) => items[kind].push({
      key: keyOf(name), name, id: `${kind}-${keyOf(name)}-${v}`, modified, by, apiVersion: v === 'production' ? 61 : 62,
      files, crc: null, size: null,
    });
    const units = v === 'dev' ? DEMO_UNITS.slice(0, 3) : v === 'globex' ? DEMO_UNITS.slice(2, 5) : DEMO_UNITS;
    for (const u of units) {
      if (v === 'production' && NOT_IN_PROD.has(u.name)) continue;
      const body = v === 'production' && PROD_EDITS[u.name] ? PROD_EDITS[u.name](u.body) : u.body;
      const changed = v === 'production' && PROD_EDITS[u.name];
      add(u.kind === 'trigger' ? 'trigger' : 'class', u.name, [{ name: `${u.name}.${u.kind === 'trigger' ? 'trigger' : 'cls'}`, text: body, lang: 'apex' }],
        v === 'preprod' && changedInPreprod(u.name) ? day(20) : day(changed ? 2 : 1), v === 'preprod' && changedInPreprod(u.name) ? 'Priya Sharma' : 'Deployment User');
    }
    if (v === 'production') for (const p of PROD_ONLY) add(p.kind, p.name, [{ name: `${p.name}.cls`, text: p.body, lang: 'apex' }], day(1), 'Deployment User');
    if (v === 'preprod' || v === 'production') {
      for (const d of vf) add(d.sub === 'component' ? 'vfcomp' : 'vfpage', d.name, [{ name: `${d.name}.${d.sub === 'component' ? 'component' : 'page'}`, text: d.lines.map((l) => l.text).join('\n'), lang: 'markup' }], day(1), 'Deployment User');
      const bundles = new Map();
      for (const d of lwc) {
        if (!bundles.has(d.name)) bundles.set(d.name, []);
        let text = d.lines.map((l) => l.text).join('\n');
        if (v === 'production' && /\.js$/.test(d.sub)) text = text.replace("title: 'Can’t close'", "title: 'Error'").replace("e.body?.message || 'Unknown error'", "'Unknown error'");
        bundles.get(d.name).push({ name: d.sub, text, lang: langOfFile(d.sub) });
      }
      for (const [name, files] of bundles) add('lwc', name, files, v === 'preprod' ? day(20) : day(1), v === 'preprod' ? 'Priya Sharma' : 'Deployment User');
      const ab = new Map();
      for (const d of aura) {
        if (!ab.has(d.name)) ab.set(d.name, []);
        const name = `${d.name}${AURA_EXT[d.sub.toUpperCase()] || `.${d.sub}`}`;
        ab.get(d.name).push({ name, def: d.sub, text: d.lines.map((l) => l.text).join('\n'), lang: langOfFile(name) });
      }
      for (const [name, files] of ab) add('aura', name, files, day(1), 'Deployment User');
    }
    for (const list of Object.values(items)) {
      for (const it of list) { const fp = fingerprint(it.files.map((f) => `${f.name}\n${f.text}`).join('\n\u0000\n')); it.crc = fp; it.size = fp; }
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    const labelList = labels.map((l) => (v === 'production' && l.name === 'Close_Reason_Missing'
      ? { ...l, lines: [{ label: 'Value', text: 'Please choose a close reason.' }, ...l.lines.slice(1)] } : l));
    this.cache = { items, labels: v === 'preprod' || v === 'production' ? labelList : labelList.slice(0, 1) };
    return this.cache;
  }

  async list(kind) { await new Promise((r) => setTimeout(r, 120)); return (await this.data()).items[kind]; }
  async files(kind, item) { return item.files; }
  async fingerprints(kind, items) { return new Map(items.map((it) => [it.key, it.crc])); }
  async labels() { return (await this.data()).labels; }
  setupUrl(kind, item) { return `https://${this.host}/lightning/setup/${{ class: 'ApexClasses', trigger: 'ApexTriggers', vfpage: 'ApexPages', vfcomp: 'ApexComponents' }[kind] || 'LightningComponentBundles'}/home?demo=${encodeURIComponent(item.name)}`; }
  reset() { this.cache = null; }
}

const changedInPreprod = (name) => Object.hasOwn(PROD_EDITS, name) || NOT_IN_PROD.has(name);

/** The demo variant of a demo org (see DemoOrgRegistry in src/informant/orgs.js). */
export function demoVariant(host) {
  if (/--preprod\./.test(host)) return 'preprod';
  if (/^acme\.my\./.test(host)) return 'production';
  if (/kyadav/.test(host)) return 'dev';
  return 'globex';
}
