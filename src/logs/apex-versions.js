// Versions of Apex classes and triggers seen in this tab. A rescan after you fix a class in the
// Developer Console brings the new body; the old one is kept here (memory only) so a debug log
// written before your change still shows the code it actually ran, with matching line numbers.

/** "2026-10-19T10:05:00.000+0000" → ms (Salesforce writes +0000, which not every parser takes). */
export const sfTime = (s) => (s ? Date.parse(String(s).replace(/\+0000$/, 'Z')) : NaN);

/** The cache keys a unit is found by: its 15-char id and its name. */
export const unitKeys = (u) => [u.id ? `${u.kind}:${u.id.slice(0, 15)}` : null, u.name ? `${u.kind}:${u.name.toLowerCase()}` : null].filter(Boolean);

export class ApexVersions {
  constructor() {
    this.latest = new Map(); // key -> newest unit seen
    this.older = new Map(); // key -> [older units], oldest first
  }

  /** Record a unit; a different body/date than the last one seen pushes that one into history. Returns true when it changed. */
  note(u) {
    if (!u) return false;
    let changed = false;
    for (const k of unitKeys(u)) {
      const prev = this.latest.get(k);
      if (prev && prev !== u && (prev.lastModified !== u.lastModified || prev.body !== u.body)) {
        const list = this.older.get(k) || [];
        if (!list.includes(prev)) list.push(prev);
        this.older.set(k, list);
        changed = true;
      }
      this.latest.set(k, u);
    }
    return changed;
  }

  /**
   * The version to show for a log that ran at `at` (ms):
   * the unit itself, or an older one with { version: { kind: 'older', latest } },
   * or the unit with { version: { kind: 'newer' } } when it changed after the log and no older body is known.
   */
  pick(key, unit, at) {
    if (!unit || !Number.isFinite(at)) return unit;
    const t = sfTime(unit.lastModified);
    // a little slack: a save and a log in the same second are the same code
    if (!Number.isFinite(t) || t <= at + 1000) return unit;
    const keys = [key, ...unitKeys(unit)];
    for (const k of keys) {
      const old = (this.older.get(k) || []).filter((u) => sfTime(u.lastModified) <= at + 1000).pop();
      if (old) return { ...old, version: { kind: 'older', latest: unit, changedAt: unit.lastModified } };
    }
    return { ...unit, version: { kind: 'newer', changedAt: unit.lastModified } };
  }
}
