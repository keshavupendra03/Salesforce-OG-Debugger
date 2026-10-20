// The Informant: the parts of an API client that don't touch the DOM or the network.
// cURL import/export, code snippets (fetch, Python, Apex), {{variables}}, URL <-> params, Postman v2.1 import/export.

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const RAW_TYPES = { json: 'application/json', text: 'text/plain', xml: 'application/xml', html: 'text/html', javascript: 'application/javascript' };

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const newId = uid;
export const kv = (k = '', v = '', on = true, desc = '') => ({ k, v, on, desc });

export function newRequest(patch = {}) {
  return {
    id: uid(), name: 'New request', method: 'GET', url: '',
    params: [], headers: [],
    auth: { type: 'inherit', bearer: '', basic: { u: '', p: '' }, apikey: { k: '', v: '', in: 'header' } },
    body: { mode: 'none', raw: '', rawType: 'json', urlencoded: [], formdata: [] },
    settings: { timeout: 0, cookies: false },
    ...patch,
  };
}

// ---------- URL and params ----------

/** "https://x/y?a=1&b" → { base: "https://x/y", params: [kv('a','1'), kv('b','')], hash } — no decoding, so {{vars}} stay as typed. */
export function splitUrl(url) {
  const s = String(url || '');
  const hashAt = s.indexOf('#');
  const hash = hashAt >= 0 ? s.slice(hashAt) : '';
  const rest = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const q = rest.indexOf('?');
  if (q < 0) return { base: rest, params: [], hash };
  const params = rest.slice(q + 1).split('&').filter((p) => p !== '').map((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) return kv(p, '');
    const v = p.slice(eq + 1);
    return { ...kv(p.slice(0, eq), v), keepEq: v === '' }; // "a=" stays "a=", not "a"
  });
  return { base: rest.slice(0, q), params, hash };
}

/** Rebuild the URL from its base and the enabled params (disabled ones stay in the table only). */
export function joinUrl(base, params, hash = '') {
  const qs = params.filter((p) => p.on && p.k !== '').map((p) => (p.v === '' && !p.keepEq ? p.k : `${p.k}=${p.v}`)).join('&');
  return `${base}${qs ? `?${qs}` : ''}${hash}`;
}

/** After the URL was edited: the params table it implies, keeping disabled rows and descriptions. */
export function paramsFromUrl(url, old = []) {
  const { params } = splitUrl(url);
  const used = new Set();
  const out = params.map((p) => {
    const prev = old.find((o, i) => !used.has(i) && o.on && o.k === p.k && (used.add(i), true));
    return { ...p, desc: prev?.desc || '' };
  });
  return [...out, ...old.filter((o) => !o.on)];
}

// ---------- variables ----------

const DYNAMIC = {
  $guid: () => (crypto.randomUUID ? crypto.randomUUID() : `${uid()}-${uid()}`),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};
export const DYNAMIC_VARS = Object.keys(DYNAMIC);

/** Replace {{name}} using the scopes in order (first wins). Unknown names are left as they are. */
export function resolve(str, scopes, extra = {}) {
  if (str == null) return str;
  return String(str).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name) => {
    if (name in extra) return extra[name];
    if (DYNAMIC[name]) return DYNAMIC[name]();
    for (const sc of scopes) {
      const hit = sc?.find?.((x) => x.on !== false && x.k === name);
      if (hit) return hit.v;
    }
    return m;
  });
}

/** {{names}} used in a request (and the auth it inherits) that no scope defines. */
export function unresolved(req, scopes, extra = {}, inheritedAuth = null) {
  const names = new Set();
  const scan = (s) => { for (const m of String(s || '').matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) names.add(m[1]); };
  scan(req.url);
  for (const r of [...req.headers, ...req.params]) if (r.on) { scan(r.k); scan(r.v); }
  if (req.body.mode === 'raw') scan(req.body.raw);
  const auth = req.auth.type === 'inherit' ? inheritedAuth : req.auth;
  if (auth?.type === 'bearer') scan(auth.bearer);
  if (auth?.type === 'basic') { scan(auth.basic?.u); scan(auth.basic?.p); }
  if (auth?.type === 'apikey') { scan(auth.apikey?.k); scan(auth.apikey?.v); }
  return [...names].filter((n) => !(n in extra) && !DYNAMIC[n] && !scopes.some((sc) => sc?.some?.((x) => x.on !== false && x.k === n)));
}

// ---------- the request on the wire ----------

// Browsers refuse to let a page set these; they're skipped (and flagged in the UI)
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
export const isForbiddenHeader = (k) => FORBIDDEN.test(String(k).trim());

/**
 * What actually gets sent: { method, url, headers: [[k, v]], body: string | null | { formdata: [[k, v]] }, skipped: [header names] }.
 * r(s) resolves variables (pass x => x to keep {{vars}} in code snippets). sf: { sessionId } for "Salesforce session" auth.
 */
export function wire(req, r = (x) => x, { sf, inheritedAuth } = {}) {
  // the query comes from the params table (it mirrors the URL, and holds disabled rows too)
  const { base, hash } = splitUrl(r(req.url));
  const params = req.params.filter((p) => p.on && p.k).map((p) => ({ ...p, k: r(p.k), v: r(p.v) }));
  const headers = [];
  const add = (k, v) => { if (k) headers.push([k, v]); };
  for (const h of req.headers) if (h.on && h.k) add(r(h.k), r(h.v));
  const has = (name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

  const auth = req.auth.type === 'inherit' ? inheritedAuth || { type: 'none' } : req.auth;
  if (auth.type === 'bearer' && auth.bearer && !has('authorization')) add('Authorization', `Bearer ${r(auth.bearer)}`);
  if (auth.type === 'basic' && !has('authorization')) add('Authorization', `Basic ${b64(`${r(auth.basic.u)}:${r(auth.basic.p)}`)}`);
  if (auth.type === 'apikey' && auth.apikey.k) {
    if (auth.apikey.in === 'query') params.push(kv(r(auth.apikey.k), r(auth.apikey.v)));
    else if (!has(r(auth.apikey.k))) add(r(auth.apikey.k), r(auth.apikey.v));
  }
  if (auth.type === 'sfsession' && !has('authorization')) add('Authorization', `Bearer ${sf?.sessionId || '{{$sfSessionId}}'}`);

  let body = null;
  const m = req.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') {
    if (req.body.mode === 'raw' && req.body.raw !== '') {
      body = r(req.body.raw);
      if (!has('content-type')) add('Content-Type', RAW_TYPES[req.body.rawType] || 'text/plain');
    } else if (req.body.mode === 'urlencoded') {
      body = req.body.urlencoded.filter((p) => p.on && p.k).map((p) => `${encodeURIComponent(r(p.k))}=${encodeURIComponent(r(p.v))}`).join('&');
      if (!has('content-type')) add('Content-Type', 'application/x-www-form-urlencoded');
    } else if (req.body.mode === 'formdata') {
      body = { formdata: req.body.formdata.filter((p) => p.on && p.k).map((p) => [r(p.k), r(p.v)]) };
    }
  }
  const skipped = headers.filter(([k]) => isForbiddenHeader(k)).map(([k]) => k);
  return { method: m, url: joinUrl(base, params, hash), headers, body, skipped };
}

function b64(s) {
  try { return btoa(unescape(encodeURIComponent(s))); } catch { return btoa(s); }
}

// ---------- cURL ----------

/** Shell-style words: single/double quotes, $'…', backslash and Windows ^ line continuations. */
function words(text) {
  let s = String(text).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  // Windows cmd copies (Chrome "Copy as cURL (cmd)") escape quotes as ^" and other characters with ^
  if (/\^"/.test(s)) s = s.replace(/\^(.)/g, '$1');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let w = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        w += s.slice(i + 1, j < 0 ? s.length : j);
        i = j < 0 ? s.length : j + 1;
      } else if (c === '$' && s[i + 1] === "'") {
        i += 2;
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            w += { n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\', '"': '"' }[n] ?? n;
            i += 2;
          } else w += s[i++];
        }
        i++;
      } else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { w += s[i + 1]; i += 2; } else w += s[i++];
        }
        i++;
      } else if (c === '\\' && i + 1 < s.length) {
        w += s[i + 1];
        i += 2;
      } else w += s[i++];
    }
    out.push(w);
  }
  return out;
}

const VALUE_FLAGS = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-ascii', '--data-binary', '--data-urlencode', '--json',
  '-F', '--form', '--form-string', '-u', '--user', '-b', '--cookie', '-A', '--user-agent', '-e', '--referer', '--url', '-o', '--output', '-m', '--max-time',
  '--connect-timeout', '-w', '--write-out', '-x', '--proxy', '--cert', '--key', '--cacert', '-T', '--upload-file', '--retry', '-c', '--cookie-jar', '-r', '--range']);

/** Parse a cURL command into a request. Unsupported bits are listed in `notes`. */
export function parseCurl(text) {
  const w = words(text);
  if (!w.length || !/^curl(\.exe)?$/i.test(w[0])) throw new Error('That doesn’t look like a cURL command (it should start with “curl”).');
  const req = newRequest({ name: '', auth: { ...newRequest().auth, type: 'none' } });
  const notes = [];
  const data = [];
  const urlencoded = [];
  const form = [];
  let method = null;
  let url = null;
  let get = false;
  for (let i = 1; i < w.length; i++) {
    let a = w[i];
    let v = null;
    // --flag=value and -Xvalue forms
    const eq = /^(--[\w-]+)=(.*)$/s.exec(a);
    if (eq && VALUE_FLAGS.has(eq[1])) { a = eq[1]; v = eq[2]; } else if (/^-[A-Za-z]./.test(a) && VALUE_FLAGS.has(a.slice(0, 2))) { v = a.slice(2); a = a.slice(0, 2); }
    const val = () => (v != null ? v : w[++i] ?? '');
    switch (a) {
      case '-X': case '--request': method = val().toUpperCase(); break;
      case '-H': case '--header': {
        const hv = val();
        const c = hv.indexOf(':');
        if (c > 0) {
          const k = hv.slice(0, c).trim();
          const value = hv.slice(c + 1).trim();
          req.headers.push(kv(k, value));
        }
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-ascii': case '--data-binary': {
        const d = val();
        if (d.startsWith('@') && a !== '--data-raw') notes.push(`The body was read from a file (${d}); paste its content into Body → raw.`);
        else data.push(d);
        break;
      }
      case '--json': data.push(val()); if (!req.headers.some((x) => /^content-type$/i.test(x.k))) req.headers.push(kv('Content-Type', 'application/json')); break;
      case '--data-urlencode': {
        const d = val();
        const e = d.indexOf('=');
        urlencoded.push(e > 0 ? kv(d.slice(0, e), d.slice(e + 1)) : kv(d, ''));
        break;
      }
      case '-F': case '--form': case '--form-string': {
        const d = val();
        const e = d.indexOf('=');
        const k = e > 0 ? d.slice(0, e) : d;
        let value = e > 0 ? d.slice(e + 1) : '';
        if (value.startsWith('@')) { notes.push(`Form field “${k}” uploads a file (${value}); files aren’t supported, so it’s kept as text.`); }
        value = value.replace(/^"(.*)"$/, '$1');
        form.push(kv(k, value));
        break;
      }
      case '-u': case '--user': {
        const d = val();
        const c = d.indexOf(':');
        req.auth = { ...req.auth, type: 'basic', basic: { u: c >= 0 ? d.slice(0, c) : d, p: c >= 0 ? d.slice(c + 1) : '' } };
        break;
      }
      case '-b': case '--cookie': req.headers.push(kv('Cookie', val())); break;
      case '-A': case '--user-agent': req.headers.push(kv('User-Agent', val())); break;
      case '-e': case '--referer': req.headers.push(kv('Referer', val())); break;
      case '--url': url = val(); break;
      case '-G': case '--get': get = true; break;
      case '-I': case '--head': method = 'HEAD'; break;
      case '-m': case '--max-time': req.settings.timeout = Math.round(Number(val()) * 1000) || 0; break;
      default:
        if (VALUE_FLAGS.has(a)) { val(); break; } // a flag we don't use, with its value
        if (a.startsWith('-')) break; // -L, -k, -s, --compressed, …
        if (url == null) url = a;
    }
  }
  if (url == null) throw new Error('No URL found in that cURL command.');
  if (!/^[a-z][\w+.-]*:\/\//i.test(url) && !/^\{\{/.test(url)) url = `https://${url}`;
  if (get && data.length) url += (url.includes('?') ? '&' : '?') + data.join('&');
  req.url = url;
  req.params = paramsFromUrl(url);
  if (!get) {
    if (form.length) req.body = { ...req.body, mode: 'formdata', formdata: form };
    else if (urlencoded.length && !data.length) req.body = { ...req.body, mode: 'urlencoded', urlencoded };
    else if (data.length) {
      const raw = data.join('&');
      const ct = req.headers.find((x) => /^content-type$/i.test(x.k))?.v || '';
      if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(raw) && !/^\s*[[{]/.test(raw))) {
        req.body = { ...req.body, mode: 'urlencoded', urlencoded: raw.split('&').map((p) => { const e = p.indexOf('='); return kv(safeDecode(e > 0 ? p.slice(0, e) : p), safeDecode(e > 0 ? p.slice(e + 1) : '')); }) };
      } else {
        const type = /json/i.test(ct) || /^\s*[[{]/.test(raw) ? 'json' : /xml/i.test(ct) ? 'xml' : /html/i.test(ct) ? 'html' : 'text';
        req.body = { ...req.body, mode: 'raw', raw: type === 'json' ? prettyJson(raw) : raw, rawType: type };
      }
    }
  }
  req.method = method || (req.body.mode !== 'none' ? 'POST' : 'GET');
  req.name = nameFor(req);
  return { req, notes };
}

const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

/** A short default name: "GET EWCItems" from the last path segment. */
export function nameFor(req) {
  const { base } = splitUrl(req.url);
  const path = base.replace(/^[a-z]+:\/\/[^/]+/i, '').split('/').filter(Boolean);
  const last = path[path.length - 1] || base.replace(/^[a-z]+:\/\//i, '') || 'request';
  return `${req.method || 'GET'} ${decodeURIComponent(last).slice(0, 60)}`;
}

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Postman-style cURL: curl --location 'url' \ --header 'K: V' \ --data '…' */
export function toCurl(req, r, opts) {
  const x = wire(req, r, opts);
  const lines = [`curl --location${x.method !== 'GET' && !(x.method === 'POST' && x.body) ? ` --request ${x.method}` : ''} ${sq(x.url)}`];
  for (const [k, v] of x.headers) lines.push(`--header ${sq(`${k}: ${v}`)}`);
  if (x.body && typeof x.body === 'string') lines.push(`--data${/^\s*[[{]/.test(x.body) ? '' : '-raw'} ${sq(x.body)}`);
  else if (x.body?.formdata) for (const [k, v] of x.body.formdata) lines.push(`--form ${sq(`${k}=${v}`)}`);
  return lines.join(' \\\n');
}

const js = (s) => JSON.stringify(s);

export function toFetch(req, r, opts) {
  const x = wire(req, r, opts);
  const h = x.headers.length ? `  headers: {\n${x.headers.map(([k, v]) => `    ${js(k)}: ${js(v)},`).join('\n')}\n  },\n` : '';
  let body = '';
  let pre = '';
  if (typeof x.body === 'string') body = `  body: ${/^\s*[[{]/.test(x.body) && isJson(x.body) ? `JSON.stringify(${x.body.trim()})` : js(x.body)},\n`;
  else if (x.body?.formdata) { pre = `const form = new FormData();\n${x.body.formdata.map(([k, v]) => `form.append(${js(k)}, ${js(v)});`).join('\n')}\n\n`; body = '  body: form,\n'; }
  return `${pre}const res = await fetch(${js(x.url)}, {\n  method: ${js(x.method)},\n${h}${body}});\nconsole.log(res.status, await res.text());`;
}

export function toPython(req, r, opts) {
  const x = wire(req, r, opts);
  const py = (s) => JSON.stringify(s);
  const lines = ['import requests', '', `url = ${py(x.url)}`];
  if (x.headers.length) lines.push(`headers = {\n${x.headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`).join('\n')}\n}`);
  let arg = '';
  if (typeof x.body === 'string') { lines.push(`payload = ${py(x.body)}`); arg = ', data=payload'; } else if (x.body?.formdata) { lines.push(`files = {\n${x.body.formdata.map(([k, v]) => `    ${py(k)}: (None, ${py(v)}),`).join('\n')}\n}`); arg = ', files=files'; }
  lines.push('', `response = requests.request(${py(x.method)}, url${x.headers.length ? ', headers=headers' : ''}${arg})`, 'print(response.status_code, response.text)');
  return lines.join('\n');
}

export function toApex(req, r, opts) {
  const x = wire(req, r, opts);
  const ap = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const lines = [
    '// Needs a Remote Site Setting (or a Named Credential: setEndpoint(\'callout:My_Credential/...\'))',
    'HttpRequest req = new HttpRequest();',
    `req.setEndpoint(${ap(x.url)});`,
    `req.setMethod(${ap(x.method)});`,
    ...x.headers.map(([k, v]) => `req.setHeader(${ap(k)}, ${ap(v)});`),
  ];
  if (typeof x.body === 'string') lines.push(`req.setBody(${ap(x.body)});`);
  else if (x.body?.formdata) lines.push(`req.setBody(${ap(x.body.formdata.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'))});`, "req.setHeader('Content-Type', 'application/x-www-form-urlencoded');");
  lines.push(`req.setTimeout(${req.settings?.timeout ? Math.min(120000, req.settings.timeout) : 120000});`, '', 'HttpResponse res = new Http().send(req);', "System.debug(res.getStatusCode() + ' ' + res.getBody());");
  return lines.join('\n');
}

const isJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

export const SNIPPETS = [
  ['curl', 'cURL', toCurl],
  ['fetch', 'JavaScript – fetch', toFetch],
  ['python', 'Python – requests', toPython],
  ['apex', 'Apex – HttpRequest', toApex],
];

// ---------- Postman v2.1 ----------

const pmKv = (list = []) => list.map((x) => kv(x.key ?? '', x.value ?? '', !x.disabled, typeof x.description === 'string' ? x.description : ''));
const toPmKv = (list = []) => list.filter((x) => x.k !== '').map((x) => ({ key: x.k, value: x.v, ...(x.on ? {} : { disabled: true }), ...(x.desc ? { description: x.desc } : {}) }));

function pmAuth(a) {
  if (!a) return { type: 'inherit' };
  const get = (arr, key) => (arr || []).find((x) => x.key === key)?.value ?? '';
  const base = newRequest().auth;
  if (a.type === 'bearer') return { ...base, type: 'bearer', bearer: get(a.bearer, 'token') };
  if (a.type === 'basic') return { ...base, type: 'basic', basic: { u: get(a.basic, 'username'), p: get(a.basic, 'password') } };
  if (a.type === 'apikey') return { ...base, type: 'apikey', apikey: { k: get(a.apikey, 'key'), v: get(a.apikey, 'value'), in: get(a.apikey, 'in') === 'query' ? 'query' : 'header' } };
  if (a.type === 'noauth') return { ...base, type: 'none' };
  return { ...base, type: 'inherit' };
}
function toPmAuth(a) {
  if (!a || a.type === 'inherit') return undefined;
  if (a.type === 'none') return { type: 'noauth' };
  if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.bearer, type: 'string' }] };
  if (a.type === 'basic') return { type: 'basic', basic: [{ key: 'username', value: a.basic.u }, { key: 'password', value: a.basic.p }] };
  if (a.type === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: a.apikey.k }, { key: 'value', value: a.apikey.v }, { key: 'in', value: a.apikey.in }] };
  if (a.type === 'sfsession') return { type: 'bearer', bearer: [{ key: 'token', value: '{{$sfSessionId}}', type: 'string' }] };
  return undefined;
}

/** Postman collection v2.1 JSON → { name, requests, vars, auth }. Folders are flattened as "Folder / Request". */
export function fromPostman(json) {
  const c = typeof json === 'string' ? JSON.parse(json) : json;
  if (!c?.info || !Array.isArray(c.item)) throw new Error('That isn’t a Postman collection (v2.1 export).');
  const requests = [];
  const walk = (items, prefix) => {
    for (const it of items) {
      if (Array.isArray(it.item)) { walk(it.item, `${prefix}${it.name} / `); continue; }
      const r = it.request || {};
      const rawUrl = typeof r.url === 'string' ? r.url : r.url?.raw || '';
      const b = r.body || {};
      const req = newRequest({
        name: `${prefix}${it.name || 'Request'}`, method: (r.method || 'GET').toUpperCase(), url: rawUrl,
        headers: pmKv(r.header), auth: pmAuth(r.auth),
      });
      req.params = typeof r.url === 'object' && Array.isArray(r.url.query) ? pmKv(r.url.query) : paramsFromUrl(rawUrl);
      if (b.mode === 'raw') req.body = { ...req.body, mode: 'raw', raw: b.raw || '', rawType: b.options?.raw?.language || (/^\s*[[{]/.test(b.raw || '') ? 'json' : 'text') };
      else if (b.mode === 'urlencoded') req.body = { ...req.body, mode: 'urlencoded', urlencoded: pmKv(b.urlencoded) };
      else if (b.mode === 'formdata') req.body = { ...req.body, mode: 'formdata', formdata: pmKv((b.formdata || []).filter((x) => x.type !== 'file')) };
      requests.push(req);
    }
  };
  walk(c.item, '');
  return { name: c.info.name || 'Imported collection', requests, vars: pmKv(c.variable), auth: c.auth ? pmAuth(c.auth) : { type: 'none' } };
}

export function toPostman(col) {
  return {
    info: { name: col.name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', _exporter_id: 'og-debugger' },
    item: col.requests.map((r) => {
      const { base, hash } = splitUrl(r.url);
      const body = r.body.mode === 'raw' ? { mode: 'raw', raw: r.body.raw, options: { raw: { language: r.body.rawType } } }
        : r.body.mode === 'urlencoded' ? { mode: 'urlencoded', urlencoded: toPmKv(r.body.urlencoded) }
          : r.body.mode === 'formdata' ? { mode: 'formdata', formdata: toPmKv(r.body.formdata).map((x) => ({ ...x, type: 'text' })) } : undefined;
      return {
        name: r.name,
        request: {
          method: r.method, header: toPmKv(r.headers), ...(toPmAuth(r.auth) ? { auth: toPmAuth(r.auth) } : {}), ...(body ? { body } : {}),
          url: { raw: joinUrl(base, r.params, hash), query: toPmKv(r.params) },
        },
      };
    }),
    ...(col.vars?.length ? { variable: toPmKv(col.vars) } : {}),
    ...(toPmAuth(col.auth) ? { auth: toPmAuth(col.auth) } : {}),
  };
}

// ---------- responses ----------

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function statusText(code) {
  return ({
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 415: 'Unsupported Media Type',
    422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  })[code] || '';
}
