# 5. Features by area

Each area has one service file. Routes are grouped by area in `src/app.js`. The README's "API quick reference"
lists every URL.

## Books (`ledgerService.js`, `reportService.js`, `src/core/ledger.js`, `src/core/reports.js`)
Companies, chart of accounts (types and subtypes decide where an account appears on the statements), journal entries
(simple and advanced), reversing, recurring entries, closing periods, statements with comparisons, CSV export.

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
  `send_to`, `client_ref` (claim/job number), set at save like every document field. A typed invoice number already in
  use becomes the next lettered one (`nextLetteredNumber`: 2601 → 2601A … Z, AA …), returned as `numberWasTaken`; an
  automatic number never gets a letter. The ✉ Email button is a `mailto:` link built in the browser.
- Payment photos (migration 021, `src/services/paymentPhotoService.js`): `payment_photos` (bytea ≤ 3 MB, JPEG/PNG,
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
  - Billed time can't be changed, deleted or sent back (`zacc_time_billed_final`, and the service says which invoice);
    a bill with a billed cost can't be voided or edited (`zacc_bill_cost_billed`) until that invoice is.

## Banking (`bankService.js`, `src/core/bankImport.js`)
CSV and OFX/QFX statements. Repeated lines are skipped by a fingerprint. Rules suggest an account. Each bank line
is posted, matched to an existing entry, or excluded. Reconciliation ticks lines until the difference is $0.00,
then locks them. Plaid feeds wait for Homer's keys.

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
