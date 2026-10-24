# zAccountant

Small-business accounting and payroll for Texas, Colorado, California and Washington DC —
**double-entry books that cannot silently go out of balance**, with payroll tax logic reviewed by a
Professional Review Board.

Status: **Sprint 6 (payroll runs, pay stubs, roles and timesheets)** — see [docs/spec/21-implementation-roadmap.md](docs/spec/21-implementation-roadmap.md).
Target: public beta January 1, 2027.

## What's here

| Folder | What it is | Engineering analogy |
|---|---|---|
| `src/core/` | Pure accounting math: money, ledger rules, financial statements | the design equations — no I/O, fully unit-tested |
| `src/payroll/` | Gross-to-net payroll engine + yearly tax tables (`tables/2026.json`) | engine = analysis method, tables = code-book values (data, not code) |
| `src/db/migrations/` | PostgreSQL schema. The database itself refuses unbalanced or edited entries | the "as-built" structure with its own redundancy |
| `src/services/` | Glue between the math and the database | — |
| `src/app.js` | Web API (URLs the browser calls) | — |
| `public/` | The browser screens (Vue 3, no build step) | — |
| `test/` | Automated tests (`*.unit.test.js` need nothing; `*.db.test.js` need PostgreSQL) | load tests / check calcs |
| `docs/spec/` | Spec sections 14, 18, 21 | — |
| `docs/board/` | Professional Review Board reports | peer review / stamped calcs |

## Ground rules baked into the code

1. **Money is integer cents**, never floating point. Rates are integer parts-per-million. Rounding is half-up, once.
2. **Every entry balances** — checked in JavaScript *and* by a PostgreSQL trigger at commit.
3. **History is append-only.** Mistakes are fixed with reversing entries; the database blocks UPDATE/DELETE.
4. **Closed periods are locked** in the database.
5. **Audit trail is hash-chained** (keyed HMAC-SHA-256), so tampering is detectable (`npm run verify:books`).
6. **Tax tables are versioned data marked `verified:false`** until the Review Board certifies them; until then
   payroll runs in *calculate-only* mode.
7. **Two-step sign-in is mandatory.** Nobody reaches company data without password + authenticator code.
8. **Each company's data is walled off by the database itself** (PostgreSQL row-level security), not just by the app.
9. **Social Security numbers and 2FA secrets are encrypted** (AES-256-GCM) before they are stored.

## Running it on your computer

You need **Node.js 22** (nodejs.org, "LTS" installer) and **PostgreSQL 16** (postgresql.org/download).

```bash
npm install                                   # downloads the libraries listed in package.json
createdb zacc_dev                             # makes an empty database
# macOS/Linux:
export DATABASE_URL=postgres://localhost:5432/zacc_dev
# Windows PowerShell:  $env:DATABASE_URL="postgres://postgres:YOURPASSWORD@localhost:5432/zacc_dev"
npm run migrate                               # builds the tables
npm run seed                                  # optional: demo company with sample transactions
npm run dev                                   # starts the server; open http://localhost:3000
```

**Signing in:** create an account on the start screen, then set up two-step sign-in with any authenticator
app (Google/Microsoft Authenticator, 1Password, Authy). `npm run seed` also creates a demo user,
`demo@example.com` / `demo password 2026`; it prints the authenticator key, and the recovery code
`DEMO1234` works once.

### Settings (environment variables)

| Variable | Needed | What it is |
|---|---|---|
| `DATABASE_URL` | always | database login the running app uses |
| `MIGRATION_DATABASE_URL` | production | a *different* login that owns the tables and runs migrations (the app login can't alter tables) |
| `AUDIT_HMAC_KEY` | production | secret key for the audit hash chain (32+ random characters) |
| `FIELD_ENCRYPTION_KEY` | production | secret key for SSN / 2FA-secret encryption (32 random bytes, base64) |
| `ALLOWED_HOSTS` | production | the site's host name, e.g. `app.zaccountant.com` |
| `TRUST_PROXY` | production | `1` behind Railway's proxy, so rate limits see each visitor's address |
| `METRICS_TOKEN` | for monitoring | turns on `GET /metrics` for Grafana (send it as a bearer token) |
| `DEVELOPER_EMAILS` | for the Developer dashboard | comma-separated sign-in emails that see the Developer dashboard (beta feedback, server errors, backup download) |
| `ADMIN_EMAILS` | optional | comma-separated sign-in emails that see the Admin dashboard only |
| `API_RATE_LIMIT`, `AUTH_RATE_LIMIT` | optional | requests per minute per address (default 1,200), sign-in attempts per 5 minutes (default 30) |

Monitoring, backups (the restore drill) and the load test: [docs/runbooks/operations.md](docs/runbooks/operations.md).

In production, create the app login and give it only the rights it needs with `npm run db:grant`
(see `src/db/grant.js`). Locally one login is fine; the server refuses to start in production without these.

**Nightly books check:** the server runs it at about 2 a.m. Central (set `NIGHTLY_JOB=off` to disable, e.g. when a
separate cron runs `npm run job:nightly`). It posts due recurring entries, re-verifies the audit trail and the
ledger, confirms the statements balance and that open invoices/bills add up to Accounts Receivable/Payable, and logs a fingerprint of each company's audit chain.

Tests: `npm run test:unit` (no database needed) or `npm test` (all, needs `DATABASE_URL`;
each test file creates and deletes its own temporary database).

## API quick reference

Sign-in: `POST /api/auth/{signup,login,logout}`, `GET /api/auth/me`, `POST /api/auth/mfa/{setup,enable,verify}`.
Everything else needs a fully signed-in session (cookie) and is under `/api/companies/:companyId/…`. Amounts may be sent as decimal strings (`"1234.56"`); responses use integer cents.

| Method & path | Purpose |
|---|---|
| `POST /api/companies` | create company + default chart of accounts |
| `GET/POST …/accounts`, `GET …/accounts/:id/register` | chart of accounts, account register |
| `GET …/entries?text=&from=&to=&accountId=&min=&max=&source=&limit=&offset=` | journal search (returns `{entries,total}`) |
| `POST …/entries`, `POST …/entries/simple`, `POST …/entries/:id/reverse` | post / reverse; send an `Idempotency-Key` header so a retried save posts once |
| `GET/POST …/recurring`, `POST …/recurring/:id/stop`, `POST …/recurring/post-due` | recurring entries |
| `GET/POST …/books-check` | latest / run the full books check |
| `POST …/bank-accounts/:id/import` | import a CSV or OFX/QFX statement (`{fileName, content, preview}`) |
| `GET …/bank-accounts/:id/transactions?status=review` | bank lines to review (or posted / matched / excluded) |
| `POST …/bank-transactions/:id/{post,match,exclude,undo}`, `GET …/matches` | review a bank line |
| `GET/POST …/bank-rules`, `DELETE …/bank-rules/:id` | categorization rules |
| `POST …/imports/preview`, `POST …/imports`, `GET …/imports`, `POST …/imports/:id/undo` | import books: `kind` = accounts, opening (`asOf`), journal, iif; CSV `content` or Excel `base64` |
| `GET/POST …/customers`, `GET/POST …/vendors`, `PATCH …/contacts/:id` | customers and vendors (with open and overdue balances) |
| `GET/POST …/invoices`, `GET/POST …/bills`, `GET …/documents/:id`, `POST …/documents/:id/void` | invoices and bills (`status=open\|paid\|void\|all`); send an `Idempotency-Key` |
| `GET/POST …/payments-received`, `GET/POST …/payments-made`, `GET …/payments/:id`, `POST …/payments/:id/void` | payments applied to invoices/bills (`applications: [{documentId, amount}]`) |
| `GET …/reports/{ar-aging,ap-aging}?asOf=` | aging by customer/vendor, tied to Accounts Receivable/Payable |
| `GET/POST …/bank-accounts/:id/reconciliations`, `GET/DELETE …/reconciliations/:id`, `POST …/lines`, `POST …/complete` | bank reconciliation |
| `POST …/lock` | close books through a date (reopening: owner + 2FA code + reason) |
| `GET/POST/DELETE …/members` | who has access: role (owner, accountant, bookkeeper, viewer, staff, or a custom role id) and department |
| `GET/POST …/roles`, `PATCH/DELETE …/roles/:id` | permission catalog, built-in roles, custom roles (`{name, permissions}`) |
| `GET/POST …/departments`, `DELETE …/departments/:id` | departments (Accounting, Engineering, Field…) |
| `GET …/reports/{dashboard,trial-balance,balance-sheet,income-statement,cash-flow}` | statements; `compare=prior_period\|prior_year` adds side-by-side columns to the balance sheet and P&L |
| `GET …/reports/payroll-register?from=&to=` | every paycheck in a pay-date range, a column per deduction and tax, with totals (payroll role) |
| `…/reports/…?format=csv` | any statement, aging or the payroll register as a CSV download for Excel (printing to PDF uses the browser's print window) |
| `GET …/audit/verify` | verify the audit hash chain |
| `GET/POST …/employees`, `POST …/employees/:id/paychecks[/preview]`, `GET …/paychecks` | payroll |
| `POST …/payroll-runs/preview`, `POST …/payroll-runs`, `GET …/payroll-runs[/:id]` | pay everyone on a schedule for a pay period (`items: [{employeeId, hours, overtimeHours, doubleTimeHours, preTaxDeductions}]`; `fromTimesheets: true` marks the period's approved hours paid) |
| `GET …/payroll-hours?payFrequency=&periodStart=&periodEnd=` | approved, unpaid timesheet hours per employee, split into regular / overtime / double time (federal 40-hour week; California daily and 7th-day rules) |
| `PATCH …/employees/:id/user` | link an employee to the person who signs in (`{userId}`), so their timesheets can be paid |
| `GET/POST …/jobs`, `PATCH …/jobs/:id` | jobs that time is entered against (optionally tied to a customer) |
| `GET/POST …/time-entries`, `PATCH/DELETE …/time-entries/:id` | timesheet entries (`{date, start, end}` or `{date, hours}`, `jobId`, `notes`, `billable`); you see your own, your department's with "approve time", or everyone's with "all time" |
| `POST …/time-entries/submit`, `POST …/time-entries/review` | send for approval (`{ids}`); approve or send back (`{ids, approve, note}`); nobody but the owner approves their own time |
| `POST …/time-entries/import` | HoursTracker (or any timesheet CSV) export: `{fileName, content, preview, userId, createJobs}`; repeated rows are skipped |
| `GET …/reports/time-summary?from=&to=` | hours by person and job |
| `GET …/paychecks/:id/stub`, `GET …/reports/payroll-liabilities?from=&to=` | pay stub with year-to-date; payroll taxes owed by agency (payroll role) |
| `POST …/payroll-deposits`, `POST …/payroll-deposits/:id/void` | record a tax deposit to one agency for a date range (`{agency, form, periodStart, periodEnd, depositDate, paidFromAccountId, reference}`; pays what is still due), or void one recorded by mistake |
