import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as payroll from '../src/services/payrollService.js';
import * as reports from '../src/services/reportService.js';

test('payroll posting against PostgreSQL', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Lone Star Framing', homeState: 'TX' });
  const emp = await payroll.createEmployee(pool, co.id, {
    firstName: 'Ana', lastName: 'Diaz', workState: 'TX', payFrequency: 'biweekly', payType: 'hourly', payRate: '25.00',
    w4: { filingStatus: 'single' },
  });

  await t.test('preview hourly paycheck with overtime', async () => {
    const p = await payroll.previewPaycheck(pool, co.id, emp.id, { payDate: '2026-01-09', hours: '80', overtimeHours: '4.5' });
    assert.equal(p.grossCents, 200_000 + 16_875); // 80×25 + 4.5×37.50
  });

  await t.test('post paychecks; YTD carries forward; books stay balanced', async () => {
    const first = await payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-01-09', hours: '80' });
    assert.equal(first.grossCents, 200_000);
    assert.equal(first.ytdAfter.futaWagesCents, 200_000);
    for (const d of ['2026-01-23', '2026-02-06', '2026-02-20']) await payroll.postPaycheck(pool, co.id, emp.id, { payDate: d, hours: '80' });
    // 4th paycheck: FUTA base is $7,000 → only $1,000 taxable on the 4th check ($6,000 already)
    const list = await payroll.listPaychecks(pool, co.id, { year: 2026 });
    assert.equal(list.length, 4);
    const fourth = list[0].calculation;
    assert.equal(fourth.employerTaxes.find((x) => x.code === 'FUTA').amountCents, 600);
    assert.equal(fourth.employerTaxes.find((x) => x.code === 'TX_SUI').amountCents, 5_400);
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(tb.balanced, true);
    const is = await reports.getIncomeStatement(pool, co.id, { from: '2026-01-01', to: '2026-12-31' });
    assert.equal(is.operatingExpenses.lines.find((l) => l.code === '6400').amountCents, 800_000);
  });

  await t.test('payroll entries cannot be reversed directly; voiding restores YTD (board finding #4)', async () => {
    const list = await payroll.listPaychecks(pool, co.id, { year: 2026 });
    const latest = list[0];
    const { rows: [pc] } = await pool.query('SELECT journal_entry_id FROM paychecks WHERE id = $1', [latest.id]);
    await assert.rejects(ledger.reverseEntry(pool, co.id, pc.journal_entry_id), /void the paycheck/);
    await assert.rejects(payroll.voidPaycheck(pool, co.id, list[1].id, { reason: 'wrong' }), /most recent/);
    await payroll.voidPaycheck(pool, co.id, latest.id, { reason: 'Hours entered twice' });
    await assert.rejects(payroll.voidPaycheck(pool, co.id, latest.id, { reason: 'again' }), /already been voided/);
    // Re-issue: YTD is back to $6,000, so FUTA is again 0.6% × $1,000
    const again = await payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-02-20', hours: '80' });
    assert.equal(again.employerTaxes.find((x) => x.code === 'FUTA').amountCents, 600);
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(tb.balanced, true);
  });

  await t.test('net pay paid from checking; idempotency key prevents double pay (board finding #5)', async () => {
    const accts = await ledger.listAccounts(pool, co.id);
    const checking = accts.find((a) => a.code === '1000').id;
    const before = (await reports.getBalanceSheet(pool, co.id, { asOf: '2026-12-31' })).liabilities.lines.find((l) => l.code === '2300').amountCents;
    const a = await payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-03-06', hours: '80', paidFromAccountId: checking, idempotencyKey: 'run-0306-ana' });
    const b = await payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-03-06', hours: '80', paidFromAccountId: checking, idempotencyKey: 'run-0306-ana' });
    assert.equal(a.paycheckId, b.paycheckId);
    assert.equal(b.duplicate, true);
    const after = (await reports.getBalanceSheet(pool, co.id, { asOf: '2026-12-31' })).liabilities.lines.find((l) => l.code === '2300').amountCents;
    assert.equal(after, before, 'net pay did not go to Net Pay Payable');
  });

  await t.test('concurrent paychecks get correct, distinct YTD (security B2)', async () => {
    const sal = await payroll.createEmployee(pool, co.id, { firstName: 'Sam', lastName: 'Lee', workState: 'TX', payFrequency: 'monthly', payType: 'salary', payRate: '2000', w4: {} });
    await Promise.all(Array.from({ length: 8 }, () => payroll.postPaycheck(pool, co.id, sal.id, { payDate: '2026-04-30' })));
    const { rows } = await pool.query(`SELECT (calculation->'ytdAfter'->>'futaWagesCents')::bigint AS f FROM paychecks WHERE employee_id = $1 ORDER BY f`, [sal.id]);
    assert.deepEqual(rows.map((r) => r.f), [200_000, 400_000, 600_000, 700_000, 700_000, 700_000, 700_000, 700_000].map((x, i) => Math.min((i + 1) * 200_000, 1_600_000)));
  });

  await t.test('payroll register: one row per paycheck, voids as negative rows, every row ties', async () => {
    const kim = await payroll.createEmployee(pool, co.id, { firstName: 'Kim', lastName: 'Ortiz', workState: 'TX', payFrequency: 'biweekly', payType: 'hourly', payRate: '30.00', w4: {} });
    const ded = [{ name: '401(k)', amountCents: 12_000, kind: 'retirement_401k' }];
    const a = await payroll.postPaycheck(pool, co.id, kim.id, { payDate: '2026-05-15', hours: '80', overtimeHours: '2', preTaxDeductions: ded });
    await payroll.postPaycheck(pool, co.id, kim.id, { payDate: '2026-05-29', hours: '80', preTaxDeductions: ded });
    const second = (await payroll.listPaychecks(pool, co.id)).find((p) => p.payDate === '2026-05-29');
    await payroll.voidPaycheck(pool, co.id, second.id, { reason: 'Paid twice', date: '2026-05-29' });
    const reg = await payroll.getPayrollRegister(pool, co.id, { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(reg.ties, true);
    assert.equal(reg.rows.length, 3);
    const [first, orig, voidRow] = reg.rows;
    assert.equal(first.hours, '82.00');
    assert.equal(first.grossCents, a.grossCents); // 80 × 30 + 2 × 45 = $2,490
    assert.equal(first.grossCents, 249_000);
    assert.equal(first.deductions['401(k)'], 12_000);
    assert.equal(orig.note, 'Voided on 2026-05-29');
    assert.equal(voidRow.note, 'Void of the 2026-05-29 paycheck');
    assert.deepEqual([voidRow.hours, voidRow.grossCents, voidRow.deductions['401(k)']], ['-80.00', -240_000, -12_000]);
    // Net effect of the month is the one good paycheck.
    assert.deepEqual([reg.totals.hours, reg.totals.grossCents, reg.totals.deductions['401(k)'], reg.totals.netPayCents], ['82.00', 249_000, 12_000, a.netPayCents]);
    assert.equal(reg.totals.employerCostCents, 249_000 + a.employerTaxes.reduce((t, x) => t + x.amountCents, 0));
    assert.deepEqual(reg.deductionColumns, [{ key: '401(k)', label: '401(k)' }]);
    // The stub's year-to-date 401(k) is back to one paycheck's worth after the void.
    const stub = await payroll.getPayStub(pool, co.id, voidRow.paycheckId);
    assert.equal(stub.deductions[0].ytdCents, 12_000);
  });

  await t.test('paychecks must be entered in date order', async () => {
    await assert.rejects(payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-02-01', hours: '80' }), /date order/);
    await assert.rejects(payroll.previewPaycheck(pool, co.id, emp.id, { payDate: '2026-05-01', hours: 'lots' }), /must be a number/);
  });

  await t.test('live (non calculate-only) payroll is refused while tables are uncertified', async () => {
    await ledger.updateCompanySettings(pool, co.id, { calculateOnlyPayroll: false });
    await assert.rejects(payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-03-06', hours: '80' }), /not certified/);
  });
});
