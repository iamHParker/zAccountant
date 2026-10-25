// Projects and what is waiting to be billed on them (Homer, 2026-10-25).
// ℹ️ A project is a job (the same list time is entered against). Time entries marked billable and bill lines
// marked "bill to client" are unbilled until an invoice line points at them; voiding that invoice frees them.
// The invoice form's "Pull in unbilled time and costs" lists them here and adds one line for each.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { parseProjectList } from '../core/projects.js';
import { minutesToHours } from '../core/timesheets.js';
import { divRoundHalfUp } from '../core/money.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);

/** Minutes → hours as an invoice quantity with up to 4 decimals, half-up (50 min → "0.8333", 90 → "1.5"). */
export function minutesToQuantity(minutes) {
  const q4 = divRoundHalfUp(BigInt(minutes) * 10000n, 60n);
  const whole = q4 / 10000n;
  const frac = String(q4 % 10000n).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Add projects from pasted folder names (see src/core/projects.js). With preview, nothing is saved: the list
 * shows which are new and which are already there. customerId (optional) is set on every new project.
 */
export async function importProjects(pool, companyId, { text, customerId = null, preview = false }, { actor = null } = {}) {
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
    const { rows: have } = await c.query('SELECT lower(trim(name)) AS n FROM jobs WHERE company_id = $1', [companyId]);
    const existing = new Set(have.map((r) => r.n));
    const rows = list.map((p) => ({ ...p, isNew: !existing.has(p.name.toLowerCase()) }));
    if (preview) return { preview: true, projects: rows, added: 0 };
    let added = 0;
    for (const p of rows.filter((r) => r.isNew)) {
      await c.query('INSERT INTO jobs (company_id, name, code, customer_id) VALUES ($1,$2,$3,$4)', [companyId, p.name, p.code, cust]);
      added++;
    }
    if (added) await appendAudit(c, companyId, { action: 'import', entity: 'jobs', entityId: null, actor, payload: { added, customerId: cust } });
    return { preview: false, projects: rows, added };
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
  return {
    time: time.map((t) => ({ ...t, hours: minutesToHours(t.minutes), quantity: minutesToQuantity(t.minutes) })),
    costs,
  };
}
