import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import * as ledger from '../src/services/ledgerService.js';
import * as arap from '../src/services/arapService.js';
import * as time from '../src/services/timesheetService.js';
import * as projects from '../src/services/projectService.js';
import { parseProjectFolder, parseProjectList, splitProjectName } from '../src/core/projects.js';

// Homer names his project folders by number and name; "Copy as path" in File Explorer pastes them in quotes.
test('projects from folder names', () => {
  assert.deepEqual(parseProjectFolder('"C:\\Jobs\\2026\\2601 Smith Residence"'), { name: '2601 Smith Residence', code: '2601' });
  assert.deepEqual(parseProjectFolder('2602 - DWH Jones roof\\'), { name: '2602 - DWH Jones roof', code: '2602' });
  assert.deepEqual(parseProjectFolder('/Users/h/Projects/26-014_Bridge'), { name: '26-014_Bridge', code: '26-014' });
  assert.deepEqual(parseProjectFolder('P2603 Warehouse'), { name: 'P2603 Warehouse', code: 'P2603' });
  assert.deepEqual(parseProjectFolder('Templates'), { name: 'Templates', code: null });
  assert.equal(parseProjectFolder('   '), null);
  const list = parseProjectList('"C:\\J\\2601 Smith Residence"\r\n\r\n2601 smith residence\n2604 Lee');
  assert.deepEqual(list.map((p) => p.code), ['2601', '2604']); // blank lines and repeats skipped
});

test('folder names split into customer, reference and site address (Homer\'s list, 2026-10-26)', () => {
  const split = (s) => { const p = parseProjectFolder(s); return splitProjectName(p.name, p.code); };
  assert.deepEqual(split('26-002 DWH, 285 Bridgestone Way, Buda, TX DIR'),
    { customer: 'DWH', reference: null, address: '285 Bridgestone Way\nBuda, TX', note: 'DIR', name: '26-002 DWH - DIR' });
  // The street starts inside the first part (no comma before it).
  assert.deepEqual(split('26-003 Garner NHWIC TX40571901 4602 Finley, Austin, TX DIR'),
    { customer: 'Garner NHWIC TX40571901', reference: null, address: '4602 Finley\nAustin, TX', note: 'DIR', name: '26-003 Garner NHWIC TX40571901 - DIR' });
  assert.deepEqual(split('26-005 Fields, Sierra Homes, 989 Earle Oak Ave. , Bulverde, TX'),
    { customer: 'Fields', reference: 'Sierra Homes', address: '989 Earle Oak Ave.\nBulverde, TX', note: null, name: '26-005 Fields, Sierra Homes' });
  assert.equal(split('26-008 Witte, 12008 Battle Bridge Dr, Austin, TX - XO Opinion').note, 'XO Opinion');
  assert.equal(split('26-012 DWH, 915 Fort Crockett, San Antonio, Texas').address, '915 Fort Crockett\nSan Antonio, TX');
  assert.deepEqual(split('26-007 Trophy Oak'), { customer: null, reference: null, address: null, note: null, name: '26-007 Trophy Oak' });
  assert.deepEqual(parseProjectList('26-009 Arbitration\n26-010 --------------\n26-010 Swimming Pool').map((p) => p.name),
    ['26-009 Arbitration', '26-010 Swimming Pool']); // a divider folder is not a project
});

test('hours as an invoice quantity', () => {
  assert.equal(projects.minutesToQuantity(90), '1.5');
  assert.equal(projects.minutesToQuantity(480), '8');
  assert.equal(projects.minutesToQuantity(50), '0.8333'); // 50/60 = 0.83333… → 0.8333
  assert.equal(projects.minutesToQuantity(20), '0.3333');
  assert.equal(projects.minutesToQuantity(40), '0.6667'); // 0.66666… rounds up
});

test('billing a project: unbilled time and costs, billed once', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase();
  t.after(() => db.drop());
  const { pool } = db;
  const co = await ledger.createCompany(pool, { name: 'Parker Engineering', homeState: 'TX' });
  const A = Object.fromEntries((await ledger.listAccounts(pool, co.id)).map((a) => [a.code, a.id]));
  const { rows: [u] } = await pool.query("INSERT INTO users (email, name, password_hash) VALUES ('homer@example.com', 'Homer', 'x') RETURNING id");
  await pool.query("INSERT INTO memberships (company_id, user_id, role) VALUES ($1, $2, 'owner')", [co.id, u.id]);
  const viewer = { userId: u.id, can: () => true, departmentId: null };
  const dwh = await arap.createContact(pool, co.id, { kind: 'customer', name: 'DWH - SATX' });
  const airline = await arap.createContact(pool, co.id, { kind: 'vendor', name: 'Southwest Airlines' });

  const imported = await projects.importProjects(pool, co.id, { text: '"C:\\Jobs\\2601 Smith Residence"\n"C:\\Jobs\\2602 Jones Roof"', customerId: dwh.id, preview: true });
  assert.deepEqual([imported.added, imported.projects.every((p) => p.isNew)], [0, true]);
  assert.equal((await time.listJobs(pool, co.id)).length, 0); // a preview saves nothing
  assert.equal((await projects.importProjects(pool, co.id, { text: '2601 Smith Residence\n2602 Jones Roof', customerId: dwh.id })).added, 2);
  const again = await projects.importProjects(pool, co.id, { text: '2601 Smith Residence\n2603 Lee', customerId: dwh.id });
  assert.deepEqual([again.added, again.projects.map((p) => p.isNew)], [1, [false, true]]);
  // Names read into parts: the customer matched by name (or added), the address into the site address, and an
  // earlier import of the same folder (full name, no customer) filled in without losing anything.
  await projects.importProjects(pool, co.id, { text: '26-004 Beldon, 101 Paseo Encinal, San Antonio, TX' });
  const parts = await projects.importProjects(pool, co.id, { makeCustomers: true, text:
    '"C:\\Jobs\\26-002 DWH - SATX, 285 Bridgestone Way, Buda, TX DIR"\n26-004 Beldon, 101 Paseo Encinal, San Antonio, TX\n26-007 Trophy Oak' });
  assert.deepEqual(parts.projects.map((p) => [p.name, p.customer, p.customerIsNew, p.status]), [
    ['26-002 DWH - SATX - DIR', 'DWH - SATX', false, 'new'],
    ['26-004 Beldon', 'Beldon', true, 'fills in'],
    ['26-007 Trophy Oak', null, false, 'new']]);
  assert.deepEqual([parts.added, parts.updated, parts.customersAdded], [2, 1, 1]);
  const byCode = Object.fromEntries((await time.listJobs(pool, co.id)).map((j) => [j.code, j]));
  assert.deepEqual([byCode['26-002'].customerName, byCode['26-002'].address], ['DWH - SATX', '285 Bridgestone Way\nBuda, TX']);
  assert.deepEqual([byCode['26-004'].name, byCode['26-004'].customerName, byCode['26-004'].address], ['26-004 Beldon', 'Beldon', '101 Paseo Encinal\nSan Antonio, TX']);
  // Without "add customers", a customer not on the list is left blank.
  const noAdd = await projects.importProjects(pool, co.id, { text: '26-013 Nguyen, 4 Elm St, Kyle, TX' });
  assert.equal((await time.listJobs(pool, co.id)).find((j) => j.code === '26-013').customerId, null);
  assert.equal(noAdd.customersAdded, 0);

  const jobs = Object.fromEntries((await time.listJobs(pool, co.id)).map((j) => [j.code, j]));
  assert.equal(jobs['2601'].customerName, 'DWH - SATX');
  await time.updateJob(pool, co.id, jobs['2601'].id, { ...jobs['2601'], address: '12 Oak St\nSan Antonio, TX' });
  await time.updateJob(pool, co.id, jobs['2601'].id, { name: jobs['2601'].name, code: '2601', customerId: dwh.id }); // no address: kept
  assert.equal((await time.listJobs(pool, co.id)).find((j) => j.code === '2601').address, '12 Oak St\nSan Antonio, TX');

  const t1 = await time.createTimeEntry(pool, co.id, viewer, { date: '2026-10-05', hours: '2.5', jobId: jobs['2601'].id, notes: 'Site visit' });
  const t2 = await time.createTimeEntry(pool, co.id, viewer, { date: '2026-10-06', hours: '0:50', jobId: jobs['2601'].id, notes: 'Report' });
  await time.createTimeEntry(pool, co.id, viewer, { date: '2026-10-06', hours: '1', jobId: jobs['2601'].id, billable: false });
  await time.createTimeEntry(pool, co.id, viewer, { date: '2026-10-07', hours: '3', jobId: jobs['2602'].id });
  const bill = await arap.createDocument(pool, co.id, { kind: 'bill', contactId: airline.id, number: 'SW-1', date: '2026-10-04', lines: [
    { accountId: A['6900'] ?? A['6000'], description: 'Airfare SAT-DAL', amount: '412.30', jobId: jobs['2601'].id, billable: true },
    { accountId: A['6900'] ?? A['6000'], description: 'Bag fee (not billed)', amount: '35', jobId: jobs['2601'].id }] });
  assert.deepEqual(bill.lines.map((l) => [l.jobName, l.billable]), [['2601 Smith Residence', true], ['2601 Smith Residence', false]]);

  const unbilled = await projects.listUnbilled(pool, co.id, { jobId: jobs['2601'].id });
  assert.deepEqual(unbilled.time.map((x) => [x.date, x.quantity, x.notes]), [['2026-10-05', '2.5', 'Site visit'], ['2026-10-06', '0.8333', 'Report']]);
  assert.deepEqual(unbilled.costs.map((x) => [x.description, x.amountCents, x.vendorName]), [['Airfare SAT-DAL', 41230, 'Southwest Airlines']]);
  assert.equal((await projects.listUnbilled(pool, co.id, { customerId: dwh.id })).time.length, 3); // all of DWH's projects
  assert.equal((await projects.listUnbilled(pool, co.id, { jobId: jobs['2601'].id, from: '2026-10-06' })).time.length, 1);

  // 2.5 h × $150 = $375.00; 0.8333 h × $150 = $124.995 → $125.00; airfare passed on at cost $412.30. Total $912.30.
  const lines = [
    ...unbilled.time.map((x) => ({ accountId: A['4000'] ?? A['4100'], description: x.notes, quantity: x.quantity, unitPrice: '150', serviceDate: x.date, timeEntryId: x.id })),
    ...unbilled.costs.map((x) => ({ accountId: A['4000'] ?? A['4100'], description: x.description, amount: x.amountCents, serviceDate: x.date, billedLineId: x.id })),
  ];
  const inv = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, number: '2601', date: '2026-10-10', jobId: jobs['2601'].id, lines });
  assert.equal(inv.totalCents, 91230);
  assert.equal(inv.job.code, '2601');
  assert.equal(inv.lines[0].timeEntryId, t1.id);

  await t.test('billed time and costs drop off the unbilled list and cannot be billed again', async () => {
    const after = await projects.listUnbilled(pool, co.id, { jobId: jobs['2601'].id });
    assert.deepEqual([after.time.length, after.costs.length], [0, 0]);
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [lines[0]] }),
      (e) => e.details.some((d) => /already billed on invoice 2601/.test(d)));
    await assert.rejects(arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [lines[1], lines[1]] }),
      (e) => e.details.some((d) => /twice/.test(d)));
    // Even straight into the database, the backstop refuses a second billing.
    const other = await arap.createDocument(pool, co.id, { kind: 'invoice', contactId: dwh.id, date: '2026-10-11', lines: [{ accountId: A['4000'] ?? A['4100'], amount: '1' }] });
    await assert.rejects(pool.query(`INSERT INTO document_lines (company_id, document_id, account_id, quantity, unit_price_cents, amount_cents, time_entry_id)
      VALUES ($1, $2, $3, '1', 1, 1, $4)`, [co.id, other.id, A['4000'] ?? A['4100'], t1.id]), /already billed/);
    await arap.voidDocument(pool, co.id, other.id);
  });

  await t.test('billed time and the bill behind a billed cost are locked', async () => {
    await assert.rejects(time.updateTimeEntry(pool, co.id, viewer, t2.id, { date: '2026-10-06', hours: '5' }), /billed on invoice 2601/);
    await assert.rejects(time.deleteTimeEntry(pool, co.id, viewer, t2.id), /billed on invoice 2601/);
    await assert.rejects(pool.query('UPDATE time_entries SET minutes = 300 WHERE id = $1', [t2.id]), /billed time entries cannot be changed/);
    await assert.rejects(arap.voidDocument(pool, co.id, bill.id), /billed to a client on invoice 2601/);
    const listed = await time.listTimeEntries(pool, co.id, viewer, { jobId: jobs['2601'].id });
    assert.equal(listed.find((e) => e.id === t2.id).billedOn, '2601');
  });

  await t.test('an edit keeps the billing; a void frees it', async () => {
    const edited = await arap.replaceDocument(pool, co.id, inv.id, { contactId: dwh.id, date: '2026-10-10', jobId: jobs['2601'].id,
      lines: inv.lines.map((l) => ({ accountId: l.accountId, description: l.description, quantity: l.quantity, unitPrice: l.unitPriceCents,
        serviceDate: l.serviceDate, timeEntryId: l.timeEntryId, billedLineId: l.billedLineId })) });
    assert.equal(edited.number, '2601');
    assert.equal((await projects.listUnbilled(pool, co.id, { jobId: jobs['2601'].id })).time.length, 0);
    await arap.voidDocument(pool, co.id, edited.id);
    const freed = await projects.listUnbilled(pool, co.id, { jobId: jobs['2601'].id });
    assert.deepEqual([freed.time.length, freed.costs.length], [2, 1]);
    await time.updateTimeEntry(pool, co.id, viewer, t2.id, { date: '2026-10-06', hours: '1' }); // editable again
    await arap.voidDocument(pool, co.id, bill.id); // and so is the bill
  });
});
