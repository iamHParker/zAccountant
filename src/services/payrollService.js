// Payroll: employees, paycheck preview, and paycheck posting (engine result -> journal entry).
import { withTransaction } from '../db/pool.js';
import { calculatePaycheck, paycheckJournalLines, PayrollError, PAY_PERIODS, SUPPORTED_STATES } from '../payroll/engine.js';
import { validateEntry, isIsoDate, LedgerError } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { insertEntry, getCompany } from './ledgerService.js';
import { appendAudit } from './audit.js';
import { encryptField } from '../security/crypto.js';

const EMP_COLS = `id, first_name AS "firstName", last_name AS "lastName", work_state AS "workState",
  pay_frequency AS "payFrequency", pay_type AS "payType", pay_rate_cents AS "payRateCents",
  w4, state_elections AS "stateElections", active, ssn_last4 AS "ssnLast4"`;

/** Validate a Social Security number (format and IRS/SSA never-issued ranges). Returns 9 digits or throws. */
export function cleanSsn(ssn) {
  const d = String(ssn).replace(/[\s-]/g, '');
  if (!/^\d{9}$/.test(d)) throw new LedgerError('Employee is not valid', ['SSN must be 9 digits']);
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
  if (area === '000' || area === '666' || area[0] === '9' || group === '00' || serial === '0000') {
    throw new LedgerError('Employee is not valid', ['that is not a valid SSN']);
  }
  return d;
}

export async function createEmployee(pool, companyId, e, { actor = null } = {}) {
  const errors = [];
  const okName = (n) => typeof n === 'string' && n.trim().length > 0 && n.length <= 100;
  if (!okName(e.firstName) || !okName(e.lastName)) errors.push('first and last name are required (up to 100 characters)');
  if (e.w4 != null && (typeof e.w4 !== 'object' || Array.isArray(e.w4))) errors.push('w4 must be an object');
  if (e.stateElections != null && (typeof e.stateElections !== 'object' || Array.isArray(e.stateElections))) errors.push('stateElections must be an object');
  if (!SUPPORTED_STATES.includes(e.workState)) errors.push('work state must be TX, CO, CA or DC');
  if (!['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(e.payFrequency)) errors.push('invalid pay frequency');
  if (!['salary', 'hourly'].includes(e.payType)) errors.push('pay type must be salary or hourly');
  let rate;
  try { rate = toCents(e.payRate); } catch (err) { errors.push(`pay rate: ${err.message}`); }
  if (rate != null && (rate <= 0 || rate > 100_000_000)) errors.push('pay rate must be between $0.01 and $1,000,000');
  if (errors.length) throw new LedgerError('Employee is not valid', errors);
  // SSN is encrypted with a key held outside the database; only the last 4 digits are stored readable.
  const ssn = e.ssn ? cleanSsn(e.ssn) : null;
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [emp] } = await c.query(
      `INSERT INTO employees (company_id, first_name, last_name, work_state, pay_frequency, pay_type, pay_rate_cents, w4, state_elections, ssn_enc, ssn_last4)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${EMP_COLS}`,
      [companyId, e.firstName.trim(), e.lastName.trim(), e.workState, e.payFrequency, e.payType, rate,
        JSON.stringify(e.w4 ?? {}), JSON.stringify(e.stateElections ?? {}),
        ssn ? encryptField(ssn, `company:${companyId}`) : null, ssn ? ssn.slice(5) : null],
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

/** Optional pay period (the days worked) shown on the pay stub. Taxes still follow the pay date. */
function cleanPeriod({ periodStart, periodEnd, payDate }) {
  if (!periodStart && !periodEnd) return { start: null, end: null };
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodEnd < periodStart) throw new PayrollError('Pay period must be two dates, start on or before end');
  if (isIsoDate(payDate) && payDate < periodStart) throw new PayrollError('Pay date cannot be before the pay period starts');
  return { start: periodStart, end: periodEnd };
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
  result.regularHours = emp.payType === 'hourly' ? hundredthsOfHours(input.hours, 'hours') / 100 : null;
  result.payRateCents = emp.payRateCents;
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
    const period = cleanPeriod(input);
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
      `INSERT INTO paychecks (company_id, employee_id, pay_date, tax_year, gross_cents, net_pay_cents, calculation, tables_verified, journal_entry_id, idempotency_key, run_id, period_start, period_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [companyId, employeeId, input.payDate, result.year, result.grossCents, result.netPayCents, JSON.stringify(result), result.tablesVerified, je.id, input.idempotencyKey ? String(input.idempotencyKey) : null,
        input.runId ?? null, period.start, period.end],
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

// ---------------------------------------------------------------- Payroll runs

const RUN_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

/**
 * Work out who is in a run: everyone active on this pay schedule, unless `items` names them.
 * Each item: { employeeId, hours, overtimeHours, preTaxDeductions }. Returns [{ emp, input }].
 */
async function runMembers(db, companyId, { payFrequency, payDate, periodStart, periodEnd, paidFromAccountId, items }) {
  const errors = [];
  if (!RUN_FREQUENCIES.includes(payFrequency)) errors.push('choose a pay schedule (weekly, biweekly, semimonthly or monthly)');
  if (!isIsoDate(payDate)) errors.push('pay date must be YYYY-MM-DD');
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodEnd < periodStart) errors.push('pay period must be two dates, start on or before end');
  else if (isIsoDate(payDate) && payDate < periodStart) errors.push('pay date cannot be before the pay period starts');
  if (errors.length) throw new PayrollError(`Payroll is not valid: ${errors.join('; ')}`);
  const emps = (await db.query(`SELECT ${EMP_COLS} FROM employees WHERE company_id = $1 AND active AND pay_frequency = $2 ORDER BY last_name, first_name`, [companyId, payFrequency])).rows;
  const given = Array.isArray(items) ? new Map(items.map((i) => [i?.employeeId, i])) : null;
  if (given) {
    for (const id of given.keys()) if (!emps.some((e) => e.id === id)) errors.push('one of the employees is not active on this pay schedule');
    if (given.size !== items.length) errors.push('an employee is listed twice');
  }
  const members = emps.filter((e) => !given || given.has(e.id)).map((emp) => {
    const i = given?.get(emp.id) ?? {};
    return { emp, input: { payDate, periodStart, periodEnd, paidFromAccountId, hours: i.hours, overtimeHours: i.overtimeHours, preTaxDeductions: i.preTaxDeductions ?? [] } };
  });
  if (!members.length) errors.push(`no active ${payFrequency} employees to pay`);
  if (errors.length) throw new PayrollError(`Payroll is not valid: ${[...new Set(errors)].join('; ')}`);
  return members;
}

const runTotals = (results) => ({
  paycheckCount: results.length,
  grossCents: results.reduce((t, r) => t + r.grossCents, 0),
  netPayCents: results.reduce((t, r) => t + r.netPayCents, 0),
  employeeTaxCents: results.reduce((t, r) => t + r.employeeTaxTotalCents, 0),
  employerTaxCents: results.reduce((t, r) => t + r.employerTaxTotalCents, 0),
  deductionCents: results.reduce((t, r) => t + r.totalDeductionsCents, 0),
});

/** Calculate every paycheck in a run without saving anything. Problems are listed per employee. */
export async function previewRun(db, companyId, opts) {
  const members = await runMembers(db, companyId, opts);
  const rows = [];
  const problems = [];
  for (const m of members) {
    try {
      const { result } = await compute(db, companyId, m.emp.id, m.input);
      rows.push({ employee: m.emp, ...result });
    } catch (e) {
      if (!(e instanceof PayrollError || e instanceof LedgerError)) throw e;
      problems.push(`${m.emp.firstName} ${m.emp.lastName}: ${e.message}`);
    }
  }
  return { payFrequency: opts.payFrequency, payDate: opts.payDate, periodStart: opts.periodStart, periodEnd: opts.periodEnd,
    paychecks: rows, problems, totals: runTotals(rows) };
}

/** Post a whole run in one transaction: either every paycheck is recorded or none is. */
export async function postRun(pool, companyId, opts, { actor = null } = {}) {
  const key = opts.idempotencyKey ? String(opts.idempotencyKey).slice(0, 120) : null;
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (key) {
      const { rows: [dup] } = await c.query('SELECT id FROM payroll_runs WHERE company_id = $1 AND idempotency_key = $2', [companyId, key]);
      if (dup) return { ...(await getRun(c, companyId, dup.id)), duplicate: true };
    }
    const { rows: [same] } = await c.query('SELECT pay_date FROM payroll_runs WHERE company_id = $1 AND pay_frequency = $2 AND period_start = $3',
      [companyId, opts.payFrequency, opts.periodStart]);
    if (same) throw new PayrollError(`This ${opts.payFrequency} pay period starting ${opts.periodStart} was already paid on ${same.pay_date}`);
    const pre = await previewRun(c, companyId, opts);
    if (pre.problems.length) throw new PayrollError(`Payroll was not recorded: ${pre.problems.join('; ')}`);
    const t = pre.totals;
    const { rows: [run] } = await c.query(
      `INSERT INTO payroll_runs (company_id, pay_frequency, period_start, period_end, pay_date, paid_from_account_id, paycheck_count, gross_cents, net_pay_cents,
         employee_tax_cents, employer_tax_cents, deduction_cents, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [companyId, opts.payFrequency, opts.periodStart, opts.periodEnd, opts.payDate, opts.paidFromAccountId || null, t.paycheckCount, t.grossCents, t.netPayCents,
        t.employeeTaxCents, t.employerTaxCents, t.deductionCents, key, actor]);
    const members = await runMembers(c, companyId, opts);
    for (const m of members) await postPaycheck(c, companyId, m.emp.id, { ...m.input, runId: run.id }, { actor });
    await appendAudit(c, companyId, { action: 'create', entity: 'payroll_run', entityId: run.id, actor,
      payload: { payFrequency: opts.payFrequency, periodStart: opts.periodStart, periodEnd: opts.periodEnd, payDate: opts.payDate, ...t } });
    return getRun(c, companyId, run.id);
  });
}

export async function getRun(db, companyId, runId) {
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new LedgerError('Payroll run not found');
  const { rows: [r] } = await db.query('SELECT * FROM payroll_runs WHERE company_id = $1 AND id = $2', [companyId, runId]);
  if (!r) throw new LedgerError('Payroll run not found');
  const { rows: pcs } = await db.query(
    `SELECT p.id, e.first_name || ' ' || e.last_name AS employee, p.gross_cents AS "grossCents", p.net_pay_cents AS "netPayCents",
            EXISTS (SELECT 1 FROM paychecks v WHERE v.voids_paycheck_id = p.id) AS voided
       FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.company_id = $1 AND p.run_id = $2 ORDER BY e.last_name, e.first_name`, [companyId, r.id]);
  return { ...runOut(r), paychecks: pcs };
}

const runOut = (r) => ({
  id: r.id, payFrequency: r.pay_frequency, periodStart: r.period_start, periodEnd: r.period_end, payDate: r.pay_date, paidFromAccountId: r.paid_from_account_id,
  paycheckCount: r.paycheck_count, grossCents: r.gross_cents, netPayCents: r.net_pay_cents, employeeTaxCents: r.employee_tax_cents,
  employerTaxCents: r.employer_tax_cents, deductionCents: r.deduction_cents, createdBy: r.created_by, createdAt: r.created_at,
});

export async function listRuns(db, companyId, { limit = 50 } = {}) {
  const { rows } = await db.query('SELECT * FROM payroll_runs WHERE company_id = $1 ORDER BY pay_date DESC, created_at DESC LIMIT $2', [companyId, Math.min(Number(limit) || 50, 500)]);
  return rows.map(runOut);
}

// ---------------------------------------------------------------- Pay stubs

/**
 * Everything a pay stub shows: this check and year-to-date (through this check, voids included),
 * for earnings, pre-tax deductions, each tax withheld, and net pay. Employer taxes are listed for
 * the employer's copy. Only the last 4 digits of the SSN appear.
 */
export async function getPayStub(db, companyId, paycheckId) {
  if (typeof paycheckId !== 'string' || !/^[0-9a-f-]{36}$/i.test(paycheckId)) throw new LedgerError('Paycheck not found');
  const { rows: [pc] } = await db.query('SELECT * FROM paychecks WHERE company_id = $1 AND id = $2', [companyId, paycheckId]);
  if (!pc) throw new LedgerError('Paycheck not found');
  const emp = await getEmployee(db, companyId, pc.employee_id);
  const company = await getCompany(db, companyId);
  const { rows: upTo } = await db.query(
    `SELECT gross_cents, net_pay_cents, calculation FROM paychecks
      WHERE company_id = $1 AND employee_id = $2 AND tax_year = $3
        AND (pay_date, created_at) <= (SELECT pay_date, created_at FROM paychecks WHERE id = $4)`, // exact (µs) timestamps
    [companyId, pc.employee_id, pc.tax_year, pc.id]);
  const sumBy = (field) => {
    const m = new Map();
    for (const r of upTo) for (const t of r.calculation[field] ?? []) {
      const k = t.code ?? t.name;
      m.set(k, (m.get(k) ?? 0) + t.amountCents);
    }
    return m;
  };
  const ytdEe = sumBy('employeeTaxes');
  const ytdEr = sumBy('employerTaxes');
  const ytdDed = sumBy('deductions');
  const calc = pc.calculation;
  const ytdGross = upTo.reduce((t, r) => t + r.gross_cents, 0);
  const ytdNet = upTo.reduce((t, r) => t + r.net_pay_cents, 0);
  const regular = calc.grossCents - (calc.overtime?.payCents ?? 0);
  // Rate and hours as they were on this paycheck (older paychecks didn't record them: shown blank).
  const rate = calc.payRateCents ?? null;
  const hourly = calc.regularHours != null;
  const earnings = [{ label: hourly ? 'Regular pay' : 'Salary', amountCents: regular, hours: hourly ? calc.regularHours : null, rateCents: hourly ? rate : null }];
  if (calc.overtime) {
    earnings.push({ label: 'Overtime (1.5×)', amountCents: calc.overtime.payCents, hours: calc.overtime.hundredthsOfHours / 100,
      rateCents: rate == null ? null : Number((BigInt(rate) * 3n + 1n) / 2n) });
  }
  const { rows: [v] } = await db.query('SELECT pay_date FROM paychecks WHERE company_id = $1 AND voids_paycheck_id = $2', [companyId, pc.id]);
  return {
    paycheckId: pc.id, employer: { name: company.name, state: company.home_state },
    employee: { name: `${emp.firstName} ${emp.lastName}`, ssnLast4: emp.ssnLast4, workState: emp.workState, payType: emp.payType, payFrequency: emp.payFrequency },
    payDate: pc.pay_date, periodStart: pc.period_start, periodEnd: pc.period_end, taxYear: pc.tax_year,
    isVoidRecord: Boolean(pc.voids_paycheck_id), voidedOn: v?.pay_date ?? null,
    earnings, grossCents: calc.grossCents, ytdGrossCents: ytdGross,
    deductions: (calc.deductions ?? []).map((d) => ({ label: d.name, amountCents: d.amountCents, ytdCents: ytdDed.get(d.name) ?? 0 })),
    employeeTaxes: (calc.employeeTaxes ?? []).map((t) => ({ code: t.code, label: t.label, amountCents: t.amountCents, ytdCents: ytdEe.get(t.code) ?? 0 })),
    employerTaxes: (calc.employerTaxes ?? []).map((t) => ({ code: t.code, label: t.label, amountCents: t.amountCents, ytdCents: ytdEr.get(t.code) ?? 0 })),
    netPayCents: calc.netPayCents, ytdNetPayCents: ytdNet,
    tablesVerified: pc.tables_verified,
  };
}

// ---------------------------------------------------------------- Payroll tax liabilities

// Which return / deposit each tax belongs to, so the owner knows what to pay where.
const AGENCY = (code, state) => {
  if (['FIT', 'SS', 'SS_ER', 'MED', 'MED_ER', 'MED_ADDL'].includes(code)) return { agency: 'IRS', form: 'Form 941 (federal deposit)' };
  if (code === 'FUTA') return { agency: 'IRS', form: 'Form 940 (FUTA)' };
  const s = code.slice(0, 2);
  const names = { CA: 'California EDD', CO: 'Colorado', DC: 'District of Columbia', TX: 'Texas Workforce Commission' };
  if (code === 'CO_PIT') return { agency: 'Colorado Dept. of Revenue', form: 'CO wage withholding' };
  if (code.startsWith('CO_FAMLI')) return { agency: 'Colorado FAMLI', form: 'FAMLI premiums' };
  if (code === 'CO_SUI' || code === 'CO_SUI_ADMIN') return { agency: 'Colorado CDLE', form: 'CO unemployment' };
  if (code === 'DC_PIT') return { agency: 'DC Office of Tax and Revenue', form: 'DC withholding' };
  if (code === 'DC_PFL' || code === 'DC_SUI' || code === 'DC_SUI_ADMIN') return { agency: 'DC DOES', form: 'DC unemployment & Paid Family Leave' };
  if (code === 'TX_SUI' || code === 'TX_SUI_ADMIN') return { agency: 'Texas Workforce Commission', form: 'TX unemployment' };
  if (s === 'CA') return { agency: 'California EDD', form: 'DE 9 / DE 88 deposit' };
  return { agency: names[state] ?? state, form: '' };
};

/**
 * Payroll taxes for paychecks dated in [from, to]: each tax withheld from employees and owed by the
 * employer, grouped by the agency it is paid to; plus the balance still owed (unpaid) in each payroll
 * liability account as of `to`. Calculate-only beta: the owner makes these deposits themselves.
 */
export async function getPayrollLiabilities(db, companyId, { from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new LedgerError('Choose a date range (from on or before to)');
  const { rows } = await db.query(
    `SELECT p.calculation, e.work_state FROM paychecks p JOIN employees e ON e.id = p.employee_id
      WHERE p.company_id = $1 AND p.pay_date BETWEEN $2 AND $3`, [companyId, from, to]);
  const byCode = new Map();
  let gross = 0;
  for (const r of rows) {
    gross += r.calculation.grossCents;
    for (const [list, who] of [['employeeTaxes', 'employee'], ['employerTaxes', 'employer']]) {
      for (const t of r.calculation[list] ?? []) {
        const row = byCode.get(t.code) ?? { code: t.code, label: t.label.replace(/ \(employer\)$/, ''), who, ...AGENCY(t.code, r.work_state), amountCents: 0, liabilityKey: t.liabilityKey };
        row.amountCents += t.amountCents;
        byCode.set(t.code, row);
      }
    }
  }
  const lines = [...byCode.values()].filter((x) => x.amountCents !== 0);
  const agencies = new Map();
  for (const l of lines) {
    const k = `${l.agency}|${l.form}`;
    const a = agencies.get(k) ?? { agency: l.agency, form: l.form, totalCents: 0, lines: [] };
    a.lines.push({ code: l.code, label: l.label, who: l.who, amountCents: l.amountCents });
    a.totalCents += l.amountCents;
    agencies.set(k, a);
  }
  const { rows: bal } = await db.query(
    `SELECT a.code, a.name, a.system_key, COALESCE(sum(l.credit_cents - l.debit_cents), 0)::bigint AS owed
       FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id AND l.entry_date <= $2
      WHERE a.company_id = $1 AND a.subtype = 'payroll' AND a.type = 'liability'
      GROUP BY a.id ORDER BY a.code`, [companyId, to]);
  return {
    from, to, paychecks: rows.length, grossCents: gross,
    // Federal first (941 deposit, then 940), then state agencies by name.
    agencies: [...agencies.values()].sort((a, b) => {
      const rank = (x) => (x.form.startsWith('Form 941') ? 0 : x.form.startsWith('Form 940') ? 1 : 2);
      return rank(a) - rank(b) || a.agency.localeCompare(b.agency);
    }),
    totalCents: lines.reduce((t, l) => t + l.amountCents, 0),
    unpaid: bal.map((b) => ({ code: b.code, name: b.name, key: b.system_key, owedCents: b.owed })),
  };
}

export { PAY_PERIODS };
