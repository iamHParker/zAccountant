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

  await t.test('paychecks must be entered in date order', async () => {
    await assert.rejects(payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-02-01', hours: '80' }), /date order/);
  });

  await t.test('live (non calculate-only) payroll is refused while tables are uncertified', async () => {
    await ledger.updateCompanySettings(pool, co.id, { calculateOnlyPayroll: false });
    await assert.rejects(payroll.postPaycheck(pool, co.id, emp.id, { payDate: '2026-03-06', hours: '80' }), /not certified/);
  });
});
