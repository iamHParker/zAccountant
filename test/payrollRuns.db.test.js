import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as payroll from '../src/services/payrollService.js';
import * as reports from '../src/services/reportService.js';

test('payroll runs, pay stubs and tax liabilities', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Front Range Steel', homeState: 'CO' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const mk = (x) => payroll.createEmployee(pool, co.id, { workState: 'CO', payFrequency: 'biweekly', w4: { filingStatus: 'single' }, ...x });
  const ana = await mk({ firstName: 'Ana', lastName: 'Diaz', payType: 'hourly', payRate: '30.00', ssn: '123-45-6789' });
  const ben = await mk({ firstName: 'Ben', lastName: 'Cole', payType: 'salary', payRate: '2500.00' });
  await mk({ firstName: 'Cy', lastName: 'Monthly', payType: 'salary', payRate: '4000.00', payFrequency: 'monthly' });
  const run1 = { payFrequency: 'biweekly', periodStart: '2026-01-01', periodEnd: '2026-01-14', payDate: '2026-01-16', paidFromAccountId: A['1000'] };

  await t.test('preview lists problems per employee and saves nothing', async () => {
    const p = await payroll.previewRun(pool, co.id, run1);
    assert.equal(p.paychecks.length, 1);                 // Ben (salary); Ana needs hours
    assert.match(p.problems[0], /Ana Diaz: hours are required/);
    await assert.rejects(payroll.postRun(pool, co.id, run1), /Ana Diaz: hours are required/);
    assert.equal((await payroll.listPaychecks(pool, co.id)).length, 0, 'nothing posted when one paycheck fails');
    await assert.rejects(payroll.previewRun(pool, co.id, { ...run1, periodEnd: '2025-12-01' }), /start on or before end/);
    await assert.rejects(payroll.previewRun(pool, co.id, { ...run1, payFrequency: 'weekly' }), /no active weekly employees/);
  });

  let run;
  await t.test('posting a run pays everyone on the schedule at once', async () => {
    const opts = { ...run1, items: [{ employeeId: ana.id, hours: '80', overtimeHours: '2' }, { employeeId: ben.id }], idempotencyKey: 'run-2026-01-16' };
    run = await payroll.postRun(pool, co.id, opts);
    assert.equal(run.paycheckCount, 2);
    assert.equal(run.grossCents, 240_000 + 9_000 + 250_000);   // 80×30 + 2×45 + salary
    assert.equal(run.paychecks.length, 2);
    const again = await payroll.postRun(pool, co.id, opts);
    assert.equal(again.id, run.id);
    assert.equal(again.duplicate, true);
    await assert.rejects(payroll.postRun(pool, co.id, { ...opts, idempotencyKey: 'run-other-key' }), /already paid on 2026-01-16/);
    const list = await payroll.listRuns(pool, co.id);
    assert.equal(list.length, 1);
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(tb.balanced, true);
  });

  await t.test('pay stub shows this check and year-to-date', async () => {
    await payroll.postRun(pool, co.id, { ...run1, periodStart: '2026-01-15', periodEnd: '2026-01-28', payDate: '2026-01-30',
      items: [{ employeeId: ana.id, hours: '80' }, { employeeId: ben.id }] });
    const pcs = await payroll.listPaychecks(pool, co.id, { year: 2026 });
    const anaSecond = pcs.find((p) => p.employee === 'Ana Diaz' && p.payDate === '2026-01-30');
    const stub = await payroll.getPayStub(pool, co.id, anaSecond.id);
    assert.equal(stub.employee.ssnLast4, '6789');
    assert.equal(JSON.stringify(stub).includes('123456789'), false, 'full SSN never on a stub');
    assert.deepEqual([stub.periodStart, stub.periodEnd, stub.payDate], ['2026-01-15', '2026-01-28', '2026-01-30']);
    assert.equal(stub.grossCents, 240_000);
    assert.equal(stub.ytdGrossCents, 240_000 + 249_000);
    assert.deepEqual(stub.earnings[0], { label: 'Regular pay', amountCents: 240_000, hours: 80, rateCents: 3000 });
    const ss = stub.employeeTaxes.find((x) => x.code === 'SS');
    assert.equal(ss.ytdCents, Math.round(489_000 * 0.062));   // SS on both checks
    const sumYtd = stub.employeeTaxes.reduce((s, x) => s + x.ytdCents, 0);
    assert.equal(stub.ytdNetPayCents, stub.ytdGrossCents - sumYtd);
    // The first stub's YTD stops at the first check.
    const first = pcs.find((p) => p.employee === 'Ana Diaz' && p.payDate === '2026-01-16');
    const s1 = await payroll.getPayStub(pool, co.id, first.id);
    assert.equal(s1.ytdGrossCents, 249_000);
    assert.equal(s1.earnings[1].label, 'Overtime (1.5×)');
    assert.equal(s1.earnings[1].rateCents, 4500);
  });

  await t.test('tax liability report adds up to the payroll entries in the books', async () => {
    const r = await payroll.getPayrollLiabilities(pool, co.id, { from: '2026-01-01', to: '2026-01-31' });
    assert.equal(r.paychecks, 4);
    const irs = r.agencies.find((a) => a.form.startsWith('Form 941'));
    assert.ok(irs.lines.some((l) => l.code === 'FIT') && irs.lines.some((l) => l.code === 'SS_ER'));
    assert.ok(r.agencies.some((a) => a.agency === 'Colorado Dept. of Revenue'));
    assert.ok(r.agencies.some((a) => a.agency === 'Colorado FAMLI'));
    // Nothing deposited yet: what's owed in the tax liability accounts equals the taxes calculated.
    const owedTaxes = r.unpaid.filter((u) => !['net_pay_payable', 'deductions_payable'].includes(u.key)).reduce((s, u) => s + u.owedCents, 0);
    assert.equal(owedTaxes, r.totalCents);
    assert.equal(r.unpaid.find((u) => u.key === 'net_pay_payable').owedCents, 0, 'net pay was paid from checking');
    // Record a 941 deposit like a user would (liability ← checking); the unpaid balance drops.
    const fica = r.unpaid.find((u) => u.key === 'fica_payable');
    await ledger.postSimple(pool, co.id, { date: '2026-02-14', fromAccountId: A['1000'], toAccountId: A['2320'], amountCents: fica.owedCents, memo: '941 deposit' });
    const after = await payroll.getPayrollLiabilities(pool, co.id, { from: '2026-01-01', to: '2026-02-28' });
    assert.equal(after.unpaid.find((u) => u.key === 'fica_payable').owedCents, 0);
    await assert.rejects(payroll.getPayrollLiabilities(pool, co.id, { from: '2026-02-01', to: '2026-01-01' }), /date range/);
  });

  await t.test('double time (California) is paid at 2× and shown on the stub', async () => {
    const ca = await payroll.createEmployee(pool, co.id, { firstName: 'Cal', lastName: 'Ifornia', workState: 'CA', payFrequency: 'weekly', payType: 'hourly', payRate: '20.00', w4: { filingStatus: 'single' } });
    const r = await payroll.postRun(pool, co.id, { payFrequency: 'weekly', periodStart: '2026-03-01', periodEnd: '2026-03-07', payDate: '2026-03-13', paidFromAccountId: A['1000'],
      items: [{ employeeId: ca.id, hours: '40', overtimeHours: '4', doubleTimeHours: '1.5' }] });
    assert.equal(r.grossCents, 40 * 2000 + 4 * 3000 + 1.5 * 4000);
    const pc = (await payroll.listPaychecks(pool, co.id)).find((p) => p.employee === 'Cal Ifornia');
    const stub = await payroll.getPayStub(pool, co.id, pc.id);
    assert.deepEqual(stub.earnings.map((e) => [e.label, e.amountCents, e.hours]), [['Regular pay', 80_000, 40], ['Overtime (1.5×)', 12_000, 4], ['Double time (2×)', 6_000, 1.5]]);
    await assert.rejects(payroll.previewPaycheck(pool, co.id, ben.id, { payDate: '2026-03-13', doubleTimeHours: '1' }), /hourly employees only/);
  });
});
