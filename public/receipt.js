// Fill a trip cost form from a receipt that was read (Homer, 2026-11-06). Shared by the Road page and the desk.
// The server reads the picture (src/services/receiptReader.js) and answers { vendor, amount, date, kind, description };
// this puts those into the form's boxes, but only boxes the person has not filled in yet: what they typed always wins.
// Nothing is saved: the person checks the boxes and presses Save.
// cardAccountFor (below) turns a card's last four digits into the card account that paid.

/**
 * form: the cost form ({ kind, date, dateDefault, amount, vendor, description }), changed in place.
 * Returns the names of the boxes filled, for the "Filled in from the receipt" note.
 */
export function fillFromReceipt(form, read) {
  const filled = [];
  if (read.vendor && !String(form.vendor ?? '').trim()) { form.vendor = read.vendor; filled.push('paid to'); }
  if (read.amount && !String(form.amount ?? '').trim() && form.kind !== 'mileage') { form.amount = read.amount; filled.push('amount'); }
  // The date box starts with a date already in it (today, or the trip's last date): that one may be replaced.
  if (read.date && (!form.date || form.date === form.dateDefault)) { form.date = read.date; form.dateDefault = read.date; filled.push('date'); }
  if (read.kind && read.kind !== 'other' && (!form.kind || form.kind === 'other')) { form.kind = read.kind; filled.push('kind'); }
  if (read.description && !String(form.description ?? '').trim()) { form.description = read.description; filled.push('what it was'); }
  // The card that paid (Homer, 2026-11-26): the Road forms keep its last four digits (form.card) for the desk to match.
  if (read.cardLast4 && 'card' in form && !String(form.card ?? '').trim()) { form.card = read.cardLast4; filled.push('card'); }
  return filled;
}

/** "7413" → the regex that finds it standing alone in an account name ("Mastercard 7413", "Chase Ink x7413", "Visa …7413"). */
const lastFourIn = (last4) => new RegExp(`(^|\\D)${last4}(\\D|$)`);

/**
 * The account a card paid from, by its last four digits (Homer, 2026-11-26: "what form of payment was used by the last
 * digits of the card"). The digits are looked for in the account names, the way accounts are already named
 * ("Chase Checking 4321", "Mastercard 7413"). Exactly one match → its id; none, or two that share the digits → null,
 * so the person picks (never a guess between two cards).
 */
export function cardAccountFor(accounts, last4) {
  if (!/^\d{4}$/.test(String(last4 ?? ''))) return null;
  const re = lastFourIn(last4);
  const found = (accounts ?? []).filter((a) => re.test(String(a.name ?? '')));
  return found.length === 1 ? found[0].id : null;
}

/** "Filled in the amount, date and paid to from the receipt." */
export function filledText(filled, read) {
  const foreign = read.currency && read.currency !== 'USD' ? ` The receipt is in ${read.currency}: change the amount to dollars.` : '';
  if (!filled.length) return `The receipt was read, but your boxes were already filled in, so nothing was changed.${foreign}`;
  const list = filled.length === 1 ? filled[0] : `${filled.slice(0, -1).join(', ')} and ${filled.at(-1)}`;
  return `Filled in the ${list} from the receipt. Check them before saving.${foreign}`;
}

/** The pictures among dropped files (a receipt dragged onto the photo boxes). */
export function droppedPictures(ev) {
  return [...(ev.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

/** The choice in a Road cost form's Trip list that makes a new one-day trip (a day run) on the cost's date. */
export const DAY_RUN = 'day-run';

/**
 * Which trip a receipt's date belongs to (Homer, 2026-11-26: "you have date, so it will fill in to trips, or day runs
 * (mini trip no overnight stays)"). trips: [{ key, startDate, endDate }] (no end date = a one-day trip).
 * → { key } of the one trip whose days cover the date; { key: DAY_RUN } when no trip does; { key: null, several } when
 * two or more do (the person picks).
 */
export function tripForDate(trips, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return { key: null };
  const covering = (trips ?? []).filter((t) => t.startDate <= date && date <= (t.endDate || t.startDate));
  if (covering.length === 1) return { key: covering[0].key };
  return covering.length ? { key: null, several: covering.length } : { key: DAY_RUN };
}
