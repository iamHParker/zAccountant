import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceDate, nextOccurrence } from '../src/core/recurring.js';

test('monthly from the 31st clamps to month end without drifting', () => {
  const dates = [0, 1, 2, 3, 12, 13].map((n) => occurrenceDate('2026-01-31', 'monthly', n));
  assert.deepEqual(dates, ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2027-01-31', '2027-02-28']);
  assert.equal(occurrenceDate('2027-01-31', 'monthly', 13), '2028-02-29'); // leap year
});

test('weekly, quarterly and yearly', () => {
  assert.equal(occurrenceDate('2026-12-28', 'weekly', 1), '2027-01-04');
  assert.equal(occurrenceDate('2026-11-30', 'quarterly', 1), '2027-02-28');
  assert.equal(occurrenceDate('2026-11-30', 'quarterly', 2), '2027-05-30');
  assert.equal(occurrenceDate('2028-02-29', 'yearly', 1), '2029-02-28');
  assert.equal(occurrenceDate('2028-02-29', 'yearly', 4), '2032-02-29');
});

test('end date stops the schedule', () => {
  const t = { startDate: '2026-01-15', frequency: 'monthly', endDate: '2026-03-15' };
  assert.equal(nextOccurrence(t, 2), '2026-03-15');
  assert.equal(nextOccurrence(t, 3), null);
});

test('bad input is refused', () => {
  assert.throws(() => occurrenceDate('2026-02-30', 'monthly', 0));
  assert.throws(() => occurrenceDate('2026-01-01', 'daily', 0));
  assert.throws(() => occurrenceDate('2026-01-01', 'monthly', -1));
});
