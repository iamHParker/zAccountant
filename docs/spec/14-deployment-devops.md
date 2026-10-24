# Section 14 — Deployment & DevOps (completed)

> Status: **Complete** (was 85%). This section fills the ten missing subsections.
> Hosting: Railway (Node.js service + managed PostgreSQL + Redis), Cloudflare in front.
> Plain-language notes for non-web engineers are marked **ℹ️**.

ℹ️ *Mental model:* think of the deployed system like a structure with redundant load paths.
Cloudflare is the "foundation isolation" (absorbs attacks, serves static files), Railway runs
copies of the app server (the "columns"), PostgreSQL is the "bedrock" holding the books, and
monitoring is the "instrumentation" (strain gauges) that tells us when something is overloaded.

---

## 14.1 Load Balancing & Auto-Scaling

| Item | Target / Policy |
|---|---|
| Baseline replicas (prod) | 2 web replicas (never 1, so a deploy or crash never takes us offline) |
| Max replicas (prod) | 6 at launch; revisit at 2,000 paying companies |
| Scale-out trigger | CPU > 70% for 5 min **or** memory > 75% for 5 min **or** p95 latency > 800 ms for 5 min |
| Scale-in trigger | CPU < 30% and memory < 50% for 20 min (slow scale-in avoids "flapping") |
| Request rate design point | 50 req/s sustained, 200 req/s burst per replica |
| Worker service | Separate `worker` service for payroll runs, imports, report PDFs (1–3 replicas, queue-depth scaled) |
| Health check | `GET /healthz` (process alive) and `GET /readyz` (DB + Redis reachable) |

Railway routes traffic across replicas automatically (its edge proxy is the load balancer).
The app is **stateless**: sessions live in Redis/JWT, files in object storage, so any replica can serve any request.

**Multi-region failover.** Not at MVP. Phase 2: warm standby in a second Railway region with
streaming PostgreSQL replica; manual promotion runbook (RB-07). Target RTO with standby: 30 min.

**CDN.** Cloudflare (free → Pro plan) in front of the Railway domain:
- Caches static UI assets (`/assets/*`, hashed filenames, `Cache-Control: public, max-age=31536000, immutable`).
- Never caches `/api/*` (`Cache-Control: no-store` — financial data must never sit in a shared cache).
- Provides TLS 1.3 at the edge, WAF and DDoS protection (see 14.5).

```toml
# railway.toml (service: web)
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node src/server.js"
healthcheckPath = "/readyz"
healthcheckTimeout = 30
numReplicas = 2
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 5
```

---

## 14.2 Monitoring, Logging & Alerting

**Choice:** Grafana Cloud (hosted Prometheus + Loki + Grafana) for MVP. Cheaper and simpler than running ELK
ourselves; Datadog is the Phase 3 upgrade path if a SOC 2 auditor or enterprise customer requires it.

- **Metrics:** app exposes `GET /metrics` (Prometheus format, protected by a bearer token). Key metrics:
  `http_request_duration_seconds` (histogram by route), `http_requests_total{status}`,
  `ledger_entries_posted_total`, `ledger_unbalanced_rejections_total`, `payroll_runs_total{state,result}`,
  `db_pool_waiting`, `queue_depth{queue}`, `audit_chain_verify_failures_total`.
- **Logs:** structured JSON to stdout (one line per event) → Railway log drain → Grafana Loki.
  **PII and amounts are never logged**; logs carry ids only (company_id, entry_id, request_id).
- **Dashboards:** (1) Golden signals (latency, traffic, errors, saturation), (2) Accounting integrity
  (unbalanced rejections, audit-chain verification, trial-balance check job), (3) Payroll/tax filing queue,
  (4) Database (connections, slow queries, replication lag, disk).

### Alert thresholds

| Alert | Warning | Critical (page) |
|---|---|---|
| p95 API latency | > 800 ms 10 min | > 2 s 5 min |
| 5xx error rate | > 1% 10 min | > 5% 5 min |
| DB connections used | > 70% | > 90% |
| DB slow queries (> 1 s) | > 10/min | > 50/min |
| Disk used (DB) | > 70% | > 85% |
| Nightly trial balance ≠ 0 for any company | — | **any** (books out of balance = Sev-1) |
| Audit hash-chain verification failure | — | **any** (possible tampering = Sev-1) |
| Payroll / tax filing job failed | any | filing due within 48 h |
| Backup job missed | 1 missed | 2 consecutive |

**Escalation:** Grafana Alerting → Slack `#zacc-alerts` (warnings) and PagerDuty (critical).
PagerDuty escalation: primary on-call 15 min → secondary 15 min → founder.

### Log retention

| Log type | Hot (searchable) | Archive | Notes |
|---|---|---|---|
| Application logs | 30 days | 1 year (R2 bucket, compressed) | no PII |
| Access/security logs | 90 days | 7 years | supports SOC 2 & incident forensics |
| Accounting audit trail (`audit_log` table) | lives in DB | **7 years minimum**, never deleted while account active | IRS record-keeping; payroll records 4 years (IRS) — we keep 7 |

---

## 14.3 Backup & Disaster Recovery

| Target | Value | Meaning (ℹ️) |
|---|---|---|
| **RPO** (Recovery Point Objective) | **≤ 5 minutes** | at most 5 minutes of data could be lost in a disaster |
| **RTO** (Recovery Time Objective) | **≤ 4 hours** (MVP), ≤ 30 min (Phase 2 standby) | how long until we're back online |

**Schedule**
- Continuous WAL (write-ahead log) archiving → point-in-time recovery to any second in last 14 days.
- Daily full logical backup (`pg_dump -Fc`) at 02:00 CT, kept 35 days.
- Weekly backup kept 13 weeks; monthly kept 7 years (year-end books must be recoverable).
- Year-end snapshot after each customer closes their fiscal year, kept 7 years.

**Encryption & off-site:** backups encrypted with `age` (public-key) before upload; stored in Cloudflare R2
**and** Backblaze B2 (two providers, two regions). Private key held offline in 1Password (2 people).

**Restore verification:** a weekly automated job restores last night's backup into a scratch database,
runs `npm run verify:books` (trial balance = 0 for every company, audit hash chain intact) and reports the result.
A backup that has not been test-restored is treated as not existing.

**DR drills:** quarterly full restore drill (timed against RTO), annual region-loss tabletop exercise.

---

## 14.4 Database Performance & Optimization

**Indexing strategy** (in `db/migrations`):

| Table | Index | Why |
|---|---|---|
| `journal_lines` | `(company_id, account_id, entry_date)` | account ledgers, trial balance as-of a date |
| `journal_entries` | `(company_id, entry_date)`, unique `(company_id, entry_number)` | journal listing, numbering |
| `bank_transactions` | `(company_id, bank_account_id, posted_date)`, `(company_id, status)` | reconciliation screens |
| `audit_log` | `(company_id, id)` | chain verification in order |
| `pay_stubs` | `(company_id, employee_id, pay_date)` | YTD wage-base calculations |

**Connection pooling:** app uses `pg.Pool` (max 10 per replica). When replicas × 10 approaches the DB limit,
add PgBouncer (transaction mode) as a Railway service. Rule: `replicas × pool_max ≤ 0.8 × max_connections`.

**Read replicas:** Phase 2, for heavy reports and exports only. Ledger posting always hits the primary.

**Partitioning:** `audit_log` and `bank_transactions` range-partitioned by month once either exceeds ~50 M rows
(PostgreSQL declarative partitioning). Not needed at launch.

**Query checklist (every PR touching SQL):** `EXPLAIN ANALYZE` on realistic data; no sequential scans on tables
> 10k rows in hot paths; every query filtered by `company_id` (also enforced by row-level security);
money is `BIGINT` cents, never `FLOAT`; pagination by keyset, not `OFFSET`, for large lists.

---

## 14.5 Security Hardening

- **WAF:** Cloudflare managed ruleset + OWASP Core Rule Set (paranoia level 2), rate limits:
  login 10/min/IP, MFA 5/min/user, API 600/min/user, export 10/hour/user.
- **DDoS:** Cloudflare always-on L3/L4/L7 protection; "Under Attack" mode runbook (RB-05).
- **IP allow-listing:** admin console and `/metrics` restricted to Cloudflare Access (zero-trust SSO). Enterprise
  customers may set their own allow-list per company.
- **Secrets:** Railway environment variables for runtime secrets (encrypted at rest), master source of truth in
  1Password Business; field-encryption keys (AES-256-GCM, per-company data keys) wrapped by a key-encryption key
  in AWS KMS (Phase 2; env-var KEK at MVP). Rotation: API keys 90 days, DB password 180 days, KEK yearly.
- **TLS:** Cloudflare edge certificates auto-renew; origin certificate 15-year Cloudflare origin cert, reviewed yearly;
  HSTS `max-age=63072000; includeSubDomains; preload`. TLS 1.2 minimum at origin, 1.3 at edge.
- **Penetration testing:** external pentest before GA and annually; automated DAST (OWASP ZAP) weekly against staging;
  `npm audit` + Dependabot on every PR.

---

## 14.6 Release & Deployment Process

**CI/CD (GitHub Actions)** — stages, each must pass before the next:

1. **Lint & type-check**
2. **Unit tests** (accounting engine, payroll engine — 100% of tax-table code paths)
3. **Integration tests** against a real PostgreSQL service container (migrations + API)
4. **Golden-file payroll tests** — fixed paychecks verified by the Professional Review Board; any change to a golden
   result requires a board-approved PR label `board-approved`
5. **Security scan** (`npm audit --audit-level=high`, secret scanning)
6. **Build Docker image**, tag with git SHA
7. **Deploy to staging** automatically on merge to `main`; smoke tests
8. **Deploy to production** by manual approval (GitHub Environment protection)

**Strategy:** Railway rolling deploy with health checks (new replica must pass `/readyz` before old one stops) —
effectively blue-green per replica. Database migrations are **expand → migrate → contract** (never a breaking
change in one release) so the previous version can always run against the new schema.

**Rollback:** redeploy previous image from Railway dashboard (< 2 min). Migrations are forward-only; a bad migration
is fixed with a new forward migration. Ledger data is never "rolled back" — accounting corrections are reversing entries.

**Feature flags:** simple `feature_flags` table (per company / per percentage) for dark launches, e.g. new state payroll
engines ship dark, then enabled for board test companies, then for all.

**Release notes:** Conventional Commits → `release-please` generates `CHANGELOG.md` and GitHub releases; customer-facing
notes curated from it.

```yaml
# .github/workflows/ci.yml (implemented in the repo)
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: zacc_test }
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
    env:
      DATABASE_URL: postgres://postgres:postgres@localhost:5432/zacc_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm test
```

---

## 14.7 Development & Staging Environments

| Env | Purpose | Data |
|---|---|---|
| Local | developer laptop, `docker compose up` (Postgres + Redis) | seed script demo company |
| CI | throwaway Postgres per run | fixtures |
| Staging | mirrors production config (same Dockerfile, same Railway settings, 1 replica) | synthetic + sanitized |
| Production | customers | real |

**Staging parity:** same image, same migrations, same env-var names; only secrets and replica count differ.

**PII sanitization** (if ever copying prod → staging, which requires founder approval): names → faker names,
SSN/TIN → `999-xx-xxxx` test range, bank/routing numbers → test values, emails → `user+<id>@example.test`,
amounts preserved (so totals still tie). Implemented as a SQL script run *inside* production's backup restore, never
by exporting raw data.

**Performance testing:** k6 scripts against staging before each major release: 200 concurrent users, payroll run of
500 employees in < 60 s, trial balance on 1 M journal lines in < 2 s.

**API contracts:** OpenAPI 3.1 file (`docs/api/openapi.yaml`) is the source of truth; contract tests validate every
response in integration tests against it; docs published with Redoc.

---

## 14.8 Cost Optimization

Railway bills by actual usage (vCPU-minutes, GB-RAM-minutes, egress, volume storage) plus plan fee.

| Stage | Customers | Est. monthly infra | Notes |
|---|---|---|---|
| Beta (Jan–Mar) | ≤ 200 | ~$80–150 | 2× 0.5 vCPU/1 GB web, 1 worker, 1 GB Postgres, Redis |
| Year 1 end | ~1,500 | ~$400–700 | 3–4 web replicas, 4 GB DB, Grafana Cloud paid tier |
| Year 3 | ~12,000 | ~$3k–5k | read replica, PgBouncer, standby region |

Fixed SaaS costs: Cloudflare Pro $20–25, Grafana Cloud $0–$300, PagerDuty ~$21/user, 1Password ~$8/user,
backups (R2+B2) < $20 at launch. Plaid is **variable per connected account** and is the largest cost driver — it is
priced into the plan tiers (Section 18).

**Caching:** Redis (Railway) for sessions, rate-limit counters, and cached report results keyed by
`(company_id, report, as_of, ledger_version)` — the cache key includes the ledger version so a new posting
automatically invalidates stale reports (no risk of showing outdated numbers).

**Storage:** source documents (receipts, statements) in Cloudflare R2 (no egress fees), lifecycle to infrequent-access
after 1 year. Audit logs stay in PostgreSQL (small rows), partitioned when large.

---

## 14.9 Compliance & Auditing (Deployment Level)

- **Infrastructure as Code:** `railway.toml` per service + Terraform (Cloudflare DNS/WAF, R2 buckets, Grafana alerts).
  All infra changes via PR.
- **Drift detection:** weekly `terraform plan` in CI; any diff opens an issue.
- **Production access:** no SSH; Railway access limited to 2 named people with hardware-key MFA; database access only
  via break-glass role that is logged and alerts Slack. API keys rotated every 90 days.
- **Deployment audit trail:** every deploy records git SHA, approver, time (GitHub Environments + Railway history),
  exported monthly to the evidence archive.
- **SOC 2 Type II (target: Type I by month 9, Type II window months 10–16):** controls mapped — CC6 access control,
  CC7 change management (PR review + CI gates), CC7 monitoring (14.2), A1 availability (14.3 backups/drills),
  C1 confidentiality (encryption, PII-free logs). Evidence collected with Vanta or Drata (Phase 2).

---

## 14.10 Incident Management & Runbooks

**On-call:** weekly rotation, primary + secondary; at launch the founder + one contractor. Handoff Mondays 09:00 CT.

**Severity levels**

| Sev | Example | Response | Customer comms |
|---|---|---|---|
| 1 | Data integrity issue (unbalanced books, wrong tax calc), outage, security breach | page immediately, 15 min ack | status page within 30 min, email affected users |
| 2 | Feature down (bank sync, payroll submission delayed) | 1 h | status page within 2 h |
| 3 | Degraded / cosmetic | next business day | release notes |

**Degradation protocol:** status page (statuspage / Instatus) updated at least every 60 min during Sev-1/2.
If payroll tax deposits could be late, customers are told the exact deadline and manual fallback the same day.

**Postmortems:** blameless, within 5 business days for Sev-1/2: timeline, root cause, what went well, action items with
owners. Stored in `docs/postmortems/`.

**Runbooks** (`docs/runbooks/`):

| ID | Situation | First steps |
|---|---|---|
| RB-01 | DB connection failures | check Railway DB status → pool saturation metric → restart web replicas → enable PgBouncer |
| RB-02 | API timeouts / high latency | identify slow route in dashboard → `pg_stat_statements` top queries → scale replicas |
| RB-03 | Trial balance ≠ 0 alert | freeze posting for that company (flag), run `verify:books`, compare audit chain, escalate to Review Board accountant |
| RB-04 | Audit chain verification failure | Sev-1 security incident: preserve evidence, revoke sessions, restore comparison from backup |
| RB-05 | DDoS / attack traffic | Cloudflare "Under Attack" mode, tighten rate limits |
| RB-06 | Plaid sync outage | check Plaid status, pause sync jobs, banner to users |
| RB-07 | Region loss | restore from backup in new region (Phase 2: promote standby) |
| RB-08 | Wrong tax calculation discovered | stop payroll runs for affected state (feature flag), identify affected stubs, issue corrections next run, notify board |
