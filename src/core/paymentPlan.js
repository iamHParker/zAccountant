// Payment plans on an invoice (Homer, 2026-10-29): discounted community work paid off in 5 to 10 monthly payments,
// with no interest. The invoice stays one invoice for its full amount; the plan only says when each part is due, so
// a customer who is on schedule is never shown as past due. A plan invoice never gets late charges (src/core/lateCharges.js).
//
// A plan is two numbers kept on the invoice: how many payments, and the first due date. The schedule is worked out
// from them the same way every time: the total split into equal payments, the odd cents going one each to the first
// payments ($1,000.00 in 3 = 333.34, 333.33, 333.33), due on the same day of each following month (the 31st becomes
// the month's last day). Payments received pay off the earliest payments first. Pure; tested in test/paymentPlan.unit.test.js.
import { isIsoDate } from './ledger.js';

export const MIN_PLAN_PAYMENTS = 2;
export const MAX_PLAN_PAYMENTS = 60;

/** firstDue plus n months, on the same day (or the month's last day when the month is shorter). */
export function addMonths(firstDue, n) {
  const [y, m, d] = firstDue.split('-').map(Number);
  const months = y * 12 + (m - 1) + n;
  const yy = Math.floor(months / 12); const mm = (months % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Check a plan typed on the invoice form → { count, firstDue }, or null when there is none. Pushes problems to errors. */
export function cleanPlan(raw, docDate, errors) {
  if (raw == null || raw === '' || raw.count == null || raw.count === '') return null;
  const count = Number(raw.count);
  if (!Number.isInteger(count) || count < MIN_PLAN_PAYMENTS || count > MAX_PLAN_PAYMENTS) {
    errors.push(`a payment plan has ${MIN_PLAN_PAYMENTS} to ${MAX_PLAN_PAYMENTS} payments`);
    return null;
  }
  if (!isIsoDate(raw.firstDue)) { errors.push('choose the date the first plan payment is due'); return null; }
  if (isIsoDate(docDate) && raw.firstDue < docDate) { errors.push('the first plan payment must be due on or after the invoice date'); return null; }
  return { count, firstDue: raw.firstDue };
}

/** The payments of a plan: [{ n, dueDate, amountCents }], adding up to the total exactly. */
export function planSchedule(totalCents, count, firstDue) {
  const each = Math.floor(totalCents / count);
  const odd = totalCents - each * count;
  return Array.from({ length: count }, (_, i) => ({ n: i + 1, dueDate: addMonths(firstDue, i), amountCents: each + (i < odd ? 1 : 0) }));
}

/**
 * The schedule with what has been paid on each (earliest first), and as of a date: how much is past due, the next
 * payment not yet fully paid, and the part of each unpaid payment with its due date (for the aging report).
 */
export function planStatus(totalCents, count, firstDue, paidCents, asOf) {
  let left = paidCents;
  const schedule = planSchedule(totalCents, count, firstDue).map((p) => {
    const paid = Math.min(p.amountCents, Math.max(0, left));
    left -= paid;
    return { ...p, paidCents: paid, balanceCents: p.amountCents - paid };
  });
  const open = schedule.filter((p) => p.balanceCents > 0);
  return {
    count, firstDue, schedule,
    pastDueCents: open.filter((p) => asOf && p.dueDate < asOf).reduce((s, p) => s + p.balanceCents, 0),
    next: open[0] ? { n: open[0].n, dueDate: open[0].dueDate, amountCents: open[0].balanceCents } : null,
    pieces: open.map((p) => ({ dueDate: p.dueDate, balanceCents: p.balanceCents })),
  };
}
