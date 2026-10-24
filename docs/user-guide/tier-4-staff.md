# Tier 4: zAccountant staff (Admin and Developer dashboards)

These dashboards are for zAccountant's own team, not for customers. A person sees them only when their sign-in
email is listed in the server's settings: `DEVELOPER_EMAILS` for both dashboards, `ADMIN_EMAILS` for the Admin
dashboard only. Nobody can give themselves access from inside the app.

## 1. Admin dashboard: plans and billing

The **Admin** button at the top opens a list of every company: owners, number of members and employees, last
activity, and plan. It never shows an amount from anyone's books.

- **Plans:** *Beta tester* (everything, free) and *Basic* (books, invoices, bills, banking, reports). The add-ons
  are *Payroll* and *Timesheets*. Prices show "price not set" until they are decided.
- **change** a company's plan: choose the plan and add-ons, and give a reason. The reason goes in the change log.
  The company's screens and the server switch the features on or off at once.
- **Plan changes** lists every change: who made it, when, from what, to what, and why.
- During the beta, testers stay on Beta tester at no charge. Payments are handled by hand until Stripe goes in
  (December 2026).

## 2. Developer dashboard: beta feedback

The **Developer** button opens the reports testers send with 🐞 Beta feedback.

1. **Reports** are listed newest first, with page, picture and status. Filter by status.
2. Open a report to see the tester's note, their picture (click it for full size, or download it), the screen they
   were on, their last clicks, the errors the page recorded, and the app version.
3. **For Claude:** a ready-to-send write-up of the report, with the reporter's name and email left out. Edit it to be
   clearer, then **Copy for Claude** and paste it into a Claude session. **Back to the automatic write-up** rebuilds
   it from the report.
4. Set the **status** (new, reviewing, sent to Claude, not a defect, fixed) and add your own **note**.

## 3. Developer dashboard: server health

- **Counts:** people signed up, companies, people signed in today.
- **Server errors:** the last 100 unexpected errors, each with its time, the page it came from, the message and a
  request id. Match a tester's request id to find the same problem in the Railway logs.
- **Download backup:** a full copy of the database (until scheduled backups are set up). Keep it somewhere private:
  it contains every company's books.
