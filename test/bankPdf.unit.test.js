// Bank statements as PDF: made-up statements in the three common layouts (sections, columns, signed amounts).
// Every statement ties out: beginning balance + rows = ending balance, worked by hand beside each one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromItems } from '../src/core/pdfRows.js';
import { readPdfStatement, moneyCell, statementEnd } from '../src/core/bankPdf.js';
import { pdfWords } from '../src/services/pdfText.js';
import { tinyPdf } from './tinyPdf.js';

// [x, y, text] as pdf.js gives them (y counts up from the bottom of the page); the reader puts page 2 2000 points lower.
const W = (x, y, str, page = 1) => ({ x, y, str, width: str.length * 5, page });
const read = (words) => readPdfStatement(rowsFromItems(words.map((w) => ({ ...w, y: w.y - (w.page - 1) * 2000 }))));
const rows = (r) => r.txns.map((t) => [t.date, t.amountCents, t.description]);

// Layout 1 (Chase-style): sections name the direction; checks listed by number; a second page; a daily balance table.
const SECTIONS = [
  W(380, 740, 'October 01, 2026 through October 31, 2026'),
  W(70, 680, 'Beginning Balance'), W(480, 680, '$1,000.00'),
  W(70, 665, 'Deposits and Additions'), W(480, 665, '2,500.00'),
  W(70, 600, 'Ending Balance'), W(480, 600, '$2,871.75'),
  W(70, 560, 'DEPOSITS AND ADDITIONS'),
  W(70, 545, 'DATE'), W(110, 545, 'DESCRIPTION'), W(480, 545, 'AMOUNT'),
  W(70, 530, '10/02'), W(110, 530, 'Remote Online Deposit 1'), W(480, 530, '$2,000.00'),
  W(70, 516, '10/15'), W(110, 516, 'Zelle Payment From J Smith'), W(490, 516, '500.00'),
  W(70, 500, 'Total Deposits and Additions'), W(480, 500, '$2,500.00'),
  W(70, 470, 'CHECKS PAID'),
  W(70, 455, 'CHECK NO.'), W(200, 455, 'DATE PAID'), W(480, 455, 'AMOUNT'),
  W(70, 440, '1001'), W(100, 440, '^'), W(200, 440, '10/05'), W(480, 440, '$400.00'),
  W(70, 426, '1002'), W(200, 426, '10/09'), W(485, 426, '125.25'),
  W(70, 410, 'Total Checks Paid'), W(480, 410, '$525.25'),
  W(70, 760, 'Page 2 of 2', 2),
  W(70, 700, 'ELECTRONIC WITHDRAWALS', 2),
  W(70, 685, '10/20', 2), W(110, 685, 'Orig CO Name:Txu Energy', 2), W(480, 685, '$88.00', 2),
  W(110, 673, 'Ind Name:Example Eng', 2),
  W(70, 640, 'FEES', 2),
  W(70, 625, '10/31', 2), W(110, 625, 'Monthly Service Fee', 2), W(480, 625, '$15.00', 2),
  W(70, 590, 'DAILY ENDING BALANCE', 2),
  W(70, 575, '10/02', 2), W(150, 575, '$3,000.00', 2), W(250, 575, '10/05', 2), W(330, 575, '$2,600.00', 2),
];

test('a statement with sections: deposits in, checks and withdrawals out, daily balances skipped', () => {
  const r = read(SECTIONS);
  assert.deepEqual(rows(r), [
    ['2026-10-02', 200000, 'Remote Online Deposit 1'], ['2026-10-15', 50000, 'Zelle Payment From J Smith'],
    ['2026-10-05', -40000, 'Check 1001'], ['2026-10-09', -12525, 'Check 1002'],
    ['2026-10-20', -8800, 'Orig CO Name:Txu Energy Ind Name:Example Eng'], // the wrapped line joins its row
    ['2026-10-31', -1500, 'Monthly Service Fee']]);
  // 1,000.00 + 2,000.00 + 500.00 − 400.00 − 125.25 − 88.00 − 15.00 = 2,871.75 = the ending balance.
  assert.deepEqual([r.beginCents, r.endCents, r.problems], [100000, 287175, []]);
});

test('a reading that does not tie out says so', () => {
  const r = read(SECTIONS.filter((w) => w.str !== '1002' && w.str !== '125.25' && w.str !== '10/09'));
  assert.match(r.problems.join(' '), /plus these rows is 2997\.00, but the statement's ending balance is 2871\.75/); // 125.25 missing
});

// Layout 2 (Wells Fargo-style): one table with Deposits/Credits and Withdrawals/Debits columns and a daily balance.
const COLUMNS = [
  W(400, 740, 'October 31, 2026'),
  W(70, 700, 'Beginning balance on 10/1'), W(200, 700, '$5,000.00'), W(300, 700, 'Ending balance on 10/31'), W(450, 700, '$5,370.00'),
  W(50, 650, 'Date'), W(90, 650, 'Check Number'), W(160, 650, 'Description'), W(350, 650, 'Deposits/ Credits'),
  W(445, 650, 'Withdrawals/ Debits'), W(555, 650, 'Ending daily balance'),
  W(50, 635, '10/3'), W(160, 635, 'Deposit Made In A Branch'), W(370, 635, '1,000.00'), W(585, 635, '6,000.00'),
  W(50, 621, '10/6'), W(95, 621, '1234'), W(160, 621, 'Check'), W(475, 621, '600.00'),
  W(50, 607, '10/28'), W(160, 607, 'Online Transfer To Savings'), W(480, 607, '30.00'), W(585, 607, '5,370.00'),
  W(50, 590, 'Ending balance on 10/31'), W(585, 590, '5,370.00'),
];

test('a statement with in and out columns: each amount goes by the column it sits under', () => {
  const r = read(COLUMNS);
  // 5,000.00 + 1,000.00 − 600.00 − 30.00 = 5,370.00
  assert.deepEqual(rows(r), [['2026-10-03', 100000, 'Deposit Made In A Branch'], ['2026-10-06', -60000, '1234 Check'],
    ['2026-10-28', -3000, 'Online Transfer To Savings']]);
  assert.deepEqual([r.beginCents, r.endCents, r.problems], [500000, 537000, []]);
});

// Layout 3 (Bank of America-style): withdrawals printed with a minus, full dates with a two-digit year.
const SIGNED = [
  W(300, 740, 'for October 1, 2026 to October 31, 2026'),
  W(70, 700, 'Beginning balance on October 1, 2026'), W(480, 700, '$200.00'),
  W(70, 690, 'Ending balance on October 31, 2026'), W(480, 690, '$1,554.90'),
  W(70, 650, 'Deposits and other additions'),
  W(70, 635, '10/02/26'), W(130, 635, 'Payroll Deposit'), W(480, 635, '1,500.00'),
  W(70, 600, 'Withdrawals and other subtractions'),
  W(70, 585, '10/04/26'), W(130, 585, 'Checkcard 1003 Home Depot'), W(480, 585, '-45.10'),
  W(70, 571, '10/07/26'), W(130, 571, 'Transfer to savings'), W(480, 571, '(100.00)'),
];

test('a statement with signed amounts', () => {
  const r = read(SIGNED);
  // 200.00 + 1,500.00 − 45.10 − 100.00 = 1,554.90
  assert.deepEqual(rows(r), [['2026-10-02', 150000, 'Payroll Deposit'], ['2026-10-04', -4510, 'Checkcard 1003 Home Depot'],
    ['2026-10-07', -10000, 'Transfer to savings']]);
  assert.deepEqual(r.problems, []);
});

test('the running balance tells in from out; a December row on a January statement is last year\'s', () => {
  const r = read([
    W(300, 740, 'Statement Period 12/15/2026 - 01/14/2027'),
    W(70, 700, 'Previous Balance'), W(480, 700, '1,000.00'),
    W(70, 650, '12/20'), W(130, 650, 'Customer payment'), W(400, 650, '100.00'), W(480, 650, '1,100.00'),
    W(70, 636, '01/05'), W(130, 636, 'Office supplies'), W(400, 636, '20.00'), W(480, 636, '1,080.00'),
    W(70, 600, 'New Balance'), W(480, 600, '1,080.00'),
  ]);
  // 1,000 → 1,100 (up 100: in) → 1,080 (down 20: out); 1,000 + 100 − 20 = 1,080.
  assert.deepEqual(rows(r), [['2026-12-20', 10000, 'Customer payment'], ['2027-01-05', -2000, 'Office supplies']]);
  assert.deepEqual(r.problems, []);
});

test('a row that cannot be told as in or out stops the reading rather than being guessed', () => {
  assert.throws(() => read([W(300, 740, 'October 1, 2026 - October 31, 2026'), W(70, 650, '10/03'), W(130, 650, 'Something'), W(480, 650, '12.00')]),
    /could not be told apart as deposits or withdrawals.*: 2026-10-03 Something 12\.00/);
});

test('amounts and statement dates as banks print them', () => {
  assert.deepEqual(['1,234.56', '$45.00', '-45.00', '45.00-', '(45.00)', '-$1,000.00', '1,23.00', '(5.00'].map(moneyCell), [
    { cents: 123456, sign: 0 }, { cents: 4500, sign: 0 }, { cents: 4500, sign: -1 }, { cents: 4500, sign: -1 },
    { cents: 4500, sign: -1 }, { cents: 100000, sign: -1 }, null, null]);
  assert.equal(statementEnd(rowsFromItems([W(10, 700, 'Account 1234'), W(10, 690, 'September 30, 2026')])), '2026-09-30');
});

test('a real PDF file (two pages) reads the same as the words do', async () => {
  const words = await pdfWords(Buffer.from(tinyPdf(SECTIONS), 'base64'), 40);
  assert.deepEqual(rows(readPdfStatement(rowsFromItems(words))), rows(read(SECTIONS)));
});

test('a credit card statement: purchases out, payments in, and the balance owed ties out the other way', () => {
  const r = readPdfStatement(rowsFromItems([
    W(300, 740, 'Opening/Closing Date 09/13/26 - 10/12/26'),
    W(70, 700, 'Previous Balance'), W(480, 700, '$500.00'), W(70, 688, 'New Balance'), W(480, 688, '$620.00'),
    W(70, 650, 'PAYMENTS AND OTHER CREDITS'),
    W(70, 636, '09/20'), W(130, 636, 'Payment Thank You'), W(480, 636, '-500.00'),
    W(70, 610, 'PURCHASE'),
    W(70, 596, '09/25'), W(130, 596, 'Hardware store'), W(480, 596, '620.00'),
  ]), { creditCard: true });
  // Owed: 500.00 − 500.00 paid + 620.00 bought = 620.00. In the books' terms: +500.00 in, −620.00 out.
  assert.deepEqual(rows(r), [['2026-09-20', 50000, 'Payment Thank You'], ['2026-09-25', -62000, 'Hardware store']]);
  assert.deepEqual(r.problems, []);
});
