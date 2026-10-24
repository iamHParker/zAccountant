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
import * as bank from './services/bankService.js';
import * as imports from './services/importService.js';
import * as arap from './services/arapService.js';
import * as roles from './services/accessService.js';
import * as time from './services/timesheetService.js';
import { AuthError } from './services/authService.js';
import { verifyChain } from './services/audit.js';
import { runBooksCheck, latestBooksCheck, centralToday } from './jobs/booksCheck.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);
const q = (v) => (typeof v === 'string' && v !== '' ? v : null); // ignore repeated (?a=1&a=2) or empty params

/**
 * Route permissions. ℹ️ Each route names the permission it needs (see src/core/permissions.js), or a
 * list meaning "any of these", or 'member' for anything every member of the company may see.
 */
export { PERMISSIONS } from './core/permissions.js';

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
  // Bank statement files can be a few MB; everything else is small.
  app.use(/^\/api\/companies\/[^/]+\/bank-accounts\/[^/]+\/import$/, express.json({ limit: '6mb' }));
  app.use(/^\/api\/companies\/[^/]+\/imports(\/preview)?$/, express.json({ limit: '15mb' }));
  app.use(/^\/api\/companies\/[^/]+\/time-entries\/import$/, express.json({ limit: '3mb' }));
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
    for (const p of ['accountId', 'entryId', 'employeeId', 'paycheckId', 'userId', 'recurringId', 'bankAccountId', 'bankTxId', 'reconId', 'ruleId', 'batchId', 'contactId', 'documentId', 'paymentId', 'runId', 'roleId', 'departmentId', 'jobId', 'timeEntryId']) {
      if (req.params[p] !== undefined && !UUID.test(req.params[p])) return res.status(404).json({ error: 'Not found' });
    }
    const body = await withScope(pool, { userId: req.user.id, companyId }, async (db) => {
      let access = null;
      if (companyId) {
        access = await auth.getAccess(db, req.user.id, companyId);
        if (!access) throw new AuthError('Company not found', 404); // don't reveal that other companies exist
        const anyOf = permission === 'member' ? [] : [].concat(permission);
        if (anyOf.length && !anyOf.some((p) => access.permissions.has(p))) {
          throw new AuthError(`Your role (${access.roleName}) can't do that. Ask the company owner.`, 403);
        }
      }
      const can = (p) => Boolean(access?.permissions.has(p));
      const viewer = { userId: req.user.id, can, departmentId: access?.departmentId ?? null };
      return handler({ db, req, companyId, role: access?.role ?? null, access, can, viewer, actor: req.user.email });
    });
    res.status(status).json(body);
  };

  // Companies
  api.get('/companies', route(null, ({ db, req }) => ledger.listCompanies(db, { userId: req.user.id })));
  api.post('/companies', route(null, ({ db, req, actor }) => {
    const { name, homeState, fiscalYearStartMonth } = req.body ?? {};
    return ledger.createCompany(db, { name, homeState, fiscalYearStartMonth, actor, ownerUserId: req.user.id });
  }, 201));
  api.get('/companies/:companyId', route('member', async ({ db, companyId, access }) => ({
    ...(await ledger.getCompany(db, companyId)), role: access.role, roleName: access.roleName, permissions: [...access.permissions], departmentId: access.departmentId,
  })));
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
  api.get('/companies/:companyId/members', route(['view_books', 'admin', 'payroll', 'time_approve', 'time_all'], ({ db, companyId }) => auth.listMembers(db, companyId)));
  api.post('/companies/:companyId/members', route('admin', async ({ db, req, companyId, actor }) => {
    const m = await auth.addMember(db, companyId, { email: req.body?.email, role: req.body?.role, departmentId: req.body?.departmentId });
    await ledger.auditOnly(db, companyId, { action: 'set_member', entity: 'membership', entityId: m.id, actor, payload: { email: m.email, role: m.role, roleId: m.roleId, departmentId: m.departmentId } });
    return m;
  }, 201));
  api.delete('/companies/:companyId/members/:userId', route('admin', async ({ db, req, companyId, actor }) => {
    await auth.removeMember(db, companyId, req.params.userId);
    await ledger.auditOnly(db, companyId, { action: 'remove_member', entity: 'membership', entityId: req.params.userId, actor, payload: {} });
    return { ok: true };
  }));

  // Roles and departments
  api.get('/companies/:companyId/roles', route('member', ({ db, companyId }) => roles.listRoles(db, companyId)));
  api.post('/companies/:companyId/roles', route('admin', ({ db, req, companyId, actor }) => roles.createRole(db, companyId, req.body ?? {}, { actor }), 201));
  api.patch('/companies/:companyId/roles/:roleId', route('admin', ({ db, req, companyId, actor }) => roles.updateRole(db, companyId, req.params.roleId, req.body ?? {}, { actor })));
  api.delete('/companies/:companyId/roles/:roleId', route('admin', ({ db, req, companyId, actor }) => roles.deleteRole(db, companyId, req.params.roleId, { actor })));
  api.get('/companies/:companyId/departments', route('member', ({ db, companyId }) => roles.listDepartments(db, companyId)));
  api.post('/companies/:companyId/departments', route('admin', ({ db, req, companyId, actor }) => roles.createDepartment(db, companyId, req.body ?? {}, { actor }), 201));
  api.delete('/companies/:companyId/departments/:departmentId', route('admin', ({ db, req, companyId, actor }) => roles.deleteDepartment(db, companyId, req.params.departmentId, { actor })));

  // Accounts
  api.get('/companies/:companyId/accounts', route(['view_books', 'invoices', 'bills'], ({ db, companyId }) => ledger.listAccounts(db, companyId)));
  api.post('/companies/:companyId/accounts', route('accounts', ({ db, req, companyId, actor }) => {
    const { code, name, type, subtype } = req.body ?? {};
    return ledger.createAccount(db, companyId, { code, name, type, subtype, actor });
  }, 201));
  api.get('/companies/:companyId/accounts/:accountId/register', route('view_books', ({ db, req, companyId }) =>
    reports.getAccountRegister(db, companyId, req.params.accountId, { from: q(req.query.from), to: q(req.query.to) })));

  // Journal
  const idemKey = (req) => req.get('Idempotency-Key') ?? req.body?.idempotencyKey ?? null;
  api.get('/companies/:companyId/entries', route('view_books', ({ db, req, companyId }) =>
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
  api.get('/companies/:companyId/recurring', route('view_books', ({ db, companyId }) => ledger.listRecurring(db, companyId)));
  api.post('/companies/:companyId/recurring', route('post', ({ db, req, companyId, actor }) => {
    const { name, frequency, startDate, endDate, memo, lines } = req.body ?? {};
    return ledger.createRecurring(db, companyId, { name, frequency, startDate, endDate, memo, lines, actor });
  }, 201));
  api.post('/companies/:companyId/recurring/:recurringId/stop', route('post', ({ db, req, companyId, actor }) =>
    ledger.stopRecurring(db, companyId, req.params.recurringId, { actor })));
  api.post('/companies/:companyId/recurring/post-due', route('post', ({ db, companyId, actor }) =>
    ledger.postDueRecurring(db, companyId, { asOf: centralToday(), actor })));

  // Banking
  const B = '/companies/:companyId/bank-accounts/:bankAccountId';
  api.post(`${B}/import`, route('post', ({ db, req, companyId, actor }) =>
    bank.importStatement(db, companyId, { bankAccountId: req.params.bankAccountId, fileName: req.body?.fileName, content: req.body?.content, preview: req.body?.preview === true, actor })));
  api.get(`${B}/transactions`, route('view_books', ({ db, req, companyId }) =>
    bank.listBankTransactions(db, companyId, { bankAccountId: req.params.bankAccountId, status: q(req.query.status) ?? 'review' })));
  api.get(`${B}/reconciliations`, route('view_books', ({ db, req, companyId }) => bank.listReconciliations(db, companyId, { bankAccountId: req.params.bankAccountId })));
  api.post(`${B}/reconciliations`, route('post', ({ db, req, companyId, actor }) =>
    bank.startReconciliation(db, companyId, { bankAccountId: req.params.bankAccountId, statementDate: req.body?.statementDate, endingBalance: req.body?.endingBalance, actor }), 201));
  const T = '/companies/:companyId/bank-transactions/:bankTxId';
  api.get(`${T}/matches`, route('view_books', ({ db, req, companyId }) => bank.findMatches(db, companyId, req.params.bankTxId)));
  api.post(`${T}/post`, route('post', ({ db, req, companyId, actor }) => bank.postBankTransaction(db, companyId, req.params.bankTxId, { accountId: req.body?.accountId, memo: req.body?.memo, actor })));
  api.post(`${T}/match`, route('post', ({ db, req, companyId, actor }) => bank.matchBankTransaction(db, companyId, req.params.bankTxId, { entryId: req.body?.entryId, actor })));
  api.post(`${T}/exclude`, route('post', ({ db, req, companyId, actor }) => bank.excludeBankTransaction(db, companyId, req.params.bankTxId, { reason: req.body?.reason, actor })));
  api.post(`${T}/undo`, route('post', ({ db, req, companyId, actor }) => bank.undoBankTransaction(db, companyId, req.params.bankTxId, { actor })));
  api.get('/companies/:companyId/bank-rules', route('view_books', ({ db, companyId }) => bank.listRules(db, companyId)));
  api.post('/companies/:companyId/bank-rules', route('post', ({ db, req, companyId, actor }) => {
    const { matchText, direction, min, max, accountId, priority } = req.body ?? {};
    return bank.createRule(db, companyId, { matchText, direction, min, max, accountId, priority: priority ?? 100, actor });
  }, 201));
  api.delete('/companies/:companyId/bank-rules/:ruleId', route('post', ({ db, req, companyId, actor }) => bank.deleteRule(db, companyId, req.params.ruleId, { actor })));
  const R = '/companies/:companyId/reconciliations/:reconId';
  api.get(R, route('view_books', ({ db, req, companyId }) => bank.getReconciliation(db, companyId, req.params.reconId)));
  api.post(`${R}/lines`, route('post', ({ db, req, companyId }) => bank.setCleared(db, companyId, req.params.reconId, { lineIds: req.body?.lineIds, cleared: req.body?.cleared !== false })));
  api.post(`${R}/complete`, route('post', ({ db, req, companyId, actor }) => bank.completeReconciliation(db, companyId, req.params.reconId, { actor })));
  api.delete(R, route('post', ({ db, req, companyId }) => bank.cancelReconciliation(db, companyId, req.params.reconId)));

  // Customers & invoices, vendors & bills, payments (accounts receivable / payable)
  // Sales needs "invoices", Bills needs "bills"; anyone who can see the books can also look.
  const SIDE_PERM = { customer: 'invoices', vendor: 'bills', invoice: 'invoices', bill: 'bills', received: 'invoices', made: 'bills' };
  const needSide = async (db, can, table, id) => {
    const { rows: [r] } = await db.query(`SELECT kind FROM ${table} WHERE id = $1`, [id]);
    if (r && !can(SIDE_PERM[r.kind])) throw new AuthError("Your role can't do that. Ask the company owner.", 403);
  };
  const seeSide = async (db, can, table, id) => { if (!can('view_books')) await needSide(db, can, table, id); };
  for (const [path, kind] of [['customers', 'customer'], ['vendors', 'vendor']]) {
    api.get(`/companies/:companyId/${path}`, route(['view_books', SIDE_PERM[kind]], ({ db, req, companyId }) =>
      arap.listContacts(db, companyId, { kind, asOf: centralToday(), includeInactive: req.query.inactive === '1' })));
    api.post(`/companies/:companyId/${path}`, route(SIDE_PERM[kind], ({ db, req, companyId, actor }) => arap.createContact(db, companyId, { ...(req.body ?? {}), kind, actor }), 201));
  }
  api.patch('/companies/:companyId/contacts/:contactId', route(['invoices', 'bills'], async ({ db, req, companyId, can, actor }) => {
    await needSide(db, can, 'contacts', req.params.contactId);
    return arap.updateContact(db, companyId, req.params.contactId, { ...(req.body ?? {}), actor });
  }));
  for (const [path, kind] of [['invoices', 'invoice'], ['bills', 'bill']]) {
    api.get(`/companies/:companyId/${path}`, route(['view_books', SIDE_PERM[kind]], ({ db, req, companyId }) =>
      arap.listDocuments(db, companyId, { kind, status: q(req.query.status) ?? 'open', contactId: q(req.query.contactId), today: centralToday() })));
    api.post(`/companies/:companyId/${path}`, route(SIDE_PERM[kind], ({ db, req, companyId, actor }) => {
      const { contactId, number, date, dueDate, memo, taxRate, lines } = req.body ?? {};
      return arap.createDocument(db, companyId, { kind, contactId, number, date, dueDate, memo, taxRate, lines, idempotencyKey: idemKey(req), actor });
    }, 201));
  }
  api.get('/companies/:companyId/documents/:documentId', route(['view_books', 'invoices', 'bills'], async ({ db, req, companyId, can }) => {
    await seeSide(db, can, 'documents', req.params.documentId);
    return arap.getDocument(db, companyId, req.params.documentId, { today: centralToday() });
  }));
  api.post('/companies/:companyId/documents/:documentId/void', route('post', ({ db, req, companyId, actor }) =>
    arap.voidDocument(db, companyId, req.params.documentId, { date: req.body?.date, actor })));
  for (const [path, kind] of [['payments-received', 'received'], ['payments-made', 'made']]) {
    api.get(`/companies/:companyId/${path}`, route(['view_books', SIDE_PERM[kind]], ({ db, req, companyId }) => arap.listPayments(db, companyId, { kind, contactId: q(req.query.contactId) })));
    api.post(`/companies/:companyId/${path}`, route(SIDE_PERM[kind], ({ db, req, companyId, actor }) => {
      const { contactId, date, accountId, method, reference, memo, applications } = req.body ?? {};
      return arap.createPayment(db, companyId, { kind, contactId, date, accountId, method, reference, memo, applications, idempotencyKey: idemKey(req), actor });
    }, 201));
  }
  api.get('/companies/:companyId/payments/:paymentId', route(['view_books', 'invoices', 'bills'], async ({ db, req, companyId, can }) => {
    await seeSide(db, can, 'payments', req.params.paymentId);
    return arap.getPayment(db, companyId, req.params.paymentId);
  }));
  api.post('/companies/:companyId/payments/:paymentId/void', route('post', ({ db, req, companyId, actor }) =>
    arap.voidPayment(db, companyId, req.params.paymentId, { date: req.body?.date, actor })));
  api.get('/companies/:companyId/reports/ar-aging', route(['view_books', 'invoices'], ({ db, req, companyId }) => arap.getAging(db, companyId, { kind: 'invoice', asOf: q(req.query.asOf) ?? centralToday() })));
  api.get('/companies/:companyId/reports/ap-aging', route(['view_books', 'bills'], ({ db, req, companyId }) => arap.getAging(db, companyId, { kind: 'bill', asOf: q(req.query.asOf) ?? centralToday() })));

  // Importing books (QuickBooks / spreadsheets). Accountant-level: it can change many periods at once.
  const importOpts = (req, actor) => ({ kind: req.body?.kind, asOf: req.body?.asOf, actor,
    file: { fileName: req.body?.fileName, content: req.body?.content, base64: req.body?.base64 ?? null } });
  api.post('/companies/:companyId/imports/preview', route('accounts', ({ db, req, companyId, actor }) => imports.previewImport(db, companyId, importOpts(req, actor))));
  api.post('/companies/:companyId/imports', route('accounts', ({ db, req, companyId, actor }) => imports.commitImport(db, companyId, importOpts(req, actor)), 201));
  api.get('/companies/:companyId/imports', route('view_books', ({ db, companyId }) => imports.listImports(db, companyId)));
  api.post('/companies/:companyId/imports/:batchId/undo', route('accounts', ({ db, req, companyId, actor }) => imports.undoImport(db, companyId, req.params.batchId, { actor })));

  // Reports
  api.get('/companies/:companyId/reports/dashboard', route('view_books', ({ db, req, companyId }) => reports.getDashboard(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/trial-balance', route('view_books', ({ db, req, companyId }) => reports.getTrialBalance(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/balance-sheet', route('view_books', ({ db, req, companyId }) => reports.getBalanceSheet(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/income-statement', route('view_books', ({ db, req, companyId }) => reports.getIncomeStatement(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.get('/companies/:companyId/reports/cash-flow', route('view_books', ({ db, req, companyId }) => reports.getCashFlow(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.get('/companies/:companyId/audit/verify', route('audit', ({ db, companyId }) => verifyChain(db, companyId)));
  api.get('/companies/:companyId/books-check', route('view_books', ({ db, companyId }) => latestBooksCheck(db, companyId)));
  api.post('/companies/:companyId/books-check', route('audit', ({ db, companyId }) => runBooksCheck(db, companyId)));

  // Payroll
  api.get('/companies/:companyId/employees', route(['view_books', 'payroll'], ({ db, companyId }) => payroll.listEmployees(db, companyId)));
  api.post('/companies/:companyId/employees', route('payroll', ({ db, req, companyId, actor }) => payroll.createEmployee(db, companyId, req.body ?? {}, { actor }), 201));
  api.post('/companies/:companyId/employees/:employeeId/paychecks/preview', route('payroll', ({ db, req, companyId }) =>
    payroll.previewPaycheck(db, companyId, req.params.employeeId, req.body ?? {})));
  api.post('/companies/:companyId/employees/:employeeId/paychecks', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.postPaycheck(db, companyId, req.params.employeeId,
      { ...req.body, idempotencyKey: req.get('Idempotency-Key') ?? req.body?.idempotencyKey }, { actor }), 201));
  api.post('/companies/:companyId/paychecks/:paycheckId/void', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.voidPaycheck(db, companyId, req.params.paycheckId, { date: req.body?.date, reason: req.body?.reason, actor }), 201));
  const runOpts = (req) => {
    const { payFrequency, periodStart, periodEnd, payDate, paidFromAccountId, items, fromTimesheets } = req.body ?? {};
    return { payFrequency, periodStart, periodEnd, payDate, paidFromAccountId, items, fromTimesheets, idempotencyKey: idemKey(req) };
  };
  api.post('/companies/:companyId/payroll-runs/preview', route('payroll', ({ db, req, companyId }) => payroll.previewRun(db, companyId, runOpts(req))));
  api.post('/companies/:companyId/payroll-runs', route('payroll', ({ db, req, companyId, actor }) => payroll.postRun(db, companyId, runOpts(req), { actor }), 201));
  api.get('/companies/:companyId/payroll-runs', route(['view_books', 'payroll'], ({ db, companyId }) => payroll.listRuns(db, companyId)));
  api.get('/companies/:companyId/payroll-runs/:runId', route(['view_books', 'payroll'], ({ db, req, companyId }) => payroll.getRun(db, companyId, req.params.runId)));
  // Pay stubs and tax totals show pay details, so they need the payroll role (not every member).
  api.get('/companies/:companyId/paychecks/:paycheckId/stub', route('payroll', ({ db, req, companyId }) => payroll.getPayStub(db, companyId, req.params.paycheckId)));
  api.get('/companies/:companyId/reports/payroll-liabilities', route('payroll', ({ db, req, companyId }) =>
    payroll.getPayrollLiabilities(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.get('/companies/:companyId/paychecks', route(['view_books', 'payroll'], ({ db, req, companyId }) =>
    payroll.listPaychecks(db, companyId, { year: req.query.year ? Number(req.query.year) : undefined })));

  api.patch('/companies/:companyId/employees/:employeeId/user', route(['payroll', 'admin'], ({ db, req, companyId, actor }) =>
    time.linkEmployeeUser(db, companyId, req.params.employeeId, req.body?.userId ?? null, { actor })));
  api.get('/companies/:companyId/payroll-hours', route('payroll', ({ db, req, companyId }) =>
    time.getPayrollHours(db, companyId, { payFrequency: q(req.query.payFrequency), periodStart: q(req.query.periodStart), periodEnd: q(req.query.periodEnd) })));

  // Jobs and timesheets. Who may see or change whose time is checked inside the service
  // (own time, your department's time with "approve time", or everyone's with "all time").
  const TIME = ['time_own', 'time_approve', 'time_all'];
  const JOB_ADMIN = ['time_approve', 'time_all', 'admin'];
  api.get('/companies/:companyId/jobs', route('member', ({ db, req, companyId }) => time.listJobs(db, companyId, { includeInactive: req.query.inactive === '1' })));
  api.post('/companies/:companyId/jobs', route(JOB_ADMIN, ({ db, req, companyId, actor }) => time.createJob(db, companyId, req.body ?? {}, { actor }), 201));
  api.patch('/companies/:companyId/jobs/:jobId', route(JOB_ADMIN, ({ db, req, companyId, actor }) => time.updateJob(db, companyId, req.params.jobId, req.body ?? {}, { actor })));
  const TE = '/companies/:companyId/time-entries';
  api.get(TE, route(TIME, ({ db, req, companyId, viewer }) => time.listTimeEntries(db, companyId, viewer, {
    from: q(req.query.from), to: q(req.query.to), userId: q(req.query.userId), status: q(req.query.status), jobId: q(req.query.jobId) })));
  api.post(TE, route(TIME, ({ db, req, companyId, viewer, actor }) => time.createTimeEntry(db, companyId, viewer, req.body ?? {}, { actor }), 201));
  api.post(`${TE}/submit`, route(TIME, ({ db, req, companyId, viewer }) => time.submitTimeEntries(db, companyId, viewer, { ids: req.body?.ids })));
  api.post(`${TE}/review`, route(['time_approve', 'time_all'], ({ db, req, companyId, viewer, actor }) =>
    time.reviewTimeEntries(db, companyId, viewer, { ids: req.body?.ids, approve: req.body?.approve, note: req.body?.note }, { actor })));
  api.post(`${TE}/import`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.importTimesheet(db, companyId, viewer, {
    fileName: req.body?.fileName, content: req.body?.content, preview: req.body?.preview === true, userId: req.body?.userId || null, createJobs: req.body?.createJobs === true }, { actor })));
  api.get('/companies/:companyId/reports/time-summary', route(TIME, ({ db, req, companyId, viewer }) =>
    time.getTimeSummary(db, companyId, viewer, { from: q(req.query.from), to: q(req.query.to) })));
  api.patch(`${TE}/:timeEntryId`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.updateTimeEntry(db, companyId, viewer, req.params.timeEntryId, req.body ?? {}, { actor })));
  api.delete(`${TE}/:timeEntryId`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.deleteTimeEntry(db, companyId, viewer, req.params.timeEntryId, { actor })));

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

