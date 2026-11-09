// Comment lines on invoices (Homer, 2026-11-09): free text such as "Weather: return trip needed" that prints
// with the other lines but carries no money. These tests show it changes no total, tax, ledger line or report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as reports from '../src/services/reportService.js';
import { verifyChain } from '../src/services/audit.js';

test('invoice comment lines: printed text, no money', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Structures LLC', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const acme = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Acme Property', termsDays: 30 });
  const sales = A['4100'];

  // 2 h × $150.00 = $300.00 taxable, 1 h × $150.00 = $150.00 not taxable; tax 8.25% × $300.00 = $24.75; total $474.75.
  // The two comment lines add $0.00 to every one of those numbers.
  const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-11-02', taxRate: '8.25', lines: [
    { accountId: sales, description: 'Site visit, units 201-210', quantity: '2', unitPrice: '150', taxable: true, serviceDate: '2026-11-02' },
    { comment: true, description: 'Tenant no-show: unit 204 skipped', serviceDate: '2026-11-02' },
    { comment: true, description: 'Weather: return trip needed', serviceDate: '2026-11-03', accountId: sales, unitPrice: '999', taxable: true },
    { accountId: sales, description: 'Return visit, unit 204', quantity: '1', unitPrice: '150', serviceDate: '2026-11-04' },
  ] });
  assert.equal(inv.subtotalCents, 45000);
  assert.equal(inv.taxCents, 2475);
  assert.equal(inv.totalCents, 47475);

  await t.test('the comment lines are kept, in order, with no account or amount', () => {
    assert.equal(inv.lines.length, 4);
    const [, c1, c2] = inv.lines;
    assert.deepEqual([c1.comment, c1.description, c1.serviceDate, c1.accountId, c1.amountCents, c1.unitPriceCents, c1.taxable],
      [true, 'Tenant no-show: unit 204 skipped', '2026-11-02', null, 0, 0, false]);
    // A price, account or tax mark sent with a comment is ignored, never stored.
    assert.deepEqual([c2.comment, c2.accountId, c2.amountCents, c2.taxable], [true, null, 0, false]);
    assert.equal(inv.lines[0].comment, false);
  });

  await t.test('the ledger and reports see only the priced lines', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM journal_lines WHERE entry_id = (SELECT journal_entry_id FROM documents WHERE id = $1)', [inv.id]);
    assert.equal(rows[0].n, 4); // AR debit, two income credits, sales tax credit: no line for either comment
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' });
    assert.equal(tb.rows.find((r) => r.code === '4100').creditCents, 45000);
    const aging = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-11-30' });
    assert.equal(aging.totals.totalCents, 47475);
    assert.equal((await verifyChain(pool, co.id)).ok, true);
  });

  await t.test('a comment needs text, and is for invoices only', async () => {
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-11-05', lines: [
      { accountId: sales, quantity: '1', unitPrice: '10' }, { comment: true, description: '   ' }] }), (e) => e.details?.some((m) => /type the comment/.test(m)));
    const vendor = await arap.createContact(pool, co.id, { kind: 'vendor', name: 'Austin Lumber' });
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'bill', contactId: vendor.id, number: 'B1', date: '2026-11-05', lines: [
      { accountId: A['5000'] ?? A['6000'], quantity: '1', unitPrice: '10' }, { comment: true, description: 'note' }] }), (e) => e.details?.some((m) => /for invoices/.test(m)));
    // Only comments: the total is $0.00, which an invoice can't be.
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-11-05', lines: [{ comment: true, description: 'just a note' }] }),
      (e) => e.details?.some((m) => /more than \$0.00/.test(m)));
  });

  await t.test('the database itself refuses a comment line with money on it', async () => {
    await assert.rejects(pool.query(`INSERT INTO document_lines (company_id, document_id, account_id, description, unit_price_cents, amount_cents, is_comment)
      VALUES ($1, $2, NULL, 'x', 0, 100, true)`, [co.id, inv.id]), /document_lines_comment_shape/);
    await assert.rejects(pool.query(`INSERT INTO document_lines (company_id, document_id, account_id, description, unit_price_cents, amount_cents)
      VALUES ($1, $2, NULL, 'x', 100, 100)`, [co.id, inv.id]), /document_lines_comment_shape/);
  });

  await t.test('editing the invoice (void + corrected copy) keeps the comments', async () => {
    const lines = inv.lines.map((l) => (l.comment ? { comment: true, description: l.description, serviceDate: l.serviceDate }
      : { accountId: l.accountId, description: l.description, quantity: l.quantity, unitPrice: (l.unitPriceCents / 100).toFixed(2), taxable: l.taxable, serviceDate: l.serviceDate }));
    lines[1].description = 'Tenant no-show: unit 204 skipped (manager notified)';
    const copy = await arap.replaceDocument(pool, co.id, inv.id, { contactId: acme.id, date: inv.date, taxRate: '8.25', lines });
    assert.equal(copy.totalCents, 47475);
    assert.deepEqual(copy.lines.filter((l) => l.comment).map((l) => l.description), ['Tenant no-show: unit 204 skipped (manager notified)', 'Weather: return trip needed']);
  });
});
