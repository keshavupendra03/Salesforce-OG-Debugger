# Salesforce OG Debugger

Version 1.0.0 · built by **Keshav Yadav** ·
[LinkedIn](https://www.linkedin.com/in/keshav-yadav-40366b205) · keshavupendra03@gmail.com · 6268471199

Pick an object and a field, and see every Apex method that **reads or writes** it, plus the
**call tree** back to the entry points (triggers, LWC/Aura, Flow, REST, Batch, Scheduled, Queueable).
Click any node to see the exact lines in the source.

No extra login: like Salesforce Inspector / Lightning Studio, it reuses the session you already
have in the browser. Code is downloaded and analysed **entirely in the browser**; nothing is sent anywhere else.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick this folder.
2. Log in to a Salesforce org, then click the Salesforce OG Debugger toolbar icon while on a Salesforce tab.
3. No org handy? Open the extension with no Salesforce tab and click **Explore the demo org**
   (or go to `chrome-extension://<id>/app.html?demo=1`).

Your user needs the **API Enabled** permission (the extension calls the REST and Tooling APIs).

## How it works

```
background.js        toolbar click → opens app.html?host=<current Salesforce host>
src/session.js       reads the `sid` cookie of that host, finds the matching cookie on *.my.salesforce.com
src/sf-api.js        REST + Tooling API client (latest API version, paging)
src/code-loader.js   lists ApexClass / ApexTrigger (unmanaged), downloads only changed bodies,
                     caches them per org in IndexedDB (keyed by LastModifiedDate)
src/apex/lexer.js    tokenizer (case-insensitive, keeps strings for dynamic SOQL / get('Field'))
src/apex/parser.js   classes, inner classes, triggers, methods, properties, member variables, SOQL regions
src/apex/analyzer.js call graph + field reference classifier + entry-path search
src/app.js           UI: object/field pickers, call tree, entry paths, source view
```

### What it detects

| Pattern | Example | Result |
|---|---|---|
| Typed field access | `acc.Industry = x` where `acc` is `Account` | write, sure |
| Collection / map access | `oldMap.get(id).Industry`, `accs[0].Industry`, casts | read, sure |
| Relationship paths | `opp.Account.Industry`, `SELECT Account.Industry FROM Opportunity` | read, sure |
| SOQL / SOSL | `[SELECT Industry FROM Account]` (sub-query aware, bind vars ignored) | read, sure |
| Constructors | `new Account(Industry = 'X')` | write, sure |
| Schema tokens | `Account.Industry`, `Schema.SObjectType.Account.fields.Industry` | read (write inside `put`) |
| Dynamic Apex | `record.put('Industry', v)` on `SObject` | possible |
| Dynamic SOQL strings | `Database.query('SELECT Industry FROM Account')` | read |
| Same field name, other object | `lead.Industry` | ignored |

Call graph: static calls, instance calls through typed variables, `this`/`super`, inherited methods,
**virtual/abstract overrides and interface implementations** (so trigger frameworks like
`TriggerHandler.run() → this.beforeUpdate()` resolve), and `new MyBatch()` / `new MyJob()` linked to
`start/execute/finish` as async calls.

"Possible" matches (unknown receiver type, `SObject`, name-only call matches) are hidden by default
and shown with dashed borders when enabled.

### Known gaps (by design for an MVP)

- Managed-package code is excluded (`NamespacePrefix = null`), since its bodies are hidden anyway.
- No full type inference: method return types, generic `Object`, and fields of wrapper classes
  fall back to "possible".
- Calls through a base class are context-insensitive: if several triggers call `TriggerHandler.run()`,
  each override shows all of them as callers.
- Only Apex. Flows, LWC, Visualforce, formulas, validation rules and workflow are not scanned yet.
- Very large orgs (tens of MB of Apex) parse on the main thread. Move parsing to a Web Worker before scaling.

## Debug Logs

Switch to **Debug Logs** in the top bar (demo: `app.html?demo=1&view=logs`).

- **Trace a user:** pick a user, a debug level (or create one with a preset), a start time and 1–24 hours.
  An existing `USER_DEBUG` trace flag for that user is updated instead of duplicated (Salesforce allows one).
- **Active trace flags** show time left, with Edit / Stop.
- **Logs** refresh live every 5 s; filter by text, user or errors; ↑/↓ steps through logs; delete one, filtered or all.
- **Execution Path:** every failure as a path from the entry point (LWC, trigger, batch, …) through DML,
  triggers and methods down to the line that threw, with root-cause / uncaught tags and the stack trace; plus a
  call tree of the whole request. Clicking a step opens its Apex method with the call / throw lines highlighted.
  Sources come from the Code Flow scan if available, otherwise from the Tooling API (cached per session).
  Call-site lines come from `METHOD_ENTRY` events, so the debug level needs Apex Code = FINE or finer.
- **Sessions:** one click in Salesforce often creates several logs (the save, page-refresh reads, queueables,
  platform-event flows run by *Automated Process*). Switch the list to **Sessions**, choose the users to include
  (target user, extra users, Automated Process) and a gap (2–60 s); logs closer together than the gap are grouped.
  Tick the logs you want and **Open N as one**: every tab then works on the merged session, with `T1…Tn` markers,
  a transaction timeline, a cross-transaction trail on each error path, and governor limits per transaction.
- **Field Trace:** "where is this field being updated?" for one real execution. Trace a user, reproduce, open the
  session, pick Object + Field. Combines the Code Flow scan (methods that ran and read/write the field) with the
  log itself (`VARIABLE_ASSIGNMENT` values at Apex Code FINEST, workflow field updates, flows, validation rules,
  SOQL). Views: **Paths** (entry point → … → write/read, plus the DML that saved the record), **Call tree**
  (pruned to steps that touch the field) and **Timeline**. Clicking a step opens the Apex with the field lines
  and logged values highlighted.
- **Viewer tabs:** Log Details (summary tiles, errors, levels, code units), Debug Log (virtualized, colour-coded,
  searchable, category filters), Queries (repeated-query detection), User Debug (JSON pretty-print), Order of
  Execution (tree with timings and a timeline), DML, Governor Limits (from `LIMIT_USAGE_FOR_NS`) and Org Limits
  (live `/limits`). Line buttons in every tab jump to that line in the raw log. Download / Copy the log.

```
src/logs/log-backend.js  Tooling/REST calls: User, DebugLevel, TraceFlag, ApexLog, /limits
src/logs/log-parser.js   one-pass log parser (categories, tree, queries, DML, debug, errors, limits)
src/logs/logs-ui.js      the view
src/logs/demo-logs.js    in-memory backend + sample logs for demo mode and tests
```

## Data Export

Switch to **Data Export** in the top bar (demo: `app.html?demo=1&view=data`).

- **SOQL editor** with highlighting and suggestions that follow the clause you're in: objects after `FROM`,
  fields (and `Account.Owner.Name` relationship paths) in `SELECT` / `WHERE` / `ORDER BY`, operators after a field,
  picklist values, `true/false` and date literals after an operator, child relationships in sub-queries.
  Ctrl+Space opens them, Ctrl+Enter runs (only the selection, if any), Ctrl+S saves.
- **Insert bar** for operators (`=`, `LIKE '%%'`, `IN ('')`, `AND`, `= null`, `ORDER BY`, `LIMIT`, date literals…).
- **Tabs**: each tab keeps its query and its last result; tabs survive a reload (results don't). Double-click to rename.
- **History** (last 100 runs) and **Saved** queries, per org, in the extension's local storage. Search, run, clear.
- **Results**: virtualized table, click a header to sort, Filter to narrow rows by text, Stop to cancel a running query
  (rows fetched so far stay). Pages load automatically up to 50,000 rows, then "Load more".
- **Record ids**: click one for *View in Salesforce* (new tab) or *Copy Id*.
- **Copy** for Excel (tab-separated), CSV or JSON; **CSV download** (UTF-8 with BOM, opens cleanly in Excel).
  Both use the selected rows if any, otherwise the filtered rows.
- **Delete**: tick rows (shift-click for a range) → Delete N → confirm. 50+ records need typing `DELETE`.
  Uses the composite API in batches of 200; failures are listed per record.
- Toggles for **Deleted & archived** (`queryAll`) and **Tooling API**.

```
src/data/soql.js               tokenizer, autocomplete, id detection, flatten, CSV/TSV/JSON
src/data/data-backend.js       query/queryAll/Tooling with paging + abort, describes, composite delete
src/data/demo-data-backend.js  sample records + a small SOQL engine for demo mode and tests
src/data/data-ui.js            the view
```

## Feedback and support

The footer has two quiet buttons that never open on their own:

- **Feedback** opens a short card that links to a Google Form in a new tab. Put the form's link in
  `FEEDBACK_FORM_URL` in [src/config.js](src/config.js) (currently https://forms.gle/1VzEaK1fkp4tCCMdA); while it's
  empty the button shows "Coming soon".
- **Buy me a coffee** shows the UPI QR / id (and a Buy Me a Coffee option, coming soon).

## Roadmap ideas

1. Flows (`Flow` metadata via Tooling API) and LWC (`LightningComponentResource`) as extra leaf/entry nodes.
2. Return-type inference so `getInstance().doWork()` and factory methods resolve.
3. "Impact report" export (CSV/Markdown) for change reviews.
4. OAuth fallback (PKCE, own connected app / External Client App) for orgs that block API calls
   from browser sessions.
5. Web Worker parsing + compact token storage for big orgs.

## Tests

```
node test/run-tests.mjs
```
Runs the analyzer against the demo org (references, false-positive checks, call graph, entry paths).
