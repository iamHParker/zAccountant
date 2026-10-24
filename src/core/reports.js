// Financial statements as pure functions.
//
// Inputs are the chart of accounts and per-account totals ("sums"):
//   sums: Map<accountId, { debitCents, creditCents }>
// The database layer (services/reportService.js) produces sums for a date or date range;
// these functions only do the accounting. Every statement carries a `check` that proves it
// ties out (e.g. Assets − Liabilities − Equity = 0). A non-zero check is a Sev-1 bug.

import { naturalBalance } from './ledger.js';

const ZERO = Object.freeze({ debitCents: 0, creditCents: 0 });
const get = (sums, id) => sums.get(id) ?? ZERO;
const byCode = (a, b) => a.code.localeCompare(b.code, 'en', { numeric: true });

function natural(acct, sums) {
  const s = get(sums, acct.id);
  return naturalBalance(acct.type, s.debitCents, s.creditCents);
}

/** Net income (revenue − expenses) from a set of sums. */
export function netIncome(accounts, sums) {
  let ni = 0;
  for (const a of accounts) {
    if (a.type === 'revenue') ni += natural(a, sums);
    else if (a.type === 'expense') ni -= natural(a, sums);
  }
  return ni;
}

export function trialBalance(accounts, sums) {
  const rows = [];
  let totalDebits = 0;
  let totalCredits = 0;
  for (const a of [...accounts].sort(byCode)) {
    const s = get(sums, a.id);
    const net = s.debitCents - s.creditCents;
    if (net === 0 && s.debitCents === 0) continue;
    const row = { accountId: a.id, code: a.code, name: a.name, type: a.type, debitCents: 0, creditCents: 0 };
    if (net >= 0) row.debitCents = net; else row.creditCents = -net;
    totalDebits += row.debitCents;
    totalCredits += row.creditCents;
    rows.push(row);
  }
  return { rows, totalDebits, totalCredits, check: totalDebits - totalCredits, balanced: totalDebits === totalCredits };
}

function section(accounts, sums, filter) {
  const lines = accounts
    .filter(filter)
    .sort(byCode)
    .map((a) => ({ accountId: a.id, code: a.code, name: a.name, amountCents: natural(a, sums) }))
    .filter((l) => l.amountCents !== 0);
  return { lines, totalCents: lines.reduce((t, l) => t + l.amountCents, 0) };
}

/** Income Statement (Profit & Loss) for the period the sums cover. */
export function incomeStatement(accounts, periodSums) {
  const revenue = section(accounts, periodSums, (a) => a.type === 'revenue' && a.subtype !== 'other');
  const cogs = section(accounts, periodSums, (a) => a.type === 'expense' && a.subtype === 'cogs');
  const operatingExpenses = section(accounts, periodSums, (a) => a.type === 'expense' && a.subtype !== 'cogs' && a.subtype !== 'other');
  const otherIncome = section(accounts, periodSums, (a) => a.type === 'revenue' && a.subtype === 'other');
  const otherExpenses = section(accounts, periodSums, (a) => a.type === 'expense' && a.subtype === 'other');
  const grossProfitCents = revenue.totalCents - cogs.totalCents;
  const operatingIncomeCents = grossProfitCents - operatingExpenses.totalCents;
  const netIncomeCents = operatingIncomeCents + otherIncome.totalCents - otherExpenses.totalCents;
  return {
    revenue, cogs, grossProfitCents, operatingExpenses, operatingIncomeCents, otherIncome, otherExpenses, netIncomeCents,
    check: netIncomeCents - netIncome(accounts, periodSums),
  };
}

/**
 * Balance Sheet as of a date.
 *   sumsAsOf:        cumulative sums from the beginning of time through the as-of date
 *   sumsBeforeFy:    cumulative sums through the day before the current fiscal year started
 * No closing entries are needed: prior years' profit is shown in Retained Earnings and
 * this year's profit as "Net Income (current year)".
 */
export function balanceSheet(accounts, sumsAsOf, sumsBeforeFy) {
  const incomeAccounts = accounts.filter((a) => a.type === 'revenue' || a.type === 'expense');
  const lifetimeNi = netIncome(incomeAccounts, sumsAsOf);
  const priorYearsNi = netIncome(incomeAccounts, sumsBeforeFy);
  const currentYearNi = lifetimeNi - priorYearsNi;

  const assets = section(accounts, sumsAsOf, (a) => a.type === 'asset');
  const liabilities = section(accounts, sumsAsOf, (a) => a.type === 'liability');
  const equity = section(accounts, sumsAsOf, (a) => a.type === 'equity');

  const re = accounts.find((a) => a.subtype === 'retained_earnings');
  if (priorYearsNi !== 0) {
    const existing = re && equity.lines.find((l) => l.accountId === re.id);
    if (existing) existing.amountCents += priorYearsNi;
    else equity.lines.push({ accountId: re?.id ?? null, code: re?.code ?? '', name: 'Retained Earnings', amountCents: priorYearsNi });
  }
  if (currentYearNi !== 0) {
    equity.lines.push({ accountId: null, code: '', name: 'Net Income (current year)', amountCents: currentYearNi });
  }
  equity.totalCents += priorYearsNi + currentYearNi;
  const liabilitiesAndEquityCents = liabilities.totalCents + equity.totalCents;
  return {
    assets, liabilities, equity,
    totalAssetsCents: assets.totalCents,
    liabilitiesAndEquityCents,
    check: assets.totalCents - liabilitiesAndEquityCents,
    balanced: assets.totalCents === liabilitiesAndEquityCents,
  };
}

/**
 * Statement of Cash Flows, indirect method, for a period.
 *   sumsStart: cumulative sums through the day BEFORE the period starts
 *   sumsEnd:   cumulative sums through the last day of the period
 * Every non-cash balance-sheet account is assigned (via account.cashFlow) to operating,
 * investing or financing, so the statement always reconciles to the change in cash.
 */
export function cashFlowStatement(accounts, sumsStart, sumsEnd) {
  const delta = new Map();
  for (const a of accounts) {
    const s0 = get(sumsStart, a.id);
    const s1 = get(sumsEnd, a.id);
    delta.set(a.id, { debitCents: s1.debitCents - s0.debitCents, creditCents: s1.creditCents - s0.creditCents });
  }
  const ni = netIncome(accounts, delta);
  const groups = { operating: [], investing: [], financing: [] };
  let cashChange = 0;
  for (const a of [...accounts].sort(byCode)) {
    if (a.type === 'revenue' || a.type === 'expense') continue;
    const d = get(delta, a.id);
    const netDebit = d.debitCents - d.creditCents;
    if (a.cashFlow === 'cash') { cashChange += netDebit; continue; }
    if (netDebit === 0) continue;
    // An increase in a non-cash asset uses cash; an increase in a liability/equity provides cash.
    const effect = -netDebit;
    const category = groups[a.cashFlow] ? a.cashFlow : 'operating';
    const verb = a.type === 'asset'
      ? (netDebit > 0 ? 'Increase in' : 'Decrease in')
      : (netDebit < 0 ? 'Increase in' : 'Decrease in');
    groups[category].push({ accountId: a.id, code: a.code, name: `${verb} ${a.name}`, amountCents: effect });
  }
  const total = (lines) => lines.reduce((t, l) => t + l.amountCents, 0);
  const operatingCents = ni + total(groups.operating);
  const investingCents = total(groups.investing);
  const financingCents = total(groups.financing);
  const netChangeCents = operatingCents + investingCents + financingCents;
  let beginningCashCents = 0;
  for (const a of accounts) if (a.cashFlow === 'cash') {
    const s = get(sumsStart, a.id);
    beginningCashCents += s.debitCents - s.creditCents;
  }
  return {
    netIncomeCents: ni,
    operating: { adjustments: groups.operating, totalCents: operatingCents },
    investing: { lines: groups.investing, totalCents: investingCents },
    financing: { lines: groups.financing, totalCents: financingCents },
    netChangeCents,
    beginningCashCents,
    endingCashCents: beginningCashCents + cashChange,
    check: netChangeCents - cashChange,
    balanced: netChangeCents === cashChange,
  };
}
