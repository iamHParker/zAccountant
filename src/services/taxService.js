// Tax-ready, level 1: totals for the owner's tax preparer. A tax summary by return line, 1099-NEC totals per
// vendor, and W-2 / W-3 totals per employee. Nothing here is filed or printed as a form (Homer, 2026-10-24).
import { withTransaction } from '../db/pool.js';
import { LedgerError, isIsoDate } from '../core/ledger.js';
import { appendAudit } from './audit.js';
import { accountSums } from './reportService.js';
import { ENTITY_TYPES } from '../core/entityTypes.js';
import { TAX_CATEGORIES, TAX_FORMS, FORM_FOR_ENTITY, TAX_LINES_SOURCE, suggestCategory, placeOf, taxSummary, necThresholdCents } from '../core/taxLines.js';

const checkYear = (year) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new LedgerError('Choose a tax year');
  return y;
};

async function companyForm(db, companyId) {
  const { rows: [c] } = await db.query('SELECT entity_type FROM companies WHERE id = $1', [companyId]);
  if (!c) throw new LedgerError('Company not found');
  return { entityType: c.entity_type, form: FORM_FOR_ENTITY[c.entity_type] ?? null };
}

async function accountsWithCategories(db, companyId) {
  const { rows } = await db.query(
    `SELECT a.id, a.code, a.name, a.type, a.subtype, a.is_active AS "isActive", t.category
       FROM accounts a LEFT JOIN account_tax_categories t ON t.company_id = a.company_id AND t.account_id = a.id
      WHERE a.company_id = $1 AND a.type IN ('revenue', 'expense') ORDER BY a.code`, [companyId]);
  return rows.map((a) => ({ ...a, category: TAX_CATEGORIES[a.category] ? a.category : null }));
}

/** Income and expense accounts with their category (saved or suggested), and where each lands on the return. */
export async function getTaxCategories(db, companyId) {
  const { entityType, form } = await companyForm(db, companyId);
  const accounts = (await accountsWithCategories(db, companyId)).map((a) => {
    const category = a.category ?? suggestCategory(a);
    const place = form ? placeOf(form, category) : null;
    return { ...a, category, suggested: !a.category, place: place ? (place.line ? `Line ${place.line}: ${place.title}` : place.elsewhere) : null };
  });
  return { entityType, form, formName: form ? TAX_FORMS[form].name : null,
    categories: Object.entries(TAX_CATEGORIES).map(([key, c]) => ({ key, label: c.label, side: c.side })), accounts };
}

/**
 * Save categories: [{ accountId, category }]. A category of null goes back to the suggestion.
 * "Accept all suggestions" sends every suggested account with its suggested category.
 */
export async function setTaxCategories(pool, companyId, { items, actor = null }) {
  if (!Array.isArray(items) || !items.length || items.length > 1000) throw new LedgerError('Choose at least one account');
  const errors = [];
  items.forEach((x, i) => {
    if (typeof x?.accountId !== 'string') errors.push(`item ${i + 1}: which account?`);
    if (x?.category != null && !TAX_CATEGORIES[x.category]) errors.push(`item ${i + 1}: unknown tax category "${x.category}"`);
  });
  if (errors.length) throw new LedgerError('Tax categories are not valid', errors);
  return withTransaction(pool, async (c) => {
    const ids = items.map((x) => x.accountId);
    const { rows } = await c.query(`SELECT id FROM accounts WHERE company_id = $1 AND id = ANY($2::uuid[]) AND type IN ('revenue', 'expense')`, [companyId, ids])
      .catch(() => { throw new LedgerError('An account was not found'); });
    if (rows.length !== new Set(ids).size) throw new LedgerError('Tax categories apply to income and expense accounts of this company only');
    for (const x of items) {
      if (x.category == null) await c.query('DELETE FROM account_tax_categories WHERE company_id = $1 AND account_id = $2', [companyId, x.accountId]);
      else await c.query(
        `INSERT INTO account_tax_categories (company_id, account_id, category, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, account_id) DO UPDATE SET category = EXCLUDED.category, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [companyId, x.accountId, x.category, actor]);
    }
    await appendAudit(c, companyId, { action: 'set_tax_categories', entity: 'account', actor, payload: { items } });
    return { saved: items.length };
  });
}

/** The tax summary for a period: income and expense totals grouped by the lines of the company's return. */
export async function getTaxSummary(db, companyId, { from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new LedgerError('Choose a date range (from on or before to)');
  const { entityType, form } = await companyForm(db, companyId);
  const base = { from, to, entityType, entityLabel: ENTITY_TYPES[entityType]?.label ?? null, source: TAX_LINES_SOURCE };
  if (!form) {
    return { ...base, form: null, formName: null, lines: [], elsewhere: [],
      message: entityType === 'individual'
        ? 'Personal books have no business return to summarize. Use the Profit & Loss report for your records.'
        : 'Choose the type of business (Settings → Company setup) so we know which return these books feed.' };
  }
  const s = taxSummary(form, await accountsWithCategories(db, companyId), await accountSums(db, companyId, { from, to }));
  return { ...base, form, formName: TAX_FORMS[form].name, ...s };
}

/** Form 1099-NEC totals: what each vendor was paid in a calendar year, by payment date. */
export async function get1099Totals(db, companyId, { year }) {
  const y = checkYear(year);
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.is_1099 AS "is1099", (c.address IS NOT NULL AND c.address <> '') AS "hasAddress",
            sum(p.amount_cents) FILTER (WHERE coalesce(p.method, '') <> 'card' AND a.subtype <> 'credit_card')::bigint AS reportable,
            sum(p.amount_cents) FILTER (WHERE p.method = 'card' OR a.subtype = 'credit_card')::bigint AS by_card
       FROM payments p
       JOIN contacts c ON c.id = p.contact_id AND c.company_id = p.company_id
       JOIN accounts a ON a.id = p.account_id AND a.company_id = p.company_id
      WHERE p.company_id = $1 AND p.kind = 'made' AND p.status = 'posted'
        AND p.pay_date BETWEEN make_date($2, 1, 1) AND make_date($2, 12, 31)
      GROUP BY c.id, c.name, c.is_1099, c.address ORDER BY c.name`, [companyId, y]);
  const threshold = necThresholdCents(y);
  const vendors = rows.map((r) => {
    const paid = Number(r.reportable ?? 0);
    return { contactId: r.id, name: r.name, is1099: r.is1099, hasAddress: r.hasAddress, paidCents: paid, byCardCents: Number(r.by_card ?? 0),
      needsForm: r.is1099 && paid >= threshold.cents };
  });
  const flagged = vendors.filter((v) => v.is1099);
  return {
    year: y, from: `${y}-01-01`, to: `${y}-12-31`, thresholdCents: threshold.cents, thresholdConfirmed: threshold.exact,
    vendors: flagged,
    // Vendors not marked for a 1099 who were paid at least the threshold: worth a second look.
    toCheck: vendors.filter((v) => !v.is1099 && v.paidCents >= threshold.cents),
    formsNeeded: flagged.filter((v) => v.needsForm).length,
    totalCents: flagged.filter((v) => v.needsForm).reduce((t, v) => t + v.paidCents, 0),
  };
}

const STATE_PIT = { CA: 'CA_PIT', CO: 'CO_PIT', DC: 'DC_PIT' };

/** W-2 boxes per employee and state for a calendar year (by pay date), and the W-3 totals. */
export async function getW2Totals(db, companyId, { year }) {
  const y = checkYear(year);
  const { rows } = await db.query(
    `SELECT p.employee_id AS "employeeId", e.last_name || ', ' || e.first_name AS employee, p.calculation AS calc, o.calculation AS orig
       FROM paychecks p JOIN employees e ON e.id = p.employee_id AND e.company_id = p.company_id
       LEFT JOIN paychecks o ON o.id = p.voids_paycheck_id
      WHERE p.company_id = $1 AND p.pay_date BETWEEN make_date($2, 1, 1) AND make_date($2, 12, 31)
      ORDER BY e.last_name, e.first_name`, [companyId, y]);
  const blank = () => ({ box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, box12D: 0, state: {} });
  const people = new Map();
  const w3 = blank();
  for (const r of rows) {
    const calc = r.calc;
    if (!people.has(r.employeeId)) people.set(r.employeeId, { employeeId: r.employeeId, employee: r.employee, ...blank(), paychecks: 0 });
    const e = people.get(r.employeeId);
    e.paychecks += r.orig ? -1 : 1;
    const tax = (code) => (calc.employeeTaxes ?? []).filter((t) => t.code === code);
    const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
    const state = calc.state ?? r.orig?.state ?? null;
    const add = (box, cents) => { e[box] += cents; w3[box] += cents; };
    add('box1', calc.wages?.incomeTaxCents ?? 0);
    add('box2', sum(tax('FIT'), (t) => t.amountCents));
    add('box3', sum(tax('SS'), (t) => t.taxableCents));
    add('box4', sum(tax('SS'), (t) => t.amountCents));
    add('box5', calc.wages?.ficaCents ?? 0);
    add('box6', sum([...tax('MED'), ...tax('MED_ADDL')], (t) => t.amountCents));
    const deds = calc.deductions ?? (r.orig?.deductions ?? []).map((d) => ({ ...d, amountCents: -d.amountCents }));
    add('box12D', sum(deds.filter((d) => d.kind === 'retirement_401k'), (d) => d.amountCents));
    if (state && STATE_PIT[state]) {
      for (const target of [e, w3]) {
        target.state[state] ??= { box16: 0, box17: 0 };
        target.state[state].box16 += calc.wages?.incomeTaxCents ?? 0;
        target.state[state].box17 += sum(tax(STATE_PIT[state]), (t) => t.amountCents);
      }
    }
  }
  const employees = [...people.values()];
  return { year: y, from: `${y}-01-01`, to: `${y}-12-31`, employees, w3: { ...w3, forms: employees.filter((e) => e.box1 || e.box5).length },
    notes: ['Box 12 code DD (employer health coverage) and box 14 items are not tracked yet; add them by hand if they apply.'] };
}
