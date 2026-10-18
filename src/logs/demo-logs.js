// Demo backend for the Debug Logs view (same interface as SfLogBackend), with realistic sample logs.

import { LEVEL_PRESETS } from './log-backend.js';

const HEADER = '62.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;NBA,INFO;SYSTEM,DEBUG;VALIDATION,INFO;VISUALFORCE,INFO;WAVE,INFO;WORKFLOW,INFO';

const pad = (n, w = 2) => String(n).padStart(w, '0');

// steps: [deltaMs, 'EVENT|details'] or a raw string (continuation / header line)
function buildLog(clock, steps) {
  const [hh, mm, ss] = clock.split(':').map(Number);
  const base = ((hh * 60 + mm) * 60 + ss) * 1000;
  const out = [HEADER];
  let ns = 0;
  for (const s of steps) {
    if (typeof s === 'string') { out.push(s); continue; }
    ns += Math.round(s[0] * 1e6);
    const t = base + ns / 1e6;
    const c = `${pad(Math.floor(t / 3600e3) % 24)}:${pad(Math.floor(t / 60e3) % 60)}:${pad(Math.floor(t / 1e3) % 60)}.${Math.floor(t % 1000 / 100)}`;
    out.push(`${c} (${ns})|${s[1]}`);
  }
  return { body: out.join('\n') + '\n', durationMs: ns / 1e6 };
}

const LIMITS = [
  ['Number of SOQL queries', 100, 200], ['Number of query rows', 50000, 50000], ['Number of SOSL queries', 20, 20],
  ['Number of DML statements', 150, 150], ['Number of Publish Immediate DML', 150, 150], ['Number of DML rows', 10000, 10000],
  ['Maximum CPU time', 10000, 60000], ['Maximum heap size', 6000000, 12000000], ['Number of callouts', 100, 100],
  ['Number of Email Invocations', 10, 10], ['Number of future calls', 50, 0], ['Number of queueable jobs added to the queue', 50, 1],
  ['Number of Mobile Apex push calls', 10, 10],
];
// used: { soql, rows, sosl, dml, dmlRows, cpu, heap, callouts, queueable }
const limitBlock = (u, async = false) => [
  [0.2, 'CUMULATIVE_LIMIT_USAGE'],
  [0, 'LIMIT_USAGE_FOR_NS|(default)|'],
  ...LIMITS.map(([name, sync, asy], i) => {
    const used = [u.soql, u.rows, u.sosl, u.dml, 0, u.dmlRows, u.cpu, u.heap, u.callouts, 0, 0, u.queueable, 0][i] || 0;
    return `  ${name}: ${used} out of ${async ? asy : sync}`;
  }),
  [0.1, 'CUMULATIVE_LIMIT_USAGE_END'],
];

const userInfo = (id, user) => [0.1, `USER_INFO|[EXTERNAL]|${id}|${user}|(GMT+05:30) India Standard Time (Asia/Kolkata)|GMT+05:30`];

const UPDATE = buildLog('10:42:07', [
  userInfo('005000000000001', 'demo.user@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|apex://AccountController/ACTION$updateIndustry'],
  [0.5, 'METHOD_ENTRY|[1]|01p000000000004|AccountController.updateIndustry(Id, String)'],
  [0.3, 'USER_DEBUG|[9]|DEBUG|updateIndustry called for 001000000000123 -> Banking'],
  [0.4, 'DML_BEGIN|[11]|Op:Update|Type:Account|Rows:1'],
  [0.6, 'CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger'],
  [0.2, 'CONSTRUCTOR_ENTRY|[2]|01p000000000002|<init>()|AccountTriggerHandler'],
  [0.3, 'CONSTRUCTOR_EXIT|[2]|01p000000000002|<init>()|AccountTriggerHandler'],
  [0.1, 'METHOD_ENTRY|[2]|01p000000000001|TriggerHandler.run()'],
  [0.2, 'METHOD_ENTRY|[9]|01p000000000002|AccountTriggerHandler.beforeUpdate()'],
  [0.1, 'HEAP_ALLOCATE|[18]|Bytes:24'],
  [0.1, 'STATEMENT_EXECUTE|[18]'],
  [0.1, 'VARIABLE_ASSIGNMENT|[18]|oldAcc|{"Id":"001000000000123","Industry":"Technology"}|0x1a2b3c4d'],
  [0.1, 'STATEMENT_EXECUTE|[19]'],
  [0.1, 'STATEMENT_EXECUTE|[20]'],
  [0.1, 'STATEMENT_EXECUTE|[23]'],
  [0.2, 'METHOD_ENTRY|[23]|01p000000000003|AccountService.normalizeIndustry(List<Account>)'],
  [0.3, 'VARIABLE_ASSIGNMENT|[13]|key|"bank"'],
  [0.2, 'VARIABLE_ASSIGNMENT|[15]|acc.Industry|"Banking"|0x1c2d3e4f'],
  [2.1, 'USER_DEBUG|[18]|DEBUG|{"normalized":1,"aliases":{"tech":"Technology","it":"Technology","bank":"Banking"}}'],
  [0.2, 'METHOD_EXIT|[23]|01p000000000003|AccountService.normalizeIndustry(List<Account>)'],
  [0.1, 'METHOD_EXIT|[9]|01p000000000002|AccountTriggerHandler.beforeUpdate()'],
  [0.1, 'METHOD_EXIT|[2]|01p000000000001|TriggerHandler.run()'],
  [0.1, 'CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger'],
  [0.3, 'CODE_UNIT_STARTED|[EXTERNAL]|Validation:Account:001000000000123'],
  [0.1, 'VALIDATION_RULE|03d000000000001|Industry_Required_For_Customers'],
  [0.1, 'VALIDATION_FORMULA|AND(ISPICKVAL(Type, "Customer"), ISBLANK(TEXT(Industry)))|Type=Customer , Industry=Banking'],
  [0.1, 'VALIDATION_PASS'],
  [0.1, 'CODE_UNIT_FINISHED|Validation:Account:001000000000123'],
  [0.4, 'CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event AfterUpdate|__sfdc_trigger/AccountTrigger'],
  [0.2, 'METHOD_ENTRY|[2]|01p000000000001|TriggerHandler.run()'],
  [0.2, 'METHOD_ENTRY|[11]|01p000000000002|AccountTriggerHandler.afterUpdate()'],
  [0.2, 'METHOD_ENTRY|[27]|01p000000000008|OpportunityService.syncAccountIndustry(List<Account>, Map<Id,Account>)'],
  [0.3, 'SOQL_EXECUTE_BEGIN|[12]|Aggregations:0|SELECT Id, Account.Industry, Account_Industry__c FROM Opportunity WHERE AccountId IN :tmpVar1 AND IsClosed = false'],
  [3.1, 'SOQL_EXECUTE_END|[12]|Rows:3'],
  [0.1, 'VARIABLE_ASSIGNMENT|[18]|opp.Account_Industry__c|"Banking"|0x2a3b4c5d'],
  [0.1, 'VARIABLE_ASSIGNMENT|[18]|opp.Account_Industry__c|"Banking"|0x2a3b4c5e'],
  [0.1, 'VARIABLE_ASSIGNMENT|[18]|opp.Account_Industry__c|"Banking"|0x2a3b4c5f'],
  [0.2, 'DML_BEGIN|[20]|Op:Update|Type:Opportunity|Rows:3'],
  [0.5, 'CODE_UNIT_STARTED|[EXTERNAL]|01q000000000002|OpportunityTrigger on Opportunity trigger event AfterUpdate|__sfdc_trigger/OpportunityTrigger'],
  [0.3, 'CONSTRUCTOR_ENTRY|[3]|01p000000000009|<init>(List<Opportunity>)|OpportunityCleanupJob'],
  [0.1, 'CONSTRUCTOR_EXIT|[3]|01p000000000009|<init>(List<Opportunity>)|OpportunityCleanupJob'],
  [0.1, 'CODE_UNIT_FINISHED|OpportunityTrigger on Opportunity trigger event AfterUpdate|__sfdc_trigger/OpportunityTrigger'],
  [0.4, 'CODE_UNIT_STARTED|[EXTERNAL]|Workflow:Opportunity'],
  [0.2, 'WF_RULE_EVAL_BEGIN|Workflow'],
  [0.1, 'WF_CRITERIA_BEGIN|[Opportunity: Big Deal 006000000000011]|Notify_Owner_On_Industry_Change|01Q000000000001|ON_ALL_CHANGES|0'],
  [0.1, 'WF_RULE_NOT_EVALUATED'],
  [0.1, 'WF_RULE_EVAL_END'],
  [0.1, 'CODE_UNIT_FINISHED|Workflow:Opportunity'],
  [0.3, 'DML_END|[20]'],
  [0.2, 'METHOD_EXIT|[27]|01p000000000008|OpportunityService.syncAccountIndustry(List<Account>, Map<Id,Account>)'],
  [0.1, 'METHOD_EXIT|[11]|01p000000000002|AccountTriggerHandler.afterUpdate()'],
  [0.1, 'METHOD_EXIT|[2]|01p000000000001|TriggerHandler.run()'],
  [0.1, 'CODE_UNIT_FINISHED|AccountTrigger on Account trigger event AfterUpdate|__sfdc_trigger/AccountTrigger'],
  [0.5, 'CODE_UNIT_STARTED|[EXTERNAL]|Flow:Account'],
  [0.2, 'FLOW_START_INTERVIEW_BEGIN|300000000000001|Account_After_Save_Notify'],
  [0.4, 'FLOW_ELEMENT_BEGIN|300000000000001|FlowDecision|Industry_Changed'],
  [0.1, 'FLOW_RULE_DETAIL|300000000000001|Industry_Changed_Yes|true'],
  [0.1, 'FLOW_ELEMENT_END|300000000000001|FlowDecision|Industry_Changed'],
  [0.3, 'FLOW_ELEMENT_BEGIN|300000000000001|FlowRecordCreate|Create_Follow_Up_Task'],
  [0.2, 'DML_BEGIN|[EXTERNAL]|Op:Insert|Type:Task|Rows:1'],
  [1.4, 'DML_END|[EXTERNAL]'],
  [0.1, 'FLOW_ELEMENT_END|300000000000001|FlowRecordCreate|Create_Follow_Up_Task'],
  [0.2, 'FLOW_START_INTERVIEW_END|300000000000001|Account_After_Save_Notify'],
  [0.1, 'CODE_UNIT_FINISHED|Flow:Account'],
  [0.4, 'DML_END|[11]'],
  [0.2, 'METHOD_EXIT|[1]|01p000000000004|AccountController.updateIndustry(Id, String)'],
  ...limitBlock({ soql: 1, rows: 3, dml: 3, dmlRows: 5, cpu: 48, heap: 21544, queueable: 1 }),
  [0.2, 'CODE_UNIT_FINISHED|apex://AccountController/ACTION$updateIndustry'],
  [0.3, 'EXECUTION_FINISHED'],
]);

const CONTACT_ROWS = [3, 2, 4, 1, 5, 2];
const CONTACTS = buildLog('10:38:51', [
  userInfo('005000000000003', 'priya.sharma@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|apex://AccountController/ACTION$getIndustryAccounts'],
  [0.4, 'METHOD_ENTRY|[1]|01p000000000004|AccountController.getIndustryAccounts(String)'],
  [0.2, 'METHOD_ENTRY|[4]|01p000000000003|AccountService.getAccountsByIndustry(String)'],
  [0.3, 'SOQL_EXECUTE_BEGIN|[32]|Aggregations:0|SELECT Id, Name, Industry, Rating, AnnualRevenue FROM Account WHERE Industry = :tmpVar1 ORDER BY AnnualRevenue DESC LIMIT 200'],
  [3.8, 'SOQL_EXECUTE_END|[32]|Rows:6'],
  [0.1, 'METHOD_EXIT|[4]|01p000000000003|AccountService.getAccountsByIndustry(String)'],
  ...CONTACT_ROWS.flatMap((rows, i) => [
    [0.3, 'SOQL_EXECUTE_BEGIN|[9]|Aggregations:0|SELECT Id, Name, Email FROM Contact WHERE AccountId = :tmpVar1 LIMIT 5'],
    [1.1 + i * 0.2, `SOQL_EXECUTE_END|[9]|Rows:${rows}`],
  ]),
  [0.2, 'USER_DEBUG|[14]|DEBUG|Loaded 6 accounts with 17 contacts'],
  [0.1, 'USER_DEBUG|[15]|FINE|AccountWrapper:[acc=Account:{Id=001000000000123, Name=Acme Bank, Industry=Banking}, contacts=3]'],
  [0.2, 'USER_DEBUG|[16]|WARN|Contact lookup runs once per account; consider a single query'],
  [0.1, 'METHOD_EXIT|[1]|01p000000000004|AccountController.getIndustryAccounts(String)'],
  ...limitBlock({ soql: 7, rows: 23, cpu: 61, heap: 48211 }),
  [0.2, 'CODE_UNIT_FINISHED|apex://AccountController/ACTION$getIndustryAccounts'],
  [0.2, 'EXECUTION_FINISHED'],
]);

const BATCH = buildLog('10:26:13', [
  userInfo('005000000000002', 'integration@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|01p000000000005|IndustryEnrichmentBatch'],
  [0.3, 'METHOD_ENTRY|[1]|01p000000000005|IndustryEnrichmentBatch.execute(Database.BatchableContext, List<Account>)'],
  [0.3, 'METHOD_ENTRY|[10]|01p000000000007|EnrichmentClient.lookupIndustry(String)'],
  [0.4, 'CALLOUT_REQUEST|[6]|System.HttpRequest[Endpoint=callout:Enrichment/company?domain=acme.com, Method=GET]'],
  [182.6, 'CALLOUT_RESPONSE|[6]|System.HttpResponse[Status=No Content, StatusCode=204]'],
  [0.3, 'EXCEPTION_THROWN|[8]|System.NullPointerException: Attempt to de-reference a null object'],
  [0.3, 'FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object'],
  '',
  'Class.EnrichmentClient.lookupIndustry: line 8, column 1',
  'Class.IndustryEnrichmentBatch.execute: line 10, column 1',
  ...limitBlock({ cpu: 3120, heap: 184220, callouts: 1 }, true),
  [0.2, 'CODE_UNIT_FINISHED|IndustryEnrichmentBatch'],
  [0.1, 'EXECUTION_FINISHED'],
]);

const ANON = buildLog('10:11:40', [
  "Execute Anonymous: List<Account> accs = [SELECT Id, Name FROM Account WHERE Industry = 'Banking' LIMIT 3];",
  "Execute Anonymous: System.debug(LoggingLevel.ERROR, 'Found ' + accs.size() + ' banks');",
  userInfo('005000000000001', 'demo.user@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex'],
  [0.3, "SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id, Name FROM Account WHERE Industry = 'Banking' LIMIT 3"],
  [1.6, 'SOQL_EXECUTE_END|[1]|Rows:3'],
  [0.2, 'USER_DEBUG|[2]|ERROR|Found 3 banks'],
  ...limitBlock({ soql: 1, rows: 3, cpu: 9, heap: 3102 }),
  [0.1, 'CODE_UNIT_FINISHED|execute_anonymous_apex'],
  [0.1, 'EXECUTION_FINISHED'],
]);

const DML_MSG = 'Update failed. First exception on row 0 with id 001000000000456; first error: CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY, AccountTrigger: execution of BeforeUpdate';
const NPE_STACK = [
  'Class.AccountService.normalizeIndustry: line 13, column 1',
  'Class.AccountTriggerHandler.beforeUpdate: line 23, column 1',
  'Class.TriggerHandler.run: line 9, column 1',
  'Trigger.AccountTrigger: line 2, column 1',
];
const CAUSED_BY = ['', 'caused by: System.NullPointerException: Attempt to de-reference a null object', '', ...NPE_STACK];

// LWC save → DML → trigger framework → service method throws; the DML then fails back in the controller.
const FAIL = buildLog('10:44:52', [
  userInfo('005000000000004', 'marco.rossi@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|apex://AccountController/ACTION$updateIndustry'],
  [0.5, 'METHOD_ENTRY|[1]|01p000000000004|AccountController.updateIndustry(Id, String)'],
  [0.3, 'USER_DEBUG|[9]|DEBUG|updateIndustry called for 001000000000456 -> Fintech'],
  [0.4, 'DML_BEGIN|[11]|Op:Update|Type:Account|Rows:1'],
  [0.6, 'CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger'],
  [0.2, 'CONSTRUCTOR_ENTRY|[2]|01p000000000002|<init>()|AccountTriggerHandler'],
  [0.3, 'CONSTRUCTOR_EXIT|[2]|01p000000000002|<init>()|AccountTriggerHandler'],
  [0.1, 'METHOD_ENTRY|[2]|01p000000000001|TriggerHandler.run()'],
  [0.2, 'METHOD_ENTRY|[9]|01p000000000002|AccountTriggerHandler.beforeUpdate()'],
  [0.1, 'VARIABLE_ASSIGNMENT|[18]|oldAcc|{"Id":"001000000000456","Industry":"Banking"}|0x5e6f7a8b'],
  [0.2, 'METHOD_ENTRY|[23]|01p000000000003|AccountService.normalizeIndustry(List<Account>)'],
  [0.1, 'VARIABLE_ASSIGNMENT|[9]|acc|{"Id":"001000000000456","Industry":"Fintech"}|0x1c2d3e4f'],
  [0.2, 'EXCEPTION_THROWN|[13]|System.NullPointerException: Attempt to de-reference a null object'],
  [0.2, 'FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object'],
  '',
  ...NPE_STACK,
  [0.1, 'CODE_UNIT_FINISHED|AccountTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/AccountTrigger'],
  [0.3, 'DML_END|[11]'],
  [0.2, `EXCEPTION_THROWN|[11]|System.DmlException: ${DML_MSG}`],
  ...CAUSED_BY,
  [0.3, `FATAL_ERROR|System.DmlException: ${DML_MSG}`],
  ...CAUSED_BY,
  '',
  'Class.AccountController.updateIndustry: line 11, column 1',
  ...limitBlock({ dml: 1, dmlRows: 1, cpu: 22, heap: 9876 }),
  [0.2, 'CODE_UNIT_FINISHED|apex://AccountController/ACTION$updateIndustry'],
  [0.2, 'EXECUTION_FINISHED'],
]);

// ---- one user action that spans several transactions (for session grouping) ----
// 1. Priya saves an Account: triggers sync Opportunities and enqueue OpportunityCleanupJob.
const SESSION_SAVE = {
  ...UPDATE,
  body: UPDATE.body.replace('005000000000001|demo.user@fieldflow.dev', '005000000000003|priya.sharma@fieldflow.dev'),
};

// 2. The page refreshes its data (a cacheable read).
const REFRESH = buildLog('10:41:07', [
  userInfo('005000000000003', 'priya.sharma@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|apex://AccountController/ACTION$getIndustryAccounts'],
  [0.4, 'METHOD_ENTRY|[1]|01p000000000004|AccountController.getIndustryAccounts(String)'],
  [0.2, 'METHOD_ENTRY|[4]|01p000000000003|AccountService.getAccountsByIndustry(String)'],
  [0.3, 'SOQL_EXECUTE_BEGIN|[32]|Aggregations:0|SELECT Id, Name, Industry, Rating, AnnualRevenue FROM Account WHERE Industry = :tmpVar1 ORDER BY AnnualRevenue DESC LIMIT 200'],
  [3.2, 'SOQL_EXECUTE_END|[32]|Rows:6'],
  [0.1, 'METHOD_EXIT|[4]|01p000000000003|AccountService.getAccountsByIndustry(String)'],
  [0.1, 'METHOD_EXIT|[1]|01p000000000004|AccountController.getIndustryAccounts(String)'],
  ...limitBlock({ soql: 1, rows: 6, cpu: 12, heap: 8120 }),
  [0.2, 'CODE_UNIT_FINISHED|apex://AccountController/ACTION$getIndustryAccounts'],
  [0.1, 'EXECUTION_FINISHED'],
]);

// 3. The queued job runs ~2s later and fails on a validation rule.
const CLOSE_MSG = 'Update failed. First exception on row 0 with id 006000000000011; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Close Reason is required when closing an opportunity: [Close_Reason__c]';
const QUEUE = buildLog('10:41:09', [
  userInfo('005000000000003', 'priya.sharma@fieldflow.dev'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|01p000000000009|OpportunityCleanupJob'],
  [0.3, 'METHOD_ENTRY|[1]|01p000000000009|OpportunityCleanupJob.execute(QueueableContext)'],
  [0.2, 'METHOD_ENTRY|[9]|01p000000000008|OpportunityService.closeStale(List<Opportunity>)'],
  [0.6, 'DML_BEGIN|[30]|Op:Update|Type:Opportunity|Rows:2'],
  [0.5, 'CODE_UNIT_STARTED|[EXTERNAL]|Validation:Opportunity:006000000000011'],
  [0.1, 'VALIDATION_RULE|03d000000000002|Close_Reason_Required'],
  [0.1, 'VALIDATION_FORMULA|AND(ISPICKVAL(StageName, "Closed Lost"), ISBLANK(Close_Reason__c))|StageName=Closed Lost , Close_Reason__c=null'],
  [0.1, 'VALIDATION_FAIL'],
  [0.1, 'CODE_UNIT_FINISHED|Validation:Opportunity:006000000000011'],
  [0.4, 'DML_END|[30]'],
  [0.2, `EXCEPTION_THROWN|[30]|System.DmlException: ${CLOSE_MSG}`],
  [0.3, `FATAL_ERROR|System.DmlException: ${CLOSE_MSG}`],
  '',
  'Class.OpportunityService.closeStale: line 30, column 1',
  'Class.OpportunityCleanupJob.execute: line 9, column 1',
  ...limitBlock({ dml: 1, dmlRows: 2, cpu: 31, heap: 5120 }, true),
  [0.2, 'CODE_UNIT_FINISHED|OpportunityCleanupJob'],
  [0.1, 'EXECUTION_FINISHED'],
]);

// 4. A platform-event flow, run by the Automated Process user, reacts to the failure.
const AP_FLOW = buildLog('10:41:10', [
  userInfo('005000000000099', 'autoproc@00d000000000001aa'),
  [0.2, 'EXECUTION_STARTED'],
  [0.1, 'CODE_UNIT_STARTED|[EXTERNAL]|Flow:Opportunity_Alert__e'],
  [0.2, 'FLOW_START_INTERVIEW_BEGIN|300000000000002|Notify_Owner_On_Failed_Close'],
  [0.3, 'FLOW_ELEMENT_BEGIN|300000000000002|FlowRecordCreate|Create_Owner_Task'],
  [0.2, 'DML_BEGIN|[EXTERNAL]|Op:Insert|Type:Task|Rows:1'],
  [1.2, 'DML_END|[EXTERNAL]'],
  [0.1, 'FLOW_ELEMENT_END|300000000000002|FlowRecordCreate|Create_Owner_Task'],
  [0.1, 'FLOW_START_INTERVIEW_END|300000000000002|Notify_Owner_On_Failed_Close'],
  [0.1, 'CODE_UNIT_FINISHED|Flow:Opportunity_Alert__e'],
  ...limitBlock({ dml: 1, dmlRows: 1, cpu: 8, heap: 2048 }),
  [0.1, 'EXECUTION_FINISHED'],
]);

export const DEMO_LOG_SAMPLES = [
  { ...UPDATE, user: '005000000000001', ago: 2, op: '/aura', request: 'Application', app: 'Browser', location: 'Monitoring', status: 'Success' },
  { ...CONTACTS, user: '005000000000003', ago: 6, op: '/aura', request: 'Application', app: 'Browser', location: 'Monitoring', status: 'Success' },
  { ...BATCH, user: '005000000000002', ago: 18, op: 'BatchApex', request: 'Application', app: 'Unknown', location: 'Monitoring', status: 'Attempt to de-reference a null object' },
  { ...ANON, user: '005000000000001', ago: 31, op: '/services/data/v62.0/tooling/executeAnonymous/', request: 'Api', app: 'Unknown', location: 'Monitoring', status: 'Success' },
  { ...FAIL, user: '005000000000004', ago: 1, op: '/aura', request: 'Application', app: 'Browser', location: 'Monitoring', status: DML_MSG },
  { ...SESSION_SAVE, user: '005000000000003', ago: 4, op: '/aura', request: 'Application', app: 'Browser', location: 'Monitoring', status: 'Success' },
  { ...REFRESH, user: '005000000000003', ago: 4 - 0.6 / 60, op: '/aura', request: 'Application', app: 'Browser', location: 'Monitoring', status: 'Success' },
  { ...QUEUE, user: '005000000000003', ago: 4 - 2.3 / 60, op: 'Queueable', request: 'Application', app: 'Unknown', location: 'Monitoring', status: CLOSE_MSG },
  { ...AP_FLOW, user: '005000000000099', ago: 4 - 3.4 / 60, op: 'FlowEventTrigger', request: 'Application', app: 'Unknown', location: 'Monitoring', status: 'Success' },
];

const AUTOMATED_PROCESS = { Id: '005000000000099', Name: 'Automated Process', Username: 'autoproc@00d000000000001aa' };

const DEMO_USERS = [
  { Id: '005000000000001', Name: 'Demo User', Username: 'demo.user@fieldflow.dev' },
  { Id: '005000000000002', Name: 'Integration User', Username: 'integration@fieldflow.dev' },
  { Id: '005000000000003', Name: 'Priya Sharma', Username: 'priya.sharma@fieldflow.dev' },
  { Id: '005000000000004', Name: 'Marco Rossi', Username: 'marco.rossi@fieldflow.dev' },
  { Id: '005000000000005', Name: 'Aisha Khan', Username: 'aisha.khan@fieldflow.dev' },
];

const ORG_LIMITS = {
  DailyApiRequests: { Max: 15000, Remaining: 14123 },
  DailyAsyncApexExecutions: { Max: 250000, Remaining: 249870 },
  DailyBulkApiBatches: { Max: 15000, Remaining: 15000 },
  DailyBulkV2QueryJobs: { Max: 10000, Remaining: 9998 },
  DailyDurableStreamingApiEvents: { Max: 10000, Remaining: 10000 },
  DailyGenericStreamingApiEvents: { Max: 10000, Remaining: 10000 },
  DailyStandardVolumePlatformEvents: { Max: 10000, Remaining: 9640 },
  DailyWorkflowEmails: { Max: 2000, Remaining: 1987 },
  DataStorageMB: { Max: 1024, Remaining: 212 },
  FileStorageMB: { Max: 2048, Remaining: 1630 },
  HourlyAsyncReportRuns: { Max: 1200, Remaining: 1200 },
  HourlyPublishedPlatformEvents: { Max: 250000, Remaining: 249000 },
  HourlyTimeBasedWorkflow: { Max: 1000, Remaining: 1000 },
  MassEmail: { Max: 5000, Remaining: 5000 },
  PermissionSets: { Max: 1500, Remaining: 1386 },
  SingleEmail: { Max: 5000, Remaining: 4870 },
  StreamingApiConcurrentClients: { Max: 2000, Remaining: 1996 },
  ConcurrentAsyncGetReportInstances: { Max: 200, Remaining: 200 },
  ConcurrentSyncReportRuns: { Max: 20, Remaining: 20 },
  DailyAnalyticsDataflowJobExecutions: { Max: 60, Remaining: 44 },
};

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const idOf = (prefix, n) => `${prefix}${String(n).padStart(12, '0')}`;

export class DemoLogBackend {
  constructor() {
    const now = Date.now();
    this.users = [...DEMO_USERS, AUTOMATED_PROCESS];
    this.levels = [
      { Id: idOf('7dl', 1), DeveloperName: 'SFDC_DevConsole', MasterLabel: 'SFDC_DevConsole', ...LEVEL_PRESETS.standard },
      { Id: idOf('7dl', 2), DeveloperName: 'FieldFlow_Light', MasterLabel: 'FieldFlow_Light', ...LEVEL_PRESETS.light },
    ];
    this.flags = [{
      Id: idOf('7tf', 1), TracedEntityId: '005000000000002', LogType: 'USER_DEBUG', DebugLevelId: this.levels[0].Id,
      StartDate: new Date(now - 40 * 60e3).toISOString(), ExpirationDate: new Date(now + 2 * 3600e3).toISOString(),
    }, {
      Id: idOf('7tf', 2), TracedEntityId: '005000000000003', LogType: 'USER_DEBUG', DebugLevelId: this.levels[0].Id,
      StartDate: new Date(now - 10 * 60e3).toISOString(), ExpirationDate: new Date(now + 50 * 60e3).toISOString(),
    }];
    this.bodies = new Map();
    this.logs = [];
    this.n = 0;
    for (const s of DEMO_LOG_SAMPLES) this.addLog(s, s.user, now - s.ago * 60e3);
  }

  addLog(sample, userId, time) {
    const Id = idOf('07L', ++this.n);
    this.bodies.set(Id, sample.body);
    this.logs.push({
      Id, LogUserId: userId, LogUser: { Name: this.users.find((u) => u.Id === userId)?.Name },
      Operation: sample.op, Request: sample.request, Status: sample.status, LogLength: sample.body.length,
      DurationMilliseconds: Math.max(1, Math.round(sample.durationMs)), StartTime: new Date(time).toISOString(),
      Application: sample.app, Location: sample.location,
    });
    this.logs.sort((a, b) => b.StartTime.localeCompare(a.StartTime));
  }

  async currentUserId() { await wait(); return DEMO_USERS[0].Id; }

  async searchUsers(q) {
    await wait();
    const s = q.trim().toLowerCase();
    return this.users.filter((u) => !s || u.Name.toLowerCase().includes(s) || u.Username.toLowerCase().includes(s));
  }

  async getUsers(ids) { return this.users.filter((u) => ids.includes(u.Id)); }

  async automatedProcessUser() { await wait(); return AUTOMATED_PROCESS; }

  async listDebugLevels() { await wait(); return this.levels.map((l) => ({ ...l })); }

  async createDebugLevel(name, levels) {
    await wait(250);
    if (this.levels.some((l) => l.DeveloperName.toLowerCase() === name.toLowerCase())) {
      throw new Error(`DUPLICATE_DEVELOPER_NAME: A debug level named ${name} already exists.`);
    }
    const Id = idOf('7dl', this.levels.length + 1);
    this.levels.push({ Id, DeveloperName: name, MasterLabel: name, ...levels });
    return Id;
  }

  async listTraceFlags() {
    await wait();
    return this.flags.filter((f) => new Date(f.ExpirationDate) > Date.now()).map((f) => ({ ...f }));
  }

  async saveTraceFlag({ id, userId, debugLevelId, start, end }) {
    await wait(250);
    if (end - start > 24 * 3600e3) throw new Error('FIELD_INTEGRITY_EXCEPTION: A trace flag can\'t be longer than 24 hours.');
    const rec = { StartDate: start.toISOString(), ExpirationDate: end.toISOString(), DebugLevelId: debugLevelId };
    const existing = id && this.flags.find((f) => f.Id === id);
    if (existing) Object.assign(existing, rec);
    else {
      id = idOf('7tf', this.flags.length + 1 + this.n);
      this.flags.push({ Id: id, TracedEntityId: userId, LogType: 'USER_DEBUG', ...rec });
    }
    // pretend the traced user does something shortly after logging starts
    const delay = Math.max(0, start - Date.now()) + 4000;
    if (delay < 60000) setTimeout(() => this.addLog(DEMO_LOG_SAMPLES[this.n % DEMO_LOG_SAMPLES.length], userId, Date.now()), delay);
    return id;
  }

  async deleteTraceFlag(id) { await wait(); this.flags = this.flags.filter((f) => f.Id !== id); }

  async listLogs() { await wait(80); return this.logs.map((l) => ({ ...l, LogUser: { ...l.LogUser } })); }

  async getLogBody(id, { onProgress } = {}) {
    if (!this.bodies.has(id)) { await wait(250); throw new Error('NOT_FOUND: The requested log no longer exists.'); }
    const body = this.bodies.get(id);
    // stream it in a few chunks so the loading view has something to show
    const total = new TextEncoder().encode(body).length;
    for (let k = 0; k <= 8; k++) { onProgress?.(Math.round((total * k) / 8), total); if (k < 8) await wait(110); }
    return body;
  }

  async deleteLogs(ids) {
    await wait();
    const s = new Set(ids);
    this.logs = this.logs.filter((l) => !s.has(l.Id));
    for (const id of ids) this.bodies.delete(id);
  }

  async orgLimits() {
    await wait(300);
    const out = structuredClone(ORG_LIMITS);
    out.DailyApiRequests.Remaining -= Math.floor(Math.random() * 40);
    return out;
  }
}
