// Run with: node test/run-tests.mjs
import assert from 'node:assert/strict';
import { CodeIndex } from '../src/apex/analyzer.js';
import { DEMO_UNITS } from '../src/demo-data.js';
import { parseLog, mergeLogs, summarize, groupQueries, errorPaths, nodeAtLine, CATS, CONT } from '../src/logs/log-parser.js';
import { traceField, linesRun } from '../src/logs/field-trace.js';
import { DEMO_LOG_SAMPLES } from '../src/logs/demo-logs.js';
import { groupSessions, MAX_SPAN_MS } from '../src/logs/sessions.js';

const idx = CodeIndex.fromUnits(DEMO_UNITS);
const byLabel = (l) => idx.methods.find((m) => m.label === l);
const label = (id) => idx.methodsById.get(id).label;

function refsFor(obj, field, opts = {}) {
  const res = idx.analyzeField(obj, field);
  const out = {};
  for (const { method, refs } of res.values()) {
    if (method.isTest && !opts.tests) continue;
    const rs = refs.filter((r) => opts.possible || r.confidence === 'sure');
    if (rs.length) out[method.label] = rs.map((r) => `${r.access}:${r.how}:${r.confidence}@${r.line}`).join(' ');
  }
  return out;
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name); throw e; }
}

async function testAsync(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); } catch (e) { console.log('  ✗', name); throw e; }
}

console.log('stats', idx.stats);

test('finds every sure reference to Account.Industry', () => {
  const r = refsFor('Account', 'Industry');
  console.log(r);
  assert.deepEqual(Object.keys(r).sort(), [
    'AccountController.updateIndustry()',
    'AccountService.assignRating()',
    'AccountService.countByIndustry()',
    'AccountService.getAccountsByIndustry()',
    'AccountService.normalizeIndustry()',
    'AccountTriggerHandler.beforeUpdate()',
    'IndustryEnrichmentBatch.execute()',
    'IndustryEnrichmentBatch.start()',
    'LeadMapper.copyFromLead()',
    'OpportunityService.syncAccountIndustry()',
  ]);
  assert.match(r['AccountService.normalizeIndustry()'], /write/);
  assert.match(r['LeadMapper.copyFromLead()'], /^write/); // l.Industry (Lead) must not count
  assert.match(r['AccountController.updateIndustry()'], /write:constructor/);
  assert.doesNotMatch(r['AccountService.getAccountsByIndustry()'], /,/); // bind var :industry ignored
});

test('possible matches include untyped SObject access', () => {
  const r = refsFor('Account', 'Industry', { possible: true });
  assert.match(r['LeadMapper.applyIndustry()'], /write:dynamic:possible/);
  assert.match(r['CsvExporter.toCsv()'], /read:dynamic:possible/);
  assert.equal(r['EnrichmentClient.lookupIndustry()'], undefined); // Map<String,Object>.get('industry')
});

test('Lead.Industry does not pick up Account code', () => {
  const r = refsFor('Lead', 'Industry');
  assert.deepEqual(Object.keys(r).sort(), ['LeadConversionService.convert()', 'LeadMapper.copyFromLead()']);
});

test('call graph resolves virtual dispatch, constructors and async jobs', () => {
  const callers = (l) => idx.callers(byLabel(l).id, {}).map((c) => label(c.from)).sort();
  assert.deepEqual(callers('AccountTriggerHandler.beforeUpdate()'), ['TriggerHandler.run()']);
  assert.deepEqual(callers('TriggerHandler.run()'), ['AccountTrigger']);
  assert.deepEqual(callers('AccountService.normalizeIndustry()'), ['AccountTriggerHandler.beforeInsert()', 'AccountTriggerHandler.beforeUpdate()']);
  assert.deepEqual(callers('IndustryEnrichmentBatch.execute()'), ['IndustryEnrichmentScheduler.execute()']);
  assert.deepEqual(callers('OpportunityService.closeStale()'), ['OpportunityCleanupJob.execute()']);
  assert.deepEqual(callers('OpportunityCleanupJob.execute()'), ['OpportunityTrigger']);
  assert.deepEqual(callers('AccountService.assignRating()'), ['AccountTriggerHandler.beforeInsert()']);
  assert.deepEqual(idx.callers(byLabel('AccountService.assignRating()').id, { tests: true }).map((c) => label(c.from)).sort(),
    ['AccountServiceTest.ratesBanks()', 'AccountTriggerHandler.beforeInsert()']);
});

test('entry paths reach triggers, LWC, REST, Flow and batch', () => {
  const roots = [...idx.analyzeField('Account', 'Industry').values()]
    .filter(({ method, refs }) => !method.isTest && refs.some((r) => r.confidence === 'sure'))
    .map(({ method }) => method.id);
  const { paths } = idx.entryPaths(roots, {});
  const lines = paths.map((p) => `[${p.end}] ` + p.ids.map(label).join(' → '));
  console.log(lines.join('\n'));
  assert.ok(lines.includes('[entry] AccountTrigger → TriggerHandler.run() → AccountTriggerHandler.beforeUpdate() → AccountService.normalizeIndustry()'));
  assert.ok(lines.includes('[entry] IndustryEnrichmentScheduler.execute() → IndustryEnrichmentBatch.execute()'));
  assert.ok(lines.includes('[entry] LeadConversionService.convert() → LeadMapper.copyFromLead()'));
  assert.ok(lines.includes('[entry] AccountController.getIndustryAccounts() → AccountService.getAccountsByIndustry()'));
});

test('parser survives odd syntax', () => {
  const odd = CodeIndex.fromUnits([{ id: 'x', name: 'Odd', kind: 'class', body: `
    public class Odd {
      public List<Map<Id, List<Account>>> nested { get; set; }
      private static Integer counter = 0;
      static { counter = 1; }
      public Integer total { get { return [SELECT COUNT() FROM Account WHERE Industry = 'X']; } }
      public class Inner implements Comparable { public Integer compareTo(Object o) { return 0; } }
      public enum Mode { A, B }
      public void m(Account a) { a?.Industry = 'Y'; Inner i = new Inner(); i.compareTo(null); }
    }` }]);
  const labels = odd.methods.map((m) => m.label);
  assert.ok(labels.includes('Odd.total'));
  assert.ok(labels.includes('Odd.Inner.compareTo()'));
  const r = [...odd.analyzeField('Account', 'Industry').values()].map((x) => x.method.label).sort();
  assert.deepEqual(r, ['Odd.m()', 'Odd.total']);
  assert.equal(odd.callers(odd.methods.find((m) => m.label === 'Odd.Inner.compareTo()').id).length, 1);
});

// ---------- debug log parser ----------

const sample = (i) => parseLog(DEMO_LOG_SAMPLES[i].body);

test('log parser: trigger chain, queries, DML, debug output, limits', () => {
  const p = sample(0);
  assert.equal(p.apiVersion, '62.0');
  assert.ok(p.levels.some((l) => l.cat === 'APEX_CODE' && l.level === 'FINEST'));
  assert.deepEqual(p.queries.map((q) => [q.object, q.rows]), [['Opportunity', 3]]);
  assert.equal(p.queries[0].context, 'OpportunityService.syncAccountIndustry(List<Account>, Map<Id,Account>)');
  assert.deepEqual(p.dml.map((d) => `${d.op} ${d.object} ${d.rows}`), ['Update Account 1', 'Update Opportunity 3', 'Insert Task 1']);
  assert.equal(p.debugs.length, 2);
  assert.equal(p.errors.length, 0);
  const s = summarize(p);
  assert.equal(s.cpu.used, 48);
  assert.equal(s.rows, 3);
  // DML on Account fires the triggers, validation and the flow inside it
  const exec = p.root.children[0];
  const method = exec.children[0].children[0];
  assert.equal(method.label, 'AccountController.updateIndustry(Id, String)');
  const dml = method.children.find((c) => c.kind === 'dml');
  assert.deepEqual(dml.children.map((c) => c.sub), ['trigger', 'validation', 'trigger', 'flow']);
  assert.equal(p.root.n.soql, 1);
  assert.equal(p.root.n.dml, 3);
  const cpuLine = p.lines.findIndex((l) => l.includes('Maximum CPU time'));
  assert.ok(p.lineCat[cpuLine] & CONT);
  assert.equal(CATS[p.lineCat[cpuLine] & 0x7f], 'limit');
});

test('log parser: fatal errors keep their stack trace; unclosed methods are closed', () => {
  const p = sample(2);
  assert.equal(p.errors.length, 2);
  const fatal = p.errors.find((e) => e.fatal);
  assert.match(fatal.msg, /NullPointerException/);
  assert.match(fatal.msg, /line 8, column 1/);
  assert.deepEqual(fatal.stack.map((f) => `${f.qual}:${f.line}`), ['EnrichmentClient.lookupIndustry:8', 'IndustryEnrichmentBatch.execute:10']);
  const unit = p.root.children[0].children[0];
  const execute = unit.children[0];
  assert.equal(execute.end, unit.end);
  assert.equal(p.callouts.length, 1);
  assert.ok(Math.abs(p.callouts[0].dur / 1e6 - 182.6) < 0.5);
  assert.equal(summarize(p).cpu.max, 60000);
});

test('log parser: repeated queries are grouped', () => {
  const p = sample(1);
  const groups = groupQueries(p.queries);
  assert.equal(p.queries.length, 7);
  assert.deepEqual(groups.map((g) => g.items.length).sort(), [1, 6]);
  assert.equal(summarize(p).repeated, 1);
});

test('log parser: anonymous Apex header lines and sub-query FROM', () => {
  const p = sample(3);
  assert.equal(CATS[p.lineCat[1]], 'other');
  assert.match(p.lines[1], /^Execute Anonymous:/);
  assert.equal(p.anon.length, 2);
  assert.equal(p.root.children[0].children[0].src.kind, 'anon');
  assert.equal(p.debugs[0].level, 'ERROR');
  const q = parseLog('62.0 APEX_CODE,DEBUG\n10:00:00.0 (100)|SOQL_EXECUTE_BEGIN|[3]|Aggregations:1|SELECT Id, (SELECT Id FROM Contacts) FROM Account\n10:00:00.0 (200)|SOQL_EXECUTE_END|[3]|Rows:2\n').queries[0];
  assert.equal(q.object, 'Account');
  assert.equal(q.rows, 2);
});

test('error paths: root cause inside a trigger, then the failed DML in the controller', () => {
  const p = sample(4);
  const paths = errorPaths(p);
  assert.equal(paths.length, 2);
  const [npe, dml] = paths;
  assert.equal(npe.head, 'System.NullPointerException: Attempt to de-reference a null object');
  assert.ok(npe.fatal && npe.rootCause && !dml.rootCause);
  assert.equal(npe.at.line, 13);
  assert.deepEqual(npe.chain.map((n) => n.kind), ['unit', 'method', 'dml', 'unit', 'method', 'method', 'method', 'error']);
  assert.deepEqual(npe.chain.filter((n) => n.kind === 'method').map((n) => n.label),
    ['AccountController.updateIndustry(Id, String)', 'TriggerHandler.run()', 'AccountTriggerHandler.beforeUpdate()', 'AccountService.normalizeIndustry(List<Account>)']);
  assert.equal(npe.stack.length, 4);
  const failing = npe.chain[npe.chain.length - 2];
  assert.deepEqual(failing.src, { kind: 'class', id: '01p000000000003', name: 'AccountService', qual: 'AccountService', method: 'normalizeIndustry', ctor: false, sig: 'List<Account>' });
  assert.deepEqual(npe.chain[3].src, { kind: 'trigger', id: '01q000000000001', name: 'AccountTrigger', qual: 'AccountTrigger' });
  assert.match(dml.head, /^System\.DmlException: Update failed/);
  assert.deepEqual(dml.chain.map((n) => n.kind), ['unit', 'method', 'error']);
  assert.equal(dml.at.line, 11);
  // call-site lines point into the caller's source
  assert.deepEqual(npe.chain.slice(1).map((n) => n.line), [1, 11, null, 2, 9, 23, 13]);
});

test('sessions: merging logs keeps one timeline, per-transaction limits and cross-log error paths', () => {
  const t0 = Date.parse('2026-10-16T10:41:06.000Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const items = [8, 6, 5, 7].map((i, k) => ({ // deliberately out of order
    meta: { Id: `07L00000000000${i}`, StartTime: at([3.4, 0.6, 0, 2.3][k]), Operation: ['FlowEventTrigger', '/aura', '/aura', 'Queueable'][k], LogUser: { Name: 'x' } },
    body: DEMO_LOG_SAMPLES[i].body,
  }));
  const m = mergeLogs(items);
  assert.ok(m.merged);
  assert.deepEqual(m.txs.map((t) => t.meta.Operation), ['/aura', '/aura', 'Queueable', 'FlowEventTrigger']);
  assert.deepEqual(m.root.children.map((t) => t.kind), ['tx', 'tx', 'tx', 'tx']);
  // timeline: each transaction starts at its log's StartTime offset
  assert.deepEqual(m.txs.map((t) => Math.round(t.node.start / 1e6)), [0, 600, 2300, 3400]);
  // every line index still points at the right text
  for (const q of m.queries) assert.match(m.lines[q.li], /SOQL_EXECUTE_BEGIN/);
  for (const e of m.errors) assert.match(m.lines[e.li], /EXCEPTION_THROWN|FATAL_ERROR/);
  assert.equal(CATS[m.lineCat[0]], 'session');
  assert.match(m.lines[m.txs[2].node.li], /^════ Transaction 3 of 4/);
  assert.deepEqual(m.queries.map((q) => q.tx), [1, 2]);
  assert.equal(m.limits.size, 4);
  const paths = errorPaths(m);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].chain.map((n) => n.kind), ['tx', 'unit', 'method', 'method', 'error']);
  assert.equal(paths[0].chain[0].tx, 3);
  assert.equal(paths[0].at.line, 30);
  const s = summarize(m);
  assert.equal(s.cpu.used, 48); // worst transaction, not the sum
  assert.equal(s.dml, 3 + 1 + 1);
});

test('session grouping: a bogus async duration does not swallow later logs; newest session first', () => {
  const log = (id, at, dur, user = 'U1') => ({ Id: id, LogUserId: user, StartTime: `2026-10-16T${at}.000+0000`, DurationMilliseconds: dur });
  const logs = [
    log('a', '19:57:14', 3520),
    log('b', '19:57:18', 127580490), // queueable reporting ~35h
    log('c', '22:43:15', 2500),
    log('d', '22:43:18', 64909),
    log('e', '22:43:18', 137538),
    log('f', '22:43:19', 1200),
    log('x', '22:43:16', 900, 'OTHER'), // not in scope
  ];
  const groups = groupSessions(logs, { gapSec: 10, users: ['U1'] });
  assert.deepEqual(groups.map((g) => g.logs.map((l) => l.Id).join('')), ['cdef', 'ab']);
  assert.ok(groups[0].end - groups[0].start <= MAX_SPAN_MS + 5000);
  // the 17-log case: two bursts of real activity separated by page-load calls, queueables reporting 20–40h
  const real = [
    log('r1', '01:00:53', 4370), log('r2', '01:00:57', 75840000),
    ...['01:01:51', '01:01:51', '01:01:51', '01:01:51', '01:01:51', '01:01:54', '01:01:56', '01:01:56', '01:01:56', '01:01:57', '01:01:59']
      .map((t, i) => log(`p${i}`, t, 60)),
    log('s1', '01:02:41', 3050), log('s2', '01:02:44', 73260000), log('s3', '01:02:44', 73260000), log('s4', '01:02:45', 145860000),
  ];
  const g17 = groupSessions(real, { gapSec: 10, users: ['U1'] });
  assert.deepEqual(g17.map((g) => g.logs.length), [4, 11, 2]);
  assert.deepEqual(g17[0].logs.map((l) => l.Id), ['s1', 's2', 's3', 's4']);
  // logs closer than the gap stay together, farther apart split
  assert.equal(groupSessions([log('p', '10:00:00', 100), log('q', '10:00:08', 100)], { gapSec: 10, users: ['U1'] }).length, 1);
  assert.equal(groupSessions([log('p', '10:00:00', 100), log('q', '10:00:20', 100)], { gapSec: 10, users: ['U1'] }).length, 2);
});

test('field trace: what ran and touched Account.Industry in one execution', () => {
  const p = sample(0);
  const r = traceField(p, idx, 'Account', 'Industry');
  const access = Object.fromEntries(r.touches.map((t) => [t.node.label, t.write ? 'write' : 'read']));
  assert.equal(access['AccountService.normalizeIndustry(List<Account>)'], 'write');
  assert.equal(access['AccountController.updateIndustry(Id, String)'], 'write');
  assert.equal(access['AccountTriggerHandler.beforeUpdate()'], 'read');
  assert.equal(access['OpportunityService.syncAccountIndustry(List<Account>, Map<Id,Account>)'], 'read');
  assert.equal(r.dmls.length, 1);
  const norm = r.touches.find((t) => t.node.label.startsWith('AccountService.normalizeIndustry'));
  assert.deepEqual(norm.assigns.map((a) => a.value), ['"Banking"']);
  assert.ok(norm.refs.some((x) => x.access === 'write' && x.line === 15));
  assert.ok(r.evidence.some((e) => e.kind === 'validation'));
  assert.ok(r.evidence.some((e) => e.kind === 'soql'));
  assert.ok(!r.evidence.some((e) => /Industry_Changed/.test(e.text))); // whole-word match only
  assert.equal(r.paths[0].kind, 'write');
  const normPath = r.paths.find((g) => g.node === norm.node);
  assert.deepEqual(normPath.chain.map((n) => n.kind), ['unit', 'method', 'dml', 'unit', 'method', 'method', 'method']);

  // a custom field on another object, with values logged three times in a loop
  const r2 = traceField(p, idx, 'Opportunity', 'Account_Industry__c');
  const sync = r2.touches.find((t) => t.node.label.startsWith('OpportunityService.syncAccountIndustry'));
  assert.ok(sync.write);
  assert.equal(sync.assigns.length, 3);
  assert.equal(r2.dmls.length, 1);

  // without the code scan, logged values still find the writer
  const r3 = traceField(p, null, 'Account', 'Industry');
  assert.deepEqual(r3.touches.map((t) => t.node.label), ['AccountService.normalizeIndustry(List<Account>)']);
});

test('field trace: works across a merged session and maps log lines to the right step', () => {
  const at = (s) => new Date(Date.parse('2026-10-16T10:41:06.000Z') + s * 1000).toISOString();
  const m = mergeLogs([5, 7].map((i, k) => ({ meta: { Id: `L${i}`, StartTime: at([0, 2.3][k]), Operation: ['/aura', 'Queueable'][k], LogUser: { Name: 'x' } }, body: DEMO_LOG_SAMPLES[i].body })));
  const r = traceField(m, idx, 'Account', 'Industry');
  const norm = r.touches.find((t) => t.node.label.startsWith('AccountService.normalizeIndustry'));
  assert.equal(norm.assigns.length, 1);
  assert.match(m.lines[norm.assigns[0].li], /acc\.Industry/);
  assert.equal(nodeAtLine(m.root, norm.assigns[0].li), norm.node);
  assert.equal(r.paths.find((g) => g.node === norm.node).chain[0].kind, 'tx');
});

test('field trace: references on lines that did not run are not counted when statements are logged', () => {
  const p = sample(0);
  const before = traceField(p, idx, 'Account', 'Industry').touches.find((t) => t.node.label === 'AccountTriggerHandler.beforeUpdate()');
  assert.ok(before.run.full);
  assert.ok(before.run.lines.has(19) && before.run.lines.has(23)); // the if, and the call site of normalizeIndustry
  assert.ok(!before.run.lines.has(13)); // line 13 ran inside normalizeIndustry, not here
  assert.ok(before.read && !before.idle);

  // drop the STATEMENT_EXECUTE for the `if` on line 19: its read of Industry no longer counts
  const body = DEMO_LOG_SAMPLES[0].body.split('\n').filter((l) => !/STATEMENT_EXECUTE\|\[19\]/.test(l)).join('\n');
  const t = traceField(parseLog(body), idx, 'Account', 'Industry').touches.find((x) => x.node.label === 'AccountTriggerHandler.beforeUpdate()');
  assert.ok(t.idle && !t.read);

  // without any STATEMENT_EXECUTE there is no line coverage, so the code scan is trusted
  const coarse = parseLog(DEMO_LOG_SAMPLES[0].body.split('\n').filter((l) => !/STATEMENT_EXECUTE/.test(l)).join('\n'));
  const c = traceField(coarse, idx, 'Account', 'Industry').touches.find((x) => x.node.label === 'AccountTriggerHandler.beforeUpdate()');
  assert.ok(!linesRun(coarse, c.node).full && c.read);
});

const { ApexVersions, sfTime } = await import('../src/logs/apex-versions.js');

await testAsync('debug logs: after a rescan, older logs keep the code they ran', async () => {
  const v = new ApexVersions();
  const v1 = { id: '01p000000000001AAA', name: 'AccountService', kind: 'class', body: 'v1', lastModified: '2026-10-19T09:00:00.000+0000' };
  const v2 = { ...v1, body: 'v2 fixed', lastModified: '2026-10-19T10:05:00.000+0000' };
  const key = 'class:01p000000000001';
  assert.equal(v.note(v1), false);
  assert.equal(v.note(v2), true); // the fix arrived with the rescan
  const before = sfTime('2026-10-19T10:00:00.000+0000');
  const after = sfTime('2026-10-19T10:06:00.000+0000');
  const old = v.pick(key, v2, before);
  assert.equal(old.body, 'v1');
  assert.equal(old.version.kind, 'older');
  assert.equal(old.version.latest.body, 'v2 fixed');
  assert.equal(v.pick(key, v2, after), v2); // a new log: the new code, no note
  assert.equal(v.pick('class:accountservice', v2, before).body, 'v1'); // found by name too
  // opened only after the fix: no older body known, so warn instead
  const fresh = new ApexVersions();
  fresh.note(v2);
  const warn = fresh.pick(key, v2, before);
  assert.equal(warn.body, 'v2 fixed');
  assert.equal(warn.version.kind, 'newer');
  assert.equal(v.pick(key, v2, NaN), v2); // unknown log time: just the latest
});

const EX = await import('../src/exec/exec-core.js');
const AC = await import('../src/exec/apex-complete.js');
const { DemoExecBackend } = await import('../src/exec/demo-exec.js');

await testAsync('OG Executor: async classes are detected and get runnable code', async () => {
  const list = EX.asyncClasses(idx);
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.deepEqual(by.IndustryEnrichmentBatch.kinds, ['batch']);
  assert.equal(by.IndustryEnrichmentBatch.callouts, true);
  assert.deepEqual(by.IndustryEnrichmentScheduler.kinds, ['schedulable']);
  assert.deepEqual(by.OpportunityCleanupJob.kinds, ['queueable']);
  assert.ok(!by.AccountService); // not async
  // constructor parameters, and a starting value that gives the job something to do
  assert.deepEqual(by.OpportunityCleanupJob.ctors[0].params, [{ type: 'List<Opportunity>', name: 'opps' }]);
  const isObj = (n) => /^(Opportunity|Account)$/.test(n);
  assert.equal(EX.defaultValue('List<Opportunity>', isObj), '[SELECT Id FROM Opportunity LIMIT 200]');
  assert.equal(EX.defaultValue('Set<Id>'), 'new Set<Id>()');
  assert.equal(EX.defaultValue('Date'), 'Date.today()');
  assert.equal(EX.defaultValue('Map<Id, Account>'), 'new Map<Id, Account>()');
  // batch: default size 200; queueable: args declared first; schedulable: System.schedule with the cron
  const batch = EX.generate({ cls: 'IndustryEnrichmentBatch', kind: 'batch', ctor: by.IndustryEnrichmentBatch.ctors[0] });
  assert.match(batch, /Database\.executeBatch\(new IndustryEnrichmentBatch\(\), 200\);/);
  const q = EX.generate({ cls: 'OpportunityCleanupJob', kind: 'queueable', ctor: by.OpportunityCleanupJob.ctors[0], args: { opps: '[SELECT Id FROM Opportunity LIMIT 200]' } });
  assert.match(q, /List<Opportunity> opps = \[SELECT Id FROM Opportunity LIMIT 200\];\n[\s\S]*System\.enqueueJob\(new OpportunityCleanupJob\(opps\)\)/);
  const s = EX.generate({ cls: 'IndustryEnrichmentScheduler', kind: 'schedulable', ctor: { params: [] }, cron: '0 0 2 * * ?', jobName: "Nightly 'enrich'" });
  assert.match(s, /System\.schedule\('Nightly \\'enrich\\'', cronExpr, new IndustryEnrichmentScheduler\(\)\)/);
  assert.match(EX.generate({ cls: 'X', kind: 'schedulable', ctor: { params: [] }, runNow: true }), /new X\(\)\.execute\(null\);/);
  assert.equal(EX.describeCron('0 0 2 * * ?'), 'Every day at 2:00 AM');
  assert.deepEqual(EX.idsFromDebug(['OG_JOB_ID 7075g00000AbCdEAAA', 'x OG_CRON_ID 08e5g00000AbCdEAAA']), { jobs: ['7075g00000AbCdEAAA'], crons: ['08e5g00000AbCdEAAA'] });
});

await testAsync('OG Executor: SOAP results, stack traces and the demo org', async () => {
  const env = EX.soapEnvelope('00D!abc<x>', "System.debug('a & b');");
  assert.match(env, /<apex:sessionId>00D!abc&lt;x&gt;<\/apex:sessionId>/);
  assert.match(env, /System\.debug\('a &amp; b'\);/);
  const ok = EX.parseSoapResult('<soapenv:Envelope><soapenv:Header><DebuggingInfo><debugLog>62.0 APEX_CODE\n12:00:00.0 (1)|USER_DEBUG|[1]|DEBUG|a &amp; b</debugLog></DebuggingInfo></soapenv:Header><soapenv:Body><executeAnonymousResponse><result><column>-1</column><compileProblem xsi:nil="true"/><compiled>true</compiled><exceptionMessage xsi:nil="true"/><exceptionStackTrace xsi:nil="true"/><line>-1</line><success>true</success></result></executeAnonymousResponse></soapenv:Body></soapenv:Envelope>');
  assert.equal(ok.success, true);
  assert.equal(ok.line, null);
  assert.match(ok.log, /DEBUG\|a & b/);
  const bad = EX.parseSoapResult('<result><column>12</column><compileProblem>Variable does not exist: foo</compileProblem><compiled>false</compiled><line>3</line><success>false</success></result>');
  assert.deepEqual([bad.compiled, bad.line, bad.column, bad.compileProblem], [false, 3, 12, 'Variable does not exist: foo']);
  assert.equal(EX.parseSoapResult('<soapenv:Fault><faultcode>sf:INVALID_SESSION_ID</faultcode><faultstring>INVALID_SESSION_ID: Invalid Session ID</faultstring></soapenv:Fault>').fault, 'INVALID_SESSION_ID: Invalid Session ID');
  assert.deepEqual(EX.parseStack('Class.Foo.bar: line 12, column 1\nAnonymousBlock: line 3, column 1').map((f) => [f.anon, f.line]), [[false, 12], [true, 3]]);

  const b = new DemoExecBackend();
  const compile = await b.execute('System.debug((1);');
  assert.equal(compile.compiled, false);
  assert.equal(compile.line, 1);
  const run = await b.execute("Id jobId = Database.executeBatch(new IndustryEnrichmentBatch(), 200);\nSystem.debug('OG_JOB_ID ' + jobId);");
  assert.equal(run.success, true);
  const p = parseLog(run.log);
  const { jobs } = EX.idsFromDebug(p.debugs.map((d) => d.msg));
  assert.equal(jobs.length, 1);
  assert.equal((await b.jobs(jobs))[0].Status, 'Queued');
  const thrown = await b.execute("throw new MyException('boom');");
  assert.equal(thrown.compiled, false); // MyException isn't a known type in the demo org
  const exc = await b.execute("throw new Exception('boom');");
  assert.equal(exc.success, false);
  assert.match(exc.exceptionMessage, /boom/);
});

await testAsync('OG Executor: Apex suggestions follow the context', async () => {
  const meta = {
    classes: [{ name: 'AccountService', statics: [{ name: 'normalizeIndustry', params: [{ type: 'List<Account>', name: 'accs' }] }], methods: [] }],
    objects: [{ name: 'Account', label: 'Account' }, { name: 'Opportunity', label: 'Opportunity' }],
    fields: (n) => (n === 'Account' ? [{ name: 'Industry', label: 'Industry', type: 'picklist' }] : undefined),
  };
  const labels = (t, pos = t.length) => AC.suggest(t, pos, meta).items.map((i) => i.label);
  assert.ok(labels('Database.').includes('executeBatch(…)'));
  assert.ok(labels('System.enq').includes('enqueueJob(…)'));
  assert.deepEqual(labels('AccountService.'), ['normalizeIndustry(List<Account>)']);
  assert.ok(labels('Id j = Database.executeBatch(new Acc').includes('AccountService'));
  assert.ok(labels('List<Account> rows = [SELECT Id FROM Opp').includes('Opportunity'));
  assert.ok(labels("List<Account> rows = new List<Account>();\nrows.").includes('size()'));
  assert.ok(labels('Account a = new Account();\na.').includes('Industry'));
  assert.equal(labels("System.debug('Database.")[0], undefined); // inside a string: nothing
  const dbg = AC.suggest('debu', 4, meta).items.find((i) => i.label === 'debug');
  assert.equal(dbg.insert, `System.debug(${AC.CARET});`);
});

const { DemoDataBackend } = await import('../src/data/demo-data-backend.js');
const IM = await import('../src/import/import-core.js');
const { DemoImportBackend } = await import('../src/import/demo-import.js');

await testAsync('Data Import: parsing, object detection, mapping and records', async () => {
  // Excel (tabs), CSV with quotes and newlines, semicolons, JSON with attributes
  const xl = IM.parseData('_\tId\tWarranty_Type__c\tCharge_Type\n[WorkOrder]\t0WO5g000002mFVrGAM\t928020001\ta3B\n[WorkOrder]\t0WO5g000003MZFoGAO\t928020001\ta3B\n');
  assert.equal(xl.format, 'excel');
  assert.deepEqual(xl.headers, ['_', 'Id', 'Warranty_Type__c', 'Charge_Type']);
  assert.equal(xl.rows.length, 2);
  const csv = IM.parseData('Name,Description\n"Acme, Inc","line 1\nline ""2"""\n');
  assert.deepEqual(csv.rows, [['Acme, Inc', 'line 1\nline "2"']]);
  assert.equal(IM.parseData('Name;City\nA;Pune').rows[0][1], 'Pune');
  const js = IM.parseData('[{"attributes":{"type":"Account"},"Id":"0015g00000000001AAA","Name":"Acme","Owner":{"Username":"a@b.c"}}]');
  assert.deepEqual(js.headers, ['_', 'Id', 'Name', 'Owner.Username']);
  // which object: the type column, else the Ids' key prefix
  const objects = [{ name: 'WorkOrder', keyPrefix: '0WO' }, { name: 'Account', keyPrefix: '001' }];
  assert.deepEqual(IM.detectObject(xl, objects), { name: 'WorkOrder', how: 'type column' });
  assert.deepEqual(IM.detectObject(IM.parseData('Id,Name\n0015g0000000001AAA,A'), objects), { name: 'Account', how: 'id prefix' });
  assert.equal(IM.suggestAction(xl.headers), 'update');
  assert.equal(IM.suggestAction(['Name']), 'insert');
  // mapping: API name, label, loose names, lookups by a parent's field
  const fields = [
    { name: 'Id', label: 'Record ID', type: 'id', createable: false, updateable: false },
    { name: 'Warranty_Type__c', label: 'Warranty Type', type: 'string', createable: true, updateable: true },
    { name: 'AccountId', label: 'Account ID', type: 'reference', relationshipName: 'Account', referenceTo: ['Account'], createable: true, updateable: true },
    { name: 'Subject', label: 'Subject', type: 'string', createable: true, updateable: true, nillable: false },
    { name: 'IsClosed', label: 'Closed', type: 'boolean', createable: false, updateable: false },
    { name: 'Amount__c', label: 'Amount', type: 'currency', createable: true, updateable: true },
  ];
  assert.equal(IM.guessField('warranty type', fields), 'Warranty_Type__c');
  assert.equal(IM.guessField('Account.Name__c', fields), 'Account.Name__c');
  assert.equal(IM.guessField('Charge_Type', fields), null);
  assert.equal(IM.guessField('_', fields), null);
  const chk = (hd, t, action) => IM.checkColumn(hd, t, { fields, action, skipped: false }).state;
  assert.equal(chk('Charge_Type', 'Charge_Type', 'update'), 'unknown');
  assert.equal(chk('IsClosed', 'IsClosed', 'update'), 'readonly');
  assert.equal(chk('Id', 'Id', 'insert'), 'ignored');
  assert.equal(chk('Subject', 'Subject', 'delete'), 'unused');
  assert.equal(chk('_', '', 'update'), 'meta');
  assert.equal(chk('Account.Name__c', 'Account.Name__c', 'insert'), 'rel');
  assert.deepEqual(IM.missingRequired(fields, ['Warranty_Type__c'], 'insert'), ['Subject']);
  // values and records
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  const cols = ['Id', 'Warranty_Type__c', 'Amount__c', 'Account.Name__c'].map((f, index) => ({ index, ...IM.checkColumn(f, f, { fields, action: 'update' }) }));
  const r = IM.buildRecord(['0WO5g000002mFVrGAM', '', '1,234.50', 'ACME-1'], cols, { action: 'update', object: 'WorkOrder', fieldsByName: byName, blankToNull: false });
  assert.deepEqual(r.record, { attributes: { type: 'WorkOrder' }, Id: '0WO5g000002mFVrGAM', Amount__c: 1234.5, Account: { Name__c: 'ACME-1' } });
  const cleared = IM.buildRecord(['0WO5g000002mFVrGAM', '', '', ''], cols, { action: 'update', object: 'WorkOrder', fieldsByName: byName, blankToNull: true });
  assert.equal(cleared.record.Warranty_Type__c, null);
  assert.match(IM.buildRecord(['', 'x', '', ''], cols, { action: 'update', object: 'WorkOrder', fieldsByName: byName }).error, /no Id/);
  assert.deepEqual(IM.buildRecord(['0WO5g000002mFVrGAM', 'x', '', ''], cols, { action: 'delete', object: 'WorkOrder', fieldsByName: byName }).record, { Id: '0WO5g000002mFVrGAM' });
  assert.equal(IM.convert('Yes', { type: 'boolean' }), true);
  assert.deepEqual(IM.chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(IM.exportRows(['A', 'B'], [['x,y', 'z']], 'csv'), 'A,B\r\n"x,y",z');
});

await testAsync('Data Import: the demo org inserts, fails like Salesforce, deletes and undeletes', async () => {
  const data = new DemoDataBackend();
  const b = new DemoImportBackend(data);
  const before = data.db.Contact.length;
  const res = await b.run('insert', 'Contact', [
    { attributes: { type: 'Contact' }, FirstName: 'Asha', LastName: 'Verma', LeadSource: 'Web' },
    { attributes: { type: 'Contact' }, FirstName: 'Neha' },
    { attributes: { type: 'Contact' }, LastName: 'X', LeadSource: 'Carrier Pigeon' },
  ]);
  assert.equal(res[0].success, true);
  assert.match(res[1].error, /REQUIRED_FIELD_MISSING/);
  assert.match(res[2].error, /RESTRICTED_PICKLIST/);
  assert.equal(data.db.Contact.length, before + 1);
  assert.equal(data.db.Contact.at(-1).Name, 'Asha Verma');
  assert.equal((await b.run('delete', 'Contact', [{ Id: res[0].id }]))[0].success, true);
  assert.equal(data.db.Contact.length, before);
  assert.equal((await b.run('undelete', 'Contact', [{ Id: res[0].id }]))[0].success, true);
  assert.equal(data.db.Contact.length, before + 1);
  const up = await b.run('update', 'Account', [{ attributes: { type: 'Account' }, Id: data.db.Account[0].Id, Industry: 'Retail' }]);
  assert.equal(up[0].success, true);
  assert.equal(data.db.Account[0].Industry, 'Retail');
});
const SQ = await import('../src/data/soql.js');

await testAsync('data export: autocomplete follows the clause, relationships and picklists', async () => {
  const b = new DemoDataBackend();
  const cache = new Map();
  for (const n of ['Account', 'Contact', 'User']) cache.set(n.toLowerCase(), await b.describe(n));
  const meta = { objects: await b.listObjects(), describe: (n) => (cache.has(n.toLowerCase()) ? cache.get(n.toLowerCase()) : undefined) };
  const labels = (t, pos = t.length) => SQ.suggest(t, pos, meta).items.map((i) => i.label);
  assert.deepEqual(labels('SELECT Id FROM Acc'), ['Account']);
  assert.ok(labels('SELECT Id FROM Account ').includes('WHERE'));
  assert.ok(labels('SELECT Id FROM Account WHERE Ind').includes('Industry'));
  assert.equal(labels('SELECT Id FROM Account WHERE Industry ')[0], '=');
  assert.ok(labels('SELECT Id FROM Account WHERE Industry = ').includes('Banking'));
  assert.ok(labels('SELECT Id FROM Account WHERE Industry IN (').includes('Banking'));
  assert.deepEqual(labels("SELECT Id FROM Account WHERE Industry = 'Ba"), ['Banking']);
  assert.ok(labels('SELECT Id FROM Contact WHERE Account.Owner.').includes('Username'));
  assert.ok(labels('SELECT Id FROM Account WHERE CreatedDate > ').includes('LAST_N_DAYS:7'));
  assert.ok(labels('SELECT Id, (SELECT La FROM Contacts) FROM Account', 21).includes('LastName'));
  // an object not described yet is requested, not guessed
  assert.deepEqual(SQ.suggest('SELECT Id FROM Lead WHERE ', 26, meta).need, ['Lead']);
  // "All fields": the whole list for an empty SELECT, only the missing ones otherwise
  const accFields = cache.get('account').fields.map((f) => f.name);
  const empty = SQ.suggest('SELECT  FROM Account', 7, meta);
  assert.equal(empty.items[0].kind, 'all');
  assert.equal(empty.allFields.insert, accFields.join(', '));
  const rest = SQ.suggest('SELECT Id, Name,  FROM Account', 17, meta);
  assert.equal(rest.items[0].label, `All remaining fields (${accFields.length - 2})`);
  assert.ok(!rest.items[0].insert.split(', ').includes('Id') && !rest.allFields);
  assert.equal(SQ.suggest('SELECT FROM Account', 7, meta).allFields.insert.slice(-1), ' '); // "SELECT |FROM" gets a space before FROM
  assert.ok(!SQ.suggest('SELECT Na FROM Account', 9, meta).items.some((i) => i.kind === 'all')); // hidden while typing a name
  assert.ok(!SQ.suggest('SELECT COUNT(),  FROM Account', 16, meta).items.some((i) => i.kind === 'all'));
  // picklist values show their label next to the API name, and the label is searchable too
  const types = SQ.suggest('SELECT Id FROM Account WHERE Type = ', 36, meta).items.filter((i) => i.kind === 'value');
  const partner = types.find((i) => i.label === 'Partner');
  assert.equal(partner.valueLabel, 'Channel Partner / Reseller');
  assert.equal(partner.insert, "'Partner'"); // SOQL still gets the API name
  assert.equal(types.find((i) => i.label === 'Prospect').valueLabel, null); // same label: nothing extra shown
  assert.deepEqual(SQ.suggest("SELECT Id FROM Account WHERE Type = 'resel", 41, meta).items.map((i) => i.label), ['Partner']);
  // picking a value inside an open quote closes it
  assert.equal(SQ.suggest("SELECT Id FROM Account WHERE Industry = 'Ba", 43, meta).items[0].insert, "Banking'");
  // child relationships: picking one writes the sub-query, caret on its field list, then the child's fields follow
  const kid = SQ.suggest('SELECT Id, Cont FROM Account', 15, meta).items.find((i) => i.kind === 'child');
  assert.equal(kid.label, 'Contacts');
  let q = 'SELECT Id, Cont FROM Account';
  q = q.slice(0, 11) + kid.insert + q.slice(15);
  const caret = 11 + kid.insert.length + kid.caret;
  assert.equal(q, 'SELECT Id, (SELECT Id FROM Contacts) FROM Account');
  assert.equal(q.slice(caret), 'Id FROM Contacts) FROM Account');
  const inner = SQ.suggest(q, caret, meta);
  assert.equal(inner.items[0].label, `All fields (${cache.get('contact').fields.length})`);
  assert.ok(inner.items.some((i) => i.label === 'LastName') && !inner.items.some((i) => i.kind === 'child'));
  assert.ok(!labels('SELECT Id,  FROM Contact', 11).includes('Contacts')); // Contact has no children
});

await testAsync('data export: demo SOQL engine, flattening and export formats', async () => {
  const b = new DemoDataBackend();
  const r = await b.query("SELECT Id, Name, Account.Name FROM Contact WHERE Account.Industry IN ('Banking','Retail') ORDER BY Name LIMIT 5");
  assert.equal(r.records.length, 5);
  const f = SQ.flatten(r.records);
  assert.deepEqual(f.columns, ['Id', 'Name', 'Account.Name']);
  assert.ok(SQ.isRecordId(f.rows[0].Id, 'Id'));
  assert.ok(!SQ.isRecordId('Hello World 12345678', 'Name'));
  assert.equal((await b.query('SELECT COUNT() FROM Account WHERE IsActive__c = true')).records.length, 0);
  // paging
  const p1 = await b.query('SELECT Id FROM Contact');
  assert.equal(p1.totalSize, 120);
  assert.ok(p1.next && !p1.done);
  const p2 = await b.more(p1.next);
  assert.equal(p1.records.length + p2.records.length, 120);
  // errors look like Salesforce's
  await assert.rejects(b.query('SELECT Nme FROM Account'), /No such column 'Nme'/);
  // a lookup that's empty on some rows doesn't leave a bare "Account" column
  const mixed = SQ.flatten((await b.query('SELECT Name, Account.Name FROM Contact')).records);
  assert.deepEqual(mixed.columns, ['Name', 'Account.Name']);
  // exports
  const cols = ['Name', 'Note'];
  const rows = [{ Name: 'A, "B"', Note: 'line1\nline2' }, { Name: null, Note: 3 }];
  assert.equal(SQ.toCsv(cols, rows), 'Name,Note\r\n"A, ""B""","line1\nline2"\r\n,3');
  assert.equal(SQ.toTsv(cols, rows), 'Name\tNote\nA, "B"\tline1 line2\n\t3');
  assert.deepEqual(JSON.parse(SQ.toJson(cols, rows)), [{ Name: 'A, "B"', Note: 'line1\nline2' }, { Name: null, Note: 3 }]);
  // delete
  const id = p1.records[0].Id;
  const del = await b.deleteRecords([id]);
  assert.ok(del[0].success);
  assert.equal((await b.query(`SELECT Id FROM Contact WHERE Id = '${id}'`)).totalSize, 0);
});

const U = await import('../src/record/sf-urls.js');
const { DemoRecordBackend } = await import('../src/record/record-backend.js');

test('record panel: which record a Salesforce page shows', () => {
  const id = '0015g00000ABCDEAAA';
  assert.equal(U.recordIdFromUrl(`https://acme.lightning.force.com/lightning/r/Account/${id}/view`), id);
  assert.equal(U.objectFromUrl(`https://acme.lightning.force.com/lightning/r/Account/${id}/view`), 'Account');
  assert.equal(U.recordIdFromUrl(`https://acme.lightning.force.com/lightning/r/${id}/view`), id);
  assert.equal(U.recordIdFromUrl('https://acme.lightning.force.com/lightning/r/WorkOrder/0WOS300000BPW3BOAX/related/Cases/view'), '0WOS300000BPW3BOAX');
  assert.equal(U.recordIdFromUrl('https://acme.my.salesforce.com/0015g00000ABCDE'), '0015g00000ABCDE');
  assert.equal(U.recordIdFromUrl('https://acme.my.salesforce.com/0015g00000ABCDE/e?retURL=%2Fhome'), '0015g00000ABCDE');
  // Setup pages wrap the classic user page in ?address=
  assert.equal(U.recordIdFromUrl('https://acme.lightning.force.com/lightning/setup/ManageUsers/page?address=%2F0055g00000XYZ12%3Fnoredirect%3D1'), '0055g00000XYZ12');
  assert.equal(U.recordIdFromUrl('https://acme.lightning.force.com/lightning/page/home'), null);
  assert.equal(U.recordIdFromUrl('https://acme.lightning.force.com/lightning/o/Account/list?filterName=Recent'), null);
  assert.equal(U.recordIdFromUrl('not a url'), null);
});

test('record panel: Setup and Login as links', () => {
  assert.equal(U.lightningHost({ apiHost: 'acme--uat.sandbox.my.salesforce.com' }), 'acme--uat.sandbox.lightning.force.com');
  assert.equal(U.lightningHost({ uiHost: 'acme.lightning.force.com', apiHost: 'acme.my.salesforce.com' }), 'acme.lightning.force.com');
  const su = new URL(U.loginAsUrl('acme.my.salesforce.com', '00D5g000000ORG1', '0055g00000XYZ12'));
  assert.equal(su.pathname, '/servlet/servlet.su');
  assert.equal(su.searchParams.get('oid'), '00D5g000000ORG1');
  assert.equal(su.searchParams.get('suorgadminid'), '0055g00000XYZ12');
  const fd = new URL(U.frontdoorUrl('acme.my.salesforce.com', 'SID!123', su.pathname + su.search));
  assert.equal(fd.pathname, '/secur/frontdoor.jsp');
  assert.equal(fd.searchParams.get('retURL'), su.pathname + su.search);
  assert.match(U.userDetailUrl('acme.lightning.force.com', '0055g00000XYZ12'), /\/lightning\/setup\/ManageUsers\/page\?address=%2F0055g00000XYZ12%3Fnoredirect%3D1/);
  assert.match(U.permSetAssignUrl('acme.lightning.force.com', '0055g00000XYZ12'), /assignPermissionSet\.apexp%3FuserId%3D0055g00000XYZ12/);
  // readable field types
  assert.equal(U.fieldTypeText({ type: 'picklist', length: 255 }), 'picklist (255)');
  assert.equal(U.fieldTypeText({ type: 'currency', precision: 16, scale: 2 }), 'currency (16, 2)');
  assert.equal(U.fieldTypeText({ type: 'reference', referenceTo: ['Account'] }), 'reference → Account');
  assert.deepEqual(U.fieldFlags({ type: 'picklist', createable: true, nillable: false, restrictedPicklist: true, updateable: true }), ['required', 'restricted']);
  assert.deepEqual(U.fieldFlags({ type: 'string', calculated: true, updateable: false }), ['formula']);
});

await testAsync('all data: read, update, clone and delete a record (demo)', async () => {
  const b = new DemoRecordBackend();
  const id = b.sampleId('Account');
  assert.equal(await b.objectForId(id), 'Account');
  const d = await b.describe('Account');
  assert.ok(d.fields.find((f) => f.name === 'Id' && !f.updateable));
  assert.ok(d.fields.find((f) => f.name === 'Name' && !f.nillable));
  const rec = await b.get('Account', id);
  assert.equal(rec.Id, id);
  await b.update('Account', id, { Industry: 'Retail' });
  assert.equal((await b.get('Account', id)).Industry, 'Retail');
  await assert.rejects(b.update('Account', id, { Name: '' }), (e) => e.fields?.[0] === 'Name');
  const copy = await b.create('Account', { Name: 'Copy of Acme' });
  assert.equal((await b.get('Account', copy)).Name, 'Copy of Acme');
  await b.remove('Account', copy);
  await assert.rejects(b.get('Account', copy), /NOT_FOUND/);
});

const SE = await import('../src/search/search-engine.js');
const { DemoSearchSources } = await import('../src/search/demo-search.js');

await testAsync('OG Search: a pasted error finds the validation rule and the flow that say it', async () => {
  const src = new DemoSearchSources();
  const docs = [];
  for (const g of ['apex', 'flow', 'validation', 'vf', 'lwc', 'aura', 'label']) docs.push(...await src.load(g));
  const err = 'Update failed. First exception on row 0 with id 006000000000011; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Close Reason is required when closing an opportunity: [Close_Reason__c]';
  assert.equal(SE.trimErrorText(err), 'Close Reason is required when closing an opportunity');
  assert.equal(SE.trimErrorText('System.NullPointerException: Attempt to de-reference a null object'), 'Attempt to de-reference a null object');
  assert.equal(SE.trimErrorText('Industry is required'), null); // nothing to trim
  const r = SE.search(docs, SE.makeMatcher(SE.trimErrorText(err)));
  assert.equal(r.results[0].doc.name, 'Close_Reason_Required'); // the rule whose message it is, before the flow that repeats it
  assert.ok(r.results[0].score > r.results[1].score);
  assert.equal(r.results[0].hits[0].label, 'Error message');
  assert.ok(r.results.some((x) => x.doc.kind === 'flow' && x.doc.name === 'Notify_Owner_On_Failed_Close'));
  // flows: custom error messages, field references and Process Builder are all searchable
  assert.ok(SE.search(docs, SE.makeMatcher('can’t be blank')).results.some((x) => x.hits.some((h) => /Custom error/.test(h.label))));
  assert.ok(SE.search(docs, SE.makeMatcher('Close_Reason__c')).results.some((x) => x.doc.kind === 'flow'));
  assert.equal(SE.search(docs, SE.makeMatcher('Deal won')).results[0].doc.kind, 'process');
  // options: case, whole word, regex, spaces
  assert.equal(SE.makeMatcher('industry', { caseSensitive: true }).test('Industry'), false);
  assert.equal(SE.makeMatcher('Industry', { wholeWord: true }).test('IndustryPicker'), false);
  assert.ok(SE.makeMatcher('Closed   Won').test('Closed Won'));
  assert.ok(SE.makeMatcher('(', { regex: true }).error);
  assert.ok(SE.makeMatcher('Closed (Won|Lost)', { regex: true }).test('Closed Lost'));
  // flow types
  assert.equal(SE.flowKind('Workflow'), 'process');
  assert.equal(SE.flowTypeLabel('AutoLaunchedFlow', 'RecordAfterSave'), 'Record-triggered flow');
  assert.ok(SE.docsBytes(docs) > 0);
});

const IC = await import('../src/informant/core.js');

test('The Informant: cURL import (Postman, Chrome bash and cmd), snippets, variables, Postman round trip', () => {
  const pm = IC.parseCurl(`curl --location 'https://acme--uat.sandbox.my.salesforce.com/services/apexrest/EWCItems?model=4E8B&SNo=71&DOP=10-09-2024' \\
--header 'Authorization: Bearer 00D!AQE.x' \\
--header 'Content-Type: application/json' \\
--header 'Cookie: BrowserId=abc'`);
  assert.equal(pm.req.method, 'GET');
  assert.deepEqual(pm.req.params.map((p) => p.k), ['model', 'SNo', 'DOP']);
  assert.equal(pm.req.headers.length, 3);
  const w = IC.wire(pm.req);
  assert.equal(w.url, pm.req.url);
  assert.deepEqual(w.skipped, ['Cookie']); // browsers don't allow a Cookie header
  const bash = IC.parseCurl(`curl 'https://x.test/v1/items' -H 'content-type: application/json' --data-raw $'{"name":"O\\'Brien"}' --compressed`);
  assert.equal(bash.req.method, 'POST');
  assert.equal(bash.req.body.mode, 'raw');
  assert.equal(JSON.parse(bash.req.body.raw).name, "O'Brien");
  const cmd = IC.parseCurl('curl ^"https://x.test/a?q=1^" ^\n  -H ^"accept: application/json^" ^\n  --data-raw ^"^{^\\^"a^\\^":1^}^"');
  assert.equal(cmd.req.url, 'https://x.test/a?q=1');
  assert.equal(JSON.parse(cmd.req.body.raw).a, 1);
  const form = IC.parseCurl('curl -X PUT https://x.test/up -u admin:pw -F name=K -F file=@a.png');
  assert.equal(form.req.auth.type, 'basic');
  assert.equal(form.req.body.mode, 'formdata');
  assert.equal(form.notes.length, 1);
  const enc = IC.parseCurl('curl https://x.test/token -d grant_type=password -d username=k%40x.com');
  assert.equal(enc.req.body.mode, 'urlencoded');
  assert.equal(enc.req.body.urlencoded[1].v, 'k@x.com');
  assert.throws(() => IC.parseCurl('wget x'), /cURL/);
  // cURL round trip
  assert.equal(IC.parseCurl(IC.toCurl(bash.req)).req.body.raw, bash.req.body.raw);
  // URL <-> params keep {{vars}} and disabled rows
  const params = IC.paramsFromUrl('{{base}}/a?x={{id}}&y=');
  assert.deepEqual(params.map((p) => [p.k, p.v]), [['x', '{{id}}'], ['y', '']]);
  params.push({ ...IC.kv('z', '9'), on: false });
  assert.equal(IC.joinUrl('{{base}}/a', params), '{{base}}/a?x={{id}}&y=');
  // variables: env wins over collection, dynamic ones, unknown ones reported
  const env = [IC.kv('base', 'https://env.test'), IC.kv('tok', 'E')];
  const col = [IC.kv('base', 'https://col.test'), IC.kv('only', 'C')];
  assert.equal(IC.resolve('{{base}}/{{only}}', [env, col]), 'https://env.test/C');
  assert.match(IC.resolve('{{$guid}}', []), /^[0-9a-f-]{36}$/);
  const req = IC.newRequest({ url: '{{base}}/x?k={{nope}}', headers: [IC.kv('Authorization', 'Bearer {{tok}}')] });
  req.params = IC.paramsFromUrl(req.url);
  assert.deepEqual(IC.unresolved(req, [env]), ['nope']);
  // a {{token}} in the collection's auth counts too
  assert.deepEqual(IC.unresolved({ ...req, url: 'https://x.test', params: [], headers: [], auth: { ...req.auth, type: 'inherit' } }, [], {}, { type: 'bearer', bearer: '{{token}}' }), ['token']);
  // auth: inherited from the collection, Salesforce session, API key in the query
  const auth = IC.wire({ ...req, auth: { ...req.auth, type: 'inherit' }, headers: [] }, (s) => s, { inheritedAuth: { type: 'bearer', bearer: 'COL' } });
  assert.deepEqual(auth.headers, [['Authorization', 'Bearer COL']]);
  const sfw = IC.wire({ ...req, headers: [], auth: { ...req.auth, type: 'sfsession' } }, (s) => s, { sf: { sessionId: 'SID' } });
  assert.deepEqual(sfw.headers, [['Authorization', 'Bearer SID']]);
  const key = IC.wire({ ...req, headers: [], auth: { ...req.auth, type: 'apikey', apikey: { k: 'api_key', v: 'K', in: 'query' } } });
  assert.match(key.url, /[?&]api_key=K/);
  // snippets
  assert.match(IC.toApex(bash.req), /req\.setMethod\('POST'\);/);
  assert.match(IC.toPython(bash.req), /requests\.request\("POST"/);
  assert.match(IC.toFetch(bash.req), /JSON\.stringify\(/);
  // Postman v2.1 round trip
  const back = IC.fromPostman(JSON.stringify(IC.toPostman({ name: 'T', requests: [pm.req, bash.req, form.req], vars: [IC.kv('base', 'x')], auth: { type: 'none' } })));
  assert.deepEqual(back.requests.map((r) => `${r.method} ${r.body.mode}`), ['GET none', 'POST raw', 'PUT formdata']);
  assert.equal(back.vars[0].k, 'base');
});

const OG = await import('../src/informant/orgs.js');

test('The Informant: org families, kinds and switching a request between prod and sandboxes', () => {
  const p = (h) => { const x = OG.parseOrgHost(h); return x && `${x.family}|${x.kind}|${x.sandbox || ''}`; };
  assert.equal(p('panasonicindia.my.salesforce.com'), 'panasonicindia|production|');
  assert.equal(p('panasonicindia--preprod.sandbox.my.salesforce.com'), 'panasonicindia|sandbox|preprod');
  assert.equal(p('PanasonicIndia--UAT.sandbox.my.salesforce.com'), 'panasonicindia|sandbox|uat');
  assert.equal(p('kyadav-dev-ed.develop.my.salesforce.com'), 'kyadav-dev-ed|developer|');
  assert.equal(p('kyadav-dev-ed.my.salesforce.com'), 'kyadav-dev-ed|developer|');
  assert.equal(p('fun-energy-1234.scratch.my.salesforce.com'), 'fun-energy-1234|scratch|');
  assert.equal(p('acme--dev.cs42.my.salesforce.com'), 'acme|sandbox|dev'); // older sandbox My Domain
  assert.equal(OG.parseOrgHost('acme.lightning.force.com'), null);
  assert.equal(OG.parseOrgHost('api.github.com'), null);
  // the user's example: the same Apex REST call on production
  assert.equal(OG.switchHost('https://panasonicindia--preprod.sandbox.my.salesforce.com/services/apexrest/PromotionalWarranty?x=1#y', 'panasonicindia.my.salesforce.com'),
    'https://panasonicindia.my.salesforce.com/services/apexrest/PromotionalWarranty?x=1#y');
  assert.equal(OG.shortName({ apiHost: 'panasonicindia--preprod.sandbox.my.salesforce.com' }), 'preprod');
  assert.equal(OG.shortName({ apiHost: 'panasonicindia.my.salesforce.com' }), 'production');
  // families: the current one first, production before its sandboxes
  const fams = OG.groupFamilies([
    { apiHost: 'globex.my.salesforce.com' }, { apiHost: 'acme--uat.sandbox.my.salesforce.com' }, { apiHost: 'acme.my.salesforce.com' },
    { apiHost: 'acme--preprod.sandbox.my.salesforce.com' }, { apiHost: 'kyadav-dev-ed.develop.my.salesforce.com' },
  ], 'acme--uat.sandbox.my.salesforce.com');
  assert.equal(fams[0].family, 'acme');
  assert.deepEqual(fams[0].orgs.map(OG.shortName), ['production', 'preprod', 'uat']);
  assert.equal(fams.length, 3);
  assert.equal(OG.maskToken('00D5g000000AbCd!AQEAQB518L6A4pYZjZAem26660'), '00D5g000000AbCd…6660');
});

console.log(`\n${passed} tests passed`);
