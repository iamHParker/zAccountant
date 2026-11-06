// Fill a trip cost form from a receipt that was read (Homer, 2026-11-06). Shared by the Road page and the desk.
// The server reads the picture (src/services/receiptReader.js) and answers { vendor, amount, date, kind, description };
// this puts those into the form's boxes, but only boxes the person has not filled in yet: what they typed always wins.
// Nothing is saved: the person checks the boxes and presses Save.

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
  return filled;
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
