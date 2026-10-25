// Help center v1: short, plain-English guides, one per task. Shown on the Help tab and opened by the
// "?" button for the screen you're on (`tab`). Written for small-business owners, not accountants.
// Keep button and field names exactly as they appear on screen.

export const HELP = [
  {
    id: 'start', tab: 'home', title: 'Getting started',
    words: 'setup new company first steps welcome dashboard',
    html: `
<p>zAccountant keeps <strong>double-entry books</strong>: every transaction moves money from one account to another,
so the books always balance. You don't need to know debits and credits for everyday work; the simple screens handle them.</p>
<ol>
  <li><strong>Create your company</strong> (name, type of business, home state, fiscal-year start, the day your books start). A standard chart of accounts is added,
      and the <strong>setup wizard</strong> walks through the rest: your books (start fresh, QuickBooks, Excel or a zAccountant backup), bank accounts and
      cards with their opening balances, invoicing, and people. Skip any step; <em>Finish setting up</em> on Home lists what's left.</li>
  <li><strong>Bring in what you have.</strong> Coming from QuickBooks or a spreadsheet? See <a data-help="import">Importing your books</a>.
      Starting fresh? Enter your bank balance as of the start date (see <a data-help="journal">Transactions</a>).</li>
  <li><strong>Add your bank account</strong> on <em>Accounts</em> if it isn't listed, then import statements on <em>Banking</em>.</li>
  <li><strong>Invite your bookkeeper or accountant</strong> on <em>Settings → People with access</em>.</li>
</ol>
<p>The <em>Home</em> tiles show cash in the bank and income, expenses and profit for this fiscal year.
"✓ Your books are in balance" is checked every time the page loads, and the full books check runs every night.</p>`,
  },
  {
    id: 'journal', tab: 'journal', title: 'Recording transactions',
    words: 'money in money out transfer journal entry debit credit reverse recurring search',
    html: `
<p><strong>Quick way (Home → Record a transaction):</strong> choose <em>Money in</em>, <em>Money out</em> or <em>Transfer</em>,
the date, a description, the amount, the bank account, and what it was for. That's a complete, balanced entry.</p>
<p><strong>Advanced journal entry (Transactions tab):</strong> for anything else, such as depreciation or a loan payment split into
principal and interest. Each line has a debit or a credit; the entry saves only when debits equal credits
(the "Difference" shows $0.00). Rule of thumb: money arriving in an account you own is a debit; income is a credit.</p>
<p><strong>Mistakes are never erased.</strong> Press <em>Reverse</em> on an entry and a new entry cancels it out, so the
history stays complete for your accountant and the auditors. Then enter it again correctly.</p>
<p><strong>Recurring entries</strong> (rent, a monthly loan payment): tick "repeat" on a journal entry. Due entries post
automatically each night, or press <em>Post due entries now</em>.</p>
<p><strong>Finding things:</strong> search by words, dates, account, amount range or where an entry came from (bank, invoice, payroll…).</p>`,
  },
  {
    id: 'sales', tab: 'sales', title: 'Invoices and getting paid',
    words: 'invoice customer receive payment accounts receivable aging overdue void edit correct mistake photo check camera iphone adjuster attention claim division email',
    html: `
<ol>
  <li>Add a customer (name, email, payment terms such as 30 days). To change one later, open the Customers tab and press <strong>edit</strong>.
      For a customer with divisions, add each division (DWH - SATX, DWH - AUS) with the same <strong>Part of</strong> name; list
      their claims adjusters under <strong>People</strong>, then pick one in <strong>Attention</strong> on the invoice.</li>
  <li>Make a <strong>new invoice</strong>: lines with quantity, price and income account; tick taxable lines and enter the
      sales-tax rate. Saving the invoice records the income and what the customer owes you (Accounts Receivable).</li>
  <li>When the customer pays, press <strong>Receive payment</strong>, pick the bank account, and apply the money to one or
      more invoices (<em>Pay all in full</em> fills them in).</li>
</ol>
<p><strong>Aging report</strong> shows who owes you and how late, in 30-day buckets, and checks that it agrees with Accounts
Receivable in your books. Download it as CSV or print it.</p>
<p><strong>Mistake on an invoice?</strong> Open it and press <strong>Edit</strong>. Saving replaces it with the corrected one (same number); the old one stays in history marked Replaced. Payments have an <strong>edit</strong> link on the Payments tab. If an invoice already has a payment, fix the payment first.</p>
<p>An invoice with no payments can also be <strong>voided</strong>; it stays on record marked void.</p>
<p><strong>Photo of the check:</strong> in Receive payment, press <strong>📷 Take photo</strong> (on an iPhone the camera opens) to keep the check and the remittance slip with the payment. Find them later under Payments → <strong>photos</strong>. A photo is a record only; deposit the check as usual.</p>
<p>Billing by the hour? See <a href="#" data-help="invoice-setup">Invoice rates, letterhead and logo</a>, and
<a href="#" data-help="projects">Projects: billing time and costs</a>.</p>`,
  },
  {
    id: 'projects', tab: null, title: 'Projects: billing time and costs',
    words: 'project job folder number unbilled billable time hours timesheet pull airfare rental car lodging cost pass on bill to client',
    html: `
<p><strong>Sales → Projects</strong> lists your projects (the same list as the jobs on the Time tab). To add many at once,
select your project folders in File Explorer, hold Shift, right-click, choose <strong>Copy as path</strong>, and paste them
under <em>Add projects from your folder names</em>. "2601 Smith Residence" becomes project number 2601.</p>
<ol>
  <li>On a bill for a cost you pass on (airfare, rental car, lodging), pick the <strong>Project</strong> on the line and leave
      <strong>Bill to client</strong> ticked.</li>
  <li>Enter your hours on the Time tab against the project, marked billable.</li>
  <li>On a new invoice, pick the <strong>Project</strong>, then press <strong>⏱ Pull in unbilled time and costs</strong>. Choose
      the rate for the hours, untick anything to leave for later, and add the lines.</li>
</ol>
<p>Each hour or cost is billed once. It comes back on the list if that invoice is voided. Billed time can't be changed until
that invoice is edited or voided.</p>`,
  },
  {
    id: 'trips', tab: 'trips', title: 'Trips: shared travel costs',
    words: 'trip travel airfare rental car lodging hotel meals tolls mileage miles receipt photo share percent split project',
    html: `
<ol>
  <li><strong>+ New trip</strong>: name, dates, and the projects it was for, each with its share in percent (80% for the major
      client, 10% for a small job). <em>Split evenly</em> fills equal shares. Shares can add up to less than 100%; the rest isn't billed.</li>
  <li><strong>+ Add cost</strong>: Airfare, Rental car, Lodging, Meals, Tolls, Mileage or Other, the amount, and what you paid
      with. Mileage is miles × your rate per mile (the IRS standard rate from irs.gov, or your own). <strong>📷 Take photo</strong> keeps the receipt.</li>
  <li><strong>+ Add travel time</strong> for the hours on the road.</li>
</ol>
<p>Late costs (tolls) can be added any time. On each project's invoice, <strong>⏱ Pull in unbilled time and costs</strong> adds
its share of every cost; type another quantity on a line to bill a different share.</p>`,
  },
  {
    id: 'invoice-setup', tab: null, title: 'Invoice rates, letterhead and logo',
    words: 'invoice rate hourly engineering drafting overtime equipment rental lodging motel airfare logo letterhead tax id firm sales tax default project',
    html: `
<p>Set these up once in <strong>Settings</strong> (owners and anyone with company settings):</p>
<ul>
  <li><strong>Invoice letterhead and logo</strong>: drag your logo onto the box (or choose the file); it shows in the box beside it. Then type your address, and a note for every invoice
      (for example your tax ID and engineering firm registration number). The closing line prints at the bottom.</li>
  <li><strong>Invoice rates and items</strong>: your hourly rates (Eng Std Rate, Drafting…) and costs you pass on
      (equipment rental, lodging, rental car, airfare). <em>Start with an engineering firm's list</em> adds the usual names;
      then press <em>edit</em> on each and type your price. Leave the price empty for costs that differ every time.</li>
</ul>
<p>On a <strong>new invoice</strong>, pick a rate in <em>Rate or item</em> and the line fills in its rate, tax and income account.
Type the date, the task (Report, Site visit…) and the hours. A one-off rate (say 1.25 × your standard rate) is typed right over the rate.
Changing a saved rate never changes invoices already saved.</p>
<p><strong>One trip, several jobs:</strong> set <em>Jobs sharing these expenses</em> (top of the invoice) to the number of jobs, say 3.
Every cost passed on (lodging, rental car, airfare…) is billed at 1/3 of its price; hourly rates aren't split. Write one invoice per job with
the same number. A quantity you type on a line yourself is kept, so you can split one cost differently.</p>
<p>The <em>Project</em> box prints the project name and site address beside Bill to.</p>
<p><strong>Sales tax</strong>: type the rate, then press <em>📌 Save … as the default</em> and every new invoice starts with it.
Only lines with <em>Tax</em> ticked are taxed.</p>`,
  },
  {
    id: 'bills', tab: 'bills', title: 'Bills and paying vendors',
    words: 'bill vendor pay bills accounts payable 1099',
    html: `
<p>Bills work like invoices in reverse. Add a vendor (tick <em>1099</em> for contractors you'll report at year end), enter
a <strong>bill</strong> with expense accounts, then <strong>Pay bills</strong> from a bank account when you pay.
Until then the bill is in Accounts Payable, so your profit is right even before you pay.</p>
<p>The <strong>Aging report</strong> shows what you owe and what's overdue.</p>`,
  },
  {
    id: 'bank', tab: 'bank', title: 'Bank statements, rules and reconciling',
    words: 'banking import csv ofx qfx match exclude rule reconcile reconciliation statement',
    html: `
<p><strong>Import:</strong> download transactions from your bank's website as <strong>CSV</strong> or <strong>QFX/OFX</strong>
and pick the file. Importing the same dates twice is safe; repeats are skipped.</p>
<p><strong>Review</strong> each line under <em>To review</em>:</p>
<ul>
  <li><em>Add</em>: choose what it was for (an expense or income account) and it's recorded.</li>
  <li><em>Match</em>: it's already in your books (for example a customer payment you recorded); link them so it isn't counted twice.</li>
  <li><em>exclude</em>: not a real transaction (a duplicate line from the bank). <em>undo</em> puts a line back.</li>
</ul>
<p><strong>Rules</strong> suggest an account when the description contains certain words ("home depot" → Materials). You still confirm each one.</p>
<p><strong>Reconcile monthly:</strong> enter the statement date and ending balance, tick every item that's on the statement,
and finish when the difference is $0.00. Reconciled items are locked so they can't be changed by accident.</p>`,
  },
  {
    id: 'reports', tab: 'reports', title: 'Reports, comparisons and exports',
    words: 'balance sheet profit loss income statement cash flow trial balance compare prior year csv excel pdf print payroll register tax schedule c 1065 1120 1120-s 1099 nec w-2 w-3 cpa',
    html: `
<ul>
  <li><strong>Balance Sheet</strong>: what the business owns and owes on a date. Assets = Liabilities + Equity, always.</li>
  <li><strong>Profit &amp; Loss</strong>: income minus expenses for a period.</li>
  <li><strong>Cash Flow</strong>: why cash went up or down (operations, buying equipment, loans and owner money).</li>
  <li><strong>Trial Balance</strong>: every account's balance; what your accountant asks for.</li>
  <li><strong>Payroll Register</strong> (payroll role): every paycheck with each tax and deduction.</li>
</ul>
<p><strong>Tax-ready</strong> (totals for your tax preparer; nothing is filed):</p>
<ul>
  <li><strong>Tax Summary</strong>: income and expenses on the lines of your return (Schedule C, 1065, 1120-S or 1120, from the
    type of business you chose). Each account has a tax category; a <em>suggested</em> one is our guess, so check it and change it in
    the list beside the account, or press <em>accept all suggestions</em>.</li>
  <li><strong>1099-NEC</strong>: for a tax year, what each vendor marked 1099 was paid by cash, check or ACH, and who needs a form
    ($600 for 2025 payments, $2,000 from 2026). Card payments are left out: the card company reports them.</li>
  <li><strong>W-2 / W-3</strong> (payroll role): each employee's W-2 boxes for the year, and the W-3 totals.</li>
</ul>
<p><strong>Compare with</strong> "the period before" or "a year earlier" puts the two side by side with the change in dollars and percent.
"—" means the earlier amount was zero, so there's no percent.</p>
<p><strong>Download CSV</strong> opens in Excel with plain numbers you can add up. <strong>Print / Save PDF</strong> prints only the report;
in the print window choose "Save as PDF" as the printer to make a PDF.</p>
<p>Every statement shows "✓ This report ties out" when its own check passes. If you ever see ⚠, please tell us.</p>`,
  },
  {
    id: 'time', tab: 'time', title: 'Timesheets and HoursTracker',
    words: 'time timesheet hours hourstracker job approve submit overtime import',
    html: `
<ol>
  <li><strong>Add time</strong>: pick the day and job, then a start and end time or just the hours (7.5 or 7:30).
      A shift that runs past midnight belongs to the day it started.</li>
  <li><strong>Submit week for approval</strong> when the week is done.</li>
  <li>Someone with "approve timesheets" sees it under <em>Waiting for approval</em> and approves it or sends it back with a note.
      Nobody but the owner approves their own time.</li>
  <li>On <em>Payroll → Run payroll</em>, <strong>Fill hours from approved timesheets</strong> brings the hours in, already split into
      regular, overtime and double time.</li>
</ol>
<p><strong>Overtime rules used:</strong> federal, over 40 hours in a Sunday–Saturday week is 1.5×. California adds over 8 hours in a day (1.5×),
over 12 (2×), and the 7th day in a row.</p>
<p><strong>HoursTracker:</strong> in the iPhone app open Reports, choose the dates, Share/Export → CSV, and pick the file under
<em>Import from HoursTracker</em>. Press <em>Check file</em> to see what will come in. Entries arrive as drafts; importing the same file again skips what's already in.</p>`,
  },
  {
    id: 'accounts', tab: 'accounts', title: 'Chart of accounts',
    words: 'accounts chart add account register bank credit card equipment',
    html: `
<p>The chart of accounts is the list of "buckets" your money is sorted into: bank accounts, what customers owe you, equipment,
loans, owner's equity, income and expenses. A standard list is created with your company.</p>
<p><strong>Add account</strong> for a new bank account, credit card, vehicle, or an expense you want tracked separately.
Choose the type carefully; it decides where the account shows on the reports.</p>
<p>Click an account to see its <strong>register</strong>: every transaction with a running balance.</p>`,
  },
  {
    id: 'import', tab: 'accounts', title: 'Importing your books from QuickBooks or Excel',
    words: 'import quickbooks excel iif opening balances template undo migrate',
    html: `
<p>On <em>Accounts → Import from QuickBooks or Excel</em>, import in this order:</p>
<ol>
  <li><strong>Chart of accounts</strong>: QuickBooks Reports → Account List → Export, or fill in our template.</li>
  <li><strong>Opening balances</strong>: a trial balance as of the day before you start in zAccountant.</li>
  <li><strong>Transactions</strong> since then: QuickBooks Reports → Journal → Export, or an IIF file.</li>
</ol>
<p>Each file is checked first: you see how many entries and accounts it has and whether the trial balance still balances.
Nothing is saved until you press <em>Import</em>, and every import can be undone. Compare the "Totals by account" with your
QuickBooks report before you import.</p>`,
  },
  {
    id: 'payroll', tab: 'payroll', title: 'Running payroll',
    words: 'payroll employee paycheck run pay stub w-4 de 4 overtime 401k void calculate-only',
    html: `
<p><strong>Calculate-only beta:</strong> zAccountant works out each paycheck and records it in your books.
You (or your accountant) pay the employees and make the tax deposits and filings. Tax tables are awaiting Professional Review Board certification.</p>
<ol>
  <li><strong>Add employee</strong>: name, work state, pay schedule, hourly rate or salary per paycheck, and their W-4 (and California DE 4 or other state form) answers.</li>
  <li><strong>Run payroll</strong>: choose the pay schedule, the period worked and the pay date. Enter hours (or fill them from timesheets),
      overtime, double time and any 401(k). Press <em>Calculate</em> to review every paycheck, then <em>Record payroll</em>.</li>
  <li>Open a <strong>stub</strong> to print it or save it as a PDF for the employee.</li>
</ol>
<p><strong>Mistake on a paycheck?</strong> Void it (most recent paycheck first). The books are reversed, year-to-date totals go back,
and any timesheet hours it paid become unpaid again so the next run picks them up.</p>`,
  },
  {
    id: 'deposits', tab: 'payroll', title: 'Payroll taxes and deposits',
    words: 'payroll taxes owed deposit 941 940 futa suta edd eftps liabilities',
    html: `
<p><em>Payroll → Payroll taxes owed</em>: choose the dates and press <em>Show</em>. Taxes are grouped by where they're paid
(IRS Form 941, IRS Form 940, your state agencies), with a reminder of when each is due and how much is still owed.</p>
<p>After you pay an agency (EFTPS for the IRS, the state's website for others), press <strong>Record deposit</strong>, choose the bank
account and enter the confirmation number. Your books then show the tax paid. A deposit recorded by mistake can be voided.</p>
<p>Use the same dates as the deposit covers (one month for monthly 941 deposits, one quarter for 940 and most state unemployment).</p>`,
  },
  {
    id: 'people', tab: 'settings', title: 'People, roles and departments',
    words: 'invite member role permission owner accountant bookkeeper viewer staff department custom',
    html: `
<p><strong>People with access:</strong> the person creates a zAccountant account first, then you add them by email and choose a role.</p>
<ul>
  <li><strong>Owner</strong>: everything, including closing and reopening periods.</li>
  <li><strong>Accountant</strong>: the books, reports, imports and payroll.</li>
  <li><strong>Bookkeeper</strong>: day-to-day entries, bank, invoices and bills.</li>
  <li><strong>Viewer</strong>: reads books and reports, changes nothing.</li>
  <li><strong>Staff</strong>: writes invoices and enters their own time.</li>
</ul>
<p><strong>Custom roles</strong> mix permissions, for example a project manager who sees reports and approves timesheets.
<strong>Departments</strong> decide whose time a supervisor approves.</p>`,
  },
  {
    id: 'close', tab: 'settings', title: 'Closing the books and the audit trail',
    words: 'close lock period reopen audit trail verify books check year end',
    html: `
<p><strong>Back up your books</strong> (alpha testing: keep your own copy). Download the chart of accounts and all transactions as CSV files. To rebuild, import them into a new company: the chart first, then the transactions. Invoice details, customers, employees and timesheets are not included.</p>
<p><strong>Close the books</strong> after a month or year is final (usually after the bank is reconciled and your accountant is done).
Nobody can add or change transactions dated on or before that day. Only the owner can reopen, with a two-step sign-in code and a reason, and that is logged.</p>
<p><strong>Audit trail:</strong> every change is written to a tamper-evident log. <em>Verify audit trail</em> checks every record,
and <em>Run full check now</em> also proves the trial balance and balance sheet balance. This runs every night by itself.</p>`,
  },
  {
    id: 'payroll-settings', tab: 'settings', title: 'Payroll settings (SUI rate, FUTA, Colorado FAMLI)',
    words: 'sui suta unemployment rate futa credit reduction famli colorado settings',
    html: `
<ul>
  <li><strong>State unemployment rate</strong>: from the rate notice your state sends each year. Until you enter it, the new-employer rate is used.</li>
  <li><strong>FUTA credit reduction</strong>: only when the Department of Labor names your state (announced in November). It adds federal unemployment tax for the year.</li>
  <li><strong>Colorado FAMLI employer size</strong>: with fewer than 10 employees you don't pay the employer half of FAMLI premiums.</li>
</ul>`,
  },
  {
    id: 'security', tab: null, title: 'Signing in and keeping your account safe',
    words: 'password two-step 2fa authenticator recovery code security sign in lost phone',
    html: `
<p>Two-step sign-in is required for everyone: your password plus a 6-digit code from an authenticator app
(Google or Microsoft Authenticator, 1Password, Authy).</p>
<p><strong>Recovery codes:</strong> save them somewhere safe when you set up. If you lose your phone, each code signs you in once.</p>
<p>Social Security numbers are encrypted before they're stored, and each company's data is walled off by the database itself.</p>`,
  },
  {
    id: 'feedback', tab: null, title: 'Beta feedback: telling us about a problem',
    words: 'bug error problem report beta feedback picture screenshot photo broken wrong',
    html: `
<p>Press <strong>🐞 Beta feedback</strong> at the top of any screen, say what happened and what you expected, and press <strong>Send</strong>.
You'll get a report number to quote if you talk to us about it.</p>
<p>The report automatically includes which screen you're on, your last few clicks (the buttons' names only, never what you typed)
and any error messages, so you don't have to copy them.</p>
<p><strong>Pictures help.</strong> <em>Take a picture of the screen</em> adds what's behind the feedback box. <em>Attach a photo or picture</em>
lets you add a screenshot you took yourself, or a phone photo of the screen. The picture shows whatever is on your screen,
including amounts from your books; only the zAccountant developers can see it, and you can remove it before sending.</p>`,
  },
];

/** The guide to open with the "?" button on a screen. */
export const helpForTab = (tab) => HELP.find((h) => h.tab === tab)?.id ?? 'start';

/** Articles matching a search (all words must appear in the title, keywords or text). */
export function searchHelp(q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return HELP;
  return HELP.filter((h) => {
    const text = `${h.title} ${h.words} ${h.html.replace(/<[^>]+>/g, ' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
