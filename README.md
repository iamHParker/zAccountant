# zAccountant

Small-business accounting and payroll for Texas, Colorado, California and Washington DC —
**double-entry books that cannot silently go out of balance**, with payroll tax logic reviewed by a
Professional Review Board.

Status: **Sprint 0 (foundations)** — see [docs/spec/21-implementation-roadmap.md](docs/spec/21-implementation-roadmap.md).
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
5. **Audit trail is hash-chained** (SHA-256), so tampering is detectable (`npm run verify:books`).
6. **Tax tables are versioned data marked `verified:false`** until the Review Board certifies them; until then
   payroll runs in *calculate-only* mode.

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

Tests: `npm run test:unit` (no database needed) or `npm test` (all, needs `DATABASE_URL`;
each test file creates and deletes its own temporary database).

## API quick reference

All under `/api/companies/:companyId/…`. Amounts may be sent as decimal strings (`"1234.56"`); responses use integer cents.

| Method & path | Purpose |
|---|---|
| `POST /api/companies` | create company + default chart of accounts |
| `GET/POST …/accounts`, `GET …/accounts/:id/register` | chart of accounts, account register |
| `GET/POST …/entries`, `POST …/entries/simple`, `POST …/entries/:id/reverse` | journal |
| `POST …/lock` | close books through a date |
| `GET …/reports/{dashboard,trial-balance,balance-sheet,income-statement,cash-flow}` | statements |
| `GET …/audit/verify` | verify the audit hash chain |
| `GET/POST …/employees`, `POST …/employees/:id/paychecks[/preview]`, `GET …/paychecks` | payroll |
