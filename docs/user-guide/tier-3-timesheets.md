# Tier 3: Timesheets add-on

For companies with the Timesheets add-on (every company during the beta). People enter their own time with the
"enter own time" permission. Supervisors approve with "approve timesheets" (their own department) or "see and
approve everyone's timesheets".

## 1. Jobs

Time is entered against a **job**: a project, optionally tied to a customer. Add jobs on the Time tab, or let a
HoursTracker import create them.

## 2. Entering time

1. **Add time**: pick the day and the job. Enter a start and end time, or just the hours (7.5 or 7:30), and any
   notes. Untick *billable* for time you won't charge a client for.
2. A shift that runs past midnight belongs to the day it started.
3. When the week is done, press **Submit week for approval**.

## 3. Approving time

Waiting entries appear under **Waiting for approval**. **Approve** them, or **send back** with a note saying what to
fix. Nobody but the owner approves their own time. Approved time is locked once a paycheck pays it.

## 4. HoursTracker import

In the HoursTracker iPhone app: Reports → choose the dates → Share/Export → CSV. In zAccountant, under **Import
from HoursTracker**, choose whose time it is and pick the file. **Check file** shows what will come in. Entries
arrive as drafts. Importing the same file again skips what's already in.

## 5. Paying time through payroll (Company plan)

1. Link each employee to the person who signs in: on the Payroll tab's employee list, choose them in the **Timesheets from** column.
2. On **Run payroll**, press **Fill hours from approved timesheets**. Hours come in already split into regular,
   overtime and double time:
   - **Federal:** over 40 hours in a Sunday–Saturday week is paid at 1.5×.
   - **California** adds: over 8 hours in a day at 1.5×, over 12 hours at 2×, and the 7th day in a row.
3. Recording the payroll marks those hours paid. Voiding the paycheck makes them unpaid again.

## 6. Hours by job

The Time tab shows **Hours by job this week**: total and billable hours for each job, for everyone whose time you can see.
