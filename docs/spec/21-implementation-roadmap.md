# Section 21 — Implementation Roadmap (new)

> Target: **public beta January 1, 2027.** Plan written October 24, 2026. Sprints are one week (Mon–Sun).
> Times are Central (CT).

## 21.1 What "launch on January 1" means (recommendation)

Ten weeks is enough to launch a trustworthy **bookkeeping core** — ledger, bank import, reports, QuickBooks import —
plus **payroll in calculate-only mode** (pay stubs and tax liabilities computed and booked, but deposits and filings
done by the customer or their accountant). It is **not** enough to responsibly launch automated tax e-filing and money
movement in four jurisdictions: those need agency enrollment (IRS MeF, TWC, CDLE, CA EDD, DC OTR/DOES), a licensed
payments partner, and Professional Review Board certification of each state's engine.

So Jan 1 = **Public Beta**; payroll goes live state-by-state Feb–Apr (Section 18.3). This protects the brand promise
("checked by professionals").

## 21.2 Sprint plan (Phase 1 — MVP)

| Sprint | Dates | Goal | Key deliverables | Exit test |
|---|---|---|---|---|
| S0 | Oct 24–Nov 1 | Foundations | repo, CI, DB migrations, money math, double-entry ledger, chart of accounts, trial balance, BS/IS/CF, payroll engine v0 (federal + 4 states), minimal UI, **Board Review #1** | all unit tests green; books always balance |
| S1 | Nov 2–8 | Identity & security | signup/login, password hashing (argon2), JWT sessions, TOTP MFA, RBAC (owner/accountant/bookkeeper/viewer), row-level security per company | security tests; no cross-company reads |
| S2 | Nov 9–15 | Ledger completeness | period close/lock, reversing entries, recurring entries, journal search, account register, audit hash-chain verification job | trial balance job nightly |
| S3 | Nov 16–22 | Banking | Plaid Link (sandbox), transaction sync, categorization rules, matching → journal entries, reconciliation screen | reconcile a sandbox month to the penny |
| S4 | Nov 23–29 (Thanksgiving) | Import | QuickBooks (IIF/CSV/QBO) and Excel templates, validation, dry-run preview, rollback | import sample QB file; TB matches source |
| S5 | Nov 30–Dec 6 | AR/AP + alpha | customers, invoices, vendors, bills, payments; **private alpha starts Dec 1**; **Board Review #2** | invoice → payment → reports tie |
| S6 | Dec 7–13 | Payroll v1 | employees (encrypted SSN), pay schedules, payroll runs, pay stubs PDF, payroll journal entries, YTD wage bases, 2027 tax tables | board golden paychecks pass |
| S7 | Dec 14–20 | Reports & polish | report PDFs/CSV export, comparative periods, dashboard, help center v1 | accountant usability test |
| S8 | Dec 21–27 | Hardening | pentest fixes, load test, backup restore drill, status page, monitoring alerts live; **Board Review #3 (go/no-go)** | RTO drill under 4 h |
| S9 | Dec 28–Jan 3 | **Launch** | production cut-over, marketing site, beta signup open **Jan 1** | smoke tests, on-call staffed |

**Phase 2 (Jan–Apr 2027):** payroll certification per state (TX Feb 1 → CO/DC Mar 1 → CA Apr 1), payments partner
(direct deposit), 941/940/W-2 generation and e-file via partner, billing (Stripe), Enterprise features.
**Phase 3 (H2 2027):** SOC 2 Type II, multi-region standby, new states (Section 18.11), inventory/projects.

## 21.3 Team composition & hiring

| Role | When | Commitment | Notes |
|---|---|---|---|
| Founder / product owner (Homer) | now | part-time → full | priorities, approvals, board liaison |
| AI coding agent (Claude) | now | continuous | implementation, tests, docs |
| Full-stack contract engineer | by Nov 15 | 20–40 h/wk | code review, deployment, on-call backup |
| Professional Review Board: CPA (lead), payroll specialist (CPP), EA/tax preparer, security reviewer, state specialist per income-tax state (CO, CA, DC) | engage by Nov 15 | 5–10 h/month each | sign-off on tax tables and golden tests |
| Customer support / success | by Dec 15 | part-time | beta support |
| Marketing contractor | by Dec 1 | part-time | site, content, launch |

## 21.4 Critical path

```
Money math → Ledger → Reports ─────────────────────────────┐
              │                                             ├─> Private alpha (Dec 1) ─> Hardening ─> Beta (Jan 1)
              ├─> Auth/RBAC ─> Banking (Plaid) ─> Reconcile ┤
              └─> Import (QB/Excel) ────────────────────────┘
Payroll engine ─> 2027 tax tables published (IRS Pub 15-T ~Dec) ─> Board certification ─> state-by-state GA
```

Hard external dependencies: **IRS Pub 15-T for 2027** (usually published in December), **state 2027 withholding
tables** (CA EDD, CO DOR, DC OTR — December), Plaid production approval (2–4 weeks), payments partner contract.

## 21.5 Risk register

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Wrong payroll tax calculation | Med | **Severe** (penalties, trust) | versioned tax tables marked *unverified* until board-certified; engine refuses live runs on unverified tables; golden tests; calculate-only beta | Board lead |
| R2 | 2027 tables published late in December | High | Med | tables are data files, not code; same-day update process; beta uses calculate-only | Engineering |
| R3 | Books out of balance due to bug | Low | Severe | balance enforced in code **and** database trigger; nightly trial-balance check; immutable posted entries | Engineering |
| R4 | Data breach | Low | Severe | encryption, MFA, RLS, pentest, minimal PII in logs | Security reviewer |
| R5 | Plaid approval delay | Med | Med | CSV/OFX bank statement import as fallback | Engineering |
| R6 | Payments/e-file partner delay | High | Med | calculate-only payroll; customer files with existing provider | Founder |
| R7 | Scope creep before Jan 1 | High | Med | this roadmap; anything not listed moves to Phase 2 | Founder |
| R8 | Owner availability (part-time) | Med | Med | decisions batched weekly; agent continues on recommended option | Founder |
| R9 | Regulatory: money transmission licensing | Med | High | never hold customer funds; use licensed partner | Founder + counsel |
| R10 | Low beta adoption | Med | Med | accountant partner pilots; free calculators for SEO | Marketing |

## 21.6 Review Board checkpoints

| Review | When | Scope | Gate |
|---|---|---|---|
| #1 | end of S0 | accounting core design, money math, ledger invariants, report formulas, payroll engine method & tables | design approved; findings fixed |
| #2 | end of S5 | full alpha walkthrough with real-world scenarios | alpha may continue |
| #3 | end of S8 | go/no-go for public beta | beta launch |
| Per-state | Feb–Apr | each state payroll engine + current-year tables, golden paychecks | state goes live |
