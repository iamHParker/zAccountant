import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseClock, parseDateTime, readTimesheetCsv, splitOvertime, minutesToHours, workweekStart } from '../src/core/timesheets.js';

test('hours and clock times are read the ways people type them', () => {
  for (const s of ['7.5', '7:30', '7:30:00', '7h 30m', '7.50 hrs', '7.5 hours']) assert.equal(parseDuration(s), 450, s);
  assert.equal(parseDuration('45m'), 45);
  assert.equal(parseDuration('.25'), 15);
  for (const s of ['', 'abc', '7:75', '-2']) assert.equal(parseDuration(s), null, s);
  assert.equal(parseClock('7:05 AM'), '07:05');
  assert.equal(parseClock('12:00 am'), '00:00');
  assert.equal(parseClock('12:30 PM'), '12:30');
  assert.equal(parseClock('4pm'), '16:00');
  assert.equal(parseClock('16:45:10'), '16:45');
  assert.equal(parseClock('13:00 PM'), null);
  assert.equal(parseClock('7'), null);
  assert.deepEqual(parseDateTime('10/14/2026 8:00 AM'), { date: '2026-10-14', time: '08:00' });
  assert.deepEqual(parseDateTime('Wednesday, Oct 14, 2026 at 5:30 PM'), { date: '2026-10-14', time: '17:30' });
  assert.deepEqual(parseDateTime('2026-10-14T08:00:00-05:00'), { date: '2026-10-14', time: '08:00' });
  assert.equal(parseDateTime('14/14/2026'), null);
});

test('hours become payroll hours rounded half-up to hundredths', () => {
  assert.equal(minutesToHours(450), '7.50');
  assert.equal(minutesToHours(452), '7.53');   // 7.5333
  assert.equal(minutesToHours(1), '0.02');     // 0.0167
  assert.equal(minutesToHours(2400), '40.00');
});

test('reading a HoursTracker export', () => {
  const csv = [
    'Job,Clocked In,Clocked Out,Duration,Hourly Rate,Earnings,Comment,Breaks',
    '"Smith Residence",10/12/2026 7:00 AM,10/12/2026 3:30 PM,8.00,30.00,240.00,"Framing, east wall",0.50',
    'Shop,10/13/2026 10:00 PM,10/14/2026 6:00 AM,,,,night shift,0:30',
    'Total,,,15.5,,,,',
  ].join('\n');
  const { rows, format } = readTimesheetCsv(csv);
  assert.equal(format, 'HoursTracker');
  assert.equal(rows.length, 2, 'totals line skipped');
  assert.deepEqual({ ...rows[0], hash: undefined }, { line: 2, date: '2026-10-12', start: '07:00', end: '15:30', minutes: 480, job: 'Smith Residence', notes: 'Framing, east wall', hash: undefined });
  assert.equal(rows[1].minutes, 450, 'overnight shift, minus the 30-minute break');
  assert.equal(rows[1].date, '2026-10-13', 'a shift belongs to the day it starts');
  assert.notEqual(rows[0].hash, rows[1].hash);
  assert.equal(readTimesheetCsv(csv).rows[0].hash, rows[0].hash, 'same row, same fingerprint');
});

test('reading a generic timesheet CSV, and rejecting bad rows', () => {
  const { rows, format } = readTimesheetCsv('Date,Project,Start,End,Notes\n2026-10-12,Bridge,7:00 AM,11:15 AM,Survey\n');
  assert.equal(format, 'CSV');
  assert.equal(rows[0].minutes, 255);
  assert.throws(() => readTimesheetCsv('Date,Hours\n2026-10-12,abc\n13/01/2026,8\n'), /2 row\(s\).*line 2.*line 3/);
  assert.throws(() => readTimesheetCsv('Name,Amount\nx,1\n'), /header row/);
  assert.throws(() => readTimesheetCsv('Date,Notes\n2026-10-12,x\n'), /Duration/);
  assert.throws(() => readTimesheetCsv('Date,Hours\n2026-10-12,25\n'), /at most 24/);
});

test('federal overtime: over 40 hours in a workweek (Sunday to Saturday)', () => {
  assert.equal(workweekStart('2026-11-04'), '2026-11-01');
  const week = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((date) => ({ date, minutes: 540 })); // 9 h a day
  const s = splitOvertime(week, { state: 'TX' });
  assert.deepEqual(s.map((d) => d.overtime), [0, 0, 0, 0, 300], 'hours past 40 fall on Friday');
  assert.equal(s.reduce((t, d) => t + d.regular, 0), 2400);
  // The next workweek starts fresh.
  const two = splitOvertime([...week, { date: '2026-11-09', minutes: 600 }], { state: 'CO' });
  assert.deepEqual(two.at(-1), { date: '2026-11-09', regular: 600, overtime: 0, doubleTime: 0 });
});

test('California: daily overtime, double time, and the 7th day', () => {
  assert.deepEqual(splitOvertime([{ date: '2026-11-02', minutes: 13 * 60 }], { state: 'CA' }),
    [{ date: '2026-11-02', regular: 480, overtime: 240, doubleTime: 60 }]);
  // Five 10-hour days: 8 regular + 2 daily overtime each; regular hours reach exactly 40, no weekly overtime.
  const five = splitOvertime(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((date) => ({ date, minutes: 600 })), { state: 'CA' });
  assert.equal(five.reduce((t, d) => t + d.regular, 0), 2400);
  assert.equal(five.reduce((t, d) => t + d.overtime, 0), 600);
  // Seven days in a row: 6 × 7 h = 42 regular-type hours, then the 7th day.
  const seven = splitOvertime(['01', '02', '03', '04', '05', '06', '07'].map((d) => ({ date: `2026-11-${d}`, minutes: d === '07' ? 600 : 420 })), { state: 'CA' });
  assert.deepEqual(seven[5], { date: '2026-11-06', regular: 300, overtime: 120, doubleTime: 0 }, 'past 40 regular hours on day 6');
  assert.deepEqual(seven[6], { date: '2026-11-07', regular: 0, overtime: 480, doubleTime: 120 }, '7th day: 8 h at 1.5×, the rest at 2×');
  // Same 7 days outside California: only the weekly rule.
  const tx = splitOvertime(['01', '02', '03', '04', '05', '06', '07'].map((d) => ({ date: `2026-11-${d}`, minutes: d === '07' ? 600 : 420 })), { state: 'TX' });
  assert.equal(tx.reduce((t, d) => t + d.overtime, 0), 52 * 60 - 2400);
  assert.equal(tx.reduce((t, d) => t + d.doubleTime, 0), 0);
});
