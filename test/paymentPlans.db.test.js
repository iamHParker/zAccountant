// Payment plans (Homer, 2026-10-29): community work paid in monthly parts, no interest. A family on schedule is never
// past due; the aging report ages each missed part from its own date and still ties to Accounts Receivable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';

test('payment plans: on schedule is not late; missed parts age from their own dates', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Plan Co', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const fam = await arap.createContact(pool, co.id, { kind: 'customer', name: 'A Family' });
  // 2,000.00 in 8 monthly payments of 250.00, Nov 1 2026 … Jun 1 2027. The invoice is due in full on the last one.
  const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: fam.id, date: '2026-10-15', dueDate: '2026-10-30',
    lines: [{ accountId: A['4100'], amount: '2000' }], plan: { count: 8, firstDue: '2026-11-01' } });
  assert.equal(inv.dueDate, '2027-06-01');
  assert.deepEqual([inv.plan.count, inv.plan.schedule.length, inv.plan.schedule[7].amountCents], [8, 8, 25000]);
  const pay = (date, amount) => arap.createPayment(pool, co.id, { kind: 'received', contactId: fam.id, date, accountId: A['1000'], method: 'check',
    applications: [{ documentId: inv.id, amount }] });
  await pay('2026-10-30', '250'); await pay('2026-11-28', '250');

  // Dec 20: two paid, on schedule. Nothing past due, though the invoice date is two months back.
  let doc = await arap.getDocument(pool, co.id, inv.id, { today: '2026-12-20' });
  assert.deepEqual([doc.status, doc.plan.pastDueCents, doc.plan.next.dueDate], ['partial', 0, '2027-01-01']);
  let aging = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-12-20' });
  assert.deepEqual([aging.totals.current, aging.totals.d1_30, aging.ties], [150000, 0, true]);
  assert.equal((await arap.listContacts(pool, co.id, { kind: 'customer', asOf: '2026-12-20' }))[0].overdueCents, 0);

  // Feb 15: Jan 1 and Feb 1 missed. 250.00 is 45 days late (31–60), 250.00 is 14 days late (1–30), 1,000.00 not due.
  doc = await arap.getDocument(pool, co.id, inv.id, { today: '2027-02-15' });
  assert.deepEqual([doc.status, doc.plan.pastDueCents], ['overdue', 50000]);
  aging = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2027-02-15' });
  assert.deepEqual([aging.totals.current, aging.totals.d1_30, aging.totals.d31_60, aging.totals.totalCents, aging.ties], [100000, 25000, 25000, 150000, true]);
  assert.equal((await arap.listContacts(pool, co.id, { kind: 'customer', asOf: '2027-02-15' }))[0].overdueCents, 50000);

  // The plan can be changed later without touching the books: stretched to 10 payments of 200.00 from Nov 1.
  doc = await arap.updateDocumentDetails(pool, co.id, inv.id, { plan: { count: 10, firstDue: '2026-11-01' } });
  assert.deepEqual([doc.plan.count, doc.dueDate, doc.totalCents], [10, '2027-08-01', 200000]);
  // Removing it leaves the due date where the plan put it.
  doc = await arap.updateDocumentDetails(pool, co.id, inv.id, { plan: null });
  assert.deepEqual([doc.plan, doc.dueDate], [null, '2027-08-01']);
  await assert.rejects(arap.createDocument(pool, co.id, { kind: 'bill', contactId: fam.id, number: 'B1', date: '2026-10-15',
    lines: [{ accountId: A['6200'], amount: '10' }], plan: { count: 2, firstDue: '2026-11-01' } }), /not valid/);
});
