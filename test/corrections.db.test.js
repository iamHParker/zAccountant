import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as reports from '../src/services/reportService.js';
import { verifyChain } from '../src/services/audit.js';
import * as photos from '../src/services/paymentPhotoService.js';

const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;

// Edit an invoice, bill or payment (Homer, 2026-10-25): the old record is voided and the corrected copy posted,
// in one step. Nothing saved is changed in place.
test('edit: invoices, bills and payments are corrected by void + replace', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Edits LLC', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const arBal = async () => { const r = (await reports.getTrialBalance(pool, co.id, { asOf: '2026-12-31' })).rows.find((x) => x.code === '1100'); return r.debitCents - r.creditCents; };
  const acme = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Acme' });
  const smith = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Smith Homes' });

  await t.test('an invoice keeps its number; the old copy is void and marked replaced', async () => {
    const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-03-01', lines: [{ accountId: A['4100'], amount: '1000' }] });
    assert.equal(inv.number, '1001');
    // Wrong customer and wrong amount: 1,000.00 → 1,250.00 to Smith Homes.
    const fixed = await arap.replaceDocument(pool, co.id, inv.id, { contactId: smith.id, date: '2026-03-01', lines: [{ accountId: A['4100'], amount: '1250' }] });
    assert.equal(fixed.number, '1001');
    assert.equal(fixed.contactName, 'Smith Homes');
    assert.equal(fixed.totalCents, 125000);
    const old = await arap.getDocument(pool, co.id, inv.id);
    assert.deepEqual([old.status, old.replacedById, old.voidDate], ['void', fixed.id, '2026-03-01']);
    assert.equal(await arBal(), 125000);   // +1,000 − 1,000 (void) + 1,250
    // Edit the corrected copy again: still 1001, and the next new invoice is 1002.
    const again = await arap.replaceDocument(pool, co.id, fixed.id, { contactId: smith.id, date: '2026-03-02', lines: [{ accountId: A['4100'], amount: '1200' }] });
    assert.equal(again.number, '1001');
    const next = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, date: '2026-03-05', lines: [{ accountId: A['4100'], amount: '10' }] });
    assert.equal(next.number, '1002');
    // A plain new invoice can't take a number in use: typing 1001 again gives 1001A.
    const lettered = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: acme.id, number: '1001', date: '2026-03-05', lines: [{ accountId: A['4100'], amount: '1' }] });
    assert.equal(lettered.number, '1001A');
    await arap.voidDocument(pool, co.id, lettered.id);
    // A voided copy can't be edited again; a bad edit changes nothing.
    await assert.rejects(arap.replaceDocument(pool, co.id, inv.id, { contactId: smith.id, date: '2026-03-01', lines: [{ accountId: A['4100'], amount: '5' }] }), /already void/);
    await assert.rejects(arap.replaceDocument(pool, co.id, again.id, { contactId: smith.id, date: '2026-03-01', lines: [] }), /not valid/);
    assert.equal((await arap.getDocument(pool, co.id, again.id)).status, 'open');
    assert.equal(await arBal(), 121000);
  });

  await t.test('a payment is edited the same way; an invoice with a payment waits for the payment', async () => {
    const inv = (await arap.listDocuments(pool, co.id, { kind: 'invoice', status: 'open' })).find((d) => d.number === '1001');
    const pay = await arap.createPayment(pool, co.id, { kind: 'received', contactId: smith.id, date: '2026-04-01', accountId: A['1000'], method: 'check', reference: '501',
      applications: [{ documentId: inv.id, amount: '1000' }] });
    // An edit that would leave the invoice smaller than what was paid is refused, and changes nothing.
    await assert.rejects(arap.replaceDocument(pool, co.id, inv.id, { contactId: smith.id, date: '2026-03-02', lines: [{ accountId: A['4100'], amount: '900' }] }),
      (e) => /less than the \$1,000\.00 already paid/.test(e.details?.join(' ') ?? e.message));
    assert.equal((await arap.getDocument(pool, co.id, inv.id)).status, 'partial');
    // Plain void still waits for the payment.
    await assert.rejects(arap.voidDocument(pool, co.id, inv.id), /void those payments first/);
    // The check and the remittance stub are photographed with the payment.
    await photos.addPaymentPhoto(pool, co.id, pay.id, { picture: JPEG, actor: 'owner@x' });
    await photos.addPaymentPhoto(pool, co.id, pay.id, { picture: JPEG, actor: 'owner@x' });
    await assert.rejects(photos.addPaymentPhoto(pool, co.id, pay.id, { picture: 'data:image/gif;base64,R0lG' }), /PNG or JPEG/);
    // The bank's deposit confirmation, a PDF, is kept beside them; something only named a PDF is refused.
    const pdf = await photos.addPaymentPhoto(pool, co.id, pay.id, { picture: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 x').toString('base64')}` });
    assert.equal(pdf.type, 'application/pdf');
    assert.equal((await photos.getPaymentPhoto(pool, co.id, pay.id, pdf.id)).name, 'payment-document.pdf');
    await photos.deletePaymentPhoto(pool, co.id, pay.id, pdf.id);
    await assert.rejects(photos.addPaymentPhoto(pool, co.id, pay.id, { picture: `data:application/pdf;base64,${Buffer.from('hello').toString('base64')}` }), /not a PDF/);
    // The check was really 1,200.00, number 502.
    const fixed = await arap.replacePayment(pool, co.id, pay.id, { contactId: smith.id, date: '2026-04-01', accountId: A['1000'], method: 'check', reference: '502',
      applications: [{ documentId: inv.id, amount: '1200' }] });
    assert.deepEqual([fixed.amountCents, fixed.reference, fixed.status], [120000, '502', 'posted']);
    const old = await arap.getPayment(pool, co.id, pay.id);
    assert.deepEqual([old.status, old.replacedById], ['void', fixed.id]);
    // The photos go with the corrected payment; the voided one keeps its copies, which can't be removed.
    assert.equal(fixed.photoCount, 2);
    const list = await photos.listPaymentPhotos(pool, co.id, fixed.id);
    assert.equal(list.length, 2);
    const file = await photos.getPaymentPhoto(pool, co.id, fixed.id, list[0].id);
    assert.equal(file.type, 'image/jpeg');
    assert.equal(file.body.length, 8);
    const oldList = await photos.listPaymentPhotos(pool, co.id, pay.id);
    await assert.rejects(photos.deletePaymentPhoto(pool, co.id, pay.id, oldList[0].id), /kept with its history/);
    await assert.rejects(photos.addPaymentPhoto(pool, co.id, pay.id, { picture: JPEG }), /void/);
    await photos.deletePaymentPhoto(pool, co.id, fixed.id, list[1].id);
    assert.equal((await arap.getPayment(pool, co.id, fixed.id)).photoCount, 1);
    assert.equal((await arap.getDocument(pool, co.id, inv.id)).balanceCents, 0);
    assert.equal(await arBal(), 1000);    // only invoice 1002 ($10) is open
    const ar = await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-12-31' });
    assert.equal(ar.ties, true);
    // A bill: the vendor's number stays unless a new one is typed.
    const v = await arap.createContact(pool, co.id, { kind: 'vendor', name: 'Austin Lumber' });
    const bill = await arap.createDocument(pool, co.id, { kind: 'bill', contactId: v.id, number: 'L-88', date: '2026-04-02', lines: [{ accountId: A['6250'], amount: '300' }] });
    const fixedBill = await arap.replaceDocument(pool, co.id, bill.id, { contactId: v.id, date: '2026-04-02', lines: [{ accountId: A['6250'], amount: '330' }] });
    assert.deepEqual([fixedBill.kind, fixedBill.number, fixedBill.totalCents], ['bill', 'L-88', 33000]);
    assert.equal((await arap.getAging(pool, co.id, { kind: 'bill', asOf: '2026-12-31' })).totals.totalCents, 33000);
    const chain = await verifyChain(pool, co.id);
    assert.equal(chain.brokenAt, null);
    assert.deepEqual(chain.ledgerMismatches, []);
  });

  // Homer, 2026-11-02 (invoice 26-018): a typing error found after the customer had paid part of the invoice.
  // Edit corrects it in place of the old copy; the payments move to the corrected copy, untouched.
  await t.test('an invoice with payments is corrected; its payments follow it', async () => {
    const hw = await arap.createContact(pool, co.id, { kind: 'customer', name: 'Hollywood Ventures' });
    const lines = [{ accountId: A['4100'], quantity: '1', unitPrice: '425' }, { accountId: A['4100'], quantity: '2.42', unitPrice: '425' }];
    const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: hw.id, number: '26-018', date: '2026-06-17', lines });
    assert.equal(inv.totalCents, 145350);        // 425.00 + 2.42 × 425.00 = 425.00 + 1,028.50
    const before = await arBal();
    const p1 = await arap.createPayment(pool, co.id, { kind: 'received', contactId: hw.id, date: '2026-07-02', accountId: A['1000'], applications: [{ documentId: inv.id, amount: '1000' }] });
    const p2 = await arap.createPayment(pool, co.id, { kind: 'received', contactId: hw.id, date: '2026-08-02', accountId: A['1000'], applications: [{ documentId: inv.id, amount: '400' }] });
    // The second line was really 2.24 hours: 2.24 × 425.00 = 952.00, total 1,377.00, balance 1,377.00 − 1,400.00 paid… too small:
    await assert.rejects(arap.replaceDocument(pool, co.id, inv.id, { contactId: hw.id, date: '2026-06-17', lines: [lines[0], { ...lines[1], quantity: '2.24' }] }),
      (e) => /less than the \$1,400\.00 already paid/.test(e.details.join(' ')));
    // …2.52 hours: 2.52 × 425.00 = 1,071.00, total 1,496.00, balance 1,496.00 − 1,400.00 = 96.00.
    const fixed = await arap.replaceDocument(pool, co.id, inv.id, { contactId: hw.id, date: '2026-06-17', lines: [lines[0], { ...lines[1], quantity: '2.52' }] });
    assert.deepEqual([fixed.number, fixed.totalCents, fixed.paidCents, fixed.balanceCents], ['26-018', 149600, 140000, 9600]);
    assert.deepEqual(fixed.payments.map((p) => [p.id, p.amountCents]), [[p1.id, 100000], [p2.id, 40000]]);
    // The payments are the same records, still posted; the old copy is void and shows none.
    for (const p of [p1, p2]) {
      const now = await arap.getPayment(pool, co.id, p.id);
      assert.deepEqual([now.status, now.journalEntryId, now.applications.map((a) => a.documentId)], ['posted', p.journalEntryId, [fixed.id]]);
    }
    const old = await arap.getDocument(pool, co.id, inv.id);
    assert.deepEqual([old.status, old.replacedById, old.payments.length], ['void', fixed.id, 0]);
    // Receivable moved only by the correction: +42.50 (1,496.00 − 1,453.50).
    assert.equal(await arBal(), before - 140000 + 4250);
    assert.equal((await arap.getAging(pool, co.id, { kind: 'invoice', asOf: '2026-12-31' })).ties, true);
    // A different customer, or a date after the first payment, is refused.
    await assert.rejects(arap.replaceDocument(pool, co.id, fixed.id, { contactId: acme.id, date: '2026-06-17', lines }), (e) => /customer can't change/.test(e.details.join(' ')));
    await assert.rejects(arap.replaceDocument(pool, co.id, fixed.id, { contactId: hw.id, date: '2026-07-03', lines }), (e) => /on or before the first payment \(2026-07-02\)/.test(e.details.join(' ')));
    // The database refuses a move that isn't to a corrected copy.
    const other = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: hw.id, date: '2026-06-17', lines });
    await assert.rejects(pool.query('UPDATE payment_applications SET document_id = $1 WHERE payment_id = $2', [other.id, p1.id]), /corrected copy/);
    const audit = await pool.query("SELECT payload FROM audit_log WHERE company_id = $1 AND action = 'move_payments'", [co.id]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].payload.paidCents, 140000);
    const chain = await verifyChain(pool, co.id);
    assert.equal(chain.brokenAt, null);
    assert.deepEqual(chain.ledgerMismatches, []);
  });
});
