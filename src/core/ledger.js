// Double-entry ledger rules (pure functions, no database).
//
// Every journal entry is a set of lines; each line is EITHER a debit OR a credit
// on one account. An entry may only be posted when total debits === total credits.
// This is the accounting equivalent of a free-body diagram summing to zero.

import { assertCents, sum, toCents } from './money.js';

export const ACCOUNT_TYPES = Object.freeze(['asset', 'liability', 'equity', 'revenue', 'expense']);

/** Debit-normal accounts grow with debits; credit-normal grow with credits. */
export function normalBalance(type) {
  if (type === 'asset' || type === 'expense') return 'debit';
  if (type === 'liability' || type === 'equity' || type === 'revenue') return 'credit';
  throw new RangeError(`Unknown account type: ${type}`);
}

/** Balance of an account in its natural sign (positive = normal). Contra accounts come out negative. */
export function naturalBalance(type, debitCents, creditCents) {
  return normalBalance(type) === 'debit' ? debitCents - creditCents : creditCents - debitCents;
}

export const CASH_FLOW_CATEGORIES = Object.freeze(['cash', 'operating', 'investing', 'financing']);

/** True only for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

export class LedgerError extends Error {
  constructor(message, details) {
    super(details?.length ? `${message}: ${details.join('; ')}` : message);
    this.name = 'LedgerError';
    this.details = details;
  }
}

/**
 * Normalize and validate a proposed journal entry.
 * Input lines may give amounts as strings ("12.34") or cents (integers) via debitCents/creditCents.
 * Returns { date, memo, lines:[{accountId, debitCents, creditCents, memo}] , totalCents }.
 */
export function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== 'object') throw new LedgerError('Entry is required');
  const date = entry.date;
  if (!isIsoDate(date)) errors.push(`date must be a real calendar date written YYYY-MM-DD (got ${date})`);
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
    errors.push('an entry needs at least two lines');
  }
  const lines = [];
  for (const [i, raw] of (entry.lines ?? []).entries()) {
    try {
      const debitCents = raw.debitCents ?? (raw.debit != null && raw.debit !== '' ? toCents(raw.debit) : 0);
      const creditCents = raw.creditCents ?? (raw.credit != null && raw.credit !== '' ? toCents(raw.credit) : 0);
      assertCents(debitCents, `line ${i + 1} debit`);
      assertCents(creditCents, `line ${i + 1} credit`);
      if (debitCents < 0 || creditCents < 0) errors.push(`line ${i + 1}: amounts cannot be negative (swap debit/credit instead)`);
      if ((debitCents > 0) === (creditCents > 0)) errors.push(`line ${i + 1}: enter either a debit or a credit, not both or neither`);
      if (!raw.accountId) errors.push(`line ${i + 1}: account is required`);
      lines.push({ accountId: raw.accountId, debitCents, creditCents, memo: raw.memo ?? null });
    } catch (e) {
      errors.push(`line ${i + 1}: ${e.message}`);
    }
  }
  const totalDebits = sum(lines.map((l) => l.debitCents));
  const totalCredits = sum(lines.map((l) => l.creditCents));
  if (!errors.length && totalDebits !== totalCredits) {
    errors.push(`debits (${totalDebits}¢) must equal credits (${totalCredits}¢); difference ${totalDebits - totalCredits}¢`);
  }
  if (errors.length) throw new LedgerError('Journal entry is not valid', errors);
  return { date, memo: entry.memo ?? null, lines, totalCents: totalDebits };
}

/** Build the lines that exactly reverse an entry (debits <-> credits). */
export function reversingLines(lines) {
  return lines.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, memo: l.memo }));
}

/**
 * "Simple mode" transaction for non-accountants: money moved FROM one account TO another.
 * TO account is debited, FROM account is credited. Examples:
 *   paid rent from checking:   from=Checking, to=Rent Expense
 *   customer paid cash sale:   from=Sales,    to=Checking
 */
export function simpleTransaction({ date, memo, fromAccountId, toAccountId, amount }) {
  const cents = typeof amount === 'number' && Number.isInteger(amount) ? amount : toCents(amount);
  if (cents <= 0) throw new LedgerError('Journal entry is not valid', ['amount must be greater than zero']);
  if (fromAccountId === toAccountId) throw new LedgerError('Journal entry is not valid', ['from and to accounts must differ']);
  return validateEntry({
    date,
    memo,
    lines: [
      { accountId: toAccountId, debitCents: cents, creditCents: 0 },
      { accountId: fromAccountId, debitCents: 0, creditCents: cents },
    ],
  });
}
