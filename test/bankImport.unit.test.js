import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseBankDate, readCsvStatement, readOfxStatement, readStatement, dedupeKeys, applyRules } from '../src/core/bankImport.js';

test('CSV parser handles quotes, commas and newlines inside fields', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,"two\nlines",3\n\n'), [['a', 'b, c', 'say "hi"'], ['1', 'two\nlines', '3']]);
});

test('bank dates in common formats', () => {
  assert.equal(parseBankDate('03/05/2026'), '2026-03-05');
  assert.equal(parseBankDate('3/5/26'), '2026-03-05');
  assert.equal(parseBankDate('2026-03-05'), '2026-03-05');
  assert.equal(parseBankDate('20260305120000[-5:EST]'), '2026-03-05');
  assert.equal(parseBankDate('02/30/2026'), null);
  assert.equal(parseBankDate('March 5'), null);
});

test('signed Amount column (Chase style), header found below account info', () => {
  const csv = 'Account: ****1234\n\nDetails,Posting Date,Description,Amount,Type,Balance\nDEBIT,03/02/2026,"HOME DEPOT #123",-245.17,DEBIT_CARD,1000\nCREDIT,03/03/2026,CLIENT PAYMENT,"1,500.00",ACH_CREDIT,2500\n,03/04/2026,Zero hold,0.00,,\n';
  const t = readCsvStatement(csv);
  assert.deepEqual(t.map((x) => [x.date, x.amountCents, x.description]), [['2026-03-02', -24517, 'HOME DEPOT #123'], ['2026-03-03', 150000, 'CLIENT PAYMENT']]);
});

test('separate Debit / Credit columns (Wells / BofA style)', () => {
  const csv = 'Date,Description,Debit,Credit\n03/02/2026,Rent,1800.00,\n03/03/2026,Deposit,,950.25\n03/04/2026,Fee,-12.00,\n';
  assert.deepEqual(readCsvStatement(csv).map((x) => x.amountCents), [-180000, 95025, -1200]);
});

test('bad rows are all reported and nothing is imported', () => {
  assert.throws(() => readCsvStatement('Date,Description,Amount\n13/45/2026,x,1\n03/01/2026,y,abc\n'), /2 row\(s\)/);
  assert.throws(() => readCsvStatement('Foo,Bar\n1,2\n'), /Date/);
});

test('OFX (SGML) download', () => {
  const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310120000[-5:EST]<TRNAMT>-42.50<FITID>A1<NAME>SHELL OIL<MEMO>FUEL
</STMTTRN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260311<TRNAMT>2000.00<FITID>A2<NAME>SMITH &amp; SONS</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const t = readStatement(ofx, 'x.qfx');
  assert.deepEqual(t, [
    { date: '2026-03-10', amountCents: -4250, description: 'SHELL OIL FUEL', fitId: 'A1' },
    { date: '2026-03-11', amountCents: 200000, description: 'SMITH & SONS', fitId: 'A2' }]);
  assert.throws(() => readOfxStatement('Date,Amount'), /not an OFX/);
});

test('dedupe keys: same file twice gives the same keys; identical rows stay distinct', () => {
  const rows = [{ date: '2026-03-01', amountCents: -500, description: 'Coffee', fitId: null }, { date: '2026-03-01', amountCents: -500, description: 'COFFEE ', fitId: null }];
  const a = dedupeKeys(rows);
  assert.notEqual(a[0], a[1]);
  assert.deepEqual(dedupeKeys(rows), a);
  assert.equal(dedupeKeys([{ ...rows[0], fitId: 'X9' }])[0], 'fit:X9');
});

test('rules: first by priority, direction and amount limits respected', () => {
  const rules = [
    { id: 'r1', matchText: 'home depot', direction: 'out', minCents: null, maxCents: 50000, accountId: 'supplies', priority: 100 },
    { id: 'r2', matchText: 'home depot', direction: 'out', minCents: 50001, maxCents: null, accountId: 'equipment', priority: 100 },
    { id: 'r3', matchText: 'depot', direction: 'any', minCents: null, maxCents: null, accountId: 'other', priority: 200 },
  ];
  assert.equal(applyRules(rules, { description: 'HOME DEPOT #123', amountCents: -24517 }).accountId, 'supplies');
  assert.equal(applyRules(rules, { description: 'HOME DEPOT #123', amountCents: -90000 }).accountId, 'equipment');
  assert.equal(applyRules(rules, { description: 'HOME DEPOT refund', amountCents: 1000 }).accountId, 'other');
  assert.equal(applyRules(rules, { description: 'Lowes', amountCents: -1000 }), null);
});
