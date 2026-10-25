# Tier 0: Everyone

## 1. Creating your account

1. Open zAccountant's front page and choose **Create an account** (or **Sign in** if you have one; the app
   itself is at `/app`). Enter your name, email and a password (a long passphrase is
   best).
2. **Two-step sign-in is required.** Open an authenticator app on your phone (Google or Microsoft Authenticator,
   1Password, Authy). Add an account, then scan the code on screen or type the key. Enter the 6-digit code the app
   shows and press **Turn on**.
3. **Save your recovery codes** somewhere safe, such as a password manager or a printed copy. If you lose your phone,
   each code signs you in once.

Each time you sign in you enter your password, then the current 6-digit code from the app. After 10 wrong passwords
the account locks for a while, to stop guessing.

## 2. Your company

**Starting your own:** after sign-in, enter the company name, the type of business (individual, sole proprietor,
single-member LLC, partnership, S or C corporation; it decides which tax return the books feed), its home state
(TX, CO, CA or DC), the month its fiscal year starts, and the day your books start. A standard chart of accounts is
created, and the **setup wizard** opens. Every step can be skipped:

1. **Basics:** the type of business and start date (change them here later).
2. **Your books:** start fresh, or import from QuickBooks, from our Excel/CSV templates, or from a zAccountant backup
   (chart of accounts first, then the rest). **← back to setup** above the importer returns to the wizard.
3. **Bank and cards:** add your accounts. Starting fresh, type each balance as of the day before the books start (for a
   card, what you owe); each becomes an entry against Owner's Capital.
4. **Invoicing** and 5. **People** open the matching Settings cards.

Until you press **Finish**, Home shows a **Finish setting up** list with what's done (✓) and what's left.
A sole proprietor or an individual keeping their own books is set up as a company too.

**Joining someone else's company** (a bookkeeper, an employee, a beta tester): don't create a company. Send the
owner the email you signed up with. They add you under **Settings → People with access** and choose your role.
Then press **Check again** on your start screen and the company appears.

**More than one company:** pick the company in the box at the top left. Add another with **Settings → + Add another
company**.

## 3. Finding your way

| Tab | What it's for | Tier |
|---|---|---|
| Home | cash, income, expenses and profit this year; record a quick transaction | 1 |
| Transactions | every entry; search; advanced journal entries; recurring entries | 1 |
| Sales | invoices, customers, payments received, what customers owe | 1 |
| Bills | bills, vendors, payments made, what you owe | 1 |
| Banking | import bank statements, review them, rules, reconcile | 1 |
| Reports | balance sheet, profit and loss, cash flow, trial balance; payroll reports | 1, 2 |
| Accounts | chart of accounts, account registers, importing from QuickBooks or Excel | 1 |
| Payroll | employees, payroll runs, pay stubs, payroll taxes | 2 |
| Time | timesheets and approvals | 3 |
| Settings | people and roles, invoice letterhead and rates, closing the books, audit trail, payroll settings | 1, 2 |

You see only the tabs your role and your company's plan include.

**? Help** opens the guide for the screen you are on, and its search box finds any guide.

## 4. When something goes wrong

zAccountant never half-saves: a save either completes or nothing changes. Messages say what to do:

| You see | It means | Do this |
|---|---|---|
| "… is not valid: line 2: enter a price or amount" | something on the form needs fixing; every problem is listed | fix each one and save again |
| "Your role (Bookkeeper) can't do that. Ask the company owner." | your role doesn't include that action | ask the owner to change your role |
| "Payroll isn't in this company's plan." | the company's plan doesn't include that feature | ask zAccountant (during the beta, report it: it shouldn't happen) |
| "That would break an accounting rule (for example an unbalanced entry or a closed period)" | the books refused it: perhaps the date is in a closed period | check the date; ask the owner if the period must reopen |
| "Can't reach zAccountant. Check your internet connection." | no connection to the server | check Wi-Fi; if you were saving, look whether it saved before trying again |
| "zAccountant is restarting or briefly unavailable" | a new version is being installed (takes about a minute) | wait a minute and try again |
| "That is too large to send" | the file or picture is over the limit | use a smaller file or picture |
| "Something went wrong on our side. Nothing was saved." | a problem in zAccountant itself | press 🐞 Beta feedback so we can fix it |
| "Please sign in" / the sign-in screen appears | your session ended | sign in again; your saved work is safe |

Saves of entries, invoices, bills and payments are protected against doubles. If you press Save again after a
dropped connection, they are recorded once.

## 5. Beta feedback: telling us about a problem

Press **🐞 Beta feedback** at the top of any screen, say what happened and what you expected, and press **Send**.
You get a report number.

The report automatically includes the screen you are on, your last few clicks (the buttons' names only, never what
you typed) and any error messages. **Take a picture of the screen** adds a picture of what's behind the feedback
box. **Attach a photo or picture** adds a screenshot or a phone photo. The picture shows whatever is on your
screen, including amounts from your books. Only zAccountant's developers can see it, and you can remove it before
sending.

**Which build am I on?** The bar along the bottom of the screen shows **Build** and a number after the company name, for example
`Build 0.1.0+b8e08b2`. The part after `+` names the exact code installed. A report already includes it, but if you
send us a screenshot or tell us about a problem some other way, mention that number.

## 6. Keeping your account safe

> **Alpha testing: keep your own backup.** Download a copy of your books regularly from **Settings → Back up your
> books** (tier 1, section 8), and keep your own records (bank statements, receipts, invoices) as well.

- **Sign in with Face ID, Touch ID or Windows Hello.** On each phone or computer you use, open **Settings → Sign in
  with Face ID, Touch ID or Windows Hello**, give the device a name, type your 6-digit authenticator code and press
  **Add this device**. From then on, choose **Sign in with Face ID or a passkey** on the sign-in screen: nothing is
  typed, so a camera over your shoulder sees nothing. Lost the device? Remove its passkey in the same place. Your
  password and code still work as the backup.
- Never share your password or recovery codes. zAccountant staff will never ask for them.
- Social Security numbers and authenticator secrets are encrypted before they are stored.
- Each company's data is walled off by the database itself. Other companies can't see yours, even by mistake.
