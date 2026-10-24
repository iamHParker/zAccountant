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
export function federalIncomeTax({ taxableWagesCents, periods, w4, fed }) {
  if (w4?.exempt) return 0;
  if (w4?.formYear && w4.formYear < 2020) throw new PayrollError('Pre-2020 Form W-4 not supported yet; employee must submit a 2020+ W-4');
  const status = w4?.filingStatus ?? 'single';
  const key = status === 'married' ? 'married' : status === 'head' ? 'head' : 'single';
  const annualWages = taxableWagesCents * periods;                              // 1c
  const plusOther = annualWages + toCents(w4?.otherIncome ?? 0);                 // 1e
  const line1g = w4?.step2 ? 0 : dollars(key === 'married' ? fed.w4Line1g.married : fed.w4Line1g.other);
  const adjusted = Math.max(0, plusOther - toCents(w4?.deductions ?? 0) - line1g); // 1i
  // Pub 15-T tables start where the standard deduction (net of line 1g) is used up.
  // Step 2 checked: brackets and standard deduction are halved.
  const scale = w4?.step2 ? 0.5 : 1;
  const zeroBand = w4?.step2
    ? Math.round(dollars(fed.standardDeduction[key]) / 2)
    : dollars(fed.standardDeduction[key]) - line1g;
  const annualTax = bracketTax(adjusted - zeroBand, fed.brackets[key], scale);
  let tax = perPeriod(annualTax, periods);                                       // 2h
  tax = Math.max(0, tax - perPeriod(toCents(w4?.dependentsCredit ?? 0), periods)); // step 3
  return tax + toCents(w4?.extraWithholding ?? 0);                               // step 4(c)
}

// ---------------------------------------------------------------- State income tax
function caIncomeTax({ taxableWagesCents, periods, el, ca }) {
  if (el?.exempt) return 0;
  const status = el?.filingStatus ?? 'single';
  const allowances = el?.allowances ?? 0;
  const extra = el?.additionalAllowances ?? 0;
  const tierKey = status === 'head' ? 'head' : status === 'married' ? (allowances >= 2 ? 'married_2plus' : 'married_0_1') : 'single';
  const annual = taxableWagesCents * periods;
  if (annual <= dollars(ca.lowIncomeExemption[tierKey])) return toCents(el?.extraWithholding ?? 0);
  const taxable = Math.max(0, annual - dollars(ca.estimatedDeductionPerAllowance) * extra - dollars(ca.standardDeduction[tierKey]));
  const bracketKey = status === 'head' ? 'head' : status === 'married' ? 'married' : 'single';
  const gross = bracketTax(taxable, ca.brackets[bracketKey]);
  const credit = toCents(ca.exemptionCreditPerAllowance) * allowances;
  return perPeriod(Math.max(0, gross - credit), periods) + toCents(el?.extraWithholding ?? 0);
}

function coIncomeTax({ taxableWagesCents, periods, el, co, filingStatus }) {
  if (el?.exempt) return 0;
  let allowance = el?.annualAllowance;
  if (allowance == null) allowance = co.defaultAllowance[filingStatus === 'married' ? 'married' : filingStatus === 'head' ? 'head' : 'single'];
  if (allowance == null) {
    throw new PayrollError('Colorado: employee needs a DR 0004 allowance (or the default allowance table must be entered by the Review Board)');
  }
  const taxable = Math.max(0, taxableWagesCents * periods - toCents(allowance));
  return perPeriod(applyRate(taxable, pct(co.ratePct)), periods) + toCents(el?.extraWithholding ?? 0);
}

function dcIncomeTax({ taxableWagesCents, periods, el, dc, fed }) {
  if (el?.exempt) return 0;
  const status = el?.filingStatus ?? 'single';
  const key = status === 'married' ? 'married' : status === 'head' ? 'head' : 'single';
  const allowances = el?.allowances ?? 0;
  if (allowances > 0 && dc.allowanceValue == null) {
    throw new PayrollError('DC: D-4 allowance value has not been entered/verified by the Review Board');
  }
  const stdDed = dc.standardDeduction === 'federal' ? fed.standardDeduction[key] : dc.standardDeduction[key];
  const taxable = Math.max(0, taxableWagesCents * periods - dollars(stdDed) - dollars(dc.allowanceValue ?? 0) * allowances);
  return perPeriod(bracketTax(taxable, dc.brackets), periods) + toCents(el?.extraWithholding ?? 0);
}

// ---------------------------------------------------------------- Main entry point
/**
 * @param {object} p
 * @param {number} p.year                tax year (selects tables)
 * @param {string} p.payFrequency        weekly | biweekly | semimonthly | monthly
 * @param {number} p.grossCents          gross pay this check
 * @param {Array}  [p.preTaxDeductions]  [{ name, amountCents, kind: 'retirement_401k' | 'section125' }]
 * @param {object} p.employee            { workState, w4:{filingStatus, step2, dependentsCredit, otherIncome, deductions, extraWithholding, exempt}, stateElections:{...} }
 * @param {object} [p.ytd]               { grossCents, ficaWagesCents, medicareWagesCents, futaWagesCents, suiWagesCents, stateInsWagesCents }
 * @param {object} [p.company]           { suiRatePct, employeeCount }
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
  add(employeeTaxes, 'FIT', 'Federal income tax', federalIncomeTax({ taxableWagesCents: incomeTaxWages, periods, w4: p.employee.w4, fed }), 'fit_payable', incomeTaxWages);

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

  // State unemployment (employer)
  const suiRatePct = company.suiRatePct ?? st.unemployment.defaultRatePct;
  if (company.suiRatePct == null) warnings.push(`Using ${state} new-employer unemployment rate ${suiRatePct}%; enter your assigned rate`);
  const suiTaxable = underCap(ficaWages, ytd.suiWagesCents, dollars(st.unemployment.wageBase));
  add(employerTaxes, `${state}_SUI`, `${state} unemployment`, applyRate(suiTaxable, pct(suiRatePct)), 'suta_payable', suiTaxable);
  if (st.unemployment.adminAssessmentPct) {
    add(employerTaxes, `${state}_SUI_ADMIN`, `${state} UI administrative assessment`, applyRate(suiTaxable, pct(st.unemployment.adminAssessmentPct)), 'suta_payable', suiTaxable);
  }

  // State-specific
  const el = p.employee.stateElections?.[state];
  if (state === 'CA') {
    add(employeeTaxes, 'CA_PIT', 'California income tax', caIncomeTax({ taxableWagesCents: incomeTaxWages, periods, el, ca: st.incomeTax }), 'state_wh_payable', incomeTaxWages);
    const sdiTaxable = underCap(ficaWages, ytd.stateInsWagesCents, st.sdi.wageBase == null ? null : dollars(st.sdi.wageBase));
    add(employeeTaxes, 'CA_SDI', 'California SDI', applyRate(sdiTaxable, pct(st.sdi.ratePct)), 'state_ins_payable', sdiTaxable);
    const ettTaxable = underCap(ficaWages, ytd.suiWagesCents, dollars(st.ett.wageBase));
    add(employerTaxes, 'CA_ETT', 'California ETT', applyRate(ettTaxable, pct(st.ett.ratePct)), 'suta_payable', ettTaxable);
  } else if (state === 'CO') {
    add(employeeTaxes, 'CO_PIT', 'Colorado income tax', coIncomeTax({ taxableWagesCents: incomeTaxWages, periods, el, co: st.incomeTax, filingStatus: p.employee.w4?.filingStatus }), 'state_wh_payable', incomeTaxWages);
    const f = st.famli;
    const cap = f.wageBase === 'socialSecurity' ? dollars(fed.socialSecurity.wageBase) : dollars(f.wageBase);
    const famliTaxable = underCap(ficaWages, ytd.stateInsWagesCents, cap);
    const total = applyRate(famliTaxable, pct(f.totalRatePct));
    const eeShare = Number(divRoundHalfUp(BigInt(total) * BigInt(pct(f.employeeSharePct)), 1_000_000n));
    add(employeeTaxes, 'CO_FAMLI', 'Colorado FAMLI (employee)', eeShare, 'state_ins_payable', famliTaxable);
    const smallEmployer = company.employeeCount != null && company.employeeCount < f.smallEmployerThreshold;
    if (!smallEmployer) add(employerTaxes, 'CO_FAMLI_ER', 'Colorado FAMLI (employer)', total - eeShare, 'state_ins_payable', famliTaxable);
  } else if (state === 'DC') {
    add(employeeTaxes, 'DC_PIT', 'DC income tax', dcIncomeTax({ taxableWagesCents: incomeTaxWages, periods, el, dc: st.incomeTax, fed }), 'state_wh_payable', incomeTaxWages);
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
