// Projects and what is waiting to be billed on them (Homer, 2026-10-25).
// ℹ️ A project is a job (the same list time is entered against). Time entries marked billable and bill lines
// marked "bill to client" are unbilled until an invoice line points at them; voiding that invoice frees them.
// The invoice form's "Pull in unbilled time and costs" lists them here and adds one line for each.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { parseProjectList, splitProjectName } from '../core/projects.js';
import { minutesToHours } from '../core/timesheets.js';
import { divRoundHalfUp } from '../core/money.js';
import { appendAudit } from './audit.js';
import { lineAmount, minutesToHoursText } from './arapService.js';
import { bpToQuantity, bpToPercent, COST_SHARE_SQL } from './tripService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);

/**
 * Minutes → hours as an invoice quantity with up to 2 decimals, half-up (50 min → "0.83", 90 → "1.5").
 * Invoice hours are billed to 2 decimals (Homer 2026-11-03) so the hours the client sees × the rate = the amount.
 */
export const minutesToQuantity = minutesToHoursText;

/** A share of a trip's travel time, in hours to 2 decimals: 6 h (360 min) at 60% → "3.6". */
export function sharedHoursQuantity(minutes, shareBp) {
  const h = divRoundHalfUp(BigInt(minutes) * BigInt(shareBp), 6000n); // minutes × bp / 6000 = hundredths of an hour
  const frac = String(h % 100n).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${h / 100n}.${frac}` : String(h / 100n);
}

/**
 * Add projects from pasted folder names (see src/core/projects.js). Each name is split into number, customer,
 * reference and site address (Homer, 2026-10-26: "26-002 DWH, 285 Bridgestone Way, Buda, TX DIR"); the project is
 * named without the address, and the address goes in its site address.
 * - customerId (optional) is used for every project instead of the customer read from the name.
 * - A customer read from the name is matched to the customer list by name; makeCustomers adds the ones that aren't.
 * - A project already on the list (by its folder name or its new name) gets only what it is missing: its customer,
 *   its site address, and the shorter name. Nothing already filled in is overwritten.
 * With preview, nothing is saved: each row says new / fills in / already on the list, and which customers are new.
 */
export async function importProjects(pool, companyId, { text, customerId = null, makeCustomers = false, preview = false }, { actor = null } = {}) {
  let list;
  try { list = parseProjectList(text); } catch (e) { throw new LedgerError(e.message); }
  if (!list.length) throw new LedgerError('Paste one folder name (or path) per line');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    let cust = null;
    if (customerId) {
      if (!isId(customerId)) throw new LedgerError('That customer does not exist');
      cust = (await c.query("SELECT id FROM contacts WHERE company_id = $1 AND id = $2 AND kind = 'customer'", [companyId, customerId])).rows[0]?.id;
      if (!cust) throw new LedgerError('That customer does not exist');
    }
    const { rows: jobs } = await c.query('SELECT id, name, customer_id, address FROM jobs WHERE company_id = $1', [companyId]);
    const jobBy = new Map(jobs.map((j) => [j.name.trim().toLowerCase(), j]));
    const { rows: custs } = await c.query("SELECT id, name FROM contacts WHERE company_id = $1 AND kind = 'customer'", [companyId]);
    const custBy = new Map(custs.map((x) => [x.name.trim().toLowerCase(), x.id]));
    const takenNames = new Set(jobBy.keys());
    const rows = [];
    for (const p of list) {
      const parts = splitProjectName(p.name, p.code);
      const customerName = cust ? null : parts.customer?.slice(0, 120) ?? null;
      const known = customerName ? custBy.get(customerName.toLowerCase()) ?? null : null;
      const job = jobBy.get(p.name.toLowerCase()) ?? jobBy.get(parts.name.toLowerCase());
      const row = { name: parts.name, folder: p.name, code: p.code, customer: customerName, customerIsNew: !!customerName && !known,
        reference: parts.reference, address: parts.address, note: parts.note, isNew: !job, fills: [] };
      if (job) {
        if (!job.customer_id && (cust || customerName)) row.fills.push('customer');
        if (!job.address && parts.address) row.fills.push('site address');
        if (job.name !== parts.name && !takenNames.has(parts.name.toLowerCase())) row.fills.push('shorter name');
        row.status = row.fills.length ? 'fills in' : 'already on the list';
      } else if (takenNames.has(parts.name.toLowerCase())) { row.status = 'already on the list'; row.isNew = false; }
      else row.status = 'new';
      takenNames.add(parts.name.toLowerCase());
      rows.push({ row, job, known });
    }
    const out = rows.map((r) => r.row);
    if (preview) return { preview: true, projects: out, added: 0, updated: 0, customersAdded: 0 };
    let added = 0; let updated = 0; let customersAdded = 0;
    const customerFor = async ({ row, known }) => {
      if (cust) return cust;
      if (known) return known;
      if (!row.customer || !makeCustomers) return null;
      const hit = custBy.get(row.customer.toLowerCase());
      if (hit) return hit;
      const { rows: [n] } = await c.query(
        "INSERT INTO contacts (company_id, kind, name, created_by) VALUES ($1, 'customer', $2, $3) RETURNING id", [companyId, row.customer, actor]);
      await appendAudit(c, companyId, { action: 'create', entity: 'customer', entityId: n.id, actor, payload: { name: row.customer, from: 'project folders' } });
      custBy.set(row.customer.toLowerCase(), n.id); customersAdded++;
      return n.id;
    };
    for (const r of rows) {
      const { row, job } = r;
      if (row.status === 'new') {
        await c.query('INSERT INTO jobs (company_id, name, code, customer_id, address) VALUES ($1,$2,$3,$4,$5)',
          [companyId, row.name, row.code, await customerFor(r), row.address]);
        added++;
      } else if (row.status === 'fills in') {
        const customer = row.fills.includes('customer') ? await customerFor(r) : null;
        await c.query(`UPDATE jobs SET customer_id = COALESCE(customer_id, $3), address = COALESCE(address, $4), name = $5
                        WHERE company_id = $1 AND id = $2`,
          [companyId, job.id, customer, row.fills.includes('site address') ? row.address : null, row.fills.includes('shorter name') ? row.name : job.name]);
        await appendAudit(c, companyId, { action: 'update', entity: 'job', entityId: job.id, actor, payload: { fills: row.fills, from: 'project folders' } });
        updated++;
      }
    }
    if (added) await appendAudit(c, companyId, { action: 'import', entity: 'jobs', entityId: null, actor, payload: { added, customerId: cust } });
    return { preview: false, projects: out, added, updated, customersAdded };
  });
}

/**
 * Billable time and costs not yet on an invoice, for one project (jobId) or every project of a customer
 * (customerId). from / to (optional) limit the work date or the bill date.
 */
export async function listUnbilled(db, companyId, { jobId = null, customerId = null, from = null, to = null } = {}) {
  if (jobId && !isId(jobId)) throw new LedgerError('Project not found');
  if (customerId && !isId(customerId)) throw new LedgerError('Customer not found');
  if (!jobId && !customerId) throw new LedgerError('Choose a project or a customer');
  if (from && !isIsoDate(from)) throw new LedgerError('from must be YYYY-MM-DD');
  if (to && !isIsoDate(to)) throw new LedgerError('to must be YYYY-MM-DD');
  const params = [companyId, jobId, customerId, from, to];
  const jobMatch = '(($2::uuid IS NOT NULL AND j.id = $2) OR ($2::uuid IS NULL AND j.customer_id = $3))';
  const notBilled = (col, id) => `NOT EXISTS (SELECT 1 FROM document_lines bl JOIN documents bd ON bd.id = bl.document_id
    WHERE bl.${col} = ${id} AND bd.status = 'posted')`;
  const { rows: time } = await db.query(
    `SELECT t.id, to_char(t.work_date, 'YYYY-MM-DD') AS date, t.minutes, t.notes, t.status, u.name AS "userName",
            j.id AS "jobId", j.name AS "jobName", j.code AS "jobCode"
       FROM time_entries t JOIN jobs j ON j.id = t.job_id JOIN users u ON u.id = t.user_id
      WHERE t.company_id = $1 AND ${jobMatch} AND t.billable AND t.status <> 'rejected'
        AND ($4::date IS NULL OR t.work_date >= $4) AND ($5::date IS NULL OR t.work_date <= $5)
        AND ${notBilled('time_entry_id', 't.id')}
      ORDER BY t.work_date, u.name, t.start_time NULLS LAST, t.created_at LIMIT 1000`, params);
  const { rows: costs } = await db.query(
    `SELECT l.id::text AS id, to_char(coalesce(l.service_date, d.doc_date), 'YYYY-MM-DD') AS date, l.description, l.amount_cents AS "amountCents",
            d.number AS "billNumber", v.name AS "vendorName", j.id AS "jobId", j.name AS "jobName", j.code AS "jobCode"
       FROM document_lines l JOIN documents d ON d.id = l.document_id JOIN contacts v ON v.id = d.contact_id JOIN jobs j ON j.id = l.job_id
      WHERE l.company_id = $1 AND ${jobMatch} AND l.billable AND d.kind = 'bill' AND d.status = 'posted'
        AND ($4::date IS NULL OR coalesce(l.service_date, d.doc_date) >= $4) AND ($5::date IS NULL OR coalesce(l.service_date, d.doc_date) <= $5)
        AND ${notBilled('billed_line_id', 'l.id')}
      ORDER BY coalesce(l.service_date, d.doc_date), l.id LIMIT 1000`, params);
  // A trip's travel time and costs, one row per project of the trip at that project's share; billed once per project.
  const notBilledFor = (col, id) => `NOT EXISTS (SELECT 1 FROM document_lines bl JOIN documents bd ON bd.id = bl.document_id
    WHERE bl.${col} = ${id} AND bl.job_id = j.id AND bd.status = 'posted')`;
  const { rows: tripTime } = await db.query(
    `SELECT t.id, to_char(t.work_date, 'YYYY-MM-DD') AS date, t.minutes, t.notes, t.status, u.name AS "userName",
            j.id AS "jobId", j.name AS "jobName", j.code AS "jobCode", tr.name AS "tripName", tj.share_bp AS "shareBp"
       FROM time_entries t JOIN trips tr ON tr.id = t.trip_id JOIN trip_jobs tj ON tj.trip_id = tr.id JOIN jobs j ON j.id = tj.job_id
       JOIN users u ON u.id = t.user_id
      WHERE t.company_id = $1 AND ${jobMatch} AND tj.share_bp > 0 AND t.billable AND t.status <> 'rejected'
        AND ($4::date IS NULL OR t.work_date >= $4) AND ($5::date IS NULL OR t.work_date <= $5)
        AND ${notBilledFor('time_entry_id', 't.id')}
      ORDER BY t.work_date, j.name LIMIT 1000`, params);
  const { rows: tripCosts } = await db.query(
    `SELECT tc.id, to_char(tc.cost_date, 'YYYY-MM-DD') AS date, tc.description, tc.vendor AS "vendorName", tc.amount_cents AS "amountCents",
            j.id AS "jobId", j.name AS "jobName", j.code AS "jobCode", tr.name AS "tripName", ${COST_SHARE_SQL} AS "shareBp"
       FROM trip_costs tc JOIN trips tr ON tr.id = tc.trip_id JOIN trip_jobs tj ON tj.trip_id = tr.id JOIN jobs j ON j.id = tj.job_id
      WHERE tc.company_id = $1 AND ${jobMatch} AND ${COST_SHARE_SQL} > 0 AND tc.status = 'posted'
        AND ($4::date IS NULL OR tc.cost_date >= $4) AND ($5::date IS NULL OR tc.cost_date <= $5)
        AND ${notBilledFor('trip_cost_id', 'tc.id')}
      ORDER BY tc.cost_date, tc.created_at, j.name LIMIT 1000`, params);
  return {
    time: [
      ...time.map((t) => ({ ...t, hours: minutesToHours(t.minutes), quantity: minutesToQuantity(t.minutes), lineJobId: null })),
      ...tripTime.map((t) => {
        const quantity = sharedHoursQuantity(t.minutes, t.shareBp);
        return { ...t, hours: quantity, fullHours: minutesToHours(t.minutes), share: bpToPercent(t.shareBp), quantity, lineJobId: t.jobId };
      }),
    ],
    costs,
    tripCosts: tripCosts.map((x) => {
      const quantity = bpToQuantity(x.shareBp);
      return { ...x, amountCents: Number(x.amountCents), share: bpToPercent(x.shareBp), quantity, shareCents: lineAmount(quantity, Number(x.amountCents)) };
    }),
  };
}

// ---------------------------------------------------------------- Deleting a project (Homer, 2026-11-16)
// "need to be able to delete errant job number": a project made by mistake (a phantom "26") can be deleted, but only
// when nothing in the books points at it. Invoices and bills are saved records, so they are never moved: edit that
// invoice or bill to the right project first. Time, trip shares, purchases and items waiting from the road can be
// moved to another project in one step (moveProjectUses), and then the project deleted.

/** What still points at a project: [{ kind, count, text, movable }] (empty = it can be deleted). */
export async function projectUses(db, companyId, jobId) {
  if (!isId(jobId)) throw new LedgerError('Project not found');
  const { rows: [job] } = await db.query('SELECT id, name, code FROM jobs WHERE company_id = $1 AND id = $2', [companyId, jobId]);
  if (!job) throw new LedgerError('Project not found');
  const uses = [];
  const { rows: docs } = await db.query(
    `SELECT DISTINCT d.kind, d.number, d.status FROM documents d LEFT JOIN document_lines l ON l.document_id = d.id
      WHERE d.company_id = $1 AND (d.job_id = $2 OR l.job_id = $2) ORDER BY d.kind, d.number LIMIT 50`, [companyId, jobId]);
  for (const kind of ['invoice', 'bill']) {
    const list = docs.filter((d) => d.kind === kind);
    if (list.length) {
      uses.push({ kind: `${kind}s`, count: list.length, movable: false,
        text: `${list.length} ${kind}${list.length === 1 ? '' : 's'} (${list.slice(0, 6).map((d) => d.number + (d.status === 'void' ? ' void' : '')).join(', ')}${list.length > 6 ? '…' : ''}): edit ${list.length === 1 ? 'it' : 'each'} to name the right project` });
    }
  }
  const { rows: [time] } = await db.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM document_lines l JOIN documents d ON d.id = l.document_id
        WHERE l.time_entry_id = t.id AND d.status = 'posted'))::int AS billed
       FROM time_entries t WHERE t.company_id = $1 AND t.job_id = $2`, [companyId, jobId]);
  if (time.n) uses.push({ kind: 'time', count: time.n, movable: time.billed === 0, text: `${time.n} time ${time.n === 1 ? 'entry' : 'entries'}${time.billed ? ` (${time.billed} already on an invoice)` : ''}` });
  const { rows: trips } = await db.query(
    `SELECT t.name, (tj.share_bp + coalesce(tj.air_bp, 0) + coalesce(tj.hotel_bp, 0) + coalesce(tj.car_bp, 0) + coalesce(tj.rest_bp, 0)) = 0 AS zero
       FROM trip_jobs tj JOIN trips t ON t.id = tj.trip_id WHERE tj.company_id = $1 AND tj.job_id = $2 ORDER BY t.start_date`, [companyId, jobId]);
  const shared = trips.filter((t) => !t.zero);
  if (shared.length) uses.push({ kind: 'trips', count: shared.length, movable: true, text: `a share of ${shared.length} trip${shared.length === 1 ? '' : 's'} (${shared.map((t) => t.name).join(', ')})` });
  const { rows: [buys] } = await db.query('SELECT count(*)::int AS n FROM purchases WHERE company_id = $1 AND job_id = $2', [companyId, jobId]);
  if (buys.n) uses.push({ kind: 'purchases', count: buys.n, movable: true, text: `${buys.n} purchase${buys.n === 1 ? '' : 's'} (equipment or supplies)` });
  const { rows: [road] } = await db.query(
    "SELECT count(*)::int AS n FROM road_items WHERE company_id = $1 AND status = 'pending' AND strpos(data::text, $2) > 0", [companyId, jobId]);
  if (road.n) uses.push({ kind: 'road', count: road.n, movable: true, text: `${road.n} item${road.n === 1 ? '' : 's'} waiting in From the road` });
  return { project: job, uses, canDelete: uses.length === 0, canMove: uses.length > 0 && uses.every((u) => u.movable) };
}

/**
 * Delete a project nothing points at. A 0% line on a trip carries nothing and goes with it (setting the share to 0
 * at the trip is how a project is taken off one). Refused, with the list, when anything else uses it.
 */
export async function deleteProject(pool, companyId, jobId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { project, uses } = await projectUses(c, companyId, jobId);
    if (uses.length) throw new LedgerError(`${project.name} is still used, so it can't be deleted`, uses.map((u) => u.text));
    await c.query('DELETE FROM trip_jobs WHERE company_id = $1 AND job_id = $2', [companyId, jobId]);
    await c.query('DELETE FROM jobs WHERE company_id = $1 AND id = $2', [companyId, jobId]);
    await appendAudit(c, companyId, { action: 'delete', entity: 'job', entityId: jobId, actor, payload: { name: project.name, code: project.code } });
    return { deleted: true, name: project.name };
  });
}

/**
 * Move what uses a project onto another one (toJobId): its time entries, its trip shares, its purchases, and items
 * waiting from the road. Refused when an invoice or bill names it, when its time is already billed, or when the other
 * project is already on the same trip (set one of them to 0% at the trip first).
 */
export async function moveProjectUses(pool, companyId, jobId, toJobId, { actor = null } = {}) {
  if (!isId(toJobId) || toJobId === jobId) throw new LedgerError('Choose the project to move them to');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { project, uses } = await projectUses(c, companyId, jobId);
    const stuck = uses.filter((u) => !u.movable);
    if (stuck.length) throw new LedgerError(`Some of what uses ${project.name} can't be moved`, stuck.map((u) => u.text));
    const { rows: [to] } = await c.query('SELECT id, name FROM jobs WHERE company_id = $1 AND id = $2 AND is_active', [companyId, toJobId]);
    if (!to) throw new LedgerError('Choose an open project to move them to');
    const { rows: clash } = await c.query(
      `SELECT t.name FROM trip_jobs a JOIN trip_jobs b ON b.trip_id = a.trip_id AND b.job_id = $3 JOIN trips t ON t.id = a.trip_id
        WHERE a.company_id = $1 AND a.job_id = $2 AND (a.share_bp + coalesce(a.air_bp, 0) + coalesce(a.hotel_bp, 0) + coalesce(a.car_bp, 0) + coalesce(a.rest_bp, 0)) > 0`,
      [companyId, jobId, toJobId]);
    if (clash.length) throw new LedgerError(`${to.name} is already on ${clash.map((t) => t.name).join(', ')}`,
      ['Open the trip and set the shares there, giving this project 0%; then delete it']);
    const time = await c.query('UPDATE time_entries SET job_id = $3, updated_at = now() WHERE company_id = $1 AND job_id = $2', [companyId, jobId, toJobId]);
    // A trip share moves as a new line for the other project with the same shares (the old line's 0% copies just go).
    await c.query(`INSERT INTO trip_jobs (company_id, trip_id, job_id, share_bp, air_bp, hotel_bp, car_bp, rest_bp)
      SELECT company_id, trip_id, $3, share_bp, air_bp, hotel_bp, car_bp, rest_bp FROM trip_jobs a
       WHERE a.company_id = $1 AND a.job_id = $2 AND NOT EXISTS (SELECT 1 FROM trip_jobs b WHERE b.trip_id = a.trip_id AND b.job_id = $3)`,
    [companyId, jobId, toJobId]);
    const trips = await c.query('DELETE FROM trip_jobs WHERE company_id = $1 AND job_id = $2', [companyId, jobId]);
    const buys = await c.query('UPDATE purchases SET job_id = $3 WHERE company_id = $1 AND job_id = $2', [companyId, jobId, toJobId]);
    const road = await c.query(`UPDATE road_items SET data = replace(data::text, $2, $3)::jsonb
      WHERE company_id = $1 AND status = 'pending' AND strpos(data::text, $2) > 0`, [companyId, jobId, toJobId]);
    const moved = { time: time.rowCount, trips: trips.rowCount, purchases: buys.rowCount, road: road.rowCount };
    await appendAudit(c, companyId, { action: 'move', entity: 'job', entityId: jobId, actor, payload: { to: toJobId, ...moved } });
    return { moved, to: to.name };
  });
}
