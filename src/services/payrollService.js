// Payroll: employees, paycheck preview, and paycheck posting (engine result -> journal entry).
import { withTransaction } from '../db/pool.js';
import { calculatePaycheck, paycheckJournalLines, PayrollError, PAY_PERIODS, SUPPORTED_STATES } from '../payroll/engine.js';
import { validateEntry, isIsoDate, LedgerError } from '../core/ledger.js';
import { toCents } from '../core/money.js';
import { insertEntry, getCompany, assertNotCleared } from './ledgerService.js';
import { appendAudit } from './audit.js';
import { encryptField } from '../security/crypto.js';

const EMP_COLS = `id, first_name AS "firstName", last_name AS "lastName", work_state AS "workState",
  pay_frequency AS "payFrequency", pay_type AS "payType", pay_rate_cents AS "payRateCents",
  w4, state_elections AS "stateElections", active, ssn_last4 AS "ssnLast4", user_id AS "userId", address,
  to_char(hire_date, 'YYYY-MM-DD') AS "hireDate", to_char(termination_date, 'YYYY-MM-DD') AS "terminationDate"`;

/** The employee's name as it was on the paycheck (paychecks made before 2026-10 fall back to today's name). */
const PC_NAME = (p, e, lastFirst = false) => lastFirst
  ? `COALESCE(${p}.calculation->'employee'->>'lastName', ${e}.last_name) || ', ' || COALESCE(${p}.calculation->'employee'->>'firstName', ${e}.first_name)`
  : `COALESCE(${p}.calculation->'employee'->>'firstName', ${e}.first_name) || ' ' || COALESCE(${p}.calculation->'employee'->>'lastName', ${e}.last_name)`;

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

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

/** Home address for the W-2: { line1, line2, city, state, zip }, all optional, US only. */
function cleanAddress(a, errors) {
  if (a == null) return {};
  if (!isObj(a)) { errors.push('address must be an object'); return {}; }
  const out = {};
  for (const k of ['line1', 'line2', 'city', 'state', 'zip']) {
    const v = a[k] == null ? '' : String(a[k]).trim();
    if (v.length > 100) errors.push(`address ${k} is too long`);
    if (v) out[k] = v;
  }
  if (out.state) out.state = out.state.toUpperCase();
  if (out.state && !/^[A-Z]{2}$/.test(out.state)) errors.push('address state is two letters, e.g. TX');
  if (out.zip && !/^\d{5}(-\d{4})?$/.test(out.zip)) errors.push('ZIP code is 5 digits (or ZIP+4)');
  return out;
}

/**
 * Check the employee fields that are present (all are required when creating). Returns the cleaned values,
 * in database columns; throws with every problem listed.
 */
function checkEmployee(e, { partial = false } = {}) {
  const errors = [];
  const has = (k) => !partial || e[k] !== undefined;
  const out = {};
  const okName = (n) => typeof n === 'string' && n.trim().length > 0 && n.length <= 100;
  if (has('firstName') || has('lastName')) {
    if ((has('firstName') && !okName(e.firstName)) || (has('lastName') && !okName(e.lastName))) errors.push('first and last name are required (up to 100 characters)');
    if (has('firstName') && okName(e.firstName)) out.first_name = e.firstName.trim();
    if (has('lastName') && okName(e.lastName)) out.last_name = e.lastName.trim();
  }
  if (e.w4 != null && !isObj(e.w4)) errors.push('w4 must be an object');
  else if (e.w4 != null || !partial) out.w4 = JSON.stringify(e.w4 ?? {});
  if (e.stateElections != null && !isObj(e.stateElections)) errors.push('stateElections must be an object');
  else if (e.stateElections != null || !partial) out.state_elections = JSON.stringify(e.stateElections ?? {});
  if (has('workState')) { if (!SUPPORTED_STATES.includes(e.workState)) errors.push('work state must be TX, CO, CA or DC'); else out.work_state = e.workState; }
  if (has('payFrequency')) { if (!PAY_FREQUENCIES.includes(e.payFrequency)) errors.push('invalid pay frequency'); else out.pay_frequency = e.payFrequency; }
  if (has('payType')) { if (!['salary', 'hourly'].includes(e.payType)) errors.push('pay type must be salary or hourly'); else out.pay_type = e.payType; }
  if (has('payRate')) {
    let rate;
    try { rate = toCents(e.payRate); } catch (err) { errors.push(`pay rate: ${err.message}`); }
    if (rate != null && (rate <= 0 || rate > 100_000_000)) errors.push('pay rate must be between $0.01 and $1,000,000');
    else if (rate != null) out.pay_rate_cents = rate;
  }
  if (e.address !== undefined) out.address = JSON.stringify(cleanAddress(e.address, errors));
  if (e.hireDate) { if (!isIsoDate(e.hireDate)) errors.push('hire date must be a date'); else out.hire_date = e.hireDate; }
  if (errors.length) throw new LedgerError('Employee is not valid', errors);
  return out;
}

const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

export async function createEmployee(pool, companyId, e, { actor = null } = {}) {
  const v = checkEmployee(e);
  // SSN is encrypted with a key held outside the database; only the last 4 digits are stored readable.
  const ssn = e.ssn ? cleanSsn(e.ssn) : null;
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [emp] } = await c.query(
      `INSERT INTO employees (company_id, first_name, last_name, work_state, pay_frequency, pay_type, pay_rate_cents, w4, state_elections, ssn_enc, ssn_last4, address, hire_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${EMP_COLS}`,
      [companyId, v.first_name, v.last_name, v.work_state, v.pay_frequency, v.pay_type, v.pay_rate_cents, v.w4, v.state_elections,
        ssn ? encryptField(ssn, `company:${companyId}`) : null, ssn ? ssn.slice(5) : null, v.address ?? '{}', v.hire_date ?? null],
    );
    await appendAudit(c, companyId, { action: 'create', entity: 'employee', entityId: emp.id, actor, payload: { name: `${emp.firstName} ${emp.lastName}`, workState: emp.workState } });
    return emp;
  });
}

const JSON_COLS = new Set(['w4', 'state_elections', 'address']);
// The database stores JSON with its keys reordered, so compare with sorted keys.
const stableJson = (x) => (isObj(x) ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`).join(',')}}` : JSON.stringify(x));

// What the audit trail shows for each changed field (W-4, state forms and SSN: only that they changed).
const AUDIT_SHOWN = { first_name: 'firstName', last_name: 'lastName', work_state: 'workState', pay_frequency: 'payFrequency',
  pay_type: 'payType', pay_rate_cents: 'payRateCents', hire_date: 'hireDate' };

/**
 * Change an employee's details (CPA edit sweep, batch 3). Applies to paychecks from now on: each paycheck already
 * made keeps its own copy of the name, state, pay type and rate it was figured with, so stubs and reports don't move.
 * A new SSN replaces the old one (blank keeps it). Audited field by field.
 */
export async function updateEmployee(pool, companyId, employeeId, e, { actor = null } = {}) {
  if (typeof employeeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(employeeId)) throw new LedgerError('Employee not found');
  const v = checkEmployee(e ?? {}, { partial: true });
  const ssn = e?.ssn ? cleanSsn(e.ssn) : null;
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [old] } = await c.query('SELECT * FROM employees WHERE company_id = $1 AND id = $2', [companyId, employeeId]);
    if (!old) throw new LedgerError('Employee not found');
    if (ssn) { v.ssn_enc = encryptField(ssn, `company:${companyId}`); v.ssn_last4 = ssn.slice(5); }
    const same = (k) => {
      const was = old[k] instanceof Date ? old[k].toISOString().slice(0, 10) : old[k];
      return JSON_COLS.has(k) ? stableJson(was) === stableJson(JSON.parse(v[k])) : String(was) === String(v[k]);
    };
    const changed = Object.keys(v).filter((k) => k !== 'ssn_last4' && !same(k));
    if (!changed.length) return getEmployee(c, companyId, employeeId);
    const cols = [...changed, ...(changed.includes('ssn_enc') ? ['ssn_last4'] : [])];
    await c.query(`UPDATE employees SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE company_id = $1 AND id = $2`,
      [companyId, employeeId, ...cols.map((k) => v[k])]);
    const payload = {};
    for (const k of changed) {
      if (AUDIT_SHOWN[k]) payload[AUDIT_SHOWN[k]] = { from: old[k] instanceof Date ? old[k].toISOString().slice(0, 10) : old[k], to: v[k] };
      else payload[{ ssn_enc: 'ssn', state_elections: 'stateElections' }[k] ?? k] = 'changed';
    }
    await appendAudit(c, companyId, { action: 'update', entity: 'employee', entityId: employeeId, actor, payload });
    return getEmployee(c, companyId, employeeId);
  });
}

/**
 * Terminate (`active: false`, with the last day worked) or rehire (`active: true`, with the new start date).
 * A terminated employee drops out of payroll runs and timesheets, so run the final paycheck first. Their paychecks,
 * W-2 and history stay; rehiring continues the same year-to-date totals.
 */
export async function setEmployeeStatus(pool, companyId, employeeId, { active, date, reason, actor = null } = {}) {
  if (typeof employeeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(employeeId)) throw new LedgerError('Employee not found');
  if (!isIsoDate(date)) throw new LedgerError(active ? 'Enter the date they start again' : 'Enter their last day of work');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [old] } = await c.query(
      `SELECT active, to_char(hire_date, 'YYYY-MM-DD') AS hire, to_char(termination_date, 'YYYY-MM-DD') AS term
         FROM employees WHERE company_id = $1 AND id = $2`, [companyId, employeeId]);
    if (!old) throw new LedgerError('Employee not found');
    if (Boolean(active) === old.active) throw new LedgerError(active ? 'This employee is already active' : 'This employee has already left');
    if (active) {
      if (old.term && date <= old.term) throw new LedgerError(`The new start date must be after their last day (${old.term})`);
      await c.query('UPDATE employees SET active = true, hire_date = $3, termination_date = NULL WHERE company_id = $1 AND id = $2', [companyId, employeeId, date]);
    } else {
      if (old.hire && date < old.hire) throw new LedgerError(`The last day can't be before they started (${old.hire})`);
      await c.query('UPDATE employees SET active = false, termination_date = $3 WHERE company_id = $1 AND id = $2', [companyId, employeeId, date]);
    }
    await appendAudit(c, companyId, { action: active ? 'rehire' : 'terminate', entity: 'employee', entityId: employeeId, actor,
      payload: { date, ...(reason ? { reason: String(reason).slice(0, 200) } : {}) } });
    return getEmployee(c, companyId, employeeId);
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
  // Double time (California: over 12 hours in a day, or over 8 on the 7th day in a row of a workweek).
  let doubleTime = null;
  if (input.doubleTimeHours != null && input.doubleTimeHours !== '') {
    if (emp.payType !== 'hourly') throw new PayrollError('double-time hours apply to hourly employees only');
    const h = hundredthsOfHours(input.doubleTimeHours, 'double-time hours');
    const dtPay = Number((BigInt(emp.payRateCents) * 2n * BigInt(h) + 50n) / 100n);
    doubleTime = { hundredthsOfHours: h, payCents: dtPay };
    gross += dtPay;
  }
  const result = calculatePaycheck({
    year, payFrequency: emp.payFrequency, grossCents: gross, payDate: input.payDate,
    preTaxDeductions: input.preTaxDeductions ?? [],
    employee: { workState: emp.workState, w4: emp.w4, stateElections: emp.stateElections },
    ytd,
    company: { suiRatePct: company.sui_rate_pct ?? undefined, famliHeadcount: company.famli_headcount, futaCreditReductionPct: company.futa_credit_reduction ?? {} },
  });
  result.overtime = overtime;
  result.doubleTime = doubleTime;
  result.regularHours = emp.payType === 'hourly' ? hundredthsOfHours(input.hours, 'hours') / 100 : null;
  result.payRateCents = emp.payRateCents;
  // The paycheck keeps its own copy of who and where, so editing the employee later never changes a past stub.
  result.employee = { firstName: emp.firstName, lastName: emp.lastName, ssnLast4: emp.ssnLast4, workState: emp.workState,
    payType: emp.payType, payFrequency: emp.payFrequency, address: emp.address ?? {} };
  result.employer = { name: company.name, state: company.home_state };
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
    await assertNotCleared(c, companyId, pc.journal_entry_id);
    const { rows: lines } = await c.query(
      `SELECT account_id AS "accountId", credit_cents AS "debitCents", debit_cents AS "creditCents"
         FROM journal_lines WHERE company_id = $1 AND entry_id = $2 ORDER BY id`, [companyId, pc.journal_entry_id]);
    const entry = validateEntry({ date: voidDate, memo: `Void paycheck: ${reason.trim()}`, lines });
    const je = await insertEntry(c, companyId, entry, { source: 'reversal', reversesEntryId: pc.journal_entry_id, actor });
    const calc = pc.calculation;
    const neg = (x) => -x;
    const voidCalc = {
      voidOf: pc.id, reason: reason.trim(), state: calc.state, employee: calc.employee, employer: calc.employer, grossCents: neg(calc.grossCents), netPayCents: neg(calc.netPayCents),
      wages: { incomeTaxCents: neg(calc.wages.incomeTaxCents), ficaCents: neg(calc.wages.ficaCents) },
      deductions: (calc.deductions ?? []).map((d) => ({ ...d, amountCents: neg(d.amountCents) })),
      employeeTaxes: calc.employeeTaxes.map((t) => ({ ...t, amountCents: neg(t.amountCents), taxableCents: neg(t.taxableCents) })),
      employerTaxes: calc.employerTaxes.map((t) => ({ ...t, amountCents: neg(t.amountCents), taxableCents: neg(t.taxableCents) })),
    };
    const { rows: [v] } = await c.query(
      `INSERT INTO paychecks (company_id, employee_id, pay_date, tax_year, gross_cents, net_pay_cents, calculation, tables_verified, journal_entry_id, voids_paycheck_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [companyId, pc.employee_id, voidDate, pc.tax_year, -pc.gross_cents, -pc.net_pay_cents, JSON.stringify(voidCalc), pc.tables_verified, je.id, pc.id]);
    // Timesheet hours this paycheck paid become unpaid again, so the next payroll run picks them up.
    const { rowCount: reopened } = await c.query(
      'UPDATE time_entries SET paid_run_id = NULL, paid_paycheck_id = NULL, updated_at = now() WHERE company_id = $1 AND paid_paycheck_id = $2', [companyId, pc.id]);
    await appendAudit(c, companyId, { action: 'void', entity: 'paycheck', entityId: pc.id, actor, payload: { voidRecordId: v.id, reason: reason.trim(), journalEntryId: je.id, timeEntriesReopened: reopened } });
    return { voidRecordId: v.id, journalEntryId: je.id, entryNumber: je.entry_number, timeEntriesReopened: reopened };
  });
}

export async function listPaychecks(db, companyId, { year } = {}) {
  const { rows } = await db.query(
    `SELECT p.id, p.pay_date AS "payDate", p.gross_cents AS "grossCents", p.net_pay_cents AS "netPayCents",
            p.tables_verified AS "tablesVerified", p.voids_paycheck_id AS "voidsPaycheckId",
            EXISTS (SELECT 1 FROM paychecks v WHERE v.voids_paycheck_id = p.id) AS voided, ${PC_NAME('p', 'e')} AS employee, p.calculation
       FROM paychecks p JOIN employees e ON e.id = p.employee_id
      WHERE p.company_id = $1 AND ($2::int IS NULL OR p.tax_year = $2)
      ORDER BY p.pay_date DESC, p.created_at DESC`, [companyId, year ?? null]);
  return rows;
}

// ---------------------------------------------------------------- Payroll runs

const RUN_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

/**
 * Work out who is in a run: everyone active on this pay schedule, unless `items` names them.
 * Each item: { employeeId, hours, overtimeHours, doubleTimeHours, preTaxDeductions }. Returns [{ emp, input }].
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
    return { emp, input: { payDate, periodStart, periodEnd, paidFromAccountId, hours: i.hours, overtimeHours: i.overtimeHours, doubleTimeHours: i.doubleTimeHours, preTaxDeductions: i.preTaxDeductions ?? [] } };
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
    const { rows: [same] } = await c.query('SELECT pay_date FROM payroll_runs WHERE company_id = $1 AND pay_frequency = $2 AND period_start = $3 AND voided_at IS NULL',
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
    // Hours that came from approved timesheets (this period, plus earlier ones approved late or
    // reopened by a void) are marked paid by this run's paycheck, so they can't be paid twice.
    let timeEntriesPaid = 0;
    for (const m of members) {
      const pc = await postPaycheck(c, companyId, m.emp.id, { ...m.input, runId: run.id }, { actor });
      if (opts.fromTimesheets === true && m.emp.userId) {
        const { rowCount } = await c.query(
          `UPDATE time_entries SET paid_run_id = $2, paid_paycheck_id = $3, updated_at = now()
            WHERE company_id = $1 AND user_id = $4 AND status = 'approved' AND paid_run_id IS NULL AND work_date <= $5`,
          [companyId, run.id, pc.paycheckId, m.emp.userId, opts.periodEnd]);
        timeEntriesPaid += rowCount;
      }
    }
    await appendAudit(c, companyId, { action: 'create', entity: 'payroll_run', entityId: run.id, actor,
      payload: { payFrequency: opts.payFrequency, periodStart: opts.periodStart, periodEnd: opts.periodEnd, payDate: opts.payDate, ...t, timeEntriesPaid } });
    return { ...(await getRun(c, companyId, run.id)), timeEntriesPaid };
  });
}

export async function getRun(db, companyId, runId) {
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new LedgerError('Payroll run not found');
  const { rows: [r] } = await db.query('SELECT * FROM payroll_runs WHERE company_id = $1 AND id = $2', [companyId, runId]);
  if (!r) throw new LedgerError('Payroll run not found');
  const { rows: pcs } = await db.query(
    `SELECT p.id, ${PC_NAME('p', 'e')} AS employee, p.gross_cents AS "grossCents", p.net_pay_cents AS "netPayCents",
            EXISTS (SELECT 1 FROM paychecks v WHERE v.voids_paycheck_id = p.id) AS voided
       FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.company_id = $1 AND p.run_id = $2 ORDER BY e.last_name, e.first_name`, [companyId, r.id]);
  return { ...runOut(r), paychecks: pcs };
}

const runOut = (r) => ({
  id: r.id, payFrequency: r.pay_frequency, periodStart: r.period_start, periodEnd: r.period_end, payDate: r.pay_date, paidFromAccountId: r.paid_from_account_id,
  paycheckCount: r.paycheck_count, grossCents: r.gross_cents, netPayCents: r.net_pay_cents, employeeTaxCents: r.employee_tax_cents,
  employerTaxCents: r.employer_tax_cents, deductionCents: r.deduction_cents, createdBy: r.created_by, createdAt: r.created_at,
  voidDate: r.void_date ?? null, voidReason: r.void_reason ?? null,
});

/**
 * Void a whole payroll run (CPA edit sweep, batch 4): every paycheck in it is voided (newest-first rules apply: a later
 * paycheck for any of these people must be voided first), timesheet hours it paid become unpaid again, and the run is
 * marked void so the same pay period can be run again with the right numbers.
 */
export async function voidRun(pool, companyId, runId, { date, reason, actor = null } = {}) {
  if (!(typeof reason === 'string' && reason.trim().length >= 3)) throw new PayrollError('A reason is required to void a payroll run');
  if (typeof runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(runId)) throw new LedgerError('Payroll run not found');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [r] } = await c.query('SELECT * FROM payroll_runs WHERE company_id = $1 AND id = $2', [companyId, runId]);
    if (!r) throw new LedgerError('Payroll run not found');
    if (r.voided_at) throw new PayrollError('This payroll run is already void');
    const { rows: pcs } = await c.query(
      `SELECT p.id FROM paychecks p WHERE p.company_id = $1 AND p.run_id = $2 AND p.voids_paycheck_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM paychecks v WHERE v.voids_paycheck_id = p.id)`, [companyId, r.id]);
    const voidDate = date || r.pay_date;
    let reopened = 0;
    for (const p of pcs) {
      try {
        reopened += (await voidPaycheck(c, companyId, p.id, { date: voidDate, reason: `Payroll run voided: ${reason.trim()}`, actor })).timeEntriesReopened;
      } catch (e) {
        if (e instanceof PayrollError || e instanceof LedgerError) {
          const { rows: [who] } = await c.query(`SELECT ${PC_NAME('p', 'e')} AS name FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.id = $1`, [p.id]);
          throw new PayrollError(`${who.name}: ${e.message}`);
        }
        throw e;
      }
    }
    await c.query('UPDATE payroll_runs SET void_date = $3, void_reason = $4, voided_by = $5, voided_at = now() WHERE company_id = $1 AND id = $2',
      [companyId, r.id, voidDate, reason.trim(), actor]);
    await appendAudit(c, companyId, { action: 'void', entity: 'payroll_run', entityId: r.id, actor,
      payload: { periodStart: r.period_start, payDate: r.pay_date, voidDate, reason: reason.trim(), paychecksVoided: pcs.length, timeEntriesReopened: reopened } });
    return { ...(await getRun(c, companyId, r.id)), paychecksVoided: pcs.length, timeEntriesReopened: reopened };
  });
}

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
  const regular = calc.grossCents - (calc.overtime?.payCents ?? 0) - (calc.doubleTime?.payCents ?? 0);
  // Rate and hours as they were on this paycheck (older paychecks didn't record them: shown blank).
  const rate = calc.payRateCents ?? null;
  const hourly = calc.regularHours != null;
  const earnings = [{ label: hourly ? 'Regular pay' : 'Salary', amountCents: regular, hours: hourly ? calc.regularHours : null, rateCents: hourly ? rate : null }];
  if (calc.overtime) {
    earnings.push({ label: 'Overtime (1.5×)', amountCents: calc.overtime.payCents, hours: calc.overtime.hundredthsOfHours / 100,
      rateCents: rate == null ? null : Number((BigInt(rate) * 3n + 1n) / 2n) });
  }
  if (calc.doubleTime) {
    earnings.push({ label: 'Double time (2×)', amountCents: calc.doubleTime.payCents, hours: calc.doubleTime.hundredthsOfHours / 100, rateCents: rate == null ? null : rate * 2 });
  }
  const { rows: [v] } = await db.query('SELECT pay_date FROM paychecks WHERE company_id = $1 AND voids_paycheck_id = $2', [companyId, pc.id]);
  return {
    paycheckId: pc.id, employer: calc.employer ?? { name: company.name, state: company.home_state },
    employee: calc.employee
      ? { name: `${calc.employee.firstName} ${calc.employee.lastName}`, ssnLast4: calc.employee.ssnLast4, workState: calc.employee.workState,
        payType: calc.employee.payType, payFrequency: calc.employee.payFrequency, address: calc.employee.address ?? {} }
      : { name: `${emp.firstName} ${emp.lastName}`, ssnLast4: emp.ssnLast4, workState: calc.state ?? emp.workState, payType: emp.payType, payFrequency: emp.payFrequency },
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

// ---------------------------------------------------------------- Payroll register

const hundredthsOf = (calc) => (calc.regularHours == null ? null
  : Math.round(calc.regularHours * 100) + (calc.overtime?.hundredthsOfHours ?? 0) + (calc.doubleTime?.hundredthsOfHours ?? 0));
const hoursText = (h) => (h == null ? null : `${h < 0 ? '-' : ''}${Math.floor(Math.abs(h) / 100)}.${String(Math.abs(h) % 100).padStart(2, '0')}`);

/**
 * Payroll register: every paycheck with a pay date in [from, to], one column per deduction and tax,
 * with totals. Void records appear as negative rows (and the paycheck they cancel is marked), so the
 * totals are what was really paid. Each row ties: gross − deductions − employee taxes = net pay.
 */
export async function getPayrollRegister(db, companyId, { from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new LedgerError('Choose a date range (from on or before to)');
  const { rows } = await db.query(
    `SELECT p.id, to_char(p.pay_date, 'YYYY-MM-DD') AS "payDate", to_char(p.period_start, 'YYYY-MM-DD') AS "periodStart",
            to_char(p.period_end, 'YYYY-MM-DD') AS "periodEnd", p.calculation, o.calculation AS "originalCalc",
            to_char(o.pay_date, 'YYYY-MM-DD') AS "voidsPayDate", ${PC_NAME('p', 'e', true)} AS employee,
            (SELECT to_char(v.pay_date, 'YYYY-MM-DD') FROM paychecks v WHERE v.company_id = p.company_id AND v.voids_paycheck_id = p.id) AS "voidedOn"
       FROM paychecks p JOIN employees e ON e.id = p.employee_id LEFT JOIN paychecks o ON o.id = p.voids_paycheck_id
      WHERE p.company_id = $1 AND p.pay_date BETWEEN $2 AND $3
      ORDER BY p.pay_date, e.last_name, e.first_name, p.created_at`, [companyId, from, to]);
  const cols = { deductions: new Map(), employeeTaxes: new Map(), employerTaxes: new Map() };
  const blankTotals = () => ({ grossCents: 0, netPayCents: 0, deductions: {}, employeeTaxes: {}, employerTaxes: {} });
  const totals = blankTotals();
  const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  let totalHours = null;
  const out = rows.map((r) => {
    const calc = r.calculation;
    const orig = r.originalCalc;
    // Void records made before deductions were copied onto them: take the original's, negated.
    const deductions = calc.deductions ?? (orig?.deductions ?? []).map((d) => ({ ...d, amountCents: -d.amountCents }));
    const hours = orig ? (hundredthsOf(orig) == null ? null : -hundredthsOf(orig)) : hundredthsOf(calc);
    const row = { paycheckId: r.id, payDate: r.payDate, employee: r.employee, periodStart: r.periodStart ?? null, periodEnd: r.periodEnd ?? null,
      hours: hoursText(hours), ...blankTotals(), grossCents: calc.grossCents, netPayCents: calc.netPayCents,
      note: r.voidsPayDate ? `Void of the ${r.voidsPayDate} paycheck` : r.voidedOn ? `Voided on ${r.voidedOn}` : null };
    if (hours != null) totalHours = (totalHours ?? 0) + hours;
    const add = (kind, key, label, cents) => {
      if (!cols[kind].has(key)) cols[kind].set(key, { key, label });
      row[kind][key] = (row[kind][key] ?? 0) + cents;
      totals[kind][key] = (totals[kind][key] ?? 0) + cents;
    };
    for (const d of deductions) add('deductions', d.name, d.name, d.amountCents);
    for (const t of calc.employeeTaxes ?? []) add('employeeTaxes', t.code, t.label, t.amountCents);
    for (const t of calc.employerTaxes ?? []) add('employerTaxes', t.code, t.label.replace(/ \(employer\)$/, ''), t.amountCents);
    totals.grossCents += row.grossCents;
    totals.netPayCents += row.netPayCents;
    row.check = row.grossCents - sumOf(row.deductions) - sumOf(row.employeeTaxes) - row.netPayCents;
    return row;
  });
  totals.hours = hoursText(totalHours);
  totals.employerCostCents = totals.grossCents + sumOf(totals.employerTaxes);
  totals.check = totals.grossCents - sumOf(totals.deductions) - sumOf(totals.employeeTaxes) - totals.netPayCents;
  return {
    from, to, rows: out, totals,
    deductionColumns: [...cols.deductions.values()],
    employeeTaxColumns: [...cols.employeeTaxes.values()],
    employerTaxColumns: [...cols.employerTaxes.values()],
    ties: totals.check === 0 && out.every((r) => r.check === 0),
  };
}

// ---------------------------------------------------------------- Payroll tax liabilities

// Which return / deposit each tax belongs to, so the owner knows what to pay where.
const AGENCY = (code, state) => {
  if (['FIT', 'SS', 'SS_ER', 'MED', 'MED_ER', 'MED_ADDL'].includes(code)) return { agency: 'IRS', form: 'Form 941 (federal deposit)' };
  if (code === 'FUTA' || code === 'FUTA_CR') return { agency: 'IRS', form: 'Form 940 (FUTA)' };
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
// When each agency's deposits are due, in words (the Board checks these; exact dates depend on the
// deposit schedule each agency assigned the company).
const DUE_HINT = (agency, form) => {
  if (form.startsWith('Form 941')) return 'Monthly depositors: by the 15th of the next month. Semiweekly depositors: the Wednesday or Friday after payday. Under $2,500 for the quarter: with Form 941 (IRS Pub 15).';
  if (form.startsWith('Form 940')) return 'Once more than $500 is owed: by the last day of the month after the quarter ends (IRS Pub 15).';
  if (agency === 'California EDD') return 'Withholding and SDI follow a schedule based on your federal deposit schedule and amount; UI and ETT are paid with them (DE 44, DE 88).';
  if (agency === 'Colorado Dept. of Revenue') return 'On the filing frequency Colorado DOR assigned you (weekly, monthly or quarterly).';
  if (agency === 'Colorado FAMLI') return 'Quarterly, by the last day of the month after the quarter ends.';
  if (agency === 'DC Office of Tax and Revenue') return 'On the filing frequency DC OTR assigned you.';
  return 'Quarterly, by the last day of the month after the quarter ends.';
};

/**
 * Payroll taxes for paychecks dated in a range, by agency, with deposits recorded for that range
 * and what is still due. Each agency's amounts are also split by liability account, which is what
 * a deposit pays down.
 */
export async function getPayrollLiabilities(db, companyId, { from, to }) {
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new LedgerError('Choose a date range (from on or before to)');
  const { rows } = await db.query(
    `SELECT p.calculation, COALESCE(p.calculation->>'state', o.calculation->>'state', e.work_state) AS work_state
       FROM paychecks p JOIN employees e ON e.id = p.employee_id LEFT JOIN paychecks o ON o.id = p.voids_paycheck_id
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
  const blank = (agency, form) => ({ agency, form, totalCents: 0, lines: [], byKey: {}, depositedCents: 0, depositedByKey: {}, deposits: [], dueCents: 0, dueHint: DUE_HINT(agency, form) });
  for (const l of lines) {
    const k = `${l.agency}|${l.form}`;
    const a = agencies.get(k) ?? blank(l.agency, l.form);
    a.lines.push({ code: l.code, label: l.label, who: l.who, amountCents: l.amountCents });
    a.totalCents += l.amountCents;
    a.byKey[l.liabilityKey] = (a.byKey[l.liabilityKey] ?? 0) + l.amountCents;
    agencies.set(k, a);
  }
  // Deposits recorded for periods inside this range (void rows are negative and cancel their original).
  const { rows: deps } = await db.query(
    `SELECT d.id, d.agency, d.form, to_char(d.period_start, 'YYYY-MM-DD') AS "periodStart", to_char(d.period_end, 'YYYY-MM-DD') AS "periodEnd",
            to_char(d.deposit_date, 'YYYY-MM-DD') AS "depositDate", d.amount_cents::bigint AS "amountCents", d.lines, d.reference, d.voids_deposit_id AS "voidsDepositId",
            EXISTS (SELECT 1 FROM payroll_deposits v WHERE v.company_id = d.company_id AND v.voids_deposit_id = d.id) AS voided
       FROM payroll_deposits d WHERE d.company_id = $1 AND d.period_start >= $2 AND d.period_end <= $3 ORDER BY d.deposit_date, d.created_at`, [companyId, from, to]);
  for (const d of deps) {
    const k = `${d.agency}|${d.form}`;
    const a = agencies.get(k) ?? blank(d.agency, d.form);
    a.depositedCents += Number(d.amountCents);
    for (const l of d.lines) a.depositedByKey[l.liabilityKey] = (a.depositedByKey[l.liabilityKey] ?? 0) + l.amountCents;
    if (!d.voidsDepositId) a.deposits.push({ id: d.id, depositDate: d.depositDate, periodStart: d.periodStart, periodEnd: d.periodEnd, amountCents: Number(d.amountCents), reference: d.reference, voided: d.voided });
    agencies.set(k, a);
  }
  for (const a of agencies.values()) a.dueCents = a.totalCents - a.depositedCents;
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
    depositedCents: [...agencies.values()].reduce((t, a) => t + a.depositedCents, 0),
    unpaid: bal.map((b) => ({ code: b.code, name: b.name, key: b.system_key, owedCents: b.owed })),
  };
}

/**
 * Record a tax deposit to one agency for a date range: pays whatever is still due for that agency
 * and range, account by account (Dr each payroll liability, Cr the bank account).
 */
export async function recordDeposit(pool, companyId, { agency, form = '', periodStart, periodEnd, depositDate, paidFromAccountId, reference, idempotencyKey }, { actor = null } = {}) {
  const key = idempotencyKey ? String(idempotencyKey).slice(0, 120) : null;
  if (!isIsoDate(depositDate)) throw new PayrollError('Deposit date must be YYYY-MM-DD');
  if (isIsoDate(periodStart) && depositDate < periodStart) throw new PayrollError('The deposit date can\'t be before the period starts');
  const ref = typeof reference === 'string' && reference.trim() ? reference.trim().slice(0, 100) : null;
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (key) {
      const { rows: [dup] } = await c.query('SELECT id FROM payroll_deposits WHERE company_id = $1 AND idempotency_key = $2', [companyId, key]);
      if (dup) return { id: dup.id, duplicate: true };
    }
    const report = await getPayrollLiabilities(c, companyId, { from: periodStart, to: periodEnd });
    // A deposit already recorded for a period that straddles this one would be counted in neither.
    const { rows: [straddle] } = await c.query(
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS s, to_char(period_end, 'YYYY-MM-DD') AS e FROM payroll_deposits d
        WHERE company_id = $1 AND agency = $2 AND form = $3 AND voids_deposit_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payroll_deposits v WHERE v.company_id = d.company_id AND v.voids_deposit_id = d.id)
          AND period_start <= $5 AND period_end >= $4 AND NOT (period_start >= $4 AND period_end <= $5) LIMIT 1`,
      [companyId, agency, form ?? '', periodStart, periodEnd]);
    if (straddle) throw new PayrollError(`A deposit to ${agency} for ${straddle.s} to ${straddle.e} overlaps this period; record deposits for whole periods that don't cross`);
    const a = report.agencies.find((x) => x.agency === agency && x.form === (form ?? ''));
    if (!a) throw new PayrollError('No payroll taxes for that agency in this period');
    const due = Object.entries(a.byKey).map(([liabilityKey, owed]) => ({ liabilityKey, amountCents: owed - (a.depositedByKey[liabilityKey] ?? 0) }))
      .filter((l) => l.amountCents !== 0);
    const total = due.reduce((t, l) => t + l.amountCents, 0);
    if (total <= 0 || due.some((l) => l.amountCents < 0)) throw new PayrollError('Nothing is due to that agency for this period');
    const { rows: [bank] } = await c.query(`SELECT id FROM accounts WHERE company_id = $1 AND id::text = $2 AND cash_flow = 'cash' AND is_active`, [companyId, String(paidFromAccountId ?? '')]);
    if (!bank) throw new PayrollError('"Paid from" must be one of your bank accounts');
    const { rows: accts } = await c.query('SELECT id, system_key FROM accounts WHERE company_id = $1 AND system_key IS NOT NULL', [companyId]);
    const byKey = new Map(accts.map((x) => [x.system_key, x.id]));
    const jl = due.map((l) => {
      const accountId = byKey.get(l.liabilityKey);
      if (!accountId) throw new PayrollError(`Company is missing system account "${l.liabilityKey}"`);
      return { accountId, debitCents: l.amountCents, creditCents: 0 };
    });
    jl.push({ accountId: bank.id, debitCents: 0, creditCents: total });
    const label = `${agency}${form ? ` (${form})` : ''}`;
    const entry = validateEntry({ date: depositDate, memo: `Payroll tax deposit: ${label}, ${periodStart} to ${periodEnd}${ref ? ` · ${ref}` : ''}`.slice(0, 500), lines: jl });
    const je = await insertEntry(c, companyId, entry, { source: 'payroll', sourceRef: 'deposit', actor });
    const { rows: [d] } = await c.query(
      `INSERT INTO payroll_deposits (company_id, agency, form, period_start, period_end, deposit_date, paid_from_account_id, amount_cents, lines, reference, journal_entry_id, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [companyId, agency, form ?? '', periodStart, periodEnd, depositDate, bank.id, total, JSON.stringify(due), ref, je.id, key, actor]);
    await appendAudit(c, companyId, { action: 'create', entity: 'payroll_deposit', entityId: d.id, actor, payload: { agency, form, periodStart, periodEnd, depositDate, amountCents: total, journalEntryId: je.id } });
    return { id: d.id, amountCents: total, lines: due, journalEntryId: je.id, entryNumber: je.entry_number };
  });
}

/** Undo a deposit recorded by mistake: reversing entry plus a negative deposit row. */
export async function voidDeposit(pool, companyId, depositId, { date, actor = null } = {}) {
  if (typeof depositId !== 'string' || !/^[0-9a-f-]{36}$/i.test(depositId)) throw new LedgerError('Deposit not found');
  return withTransaction(pool, async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const { rows: [d] } = await c.query('SELECT * FROM payroll_deposits WHERE company_id = $1 AND id = $2', [companyId, depositId]);
    if (!d) throw new LedgerError('Deposit not found');
    if (d.voids_deposit_id) throw new PayrollError('This is already a void record');
    const { rows: [already] } = await c.query('SELECT 1 FROM payroll_deposits WHERE company_id = $1 AND voids_deposit_id = $2', [companyId, d.id]);
    if (already) throw new PayrollError('This deposit has already been voided');
    const depDate = d.deposit_date instanceof Date ? d.deposit_date.toISOString().slice(0, 10) : String(d.deposit_date);
    const voidDate = date ?? depDate;
    if (!isIsoDate(voidDate) || voidDate < depDate) throw new PayrollError('Void date must be on or after the deposit date');
    await assertNotCleared(c, companyId, d.journal_entry_id);
    const { rows: lines } = await c.query(
      `SELECT account_id AS "accountId", credit_cents AS "debitCents", debit_cents AS "creditCents"
         FROM journal_lines WHERE company_id = $1 AND entry_id = $2 ORDER BY id`, [companyId, d.journal_entry_id]);
    const entry = validateEntry({ date: voidDate, memo: `Void payroll tax deposit: ${d.agency}`, lines });
    const je = await insertEntry(c, companyId, entry, { source: 'reversal', reversesEntryId: d.journal_entry_id, actor });
    const { rows: [v] } = await c.query(
      `INSERT INTO payroll_deposits (company_id, agency, form, period_start, period_end, deposit_date, paid_from_account_id, amount_cents, lines, reference, journal_entry_id, voids_deposit_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [companyId, d.agency, d.form, d.period_start, d.period_end, voidDate, d.paid_from_account_id, -Number(d.amount_cents),
        JSON.stringify(d.lines.map((l) => ({ ...l, amountCents: -l.amountCents }))), d.reference, je.id, d.id, actor]);
    await appendAudit(c, companyId, { action: 'void', entity: 'payroll_deposit', entityId: d.id, actor, payload: { voidRecordId: v.id, journalEntryId: je.id } });
    return { voidRecordId: v.id, journalEntryId: je.id };
  });
}

export { PAY_PERIODS };
