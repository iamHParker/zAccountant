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
import { lineAmount } from './arapService.js';
import { bpToQuantity, bpToPercent, COST_SHARE_SQL } from './tripService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);

/** Minutes → hours as an invoice quantity with up to 4 decimals, half-up (50 min → "0.8333", 90 → "1.5"). */
export function minutesToQuantity(minutes) {
  const q4 = divRoundHalfUp(BigInt(minutes) * 10000n, 60n);
  const whole = q4 / 10000n;
  const frac = String(q4 % 10000n).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** A share of a trip's travel time, in hours to 4 decimals: 6 h (360 min) at 60% → "3.6". */
export function sharedHoursQuantity(minutes, shareBp) {
  const q4 = divRoundHalfUp(BigInt(minutes) * BigInt(shareBp), 60n); // minutes × bp / 60 = hours × 10000
  const whole = q4 / 10000n;
  const frac = String(q4 % 10000n).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
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
