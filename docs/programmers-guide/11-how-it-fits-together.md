# 11. How the pieces fit together

Chapter 5 describes each feature on its own. This chapter is the general arrangement drawing: the main tables, how
they connect, and the path a real job takes through them, from an hour worked to a line on the tax summary.

## The one idea: everything ends in the ledger

Every feature that involves money writes a **journal entry** (`journal_entries` + `journal_lines`). Invoices, bills,
payments, trip costs, paychecks, tax deposits, bank lines and imports are all "source documents" that each post one
balanced entry and remember its id (`journal_entry_id`). Reports read only the ledger. So:

- a new feature that moves money must post through `ledgerService` (never write `journal_lines` directly);
- the reports never need to know a new feature exists;
- correcting a source document means voiding it (its entry is reversed by a new entry) and, for an edit, posting a
  corrected copy. Nothing posted is changed in place.

```
             people & access                     source documents (each posts ONE entry)              the ledger            outputs
 ┌──────────────────────────────┐   ┌────────────────────────────────────────────────────────────┐   ┌───────────────────┐   ┌──────────────────┐
 │ users ── memberships ── companies   │ documents (invoices, bills) ── document_lines              │   │ journal_entries   │   │ reports          │
 │ (role, department)  │        │   │ payments ── payment_applications ──▶ documents             │──▶│   └ journal_lines │──▶│ (P&L, balance     │
 │ passkeys, sessions  │        │   │ trip_costs (trips ── trip_jobs ──▶ jobs)                   │   │       └▶ accounts │   │  sheet, aging,    │
 └─────────────────────┼────────┘   │ paychecks ── payroll_runs, payroll_deposits                │   └─────────┬─────────┘   │  tax summary,     │
                       │            │ bank_transactions (posted or matched)                      │             │             │  1099, W-2, CSV)  │
                       ▼            │ import_batches, recurring_entries                          │             ▼             └──────────────────┘
          every company table       └────────────────────────────────────────────────────────────┘        audit_log
          has company_id + RLS                                                                       (HMAC chain, every change)
```

## The main tables, grouped

| Group | Tables | Notes |
|---|---|---|
| People | `users`, `sessions`, `passkeys`, `auth_challenges` | no `company_id`: a person may belong to several companies |
| Company and access | `companies`, `memberships`, `company_roles`, `departments`, `company_plans`, `plan_changes` | a membership joins a user to a company with a role |
| The ledger | `accounts`, `journal_entries`, `journal_lines`, `audit_log`, `recurring_entries`, `books_checks` | the foundation; the database itself refuses unbalanced or edited entries |
| Customers and vendors | `contacts` (`kind` customer or vendor), `documents`, `document_lines`, `payments`, `payment_applications`, `payment_photos` | an invoice and a bill are the same table, told apart by `kind` |
| Invoice setup | `invoice_items` (saved rates), `company_logos`, letterhead columns on `companies` | |
| Projects and time | `jobs` (projects), `time_entries` | the Timesheets and Projects features share `jobs` |
| Travel | `trips`, `trip_jobs` (each project's share), `trip_costs`, `trip_cost_photos`, `mileage_drives` | a trip cost posts its own entry |
| The phone | `road_keys`, `road_items`, `road_photos` | an inbox: nothing reaches the books until Accept at the desk |
| Banking | `bank_transactions`, `bank_rules`, `reconciliations`, `reconciliation_lines`, `import_batches` | a bank line is `review`, `posted`, `matched` or `excluded` |
| Payroll | `employees`, `paychecks`, `payroll_runs`, `payroll_deposits` | each paycheck keeps its own copy of the employee and the calculation |
| Tax-ready | `account_tax_categories` | one category per income or expense account |
| Per person | `home_layouts` | which Home cards each person shows |
| zAccountant itself | `feedback_reports`, `offsite_backups` | no business data |

**Two-column foreign keys.** Most links are `(company_id, id)` pairs, not just `id`. A payment of company A can
therefore never point at an invoice of company B: the database refuses the pair. This is on top of row-level security,
which hides company B's rows altogether (chapter 3).

**Built-in accounts are found by key, not by number.** Code asks for "the Accounts Receivable account" or "Sales Tax
Payable" by its `accounts.system_key`, so a company that renumbers or renames its chart doesn't break posting. The standard chart
a new company gets is in `src/core/chartOfAccounts.js`.

## A job's path through the system

Follow Homer's typical engineering job, and watch which tables each step touches.

1. **Project.** Sales → Projects adds a `jobs` row (number, name, customer, site address), or many at once from pasted
   folder names (`src/core/projects.js`).
2. **Time.** An engineer enters hours on the Time tab: a `time_entries` row in whole minutes, `billable`, against the
   job. No money moves yet; time is not in the ledger until it is billed or paid.
3. **A trip.** A site visit becomes a `trips` row with the projects sharing it (`trip_jobs`, shares in hundredths of a
   percent, optionally different for air, hotel, car and the rest). Costs typed on the phone's Road page wait in
   `road_items`; at the desk **Accept** turns each into a `trip_costs` row, which posts its own entry (Dr travel expense,
   Cr the card or bank, or Owner's equity when paid personally). MileIQ's monthly file adds mileage costs the same way,
   remembering each drive in `mileage_drives` so a second import adds nothing. Travel time is a `time_entries` row with
   `trip_id`.
4. **A bill passed on.** A vendor's bill (a `documents` row, `kind = 'bill'`) for equipment rental can mark a line
   "bill to client" with the project (`document_lines.job_id`, `billable`). Posting: Dr expense, Cr Accounts Payable.
5. **The invoice.** New invoice → *Pull in unbilled time and costs* asks `GET …/unbilled` for everything billable on
   the project not yet on a posted invoice: time (hours × rate), passed-on bill lines, trip costs and trip time at the
   project's share. Each invoice line remembers its source (`time_entry_id`, `billed_line_id` or `trip_cost_id`), and the
   trigger `zacc_bill_once` makes sure each source is billed only once per project. Saving posts Dr Accounts
   Receivable, Cr income for each line, Cr Sales Tax Payable.
6. **Paid.** The customer's check arrives (perhaps photographed on the Road page as a check item). Receive payment
   writes a `payments` row and `payment_applications` rows tying it to the invoice; posting is Dr the bank account it
   was deposited to, Cr Accounts Receivable. Photos and the deposit PDF go in `payment_photos`. If the invoice is on a
   payment plan, the plan's schedule decides what is past due; if it is late and not on a plan, the monthly late-charge
   run may add a separate small invoice.
7. **The bank statement.** Banking imports the month's CSV, QFX or PDF into `bank_transactions`. The deposit line is
   **matched** to the payment's entry (no new entry; `journal_entry_id` points at the existing one), and each card
   charge either matches a trip cost or is **posted** as a new entry. Reconciliation ticks the lines
   (`reconciliation_lines`) until the difference is $0.00 and locks them.
8. **Paying people.** Approved time feeds a payroll run (`payroll_runs`, `paychecks`); each paycheck posts Dr wages and
   employer taxes, Cr the bank and the tax liabilities. A tax deposit (`payroll_deposits`) later clears those
   liabilities. Paid time is locked (`time_entries.paid_run_id`).
9. **Closing the month.** Settings → Close the books sets `companies.locked_through`; the database then refuses any
   entry dated on or before it. The nightly books check proves the trial balance, the balance sheet and the aging tie
   out, and re-verifies the audit chain.
10. **Reports and tax.** Every report reads the ledger: the P&L, the balance sheet, the aging (open documents, which
    must equal the Accounts Receivable and Payable balances), the Statistics card, and Tax-ready's summary, which puts
    each income and expense account on a line of the company's return through `account_tax_categories`.

At every step one `audit_log` row is written in the same transaction, so the history of who did what can be proved.

## What stops the pieces from drifting apart

| Risk | What holds it |
|---|---|
| An invoice says $1,000 but its entry says $999 | the entry is built from the same lines in the same transaction; the aging check compares open documents with the control accounts every night |
| An hour or a cost billed twice | `zacc_bill_once` trigger, with an advisory lock so two invoices saved together take turns |
| A billed hour changed afterwards | `zacc_time_billed_final`; a bill with a billed cost can't be voided until its invoice is |
| A payment larger than what's owed | `payment_applications_no_overpay` |
| Editing an invoice that has payments | the payments move to the corrected copy (`payment_applications_move`, migration 039); the payments' own entries never change, so bank matches and reconciliations stand |
| Reversing something the bank already agrees with | `ledgerService.assertNotCleared` refuses it; undo it in Banking first |
| A change inside a closed month | `journal_entries_period_open` trigger |
| A company seeing another's data | row-level security plus two-column foreign keys |

## Adding a new kind of source document

When a future feature moves money (Stripe subscription fees, Plaid bank feeds, a new kind of receipt), follow the
pattern the existing ones share:

1. A table with `company_id`, row-level security, a `journal_entry_id`, and void columns (`status`, `void_entry_id`,
   `void_date`) or a `replaced_by_id` if it can be edited (chapter 4).
2. A service function that checks the input, posts the entry through `ledgerService`, saves the row with the entry id,
   and writes one audit row, all inside the request's transaction.
3. A new `journal_entries.source` value (chapter 2 lists them), and an `ENTRY_OWNER` entry in `public/app.js` so the Transactions tab says
   where to change it.
4. If the book file or QuickBooks export should name its customer or vendor, check `bookFileService.js`.
5. Tests with hand-worked numbers, and an HTTP test as the restricted login (chapter 8).
