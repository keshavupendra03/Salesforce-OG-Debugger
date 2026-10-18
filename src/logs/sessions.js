// Groups debug logs into "sessions": logs from the chosen users that ran close together in time.

const toMs = (s) => Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));

// ApexLog.DurationMilliseconds is unreliable for async logs (queueables report 20–40 hours, likely counting
// time spent waiting in the queue). Grouping therefore trusts start times: a duration above BOGUS_MS is
// ignored, and a real duration extends a log's reach by at most MAX_SPAN_MS.
export const MAX_SPAN_MS = 15 * 1000;
export const BOGUS_MS = 10 * 60 * 1000;
export const isBogusDuration = (ms) => ms > BOGUS_MS;
const reach = (ms) => (!ms || ms < 0 || isBogusDuration(ms) ? 0 : Math.min(ms, MAX_SPAN_MS));

/**
 * Gap-based grouping: a new session starts when a log begins more than `gapSec` seconds after the previous
 * log of the current session ended. Returns newest session first; logs inside a session are oldest first.
 * Each session: { logs, start, end } (ms timestamps, end uses capped durations).
 */
export function groupSessions(logs, { gapSec, users }) {
  const scope = new Set(users || []);
  const sorted = logs.filter((l) => scope.has(l.LogUserId)).sort((a, b) => toMs(a.StartTime) - toMs(b.StartTime));
  const groups = [];
  let cur = null;
  for (const l of sorted) {
    const s = toMs(l.StartTime);
    const e = s + reach(l.DurationMilliseconds);
    if (!cur || s - cur.end > gapSec * 1000) {
      cur = { logs: [], start: s, end: e };
      groups.push(cur);
    }
    cur.logs.push(l);
    cur.end = Math.max(cur.end, e);
  }
  return groups.reverse();
}
