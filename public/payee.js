// Who a bank line is from, for Banking's "same payee" fill-in (Homer, 2026-10-26: ATMOS and BLUECOSMO repeat every
// month on the card statement; classify one, the rest should follow). Pure; tested in test/payee.unit.test.js.
//
// Card and bank descriptions carry noise around the name: a date and a 16-18 character transaction code in front
// (Homer's card statements), "SQ *", "TST*", "POS DEBIT", store numbers, phone numbers. Any word with a digit in it is
// dropped (dates, codes, store and phone numbers), then the noise words; the key is the first two words left, so
// "10/03 24692166276ABC123 ATMOS ENERGY 888-286-6700 TX" and "ATMOS ENERGY 800-111-2222" are the same payee.

const NOISE = new Set(['sq', 'tst', 'pp', 'paypal', 'pos', 'ach', 'debit', 'credit', 'purchase', 'checkcard', 'card', 'recurring',
  'payment', 'pmt', 'online', 'web', 'electronic', 'withdrawal', 'deposit', 'visa', 'mc', 'dbt', 'crd', 'orig', 'co', 'name', 'id']);

const words = (desc) => String(desc ?? '').toLowerCase().split(/\s+/).filter((w) => !/\d/.test(w))
  .flatMap((w) => w.replace(/[^a-z]+/g, ' ').split(' ')).filter((w) => w.length >= 2 && w.length <= 15 && !NOISE.has(w)); // 16+ letters: a code

/** "SQ *ATMOS ENERGY #123 DALLAS TX" → "atmos energy". Empty when nothing is left. */
export function payeeKey(desc) { return words(desc).slice(0, 2).join(' '); }

/** The words a rule should look for: the payee's first word when it is distinctive (4+ letters), else both words. */
export function payeeRuleText(desc) {
  const w = words(desc);
  if (!w.length) return '';
  return w[0].length >= 4 || w.length === 1 ? w[0] : w.slice(0, 2).join(' ');
}
