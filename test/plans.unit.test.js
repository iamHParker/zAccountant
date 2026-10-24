import test from 'node:test';
import assert from 'node:assert/strict';
import { featuresOf, featureForPath, checkPlanChange, PLANS, FEATURES } from '../src/core/plans.js';

test('Beta tester includes every feature; Basic none; add-ons add their own', () => {
  assert.deepEqual(featuresOf('beta'), Object.keys(FEATURES).sort());
  assert.deepEqual(featuresOf('basic'), []);
  assert.deepEqual(featuresOf('basic', ['timesheets']), ['timesheets']);
  assert.deepEqual(featuresOf('basic', ['payroll', 'timesheets', 'payroll']), ['payroll', 'timesheets']);
  assert.deepEqual(featuresOf('nonsense', ['nonsense']), []);
  assert.equal(PLANS.beta.monthlyCents, 0, 'testers pay nothing');
});

test('which API paths need which feature', () => {
  for (const p of ['/employees', '/employees/x/paychecks', '/paychecks/x/stub', '/payroll-runs/preview', '/payroll-deposits', '/payroll-hours',
    '/reports/payroll-register', '/reports/payroll-liabilities']) assert.equal(featureForPath(p), 'payroll', p);
  for (const p of ['/time-entries', '/time-entries/import', '/jobs', '/jobs/x', '/reports/time-summary']) assert.equal(featureForPath(p), 'timesheets', p);
  for (const p of ['', '/accounts', '/entries/simple', '/reports/balance-sheet', '/invoices', '/settings', '/employeesX', '/jobsite'])
    assert.equal(featureForPath(p), null, p);
});

test('a plan change needs a known plan, known add-ons and a reason', () => {
  assert.deepEqual(checkPlanChange({ plan: 'basic', addOns: ['timesheets', 'payroll', 'payroll'], reason: ' paid ' }),
    { plan: 'basic', addOns: ['payroll', 'timesheets'], reason: 'paid' });
  assert.throws(() => checkPlanChange({ plan: 'gold', reason: 'x' }), /Plan must be/);
  assert.throws(() => checkPlanChange({ plan: 'basic', addOns: 'payroll', reason: 'x' }), /Add-ons/);
  assert.throws(() => checkPlanChange({ plan: 'basic', reason: '  ' }), /reason/);
});
