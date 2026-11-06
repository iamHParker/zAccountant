// Equipment and supplies bought on the road (migration 041): the phone sends a purchase (no trip), the desk accepts
// it to Equipment (an asset) or Office Supplies (an expense), and the equipment list shows what is on the books.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('Road purchases: equipment to an asset, supplies to an expense, photos kept, void reverses', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = (bearer = null) => {
    let cookie = '';
    const call = async (method, path, body) => {
      const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
      const set = r.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* file */ }
      return { status: r.status, body: json, type: r.headers.get('content-type') };
    };
    return { call };
  };
  const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

  const desk = client();
  await desk.call('POST', '/api/auth/signup', { email: 'homer@example.com', name: 'homer', password: 'a long enough passphrase' });
  const setup = (await desk.call('POST', '/api/auth/mfa/setup', {})).body;
  ok(await desk.call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.secret, Date.now()) }));
  const co = ok(await desk.call('POST', '/api/companies', { name: 'Parker Engineering', homeState: 'TX', fiscalYearStartMonth: 1 }), 201);
  const b = `/api/companies/${co.id}`;
  const A = Object.fromEntries(ok(await desk.call('GET', `${b}/accounts`)).map((a) => [a.code, a.id]));
  ok(await desk.call('POST', `${b}/jobs/import`, { text: '2601 Smith Residence' }));
  const [job] = ok(await desk.call('GET', `${b}/jobs`));
  const made = ok(await desk.call('POST', `${b}/road-keys`, { name: "Homer's iPhone" }), 201);
  const phone = client(made.url.split('#key=')[1]);

  // On the road, no trip: a laser level (equipment, with its serial number) and batteries and markers for a job.
  ok(await phone.call('POST', '/api/road/items', { clientId: 'buy-level-001', kind: 'purchase',
    data: { date: '2026-11-05', category: 'equipment', vendor: 'Home Depot', description: 'Laser level', serialNumber: 'DW088-4471', amount: '649.00' } }), 201);
  ok(await phone.call('POST', '/api/road/items/buy-level-001/photos', { clientId: 'photo-level-01', picture: PNG }), 201);
  ok(await phone.call('POST', '/api/road/items', { clientId: 'buy-batts-001', kind: 'purchase',
    data: { date: '2026-11-05', category: 'supplies', vendor: 'Home Depot', description: 'Batteries, markers', amount: '23.47', jobId: job.id, serialNumber: 'ignored' } }), 201);
  const bad = await phone.call('POST', '/api/road/items', { clientId: 'buy-bad-0001', kind: 'purchase', data: { date: '2026-11-05', category: 'snacks', amount: '0' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.details.join(' '), /equipment or supplies/);

  const inbox = ok(await desk.call('GET', `${b}/road-items`));
  const level = inbox.find((i) => i.data.category === 'equipment');
  const batts = inbox.find((i) => i.data.category === 'supplies');
  assert.equal(level.data.amountCents, 64900);
  assert.equal(batts.data.serialNumber, undefined); // supplies carry no serial number
  assert.equal(batts.data.jobId, job.id);
  // Accept all is for a trip's items; purchases go one at a time.
  assert.equal((await desk.call('POST', `${b}/road-items/accept-all`, { itemIds: [level.id], paidFromAccountId: A['2100'] })).status, 400);
  // No paid-with account: refused, nothing posted.
  assert.equal((await desk.call('POST', `${b}/road-items/${level.id}/accept`, {})).status, 400);

  // The level goes to its usual account (1500 Equipment); the batteries to 6200 Office Supplies. Both on the card.
  const lv = ok(await desk.call('POST', `${b}/road-items/${level.id}/accept`, { paidFromAccountId: A['2100'] }));
  const bt = ok(await desk.call('POST', `${b}/road-items/${batts.id}/accept`, { paidFromAccountId: A['2100'] }));
  const lines = async (id) => (await db.pool.query(
    `SELECT a.code, l.debit_cents::int AS dr, l.credit_cents::int AS cr FROM purchases p JOIN journal_lines l ON l.entry_id = p.journal_entry_id
       JOIN accounts a ON a.id = l.account_id WHERE p.id = $1 ORDER BY l.debit_cents DESC`, [id])).rows;
  assert.deepEqual(await lines(lv.purchaseId), [{ code: '1500', dr: 64900, cr: 0 }, { code: '2100', dr: 0, cr: 64900 }]);
  assert.deepEqual(await lines(bt.purchaseId), [{ code: '6200', dr: 2347, cr: 0 }, { code: '2100', dr: 0, cr: 2347 }]);
  // Accepting twice changes nothing.
  assert.equal((await desk.call('POST', `${b}/road-items/${level.id}/accept`, { paidFromAccountId: A['2100'] })).status, 400);

  // The equipment list: the level with its serial number and its photo.
  const list = ok(await desk.call('GET', `${b}/purchases?category=equipment`));
  assert.equal(list.length, 1);
  assert.equal(list[0].serialNumber, 'DW088-4471');
  assert.equal(list[0].accountCode, '1500');
  assert.equal(list[0].photos.length, 1);
  const pic = await desk.call('GET', `${b}/purchases/${list[0].id}/photos/${list[0].photos[0]}`);
  assert.equal(pic.type, 'image/png');
  const all = ok(await desk.call('GET', `${b}/purchases`));
  assert.equal(all.length, 2);
  assert.equal(all.find((p) => p.category === 'supplies').jobCode, '2601');

  // A supplies item can also go to another expense chosen at the desk; a cash account can't be "bought".
  ok(await phone.call('POST', '/api/road/items', { clientId: 'buy-stake-001', kind: 'purchase', data: { date: '2026-11-06', category: 'supplies', amount: '40' } }), 201);
  const stakes = ok(await desk.call('GET', `${b}/road-items`)).find((i) => i.kind === 'purchase');
  assert.equal((await desk.call('POST', `${b}/road-items/${stakes.id}/accept`, { accountId: A['1000'], paidFromAccountId: A['2100'] })).status, 400);
  const st = ok(await desk.call('POST', `${b}/road-items/${stakes.id}/accept`, { accountId: A['6600'], paidFromAccountId: A['1000'] }));
  assert.deepEqual(await lines(st.purchaseId), [{ code: '6600', dr: 4000, cr: 0 }, { code: '1000', dr: 0, cr: 4000 }]);

  // Void the level (sold back, returned): its entry is reversed and it leaves the equipment list.
  const v = ok(await desk.call('POST', `${b}/purchases/${lv.purchaseId}/void`));
  assert.equal(v.status, 'void');
  assert.equal((await desk.call('POST', `${b}/purchases/${lv.purchaseId}/void`)).status, 400);
  assert.equal(ok(await desk.call('GET', `${b}/purchases?category=equipment`)).length, 0);
  const { rows: [{ net }] } = await db.pool.query(
    `SELECT coalesce(sum(l.debit_cents - l.credit_cents), 0)::int AS net FROM journal_lines l WHERE l.company_id = $1 AND l.account_id = $2`, [co.id, A['1500']]);
  assert.equal(net, 0);
});
