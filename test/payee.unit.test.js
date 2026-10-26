// Banking's "same payee": lines from the same company group together, whatever store numbers and cities ride along.
import test from 'node:test';
import assert from 'node:assert/strict';
import { payeeKey, payeeRuleText } from '../public/payee.js';

test('the same payee, printed differently each month, has one key', () => {
  assert.equal(payeeKey('ATMOS ENERGY 888-286-6700 TX'), 'atmos energy');
  assert.equal(payeeKey('ATMOS ENERGY 800-111-2222'), 'atmos energy');
  assert.equal(payeeKey('BLUECOSMO INC 877-000-0000 WA'), 'bluecosmo inc');
  assert.equal(payeeKey('SQ *JOES COFFEE AUSTIN TX'), 'joes coffee');
  assert.equal(payeeKey('POS DEBIT HOME DEPOT #4410'), 'home depot');
  assert.notEqual(payeeKey('HOME DEPOT #4410'), payeeKey('HOME GOODS 12'));
  assert.equal(payeeKey('12345'), '');
  // Homer's card statements: date and a 16-18 character transaction code before the name, different every month.
  assert.equal(payeeKey('09/14 2469216A6276XYZ0012 ATMOS ENERGY'), 'atmos energy');
  assert.equal(payeeKey('10/14 55432861P2SAMN4X7Q BLUECOSMO INC'), 'bluecosmo inc');
  assert.equal(payeeRuleText('10/14 55432861P2SAMN4X7Q BLUECOSMO INC'), 'bluecosmo');
});

test('a rule looks for the distinctive word, which a later statement will contain too', () => {
  assert.equal(payeeRuleText('ATMOS ENERGY 888-286-6700 TX'), 'atmos');
  assert.equal(payeeRuleText('BLUECOSMO INC'), 'bluecosmo');
  assert.equal(payeeRuleText('UPS STORE 1234'), 'ups store');
  assert.equal(payeeRuleText('---'), '');
});
