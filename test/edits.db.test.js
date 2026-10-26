// The CPA edit sweep (docs/board/edit-sweep.md), batch 2: master-data edits, through HTTP as the restricted runtime role
// (so each new UPDATE grant in src/db/grant.js is exercised the way production runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, freshDatabase } from './db.js';
import { createApp } from '../src/app.js';
import { totpCode } from '../src/security/totp.js';

process.env.AUTH_RATE_LIMIT = '1000';

test('edits: company, accounts, recurring entries, bank rules, employees', { skip: !hasDb && 'DATABASE_URL not set' }, async (t) => {
  const db = await freshDatabase({ withAppRole: true });
  const server = createApp(db.appPool, { log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(async () => { server.close(); await db.drop(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await call('POST', '/api/auth/signup', { email: 'owner@example.com', name: 'Owner', password: 'a long enough passphrase' });
  const setup = await call('POST', '/api/auth/mfa/setup', {});
  await call('POST', '/api/auth/mfa/enable', { code: totpCode(setup.body.secret, Date.now()) });
  const co = (await call('POST', '/api/companies', { name: 'Parker Engr', homeState: 'TX', fiscalYearStartMonth: 1 })).body;
  const c = `/api/companies/${co.id}`;
  const A = Object.fromEntries((await call('GET', `${c}/accounts`)).body.map((a) => [a.code, a]));
  const ok = (r, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));
  const refused = (r, re) => { assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), re); };

  await t.test('company name, home state and fiscal-year start', async () => {
    const r = await call('PATCH', `${c}/profile`, { name: 'Parker Engineering, PLLC', homeState: 'CO', fiscalYearStartMonth: 7 });
    ok(r);
    assert.equal(r.body.name, 'Parker Engineering, PLLC');
    assert.equal(r.body.home_state, 'CO');
    assert.equal(r.body.fiscal_year_start_month, 7);
    refused(await call('PATCH', `${c}/profile`, { fiscalYearStartMonth: 13 }), /month from 1 to 12/);
    refused(await call('PATCH', `${c}/profile`, { homeState: 'NY' }), /TX, CO, CA or DC/);
    ok(await call('POST', `${c}/lock`, { through: '2025-12-31' }));
    refused(await call('PATCH', `${c}/profile`, { fiscalYearStartMonth: 1 }), /closed through 2025-12-31/);
    ok(await call('PATCH', `${c}/profile`, { name: 'Parker Engineering' })); // a name change is fine while closed
  });

  await t.test('account kind, turn off only at $0 and when nothing uses it', async () => {
    const supplies = (await call('POST', `${c}/accounts`, { code: '6450', name: 'Field supplies', type: 'expense', subtype: 'operating' })).body;
    ok(await call('PATCH', `${c}/accounts/${supplies.id}`, { subtype: 'cogs' }));
    refused(await call('PATCH', `${c}/accounts/${A['1100'].id}`, { isActive: false }), /built-in/);
    ok(await call('POST', `${c}/entries/simple`, { date: '2026-03-02', memo: 'Gloves', amount: '45.10', fromAccountId: A['1000'].id, toAccountId: supplies.id }), 201);
    refused(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false }), /balance is \$45\.10/);
    const rule = (await call('POST', `${c}/bank-rules`, { matchText: 'home depot', direction: 'out', accountId: supplies.id })).body;
    const e = (await call('POST', `${c}/entries`, { date: '2026-03-03', memo: 'Move to supplies', lines: [{ accountId: A['6300'].id, debit: '45.10' }, { accountId: supplies.id, credit: '45.10' }] }));
    ok(e, 201);
    refused(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false }), /bank rule/);
    ok(await call('DELETE', `${c}/bank-rules/${rule.id}`, {}));
    const off = await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: false });
    ok(off);
    assert.equal(off.body.isActive, false);
    refused(await call('POST', `${c}/entries/simple`, { date: '2026-03-04', memo: 'x', amount: '1', fromAccountId: A['1000'].id, toAccountId: supplies.id }), /active/i);
    ok(await call('PATCH', `${c}/accounts/${supplies.id}`, { isActive: true }));
  });

  await t.test('recurring entry: change the amount from the next date on, end early, restart', async () => {
    const lines = (amt) => [{ accountId: A['6300'].id, debit: amt }, { accountId: A['1000'].id, credit: amt }];
    const r = (await call('POST', `${c}/recurring`, { name: 'Office rent', frequency: 'monthly', startDate: '2026-04-01', memo: 'Rent', lines: lines('1800') })).body;
    ok(await call('POST', `${c}/recurring/post-due`, {})); // posts April through this month
    const before = (await call('GET', `${c}/recurring`)).body.find((x) => x.id === r.id);
    assert.ok(before.postedCount >= 1);
    const ch = await call('PUT', `${c}/recurring/${r.id}`, { name: 'Office rent (new lease)', memo: 'Rent', lines: lines('1950'), endDate: '2027-03-31' });
    ok(ch);
    assert.equal(ch.body.amountCents, 195000);
    assert.equal(ch.body.postedCount, before.postedCount, 'nothing posted already changes');
    const { body: { entries } } = await call('GET', `${c}/entries?source=recurring`);
    assert.ok(entries.every((e) => e.lines.some((l) => l.debitCents === 180000)), 'posted rent stays $1,800');
    refused(await call('PUT', `${c}/recurring/${r.id}`, { lines: [{ accountId: A['6300'].id, debit: '1' }, { accountId: A['1000'].id, credit: '2' }] }), /balance|equal/i);
    ok(await call('POST', `${c}/recurring/${r.id}/stop`, {}));
    const again = await call('PUT', `${c}/recurring/${r.id}`, { restart: true });
    ok(again);
    assert.equal(again.body.isActive, true);
    const ended = await call('PUT', `${c}/recurring/${r.id}`, { endDate: '2026-04-01' });
    ok(ended);
    assert.equal(ended.body.nextDate, null, 'an end date already passed finishes it');
  });

  await t.test('bank rule edit', async () => {
    const rule = (await call('POST', `${c}/bank-rules`, { matchText: 'shell oil', direction: 'out', accountId: A['6300'].id })).body;
    const r = await call('PUT', `${c}/bank-rules/${rule.id}`, { matchText: 'shell', direction: 'any', accountId: A['1000'].id, min: '10.00' });
    ok(r);
    assert.equal(r.body.matchText, 'shell');
    assert.equal(Number(r.body.minCents), 1000);
    refused(await call('PUT', `${c}/bank-rules/${rule.id}`, { matchText: 'x', accountId: A['1000'].id }), /2-100/);
  });

  await t.test('employee edit: past paychecks keep the details they were figured with', async () => {
    ok(await call('PATCH', `${c}/settings`, { calculateOnlyPayroll: true }));
    const emp = (await call('POST', `${c}/employees`, { firstName: 'Ann', lastName: 'Lee', workState: 'TX', payFrequency: 'biweekly',
      payType: 'hourly', payRate: '30', w4: { formYear: 2020, filingStatus: 'single' }, hireDate: '2026-01-05' })).body;
    assert.equal(emp.hireDate, '2026-01-05');
    const first = await call('POST', `${c}/employees/${emp.id}/paychecks`, { payDate: '2026-03-13', hours: '80', paidFromAccountId: A['1000'].id });
    ok(first, 201);
    refused(await call('PATCH', `${c}/profile`, { homeState: 'TX' }), /payroll has already run/);

    const ch = await call('PUT', `${c}/employees/${emp.id}`, { lastName: 'Lee-Park', workState: 'CA', payRate: '32.50',
      stateElections: { CA: { filingStatus: 'single', allowances: 1 } }, address: { line1: '12 Oak St', city: 'Fresno', state: 'ca', zip: '93701' } });
    ok(ch);
    assert.equal(ch.body.lastName, 'Lee-Park');
    assert.equal(ch.body.payRateCents, 3250);
    assert.deepEqual(ch.body.address, { line1: '12 Oak St', city: 'Fresno', state: 'CA', zip: '93701' });
    refused(await call('PUT', `${c}/employees/${emp.id}`, { payRate: '0', address: { zip: '9370' } }), /pay rate[\s\S]*ZIP/);

    const stub1 = (await call('GET', `${c}/paychecks/${first.body.paycheckId}/stub`)).body;
    assert.equal(stub1.employee.name, 'Ann Lee', 'the March stub keeps the name it was paid under');
    assert.equal(stub1.employee.workState, 'TX');
    assert.equal(stub1.earnings[0].rateCents, 3000);
    const second = await call('POST', `${c}/employees/${emp.id}/paychecks`, { payDate: '2026-03-27', hours: '80', paidFromAccountId: A['1000'].id });
    ok(second, 201);
    assert.equal(second.body.grossCents, 260000, '80 h x $32.50');
    assert.ok(second.body.employeeTaxes.some((x) => x.code === 'CA_PIT'), 'taxed for California from now on');
    const liab = (await call('GET', `${c}/reports/payroll-liabilities?from=2026-03-01&to=2026-03-31`)).body;
    assert.ok(JSON.stringify(liab).includes('CA'), 'California withholding goes to California');
    const list = (await call('GET', `${c}/paychecks?year=2026`)).body.map((p) => p.employee);
    assert.deepEqual(list, ['Ann Lee-Park', 'Ann Lee']);

    const audit = await db.pool.query("SELECT payload FROM audit_log WHERE entity = 'employee' AND action = 'update'");
    assert.deepEqual(audit.rows[0].payload.payRateCents, { from: 3000, to: 3250 });
    assert.equal(audit.rows[0].payload.stateElections, 'changed');

    const ssn = await call('PUT', `${c}/employees/${emp.id}`, { ssn: '123-45-6789' });
    ok(ssn);
    assert.equal(ssn.body.ssnLast4, '6789');
    const noAudit = await db.pool.query("SELECT payload FROM audit_log WHERE entity = 'employee' AND payload::text LIKE '%123456789%'");
    assert.equal(noAudit.rows.length, 0, 'the SSN never reaches the audit trail');
  });

  await t.test('terminate and rehire', async () => {
    const emp = (await call('GET', `${c}/employees`)).body[0];
    refused(await call('POST', `${c}/employees/${emp.id}/terminate`, { date: '2025-12-31' }), /before they started/);
    const off = await call('POST', `${c}/employees/${emp.id}/terminate`, { date: '2026-04-10', reason: 'moved away' });
    ok(off);
    assert.equal(off.body.active, false);
    assert.equal(off.body.terminationDate, '2026-04-10');
    assert.equal((await call('POST', `${c}/employees/${emp.id}/paychecks/preview`, { payDate: '2026-04-24', hours: '8' })).status, 400);
    refused(await call('POST', `${c}/employees/${emp.id}/rehire`, { date: '2026-04-10' }), /after their last day/);
    const back = await call('POST', `${c}/employees/${emp.id}/rehire`, { date: '2026-06-01' });
    ok(back);
    assert.equal(back.body.active, true);
    assert.equal(back.body.hireDate, '2026-06-01');
    assert.equal(back.body.terminationDate, null);
  });

  // ---------------------------------------------------------------- batch 4: ledger corrections
  await t.test('journal entry edit = reversal + corrected entry', async () => {
    const e = (await call('POST', `${c}/entries`, { date: '2026-05-04', memo: 'Depreciation', lines: [{ accountId: A['6300'].id, debit: '500' }, { accountId: A['1000'].id, credit: '500' }] })).body;
    const fix = await call('PUT', `${c}/entries/${e.id}`, { date: '2026-05-04', memo: 'Depreciation (corrected)', lines: [{ accountId: A['6300'].id, debit: '520' }, { accountId: A['1000'].id, credit: '520' }] });
    ok(fix);
    assert.equal(fix.body.correctsNumber, e.entry_number);
    assert.equal(fix.body.reversalNumber, e.entry_number + 1);
    refused(await call('PUT', `${c}/entries/${e.id}`, { date: '2026-05-04', memo: 'again', lines: [{ accountId: A['6300'].id, debit: '1' }, { accountId: A['1000'].id, credit: '1' }] }), /already reversed/);
    const inv = (await call('POST', `${c}/invoices`, { contactId: (await call('POST', `${c}/customers`, { name: 'City of Austin' })).body.id, date: '2026-05-05', lines: [{ accountId: A['4100'].id, amount: '900' }] })).body;
    refused(await call('PUT', `${c}/entries/${inv.journalEntryId}`, { date: '2026-05-05', memo: 'x', lines: [{ accountId: A['6300'].id, debit: '1' }, { accountId: A['1000'].id, credit: '1' }] }), /invoice/);
  });

  await t.test('paid invoice: memo, PO and due date change in place; amounts never', async () => {
    const cust = (await call('POST', `${c}/customers`, { name: 'TxDOT' })).body;
    const inv = (await call('POST', `${c}/invoices`, { contactId: cust.id, date: '2026-05-06', lines: [{ accountId: A['4100'].id, amount: '1200' }] })).body;
    ok(await call('POST', `${c}/payments-received`, { contactId: cust.id, date: '2026-05-20', accountId: A['1000'].id, applications: [{ documentId: inv.id, amount: '1200' }] }), 201);
    const r = await call('PATCH', `${c}/documents/${inv.id}`, { memo: 'Bridge inspection', clientRef: 'PO 4471', dueDate: '2026-06-30' });
    ok(r);
    assert.equal(r.body.memo, 'Bridge inspection');
    assert.equal(r.body.clientRef, 'PO 4471');
    assert.equal(r.body.totalCents, 120000);
    assert.equal(r.body.status, 'paid');
    refused(await call('PATCH', `${c}/documents/${inv.id}`, { dueDate: '2026-05-01' }), /on or after the date/);
  });

  await t.test('void a whole payroll run, then run the period again', async () => {
    const w = (await call('POST', `${c}/employees`, { firstName: 'Wes', lastName: 'Kent', workState: 'TX', payFrequency: 'weekly', payType: 'hourly', payRate: '25', w4: { filingStatus: 'single' } })).body;
    const opts = { payFrequency: 'weekly', periodStart: '2026-05-03', periodEnd: '2026-05-09', payDate: '2026-05-15', paidFromAccountId: A['1000'].id, items: [{ employeeId: w.id, hours: '40' }] };
    const run = (await call('POST', `${c}/payroll-runs`, opts)).body;
    refused(await call('POST', `${c}/payroll-runs`, opts), /already paid/);
    refused(await call('POST', `${c}/payroll-runs/${run.id}/void`, {}), /reason/);
    const v = await call('POST', `${c}/payroll-runs/${run.id}/void`, { reason: 'wrong hours' });
    ok(v);
    assert.equal(v.body.paychecksVoided, 1);
    assert.equal(v.body.voidReason, 'wrong hours');
    refused(await call('POST', `${c}/payroll-runs/${run.id}/void`, { reason: 'again' }), /already void/);
    const again = await call('POST', `${c}/payroll-runs`, { ...opts, items: [{ employeeId: w.id, hours: '38' }] });
    ok(again, 201);
    assert.equal(again.body.grossCents, 95000, '38 h x $25');
    await assert.rejects(db.pool.query('UPDATE payroll_runs SET gross_cents = 1 WHERE id = $1', [run.id]), /append-only/);
  });

  await t.test('reopen the latest reconciliation; undo a statement import', async () => {
    const csv = 'Date,Description,Amount\n05/01/2026,DEPOSIT,1000.00\n05/02/2026,SHELL OIL,-40.00\n05/03/2026,HOME DEPOT,-60.00\n';
    const imp = (await call('POST', `${c}/bank-accounts/${A['1010'].id}/import`, { fileName: 'may.csv', content: csv })).body;
    assert.equal(imp.new, 3);
    const lines = (await call('GET', `${c}/bank-accounts/${A['1010'].id}/transactions`)).body;
    ok(await call('POST', `${c}/bank-transactions/${lines.find((l) => l.description === 'DEPOSIT').id}/post`, { accountId: A['4100'].id }));
    const imports = (await call('GET', `${c}/bank-accounts/${A['1010'].id}/imports`)).body;
    assert.deepEqual([imports[0].fileName, imports[0].lines, imports[0].undoable], ['may.csv', 3, 2]);
    const u = await call('POST', `${c}/bank-imports/${imp.batch}/undo`, {});
    ok(u);
    assert.deepEqual(u.body, { removed: 2, kept: 1 });
    refused(await call('POST', `${c}/bank-imports/${imp.batch}/undo`, {}), /already in the books/);
    assert.equal((await call('POST', `${c}/bank-accounts/${A['1010'].id}/import`, { fileName: 'may.csv', content: csv })).body.new, 2, 'the undone lines import again');

    const rec = (await call('POST', `${c}/bank-accounts/${A['1010'].id}/reconciliations`, { statementDate: '2026-05-31', endingBalance: '1000' })).body;
    const sheet = (await call('GET', `${c}/reconciliations/${rec.id}`)).body;
    ok(await call('POST', `${c}/reconciliations/${rec.id}/lines`, { lineIds: sheet.lines.map((l) => l.id) }));
    ok(await call('POST', `${c}/reconciliations/${rec.id}/complete`, {}));
    refused(await call('POST', `${c}/reconciliations/${rec.id}/reopen`, {}), /why/);
    const re = await call('POST', `${c}/reconciliations/${rec.id}/reopen`, { reason: 'typed the wrong ending balance' });
    ok(re);
    assert.equal(re.body.status, 'open');
    assert.equal(re.body.lines.filter((l) => l.cleared).length, sheet.lines.length, 'the ticks stay');
    // Cancelling an open reconciliation really removes it (it used to stay behind: the old trigger returned NULL on DELETE).
    ok(await call('DELETE', `${c}/reconciliations/${rec.id}`, {}));
    ok(await call('POST', `${c}/bank-accounts/${A['1010'].id}/reconciliations`, { statementDate: '2026-05-31', endingBalance: '1000' }), 201);
  });
});
