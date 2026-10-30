# 5. Features by area

Each area has one service file. Routes are grouped by area in `src/app.js`. The README's "API quick reference"
lists every URL.

## Books (`ledgerService.js`, `reportService.js`, `src/core/ledger.js`, `src/core/reports.js`)
Companies, chart of accounts (types and subtypes decide where an account appears on the statements), journal entries
(simple and advanced), reversing, recurring entries, closing periods, statements with comparisons, CSV export.

## Home cards and Statistics (`homeLayoutService.js`, `reportService.getStatistics`, migration 029)
The card catalog is `HOME_CARDS` in `public/app.js` (id, icon, title, permissions, plan feature, and `go`: a tab plus
an optional method to run there, or `before`, run first, which can return false to stay put: the Credit cards card picks the card account that way). The server stores only each person's `{ left, right }` id lists (`home_layouts`,
RLS on company *and* user; route permission `member`) and checks their shape; the browser skips unknown ids and cards
the role can't use. `GET /reports/statistics` (view_books): 12 calendar months ending with `asOf` (income = revenue
credits − debits, expenses = expense debits − credits, cash = running balance of `cash_flow = 'cash'` accounts), the
six largest expense accounts this fiscal year, and receivable/payable totals and past-due parts from `getAging`.
Charts are plain HTML bars sized with `:style` (CSSOM, allowed by the CSP); series colors `--series-1/2` were checked
with the dataviz palette validator in light and dark.

## Importing books (`importService.js`, `src/core/bookImport.js`, `src/core/xlsx.js`)
Chart of accounts, opening balances and journals from CSV, Excel or a QuickBooks IIF file. `preview` checks
everything and saves nothing. An import is one batch, and the whole batch can be undone.

## New-company setup wizard (`ledgerService.updateSetup` / `setupStatus`, migration 017)
`companies.entity_type` (individual, sole_proprietor, single_member_llc, partnership, s_corp, c_corp; labels and tax
forms in `src/core/entityTypes.js`), `books_start_date`, and `setup_done` (false for new companies; the migration set
older ones true). `GET …/setup` returns counts-based steps (basics, books = any entry, bank = any entry on a
bank/cash/card account, invoicing = letterhead or logo or a saved rate, people = more than one member). `PUT …/setup`
(admin) changes the three fields. The wizard is the `setup` tab in `public/index.html`; imports reuse the Accounts
importer with `setup.fromImport` showing a back link. Opening balances are simple entries against Owner's Capital
(3000) dated the day before the books start, with an idempotency key per account.

## Back up your books (`backupService.js`)
Settings → Back up your books downloads two CSVs in exactly our import templates' layout: the chart of accounts
and every journal line (Entry, Date, Memo, Account, Debit, Credit, Source). Importing them into a new company
(accounts first, then journal) rebuilds the same trial balance; `api.db.test.js` proves it. Documents (invoice
lines, customers, employees, timesheets) and line memos are not in it. Alpha users are told to keep their own.

**The book file (`.zacc`, `bookFileService.js`, `GET …/book-file`, permission `admin`):** a .zip (`src/core/zip.js`
writes it; `unzip` in `xlsx.js` reads it) with `README.txt`, `manifest.json` (format `zacc`, version 1, company, time,
each file's bytes, rows and SHA-256), `import/` (the two CSVs above), `tables/<table>.csv` for **every table with a
`company_id` column** (found from `information_schema`, so new tables are included automatically; `SKIP_TABLES`
and `SKIP_COLUMNS` keep out road keys, feedback, plans, `ssn_enc` and other secrets) and `pictures/` (bytea columns,
named in their rows). Text starting with = + - @ gets a leading ' (CSV formula guard), as the manifest notes.
Re-importing a whole .zacc is not built yet; the `import/` CSVs rebuild the books today.

**QuickBooks (`GET …/export/quickbooks-desktop` .iif, `…/quickbooks-online` .csv, permission `view_books`):** every
journal line; account names are "code name" (31 characters, ':' replaced, since QuickBooks reads it as a sub-account);
IIF account types from type/subtype (`IIF_TYPE`); the customer or vendor name is filled from the invoice, bill or
payment that made the entry, which QuickBooks Online needs on A/R and A/P lines.

## Sales and bills (`arapService.js`, `invoiceSetupService.js`)
- Customers and vendors are `contacts` (`kind`). Invoices and bills are `documents` with `document_lines`.
- Saving a document posts one journal entry: invoice = Dr Accounts Receivable, Cr income per line, Cr Sales Tax
  Payable. Bill = Dr expense per line, Cr Accounts Payable. Payments are `payments` plus `payment_applications`.
- Open balance = total − posted payments, so the aging reports always add up to the control accounts.
- Documents are never edited: they are voided (entry reversed) and entered again. **Edit** (`PUT …/documents/:id`,
  `PUT …/payments/:id`, permission `post`) does both in one transaction: `replaceDocument` / `replacePayment` void the
  old record with `replaced_by_id` set to the new id, then post the copy (an invoice keeps its number; the number index
  skips replaced invoices). Migration 020.
- Divisions and adjusters (migration 022): `contacts.group_name` ("Part of"; `getAging` returns `groups` totals) and
  `contacts.people` (jsonb `[{name,email,phone}]`, ≤ 50, checked by `cleanPeople`). Invoices carry `attention`,
  `send_to`, `client_ref` (claim/job number), `care_of` (an attorney's client: Bill To reads "client c/o contact"; migration 032), set at save like every document field. A typed invoice number already in
  use becomes the next lettered one (`nextLetteredNumber`: 2601 → 2601A … Z, AA …), returned as `numberWasTaken`; an
  automatic number never gets a letter. The ✉ Email button is a `mailto:` link built in the browser.
- Payment plans (migration 036, `src/core/paymentPlan.js`, Homer 2026-10-29): `documents.plan_count` (2-60) and
  `plan_first_due` on an invoice. `planSchedule` splits the total evenly (odd cents one each to the first payments),
  monthly from the first due date (31st → month end); `planStatus` applies what was paid earliest-first and gives
  `pastDueCents`, `next` and the unpaid `pieces`. `docOut.status` is overdue only when a plan payment is past its date;
  `listContacts` overdue and `getAging` (each piece in its own bucket; CSV row spreads with `byBucket`) follow. A plan
  sets `due_date` to the last payment. It can be added, changed or removed with PATCH (`updateDocumentDetails`): it
  moves no money. Sales → Payment plans (`ar.panel = 'plans'`) and the Home card `plans` (`loadHomePlans`) filter open
  invoices with `plan`; Statement prints `getDocument`'s payments and schedule; `payPlan` pre-fills the next payment.
  A plan invoice never gets late charges.
- Late charges (migration 037, `src/core/lateCharges.js` pure, `src/services/lateChargeService.js`, Homer 2026-10-29):
  company `late_apr` (percent text, ≤ 36% typo guard), `late_fee_cents`, `late_grace_days` (30), `late_holiday_grace_days`
  (60: a homeowner's invoice due in Nov/Dec); contact `is_homeowner`, `no_late_charges`; invoice `no_late_charges`
  (create, PUT, PATCH) and `late_charge_month` ('YYYY-MM', set only by the run). `chargesFor` takes invoices past
  `graceEnds` (not plans, not exempt, not late-charge invoices), interest = one month of simple interest on the total,
  `balance × ppm ÷ 12,000,000` half-up, plus the fee once per customer. Routes: GET/PUT `late-charges/settings`
  (PUT admin), GET `late-charges/preview?asOf=` and POST `late-charges` ('invoices'). The run posts one ordinary invoice
  per customer through `createDocument` (lines on the `late_charges` system account, created as 4910 "Late Charges &
  Finance Charges" the first time); the unique index `documents_late_charge_once` stops a second one in a month, a
  void frees it, and `replaceDocument` carries `late_charge_month` to the corrected copy. UI: Settings → Late charges,
  Sales → Late charges (`ar.panel = 'late'`), customer checkboxes, the invoice's "No late charges" box.
- Payment photos (migration 021, `src/services/paymentPhotoService.js`): `payment_photos` (bytea ≤ 3 MB, JPEG/PNG, or a
  PDF since migration 035 such as the bank's deposit confirmation, sent unshrunk as `data:application/pdf`, checked for `%PDF-`;
  6 per payment), routes `…/payments/:id/photos[/:photoId]` (add/remove: the side's permission; view: view_books or the
  side). The browser shrinks each photo to 2000 px (`pictureFromFile`); the form's file inputs use
  `capture="environment"` so an iPhone opens its camera. Edit copies the photos to the corrected payment. ⚠️ A check
  photo carries bank numbers: audit entries record only the photo id and size.
- **Professional-services invoices (migration 016):**
  - `invoice_items` holds saved rates. Kind `service` is hours × rate; kind `expense` is a cost passed on, usually
    quantity 1 and untaxed. A rate with no price means "type it on the invoice".
  - Quantity may be a share `"1/N"` (an expense split across N jobs, Homer 2026-10-24): `lineAmount` divides the
    price by N exactly and rounds once, half-up. The invoice's *Jobs sharing these expenses* box writes `1/N` on
    every expense-kind line except ones whose quantity the user typed (`qtyTyped`). Each invoice rounds on its own,
    so three thirds of $350.00 bill $116.67 each ($350.01 in all).
  - Picking a rate fills the line; the line keeps its own copy of the numbers, so changing a rate later never
    changes old invoices.
  - Lines have `service_date` and `item_id`. Invoices have `project` (name and site address).
  - The company has a letterhead (`invoice_address`, `invoice_note` for the tax ID and firm number,
    `invoice_footer`), a logo in `company_logos` (≤1 MB PNG/JPEG, checked by its first bytes), and
    `default_sales_tax_rate`, which fills new invoices.
  - Sales tax = rate × the sum of taxable lines, rounded once (not per line). Zero to 20%.
- **Projects and billing time and costs (migration 023, `src/services/projectService.js`, `src/core/projects.js`):**
  - A project is a `jobs` row (the timesheet jobs), now with a site `address`. `/jobs` is no longer gated by the
    Timesheets plan feature, and `invoices` may add projects. `POST …/jobs/import` adds projects from pasted folder
    names (`parseProjectList`: last path part, leading number = `code`, whole folder name = `name`; preview first).
  - A bill line can carry `job_id` and `billable` ("bill to client"). An invoice carries `job_id`; an invoice line
    carries `time_entry_id` or `billed_line_id` (the bill line it passes on).
  - `GET …/unbilled?jobId=|customerId=&from&to` (permission `invoices`) lists billable, non-rejected time and billable
    lines of posted bills that no posted invoice line points at. Hours become a quantity with `minutesToQuantity`
    (4 decimals, half-up: 50 min → 0.8333).
  - Billed once: `cleanLines` checks first (clear message); trigger `zacc_bill_once` is the backstop, with an advisory
    lock on the source so two invoices saved together take turns. Voiding the invoice frees the source; Edit's copy
    carries the same links (the old invoice is voided first in the same transaction).
  - **Trips (migration 024, `src/services/tripService.js`, Trips tab, permission `bills`; edit/void `post`):** a trip
    lists projects with a share in hundredths of a percent (`share_bp`, total ≤ 100%; the rest is not billed). A trip
    cost posts its own entry (source `trip`: Dr expense, Cr bank / credit card / owner equity "paid personally") and is
    edited by void + corrected copy (`replaced_by_id`, photos copied). Kinds: airfare, rental car, lodging, meals,
    tolls, mileage, other; mileage = miles × a typed rate per mile (`mileageAmount`, never a built-in IRS number).
    Travel time is a time entry with `trip_id` (no job). `listUnbilled` returns `tripCosts` (quantity = share,
    `bpToQuantity`: 80% → 0.8, × the full cost) and trip time rows (hours × share, `sharedHoursQuantity`). Those invoice
    lines carry `job_id`; billed once per (source, project). Typing another quantity on the invoice overrides a share.
  - **Road page (migration 026, `src/services/roadService.js`, `public/road.html` + `road.js` + `road-sw.js`):** the phone
    keeps items in IndexedDB and sends them with its road key (see Security); each item and photo has the phone's own
    `client_id`, so a resend changes nothing. A service worker keeps a copy of the page for no-signal starts (network
    first). Trips → From the road accepts an item in one transaction: a trip (new project numbers become jobs unless a
    job with that name or number exists; even shares via `evenShares`), a cost (`addTripCost` with idempotency key
    `road-<item id>`, photos copied), or travel time (a time entry for the sender). QR codes come from
    `qrcode-generator` on the server (SVG). A **check** item (migration 033: date, from, amount, check number, typed
    invoice numbers, photos) shows on Sales instead; `listRoadItems` matches the typed numbers to unpaid invoices.
    The desk records it through the normal Receive payment form, then `POST …/road-items/:id/accept-check
    { paymentId }` (`invoices`) links it (`road_items.payment_id`) and copies its photos to `payment_photos`.
    Changing a sent item: `PUT /api/road/items/:clientId { data }` (`editItem`) re-checks the data like a new item
    and replaces `road_items.data`, only while `status = 'pending'`; the phone marks the item `edited` and sends the
    change on its next sync. Accepted items are fixed at the desk (`PATCH …/trips/:tripId/travel-time/:timeEntryId`
    = `updateTravelTime`, or a trip cost's void + copy).
    At the desk (Homer, 2026-10-30): `PATCH …/road-items/:id { data }` (`editRoadItem`) and `accept { data }` re-check
    desk changes through `deskData` → `cleanItem` (the trip and kind stay; amounts typed in dollars, time as h:mm);
    `POST …/road-items/accept-all { itemIds, expenseAccountId, paidFromAccountId }` (`acceptRoadItems`) accepts several
    in one transaction, trips first, and refuses if any is no longer pending; `paidFrom: { itemId: accountId }` puts
    single costs on another card (the browser's `roadCard`: the row's pick, else `zacc.cardByKind` in localStorage,
    else Paid with). The trip's project card searches `ar.jobs` by code, name or customer (`tripJobMatches`), adds the
    ticked ones or a new job (`POST …/jobs`) and PATCHes the trip with even shares across all (`addTripJobs`). The Trips tab has a trip pull-down
    (`pickTrip`, newest first) and one Entries grid per trip (`tripGrid`: costs, travel time and the trip's pending
    road items, by date; View | Edit | Delete; a road item's Edit fills the cost or travel form and "Save to books"
    accepts it with the changes).
  - **MileIQ import (migration 028, `src/core/mileiq.js` reader, `src/services/mileIqService.js`):** the CSV is laid out
    like a spreadsheet (rates row, a SUMMARY of `=SUMIFS` formulas, then DETAILED LOG); the reader finds the log's
    header, reads only typed cells and works the dollars out itself. A drive's `key` is a SHA-256 of when, where, miles
    and vehicle; `mileage_drives` keeps each imported drive, and a key counts as imported while its trip cost is posted
    or was edited. Import groups drives per (trip, day, rate) into one `addTripCost` mileage cost whose amount is the
    sum of each drive rounded (server-only `mileageCents` option, so the books tie out to MileIQ's report); tolls and
    parking post as their own costs. Drives with trip `new` go on one new trip spanning their dates.
  - Billed time can't be changed, deleted or sent back (`zacc_time_billed_final`, and the service says which invoice);
    a bill with a billed cost can't be voided or edited (`zacc_bill_cost_billed`) until that invoice is.

## Old invoices from a PDF (`oldInvoiceService.js`, `src/core/oldInvoice.js`)
- `POST /companies/:id/invoices/read-pdf` (`invoices`) takes `{ pdf: base64 }` (4 MB) and saves nothing. pdf.js
  (`pdfjs-dist`, legacy build, eval off; `src/services/pdfText.js`) gives positioned words; `rowsFromItems`
  (`src/core/pdfRows.js`) rebuilds rows and cells by y/x;
  `parseOldInvoice` reads Homer's Excel layout (INVOICE # / DATE, BILL TO with "X C/o Y", TERMS, Description block
  minus TAX ID / TX Firm, the Hours…Subtotal rows, Tax Rate, TOTAL DUE) and lists `problems`.
- `invoiceLine` keeps hours × rate when it rounds to the printed subtotal, else 1 × subtotal (hours in the text), so
  the total always ties. The browser fills the New invoice form (`readOldInvoice` in `public/app.js`); Save posts it
  through the normal create route. The PDF is never stored, logged or audited (it names a client).

## Banking (`bankService.js`, `src/core/bankImport.js`)
CSV, OFX/QFX and PDF statements. Repeated lines are skipped by a fingerprint. Rules suggest an account. Each bank line
is posted, matched to an existing entry, or excluded. Reconciliation ticks lines until the difference is $0.00,
then locks them. Plaid feeds wait for Homer's keys.
- **Same payee** (`public/payee.js`, Homer 2026-10-26): `payeeKey` drops words with a digit (card date, 16-18
  character transaction code, store and phone numbers), words of 16+ letters and noise words (SQ, POS, DEBIT…), and
  keeps the first two words. Choosing an account on a review line fills it into the other waiting lines with the same
  key and direction that have nothing chosen (`bank.sameAs` marks them). "Add all … chosen" posts them one by one
  through the normal post route; "always use this for …" creates a rule with `payeeRuleText`.
- **PDF statements** (`src/core/bankPdf.js`, migration 034 `source = 'pdf'`): the import route takes `{ pdf: base64 }`
  (8 MB, 60 pages, JSON limit 12 MB) instead of `content`. `readPdfStatement(rows, { creditCard })` finds the
  statement period (gives the year for "10/03" rows; a December row on a January statement is last year's), the
  beginning/ending balances, and rows that start with a date and end with an amount; a line just under a row with no
  amount continues its description. Direction, in order: a printed sign (on a card statement minus = payment = in),
  the in/out column it sits under, the running balance's change, the section heading (Deposits in; Checks, Withdrawals,
  Fees, Purchases out; "Daily balance" skipped). A row still undecided stops the import (never guessed). The preview
  returns `beginCents`, `endCents` and `problems` (e.g. beginning + rows ≠ ending). Tests: `test/bankPdf.unit.test.js`
  with made-up statements in each layout; `test/tinyPdf.js` writes real PDFs for tests.

## Payroll (`payrollService.js`, `src/payroll/engine.js`, `src/payroll/tables/2026.json`)
- `calculatePaycheck` is pure: wages, pre-tax deductions, federal (2020+ W-4 and older forms), FICA, state income
  tax (CA DE 4, CO, DC), state unemployment, CO FAMLI, CA SDI, FUTA with credit reduction. Every number comes from the
  tables file, which records sources.
- Paychecks and payroll runs post journal entries. Voiding goes newest-first and returns paid timesheet hours.
- Liabilities are grouped by agency and form. Deposits pay what is still owed for a period.
- **Calculate-only mode:** while any table block a run uses is `verified: false`, the company only calculates and
  records. Homer pays and files. The Professional Review Board sets `verified: true`.

## Timesheets (`timesheetService.js`, `src/core/timesheets.js`)
Time entries are whole minutes. A shift past midnight belongs to the day it started. Entries go draft → submitted →
approved (or sent back). Department approvers see their department; nobody but the owner approves their own time.
Overtime is federal 40 h/week plus California's daily and 7th-day rules. The HoursTracker CSV import skips rows
already imported. Approved hours feed a payroll run and are then locked as paid.

## People and roles (`accessService.js`)
Members, built-in and custom roles, departments. See chapter 3.

## Beta feedback and the Developer dashboard (`feedbackService.js`, `public/feedback.js`)
The browser keeps the last 20 clicks (button labels only, never typed text) and the last 20 errors in memory. A
report is sent only when the tester presses Send, with an optional JPEG of the screen (html-to-image) or a photo.
Developers triage reports, edit a Claude-ready write-up (the reporter's name and email are left out), see the last
100 server errors, and download a database backup (`src/jobs/backup.js`, pg_dump).

## Tax-ready level 1 (`taxService.js`, `src/core/taxLines.js`, migration 018; plan feature `tax`)
Accounts get a tax CATEGORY (`account_tax_categories`; no row = `suggestCategory`, shown as suggested), and each form
(`TAX_FORMS`: Schedule C, 1065, 1120-S, 1120) places a category on a line or names where it goes instead
(`placeOf`). The form comes from `companies.entity_type` (`FORM_FOR_ENTITY`; individual = none). `taxSummary` is
pure and tested with hand totals. Line numbers are from the IRS 2025 instructions, `verified: false`.
`get1099Totals`: posted payments made, by payment date, card payments (method card or a credit-card account) left
out; threshold by year in `NEC_THRESHOLD`. `getW2Totals`: sums each paycheck's stored calculation (void rows are
negative). Routes: `GET/PUT tax-categories`, `reports/tax-summary|tax-1099|tax-w2` (CSV via `report()`).

## Plans and the Admin dashboard (`planService.js`, `src/core/plans.js`)
See chapter 3. Prices stay `null` until Homer sets them. Stripe comes in December 2026.

## Renaming an account (`ledgerService.renameAccount`)
`PUT /companies/:companyId/accounts/:accountId/name` (permission `accounts`) changes only `accounts.name` (the runtime
role has `UPDATE (name)` on `accounts`, nothing else). Number, type, kind and cash-flow section never change once
created, so reports can't shift underneath posted entries. Audited as `rename` with the old and new names.

## Edit rules after the CPA sweep (`docs/board/edit-sweep.md`)
Where people expect an edit, and how each kind of record allows it, follow the CPA sweep. Posted history is corrected by
reversal or void + corrected copy, master data is edited in place with an audit entry. Any reversal or void of an entry calls
`ledgerService.assertNotCleared`: it refuses an entry with a line ticked in a reconciliation, or one a bank transaction is
posted or matched to (Banking's Undo passes `bankLineOk`). `reverseEntry` calls it; paycheck and deposit voids call it
directly. A trip project that has billed keeps its share (`tripService.updateTrip`).

Batch 2 (master data, all audited from/to, all through column grants in `src/db/grant.js`):
- `ledgerService.updateCompanyProfile` (`PATCH …/profile`, admin): name; home state refused once any paycheck exists;
  fiscal-year start refused while `locked_through` is set.
- `ledgerService.updateAccount` (`PATCH …/accounts/:id`, accounts): `subtype` within the type, never on system accounts,
  never from bank-like to not once bank lines or reconciliations exist; `isActive: false` needs a $0 balance and no
  bank rule, recurring entry (`lines @>` the account id) or invoice item using it. No hard delete, by design.
- `ledgerService.updateRecurring` (`PUT …/recurring/:id`, post): name, memo, lines, end date, `restart`. Start date and
  frequency are fixed, so `next_date` is recomputed with `nextOccurrence(…, posted_count)`; nothing posted changes.
- `bankService.updateRule` (`PUT …/bank-rules/:id`, post): same checks as `createRule`.
Batch 3 (employees, migration 030):
- Each paycheck's `calculation` carries `employee` (name, SSN last 4, work state, pay type, frequency, address) and
  `employer` (name, state), copied in `compute()` and onto void records. Stubs, the paycheck list, runs and the payroll
  register read the name from there (`PC_NAME`, falling back to `employees` for older paychecks); liabilities take the
  state from `calculation.state`. The W-2 deliberately uses the current name and address.
- `payrollService.updateEmployee` (`PUT …/employees/:id`, payroll): partial; same checks as create (`checkEmployee`);
  audit shows from/to for name, state, frequency, pay type, rate and hire date, only "changed" for W-4, state forms,
  address and SSN.
- `setEmployeeStatus` (`POST …/terminate` / `…/rehire`, payroll): last day / new start date; `active` drives payroll
  runs and timesheets.
Batch 4 (ledger corrections, migration 031):
- `ledgerService.correctEntry` (`PUT …/entries/:id`, post): reverse + corrected entry in one transaction, for
  `CORRECTABLE` sources (manual, simple, recurring, import); the idempotency key belongs to the corrected entry.
- `arapService.updateDocumentDetails` (`PATCH …/documents/:id`, invoices/bills): memo, due date, client ref, project,
  attention, send-to, in place (column grants), even when paid; amounts still only by void + copy.
- `payrollService.voidRun` (`POST …/payroll-runs/:id/void`, payroll): voids each paycheck (`voidPaycheck`), then sets
  the run's void columns; trigger `zacc_run_void_once` allows only that, once; `payroll_runs_period` is unique only
  among runs not voided.
- `bankService.reopenReconciliation` (`POST …/reconciliations/:id/reopen`, close): latest only, open period only,
  reason audited; `zacc_recon_final` now allows completed → open for the latest and also returns OLD on DELETE (it
  returned NULL, so Cancel never deleted an open reconciliation: B7).
- `bankService.listImports` / `undoImport` (`GET …/bank-accounts/:id/imports`, `POST …/bank-imports/:batch/undo`):
  deletes the batch's lines still in review or excluded.
Batch 5 (your own sign-in): `authService.changePassword` (`POST /api/auth/password`: current password + TOTP code,
then every other session of that user is deleted) and `updateMyName` (`PATCH /api/auth/me`). Email change and
"forgot password" wait for outgoing email: an unconfirmed email change would let someone claim an address an owner
later adds as a member, or one listed in `ADMIN_EMAILS` / `DEVELOPER_EMAILS`.
Tests: `test/edits.db.test.js` (HTTP, restricted runtime role).

