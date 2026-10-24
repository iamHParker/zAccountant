// Database-backed ledger: companies, accounts, posting and reversing entries, closing periods.
import { randomUUID } from 'node:crypto';
import { withTransaction, setScopeCompany } from '../db/pool.js';
import { DEFAULT_CHART } from '../core/chartOfAccounts.js';
import { validateEntry, simpleTransaction, reversingLines, LedgerError, ACCOUNT_TYPES, isIsoDate } from '../core/ledger.js';
import { appendAudit } from './audit.js';

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
async function insertEntry(c, companyId, entry, { source = 'manual', sourceRef = null, reversesEntryId = null, actor = null }) {
  const company = await lockCompany(c, companyId);
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
  if (company.locked_through && entry.date <= company.locked_through) {
    throw new LedgerError('Journal entry is not valid', [`books are closed through ${company.locked_through}`]);
  }
  const number = company.next_entry_number;
  await c.query('UPDATE companies SET next_entry_number = next_entry_number + 1 WHERE id = $1', [companyId]);
  const { rows: [je] } = await c.query(
    `INSERT INTO journal_entries (company_id, entry_number, entry_date, memo, source, source_ref, reverses_entry_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, number, entry.date, entry.memo, source, sourceRef, reversesEntryId, actor],
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

export async function reverseEntry(pool, companyId, entryId, { date, memo, actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    const co = await lockCompany(c, companyId);
    const { rows: [orig] } = await c.query('SELECT * FROM journal_entries WHERE company_id = $1 AND id = $2', [companyId, entryId]);
    if (!orig) throw new LedgerError('Journal entry not found');
    if (orig.reverses_entry_id) throw new LedgerError('Journal entry is not valid', ['a reversing entry cannot itself be reversed; post a new entry']);
    if (orig.source === 'payroll') throw new LedgerError('Journal entry is not valid', ['this is a paycheck; void the paycheck instead so year-to-date wages stay correct']);
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
    return insertEntry(c, companyId, entry, { source: 'reversal', reversesEntryId: entryId, actor });
  });
}

export async function listEntries(db, companyId, { from, to, limit = 200 } = {}) {
  if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) throw new LedgerError('Dates must be YYYY-MM-DD');
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 200;
  const { rows } = await db.query(
    `SELECT e.id, e.entry_number AS "number", e.entry_date AS "date", e.memo, e.source, e.reverses_entry_id AS "reversesEntryId",
            r.entry_number AS "reversedByNumber",
            json_agg(json_build_object('accountId', l.account_id, 'code', a.code, 'name', a.name,
                     'debitCents', l.debit_cents, 'creditCents', l.credit_cents, 'memo', l.memo) ORDER BY l.id) AS lines
       FROM journal_entries e
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN journal_entries r ON r.reverses_entry_id = e.id
      WHERE e.company_id = $1 AND ($2::date IS NULL OR e.entry_date >= $2) AND ($3::date IS NULL OR e.entry_date <= $3)
      GROUP BY e.id, r.entry_number
      ORDER BY e.entry_date DESC, e.entry_number DESC
      LIMIT $4`,
    [companyId, from || null, to || null, Math.min(limit, 1000)],
  );
  return rows;
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

export async function updateCompanySettings(pool, companyId, { suiRatePct, calculateOnlyPayroll, famliHeadcount, actor = null }) {
  if (suiRatePct != null && !/^\d{1,2}(\.\d{1,4})?$/.test(String(suiRatePct))) throw new LedgerError('Unemployment rate must be a percent like 2.7');
  if (famliHeadcount != null && !(Number.isInteger(famliHeadcount) && famliHeadcount >= 0)) throw new LedgerError('FAMLI headcount must be a whole number');
  if (calculateOnlyPayroll != null && typeof calculateOnlyPayroll !== 'boolean') throw new LedgerError('calculateOnlyPayroll must be true or false');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [co] } = await c.query(
      `UPDATE companies SET sui_rate_pct = COALESCE($2, sui_rate_pct),
              calculate_only_payroll = COALESCE($3, calculate_only_payroll),
              famli_headcount = COALESCE($4, famli_headcount) WHERE id = $1 RETURNING *`,
      [companyId, suiRatePct == null ? null : String(suiRatePct), calculateOnlyPayroll ?? null, famliHeadcount ?? null]);
    await appendAudit(c, companyId, { action: 'update_settings', entity: 'company', entityId: companyId, actor, payload: { suiRatePct: suiRatePct ?? null, calculateOnlyPayroll: calculateOnlyPayroll ?? null, famliHeadcount: famliHeadcount ?? null } });
    return co;
  });
}
