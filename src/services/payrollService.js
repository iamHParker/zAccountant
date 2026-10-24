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
  try { rate = toCents(e.payRate); } catch (err) { errors.push(`pay rate: ${err.message}`); }
  if (rate != null && (rate <= 0 || rate > 100_000_000)) errors.push('pay rate must be between $0.01 and $1,000,000');
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

/** Hours as hundredths (exact): "37.5" -> 3750. */
function hundredthsOfHours(h, label) {
  let v;
  try { v = toCents(h); } catch { throw new PayrollError(`${label} must be a number like 40 or 37.5`); }
  if (v < 0 || v > 100_000) throw new PayrollError(`${label} must be between 0 and 1,000`);
  return v;
}

function grossFor(emp, { hours }) {
  if (emp.payType === 'salary') return emp.payRateCents;
  if (hours == null || hours === '') throw new PayrollError('hours are required for hourly employees');
  // overtime is entered separately as overtimeHours
  return Number((BigInt(emp.payRateCents) * BigInt(hundredthsOfHours(hours, 'hours')) + 50n) / 100n);
}

/**
 * Year-to-date wages = SUM over this employee's paychecks in the tax year (voids are negative rows).
 * Computed while the company row is locked, so concurrent paychecks cannot see stale totals.
 */
async function ytdFor(db, companyId, employeeId, year) {
  const { rows: [r] } = await db.query(
    `SELECT coalesce(sum(gross_cents), 0)::bigint AS gross,
            coalesce(sum((calculation->'wages'->>'ficaCents')::bigint), 0)::bigint AS fica,
            max(pay_date) AS last_pay_date
       FROM paychecks WHERE company_id = $1 AND employee_id = $2 AND tax_year = $3`, [companyId, employeeId, year]);
  const f = r.fica;
  return {
    ytd: { grossCents: r.gross, ficaWagesCents: f, medicareWagesCents: f, futaWagesCents: f, suiWagesCents: f, stateInsWagesCents: f },
    lastPayDate: r.last_pay_date,
  };
}

async function compute(db, companyId, employeeId, input) {
  if (!isIsoDate(input.payDate)) throw new LedgerError('payDate must be YYYY-MM-DD');
  const company = await getCompany(db, companyId);
  const emp = await getEmployee(db, companyId, employeeId);
  if (!emp.active) throw new PayrollError('Employee is inactive');
  const year = Number(input.payDate.slice(0, 4)); // taxes follow the PAY date, not the work period
  const { ytd, lastPayDate } = await ytdFor(db, companyId, employeeId, year);
  let gross = grossFor(emp, input);
  let overtime = null;
  if (input.overtimeHours != null && input.overtimeHours !== '') {
    if (emp.payType !== 'hourly') throw new PayrollError('overtime hours apply to hourly employees only');
    const h = hundredthsOfHours(input.overtimeHours, 'overtime hours');
    const otPay = Number((BigInt(emp.payRateCents) * 3n * BigInt(h) + 100n) / 200n); // 1.5x, rounded half-up
    // The 0.5x premium is tracked separately: needed for year-end reporting of qualified overtime.
    const premium = Number((BigInt(emp.payRateCents) * BigInt(h) + 100n) / 200n);
    overtime = { hundredthsOfHours: h, payCents: otPay, premiumCents: premium };
    gross += otPay;
  }
  const result = calculatePaycheck({
    year, payFrequency: emp.payFrequency, grossCents: gross,
    preTaxDeductions: input.preTaxDeductions ?? [],
    employee: { workState: emp.workState, w4: emp.w4, stateElections: emp.stateElections },
    ytd,
    company: { suiRatePct: company.sui_rate_pct ?? undefined, famliHeadcount: company.famli_headcount },
  });
  result.overtime = overtime;
  return { company, emp, result, lastPayDate };
}

export async function previewPaycheck(db, companyId, employeeId, input) {
  const { emp, result } = await compute(db, companyId, employeeId, input);
  return { employee: emp, ...result };
}

/**
 * Record a paycheck. input.paidFromAccountId (a bank account) books net pay as paid from that account;
 * without it, net pay waits in "Net Pay Payable" until a payment is recorded.
 * input.idempotencyKey makes a double-submitted request return the first result instead of paying twice.
 */
export async function postPaycheck(pool, companyId, employeeId, input, { actor = null } = {}) {
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]); // serialize YTD math
    if (input.idempotencyKey) {
      const { rows: [dup] } = await c.query('SELECT id, journal_entry_id, calculation FROM paychecks WHERE company_id = $1 AND idempotency_key = $2', [companyId, String(input.idempotencyKey)]);
      if (dup) return { paycheckId: dup.id, journalEntryId: dup.journal_entry_id, duplicate: true, ...dup.calculation };
    }
    const { company, emp, result, lastPayDate } = await compute(c, companyId, employeeId, input);
    if (lastPayDate && input.payDate < lastPayDate) {
      throw new PayrollError(`Paychecks must be entered in date order; last paycheck for this employee is ${lastPayDate}`);
    }
    if (!result.tablesVerified && !company.calculate_only_payroll) {
      throw new PayrollError('Tax tables are not certified by the Professional Review Board; switch the company to calculate-only payroll');
    }
    const { rows: accts } = await c.query('SELECT id, system_key FROM accounts WHERE company_id = $1 AND system_key IS NOT NULL', [companyId]);
    const byKey = new Map(accts.map((a) => [a.system_key, a.id]));
    if (input.paidFromAccountId) {
      const { rows: [bank] } = await c.query(`SELECT id FROM accounts WHERE company_id = $1 AND id::text = $2 AND cash_flow = 'cash' AND is_active`, [companyId, String(input.paidFromAccountId)]);
      if (!bank) throw new PayrollError('"Paid from" must be one of your bank accounts');
      byKey.set('net_pay_payable', bank.id);
    }
    const lines = paycheckJournalLines(result).map((l) => {
      const accountId = byKey.get(l.accountKey);
      if (!accountId) throw new PayrollError(`Company is missing system account "${l.accountKey}"`);
      return { accountId, debitCents: l.debitCents, creditCents: l.creditCents };
    });
    const entry = validateEntry({ date: input.payDate, memo: `Payroll: ${emp.firstName} ${emp.lastName}`, lines });
    const je = await insertEntry(c, companyId, entry, { source: 'payroll', sourceRef: employeeId, actor });
    const { rows: [pc] } = await c.query(
      `INSERT INTO paychecks (company_id, employee_id, pay_date, tax_year, gross_cents, net_pay_cents, calculation, tables_verified, journal_entry_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [companyId, employeeId, input.payDate, result.year, result.grossCents, result.netPayCents, JSON.stringify(result), result.tablesVerified, je.id, input.idempotencyKey ? String(input.idempotencyKey) : null],
    );
    await appendAudit(c, companyId, { action: 'create', entity: 'paycheck', entityId: pc.id, actor, payload: { employeeId, payDate: input.payDate, grossCents: result.grossCents, netPayCents: result.netPayCents, journalEntryId: je.id } });
    return { paycheckId: pc.id, journalEntryId: je.id, entryNumber: je.entry_number, employee: emp, ...result };
  });
}

/**
 * Void a paycheck: reverses its journal entry and records a negative paycheck row so year-to-date
 * wages (and the Social Security / FUTA / state wage bases) drop back. Only the employee's most
 * recent paycheck can be voided, so later paychecks' wage-base math stays valid.
 */
export async function voidPaycheck(pool, companyId, paycheckId, { date, reason, actor = null } = {}) {
  if (!(typeof reason === 'string' && reason.trim().length >= 3)) throw new PayrollError('A reason is required to void a paycheck');
  return withTransaction(pool, async (c) => {
    const { rows: [co] } = await c.query('SELECT * FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (!co) throw new LedgerError('Company not found');
    const { rows: [pc] } = await c.query('SELECT * FROM paychecks WHERE company_id = $1 AND id::text = $2', [companyId, String(paycheckId)]);
    if (!pc) throw new LedgerError('Paycheck not found');
    if (pc.voids_paycheck_id) throw new PayrollError('This is already a void record');
    const { rows: [already] } = await c.query('SELECT 1 FROM paychecks WHERE company_id = $1 AND voids_paycheck_id = $2', [companyId, pc.id]);
    if (already) throw new PayrollError('This paycheck has already been voided');
    const { rows: [latest] } = await c.query(
      `SELECT id FROM paychecks WHERE company_id = $1 AND employee_id = $2 AND tax_year = $3 AND voids_paycheck_id IS NULL
          AND id NOT IN (SELECT voids_paycheck_id FROM paychecks WHERE company_id = $1 AND voids_paycheck_id IS NOT NULL)
        ORDER BY pay_date DESC, created_at DESC LIMIT 1`, [companyId, pc.employee_id, pc.tax_year]);
    if (latest.id !== pc.id) throw new PayrollError('Only the most recent paycheck for an employee can be voided; void later ones first');
    const voidDate = date ?? pc.pay_date;
    if (!isIsoDate(voidDate) || voidDate < pc.pay_date) throw new PayrollError('Void date must be on or after the pay date');
    if (voidDate.slice(0, 4) !== String(pc.tax_year)) throw new PayrollError('A paycheck must be voided in the same tax year; otherwise issue a correction');
    const { rows: lines } = await c.query(
      `SELECT account_id AS "accountId", credit_cents AS "debitCents", debit_cents AS "creditCents"
         FROM journal_lines WHERE company_id = $1 AND entry_id = $2 ORDER BY id`, [companyId, pc.journal_entry_id]);
    const entry = validateEntry({ date: voidDate, memo: `Void paycheck: ${reason.trim()}`, lines });
    const je = await insertEntry(c, companyId, entry, { source: 'reversal', reversesEntryId: pc.journal_entry_id, actor });
    const calc = pc.calculation;
    const neg = (x) => -x;
    const voidCalc = {
      voidOf: pc.id, reason: reason.trim(), grossCents: neg(calc.grossCents), netPayCents: neg(calc.netPayCents),
      wages: { incomeTaxCents: neg(calc.wages.incomeTaxCents), ficaCents: neg(calc.wages.ficaCents) },
      employeeTaxes: calc.employeeTaxes.map((t) => ({ ...t, amountCents: neg(t.amountCents), taxableCents: neg(t.taxableCents) })),
      employerTaxes: calc.employerTaxes.map((t) => ({ ...t, amountCents: neg(t.amountCents), taxableCents: neg(t.taxableCents) })),
    };
    const { rows: [v] } = await c.query(
      `INSERT INTO paychecks (company_id, employee_id, pay_date, tax_year, gross_cents, net_pay_cents, calculation, tables_verified, journal_entry_id, voids_paycheck_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [companyId, pc.employee_id, voidDate, pc.tax_year, -pc.gross_cents, -pc.net_pay_cents, JSON.stringify(voidCalc), pc.tables_verified, je.id, pc.id]);
    await appendAudit(c, companyId, { action: 'void', entity: 'paycheck', entityId: pc.id, actor, payload: { voidRecordId: v.id, reason: reason.trim(), journalEntryId: je.id } });
    return { voidRecordId: v.id, journalEntryId: je.id, entryNumber: je.entry_number };
  });
}

export async function listPaychecks(db, companyId, { year } = {}) {
  const { rows } = await db.query(
    `SELECT p.id, p.pay_date AS "payDate", p.gross_cents AS "grossCents", p.net_pay_cents AS "netPayCents",
            p.tables_verified AS "tablesVerified", p.voids_paycheck_id AS "voidsPaycheckId",
            EXISTS (SELECT 1 FROM paychecks v WHERE v.voids_paycheck_id = p.id) AS voided, e.first_name || ' ' || e.last_name AS employee, p.calculation
       FROM paychecks p JOIN employees e ON e.id = p.employee_id
      WHERE p.company_id = $1 AND ($2::int IS NULL OR p.tax_year = $2)
      ORDER BY p.pay_date DESC, p.created_at DESC`, [companyId, year ?? null]);
  return rows;
}

export { PAY_PERIODS };
