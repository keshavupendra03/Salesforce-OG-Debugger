// Downloads Apex classes and triggers, re-using a local IndexedDB cache so that only classes
// whose LastModifiedDate changed are fetched again. The cache never leaves the browser.

const DB = 'field-flow';
const STORE = 'orgs';

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result ?? null);
    t.onerror = () => reject(t.error);
  });
}

export const loadCache = (orgId) => tx('readonly', (s) => s.get(orgId)).catch(() => null);
export const saveCache = (orgId, data) => tx('readwrite', (s) => s.put(data, orgId)).catch(() => null);
export const clearCache = (orgId) => tx('readwrite', (s) => s.delete(orgId)).catch(() => null);

async function pool(items, size, worker) {
  let i = 0;
  const run = async () => { while (i < items.length) { const item = items[i++]; await worker(item); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

export async function loadOrgCode(api, orgId, onProgress = () => {}) {
  onProgress('Listing Apex classes and triggers…', 0);
  const [classes, triggers] = await Promise.all([
    api.query('SELECT Id, Name, LastModifiedDate FROM ApexClass WHERE NamespacePrefix = null', { tooling: true }),
    api.query('SELECT Id, Name, LastModifiedDate FROM ApexTrigger WHERE NamespacePrefix = null', { tooling: true }),
  ]);

  const cached = await loadCache(orgId);
  const byId = new Map((cached?.units || []).map((u) => [u.id, u]));
  const units = [];
  const stale = [];
  for (const [kind, sobject, list] of [['class', 'ApexClass', classes], ['trigger', 'ApexTrigger', triggers]]) {
    for (const r of list) {
      const u = byId.get(r.Id);
      if (u && u.lastModified === r.LastModifiedDate) units.push(u);
      else stale.push({ kind, sobject, id: r.Id });
    }
  }

  const chunks = [];
  for (const sobject of ['ApexClass', 'ApexTrigger']) {
    const ids = stale.filter((s) => s.sobject === sobject);
    for (let i = 0; i < ids.length; i += 100) chunks.push({ sobject, kind: ids[0].kind, ids: ids.slice(i, i + 100) });
  }
  let done = 0;
  await pool(chunks, 4, async (c) => {
    const inList = c.ids.map((s) => `'${s.id}'`).join(',');
    const recs = await api.query(`SELECT Id, Name, Body, LastModifiedDate FROM ${c.sobject} WHERE Id IN (${inList})`, { tooling: true });
    for (const r of recs) units.push({ id: r.Id, name: r.Name, kind: c.kind, body: r.Body || '', lastModified: r.LastModifiedDate });
    done += c.ids.length;
    onProgress(`Downloading code… ${done} / ${stale.length}`, done / stale.length);
  });

  await saveCache(orgId, { units, savedAt: Date.now() });
  return { units, downloaded: stale.length, fromCache: units.length - stale.length };
}
