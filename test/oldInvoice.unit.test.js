// Old invoices from a PDF: the words on the page → rows → the invoice (made-up client; Homer's Excel layout).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromItems, parseOldInvoice, invoiceLine } from '../src/core/oldInvoice.js';
import { readOldInvoice } from '../src/services/oldInvoiceService.js';
import { tinyPdf } from './tinyPdf.js';

// [x, y, text] as pdf.js gives them (y counts up from the bottom of the page).
const W = (x, y, str) => ({ x, y, str, width: str.length * 5 });
const PAGE = [
  W(465, 696, 'INVOICE'), W(411, 675, 'DATE'), W(479, 675, 'INVOICE #'), W(405, 664, '10/3/2026'), W(488, 664, '26-901'),
  W(78, 617, 'BILL TO:'), W(70, 593, 'Mr Smith C/o Jane Doe, ATTY'), W(70, 580, 'Doe Law'), W(70, 567, '100 Main St, Suite 2'),
  W(70, 553, 'Austin, Texas 78701'),
  W(408, 497, 'TERMS'), W(490, 497, 'UNIT'), W(409, 482, '20 days'), W(483, 481, '26-901'),
  W(258, 466, 'Description'), W(169, 445, 'Forensic Engineering Consulting Services'), W(425, 445, '$425.00'), W(464, 445, 'Labor: Eng Rate'),
  W(169, 435, 'Smith Residence'), W(169, 424, '1 Oak Ln'), W(169, 414, 'Austin, Texas'),
  W(169, 383, 'TAX ID# 00-0000000'), W(169, 372, 'TX Firm 000'),
  W(80, 347, 'Hours'), W(119, 352, 'C'), W(115, 342, 'o'), W(136, 347, 'Date'), W(240, 347, 'Identification of Task'), W(413, 347, 'Rate'),
  W(484, 347, 'Subtotal'),
  W(98, 334, '2.00'), W(127, 334, '9/16/2026'), W(169, 334, 'Travel and prep'), W(397, 334, '$'), W(430, 334, '425.00'), W(468, 334, '$'), W(511, 334, '850.00'),
  W(98, 320, '2.73'), W(127, 320, '9/16/2026'), W(169, 320, 'Site Visit'), W(397, 320, '$'), W(429, 320, '425.00'), W(470, 320, '$'), W(505, 320, '1,161.67'),
  W(98, 307, '0.00'), W(127, 307, '9/16/2026'), W(169, 307, 'Return travel'), W(397, 307, '$'), W(429, 307, '425.00'), W(474, 307, '$'), W(531, 307, '-'),
  W(98, 267, '0.25'), W(127, 267, '10/3/2025'), W(169, 267, 'Report'), W(397, 267, '$'), W(430, 267, '425.00'), W(468, 267, '$'), W(511, 267, '106.25'),
  W(169, 138, 'Tax Rate'), W(431, 138, '8.25%'), W(516, 138, '$0.00'),
  W(69, 115, 'Thank you for using us'), W(398, 114, 'TOTAL DUE'), W(496, 114, '$2,117.92'),
];

test('an old invoice PDF in Homer\'s layout reads back as printed', () => {
  const inv = parseOldInvoice(rowsFromItems(PAGE));
  assert.equal(inv.number, '26-901');
  assert.equal(inv.date, '2026-10-03');
  assert.equal(inv.termsDays, 20);
  assert.deepEqual([inv.careOf, inv.customerName], ['Mr Smith', 'Jane Doe, ATTY']);
  assert.equal(inv.address, 'Doe Law\n100 Main St, Suite 2\nAustin, Texas 78701');
  assert.equal(inv.project, 'Forensic Engineering Consulting Services\nSmith Residence\n1 Oak Ln\nAustin, Texas'); // TAX ID lines left out
  assert.deepEqual(inv.lines.map((l) => [l.hours, l.serviceDate, l.task, l.amountCents]), [
    ['2.00', '2026-09-16', 'Travel and prep', 85000], ['2.73', '2026-09-16', 'Site Visit', 116167],
    ['0.00', '2026-09-16', 'Return travel', 0], ['0.25', '2025-10-03', 'Report', 10625]]);
  assert.equal(inv.totalCents, 211792); // 850.00 + 1,161.67 + 0 + 106.25 = 2,117.92
  assert.deepEqual(inv.problems, ['The line "Report" is dated 2025-10-03: check the year']);
});

test('a line keeps its hours when hours × rate is the printed subtotal, else bills the subtotal as 1', () => {
  assert.deepEqual(invoiceLine({ hours: '2.00', rateCents: 42500, amountCents: 85000, task: 'Travel', serviceDate: null }),
    { quantity: '2.00', unitPrice: '425.00', description: 'Travel', serviceDate: null });
  // 2.73 × 425 = 1,160.25, but 2.7333… h was billed: 1,161.67. One line of $1,161.67 keeps the total exact.
  assert.deepEqual(invoiceLine({ hours: '2.73', rateCents: 42500, amountCents: 116167, task: 'Site Visit', serviceDate: '2026-09-16' }),
    { quantity: '1', unitPrice: '1161.67', description: 'Site Visit (2.73 h at $425.00)', serviceDate: '2026-09-16' });
});

test('a total that does not add up is reported', () => {
  const page = PAGE.map((w) => (w.str === '$2,117.92' ? { ...w, str: '$2,000.00' } : w));
  assert.match(parseOldInvoice(rowsFromItems(page)).problems.join(' '), /add up to 2117\.92, but TOTAL DUE is 2000\.00/);
});

test('the server reads the PDF itself and matches the saved customer', async () => {
  const db = { query: async (sql) => ({ rows: /FROM contacts/.test(sql) ? [{ id: 'c-1', name: 'jane doe ATTY' }] : [] }) };
  const r = await readOldInvoice(db, 'co', { pdf: tinyPdf(PAGE) });
  assert.deepEqual([r.number, r.date, r.dueDate, r.customerId, r.careOf], ['26-901', '2026-10-03', '2026-10-23', 'c-1', 'Mr Smith']); // due = date + 20 days
  assert.deepEqual(r.lines.map((l) => [l.quantity, l.unitPrice]), [['2.00', '425.00'], ['1', '1161.67'], ['0.00', '425.00'], ['0.25', '425.00']]);
  assert.equal(r.totalCents, 211792);
  await assert.rejects(readOldInvoice(db, 'co', { pdf: Buffer.from('hello').toString('base64') }), /not a PDF/);
});
