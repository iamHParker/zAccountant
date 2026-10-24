// HTTP API (Express). ℹ️ A "route" is like a subroutine the browser calls by URL:
//   GET  = read something, POST = create something, PATCH = change a setting.
// All money in requests may be decimal strings ("1234.56"); all money in responses is integer cents.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { LedgerError } from './core/ledger.js';
import { PayrollError } from './payroll/engine.js';
import * as ledger from './services/ledgerService.js';
import * as reports from './services/reportService.js';
import * as payroll from './services/payrollService.js';
import { verifyChain } from './services/audit.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

export function createApp(pool) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // 'unsafe-eval' is needed only because the MVP UI compiles Vue templates in the browser;
      // it goes away when the UI gets a build step (Sprint 7).
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  const api = express.Router();
  api.param('companyId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Company not found' })));
  api.param('accountId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Account not found' })));
  api.param('entryId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Entry not found' })));
  api.param('employeeId', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Employee not found' })));

  // Companies
  api.get('/companies', async (req, res) => res.json(await ledger.listCompanies(pool)));
  api.post('/companies', async (req, res) => {
    const { name, homeState, fiscalYearStartMonth } = req.body ?? {};
    res.status(201).json(await ledger.createCompany(pool, { name, homeState, fiscalYearStartMonth }));
  });
  api.get('/companies/:companyId', async (req, res) => res.json(await ledger.getCompany(pool, req.params.companyId)));
  api.patch('/companies/:companyId/settings', async (req, res) => res.json(await ledger.updateCompanySettings(pool, req.params.companyId, req.body ?? {})));
  api.post('/companies/:companyId/lock', async (req, res) => res.json(await ledger.lockPeriod(pool, req.params.companyId, { through: req.body?.through ?? null })));

  // Accounts
  api.get('/companies/:companyId/accounts', async (req, res) => res.json(await ledger.listAccounts(pool, req.params.companyId)));
  api.post('/companies/:companyId/accounts', async (req, res) => res.status(201).json(await ledger.createAccount(pool, req.params.companyId, req.body ?? {})));
  api.get('/companies/:companyId/accounts/:accountId/register', async (req, res) =>
    res.json(await reports.getAccountRegister(pool, req.params.companyId, req.params.accountId, { from: req.query.from || null, to: req.query.to || null })));

  // Journal
  api.get('/companies/:companyId/entries', async (req, res) =>
    res.json(await ledger.listEntries(pool, req.params.companyId, { from: req.query.from || null, to: req.query.to || null, limit: req.query.limit })));
  api.post('/companies/:companyId/entries', async (req, res) => res.status(201).json(await ledger.postEntry(pool, req.params.companyId, req.body ?? {})));
  api.post('/companies/:companyId/entries/simple', async (req, res) => res.status(201).json(await ledger.postSimple(pool, req.params.companyId, req.body ?? {})));
  api.post('/companies/:companyId/entries/:entryId/reverse', async (req, res) =>
    res.status(201).json(await ledger.reverseEntry(pool, req.params.companyId, req.params.entryId, { date: req.body?.date, memo: req.body?.memo })));

  // Reports
  const id = (req) => req.params.companyId;
  api.get('/companies/:companyId/reports/dashboard', async (req, res) => res.json(await reports.getDashboard(pool, id(req), { asOf: req.query.asOf || today() })));
  api.get('/companies/:companyId/reports/trial-balance', async (req, res) => res.json(await reports.getTrialBalance(pool, id(req), { asOf: req.query.asOf || today() })));
  api.get('/companies/:companyId/reports/balance-sheet', async (req, res) => res.json(await reports.getBalanceSheet(pool, id(req), { asOf: req.query.asOf || today() })));
  api.get('/companies/:companyId/reports/income-statement', async (req, res) => res.json(await reports.getIncomeStatement(pool, id(req), { from: req.query.from, to: req.query.to })));
  api.get('/companies/:companyId/reports/cash-flow', async (req, res) => res.json(await reports.getCashFlow(pool, id(req), { from: req.query.from, to: req.query.to })));
  api.get('/companies/:companyId/audit/verify', async (req, res) => res.json(await verifyChain(pool, id(req))));

  // Payroll
  api.get('/companies/:companyId/employees', async (req, res) => res.json(await payroll.listEmployees(pool, id(req))));
  api.post('/companies/:companyId/employees', async (req, res) => res.status(201).json(await payroll.createEmployee(pool, id(req), req.body ?? {})));
  api.post('/companies/:companyId/employees/:employeeId/paychecks/preview', async (req, res) =>
    res.json(await payroll.previewPaycheck(pool, id(req), req.params.employeeId, req.body ?? {})));
  api.post('/companies/:companyId/employees/:employeeId/paychecks', async (req, res) =>
    res.status(201).json(await payroll.postPaycheck(pool, id(req), req.params.employeeId, req.body ?? {})));
  api.get('/companies/:companyId/paychecks', async (req, res) =>
    res.json(await payroll.listPaychecks(pool, id(req), { year: req.query.year ? Number(req.query.year) : undefined })));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Static UI
  const vuePath = fileURLToPath(new URL('../node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url));
  app.get('/vendor/vue.js', (req, res) => res.type('text/javascript').sendFile(vuePath));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

  // Errors -> JSON. User mistakes are 400 with a readable message; anything else is 500 without internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof LedgerError || err instanceof PayrollError) {
      const status = /not found/i.test(err.message) ? 404 : 400;
      return res.status(status).json({ error: err.message, details: err.details ?? [] });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.code === '23514' || err.code === '23505' || err.code === '22P02' || err.code === '23503') {
      return res.status(400).json({ error: err.code === '23505' ? 'That code or number is already in use' : err.message });
    }
    if (err.code === '42501') return res.status(400).json({ error: err.message });
    console.error(JSON.stringify({ level: 'error', msg: err.message, path: req.path }));
    res.status(500).json({ error: 'Something went wrong on our side. Nothing was saved.' });
  });
  return app;
}
