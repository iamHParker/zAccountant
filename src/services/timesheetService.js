// Jobs and timesheets. ℹ️ Everyone with "own time" enters their hours against a job; someone with
// "approve time" (for their department) or "all time" approves them; approved hours fill in the
// payroll run for the employee linked to that person, and are marked paid when the run is recorded.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { ImportError } from '../core/bankImport.js';
import { parseDuration, parseClock, shiftMinutes, readTimesheetCsv, splitOvertime, minutesToHours, workweekStart } from '../core/timesheets.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);
const lockCompany = (c, companyId) => c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- Jobs

const JOB_COLS = `j.id, j.name, j.code, j.customer_id AS "customerId", c.name AS "customerName", j.address, j.is_active AS "isActive"`;

export async function listJobs(db, companyId, { includeInactive = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${JOB_COLS} FROM jobs j LEFT JOIN contacts c ON c.id = j.customer_id
      WHERE j.company_id = $1 ${includeInactive ? '' : 'AND j.is_active'} ORDER BY lower(j.name)`, [companyId]);
  return rows;
}

async function cleanJob(db, companyId, { name, code, customerId, address }) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 80) throw new LedgerError('Job name is required (up to 80 characters)');
  const cd = typeof code === 'string' && code.trim() ? code.trim() : null;
  if (cd && cd.length > 30) throw new LedgerError('Job code can be up to 30 characters');
  let cust = null;
  if (customerId) {
    if (!isId(customerId)) throw new LedgerError('That customer does not exist');
    const { rows: [c] } = await db.query("SELECT id FROM contacts WHERE company_id = $1 AND id = $2 AND kind = 'customer'", [companyId, customerId]);
    if (!c) throw new LedgerError('That customer does not exist');
    cust = c.id;
  }
  const addr = typeof address === 'string' && address.trim() ? address.trim() : null;
  if (addr && addr.length > 300) throw new LedgerError('The site address can be up to 300 characters');
  return { name: n, code: cd, customerId: cust, address: addr };
}

export async function createJob(pool, companyId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const v = await cleanJob(c, companyId, input);
    const { rows: [dup] } = await c.query('SELECT 1 FROM jobs WHERE company_id = $1 AND lower(trim(name)) = lower($2)', [companyId, v.name]);
    if (dup) throw new LedgerError(`There is already a job named "${v.name}"`);
    const { rows: [j] } = await c.query('INSERT INTO jobs (company_id, name, code, customer_id, address) VALUES ($1,$2,$3,$4,$5) RETURNING id', [companyId, v.name, v.code, v.customerId, v.address]);
    await appendAudit(c, companyId, { action: 'create', entity: 'job', entityId: j.id, actor, payload: v });
    return (await c.query(`SELECT ${JOB_COLS} FROM jobs j LEFT JOIN contacts c ON c.id = j.customer_id WHERE j.id = $1`, [j.id])).rows[0];
  });
}

export async function updateJob(pool, companyId, jobId, input, { actor = null } = {}) {
  if (!isId(jobId)) throw new LedgerError('Job not found');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const v = await cleanJob(c, companyId, input);
    const { rows: [dup] } = await c.query('SELECT 1 FROM jobs WHERE company_id = $1 AND lower(trim(name)) = lower($2) AND id <> $3', [companyId, v.name, jobId]);
    if (dup) throw new LedgerError(`There is already a job named "${v.name}"`);
    // The site address is left alone when the change doesn't mention it (closing a job sends only name, code, customer).
    const { rowCount } = await c.query(`UPDATE jobs SET name = $3, code = $4, customer_id = $5, is_active = $6, address = CASE WHEN $7 THEN $8 ELSE address END
      WHERE company_id = $1 AND id = $2`, [companyId, jobId, v.name, v.code, v.customerId, input.isActive !== false, input.address !== undefined, v.address]);
    if (!rowCount) throw new LedgerError('Job not found');
    await appendAudit(c, companyId, { action: 'update', entity: 'job', entityId: jobId, actor, payload: { ...v, isActive: input.isActive !== false } });
    return (await c.query(`SELECT ${JOB_COLS} FROM jobs j LEFT JOIN contacts c ON c.id = j.customer_id WHERE j.id = $1`, [jobId])).rows[0];
  });
}

// ---------------------------------------------------------------- Who may see and change whose time

/**
 * `viewer` = { userId, can(permission), departmentId } for the person making the request.
 * Own time needs "time_own"; other people's time needs "time_all", or "time_approve" when they are
 * in the viewer's department.
 */
async function departmentOf(db, companyId, userId) {
  const { rows: [m] } = await db.query('SELECT department_id FROM memberships WHERE company_id = $1 AND user_id = $2', [companyId, userId]);
  return m ? { member: true, departmentId: m.department_id } : { member: false, departmentId: null };
}

async function mayManage(db, companyId, viewer, targetUserId) {
  if (targetUserId === viewer.userId) return viewer.can('time_own') || viewer.can('time_all');
  if (viewer.can('time_all')) return true;
  if (!viewer.can('time_approve') || !viewer.departmentId) return false;
  return (await departmentOf(db, companyId, targetUserId)).departmentId === viewer.departmentId;
}

async function mayApprove(db, companyId, viewer, targetUserId) {
  // Nobody approves their own hours, except the company admin (a one-person company needs to).
  if (targetUserId === viewer.userId && !viewer.can('admin')) return false;
  if (viewer.can('time_all')) return true;
  if (!viewer.can('time_approve') || !viewer.departmentId) return false;
  return (await departmentOf(db, companyId, targetUserId)).departmentId === viewer.departmentId;
}

const deny = () => new LedgerError("You can't see or change that person's time");
const billed = (number) => new LedgerError(`That time is billed on invoice ${number}. Edit or void that invoice first.`);

/** SQL (and its parameters) limiting time entries to people the viewer may see. */
function visibleClause(viewer, alias, params) {
  if (viewer.can('time_all')) return 'true';
  params.push(viewer.userId);
  const me = `$${params.length}`;
  if (viewer.can('time_approve') && viewer.departmentId) {
    params.push(viewer.departmentId);
    return `(${alias}.user_id = ${me} OR ${alias}.user_id IN (SELECT user_id FROM memberships WHERE company_id = ${alias}.company_id AND department_id = $${params.length}))`;
  }
  return `${alias}.user_id = ${me}`;
}

// ---------------------------------------------------------------- Time entries

const ENTRY_COLS = `t.id, t.user_id AS "userId", u.name AS "userName", t.job_id AS "jobId", j.name AS "jobName",
  to_char(t.work_date, 'YYYY-MM-DD') AS date, t.minutes, to_char(t.start_time, 'HH24:MI') AS start, to_char(t.end_time, 'HH24:MI') AS "end",
  t.notes, t.billable, t.status, t.review_note AS "reviewNote", rv.name AS "reviewedBy", t.reviewed_at AS "reviewedAt",
  t.paid_run_id AS "paidRunId", t.source, t.trip_id AS "tripId", tr.name AS "tripName",
  (SELECT d.number FROM document_lines l JOIN documents d ON d.id = l.document_id WHERE l.time_entry_id = t.id AND d.status = 'posted' LIMIT 1) AS "billedOn"`;
const ENTRY_FROM = `time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN users rv ON rv.id = t.reviewed_by
  LEFT JOIN trips tr ON tr.id = t.trip_id`;
const withHours = (r) => ({ ...r, hours: minutesToHours(r.minutes) });

const STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

export async function listTimeEntries(db, companyId, viewer, { from, to, userId, status, jobId } = {}) {
  const params = [companyId];
  const where = ['t.company_id = $1', visibleClause(viewer, 't', params)];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (from) { if (!isIsoDate(from)) throw new LedgerError('from must be YYYY-MM-DD'); add('t.work_date >= ?', from); }
  if (to) { if (!isIsoDate(to)) throw new LedgerError('to must be YYYY-MM-DD'); add('t.work_date <= ?', to); }
  if (userId) { if (!isId(userId)) throw new LedgerError('Person not found'); add('t.user_id = ?', userId); }
  if (jobId) { if (!isId(jobId)) throw new LedgerError('Job not found'); add('t.job_id = ?', jobId); }
  if (status) {
    if (status === 'unpaid') where.push("t.status = 'approved' AND t.paid_run_id IS NULL");
    else if (status === 'paid') where.push('t.paid_run_id IS NOT NULL');
    else if (STATUSES.includes(status)) add('t.status = ?', status);
    else throw new LedgerError('Unknown status');
  }
  const { rows } = await db.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE ${where.join(' AND ')}
    ORDER BY t.work_date DESC, u.name, t.start_time NULLS LAST, t.created_at LIMIT 2000`, params);
  return rows.map(withHours);
}

async function getEntry(db, companyId, id) {
  if (!isId(id)) throw new LedgerError('Time entry not found');
  const { rows: [r] } = await db.query(`SELECT ${ENTRY_COLS} FROM ${ENTRY_FROM} WHERE t.company_id = $1 AND t.id = $2`, [companyId, id]);
  if (!r) throw new LedgerError('Time entry not found');
  return withHours(r);
}

/** Validate what a person typed for one entry. Returns the database values. */
async function cleanEntry(db, companyId, input) {
  const errors = [];
  if (!isIsoDate(input.date)) errors.push('date must be YYYY-MM-DD');
  else if (input.date < '2000-01-01' || input.date > '2100-12-31') errors.push('date is out of range');
  const start = input.start ? parseClock(input.start) : null;
  const end = input.end ? parseClock(input.end) : null;
  if (input.start && !start) errors.push('start time is not valid (e.g. 7:30 AM)');
  if (input.end && !end) errors.push('end time is not valid (e.g. 4:00 PM)');
  let minutes = null;
  const hoursGiven = input.hours != null && String(input.hours).trim() !== '';
  if (hoursGiven) {
    minutes = parseDuration(input.hours);
    if (minutes == null) errors.push('hours must be like 7.5 or 7:30');
  } else if (start && end) {
    minutes = shiftMinutes(start, end) - (input.breakMinutes ? Number(input.breakMinutes) || 0 : 0);
  } else if (!errors.length) errors.push('enter the hours, or a start and end time');
  if (minutes != null && !(minutes > 0 && minutes <= 1440)) errors.push('hours must be more than 0 and at most 24');
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null;
  if (notes && notes.length > 500) errors.push('notes can be up to 500 characters');
  let jobId = null;
  if (input.jobId) {
    if (!isId(input.jobId)) errors.push('that job does not exist');
    else {
      const { rows: [j] } = await db.query('SELECT id, is_active FROM jobs WHERE company_id = $1 AND id = $2', [companyId, input.jobId]);
      if (!j) errors.push('that job does not exist');
      else if (!j.is_active) errors.push('that job is closed');
      else jobId = j.id;
    }
  }
  // Travel time belongs to a trip (shared by the trip's projects) instead of a job.
  let tripId = null;
  if (input.tripId) {
    if (jobId) errors.push('travel time goes on the trip, not a job');
    const { rows: [tr] } = isId(input.tripId) ? await db.query('SELECT id FROM trips WHERE company_id = $1 AND id = $2', [companyId, input.tripId]) : { rows: [] };
    if (!tr) errors.push('that trip does not exist');
    else tripId = tr.id;
  }
  if (errors.length) throw new LedgerError('Time entry is not valid', errors);
  return { date: input.date, minutes, start, end, notes, jobId, tripId, billable: input.billable !== false };
}

/** A person can't have more than 24 hours on one day. */
async function checkDayTotal(db, companyId, userId, date, minutes, exceptId = null) {
  const { rows: [r] } = await db.query(
    'SELECT coalesce(sum(minutes), 0)::int AS m FROM time_entries WHERE company_id = $1 AND user_id = $2 AND work_date = $3 AND id IS DISTINCT FROM $4',
    [companyId, userId, date, exceptId]);
  if (r.m + minutes > 1440) throw new LedgerError(`That would put more than 24 hours on ${date}`);
}

export async function createTimeEntry(pool, companyId, viewer, input, { actor = null } = {}) {
  const userId = input.userId || viewer.userId;
  return withTransaction(pool, async (c) => {
    if (!isId(userId) || !(await departmentOf(c, companyId, userId)).member) throw new LedgerError('That person is not a member of this company');
    if (!(await mayManage(c, companyId, viewer, userId))) throw deny();
    const v = await cleanEntry(c, companyId, input);
    await checkDayTotal(c, companyId, userId, v.date, v.minutes);
    const { rows: [t] } = await c.query(
      `INSERT INTO time_entries (company_id, user_id, job_id, trip_id, work_date, minutes, start_time, end_time, notes, billable, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, userId, v.jobId, v.tripId, v.date, v.minutes, v.start, v.end, v.notes, v.billable, viewer.userId]);
    if (userId !== viewer.userId) await appendAudit(c, companyId, { action: 'create', entity: 'time_entry', entityId: t.id, actor, payload: { userId, date: v.date, minutes: v.minutes } });
    return getEntry(c, companyId, t.id);
  });
}

/** Change an entry that hasn't been approved yet. A submitted entry goes back to draft. */
export async function updateTimeEntry(pool, companyId, viewer, id, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    const e = await getEntry(c, companyId, id);
    if (!(await mayManage(c, companyId, viewer, e.userId))) throw deny();
    if (e.billedOn) throw billed(e.billedOn);
    if (e.status === 'approved') throw new LedgerError('Approved time can\'t be changed. Ask the approver to send it back first.');
    const v = await cleanEntry(c, companyId, { ...input, jobId: input.jobId === undefined ? e.jobId : input.jobId, tripId: input.tripId === undefined ? e.tripId : input.tripId });
    await checkDayTotal(c, companyId, e.userId, v.date, v.minutes, id);
    await c.query(
      `UPDATE time_entries SET job_id = $3, work_date = $4, minutes = $5, start_time = $6, end_time = $7, notes = $8, billable = $9, trip_id = $10,
         status = 'draft', review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
       WHERE company_id = $1 AND id = $2`, [companyId, id, v.jobId, v.date, v.minutes, v.start, v.end, v.notes, v.billable, v.tripId]);
    if (e.userId !== viewer.userId) await appendAudit(c, companyId, { action: 'update', entity: 'time_entry', entityId: id, actor, payload: { userId: e.userId, date: v.date, minutes: v.minutes } });
    return getEntry(c, companyId, id);
  });
}

export async function deleteTimeEntry(pool, companyId, viewer, id, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    const e = await getEntry(c, companyId, id);
    if (!(await mayManage(c, companyId, viewer, e.userId))) throw deny();
    if (e.billedOn) throw billed(e.billedOn);
    if (e.status === 'approved') throw new LedgerError('Approved time can\'t be deleted. Ask the approver to send it back first.');
    await c.query('DELETE FROM time_entries WHERE company_id = $1 AND id = $2', [companyId, id]);
    if (e.userId !== viewer.userId) await appendAudit(c, companyId, { action: 'delete', entity: 'time_entry', entityId: id, actor, payload: { userId: e.userId, date: e.date, minutes: e.minutes } });
    return { ok: true };
  });
}

const cleanIds = (ids) => {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every(isId)) throw new LedgerError('Choose one or more time entries');
  return [...new Set(ids)];
};

/** Send draft (or sent-back) entries to the approver. */
export async function submitTimeEntries(pool, companyId, viewer, { ids }) {
  const list = cleanIds(ids);
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query('SELECT id, user_id, status FROM time_entries WHERE company_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE', [companyId, list]);
    if (rows.length !== list.length) throw new LedgerError('Time entry not found');
    for (const r of rows) {
      if (!(await mayManage(c, companyId, viewer, r.user_id))) throw deny();
      if (r.status === 'approved') throw new LedgerError('Some of those entries are already approved');
    }
    const { rowCount } = await c.query(`UPDATE time_entries SET status = 'submitted', review_note = NULL, updated_at = now()
      WHERE company_id = $1 AND id = ANY($2::uuid[]) AND status IN ('draft','rejected')`, [companyId, list]);
    return { submitted: rowCount };
  });
}

/**
 * Approve, or send back with a note. Approved entries that haven't been paid can also be sent back.
 * Paid time is final.
 */
export async function reviewTimeEntries(pool, companyId, viewer, { ids, approve, note }, { actor = null } = {}) {
  const list = cleanIds(ids);
  if (typeof approve !== 'boolean') throw new LedgerError('Say whether to approve or send back');
  const n = typeof note === 'string' && note.trim() ? note.trim().slice(0, 300) : null;
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query('SELECT id, user_id, status, paid_run_id FROM time_entries WHERE company_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE', [companyId, list]);
    if (rows.length !== list.length) throw new LedgerError('Time entry not found');
    for (const r of rows) {
      if (!(await mayApprove(c, companyId, viewer, r.user_id))) {
        throw new LedgerError(r.user_id === viewer.userId ? 'Someone else has to approve your own time' : "You can't approve that person's time");
      }
      if (r.paid_run_id) throw new LedgerError('Some of those hours were already paid; paid time is final');
      if (!approve) {
        const { rows: [b] } = await c.query(`SELECT d.number FROM document_lines l JOIN documents d ON d.id = l.document_id
          WHERE l.time_entry_id = $1 AND d.status = 'posted' LIMIT 1`, [r.id]);
        if (b) throw billed(b.number);
      }
      if (approve && r.status !== 'submitted') throw new LedgerError('Only submitted time can be approved');
      if (!approve && !['submitted', 'approved'].includes(r.status)) throw new LedgerError('Only submitted or approved time can be sent back');
    }
    await c.query(`UPDATE time_entries SET status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now(), updated_at = now()
      WHERE company_id = $1 AND id = ANY($2::uuid[])`, [companyId, list, approve ? 'approved' : 'rejected', n, viewer.userId]);
    await appendAudit(c, companyId, { action: approve ? 'approve' : 'reject', entity: 'time_entries', entityId: null, actor, payload: { ids: list, note: n } });
    return { [approve ? 'approved' : 'sentBack']: list.length };
  });
}

// ---------------------------------------------------------------- Importing from HoursTracker (or any CSV)

/**
 * Import a timesheet export for one person (the viewer, or someone they manage). Job names are
 * matched to jobs (ignoring case); with `createJobs` a missing job is created, otherwise the entry
 * keeps the job name in its notes. Rows already imported are skipped. Entries arrive as drafts.
 * With `preview`, nothing is saved.
 */
export async function importTimesheet(pool, companyId, viewer, { fileName = '', content, preview = false, userId, createJobs = false }, { actor = null } = {}) {
  let parsed;
  try { parsed = readTimesheetCsv(typeof content === 'string' ? content : ''); } catch (e) {
    if (e instanceof ImportError) throw new LedgerError(e.message, e.details);
    throw e;
  }
  const target = userId || viewer.userId;
  const canMakeJobs = viewer.can('time_all') || viewer.can('time_approve') || viewer.can('admin');
  if (createJobs && !canMakeJobs) throw new LedgerError("Your role can't add jobs. Ask an approver to add them, or import without new jobs.");
  return withTransaction(pool, async (c) => {
    if (!isId(target) || !(await departmentOf(c, companyId, target)).member) throw new LedgerError('That person is not a member of this company');
    if (!(await mayManage(c, companyId, viewer, target))) throw deny();
    await lockCompany(c, companyId);
    const jobs = new Map((await c.query('SELECT id, name, is_active FROM jobs WHERE company_id = $1', [companyId])).rows.map((j) => [j.name.trim().toLowerCase(), j]));
    const { rows: seen } = await c.query('SELECT import_hash FROM time_entries WHERE company_id = $1 AND user_id = $2 AND import_hash = ANY($3::text[])',
      [companyId, target, parsed.rows.map((r) => r.hash)]);
    const already = new Set(seen.map((s) => s.import_hash));
    const fresh = [];
    const inFile = new Set();
    for (const r of parsed.rows) if (!already.has(r.hash) && !inFile.has(r.hash)) { inFile.add(r.hash); fresh.push(r); }
    const newJobs = [...new Set(fresh.filter((r) => r.job && !jobs.has(r.job.toLowerCase())).map((r) => r.job))];
    // Hours already on each day (plus this file) can't exceed 24.
    const byDay = new Map();
    for (const r of fresh) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.minutes);
    const { rows: existing } = await c.query(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS d, sum(minutes)::int AS m FROM time_entries WHERE company_id = $1 AND user_id = $2 AND work_date = ANY($3::date[]) GROUP BY work_date`,
      [companyId, target, [...byDay.keys()]]);
    for (const e of existing) byDay.set(e.d, byDay.get(e.d) + e.m);
    const overfull = [...byDay].filter(([, m]) => m > 1440).map(([d]) => d).sort();
    if (overfull.length) throw new LedgerError('Some days would have more than 24 hours', overfull.map((d) => `${d}: check for overlapping entries`));
    const summary = {
      format: parsed.format, fileName: String(fileName).slice(0, 200), rows: parsed.rows.length, toImport: fresh.length,
      duplicates: parsed.rows.length - fresh.length, minutes: fresh.reduce((t, r) => t + r.minutes, 0),
      from: fresh.length ? fresh.reduce((m, r) => (r.date < m ? r.date : m), fresh[0].date) : null,
      to: fresh.length ? fresh.reduce((m, r) => (r.date > m ? r.date : m), fresh[0].date) : null,
      newJobs, closedJobs: [...new Set(fresh.filter((r) => r.job && jobs.get(r.job.toLowerCase())?.is_active === false).map((r) => r.job))],
      sample: fresh.slice(0, 20).map((r) => ({ date: r.date, start: r.start, end: r.end, hours: minutesToHours(r.minutes), job: r.job, notes: r.notes })),
    };
    summary.hours = minutesToHours(summary.minutes);
    if (preview) return { ...summary, preview: true };
    if (createJobs) {
      for (const name of newJobs) {
        const { rows: [j] } = await c.query('INSERT INTO jobs (company_id, name) VALUES ($1,$2) RETURNING id, name, is_active', [companyId, name]);
        jobs.set(name.toLowerCase(), j);
        await appendAudit(c, companyId, { action: 'create', entity: 'job', entityId: j.id, actor, payload: { name, from: 'timesheet import' } });
      }
    }
    for (const r of fresh) {
      const j = r.job ? jobs.get(r.job.toLowerCase()) : null;
      const useJob = j && j.is_active;
      const notes = [r.job && !useJob ? `Job: ${r.job}` : null, r.notes || null].filter(Boolean).join(' · ').slice(0, 500) || null;
      await c.query(
        `INSERT INTO time_entries (company_id, user_id, job_id, work_date, minutes, start_time, end_time, notes, billable, source, import_hash, entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11)`,
        [companyId, target, useJob ? j.id : null, r.date, r.minutes, r.start, r.end, notes, parsed.format === 'HoursTracker' ? 'hourstracker' : 'csv', r.hash, viewer.userId]);
    }
    await appendAudit(c, companyId, { action: 'import', entity: 'time_entries', entityId: null, actor,
      payload: { userId: target, fileName: summary.fileName, format: summary.format, imported: fresh.length, duplicates: summary.duplicates, minutes: summary.minutes } });
    return { ...summary, imported: fresh.length };
  });
}

// ---------------------------------------------------------------- Summaries and the payroll feed

/** Hours by person and job for a date range (what the viewer may see). */
export async function getTimeSummary(db, companyId, viewer, { from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new LedgerError('Choose a date range (from on or before to)');
  const params = [companyId, from, to];
  const vis = visibleClause(viewer, 't', params);
  const { rows } = await db.query(
    `SELECT t.user_id AS "userId", u.name AS "userName", t.job_id AS "jobId", coalesce(j.name, '(no job)') AS "jobName",
            sum(t.minutes)::int AS minutes, sum(t.minutes) FILTER (WHERE t.billable)::int AS "billableMinutes",
            sum(t.minutes) FILTER (WHERE t.status = 'approved')::int AS "approvedMinutes"
       FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.company_id = $1 AND t.work_date BETWEEN $2 AND $3 AND ${vis}
      GROUP BY t.user_id, u.name, t.job_id, j.name ORDER BY u.name, 4`, params);
  const fix = (r) => ({ ...r, billableMinutes: r.billableMinutes ?? 0, approvedMinutes: r.approvedMinutes ?? 0 });
  const byJob = new Map();
  for (const r of rows) {
    const k = r.jobId ?? 'none';
    const j = byJob.get(k) ?? { jobId: r.jobId, jobName: r.jobName, minutes: 0, billableMinutes: 0 };
    j.minutes += r.minutes; j.billableMinutes += r.billableMinutes ?? 0;
    byJob.set(k, j);
  }
  return { from, to, rows: rows.map(fix), jobs: [...byJob.values()].sort((a, b) => b.minutes - a.minutes),
    totalMinutes: rows.reduce((t, r) => t + r.minutes, 0) };
}

/**
 * Hours to pay in a payroll run, from approved timesheets not yet paid. For each active employee on
 * the pay schedule who is linked to a person: regular, overtime and double-time hours (federal
 * 40-hour week; California daily rules too). Whole workweeks are read so weekly overtime is right
 * when a workweek straddles two pay periods. Unpaid approved hours from before the period (approved
 * late, or reopened by a voided paycheck) are included too, and flagged.
 */
export async function getPayrollHours(db, companyId, { payFrequency, periodStart, periodEnd }) {
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodEnd < periodStart) throw new LedgerError('Pay period must be two dates, start on or before end');
  if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(payFrequency)) throw new LedgerError('Choose a pay schedule');
  const { rows: emps } = await db.query(
    `SELECT e.id, e.first_name AS "firstName", e.last_name AS "lastName", e.pay_type AS "payType", e.work_state AS "workState", e.user_id AS "userId"
       FROM employees e WHERE e.company_id = $1 AND e.active AND e.pay_frequency = $2 ORDER BY e.last_name, e.first_name`, [companyId, payFrequency]);
  const linked = emps.filter((e) => e.userId);
  const { rows: [early] } = linked.length ? await db.query(
    `SELECT to_char(min(work_date), 'YYYY-MM-DD') AS d FROM time_entries
      WHERE company_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'approved' AND paid_run_id IS NULL AND work_date < $3`,
    [companyId, linked.map((e) => e.userId), periodStart]) : { rows: [{}] };
  const from = workweekStart(early?.d && early.d < periodStart ? early.d : periodStart);
  const to = addDays(workweekStart(periodEnd), 6);
  const { rows: days } = linked.length ? await db.query(
    `SELECT user_id, to_char(work_date, 'YYYY-MM-DD') AS d, status, (paid_run_id IS NOT NULL) AS paid, sum(minutes)::int AS m
       FROM time_entries WHERE company_id = $1 AND user_id = ANY($2::uuid[]) AND work_date BETWEEN $3 AND $4
      GROUP BY user_id, work_date, status, paid_run_id IS NOT NULL`, [companyId, linked.map((e) => e.userId), from, to]) : { rows: [] };
  const out = [];
  for (const e of emps) {
    const name = `${e.firstName} ${e.lastName}`;
    const row = { employeeId: e.id, name, payType: e.payType, workState: e.workState, linked: Boolean(e.userId),
      regularMinutes: 0, overtimeMinutes: 0, doubleTimeMinutes: 0, waitingMinutes: 0, warnings: [] };
    if (!e.userId) {
      if (e.payType === 'hourly') row.warnings.push('not linked to a person, so no timesheet hours');
      out.push(row); continue;
    }
    const mine = days.filter((d) => d.user_id === e.userId);
    // Hours counted toward the workweek: approved (paid or not). Paid days before the period count
    // toward the 40 hours but aren't paid again.
    const perDay = new Map();
    for (const d of mine) if (d.status === 'approved') perDay.set(d.d, (perDay.get(d.d) ?? 0) + d.m);
    const paidInPeriod = mine.some((d) => d.paid && d.d >= periodStart && d.d <= periodEnd);
    if (paidInPeriod) row.warnings.push('some hours in this period were already paid; only the unpaid ones are included');
    const unpaidByDay = new Map();
    for (const d of mine) if (d.status === 'approved' && !d.paid) unpaidByDay.set(d.d, (unpaidByDay.get(d.d) ?? 0) + d.m);
    let earlierMinutes = 0;
    for (const s of splitOvertime([...perDay].map(([date, minutes]) => ({ date, minutes })), { state: e.workState })) {
      if (s.date > periodEnd) continue;
      const unpaid = unpaidByDay.get(s.date) ?? 0;
      if (!unpaid) continue;
      // If part of a day was already paid, pay the remaining part at the day's highest rates.
      let left = unpaid;
      const dt = Math.min(left, s.doubleTime); left -= dt;
      const ot = Math.min(left, s.overtime); left -= ot;
      row.doubleTimeMinutes += dt; row.overtimeMinutes += ot; row.regularMinutes += left;
      if (s.date < periodStart) earlierMinutes += unpaid;
    }
    if (earlierMinutes) row.warnings.push(`includes ${minutesToHours(earlierMinutes)} unpaid hours from before this period (approved late, or from a voided paycheck)`);
    row.waitingMinutes = mine.filter((d) => ['draft', 'submitted'].includes(d.status) && d.d >= periodStart && d.d <= periodEnd).reduce((t, d) => t + d.m, 0);
    if (row.waitingMinutes) row.warnings.push(`${minutesToHours(row.waitingMinutes)} hours in this period are not approved yet`);
    if (e.payType === 'salary' && row.overtimeMinutes + row.doubleTimeMinutes > 0) {
      row.warnings.push('salaried: hours over 40 are shown for reference; check whether this employee is exempt from overtime');
    }
    out.push(row);
  }
  return {
    payFrequency, periodStart, periodEnd,
    employees: out.map((r) => ({ ...r, hours: minutesToHours(r.regularMinutes), overtimeHours: minutesToHours(r.overtimeMinutes), doubleTimeHours: minutesToHours(r.doubleTimeMinutes) })),
  };
}

/** Link an employee to the person who signs in (so their approved time can be paid), or unlink with null. */
export async function linkEmployeeUser(pool, companyId, employeeId, userId, { actor = null } = {}) {
  if (!isId(employeeId)) throw new LedgerError('Employee not found');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (userId != null && userId !== '') {
      if (!isId(userId) || !(await departmentOf(c, companyId, userId)).member) throw new LedgerError('That person is not a member of this company');
      const { rows: [other] } = await c.query("SELECT first_name || ' ' || last_name AS n FROM employees WHERE company_id = $1 AND user_id = $2 AND id <> $3", [companyId, userId, employeeId]);
      if (other) throw new LedgerError(`That person is already linked to employee ${other.n}`);
    } else userId = null;
    const { rowCount } = await c.query('UPDATE employees SET user_id = $3 WHERE company_id = $1 AND id = $2', [companyId, employeeId, userId]);
    if (!rowCount) throw new LedgerError('Employee not found');
    await appendAudit(c, companyId, { action: 'link_user', entity: 'employee', entityId: employeeId, actor, payload: { userId } });
    return { ok: true, employeeId, userId };
  });
}
