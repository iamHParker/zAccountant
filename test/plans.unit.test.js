import test from 'node:test';
import assert from 'node:assert/strict';
import { featuresOf, featureForPath, checkPlanChange, PLANS, FEATURES } from '../src/core/plans.js';

test('Beta tester includes every feature; Basic none; add-ons add their own', () => {
  assert.deepEqual(featuresOf('beta'), Object.keys(FEATURES).sort());
  assert.deepEqual(featuresOf('individual'), []);
  assert.deepEqual(featuresOf('company'), ['payroll'], 'payroll comes with the Company plan');
  assert.deepEqual(featuresOf('individual', ['timesheets']), ['timesheets']);
  assert.deepEqual(featuresOf('company', ['tax', 'timesheets', 'tax']), ['payroll', 'tax', 'timesheets']);
  assert.deepEqual(featuresOf('nonsense', ['nonsense']), []);
  assert.equal(PLANS.beta.monthlyCents, 0, 'testers pay nothing');
  for (const p of ['individual', 'company']) assert.deepEqual([PLANS[p].monthlyCents, PLANS[p].annualCents], [null, null], 'no price invented');
});

test('which API paths need which feature', () => {
  for (const p of ['/employees', '/employees/x/paychecks', '/paychecks/x/stub', '/payroll-runs/preview', '/payroll-deposits', '/payroll-hours',
    '/reports/payroll-register', '/reports/payroll-liabilities']) assert.equal(featureForPath(p), 'payroll', p);
  for (const p of ['/time-entries', '/time-entries/import', '/reports/time-summary']) assert.equal(featureForPath(p), 'timesheets', p);
  for (const p of ['/tax-categories', '/reports/tax-summary', '/reports/tax-1099', '/reports/tax-w2']) assert.equal(featureForPath(p), 'tax', p);
  for (const p of ['', '/accounts', '/entries/simple', '/reports/balance-sheet', '/invoices', '/settings', '/employeesX', '/jobsite',
    '/jobs', '/jobs/import', '/unbilled']) // projects are named on invoices and bills, so every plan has them
    assert.equal(featureForPath(p), null, p);
});

test('a plan change needs a known plan, known add-ons and a reason', () => {
  assert.deepEqual(checkPlanChange({ plan: 'company', addOns: ['timesheets', 'tax', 'tax'], reason: ' paid ' }),
    { plan: 'company', addOns: ['tax', 'timesheets'], reason: 'paid' });
  assert.throws(() => checkPlanChange({ plan: 'company', addOns: ['payroll'], reason: 'x' }), /Add-ons/, 'payroll is not an add-on any more');
  assert.throws(() => checkPlanChange({ plan: 'gold', reason: 'x' }), /Plan must be/);
  assert.throws(() => checkPlanChange({ plan: 'company', addOns: 'payroll', reason: 'x' }), /Add-ons/);
  assert.throws(() => checkPlanChange({ plan: 'company', reason: '  ' }), /reason/);
});
