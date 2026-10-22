// Trigger frameworks: which handler does a trigger really reach?
// Code Flow follows a call made through an interface or a virtual method to every class that implements it.
// That's right for the code, but a trigger framework picks ONE handler per trigger at run time:
//   new AccountTriggerHandler().run()                 (the trigger builds it)
//   ETTF_TriggerDispatcher.Run('DDM')                  (a custom metadata record names the class; Type.forName)
// So for a path that starts at a trigger and then goes through such a call, we check that the handler on the
// other side is the one this trigger uses. Pure: the caller passes the index and what it read from the org.

const STRIP = /(triggerhandler|triggerhelper|triggerdispatcher|handler|helper|trigger|cls)$/;

/** "AccountTriggerHandler" → "account", "DDM_Request__c" → "ddmrequest", "ddmTrigger" → "ddm". */
export function nameKey(s) {
  let k = String(s || '').toLowerCase().replace(/__(c|mdt|e)$/, '').replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < 2; i++) k = k.replace(STRIP, '');
  return k;
}

/** What a trigger says about its handler: its name, object, the strings it passes, the classes it builds. */
export function triggerFacts(trigger, index) {
  const unit = trigger.file.unit;
  const body = String(unit.body || '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const literals = [...body.matchAll(/'((?:\\.|[^'\\])*)'/g)].map((m) => m[1]).filter((s) => /^[\w.-]{2,80}$/.test(s));
  const built = [...body.matchAll(/\bnew\s+([A-Za-z_][\w.]*)\s*\(/g)]
    .map((m) => index.typesByShortName.get(m[1].split('.').pop().toLowerCase())?.[0])
    .filter((t) => t && t.kind !== 'trigger');
  return { name: unit.name, object: trigger.type.triggerObjectLabel || trigger.type.triggerObject || '', literals, built };
}

// every base class and interface above a type
function ancestors(t) {
  const out = new Set();
  const walk = (x) => {
    for (const p of [x.superType, ...(x.interfaceTypes || [])]) {
      if (p && !out.has(p)) { out.add(p); walk(p); }
    }
  };
  walk(t);
  return out;
}

const related = (a, b) => a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a));

/**
 * Does the trigger (facts) use this handler class?
 * dispatchMap: Map(lower key → Set(lower class name)) from custom metadata, or null.
 * → { ok: true | false, how: 'built' | 'metadata' | 'name', detail }
 */
export function handlerMatch(facts, handler, index, dispatchMap) {
  // 1. the trigger builds its handler: new AccountTriggerHandler() reaches that class (and its subclasses) only.
  //    Only classes of the same family count (sharing a base class or interface), not e.g. a new Logger().
  const family = ancestors(handler);
  const builtHandlers = facts.built.filter((b) => b === handler || [...ancestors(b)].some((a) => family.has(a)));
  if (builtHandlers.length) {
    const ok = builtHandlers.some((b) => b === handler || index.allSubtypes(b).includes(handler));
    return { ok, how: 'built', detail: ok ? `${facts.name} creates ${handler.display}` : `${facts.name} creates ${builtHandlers.map((b) => b.display).join(', ')}` };
  }
  // 2. the string the trigger passes names a custom metadata record, which names the class
  if (dispatchMap?.size) {
    for (const lit of facts.literals) {
      const classes = dispatchMap.get(lit.toLowerCase());
      if (!classes?.size) continue;
      const ok = classes.has(handler.lname);
      return { ok, how: 'metadata', detail: `'${lit}' → ${[...classes].join(', ')} (custom metadata)` };
    }
  }
  // 3. names: ddmTrigger / DDM_Request__c / 'DDM' ↔ ddmTriggerHandler
  const h = nameKey(handler.name);
  const keys = [facts.name, facts.object, ...facts.literals].map(nameKey);
  const ok = keys.some((k) => related(k, h));
  return { ok, how: 'name', detail: ok ? `names match (${handler.display})` : `no name in ${facts.name} points to ${handler.display}` };
}

/**
 * Custom metadata records → which class each record names.
 * records: [{ DeveloperName, MasterLabel, ...text fields }], classNames: Set(lower class names in the org).
 */
export function buildDispatchMap(records, classNames) {
  const map = new Map();
  for (const r of records) {
    const classes = new Set();
    for (const [k, v] of Object.entries(r)) {
      if (k === 'attributes' || typeof v !== 'string') continue;
      const c = v.trim().toLowerCase();
      if (classNames.has(c)) classes.add(c);
    }
    if (!classes.size) continue;
    for (const key of [r.DeveloperName, r.MasterLabel, r.QualifiedApiName, r.Label]) {
      if (typeof key !== 'string' || !key) continue;
      const k = key.toLowerCase();
      if (!map.has(k)) map.set(k, new Set());
      for (const c of classes) map.get(k).add(c);
    }
  }
  return map;
}

/** Custom metadata types that dispatchers read class names from: referenced in a class that also uses Type.forName. */
export function dispatchMetadataTypes(units) {
  const out = new Set();
  for (const u of units) {
    const body = u.body || '';
    if (!/Type\s*\.\s*forName/i.test(body)) continue;
    for (const m of body.matchAll(/\b([A-Za-z]\w*__mdt)\b/g)) out.add(m[1]);
  }
  return [...out].slice(0, 6);
}
