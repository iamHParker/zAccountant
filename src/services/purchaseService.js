// Equipment and supplies bought on the road (Homer, 2026-11-06; migration 041). The phone's Road page sends them;
// the desk accepts each one here, on Bills → "Bought on the road".
//
// ℹ️ How a purchase reaches the books: one journal entry, Dr the account chosen (Equipment, an asset, for something
// that lasts; Office Supplies, an expense, for what is used up), Cr what paid for it (bank, card, or an owner account
// when paid personally). Like a beam that is either part of the structure (equipment: it stays on the balance sheet
// and is depreciated) or formwork (supplies: used up and gone this year). A saved purchase is never changed: Void
// reverses its entry; the receipt photos stay with it.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate, validateEntry } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { insertEntry, reverseEntry, cleanIdempotencyKey } from './ledgerService.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v) => typeof v === 'string' && UUIDISH.test(v);
const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null); // eslint-disable-line no-control-regex

export const PURCHASE_CATEGORIES = { equipment: 'Equipment', supplies: 'Supplies' };
/** The account each kind starts on at the desk (standard chart codes): 1500 Equipment, 6200 Office Supplies. */
export const DEFAULT_PURCHASE_CODES = { equipment: '1500', supplies: '6200' };

const payableFrom = (a) => a.is_active && (a.cash_flow === 'cash' || a.subtype === 'credit_card' || (a.type === 'equity' && a.system_key !== 'retained_earnings'));
/** What a purchase may be booked to: an expense, or an asset that isn't cash or a control account (Equipment). */
const bookableTo = (a) => a.is_active && (a.type === 'expense' || (a.type === 'asset' && a.cash_flow !== 'cash' && !a.system_key));

async function lockCompany(c, companyId) {
  await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
}

/** The usual account for a kind of purchase, if the company's chart still has it. */
export async function defaultPurchaseAccount(db, companyId, category) {
  const code = DEFAULT_PURCHASE_CODES[category];
  if (!code) return null;
  const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE company_id = $1 AND code = $2', [companyId, code]);
  return a && bookableTo(a) ? a.id : null;
}

/**
 * Save a purchase and post its entry. input: date, category, amount (dollars) or amountCents, vendor, description,
 * jobId, accountId (else the usual one for the category), paidFromAccountId. Runs inside the caller's transaction
 * when given a client (accepting a road item).
 */
export async function addPurchase(pool, companyId, input, { actor = null, idempotencyKey = null } = {}) {
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT id FROM purchases WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return getPurchase(c, companyId, prior.id);
    }
    const errors = [];
    const date = input?.date;
    if (!isIsoDate(date)) errors.push('the date must be a real date');
    const category = PURCHASE_CATEGORIES[input?.category] ? input.category : null;
    if (!category) errors.push('say whether it is equipment or supplies');
    const description = text(input?.description, 300) ?? (category ? PURCHASE_CATEGORIES[category] : null);
    if (!description) errors.push('say what it was');
    const vendor = text(input?.vendor, 120);
    const serialNumber = category === 'equipment' ? text(input?.serialNumber, 60) : null;
    let amount = Number.isSafeInteger(input?.amountCents) ? input.amountCents : null;
    if (amount == null) { try { amount = toCents(String(input?.amount ?? '')); } catch { errors.push('the amount is not a dollar amount'); } }
    if (amount != null && amount <= 0) errors.push('the amount must be more than $0.00');
    const accountId = isId(input?.accountId) ? input.accountId : (category ? await defaultPurchaseAccount(c, companyId, category) : null);
    const ids = [accountId, input?.paidFromAccountId].filter(isId);
    const { rows: accts } = ids.length ? await c.query('SELECT * FROM accounts WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]) : { rows: [] };
    const to = accts.find((a) => a.id === accountId);
    const from = accts.find((a) => a.id === input?.paidFromAccountId);
    if (!to || !bookableTo(to)) errors.push(category === 'equipment' ? 'choose the account (Equipment, or an expense)' : 'choose the account (Office Supplies, or another expense)');
    if (!from || !payableFrom(from)) errors.push('choose what you paid with (bank, credit card, or paid personally)');
    let jobId = null;
    if (isId(input?.jobId)) {
      const { rows: [j] } = await c.query('SELECT id FROM jobs WHERE company_id = $1 AND id = $2', [companyId, input.jobId]);
      jobId = j?.id ?? null;
    }
    if (errors.length) throw new LedgerError('Purchase is not valid', errors);
    const label = `${PURCHASE_CATEGORIES[category]}: ${description}${vendor ? ` (${vendor})` : ''}`.slice(0, 500);
    const entry = validateEntry({ date, memo: label, lines: [
      { accountId: to.id, debitCents: amount, creditCents: 0, memo: description },
      { accountId: from.id, debitCents: 0, creditCents: amount, memo: vendor ?? description },
    ] });
    const { rows: [{ id }] } = await c.query('SELECT gen_random_uuid() AS id');
    const je = await insertEntry(c, companyId, entry, { source: 'purchase', sourceRef: id, actor });
    await c.query(
      `INSERT INTO purchases (id, company_id, purchase_date, category, vendor, description, serial_number, amount_cents, account_id, paid_from_account_id, job_id,
                              journal_entry_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, companyId, date, category, vendor, description, serialNumber, amount, to.id, from.id, jobId, je.id, idempotencyKey, actor]);
    await appendAudit(c, companyId, { action: 'create', entity: 'purchase', entityId: id, actor,
      payload: { date, category, vendor, description, serialNumber, amountCents: amount, accountId: to.id, paidFromAccountId: from.id, jobId, entryId: je.id } });
    return getPurchase(c, companyId, id);
  });
}

const SELECT = `SELECT p.id, p.purchase_date::text AS date, p.category, p.vendor, p.description, p.serial_number AS "serialNumber", p.amount_cents AS "amountCents",
    p.account_id AS "accountId", a.code AS "accountCode", a.name AS "accountName", p.paid_from_account_id AS "paidFromAccountId",
    f.name AS "paidFromName", p.job_id AS "jobId", j.code AS "jobCode", j.name AS "jobName", p.status, p.journal_entry_id AS "entryId",
    coalesce((SELECT json_agg(ph.id ORDER BY ph.created_at, ph.id) FROM purchase_photos ph WHERE ph.purchase_id = p.id), '[]') AS photos
  FROM purchases p JOIN accounts a ON a.id = p.account_id JOIN accounts f ON f.id = p.paid_from_account_id LEFT JOIN jobs j ON j.id = p.job_id`;

export async function getPurchase(db, companyId, id) {
  if (!isId(id)) throw new LedgerError('Purchase not found');
  const { rows: [p] } = await db.query(`${SELECT} WHERE p.company_id = $1 AND p.id = $2`, [companyId, id]);
  if (!p) throw new LedgerError('Purchase not found');
  return { ...p, amountCents: Number(p.amountCents) };
}

/**
 * The most recent purchases, newest first. category 'equipment' with all = the equipment list (every piece still on
 * the books, not void, however old).
 */
export async function listPurchases(db, companyId, { limit = 50, category = null } = {}) {
  const cat = PURCHASE_CATEGORIES[category] ? category : null;
  const { rows } = await db.query(`${SELECT} WHERE p.company_id = $1 AND ($2::text IS NULL OR (p.category = $2 AND p.status = 'posted'))
    ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT $3`,
    [companyId, cat, cat ? 1000 : Math.min(Math.max(Number(limit) || 50, 1), 200)]);
  return rows.map((p) => ({ ...p, amountCents: Number(p.amountCents) }));
}

/** Void a purchase: its entry is reversed (dated today unless a date is given); the record and photos stay. */
export async function voidPurchase(pool, companyId, id, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (!isId(id)) throw new LedgerError('Purchase not found');
    const { rows: [p] } = await c.query('SELECT * FROM purchases WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, id]);
    if (!p) throw new LedgerError('Purchase not found');
    if (p.status === 'void') throw new LedgerError('That purchase is already void');
    const rev = await reverseEntry(c, companyId, p.journal_entry_id, { memo: `Void purchase: ${p.description}`, actor, fromDocument: true });
    await c.query(`UPDATE purchases SET status = 'void', void_date = $3, void_entry_id = $4, voided_by = $5, voided_at = now()
      WHERE company_id = $1 AND id = $2`, [companyId, p.id, rev.entry_date, rev.id, actor]);
    await appendAudit(c, companyId, { action: 'void', entity: 'purchase', entityId: p.id, actor, payload: { reversalId: rev.id } });
    return getPurchase(c, companyId, p.id);
  });
}

export async function getPurchasePhoto(db, companyId, purchaseId, photoId) {
  if (!isId(photoId) || !isId(purchaseId)) throw new LedgerError('Photo not found');
  const { rows: [r] } = await db.query('SELECT picture, picture_type FROM purchase_photos WHERE company_id = $1 AND purchase_id = $2 AND id = $3', [companyId, purchaseId, photoId]);
  if (!r) throw new LedgerError('Photo not found');
  return { name: `receipt.${r.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: r.picture_type, body: r.picture, inline: true };
}
