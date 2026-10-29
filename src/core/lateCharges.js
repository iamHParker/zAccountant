// Late charges on past-due invoices (Homer, 2026-10-29: "I charge like MasterCard"): interest at a yearly rate
// (APR, 6% for now) plus a flat fee for each late statement sent ($35). Pure; tested in test/lateCharges.unit.test.js.
//
// ℹ️ The rules, worked once a month for each customer:
//   • An invoice can be charged only after its grace period: grace days after its due date (30), or the holiday
//     grace (60) when the customer is a homeowner and the invoice fell due in November or December.
//   • Interest is one month of simple interest on what is past due: balance × APR ÷ 12, rounded half-up once on the
//     customer's total. $1,000.00 at 6% → 100000 × 0.06 ÷ 12 = 500 cents = $5.00. No interest on interest: the
//     late-charge invoices themselves are never charged.
//   • The statement fee is charged once per customer per month, only when something of theirs is chargeable.
//   • Never charged: invoices on a payment plan (community work, Homer's rule), invoices or customers marked
//     "no late charges".
import { divRoundHalfUp, percentToPpm } from './money.js';

export const MAX_LATE_APR_PPM = 360_000; // 36%: a typo guard, not a legal limit (the contract and state law decide)

const addDays = (date, n) => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The company's late-charge settings, from its row. On when an APR or a fee is set. */
export function lateSettings(co) {
  const aprPpm = co.late_apr ? percentToPpm(co.late_apr) : 0;
  const feeCents = co.late_fee_cents ?? 0;
  return {
    apr: co.late_apr ?? null, aprPpm, feeCents,
    graceDays: co.late_grace_days ?? 30, holidayGraceDays: co.late_holiday_grace_days ?? 60,
    on: aprPpm > 0 || feeCents > 0,
  };
}

/** The last day of an invoice's grace period: after it, the invoice can be charged. */
export function graceEnds(dueDate, isHomeowner, settings) {
  const month = Number(dueDate.slice(5, 7));
  const days = isHomeowner && (month === 11 || month === 12) ? settings.holidayGraceDays : settings.graceDays;
  return addDays(dueDate, days);
}

/** One month of simple interest on cents at the APR (in parts per million: 6% = 60000), rounded half-up. */
export function monthlyInterest(cents, aprPpm) {
  if (!aprPpm || cents <= 0) return 0;
  // The rate is ppm ÷ 1,000,000 (6% = 60000 ppm = 0.06) and one month is a twelfth: cents × ppm ÷ 12,000,000.
  return Number(divRoundHalfUp(BigInt(cents) * BigInt(aprPpm), 12_000_000n));
}

/**
 * What one customer would be charged as of a date. invoices: their open invoices
 * [{ id, number, dueDate, balanceCents, planCount, noLateCharges, lateChargeMonth }].
 * Returns { invoices: [the chargeable ones, with graceEnds], pastDueCents, interestCents, feeCents, totalCents }.
 */
export function chargesFor(customer, invoices, settings, asOf) {
  if (!settings.on || customer.noLateCharges) return { invoices: [], pastDueCents: 0, interestCents: 0, feeCents: 0, totalCents: 0 };
  const chargeable = invoices
    .filter((d) => d.balanceCents > 0 && !d.planCount && !d.noLateCharges && !d.lateChargeMonth)
    .map((d) => ({ ...d, graceEnds: graceEnds(d.dueDate, customer.isHomeowner, settings) }))
    .filter((d) => d.graceEnds < asOf)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const pastDueCents = chargeable.reduce((s, d) => s + d.balanceCents, 0);
  const interestCents = monthlyInterest(pastDueCents, settings.aprPpm);
  const feeCents = chargeable.length ? settings.feeCents : 0;
  return { invoices: chargeable, pastDueCents, interestCents, feeCents, totalCents: interestCents + feeCents };
}
