// Plans for each company, and the Admin dashboard's view of every company. See src/core/plans.js for the
// plans themselves and which features they switch on.
import { LedgerError } from '../core/ledger.js';
import { PLANS, ADD_ONS, FEATURES, DEFAULT_PLAN, featuresOf, checkPlanChange } from '../core/plans.js';
import * as ledger from './ledgerService.js';

/** A company's plan, add-ons and the features they give (the default plan when none has been set). */
export async function getCompanyPlan(db, companyId) {
  const { rows: [p] } = await db.query('SELECT plan, add_ons FROM company_plans WHERE company_id = $1', [companyId]);
  const plan = p?.plan ?? DEFAULT_PLAN;
  const addOns = p?.add_ons ?? [];
  return { plan, planName: PLANS[plan]?.name ?? plan, addOns, features: featuresOf(plan, addOns) };
}

/** The plan list for the Admin dashboard. */
export function catalog() {
  return {
    plans: Object.entries(PLANS).map(([key, p]) => ({ key, ...p })),
    addOns: Object.entries(ADD_ONS).map(([key, a]) => ({ key, ...a })),
    features: FEATURES, defaultPlan: DEFAULT_PLAN,
  };
}

/** Every company with what billing needs (platform admins only: the database function refuses anyone else). */
export async function listCompanies(db) {
  const { rows } = await db.query('SELECT * FROM zacc_admin_companies()');
  const counts = {};
  const companies = rows.map((r) => {
    const plan = r.plan ?? DEFAULT_PLAN;
    counts[plan] = (counts[plan] ?? 0) + 1;
    return {
      id: r.id, name: r.name, homeState: r.home_state, createdAt: r.created_at, owners: r.owners ?? '', members: Number(r.members),
      employees: Number(r.employees), lastActivity: r.last_activity, plan, planName: PLANS[plan]?.name ?? plan,
      planIsDefault: r.plan == null, addOns: r.add_ons ?? [], planUpdatedAt: r.plan_updated_at,
    };
  });
  return { companies, planCounts: counts, ...catalog() };
}

/** Change a company's plan and add-ons, with a reason; logged in the change log and the company's own audit trail. */
export async function setCompanyPlan(db, companyId, input, { actor }) {
  let v;
  try { v = checkPlanChange(input); } catch (e) { throw new LedgerError(e.message); }
  const { rows: [old] } = await db.query('SELECT plan, add_ons FROM company_plans WHERE company_id = $1', [companyId]);
  // The company's own audit chain is written in that company's scope (row-level security).
  await db.query("SELECT set_config('zacc.company_id', $1, true)", [companyId]);
  const { rows: [co] } = await db.query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
  if (!co) throw new LedgerError('Company not found');
  await db.query(
    `INSERT INTO company_plans (company_id, plan, add_ons, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id) DO UPDATE SET plan = EXCLUDED.plan, add_ons = EXCLUDED.add_ons, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [companyId, v.plan, v.addOns, actor]);
  await db.query(
    `INSERT INTO plan_changes (company_id, company_name, old_plan, old_add_ons, new_plan, new_add_ons, reason, changed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [companyId, co.name, old?.plan ?? null, old?.add_ons ?? null, v.plan, v.addOns, v.reason, actor]);
  await ledger.auditOnly(db, companyId, { action: 'set_plan', entity: 'company', entityId: companyId, actor,
    payload: { from: old ? { plan: old.plan, addOns: old.add_ons } : { plan: DEFAULT_PLAN, addOns: [] }, to: { plan: v.plan, addOns: v.addOns }, reason: v.reason } });
  return getCompanyPlan(db, companyId);
}

/** The latest plan changes, newest first. */
export async function listPlanChanges(db, { limit = 200 } = {}) {
  const { rows } = await db.query(
    'SELECT * FROM plan_changes ORDER BY changed_at DESC LIMIT $1', [Math.min(Number(limit) || 200, 500)]);
  return rows.map((r) => ({
    at: r.changed_at, companyId: r.company_id, companyName: r.company_name, by: r.changed_by, reason: r.reason,
    from: r.old_plan ? `${PLANS[r.old_plan]?.name ?? r.old_plan}${r.old_add_ons?.length ? ` + ${r.old_add_ons.join(', ')}` : ''}` : `${PLANS[DEFAULT_PLAN].name} (default)`,
    to: `${PLANS[r.new_plan]?.name ?? r.new_plan}${r.new_add_ons.length ? ` + ${r.new_add_ons.join(', ')}` : ''}`,
  }));
}
