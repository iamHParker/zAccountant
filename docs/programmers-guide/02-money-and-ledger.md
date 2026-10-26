# 2. Money, rounding and the ledger

## Money is integer cents

Floating-point numbers can't hold 0.10 exactly (0.1 + 0.2 = 0.30000000000000004), so a sum of thousands of them
drifts. zAccountant never stores or adds dollars as floating point.

- **Storage:** PostgreSQL `bigint` cents. `src/db/pool.js` turns `bigint` into a JavaScript `Number` and refuses
  any value beyond about $90 trillion.
- **Input:** people type `"1,234.56"`. `toCents()` (`src/core/money.js`) parses the text exactly. It never calls
  `parseFloat`.
- **Rates:** a percent string like `"8.25"` becomes integer parts-per-million (`percentToPpm("8.25") = 82500`).
- **Multiplying:** use BigInt and round once, half-up (`applyRate`, `divRoundHalfUp`). Quantities such as hours keep
  up to 4 decimals (`lineAmount` in `arapService.js`). Every number parser takes a missing leading zero: ".5" hours,
  ".5" miles, "$.725" a mile and ".5" % mean 0.5 (`cleanQuantity` stores ".5" as "0.5"); keep new parsers the same.
- **Splitting:** `allocate(cents, weights)` splits a total so the parts always add back to the total, giving the
  leftover cents to the largest remainders. Use it for any proration.
- **Display:** `formatMoney` on the server and `money()` in the browser. The browser copies of `lineCents` and
  `taxCents` only preview a total; the server's number is the one saved.

Worked check (Homer's invoice 26-134): 2.5 h × $531.25 = $1,328.125, which rounds half-up to **$1,328.13**. Tax is
8.25% × $1,328.13 = $109.5707, which rounds to **$109.57**. The total is **$1,437.70**, the same as his Excel sheet.
Tests write hand calculations like this in comments next to the numbers they check.

## The ledger

Every transaction is a `journal_entries` row with two or more `journal_lines`. Each line is a debit or a credit to
one account. The rules below are enforced by the **database**, so even a bug in the app can't break them:

| Rule | Where it is enforced |
|---|---|
| Debits = credits for every entry | `validateEntry` in `src/core/ledger.js`, then the deferred constraint trigger `journal_lines_balanced` at COMMIT |
| An entry has lines | `journal_entries_have_lines` |
| No edits or deletes of posted entries, lines, audit rows, paychecks, runs, deposits | `zacc_immutable()` triggers |
| Nothing dated in a closed period | `journal_entries_period_open` (reads `companies.locked_through`) |
| Accounts Receivable/Payable change only through invoices, bills and payments | control-account checks in `ledgerService` |
| A payment can't exceed what's owed | `payment_applications_no_overpay` |
| A reconciled statement is final | `reconciliations_final`, `reconciliation_lines_open` |

**Fixing a mistake** means posting a reversing entry (`reverseEntry`), or voiding a document, which reverses its
entry. History stays complete, which is what an auditor expects.

## Where amounts come from

| Source (`journal_entries.source`) | Made by |
|---|---|
| `manual` | Transactions tab (advanced journal entry) |
| `simple` | Home → Record a transaction (money in, money out, transfer) |
| `bank` | Banking review (adding a bank line) |
| `invoice`, `bill`, `payment` | `arapService.js` |
| `payroll` | `payrollService.js`: paychecks, payroll runs and tax deposits |
| `import` | `importService.js` (QuickBooks/Excel/IIF; can be undone as a batch) |
| `recurring` | the nightly job or "Post due entries now" |
| `reversal` | reversing an entry, or voiding a document, paycheck or deposit |

## The audit chain

`appendAudit(db, companyId, { action, entity, entityId, actor, payload })` (`src/services/audit.js`) adds a row whose
hash covers the previous row's hash, keyed with `AUDIT_HMAC_KEY`. Changing, inserting or reordering any row breaks
the chain. `verifyChain` recomputes it and also checks every ledger line against what the audit trail recorded.
**Every service function that changes data writes one audit row in the same transaction.** Record facts in the
payload (ids, amounts, what changed), never secrets or pictures.

## Reports tie out

Statements come from `src/core/reports.js` (pure) fed by `reportService.js`. Each one carries its own proof: the
balance sheet balances, the aging totals equal Accounts Receivable/Payable, and the trial balance's debits equal its
credits. The nightly books check (`src/jobs/booksCheck.js`) runs these proofs for every company.
