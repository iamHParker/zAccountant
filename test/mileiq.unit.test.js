import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMileIqCsv, sumMiles } from '../src/core/mileiq.js';
import { routeText } from '../src/services/mileIqService.js';

// Same layout as Homer's October 2026 export (rates row, SUMMARY of formulas, DETAILED LOG, Totals, footer),
// with made-up places.
const sample = readFileSync(new URL('./fixtures/mileiq-sample.csv', import.meta.url), 'utf8');

test('MileIQ: reads the drive log, skips the summary formulas, totals and footer', () => {
  const r = readMileIqCsv(sample);
  assert.deepEqual(r.rates, { business: '0.76', medical: '0.235', charity: '0.14', moving: '0.235' });
  assert.deepEqual(r.vehicles, ['Pickup 2019']);
  assert.equal(r.drives.length, 7);
  const [a, b] = r.drives;
  assert.deepEqual([a.date, a.startTime, a.endTime, a.miles, a.rate, a.category, a.business], ['2026-10-08', '13:00', '13:27', '19.4', '0.76', 'Business', true]);
  // The file's MILES_VALUE is a formula (=ROUND(PRODUCT(F12,G12),2)); worked here: 19.4 × 0.76 = 14.744 → $14.74.
  assert.equal(a.valueCents, 1474);
  assert.deepEqual([b.parkingCents, b.tollsCents, b.purpose, b.notes], [550, 225, 'Temporary Site', 'soil borings']);
  const commute = r.drives.find((d) => d.purpose === 'Commute');
  assert.equal(commute.business, false);
  assert.equal(new Set(r.drives.map((d) => d.key)).size, 7);
  assert.match(a.key, /^[0-9a-f]{32}$/);
  // The same drive read again has the same key (that's what stops a second import).
  assert.equal(readMileIqCsv(sample).drives[0].key, a.key);
});

test('MileIQ: wrong files and bad rows are refused with a reason', () => {
  assert.throws(() => readMileIqCsv(''), /empty/);
  assert.throws(() => readMileIqCsv('Date,Description,Amount\n10/01/2026,Coffee,-4.50\n'), /MileIQ drive report/);
  const bad = sample.replace('0.76,14.3,', '0.76,lots,');
  assert.throws(() => readMileIqCsv(bad), (e) => /could not be read/.test(e.message) && e.details.some((d) => /miles "lots"/.test(d)));
});

test('MileIQ: miles add up exactly; routes read like a trip', () => {
  // October 2026's file: 115 drives, 2,406.1 mi (MileIQ's email says 2406.10).
  assert.equal(sumMiles(['19.4', '14.3']), '33.7');
  assert.equal(sumMiles(['0.7', '0.3']), '1');
  assert.equal(sumMiles(['3.25', '2.05']), '5.3');
  assert.equal(routeText([{ from: 'Office', to: 'Marco' }, { from: 'Marco', to: 'Office' }]), 'Office → Marco → Office');
  assert.equal(routeText([{ from: '100 Airport Rd, Midland, TX', to: 'Shell' }, { from: 'Home', to: 'Office' }]), '100 Airport Rd → Shell; Home → Office');
});
