// Reuses the Salesforce session the user already has in the browser (same approach as
// Salesforce Inspector / Lightning Studio): read the `sid` cookie of the tab's org and find the
// matching cookie on the org's API domain (*.my.salesforce.com). Nothing is stored or sent elsewhere.

const API_DOMAINS = ['salesforce.com', 'cloudforce.com', 'salesforce.mil', 'cloudforce.mil', 'sfcrmproducts.cn', 'force.com'];

export const SF_HOST_RE = /\.(salesforce|force|cloudforce|visualforce|salesforce-setup)\.(com|mil)$|\.sfcrmproducts\.cn$/i;

export function isSalesforceHost(host) {
  return SF_HOST_RE.test(host || '');
}

export async function getSession(uiHost) {
  if (!globalThis.chrome?.cookies) {
    throw new Error('Cookie access is only available when this page runs inside the extension.');
  }
  const sid = await chrome.cookies.get({ url: `https://${uiHost}`, name: 'sid' });
  if (!sid) {
    throw new Error(`No Salesforce session found for ${uiHost}. Log in to Salesforce in this browser, then open Salesforce OG Debugger again from a Salesforce tab.`);
  }
  const orgId = sid.value.split('!')[0];
  for (const domain of API_DOMAINS) {
    const cookies = await chrome.cookies.getAll({ name: 'sid', domain, secure: true });
    const match = cookies.find((c) => c.value.startsWith(orgId + '!')
      && c.domain !== 'help.salesforce.com'
      && !/lightning\.force\.com$|\.vf\.force\.com$|visualforce\.com$/.test(c.domain));
    if (match) return { apiHost: match.domain.replace(/^\./, ''), sessionId: match.value, orgId, uiHost };
  }
  if (/\.my\.salesforce\.com$/i.test(uiHost)) return { apiHost: uiHost, sessionId: sid.value, orgId, uiHost };
  throw new Error('Found a Lightning session but not the matching API session. Open any Setup page once, then try again.');
}
