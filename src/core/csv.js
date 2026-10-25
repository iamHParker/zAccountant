// Reports as CSV files that open cleanly in Excel. Pure functions, no database.
// Amounts are plain decimals ("-1234.56") so a spreadsheet can add them up; text cells that would
// start a formula (=, +, -, @) get a leading apostrophe so a contact named "=HYPERLINK(...)" stays text.
import { centsToDecimal } from './money.js';

/** An amount cell (cents → "1234.56"); never formula-escaped. */
export const amt = (cents) => ({ n: cents == null ? '' : centsToDecimal(cents) });

export function csvCell(v) {
  if (v == null) return '';
  let s = typeof v === 'object' && 'n' in v ? v.n : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows (arrays of cells) → CSV text, CRLF line ends, with a byte-order mark so Excel reads UTF-8. */
export function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** A safe file name: "Acme Co - Balance Sheet 2026-12-31.csv". */
export function csvFileName(company, title, period) {
  return `${company} - ${title} ${period}`.replace(/[^\w .,()&-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) + '.csv';
}

const periodText = (d) => (d.asOf ? `As of ${d.asOf}` : `${d.from} to ${d.to}`);
const cmpText = (c) => (c.asOf ? c.asOf : `${c.from} to ${c.to}`);

/** Financial statement → rows. `kind`: balance-sheet, income-statement, cash-flow, trial-balance. */
export function statementRows(kind, d, { company, title }) {
  const cmp = d.comparison ?? null;
  const rows = [[company], [title], [periodText(d)], []];
  if (kind === 'trial-balance') {
    rows.push(['Account number', 'Account', 'Debit', 'Credit']);
    for (const r of d.rows) rows.push([r.code, r.name, r.debitCents ? amt(r.debitCents) : '', r.creditCents ? amt(r.creditCents) : '']);
    rows.push(['', 'Total', amt(d.totalDebits), amt(d.totalCredits)]);
    return rows;
  }
  rows.push(cmp ? ['Account number', 'Account', periodText(d).replace(/^As of /, ''), cmpText(cmp), 'Change', 'Change %'] : ['Account number', 'Account', 'Amount']);
  const tail = (x) => (cmp ? [amt(x.priorCents), amt(x.changeCents), x.changePct ?? ''] : []);
  const head = (label) => rows.push(['', label]);
  const lines = (sec, sign = 1) => {
    for (const l of sec.lines) rows.push([l.code ?? '', l.name, amt(sign * l.amountCents), ...(cmp ? [amt(sign * l.priorCents), amt(sign * l.changeCents), l.changePct ?? ''] : [])]);
  };
  const secTotal = (label, sec) => rows.push(['', label, amt(sec.totalCents), ...(cmp ? [amt(sec.totalPriorCents), amt(sec.totalChangeCents), sec.totalChangePct ?? ''] : [])]);
  const total = (label, key) => rows.push(['', label, amt(d[key]), ...(cmp ? tail(cmp.totals[key]) : [])]);

  if (kind === 'balance-sheet') {
    head('Assets'); lines(d.assets); secTotal('Total assets', d.assets);
    head('Liabilities'); lines(d.liabilities); secTotal('Total liabilities', d.liabilities);
    head('Equity'); lines(d.equity); secTotal('Total equity', d.equity);
    total('Total liabilities and equity', 'liabilitiesAndEquityCents');
  } else if (kind === 'income-statement') {
    head('Income'); lines(d.revenue); secTotal('Total income', d.revenue);
    if (d.cogs.lines.length) { head('Cost of goods sold'); lines(d.cogs); secTotal('Total cost of goods sold', d.cogs); total('Gross profit', 'grossProfitCents'); }
    head('Expenses'); lines(d.operatingExpenses); secTotal('Total expenses', d.operatingExpenses);
    total('Operating income', 'operatingIncomeCents');
    if (d.otherIncome.lines.length) { head('Other income'); lines(d.otherIncome); secTotal('Total other income', d.otherIncome); }
    if (d.otherExpenses.lines.length) { head('Other expenses'); lines(d.otherExpenses); secTotal('Total other expenses', d.otherExpenses); }
    total('Net income', 'netIncomeCents');
  } else if (kind === 'cash-flow') {
    head('Operating activities');
    rows.push(['', 'Net income', amt(d.netIncomeCents)]);
    for (const l of d.operating.adjustments) rows.push([l.code ?? '', l.name, amt(l.amountCents)]);
    rows.push(['', 'Net cash from operating activities', amt(d.operating.totalCents)]);
    head('Investing activities'); lines(d.investing); rows.push(['', 'Net cash from investing activities', amt(d.investing.totalCents)]);
    head('Financing activities'); lines(d.financing); rows.push(['', 'Net cash from financing activities', amt(d.financing.totalCents)]);
    rows.push(['', 'Net change in cash', amt(d.netChangeCents)]);
    rows.push(['', 'Cash at beginning of period', amt(d.beginningCashCents)]);
    rows.push(['', 'Cash at end of period', amt(d.endingCashCents)]);
    if (d.nonCashActivities.length) {
      head('Non-cash investing and financing activities (disclosure)');
      for (const l of d.nonCashActivities) rows.push([l.code ?? '', l.name, amt(l.debitCents - l.creditCents)]);
    }
  } else throw new RangeError(`no CSV layout for ${kind}`);
  return rows;
}

/** A/R or A/P aging → rows: one per customer/vendor, then each open invoice/bill under it. */
export function agingRows(d, { company, title }) {
  const rows = [[company], [title], [`As of ${d.asOf}`], []];
  rows.push(['Name', 'Number', 'Date', 'Due', 'Days past due', ...d.buckets.map((b) => b.label), 'Total']);
  for (const r of d.rows) {
    rows.push([r.name, '', '', '', '', ...d.buckets.map((b) => amt(r[b.id])), amt(r.totalCents)]);
    for (const doc of r.documents) {
      rows.push(['', doc.number, doc.date, doc.dueDate, doc.daysPastDue, ...d.buckets.map((b) => (b.id === doc.bucket ? amt(doc.balanceCents) : '')), amt(doc.balanceCents)]);
    }
  }
  rows.push(['Total', '', '', '', '', ...d.buckets.map((b) => amt(d.totals[b.id])), amt(d.totals.totalCents)]);
  if (d.groups?.length) {
    rows.push([], ['Totals by group (Part of)']);
    for (const g of d.groups) rows.push([g.name, '', '', '', '', ...d.buckets.map((b) => amt(g[b.id])), amt(g.totalCents)]);
  }
  return rows;
}

/** Payroll register → rows: one per paycheck, a column per tax and deduction, then totals. */
export function payrollRegisterRows(d, { company, title }) {
  const rows = [[company], [title], [`Pay dates ${d.from} to ${d.to}`], []];
  const col = (c) => c.label;
  rows.push(['Pay date', 'Employee', 'Period', 'Hours', 'Gross pay', ...d.deductionColumns.map(col), ...d.employeeTaxColumns.map(col), 'Net pay',
    ...d.employerTaxColumns.map((c) => `${c.label} (employer)`), 'Note']);
  const cells = (r) => [amt(r.grossCents), ...d.deductionColumns.map((c) => amt(r.deductions[c.key] ?? 0)), ...d.employeeTaxColumns.map((c) => amt(r.employeeTaxes[c.key] ?? 0)),
    amt(r.netPayCents), ...d.employerTaxColumns.map((c) => amt(r.employerTaxes[c.key] ?? 0))];
  for (const r of d.rows) rows.push([r.payDate, r.employee, r.periodStart ? `${r.periodStart} to ${r.periodEnd}` : '', r.hours ?? '', ...cells(r), r.note ?? '']);
  rows.push(['Total', '', '', d.totals.hours ?? '', ...cells(d.totals), '']);
  return rows;
}

/** Tax summary → rows: each line of the return with its total, the accounts under it, then items reported elsewhere. */
export function taxSummaryRows(d, { company, title }) {
  const rows = [[company], [title], [`${d.from} to ${d.to}`], [d.formName ?? d.message ?? ''], []];
  if (!d.form) return rows;
  rows.push(['Line', 'Description', 'Account', 'Amount', 'Category', 'Suggested?']);
  for (const g of d.lines) {
    rows.push([g.line, g.title, '', amt(g.cents), '', '']);
    for (const a of g.accounts) rows.push(['', '', `${a.code} ${a.name}`, amt(a.cents), a.category, a.suggested ? 'suggested' : '']);
  }
  if (d.elsewhere.length) {
    rows.push([], ['Reported elsewhere']);
    for (const g of d.elsewhere) for (const a of g.accounts) rows.push(['', g.note, `${a.code} ${a.name}`, amt(a.cents), a.category, a.suggested ? 'suggested' : '']);
  }
  rows.push([], ['', 'Ordinary business income (before items reported elsewhere)', '', amt(d.ordinaryIncomeCents)]);
  return rows;
}

/** 1099-NEC totals → rows: one per vendor marked for a 1099. */
export function nec1099Rows(d, { company, title }) {
  const rows = [[company], [title], [`Payments made in ${d.year}`], [`Threshold ${centsToDecimal(d.thresholdCents)}`], []];
  rows.push(['Vendor', 'Paid (cash, check, ACH)', 'Paid by card (on 1099-K instead)', 'Form needed?', 'Address on file?']);
  for (const v of d.vendors) rows.push([v.name, amt(v.paidCents), amt(v.byCardCents), v.needsForm ? 'yes' : 'no', v.hasAddress ? 'yes' : 'no']);
  rows.push(['Total on forms needed', amt(d.totalCents)]);
  return rows;
}

/** W-2 / W-3 totals → rows: one per employee, then the W-3 totals. */
export function w2Rows(d, { company, title }) {
  const rows = [[company], [title], [`Pay dates in ${d.year}`], []];
  const states = [...new Set(d.employees.flatMap((e) => Object.keys(e.state)))].sort();
  rows.push(['Employee', 'Box 1 Wages', 'Box 2 Federal tax withheld', 'Box 3 Social Security wages', 'Box 4 Social Security tax',
    'Box 5 Medicare wages', 'Box 6 Medicare tax', 'Box 12 D (401k)', ...states.flatMap((s) => [`Box 16 ${s} wages`, `Box 17 ${s} tax`])]);
  const cells = (e) => [amt(e.box1), amt(e.box2), amt(e.box3), amt(e.box4), amt(e.box5), amt(e.box6), amt(e.box12D),
    ...states.flatMap((s) => [amt(e.state[s]?.box16 ?? 0), amt(e.state[s]?.box17 ?? 0)])];
  for (const e of d.employees) rows.push([e.employee, ...cells(e)]);
  rows.push([`W-3 total (${d.w3.forms} forms)`, ...cells(d.w3)]);
  return rows;
}
