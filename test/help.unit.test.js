import test from 'node:test';
import assert from 'node:assert/strict';
import { HELP, helpForTab, searchHelp } from '../public/help.js';

test('every screen has a guide, and guide links point at real guides', () => {
  for (const tab of ['home', 'journal', 'sales', 'bills', 'trips', 'bank', 'reports', 'time', 'accounts', 'payroll', 'settings']) {
    assert.equal(HELP.find((h) => h.id === helpForTab(tab)).tab, tab, tab);
  }
  assert.equal(helpForTab('new-company'), 'start');
  const ids = new Set(HELP.map((h) => h.id));
  assert.equal(ids.size, HELP.length, 'ids are unique');
  for (const h of HELP) for (const [, id] of h.html.matchAll(/data-help="([^"]+)"/g)) assert.ok(ids.has(id), `${h.id} links to ${id}`);
});

test('search needs every word and ignores case', () => {
  assert.equal(searchHelp('').length, HELP.length);
  assert.deepEqual(searchHelp('HoursTracker').map((h) => h.id), ['time']);
  assert.ok(searchHelp('941').some((h) => h.id === 'deposits'));
  assert.deepEqual(searchHelp('reconcile zebra'), []);
});
