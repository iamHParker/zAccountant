# 1. Architecture: the load path of a request

Think of a request like a load path in a structure. It enters at the roof (the browser) and passes through each
member in turn. Each member checks one thing, and the load reaches the foundation (PostgreSQL) only if every
check passes. If any member fails, the whole load is refused. Nothing is half-saved.

```
Browser (public/app.js, Vue)        user presses "Save invoice"
   │  fetch('/api/companies/<id>/invoices', JSON)
   ▼
Express app (src/app.js)
   ├─ host check, CSRF check (JSON only, same origin), rate limit, request id + log line
   ├─ session check: signed in AND passed two-step sign-in, else 401
   ├─ route(permission, handler)
   │    ├─ ids in the URL are UUIDs, else 404
   │    ├─ withScope: BEGIN, tag the transaction with user + company (row-level security reads these)
   │    ├─ member of the company?  (no → 404, so other companies' existence isn't revealed)
   │    ├─ role has the permission?  (no → 403 with a sentence)
   │    ├─ company's plan has the feature?  (no → 402)
   │    └─ handler → service function → SQL
   ├─ COMMIT (deferred checks run here: entry balances, period not locked) or ROLLBACK
   └─ JSON answer, or the error handler turns the error into a status code + sentence
   ▼
PostgreSQL 16: constraints, triggers, row-level security, column grants
```

## The folders

| Folder | What it is | Engineering analogy |
|---|---|---|
| `src/core/` | Pure rules and math: money, ledger checks, statements, CSV/Excel, permissions, plans | design equations: no I/O, unit-tested |
| `src/payroll/` | Gross-to-net payroll engine (pure) and yearly tax tables (data) | analysis method + code-book values |
| `src/services/` | Business operations: read/write the database through the core rules | the connections that join members |
| `src/db/` | Pool, transactions, migrations, grants, seed | the foundation and its as-built drawings |
| `src/jobs/` | Nightly books check, backup, restore drill, load test | inspections and load tests |
| `src/app.js` | Every URL (route), its permission, and error handling | the load path |
| `src/server.js` | Start-up: settings check, migrations, runtime DB login, listen, shut down cleanly | erection sequence |
| `public/` | The screens: `index.html` (layout), `app.js` (behaviour), `styles.css`, `help.js`, `feedback.js` | architectural finishes |
| `test/` | `*.unit.test.js` (no database) and `*.db.test.js` (each makes its own throwaway database) | check calcs |
| `docs/` | Spec, board reviews, runbooks, these guides | the project manual |

## Layers and who may call whom

- `public/` talks only to `/api/...` over HTTP.
- `src/app.js` calls services. It never writes SQL for business data.
- Services call `src/core/` for rules and run SQL through the `db` client they are handed.
- `src/core/` and `src/payroll/engine.js` never touch the database or the network. That keeps them simple to test,
  like a design equation you can check by hand.

## One transaction per request

`withScope(pool, { userId, companyId, platformRole }, fn)` (`src/db/pool.js`) opens a transaction, tags it with
who is asking, runs `fn(db)`, and commits. Service functions that need their own transaction call
`withTransaction(db, fn)`; inside a request that becomes a SAVEPOINT. A failed step therefore rolls back on its
own, and its error reaches the person straight away.

## Where to look first

| You want to change… | Start in |
|---|---|
| a screen | `public/index.html` (markup) and `public/app.js` (methods) |
| what a URL does or who may call it | `src/app.js` |
| business behaviour (invoices, payroll…) | the matching file in `src/services/` |
| a calculation | `src/core/` or `src/payroll/engine.js` |
| a tax rate | `src/payroll/tables/<year>.json` |
| a table or column | a new file in `src/db/migrations/`, plus `src/db/grant.js` |
