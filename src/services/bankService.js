// Banking: import bank statements, categorize or match each transaction, and reconcile.
//
// ℹ️ The bank feed is not the books. Each imported bank transaction waits in a "to review" list
// until someone (or a rule's suggestion, confirmed by someone) decides what it is:
//   • Post      — record a new entry: bank account ↔ the chosen account (e.g. Rent expense).
//   • Match     — it's already in the books (e.g. a paycheck or a check you entered); link to that entry.
//   • Exclude   — not a real business transaction for this account (e.g. the bank listed it twice).
// Reconciliation then proves the books agree with the bank statement to the penny.
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate, simpleTransaction } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { readStatement, dedupeKeys, applyRules, ImportError } from '../core/bankImport.js';
import { insertEntry, reverseEntry } from './ledgerService.js';
import { appendAudit } from './audit.js';

const UUIDISH = /^[0-9a-f-]{36}$/i;
const lockCompany = async (c, companyId) => {
  const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  return co;
};

async function bankAccount(db, companyId, accountId) {
  if (typeof accountId !== 'string' || !UUIDISH.test(accountId)) throw new LedgerError('Bank account not found');
  const { rows: [a] } = await db.query('SELECT * FROM accounts WHERE company_id = $1 AND id = $2', [companyId, accountId]);
  // Credit cards are "bank-like" too: they have statements and are reconciled the same way.
  if (!a || !(a.cash_flow === 'cash' || a.subtype === 'credit_card')) throw new LedgerError('Bank account not found');
  return a;
}

const ruleOut = (r) => ({ id: r.id, matchText: r.match_text, direction: r.direction, minCents: r.min_cents, maxCents: r.max_cents, accountId: r.account_id, priority: r.priority, isActive: r.is_active });

async function activeRules(db, companyId) {
  const { rows } = await db.query('SELECT * FROM bank_rules WHERE company_id = $1 AND is_active ORDER BY priority, created_at', [companyId]);
  return rows.map(ruleOut);
}

/**
 * Import a CSV or OFX/QFX statement for one bank account. Transactions already imported (same bank
 * id, or same date+amount+description) are skipped, so overlapping downloads are safe.
 * With preview: true nothing is saved; the result shows what would happen.
 */
export async function importStatement(pool, companyId, { bankAccountId, fileName = '', content, preview = false, actor = null }) {
  if (typeof content !== 'string' || !content.trim()) throw new LedgerError('Choose a statement file to import');
  if (content.length > 5_000_000) throw new LedgerError('File is too large (5 MB limit)');
  let txns;
  try { txns = readStatement(content, fileName); } catch (e) {
    if (e instanceof ImportError) throw new LedgerError(e.message, e.details);
    throw e;
  }
  const keys = dedupeKeys(txns);
  const source = /<OFX>/i.test(content.slice(0, 5000)) ? 'ofx' : 'csv';
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const acct = await bankAccount(c, companyId, bankAccountId);
    const { rows: existing } = await c.query(
      'SELECT dedupe_key FROM bank_transactions WHERE company_id = $1 AND bank_account_id = $2 AND dedupe_key = ANY($3)', [companyId, acct.id, keys]);
    const have = new Set(existing.map((r) => r.dedupe_key));
    const rules = await activeRules(c, companyId);
    const batch = randomUUID();
    const fresh = [];
    txns.forEach((t, i) => { if (!have.has(keys[i])) fresh.push({ ...t, key: keys[i], rule: applyRules(rules, t) }); });
    const dates = txns.map((t) => t.date).sort();
    const summary = {
      batch, fileName: String(fileName).slice(0, 200), source, total: txns.length, new: fresh.length, duplicates: txns.length - fresh.length,
      firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
      inCents: fresh.filter((t) => t.amountCents > 0).reduce((s, t) => s + t.amountCents, 0),
      outCents: fresh.filter((t) => t.amountCents < 0).reduce((s, t) => s - t.amountCents, 0),
      preview: preview ? fresh.slice(0, 50).map((t) => ({ date: t.date, amountCents: t.amountCents, description: t.description, suggestedAccountId: t.rule?.accountId ?? null })) : undefined,
    };
    if (preview) return summary;
    for (const t of fresh) {
      await c.query(
        `INSERT INTO bank_transactions (company_id, bank_account_id, posted_date, amount_cents, description, dedupe_key, source, import_batch, suggested_account_id, rule_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [companyId, acct.id, t.date, t.amountCents, t.description, t.key, source, batch, t.rule?.accountId ?? null, t.rule?.id ?? null]);
    }
    await appendAudit(c, companyId, { action: 'import', entity: 'bank_statement', entityId: batch, actor,
      payload: { bankAccountId: acct.id, fileName: summary.fileName, source, total: summary.total, new: summary.new, duplicates: summary.duplicates, inCents: summary.inCents, outCents: summary.outCents } });
    return summary;
  });
}

const txOut = (t) => ({
  id: t.id, bankAccountId: t.bank_account_id, date: t.posted_date, amountCents: t.amount_cents, description: t.description,
  status: t.status, suggestedAccountId: t.suggested_account_id, ruleId: t.rule_id, journalEntryId: t.journal_entry_id,
  entryNumber: t.entry_number ?? null, note: t.note, source: t.source,
});

export async function listBankTransactions(db, companyId, { bankAccountId, status = 'review', limit = 500 } = {}) {
  if (status && !['review', 'posted', 'matched', 'excluded', 'all'].includes(status)) throw new LedgerError('Unknown status');
  await bankAccount(db, companyId, bankAccountId);
  const { rows } = await db.query(
    `SELECT b.*, e.entry_number FROM bank_transactions b LEFT JOIN journal_entries e ON e.id = b.journal_entry_id
      WHERE b.company_id = $1 AND b.bank_account_id = $2 AND ($3 = 'all' OR b.status = $3)
      ORDER BY b.posted_date DESC, b.created_at DESC LIMIT $4`,
    [companyId, bankAccountId, status, Math.min(Number(limit) || 500, 2000)]);
  return rows.map(txOut);
}

async function lockBankTx(c, companyId, bankTxId) {
  if (typeof bankTxId !== 'string' || !UUIDISH.test(bankTxId)) throw new LedgerError('Bank transaction not found');
  const { rows: [t] } = await c.query('SELECT * FROM bank_transactions WHERE company_id = $1 AND id = $2 FOR UPDATE', [companyId, bankTxId]);
  if (!t) throw new LedgerError('Bank transaction not found');
  return t;
}

/** Record a reviewed bank transaction as a new entry (bank account ↔ chosen account). */
export async function postBankTransaction(pool, companyId, bankTxId, { accountId, memo, actor = null }) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const t = await lockBankTx(c, companyId, bankTxId);
    if (t.status !== 'review') throw new LedgerError(`This bank transaction is already ${t.status}`);
    const amt = Math.abs(t.amount_cents);
    // Money in: debit bank, credit the chosen account. Money out: the reverse.
    const entry = simpleTransaction({
      date: t.posted_date, memo: (memo ?? t.description) || null, amountCents: amt,
      fromAccountId: t.amount_cents > 0 ? accountId : t.bank_account_id,
      toAccountId: t.amount_cents > 0 ? t.bank_account_id : accountId,
    });
    const je = await insertEntry(c, companyId, entry, { source: 'bank', sourceRef: t.id, actor });
    await c.query(`UPDATE bank_transactions SET status = 'posted', journal_entry_id = $3, reviewed_by = $4, reviewed_at = now() WHERE company_id = $1 AND id = $2`,
      [companyId, t.id, je.id, actor]);
    return { ...txOut({ ...t, status: 'posted', journal_entry_id: je.id }), entryNumber: je.entry_number };
  });
}

/**
 * Entries already in the books that could be this bank transaction: they hit this bank account for
 * the same amount and direction, within `days` of the bank date, and aren't linked to another bank line.
 */
export async function findMatches(db, companyId, bankTxId, { days = 10 } = {}) {
  const t = (await db.query('SELECT * FROM bank_transactions WHERE company_id = $1 AND id = $2', [companyId, bankTxId])).rows[0];
  if (!t) throw new LedgerError('Bank transaction not found');
  const { rows } = await db.query(
    `SELECT e.id, e.entry_number AS "number", e.entry_date AS "date", e.memo, e.source,
            sum(l.debit_cents - l.credit_cents)::bigint AS "bankCents"
       FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.account_id = $2
      WHERE e.company_id = $1 AND e.entry_date BETWEEN $3::date - $5::int AND $3::date + $5::int
        AND NOT EXISTS (SELECT 1 FROM bank_transactions b WHERE b.company_id = $1 AND b.journal_entry_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
        AND e.reverses_entry_id IS NULL
      GROUP BY e.id
     HAVING sum(l.debit_cents - l.credit_cents) = $4
      ORDER BY abs(e.entry_date - $3::date), e.entry_number
      LIMIT 10`,
    [companyId, t.bank_account_id, t.posted_date, t.amount_cents, Math.min(Math.max(Number(days) || 10, 0), 60)]);
  return rows;
}

export async function matchBankTransaction(pool, companyId, bankTxId, { entryId, actor = null }) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const t = await lockBankTx(c, companyId, bankTxId);
    if (t.status !== 'review') throw new LedgerError(`This bank transaction is already ${t.status}`);
    const candidates = await findMatches(c, companyId, bankTxId, { days: 60 });
    const hit = candidates.find((e) => e.id === entryId);
    if (!hit) throw new LedgerError('That entry does not match this bank transaction (it must hit this account for the same amount, and not be matched already)');
    await c.query(`UPDATE bank_transactions SET status = 'matched', journal_entry_id = $3, reviewed_by = $4, reviewed_at = now() WHERE company_id = $1 AND id = $2`,
      [companyId, t.id, entryId, actor]);
    await appendAudit(c, companyId, { action: 'match', entity: 'bank_transaction', entityId: t.id, actor, payload: { entryId, amountCents: t.amount_cents, date: t.posted_date } });
    return { ...txOut({ ...t, status: 'matched', journal_entry_id: entryId }), entryNumber: hit.number };
  });
}

export async function excludeBankTransaction(pool, companyId, bankTxId, { reason, actor = null }) {
  if (typeof reason !== 'string' || reason.trim().length < 3) throw new LedgerError('Say why this transaction is excluded (e.g. "duplicate")');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const t = await lockBankTx(c, companyId, bankTxId);
    if (t.status !== 'review') throw new LedgerError(`This bank transaction is already ${t.status}`);
    await c.query(`UPDATE bank_transactions SET status = 'excluded', note = $3, reviewed_by = $4, reviewed_at = now() WHERE company_id = $1 AND id = $2`,
      [companyId, t.id, reason.trim().slice(0, 300), actor]);
    await appendAudit(c, companyId, { action: 'exclude', entity: 'bank_transaction', entityId: t.id, actor, payload: { reason: reason.trim(), amountCents: t.amount_cents, date: t.posted_date } });
    return txOut({ ...t, status: 'excluded', note: reason.trim() });
  });
}

/**
 * Send a reviewed bank transaction back to "to review". A posted one has its entry reversed
 * (history is kept); a matched one is just unlinked. Not allowed if the entry is reconciled.
 */
export async function undoBankTransaction(pool, companyId, bankTxId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const t = await lockBankTx(c, companyId, bankTxId);
    if (t.status === 'review') throw new LedgerError('This bank transaction has not been reviewed yet');
    if (t.journal_entry_id) {
      const { rows: [cleared] } = await c.query(
        `SELECT 1 FROM reconciliation_lines rl JOIN journal_lines l ON l.id = rl.journal_line_id
          WHERE l.entry_id = $1 AND l.account_id = $2`, [t.journal_entry_id, t.bank_account_id]);
      if (cleared) throw new LedgerError('This entry is part of a bank reconciliation; it can no longer be undone here');
    }
    const { rows: [rev] } = t.journal_entry_id
      ? await c.query('SELECT 1 FROM journal_entries WHERE company_id = $1 AND reverses_entry_id = $2', [companyId, t.journal_entry_id]) : { rows: [] };
    if (t.status === 'posted' && !rev) await reverseEntry(c, companyId, t.journal_entry_id, { memo: `Undo bank posting: ${t.description}`.slice(0, 500), actor, fromBank: true });
    await c.query(`UPDATE bank_transactions SET status = 'review', journal_entry_id = NULL, note = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE company_id = $1 AND id = $2`,
      [companyId, t.id]);
    await appendAudit(c, companyId, { action: 'undo', entity: 'bank_transaction', entityId: t.id, actor, payload: { was: t.status, entryId: t.journal_entry_id } });
    return txOut({ ...t, status: 'review', journal_entry_id: null, note: null });
  });
}

// ---------------------------------------------------------------- Rules

export async function listRules(db, companyId) {
  const { rows } = await db.query('SELECT * FROM bank_rules WHERE company_id = $1 AND is_active ORDER BY priority, created_at', [companyId]);
  return rows.map(ruleOut);
}

export async function createRule(pool, companyId, { matchText, direction = 'any', min, max, accountId, priority = 100, actor = null }) {
  const errors = [];
  if (typeof matchText !== 'string' || matchText.trim().length < 2 || matchText.trim().length > 100) errors.push('text to look for must be 2-100 characters');
  if (!['in', 'out', 'any'].includes(direction)) errors.push('direction must be in, out or any');
  const cents = (v, label) => {
    if (v == null || v === '') return null;
    try { const n = toCents(String(v)); if (n < 0) throw new Error(); return n; } catch { errors.push(`${label} must be a dollar amount`); return null; }
  };
  const minCents = cents(min, 'minimum');
  const maxCents = cents(max, 'maximum');
  if (!Number.isInteger(priority) || priority < 0 || priority > 10000) errors.push('priority must be a whole number');
  if (errors.length) throw new LedgerError('Rule is not valid', errors);
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [a] } = await c.query('SELECT id, system_key, is_active FROM accounts WHERE company_id = $1 AND id::text = $2', [companyId, String(accountId)]);
    if (!a || !a.is_active || a.system_key === 'retained_earnings') throw new LedgerError('Rule is not valid', ['choose an active account']);
    const { rows: [r] } = await c.query(
      `INSERT INTO bank_rules (company_id, match_text, direction, min_cents, max_cents, account_id, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, matchText.trim(), direction, minCents, maxCents, a.id, priority, actor]);
    // Apply the new rule to transactions still waiting for review that have no suggestion yet.
    const { rows: waiting } = await c.query(
      `SELECT id, description, amount_cents FROM bank_transactions WHERE company_id = $1 AND status = 'review' AND suggested_account_id IS NULL`, [companyId]);
    const rule = ruleOut(r);
    let applied = 0;
    for (const w of waiting) {
      if (applyRules([rule], { description: w.description, amountCents: w.amount_cents })) {
        await c.query('UPDATE bank_transactions SET suggested_account_id = $3, rule_id = $4 WHERE company_id = $1 AND id = $2', [companyId, w.id, a.id, r.id]);
        applied++;
      }
    }
    await appendAudit(c, companyId, { action: 'create', entity: 'bank_rule', entityId: r.id, actor, payload: rule });
    return { ...rule, applied };
  });
}

export async function deleteRule(pool, companyId, ruleId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [r] } = await c.query('UPDATE bank_rules SET is_active = false WHERE company_id = $1 AND id::text = $2 RETURNING *', [companyId, String(ruleId)]);
    if (!r) throw new LedgerError('Rule not found');
    await appendAudit(c, companyId, { action: 'delete', entity: 'bank_rule', entityId: r.id, actor, payload: { matchText: r.match_text } });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- Reconciliation

const reconOut = (r) => ({
  id: r.id, bankAccountId: r.bank_account_id, statementDate: r.statement_date, beginningCents: r.beginning_cents,
  endingCents: r.ending_cents, status: r.status, completedAt: r.completed_at, completedBy: r.completed_by,
});

/** Balance of everything cleared in completed reconciliations for this account (the next statement's beginning balance). */
async function clearedBalance(db, companyId, bankAccountId) {
  const { rows: [{ cents }] } = await db.query(
    `SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint AS cents
       FROM reconciliation_lines rl JOIN reconciliations r ON r.id = rl.reconciliation_id
       JOIN journal_lines l ON l.id = rl.journal_line_id
      WHERE rl.company_id = $1 AND r.bank_account_id = $2 AND r.status = 'completed'`, [companyId, bankAccountId]);
  return cents;
}

/** Account sign: banks are assets (debit = up); credit cards are liabilities (credit = up). */
const signFor = (acct) => (acct.type === 'liability' ? -1 : 1);

export async function startReconciliation(pool, companyId, { bankAccountId, statementDate, endingBalance, actor = null }) {
  if (!isIsoDate(statementDate)) throw new LedgerError('Statement date must be a real date');
  let endingCents;
  try { endingCents = toCents(String(endingBalance ?? '')); } catch { throw new LedgerError('Enter the ending balance from the statement'); }
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const acct = await bankAccount(c, companyId, bankAccountId);
    const { rows: [open] } = await c.query(`SELECT id FROM reconciliations WHERE company_id = $1 AND bank_account_id = $2 AND status = 'open'`, [companyId, acct.id]);
    if (open) throw new LedgerError('A reconciliation for this account is already in progress');
    const { rows: [last] } = await c.query(
      `SELECT statement_date FROM reconciliations WHERE company_id = $1 AND bank_account_id = $2 AND status = 'completed' ORDER BY statement_date DESC LIMIT 1`, [companyId, acct.id]);
    if (last && statementDate <= last.statement_date) throw new LedgerError(`Statement date must be after the last reconciled statement (${last.statement_date})`);
    const beginning = signFor(acct) * (await clearedBalance(c, companyId, acct.id));
    const { rows: [r] } = await c.query(
      `INSERT INTO reconciliations (company_id, bank_account_id, statement_date, beginning_cents, ending_cents, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [companyId, acct.id, statementDate, beginning, endingCents, actor]);
    return reconOut(r);
  });
}

/**
 * The reconciliation worksheet: every uncleared book line on this account dated on or before the
 * statement date, which ones are ticked, and the running difference (must reach $0.00 to finish).
 */
export async function getReconciliation(db, companyId, reconId) {
  const { rows: [r] } = await db.query('SELECT * FROM reconciliations WHERE company_id = $1 AND id::text = $2', [companyId, String(reconId)]);
  if (!r) throw new LedgerError('Reconciliation not found');
  const acct = await bankAccount(db, companyId, r.bank_account_id);
  const sign = signFor(acct);
  const { rows: lines } = await db.query(
    `SELECT l.id, l.entry_date AS "date", e.entry_number AS "number", coalesce(l.memo, e.memo) AS memo,
            ($4::int * (l.debit_cents - l.credit_cents))::bigint AS "amountCents",
            (rl.reconciliation_id IS NOT NULL) AS cleared
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       LEFT JOIN reconciliation_lines rl ON rl.journal_line_id = l.id
      WHERE l.company_id = $1 AND l.account_id = $2 AND l.entry_date <= $3
        AND (rl.reconciliation_id IS NULL OR rl.reconciliation_id = $5)
      ORDER BY l.entry_date, e.entry_number, l.id`,
    [companyId, r.bank_account_id, r.statement_date, sign, r.id]);
  const clearedCents = lines.filter((l) => l.cleared).reduce((s, l) => s + l.amountCents, 0);
  const differenceCents = r.ending_cents - (r.beginning_cents + clearedCents);
  return { ...reconOut(r), accountName: acct.name, lines, clearedCents, differenceCents };
}

export async function listReconciliations(db, companyId, { bankAccountId }) {
  await bankAccount(db, companyId, bankAccountId);
  const { rows } = await db.query('SELECT * FROM reconciliations WHERE company_id = $1 AND bank_account_id = $2 ORDER BY statement_date DESC', [companyId, bankAccountId]);
  return rows.map(reconOut);
}

/** Tick or untick book lines. */
export async function setCleared(pool, companyId, reconId, { lineIds, cleared }) {
  if (!Array.isArray(lineIds) || !lineIds.length || lineIds.length > 2000 || !lineIds.every((x) => Number.isSafeInteger(x) && x > 0)) throw new LedgerError('Choose the lines to tick');
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [r] } = await c.query('SELECT * FROM reconciliations WHERE company_id = $1 AND id::text = $2 FOR UPDATE', [companyId, String(reconId)]);
    if (!r) throw new LedgerError('Reconciliation not found');
    if (r.status !== 'open') throw new LedgerError('This reconciliation is finished');
    if (cleared) {
      const { rows: ok } = await c.query(
        `SELECT l.id FROM journal_lines l LEFT JOIN reconciliation_lines rl ON rl.journal_line_id = l.id
          WHERE l.company_id = $1 AND l.account_id = $2 AND l.entry_date <= $3 AND l.id = ANY($4::bigint[]) AND rl.journal_line_id IS NULL`,
        [companyId, r.bank_account_id, r.statement_date, lineIds]);
      for (const { id } of ok) await c.query('INSERT INTO reconciliation_lines (company_id, reconciliation_id, journal_line_id) VALUES ($1,$2,$3)', [companyId, r.id, id]);
    } else {
      await c.query('DELETE FROM reconciliation_lines WHERE company_id = $1 AND reconciliation_id = $2 AND journal_line_id = ANY($3::bigint[])', [companyId, r.id, lineIds]);
    }
    return getReconciliation(c, companyId, r.id);
  });
}

/** Finish: only when the difference is exactly $0.00. After this the reconciliation can't change. */
export async function completeReconciliation(pool, companyId, reconId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const sheet = await getReconciliation(c, companyId, reconId);
    if (sheet.status !== 'open') throw new LedgerError('This reconciliation is already finished');
    if (sheet.differenceCents !== 0) throw new LedgerError(`The difference must be $0.00 to finish (it is ${(sheet.differenceCents / 100).toFixed(2)})`);
    await c.query(`UPDATE reconciliations SET status = 'completed', completed_by = $3, completed_at = now() WHERE company_id = $1 AND id = $2`, [companyId, sheet.id, actor]);
    await appendAudit(c, companyId, { action: 'reconcile', entity: 'bank_account', entityId: sheet.bankAccountId, actor,
      payload: { reconciliationId: sheet.id, statementDate: sheet.statementDate, beginningCents: sheet.beginningCents, endingCents: sheet.endingCents,
        clearedLineIds: sheet.lines.filter((l) => l.cleared).map((l) => l.id) } });
    return { ...sheet, status: 'completed' };
  });
}

/** Abandon a reconciliation that is still in progress (nothing in the books changes). */
export async function cancelReconciliation(pool, companyId, reconId, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await lockCompany(c, companyId);
    const { rows: [r] } = await c.query('SELECT * FROM reconciliations WHERE company_id = $1 AND id::text = $2 FOR UPDATE', [companyId, String(reconId)]);
    if (!r) throw new LedgerError('Reconciliation not found');
    if (r.status !== 'open') throw new LedgerError('A finished reconciliation cannot be cancelled');
    await c.query('DELETE FROM reconciliation_lines WHERE company_id = $1 AND reconciliation_id = $2', [companyId, r.id]);
    await c.query('DELETE FROM reconciliations WHERE company_id = $1 AND id = $2', [companyId, r.id]);
    await appendAudit(c, companyId, { action: 'cancel', entity: 'reconciliation', entityId: String(r.id), actor, payload: { bankAccountId: r.bank_account_id, statementDate: r.statement_date } });
    return { ok: true };
  });
}
