// Customers & invoices (accounts receivable) and vendors & bills (accounts payable).
//
// ℹ️ How it reaches the books — each document posts one journal entry:
//   Invoice          Dr Accounts Receivable (total)   Cr income account per line, Cr Sales Tax Payable
//   Payment received Dr bank account                  Cr Accounts Receivable
//   Bill             Dr expense account per line      Cr Accounts Payable (total)
//   Bill payment     Dr Accounts Payable              Cr bank or credit card account
// The open balance of every invoice/bill is its total minus the payments applied to it, so the
// customer (vendor) balances always add up to the Accounts Receivable (Payable) balance — the aging
// report proves this to the penny. Nothing is edited after saving; a mistake is voided (its entry is
// reversed, history kept) and entered again. "Edit" does both in one step (replaceDocument, replacePayment):
// the old record is voided and marked replaced_by_id, and the corrected copy is posted; an invoice keeps its number.
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate, validateEntry, MAX_LINE_CENTS } from '../core/ledger.js';
import { toCents, divRoundHalfUp, applyRate, percentToPpm } from '../core/money.js';
import { insertEntry, reverseEntry, cleanIdempotencyKey } from './ledgerService.js';
import { appendAudit } from './audit.js';
import { blockText } from './invoiceSetupService.js';
import { copyPaymentPhotos } from './paymentPhotoService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIDE = {
  invoice: { contact: 'customer', payment: 'received', control: 'accounts_receivable', label: 'Invoice', who: 'customer' },
  bill: { contact: 'vendor', payment: 'made', control: 'accounts_payable', label: 'Bill', who: 'vendor' },
};
const DOC_FOR_PAYMENT = { received: 'invoice', made: 'bill' };
const METHODS = ['check', 'ach', 'card', 'cash', 'wire', 'other'];
const MAX_DOC_LINES = 200;

const lockCompany = async (c, companyId) => {
  const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return co;
};
const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) || null); // eslint-disable-line no-control-regex
const money = (v, label, errors) => {
  try { return typeof v === 'number' && Number.isInteger(v) ? v : toCents(v); } catch { errors.push(`${label} is not a dollar amount`); return null; }
};

async function systemAccount(c, companyId, key, missing) {
  const { rows: [a] } = await c.query('SELECT * FROM accounts WHERE company_id = $1 AND system_key = $2', [companyId, key]);
  if (!a) throw new LedgerError(missing);
  return a;
}

/**
 * Quantity "2.5" × unit price cents → line amount in cents, rounded half-up (exact, no floating point).
 * A share "1/3" (a cost split evenly across 3 jobs, Homer 2026-10-24) is price × 1 ÷ 3, divided exactly
 * then rounded once, so $350.00 at 1/3 is $116.67 (35000 ÷ 3 = 11666.67 → 11667 cents).
 */
export function lineAmount(quantity, unitPriceCents) {
  const q = String(quantity ?? '1').trim();
  const f = /^(\d{1,4})\/(\d{1,4})$/.exec(q);
  if (f) {
    if (BigInt(f[2]) === 0n) throw new LedgerError('A share like 1/3 cannot divide by 0');
    return Number(divRoundHalfUp(BigInt(f[1]) * BigInt(unitPriceCents), BigInt(f[2])));
  }
  const m = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec(q);
  if (!m) throw new LedgerError('Quantity must be a number with up to 4 decimals, or a share like 1/3');
  const q4 = BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'));
  return Number(divRoundHalfUp(q4 * BigInt(unitPriceCents), 10000n));
}

// ---------------------------------------------------------------- Customers & vendors

const contactOut = (r) => ({
  id: r.id, kind: r.kind, name: r.name, email: r.email, phone: r.phone, address: r.address, termsDays: r.terms_days,
  is1099: r.is_1099, isActive: r.is_active, openCents: r.open_cents ?? 0, overdueCents: r.overdue_cents ?? 0,
});

function cleanContact(input, errors, partial = false) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = text(input.name, 200);
    if (!out.name || out.name.length > 120) errors.push('name is required (up to 120 characters)');
  }
  for (const [k, max] of [['email', 200], ['phone', 40], ['address', 500]]) if (!partial || input[k] !== undefined) out[k] = text(input[k], max);
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push('email address is not valid');
  if (!partial || input.termsDays !== undefined) {
    out.termsDays = input.termsDays == null || input.termsDays === '' ? 30 : Number(input.termsDays);
    if (!Number.isInteger(out.termsDays) || out.termsDays < 0 || out.termsDays > 365) errors.push('payment terms must be 0-365 days');
  }
  if (!partial || input.is1099 !== undefined) out.is1099 = input.is1099 === true;
  if (partial && input.isActive !== undefined) out.isActive = input.isActive !== false;
  return out;
}

async function nameTaken(c, companyId, kind, name, exceptId = null) {
  const { rows } = await c.query('SELECT 1 FROM contacts WHERE company_id = $1 AND kind = $2 AND lower(trim(name)) = lower($3) AND id IS DISTINCT FROM $4',
    [companyId, kind, name, exceptId]);
  return rows.length > 0;
}

export async function createContact(pool, companyId, { kind, actor = null, ...input }) {
  if (!['customer', 'vendor'].includes(kind)) throw new LedgerError('kind must be customer or vendor');
  const errors = [];
  const v = cleanContact(input, errors);
  if (kind === 'customer' && v.is1099) errors.push('1099 applies to vendors only');
  if (errors.length) throw new LedgerError(`${kind === 'customer' ? 'Customer' : 'Vendor'} is not valid`, errors);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (await nameTaken(c, companyId, kind, v.name)) throw new LedgerError(`There is already a ${kind} named "${v.name}"`);
    const { rows: [r] } = await c.query(
      `INSERT INTO contacts (company_id, kind, name, email, phone, address, terms_days, is_1099, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, kind, v.name, v.email, v.phone, v.address, v.termsDays, v.is1099, actor]);
    await appendAudit(c, companyId, { action: 'create', entity: kind, entityId: r.id, actor, payload: v });
    return contactOut(r);
  });
}

export async function updateContact(pool, companyId, contactId, { actor = null, ...input }) {
  if (typeof contactId !== 'string' || !UUIDISH.test(contactId)) throw new LedgerError('Contact not found');
  const errors = [];
  const v = cleanContact(input, errors, true);
  if (errors.length) throw new LedgerError('Contact is not valid', errors);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [old] } = await c.query('SELECT * FROM contacts WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, contactId]);
    if (!old) throw new LedgerError('Contact not found');
    if (v.name && await nameTaken(c, companyId, old.kind, v.name, old.id)) throw new LedgerError(`There is already a ${old.kind} named "${v.name}"`);
    if (old.kind === 'customer' && v.is1099) throw new LedgerError('1099 applies to vendors only');
    const cols = { name: 'name', email: 'email', phone: 'phone', address: 'address', termsDays: 'terms_days', is1099: 'is_1099', isActive: 'is_active' };
    const sets = []; const vals = [companyId, contactId];
    for (const [k, col] of Object.entries(cols)) if (v[k] !== undefined) { vals.push(v[k]); sets.push(`${col} = $${vals.length}`); }
    if (!sets.length) return contactOut(old);
    const { rows: [r] } = await c.query(`UPDATE contacts SET ${sets.join(', ')} WHERE company_id = $1 AND id = $2 RETURNING *`, vals);
    await appendAudit(c, companyId, { action: 'update', entity: old.kind, entityId: old.id, actor, payload: v });
    return contactOut(r);
  });
}

/** Customers or vendors, with what each owes / is owed today. */
export async function listContacts(db, companyId, { kind, asOf, includeInactive = false }) {
  if (!['customer', 'vendor'].includes(kind)) throw new LedgerError('kind must be customer or vendor');
  const { rows } = await db.query(
    `SELECT c.*, COALESCE(sum(b.balance), 0)::bigint AS open_cents,
            COALESCE(sum(b.balance) FILTER (WHERE b.due_date < $3), 0)::bigint AS overdue_cents
       FROM contacts c
       LEFT JOIN (${OPEN_BALANCES}) b ON b.contact_id = c.id
      WHERE c.company_id = $1 AND c.kind = $2 AND (c.is_active OR $4)
      GROUP BY c.id ORDER BY lower(c.name)`,
    [companyId, kind, asOf, includeInactive]);
  return rows.map(contactOut);
}

// Open balance of every posted document right now ($1 = company).
const OPEN_BALANCES = `
  SELECT d.id, d.contact_id, d.due_date, d.total_cents - COALESCE((
           SELECT sum(a.amount_cents) FROM payment_applications a JOIN payments p ON p.id = a.payment_id
            WHERE a.document_id = d.id AND p.status = 'posted'), 0)::bigint AS balance
    FROM documents d WHERE d.company_id = $1 AND d.status = 'posted'`;

async function getContact(c, companyId, contactId, kind) {
  if (typeof contactId !== 'string' || !UUIDISH.test(contactId)) throw new LedgerError(`Choose a ${kind}`);
  const { rows: [r] } = await c.query('SELECT * FROM contacts WHERE company_id = $1 AND id = $2 AND kind = $3', [companyId, contactId, kind]);
  if (!r) throw new LedgerError(`Choose a ${kind}`);
  return r;
}

// ---------------------------------------------------------------- Invoices & bills

const docOut = (d, today) => {
  const paid = d.paid_cents ?? 0;
  const balance = d.status === 'void' ? 0 : d.total_cents - paid;
  const status = d.status === 'void' ? 'void' : balance === 0 ? 'paid' : (today && d.due_date < today ? 'overdue' : (paid > 0 ? 'partial' : 'open'));
  return {
    id: d.id, kind: d.kind, contactId: d.contact_id, contactName: d.contact_name, number: d.number, date: d.doc_date, dueDate: d.due_date,
    memo: d.memo, project: d.project ?? null, subtotalCents: d.subtotal_cents, taxRate: d.tax_rate, taxCents: d.tax_cents, totalCents: d.total_cents,
    paidCents: paid, balanceCents: balance, status, voidDate: d.void_date, journalEntryId: d.journal_entry_id, entryNumber: d.entry_number ?? null,
    replacedById: d.replaced_by_id ?? null,
  };
};

const DOC_SELECT = `
  SELECT d.*, ct.name AS contact_name, e.entry_number,
         COALESCE((SELECT sum(a.amount_cents) FROM payment_applications a JOIN payments p ON p.id = a.payment_id
                    WHERE a.document_id = d.id AND p.status = 'posted'), 0)::bigint AS paid_cents
    FROM documents d JOIN contacts ct ON ct.id = d.contact_id JOIN journal_entries e ON e.id = d.journal_entry_id`;

/**
 * Validate the lines of an invoice or bill. Each line: { accountId, description, quantity, unitPrice }
 * (or just { accountId, description, amount }), and taxable: true for invoice lines that carry sales tax.
 * Optional: serviceDate (the day the work was done or the cost incurred) and itemId (the saved rate it came from).
 */
async function cleanLines(c, companyId, kind, rawLines, errors) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) { errors.push('add at least one line'); return []; }
  if (rawLines.length > MAX_DOC_LINES) { errors.push(`at most ${MAX_DOC_LINES} lines`); return []; }
  const ids = [...new Set(rawLines.map((l) => l?.accountId).filter((x) => typeof x === 'string' && UUIDISH.test(x)))];
  const { rows: accts } = await c.query('SELECT * FROM accounts WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, ids]);
  const byId = new Map(accts.map((a) => [a.id, a]));
  const itemIds = [...new Set(rawLines.map((l) => l?.itemId).filter((x) => typeof x === 'string' && UUIDISH.test(x)))];
  const { rows: items } = itemIds.length ? await c.query('SELECT id FROM invoice_items WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, itemIds]) : { rows: [] };
  const itemSet = new Set(items.map((x) => x.id));
  return rawLines.map((l, i) => {
    const n = `line ${i + 1}`;
    const a = byId.get(l?.accountId);
    if (!a || !a.is_active) errors.push(`${n}: choose an ${kind === 'invoice' ? 'income' : 'expense'} account`);
    else if (a.cash_flow === 'cash' || ['accounts_receivable', 'accounts_payable', 'retained_earnings', 'sales_tax_payable'].includes(a.system_key)) {
      errors.push(`${n}: ${a.name} can't be used on ${kind === 'invoice' ? 'an invoice' : 'a bill'} line`);
    }
    const serviceDate = l?.serviceDate == null || l.serviceDate === '' ? null : l.serviceDate;
    if (serviceDate != null && !isIsoDate(serviceDate)) errors.push(`${n}: the date must be a real date (YYYY-MM-DD)`);
    const itemId = l?.itemId == null || l.itemId === '' ? null : l.itemId;
    if (itemId != null && !itemSet.has(itemId)) errors.push(`${n}: that saved rate was not found`);
    let unit = l?.unitPrice ?? l?.amount;
    unit = unit == null || unit === '' ? null : money(unit, `${n} price`, errors);
    if (unit == null) { if (!errors.some((e) => e.startsWith(n))) errors.push(`${n}: enter a price or amount`); return null; }
    if (unit < 0) { errors.push(`${n}: amounts can't be negative`); return null; }
    let amount;
    try { amount = lineAmount(l.quantity ?? '1', unit); } catch (e) { errors.push(`${n}: ${e.message}`); return null; }
    if (amount > MAX_LINE_CENTS) { errors.push(`${n}: amount is too large`); return null; }
    return { accountId: l.accountId, description: text(l.description, 300), quantity: String(l.quantity ?? '1').trim(), unitPriceCents: unit, amountCents: amount,
      taxable: kind === 'invoice' && l.taxable === true, serviceDate, itemId };
  });
}

/** Create and post an invoice (kind 'invoice') or a bill (kind 'bill'). */
export async function createDocument(pool, companyId, { kind, contactId, number, date, dueDate, memo, project, taxRate, lines, idempotencyKey = null, actor = null, documentId = null, replacesId = null }) {
  const side = SIDE[kind];
  if (!side) throw new LedgerError('kind must be invoice or bill');
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    const co = await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT id FROM documents WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return { ...(await getDocument(c, companyId, prior.id)), replayed: true };
    }
    const errors = [];
    const contact = await getContact(c, companyId, contactId, side.contact).catch((e) => { errors.push(e.message.toLowerCase()); return null; });
    if (!isIsoDate(date)) errors.push('date must be a real date (YYYY-MM-DD)');
    if (dueDate != null && dueDate !== '' && (!isIsoDate(dueDate) || (isIsoDate(date) && dueDate < date))) errors.push('due date must be on or after the date');
    const cleanMemoText = text(memo, 500);
    let projectText = null;
    try { projectText = blockText(project, 300, 'project'); } catch (e) { errors.push(e.message.replace(/^Keep/, 'keep')); }
    if (projectText && kind !== 'invoice') errors.push('the project block is for invoices');
    const clean = await cleanLines(c, companyId, kind, lines, errors);
    let ppm = 0;
    let rate = null;
    if (taxRate != null && taxRate !== '' && String(taxRate).trim() !== '0') {
      if (kind !== 'invoice') errors.push('sales tax applies to invoices only (enter tax on a bill as its own line)');
      else {
        try { ppm = percentToPpm(taxRate); rate = String(taxRate).trim(); } catch { errors.push('sales tax rate must be a percent like 8.25'); }
        if (ppm > 200_000) errors.push('sales tax rate must be 20% or less');
      }
    }
    let num = text(number, 40);
    if (kind === 'bill' && num == null) errors.push("enter the vendor's bill or invoice number");
    if (errors.length) throw new LedgerError(`${side.label} is not valid`, errors);

    const subtotal = clean.reduce((s, l) => s + l.amountCents, 0);
    const taxable = clean.filter((l) => l.taxable).reduce((s, l) => s + l.amountCents, 0);
    const tax = ppm ? applyRate(taxable, ppm) : 0;
    const total = subtotal + tax;
    if (total <= 0) throw new LedgerError(`${side.label} is not valid`, ['the total must be more than $0.00']);
    if (rate && taxable === 0) throw new LedgerError(`${side.label} is not valid`, ['mark at least one line as taxable, or leave the sales tax rate empty']);

    let auto = false;
    if (kind === 'invoice' && num == null) { num = String(co.next_invoice_number); auto = true; }
    const dup = kind === 'invoice'
      ? await c.query('SELECT 1 FROM documents WHERE company_id = $1 AND kind = $2 AND lower(number) = lower($3) AND replaced_by_id IS NULL', [companyId, kind, num])
      : await c.query("SELECT 1 FROM documents WHERE company_id = $1 AND kind = 'bill' AND contact_id = $2 AND lower(number) = lower($3) AND status = 'posted'", [companyId, contact.id, num]);
    if (dup.rows.length) {
      throw new LedgerError(kind === 'invoice' ? `Invoice number ${num} is already used` : `Bill ${num} from ${contact.name} is already entered`);
    }
    if (auto) await c.query('UPDATE companies SET next_invoice_number = next_invoice_number + 1 WHERE id = $1', [companyId]);
    const due = dueDate || addDays(date, contact.terms_days);

    const control = await systemAccount(c, companyId, side.control, `This company has no ${kind === 'invoice' ? 'Accounts Receivable' : 'Accounts Payable'} account`);
    const label = `${side.label} ${num} · ${contact.name}`;
    const jl = [];
    if (kind === 'invoice') {
      jl.push({ accountId: control.id, debitCents: total, creditCents: 0, memo: label });
      for (const l of clean) if (l.amountCents > 0) jl.push({ accountId: l.accountId, debitCents: 0, creditCents: l.amountCents, memo: l.description });
      if (tax > 0) {
        const st = await systemAccount(c, companyId, 'sales_tax_payable', 'Add a "Sales Tax Payable" liability account first');
        jl.push({ accountId: st.id, debitCents: 0, creditCents: tax, memo: `Sales tax ${rate}%` });
      }
    } else {
      for (const l of clean) if (l.amountCents > 0) jl.push({ accountId: l.accountId, debitCents: l.amountCents, creditCents: 0, memo: l.description });
      jl.push({ accountId: control.id, debitCents: 0, creditCents: total, memo: label });
    }
    const entry = validateEntry({ date, memo: (cleanMemoText ? `${label}: ${cleanMemoText}` : label).slice(0, 500), lines: jl });
    const docId = documentId ?? (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    const je = await insertEntry(c, companyId, entry, { source: kind, sourceRef: docId, actor });
    await c.query(
      `INSERT INTO documents (id, company_id, kind, contact_id, number, doc_date, due_date, memo, project, subtotal_cents, tax_rate, tax_cents, total_cents, journal_entry_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [docId, companyId, kind, contact.id, num, date, due, cleanMemoText, projectText, subtotal, rate, tax, total, je.id, idempotencyKey, actor]);
    for (const l of clean) {
      await c.query(
        `INSERT INTO document_lines (company_id, document_id, account_id, description, quantity, unit_price_cents, amount_cents, taxable, service_date, item_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [companyId, docId, l.accountId, l.description, l.quantity, l.unitPriceCents, l.amountCents, l.taxable, l.serviceDate, l.itemId]);
    }
    await appendAudit(c, companyId, { action: replacesId ? 'replace' : 'create', entity: kind, entityId: docId, actor,
      payload: { ...(replacesId ? { replacesId } : {}), number: num, contactId: contact.id, date, dueDate: due, subtotalCents: subtotal, taxRate: rate, taxCents: tax, totalCents: total, lines: clean, entryId: je.id } });
    return getDocument(c, companyId, docId);
  });
}

export async function getDocument(db, companyId, docId, { today = null } = {}) {
  if (typeof docId !== 'string' || !UUIDISH.test(docId)) throw new LedgerError('Invoice or bill not found');
  const { rows: [d] } = await db.query(`${DOC_SELECT} WHERE d.company_id = $1 AND d.id = $2`, [companyId, docId]);
  if (!d) throw new LedgerError('Invoice or bill not found');
  const { rows: lines } = await db.query(
    `SELECT l.*, a.code, a.name AS account_name, i.name AS item_name, i.kind AS item_kind
       FROM document_lines l JOIN accounts a ON a.id = l.account_id LEFT JOIN invoice_items i ON i.id = l.item_id
      WHERE l.document_id = $1 ORDER BY l.id`, [d.id]);
  const { rows: pays } = await db.query(
    `SELECT p.id, p.pay_date, p.method, p.reference, p.status, a.amount_cents FROM payment_applications a JOIN payments p ON p.id = a.payment_id
      WHERE a.document_id = $1 ORDER BY p.pay_date, p.created_at`, [d.id]);
  const { rows: [ct] } = await db.query('SELECT name, email, phone, address, terms_days AS "termsDays" FROM contacts WHERE id = $1', [d.contact_id]);
  return {
    ...docOut(d, today),
    contact: ct,
    lines: lines.map((l) => ({ accountId: l.account_id, accountCode: l.code, accountName: l.account_name, description: l.description,
      quantity: l.quantity, unitPriceCents: l.unit_price_cents, amountCents: l.amount_cents, taxable: l.taxable,
      serviceDate: l.service_date, itemId: l.item_id, itemName: l.item_name ?? null, itemKind: l.item_kind ?? null })),
    payments: pays.map((p) => ({ id: p.id, date: p.pay_date, method: p.method, reference: p.reference, status: p.status, amountCents: p.amount_cents })),
  };
}

/** Invoices or bills. status: 'open' (anything with a balance), 'paid', 'void', or 'all'. */
export async function listDocuments(db, companyId, { kind, status = 'open', contactId = null, today = null, limit = 500 }) {
  if (!SIDE[kind]) throw new LedgerError('kind must be invoice or bill');
  if (!['open', 'paid', 'void', 'all'].includes(status)) throw new LedgerError('status must be open, paid, void or all');
  if (contactId && !UUIDISH.test(contactId)) throw new LedgerError('Contact not found');
  const { rows } = await db.query(
    `SELECT * FROM (${DOC_SELECT} WHERE d.company_id = $1 AND d.kind = $2 AND ($3::uuid IS NULL OR d.contact_id = $3)) x
      WHERE $4 = 'all' OR ($4 = 'void' AND status = 'void')
         OR ($4 = 'open' AND status = 'posted' AND total_cents > paid_cents) OR ($4 = 'paid' AND status = 'posted' AND total_cents = paid_cents)
      ORDER BY doc_date DESC, created_at DESC LIMIT $5`,
    [companyId, kind, contactId, status, Math.min(Number(limit) || 500, 2000)]);
  return rows.map((d) => docOut(d, today));
}

/** Void an invoice or bill: its entry is reversed. Payments applied to it must be voided first. */
export async function voidDocument(pool, companyId, docId, { date = null, actor = null, replacedById = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (typeof docId !== 'string' || !UUIDISH.test(docId)) throw new LedgerError('Invoice or bill not found');
    const { rows: [d] } = await c.query('SELECT * FROM documents WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, docId]);
    if (!d) throw new LedgerError('Invoice or bill not found');
    const label = `${SIDE[d.kind].label} ${d.number}`;
    if (d.status === 'void') throw new LedgerError(`${label} is already void`);
    const { rows: paid } = await c.query(
      `SELECT 1 FROM payment_applications a JOIN payments p ON p.id = a.payment_id WHERE a.document_id = $1 AND p.status = 'posted' LIMIT 1`, [d.id]);
    if (paid.length) throw new LedgerError(`${label} has payments; ${replacedById ? 'edit or void those payments first' : 'void those payments first'}`);
    const rev = await reverseEntry(c, companyId, d.journal_entry_id, { date: date || undefined, memo: `Void ${label}`, actor, fromDocument: true });
    await c.query(`UPDATE documents SET status = 'void', void_date = $3, void_entry_id = $4, voided_by = $5, voided_at = now(), replaced_by_id = $6
                    WHERE company_id = $1 AND id = $2`, [companyId, d.id, rev.entry_date, rev.id, actor, replacedById]);
    await appendAudit(c, companyId, { action: 'void', entity: d.kind, entityId: d.id, actor, payload: { number: d.number, voidDate: rev.entry_date, reversalId: rev.id } });
    return getDocument(c, companyId, d.id);
  });
}

/**
 * Edit an invoice or bill: void it and post the corrected copy, in one step. The input is the whole corrected
 * document (same fields as createDocument); an empty number keeps the old one. The void is dated like any void
 * (the original date, or the first open day if that period is locked).
 */
export async function replaceDocument(pool, companyId, docId, { idempotencyKey = null, actor = null, ...input }) {
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT id FROM documents WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return { ...(await getDocument(c, companyId, prior.id)), replayed: true };
    }
    if (typeof docId !== 'string' || !UUIDISH.test(docId)) throw new LedgerError('Invoice or bill not found');
    const { rows: [old] } = await c.query('SELECT kind, number FROM documents WHERE company_id = $1 AND id = $2', [companyId, docId]);
    if (!old) throw new LedgerError('Invoice or bill not found');
    const { rows: [{ id: newId }] } = await c.query('SELECT gen_random_uuid() AS id');
    await voidDocument(c, companyId, docId, { actor, replacedById: newId });
    const number = input.number == null || String(input.number).trim() === '' ? old.number : input.number;
    return createDocument(c, companyId, { ...input, kind: old.kind, number, idempotencyKey, actor, documentId: newId, replacesId: docId });
  });
}

// ---------------------------------------------------------------- Payments

const payOut = (p) => ({
  id: p.id, kind: p.kind, contactId: p.contact_id, contactName: p.contact_name, date: p.pay_date, amountCents: p.amount_cents,
  accountId: p.account_id, accountName: p.account_name, method: p.method, reference: p.reference, memo: p.memo, status: p.status,
  voidDate: p.void_date, journalEntryId: p.journal_entry_id, entryNumber: p.entry_number ?? null, applications: p.applications ?? [],
  replacedById: p.replaced_by_id ?? null, photoCount: Number(p.photo_count ?? 0),
});

/**
 * Record money received from a customer (kind 'received') or paid to a vendor (kind 'made'), applied to
 * one or more of that contact's open invoices/bills: applications = [{ documentId, amount }].
 * The payment amount is the sum of the applications.
 */
export async function createPayment(pool, companyId, { kind, contactId, date, accountId, method, reference, memo, applications, idempotencyKey = null, actor = null, paymentId = null, replacesId = null }) {
  const docKind = DOC_FOR_PAYMENT[kind];
  if (!docKind) throw new LedgerError('kind must be received or made');
  const side = SIDE[docKind];
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT id FROM payments WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return { ...(await getPayment(c, companyId, prior.id)), replayed: true };
    }
    const errors = [];
    const contact = await getContact(c, companyId, contactId, side.contact).catch((e) => { errors.push(e.message.toLowerCase()); return null; });
    if (!isIsoDate(date)) errors.push('date must be a real date (YYYY-MM-DD)');
    if (method != null && method !== '' && !METHODS.includes(method)) errors.push(`method must be one of ${METHODS.join(', ')}`);
    let acct = null;
    if (typeof accountId === 'string' && UUIDISH.test(accountId)) {
      acct = (await c.query('SELECT * FROM accounts WHERE company_id = $1 AND id = $2', [companyId, accountId])).rows[0];
    }
    const okAcct = acct && acct.is_active && (acct.cash_flow === 'cash' || (kind === 'made' && acct.subtype === 'credit_card'));
    if (!okAcct) errors.push(kind === 'received' ? 'choose the bank account the money went into' : 'choose the bank or credit card account you paid from');
    if (!Array.isArray(applications) || applications.length === 0) errors.push(`choose at least one ${docKind} to pay`);
    if (errors.length) throw new LedgerError('Payment is not valid', errors);

    const apps = [];
    const seen = new Set();
    for (const [i, raw] of applications.entries()) {
      const n = `${docKind} ${i + 1}`;
      if (typeof raw?.documentId !== 'string' || !UUIDISH.test(raw.documentId) || seen.has(raw.documentId)) { errors.push(`${n}: not found or listed twice`); continue; }
      seen.add(raw.documentId);
      const amt = money(raw.amount, `${n} amount`, errors);
      if (amt == null) continue;
      if (amt <= 0) { errors.push(`${n}: amount must be more than $0.00`); continue; }
      // Lock the document so two payments at once can't both take the same balance.
      const { rows: [d] } = await c.query(`SELECT * FROM documents WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, raw.documentId]);
      if (!d || d.kind !== docKind || d.contact_id !== contact.id) { errors.push(`${n}: not one of ${contact.name}'s ${docKind}s`); continue; }
      const label = `${side.label} ${d.number}`;
      if (d.status !== 'posted') { errors.push(`${label} is void`); continue; }
      if (d.doc_date > date) { errors.push(`${label} is dated ${d.doc_date}, after this payment`); continue; }
      const { rows: [{ paid }] } = await c.query(
        `SELECT COALESCE(sum(a.amount_cents), 0)::bigint AS paid FROM payment_applications a JOIN payments p ON p.id = a.payment_id
          WHERE a.document_id = $1 AND p.status = 'posted'`, [d.id]);
      const balance = d.total_cents - paid;
      if (amt > balance) { errors.push(`${label}: ${fmt(amt)} is more than its balance of ${fmt(balance)}`); continue; }
      apps.push({ documentId: d.id, number: d.number, amountCents: amt });
    }
    if (errors.length) throw new LedgerError('Payment is not valid', errors);
    const total = apps.reduce((s, a) => s + a.amountCents, 0);
    if (total > MAX_LINE_CENTS) throw new LedgerError('Payment is not valid', ['amount is too large']);

    const control = await systemAccount(c, companyId, side.control, 'Accounts Receivable/Payable account is missing');
    const label = `${kind === 'received' ? 'Payment from' : 'Payment to'} ${contact.name} · ${apps.map((a) => `${side.label} ${a.number}`).join(', ')}`.slice(0, 480);
    const lines = kind === 'received'
      ? [{ accountId: acct.id, debitCents: total, creditCents: 0 }, { accountId: control.id, debitCents: 0, creditCents: total }]
      : [{ accountId: control.id, debitCents: total, creditCents: 0 }, { accountId: acct.id, debitCents: 0, creditCents: total }];
    const memoText = text(memo, 500);
    const payId = paymentId ?? (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
    const je = await insertEntry(c, companyId, validateEntry({ date, memo: label, lines }), { source: 'payment', sourceRef: payId, actor });
    await c.query(
      `INSERT INTO payments (id, company_id, kind, contact_id, pay_date, amount_cents, account_id, method, reference, memo, journal_entry_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [payId, companyId, kind, contact.id, date, total, acct.id, method || null, text(reference, 60), memoText, je.id, idempotencyKey, actor]);
    for (const a of apps) {
      await c.query('INSERT INTO payment_applications (company_id, payment_id, document_id, amount_cents) VALUES ($1,$2,$3,$4)', [companyId, payId, a.documentId, a.amountCents]);
    }
    await appendAudit(c, companyId, { action: replacesId ? 'replace' : 'create', entity: 'payment', entityId: payId, actor,
      payload: { ...(replacesId ? { replacesId } : {}), kind, contactId: contact.id, date, amountCents: total, accountId: acct.id, applications: apps, entryId: je.id } });
    return getPayment(c, companyId, payId);
  });
}

const fmt = (c) => `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

export async function getPayment(db, companyId, paymentId) {
  if (typeof paymentId !== 'string' || !UUIDISH.test(paymentId)) throw new LedgerError('Payment not found');
  const { rows: [p] } = await db.query(
    `SELECT p.*, ct.name AS contact_name, a.name AS account_name, e.entry_number,
            (SELECT count(*) FROM payment_photos f WHERE f.payment_id = p.id) AS photo_count FROM payments p
       JOIN contacts ct ON ct.id = p.contact_id JOIN accounts a ON a.id = p.account_id JOIN journal_entries e ON e.id = p.journal_entry_id
      WHERE p.company_id = $1 AND p.id = $2`, [companyId, paymentId]);
  if (!p) throw new LedgerError('Payment not found');
  const { rows: apps } = await db.query(
    `SELECT a.document_id, a.amount_cents, d.number FROM payment_applications a JOIN documents d ON d.id = a.document_id
      WHERE a.payment_id = $1 ORDER BY d.doc_date, d.number`, [p.id]);
  return payOut({ ...p, applications: apps.map((a) => ({ documentId: a.document_id, number: a.number, amountCents: a.amount_cents })) });
}

export async function listPayments(db, companyId, { kind, contactId = null, limit = 500 }) {
  if (!DOC_FOR_PAYMENT[kind]) throw new LedgerError('kind must be received or made');
  if (contactId && !UUIDISH.test(contactId)) throw new LedgerError('Contact not found');
  const { rows } = await db.query(
    `SELECT p.*, ct.name AS contact_name, a.name AS account_name, e.entry_number,
            (SELECT count(*) FROM payment_photos f WHERE f.payment_id = p.id) AS photo_count,
            (SELECT json_agg(json_build_object('documentId', x.document_id, 'number', d.number, 'amountCents', x.amount_cents) ORDER BY d.number)
               FROM payment_applications x JOIN documents d ON d.id = x.document_id WHERE x.payment_id = p.id) AS applications
       FROM payments p JOIN contacts ct ON ct.id = p.contact_id JOIN accounts a ON a.id = p.account_id JOIN journal_entries e ON e.id = p.journal_entry_id
      WHERE p.company_id = $1 AND p.kind = $2 AND ($3::uuid IS NULL OR p.contact_id = $3)
      ORDER BY p.pay_date DESC, p.created_at DESC LIMIT $4`,
    [companyId, kind, contactId, Math.min(Number(limit) || 500, 2000)]);
  return rows.map(payOut);
}

/** Void a payment (e.g. a bounced check): its entry is reversed and the invoices/bills are open again. */
export async function voidPayment(pool, companyId, paymentId, { date = null, actor = null, replacedById = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (typeof paymentId !== 'string' || !UUIDISH.test(paymentId)) throw new LedgerError('Payment not found');
    const { rows: [p] } = await c.query('SELECT * FROM payments WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, paymentId]);
    if (!p) throw new LedgerError('Payment not found');
    if (p.status === 'void') throw new LedgerError('This payment is already void');
    const { rows: [matched] } = await c.query("SELECT 1 FROM bank_transactions WHERE company_id = $1 AND journal_entry_id = $2 AND status = 'matched'", [companyId, p.journal_entry_id]);
    if (matched) throw new LedgerError('This payment is matched to a bank transaction; undo that match in Banking first');
    const { rows: [cleared] } = await c.query(
      'SELECT 1 FROM reconciliation_lines rl JOIN journal_lines l ON l.id = rl.journal_line_id WHERE l.entry_id = $1', [p.journal_entry_id]);
    if (cleared) throw new LedgerError('This payment is part of a bank reconciliation and can no longer be voided');
    const rev = await reverseEntry(c, companyId, p.journal_entry_id, { date: date || undefined, memo: `Void payment of ${fmt(p.amount_cents)}`, actor, fromDocument: true });
    await c.query(`UPDATE payments SET status = 'void', void_date = $3, void_entry_id = $4, voided_by = $5, voided_at = now(), replaced_by_id = $6
                    WHERE company_id = $1 AND id = $2`, [companyId, p.id, rev.entry_date, rev.id, actor, replacedById]);
    await appendAudit(c, companyId, { action: 'void', entity: 'payment', entityId: p.id, actor, payload: { amountCents: p.amount_cents, voidDate: rev.entry_date, reversalId: rev.id } });
    return getPayment(c, companyId, p.id);
  });
}

/** Edit a payment: void it and record the corrected one, in one step (same fields as createPayment). */
export async function replacePayment(pool, companyId, paymentId, { idempotencyKey = null, actor = null, ...input }) {
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    if (idempotencyKey) {
      const { rows: [prior] } = await c.query('SELECT id FROM payments WHERE company_id = $1 AND idempotency_key = $2', [companyId, idempotencyKey]);
      if (prior) return { ...(await getPayment(c, companyId, prior.id)), replayed: true };
    }
    if (typeof paymentId !== 'string' || !UUIDISH.test(paymentId)) throw new LedgerError('Payment not found');
    const { rows: [old] } = await c.query('SELECT kind FROM payments WHERE company_id = $1 AND id = $2', [companyId, paymentId]);
    if (!old) throw new LedgerError('Payment not found');
    const { rows: [{ id: newId }] } = await c.query('SELECT gen_random_uuid() AS id');
    await voidPayment(c, companyId, paymentId, { actor, replacedById: newId });
    await createPayment(c, companyId, { ...input, kind: old.kind, idempotencyKey, actor, paymentId: newId, replacesId: paymentId });
    await copyPaymentPhotos(c, companyId, paymentId, newId);   // the check photo belongs to the corrected payment too
    return getPayment(c, companyId, newId);
  });
}

// ---------------------------------------------------------------- Aging

export const AGING_BUCKETS = Object.freeze([
  { id: 'current', label: 'Current', max: 0 }, { id: 'd1_30', label: '1–30 days', max: 30 }, { id: 'd31_60', label: '31–60 days', max: 60 },
  { id: 'd61_90', label: '61–90 days', max: 90 }, { id: 'over90', label: 'Over 90 days', max: Infinity },
]);
export const bucketFor = (daysPastDue) => AGING_BUCKETS.find((b) => daysPastDue <= b.max).id;

/**
 * Accounts receivable (kind 'invoice') or payable (kind 'bill') aging as of a date: each contact's
 * open balance by how long past due. Uses only what was true on that date (later payments and
 * voids are ignored), and ties the total to the Accounts Receivable/Payable balance in the books.
 */
export async function getAging(db, companyId, { kind, asOf }) {
  const side = SIDE[kind];
  if (!side) throw new LedgerError('kind must be invoice or bill');
  if (!isIsoDate(asOf)) throw new LedgerError('date must be YYYY-MM-DD');
  const { rows: docs } = await db.query(
    `SELECT d.id, d.number, d.doc_date, d.due_date, d.total_cents, d.contact_id, ct.name AS contact_name,
            d.total_cents - COALESCE((SELECT sum(a.amount_cents) FROM payment_applications a JOIN payments p ON p.id = a.payment_id
                                       WHERE a.document_id = d.id AND p.pay_date <= $3 AND (p.status = 'posted' OR p.void_date > $3)), 0)::bigint AS balance
       FROM documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.company_id = $1 AND d.kind = $2 AND d.doc_date <= $3 AND (d.status = 'posted' OR d.void_date > $3)`,
    [companyId, kind, asOf]);
  const byContact = new Map();
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0]));
  for (const d of docs) {
    if (d.balance === 0) continue;
    const bucket = bucketFor(daysBetween(d.due_date, asOf));
    let row = byContact.get(d.contact_id);
    if (!row) byContact.set(d.contact_id, row = { contactId: d.contact_id, name: d.contact_name, totalCents: 0, documents: [], ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.id, 0])) });
    row[bucket] += d.balance;
    row.totalCents += d.balance;
    totals[bucket] += d.balance;
    row.documents.push({ id: d.id, number: d.number, date: d.doc_date, dueDate: d.due_date, totalCents: d.total_cents, balanceCents: d.balance, daysPastDue: Math.max(0, daysBetween(d.due_date, asOf)), bucket });
  }
  const rows = [...byContact.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) r.documents.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const totalCents = rows.reduce((s, r) => s + r.totalCents, 0);
  // Control-account balance in the books, split into what invoices/bills/payments posted (must equal
  // the aging total exactly) and anything else, such as opening balances imported from QuickBooks.
  const { rows: [gl] } = await db.query(
    `SELECT COALESCE(sum(l.debit_cents - l.credit_cents), 0)::bigint AS net,
            COALESCE(sum(l.debit_cents - l.credit_cents) FILTER (WHERE NOT (e.source IN ('invoice','bill','payment')
              OR (e.source = 'reversal' AND o.source IN ('invoice','bill','payment')))), 0)::bigint AS other
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN journal_entries o ON o.id = e.reverses_entry_id
      WHERE l.company_id = $1 AND a.system_key = $2 AND l.entry_date <= $3`, [companyId, side.control, asOf]);
  const sign = kind === 'invoice' ? 1 : -1;
  const glBalanceCents = sign * gl.net;
  const otherEntriesCents = sign * gl.other;
  const differenceCents = glBalanceCents - otherEntriesCents - totalCents;
  return {
    kind, asOf, buckets: AGING_BUCKETS.map(({ id, label }) => ({ id, label })), rows, totals: { ...totals, totalCents },
    glBalanceCents, otherEntriesCents, differenceCents, ties: differenceCents === 0,
  };
}
