// HTTP API (Express). ℹ️ A "route" is like a subroutine the browser calls by URL:
//   GET  = read something, POST = create something, PATCH = change a setting.
// All money in requests may be decimal strings ("1234.56"); all money in responses is integer cents.
//
// Every /api route except sign-in requires: a valid session cookie, a completed two-factor check,
// and (for company routes) a membership whose role allows the action. Each request then runs in one
// database transaction tagged with the user and company, which row-level security enforces.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { LedgerError } from './core/ledger.js';
import { PayrollError } from './payroll/engine.js';
import { withScope } from './db/pool.js';
import * as ledger from './services/ledgerService.js';
import * as reports from './services/reportService.js';
import * as payroll from './services/payrollService.js';
import * as auth from './services/authService.js';
import { AuthError } from './services/authService.js';
import { verifyChain } from './services/audit.js';
import { runBooksCheck, latestBooksCheck, centralToday } from './jobs/booksCheck.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);
const q = (v) => (typeof v === 'string' && v !== '' ? v : null); // ignore repeated (?a=1&a=2) or empty params

/** What each role may do. Reading is allowed for every member. */
export const PERMISSIONS = Object.freeze({
  read: ['owner', 'accountant', 'bookkeeper', 'viewer'],
  post: ['owner', 'accountant', 'bookkeeper'],            // record & reverse transactions
  accounts: ['owner', 'accountant'],                      // change the chart of accounts
  close: ['owner', 'accountant'],                         // close periods (reopening: owner + fresh 2FA code)
  payroll: ['owner', 'accountant'],                       // employees, paychecks
  audit: ['owner', 'accountant'],
  admin: ['owner'],                                       // settings, members
});

// Host names this server answers to. Anything else is refused, which blocks "DNS rebinding"
// (a malicious web page tricking the browser into talking to this server).
const allowedHosts = () => new Set((process.env.ALLOWED_HOSTS ?? 'localhost,127.0.0.1').split(',').map((h) => h.trim().toLowerCase()));

const secureCookies = () => process.env.NODE_ENV === 'production';
const COOKIE = () => (secureCookies() ? '__Host-zacc_session' : 'zacc_session');

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function setSessionCookie(res, token) {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${12 * 3600}`];
  if (secureCookies()) attrs.push('Secure');
  res.append('Set-Cookie', `${COOKIE()}=${encodeURIComponent(token)}; ${attrs.join('; ')}`);
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies() ? '; Secure' : ''}`);
}

/** Tiny in-memory rate limiter (per IP + bucket). A shared store (Redis) replaces it when we run >1 server. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) hits.set(key, { start: now, n: 1 });
    else if (++h.n > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    if (hits.size > 10_000) for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
    return next();
  };
}

export function createApp(pool) {
  const app = express();
  const hosts = allowedHosts();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!hosts.has(host)) return res.status(421).json({ error: 'Unknown host' });
    // Cross-site request forgery guard (with SameSite=Strict cookies): anything that changes data must
    // be JSON and, if the browser says where it came from (Origin), it must come from this same site.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.path.startsWith('/api/')) {
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send data as application/json' });
      const origin = req.headers.origin;
      if (origin) {
        let originHost;
        try { originHost = new URL(origin).host.toLowerCase(); } catch { originHost = null; }
        if (originHost !== (req.headers.host ?? '').toLowerCase()) return res.status(403).json({ error: 'Cross-site request refused' });
      }
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // 'unsafe-eval' is needed only because the MVP UI compiles Vue templates in the browser;
      // it goes away when the UI gets a build step (Sprint 7).
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (secureCookies()) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });

  // ------------------------------------------------------------------ Sign-in (no session needed)
  const authApi = express.Router();
  authApi.use(rateLimiter({ windowMs: 5 * 60_000, max: Number(process.env.AUTH_RATE_LIMIT ?? 30) }));
  const session = async (req) => auth.getSession(pool, readCookie(req, COOKIE()));

  authApi.post('/signup', async (req, res) => {
    const { email, password, name } = req.body ?? {};
    const r = await auth.signup(pool, { email, password, name });
    setSessionCookie(res, r.token);
    res.status(201).json({ user: r.user, next: r.next });
  });
  authApi.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    const r = await auth.login(pool, { email, password });
    setSessionCookie(res, r.token);
    res.json({ user: r.user, next: r.next });
  });
  authApi.post('/logout', async (req, res) => {
    await auth.logout(pool, readCookie(req, COOKIE()));
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  authApi.get('/me', async (req, res) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Not signed in' });
    const next = s.session.mfa_passed ? null : (s.user.mfaEnabled ? 'mfa_verify' : 'mfa_setup');
    res.json({ user: s.user, next });
  });
  authApi.post('/mfa/setup', async (req, res) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Not signed in' });
    res.json(await auth.mfaSetup(pool, s.user.id));
  });
  authApi.post('/mfa/enable', async (req, res) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Not signed in' });
    res.json(await auth.mfaEnable(pool, s.user.id, s.session.token_hash, req.body?.code));
  });
  authApi.post('/mfa/verify', async (req, res) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Not signed in' });
    const r = await auth.mfaVerify(pool, s.user.id, s.session.token_hash, { code: req.body?.code, recoveryCode: req.body?.recoveryCode });
    setSessionCookie(res, r.token);
    res.json({ ok: true });
  });
  app.use('/api/auth', authApi);

  // ------------------------------------------------------------------ Everything else needs a full sign-in
  const api = express.Router();
  api.use(async (req, res, next) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    if (!s.session.mfa_passed) return res.status(401).json({ error: 'Enter your two-factor code to continue', next: s.user.mfaEnabled ? 'mfa_verify' : 'mfa_setup' });
    req.user = s.user;
    next();
  });

  /**
   * Wrap a handler: checks the role for company routes, runs it in a request transaction scoped to the
   * user and company, commits, then responds. handler({ db, req, companyId, role, actor }) returns the body.
   */
  const route = (permission, handler, status = 200) => async (req, res) => {
    const companyId = req.params.companyId ?? null;
    if (companyId && !UUID.test(companyId)) return res.status(404).json({ error: 'Company not found' });
    for (const p of ['accountId', 'entryId', 'employeeId', 'paycheckId', 'userId', 'recurringId']) {
      if (req.params[p] !== undefined && !UUID.test(req.params[p])) return res.status(404).json({ error: 'Not found' });
    }
    const body = await withScope(pool, { userId: req.user.id, companyId }, async (db) => {
      let role = null;
      if (companyId) {
        role = await auth.getRole(db, req.user.id, companyId);
        if (!role) throw new AuthError('Company not found', 404); // don't reveal that other companies exist
        if (!PERMISSIONS[permission].includes(role)) throw new AuthError(`Your role (${role}) can't do that. Ask the company owner.`, 403);
      }
      return handler({ db, req, companyId, role, actor: req.user.email });
    });
    res.status(status).json(body);
  };

  // Companies
  api.get('/companies', route(null, ({ db, req }) => ledger.listCompanies(db, { userId: req.user.id })));
  api.post('/companies', route(null, ({ db, req, actor }) => {
    const { name, homeState, fiscalYearStartMonth } = req.body ?? {};
    return ledger.createCompany(db, { name, homeState, fiscalYearStartMonth, actor, ownerUserId: req.user.id });
  }, 201));
  api.get('/companies/:companyId', route('read', async ({ db, companyId, role }) => ({ ...(await ledger.getCompany(db, companyId)), role })));
  api.patch('/companies/:companyId/settings', route('admin', ({ db, req, companyId, actor }) => {
    const { suiRatePct, calculateOnlyPayroll, famliHeadcount } = req.body ?? {};
    return ledger.updateCompanySettings(db, companyId, { suiRatePct, calculateOnlyPayroll, famliHeadcount, actor });
  }));
  api.post('/companies/:companyId/lock', route('close', async ({ db, req, companyId, role, actor }) => {
    const through = req.body?.through ?? null;
    const co = await ledger.getCompany(db, companyId);
    const reopening = co.locked_through && (through === null || through < co.locked_through);
    if (reopening) {
      // Reopening closed books: owner only, with a fresh two-factor code.
      if (role !== 'owner') throw new AuthError('Only the company owner can reopen closed books', 403);
      await auth.checkSecondFactor(db, req.user.id, { code: req.body?.mfaCode });
    }
    return ledger.lockPeriod(db, companyId, { through, reason: req.body?.reason ?? null, actor });
  }));

  // Members
  api.get('/companies/:companyId/members', route('read', ({ db, companyId }) => auth.listMembers(db, companyId)));
  api.post('/companies/:companyId/members', route('admin', async ({ db, req, companyId, actor }) => {
    const m = await auth.addMember(db, companyId, { email: req.body?.email, role: req.body?.role });
    await ledger.auditOnly(db, companyId, { action: 'set_member', entity: 'membership', entityId: m.id, actor, payload: { email: m.email, role: m.role } });
    return m;
  }, 201));
  api.delete('/companies/:companyId/members/:userId', route('admin', async ({ db, req, companyId, actor }) => {
    await auth.removeMember(db, companyId, req.params.userId);
    await ledger.auditOnly(db, companyId, { action: 'remove_member', entity: 'membership', entityId: req.params.userId, actor, payload: {} });
    return { ok: true };
  }));

  // Accounts
  api.get('/companies/:companyId/accounts', route('read', ({ db, companyId }) => ledger.listAccounts(db, companyId)));
  api.post('/companies/:companyId/accounts', route('accounts', ({ db, req, companyId, actor }) => {
    const { code, name, type, subtype } = req.body ?? {};
    return ledger.createAccount(db, companyId, { code, name, type, subtype, actor });
  }, 201));
  api.get('/companies/:companyId/accounts/:accountId/register', route('read', ({ db, req, companyId }) =>
    reports.getAccountRegister(db, companyId, req.params.accountId, { from: q(req.query.from), to: q(req.query.to) })));

  // Journal
  const idemKey = (req) => req.get('Idempotency-Key') ?? req.body?.idempotencyKey ?? null;
  api.get('/companies/:companyId/entries', route('read', ({ db, req, companyId }) =>
    ledger.listEntries(db, companyId, {
      from: q(req.query.from), to: q(req.query.to), text: q(req.query.text), accountId: q(req.query.accountId),
      min: q(req.query.min), max: q(req.query.max), source: q(req.query.source), limit: q(req.query.limit), offset: q(req.query.offset),
    })));
  api.post('/companies/:companyId/entries', route('post', ({ db, req, companyId, actor }) =>
    ledger.postEntry(db, companyId, req.body ?? {}, { actor, idempotencyKey: idemKey(req) }), 201));
  api.post('/companies/:companyId/entries/simple', route('post', ({ db, req, companyId, actor }) =>
    ledger.postSimple(db, companyId, req.body ?? {}, { actor, idempotencyKey: idemKey(req) }), 201));
  api.post('/companies/:companyId/entries/:entryId/reverse', route('post', ({ db, req, companyId, actor }) =>
    ledger.reverseEntry(db, companyId, req.params.entryId, { date: req.body?.date, memo: req.body?.memo, actor, idempotencyKey: idemKey(req) }), 201));

  // Recurring entries
  api.get('/companies/:companyId/recurring', route('read', ({ db, companyId }) => ledger.listRecurring(db, companyId)));
  api.post('/companies/:companyId/recurring', route('post', ({ db, req, companyId, actor }) => {
    const { name, frequency, startDate, endDate, memo, lines } = req.body ?? {};
    return ledger.createRecurring(db, companyId, { name, frequency, startDate, endDate, memo, lines, actor });
  }, 201));
  api.post('/companies/:companyId/recurring/:recurringId/stop', route('post', ({ db, req, companyId, actor }) =>
    ledger.stopRecurring(db, companyId, req.params.recurringId, { actor })));
  api.post('/companies/:companyId/recurring/post-due', route('post', ({ db, companyId, actor }) =>
    ledger.postDueRecurring(db, companyId, { asOf: centralToday(), actor })));

  // Reports
  api.get('/companies/:companyId/reports/dashboard', route('read', ({ db, req, companyId }) => reports.getDashboard(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/trial-balance', route('read', ({ db, req, companyId }) => reports.getTrialBalance(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/balance-sheet', route('read', ({ db, req, companyId }) => reports.getBalanceSheet(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/income-statement', route('read', ({ db, req, companyId }) => reports.getIncomeStatement(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.get('/companies/:companyId/reports/cash-flow', route('read', ({ db, req, companyId }) => reports.getCashFlow(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.get('/companies/:companyId/audit/verify', route('audit', ({ db, companyId }) => verifyChain(db, companyId)));
  api.get('/companies/:companyId/books-check', route('read', ({ db, companyId }) => latestBooksCheck(db, companyId)));
  api.post('/companies/:companyId/books-check', route('audit', ({ db, companyId }) => runBooksCheck(db, companyId)));

  // Payroll
  api.get('/companies/:companyId/employees', route('read', ({ db, companyId }) => payroll.listEmployees(db, companyId)));
  api.post('/companies/:companyId/employees', route('payroll', ({ db, req, companyId, actor }) => payroll.createEmployee(db, companyId, req.body ?? {}, { actor }), 201));
  api.post('/companies/:companyId/employees/:employeeId/paychecks/preview', route('payroll', ({ db, req, companyId }) =>
    payroll.previewPaycheck(db, companyId, req.params.employeeId, req.body ?? {})));
  api.post('/companies/:companyId/employees/:employeeId/paychecks', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.postPaycheck(db, companyId, req.params.employeeId,
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') ?? req.body?.idempotencyKey }, { actor }), 201));
  api.post('/companies/:companyId/paychecks/:paycheckId/void', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.voidPaycheck(db, companyId, req.params.paycheckId, { date: req.body?.date, reason: req.body?.reason, actor }), 201));
  api.get('/companies/:companyId/paychecks', route('read', ({ db, req, companyId }) =>
    payroll.listPaychecks(db, companyId, { year: req.query.year ? Number(req.query.year) : undefined })));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Static UI
  const vuePath = fileURLToPath(new URL('../node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url));
  app.get('/vendor/vue.js', (req, res) => res.type('text/javascript').sendFile(vuePath));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url))));

  // Errors -> JSON. User mistakes are 4xx with a readable message; anything else is 500 without internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    if (err instanceof LedgerError || err instanceof PayrollError) {
      const status = /not found/i.test(err.message) ? 404 : 400;
      return res.status(status).json({ error: err.message, details: err.details ?? [] });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.expose ? err.message : 'Bad request' });
    // Database rule violations: return a plain explanation, never raw database text.
    const pgMessages = {
      23505: 'That code or number is already in use',
      23514: 'That would break an accounting rule (for example an unbalanced entry or a closed period), so nothing was saved',
      23503: 'That refers to something that does not exist in this company',
      23502: 'A required field is missing',
      '22P02': 'One of the values is not in the right format',
      22001: 'One of the values is too long',
      22003: 'One of the numbers is too large',
      22021: 'Text contains characters that are not allowed',
      22007: 'One of the dates is not valid',
      22008: 'One of the dates is not valid',
      42501: 'That change is not allowed',
    };
    if (pgMessages[err.code]) return res.status(400).json({ error: pgMessages[err.code] });
    console.error(JSON.stringify({ level: 'error', msg: err.message, code: err.code, path: req.path }));
    res.status(500).json({ error: 'Something went wrong on our side. Nothing was saved.' });
  });
  return app;
}

