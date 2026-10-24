# zAccountant — notes for Claude sessions

Project memory lives here (Claude memory is off for this project). Keep it short and current.

**Keeping this file small (Homer's standing rule).** This file loads into every session, so its size is a cost
paid on every turn. When it passes about **120 lines**, split it, in the same PR as the change that grew it:
- Notes about one part of the code go into a `CLAUDE.md` in that folder (`src/payroll/CLAUDE.md`,
  `public/CLAUDE.md`, `src/db/CLAUDE.md`…). Claude Code loads a folder's file only when working there.
- Reference detail that's rarely needed (history, finished decisions, long how-tos) goes into `docs/claude/<topic>.md`;
  leave a one-line pointer here saying when to read it.
- This top file keeps only what every session needs: the person, dates, authority, open items, the core rules.
- Prune as well as split: delete notes that are done or no longer true.

## The person
- **Homer** (GitHub `iamHParker`): structural engineer (geotechnical minor); programs in Fortran, VB, C/C++,
  assembler, Xojo. New to JavaScript and web development: explain plainly, use engineering analogies,
  never assume web jargon is known.

## The product
- Small-business accounting + payroll, built from Homer's master spec (`docs/spec/`).
- Stack: Node 22 / Express, PostgreSQL 16, Vue 3 in the browser with **no build step**, hosted on **Railway**.
- Markets: **TX, CO, CA, DC**. Time zone: **Central (CT)**. Accounting accuracy first; friendly UI second.

## Dates
- **Private alpha: Dec 1, 2026.** Until then Claude may open PRs to `main` and merge its own once CI is green
  (Homer: "Till alpha you have authority to pr to main"). After Dec 1, ask before merging.
- **Board Review #2: Dec 6, 2026** (Professional Review Board walkthrough; Review #1 is `docs/board/review-1.md`).
- **Railway setup instructions for Homer: around Nov 15, 2026.** Homer does the Railway account steps himself.
- **Public launch: Jan 1, 2027.** 2027 payroll tax tables go in during December 2026.
- **Plaid** bank feeds wait until Homer has Plaid keys.

## Decisions Homer made
- Roles, departments, permission checkboxes, timesheets (with HoursTracker CSV import feeding payroll): **all
  before launch** (done: PRs #8, #9).
- Payroll and report polish slid about a week to make room for that.
- 2026-10-24: stay on Railway **Hobby** while beta testers debug (Pro later; Homer has two more projects to follow).
  Beta testers pay nothing and get every feature, even with their real books. Plans are switched **by hand** in the
  Admin dashboard for now; **Stripe** goes in during December, before launch.

## Open items
- DC $4,150 per-allowance withholding amount: no official 2026 source (latest FR-230 is 2018). Needs DC OTR
  confirmation before the Board certifies DC.
- **Production has no backups yet** (Railway Hobby plan can't schedule them). Homer decides by mid-Nov: upgrade
  to Pro, or Claude builds a nightly pg_dump to outside storage. Must be in place, with a restore drill, before alpha.
- Invoice queue item 6: split travel costs (motel, rental car, airfare) across 2+ jobs, each invoice getting a share.
  Homer's sample (a 2025 Excel invoice) had no split, so ask him how he divides them (equal shares or percents).
- All tax-table blocks are `verified: false` until the Board certifies them; companies run in calculate-only mode.

## How the code is built (rules to keep)
- Money is **integer cents**; rounding is half-up with BigInt (`src/core/money.js`). Hours are whole minutes.
- Double-entry ledger enforced by the database (deferred balance trigger), append-only history, period lock,
  HMAC audit chain. AR/AP control accounts accept only document postings.
- Row-level security via `withScope`; the runtime DB role gets column-level grants (`src/db/grant.js`) — add a
  grant for every new table/column the app writes.
- Every API route names a permission (`src/core/permissions.js`); the UI hides what a role can't use, but the
  server is the gatekeeper.
- Payroll engine is pure (`src/payroll/engine.js`); tax values are data in `src/payroll/tables/<year>.json`
  with sources recorded. Tests show hand-worked arithmetic in comments.
- New schema = new numbered file in `src/db/migrations/`.
- Reports: a route built with `report(permission, title, load, rowsFor)` in `src/app.js` answers JSON, or a CSV
  download with `?format=csv` (row builders in `src/core/csv.js`). PDFs come from the browser's print window;
  `printPage` prints only the card holding the button (or the section's `.print-me` card).

- Railway: live at `zaccountant-production.up.railway.app` (Homer's owner account set up 2026-10-24); first-time setup steps in `docs/runbooks/railway-setup.md`; the server creates its restricted DB login
  from `DATABASE_URL` at start-up (`ensureRuntimeRole`).
- Beta feedback + Developer dashboard (modelled on wri-eng's Report a problem): `public/feedback.js` (recorder, pictures),
  `src/services/feedbackService.js`, table `feedback_reports` (RLS: sender or platform developer). Platform roles come only
  from `DEVELOPER_EMAILS` / `ADMIN_EMAILS` (`src/core/platform.js`). Never log a report's note or picture.
- Plans (Admin dashboard): catalog + path gates in `src/core/plans.js`, `src/services/planService.js`, tables
  `company_plans` / `plan_changes` (migration 015). `route()` refuses a gated path with 402. No row = Beta tester (all on).
  Prices are null until Homer sets them; don't invent prices.
- Invoices for professional services (migration 016, `src/services/invoiceSetupService.js`): saved rates/items
  (`invoice_items`, kind service = hours × rate, expense = cost passed on), line `service_date`/`item_id`, invoice
  `project` block, letterhead (address, note with tax ID + TX firm number, closing line), logo in `company_logos`,
  pinned `default_sales_tax_rate`. Layout follows Homer's Excel invoice: Hours, Date, Task, Rate, T, Subtotal.
- Ops: request logs/metrics in `src/metrics.js`; restore drill and load test in `src/jobs/`; how to run them and
  the results log: `docs/runbooks/operations.md`.

## Working here
- Tests: `npm test` (needs `DATABASE_URL`, e.g. `postgres://zacc:zacc@localhost:5432/zacc_dev`); each DB test
  file makes its own throwaway database. `npm run test:unit` needs no database.
- Run locally: `npm run migrate`, then `node src/server.js` (`NIGHTLY_JOB=off` to skip the nightly job).
- Browser checks with Playwright before UI PRs; the inline-style CSP means use classes in `public/styles.css`.
- PR bodies start with the claude-projects attribution comment for `iamHParker`; assign PRs to `iamHParker`.
