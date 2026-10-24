// Database-backed ledger: companies, accounts, posting and reversing entries, closing periods.
import { randomUUID } from 'node:crypto';
import { withTransaction, setScopeCompany } from '../db/pool.js';
import { DEFAULT_CHART } from '../core/chartOfAccounts.js';
import { validateEntry, simpleTransaction, reversingLines, LedgerError, ACCOUNT_TYPES, isIsoDate } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { appendAudit } from './audit.js';
import { FREQUENCIES, nextOccurrence } from '../core/recurring.js';

const lockCompany = async (client, companyId) => {
  const { rows } = await client.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!rows[0]) throw new LedgerError('Company not found');
  return rows[0];
};

/** Create a company with the default chart of accounts. If ownerUserId is given, that user becomes its owner. */
export async function createCompany(pool, { name, homeState, fiscalYearStartMonth = 1, actor = null, ownerUserId = null }) {
  const errors = [];
  if (typeof name !== 'string' || !name.trim() || name.length > 120) errors.push('business name is required (up to 120 characters)');
  if (!['TX', 'CO', 'CA', 'DC'].includes(homeState)) errors.push('state must be TX, CO, CA or DC');
  if (!Number.isInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) errors.push('fiscal year start month must be 1-12');
  if (errors.length) throw new LedgerError('Company is not valid', errors);
  return withTransaction(pool, async (c) => {
    const id = randomUUID();
    if (c.__inTx) await setScopeCompany(c, id);
    const { rows: [co] } = await c.query(
      'INSERT INTO companies (id, name, home_state, fiscal_year_start_month) VALUES ($1,$2,$3,$4) RETURNING *',
      [id, name.trim(), homeState, fiscalYearStartMonth],
    );
    if (ownerUserId) await c.query("INSERT INTO memberships (company_id, user_id, role) VALUES ($1,$2,'owner')", [id, ownerUserId]);
    for (const a of DEFAULT_CHART) {
      await c.query(
        `INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow, system_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [co.id, a.code, a.name, a.type, a.subtype ?? null, a.cashFlow ?? null, a.key ?? null],
      );
    }
    await appendAudit(c, co.id, { action: 'create', entity: 'company', entityId: co.id, actor, payload: { name, homeState, fiscalYearStartMonth } });
    return co;
  });
}

/** Record an audit event that has no ledger change (e.g. membership changes). */
export async function auditOnly(pool, companyId, event) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    return appendAudit(c, companyId, event);
  });
}

export async function listCompanies(db, { userId = null } = {}) {
  if (!userId) return (await db.query('SELECT * FROM companies ORDER BY created_at')).rows;
  return (await db.query(
    `SELECT c.*, m.role FROM companies c JOIN memberships m ON m.company_id = c.id
      WHERE m.user_id = $1 ORDER BY c.created_at`, [userId])).rows;
}

export async function getCompany(db, companyId) {
  const { rows } = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!rows[0]) throw new LedgerError('Company not found');
  return rows[0];
}

export async function listAccounts(db, companyId) {
  const { rows } = await db.query(
    `SELECT id, code, name, type, subtype, cash_flow AS "cashFlow", system_key AS "key", is_active AS "isActive"
       FROM accounts WHERE company_id = $1 ORDER BY code`, [companyId]);
  return rows;
}

// Allowed subtypes per account type, and the cash-flow section each one belongs to.
export const ACCOUNT_SUBTYPES = Object.freeze({
  asset: { bank: 'cash', cash: 'cash', receivable: 'operating', current: 'operating', fixed: 'investing', contra: 'operating', investment: 'investing' },
  liability: { payable: 'operating', credit_card: 'operating', current: 'operating', long_term: 'financing' },
  equity: { capital: 'financing', draws: 'financing' },
  revenue: { operating: null, other: null },
  expense: { operating: null, cogs: null, other: null },
});
const DEFAULT_SUBTYPE = { asset: 'current', liability: 'current', equity: 'capital', revenue: 'operating', expense: 'operating' };

export async function createAccount(pool, companyId, { code, name, type, subtype, actor = null }) {
  const errors = [];
  if (typeof code !== 'string' || !/^[0-9A-Za-z.-]{1,20}$/.test(code)) errors.push('code must be 1-20 letters/digits');
  if (typeof name !== 'string' || !name.trim() || name.length > 100) errors.push('name is required (up to 100 characters)');
  if (!ACCOUNT_TYPES.includes(type)) errors.push(`type must be one of ${ACCOUNT_TYPES.join(', ')}`);
  subtype ||= DEFAULT_SUBTYPE[type];
  const allowed = ACCOUNT_SUBTYPES[type] ?? {};
  if (type && !Object.hasOwn(allowed, subtype)) errors.push(`subtype for ${type} must be one of ${Object.keys(allowed).join(', ')}`);
  if (errors.length) throw new LedgerError('Account is not valid', errors);
  const cashFlow = allowed[subtype]; // cash-flow section follows from the subtype (e.g. fixed asset -> investing)
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [a] } = await c.query(
      `INSERT INTO accounts (company_id, code, name, type, subtype, cash_flow) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, code, name, type, subtype, cash_flow AS "cashFlow"`,
      [companyId, code, name.trim(), type, subtype, cashFlow],
    );
    await appendAudit(c, companyId, { action: 'create', entity: 'account', entityId: a.id, actor, payload: a });
    return a;
  });
}

const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Post a validated entry inside an existing transaction (company row must be locked). */
/** Idempotency keys come from the browser (one per "Save" click); keep them short and plain. */
export function cleanIdempotencyKey(key) {
  if (key == null || key === '') return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9:_.-]{8,120}$/.test(key)) throw new LedgerError('Idempotency-Key must be 8-120 letters, digits or : _ . -');
  return key;
}

/** If an entry was already posted with this key, return it (so a retried "Save" never posts twice). */
async function findByIdempotencyKey(c, companyId, key) {
  if (!key) return null;
  const { rows: [je] } = await c.query('SELECT * FROM journal_entries WHERE company_id = $1 AND idempotency_key = $2', [companyId, key]);
  if (!je) return null;
  const { rows: lines } = await c.query(
    `SELECT account_id AS "accountId", debit_cents AS "debitCents", credit_cents AS "creditCents", memo
       FROM journal_lines WHERE entry_id = $1 ORDER BY id`, [je.id]);
  return { ...je, lines, replayed: true };
}

const CONTROL_KEYS = { accounts_receivable: 'Accounts Receivable changes through invoices and customer payments (Sales tab)', accounts_payable: 'Accounts Payable changes through bills and bill payments (Bills tab)' };
const DOCUMENT_SOURCES_OK = ['invoice', 'bill', 'payment', 'reversal', 'import', 'system'];
const controlMessage = (accts) => CONTROL_KEYS[accts.find((a) => CONTROL_KEYS[a.system_key]).system_key];

async function insertEntry(c, companyId, entry, { source = 'manual', sourceRef = null, reversesEntryId = null, actor = null, idempotencyKey = null }) {
  const company = await lockCompany(c, companyId);
  idempotencyKey = cleanIdempotencyKey(idempotencyKey);
  const existing = await findByIdempotencyKey(c, companyId, idempotencyKey);
  if (existing) return existing;
  // All accounts must exist, belong to this company, and be active.
  const ids = [...new Set(entry.lines.map((l) => l.accountId))];
  const { rows: accts } = await c.query(
    `SELECT id, is_active, system_key FROM accounts
      WHERE company_id = $1 AND id = ANY(SELECT x::uuid FROM unnest($2::text[]) x WHERE x ~* '^[0-9a-f-]{36}$')`, [companyId, ids]);
  const found = new Map(accts.map((a) => [a.id, a]));
  const bad = ids.filter((id) => !found.has(id));
  if (bad.length) throw new LedgerError('Journal entry is not valid', [`unknown account(s): ${bad.join(', ')}`]);
  const inactive = ids.filter((id) => !found.get(id).is_active);
  if (inactive.length && source !== 'reversal') throw new LedgerError('Journal entry is not valid', ['cannot post to an inactive account']);
  // Retained earnings is calculated automatically from prior years' profit. Direct postings
  // (prior-period adjustments) are an accountant-level action, not allowed from normal entry screens.
  if (accts.some((a) => a.system_key === 'retained_earnings') && !['reversal', 'import', 'system'].includes(source)) {
    throw new LedgerError('Journal entry is not valid', ['Retained Earnings is calculated automatically; ask your accountant about prior-period adjustments']);
  }
  // Accounts Receivable / Payable are kept by invoices, bills and payments, so the customer and vendor
  // balances always add up to them. Ordinary entry screens can't post to them directly.
  if (accts.some((a) => CONTROL_KEYS[a.system_key]) && !DOCUMENT_SOURCES_OK.includes(source)) {
    throw new LedgerError('Journal entry is not valid', [controlMessage(accts)]);
  }
  if (company.locked_through && entry.date <= company.locked_through) {
    throw new LedgerError('Journal entry is not valid', [`books are closed through ${company.locked_through}`]);
  }
  const number = company.next_entry_number;
  await c.query('UPDATE companies SET next_entry_number = next_entry_number + 1 WHERE id = $1', [companyId]);
  const { rows: [je] } = await c.query(
    `INSERT INTO journal_entries (company_id, entry_number, entry_date, memo, source, source_ref, reverses_entry_id, created_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [companyId, number, entry.date, entry.memo, source, sourceRef, reversesEntryId, actor, idempotencyKey],
  );
  for (const l of entry.lines) {
    await c.query(
      `INSERT INTO journal_lines (entry_id, company_id, account_id, entry_date, debit_cents, credit_cents, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [je.id, companyId, l.accountId, entry.date, l.debitCents, l.creditCents, l.memo],
    );
  }
  await appendAudit(c, companyId, {
    action: 'post', entity: 'journal_entry', entityId: je.id, actor,
    payload: { number, date: entry.date, memo: entry.memo, source, sourceRef, reversesEntryId, lines: entry.lines },
  });
  return { ...je, lines: entry.lines };
}

export async function postEntry(pool, companyId, rawEntry, opts = {}) {
  const entry = validateEntry(rawEntry);
  return withTransaction(pool, (c) => insertEntry(c, companyId, entry, opts));
}

export async function postSimple(pool, companyId, tx, opts = {}) {
  const entry = simpleTransaction(tx);
  return withTransaction(pool, (c) => insertEntry(c, companyId, entry, { ...opts, source: 'simple' }));
}

/** Exposed so other services (payroll) can post inside their own transaction. */
export { insertEntry };

export async function reverseEntry(pool, companyId, entryId, { date, memo, actor = null, idempotencyKey = null, fromDocument = false } = {}) {
  return withTransaction(pool, async (c) => {
    const co = await lockCompany(c, companyId);
    const existing = await findByIdempotencyKey(c, companyId, cleanIdempotencyKey(idempotencyKey));
    if (existing) return existing;
    const { rows: [orig] } = await c.query('SELECT * FROM journal_entries WHERE company_id = $1 AND id = $2', [companyId, entryId]);
    if (!orig) throw new LedgerError('Journal entry not found');
    if (orig.reverses_entry_id) throw new LedgerError('Journal entry is not valid', ['a reversing entry cannot itself be reversed; post a new entry']);
    if (orig.source === 'payroll') throw new LedgerError('Journal entry is not valid', ['this is a paycheck; void the paycheck instead so year-to-date wages stay correct']);
    if (DOCUMENT_ENTRY[orig.source] && !fromDocument) throw new LedgerError('Journal entry is not valid', [`this entry belongs to ${DOCUMENT_ENTRY[orig.source]}; void it there so balances stay correct`]);
    const { rows: [already] } = await c.query('SELECT entry_number FROM journal_entries WHERE company_id = $1 AND reverses_entry_id = $2', [companyId, entryId]);
    if (already) throw new LedgerError('Journal entry is not valid', [`already reversed by entry #${already.entry_number}`]);
    const { rows: lines } = await c.query(
      `SELECT account_id AS "accountId", debit_cents AS "debitCents", credit_cents AS "creditCents", memo
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`, [entryId]);
    // Default date: the original date, or the first open day if that period is closed.
    const firstOpen = co.locked_through ? addDays(co.locked_through, 1) : null;
    const revDate = date ?? (firstOpen && firstOpen > orig.entry_date ? firstOpen : orig.entry_date);
    if (isIsoDate(revDate) && revDate < orig.entry_date) {
      throw new LedgerError('Journal entry is not valid', [`a reversal cannot be dated before the original entry (${orig.entry_date})`]);
    }
    const entry = validateEntry({
      date: revDate,
      memo: memo ?? `Reversal of entry #${orig.entry_number}${orig.memo ? `: ${orig.memo}` : ''}`,
      lines: reversingLines(lines),
    });
    return insertEntry(c, companyId, entry, { source: 'reversal', reversesEntryId: entryId, actor, idempotencyKey });
  });
}

const DOCUMENT_ENTRY = { invoice: 'an invoice (Sales tab)', bill: 'a bill (Bills tab)', payment: 'a payment (Sales or Bills tab)' };
const SOURCES = ['manual', 'simple', 'payroll', 'import', 'reversal', 'bank', 'recurring', 'system', 'invoice', 'bill', 'payment'];

/**
 * Journal search. All filters are optional and combine with AND:
 *   text      — words in the entry memo or any line memo, or an entry number ("#12" or "12")
 *   from, to  — date range (YYYY-MM-DD)
 *   accountId — entries that touch this account
 *   min, max  — entry total in dollars (the debit side), e.g. "100" or "2500.00"
 *   source    — manual, simple, payroll, recurring, reversal ...
 * Returns { entries, total, limit, offset } newest first.
 */
export async function listEntries(db, companyId, { from, to, text, accountId, min, max, source, limit = 200, offset = 0 } = {}) {
  const errors = [];
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) errors.push('dates must be YYYY-MM-DD');
  if (accountId && !/^[0-9a-f-]{36}$/i.test(accountId)) errors.push('unknown account');
  if (source && !SOURCES.includes(source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);
  const money = (v, label) => {
    if (v == null || v === '') return null;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(v).replace(/[$,]/g, ''))) { errors.push(`${label} must be a dollar amount`); return null; }
    return toCents(String(v).replace(/[$,]/g, ''));
  };
  const minCents = money(min, 'minimum amount');
  const maxCents = money(max, 'maximum amount');
  if (typeof text === 'string' && text.length > 100) errors.push('search text is too long');
  if (errors.length) throw new LedgerError('Search is not valid', errors);
  limit = Number(limit); offset = Number(offset);
  if (!Number.isInteger(limit) || limit < 1) limit = 200;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  const t = typeof text === 'string' ? text.trim() : '';
  const number = /^#?\d{1,9}$/.test(t) ? Number(t.replace('#', '')) : null;
  // Escape LIKE wildcards so "50%" searches for the literal text.
  const pattern = t && number === null ? `%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const params = [companyId, from || null, to || null, accountId || null, minCents, maxCents, source || null, number, pattern];
  const where = `
      e.company_id = $1
      AND ($2::date IS NULL OR e.entry_date >= $2) AND ($3::date IS NULL OR e.entry_date <= $3)
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.account_id = $4))
      AND ($5::bigint IS NULL OR (SELECT sum(debit_cents) FROM journal_lines x WHERE x.entry_id = e.id) >= $5)
      AND ($6::bigint IS NULL OR (SELECT sum(debit_cents) FROM journal_lines x WHERE x.entry_id = e.id) <= $6)
      AND ($7::text IS NULL OR e.source = $7)
      AND ($8::int IS NULL OR e.entry_number = $8)
      AND ($9::text IS NULL OR e.memo ILIKE $9 OR EXISTS (SELECT 1 FROM journal_lines x WHERE x.entry_id = e.id AND x.memo ILIKE $9))`;
  const { rows: [{ total }] } = await db.query(`SELECT count(*)::int AS total FROM journal_entries e WHERE ${where}`, params);
  const { rows } = await db.query(
    `SELECT e.id, e.entry_number AS "number", e.entry_date AS "date", e.memo, e.source, e.reverses_entry_id AS "reversesEntryId",
            r.entry_number AS "reversedByNumber",
            json_agg(json_build_object('accountId', l.account_id, 'code', a.code, 'name', a.name,
                     'debitCents', l.debit_cents, 'creditCents', l.credit_cents, 'memo', l.memo) ORDER BY l.id) AS lines
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN journal_entries r ON r.reverses_entry_id = e.id
      WHERE ${where}
      GROUP BY e.id, r.entry_number
      ORDER BY e.entry_date DESC, e.entry_number DESC
      LIMIT $10 OFFSET $11`,
    [...params, Math.min(limit, 1000), offset],
  );
  return { entries: rows, total, limit: Math.min(limit, 1000), offset };
}

// ---------------------------------------------------------------- Recurring entries

const recurringOut = (r) => ({
  id: r.id, name: r.name, frequency: r.frequency, startDate: r.start_date, endDate: r.end_date, memo: r.memo,
  lines: r.lines, postedCount: r.posted_count, nextDate: r.next_date, isActive: r.is_active, lastError: r.last_error,
  amountCents: r.lines.reduce((s, l) => s + l.debitCents, 0),
});

/**
 * Save a recurring entry template. It is checked exactly like a real entry (balanced, real accounts),
 * and posts automatically each night on its dates — or right away with "Post due entries".
 * Templates can't be edited (that would blur the audit trail): stop one and create a new one.
 */
export async function createRecurring(pool, companyId, { name, frequency, startDate, endDate = null, memo, lines, actor = null }) {
  const errors = [];
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) errors.push('name is required (up to 100 characters)');
  if (!Object.hasOwn(FREQUENCIES, frequency)) errors.push(`frequency must be one of ${Object.keys(FREQUENCIES).join(', ')}`);
  if (endDate != null && endDate !== '' && (!isIsoDate(endDate) || (isIsoDate(startDate) && endDate < startDate))) errors.push('end date must be a real date on or after the start date');
  if (errors.length) throw new LedgerError('Recurring entry is not valid', errors);
  const entry = validateEntry({ date: startDate, memo, lines });  // same checks as a real entry
  endDate = endDate || null;
  return withTransaction(pool, async (c) => {
    const co = await lockCompany(c, companyId);
    if (co.locked_through && startDate <= co.locked_through) throw new LedgerError('Recurring entry is not valid', [`start date must be after ${co.locked_through} (books are closed through then)`]);
    const ids = [...new Set(entry.lines.map((l) => l.accountId))];
    const { rows: accts } = await c.query(
      `SELECT id, system_key, is_active FROM accounts
        WHERE company_id = $1 AND id = ANY(SELECT x::uuid FROM unnest($2::text[]) x WHERE x ~* '^[0-9a-f-]{36}$')`, [companyId, ids]);
    if (accts.length !== ids.length || accts.some((a) => !a.is_active)) throw new LedgerError('Recurring entry is not valid', ['every line needs an active account of this company']);
    if (accts.some((a) => a.system_key === 'retained_earnings')) throw new LedgerError('Recurring entry is not valid', ['Retained Earnings is calculated automatically']);
    if (accts.some((a) => CONTROL_KEYS[a.system_key])) throw new LedgerError('Recurring entry is not valid', [controlMessage(accts)]);
    const { rows: [r] } = await c.query(
      `INSERT INTO recurring_entries (company_id, name, frequency, start_date, end_date, memo, lines, next_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$8) RETURNING *`,
      [companyId, name.trim(), frequency, startDate, endDate, entry.memo, JSON.stringify(entry.lines), actor]);
    await appendAudit(c, companyId, { action: 'create', entity: 'recurring_entry', entityId: r.id, actor,
      payload: { name: r.name, frequency, startDate, endDate, memo: entry.memo, lines: entry.lines } });
    return recurringOut(r);
  });
}

export async function listRecurring(db, companyId) {
  const { rows } = await db.query('SELECT * FROM recurring_entries WHERE company_id = $1 ORDER BY is_active DESC, next_date NULLS LAST, name', [companyId]);
  return rows.map(recurringOut);
}

export async function stopRecurring(pool, companyId, recurringId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [r] } = await c.query(
      'UPDATE recurring_entries SET is_active = false WHERE company_id = $1 AND id = $2 RETURNING *', [companyId, recurringId]);
    if (!r) throw new LedgerError('Recurring entry not found');
    await appendAudit(c, companyId, { action: 'stop', entity: 'recurring_entry', entityId: r.id, actor, payload: { name: r.name } });
    return recurringOut(r);
  });
}

const MAX_CATCH_UP = 120;  // per template per run, so a typo'd start date can't post thousands of entries

/**
 * Post every recurring entry that is due on or before `asOf`. Each occurrence is its own small
 * transaction with an idempotency key (template + occurrence number), so running this twice — or from
 * two servers at once — can never post the same occurrence twice. If an occurrence can't be posted
 * (e.g. its period was closed), the template stops there and shows the reason; nothing is skipped silently.
 * Returns { posted: [{name, date, number}], problems: [{name, date, error}] }.
 */
export async function postDueRecurring(pool, companyId, { asOf, actor = 'system:recurring' }) {
  if (!isIsoDate(asOf)) throw new LedgerError('asOf must be YYYY-MM-DD');
  const posted = [];
  const problems = [];
  const { rows: due } = await pool.query(
    'SELECT id FROM recurring_entries WHERE company_id = $1 AND is_active AND next_date IS NOT NULL AND next_date <= $2 ORDER BY next_date', [companyId, asOf]);
  for (const { id } of due) {
    for (let i = 0; i < MAX_CATCH_UP; i++) {
      let r;
      try {
        const out = await withTransaction(pool, async (c) => {
          await lockCompany(c, companyId);
          ({ rows: [r] } = await c.query('SELECT * FROM recurring_entries WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, id]));
          if (!r.is_active || !r.next_date || r.next_date > asOf) return null;
          const n = r.posted_count;
          const date = r.next_date;
          const entry = validateEntry({ date, memo: r.memo ? `${r.memo}` : r.name, lines: r.lines });
          const je = await insertEntry(c, companyId, entry, { source: 'recurring', sourceRef: `${r.id}#${n + 1}`, actor, idempotencyKey: `recurring:${r.id}:${n + 1}` });
          const next = nextOccurrence({ startDate: r.start_date, frequency: r.frequency, endDate: r.end_date }, n + 1);
          await c.query('UPDATE recurring_entries SET posted_count = $3, next_date = $4, last_error = NULL WHERE company_id = $1 AND id = $2',
            [companyId, id, n + 1, next]);
          return { name: r.name, date, number: je.entry_number };
        });
        if (!out) break;
        posted.push(out);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        const msg = err.message.slice(0, 500);
        await withTransaction(pool, (c) => c.query('UPDATE recurring_entries SET last_error = $3 WHERE company_id = $1 AND id = $2', [companyId, id, msg]));
        problems.push({ name: r?.name, date: r?.next_date, error: msg });
        break;
      }
    }
  }
  return { posted, problems };
}

/**
 * Close the books through a date. Moving the date earlier (or clearing it) REOPENS closed
 * periods: allowed, but a reason is required and recorded in the audit trail.
 * (Sprint 1: reopening also requires the owner role + MFA.)
 */
export async function lockPeriod(pool, companyId, { through, reason = null, actor = null }) {
  if (through !== null && !isIsoDate(through)) throw new LedgerError('Close date must be a real date written YYYY-MM-DD');
  return withTransaction(pool, async (c) => {
    const co = await lockCompany(c, companyId);
    const reopening = co.locked_through && (through === null || through < co.locked_through);
    if (reopening && !(typeof reason === 'string' && reason.trim().length >= 5)) {
      throw new LedgerError(`Reopening books closed through ${co.locked_through} requires a reason`);
    }
    await c.query('UPDATE companies SET locked_through = $2 WHERE id = $1', [companyId, through]);
    await appendAudit(c, companyId, { action: reopening ? 'reopen_period' : 'lock_period', entity: 'company', entityId: companyId, actor, payload: { from: co.locked_through, to: through, reason: reason ?? null } });
    return { lockedThrough: through };
  });
}

export async function updateCompanySettings(pool, companyId, { suiRatePct, calculateOnlyPayroll, famliHeadcount, futaCreditReduction, actor = null }) {
  // FUTA credit-reduction estimate by state, e.g. { CA: '1.2' }; an empty value removes a state.
  let futaCr = null;
  if (futaCreditReduction != null) {
    if (typeof futaCreditReduction !== 'object' || Array.isArray(futaCreditReduction)) throw new LedgerError('FUTA credit reduction must be rates by state');
    futaCr = {};
    for (const [st, v] of Object.entries(futaCreditReduction)) {
      if (!['TX', 'CO', 'CA', 'DC'].includes(st)) throw new LedgerError(`FUTA credit reduction: ${st} is not a supported state`);
      if (v === '' || v == null) continue;
      if (!/^\d(\.\d{1,2})?$/.test(String(v)) || Number(v) > 5.4) throw new LedgerError('FUTA credit reduction must be a percent from 0 to 5.4, like 1.2');
      futaCr[st] = String(v);
    }
  }
  if (suiRatePct != null && !/^\d{1,2}(\.\d{1,4})?$/.test(String(suiRatePct))) throw new LedgerError('Unemployment rate must be a percent like 2.7');
  if (famliHeadcount != null && !(Number.isInteger(famliHeadcount) && famliHeadcount >= 0)) throw new LedgerError('FAMLI headcount must be a whole number');
  if (calculateOnlyPayroll != null && typeof calculateOnlyPayroll !== 'boolean') throw new LedgerError('calculateOnlyPayroll must be true or false');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [co] } = await c.query(
      `UPDATE companies SET sui_rate_pct = COALESCE($2, sui_rate_pct),
              calculate_only_payroll = COALESCE($3, calculate_only_payroll),
              famli_headcount = COALESCE($4, famli_headcount),
              futa_credit_reduction = COALESCE($5::jsonb, futa_credit_reduction) WHERE id = $1 RETURNING *`,
      [companyId, suiRatePct == null ? null : String(suiRatePct), calculateOnlyPayroll ?? null, famliHeadcount ?? null, futaCr == null ? null : JSON.stringify(futaCr)]);
    await appendAudit(c, companyId, { action: 'update_settings', entity: 'company', entityId: companyId, actor,
      payload: { suiRatePct: suiRatePct ?? null, calculateOnlyPayroll: calculateOnlyPayroll ?? null, famliHeadcount: famliHeadcount ?? null, futaCreditReduction: futaCr } });
    return co;
  });
}
