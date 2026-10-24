# Professional Review Board — Review #1 (Sprint 0)

**Date:** October 24, 2026  **Scope:** accounting core, financial statements, payroll engine and 2026 tax tables, security of the foundation.

> **Important:** this review was carried out by AI reviewers acting in the roles of the Board
> (CPA, Certified Payroll Professional, security reviewer). It finds real bugs and checks values against
> official sources, but it is **not** a professional certification. Before any tax table is marked
> `verified: true` and payroll leaves calculate-only mode, a credentialed human CPA/CPP must sign off
> (Section 13 certification gate). All tables therefore remain `verified: false`.

## Verdicts

| Reviewer | Verdict at review | After fixes in this sprint |
|---|---|---|
| CPA (ledger & statements) | Approve with conditions (items 1–6) | Conditions met |
| Security | Not approved (2 blockers, 2 majors) | Blockers and CSRF fixed; audit-anchoring and DB roles scheduled for Sprint 1 |
| Payroll (CPP) — Federal | Certify after fixes | Fixed; ready for human sign-off |
| Payroll — TX | Certify | Ready for human sign-off |
| Payroll — CO | Certify after fixes | Fixed; ready for human sign-off (new-employer UI rate varies by industry) |
| Payroll — CA | Certify after fixes | Fixed; DE 44 Example E reproduced exactly; 1–2¢ per-period rounding open |
| Payroll — DC | Not ready | Method fixed; $4,150 allowance confirmed only in the 2018 FR-230. Needs OTR confirmation |

## Findings and disposition

### CPA

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Major | Equipment sale: cash-flow put proceeds in operating | **Fixed.** Depreciation add-back from accumulated-depreciation credits; disposals go to investing at proceeds; gain/loss backed out of operating; new account 4950 Gain (Loss) on Sale of Assets. Test added. |
| 2 | Major | Non-cash investing/financing (equipment bought with a loan) shown as cash | **Fixed.** Detected and shown as a supplemental disclosure (ASC 230). Tests added. |
| 3 | Major | Trial balance disagreed with balance sheet after year one | **Fixed.** Trial balance is now post-closing (prior-year profit in Retained Earnings). Test added. |
| 4 | Major | Reversing a payroll entry left YTD wages wrong | **Fixed.** Payroll entries can't be reversed directly; new *void paycheck* writes a negative paycheck row and restores YTD. Tests added. |
| 5 | Major | Net Pay Payable never cleared | **Fixed.** A paycheck can be paid from a bank account (default in the UI); tax liabilities are paid with "Money out". Tax-deposit workflow planned for Sprint 6. |
| 6 | Major | `amount: 100` meant $1.00 | **Fixed.** `amount` is always dollars; `amountCents` for cents. Test added. |
| 7 | Minor | Contra-account cash-flow label inverted | **Fixed** ("Depreciation and amortization"). |
| 8 | Minor | Reversing an entry in a closed period failed; reversal could predate original | **Fixed.** Defaults to the first open day; cannot predate the original. Test added. |
| 9 | Minor | Huge amounts could overflow totals | **Fixed.** $1B per-line cap in code and in a database CHECK constraint. |
| 10 | Minor | Weak lock-date validation; reopening needs no reason | **Fixed** (real-date check; reopening requires a reason, audited). Role/MFA check is Sprint 1. |
| 11 | Minor | Direct postings to Retained Earnings | **Fixed.** Blocked except reversals/imports. |
| 12 | Minor | New accounts defaulted to operating cash flow | **Fixed.** Cash-flow section follows the account kind (fixed → investing, long-term loan → financing). |
| 13–14 | Suggestion | Year-end roll of draws to capital; classified balance sheet | Backlog (Sprint 7). |
| 15 | Suggestion | Audit hash doesn't cover ledger | **Fixed.** Verification now reconciles every ledger entry against the audit trail. |

### Security

| # | Severity | Finding | Disposition |
|---|---|---|---|
| B1 | Blocker | One entry with enormous amounts breaks every report | **Fixed** ($1B line cap + DB CHECK + validation). Test added. |
| B2 | Blocker | Concurrent paychecks computed wrong YTD | **Fixed.** YTD = SUM of paychecks under the company lock; idempotency key on paycheck posting. Concurrency test added. |
| M1 | Major | CSRF / DNS rebinding against the local server | **Fixed.** Host allow-list (`ALLOWED_HOSTS`), JSON-only + same-origin check on writes. Tests added. |
| M2 | Major | Audit chain forgeable with DB access | **Partly fixed:** HMAC with key held outside the DB, per-company sequence numbers, company id in the hash, ledger reconciliation. **Sprint 1:** KMS-held key, daily external anchoring of the chain head, separate migration/runtime DB roles, RLS. |
| — | Minor | Several bad inputs returned 500 / leaked DB text | **Fixed.** Readable 4xx messages; raw database errors never returned. API test covers each case. |
| — | Minor | Reversal FK and lookups not company-scoped; memo unbounded; client could override salary gross | **Fixed.** |
| — | Suggestion | Tighten CSP | **Fixed** (`object-src 'none'; base-uri 'none'; form-action 'self'`). |

### Payroll (CPP)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | CA low-income exemption, standard deduction, exemption credit were 2025 values | **Fixed** with the official 2026 Method B values. DE 44 Example E ($4.13) reproduced as a test. |
| 2 | Blocker | DC withholding subtracted a standard deduction (not allowed by DC Code §47-1812.08(b)(1A)) | **Fixed.** Wages − $4,150 × D-4 allowances. |
| 3 | Major | CO default allowance missing | **Fixed:** DR 1098 line 2a — $11,000 MFJ, otherwise $5,500. |
| 4 | Major | CO ignored federal-exempt W-4 | **Fixed.** |
| 5 | Major | FAMLI small-employer test used active employee count | **Fixed.** Employer enters the FAMLI headcount; if unknown, the employer share is charged. |
| 6 | Major | Pre-2020 W-4 refused | **Fixed.** Worksheet 1A lines 1j–1l ($4,300/allowance, STANDARD table, no HoH). |
| 7 | Major | Overtime premium not tracked | **Fixed.** 0.5× premium stored on each paycheck for year-end reporting. CA daily overtime (wage-hour rule) backlog. |
| 8 | Minor | CA annualized vs DE 44 per-period tables differ by 1–2¢ in some cases | **Open.** Sprint 6: use per-period method or document. |
| 9 | Minor | Step 2 checkbox thresholds differed by 1–2¢ | **Fixed.** Engine now uses the official Pub 15-T annual tables exactly as printed (with a test proving the STANDARD table agrees with the 2026 brackets). |
| 10 | Minor | W-4 exempt status expiry (Feb 15) and DR 0004 cancellation rules | Backlog (Sprint 6). |
| 11 | Suggestion | Accrue CA FUTA credit reduction during the year | Backlog (Sprint 6). |
| 12 | Suggestion | YTD from last snapshot | **Fixed** (see B2). |

## Values verified against official sources
Federal brackets, standard deductions, line 1g amounts, Step 2 and STANDARD tables (2026 Pub 15-T); SS wage base $184,500;
TX UI $9,000 / 2.7%; CO 4.4%, DR 1098 allowances, FAMLI 0.88%, UI base $30,600; CA 2026 Method B values and brackets,
SDI 1.3%, UI/ETT; DC brackets, UI base and 0.2% assessment. Sources are recorded in `src/payroll/tables/2026.json`.

**Not verifiable from an official source:** CO new-employer UI rate (varies by industry), DC $4,150 allowance for 2026
(latest official FR-230 is 2018), DC PFL 0.75% effective date (secondary sources only).

## Next review
Review #2 at end of Sprint 5 (Dec 6): full alpha walkthrough. 2027 tables must be loaded and reviewed when the IRS and
states publish them (December).
