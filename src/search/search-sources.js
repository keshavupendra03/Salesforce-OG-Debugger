// OG Search sources for a real org: everything a user-facing error can come from, as searchable docs.
// Apex reuses the Code Flow download (cached in IndexedDB). Flow versions and validation-rule formulas need one
// Tooling request per item, so they're cached here per org (flow versions never change; rules by LastModifiedDate).

import { linesOf, flowLines, flowKind, flowTypeLabel, validationLines } from './search-engine.js';
import { lightningHost } from '../record/sf-urls.js';

// ---------- tiny IndexedDB key/value cache ----------
const DB = 'og-search';
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function getMany(keys) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const out = new Map();
      const t = d.transaction('kv', 'readonly');
      const s = t.objectStore('kv');
      for (const k of keys) { const r = s.get(k); r.onsuccess = () => { if (r.result !== undefined) out.set(k, r.result); }; }
      t.oncomplete = () => resolve(out);
      t.onerror = () => resolve(out);
    });
  } catch { return new Map(); }
}
async function putMany(entries) {
  if (!entries.length) return;
  try {
    const d = await db();
    await new Promise((resolve) => {
      const t = d.transaction('kv', 'readwrite');
      const s = t.objectStore('kv');
      for (const [k, v] of entries) s.put(v, k);
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
  } catch { /* cache is optional */ }
}
export async function clearSearchCache(orgKey) {
  try {
    const d = await db();
    await new Promise((resolve) => {
      const t = d.transaction('kv', 'readwrite');
      const s = t.objectStore('kv');
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (String(c.key).startsWith(`${orgKey}|`)) c.delete();
        c.continue();
      };
      t.oncomplete = resolve;
      t.onerror = resolve;
    });
  } catch { /* nothing cached */ }
}

async function pool(items, size, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const it = items[i++]; await worker(it); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}
const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const inList = (ids) => ids.map((id) => `'${id}'`).join(',');

export class SfSearchSources {
  constructor(api, session, { getApexUnits }) {
    this.api = api;
    this.orgKey = session.orgId;
    this.ui = lightningHost(session);
    this.getApexUnits = getApexUnits;
  }

  tq(soql) { return this.api.query(soql, { tooling: true }); }
  key(k) { return `${this.orgKey}|${k}`; }
  setup(page, id) { return `https://${this.ui}/lightning/setup/${page}/page?address=${encodeURIComponent(`/${id}`)}`; }

  /** Load one source group: 'apex' | 'flow' | 'validation' | 'vf' | 'lwc' | 'aura' | 'label'. */
  async load(group, progress = () => {}) {
    return this[`load_${group}`](progress);
  }

  async load_apex(progress) {
    progress('Reading Apex…');
    const units = await this.getApexUnits((text, f) => progress(text, f));
    return units.map((u) => ({
      kind: u.kind === 'trigger' ? 'trigger' : 'apex', id: u.id, name: u.name, sub: u.kind === 'trigger' ? 'trigger' : 'class',
      lines: linesOf(u.body), code: 'apex',
      link: this.setup(u.kind === 'trigger' ? 'ApexTriggers' : 'ApexClasses', u.id),
    }));
  }

  async load_flow(progress) {
    progress('Listing flows…');
    const defs = await this.tq('SELECT Id, DeveloperName, MasterLabel, ActiveVersionId, LatestVersionId, NamespacePrefix FROM FlowDefinition');
    // the version that runs (active), or the newest one when nothing is active
    const wanted = defs.filter((d) => !d.NamespacePrefix && (d.ActiveVersionId || d.LatestVersionId))
      .map((d) => ({ def: d, id: d.ActiveVersionId || d.LatestVersionId, active: !!d.ActiveVersionId }));
    const cached = await getMany(wanted.map((w) => this.key(`flow:${w.id}`)));
    const fresh = [];
    let done = 0;
    await pool(wanted.filter((w) => !cached.has(this.key(`flow:${w.id}`))), 6, async (w) => {
      try {
        const [f] = await this.tq(`SELECT Id, MasterLabel, ProcessType, Status, VersionNumber, Metadata FROM Flow WHERE Id = '${w.id}'`);
        if (f) {
          const md = f.Metadata || {};
          const v = { label: f.MasterLabel, processType: f.ProcessType, triggerType: md.start?.triggerType || null, object: md.start?.object || null,
            status: f.Status, version: f.VersionNumber, lines: flowLines(md) };
          cached.set(this.key(`flow:${w.id}`), v);
          fresh.push([this.key(`flow:${w.id}`), v]);
        }
      } catch { /* a flow we can't read: skip it */ }
      done++;
      progress(`Reading flows… ${done} new`, done / Math.max(1, wanted.length));
    });
    await putMany(fresh);
    return wanted.map((w) => {
      const v = cached.get(this.key(`flow:${w.id}`));
      if (!v) return null;
      const kind = flowKind(v.processType);
      return {
        kind, id: w.id, name: w.def.DeveloperName, sub: `${flowTypeLabel(v.processType, v.triggerType)}${v.object ? ` · ${v.object}` : ''} · v${v.version}${w.active ? '' : ' · inactive'}`,
        title: v.label, lines: v.lines, inactive: !w.active,
        link: kind === 'process' ? `https://${this.ui}/lightning/setup/ProcessAutomation/home` : `https://${this.ui}/builder_platform_interaction/flowBuilder.app?flowId=${w.id}`,
      };
    }).filter(Boolean);
  }

  async load_validation(progress) {
    progress('Listing validation rules…');
    let rules;
    try {
      rules = await this.tq('SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, EntityDefinition.QualifiedApiName, LastModifiedDate FROM ValidationRule WHERE NamespacePrefix = null');
    } catch {
      rules = await this.tq('SELECT Id, ValidationName, Active, Description, ErrorMessage, ErrorDisplayField, LastModifiedDate FROM ValidationRule WHERE NamespacePrefix = null');
    }
    // formulas live in Metadata, which Salesforce only returns one rule at a time
    const keyOf = (r) => this.key(`vr:${r.Id}:${r.LastModifiedDate}`);
    const cached = await getMany(rules.map(keyOf));
    const fresh = [];
    let done = 0;
    const todo = rules.filter((r) => !cached.has(keyOf(r)));
    await pool(todo, 6, async (r) => {
      try {
        const [m] = await this.tq(`SELECT Id, Metadata FROM ValidationRule WHERE Id = '${r.Id}'`);
        const formula = m?.Metadata?.errorConditionFormula || '';
        cached.set(keyOf(r), formula);
        fresh.push([keyOf(r), formula]);
      } catch { /* keep the message without the formula */ }
      done++;
      progress(`Reading rule formulas… ${done} / ${todo.length}`, done / Math.max(1, todo.length));
    });
    await putMany(fresh);
    return rules.map((r) => {
      const obj = r.EntityDefinition?.QualifiedApiName || null;
      return {
        kind: 'validation', id: r.Id, name: r.ValidationName, sub: `${obj || 'object'}${r.Active ? '' : ' · inactive'}`, inactive: !r.Active,
        lines: validationLines({ ...r, formula: cached.get(keyOf(r)) || '' }),
        link: obj ? `https://${this.ui}/lightning/setup/ObjectManager/${obj}/ValidationRules/${r.Id}/view` : this.setup('ObjectManager', ''),
      };
    });
  }

  async load_vf(progress) {
    progress('Reading Visualforce…');
    const [pages, comps] = await Promise.all([
      this.tq('SELECT Id, Name, Markup FROM ApexPage WHERE NamespacePrefix = null'),
      this.tq('SELECT Id, Name, Markup FROM ApexComponent WHERE NamespacePrefix = null'),
    ]);
    return [
      ...pages.map((p) => ({ kind: 'vf', id: p.Id, name: p.Name, sub: 'page', lines: linesOf(p.Markup), code: 'markup', link: this.setup('ApexPages', p.Id) })),
      ...comps.map((c) => ({ kind: 'vf', id: c.Id, name: c.Name, sub: 'component', lines: linesOf(c.Markup), code: 'markup', link: this.setup('ApexComponents', c.Id) })),
    ];
  }

  async load_lwc(progress) {
    progress('Listing Lightning web components…');
    const bundles = await this.tq('SELECT Id, DeveloperName FROM LightningComponentBundle WHERE NamespacePrefix = null');
    const byId = new Map(bundles.map((b) => [b.Id, b.DeveloperName]));
    const out = [];
    let done = 0;
    await pool(chunks(bundles.map((b) => b.Id), 50), 4, async (ids) => {
      const files = await this.tq(`SELECT Id, FilePath, Source, LightningComponentBundleId FROM LightningComponentResource WHERE LightningComponentBundleId IN (${inList(ids)})`);
      for (const f of files) {
        if (!f.Source) continue;
        out.push({ kind: 'lwc', id: f.Id, name: byId.get(f.LightningComponentBundleId) || 'lwc', sub: (f.FilePath || '').split('/').pop(), lines: linesOf(f.Source), code: /\.html$/.test(f.FilePath) ? 'markup' : 'js',
          link: `https://${this.ui}/lightning/setup/LightningComponentBundles/home` });
      }
      done += ids.length;
      progress(`Reading LWC… ${done} / ${bundles.length}`, done / Math.max(1, bundles.length));
    });
    return out;
  }

  async load_aura(progress) {
    progress('Listing Aura components…');
    const bundles = await this.tq('SELECT Id, DeveloperName FROM AuraDefinitionBundle WHERE NamespacePrefix = null');
    const byId = new Map(bundles.map((b) => [b.Id, b.DeveloperName]));
    const out = [];
    let done = 0;
    await pool(chunks(bundles.map((b) => b.Id), 50), 4, async (ids) => {
      const defs = await this.tq(`SELECT Id, DefType, Format, Source, AuraDefinitionBundleId FROM AuraDefinition WHERE AuraDefinitionBundleId IN (${inList(ids)})`);
      for (const d of defs) {
        if (!d.Source) continue;
        out.push({ kind: 'aura', id: d.Id, name: byId.get(d.AuraDefinitionBundleId) || 'aura', sub: d.DefType?.toLowerCase(), lines: linesOf(d.Source), code: d.Format === 'XML' ? 'markup' : 'js',
          link: `https://${this.ui}/lightning/setup/LightningComponentBundles/home` });
      }
      done += ids.length;
      progress(`Reading Aura… ${done} / ${bundles.length}`, done / Math.max(1, bundles.length));
    });
    return out;
  }

  async load_label(progress) {
    progress('Reading custom labels…');
    const labels = await this.tq('SELECT Id, Name, Value, MasterLabel, Category, Language FROM ExternalString WHERE NamespacePrefix = null');
    return labels.map((l) => ({
      kind: 'label', id: l.Id, name: l.Name, sub: [l.Category, l.Language].filter(Boolean).join(' · '),
      lines: [{ label: 'Value', text: l.Value || '' }, ...(l.MasterLabel && l.MasterLabel !== l.Value ? [{ label: 'Short description', text: l.MasterLabel }] : [])],
      link: this.setup('ExternalStrings', l.Id),
    }));
  }

  clearCache() { return clearSearchCache(this.orgKey); }
}
