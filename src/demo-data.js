// Sample org used by demo mode (no Salesforce login needed) and by the tests.

const cls = (id, name, body) => ({ id, name, kind: 'class', body: body.trim() + '\n' });
const trg = (id, name, body) => ({ id, name, kind: 'trigger', body: body.trim() + '\n' });

export const DEMO_UNITS = [
  trg('01q000000000001', 'AccountTrigger', `
trigger AccountTrigger on Account (before insert, before update, after update) {
    new AccountTriggerHandler().run();
}`),

  trg('01q000000000002', 'OpportunityTrigger', `
trigger OpportunityTrigger on Opportunity (after insert, after update) {
    if (Trigger.isUpdate) {
        System.enqueueJob(new OpportunityCleanupJob(Trigger.new));
    }
}`),

  cls('01p000000000001', 'TriggerHandler', `
/**
 * Minimal trigger framework: subclasses override the context methods they need.
 */
public virtual class TriggerHandler {
    public void run() {
        if (Trigger.isBefore && Trigger.isInsert) {
            this.beforeInsert();
        } else if (Trigger.isBefore && Trigger.isUpdate) {
            this.beforeUpdate();
        } else if (Trigger.isAfter && Trigger.isUpdate) {
            this.afterUpdate();
        }
    }

    protected virtual void beforeInsert() {}
    protected virtual void beforeUpdate() {}
    protected virtual void afterUpdate() {}
}`),

  cls('01p000000000002', 'AccountTriggerHandler', `
public with sharing class AccountTriggerHandler extends TriggerHandler {
    private List<Account> newList;
    private Map<Id, Account> oldMap;

    public AccountTriggerHandler() {
        this.newList = (List<Account>) Trigger.new;
        this.oldMap = (Map<Id, Account>) Trigger.oldMap;
    }

    protected override void beforeInsert() {
        AccountService.normalizeIndustry(newList);
        AccountService.assignRating(newList);
    }

    protected override void beforeUpdate() {
        List<Account> changed = new List<Account>();
        for (Account acc : newList) {
            Account oldAcc = oldMap.get(acc.Id);
            if (acc.Industry != oldAcc.Industry) {
                changed.add(acc);
            }
        }
        AccountService.normalizeIndustry(changed);
    }

    protected override void afterUpdate() {
        OpportunityService.syncAccountIndustry(newList, oldMap);
    }
}`),

  cls('01p000000000003', 'AccountService', `
public with sharing class AccountService {
    private static final Map<String, String> INDUSTRY_ALIASES = new Map<String, String>{
        'tech' => 'Technology',
        'it'   => 'Technology',
        'bank' => 'Banking'
    };

    public static void normalizeIndustry(List<Account> accounts) {
        for (Account acc : accounts) {
            if (String.isBlank(acc.Industry)) {
                continue;
            }
            String key = acc.Industry.trim().toLowerCase();
            if (INDUSTRY_ALIASES.containsKey(key)) {
                acc.Industry = INDUSTRY_ALIASES.get(key);
            }
        }
        System.debug(JSON.serialize(new Map<String, Object>{ 'normalized' => accounts.size(), 'aliases' => INDUSTRY_ALIASES }));
    }

    public static void assignRating(List<Account> accounts) {
        for (Account acc : accounts) {
            if (acc.AnnualRevenue != null && acc.AnnualRevenue > 10000000) {
                acc.Rating = 'Hot';
            } else if (acc.Industry == 'Banking') {
                acc.Rating = 'Warm';
            }
        }
    }

    public static List<Account> getAccountsByIndustry(String industry) {
        return [
            SELECT Id, Name, Industry, Rating, AnnualRevenue
            FROM Account
            WHERE Industry = :industry
            ORDER BY AnnualRevenue DESC
            LIMIT 200
        ];
    }

    public static Map<String, Integer> countByIndustry() {
        Map<String, Integer> counts = new Map<String, Integer>();
        for (AggregateResult ar : [SELECT Industry, COUNT(Id) total FROM Account GROUP BY Industry]) {
            counts.put((String) ar.get('Industry'), (Integer) ar.get('total'));
        }
        return counts;
    }
}`),

  cls('01p000000000004', 'AccountController', `
public with sharing class AccountController {
    @AuraEnabled(cacheable=true)
    public static List<Account> getIndustryAccounts(String industry) {
        return AccountService.getAccountsByIndustry(industry);
    }

    @AuraEnabled
    public static void updateIndustry(Id accountId, String industry) {
        System.debug('updateIndustry called for ' + accountId + ' -> ' + industry);
        Account acc = new Account(Id = accountId, Industry = industry);
        update acc;
    }

    @AuraEnabled(cacheable=true)
    public static Map<String, Integer> getIndustryChart() {
        return AccountService.countByIndustry();
    }

    @AuraEnabled
    public static String exportIndustries(List<Id> accountIds) {
        List<SObject> rows = [SELECT Id, Name FROM Account WHERE Id IN :accountIds];
        return CsvExporter.toCsv(rows);
    }
}`),

  cls('01p000000000005', 'IndustryEnrichmentBatch', `
public with sharing class IndustryEnrichmentBatch implements Database.Batchable<SObject>, Database.AllowsCallouts {
    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator(
            'SELECT Id, Website, Industry FROM Account WHERE Industry = null AND Website != null'
        );
    }

    public void execute(Database.BatchableContext bc, List<Account> scope) {
        for (Account acc : scope) {
            acc.Industry = EnrichmentClient.lookupIndustry(acc.Website);
        }
        update scope;
    }

    public void finish(Database.BatchableContext bc) {}
}`),

  cls('01p000000000006', 'IndustryEnrichmentScheduler', `
public with sharing class IndustryEnrichmentScheduler implements Schedulable {
    public void execute(SchedulableContext sc) {
        Database.executeBatch(new IndustryEnrichmentBatch(), 100);
    }
}`),

  cls('01p000000000007', 'EnrichmentClient', `
public with sharing class EnrichmentClient {
    public static String lookupIndustry(String website) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Enrichment/company?domain=' + EncodingUtil.urlEncode(website, 'UTF-8'));
        req.setMethod('GET');
        HttpResponse res = new Http().send(req);
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        return (String) body.get('industry');
    }
}`),

  cls('01p000000000008', 'OpportunityService', `
public with sharing class OpportunityService {
    public static void syncAccountIndustry(List<Account> accounts, Map<Id, Account> oldMap) {
        Set<Id> changedIds = new Set<Id>();
        for (Account acc : accounts) {
            if (acc.Industry != oldMap.get(acc.Id).Industry) {
                changedIds.add(acc.Id);
            }
        }
        if (changedIds.isEmpty()) {
            return;
        }
        List<Opportunity> opps = [
            SELECT Id, Account.Industry, Account_Industry__c
            FROM Opportunity
            WHERE AccountId IN :changedIds AND IsClosed = false
        ];
        for (Opportunity opp : opps) {
            opp.Account_Industry__c = opp.Account.Industry;
        }
        update opps;
    }

    public static void closeStale(List<Opportunity> opps) {
        List<Opportunity> toUpdate = new List<Opportunity>();
        for (Opportunity o : opps) {
            if (o.CloseDate < Date.today() && !o.IsClosed) {
                toUpdate.add(new Opportunity(Id = o.Id, StageName = 'Closed Lost'));
            }
        }
        update toUpdate;
    }

    public static String closeReasonMessage() {
        return System.Label.Close_Reason_Missing + ' ' + Label.Generic_Save_Error;
    }
}`),

  cls('01p000000000009', 'OpportunityCleanupJob', `
public class OpportunityCleanupJob implements Queueable {
    private List<Opportunity> opps;

    public OpportunityCleanupJob(List<Opportunity> opps) {
        this.opps = opps;
    }

    public void execute(QueueableContext ctx) {
        OpportunityService.closeStale(opps);
    }
}`),

  cls('01p000000000010', 'AccountIntakeResource', `
@RestResource(urlMapping='/accounts/intake/*')
global with sharing class AccountIntakeResource {
    @HttpPost
    global static Id createAccount(String name, String industry, String website) {
        Account acc = new Account(Name = name, Website = website);
        LeadMapper.applyIndustry(acc, industry);
        insert acc;
        return acc.Id;
    }
}`),

  cls('01p000000000011', 'LeadMapper', `
public with sharing class LeadMapper {
    // Generic helper: the record type is only known at runtime
    public static void applyIndustry(SObject record, String industry) {
        record.put('Industry', industry);
    }

    public static void copyFromLead(Lead l, Account a) {
        a.Industry = l.Industry;
        a.Website = l.Website;
    }
}`),

  cls('01p000000000012', 'LeadConversionService', `
public with sharing class LeadConversionService {
    @InvocableMethod(label='Convert qualified leads')
    public static void convert(List<Id> leadIds) {
        List<Account> accounts = new List<Account>();
        for (Lead l : [SELECT Id, Company, Industry, Website FROM Lead WHERE Id IN :leadIds]) {
            Account a = new Account(Name = l.Company);
            LeadMapper.copyFromLead(l, a);
            accounts.add(a);
        }
        insert accounts;
    }
}`),

  cls('01p000000000013', 'CsvExporter', `
public with sharing class CsvExporter {
    public static String toCsv(List<SObject> rows) {
        String out = 'Name,Industry\\n';
        for (SObject row : rows) {
            out += row.get('Name') + ',' + row.get('Industry') + '\\n';
        }
        return out;
    }
}`),

  cls('01p000000000014', 'AccountServiceTest', `
@IsTest
private class AccountServiceTest {
    @IsTest
    static void normalizesAliases() {
        Account a = new Account(Name = 'Acme', Industry = 'tech');
        insert a;
        a = [SELECT Industry FROM Account WHERE Id = :a.Id];
        System.assertEquals('Technology', a.Industry);
    }

    @IsTest
    static void ratesBanks() {
        List<Account> accs = new List<Account>{ new Account(Name = 'Bank', Industry = 'Banking') };
        AccountService.assignRating(accs);
        System.assertEquals('Warm', accs[0].Rating);
    }
}`),
];

const f = (name, label, type, extra = {}) => ({ name, label, type, custom: name.endsWith('__c'), ...extra });

export const DEMO_OBJECTS = [
  { name: 'Account', label: 'Account', custom: false },
  { name: 'Contact', label: 'Contact', custom: false },
  { name: 'Lead', label: 'Lead', custom: false },
  { name: 'Opportunity', label: 'Opportunity', custom: false },
];

export const DEMO_FIELDS = {
  Account: [
    f('Id', 'Account ID', 'id'), f('Name', 'Account Name', 'string'), f('Industry', 'Industry', 'picklist'),
    f('Rating', 'Account Rating', 'picklist'), f('AnnualRevenue', 'Annual Revenue', 'currency'),
    f('Website', 'Website', 'url'), f('Type', 'Account Type', 'picklist'),
  ],
  Contact: [f('Id', 'Contact ID', 'id'), f('FirstName', 'First Name', 'string'), f('LastName', 'Last Name', 'string'), f('Email', 'Email', 'email')],
  Lead: [f('Id', 'Lead ID', 'id'), f('Company', 'Company', 'string'), f('Industry', 'Industry', 'picklist'), f('Website', 'Website', 'url')],
  Opportunity: [
    f('Id', 'Opportunity ID', 'id'), f('Name', 'Name', 'string'), f('StageName', 'Stage', 'picklist'),
    f('CloseDate', 'Close Date', 'date'), f('Amount', 'Amount', 'currency'), f('IsClosed', 'Closed', 'boolean'),
    f('AccountId', 'Account ID', 'reference'), f('Account_Industry__c', 'Account Industry', 'string'),
  ],
};

// A second sample (app.html?demo=framework): a metadata-driven trigger framework, where every trigger calls
// one dispatcher that picks the handler class at run time. Used to check Code Flow keeps only real paths.
export const DEMO_FRAMEWORK_UNITS = [
  cls('01p000000000101', 'FW_ITriggerHandler', `
public interface FW_ITriggerHandler {
    void afterUpdate(Map<Id, SObject> newMap, Map<Id, SObject> oldMap);
}`),
  cls('01p000000000102', 'FW_TriggerDispatcher', `
public class FW_TriggerDispatcher {
    public static void run(String settingName) {
        Trigger_Setting__mdt setting = Trigger_Setting__mdt.getInstance(settingName);
        FW_ITriggerHandler handler = (FW_ITriggerHandler) Type.forName(setting.Handler_Class__c).newInstance();
        execute(handler);
    }
    private static void execute(FW_ITriggerHandler handler) {
        if (Trigger.isAfter && Trigger.isUpdate) {
            handler.afterUpdate(Trigger.newMap, Trigger.oldMap);
        }
    }
}`),
  cls('01p000000000103', 'ddmTriggerHandler', `
public class ddmTriggerHandler implements FW_ITriggerHandler {
    public void afterUpdate(Map<Id, SObject> newMap, Map<Id, SObject> oldMap) {
        ddmOrderService.generateOrderOnReplacement(newMap.keySet());
    }
}`),
  cls('01p000000000104', 'CaseTriggerHandler', `
public class CaseTriggerHandler implements FW_ITriggerHandler {
    public void afterUpdate(Map<Id, SObject> newMap, Map<Id, SObject> oldMap) {
        System.debug('cases updated');
    }
}`),
  cls('01p000000000105', 'ddmOrderService', `
public class ddmOrderService {
    public static void generateOrderOnReplacement(Set<Id> requestIds) {
        System.debug('creating replacement orders for ' + requestIds.size() + ' requests');
    }
}`),
  trg('01q000000000101', 'ddmTrigger', `
trigger ddmTrigger on DDM_Request__c (before insert, before update, after update) {
    FW_TriggerDispatcher.run('DDM');
}`),
  trg('01q000000000102', 'CaseTrigger', `
trigger CaseTrigger on Case (before insert, before update, after update) {
    FW_TriggerDispatcher.run('Case');
}`),
  trg('01q000000000103', 'AssetTrigger', `
trigger AssetTrigger on Asset (before insert, before update, after update) {
    FW_TriggerDispatcher.run('Asset');
}`),
];
