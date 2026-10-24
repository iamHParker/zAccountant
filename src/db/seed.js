// Creates a demo company with a few months of activity, so you can click around.
//   npm run seed
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import * as ledger from '../services/ledgerService.js';
import * as payroll from '../services/payrollService.js';

const pool = createPool();
try {
  await migrate(pool);
  const co = await ledger.createCompany(pool, { name: 'Demo Structural Engineering LLC', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const y = new Date().getFullYear();
  const s = (date, memo, from, to, amount) => ledger.postSimple(pool, co.id, { date: `${y}-${date}`, memo, fromAccountId: A[from], toAccountId: A[to], amount });
  await s('01-02', 'Owner investment', '3000', '1000', '40000');
  await s('01-05', 'January office rent', '1000', '6300', '1850');
  await s('01-12', 'Laptop and plotter', '1000', '1500', '6200');
  await s('01-20', 'Foundation design — Smith residence', '4100', '1000', '7500');
  await s('02-05', 'February office rent', '1000', '6300', '1850');
  await s('02-10', 'Professional liability insurance', '1000', '6150', '2400');
  await s('02-25', 'Retaining wall calcs — Hill Country Builders', '4100', '1000', '12000');
  await s('03-01', 'Software subscriptions', '2100', '6200', '389.97');
  const emp = await payroll.createEmployee(pool, co.id, {
    firstName: 'Jordan', lastName: 'Reyes', workState: 'TX', payFrequency: 'biweekly', payType: 'hourly', payRate: '32.50',
    w4: { filingStatus: 'single' },
  });
  await payroll.postPaycheck(pool, co.id, emp.id, { payDate: `${y}-01-16`, hours: '80' });
  await payroll.postPaycheck(pool, co.id, emp.id, { payDate: `${y}-01-30`, hours: '80', overtimeHours: '6' });
  console.log(`Demo company created: ${co.name}`);
} finally {
  await pool.end();
}
