// The .zacc book file and the QuickBooks exports, through HTTP with the restricted runtime role.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';
import { unzip } from '../src/core/xlsx.js';
import { writeZip } from '../src/core/zip.js';

process.env.AUTH_RATE_LIMIT = '1000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('zip writer: files come back out exactly (and its CRC-32s check)', () => {
  const pic = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
  const z = writeZip([{ name: 'a.txt', data: 'hello, 2601 Smith ✓' }, { name: 'pictures/x.png', data: pic }]);
  const read = unzip(z);
  assert.equal(read('a.txt'), 'hello, 2601 Smith ✓');
  assert.deepEqual(read('pictures/x.png', { raw: true }), pic);
  assert.equal(read('missing'), null);
});

test('book file (.zacc) and QuickBooks exports', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* a file */ }
      return { status: r.status, body: json, buf, headers: Object.fromEntries(r.headers) };
    };
    return { call };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
  async function newUser(email) {
    const c = client();
    await c.call('POST', '/api/auth/signup', { email, name: email.split('@')[0], password: 'a long enough passphrase' });
    const s = (await c.call('POST', '/api/auth/mfa/setup', {})).body;
    ok(await c.call('POST', '/api/auth/mfa/enable', { code: totpCode(s.secret, Date.now()) }));
    return c;
  }
  const owner = await newUser('owner@example.com');
  const co = ok(await owner.call('POST', '/api/companies', { name: 'Parker: Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await owner.call('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  ok(await owner.call('POST', `${b}/entries/simple`, { date: '2026-01-05', memo: '=Owner money in', fromAccountId: A['3000'] ?? A['3100'], toAccountId: A['1000'], amount: '5,000.00' }), 201);
  const cust = ok(await owner.call('POST', `${b}/customers`, { name: 'DWH - SATX' }), 201);
  ok(await owner.call('POST', `${b}/invoices`, { contactId: cust.id, date: '2026-02-01', lines: [{ accountId: A['4000'], description: 'Report', quantity: '2', unitPrice: '150' }] }), 201);
  ok(await owner.call('POST', `${b}/employees`, { firstName: 'Kim', lastName: 'Ortiz', workState: 'TX', payFrequency: 'monthly', payType: 'salary', payRate: '5000', ssn: '123-45-6789', w4: {} }), 201);
  const trip = ok(await owner.call('POST', `${b}/trips`, { name: 'Dallas', startDate: '2026-02-03', jobs: [] }), 201);
  const tc = ok(await owner.call('POST', `${b}/trips/${trip.id}/costs`, { date: '2026-02-03', kind: 'tolls', amount: '18.40', expenseAccountId: A['6500'], paidFromAccountId: A['2100'] }), 201);
  ok(await owner.call('POST', `${b}/trip-costs/${tc.costId}/photos`, { picture: PNG }), 201);

  const f = await owner.call('GET', `${b}/book-file`);
  assert.equal(f.status, 200);
  assert.match(f.headers['content-disposition'], /attachment; filename="Parker Engineering \d{4}-\d{2}-\d{2}\.zacc"/);
  const read = unzip(f.buf);
  assert.match(read('README.txt'), /ordinary \.zip file/);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.format, 'zacc');
  assert.equal(manifest.version, 1);
  // Every file is there and matches its fingerprint.
  for (const m of manifest.files) assert.equal(createHash('sha256').update(read(m.name, { raw: true })).digest('hex'), m.sha256, m.name);
  const names = manifest.files.map((m) => m.name);
  for (const n of ['import/Chart of accounts.csv', 'import/All transactions.csv', 'tables/companies.csv', 'tables/journal_entries.csv',
    'tables/journal_lines.csv', 'tables/contacts.csv', 'tables/documents.csv', 'tables/employees.csv', 'tables/trips.csv', 'tables/trip_costs.csv', 'tables/audit_log.csv']) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.some((n) => /road_|feedback|plan/.test(n)));
  // Social Security numbers stay out (only the last four, which the app shows anyway).
  const emp = read('tables/employees.csv');
  assert.ok(!emp.includes('ssn_enc') && !emp.includes('v1:'));
  assert.ok(emp.includes('6789'));
  // The receipt picture is inside, named in its row.
  const pic = names.find((n) => n.startsWith('pictures/trip_cost_photos/'));
  assert.ok(pic && read('tables/trip_cost_photos.csv').includes(pic));
  assert.equal(read(pic, { raw: true }).subarray(1, 4).toString(), 'PNG');
  // The import CSVs are the same as the separate downloads.
  assert.equal(read('import/All transactions.csv'), (await owner.call('GET', `${b}/backup/journal`)).buf.toString('utf8'));
  assert.match(read('import/All transactions.csv'), /'=Owner money in/); // formula-looking text stays text

  // Only the owner (admin) gets the whole file.
  const viewer = await newUser('viewer@example.com');
  ok(await owner.call('POST', `${b}/members`, { email: 'viewer@example.com', role: 'viewer' }), 201);
  assert.equal((await viewer.call('GET', `${b}/book-file`)).status, 403);

  // QuickBooks Desktop (.iif): accounts, then each entry; every entry's amounts add up to zero.
  const iif = (await viewer.call('GET', `${b}/export/quickbooks-desktop`)).buf.toString('utf8');
  assert.match(iif, /^!ACCNT\tNAME\tACCNTTYPE\tACCNUM\r\n/);
  assert.match(iif, /\r\nACCNT\t1000 Checking\tBANK\t1000\r\n/);
  assert.match(iif, /\r\nACCNT\t1100 Accounts Receivable\tAR\t1100\r\n/);
  const entries = iif.split('\r\n').filter((l) => /^(TRNS|SPL|ENDTRNS)/.test(l)).join('\n').split('ENDTRNS').filter((s) => s.trim());
  assert.equal(entries.length, 3);
  for (const e of entries) {
    const cents = e.trim().split('\n').reduce((s, l) => s + Math.round(Number(l.split('\t')[5]) * 100), 0);
    assert.equal(cents, 0, e);
  }
  assert.match(iif, /TRNS\tGENERAL JOURNAL\t02\/01\/2026\t1100 Accounts Receivable\tDWH - SATX\t300\.00\t2\t/);
  // QuickBooks Online (.csv): debits equal credits; the customer's name on the A/R line.
  const qbo = (await viewer.call('GET', `${b}/export/quickbooks-online`)).buf.toString('utf8').replace(/^﻿/, '');
  const lines = qbo.trim().split('\r\n');
  assert.equal(lines[0], 'Journal No.,Journal Date,Account Name,Debits,Credits,Description,Name');
  const sum = (i) => lines.slice(1).reduce((s, l) => s + Math.round(Number(l.split(',')[i] || 0) * 100), 0);
  assert.equal(sum(3), sum(4));
  assert.ok(lines.some((l) => l.startsWith('2,02/01/2026,1100 Accounts Receivable,300.00,') && l.endsWith(',DWH - SATX')));
});
