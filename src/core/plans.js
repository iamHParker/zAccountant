// Plans and add-ons: which parts of zAccountant a company may use. ℹ️ The server is the gate (like a
// load rating on a beam): a request for a feature the company's plan doesn't include is refused before it
// runs, whatever the screen shows. The screens only hide what the server would refuse.
//
// Homer, 2026-10-24: beta testers pay nothing and get every feature; plans are switched by hand in the Admin
// dashboard until Stripe goes in (December, before the Jan 1 launch). Prices are Homer's to set, so they
// stay null ("not set") until he does.
// Homer, 2026-10-25: subscriptions (they pay for the storage the books and files take), monthly or a reduced
// annual price; a Family and individuals plan and a Company plan; Tax and Timesheets as added services.
// ℹ️ Payroll comes with the Company plan (his list named no payroll add-on).

/** The features a plan or add-on can switch on. Everything not listed here is part of every plan. */
export const FEATURES = {
  payroll: 'Payroll (employees, paychecks, tax deposits, payroll reports)',
  timesheets: 'Timesheets (time entry, approvals, jobs, HoursTracker import)',
  tax: 'Tax-ready (accounts mapped to return lines, tax summary, 1099-NEC and W-2/W-3 totals)',
};

export const PLANS = {
  beta: { name: 'Beta tester', features: Object.keys(FEATURES), monthlyCents: 0, annualCents: 0, note: 'Free, everything on, while testing' },
  individual: { name: 'Family and individuals', features: [], monthlyCents: null, annualCents: null,
    note: 'Household and personal books: accounts, bank imports, bills, reports' },
  company: { name: 'Company', features: ['payroll'], monthlyCents: null, annualCents: null,
    note: 'Books, invoices, bills, banking, reports and payroll' },
};
export const ADD_ONS = {
  tax: { name: 'Tax-ready', features: ['tax'], monthlyCents: null, annualCents: null },
  timesheets: { name: 'Timesheets', features: ['timesheets'], monthlyCents: null, annualCents: null },
};

/** A company with no plan row yet is on this one (every company made during the beta). */
export const DEFAULT_PLAN = 'beta';

/** The features a company has: its plan's plus its add-ons'. */
export function featuresOf(plan = DEFAULT_PLAN, addOns = []) {
  const f = new Set(PLANS[plan]?.features ?? []);
  for (const a of addOns ?? []) for (const x of ADD_ONS[a]?.features ?? []) f.add(x);
  return [...f].sort();
}

// Which API paths (after /companies/:companyId) need which feature.
const GATES = [
  [/^\/(employees|paychecks|payroll-runs|payroll-deposits|payroll-hours)(\/|$)/, 'payroll'],
  [/^\/reports\/payroll-(register|liabilities)(\/|$)/, 'payroll'],
  [/^\/(time-entries|jobs)(\/|$)/, 'timesheets'],
  [/^\/reports\/time-summary(\/|$)/, 'timesheets'],
  [/^\/(tax-categories|reports\/tax-(summary|1099|w2))(\/|$)/, 'tax'],
];

/** The feature a company API path needs, or null. `rest` is the part after /companies/<id>. */
export function featureForPath(rest) {
  for (const [re, f] of GATES) if (re.test(rest)) return f;
  return null;
}

/** Check a plan change from the Admin dashboard -> { plan, addOns, reason }. Throws a sentence. */
export function checkPlanChange({ plan, addOns = [], reason } = {}) {
  if (!PLANS[plan]) throw new Error(`Plan must be one of: ${Object.keys(PLANS).join(', ')}`);
  if (!Array.isArray(addOns) || addOns.some((a) => !ADD_ONS[a])) throw new Error(`Add-ons must be from: ${Object.keys(ADD_ONS).join(', ')}`);
  const r = String(reason ?? '').trim();
  if (!r) throw new Error('Give a reason (it goes in the change log)');
  if (r.length > 500) throw new Error('Keep the reason under 500 characters');
  return { plan, addOns: [...new Set(addOns)].sort(), reason: r };
}
