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

const { DemoDataBackend } = await import('../src/data/demo-data-backend.js');
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
  // picking a value inside an open quote closes it
  assert.equal(SQ.suggest("SELECT Id FROM Account WHERE Industry = 'Ba", 43, meta).items[0].insert, "Banking'");
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

console.log(`\n${passed} tests passed`);
