# Tier 1: Books (Basic plan)

Every company has these. They are double-entry books: every transaction takes money out of one account and puts it
into another, so the books always balance. You don't need to know debits and credits for everyday work.

## 1. First steps for a new company

1. **Bring in what you have.** Coming from QuickBooks or a spreadsheet: see section 9. Starting fresh: record your
   bank balance as of the start date (section 3).
2. **Check your accounts** (Accounts tab). Add your bank accounts and credit cards if they aren't listed.
3. **Set up invoicing** (section 4): letterhead, logo, rates.
4. **Invite people** (section 8).

## 2. Home

The tiles show cash in the bank, and income, expenses and profit for this fiscal year. "✓ Your books are in balance"
is checked every time the page loads. A full check of the books also runs every night.

## 3. Recording transactions

- **Quick way (Home → Record a transaction):** choose *Money in*, *Money out* or *Transfer*. Enter the date, a
  description, the amount, the bank account, and what it was for. That's a complete, balanced entry.
- **Advanced journal entry (Transactions tab):** for anything else, such as depreciation, or a loan payment split
  into principal and interest. Each line is a debit or a credit, and the entry saves only when the "Difference" is
  $0.00. Rule of thumb: money arriving in an account you own is a debit; income is a credit.
- **Mistakes are never erased.** Press **reverse** on an entry: a new entry cancels it out, and the history stays
  complete for your accountant. Then enter it again correctly.
- **Recurring entries** (rent, a loan payment): tick "repeat" on a journal entry. Entries that are due post each
  night, or press **Post due entries now**.
- **Search** by words, dates, account, an amount range, or where the entry came from (bank, invoice, payroll…).

## 4. Sales: invoices and getting paid

### Set up once (Settings, owner or anyone with company-settings permission)

- **Invoice letterhead and logo:**
  - Upload your logo (PNG or JPEG).
  - Type the address that prints under your company name.
  - Add a note for every invoice, such as your **tax ID** and **state engineering firm number**.
  - Add a closing line ("Thank you for using us for your Engineering Consulting Services").
- **Invoice rates and items:**
  - These are your hourly rates (Eng Std Rate, Eng Overtime Rate, Drafting…) and the costs you pass on
    (equipment rental, lodging, rental car, airfare).
  - **Start with an engineering firm's list** adds the usual names. Then press **edit** on each one and type your
    price, whether it is taxable, and the income account it goes to.
  - Leave the price empty for costs that change every time.
  - **hide** removes a rate from the invoice list without losing its history.

### Customers

**+ New customer**: name, email, address (it prints in the Bill To box), and payment terms in days (20 days means
the invoice is due 20 days after its date).

### Writing an invoice

1. **+ New invoice**: choose the customer. Type an invoice number (your job number, such as 26-134), or leave it
   empty to get the next number automatically. Set the date.
2. **Project** (optional): the project name and site address. They print beside Bill To.
3. For each line:
   - **Rate or item:** pick one, and the rate, tax and income account fill in.
   - **Date:** the day the work was done or the cost was incurred.
   - **Task / description:** Report, Site visit, Deposition…
   - **Hours / qty:** hours for a rate; usually 1 for a cost.
   - **Rate / price:** change it for a one-off rate (for example 1.25 × your standard rate).
   - **Tax:** tick it if the line is taxable.
4. **Sales tax rate %:** type it (for example 8.25). Press **📌 Save 8.25% as the default** and every new invoice
   starts with it. Only lines with Tax ticked are taxed. The tax is worked on their total, rounded to the cent once.
5. Check the subtotal, tax and total, then **Save invoice**. Saving records the income and what the customer owes
   (Accounts Receivable).

**Print / Save PDF** prints the invoice with your logo, letterhead, Bill To, Project, invoice number, date, due
date, terms, the lines (Hours, Date, Description, Rate, Tax, Amount), sales tax, total, payments and balance due.
In the print window, choose "Save as PDF" to email it.

### Getting paid

**Receive payment**: choose the customer, the date, the bank account it went into and the method. Then enter how
much goes to each open invoice (**Pay all in full** fills them in). One payment can cover several invoices.

### Mistakes and reports

- An invoice with no payments can be **voided**. It stays on record, marked void. To undo a payment, void the
  payment first.
- The **Aging report** shows who owes you and how late, in 30-day groups, and checks that it agrees with Accounts
  Receivable.

## 5. Bills: paying vendors

Bills work like invoices in reverse. Add a vendor (tick **1099** for contractors you will report at year end).
Enter each **bill** with its expense accounts when it arrives. Press **Pay bills** when you pay. Until then the bill
sits in Accounts Payable, so your profit is right even before you pay. The **Aging report** shows what you owe and
what's overdue.

## 6. Banking

1. **Import** a statement downloaded from your bank's website as **CSV** or **QFX/OFX**. Importing the same dates
   twice is safe: repeats are skipped.
2. **Review** each line under *To review*:
   - **Add**: choose what it was for, and it's recorded.
   - **Match**: it's already in your books (for example a customer payment you recorded). Link them so it isn't
     counted twice.
   - **exclude**: not a real transaction. **undo** puts a line back.
3. **Rules** suggest an account when the description contains certain words ("home depot" → Materials). You still
   confirm each one.
4. **Reconcile monthly:** enter the statement date and ending balance, tick every item on the statement, and press
   finish when the difference is $0.00. Reconciled items are locked.

## 7. Reports

| Report | Answers |
|---|---|
| Balance Sheet | what the business owns and owes on a date (Assets = Liabilities + Equity) |
| Profit & Loss | income minus expenses for a period |
| Cash Flow | why cash went up or down: operations, equipment, loans and owner money |
| Trial Balance | every account's balance; what your accountant asks for |
| AR / AP Aging (on the Sales and Bills tabs) | who owes you, whom you owe, and how late |

**Compare with** "the period before" or "a year earlier" shows both side by side, with the change in dollars and
percent. **Download CSV** opens in Excel. **Print / Save PDF** prints only the report. Each statement shows "✓ This
report ties out" when its own check passes. If you ever see ⚠, please send a 🐞 Beta feedback report.

## 8. Settings

- **People with access:** the person creates a zAccountant account first. Then add them by email and choose a
  role. **change** or **remove** them later.
- **Roles:** five are built in. **+ New role** makes a custom mix, for example a project manager who sees reports and
  approves timesheets but doesn't record transactions.
- **Departments:** group people (Accounting, Engineering, Field). A department's approver approves its timesheets.
- **Invoice letterhead and logo**, **Invoice rates and items:** see section 4.
- **Back up your books:** while zAccountant is in alpha testing, keep your own copy. **Download chart of accounts**
  and **Download all transactions** give two CSV files that open in Excel. To rebuild the books, make a new
  company and import them (Accounts → Import): the chart of accounts first, then the transactions. Every report
  comes back the same. Invoice and bill details, customers, employees and timesheets are not in these files, so keep
  your saved invoices and pay stubs too. Anyone who can see the books can download them.
- **Close the books:** after a month or year is final (usually after the bank is reconciled and your accountant is
  done), close through its last day. Nothing dated on or before that day can be added or changed. Only the owner
  can reopen, with a two-step code and a reason, and that is logged.
- **Audit trail:** every change is written to a tamper-evident log. **Verify audit trail** checks every record.
  **Run full check now** also proves the trial balance and balance sheet balance; this runs every night by itself.

## 9. Accounts and importing your books

- **Chart of accounts:** the list of buckets. **Add account** for a new bank account, credit card, vehicle, or an
  expense you want tracked separately. The type decides where it appears on the reports. Click an account to see
  its **register**: every transaction with a running balance.
- **Importing from QuickBooks or Excel** (Accounts → Import), in this order:
  1. **Chart of accounts:** QuickBooks Reports → Account List → Export, or fill in our template.
  2. **Opening balances:** a trial balance as of the day before you start in zAccountant.
  3. **Transactions** since then: QuickBooks Reports → Journal → Export, or an IIF file.

  Each file is checked first, and you see what it holds. Nothing is saved until you press **Import**, and every
  import can be undone.
