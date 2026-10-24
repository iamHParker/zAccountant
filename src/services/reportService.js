// Pulls account totals from the database and hands them to the pure report functions.
import { trialBalance, incomeStatement, balanceSheet, cashFlowStatement, postClosingSums } from '../core/reports.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { getCompany, listAccounts } from './ledgerService.js';

const need = (d, label) => { if (!isIsoDate(d)) throw new LedgerError(`${label} must be YYYY-MM-DD`); return d; };

/** Per-account sums for entries dated in [from, to] (either bound may be null = open). */
export async function accountSums(db, companyId, { from = null, to = null } = {}) {
  const { rows } = await db.query(
    `SELECT account_id, sum(debit_cents)::bigint AS d, sum(credit_cents)::bigint AS c
       FROM journal_lines
      WHERE company_id = $1 AND ($2::date IS NULL OR entry_date >= $2) AND ($3::date IS NULL OR entry_date <= $3)
      GROUP BY account_id`,
    [companyId, from, to],
  );
  return new Map(rows.map((r) => [r.account_id, { debitCents: r.d, creditCents: r.c }]));
}

function dayBefore(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** First day of the fiscal year that contains `date`. */
export function fiscalYearStart(date, startMonth) {
  const [y, m] = date.split('-').map(Number);
  const year = m >= startMonth ? y : y - 1;
  return `${year}-${String(startMonth).padStart(2, '0')}-01`;
}

/** Trial balance as of a date, post-closing view: income accounts show this fiscal year only and
 *  prior years' profit is in Retained Earnings, so it agrees line-for-line with the balance sheet. */
export async function getTrialBalance(db, companyId, { asOf }) {
  need(asOf, 'asOf');
  const company = await getCompany(db, companyId);
  const accounts = await listAccounts(db, companyId);
  const fyStart = fiscalYearStart(asOf, company.fiscal_year_start_month);
  const [sumsAsOf, sumsBeforeFy] = await Promise.all([
    accountSums(db, companyId, { to: asOf }),
    accountSums(db, companyId, { to: dayBefore(fyStart) }),
  ]);
  return { asOf, fiscalYearStart: fyStart, ...trialBalance(accounts, postClosingSums(accounts, sumsAsOf, sumsBeforeFy)) };
}

/**
 * Per-account sums of NON-CASH investing/financing transactions in a period: entries with no cash
 * line whose investing/financing lines net to zero among themselves (e.g. equipment bought with a
 * loan, loan converted to owner's capital). ASC 230 requires these to be disclosed, not shown as cash.
 */
export async function nonCashSums(db, companyId, { from, to }) {
  const { rows } = await db.query(
    `WITH lines AS (
       SELECT l.entry_id, l.account_id, l.debit_cents, l.credit_cents, a.cash_flow
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.company_id = $1 AND l.entry_date BETWEEN $2 AND $3),
     candidates AS (
       SELECT entry_id FROM lines GROUP BY entry_id
       HAVING bool_and(cash_flow IS DISTINCT FROM 'cash')
          AND bool_or(cash_flow IN ('investing','financing'))
          AND sum(CASE WHEN cash_flow IN ('investing','financing') THEN debit_cents - credit_cents ELSE 0 END) = 0)
     SELECT account_id, sum(debit_cents)::bigint AS d, sum(credit_cents)::bigint AS c
       FROM lines WHERE entry_id IN (SELECT entry_id FROM candidates) AND cash_flow IN ('investing','financing')
      GROUP BY account_id`,
    [companyId, from, to],
  );
  return new Map(rows.map((r) => [r.account_id, { debitCents: r.d, creditCents: r.c }]));
}

export async function getIncomeStatement(db, companyId, { from, to }) {
  need(from, 'from'); need(to, 'to');
  if (from > to) throw new LedgerError('"from" must be on or before "to"');
  const accounts = await listAccounts(db, companyId);
  return { from, to, ...incomeStatement(accounts, await accountSums(db, companyId, { from, to })) };
}

export async function getBalanceSheet(db, companyId, { asOf }) {
  need(asOf, 'asOf');
  const company = await getCompany(db, companyId);
  const accounts = await listAccounts(db, companyId);
  const fyStart = fiscalYearStart(asOf, company.fiscal_year_start_month);
  const [sumsAsOf, sumsBeforeFy] = await Promise.all([
    accountSums(db, companyId, { to: asOf }),
    accountSums(db, companyId, { to: dayBefore(fyStart) }),
  ]);
  return { asOf, fiscalYearStart: fyStart, ...balanceSheet(accounts, sumsAsOf, sumsBeforeFy) };
}

export async function getCashFlow(db, companyId, { from, to }) {
  need(from, 'from'); need(to, 'to');
  if (from > to) throw new LedgerError('"from" must be on or before "to"');
  const accounts = await listAccounts(db, companyId);
  const [start, end, nonCash] = await Promise.all([
    accountSums(db, companyId, { to: dayBefore(from) }),
    accountSums(db, companyId, { to }),
    nonCashSums(db, companyId, { from, to }),
  ]);
  return { from, to, ...cashFlowStatement(accounts, start, end, nonCash) };
}

/** Account register: every line on one account with a running balance. */
export async function getAccountRegister(db, companyId, accountId, { from = null, to = null } = {}) {
  if (from) need(from, 'from');
  if (to) need(to, 'to');
  const accounts = await listAccounts(db, companyId);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new LedgerError('Account not found');
  const sign = ['asset', 'expense'].includes(account.type) ? 1 : -1;
  const opening = from ? (await accountSums(db, companyId, { to: dayBefore(from) })).get(accountId) : null;
  let balance = opening ? sign * (opening.debitCents - opening.creditCents) : 0;
  const { rows } = await db.query(
    `SELECT e.entry_number AS "number", l.entry_date AS "date", coalesce(l.memo, e.memo) AS memo,
            l.debit_cents AS "debitCents", l.credit_cents AS "creditCents"
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.company_id = $1 AND l.account_id = $2
        AND ($3::date IS NULL OR l.entry_date >= $3) AND ($4::date IS NULL OR l.entry_date <= $4)
      ORDER BY l.entry_date, e.entry_number, l.id`,
    [companyId, accountId, from, to],
  );
  const openingBalanceCents = balance;
  const lines = rows.map((r) => {
    balance += sign * (r.debitCents - r.creditCents);
    return { ...r, balanceCents: balance };
  });
  return { account, openingBalanceCents, lines, endingBalanceCents: balance };
}

/** Dashboard numbers for the friendly home screen. */
export async function getDashboard(db, companyId, { asOf }) {
  need(asOf, 'asOf');
  const company = await getCompany(db, companyId);
  const fyStart = fiscalYearStart(asOf, company.fiscal_year_start_month);
  const [bs, is] = await Promise.all([
    getBalanceSheet(db, companyId, { asOf }),
    getIncomeStatement(db, companyId, { from: fyStart, to: asOf }),
  ]);
  const accounts = await listAccounts(db, companyId);
  const cashIds = new Set(accounts.filter((a) => a.cashFlow === 'cash').map((a) => a.id));
  const cashCents = bs.assets.lines.filter((l) => cashIds.has(l.accountId)).reduce((t, l) => t + l.amountCents, 0);
  return {
    asOf, fiscalYearStart: fyStart, cashCents,
    revenueYtdCents: is.revenue.totalCents + is.otherIncome.totalCents,
    expensesYtdCents: is.cogs.totalCents + is.operatingExpenses.totalCents + is.otherExpenses.totalCents,
    netIncomeYtdCents: is.netIncomeCents,
    booksBalanced: bs.balanced,
  };
}
