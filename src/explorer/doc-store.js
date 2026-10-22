// OG Explorer's documents: every Apex class and trigger, LWC, Aura component, Visualforce page and component.
// Apex comes from the Code Flow scan; components from the sources FBI Search reads (cached). Nothing new is
// downloaded.
//
// doc: { key, kind, name, sub, files: [{ name, text, lang }], file? (parsed Apex), link, readOnly, origin }
//   kind: 'class' | 'trigger' | 'lwc' | 'aura' | 'vfpage' | 'vfcomp'
//   origin: what a save would write to: { sobject, id, lastModified } (Apex), or per file for bundles.
//
// Editing is built for, not switched on: canSave() is false today. Saving later goes through the Tooling API
// (Apex: MetadataContainer + ApexClassMember / ApexTriggerMember + ContainerAsyncRequest, which compiles and
// reports errors per line; LWC: PATCH LightningComponentResource.Source; Aura: AuraDefinition.Source;
// Visualforce: ApexPage / ApexComponent.Markup), checking origin.lastModified first so nobody's change is lost.

export const DOC_KINDS = {
  class: { label: 'Apex classes', icon: 'C', ext: 'cls' },
  trigger: { label: 'Apex triggers', icon: 'T', ext: 'trigger' },
  lwc: { label: 'Lightning web components', icon: 'L', ext: 'js' },
  aura: { label: 'Aura components', icon: 'A', ext: 'cmp' },
  vfpage: { label: 'Visualforce pages', icon: 'P', ext: 'page' },
  vfcomp: { label: 'Visualforce components', icon: 'V', ext: 'component' },
};

const LWC_ORDER = ['js', 'html', 'css', 'svg', 'xml'];
const AURA_ORDER = ['component', 'application', 'event', 'interface', 'tokens', 'controller', 'helper', 'renderer', 'style', 'documentation', 'design', 'svg'];
const langOf = (name, code) => (code === 'apex' ? 'apex' : /\.(js|ts)$/i.test(name) || code === 'js' ? 'js' : /\.css$/i.test(name) ? 'css' : 'markup');

export class DocStore {
  /** index: the Code Flow CodeIndex; sources: FBI Search sources; setupUrl(unit) for Apex links. */
  constructor({ index, sources, setupUrl }) {
    this.index = index;
    this.sources = sources;
    this.setupUrl = setupUrl;
    this.docs = new Map();
    this.componentsLoaded = false;
  }

  /** Apex right away (it's in memory); components after, when they're read. */
  loadApex() {
    for (const f of this.index.files) {
      const u = f.unit;
      const kind = u.kind === 'trigger' ? 'trigger' : 'class';
      const key = `${kind}:${u.name.toLowerCase()}`;
      this.docs.set(key, {
        key, kind, name: u.name, sub: kind === 'trigger' ? `trigger on ${f.types[0]?.triggerObjectLabel || '…'}` : this.classSub(f),
        files: [{ name: `${u.name}.${DOC_KINDS[kind].ext}`, text: u.body, lang: 'apex' }], file: f,
        link: this.setupUrl?.(u) || null, readOnly: true,
        origin: { sobject: kind === 'trigger' ? 'ApexTrigger' : 'ApexClass', id: u.id, lastModified: u.lastModified || null },
      });
    }
  }

  classSub(f) {
    const t = f.types.find((x) => !x.outer);
    if (!t) return 'class';
    const bits = [t.kind === 'interface' ? 'interface' : t.isTest ? 'test class' : t.mods?.has('abstract') ? 'abstract class' : 'class'];
    const impl = (t.implements || []).map((s) => s.replace(/<.*$/, '').split('.').pop());
    if (impl.length) bits.push(`implements ${impl.slice(0, 3).join(', ')}`);
    else if (t.extends) bits.push(`extends ${t.extends}`);
    return bits.join(' · ');
  }

  async loadComponents(progress = () => {}) {
    const groups = {};
    for (const g of ['lwc', 'aura', 'vf']) {
      try { groups[g] = await this.sources.load(g, progress); } catch (e) { groups[g] = []; this.failed = [...(this.failed || []), `${g}: ${e.message}`]; }
    }
    const bundle = (docs, kind, order) => {
      const map = new Map();
      for (const d of docs) {
        const key = `${kind}:${d.name.toLowerCase()}`;
        if (!map.has(key)) map.set(key, { key, kind, name: d.name, sub: kind === 'lwc' ? 'Lightning web component' : 'Aura component', files: [], link: d.link, readOnly: true, origin: { files: [] } });
        const b = map.get(key);
        const ext = kind === 'lwc' ? String(d.sub || '').split('.').pop().toLowerCase() : String(d.sub || '').toLowerCase();
        b.files.push({ name: kind === 'lwc' ? d.sub : `${d.name} · ${d.sub}`, text: (d.lines || []).map((l) => l.text).join('\n'), lang: langOf(d.sub || '', d.code), order: order.indexOf(ext) < 0 ? 99 : order.indexOf(ext) });
        b.origin.files.push({ id: d.id });
      }
      for (const b of map.values()) b.files.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
      return [...map.values()];
    };
    for (const b of bundle(groups.lwc, 'lwc', LWC_ORDER)) this.docs.set(b.key, b);
    for (const b of bundle(groups.aura, 'aura', AURA_ORDER)) this.docs.set(b.key, b);
    for (const d of groups.vf) {
      const kind = d.sub === 'component' ? 'vfcomp' : 'vfpage';
      const key = `${kind}:${d.name.toLowerCase()}`;
      this.docs.set(key, {
        key, kind, name: d.name, sub: kind === 'vfcomp' ? 'Visualforce component' : 'Visualforce page',
        files: [{ name: `${d.name}.${DOC_KINDS[kind].ext}`, text: (d.lines || []).map((l) => l.text).join('\n'), lang: 'markup' }],
        link: d.link, readOnly: true, origin: { sobject: kind === 'vfcomp' ? 'ApexComponent' : 'ApexPage', id: d.id },
      });
    }
    this.componentsLoaded = true;
  }

  get(key) { return this.docs.get(key) || null; }
  list(kind) { return [...this.docs.values()].filter((d) => d.kind === kind).sort((a, b) => a.name.localeCompare(b.name)); }

  /** Where a method / class lives. */
  docOfUnit(unit) { return this.get(`${unit.kind === 'trigger' ? 'trigger' : 'class'}:${unit.name.toLowerCase()}`); }

  // ---- editing (not yet) ----
  canSave() { return false; }
  async save() { throw new Error('Saving from OG Explorer isn’t available yet.'); }
}
