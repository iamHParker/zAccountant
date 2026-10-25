// Tax-ready, level 1: which line of the business's federal return each income and expense account feeds.
// ℹ️ Each account is given a CATEGORY ("advertising", "rent of property"…), not a line number. Each return
// then says where that category goes. That way, changing the type of business (sole proprietor → S corp)
// keeps the work done, and a category that has no line on a return says where it goes instead.
//
// This is a summary for the owner's tax preparer, not a return: no forms are printed or filed (Homer,
// 2026-10-24: a CPA partner does real preparation through an accountant's role).
//
// Sources: IRS instructions for Schedule C (Form 1040), Form 1065, Form 1120-S and Form 1120, tax year 2025
// (irs.gov/instructions/i1040sc, i1065, i1120s, i1120), checked 2026-10-25. Line numbers move from year to
// year, so these stay `verified: false` until the Board checks them against the year being prepared.
import { DEFAULT_CHART } from './chartOfAccounts.js';

export const TAX_LINES_SOURCE = Object.freeze({
  taxYear: 2025, verified: false,
  urls: ['https://www.irs.gov/instructions/i1040sc', 'https://www.irs.gov/instructions/i1065',
    'https://www.irs.gov/instructions/i1120s', 'https://www.irs.gov/instructions/i1120'],
});

/** The categories an account can be given. `side` says whether it is income or a deduction. */
export const TAX_CATEGORIES = Object.freeze({
  gross_receipts: { label: 'Gross receipts or sales', side: 'income' },
  returns_allowances: { label: 'Returns and allowances', side: 'income' },
  cogs: { label: 'Cost of goods sold', side: 'cogs' },
  other_income: { label: 'Other business income', side: 'income' },
  interest_income: { label: 'Interest income', side: 'income' },
  asset_sale_gain: { label: 'Gain or loss on sale of business property', side: 'income' },
  advertising: { label: 'Advertising', side: 'deduction' },
  car_truck: { label: 'Car and truck expenses', side: 'deduction' },
  commissions_fees: { label: 'Commissions and fees', side: 'deduction' },
  contract_labor: { label: 'Contract labor', side: 'deduction' },
  depreciation: { label: 'Depreciation', side: 'deduction' },
  employee_benefits: { label: 'Employee benefit programs', side: 'deduction' },
  insurance: { label: 'Insurance (other than health)', side: 'deduction' },
  interest_mortgage: { label: 'Interest: mortgage', side: 'deduction' },
  interest_other: { label: 'Interest: other', side: 'deduction' },
  legal_professional: { label: 'Legal and professional services', side: 'deduction' },
  office_expense: { label: 'Office expense', side: 'deduction' },
  pension: { label: 'Pension and profit-sharing plans', side: 'deduction' },
  rent_equipment: { label: 'Rent: vehicles, machinery, equipment', side: 'deduction' },
  rent_property: { label: 'Rent: other business property', side: 'deduction' },
  repairs: { label: 'Repairs and maintenance', side: 'deduction' },
  supplies: { label: 'Supplies', side: 'deduction' },
  taxes_licenses: { label: 'Taxes and licenses', side: 'deduction' },
  travel: { label: 'Travel', side: 'deduction' },
  meals: { label: 'Meals', side: 'deduction' },
  utilities: { label: 'Utilities', side: 'deduction' },
  wages: { label: 'Wages (employees)', side: 'deduction' },
  officer_compensation: { label: 'Officer compensation', side: 'deduction' },
  guaranteed_payments: { label: 'Guaranteed payments to partners', side: 'deduction' },
  bad_debts: { label: 'Bad debts', side: 'deduction' },
  charitable: { label: 'Charitable contributions', side: 'deduction' },
  other_expense: { label: 'Other expenses', side: 'deduction' },
  not_deductible: { label: 'Not deductible (penalties, personal)', side: 'none' },
});
export const TAX_CATEGORY_KEYS = Object.freeze(Object.keys(TAX_CATEGORIES));

// Where each category goes on each return: [line, title] for a line on page 1, or { elsewhere } for a
// category reported somewhere else. A category not listed goes to the return's "other" line.
const L = (line, title) => ({ line, title });
const NOT_DEDUCTIBLE = { elsewhere: 'Not deductible: not on the return' };
export const TAX_FORMS = Object.freeze({
  schedule_c: {
    name: 'Schedule C (Form 1040)', other: L('27b', 'Other expenses (list them in Part V)'),
    lines: {
      gross_receipts: L('1', 'Gross receipts or sales'), returns_allowances: L('2', 'Returns and allowances'),
      cogs: L('4', 'Cost of goods sold'), other_income: L('6', 'Other income'),
      interest_income: { elsewhere: 'Schedule B (Form 1040), not Schedule C' },
      asset_sale_gain: { elsewhere: 'Form 4797 (sales of business property)' },
      advertising: L('8', 'Advertising'), car_truck: L('9', 'Car and truck expenses'),
      commissions_fees: L('10', 'Commissions and fees'), contract_labor: L('11', 'Contract labor'),
      depreciation: L('13', 'Depreciation and section 179 expense'), employee_benefits: L('14', 'Employee benefit programs'),
      insurance: L('15', 'Insurance (other than health)'), interest_mortgage: L('16a', 'Interest: mortgage'),
      interest_other: L('16b', 'Interest: other'), legal_professional: L('17', 'Legal and professional services'),
      office_expense: L('18', 'Office expense'), pension: L('19', 'Pension and profit-sharing plans'),
      rent_equipment: L('20a', 'Rent or lease: vehicles, machinery, equipment'), rent_property: L('20b', 'Rent or lease: other business property'),
      repairs: L('21', 'Repairs and maintenance'), supplies: L('22', 'Supplies'), taxes_licenses: L('23', 'Taxes and licenses'),
      travel: L('24a', 'Travel'), meals: L('24b', 'Deductible meals (generally 50% of the total shown)'),
      utilities: L('25', 'Utilities'), wages: L('26', 'Wages'),
      officer_compensation: { elsewhere: "Not deductible on Schedule C: an owner's pay is a draw" },
      guaranteed_payments: { elsewhere: 'Not on Schedule C (partnerships only)' },
      charitable: { elsewhere: 'Schedule A (Form 1040), not Schedule C' },
      not_deductible: NOT_DEDUCTIBLE,
    },
  },
  form_1065: {
    name: 'Form 1065', other: L('21', 'Other deductions'),
    lines: {
      gross_receipts: L('1a', 'Gross receipts or sales'), returns_allowances: L('1b', 'Returns and allowances'),
      cogs: L('2', 'Cost of goods sold'), other_income: L('7', 'Other income (loss)'),
      interest_income: { elsewhere: 'Schedule K, line 5 (interest income)' },
      asset_sale_gain: { elsewhere: 'Form 4797, then line 6' },
      wages: L('9', 'Salaries and wages (other than to partners)'), guaranteed_payments: L('10', 'Guaranteed payments to partners'),
      repairs: L('11', 'Repairs and maintenance'), bad_debts: L('12', 'Bad debts'),
      rent_equipment: L('13', 'Rent'), rent_property: L('13', 'Rent'), taxes_licenses: L('14', 'Taxes and licenses'),
      interest_mortgage: L('15', 'Interest'), interest_other: L('15', 'Interest'), depreciation: L('16', 'Depreciation'),
      pension: L('18', 'Retirement plans, etc.'), employee_benefits: L('19', 'Employee benefit programs'),
      officer_compensation: { elsewhere: 'Not on Form 1065: pay to partners is a guaranteed payment or a draw' },
      charitable: { elsewhere: 'Schedule K, line 13a (charitable contributions)' },
      not_deductible: NOT_DEDUCTIBLE,
    },
  },
  form_1120s: {
    name: 'Form 1120-S', other: L('20', 'Other deductions'),
    lines: {
      gross_receipts: L('1a', 'Gross receipts or sales'), returns_allowances: L('1b', 'Returns and allowances'),
      cogs: L('2', 'Cost of goods sold'), other_income: L('5', 'Other income (loss)'),
      interest_income: { elsewhere: 'Schedule K, line 4 (interest income)' },
      asset_sale_gain: { elsewhere: 'Form 4797, then line 4' },
      officer_compensation: L('7', 'Compensation of officers'), wages: L('8', 'Salaries and wages'),
      repairs: L('9', 'Repairs and maintenance'), bad_debts: L('10', 'Bad debts'),
      rent_equipment: L('11', 'Rents'), rent_property: L('11', 'Rents'), taxes_licenses: L('12', 'Taxes and licenses'),
      interest_mortgage: L('13', 'Interest'), interest_other: L('13', 'Interest'), depreciation: L('14', 'Depreciation'),
      advertising: L('16', 'Advertising'), pension: L('17', 'Pension, profit-sharing, etc., plans'),
      employee_benefits: L('18', 'Employee benefit programs'),
      guaranteed_payments: { elsewhere: 'Not on Form 1120-S (partnerships only)' },
      charitable: { elsewhere: 'Schedule K, line 12a (charitable contributions)' },
      not_deductible: NOT_DEDUCTIBLE,
    },
  },
  form_1120: {
    name: 'Form 1120', other: L('26', 'Other deductions'),
    lines: {
      gross_receipts: L('1a', 'Gross receipts or sales'), returns_allowances: L('1b', 'Returns and allowances'),
      cogs: L('2', 'Cost of goods sold'), interest_income: L('5', 'Interest'), other_income: L('10', 'Other income'),
      asset_sale_gain: { elsewhere: 'Form 4797, then line 9' },
      officer_compensation: L('12', 'Compensation of officers'), wages: L('13', 'Salaries and wages'),
      repairs: L('14', 'Repairs and maintenance'), bad_debts: L('15', 'Bad debts'),
      rent_equipment: L('16', 'Rents'), rent_property: L('16', 'Rents'), taxes_licenses: L('17', 'Taxes and licenses'),
      interest_mortgage: L('18', 'Interest'), interest_other: L('18', 'Interest'), charitable: L('19', 'Charitable contributions'),
      depreciation: L('20', 'Depreciation'), advertising: L('22', 'Advertising'), pension: L('23', 'Pension, profit-sharing, etc., plans'),
      employee_benefits: L('24', 'Employee benefit programs'),
      guaranteed_payments: { elsewhere: 'Not on Form 1120 (partnerships only)' },
      not_deductible: NOT_DEDUCTIBLE,
    },
  },
});

/** The return a type of business files, or null for personal books. */
export const FORM_FOR_ENTITY = Object.freeze({
  sole_proprietor: 'schedule_c', single_member_llc: 'schedule_c', partnership: 'form_1065', s_corp: 'form_1120s', c_corp: 'form_1120',
  individual: null,
});

/** Where a category goes on a form: { line, title } or { elsewhere }. */
export function placeOf(form, category) {
  const f = TAX_FORMS[form];
  return f.lines[category] ?? f.other;
}

// Suggestions for the accounts in our default chart, then by words in the account's name.
const BY_CODE = {
  4000: 'gross_receipts', 4100: 'gross_receipts', 4900: 'interest_income', 4950: 'asset_sale_gain', 5000: 'cogs',
  6000: 'advertising', 6050: 'other_expense', 6100: 'depreciation', 6150: 'insurance', 6200: 'office_expense',
  6250: 'legal_professional', 6300: 'rent_property', 6350: 'utilities', 6400: 'wages', 6410: 'taxes_licenses',
  6500: 'travel', 6600: 'car_truck', 6900: 'interest_other',
};
const BY_WORDS = [
  [/refund|return|allowance|discount/i, 'returns_allowances', 'revenue'], [/interest/i, 'interest_income', 'revenue'],
  [/gain|sale of (asset|equipment)/i, 'asset_sale_gain', 'revenue'],
  [/advertis|marketing/i, 'advertising'], [/vehicle|auto|car|truck|mileage|fuel|gas/i, 'car_truck'],
  [/commission|merchant|fee/i, 'commissions_fees'], [/contract|subcontract/i, 'contract_labor'],
  [/depreciat|amortiz/i, 'depreciation'], [/health|benefit/i, 'employee_benefits'], [/insurance/i, 'insurance'],
  [/mortgage/i, 'interest_mortgage'], [/interest/i, 'interest_other'], [/legal|accounting|professional|attorney/i, 'legal_professional'],
  [/\boffice\b|software|postage|computer/i, 'office_expense'], [/401|pension|retirement|profit.?sharing/i, 'pension'],
  [/equipment rent|lease/i, 'rent_equipment'], [/rent/i, 'rent_property'], [/repair|maintenance/i, 'repairs'],
  [/supplies|materials/i, 'supplies'], [/tax|license|permit/i, 'taxes_licenses'], [/meal|entertain/i, 'meals'],
  [/travel|lodging|airfare|hotel/i, 'travel'], [/utilit|electric|water|phone|internet/i, 'utilities'],
  [/officer/i, 'officer_compensation'], [/guaranteed/i, 'guaranteed_payments'], [/wage|salar|payroll/i, 'wages'],
  [/bad debt/i, 'bad_debts'], [/donation|charit/i, 'charitable'], [/penalt|fine/i, 'not_deductible'],
];

/** A suggested category for an income or expense account, or null for balance-sheet accounts. */
export function suggestCategory(account) {
  if (!['revenue', 'expense'].includes(account.type)) return null;
  // Our chart's own accounts (same code and name) are known; a renamed or imported one is judged by its name.
  if (BY_CODE[account.code] && DEFAULT_CHART.some((d) => d.code === account.code && d.name === account.name)) return BY_CODE[account.code];
  if (account.subtype === 'cogs') return 'cogs';
  for (const [re, cat, onlyType] of BY_WORDS) {
    if (onlyType && onlyType !== account.type) continue;
    if (!onlyType && account.type === 'revenue') continue;
    if (re.test(account.name)) return cat;
  }
  return account.type === 'revenue' ? (account.subtype === 'other' ? 'other_income' : 'gross_receipts') : 'other_expense';
}

/**
 * Groups income and expense accounts' activity onto a return's lines.
 * @param form  key of TAX_FORMS
 * @param accounts [{ id, code, name, type, subtype, category (saved, or null) }]
 * @param sums  Map accountId → { debitCents, creditCents } for the period
 * @returns { lines: [{ line, title, cents, accounts }], elsewhere: [{ note, cents, accounts }],
 *            suggestedCount, incomeCents, deductionCents }
 * Amounts are positive for income on income lines and for expenses on deduction lines; returns and
 * allowances and a loss show negative where they reduce the line.
 */
export function taxSummary(form, accounts, sums) {
  const lines = new Map();
  const elsewhere = new Map();
  let suggestedCount = 0;
  for (const a of accounts) {
    if (!['revenue', 'expense'].includes(a.type)) continue;
    const s = sums.get(a.id);
    if (!s) continue;
    const net = Number(s.debitCents) - Number(s.creditCents);
    if (net === 0) continue;
    const category = a.category ?? suggestCategory(a);
    const suggested = !a.category;
    if (suggested) suggestedCount++;
    const side = TAX_CATEGORIES[category].side;
    // Income lines show credits positive; returns and allowances shows the amount given back as positive.
    const cents = category === 'returns_allowances' ? net : side === 'income' ? -net : net;
    const row = { id: a.id, code: a.code, name: a.name, category, suggested, cents };
    const place = placeOf(form, category);
    const map = place.line ? lines : elsewhere;
    const key = place.line ?? place.elsewhere;
    if (!map.has(key)) map.set(key, place.line ? { line: place.line, title: place.title, cents: 0, accounts: [] } : { note: place.elsewhere, cents: 0, accounts: [] });
    const g = map.get(key);
    g.cents += cents; g.accounts.push(row);
  }
  const order = (x) => { const m = /^(\d+)([a-z]?)$/.exec(x.line); return Number(m[1]) * 100 + (m[2] ? m[2].charCodeAt(0) : 0); };
  const out = [...lines.values()].sort((a, b) => order(a) - order(b));
  const isIncome = (g) => g.accounts.some((r) => ['income', 'cogs'].includes(TAX_CATEGORIES[r.category].side));
  const incomeCents = out.filter((g) => g.accounts.every((r) => TAX_CATEGORIES[r.category].side === 'income'))
    .reduce((t, g) => t + (g.accounts[0].category === 'returns_allowances' ? -g.cents : g.cents), 0);
  const cogsCents = out.filter((g) => g.accounts.every((r) => r.category === 'cogs')).reduce((t, g) => t + g.cents, 0);
  const deductionCents = out.filter((g) => !isIncome(g)).reduce((t, g) => t + g.cents, 0);
  return { lines: out, elsewhere: [...elsewhere.values()], suggestedCount, incomeCents, cogsCents, deductionCents,
    ordinaryIncomeCents: incomeCents - cogsCents - deductionCents };
}

// Form 1099-NEC: nonemployee pay of this much or more in a calendar year is reported. $600 for payments made
// through 2025; $2,000 for payments made after Dec 31, 2025 (One Big Beautiful Bill Act, IRC §§6041/6041A;
// see natptax.com "Form 1099 filing changes under the new $2,000 threshold"). Later years may be indexed for
// inflation: confirm before relying on a year not listed. Payments by credit card or a payment app are left
// out: the card company reports those on Form 1099-K.
export const NEC_THRESHOLD = Object.freeze({ verified: false, byYear: { 2024: 60000, 2025: 60000, 2026: 200000 } });
export function necThresholdCents(year) {
  const ys = Object.keys(NEC_THRESHOLD.byYear).map(Number).sort((a, b) => a - b);
  const y = ys.filter((x) => x <= year).pop() ?? ys[0];
  return { cents: NEC_THRESHOLD.byYear[y], exact: y === year };
}
