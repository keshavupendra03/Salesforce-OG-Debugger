// Clicking the toolbar icon opens Salesforce OG Debugger in a full tab bound to the org of the current tab.
const SF_HOST_RE = /\.(salesforce|force|cloudforce|visualforce|salesforce-setup)\.(com|mil)$|\.sfcrmproducts\.cn$/i;

// ---------- Empty cache & hard reload (OG panel → Record tab) ----------
// Like DevTools' "Empty cache and hard reload", but only for this org: Lightning keeps LWC / Aura component
// files in the browser cache, so a plain reload can still show the old component after a deploy.
// Cookies are never touched, so you stay logged in.

// Every origin the org's pages and files come from: Lightning, My Domain, Setup, Visualforce, files, static.
function orgOrigins(host) {
  const m = /^([\w-]+?)(\.(?:sandbox|develop|scratch|trailblaze|demo))?\.(lightning\.force|my\.salesforce|my\.salesforce-setup|my\.salesforce-static)\.(com|mil)$/i.exec(host);
  if (!m) return [`https://${host}`];
  const [, name, kind = '', , tld] = m;
  const base = name.replace(/--c$/i, '');
  return [...new Set([
    `https://${host}`,
    `https://${base}${kind}.lightning.force.${tld}`,
    `https://${base}${kind}.my.salesforce.${tld}`,
    `https://${base}${kind}.my.salesforce-setup.${tld}`,
    `https://${base}${kind}.my.salesforce-static.${tld}`,
    `https://${base}--c${kind}.vf.force.${tld}`,
    `https://${base}${kind}.file.force.${tld}`,
  ].map((o) => o.toLowerCase()))];
}

async function hardReload(tabId, { deep } = {}) {
  const tab = await chrome.tabs.get(tabId);
  const host = new URL(tab.url).hostname;
  if (!SF_HOST_RE.test(host)) throw new Error('This isn’t a Salesforce page.');
  const origins = orgOrigins(host);
  // cache: the HTTP cache (component files, static resources); cacheStorage + serviceWorkers: anything
  // Lightning keeps offline; deep adds IndexedDB, where Lightning stores component definitions and data
  const types = { cache: true, cacheStorage: true, serviceWorkers: true, ...(deep ? { indexedDB: true } : {}) };
  await chrome.browsingData.remove({ origins, since: 0 }, types);
  await chrome.tabs.reload(tabId, { bypassCache: true });
  return { ok: true, origins: origins.length };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'og-hard-reload') return false;
  const tabId = sender.tab?.id;
  if (tabId == null) { reply({ ok: false, error: 'No tab to reload.' }); return false; }
  hardReload(tabId, msg).then(reply, (e) => reply({ ok: false, error: e?.message || String(e) }));
  return true; // reply comes later
});

chrome.action.onClicked.addListener((tab) => {
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* chrome:// pages etc. */ }
  const url = chrome.runtime.getURL('app.html') + (SF_HOST_RE.test(host) ? `?host=${encodeURIComponent(host)}` : '');
  chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
});
