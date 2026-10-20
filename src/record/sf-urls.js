// Salesforce URLs the record panel and the All data page need: which record a page shows,
// Setup pages for a user, and Login as. Pure functions, so they're covered by the tests.

const ID = '[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?';
const isId = (s) => new RegExp(`^${ID}$`).test(s || '');

/** The record id a Salesforce page URL points at, or null. */
export function recordIdFromUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const path = decodeURIComponent(u.pathname);
  // Lightning: /lightning/r/Account/001.../view, /lightning/r/001.../view
  let m = new RegExp(`^/lightning/r/(?:\\w+/)?(${ID})(?:/|$)`).exec(path);
  if (m) return m[1];
  // Setup pages wrap a classic URL: /lightning/setup/ManageUsers/page?address=%2F005...%3Fnoredirect%3D1
  const address = u.searchParams.get('address');
  if (address) {
    const inner = recordIdFromUrl(`${u.origin}${address.startsWith('/') ? '' : '/'}${address}`);
    if (inner) return inner;
  }
  // Classic: /001..., /001.../e, ?id=001...
  m = new RegExp(`^/(${ID})(?:/|$)`).exec(path);
  if (m && !/^(apex|home|setup|lightning|secur|servlet|_ui)$/i.test(m[1])) return m[1];
  const q = u.searchParams.get('id');
  return isId(q) ? q : null;
}

/** The object name in a Lightning record URL (/lightning/r/Account/...), when it's there. */
export function objectFromUrl(href) {
  try {
    const m = new RegExp(`^/lightning/r/(\\w+)/${ID}(?:/|$)`).exec(decodeURIComponent(new URL(href).pathname));
    return m ? m[1] : null;
  } catch { return null; }
}

/** Lightning host for an org: the UI host when it's already Lightning, else derived from the My Domain API host. */
export function lightningHost({ uiHost, apiHost }) {
  if (uiHost && /\.lightning\.force\.com$/i.test(uiHost)) return uiHost;
  const h = apiHost || uiHost || '';
  return h.replace(/\.my\.salesforce\.com$/i, '.lightning.force.com');
}

const setup = (base, page, address) => `https://${base}/lightning/setup/${page}/page?address=${encodeURIComponent(address)}`;

export const userDetailUrl = (base, userId) => setup(base, 'ManageUsers', `/${userId}?noredirect=1&isUserEntityOverride=1`);
export const permSetAssignUrl = (base, userId) => setup(base, 'PermSets', `/udd/PermissionSet/assignPermissionSet.apexp?userId=${userId}`);
export const permSetUrl = (base, id) => setup(base, 'PermSets', `/${id}`);
export const permSetGroupUrl = (base, id) => setup(base, 'PermSetGroups', `/${id}`);
export const objectManagerUrl = (base, object) => `https://${base}/lightning/setup/ObjectManager/${encodeURIComponent(object)}/FieldsAndRelationships/view`;
export const recordViewUrl = (base, object, id) => `https://${base}/lightning/r/${object ? `${encodeURIComponent(object)}/` : ''}${id}/view`;

/** Login as another user (Setup → Users → Login): runs on the classic My Domain host. */
export function loginAsUrl(apiHost, orgId, userId) {
  const q = new URLSearchParams({ oid: orgId, suorgadminid: userId, retURL: '/', targetURL: '/home/home.jsp' });
  return `https://${apiHost}/servlet/servlet.su?${q}`;
}

/**
 * The same, in a fresh browser session: frontdoor.jsp signs the incognito window in with the current
 * admin session, then continues to Login as. The normal window stays logged in as you.
 */
export function frontdoorUrl(apiHost, sessionId, retPath) {
  return `https://${apiHost}/secur/frontdoor.jsp?${new URLSearchParams({ sid: sessionId, retURL: retPath })}`;
}

/** A readable type: "picklist (255), restricted", "currency (16, 2)", "reference → Account". */
export function fieldTypeText(f) {
  let t = f.type;
  if (f.type === 'reference' && f.referenceTo?.length) t = `reference → ${f.referenceTo.join(', ')}`;
  else if (['currency', 'double', 'percent'].includes(f.type) && f.precision) t += ` (${f.precision}, ${f.scale || 0})`;
  else if (['string', 'textarea', 'picklist', 'multipicklist', 'url', 'email', 'phone', 'encryptedstring', 'combobox'].includes(f.type) && f.length) t += ` (${f.length})`;
  else if (f.type === 'int' && f.digits) t += ` (${f.digits})`;
  return t;
}

/** Flags worth seeing next to a type: required, formula, restricted, unique… */
export function fieldFlags(f) {
  const out = [];
  if (f.calculated) out.push(f.autoNumber ? 'auto number' : 'formula');
  if (f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean') out.push('required');
  if (f.restrictedPicklist) out.push('restricted');
  if (f.externalId) out.push('external id');
  if (f.unique) out.push('unique');
  if (f.encrypted) out.push('encrypted');
  if (f.htmlFormatted) out.push('rich text');
  if (!f.updateable && !f.calculated && f.name !== 'Id') out.push('read only');
  return out;
}
