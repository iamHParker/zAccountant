import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNumber, projectName, projectLabel, projectChoices } from '../public/projectPick.js';

// Homer's list from 2026-11-23: imported projects (number inside the name, no code) mixed with ones added since
// (separate code, name, customer). He picked 26-152 when the Walberto job was 26-153 because new ones trailed the list.
const jobs = [
  { id: 1, code: null, name: '25-098 Manuppelli, 1130 Farraty Rd, Terrell Hills, TX Opinion', isActive: true },
  { id: 2, code: null, name: '26-002 DWH, 285 Bridgestone Way, Buda, TX DIR', isActive: true },
  { id: 3, code: '26-142', name: '26-142 Lucchese Pytowki, 2309 S 2nd St', customerName: 'Lucchese', isActive: true },
  { id: 4, code: '26-149', name: 'Alaza Brook Apts', customerName: 'Alanza Brrok', isActive: true },
  { id: 5, code: '25-107A', name: 'Bair Residence', customerName: 'Mat Bair', isActive: true },
  { id: 6, code: '26-152', name: 'David Hawkins', customerName: 'David Hawkins', isActive: true },
  { id: 7, code: '26-153', name: 'Walberto Rodríguez', customerName: 'Walberto Rodriguez', isActive: true },
  { id: 8, code: '25-107', name: 'Bair first visit', isActive: true },
  { id: 9, code: null, name: 'Overhead', isActive: true },
  { id: 10, code: '26-160', name: 'Closed job', isActive: false },
  { id: 11, code: null, name: '26-010 ------------', isActive: true },
];

test('numbers come from the code, or from the front of an imported name', () => {
  assert.equal(projectNumber(jobs[0]), '25-098');
  assert.equal(projectNumber(jobs[4]), '25-107A');
  assert.equal(projectNumber(jobs[8]), '');
  assert.equal(projectName(jobs[1]), 'DWH, 285 Bridgestone Way, Buda, TX DIR');
  assert.equal(projectName(jobs[2]), 'Lucchese Pytowki, 2309 S 2nd St');
});

test('every entry reads number · project · customer', () => {
  assert.equal(projectLabel(jobs[1]), '26-002 · DWH, 285 Bridgestone Way, Buda, TX DIR');
  assert.equal(projectLabel(jobs[2]), '26-142 · Lucchese Pytowki, 2309 S 2nd St · Lucchese');
  assert.equal(projectLabel(jobs[6]), '26-153 · Walberto Rodríguez · Walberto Rodriguez');
  assert.equal(projectLabel(jobs[5]), '26-152 · David Hawkins'); // customer same as the name: said once
  assert.equal(projectLabel(jobs[8]), 'Overhead');
  assert.equal(projectLabel(jobs[10]), '26-010'); // a divider line imported from the folder list
});

test('newest number first, letters after their number, no number last; closed ones only if already picked', () => {
  const order = (keep) => projectChoices(jobs, keep).map((j) => j.id);
  assert.deepEqual(order(), [7, 6, 4, 3, 11, 2, 5, 8, 1, 9]);
  assert.deepEqual(order(10), [10, 7, 6, 4, 3, 11, 2, 5, 8, 1, 9]);
});
