// Clicking the toolbar icon opens Salesforce OG Debugger in a full tab bound to the org of the current tab.
const SF_HOST_RE = /\.(salesforce|force|cloudforce|visualforce|salesforce-setup)\.(com|mil)$|\.sfcrmproducts\.cn$/i;

chrome.action.onClicked.addListener((tab) => {
  let host = '';
  try { host = new URL(tab.url).hostname; } catch { /* chrome:// pages etc. */ }
  const url = chrome.runtime.getURL('app.html') + (SF_HOST_RE.test(host) ? `?host=${encodeURIComponent(host)}` : '');
  chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
});
