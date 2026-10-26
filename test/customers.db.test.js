import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import { nextLetteredNumber } from '../src/services/arapService.js';
import { agingRows } from '../src/core/csv.js';

test('a repeated invoice number takes the next letter: 2601, 2601A … Z, AA … AZ, BA', () => {
  const used = (...n) => new Set(n.map((x) => x.toLowerCase()));
  assert.equal(nextLetteredNumber('2601', used()), '2601');
  assert.equal(nextLetteredNumber('2601', used('2601')), '2601A');
  assert.equal(nextLetteredNumber('2601', used('2601', '2601A', '2601B')), '2601C');
  const throughZ = ['2601', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `2601${l}`)];
  assert.equal(nextLetteredNumber('2601', used(...throughZ)), '2601AA');
  const throughAZ = [...throughZ, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `2601A${l}`)];
  assert.equal(nextLetteredNumber('2601', used(...throughAZ)), '2601BA');
});

// Divisions and adjusters (Homer, 2026-10-25): DWH has divisions (DWH - SATX, DWH - AUS); each invoice is for
// one claims adjuster, sent to their email, and carries the client's claim or job number.
test('customers: divisions, adjusters, and who an invoice is for', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Parker Engineering', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));

  const satx = await arap.createContact(pool, co.id, { kind: 'customer', name: 'DWH - SATX', groupName: 'DWH',
    people: [{ name: 'Jane Doe', email: 'jane@dwh.example', phone: '210-555-0101' }, { name: '', email: '', phone: '' }] });
  assert.equal(satx.groupName, 'DWH');
  assert.deepEqual(satx.people, [{ name: 'Jane Doe', email: 'jane@dwh.example', phone: '210-555-0101' }]); // the empty row is dropped
  const aus = await arap.createContact(pool, co.id, { kind: 'customer', name: 'DWH - AUS', groupName: 'DWH' });
  await arap.createContact(pool, co.id, { kind: 'customer', name: 'Smith Homes' });

  await t.test('people are checked and can be edited', async () => {
    await assert.rejects(arap.updateContact(pool, co.id, aus.id, { people: [{ name: 'Bob', email: 'not-an-email' }] }), /not valid/);
    await assert.rejects(arap.updateContact(pool, co.id, aus.id, { people: [{ name: 'Bob' }, { name: 'bob' }] }), /not valid/);
    await assert.rejects(arap.updateContact(pool, co.id, aus.id, { people: [{ email: 'x@y.com' }] }), /not valid/);
    const r = await arap.updateContact(pool, co.id, aus.id, { people: [{ name: 'Bob Ray', email: 'bob@dwh.example' }] });
    assert.deepEqual(r.people, [{ name: 'Bob Ray', email: 'bob@dwh.example', phone: null }]);
    assert.equal(r.groupName, 'DWH'); // untouched by a partial edit
  });

  await t.test('an invoice records attention, send-to and the claim number, and keeps them on edit', async () => {
    const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: satx.id, number: '2601', date: '2026-10-01',
      attention: 'Jane Doe', careOf: 'Ms Smith', sendTo: 'jane@dwh.example', clientRef: 'CLM-88213', lines: [{ accountId: A['4100'], amount: '900' }] });
    assert.deepEqual([inv.attention, inv.careOf, inv.sendTo, inv.clientRef, inv.contact.groupName], ['Jane Doe', 'Ms Smith', 'jane@dwh.example', 'CLM-88213', 'DWH']);
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: satx.id, date: '2026-10-01', sendTo: 'jane',
      lines: [{ accountId: A['4100'], amount: '1' }] }), /not valid/);
    const fixed = await arap.replaceDocument(pool, co.id, inv.id, { contactId: satx.id, date: '2026-10-01', attention: 'Jane Doe',
      sendTo: 'jane@dwh.example', clientRef: 'CLM-88213', lines: [{ accountId: A['4100'], amount: '950' }] });
    assert.equal(fixed.number, '2601');
    assert.equal(fixed.clientRef, 'CLM-88213');
    assert.equal(fixed.careOf, null); // the corrected copy holds what was sent with it
    assert.equal((await arap.updateDocumentDetails(pool, co.id, fixed.id, { careOf: 'Ms Smith' })).careOf, 'Ms Smith');
    // A second invoice on project 2601 is 2601A, a third 2601B.
    const b = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: aus.id, number: '2601', date: '2026-10-05', lines: [{ accountId: A['4100'], amount: '100' }] });
    const c = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: aus.id, number: '2601', date: '2026-10-06', lines: [{ accountId: A['4100'], amount: '50' }] });
    assert.deepEqual([b.number, c.number, c.numberWasTaken], ['2601A', '2601B', '2601']);
  });

  await t.test('the aging report totals DWH across its divisions', async () => {
    const aging = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-10-10' });
    assert.equal(aging.rows.length, 2);
    assert.deepEqual(aging.groups.map((g) => [g.name, g.count, g.totalCents]), [['DWH', 2, 110000]]);
    const csv = agingRows(aging, { company: 'Parker Engineering', title: 'Accounts Receivable Aging' });
    assert.ok(csv.some((r) => r[0] === 'DWH' && r.at(-1).n === '1100.00'));
  });
});
