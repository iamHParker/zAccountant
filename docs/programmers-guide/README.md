# zAccountant Programmer's Guide

This guide is for anyone changing the code: a new developer, Homer, or a Claude session. It explains how the
pieces fit, the rules the code never breaks, and the steps for common changes. The [README](../../README.md) covers
installing and running; the [User Guide](../user-guide/README.md) covers what people see on screen.

Written for an engineer who is new to web programming. Where a web idea has an engineering equivalent, the
chapter says so.

| # | Chapter | Read it when you… |
|---|---|---|
| 1 | [Architecture: the load path of a request](01-architecture.md) | start here; how a click becomes a saved row |
| 2 | [Money, rounding and the ledger](02-money-and-ledger.md) | touch anything with amounts, entries or reports |
| 3 | [Security: sign-in, permissions, plans, row-level security](03-security.md) | add a route, a table or a role |
| 4 | [The database and migrations](04-database.md) | add or change a table or column |
| 5 | [Features by area](05-features.md) | work on invoices, banking, payroll, timesheets, feedback or plans |
| 6 | [The browser side (Vue, no build step)](06-front-end.md) | change a screen |
| 7 | [Error handling](07-error-handling.md) | write anything that can fail (everything) |
| 8 | [Testing](08-testing.md) | before every pull request |
| 9 | [Recipes: step-by-step changes](09-recipes.md) | add a route, a setting, a report, a tax table |
| 10 | [Operations: deploys, backups, monitoring](10-operations.md) | something is wrong in production |

## Ten rules (break one and the books can be wrong)

1. **Money is integer cents** (JavaScript `Number` holding whole cents, `bigint` in PostgreSQL). Never floating-point
   dollars. Rates are integer parts-per-million. Rounding is half-up, done once, with BigInt (`src/core/money.js`).
2. **Every journal entry balances.** JavaScript checks it, and a PostgreSQL trigger checks it again at commit.
3. **History is append-only.** Nothing posted is edited or deleted; mistakes are reversed by a new entry, and
   documents are voided.
4. **Closed periods are locked** by the database, not just the screen.
5. **Every change writes the audit chain** (`appendAudit`), a keyed hash chain that shows tampering.
6. **The server is the gatekeeper.** Every API route names a permission; the screens only hide what the server would refuse.
7. **Row-level security walls off each company** inside PostgreSQL. The app's database login can only touch the
   columns `src/db/grant.js` grants.
8. **Tax values are data**, in `src/payroll/tables/<year>.json`, with sources, and `verified: false` until the
   Professional Review Board certifies them.
9. **Every request is one transaction.** It either all saves or none of it does.
10. **Errors are plain sentences** for people, never stack traces or database text (chapter 7).
