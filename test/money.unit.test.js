import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, centsToDecimal, formatMoney, applyRate, percentToPpm, allocate, divRoundHalfUp } from '../src/core/money.js';

test('toCents parses exactly, no floating point', () => {
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents('0.29'), 29); // 0.29*100 = 28.999999999999996 in floating point
  assert.equal(toCents('1,234.56'), 123456);
  assert.equal(toCents('$1,234.5'), 123450);
  assert.equal(toCents('(12.30)'), -1230);
  assert.equal(toCents('-0'), 0);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('.5'), 50);
  assert.throws(() => toCents('1.234'));
  assert.throws(() => toCents('abc'));
  assert.throws(() => toCents(''));
  assert.throws(() => toCents('.'));
  assert.throws(() => toCents(1e21));
});

test('formatting', () => {
  assert.equal(centsToDecimal(-5), '-0.05');
  assert.equal(centsToDecimal(123456), '1234.56');
  assert.equal(formatMoney(123456789), '$1,234,567.89');
  assert.equal(formatMoney(-1230), '($12.30)');
});

test('rates and rounding are half-up to the cent', () => {
  assert.equal(percentToPpm('6.2'), 62000);
  assert.equal(percentToPpm('10.23'), 102300);
  assert.equal(percentToPpm('0.88'), 8800);
  assert.equal(applyRate(100000, 62000), 6200);   // 6.2% of $1,000
  assert.equal(applyRate(25, 20000), 1);          // 2% of 25¢ = 0.5¢ -> 1¢ (half-up)
  assert.equal(applyRate(25, 2000), 0);           // 0.2% of 25¢ = 0.05¢ -> 0
  assert.equal(applyRate(250, 2000), 1);          // 0.5¢ -> 1¢ (half-up)
  assert.equal(applyRate(249, 2000), 0);          // 0.498¢ -> 0
  assert.equal(divRoundHalfUp(-5n, 2n), -3n);     // symmetric for negatives
});

test('allocate always sums to the total', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
  for (const total of [1, 7, 99, 1000001]) {
    const parts = allocate(total, [3, 5, 7, 11]);
    assert.equal(parts.reduce((a, b) => a + b, 0), total);
  }
});
