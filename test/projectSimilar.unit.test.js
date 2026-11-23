// "Is this project already on the list?" (Homer, 2026-11-23): 26-143 and 26-151 were the same claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimNumbers, streetKey, similarProjects } from '../public/projectSimilar.js';

test('claim numbers: letters with 5+ digits, or 7+ digits; never the project number, a house number or a ZIP', () => {
  assert.deepEqual(claimNumbers('Richards (OK007208-01)', '26-151'), ['OK00720801']);
  assert.deepEqual(claimNumbers('26-143 Richards, NHWIC OK007208-01 9112 NW 142nd Yukon OK 73099'), ['OK00720801']);
  assert.deepEqual(claimNumbers('Smith claim 0043218876'), ['0043218876']);
  assert.deepEqual(claimNumbers('2601 Smith Residence, 78610', '2601'), []);
  assert.deepEqual(claimNumbers('26-151', '26-151'), []);
});

test('street key: the same street however it is typed', () => {
  assert.equal(streetKey('9112 NW 142nd, Yukon, OK'), '9112 nw 142nd');
  assert.equal(streetKey('9112 N.W. 142nd\nYukon, OK 73099'), '9112 nw 142nd');
  assert.equal(streetKey('285 Bridgestone Way'), '285 bridgestone');
  assert.equal(streetKey('9112 NW 142nd Street'), '9112 nw 142nd');
  assert.equal(streetKey('3204 Stirrat Street'), streetKey('3204 Stirrat St.'));
  assert.equal(streetKey('Yukon, OK'), ''); // no house number: not a street
  assert.equal(streetKey(''), '');
});

test("Homer's two Richards projects: the second one is caught by its claim number", () => {
  const jobs = [
    { id: 'a', code: '26-143', name: 'Richards, NHWIC OK007208-01', address: null },
    { id: 'b', code: '26-150', name: 'Garcia Barn', address: '9112 NW 142nd Street\nYukon, OK' },
    { id: 'c', code: '26-149', name: 'Smith Residence', address: '77 Elm St' },
  ];
  const hits = similarProjects(jobs, { code: '26-151', name: 'Richards (OK007208-01)', address: '9112 NW 142nd, Yukon, OK' });
  assert.deepEqual(hits.map((h) => [h.job.id, h.why]), [['a', 'same claim number OK00720801'], ['b', 'same address (9112 NW 142nd Street)']]);
  // Editing 26-143 itself never matches itself; nothing in common, nothing found.
  assert.deepEqual(similarProjects(jobs, jobs[0], 'a'), []);
  assert.deepEqual(similarProjects(jobs, { code: '26-152', name: 'Jones Garage', address: '12 Oak Ln' }), []);
  // An address written into the name counts too ("26-002 DWH, 285 Bridgestone Way, Buda, TX").
  const dwh = [{ id: 'd', code: '26-002', name: 'DWH, 285 Bridgestone Way, Buda, TX', address: null }];
  assert.equal(similarProjects(dwh, { name: 'DWH second claim', address: '285 Bridgestone Way\nBuda, TX' })[0].job.id, 'd');
});
