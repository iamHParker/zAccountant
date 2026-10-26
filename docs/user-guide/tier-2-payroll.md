# Tier 2: Payroll (Company plan)

For companies on the Company plan (every company during the beta), and people whose role has the payroll
permission.

> **Calculate-only during the beta.** zAccountant works out each paycheck and records it in your books. You, or your
> accountant, pay the employees and make the tax deposits and filings. The tax tables are waiting for
> certification by our Professional Review Board. Check the numbers against your current payroll service before
> relying on them.

## 1. Payroll settings (Settings tab, owner)

- **State unemployment rate:** from the rate notice your state sends each year. Until you enter it, the new-employer
  rate is used.
- **FUTA credit reduction:** only when the U.S. Department of Labor names your state (announced each November). It
  adds federal unemployment tax for the year.
- **Colorado FAMLI employer size:** with fewer than 10 employees you don't pay the employer half of FAMLI premiums.

## 2. Employees

**Add employee**: name, Social Security number (encrypted; only the last 4 digits ever show), work state, pay
schedule (weekly, every two weeks, twice a month, monthly), hourly rate or salary per paycheck, and their tax form
answers:
- federal **W-4** (2020 or later, or an older form with allowances);
- **California DE 4**, **Colorado** annual allowance, or **DC D-4**, depending on the work state.

Add their **hire date** and **home address** too: the address goes on the W-2.

To pay someone from their timesheets, choose the person who signs in under **Timesheets from** in the employee list (tier 3).

**edit** (beside each employee) changes anything on that form: a raise, a new W-4, a married name, a move to another
state, a new address. Leave the Social Security number blank to keep the one on file. The change applies to paychecks
from then on. Each paycheck already made keeps the name, state, address, pay type and rate it was figured with, so old
stubs reprint exactly as issued. Every change is in the audit trail (for the SSN, W-4 and state forms, only *that*
they changed, never the numbers). The W-2 uses the employee's current name and address, as the IRS expects.

**Moving to another state:** change **Works in** and fill in the new state's form. Paychecks before the move stay
taxed for the old state, and the payroll taxes report sends each state its own share.

**left the company** asks for their last day of work. Run their final paycheck first: after this they drop out of
payroll runs and timesheets. Their paychecks and W-2 stay. **rehire** asks for the day they start again; the
year-to-date totals carry on.

## 3. Running payroll

1. **Run payroll**: choose the pay schedule, the period worked and the pay date.
2. Enter each person's hours, overtime, double time and any 401(k) or other pre-tax deduction. Or press **Fill
   hours from approved timesheets** (tier 3).
3. **Calculate** shows every paycheck: gross pay, each tax, deductions, net pay and the employer's taxes. Review it.
4. **Record payroll** saves the paychecks and records the wages, withholding and employer taxes in your books.

Open a **stub** to print it or save it as a PDF for the employee. It shows this check and the year-to-date totals.

**Mistake on a paycheck?** Void it, most recent paycheck first. The books are reversed, the year-to-date totals go
back, and any timesheet hours it paid become unpaid again, so the next run picks them up.

**A whole run went out wrong** (wrong hours for everyone, the wrong period)? Press **void run** beside it under Payroll
runs and give the reason. Every paycheck in it is voided the same way, and the same pay period can be run again with
the right numbers. If someone in it has a later paycheck, void that one first.

## 4. Payroll taxes and deposits

**Payroll → Payroll taxes owed**: choose the dates and press **Show**. Taxes are grouped by where they are paid
(IRS Form 941, IRS Form 940, your state agencies), with when each is due and how much is still owed.

After you pay an agency (EFTPS for the IRS, the state's website for the others), press **Record deposit**. Choose the
bank account and enter the confirmation number, and your books show the tax paid. Use the dates the deposit covers:
one month for monthly 941 deposits, one quarter for 940 and most state unemployment. A deposit recorded by mistake
can be voided.

## 5. Payroll reports

- **Payroll Register** (Reports tab): every paycheck in a date range, with a column for each tax and deduction and
  totals. Download as CSV or print.
- **Payroll taxes owed:** above.
