// Payroll engine tests. Each expected value is worked by hand in the comment beside it
// so a reviewer can check the arithmetic without reading the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePaycheck, paycheckJournalLines, bracketTax, PayrollError, loadTables, caIncomeTaxAnnualized } from '../src/payroll/engine.js';

const tax = (r, code) => [...r.employeeTaxes, ...r.employerTaxes].find((t) => t.code === code)?.amountCents ?? 0;
const run = (o) => calculatePaycheck({ year: 2026, ytd: {}, company: {}, ...o });

test('bracketTax is exact and rounds once', () => {
  assert.equal(bracketTax(1_000_000, [[0, '10'], [5000, '20']]), 150_000); // $10,000: 500 + 1,000
  assert.equal(bracketTax(0, [[0, '10']]), 0);
  assert.equal(bracketTax(-5, [[0, '10']]), 0);
});

test('TX single biweekly $2,000', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 200_000, employee: { workState: 'TX', w4: { filingStatus: 'single' } } });
  // FIT: (2,000×26 − 16,100 std) = 35,900 → 10%×12,400 + 12%×23,500 = 4,060 /26 = 156.15
  assert.equal(tax(r, 'FIT'), 15_615);
  assert.equal(tax(r, 'SS'), 12_400);     // 6.2%
  assert.equal(tax(r, 'MED'), 2_900);     // 1.45%
  assert.equal(r.netPayCents, 200_000 - 15_615 - 12_400 - 2_900);
  assert.equal(tax(r, 'SS_ER'), 12_400);
  assert.equal(tax(r, 'FUTA'), 1_200);    // 0.6%
  assert.equal(tax(r, 'TX_SUI'), 5_400);  // 2.7% default new-employer rate
  assert.ok(r.warnings.some((w) => /new-employer/.test(w)));
  assert.equal(r.tablesVerified, false);
});

test('W-4 step 3 credit and step 4(c) extra withholding', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 200_000,
    employee: { workState: 'TX', w4: { filingStatus: 'single', dependentsCredit: '2000', extraWithholding: '25' } } });
  // 156.15 − 2,000/26 (76.92) + 25.00 = 104.23
  assert.equal(tax(r, 'FIT'), 10_423);
});

test('Married, W-4 step 2 checked, monthly $10,000', () => {
  const r = run({ payFrequency: 'monthly', grossCents: 1_000_000, employee: { workState: 'TX', w4: { filingStatus: 'married', step2: true } } });
  // 120,000 − 16,100 (half of 32,200) = 103,900 on half-width brackets:
  // 10%×12,400 + 12%×38,000 + 22%×53,500 = 1,240 + 4,560 + 11,770 = 17,570 /12 = 1,464.17
  assert.equal(tax(r, 'FIT'), 146_417);
});

test('Head of household weekly $900', () => {
  const r = run({ payFrequency: 'weekly', grossCents: 90_000, employee: { workState: 'TX', w4: { filingStatus: 'head' } } });
  // 46,800 − 24,150 = 22,650 → 10%×17,700 + 12%×4,950 = 1,770 + 594 = 2,364 /52 = 45.46
  assert.equal(tax(r, 'FIT'), 4_546);
});

test('low wages: no federal withholding below the standard deduction', () => {
  const r = run({ payFrequency: 'monthly', grossCents: 100_000, employee: { workState: 'TX', w4: { filingStatus: 'single' } } });
  assert.equal(tax(r, 'FIT'), 0);
});

test('Social Security wage base and Additional Medicare cross mid-paycheck', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 100_000, employee: { workState: 'TX', w4: {} },
    ytd: { ficaWagesCents: 18_400_000, medicareWagesCents: 19_950_000, futaWagesCents: 700_000, suiWagesCents: 900_000 } });
  assert.equal(tax(r, 'SS'), 3_100);       // only $500 left under $184,500 → 31.00
  assert.equal(tax(r, 'SS_ER'), 3_100);
  assert.equal(tax(r, 'MED'), 1_450);
  assert.equal(tax(r, 'MED_ADDL'), 450);   // 0.9% × $500 over $200,000
  assert.equal(tax(r, 'FUTA'), 0);
  assert.equal(tax(r, 'TX_SUI'), 0);
});

test('FUTA stops at $7,000', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 200_000, employee: { workState: 'TX', w4: {} }, ytd: { futaWagesCents: 650_000 } });
  assert.equal(tax(r, 'FUTA'), 300);       // 0.6% × $500
});

test('401(k) lowers income-tax wages but not FICA', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 200_000, employee: { workState: 'TX', w4: { filingStatus: 'single' } },
    preTaxDeductions: [{ name: '401(k)', amountCents: 20_000, kind: 'retirement_401k' }] });
  // (1,800×26 − 16,100) = 30,700 → 1,240 + 12%×18,300 = 3,436 /26 = 132.15
  assert.equal(tax(r, 'FIT'), 13_215);
  assert.equal(tax(r, 'SS'), 12_400);
  assert.equal(r.netPayCents, 200_000 - 20_000 - 13_215 - 12_400 - 2_900);
});

test('Section 125 lowers both income-tax and FICA wages', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 200_000, employee: { workState: 'TX', w4: {} },
    preTaxDeductions: [{ name: 'Health premium', amountCents: 10_000, kind: 'section125' }] });
  assert.equal(tax(r, 'SS'), 11_780);      // 6.2% × 1,900
});

test('California single, 1 allowance, biweekly $3,000 (DE 44 Method B)', () => {
  const r = run({ payFrequency: 'biweekly', grossCents: 300_000, company: { suiRatePct: '3.4' },
    employee: { workState: 'CA', w4: { filingStatus: 'single' }, stateElections: { CA: { filingStatus: 'single', allowances: 1 } } } });
  // Biweekly tables: 3,000 − 219 std = 2,781 → over 2,214 at 8.8%: 567 × 8.8% = 49.90 + 84.16 = 134.06
  // − 6.47 credit (1 allowance) = 127.59. (Annualizing gives 127.54: the two Method B ways differ by cents.)
  assert.equal(tax(r, 'CA_PIT'), 12_759);
  assert.equal(tax(r, 'CA_SDI'), 3_900);   // 1.3%, no wage cap
  assert.equal(tax(r, 'CA_ETT'), 300);     // 0.1%
  assert.equal(tax(r, 'CA_SUI'), 10_200);  // 3.4%
});

test('California low-income exemption', () => {
  const r = run({ payFrequency: 'monthly', grossCents: 150_000,
    employee: { workState: 'CA', w4: {}, stateElections: { CA: { filingStatus: 'single', allowances: 1 } } } });
  assert.equal(tax(r, 'CA_PIT'), 0);       // $18,000/yr ≤ $18,896
});

test('Colorado flat tax with DR 0004 allowance, FAMLI split', () => {
  const emp = (allow) => ({ workState: 'CO', w4: { filingStatus: 'single' }, stateElections: { CO: { annualAllowance: allow } } });
  const r = run({ payFrequency: 'monthly', grossCents: 500_000, employee: emp('0') });
  assert.equal(tax(r, 'CO_PIT'), 22_000);     // 60,000 × 4.4% /12 = 220.00
  assert.equal(tax(r, 'CO_FAMLI'), 2_200);    // 0.88% × 5,000 = 44.00, half each
  assert.equal(tax(r, 'CO_FAMLI_ER'), 2_200);
  const r2 = run({ payFrequency: 'monthly', grossCents: 500_000, employee: emp('15000') });
  assert.equal(tax(r2, 'CO_PIT'), 16_500);    // (60,000 − 15,000) × 4.4% /12 = 165.00
  const small = run({ payFrequency: 'monthly', grossCents: 500_000, employee: emp('0'), company: { famliHeadcount: 4 } });
  assert.equal(tax(small, 'CO_FAMLI_ER'), 0); // under 10 employees: no employer share
  const unknown = run({ payFrequency: 'monthly', grossCents: 500_000, employee: emp('0'), company: {} });
  assert.equal(tax(unknown, 'CO_FAMLI_ER'), 2_200); // headcount unknown: charge the employer share
  // No DR 0004: DR 1098 line 2a default $5,500 (single): (60,000 − 5,500) × 4.4% /12 = 199.83
  assert.equal(tax(run({ payFrequency: 'monthly', grossCents: 500_000, employee: { workState: 'CO', w4: { filingStatus: 'single' } } }), 'CO_PIT'), 19_983);
  // Married filing jointly default $11,000: (60,000 − 11,000) × 4.4% /12 = 179.67
  assert.equal(tax(run({ payFrequency: 'monthly', grossCents: 500_000, employee: { workState: 'CO', w4: { filingStatus: 'married' } } }), 'CO_PIT'), 17_967);
  // Federally exempt W-4 → exempt from Colorado withholding too
  assert.equal(tax(run({ payFrequency: 'monthly', grossCents: 500_000, employee: { workState: 'CO', w4: { exempt: true } } }), 'CO_PIT'), 0);
});

// DE 44 Method B worked examples (26methb.pdf). A-D use the per-period tables, as the engine does for
// weekly/biweekly/semimonthly/monthly payrolls; E-F show the annualized way, used for other periods.
const ca = (payFrequency, grossCents, CA) => tax(run({ payFrequency, grossCents, employee: { workState: 'CA', w4: {}, stateElections: { CA } } }), 'CA_PIT');
test('California DE 44 Examples A-D (per-period tables)', () => {
  assert.equal(ca('weekly', 21_000, { filingStatus: 'single', allowances: 1 }), 0);   // A: under the $363 low-income line
  // B: 1,600 − 38 est. deduction − 439 std = 1,123 → 2.2% × 271 = 5.96 + 9.37 = 15.33 − 2 × 6.47 = 2.38
  assert.equal(ca('biweekly', 160_000, { filingStatus: 'married', allowances: 2, additionalAllowances: 1 }), 238);
  // C: 5,100 − 951 = 4,149 → 2.2% × 2,301 = 50.62 + 20.33 = 70.95 − 5 × 14.03 = 0.82
  assert.equal(ca('monthly', 510_000, { filingStatus: 'married', allowances: 5 }), 82);
  // D: 950 − 219 = 731 → 2.2% × 305 = 6.71 + 4.69 = 11.40 − 3 × 3.24 = 1.69
  assert.equal(ca('weekly', 95_000, { filingStatus: 'head', allowances: 3 }), 169);
});

test('California DE 44 Examples E-F (annualized) and the per-period result for the same pay', () => {
  const t = loadTables(2026).states.CA.incomeTax;
  // E: 57,600 − 11,412 = 46,188 → 243.74 + 528.66 = 772.40 − 673.20 = 99.20 / 24 = 4.13
  assert.equal(caIncomeTaxAnnualized({ taxableWagesCents: 240_000, periods: 24, el: { filingStatus: 'married', allowances: 4 }, ca: t }), 413);
  // F: 57,000 − 11,412 = 45,588 → 243.74 + 515.46 = 759.20 − 673.20 = 86.00 / 12 = 7.17
  assert.equal(caIncomeTaxAnnualized({ taxableWagesCents: 475_000, periods: 12, el: { filingStatus: 'married', allowances: 4 }, ca: t }), 717);
  // Same pay as E with the semimonthly tables: 2,400 − 476 = 1,924 → 22.00 + 10.16 = 32.16 − 28.05 (Table 4, 4 allowances) = 4.11.
  // Both are official Method B; the 2¢ difference is the rounding of the per-period tables.
  assert.equal(ca('semimonthly', 240_000, { filingStatus: 'married', allowances: 4 }), 411);
});

test('California per-period tables were transcribed correctly (every "plus" re-derived)', () => {
  const pp = loadTables(2026).states.CA.incomeTax.perPeriod;
  for (const period of ['weekly', 'biweekly', 'semimonthly', 'monthly']) {
    for (const [status, rows] of Object.entries(pp[period].brackets)) {
      let plus = 0;
      rows.forEach((r, i) => {
        if (i > 0) plus += Math.round((r[0] - rows[i - 1][0]) * Number(rows[i - 1][1])); // dollars × % = cents
        assert.equal(Math.round(Number(r[2]) * 100), plus, `${period} ${status} row ${i}`);
      });
    }
  }
});

test('California Tables 2 and 4 match the annual amounts × allowances ÷ periods', () => {
  const ca = loadTables(2026).states.CA.incomeTax;
  const periods = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
  for (const [p, n] of Object.entries(periods)) {
    const t = ca.perPeriod[p];
    t.exemptionCredit.forEach((v, i) => assert.equal(Math.round(Number(v) * 100), Math.round(16830 * (i + 1) / n), `${p} credit ${i + 1}`));
    t.estimatedDeduction.forEach((v, i) => assert.equal(v, Math.round(1000 * (i + 1) / n), `${p} deduction ${i + 1}`));
  }
  assert.equal(ca.exemptionCreditPerAllowance, '168.30');
});

test('California: more than 10 allowances use the one-allowance amount × the number (DE 44: 15 weekly = $48.60)', () => {
  const big = { filingStatus: 'married', allowances: 15 };
  // 3,000 weekly married: − 219 = 2,781 → over 2,214 at 8.8%: 567 × 8.8% = 49.90 + 84.16 = 134.06 − 48.60 = 85.46
  assert.equal(ca('weekly', 300_000, big), 8_546);
});

test('an exempt W-4 / DE 4 lapses after February 15 of the next year', () => {
  const emp = (w4, CA) => ({ workState: 'CA', w4, stateElections: { CA } });
  const before = run({ payFrequency: 'biweekly', grossCents: 300_000, payDate: '2027-02-12',
    employee: emp({ exempt: true, exemptYear: 2026 }, { exempt: true, exemptYear: 2026 }) });
  assert.equal(tax(before, 'FIT'), 0);
  assert.equal(tax(before, 'CA_PIT'), 0);
  const after = run({ payFrequency: 'biweekly', grossCents: 300_000, payDate: '2027-02-16',
    employee: emp({ exempt: true, exemptYear: 2026, filingStatus: 'married' }, { exempt: true, exemptYear: 2026, filingStatus: 'married', allowances: 3 }) });
  const single = run({ payFrequency: 'biweekly', grossCents: 300_000, payDate: '2027-02-16', employee: emp({ filingStatus: 'single' }, { filingStatus: 'single', allowances: 0 }) });
  assert.ok(tax(after, 'FIT') > 0);
  assert.equal(tax(after, 'FIT'), tax(single, 'FIT'), 'federal: Single, no adjustments');
  assert.equal(tax(after, 'CA_PIT'), tax(single, 'CA_PIT'), 'California: Single, zero allowances');
  assert.ok(after.warnings.some((w) => /W-4 exempt claim for 2026 lapsed/.test(w)));
  // Colorado follows the federal W-4, so its exemption lapses too.
  const co = run({ payFrequency: 'monthly', grossCents: 500_000, payDate: '2027-03-01', employee: { workState: 'CO', w4: { exempt: true, exemptYear: 2026 } } });
  assert.equal(tax(co, 'CO_PIT'), 19_983);
  const noYear = run({ payFrequency: 'monthly', grossCents: 500_000, payDate: '2026-03-01', employee: { workState: 'TX', w4: { exempt: true } } });
  assert.equal(tax(noYear, 'FIT'), 0);
  assert.ok(noYear.warnings.some((w) => /record the year/.test(w)));
});

test('FUTA credit reduction accrues per paycheck when a rate is entered', () => {
  const r = run({ payFrequency: 'monthly', grossCents: 500_000, company: { futaCreditReductionPct: { CA: '1.2' } },
    employee: { workState: 'CA', w4: {}, stateElections: { CA: {} } } });
  assert.equal(tax(r, 'FUTA'), 3_000);      // 0.6% × 5,000
  assert.equal(tax(r, 'FUTA_CR'), 6_000);   // 1.2% × 5,000 (under the $7,000 base)
  const later = run({ payFrequency: 'monthly', grossCents: 500_000, ytd: { futaWagesCents: 500_000 }, company: { futaCreditReductionPct: { CA: '1.2' } },
    employee: { workState: 'CA', w4: {}, stateElections: { CA: {} } } });
  assert.equal(tax(later, 'FUTA_CR'), 2_400); // only $2,000 left under the base
  const tx = run({ payFrequency: 'monthly', grossCents: 500_000, company: { futaCreditReductionPct: { CA: '1.2' } }, employee: { workState: 'TX', w4: {} } });
  assert.equal(tax(tx, 'FUTA_CR'), 0);       // rate is for California wages only
});

test('DC single semimonthly $4,000', () => {
  const r = run({ payFrequency: 'semimonthly', grossCents: 400_000,
    employee: { workState: 'DC', w4: { filingStatus: 'single' }, stateElections: { DC: { filingStatus: 'single', allowances: 0 } } } });
  // No standard deduction in DC withholding: 96,000 → 400 + 1,800 + 1,300 + 8.5%×36,000 (3,060) = 6,560 /24 = 273.33
  assert.equal(tax(r, 'DC_PIT'), 27_333);
  const two = run({ payFrequency: 'semimonthly', grossCents: 400_000,
    employee: { workState: 'DC', w4: {}, stateElections: { DC: { allowances: 2 } } } });
  // 96,000 − 2×4,150 = 87,700 → 3,500 + 8.5%×27,700 (2,354.50) = 5,854.50 /24 = 243.94 (243.9375 rounds up)
  assert.equal(tax(two, 'DC_PIT'), 24_394);
  assert.equal(tax(r, 'DC_PFL'), 3_000);      // 0.75% employer-only
  assert.equal(tax(r, 'DC_SUI'), 10_800);     // 2.7%
  assert.equal(tax(r, 'DC_SUI_ADMIN'), 800);  // 0.2%
});

test('paycheck journal entry always balances', () => {
  const cases = [
    { payFrequency: 'biweekly', grossCents: 200_000, employee: { workState: 'TX', w4: {} }, preTaxDeductions: [{ name: '401k', amountCents: 12_345, kind: 'retirement_401k' }] },
    { payFrequency: 'weekly', grossCents: 123_457, employee: { workState: 'CA', w4: {}, stateElections: { CA: { allowances: 2, filingStatus: 'married' } } } },
    { payFrequency: 'monthly', grossCents: 987_654, employee: { workState: 'CO', w4: {}, stateElections: { CO: { annualAllowance: '0' } } } },
    { payFrequency: 'semimonthly', grossCents: 31_415_926, employee: { workState: 'DC', w4: { filingStatus: 'married' } } },
  ];
  for (const c of cases) {
    const r = run(c);
    const lines = paycheckJournalLines(r);
    const d = lines.reduce((t, l) => t + l.debitCents, 0);
    const cr = lines.reduce((t, l) => t + l.creditCents, 0);
    assert.equal(d, cr, `${c.employee.workState}`);
    assert.equal(d, r.grossCents + r.employerTaxTotalCents);
  }
});

test('input validation', () => {
  assert.throws(() => run({ payFrequency: 'daily', grossCents: 1, employee: { workState: 'TX' } }), PayrollError);
  assert.throws(() => run({ payFrequency: 'weekly', grossCents: 1, employee: { workState: 'NY' } }), PayrollError);
  assert.throws(() => run({ payFrequency: 'weekly', grossCents: 1.5, employee: { workState: 'TX' } }), PayrollError);
  assert.throws(() => calculatePaycheck({ year: 1999, payFrequency: 'weekly', grossCents: 1, employee: { workState: 'TX' } }), /No payroll tax tables/);
  assert.throws(() => run({ payFrequency: 'weekly', grossCents: 100, employee: { workState: 'TX', w4: {} }, preTaxDeductions: [{ name: 'x', amountCents: 200, kind: 'section125' }] }), /exceed/);
});

test('official Pub 15-T STANDARD table agrees with the 2026 brackets (data cross-check)', async () => {
  const { loadTables, percentageTableTax } = await import('../src/payroll/engine.js');
  const fed = loadTables(2026).federal;
  for (const key of ['single', 'married', 'head']) {
    const zero = (fed.standardDeduction[key] - (key === 'married' ? fed.w4Line1g.married : fed.w4Line1g.other)) * 100;
    for (let w = 0; w <= 1_000_000_00; w += 123_457) {
      assert.equal(percentageTableTax(w, fed.percentageMethodTables.standard[key]), bracketTax(w - zero, fed.brackets[key]), `${key} ${w}`);
    }
  }
});

test('W-4 Step 2 uses the official table (whole-dollar row edges)', () => {
  // Single, step 2, annual $120,000 (monthly $10,000): row 108,938 → 20,512.00 + 32% × 11,062 = 24,051.84 /12 = 2,004.32
  const r = run({ payFrequency: 'monthly', grossCents: 1_000_000, employee: { workState: 'TX', w4: { filingStatus: 'single', step2: true } } });
  assert.equal(tax(r, 'FIT'), 200_432);
});

test('Form W-4 from 2019 or earlier (lines 1j-1l)', () => {
  // Single, 2 allowances, monthly $5,000: 60,000 − 8,600 = 51,400 → 1,240 + 12% × 31,500 = 5,020 /12 = 418.33
  const r = run({ payFrequency: 'monthly', grossCents: 500_000, employee: { workState: 'TX', w4: { formYear: 2019, filingStatus: 'single', allowances: 2 } } });
  assert.equal(tax(r, 'FIT'), 41_833);
  // Head of household is not available on old forms → single table
  const h = run({ payFrequency: 'monthly', grossCents: 500_000, employee: { workState: 'TX', w4: { formYear: 2019, filingStatus: 'head', allowances: 2 } } });
  assert.equal(tax(h, 'FIT'), 41_833);
});
