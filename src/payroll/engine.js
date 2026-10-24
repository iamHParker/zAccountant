// Payroll gross-to-net engine (pure functions; no database).
//
// Given one paycheck's gross pay, the employee's withholding elections, and year-to-date wages,
// compute every employee-withheld tax, every employer tax, and net pay — all in integer cents.
//
// Method notes for reviewers:
//  * Federal income tax: IRS Pub 15-T, Worksheet 1A (percentage method, annual tables) for
//    2020-or-later Forms W-4. Pre-2020 W-4s are not supported yet (engine throws).
//  * Annual tax is computed exactly, divided by pay periods, rounded half-up to the cent.
//  * Wage-base limits (Social Security, FUTA, SUI, FAMLI, ETT) use year-to-date wages, so the
//    paycheck that crosses a limit is taxed only on the part below it.

import { readFileSync } from 'node:fs';
import { applyRate, percentToPpm, divRoundHalfUp, toCents } from '../core/money.js';

export const PAY_PERIODS = Object.freeze({ weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 });
export const SUPPORTED_STATES = Object.freeze(['TX', 'CO', 'CA', 'DC']);

export class PayrollError extends Error {
  constructor(message) { super(message); this.name = 'PayrollError'; }
}

const tableCache = new Map();
export function loadTables(year) {
  if (!tableCache.has(year)) {
    let raw;
    try {
      raw = readFileSync(new URL(`./tables/${year}.json`, import.meta.url), 'utf8');
    } catch {
      throw new PayrollError(`No payroll tax tables installed for ${year}`);
    }
    tableCache.set(year, Object.freeze(JSON.parse(raw)));
  }
  return tableCache.get(year);
}

const dollars = (d) => Math.round(d * 100); // table dollar amounts are whole dollars -> cents
const pct = (p) => percentToPpm(p);

/** Progressive tax on an annual amount (cents) using [[floorDollars, ratePct], ...] brackets. Exact, rounded once. */
export function bracketTax(annualCents, brackets, scale = 1) {
  if (annualCents <= 0) return 0;
  let numerator = 0n; // cents × ppm
  for (let i = 0; i < brackets.length; i++) {
    const lo = dollars(brackets[i][0] * scale);
    const hi = i + 1 < brackets.length ? dollars(brackets[i + 1][0] * scale) : Infinity;
    if (annualCents <= lo) break;
    const width = Math.min(annualCents, hi) - lo;
    numerator += BigInt(width) * BigInt(pct(brackets[i][1]));
  }
  return Number(divRoundHalfUp(numerator, 1_000_000n));
}

const perPeriod = (annualCents, periods) => Number(divRoundHalfUp(BigInt(annualCents), BigInt(periods)));

/** Taxable amount this paycheck under a wage-base cap, given wages already taxed this year. */
export function underCap(currentCents, ytdCents, capCents) {
  if (capCents == null) return currentCents;
  return Math.max(0, Math.min(currentCents, capCents - ytdCents));
}

// ---------------------------------------------------------------- Federal income tax (Pub 15-T 1A)
/** Annual Percentage Method table lookup, exactly as Pub 15-T prints it: tentative + rate × (wage − over). */
export function percentageTableTax(adjustedCents, rows) {
  if (adjustedCents <= 0) return 0;
  let row = rows[0];
  for (const r of rows) if (adjustedCents >= dollars(r[0])) row = r;
  const excess = BigInt(adjustedCents - dollars(row[0]));
  return toCents(row[1]) + Number(divRoundHalfUp(excess * BigInt(pct(row[2])), 1_000_000n));
}

export function federalIncomeTax({ taxableWagesCents, periods, w4, fed }) {
  if (w4?.exempt) return 0;
  const status = w4?.filingStatus ?? 'single';
  const tables = fed.percentageMethodTables;
  const annualWages = taxableWagesCents * periods;                               // 1c
  let adjusted;
  let table;
  if (w4?.formYear && w4.formYear < 2020) {
    // Form W-4 from 2019 or earlier: lines 1j-1l. Single or Married only.
    const allowances = w4.allowances ?? 0;
    if (!Number.isInteger(allowances) || allowances < 0) throw new PayrollError('W-4 allowances must be a whole number');
    adjusted = Math.max(0, annualWages - dollars(fed.pre2020W4.allowanceValue) * allowances);
    table = tables.standard[status === 'married' ? 'married' : 'single'];
  } else {
    const key = status === 'married' ? 'married' : status === 'head' ? 'head' : 'single';
    const plusOther = annualWages + toCents(w4?.otherIncome ?? 0);              // 1e
    const line1g = w4?.step2 ? 0 : dollars(key === 'married' ? fed.w4Line1g.married : fed.w4Line1g.other);
    adjusted = Math.max(0, plusOther - toCents(w4?.deductions ?? 0) - line1g);  // 1i
    table = (w4?.step2 ? tables.step2Checkbox : tables.standard)[key];
  }
  const annualTax = percentageTableTax(adjusted, table);
  let tax = perPeriod(annualTax, periods);                                       // 2h
  tax = Math.max(0, tax - perPeriod(toCents(w4?.dependentsCredit ?? 0), periods)); // step 3
  return tax + toCents(w4?.extraWithholding ?? 0);                               // step 4(c)
}

// ---------------------------------------------------------------- State income tax
const caKeys = (el) => {
  const status = el?.filingStatus ?? 'single';
  const allowances = el?.allowances ?? 0;
  if (!Number.isInteger(allowances) || allowances < 0) throw new PayrollError('California: DE 4 allowances must be a whole number');
  const extra = el?.additionalAllowances ?? 0;
  if (!Number.isInteger(extra) || extra < 0) throw new PayrollError('California: additional allowances must be a whole number');
  return {
    allowances, extra,
    tierKey: status === 'head' ? 'head' : status === 'married' ? (allowances >= 2 ? 'married_2plus' : 'married_0_1') : 'single',
    bracketKey: status === 'head' ? 'head' : status === 'married' ? 'married' : 'single',
  };
};

/**
 * California DE 44 Method B with the per-period tables (Examples A-D): low-income test on this
 * check's wages, minus estimated-deduction and standard-deduction amounts for the period, tax from
 * the period's rate table ("plus" + rate × excess, rounded to the cent), minus the exemption credit.
 */
export function caIncomeTaxPerPeriod({ taxableWagesCents, el, t }) {
  if (el?.exempt) return 0;
  const { allowances, extra, tierKey, bracketKey } = caKeys(el);
  if (taxableWagesCents <= dollars(t.lowIncomeExemption[tierKey])) return toCents(el?.extraWithholding ?? 0);
  // Tables 2 and 4 list 1-10 allowances; above 10, the one-allowance amount times the number.
  const byCount = (list, n, toC) => (n === 0 ? 0 : n <= list.length ? toC(list[n - 1]) : toC(list[0]) * n);
  const taxable = Math.max(0, taxableWagesCents - byCount(t.estimatedDeduction, extra, dollars) - dollars(t.standardDeduction[tierKey]));
  const rows = t.brackets[bracketKey];
  let row = rows[0];
  for (const r of rows) if (taxable > dollars(r[0])) row = r;
  const excess = BigInt(Math.max(0, taxable - dollars(row[0])));
  const gross = toCents(row[2]) + Number(divRoundHalfUp(excess * BigInt(pct(row[1])), 1_000_000n));
  const credit = byCount(t.exemptionCredit, allowances, toCents);
  return Math.max(0, gross - credit) + toCents(el?.extraWithholding ?? 0);
}

/** California Method B by annualizing (Examples E-F); used for pay periods without DE 44 tables. */
export function caIncomeTaxAnnualized({ taxableWagesCents, periods, el, ca }) {
  if (el?.exempt) return 0;
  const { allowances, extra, tierKey, bracketKey } = caKeys(el);
  const annual = taxableWagesCents * periods;
  if (annual <= dollars(ca.lowIncomeExemption[tierKey])) return toCents(el?.extraWithholding ?? 0);
  const taxable = Math.max(0, annual - dollars(ca.estimatedDeductionPerAllowance) * extra - dollars(ca.standardDeduction[tierKey]));
  const gross = bracketTax(taxable, ca.brackets[bracketKey]);
  const credit = toCents(ca.exemptionCreditPerAllowance) * allowances;
  return perPeriod(Math.max(0, gross - credit), periods) + toCents(el?.extraWithholding ?? 0);
}

function caIncomeTax({ taxableWagesCents, periods, payFrequency, el, ca }) {
  const t = ca.perPeriod?.[payFrequency];
  return t ? caIncomeTaxPerPeriod({ taxableWagesCents, el, t }) : caIncomeTaxAnnualized({ taxableWagesCents, periods, el, ca });
}

/**
 * A W-4 (or DE 4) claiming exempt is good for one calendar year: unless a new one is given by
 * February 15 of the next year, withholding resumes as Single with no adjustments (federal: Pub 15;
 * California: DE 4, "Single with zero allowances"). `exemptYear` is the year the exempt form covers.
 * Returns { elections, warning } with the elections to use for this pay date.
 */
export function applyExemptExpiry(elections, payDate, form, lapsed) {
  if (!elections?.exempt) return { elections, warning: null };
  if (elections.exemptYear == null || !payDate) {
    return { elections, warning: `${form} claims exempt: record the year it covers so it lapses after February 15 of the next year` };
  }
  const y = Number(elections.exemptYear);
  if (!Number.isInteger(y)) throw new PayrollError(`${form}: exempt year must be a year like 2026`);
  if (payDate > `${y + 1}-02-15`) {
    return { elections: lapsed, warning: `${form} exempt claim for ${y} lapsed on ${y + 1}-02-15; withholding as Single with no adjustments until a new form is given` };
  }
  return { elections, warning: null };
}

function coIncomeTax({ taxableWagesCents, periods, el, co, filingStatus, federalExempt }) {
  // DR 1098: an employee exempt from federal withholding on the W-4 is exempt from Colorado withholding too.
  if (el?.exempt || federalExempt) return 0;
  let allowance = el?.annualAllowance;
  if (allowance == null) allowance = co.defaultAllowance[filingStatus === 'married' ? 'married' : filingStatus === 'head' ? 'head' : 'single'];
  if (allowance == null) {
    throw new PayrollError('Colorado: employee needs a DR 0004 allowance (or the default allowance table must be entered by the Review Board)');
  }
  const taxable = Math.max(0, taxableWagesCents * periods - toCents(allowance));
  return perPeriod(applyRate(taxable, pct(co.ratePct)), periods) + toCents(el?.extraWithholding ?? 0);
}

// DC Code §47-1812.08(b)(1A): no standard deduction in withholding; subtract D-4 allowances only.
function dcIncomeTax({ taxableWagesCents, periods, el, dc }) {
  if (el?.exempt) return 0;
  const allowances = el?.allowances ?? 0;
  if (!Number.isInteger(allowances) || allowances < 0) throw new PayrollError('DC: D-4 allowances must be a whole number');
  const taxable = Math.max(0, taxableWagesCents * periods - dollars(dc.allowanceValue) * allowances);
  return perPeriod(bracketTax(taxable, dc.brackets), periods) + toCents(el?.extraWithholding ?? 0);
}

// ---------------------------------------------------------------- Main entry point
/**
 * @param {object} p
 * @param {number} p.year                tax year (selects tables)
 * @param {string} p.payFrequency        weekly | biweekly | semimonthly | monthly
 * @param {string} [p.payDate]           YYYY-MM-DD (exempt W-4 / DE 4 claims lapse after Feb 15 of the next year)
 * @param {number} p.grossCents          gross pay this check
 * @param {Array}  [p.preTaxDeductions]  [{ name, amountCents, kind: 'retirement_401k' | 'section125' }]
 * @param {object} p.employee            { workState, w4:{filingStatus, step2, dependentsCredit, otherIncome, deductions, extraWithholding, exempt}, stateElections:{...} }
 * @param {object} [p.ytd]               { grossCents, ficaWagesCents, medicareWagesCents, futaWagesCents, suiWagesCents, stateInsWagesCents }
 * @param {object} [p.company]           { suiRatePct, famliHeadcount, futaCreditReductionPct: { CA: '1.5' } }
 */
export function calculatePaycheck(p) {
  const tables = loadTables(p.year);
  const fed = tables.federal;
  const periods = PAY_PERIODS[p.payFrequency];
  if (!periods) throw new PayrollError(`Unknown pay frequency: ${p.payFrequency}`);
  const state = p.employee?.workState;
  if (!SUPPORTED_STATES.includes(state)) throw new PayrollError(`Work state ${state} is not supported (TX, CO, CA, DC)`);
  const st = tables.states[state];
  const gross = p.grossCents;
  if (!Number.isSafeInteger(gross) || gross < 0) throw new PayrollError('grossCents must be a non-negative integer');
  const ytd = { grossCents: 0, ficaWagesCents: 0, medicareWagesCents: 0, futaWagesCents: 0, suiWagesCents: 0, stateInsWagesCents: 0, ...p.ytd };
  const company = p.company ?? {};
  const warnings = [];
  // Expired "exempt" claims (federal W-4; California DE 4). Colorado follows the federal W-4.
  const fedEx = applyExemptExpiry(p.employee?.w4, p.payDate, 'Form W-4', { filingStatus: 'single' });
  if (fedEx.warning) warnings.push(fedEx.warning);
  const w4 = fedEx.elections;
  let stateElections = p.employee?.stateElections;
  if (state === 'CA' && stateElections?.CA) {
    const caEx = applyExemptExpiry(stateElections.CA, p.payDate, 'DE 4', { filingStatus: 'single', allowances: 0 });
    if (caEx.warning) warnings.push(caEx.warning);
    stateElections = { ...stateElections, CA: caEx.elections };
  }

  // Pre-tax deductions
  const deductions = (p.preTaxDeductions ?? []).map((d) => ({ ...d }));
  let fitExcl = 0, ficaExcl = 0;
  for (const d of deductions) {
    if (!Number.isSafeInteger(d.amountCents) || d.amountCents < 0) throw new PayrollError(`Deduction ${d.name}: invalid amount`);
    if (d.kind === 'retirement_401k') fitExcl += d.amountCents;
    else if (d.kind === 'section125') { fitExcl += d.amountCents; ficaExcl += d.amountCents; }
    else throw new PayrollError(`Unknown deduction kind ${d.kind}`);
  }
  const totalDeductions = deductions.reduce((t, d) => t + d.amountCents, 0);
  if (totalDeductions > gross) throw new PayrollError('Pre-tax deductions exceed gross pay');
  const incomeTaxWages = gross - fitExcl;     // federal & state income tax wages
  const ficaWages = gross - ficaExcl;         // FICA, FUTA, SUI, SDI/FAMLI wages

  const employeeTaxes = [];
  const employerTaxes = [];
  const add = (list, code, label, amountCents, liabilityKey, taxableCents) => {
    if (amountCents !== 0) list.push({ code, label, amountCents, liabilityKey, taxableCents });
  };

  // Federal income tax
  add(employeeTaxes, 'FIT', 'Federal income tax', federalIncomeTax({ taxableWagesCents: incomeTaxWages, periods, w4, fed }), 'fit_payable', incomeTaxWages);

  // Social Security & Medicare
  const ssTaxable = underCap(ficaWages, ytd.ficaWagesCents, dollars(fed.socialSecurity.wageBase));
  const ssRate = pct(fed.socialSecurity.ratePct);
  add(employeeTaxes, 'SS', 'Social Security', applyRate(ssTaxable, ssRate), 'fica_payable', ssTaxable);
  add(employerTaxes, 'SS_ER', 'Social Security (employer)', applyRate(ssTaxable, ssRate), 'fica_payable', ssTaxable);
  const medRate = pct(fed.medicare.ratePct);
  add(employeeTaxes, 'MED', 'Medicare', applyRate(ficaWages, medRate), 'fica_payable', ficaWages);
  add(employerTaxes, 'MED_ER', 'Medicare (employer)', applyRate(ficaWages, medRate), 'fica_payable', ficaWages);
  const addlThreshold = dollars(fed.medicare.additionalThreshold);
  const addlTaxable = Math.max(0, ytd.medicareWagesCents + ficaWages - Math.max(addlThreshold, ytd.medicareWagesCents));
  add(employeeTaxes, 'MED_ADDL', 'Additional Medicare', applyRate(addlTaxable, pct(fed.medicare.additionalRatePct)), 'fica_payable', addlTaxable);

  // FUTA (employer)
  const futaTaxable = underCap(ficaWages, ytd.futaWagesCents, dollars(fed.futa.wageBase));
  add(employerTaxes, 'FUTA', 'Federal unemployment (FUTA)', applyRate(futaTaxable, pct(fed.futa.ratePct)), 'futa_payable', futaTaxable);
  // FUTA credit reduction: in a state that owes the federal government for UI loans, part of the 5.4%
  // credit is taken back on Form 940 Schedule A. Accruing it per paycheck (announced rate, or the
  // employer's estimate) avoids a surprise at year end.
  const crPct = company.futaCreditReductionPct?.[state] ?? fed.futa.creditReductionPct?.[state] ?? null;
  if (crPct != null && crPct !== '' && pct(crPct) > 0) {
    add(employerTaxes, 'FUTA_CR', `FUTA credit reduction (${state} ${crPct}%)`, applyRate(futaTaxable, pct(crPct)), 'futa_payable', futaTaxable);
  }

  // State unemployment (employer)
  const suiRatePct = company.suiRatePct ?? st.unemployment.defaultRatePct;
  if (company.suiRatePct == null) warnings.push(`Using ${state} new-employer unemployment rate ${suiRatePct}%; enter your assigned rate`);
  const suiTaxable = underCap(ficaWages, ytd.suiWagesCents, dollars(st.unemployment.wageBase));
  add(employerTaxes, `${state}_SUI`, `${state} unemployment`, applyRate(suiTaxable, pct(suiRatePct)), 'suta_payable', suiTaxable);
  if (st.unemployment.adminAssessmentPct) {
    add(employerTaxes, `${state}_SUI_ADMIN`, `${state} UI administrative assessment`, applyRate(suiTaxable, pct(st.unemployment.adminAssessmentPct)), 'suta_payable', suiTaxable);
  }

  // State-specific
  const el = stateElections?.[state];
  if (state === 'CA') {
    add(employeeTaxes, 'CA_PIT', 'California income tax', caIncomeTax({ taxableWagesCents: incomeTaxWages, periods, payFrequency: p.payFrequency, el, ca: st.incomeTax }), 'state_wh_payable', incomeTaxWages);
    const sdiTaxable = underCap(ficaWages, ytd.stateInsWagesCents, st.sdi.wageBase == null ? null : dollars(st.sdi.wageBase));
    add(employeeTaxes, 'CA_SDI', 'California SDI', applyRate(sdiTaxable, pct(st.sdi.ratePct)), 'state_ins_payable', sdiTaxable);
    const ettTaxable = underCap(ficaWages, ytd.suiWagesCents, dollars(st.ett.wageBase));
    add(employerTaxes, 'CA_ETT', 'California ETT', applyRate(ettTaxable, pct(st.ett.ratePct)), 'suta_payable', ettTaxable);
  } else if (state === 'CO') {
    add(employeeTaxes, 'CO_PIT', 'Colorado income tax', coIncomeTax({ taxableWagesCents: incomeTaxWages, periods, el, co: st.incomeTax, filingStatus: w4?.filingStatus, federalExempt: Boolean(w4?.exempt) }), 'state_wh_payable', incomeTaxWages);
    const f = st.famli;
    const cap = f.wageBase === 'socialSecurity' ? dollars(fed.socialSecurity.wageBase) : dollars(f.wageBase);
    const famliTaxable = underCap(ficaWages, ytd.stateInsWagesCents, cap);
    const total = applyRate(famliTaxable, pct(f.totalRatePct));
    const eeShare = Number(divRoundHalfUp(BigInt(total) * BigInt(pct(f.employeeSharePct)), 1_000_000n));
    add(employeeTaxes, 'CO_FAMLI', 'Colorado FAMLI (employee)', eeShare, 'state_ins_payable', famliTaxable);
    // FAMLI: employers with fewer than 10 employees (nationwide, counted per FAMLI's annual rule) pay no
    // employer share. company.famliHeadcount is entered by the employer; if unknown we charge the share.
    const smallEmployer = company.famliHeadcount != null && company.famliHeadcount < f.smallEmployerThreshold;
    if (!smallEmployer) add(employerTaxes, 'CO_FAMLI_ER', 'Colorado FAMLI (employer)', total - eeShare, 'state_ins_payable', famliTaxable);
  } else if (state === 'DC') {
    add(employeeTaxes, 'DC_PIT', 'DC income tax', dcIncomeTax({ taxableWagesCents: incomeTaxWages, periods, el, dc: st.incomeTax }), 'state_wh_payable', incomeTaxWages);
    add(employerTaxes, 'DC_PFL', 'DC Paid Family Leave', applyRate(ficaWages, pct(st.paidFamilyLeave.employerRatePct)), 'state_ins_payable', ficaWages);
  }
  // TX: no state income tax, no employee state taxes.

  const employeeTaxTotal = employeeTaxes.reduce((t, x) => t + x.amountCents, 0);
  const employerTaxTotal = employerTaxes.reduce((t, x) => t + x.amountCents, 0);
  const netPayCents = gross - totalDeductions - employeeTaxTotal;
  if (netPayCents < 0) throw new PayrollError('Withholding exceeds pay; reduce extra withholding');

  const verified = Boolean(fed.verified && st.verified);
  if (!verified) warnings.push(`${p.year} tax tables for federal/${state} are not yet certified by the Professional Review Board (calculate-only)`);

  return {
    year: p.year, state, payFrequency: p.payFrequency, periods,
    grossCents: gross,
    deductions, totalDeductionsCents: totalDeductions,
    wages: { incomeTaxCents: incomeTaxWages, ficaCents: ficaWages },
    employeeTaxes, employeeTaxTotalCents: employeeTaxTotal,
    employerTaxes, employerTaxTotalCents: employerTaxTotal,
    netPayCents,
    tablesVerified: verified,
    warnings,
    ytdAfter: {
      grossCents: ytd.grossCents + gross,
      ficaWagesCents: ytd.ficaWagesCents + ficaWages,
      medicareWagesCents: ytd.medicareWagesCents + ficaWages,
      futaWagesCents: ytd.futaWagesCents + ficaWages,
      suiWagesCents: ytd.suiWagesCents + ficaWages,
      stateInsWagesCents: ytd.stateInsWagesCents + ficaWages,
    },
  };
}

/**
 * Journal entry lines for a paycheck (by account key; the service maps keys to account ids).
 * Dr Wages expense (gross) + Dr Payroll tax expense (employer taxes)
 * Cr each liability (withholdings, employer taxes, deductions) + Cr Net pay payable.
 * Balanced by construction: gross = deductions + employee taxes + net.
 */
export function paycheckJournalLines(result) {
  const credits = new Map();
  const credit = (key, c) => credits.set(key, (credits.get(key) ?? 0) + c);
  for (const t of result.employeeTaxes) credit(t.liabilityKey, t.amountCents);
  for (const t of result.employerTaxes) credit(t.liabilityKey, t.amountCents);
  if (result.totalDeductionsCents) credit('deductions_payable', result.totalDeductionsCents);
  credit('net_pay_payable', result.netPayCents);
  const lines = [{ accountKey: 'wages_expense', debitCents: result.grossCents, creditCents: 0 }];
  if (result.employerTaxTotalCents) lines.push({ accountKey: 'payroll_tax_expense', debitCents: result.employerTaxTotalCents, creditCents: 0 });
  for (const [key, c] of credits) if (c) lines.push({ accountKey: key, debitCents: 0, creditCents: c });
  return lines;
}
