# Tier 1: Books (every plan)

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
  - Drag your logo (PNG or JPEG) onto the dashed box, or click it to choose the file. The box beside it shows the
    logo your invoices will print.
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

To change a customer's details, open the **Customers** tab and press **edit** on their row. The same form opens
filled in; change what you need and press **Save changes**. Invoices already written keep their numbers and amounts,
but they show the new name and address when you open or print them. Vendors work the same way under Bills → Vendors.

**A customer with divisions** (for example DWH in San Antonio and Austin): add one customer per division, such as
"DWH - SATX" and "DWH - AUS", each with its own address. Type the same name in **Part of** (DWH) on each. The aging
report then shows each division and also a DWH total.

**People** on a customer: the claims adjusters (or other contacts) you send invoices to, each with a name, email and
phone. Press **+ Add person** to add one.

### Writing an invoice

1. **+ New invoice**: choose the customer. Type an invoice number (your job number, such as 26-134), or leave it
   empty to get the next number automatically. Set the date.
   If that number is already used, the invoice gets the next letter: typing 2601 a second time saves **2601A**,
   then 2601B, and after 2601Z comes 2601AA. A message tells you the number it was saved under.
2. **Attention**: pick the adjuster from the customer's people, and **Send to** fills in with their email. A name
   you type that isn't saved yet gets a tick box, "Save … to DWH - SATX for next time". **Claim / job number** is
   the client's own number; it prints in the box with the invoice number.
   **Project** (optional): the project name and site address. They print beside Bill To.
   **Project** (the list above the project block): pick it and the customer, the project block (name and site
   address) and the invoice number (the project number) fill in when they're empty.
   **⏱ Pull in unbilled time and costs** lists the project's billable hours from timesheets and the costs on bills
   marked "bill to client" that aren't on an invoice yet. Pick the rate for the hours (Eng Std Rate…) and the item for
   the costs, untick anything to leave for later, and press **Add … lines**. Each hour or cost can be billed only
   once: it drops off the list when the invoice is saved, and comes back if that invoice is voided. Leave the project
   empty to see everything for all of the customer's projects. Hours are billed to 4 decimals (50 minutes = 0.8333 h).
3. For each line:
   - **Rate or item:** pick one, and the rate, tax and income account fill in.
   - **Date:** the day the work was done or the cost was incurred.
   - **Task / description:** Report, Site visit, Deposition…
   - **Hours / qty:** hours for a rate; usually 1 for a cost.
   - **Rate / price:** change it for a one-off rate (for example 1.25 × your standard rate).
   - **Tax:** tick it if the line is taxable.
   - **Jobs sharing these expenses** (top of the lines): when one trip served several jobs, set the number of
     jobs (1 by default, never less). Each cost passed on (lodging, rental car, airfare) gets quantity 1/3 for
     3 jobs, so $350 of lodging bills $116.67. Hourly rates aren't split. Write one invoice per job with the same
     number. To split one cost differently, type its quantity yourself (0.5, 1/4…); it stays as you typed it.
4. **Sales tax rate %:** type it (for example 8.25). Press **📌 Save 8.25% as the default** and every new invoice
   starts with it. Only lines with Tax ticked are taxed. The tax is worked on their total, rounded to the cent once.
5. Check the subtotal, tax and total, then **Save invoice**. Saving records the income and what the customer owes
   (Accounts Receivable).

**Print / Save PDF** prints the invoice with your logo, letterhead, Bill To, Project, invoice number, date, due
date, terms, the lines (Hours, Date, Description, Rate, Tax, Amount), sales tax, total, payments and balance due.
In the print window, choose "Save as PDF" to email it.

**✉ Email** opens your computer's email program (Outlook, Mail…) with the Send to address, a subject (invoice
number, claim number and project) and a short note filled in. Attach the PDF yourself; zAccountant doesn't send email
itself yet. On Windows, the button opens whichever program is set under Settings → Apps → Default apps → "mailto".

### Getting paid

**Receive payment**: choose the customer, the date, the bank account it went into and the method. Then enter how
much goes to each open invoice (**Pay all in full** fills them in). One payment can cover several invoices.

### Photos of the check

When a customer pays by check, you can keep a photo of the check and of the printed remittance (the slip that names
the invoice) with the payment. On an iPhone, open zAccountant in Safari: in **Receive payment**, press **📷 Take
photo** and the camera opens. **Choose photo** picks one you already took. Add up to 6 photos, then **Save payment**.

- To see them later, or add one you forgot, open the **Payments** tab and press **photos** (or **add photo**) on the
  payment's row. Press a photo to open it full size.
- A photo is a record only. It doesn't deposit the check; take the check to the bank as usual.
- A check photo shows the customer's bank account numbers. Only people in your company can see it.
- If you edit the payment, its photos stay with the corrected payment.

### Mistakes and reports

- To fix a mistake on an invoice, open it and press **Edit**. The form opens filled in; change what's wrong and press
  **Save changes**. Behind the scenes the old invoice is voided and the corrected one takes its place with the same
  number. The old one stays in the Voided list, marked "Replaced". Bills work the same way.
- To fix a payment (wrong amount, date or check number), open the **Payments** tab and press **edit** on its row.
- An invoice that already has a payment can't be edited until the payment is fixed: edit or void the payment first.
- An invoice with no payments can also be **voided** outright. It stays on record, marked void.
- Edit and Void need the owner's or accountant's permission, because both reverse a saved entry.
- The **Aging report** shows who owes you and how late, in 30-day groups, and checks that it agrees with Accounts
  Receivable.

## 5. Bills: paying vendors

Bills work like invoices in reverse. Add a vendor (tick **1099** for contractors you will report at year end).
Enter each **bill** with its expense accounts when it arrives. Press **Pay bills** when you pay. Until then the bill
sits in Accounts Payable, so your profit is right even before you pay. The **Aging report** shows what you owe and
what's overdue.

**Costs you pass on to a client** (airfare, rental car, lodging): on the bill line, pick the **Project** and leave
**Bill to client** ticked. The cost then waits on that project's "Pull in unbilled time and costs" list. A cost paid
by credit card is entered the same way: a bill from the airline, paid from the credit card account. A bill whose cost
is already on an invoice can't be edited or voided until that invoice is.

### Projects

**Sales → Projects** lists your projects (the same list as the jobs on the Time tab): number, name, customer and site
address. **+ New project** adds one. To add many at once from your project folders:

1. In File Explorer, open the folder that holds your project folders and select them (Ctrl+A for all).
2. Hold **Shift**, right-click one of them, and choose **Copy as path**.
3. In Projects, open **Add projects from your folder names**, paste, and press **Check the list**. The number at the
   start of each folder name (2601 in "2601 Smith Residence") becomes the project number. Projects already on the
   list are skipped. Pick a customer to set it on all of the new ones, then press **Add … new projects**.

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
| Tax Summary | income and expenses on the lines of your federal return (Schedule C, 1065, 1120-S or 1120) |
| 1099-NEC | what each vendor marked 1099 was paid in a tax year, and who needs a form |
| W-2 / W-3 (payroll role) | each employee's W-2 boxes for the year, and the W-3 totals |

**Compare with** "the period before" or "a year earlier" shows both side by side, with the change in dollars and
percent. **Download CSV** opens in Excel. **Print / Save PDF** prints only the report. Each statement shows "✓ This
report ties out" when its own check passes. If you ever see ⚠, please send a 🐞 Beta feedback report.

**Tax-ready** (the last three reports) gives your tax preparer totals; nothing is filed or printed as a form.
- **Tax Summary** uses the type of business you chose at setup to pick the return. Each income and expense account
  has a *tax category* (advertising, rent, wages…) that puts it on a line. Ones marked *suggested* are our guess from the
  account's name: check each and change it in the list beside the account, or press **accept all suggestions** to keep
  them. Some items go elsewhere (interest income to Schedule B or Schedule K, asset sales to Form 4797) and are listed
  separately. Meals are shown in full; generally half is deductible. Line numbers follow the IRS's 2025 instructions.
- **1099-NEC**: pick the tax year. A form is needed for each vendor marked 1099 (Bills → Vendors) paid **$600** or more in
  2025, or **$2,000** or more from 2026, by cash, check or ACH. Card payments are left out: the card company reports them
  on a 1099-K. You still need each vendor's tax ID from their Form W-9. *Worth a second look* lists vendors not marked
  1099 who were paid over the amount.
- **W-2 / W-3**: boxes 1–6, box 12 code D (401(k)) and the state boxes, by pay date. Box 12 DD and box 14 are not
  tracked yet.

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
