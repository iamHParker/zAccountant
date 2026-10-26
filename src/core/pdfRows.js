// Words on a PDF page → rows and cells, like reading a printed page line by line. Shared by the old-invoice reader
// (src/core/oldInvoice.js) and the bank-statement reader (src/core/bankPdf.js). Pure, no database.
//
// pdf.js gives positioned words: x across and y up the page, in points (72 to the inch). Words within ROW_GAP of the
// same height are one row; inside a row, a gap wider than CELL_GAP starts a new cell (a new column on the page).

const ROW_GAP = 3;
const CELL_GAP = 6;

/** Positioned words [{str, x, y, width}] → rows top to bottom, each {y, cells: [{text, x, end}]} left to right. */
export function rowsFromItems(items) {
  const words = items.filter((w) => w.str && w.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const w of words) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= ROW_GAP);
    if (row) row.words.push(w); else rows.push({ y: w.y, words: [w] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    const cells = [];
    for (const w of r.words.sort((a, b) => a.x - b.x)) {
      const last = cells.at(-1);
      const end = w.x + (w.width ?? w.str.length * 5);
      if (last && w.x - last.end <= CELL_GAP) { last.text += (w.x - last.end > 1 ? ' ' : '') + w.str; last.end = end; }
      else cells.push({ text: w.str, x: w.x, end });
    }
    return { y: r.y, cells: cells.map(({ text, x, end }) => ({ text: text.trim(), x, end })) };
  });
}
