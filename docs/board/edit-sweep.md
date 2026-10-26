# CPA sweep: where people expect "edit" in zAccountant (2026-10-25)

Reviewed from the code (routes, database permissions, screens) by the Board's CPA reviewer.
The ledger design itself is sound: nothing that holds posted history is changed in place. The gaps are below.

## Fix first: accounting-integrity bugs
| # | Problem | Fix |
|---|---|---|
| B1 | Reversing a Banking-posted (or bank-matched) entry from the Transactions tab leaves the bank line marked done. | Refuse; send to Banking → Undo. |
| B2 | Voiding a paycheck, tax deposit, trip cost or journal entry doesn't check bank matches or finished reconciliations (payments already do). | One shared check for all. |
| B3 | Transactions shows "reverse" on invoice/bill/payment/trip entries that the server always refuses. | Show where to void it instead. |
| B4 | A trip's project % shares can change after one project has billed, so billing can stop adding up to 100%. | Freeze the share of a project that has billed. |
| B5 | Old invoices and pay stubs reprint with today's names, addresses and letterhead. | Store a copy on the document when issued. Needed before employee edit. |
| B6 | Cancelling an open reconciliation isn't audited. | Audit it. |
| B7 | Cancelling an open reconciliation never deleted it (its trigger returned NULL on DELETE), so a new one couldn't start. Found in batch 4. | Trigger fixed (migration 031). |

## Missing edits, in build order
| Batch | Items | CPA: before alpha? |
|---|---|---|
| 1 (small fixes) ✓ PR 52 | B1-B4, B6; rename departments; rename passkeys | yes |
| 2 (master data) ✓ PR 53 | company name, fiscal-year start (state: block once payroll ran); account turn off (no delete: history must keep adding up) and re-classify; recurring entry edit + restart; bank rule edit (employee address moved to batch 3) | yes (except state, re-classify, bank rule) |
| 3 (employees) ✓ PR 54 | employee address; store details on each paycheck (B5), then edit employee (pay rate, W-4, state elections, name), terminate/rehire | yes |
| 4 (ledger corrections) ✓ PR 55 | journal entry Edit = reverse + corrected copy; fix memo/due date/PO on a paid invoice; void a whole payroll run and re-run the period; reopen the latest reconciliation; undo a bank statement import | yes |
| 5 (security) | change password (current password + 2FA), password reset, change name/email | password change yes |
| Later | prior-year paycheck correction (W-2c), one-click bank re-categorize, deposit edit, restore dismissed road item, withdraw feedback | nice to have |

Already correct: accounts (rename), invoices/bills/payments/trip costs (void, or Edit = void + corrected copy), contacts, invoice items, letterhead and payroll settings, closing the books, projects, trips, time entries, paychecks (void newest first), imports (undo), roles, members, home cards.
