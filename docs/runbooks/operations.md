# Operations runbook: monitoring, backups, load

Plain-language guide for running zAccountant in production (Railway). Section 14 of the spec has the targets;
this page has the "how". ℹ️ Engineering analogy: monitoring is the strain gauges, the restore drill is the
proof load on the foundation, the load test is the proof load on the frame.

## 1. Health checks

| URL | Meaning | Who uses it |
|---|---|---|
| `GET /healthz` | the server process is running | uptime monitor (status page) |
| `GET /readyz` | the server can reach the database | Railway health check (`healthcheckPath`) |

## 2. Logs

One JSON line per request on standard output; Railway collects them (and can forward them to Grafana Loki).

```json
{"level":"info","msg":"request","reqId":"…","method":"POST","route":"/api/companies/:companyId/entries/simple","status":201,"ms":14,"userId":"…","companyId":"…"}
```

- Only ids, never names, emails, amounts or search text.
- `reqId` is also sent back in the `X-Request-Id` header; a server error (`"level":"error"`) carries the same id,
  so a customer's report can be matched to the log line.
- On each deploy Railway sends SIGTERM: the server logs `shutting down`, finishes requests in flight, then exits.

## 3. Metrics and alerts

Set `METRICS_TOKEN` (a long random string) in Railway. `GET /metrics` with `Authorization: Bearer <token>` returns
Prometheus text: request counts by route and status, a latency histogram per route (buckets include the 0.8 s
and 2 s alert thresholds), database pool connections and waiting requests, uptime and memory. Without the
variable the URL answers 404.

Alert rules for Grafana (thresholds from Section 14.2):

| Alert | Rule (PromQL) | Warning | Page |
|---|---|---|---|
| Slow | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))` | > 0.8 s for 10 min | > 2 s for 5 min |
| Errors | `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))` | > 1 % for 10 min | > 5 % for 5 min |
| DB pool | `db_pool_waiting` | > 0 for 5 min | > 5 for 5 min |
| Books out of balance | nightly log line with `"ok":false` (books check) | — | any |
| Audit chain broken | nightly log line with `"auditChainOk":false` | — | any |

## 4. Backups and the restore drill (RTO under 4 hours)

**While on Railway's Hobby plan (Homer, 2026-10-24) there are no automatic backups.** A developer downloads one
from the Developer dashboard (**Download backup**, `GET /api/developer/backup`, pg_dump custom format, file named
`zaccountant-backup-<date>-pg<version>.dump`) about once a week and keeps it private: it holds every company's books.
Restore it with `pg_restore` of that PostgreSQL version, or check it with the drill's `--file` option below.
Once on Pro, Railway takes the automatic backups. The drill proves a backup actually restores and the books
in the copy are intact. Run it monthly, and before Board Review #3:

1. In Railway, add a **second, empty** PostgreSQL database (never restore over the live one; the drill refuses a
   database that has tables).
2. Run, with the same `AUDIT_HMAC_KEY` as production:
   ```bash
   BACKUP_SOURCE_URL=<live database URL>  RESTORE_TARGET_URL=<empty database URL>  npm run drill:restore
   # or restore a backup file you downloaded:  RESTORE_TARGET_URL=… npm run drill:restore -- --file backup.dump
   ```
3. It backs up, restores, compares tables, and runs the full books check (every trial balance zero, every audit
   chain verified) on the copy, timing each step. The last line says `"ok":true` and the minutes taken.
4. Write the result in the drill log below, then delete the scratch database.

| Date | Database size | Minutes | Result | By |
|---|---|---|---|---|
| 2026-10-24 | dev copy, 13,223 rows, 49 companies | 0.03 | ok, 0 failures | Claude (local) |

## 5. Load test

Design point (Section 14.1): 50 requests/second per server copy with p95 under 0.8 s and under 1 % errors.
Run against a **test** server only, started with the per-address limits raised (one machine plays many users):

```bash
API_RATE_LIMIT=1000000 AUTH_RATE_LIMIT=1000 npm start          # test server
npm run test:load -- --url http://localhost:3000 --users 20 --seconds 60
```

The mix per user: record a transaction, dashboard, journal search, P&L with comparison, balance sheet, trial balance.

| Date | Where | Users × seconds | Requests/s | p95 | Errors | Result |
|---|---|---|---|---|---|---|
| 2026-10-24 | local, 1 server, 20 users | 20 × 30 | 524 | 58 ms | 0 | ok (10× design point) |

Re-run on Railway (staging) once it's set up, since the real network and database add latency.

## 6. Rate limits

- Sign-in: 30 attempts per 5 minutes per address (`AUTH_RATE_LIMIT`).
- All API calls: 1,200 per minute per address (`API_RATE_LIMIT`), about 20 a second, far above a person's use.
- Behind Railway's proxy set `TRUST_PROXY=1` so the limits see each visitor's address, not the proxy's.
