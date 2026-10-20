// OG Search sources for the demo org: the demo Apex plus sample flows, a Process Builder, validation rules,
// Visualforce, LWC, Aura and custom labels. They match the demo debug logs (Close_Reason_Required,
// Notify_Owner_On_Failed_Close), so "find where this error comes from" works end to end in demo mode.

import { DEMO_UNITS } from '../demo-data.js';
import { linesOf, flowLines, flowKind, flowTypeLabel, validationLines } from './search-engine.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UI = 'https://demo.example.lightning.force.com';

const FLOWS = [
  {
    id: '301000000000001', name: 'Notify_Owner_On_Failed_Close', processType: 'AutoLaunchedFlow', active: true, version: 3,
    md: {
      label: 'Notify Owner On Failed Close', description: 'Emails the owner when an opportunity could not be closed.',
      start: { object: 'Opportunity', triggerType: 'RecordAfterSave', filterFormula: 'ISPICKVAL({!$Record.StageName}, "Closed Lost")' },
      decisions: [{ name: 'Has_Close_Reason', label: 'Has Close Reason?', rules: [{ name: 'Missing', label: 'Missing', conditions: [{ leftValueReference: '$Record.Close_Reason__c', operator: 'IsNull', rightValue: { booleanValue: true } }] }] }],
      customErrors: [{ name: 'Block_Close', label: 'Block close without reason', customErrorMessages: [{ errorMessage: 'Close reason can’t be blank when the opportunity is Closed Lost.', isFieldError: true, fieldSelection: 'Close_Reason__c' }] }],
      actionCalls: [{ name: 'Email_Owner', label: 'Email the owner', actionName: 'emailSimple', inputParameters: [{ name: 'emailSubject', value: { stringValue: 'Opportunity {!$Record.Name} could not be closed' } }, { name: 'emailBody', value: { elementReference: 'EmailBody' } }] }],
      textTemplates: [{ name: 'EmailBody', text: 'Hi {!$Record.Owner.FirstName}, the close failed: Close Reason is required when closing an opportunity.' }],
    },
  },
  {
    id: '301000000000002', name: 'Account_Industry_Sync', processType: 'AutoLaunchedFlow', active: true, version: 1,
    md: {
      label: 'Account Industry Sync', start: { object: 'Account', triggerType: 'RecordBeforeSave' },
      assignments: [{ name: 'Copy_Industry', label: 'Copy industry to description', assignmentItems: [{ assignToReference: '$Record.Description', operator: 'Assign', value: { stringValue: 'Industry: {!$Record.Industry}' } }] }],
    },
  },
  {
    id: '301000000000003', name: 'New_Customer_Intake', processType: 'Flow', active: true, version: 5,
    md: {
      label: 'New Customer Intake',
      screens: [{ name: 'Details', label: 'Customer details', fields: [{ name: 'Company', fieldText: 'Company name', fieldType: 'InputField', validationRule: { errorMessage: 'Please enter the company name.', formulaExpression: 'NOT(ISBLANK({!Company}))' } }] }],
      recordCreates: [{ name: 'Create_Account', label: 'Create the account', object: 'Account' }],
    },
  },
  {
    id: '301000000000004', name: 'Opportunity_Stage_Update', processType: 'Workflow', active: true, version: 2,
    md: {
      label: 'Opportunity Stage Update (Process Builder)', description: 'Old process: stamps the close date and posts to Chatter.',
      decisions: [{ name: 'myDecision', label: 'Stage is Closed Won', rules: [{ name: 'myRule_1', label: 'Closed Won', conditions: [{ leftValueReference: 'myVariable_current.StageName', operator: 'EqualTo', rightValue: { stringValue: 'Closed Won' } }] }] }],
      recordUpdates: [{ name: 'myRule_1_A1', label: 'Stamp close date', inputAssignments: [{ field: 'CloseDate', value: { elementReference: '$Flow.CurrentDate' } }] }],
      actionCalls: [{ name: 'myRule_1_A2', label: 'Post to Chatter', actionName: 'chatterPost', inputParameters: [{ name: 'text', value: { stringValue: 'Deal won! {!myVariable_current.Name} is closed.' } }] }],
    },
  },
  {
    id: '301000000000005', name: 'Lead_Old_Assignment', processType: 'AutoLaunchedFlow', active: false, version: 1,
    md: { label: 'Lead Old Assignment', customErrors: [{ name: 'Stop', label: 'Stop', customErrorMessages: [{ errorMessage: 'Leads can only be assigned by the queue.' }] }] },
  },
];

const RULES = [
  { Id: '03d000000000002', ValidationName: 'Close_Reason_Required', object: 'Opportunity', Active: true, ErrorMessage: 'Close Reason is required when closing an opportunity', ErrorDisplayField: 'Close_Reason__c', Description: 'Sales ops wants a reason for every lost deal.', formula: 'AND(\n  ISPICKVAL(StageName, "Closed Lost"),\n  ISBLANK(Close_Reason__c)\n)' },
  { Id: '03d000000000003', ValidationName: 'Amount_Positive', object: 'Opportunity', Active: true, ErrorMessage: 'Amount must be greater than zero.', ErrorDisplayField: 'Amount', Description: '', formula: 'Amount <= 0' },
  { Id: '03d000000000004', ValidationName: 'Website_Format', object: 'Account', Active: true, ErrorMessage: 'Website must start with https://', ErrorDisplayField: 'Website', Description: 'Security asked for HTTPS links only.', formula: 'AND(NOT(ISBLANK(Website)), NOT(BEGINS(Website, "https://")))' },
  { Id: '03d000000000005', ValidationName: 'Industry_Required_For_Customers', object: 'Account', Active: false, ErrorMessage: 'Industry is required for customers.', ErrorDisplayField: 'Industry', Description: 'Switched off during the data migration.', formula: 'AND(ISPICKVAL(Type, "Customer"), ISBLANK(TEXT(Industry)))' },
];

const VF = [
  { Id: '066000000000001', Name: 'AccountSummaryPdf', sub: 'page', Markup: `<apex:page standardController="Account" renderAs="pdf" extensions="AccountController">
  <h1>{!Account.Name}</h1>
  <apex:outputText value="Industry: {!Account.Industry}"/>
  <apex:pageMessages />
  <apex:outputPanel rendered="{!ISBLANK(Account.Industry)}">Industry is required before printing.</apex:outputPanel>
</apex:page>` },
  { Id: '099000000000001', Name: 'ErrorBanner', sub: 'component', Markup: `<apex:component>
  <apex:attribute name="message" type="String" description="What went wrong"/>
  <div class="banner">Something went wrong: {!message}</div>
</apex:component>` },
];

const LWC = [
  { Id: '0Rd000000000001', bundle: 'closeOpportunity', file: 'closeOpportunity.js', Source: `import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import closeOpp from '@salesforce/apex/OpportunityService.closeStale';
import CLOSE_REASON_MISSING from '@salesforce/label/c.Close_Reason_Missing';

export default class CloseOpportunity extends LightningElement {
  @api recordId;
  reason;

  async handleClose() {
    if (!this.reason) {
      this.dispatchEvent(new ShowToastEvent({ title: 'Can’t close', message: CLOSE_REASON_MISSING, variant: 'error' }));
      return;
    }
    try {
      await closeOpp({ ids: [this.recordId] });
    } catch (e) {
      this.dispatchEvent(new ShowToastEvent({ title: 'Close failed', message: e.body?.message || 'Unknown error', variant: 'error' }));
    }
  }
}` },
  { Id: '0Rd000000000002', bundle: 'closeOpportunity', file: 'closeOpportunity.html', Source: `<template>
  <lightning-card title="Close opportunity">
    <lightning-combobox label="Close reason" value={reason} onchange={handleReason}></lightning-combobox>
    <lightning-button label="Close" variant="brand" onclick={handleClose}></lightning-button>
  </lightning-card>
</template>` },
];

const AURA = [
  { Id: '0Ad000000000001', bundle: 'IndustryPicker', DefType: 'COMPONENT', Format: 'XML', Source: `<aura:component implements="force:hasRecordId">
  <aura:attribute name="industry" type="String"/>
  <lightning:input label="Industry" value="{!v.industry}" required="true" messageWhenValueMissing="Industry is required."/>
</aura:component>` },
];

const LABELS = [
  { Id: '101000000000001', Name: 'Close_Reason_Missing', Value: 'Please pick a close reason before closing this opportunity.', MasterLabel: 'Close reason missing', Category: 'Opportunity' },
  { Id: '101000000000002', Name: 'Generic_Save_Error', Value: 'We couldn’t save your changes. Try again, or contact your admin.', MasterLabel: 'Generic save error', Category: '' },
];

export class DemoSearchSources {
  constructor() { this.orgKey = 'demo'; }

  async load(group, progress = () => {}) {
    progress(`Reading ${group}…`, 0.3);
    await wait(group === 'flow' || group === 'validation' ? 450 : 200);
    progress(`Reading ${group}…`, 1);
    return this[group]();
  }

  apex() {
    return DEMO_UNITS.map((u) => ({
      kind: u.kind === 'trigger' ? 'trigger' : 'apex', id: u.id, name: u.name, sub: u.kind === 'trigger' ? 'trigger' : 'class',
      lines: linesOf(u.body), code: 'apex', link: `${UI}/lightning/setup/${u.kind === 'trigger' ? 'ApexTriggers' : 'ApexClasses'}/page?address=%2F${u.id}`,
    }));
  }

  flow() {
    return FLOWS.map((f) => ({
      kind: flowKind(f.processType), id: f.id, name: f.name, title: f.md.label, inactive: !f.active,
      sub: `${flowTypeLabel(f.processType, f.md.start?.triggerType)}${f.md.start?.object ? ` · ${f.md.start.object}` : ''} · v${f.version}${f.active ? '' : ' · inactive'}`,
      lines: flowLines(f.md),
      link: flowKind(f.processType) === 'process' ? `${UI}/lightning/setup/ProcessAutomation/home` : `${UI}/builder_platform_interaction/flowBuilder.app?flowId=${f.id}`,
    }));
  }

  validation() {
    return RULES.map((r) => ({
      kind: 'validation', id: r.Id, name: r.ValidationName, sub: `${r.object}${r.Active ? '' : ' · inactive'}`, inactive: !r.Active,
      lines: validationLines(r), link: `${UI}/lightning/setup/ObjectManager/${r.object}/ValidationRules/${r.Id}/view`,
    }));
  }

  vf() {
    return VF.map((p) => ({ kind: 'vf', id: p.Id, name: p.Name, sub: p.sub, lines: linesOf(p.Markup), code: 'markup', link: `${UI}/lightning/setup/${p.sub === 'page' ? 'ApexPages' : 'ApexComponents'}/page?address=%2F${p.Id}` }));
  }

  lwc() {
    return LWC.map((f) => ({ kind: 'lwc', id: f.Id, name: f.bundle, sub: f.file, lines: linesOf(f.Source), code: /\.html$/.test(f.file) ? 'markup' : 'js', link: `${UI}/lightning/setup/LightningComponentBundles/home` }));
  }

  aura() {
    return AURA.map((d) => ({ kind: 'aura', id: d.Id, name: d.bundle, sub: d.DefType.toLowerCase(), lines: linesOf(d.Source), code: 'markup', link: `${UI}/lightning/setup/LightningComponentBundles/home` }));
  }

  label() {
    return LABELS.map((l) => ({
      kind: 'label', id: l.Id, name: l.Name, sub: l.Category,
      lines: [{ label: 'Value', text: l.Value }, { label: 'Short description', text: l.MasterLabel }], link: `${UI}/lightning/setup/ExternalStrings/page?address=%2F${l.Id}`,
    }));
  }

  clearCache() { return Promise.resolve(); }
}
