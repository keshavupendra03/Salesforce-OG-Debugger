// Data Export backend for a real org: SOQL (query / queryAll / Tooling) with paging and abort,
// describes for autocomplete, and record deletes through the composite API.

const ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export class SfDataBackend {
  constructor(api, session) {
    this.api = api;
    this.session = session;
    this.orgKey = session?.orgId || session?.apiHost || 'org';
  }

  get base() { return `/services/data/${this.api.version}`; }

  async listObjects({ tooling = false } = {}) {
    const r = await this.api.request(`${this.base}/${tooling ? 'tooling/' : ''}sobjects/`);
    return r.sobjects.filter((o) => o.queryable).map((o) => ({ name: o.name, label: o.label, custom: o.custom }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describe(name, { tooling = false } = {}) {
    const r = await this.api.request(`${this.base}/${tooling ? 'tooling/' : ''}sobjects/${encodeURIComponent(name)}/describe/`);
    return {
      name: r.name,
      fields: r.fields.map((f) => ({
        name: f.name, label: f.label, type: f.type, relationshipName: f.relationshipName || null, referenceTo: f.referenceTo || [],
        picklist: (f.picklistValues || []).filter((p) => p.active).map((p) => p.value),
      })).sort((a, b) => a.name.localeCompare(b.name)),
      children: (r.childRelationships || []).filter((c) => c.relationshipName).map((c) => ({ name: c.relationshipName, object: c.childSObject })),
    };
  }

  /** First page: { records, totalSize, done, next }. */
  async query(soql, { tooling = false, all = false, signal } = {}) {
    const ep = tooling ? 'tooling/query' : all ? 'queryAll' : 'query';
    const r = await this.api.request(`${this.base}/${ep}/?q=${encodeURIComponent(soql)}`, { signal });
    return { records: r.records || [], totalSize: r.totalSize, done: r.done, next: r.done ? null : r.nextRecordsUrl };
  }

  async more(next, { signal } = {}) {
    const r = await this.api.request(next, { signal });
    return { records: r.records || [], totalSize: r.totalSize, done: r.done, next: r.done ? null : r.nextRecordsUrl };
  }

  /** Deletes in batches of 200. Returns [{ id, success, error }]. */
  async deleteRecords(ids, { onProgress } = {}) {
    if (!ids.every((id) => ID_RE.test(id))) throw new Error('Invalid record id.');
    const out = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await this.api.request(`${this.base}/composite/sobjects?ids=${chunk.join(',')}&allOrNone=false`, { method: 'DELETE' });
      for (const x of r || []) out.push({ id: x.id, success: x.success, error: x.errors?.map((e) => e.message).join('; ') || null });
      onProgress?.(Math.min(ids.length, i + 200), ids.length);
    }
    return out;
  }

  recordUrl(id) {
    const ui = this.session?.uiHost;
    if (ui && /\.lightning\.force\.com$/i.test(ui)) return `https://${ui}/lightning/r/${id}/view`;
    return `https://${ui || this.session?.apiHost}/${id}`;
  }
}
