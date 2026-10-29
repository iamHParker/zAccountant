// Late charges (Homer, 2026-10-29): the settings, and the monthly run that bills interest and the late-statement fee.
// The rules are pure, in src/core/lateCharges.js.
//
// ℹ️ How a run reaches the books: each customer charged gets one ordinary invoice, dated the run date, with a
// "Finance charge" line and a "Late statement fee" line credited to the Late Charges income account:
//   Dr Accounts Receivable   Cr Late Charges & Finance Charges
// It is marked with the month it charges (late_charge_month), so the database refuses a second one for that customer
// that month; voiding it frees the month again. A late-charge invoice is never itself charged (no interest on interest).
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { toCents, percentToPpm, formatMoney } from '../core/money.js';
import { lateSettings, chargesFor, MAX_LATE_APR_PPM } from '../core/lateCharges.js';
import { createDocument } from './arapService.js';
import { appendAudit } from './audit.js';

const LATE_KEY = 'late_charges';

const settingsOut = (co) => {
  const s = lateSettings(co);
  return { apr: s.apr, feeCents: co.late_fee_cents ?? null, graceDays: s.graceDays, holidayGraceDays: s.holidayGraceDays, on: s.on };
};

export async function getLateSettings(db, companyId) {
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return settingsOut(co);
}

/** Save the APR (a percent like "6", empty = no interest), the fee in dollars (empty = none) and the two grace periods. */
export async function setLateSettings(pool, companyId, { apr, fee, graceDays, holidayGraceDays, actor = null }) {
  const errors = [];
  let aprText = apr == null ? null : String(apr).trim().replace(/%$/, '').trim() || null;
  if (aprText) {
    try {
      const ppm = percentToPpm(aprText);
      if (ppm > MAX_LATE_APR_PPM) errors.push('the yearly rate must be 36% or less');
      aprText = ppm === 0 ? null : String(Number(aprText)); // "06.50" → "6.5"
    } catch { errors.push('the yearly rate must be a percent like 6 or 18.5'); }
  }
  let feeCents = null;
  if (fee != null && String(fee).trim() !== '') {
    try { feeCents = toCents(String(fee).replace(/[$,\s]/g, '')); } catch { errors.push('the late-statement fee must be a dollar amount like 35.00'); }
    if (feeCents != null && (feeCents < 0 || feeCents > 100000)) errors.push('the late-statement fee must be $0 to $1,000');
    if (feeCents === 0) feeCents = null;
  }
  const days = (v, label, dflt) => {
    if (v == null || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 365) { errors.push(`${label} must be 0 to 365 days`); return dflt; }
    return n;
  };
  const grace = days(graceDays, 'the grace period', 30);
  const holiday = days(holidayGraceDays, 'the November/December grace period for homeowners', 60);
  if (errors.length) throw new LedgerError('Late-charge settings are not valid', errors);
  return withTransaction(pool, async (c) => {
    const { rows: [co] } = await c.query(
      `UPDATE companies SET late_apr = $2, late_fee_cents = $3, late_grace_days = $4, late_holiday_grace_days = $5 WHERE id = $1 RETURNING *`,
      [companyId, aprText, feeCents, grace, holiday]);
    if (!co) throw new LedgerError('Company not found');
    await appendAudit(c, companyId, { action: 'update_settings', entity: 'company', entityId: companyId, actor,
      payload: { lateCharges: { apr: aprText, feeCents, graceDays: grace, holidayGraceDays: holiday } } });
    return settingsOut(co);
  });
}

/** Every customer's open invoices as of a date (payments and voids after it ignored), grouped by customer. */
async function openInvoicesAsOf(db, companyId, asOf) {
  const { rows } = await db.query(
    `SELECT d.id, d.number, to_char(d.due_date, 'YYYY-MM-DD') AS due_date, d.plan_count, d.no_late_charges, d.late_charge_month,
            ct.id AS contact_id, ct.name, ct.is_homeowner, ct.no_late_charges AS contact_no_late, ct.email,
            d.total_cents - COALESCE((SELECT sum(a.amount_cents) FROM payment_applications a JOIN payments p ON p.id = a.payment_id
                                       WHERE a.document_id = d.id AND p.pay_date <= $2 AND (p.status = 'posted' OR p.void_date > $2)), 0)::bigint AS balance
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = $1 AND d.kind = 'invoice' AND d.doc_date <= $2 AND (d.status = 'posted' OR d.void_date > $2)
      ORDER BY lower(ct.name), d.due_date`, [companyId, asOf]);
  const byContact = new Map();
  for (const r of rows) {
    let g = byContact.get(r.contact_id);
    if (!g) byContact.set(r.contact_id, g = { contactId: r.contact_id, name: r.name, email: r.email, isHomeowner: r.is_homeowner, noLateCharges: r.contact_no_late, invoices: [] });
    g.invoices.push({ id: r.id, number: r.number, dueDate: r.due_date, balanceCents: Number(r.balance), planCount: r.plan_count,
      noLateCharges: r.no_late_charges, lateChargeMonth: r.late_charge_month });
  }
  return [...byContact.values()];
}

async function buildPreview(db, companyId, asOf) {
  if (!isIsoDate(asOf)) throw new LedgerError('Choose the date to charge as of (YYYY-MM-DD)');
  const { rows: [co] } = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  const settings = lateSettings(co);
  const month = asOf.slice(0, 7);
  const { rows: done } = await db.query(
    `SELECT contact_id, number FROM documents WHERE company_id = $1 AND late_charge_month = $2 AND status = 'posted'`, [companyId, month]);
  const charged = new Map(done.map((r) => [r.contact_id, r.number]));
  const customers = [];
  for (const g of await openInvoicesAsOf(db, companyId, asOf)) {
    const ch = chargesFor(g, g.invoices, settings, asOf);
    if (ch.totalCents === 0 && !charged.has(g.contactId)) continue;
    customers.push({ contactId: g.contactId, name: g.name, email: g.email, isHomeowner: g.isHomeowner,
      alreadyChargedOn: charged.get(g.contactId) ?? null, ...ch,
      invoices: ch.invoices.map(({ id, number, dueDate, graceEnds, balanceCents }) => ({ id, number, dueDate, graceEnds, balanceCents })) });
  }
  const toPost = customers.filter((x) => !x.alreadyChargedOn && x.totalCents > 0);
  return { asOf, month, settings: settingsOut(co), aprPpm: settings.aprPpm, customers, totalCents: toPost.reduce((s, x) => s + x.totalCents, 0), count: toPost.length };
}

/** What a run as of a date would charge each customer. Nothing is saved. */
export async function previewLateCharges(db, companyId, { asOf }) {
  const p = await buildPreview(db, companyId, asOf);
  delete p.aprPpm;
  return p;
}

/** The Late Charges income account, added to the chart the first time it is needed (4910, or the next free number). */
async function lateAccount(c, companyId, actor) {
  const { rows: [a] } = await c.query('SELECT id FROM accounts WHERE company_id = $1 AND system_key = $2', [companyId, LATE_KEY]);
  if (a) return a.id;
  const { rows: used } = await c.query(`SELECT code FROM accounts WHERE company_id = $1 AND code LIKE '49__'`, [companyId]);
  const taken = new Set(used.map((r) => r.code));
  let code = null;
  for (let n = 4910; n <= 4999 && !code; n++) if (!taken.has(String(n))) code = String(n);
  if (!code) throw new LedgerError('Add an income account for late charges first (no free number from 4910 to 4999)');
  const { rows: [made] } = await c.query(
    `INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow, system_key) VALUES ($1,$2,'Late Charges & Finance Charges','revenue','other',NULL,$3)
     RETURNING id, code, name`, [companyId, code, LATE_KEY]);
  await appendAudit(c, companyId, { action: 'create', entity: 'account', entityId: made.id, actor, payload: { ...made, systemKey: LATE_KEY } });
  return made.id;
}

const pct = (ppm) => `${Number(ppm) / 10000}%`;

/**
 * Post the late charges as of a date: one invoice for each customer in contactIds (or every customer the preview
 * would charge). Customers already charged that month are skipped. All or nothing.
 */
export async function postLateCharges(pool, companyId, { asOf, contactIds = null, actor = null }) {
  if (contactIds != null && !Array.isArray(contactIds)) throw new LedgerError('contactIds must be a list');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const p = await buildPreview(c, companyId, asOf);
    if (!p.settings.on) throw new LedgerError('Set the late-charge rate or fee in Settings first');
    const want = contactIds ? new Set(contactIds) : null;
    const todo = p.customers.filter((x) => !x.alreadyChargedOn && x.totalCents > 0 && (!want || want.has(x.contactId)));
    if (!todo.length) throw new LedgerError('There is nothing to charge as of that date');
    const accountId = await lateAccount(c, companyId, actor);
    const made = [];
    for (const x of todo) {
      const lines = [];
      if (x.interestCents > 0) {
        lines.push({ accountId, quantity: '1', amount: x.interestCents,
          description: `Finance charge: ${pct(p.aprPpm)} a year, one month on ${formatMoney(x.pastDueCents, { accounting: false })} past due (invoice${x.invoices.length > 1 ? 's' : ''} ${x.invoices.map((d) => d.number).join(', ')})` });
      }
      if (x.feeCents > 0) lines.push({ accountId, quantity: '1', amount: x.feeCents, description: 'Late statement fee' });
      const doc = await createDocument(c, companyId, { kind: 'invoice', contactId: x.contactId, date: asOf, lines,
        memo: `Late charges for ${p.month}`, lateChargeMonth: p.month, actor });
      made.push({ contactId: x.contactId, name: x.name, documentId: doc.id, number: doc.number, totalCents: doc.totalCents });
    }
    await appendAudit(c, companyId, { action: 'post_late_charges', entity: 'company', entityId: companyId, actor,
      payload: { asOf, month: p.month, invoices: made.map((m) => ({ documentId: m.documentId, totalCents: m.totalCents })) } });
    return { asOf, month: p.month, invoices: made, totalCents: made.reduce((s, m) => s + m.totalCents, 0) };
  });
}
