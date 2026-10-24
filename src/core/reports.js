// Financial statements as pure functions.
//
// Inputs are the chart of accounts and per-account totals ("sums"):
//   sums: Map<accountId, { debitCents, creditCents }>
// The database layer (services/reportService.js) produces sums for a date or date range;
// these functions only do the accounting. Every statement carries a `check` that proves it
// ties out (e.g. Assets − Liabilities − Equity = 0). A non-zero check is a Sev-1 bug.

import { naturalBalance } from './ledger.js';
import { divRoundHalfUp } from './money.js';

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
  const isOther = (a) => a.subtype === 'other' || a.subtype === 'asset_disposal';
  const revenue = section(accounts, periodSums, (a) => a.type === 'revenue' && !isOther(a));
  const cogs = section(accounts, periodSums, (a) => a.type === 'expense' && a.subtype === 'cogs');
  const operatingExpenses = section(accounts, periodSums, (a) => a.type === 'expense' && a.subtype !== 'cogs' && !isOther(a));
  const otherIncome = section(accounts, periodSums, (a) => a.type === 'revenue' && isOther(a));
  const otherExpenses = section(accounts, periodSums, (a) => a.type === 'expense' && isOther(a));
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
 * Statement of Cash Flows, indirect method (ASC 230), for a period.
 *   sumsStart:    cumulative sums through the day BEFORE the period starts
 *   sumsEnd:      cumulative sums through the last day of the period
 *   nonCashSums:  (optional) per-account sums of NON-CASH investing/financing transactions in the period
 *                 (e.g. equipment bought with a loan). They are left out of the cash flows and
 *                 listed as a supplemental disclosure instead.
 * Every non-cash balance-sheet account is assigned (via account.cashFlow) to operating,
 * investing or financing, so the statement always reconciles to the change in cash.
 * Fixed-asset disposals: accumulated-depreciation debits and gains/losses on disposal are moved
 * from operating to investing so investing shows the actual sale proceeds.
 */
export function cashFlowStatement(accounts, sumsStart, sumsEnd, nonCashSums = new Map()) {
  const delta = new Map();
  for (const a of accounts) {
    const s0 = get(sumsStart, a.id);
    const s1 = get(sumsEnd, a.id);
    const nc = get(nonCashSums, a.id);
    delta.set(a.id, {
      debitCents: s1.debitCents - s0.debitCents - nc.debitCents,
      creditCents: s1.creditCents - s0.creditCents - nc.creditCents,
    });
  }
  // Net income uses the full period (non-cash swaps never touch income accounts).
  const ni = netIncome(accounts, delta);
  const groups = { operating: [], investing: [], financing: [] };
  let cashChange = 0;
  let disposalProceedsAdj = 0; // moved from operating to investing
  for (const a of [...accounts].sort(byCode)) {
    const d = get(delta, a.id);
    if (a.type === 'revenue' || a.type === 'expense') {
      if (a.subtype === 'asset_disposal') {
        // Gain (credit) is not operating cash; back it out of operating and add it to proceeds.
        const gain = d.creditCents - d.debitCents;
        if (gain !== 0) {
          groups.operating.push({ accountId: a.id, code: a.code, name: gain > 0 ? 'Gain on sale of assets' : 'Loss on sale of assets', amountCents: -gain });
          disposalProceedsAdj += gain;
        }
      }
      continue;
    }
    if (a.cashFlow === 'cash') { cashChange += d.debitCents - d.creditCents; continue; }
    if (a.subtype === 'contra' && a.cashFlow === 'operating') {
      // Accumulated depreciation: credits are depreciation (non-cash expense, add back);
      // debits are removals on disposal (part of the investing proceeds calculation).
      if (d.creditCents) groups.operating.push({ accountId: a.id, code: a.code, name: 'Depreciation and amortization', amountCents: d.creditCents });
      if (d.debitCents) disposalProceedsAdj -= d.debitCents;
      continue;
    }
    const netDebit = d.debitCents - d.creditCents;
    if (netDebit === 0) continue;
    // An increase in a non-cash asset uses cash; an increase in a liability/equity provides cash.
    const effect = -netDebit;
    const category = groups[a.cashFlow] ? a.cashFlow : 'operating';
    let name;
    if (category === 'investing' && a.type === 'asset') name = netDebit > 0 ? `Purchase of ${a.name}` : `Disposal of ${a.name} (at cost)`;
    else {
      const verb = a.type === 'asset' ? (netDebit > 0 ? 'Increase in' : 'Decrease in') : (netDebit < 0 ? 'Increase in' : 'Decrease in');
      name = `${verb} ${a.name}`;
    }
    groups[category].push({ accountId: a.id, code: a.code, name, amountCents: effect });
  }
  if (disposalProceedsAdj !== 0) {
    groups.investing.push({ accountId: null, code: '', name: 'Adjustment to sale proceeds (accumulated depreciation and gain/loss)', amountCents: disposalProceedsAdj });
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
  const nonCashActivities = [...accounts].sort(byCode)
    .map((a) => ({ a, s: get(nonCashSums, a.id) }))
    .filter(({ s }) => s.debitCents || s.creditCents)
    .map(({ a, s }) => ({ accountId: a.id, code: a.code, name: a.name, debitCents: s.debitCents, creditCents: s.creditCents }));
  return {
    netIncomeCents: ni,
    operating: { adjustments: groups.operating, totalCents: operatingCents },
    investing: { lines: groups.investing, totalCents: investingCents },
    financing: { lines: groups.financing, totalCents: financingCents },
    netChangeCents,
    beginningCashCents,
    endingCashCents: beginningCashCents + cashChange,
    nonCashActivities,
    check: netChangeCents - cashChange,
    balanced: netChangeCents === cashChange,
  };
}

/**
 * Post-closing view of account sums as of a date: income/expense accounts show only the current
 * fiscal year, and all prior years' profit is rolled into Retained Earnings — so the trial balance
 * agrees line-for-line with the balance sheet. Total debits still equal total credits.
 */
export function postClosingSums(accounts, sumsAsOf, sumsBeforeFy) {
  const out = new Map();
  for (const a of accounts) {
    const s = get(sumsAsOf, a.id);
    if (a.type === 'revenue' || a.type === 'expense') {
      const b = get(sumsBeforeFy, a.id);
      out.set(a.id, { debitCents: s.debitCents - b.debitCents, creditCents: s.creditCents - b.creditCents });
    } else out.set(a.id, { ...s });
  }
  const priorNi = netIncome(accounts.filter((a) => a.type === 'revenue' || a.type === 'expense'), sumsBeforeFy);
  if (priorNi !== 0) {
    const re = accounts.find((a) => a.subtype === 'retained_earnings');
    if (!re) throw new RangeError('Retained earnings account is missing');
    const r = out.get(re.id);
    if (priorNi > 0) r.creditCents += priorNi; else r.debitCents += -priorNi;
  }
  return out;
}

// ---------------------------------------------------------------- Comparative statements

const monthEnd = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const isMonthEnd = (iso) => Number(iso.slice(8, 10)) === monthEnd(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)));

/** Move a date by whole months. A month-end stays a month-end (2026-02-28 − 12 months = 2025-02-28,
 *  2028-02-29 − 12 = 2027-02-28, 2029-02-28 − 12 = 2028-02-29); other days are clamped to the month. */
export function shiftMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = t - ny * 12 + 1;
  const last = monthEnd(ny, nm);
  const nd = isMonthEnd(iso) ? last : Math.min(d, last);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The period to compare a statement with. `compare` is 'prior_year' (the same dates a year earlier)
 * or 'prior_period' (the stretch just before: whole months are compared with the same number of whole
 * months, e.g. Q2 with Q1; any other range with the same number of days just before it). A balance sheet
 * (asOf) compares with one year or one month earlier. Returns { from, to } or { asOf }, or null for none.
 */
export function comparisonPeriod({ from, to, asOf }, compare) {
  if (!compare || compare === 'none') return null;
  if (!['prior_year', 'prior_period'].includes(compare)) throw new RangeError('compare must be prior_year or prior_period');
  if (asOf) return { asOf: shiftMonths(asOf, compare === 'prior_year' ? -12 : -1) };
  if (compare === 'prior_year') return { from: shiftMonths(from, -12), to: shiftMonths(to, -12) };
  if (from.endsWith('-01') && isMonthEnd(to)) {
    const months = (Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7))) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) + 1;
    return { from: shiftMonths(from, -months), to: shiftMonths(to, -months) };
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  return { from: addDaysIso(from, -days), to: addDaysIso(from, -1) };
}

/** Percent change from `prior` to `current` as a string with one decimal ("12.5", "-100.0"), rounded
 *  half away from zero; null when the prior amount is 0 (no meaningful percent). Measured against the
 *  size of the prior amount, so a loss that shrinks shows as an improvement (+). */
export function percentChange(current, prior) {
  if (prior === 0) return null;
  const tenths = divRoundHalfUp(BigInt(current - prior) * 1000n, BigInt(Math.abs(prior)));
  const a = tenths < 0n ? -tenths : tenths;
  return `${tenths < 0n ? '-' : ''}${a / 10n}.${a % 10n}`;
}

const delta = (cur, prior) => ({ priorCents: prior, changeCents: cur - prior, changePct: percentChange(cur, prior) });

/** Line up a section of two statements: every line gets prior/change columns; a line only in the prior
 *  statement is kept (current = 0) so the columns still add to their totals. */
function compareSection(cur, prior) {
  const key = (l) => l.accountId ?? `name:${l.name}`;
  const priorByKey = new Map(prior.lines.map((l) => [key(l), l]));
  const seen = new Set();
  const lines = cur.lines.map((l) => {
    seen.add(key(l));
    return { ...l, ...delta(l.amountCents, priorByKey.get(key(l))?.amountCents ?? 0) };
  });
  for (const l of prior.lines) if (!seen.has(key(l))) lines.push({ ...l, amountCents: 0, ...delta(0, l.amountCents) });
  lines.sort((a, b) => (a.code && b.code ? byCode(a, b) : a.code ? -1 : b.code ? 1 : 0));
  const t = delta(cur.totalCents, prior.totalCents);
  return { lines, totalCents: cur.totalCents, totalPriorCents: t.priorCents, totalChangeCents: t.changeCents, totalChangePct: t.changePct };
}

const SECTIONS = {
  'income-statement': { sections: ['revenue', 'cogs', 'operatingExpenses', 'otherIncome', 'otherExpenses'], totals: ['grossProfitCents', 'operatingIncomeCents', 'netIncomeCents'] },
  'balance-sheet': { sections: ['assets', 'liabilities', 'equity'], totals: ['totalAssetsCents', 'liabilitiesAndEquityCents'] },
};

/**
 * Put a statement side by side with the same statement for an earlier period. Section lines gain
 * priorCents / changeCents / changePct and each section gains totalPriorCents / totalChangeCents /
 * totalChangePct; `comparison.totals[name]` holds the same for subtotals such as net income.
 * The prior statement must tie out too: `comparison.check` is its check (0 = ties out).
 */
export function compareStatements(kind, current, prior, period) {
  const spec = SECTIONS[kind];
  if (!spec) throw new RangeError(`no comparison for ${kind}`);
  const out = { ...current };
  for (const s of spec.sections) out[s] = compareSection(current[s], prior[s]);
  out.comparison = { ...period, check: prior.check, totals: Object.fromEntries(spec.totals.map((t) => [t, delta(current[t], prior[t])])) };
  return out;
}
