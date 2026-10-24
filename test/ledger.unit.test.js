import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEntry, simpleTransaction, reversingLines, normalBalance, naturalBalance, LedgerError, isIsoDate } from '../src/core/ledger.js';

const L = (accountId, debit, credit) => ({ accountId, debit, credit });

test('balanced entry is accepted and amounts become cents', () => {
  const e = validateEntry({ date: '2026-03-01', lines: [L('a', '100.10', ''), L('b', '', '60.05'), L('c', null, '40.05')] });
  assert.equal(e.totalCents, 10010);
  assert.deepEqual(e.lines.map((l) => [l.debitCents, l.creditCents]), [[10010, 0], [0, 6005], [0, 4005]]);
});

test('unbalanced entry is rejected with the difference', () => {
  assert.throws(() => validateEntry({ date: '2026-03-01', lines: [L('a', '100.00'), L('b', null, '99.99')] }),
    (e) => e instanceof LedgerError && /difference 1¢/.test(e.details.join()));
});

test('bad lines are rejected', () => {
  const bad = (lines, re) => assert.throws(() => validateEntry({ date: '2026-03-01', lines }), (e) => re.test(e.details.join('|')));
  bad([L('a', '5', '5'), L('b', null, '0')], /either a debit or a credit/);
  bad([L('a', '5')], /at least two lines/);
  bad([{ accountId: 'a', debitCents: -5 }, { accountId: 'b', creditCents: -5 }], /cannot be negative/);
  bad([L('a', '1.234'), L('b', null, '1.23')], /line 1/);
  bad([L('', '1'), L('b', null, '1')], /account is required/);
});

test('dates must be real calendar dates', () => {
  assert.ok(isIsoDate('2028-02-29'));
  assert.ok(!isIsoDate('2026-02-29'));
  assert.ok(!isIsoDate('2026-13-01'));
  assert.ok(!isIsoDate('03/01/2026'));
  assert.throws(() => validateEntry({ date: '2026-02-30', lines: [L('a', '1'), L('b', null, '1')] }), LedgerError);
});

test('simple transaction: money moves FROM one account TO another', () => {
  const e = simpleTransaction({ date: '2026-01-02', fromAccountId: 'checking', toAccountId: 'rent', amount: '1500' });
  assert.deepEqual(e.lines, [
    { accountId: 'rent', debitCents: 150000, creditCents: 0, memo: null },
    { accountId: 'checking', debitCents: 0, creditCents: 150000, memo: null },
  ]);
  assert.throws(() => simpleTransaction({ date: '2026-01-02', fromAccountId: 'x', toAccountId: 'x', amount: '1' }));
  assert.throws(() => simpleTransaction({ date: '2026-01-02', fromAccountId: 'x', toAccountId: 'y', amount: '0' }));
});

test('reversal swaps debits and credits', () => {
  const r = reversingLines([{ accountId: 'a', debitCents: 5, creditCents: 0 }, { accountId: 'b', debitCents: 0, creditCents: 5 }]);
  assert.deepEqual(r.map((l) => [l.accountId, l.debitCents, l.creditCents]), [['a', 0, 5], ['b', 5, 0]]);
});

test('normal balances', () => {
  assert.equal(normalBalance('asset'), 'debit');
  assert.equal(normalBalance('expense'), 'debit');
  assert.equal(normalBalance('revenue'), 'credit');
  assert.equal(naturalBalance('liability', 100, 300), 200);
  assert.equal(naturalBalance('asset', 100, 300), -200); // e.g. accumulated depreciation (contra)
});

test('amount units: simple `amount` is always dollars; amountCents is cents (board finding #6)', () => {
  const t = (x) => simpleTransaction({ date: '2026-01-02', fromAccountId: 'a', toAccountId: 'b', ...x }).totalCents;
  assert.equal(t({ amount: 100 }), 10_000);
  assert.equal(t({ amount: '100' }), 10_000);
  assert.equal(t({ amount: 100.5 }), 10_050);
  assert.equal(t({ amountCents: 100 }), 100);
});

test('per-line limit keeps totals exact (security B1)', () => {
  const big = 9_007_199_254_740_991;
  assert.throws(() => validateEntry({ date: '2026-01-01', lines: [{ accountId: 'a', debitCents: big }, { accountId: 'b', creditCents: big }] }), /per-line limit/);
  assert.throws(() => validateEntry({ date: '2026-01-01', memo: { x: 1 }, lines: [L('a', '1'), L('b', null, '1')] }), /memo must be text/);
  assert.equal(validateEntry({ date: '2026-01-01', memo: 'a\u0000b', lines: [L('a', '1'), L('b', null, '1')] }).memo, 'a b');
});
