import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as reports from '../src/services/reportService.js';
import * as bank from '../src/services/bankService.js';
import { verifyChain } from '../src/services/audit.js';
import { runBooksCheck } from '../src/jobs/booksCheck.js';

test('line amounts are exact (quantity × price, half-up)', () => {
  assert.equal(arap.lineAmount('1', 12345), 12345);
  assert.equal(arap.lineAmount('2.5', 8000), 20000);
  assert.equal(arap.lineAmount('0.3333', 100), 33);        // 33.33¢ → 33¢
  assert.equal(arap.lineAmount('1.5', 1), 2);              // 1.5¢ → 2¢ (half-up)
  assert.equal(arap.lineAmount('3', 3333), 9999);
  assert.throws(() => arap.lineAmount('1.23456', 100), /4 decimals/);
  assert.throws(() => arap.lineAmount('-1', 100), /Quantity/);
  // Costs split across jobs (Homer, 2026-10-24): quantity "1/N", price ÷ N divided exactly, rounded once.
  assert.equal(arap.lineAmount('1/3', 35000), 11667);      // motel $350.00 ÷ 3 = $116.666… → $116.67
  assert.equal(arap.lineAmount('1/2', 45001), 22501);      // $450.01 ÷ 2 = $225.005 → $225.01 (half-up)
  assert.equal(arap.lineAmount('1/4', 120000), 30000);     // airfare $1,200.00 ÷ 4 = $300.00
  assert.equal(arap.lineAmount('1/1', 9999), 9999);
  assert.throws(() => arap.lineAmount('1/0', 100), /divide by 0/);
  assert.equal(arap.bucketFor(-5), 'current');
  assert.equal(arap.bucketFor(0), 'current');
  assert.equal(arap.bucketFor(1), 'd1_30');
  assert.equal(arap.bucketFor(31), 'd31_60');
  assert.equal(arap.bucketFor(91), 'over90');
});

test('AR/AP: invoice → payment → reports tie', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Structures LLC', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const bal = async (code, asOf = '2026-12-31') => (await reports.getTrialBalance(pool, co.id, { asOf })).rows.find((r) => r.code === code);
  let acme; let bob; let lumber; let inv1; let inv2; let bill1;

  await t.test('customers and vendors', async () => {
    acme = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Acme Engineering', email: 'ap@acme.example', termsDays: 30 });
    bob = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Bob Builder', termsDays: 15 });
    lumber = await arap.createContact(pool, co.id, { kind: 'vendor', name: 'Austin Lumber', is1099: true });
    await assert.rejects(arap.createContact(pool, co.id, { kind: 'customer', name: ' acme engineering ' }), /already a customer/);
    await assert.rejects(arap.createContact(pool, co.id, { kind: 'customer', name: 'X', is1099: true }), /vendors only/);
    await assert.rejects(arap.createContact(pool, co.id, { kind: 'vendor', name: 'Y', email: 'nope' }), /email/);
    // Same name may be both a customer and a vendor.
    await arap.createContact(pool, co.id, { kind: 'vendor', name: 'Acme Engineering' });
    const upd = await arap.updateContact(pool, co.id, bob.id, { phone: '512-555-0100', termsDays: 10 });
    assert.equal(upd.termsDays, 10);
    assert.equal(upd.name, 'Bob Builder');
  });

  await t.test('invoice with sales tax posts AR, income and tax', async () => {
    inv1 = await arap.createDocument(pool, co.id, {
      kind: 'invoice', contactId: acme.id, date: '2026-03-01', taxRate: '8.25',
      lines: [
        { accountId: A['4100'], description: 'Foundation design', quantity: '12.5', unitPrice: '150.00' },  // $1,875.00
        { accountId: A['4000'], description: 'Anchor bolts', quantity: '3', unitPrice: '33.33', taxable: true }, // $99.99 → tax $8.25
      ],
    });
    assert.equal(inv1.number, '1001');
    assert.equal(inv1.dueDate, '2026-03-31');
    assert.deepEqual([inv1.subtotalCents, inv1.taxCents, inv1.totalCents, inv1.balanceCents], [197499, 825, 198324, 198324]);
    assert.equal((await bal('1100')).debitCents, 198324);
    assert.equal((await bal('2200')).creditCents, 825);
    assert.equal((await bal('4100')).creditCents, 187500);
    inv2 = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: bob.id, date: '2026-04-10', lines: [{ accountId: A['4100'], amount: '500' }] });
    assert.equal(inv2.number, '1002');
    assert.equal(inv2.dueDate, '2026-04-20'); // Bob's terms are now 10 days
    const own = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: bob.id, number: 'A-7', date: '2026-04-11', lines: [{ accountId: A['4100'], amount: '1' }] });
    assert.equal(own.number, 'A-7');
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: bob.id, number: 'a-7', date: '2026-04-11', lines: [{ accountId: A['4100'], amount: '1' }] }), /already used/);
    await arap.voidDocument(pool, co.id, own.id);
  });

  await t.test('invoice validation', async () => {
    const bad = (x) => arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-03-01', lines: [{ accountId: A['4100'], amount: '10' }], ...x });
    await assert.rejects(bad({ lines: [] }), /at least one line/);
    await assert.rejects(bad({ lines: [{ accountId: A['1000'], amount: '10' }] }), /can't be used/);
    await assert.rejects(bad({ lines: [{ accountId: A['1100'], amount: '10' }] }), /can't be used/);
    await assert.rejects(bad({ lines: [{ accountId: A['4100'], amount: '-10' }] }), /negative/);
    await assert.rejects(bad({ lines: [{ accountId: A['4100'], amount: '0' }] }), /more than \$0.00/);
    await assert.rejects(bad({ taxRate: '8.25' }), /taxable/);
    await assert.rejects(bad({ taxRate: '25' }), /20%/);
    await assert.rejects(bad({ dueDate: '2026-02-01' }), /due date/);
    await assert.rejects(bad({ contactId: lumber.id }), /choose a customer/);
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'bill', contactId: lumber.id, date: '2026-03-01', lines: [{ accountId: A['6200'], amount: '10' }] }), /bill or invoice number/);
  });

  await t.test('idempotent save: a retried click creates one invoice', async () => {
    const args = { kind: 'invoice', contactId: bob.id, date: '2026-05-01', lines: [{ accountId: A['4100'], amount: '75' }], idempotencyKey: 'inv-click-0001' };
    const a = await arap.createDocument(pool, co.id, args);
    const b = await arap.createDocument(pool, co.id, args);
    assert.equal(a.id, b.id);
    assert.equal(b.replayed, true);
    await arap.voidDocument(pool, co.id, a.id);
  });

  await t.test('bills: vendor bill number can only be entered once', async () => {
    bill1 = await arap.createDocument(pool, co.id, {
      kind: 'bill', contactId: lumber.id, number: 'INV-5521', date: '2026-03-05', memo: 'Job 12 framing',
      lines: [{ accountId: A['5000'], description: '2x10 joists', quantity: '40', unitPrice: '18.75' }, { accountId: A['6600'], description: 'Delivery', amount: '45' }],
    });
    assert.equal(bill1.totalCents, 79500);
    assert.equal(bill1.dueDate, '2026-04-04');
    assert.equal((await bal('2000')).creditCents, 79500);
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'bill', contactId: lumber.id, number: 'inv-5521', date: '2026-03-06', lines: [{ accountId: A['5000'], amount: '1' }] }), /already entered/);
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'bill', contactId: lumber.id, number: 'T1', taxRate: '8', date: '2026-03-06', lines: [{ accountId: A['5000'], amount: '1' }] }), /invoices only/);
  });

  await t.test('AR/AP accounts can only change through invoices, bills and payments', async () => {
    await assert.rejects(ledger.postSimple(pool, co.id, { date: '2026-03-10', fromAccountId: A['1100'], toAccountId: A['1000'], amount: '5' }), /Sales tab/);
    await assert.rejects(ledger.postEntry(pool, co.id, { date: '2026-03-10', lines: [{ accountId: A['6200'], debit: '5' }, { accountId: A['2000'], credit: '5' }] }), /Bills tab/);
    await assert.rejects(ledger.reverseEntry(pool, co.id, inv1.journalEntryId), /void it there/);
    await assert.rejects(ledger.createRecurring(pool, co.id, { name: 'x', frequency: 'monthly', startDate: '2026-03-10', lines: [{ accountId: A['1100'], debit: '5' }, { accountId: A['4100'], credit: '5' }] }), /Sales tab/);
  });

  let pay1;
  await t.test('payments: partial, then the rest, never more than the balance', async () => {
    pay1 = await arap.createPayment(pool, co.id, { kind: 'received', contactId: acme.id, date: '2026-03-20', accountId: A['1000'], method: 'check', reference: '4471',
      applications: [{ documentId: inv1.id, amount: '1000.00' }] });
    assert.equal(pay1.amountCents, 100000);
    let d = await arap.getDocument(pool, co.id, inv1.id);
    assert.deepEqual([d.paidCents, d.balanceCents, d.status], [100000, 98324, 'partial']);
    await assert.rejects(arap.createPayment(pool, co.id, { kind: 'received', contactId: acme.id, date: '2026-03-21', accountId: A['1000'], applications: [{ documentId: inv1.id, amount: '983.25' }] }), /more than its balance of \$983.24/);
    await assert.rejects(arap.createPayment(pool, co.id, { kind: 'received', contactId: bob.id, date: '2026-03-21', accountId: A['1000'], applications: [{ documentId: inv1.id, amount: '1' }] }), /not one of Bob Builder/);
    await assert.rejects(arap.createPayment(pool, co.id, { kind: 'received', contactId: bob.id, date: '2026-04-01', accountId: A['1000'], applications: [{ documentId: inv2.id, amount: '1' }] }), /after this payment/);
    await assert.rejects(arap.createPayment(pool, co.id, { kind: 'received', contactId: acme.id, date: '2026-03-21', accountId: A['6200'], applications: [{ documentId: inv1.id, amount: '1' }] }), /bank account/);
    await assert.rejects(arap.voidDocument(pool, co.id, inv1.id), /void those payments first/);
    await arap.createPayment(pool, co.id, { kind: 'received', contactId: acme.id, date: '2026-04-15', accountId: A['1000'], applications: [{ documentId: inv1.id, amount: '983.24' }] });
    d = await arap.getDocument(pool, co.id, inv1.id);
    assert.deepEqual([d.balanceCents, d.status, d.payments.length], [0, 'paid', 2]);
    // Pay the lumber bill by credit card.
    const pm = await arap.createPayment(pool, co.id, { kind: 'made', contactId: lumber.id, date: '2026-03-25', accountId: A['2100'], method: 'card', applications: [{ documentId: bill1.id, amount: '795' }] });
    assert.equal(pm.amountCents, 79500);
    assert.equal((await bal('2100')).creditCents, 79500);
  });

  await t.test('aging as of a past date uses only what was true then, and ties to the books', async () => {
    const mar31 = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-03-31' });
    assert.equal(mar31.totals.totalCents, 98324);        // after the first $1,000 payment, before the rest
    assert.equal(mar31.rows[0].current, 98324);           // due 3/31 → not yet past due
    assert.equal(mar31.ties, true);
    assert.equal(mar31.glBalanceCents, 98324);
    const apr30 = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-04-30' });
    assert.equal(apr30.totals.totalCents, 50000);
    assert.equal(apr30.rows[0].name, 'Bob Builder');
    assert.equal(apr30.rows[0].d1_30, 50000);              // due 4/20 → 10 days past due
    assert.equal(apr30.ties, true);
    const later = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-08-01' });
    assert.equal(later.rows[0].over90, 50000);             // due 4/20 → 103 days past due
  });

  await t.test('voiding a payment reopens the invoice; history and audit trail stay intact', async () => {
    const v = await arap.voidPayment(pool, co.id, pay1.id, { date: '2026-05-02' });
    assert.equal(v.status, 'void');
    assert.equal(v.voidDate, '2026-05-02');
    const d = await arap.getDocument(pool, co.id, inv1.id);
    assert.equal(d.balanceCents, 100000);
    // As of before the void, the payment still counted.
    assert.equal((await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-04-30' })).totals.totalCents, 50000);
    const after = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-05-31' });
    assert.equal(after.totals.totalCents, 150000);
    assert.equal(after.ties, true);
    await assert.rejects(arap.voidPayment(pool, co.id, pay1.id), /already void/);
    const contacts = await arap.listContacts(pool, co.id, { kind: 'customer', asOf: '2026-12-31' });
    assert.equal(contacts.find((x) => x.name === 'Acme Engineering').openCents, 100000);
    assert.equal(contacts.find((x) => x.name === 'Bob Builder').overdueCents, 50000);
    const open = await arap.listDocuments(pool, co.id, { kind: 'invoice', status: 'open', today: '2026-12-31' });
    assert.deepEqual(open.map((x) => x.number).sort(), ['1001', '1002']);
    assert.ok(open.every((x) => x.status === 'overdue'));
    assert.equal((await arap.listDocuments(pool, co.id, { kind: 'invoice', status: 'void' })).length, 2);
    const chain = await verifyChain(pool, co.id);
    assert.equal(chain.brokenAt, null);
    assert.deepEqual(chain.ledgerMismatches, []);
  });

  await t.test('bank match: a received payment is found as a match for the deposit', async () => {
    const p = await arap.createPayment(pool, co.id, { kind: 'received', contactId: bob.id, date: '2026-06-01', accountId: A['1000'], applications: [{ documentId: inv2.id, amount: '500' }] });
    await bank.importStatement(pool, co.id, { bankAccountId: A['1000'], content: 'Date,Description,Amount\n06/02/2026,DEPOSIT BOB BUILDER,500.00\n' });
    const [bt] = await bank.listBankTransactions(pool, co.id, { bankAccountId: A['1000'] });
    const matches = await bank.findMatches(pool, co.id, bt.id);
    assert.ok(matches.some((m) => m.id === p.journalEntryId));
    await bank.matchBankTransaction(pool, co.id, bt.id, { entryId: p.journalEntryId });
    await assert.rejects(arap.voidPayment(pool, co.id, p.id), /undo that match/);
  });

  await t.test('reports tie and the nightly check agrees', async () => {
    const bs = await reports.getBalanceSheet(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(bs.balanced, true);
    const ar = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-12-31' });
    const ap = await arap.getAging(pool, co.id, { kind: 'bill', asOf: '2026-12-31' });
    assert.equal(ar.glBalanceCents, (await bal('1100')).debitCents - (await bal('1100')).creditCents);
    assert.equal(ar.totals.totalCents, 100000);
    assert.equal(ap.totals.totalCents, 0);
    assert.equal(ar.ties && ap.ties, true);
    const check = await runBooksCheck(pool, co.id, { asOf: '2026-12-31' });
    assert.deepEqual(check.problems, []);
  });

  await t.test('opening AR from an import is reported separately and still ties', async () => {
    await ledger.postEntry(pool, co.id, { date: '2026-01-01', memo: 'Opening AR', lines: [{ accountId: A['1100'], debit: '250' }, { accountId: A['3000'], credit: '250' }] }, { source: 'import' });
    const ar = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-12-31' });
    assert.equal(ar.otherEntriesCents, 25000);
    assert.equal(ar.glBalanceCents, 125000);
    assert.equal(ar.ties, true);
  });
});
