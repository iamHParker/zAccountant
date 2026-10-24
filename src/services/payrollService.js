// Payroll: employees, paycheck preview, and paycheck posting (engine result -> journal entry).
import { withTransaction } from '../db/pool.js';
import { calculatePaycheck, paycheckJournalLines, PayrollError, PAY_PERIODS, SUPPORTED_STATES } from '../payroll/engine.js';
import { validateEntry, isIsoDate, LedgerError } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { insertEntry, getCompany } from './ledgerService.js';
import { appendAudit } from './audit.js';

const EMP_COLS = `id, first_name AS "firstName", last_name AS "lastName", work_state AS "workState",
  pay_frequency AS "payFrequency", pay_type AS "payType", pay_rate_cents AS "payRateCents",
  w4, state_elections AS "stateElections", active`;

export async function createEmployee(pool, companyId, e, { actor = null } = {}) {
  const errors = [];
  if (!e.firstName?.trim() || !e.lastName?.trim()) errors.push('first and last name are required');
  if (!SUPPORTED_STATES.includes(e.workState)) errors.push('work state must be TX, CO, CA or DC');
  if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(e.payFrequency)) errors.push('invalid pay frequency');
  if (!['salary', 'hourly'].includes(e.payType)) errors.push('pay type must be salary or hourly');
  let rate;
  try { rate = e.payRateCents ?? toCents(e.payRate); } catch (err) { errors.push(`pay rate: ${err.message}`); }
  if (errors.length) throw new LedgerError('Employee is not valid', errors);
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [emp] } = await c.query(
      `INSERT INTO employees (company_id, first_name, last_name, work_state, pay_frequency, pay_type, pay_rate_cents, w4, state_elections)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${EMP_COLS}`,
      [companyId, e.firstName.trim(), e.lastName.trim(), e.workState, e.payFrequency, e.payType, rate,
        JSON.stringify(e.w4 ?? {}), JSON.stringify(e.stateElections ?? {})],
    );
    await appendAudit(c, companyId, { action: 'create', entity: 'employee', entityId: emp.id, actor, payload: { name: `${emp.firstName} ${emp.lastName}`, workState: emp.workState } });
    return emp;
  });
}

export async function listEmployees(db, companyId) {
  return (await db.query(`SELECT ${EMP_COLS} FROM employees WHERE company_id = $1 ORDER BY last_name, first_name`, [companyId])).rows;
}

async function getEmployee(db, companyId, employeeId) {
  const { rows } = await db.query(`SELECT ${EMP_COLS} FROM employees WHERE company_id = $1 AND id = $2`, [companyId, employeeId]);
  if (!rows[0]) throw new LedgerError('Employee not found');
  return rows[0];
}

function grossFor(emp, { hours, grossCents }) {
  if (grossCents != null) return grossCents;
  if (emp.payType === 'salary') return emp.payRateCents;
  if (hours == null) throw new PayrollError('hours are required for hourly employees');
  // hours given as a decimal string like "40" or "37.5"; overtime over 40/week is entered separately as overtimeHours
  const hundredths = toCents(hours); // reuse exact decimal parsing: "37.5" -> 3750 hundredths of an hour
  return Math.round((emp.payRateCents * hundredths) / 100);
}

async function ytdFor(db, companyId, employeeId, year) {
  const { rows } = await db.query(
    `SELECT calculation->'ytdAfter' AS ytd, pay_date FROM paychecks
      WHERE company_id = $1 AND employee_id = $2 AND tax_year = $3
      ORDER BY pay_date DESC, created_at DESC LIMIT 1`, [companyId, employeeId, year]);
  return { ytd: rows[0]?.ytd ?? {}, lastPayDate: rows[0]?.pay_date ?? null };
}

async function compute(db, companyId, employeeId, input) {
  if (!isIsoDate(input.payDate)) throw new LedgerError('payDate must be YYYY-MM-DD');
  const company = await getCompany(db, companyId);
  const emp = await getEmployee(db, companyId, employeeId);
  if (!emp.active) throw new PayrollError('Employee is inactive');
  const year = Number(input.payDate.slice(0, 4)); // taxes follow the PAY date, not the work period
  const { ytd, lastPayDate } = await ytdFor(db, companyId, employeeId, year);
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND active', [companyId]);
  let gross = grossFor(emp, input);
  if (input.overtimeHours != null) {
    if (emp.payType !== 'hourly') throw new PayrollError('overtime hours apply to hourly employees only');
    gross += Math.round((emp.payRateCents * 3 * toCents(input.overtimeHours)) / 200); // 1.5x
  }
  const result = calculatePaycheck({
    year, payFrequency: emp.payFrequency, grossCents: gross,
    preTaxDeductions: input.preTaxDeductions ?? [],
    employee: { workState: emp.workState, w4: emp.w4, stateElections: emp.stateElections },
    ytd,
    company: { suiRatePct: company.sui_rate_pct ?? undefined, employeeCount: n },
  });
  return { company, emp, result, lastPayDate };
}

export async function previewPaycheck(db, companyId, employeeId, input) {
  const { emp, result } = await compute(db, companyId, employeeId, input);
  return { employee: emp, ...result };
}

export async function postPaycheck(pool, companyId, employeeId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]); // serialize YTD math
    const { company, emp, result, lastPayDate } = await compute(c, companyId, employeeId, input);
    if (lastPayDate && input.payDate < lastPayDate) {
      throw new PayrollError(`Paychecks must be entered in date order; last paycheck for this employee is ${lastPayDate}`);
    }
    if (!result.tablesVerified && !company.calculate_only_payroll) {
      throw new PayrollError('Tax tables are not certified by the Professional Review Board; switch the company to calculate-only payroll');
    }
    const { rows: accts } = await c.query('SELECT id, system_key FROM accounts WHERE company_id = $1 AND system_key IS NOT NULL', [companyId]);
    const byKey = new Map(accts.map((a) => [a.system_key, a.id]));
    const lines = paycheckJournalLines(result).map((l) => {
      const accountId = byKey.get(l.accountKey);
      if (!accountId) throw new PayrollError(`Company is missing system account "${l.accountKey}"`);
      return { accountId, debitCents: l.debitCents, creditCents: l.creditCents };
    });
    const entry = validateEntry({ date: input.payDate, memo: `Payroll: ${emp.firstName} ${emp.lastName}`, lines });
    const je = await insertEntry(c, companyId, entry, { source: 'payroll', sourceRef: employeeId, actor });
    const { rows: [pc] } = await c.query(
      `INSERT INTO paychecks (company_id, employee_id, pay_date, tax_year, gross_cents, net_pay_cents, calculation, tables_verified, journal_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [companyId, employeeId, input.payDate, result.year, result.grossCents, result.netPayCents, JSON.stringify(result), result.tablesVerified, je.id],
    );
    await appendAudit(c, companyId, { action: 'create', entity: 'paycheck', entityId: pc.id, actor, payload: { employeeId, payDate: input.payDate, grossCents: result.grossCents, netPayCents: result.netPayCents, journalEntryId: je.id } });
    return { paycheckId: pc.id, journalEntryId: je.id, entryNumber: je.entry_number, employee: emp, ...result };
  });
}

export async function listPaychecks(db, companyId, { year } = {}) {
  const { rows } = await db.query(
    `SELECT p.id, p.pay_date AS "payDate", p.gross_cents AS "grossCents", p.net_pay_cents AS "netPayCents",
            p.tables_verified AS "tablesVerified", e.first_name || ' ' || e.last_name AS employee, p.calculation
       FROM paychecks p JOIN employees e ON e.id = p.employee_id
      WHERE p.company_id = $1 AND ($2::int IS NULL OR p.tax_year = $2)
      ORDER BY p.pay_date DESC, p.created_at DESC`, [companyId, year ?? null]);
  return rows;
}

export { PAY_PERIODS };
