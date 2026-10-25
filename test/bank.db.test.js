import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as bank from '../src/services/bankService.js';
import * as reports from '../src/services/reportService.js';
import { verifyChain } from '../src/services/audit.js';

const CSV = `Date,Description,Amount
03/01/2026,OPENING DEPOSIT,10000.00
03/03/2026,HOME DEPOT #4410,-245.17
03/05/2026,PAYROLL ACH,-2000.00
03/05/2026,PAYROLL ACH,-2000.00
03/09/2026,CITY OF AUSTIN UTIL,-180.40
03/15/2026,CLIENT ACME ENGINEERING,4500.00
`;

test('banking: import, review, rules, match, reconcile', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Bank Co', homeState: 'TX' });
  const accts = await ledger.listAccounts(pool, co.id);
  const A = Object.fromEntries(accts.map((a) => [a.code, a.id]));
  const checking = A['1000'];
  const list = (status = 'review') => bank.listBankTransactions(pool, co.id, { bankAccountId: checking, status });

  await t.test('preview saves nothing; import is idempotent', async () => {
    const p = await bank.importStatement(pool, co.id, { bankAccountId: checking, fileName: 'mar.csv', content: CSV, preview: true });
    assert.equal(p.new, 6);
    assert.equal((await list()).length, 0);
    const r = await bank.importStatement(pool, co.id, { bankAccountId: checking, fileName: 'mar.csv', content: CSV });
    assert.deepEqual([r.new, r.duplicates, r.inCents, r.outCents], [6, 0, 1450000, 442557]);
    const again = await bank.importStatement(pool, co.id, { bankAccountId: checking, fileName: 'mar.csv', content: CSV + '03/20/2026,NEW ONE,-1.00\n' });
    assert.deepEqual([again.new, again.duplicates], [1, 6]);
    assert.equal((await list()).length, 7);
    await assert.rejects(bank.importStatement(pool, co.id, { bankAccountId: A['6300'], content: CSV }), /Bank account not found/);
  });

  await t.test('rules suggest an account, including for waiting transactions', async () => {
    const rule = await bank.createRule(pool, co.id, { matchText: 'home depot', direction: 'out', accountId: A['6400'] ?? A['6200'] });
    assert.equal(rule.applied, 1);
    const hd = (await list()).find((x) => x.description.startsWith('HOME DEPOT'));
    assert.equal(hd.suggestedAccountId, rule.accountId);
    await assert.rejects(bank.createRule(pool, co.id, { matchText: 'x', accountId: A['6200'] }), /2-100/);
  });

  await t.test('posting creates a balanced entry in the right direction', async () => {
    const txs = await list();
    const dep = txs.find((x) => x.description === 'OPENING DEPOSIT');
    const r = await bank.postBankTransaction(pool, co.id, dep.id, { accountId: A['3000'] });
    assert.equal(r.status, 'posted');
    const util = txs.find((x) => x.description.startsWith('CITY'));
    await bank.postBankTransaction(pool, co.id, util.id, { accountId: A['6200'] });
    await assert.rejects(bank.postBankTransaction(pool, co.id, util.id, { accountId: A['6200'] }), /already posted/);
    const reg = await reports.getAccountRegister(pool, co.id, checking, {});
    const bal = reg.lines?.at(-1)?.balanceCents ?? reg.endingCents ?? reg.balanceCents;
    const tb = await reports.getTrialBalance(pool, co.id, { asOf: '2026-03-31' });
    assert.equal(tb.balanced, true);
    const cash = tb.rows.find((x) => x.code === '1000');
    assert.equal(cash.debitCents - cash.creditCents, 1000000 - 18040, JSON.stringify({ bal }));
  });

  await t.test('matching links to an entry already in the books (no double counting)', async () => {
    // The payroll was entered by hand before the bank file arrived.
    const p1 = await ledger.postSimple(pool, co.id, { date: '2026-03-04', memo: 'Payroll', fromAccountId: checking, toAccountId: A['6200'], amount: '2000' });
    const p2 = await ledger.postSimple(pool, co.id, { date: '2026-03-05', memo: 'Payroll 2', fromAccountId: checking, toAccountId: A['6200'], amount: '2000' });
    const [b1, b2] = (await list()).filter((x) => x.description === 'PAYROLL ACH');
    const m = await bank.findMatches(pool, co.id, b1.id);
    assert.deepEqual(m.map((e) => e.id).sort(), [p1.id, p2.id].sort());
    await bank.matchBankTransaction(pool, co.id, b1.id, { entryId: p2.id });
    assert.deepEqual((await bank.findMatches(pool, co.id, b2.id)).map((e) => e.id), [p1.id], 'an entry matches one bank line only');
    await assert.rejects(bank.matchBankTransaction(pool, co.id, b2.id, { entryId: p2.id }), /does not match/);
    await bank.matchBankTransaction(pool, co.id, b2.id, { entryId: p1.id });
    // CPA review B1: a matched entry can't be reversed from Transactions (Banking would still call it handled).
    await assert.rejects(ledger.reverseEntry(pool, co.id, p1.id), /matched to the bank transaction.*Banking/);
    const income = await ledger.postSimple(pool, co.id, { date: '2026-03-15', memo: 'Wrong amount', fromAccountId: A['4000'], toAccountId: checking, amount: '4499.99' });
    const acme = (await list()).find((x) => x.description.startsWith('CLIENT'));
    assert.equal((await bank.findMatches(pool, co.id, acme.id)).length, 0, 'amount must match to the penny');
    await ledger.reverseEntry(pool, co.id, income.id);
  });

  await t.test('exclude needs a reason; undo reverses a posting and puts it back to review', async () => {
    const extra = (await list()).find((x) => x.description === 'NEW ONE');
    await assert.rejects(bank.excludeBankTransaction(pool, co.id, extra.id, { reason: '' }), /why/);
    await bank.excludeBankTransaction(pool, co.id, extra.id, { reason: 'duplicate from bank' });
    await bank.undoBankTransaction(pool, co.id, extra.id);
    const hd = (await list()).find((x) => x.description.startsWith('HOME DEPOT'));
    const posted = await bank.postBankTransaction(pool, co.id, hd.id, { accountId: hd.suggestedAccountId });
    const undone = await bank.undoBankTransaction(pool, co.id, hd.id);
    assert.equal(undone.status, 'review');
    const { entries } = await ledger.listEntries(pool, co.id, { source: 'reversal' });
    assert.ok(entries.some((e) => e.reversesEntryId === posted.journalEntryId));
    await bank.postBankTransaction(pool, co.id, hd.id, { accountId: hd.suggestedAccountId });
    const acme = (await list()).find((x) => x.description.startsWith('CLIENT'));
    const acmePosted = await bank.postBankTransaction(pool, co.id, acme.id, { accountId: A['4000'] });
    await assert.rejects(ledger.reverseEntry(pool, co.id, acmePosted.journalEntryId), /posted to the bank transaction.*Banking/);
    await bank.excludeBankTransaction(pool, co.id, extra.id, { reason: 'test charge' });
    assert.equal((await list()).length, 0);
  });

  await t.test('reconciliation must reach $0.00 difference; finished ones are final', async () => {
    // Bank statement: 10,000 − 245.17 − 2,000 − 2,000 − 180.40 + 4,500 = 10,074.43
    const r = await bank.startReconciliation(pool, co.id, { bankAccountId: checking, statementDate: '2026-03-31', endingBalance: '10,074.43' });
    assert.equal(r.beginningCents, 0);
    await assert.rejects(bank.startReconciliation(pool, co.id, { bankAccountId: checking, statementDate: '2026-04-30', endingBalance: '1' }), /already in progress/);
    let sheet = await bank.getReconciliation(pool, co.id, r.id);
    // The bank never saw the wrong-amount entry or the first Home Depot posting (both were reversed
    // in the books), so those pairs stay unticked; everything else is on the statement.
    const hd = sheet.lines.filter((l) => /HOME DEPOT/.test(l.memo ?? '') && !/^Undo/.test(l.memo));
    const skip = (l) => /Wrong amount/.test(l.memo ?? '') || /^Undo bank/.test(l.memo ?? '') || l.id === hd[0].id;
    sheet = await bank.setCleared(pool, co.id, r.id, { lineIds: sheet.lines.map((l) => l.id), cleared: true });
    assert.notEqual(sheet.differenceCents, 1007443);
    sheet = await bank.setCleared(pool, co.id, r.id, { lineIds: sheet.lines.filter(skip).map((l) => l.id), cleared: false });
    assert.equal(sheet.lines.filter((l) => l.cleared).length, 6);
    assert.equal(sheet.differenceCents, 0, JSON.stringify(sheet.lines));
    await assert.rejects(bank.setCleared(pool, co.id, r.id, { lineIds: [1, 'x'], cleared: true }), /Choose/);
    const done = await bank.completeReconciliation(pool, co.id, r.id);
    assert.equal(done.status, 'completed');
    await assert.rejects(pool.query('DELETE FROM reconciliation_lines'), /completed/);
    await assert.rejects(bank.cancelReconciliation(pool, co.id, r.id), /cannot be cancelled/);
    // Next month starts from the reconciled balance; reconciled entries can't be undone from banking.
    const next = await bank.startReconciliation(pool, co.id, { bankAccountId: checking, statementDate: '2026-04-30', endingBalance: '10074.43' });
    assert.equal(next.beginningCents, 1007443);
    const acme = (await list('posted')).find((x) => x.description.startsWith('CLIENT'));
    await assert.rejects(bank.undoBankTransaction(pool, co.id, acme.id), /reconciliation/);
    await assert.rejects(ledger.reverseEntry(pool, co.id, acme.journalEntryId), /reconciliation/);
    const unbalanced = await bank.startReconciliation(pool, co.id, { bankAccountId: A['1000'], statementDate: '2026-05-31', endingBalance: '1' }).catch((e) => e);
    assert.match(unbalanced.message, /already in progress/);
    await bank.cancelReconciliation(pool, co.id, next.id);
    const v = await verifyChain(pool, co.id);
    assert.equal(v.ok, true);
  });
});
