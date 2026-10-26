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

**Trigger frameworks:** a trigger that reaches a handler through an interface / virtual call (one dispatcher
for every trigger) only counts for the handler it really uses: the one it creates (`new XHandler()`), the one
its custom metadata names (`TriggerSettings__mdt`-style records read after the scan, when the dispatcher uses
`Type.forName`), or failing those, the one its name matches. The others fold into "Only if the trigger
framework picked this handler" in both the call tree and the entry paths (`src/apex/dispatch.js`).

### Outside Apex

Both tabs also list what isn't Apex, read from the same (cached) sources FBI Search uses:

| Where | Field mode | Method mode |
|---|---|---|
| Flows and Process Builder | the elements that read or write it (`$Record`, record variables, Get Records, loops, Update / Create Records) | Apex actions running its `@InvocableMethod` |
| Validation rules | formulas that use it (same object, or through a lookup) | |
| Formula fields | formulas on the object that use it | |
| LWC | `@salesforce/schema/Object.Field`, `Object.Field`, field names next to the object | `import … from '@salesforce/apex/Class.method'` |
| Aura | as LWC | `controller="Class"` + `c.method` |
| Visualforce | `{!Object.Field}`, inputs | `controller` / `extensions` + `{!method}`, `{!property}`, remoting |

They show as dashed cards in the call tree (with what they do, the source lines, and a link to Flow Builder /
Setup) and as the start of entry paths: an LWC that calls an `@AuraEnabled` method becomes the entry point
("LWC closeOpportunity → OpportunityService.closeStale()"). `src/usage/usage.js`.

### Known gaps (by design for an MVP)

- Managed-package code is excluded (`NamespacePrefix = null`), since its bodies are hidden anyway.
- No full type inference: method return types, generic `Object`, and fields of wrapper classes
  fall back to "possible".
- Outside Apex: workflow field updates, cross-object formulas on other objects, page layouts and reports are not
  scanned; component matches by field name are marked "possible".
- Very large orgs (tens of MB of Apex) parse on the main thread. Move parsing to a Web Worker before scaling.

## Debug Logs

Switch to **Debug Logs** in the top bar (demo: `app.html?demo=1&view=logs`).

- **Trace a user:** pick a user, a debug level (or create one with a preset), a start time and 1–24 hours.
  An existing `USER_DEBUG` trace flag for that user is updated instead of duplicated (Salesforce allows one).
- **Active trace flags** show time left, with Edit / Stop.
- **Logs** refresh live every 5 s; filter by text, user or errors; ↑/↓ steps through logs; delete one, filtered or all.
  **⤢** opens the list in a big window (one row per log, filters on one line). It's the same list, so filters,
  List / Sessions, ticked logs and Live carry over. Opening a log closes the window; ↑/↓ browse without closing;
  Esc, a click outside or **⤡** puts the list back in the sidebar.
- **Execution Path:** every failure as a path from the entry point (LWC, trigger, batch, …) through DML,
  triggers and methods down to the line that threw, with root-cause / uncaught tags and the stack trace; plus a
  call tree of the whole request. Clicking a step opens its Apex method with the call / throw lines highlighted.
  **⧉** copies one error path as plain text, **Copy all paths** copies them all.
  Every Apex code panel (Execution Path, Field Trace, and the ⤢ expanded view) has **Copy method**, **Copy class**
  (**Copy trigger**) and **Open in OG Explorer**, which opens the class in a new Explorer tab at that method.
  **Entry paths** (third mode) shows Code Flow's entry paths for any method that ran in the log: every way the
  code can reach it, not only the way it ran this time. It starts on the step you selected (or where it failed);
  **Who calls** is a search box: type any words of a method or trigger that ran (↑ ↓ Enter). Same cards and copy
  buttons as Code Flow; a click on a step shows its code on the right and opens the call tree to that step.
- The **call tree keeps its state** (open branches, selection, scroll) when you switch modes or sub-tabs; it only
  moves when you pick a step in Entry paths.
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
- **↻ Rescan Apex** (open log's header): fixed the bug in the Developer Console? Rescan fetches only the classes and
  triggers whose `LastModifiedDate` changed, re-opens the code on screen and tells you what changed. A log written
  *before* your change keeps showing the code it ran (🕰 note, with *Show latest*), so line numbers still match. If
  that older version was never loaded in this tab, a ⚠ note says the class changed after the log. Old versions are
  kept in memory only.

```
src/logs/log-backend.js  Tooling/REST calls: User, DebugLevel, TraceFlag, ApexLog, /limits
src/logs/log-parser.js   one-pass log parser (categories, tree, queries, DML, debug, errors, limits)
src/logs/logs-ui.js      the view
src/logs/demo-logs.js    in-memory backend + sample logs for demo mode and tests
src/logs/apex-versions.js which Apex version a log ran, across rescans
```

## Data Export

Switch to **Data Export** in the top bar (demo: `app.html?demo=1&view=data`).

- **SOQL editor** with highlighting and suggestions that follow the clause you're in: objects after `FROM`,
  fields (and `Account.Owner.Name` relationship paths) in `SELECT` / `WHERE` / `ORDER BY`, operators after a field,
  picklist values, `true/false` and date literals after an operator. Child relationships (↳ `Contacts`) are offered in
  `SELECT`: picking one writes `(SELECT Id FROM Contacts)` and opens the child's fields, with *All fields* on top.
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

## Data Import

**Data Import** in the top bar, next to Data Export (demo: `app.html?demo=1&view=import`):

- **Paste or drop:** copy cells from Excel or Google Sheets and press Ctrl+V anywhere in the view, or drop a CSV /
  JSON file. Comma, semicolon and tab-separated text are all read, with quoted cells and line breaks inside them.
- **The object is worked out for you** from a `_` type column (`[WorkOrder]`, as Data Export and Salesforce
  Inspector copy it), JSON `attributes.type`, or the key prefix of the Ids. Otherwise you're asked for it.
- **Action:** Insert, Update, Upsert (match on Id or any external id / unique field), Delete (to the Recycle Bin) and
  Undelete. With an Id column it starts on Update, otherwise on Insert.
- **Field mapping:** each column is matched by API name, label or a loose spelling. Unknown or read-only fields are
  marked red and block the run until you type the right field or **Skip** (or *Skip all unknown fields*). A column
  like `Account.External_Id__c` or `Owner.Username` sets a lookup through the parent's field. Required fields missing
  for an insert are listed.
- **Run** in batches (1–200, default 200) with 1–10 threads (default 6), after a confirmation that names the org and
  warns on production. Deleting 50+ records, or any in production, asks you to type DELETE.
- **Every row** shows Queued / Processing / Succeeded / Failed, the new or changed record's Id (a link) or
  Salesforce's error. Filter by status, *Cancel queued*, *Retry failed*, *Re-queue all*.
- **Results out:** copy the rows shown for Excel, as CSV or JSON, or download a CSV, with `__Status`, `__Id` and
  `__Errors` columns. Filter to Failed, fix them in your sheet, paste back, run again.
- More options: blank cells clear the field (update / upsert), save despite duplicate-rule alerts, skip assignment
  rules, custom headers.
- Uses the REST sObject Collections API (allOrNone=false, so one bad row doesn't fail its batch); undelete uses the
  SOAP API. In demo mode it changes the same pretend org Data Export queries.

```
src/import/import-core.js    parsing, object detection, mapping, values, records (pure, tested)
src/import/import-backend.js REST collections + SOAP undelete
src/import/demo-import.js    demo org: required fields, restricted picklists, Recycle Bin
src/import/import-ui.js      the view
```

## FBI Search (Full-Base Inspector)

**FBI Search** in the top bar (demo: `app.html?demo=1&view=search`) answers "where does this error come from?".
Paste an error from a record page, a toast or a debug log and press Enter. It searches:

| Source | What's searched |
|---|---|
| Apex classes and triggers | every line (reuses the Code Flow download) |
| Flows and Process Builder | the active version of each flow: labels, custom errors, screen texts, formulas, field references |
| Validation rules | error message, description and formula |
| Visualforce | page and component markup |
| LWC and Aura | every source file |
| Custom labels | value and short description |

- Pasted errors are trimmed to the message: `…first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Close Reason is required: [Close_Reason__c]`
  searches for *Close Reason is required* (one click to search the full text instead).
- Results are ranked so the place a message is defined (a validation message, a flow custom error, `addError`) comes
  first; inactive rules and flows are marked and ranked lower. Options: match case, whole word, regex.
- The preview shows the item with the matches highlighted (↑ ↓ between matches) and opens it in Setup / Flow Builder.
  **Code results** (Apex, LWC, Aura, Visualforce) open in the OG Explorer viewer: colours, clickable methods (hover,
  Alt+click peek, click to open in OG Explorer), the code look (OG / Developer Console / VS Code, shared with OG
  Explorer), sticky scroll, folding, custom-label hovers and selection highlights. **Open in OG Explorer** opens the
  file at the current match.
- Sources load only when you search them. Flow versions and rule formulas take one request each, so they're cached on
  disk per org and only changes are fetched next time. **🧹 Free memory** unloads everything when you're done.

```
src/search/search-engine.js   docs, matching, ranking, error trimming, flow flattening (pure, tested)
src/search/search-sources.js  Tooling API loaders + IndexedDB cache
src/search/demo-search.js     demo sources (match the demo debug logs)
src/search/search-ui.js       the view
```

## The Informant (API client)

**The Informant** in the top bar (demo: `app.html?demo=1&view=api`) is an API client laid out like Postman:

- **Left:** Collections (new, import, filter, ⋯ menu: add request, rename, variables, authorization, duplicate,
  export, delete), Environments (plus Globals; ✓ to activate) and History.
- **Top:** request tabs (unsaved dot, middle-click to close, +) and the environment picker with a 👁 quick look.
- **Request:** method, URL with `{{variables}}` highlighted (unknown ones in red, with a warning), Send / Cancel,
  Save, Share. Tabs: Params (in sync with the URL, Bulk Edit), Authorization (inherit, none, bearer, basic, API key,
  **Salesforce session**), Headers (with the auto-generated ones), Body (none, form-data, x-www-form-urlencoded, raw
  JSON/Text/XML/HTML/JavaScript with Beautify and live JSON check) and Settings (timeout, send browser cookies).
- **Response:** status, time, size; Body (Pretty with line numbers, Raw, Preview for HTML) and Headers; copy or save.
- **Right:** Code snippet (cURL, JavaScript fetch, Python requests, Apex HttpRequest; optionally with variables filled
  in) and request info.
- **Import:** paste a cURL into the URL bar, or use Import for cURL, Postman v2.1 collections or files. **Share:**
  copy as cURL / fetch / Apex, export collections as Postman v2.1.
- Variables: environment → collection → globals, plus `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`,
  `{{$randomInt}}`, and `{{$sfInstanceUrl}}`, `{{$sfApiVersion}}` for the connected org.
- Ctrl+Enter sends, Ctrl+S saves. Everything is stored in this browser (localStorage).

### Every org you're logged into

- **Org picker (top right):** every Salesforce org this browser has a session for, plus the ones you used before,
  grouped into **families**. A family is a production org and its sandboxes (`acme.my.salesforce.com`,
  `acme--uat.sandbox.my.salesforce.com`, …). Developer, scratch and Trailhead orgs on other My Domains get their own
  family.
- **Org details:** user, org, edition, instance, API version, session status, and the **access token**: masked,
  👁 to show it, ⧉ to copy it, ↻ **Refresh token** to read it again and check it with Salesforce. *Log in ↗* opens an
  org whose session has expired.
- **Org chip in the URL bar:** shows which org the request goes to. Click it to send the same request to another org
  in the family: the host in the URL changes, the picker follows, and that org's token is used. *Send to all N orgs*
  sends it to every org in the family and shows the results side by side.
- **Pasted tokens:** a cURL with a hard-coded `Bearer 00D…` gets a banner offering your live session for that org
  instead (Authorization → *Salesforce session*).
- Not logged in, or the session expired: the response says so, with *Log in ↗* and *Refresh token and send*.
- Tokens come from the browser's own Salesforce login cookies. They're read fresh each time and **never saved**; only
  the org list (hosts, names, user names) is kept. Shared or exported requests use `{{$sfSessionId}}` in place of the
  token.

Calling a site other than Salesforce asks the browser's permission once per site (optional host permission).
Browsers don't let extensions set `Cookie`, `Host` or `Origin`; those headers are flagged and skipped (use
*Send browser cookies* instead). Pre-request / test scripts aren't supported: extensions can't run typed-in code.

```
src/informant/core.js         cURL import/export, snippets, variables, URL <-> params, Postman v2.1 (pure, tested)
src/informant/informant-ui.js the view, plus the demo server used in demo mode
src/informant/orgs.js         org families from My Domain hosts, the org/token registry (cookies), demo orgs
```

## OG Explorer

**OG Explorer** in the top bar (demo: `app.html?demo=1&view=explorer`) reads your org's code like an IDE (read-only):

- **Everything:** Apex classes and triggers, LWC, Aura, Visualforce pages and components, with Recent and a filter.
  **Ctrl+P** goes to anything: classes, components and `Class.method` (words in any order: `ddmhigh gen`).
- **Click a call to jump to it:** method calls, `new Foo()`, class names, `extends` / `implements`; an LWC's
  `@salesforce/apex/Class.method` import, `<c-child>` / `import 'c/child'`; Aura and Visualforce `controller` /
  `extensions`, `c.method`, `{!method}`. A call through an interface or virtual method asks which implementation.
  **Hover** for the signature and the first lines, **Alt+click to peek** (the method opens under the line, peeks
  can nest), **Ctrl+click** for a new tab. Calls matched by name only are marked.
- **Back / Forward** (Alt+← / Alt+→, mouse buttons) retrace every jump; the breadcrumb shows file › method.
  Tabs from the sidebar or Ctrl+P are previews (reused, italic: double-click to keep); a file you jump from stays.
- **Outline:** the file's methods, and **Called by / Calls** for the method you're in. Ctrl+F finds in the file,
  Ctrl+G goes to a line. Copy method / class, Setup ↗, the method's call tree in Code Flow, Run in OG Executor.
- **Like VS Code:** select text and every other occurrence in the file lights up (with a count; Apex ignores case).
  Fold methods, `if` / `for` / `try` blocks and multi-line tags from the arrow by the line number (⊟ / ⊞ fold or
  unfold everything); jumping into folded code opens it.
- **Code look** (top right of the editor): **OG**, **Developer Console** (white, Salesforce's colours and gutter) or
  **VS Code** (dark: bracket-pair colours, indent guides, its token colours). Only the editor changes; links, peeks,
  tabs, back / forward and the outline work the same in every look. LWC, Aura and Visualforce files are coloured too.
- **Sticky scroll** (like VS Code, on by default, switch it off in the same menu): the class, method and blocks
  you're scrolled into stay pinned at the top; each slides away as its block ends. Click a pinned line to go to it.
- **Layout:** both side panes resize (drag the edge, double-click to reset) and collapse to a slim rail (the file
  list also with Ctrl+B). The sidebar starts with every section folded so you can see what there is to explore.
- **Custom labels:** hover `System.Label.X` / `Label.X` (Apex), `@salesforce/label/c.X` (LWC), `$Label.c.X` (Aura) or
  `$Label.X` (Visualforce) to see the label's value, short description and category, with Copy value and Open in
  Setup. Works in every code view (Explorer, peeks, Code Flow, Debug Logs). Labels are read once, on the first
  hover, and again after a rescan.
- Code Flow's code panel (and its expanded view) has **Open in OG Explorer**, next to Open in Setup: the class
  opens in a new Explorer tab at the method.
- The **code panels in Code Flow and Debug Logs** have the same links: hover and Alt+click peek in place, a click
  continues in OG Explorer.
- No extra downloads: Apex from the Code Flow scan, components from the (cached) FBI Search sources. Built for
  editing later: documents carry their Tooling record and LastModifiedDate (`src/explorer/doc-store.js`).

```
src/explorer/code-links.js   which names are links, hover / click / peek (shared with Code Flow and Debug Logs)
src/explorer/code-tools.js   folding, selection highlights, indent guides, sticky scroll
src/explorer/syntax.js       colours for LWC / Aura JavaScript, CSS and markup
src/explorer/doc-store.js    the documents (and where a future save would write)
src/explorer/explorer-ui.js  the view
```

## The OG Executor (run Batch, Queueable, Schedulable and Anonymous Apex)

**The OG Executor** in the top bar (demo: `app.html?demo=1&view=exec`):

- **Async classes:** every class that implements `Database.Batchable`, `Queueable` or `Schedulable` (also through a
  parent class), found by the Code Flow scan. Filter by kind, search, see which need constructor arguments.
- **Pick one** and the Anonymous Apex that runs it is written for you:
  - **Batch:** `Database.executeBatch(new X(…), 200)`. Batch size defaults to 200 (1–2000), with a warning when the
    class makes callouts and the size is over 100.
  - **Queueable:** `System.enqueueJob(new X(…))`, optionally delayed by 1–10 minutes.
  - **Schedulable:** `System.schedule(name, cron, new X())` with cron presets, a plain-English reading of the
    expression and a job name. Or *Run execute() once now*.
  - **Constructor arguments:** pick the constructor, and each parameter gets a typed starting value you can edit.
    A `List<Opportunity>` gets `[SELECT Id FROM Opportunity LIMIT 200]`, a `Date` gets `Date.today()`.
  - The code stays editable. If you change settings after editing, you're asked before it's replaced.
- **Editor:** Apex highlighting, line numbers, auto-indent, Ctrl+/ comments, Tab indent and suggestions as you type.
  Suggestions cover `System.` / `Database.` / `Limits.` / `JSON.` members, your classes and their static methods,
  `new` + class, SObjects after `FROM`, fields of a typed SObject variable, List/Set/Map/String methods, local
  variables, and snippets (`debug`, `for`, `try`, `executebatch`, `enqueuejob`, `dryrun`, `myjobs`, `abortmine`…).
  Ctrl+Enter executes; with text selected, only the selection runs.
- **Execute** uses the Apex SOAP API's `executeAnonymous` with a debugging header (like the Developer Console), so
  the run's debug log comes back with the result. No trace flag is needed for the run itself.
  - **Result:** success, or a compile error (line and column marked in the editor, with *Go to line*), or an
    exception with its stack trace.
  - **Debug output:** the `System.debug` lines, with JSON pretty-printed and a filter.
  - **Jobs:** live status every 3 s (Queued → Preparing → Processing → Completed / Failed / Aborted), batch progress
    and failed batches, the error, start/finish times, *Abort*, and for schedules the next run and *Unschedule*.
    Job ids come from `OG_JOB_ID` lines and from your new `AsyncApexJob` records, so jobs started by hand-written
    code are tracked too.
  - **Logs:** this run's log plus the logs your jobs write. Open any of them in Debug Logs (execution path, queries,
    limits…). Async jobs only write logs while you're traced: *Trace me for 1 hour* sets a USER_DEBUG trace flag.
- **History:** your last 40 runs; click one to load its code again. The editor's draft is kept.
- Needs the *Author Apex* permission (as the Developer Console does).

```
src/exec/exec-core.js     detection, constructor params, default values, code generation, cron, SOAP (pure, tested)
src/exec/apex-complete.js suggestions while typing Anonymous Apex (pure, tested)
src/exec/exec-backend.js  executeAnonymous (SOAP), AsyncApexJob / CronTrigger / ApexLog, trace flag
src/exec/demo-exec.js     a pretend org for demo mode: compile errors, exceptions, jobs that progress and fail
src/exec/exec-ui.js       the view
```

## On Salesforce pages: the OG panel and All data

A slim OG handle sits on the right edge of Lightning / Setup pages (drag it up or down; it remembers where).
Click it to slide out the panel:

- **Record**: the record on the page (name, object, id, dates) and **Show all data**. On other pages, paste an id.
  **⟳ Empty cache & hard reload** (on every page): deployed an LWC change but still see the old one? One click
  empties this org's browser cache (Lightning, My Domain, Setup, Visualforce, files) and reloads skipping the cache,
  like DevTools' *Empty cache and hard reload*. Cookies are kept, so you stay logged in. *Deep clean* also clears the
  org's IndexedDB, where Lightning keeps component definitions. After the reload the edge handle shows ✓ Fresh page.
  Uses the `browsingData` permission.
- **Users**: you, plus search by name, username, email or alias. Per user: *Login as* (this tab), *Login in Incognito*
  (a private window; you stay logged in as yourself here), *Details* (the user in Setup), *PSet* / *PSetG* with counts,
  and ▾ to list the assigned permission sets and groups.
- **Tools**: open Code Flow, Debug Logs or Data Export for this org.

**All data** (`record.html?host=…&id=…`) lists every field: API name, label, type (length, precision, required,
formula, restricted…) and value. Filter by any of them (`/` focuses the filter). Double-click a value to edit it
(Enter keeps it, Esc undoes), or **Edit** to edit everything; changes collect in a save bar (Ctrl+S). Lookups open the
related record. **Clone**, **Delete** and **Export** (JSON, CSV, Excel, download) are in the header.

Login in Incognito needs *Allow in Incognito* turned on for the extension (the panel links to the setting). Login as
needs the org to allow admins to log in as users.

```
content.js                  the edge handle + panel frame (closed shadow root)
panel.html, src/panel/      the panel
record.html, src/record/    All data, the record backend (REST + demo), Salesforce URL helpers
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
