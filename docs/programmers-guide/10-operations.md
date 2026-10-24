# 10. Operations: deploys, backups, monitoring

Production runs on **Railway** at `zaccountant-production.up.railway.app` (Hobby plan during the beta).

| Topic | Where |
|---|---|
| First-time Railway setup, settings (environment variables), custom domain | [docs/runbooks/railway-setup.md](../runbooks/railway-setup.md) |
| Health checks, logs, metrics and alerts, restore drill, load test, results log | [docs/runbooks/operations.md](../runbooks/operations.md) |
| Every setting the server reads | README → "Settings (environment variables)" |

## A deploy, step by step

1. A pull request merges into `main`.
2. Railway builds the `Dockerfile` (Node 22 plus the PostgreSQL client tools for backups).
3. The new copy starts: it checks its settings, runs new migrations as the owner login, refreshes the restricted
   login's grants, then starts listening. `/readyz` turns green when it can reach the database.
4. Railway sends the old copy SIGTERM. It finishes its requests and exits.

If a migration fails, the new copy refuses to start and the old one keeps serving. Fix forward with a new
migration; never edit the failed file once it is on `main`.

## When something is wrong

| Symptom | Look at |
|---|---|
| A tester's 🐞 report | Developer dashboard: the report's clicks, errors and request ids; "Server errors" lists the last 100 |
| A request id from a report | Railway → Deployments → Logs, search for the id |
| "zAccountant is restarting or briefly unavailable" for more than a few minutes | Railway deployment status; `/readyz`; the database service |
| The nightly books check shows ⚠ | Settings → Audit trail on that company; `npm run verify:books` with the owner login |

## Backups

The Hobby plan has no scheduled backups. Until Homer decides (by mid-November 2026), a developer downloads one with
**Developer dashboard → Download backup** (pg_dump custom format, streamed from the server). Restore it with
`pg_restore` into a scratch database, and prove it with `npm run drill:restore`. Backups must be scheduled, with a
recorded restore drill, before the December 1 alpha.

## Secrets

`AUDIT_HMAC_KEY`, `FIELD_ENCRYPTION_KEY` and the database passwords live only in Railway's variables. Never put them
in code, docs, commits, logs or chat. Losing `FIELD_ENCRYPTION_KEY` makes stored Social Security numbers and
authenticator secrets unreadable, so keep a copy in a password manager.
