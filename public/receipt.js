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
 * digits of the card"). First the account's card numbers (every last-four it has had: a replaced card keeps the same
 * account, Accounts → Card numbers); then, for an account with none listed, the digits in its name ("Mastercard 7413").
 * Exactly one match → its id; none, or two → null, so the person picks (never a guess between two cards).
 */
export function cardAccountFor(accounts, last4) {
  if (!/^\d{4}$/.test(String(last4 ?? ''))) return null;
  const list = accounts ?? [];
  const listed = list.filter((a) => (a.cardNumbers ?? []).includes(String(last4)));
  if (listed.length) return listed.length === 1 ? listed[0].id : null;
  const re = lastFourIn(last4);
  const named = list.filter((a) => !(a.cardNumbers ?? []).length && re.test(String(a.name ?? '')));
  return named.length === 1 ? named[0].id : null;
}

/** "Filled in the amount, date and paid to from the receipt." */
export function filledText(filled, read) {
  const foreign = read.currency && read.currency !== 'USD' ? ` The receipt is in ${read.currency}: change the amount to dollars.` : '';
  if (!filled.length) return `The receipt was read, but your boxes were already filled in, so nothing was changed.${foreign}${fuelText(read)}`;
  const list = filled.length === 1 ? filled[0] : `${filled.slice(0, -1).join(', ')} and ${filled.at(-1)}`;
  return `Filled in the ${list} from the receipt. Check them before saving.${foreign}${fuelText(read)}${photoDateText(read)}`;
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

/** "12.345" → 12345 (thousandths), or null. */
const thousandths = (v) => { const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(v ?? '')); return m ? Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0')) : null; };

/**
 * The check on a fuel reading (Homer's pump photo, 2026-11-26: glare over the middle digits of "$51.66"). Gallons ×
 * price per gallon must come to the amount (the pump rounds to the cent, so within 1¢); with no price shown, the
 * price it works out to is given, so a misread digit stands out ($57.66 for 15.177 gal would be $3.80 a gallon).
 * A digit the reader was unsure of is always said. "" when there is nothing to say.
 */
export function fuelText(read) {
  const notes = [];
  if (read.amountUnsure) notes.push('The amount was hard to read: check it against the pump or your card statement.');
  const gal = thousandths(read.gallons);
  const cents = /^\d+\.\d{2}$/.test(read.amount ?? '') ? Math.round(Number(read.amount) * 100) : null;
  if (gal && cents) {
    const ppg = thousandths(read.pricePerGallon); // dollars in thousandths: 3.399 → 3399
    if (ppg) {
      const expect = Math.round((gal * ppg) / 10000); // thousandths × thousandths = millionths of a dollar → cents
      if (Math.abs(expect - cents) > 1) notes.push(`${read.gallons} gal × $${read.pricePerGallon} is $${(expect / 100).toFixed(2)}, not $${read.amount}: check the amount.`);
    } else notes.push(`${read.gallons} gal for $${read.amount} is $${(cents * 10 / gal).toFixed(3)} a gallon.`);
  }
  return notes.length ? ` ${notes.join(' ')}` : '';
}

/** Said when the date came from the picture's own record (public/photoDate.js), not from the receipt. */
const photoDateText = (read) => (read.dateFromPhoto ? ` The date is when the photo was taken (${read.dateFromPhoto}).` : '');
