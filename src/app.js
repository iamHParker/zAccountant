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
import * as lateCharges from './services/lateChargeService.js';
import * as photos from './services/paymentPhotoService.js';
import * as roles from './services/accessService.js';
import * as time from './services/timesheetService.js';
import * as projects from './services/projectService.js';
import * as trips from './services/tripService.js';
import * as roadSvc from './services/roadService.js';
import * as bookFiles from './services/bookFileService.js';
import * as mileIq from './services/mileIqService.js';
import * as homeLayout from './services/homeLayoutService.js';
import { AuthError } from './services/authService.js';
import { toCsv, csvFileName, statementRows, agingRows, payrollRegisterRows, taxSummaryRows, nec1099Rows, w2Rows } from './core/csv.js';
import * as tax from './services/taxService.js';
import { verifyChain } from './services/audit.js';
import { runBooksCheck, latestBooksCheck, centralToday } from './jobs/booksCheck.js';
import { offsiteConfig, recentOffsiteBackups } from './jobs/offsiteBackup.js';
import { createMetrics, bearerMatches } from './metrics.js';
import * as feedback from './services/feedbackService.js';
import { platformRole, appVersion } from './core/platform.js';
import { streamBackup } from './jobs/backup.js';
import * as plans from './services/planService.js';
import * as invoiceSetup from './services/invoiceSetupService.js';
import * as oldInvoices from './services/oldInvoiceService.js';
import { featureForPath, FEATURES, PLANS, ADD_ONS } from './core/plans.js';
import * as backup from './services/backupService.js';
import { page } from './core/pages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);
const q = (v) => (typeof v === 'string' && v !== '' ? v : null); // ignore repeated (?a=1&a=2) or empty params
const FILE = Symbol('file'); // a handler returning { [FILE]: { name, type, body } } sends a download instead of JSON

/**
 * Route permissions. ℹ️ Each route names the permission it needs (see src/core/permissions.js), or a
 * list meaning "any of these", or 'member' for anything every member of the company may see.
 */
export { PERMISSIONS } from './core/permissions.js';

// Host names this server answers to. Anything else is refused, which blocks "DNS rebinding"
// (a malicious web page tricking the browser into talking to this server).
const allowedHosts = () => new Set([
  ...(process.env.ALLOWED_HOSTS ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? '' : 'localhost,127.0.0.1')).split(','),
  process.env.RAILWAY_PUBLIC_DOMAIN ?? '', // Railway tells the app its own address
].map((h) => h.trim().toLowerCase()).filter(Boolean));

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

export function createApp(pool, { log } = {}) {
  const app = express();
  const hosts = allowedHosts();
  const metrics = createMetrics({ log });
  // The last 100 server errors (what went wrong and where, with the request id; never request data), for the
  // Developer dashboard. Kept in memory only: a restart or deploy clears it, and the full log stays in Railway.
  const serverErrors = [];
  app.disable('x-powered-by');
  // Behind Railway's proxy the visitor's address is in X-Forwarded-For (one hop); rate limits need it.
  const trustProxy = process.env.TRUST_PROXY ?? (process.env.RAILWAY_ENVIRONMENT_NAME ? '1' : null);
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.use(metrics.middleware);
  // Health checks answer before the Host check: Railway's checker calls them by an internal host name,
  // and they reveal nothing.
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => {
    try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
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
  app.use(/^\/api\/companies\/[^/]+\/bank-accounts\/[^/]+\/import$/, express.json({ limit: '12mb' })); // a PDF statement (8 MB) as base64
  app.use(/^\/api\/companies\/[^/]+\/imports(\/preview)?$/, express.json({ limit: '15mb' }));
  app.use(/^\/api\/companies\/[^/]+\/time-entries\/import$/, express.json({ limit: '3mb' }));
  app.use(/^\/api\/companies\/[^/]+\/mileiq\/(preview|import)$/, express.json({ limit: '3mb' })); // a MileIQ report, as text
  app.use(/^\/api\/companies\/[^/]+\/invoices\/read-pdf$/, express.json({ limit: '6mb' })); // an old invoice PDF, as base64 (4 MB at most)
  app.use(/^\/api\/companies\/[^/]+\/logo$/, express.json({ limit: '2mb' })); // the logo, as base64 (1 MB at most)
  app.use(/^\/api\/companies\/[^/]+\/payments\/[^/]+\/photos$/, express.json({ limit: '5mb' })); // a check photo, as base64 (3 MB at most)
  app.use(/^\/api\/companies\/[^/]+\/trip-costs\/[^/]+\/photos$/, express.json({ limit: '5mb' })); // a receipt photo, likewise
  app.use(/^\/api\/road\/items\/[^/]+\/photos$/, express.json({ limit: '5mb' })); // a receipt photo from the Road page
  app.use('/api/feedback', express.json({ limit: '6mb' })); // a picture of the screen, as base64
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // No 'unsafe-eval': the screens are compiled on the server (src/core/pages.js), not in the browser.
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (secureCookies()) res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // Monitoring (Grafana scrapes this). Off unless METRICS_TOKEN is set; the caller must send it as a bearer token.
  app.get('/metrics', (req, res) => {
    if (!process.env.METRICS_TOKEN) return res.status(404).json({ error: 'Not found' });
    if (!bearerMatches(req, process.env.METRICS_TOKEN)) return res.status(401).json({ error: 'Not authorized' });
    res.type('text/plain; version=0.0.4').send(metrics.render(pool));
  });
  // A ceiling on API calls per address (sign-in has its own, much lower, limit below).
  app.use('/api', rateLimiter({ windowMs: 60_000, max: Number(process.env.API_RATE_LIMIT ?? 1200) }));

  // ------------------------------------------------------------------ Sign-in (no session needed)
  const authApi = express.Router();
  authApi.use(rateLimiter({ windowMs: 5 * 60_000, max: Number(process.env.AUTH_RATE_LIMIT ?? 30) }));
  const session = async (req) => auth.getSession(pool, readCookie(req, COOKIE()));
  const fullSession = async (req) => {
    const s = await session(req);
    if (!s?.session.mfa_passed) throw new AuthError('Please sign in', 401);
    return s;
  };

  authApi.post('/signup', async (req, res) => {
    const { email, password, name } = req.body ?? {};
    const r = await auth.signup(pool, { email, password, name });
    setSessionCookie(res, r.token);
    res.status(201).json({ user: { ...r.user, platformRole: platformRole(r.user.email) }, next: r.next, version: appVersion() });
  });
  authApi.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    const r = await auth.login(pool, { email, password });
    setSessionCookie(res, r.token);
    res.json({ user: { ...r.user, platformRole: platformRole(r.user.email) }, next: r.next, version: appVersion() });
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
    res.json({ user: { ...s.user, platformRole: platformRole(s.user.email) }, next, version: appVersion() });
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
  // Your own sign-in: name and password (email stays until it can be confirmed by email).
  authApi.patch('/me', async (req, res) => {
    const s = await fullSession(req);
    res.json(await auth.updateMyName(pool, s.user.id, { name: req.body?.name }));
  });
  authApi.post('/password', async (req, res) => {
    const s = await fullSession(req);
    res.json(await auth.changePassword(pool, s.user.id, s.session.token_hash,
      { currentPassword: req.body?.currentPassword, newPassword: req.body?.newPassword, code: req.body?.code }));
  });
  // Passkeys (Face ID, Touch ID, Windows Hello). The site's name for them is its host name; the browser checks it.
  const relyingParty = (req) => ({ rpId: (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''), origin: `${req.protocol}://${(req.headers.host ?? '').toLowerCase()}` });
  authApi.post('/passkey/options', async (req, res) => res.json(await auth.passkeyLoginOptions(pool, relyingParty(req))));
  authApi.post('/passkey/login', async (req, res) => {
    const r = await auth.passkeyLogin(pool, { credential: req.body?.credential }, relyingParty(req));
    setSessionCookie(res, r.token);
    res.json({ user: { ...r.user, platformRole: platformRole(r.user.email) }, next: null, version: appVersion() });
  });
  authApi.get('/passkeys', async (req, res) => res.json(await auth.listPasskeys(pool, (await fullSession(req)).user.id)));
  authApi.post('/passkeys/options', async (req, res) => {
    const s = await fullSession(req);
    res.json(await auth.passkeyRegisterOptions(pool, s.user.id, { mfaCode: req.body?.mfaCode }, relyingParty(req)));
  });
  authApi.post('/passkeys', async (req, res) => {
    const s = await fullSession(req);
    res.status(201).json(await auth.passkeyRegister(pool, s.user.id, { credential: req.body?.credential, name: req.body?.name }, relyingParty(req)));
  });
  authApi.put('/passkeys/:id', async (req, res) => res.json(await auth.renamePasskey(pool, (await fullSession(req)).user.id, req.params.id, { name: req.body?.name })));
  authApi.delete('/passkeys/:id', async (req, res) => {
    await auth.removePasskey(pool, (await fullSession(req)).user.id, req.params.id);
    res.json({ ok: true });
  });
  app.use('/api/auth', authApi);

  // ------------------------------------------------------------------ The Road page's phone key (src/services/roadService.js)
  // No session: the phone sends its road key (Authorization: Bearer zr_…). It reaches only these few routes, scoped
  // to the key's company and person, and stops working if the key is revoked or expires or the person loses the
  // Bills permission.
  const roadApi = express.Router();
  const roadRoute = (handler, status = 200) => async (req, res) => {
    const m = /^Bearer (\S{1,100})$/.exec(req.headers.authorization ?? '');
    const key = m ? await roadSvc.findRoadKey(pool, m[1]) : null;
    if (!key) return res.status(401).json({ error: 'This road key no longer works. Make a new one at your desk: Trips → Your phone on the road.', roadKey: 'invalid' });
    const body = await withScope(pool, { userId: key.userId, companyId: key.companyId }, async (db) => {
      const access = await auth.getAccess(db, key.userId, key.companyId);
      if (!access?.permissions.has('bills')) throw new AuthError('This road key no longer works: your role in the company has changed.', 403);
      return handler({ db, req, key });
    });
    res.status(status).json(body);
  };
  roadApi.get('/', roadRoute(({ db, key }) => roadSvc.roadSummary(db, key)));
  roadApi.post('/items', roadRoute(({ db, req, key }) => roadSvc.receiveItem(db, key, req.body ?? {}), 201));
  roadApi.put('/items/:clientId', roadRoute(({ db, req, key }) => roadSvc.editItem(db, key, req.params.clientId, req.body ?? {})));
  roadApi.post('/items/:clientId/photos', roadRoute(({ db, req, key }) => roadSvc.receivePhoto(db, key, req.params.clientId, req.body ?? {}), 201));
  roadApi.post('/status', roadRoute(({ db, req, key }) => roadSvc.itemStatuses(db, key, req.body?.clientIds)));
  app.use('/api/road', roadApi);

  // The front page lists the plans and their prices from the same catalog the Admin dashboard uses, so a price
  // set there shows here too. Public: names and prices only.
  app.get('/api/public/plans', (req, res) => {
    const list = (o) => Object.entries(o).map(([key, p]) => ({ key, name: p.name, monthlyCents: p.monthlyCents, annualCents: p.annualCents, note: p.note ?? null, points: p.points ?? [] }));
    res.json({ plans: list(PLANS), addOns: list(ADD_ONS) });
  });

  // ------------------------------------------------------------------ Everything else needs a full sign-in
  const api = express.Router();
  api.use(async (req, res, next) => {
    const s = await session(req);
    if (!s) return res.status(401).json({ error: 'Please sign in' });
    if (!s.session.mfa_passed) return res.status(401).json({ error: 'Enter your two-factor code to continue', next: s.user.mfaEnabled ? 'mfa_verify' : 'mfa_setup' });
    req.user = { ...s.user, platformRole: platformRole(s.user.email) };
    next();
  });

  /**
   * Wrap a handler: checks the role for company routes, runs it in a request transaction scoped to the
   * user and company, commits, then responds. handler({ db, req, companyId, role, actor }) returns the body.
   */
  const route = (permission, handler, status = 200) => async (req, res) => {
    const companyId = req.params.companyId ?? null;
    if (companyId && !UUID.test(companyId)) return res.status(404).json({ error: 'Company not found' });
    for (const p of ['accountId', 'entryId', 'employeeId', 'paycheckId', 'userId', 'recurringId', 'bankAccountId', 'bankTxId', 'reconId', 'ruleId', 'batchId', 'contactId', 'documentId', 'paymentId', 'runId', 'roleId', 'departmentId', 'jobId', 'timeEntryId', 'depositId', 'itemId', 'tripId', 'costId', 'photoId', 'keyId', 'itemId']) {
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
      // Plan gate: payroll and timesheets are features a company's plan switches on (src/core/plans.js).
      const feature = companyId ? featureForPath(req.path.replace(/^\/companies\/[^/]+/, '')) : null;
      if (feature && !(await plans.getCompanyPlan(db, companyId)).features.includes(feature)) {
        throw new AuthError(`${FEATURES[feature].split(' (')[0]} isn't in this company's plan. Ask zAccountant to add it.`, 402);
      }
      const can = (p) => Boolean(access?.permissions.has(p));
      const viewer = { userId: req.user.id, can, departmentId: access?.departmentId ?? null };
      return handler({ db, req, companyId, role: access?.role ?? null, access, can, viewer, actor: req.user.email });
    });
    if (body?.[FILE]) {
      const f = body[FILE];
      return res.status(status).type(f.type).set('Content-Disposition', `${f.inline ? 'inline' : 'attachment'}; filename="${f.name}"`).send(f.body);
    }
    res.status(status).json(body);
  };

  // A report route that answers JSON, or a CSV download with ?format=csv. `title` and `period` name the file.
  const report = (permission, title, load, rowsFor) => route(permission, async (ctx) => {
    const data = await load(ctx);
    if (ctx.req.query.format !== 'csv') return data;
    const company = (await ledger.getCompany(ctx.db, ctx.companyId)).name;
    const period = data.asOf ?? `${data.from} to ${data.to}`;
    return { [FILE]: { name: csvFileName(company, title, period), type: 'text/csv; charset=utf-8', body: toCsv(rowsFor(data, { company, title })) } };
  });
  const statement = (kind) => (data, opts) => statementRows(kind, data, opts);

  // ------------------------------------------------------------------ Beta feedback and the Developer dashboard
  // Any signed-in person may send feedback; the company open at the time is recorded only if they belong to it.
  api.post('/feedback', async (req, res) => {
    const companyId = typeof req.body?.companyId === 'string' && UUID.test(req.body.companyId) ? req.body.companyId : null;
    const r = await withScope(pool, { userId: req.user.id, companyId }, async (db) => {
      const member = companyId ? await auth.getAccess(db, req.user.id, companyId) : null;
      return feedback.createReport(db, req.user, member ? companyId : null, req.body ?? {}, { appVersion: appVersion() });
    });
    // The log names the report and the person's id, never the note or the picture.
    log?.(JSON.stringify({ level: 'info', msg: 'beta feedback', reqId: req.id, report: r.number, userId: req.user.id }));
    res.status(201).json(r);
  });

  // Developer routes: platform role developer only (DEVELOPER_EMAILS in Railway). Row-level security also
  // checks it, so a mistake here still can't show one tester another tester's report.
  const dev = (handler) => async (req, res) => {
    if (req.user.platformRole !== 'developer') return res.status(403).json({ error: 'The Developer dashboard is for zAccountant developers.' });
    if (req.params.reportId !== undefined && !UUID.test(req.params.reportId)) return res.status(404).json({ error: 'Report not found' });
    const body = await withScope(pool, { userId: req.user.id, platformRole: 'developer' }, (db) => handler({ db, req }));
    if (body?.[FILE]) {
      const f = body[FILE];
      return res.type(f.type).set('Content-Disposition', `inline; filename="${f.name}"`).send(f.body);
    }
    res.json(body);
  };
  const siteUrl = () => (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  api.get('/developer/summary', dev(async ({ db }) => {
    let offsite;
    try { offsite = offsiteConfig() ? 'on' : 'off'; } catch (e) { offsite = e.message; }
    return { version: appVersion(), counts: await feedback.platformCounts(db), serverErrors: serverErrors.slice().reverse(),
      offsite, offsiteBackups: await recentOffsiteBackups(db) };
  }));
  // A full backup, streamed straight from pg_dump (owner login, which sees every company). Logged: who and when.
  api.get('/developer/backup', async (req, res) => {
    if (req.user.platformRole !== 'developer') return res.status(403).json({ error: 'The Developer dashboard is for zAccountant developers.' });
    const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
    try {
      await streamBackup(url, res, { log: (r) => log?.(JSON.stringify({ level: 'info', msg: 'backup downloaded', reqId: req.id, userId: req.user.id, ...r })) });
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'backup failed', reqId: req.id, error: e.message.replace(/postgres(ql)?:\/\/\S+/g, '[url]') }));
      if (!res.headersSent) res.status(500).json({ error: 'The backup could not be made. The server log has the details.' });
    }
  });
  api.get('/developer/reports', dev(({ db, req }) => feedback.listReports(db, { status: q(req.query.status) })));
  api.get('/developer/reports/:reportId', dev(({ db, req }) => feedback.getReport(db, req.params.reportId, { siteUrl: siteUrl() })));
  api.get('/developer/reports/:reportId/picture', dev(async ({ db, req }) => ({ [FILE]: await feedback.getPicture(db, req.params.reportId) })));
  api.patch('/developer/reports/:reportId', dev(({ db, req }) => feedback.updateReport(db, req.params.reportId, req.body ?? {}, { actor: req.user.email })));

  // ------------------------------------------------------------------ Admin dashboard (plans; platform admins and developers)
  const admin = (handler) => async (req, res) => {
    if (!['admin', 'developer'].includes(req.user.platformRole)) return res.status(403).json({ error: 'The Admin dashboard is for zAccountant admins.' });
    if (req.params.targetId !== undefined && !UUID.test(req.params.targetId)) return res.status(404).json({ error: 'Company not found' });
    res.json(await withScope(pool, { userId: req.user.id, platformRole: req.user.platformRole }, (db) => handler({ db, req })));
  };
  api.get('/admin/companies', admin(({ db }) => plans.listCompanies(db)));
  api.get('/admin/plan-changes', admin(({ db }) => plans.listPlanChanges(db)));
  api.put('/admin/companies/:targetId/plan', admin(({ db, req }) => plans.setCompanyPlan(db, req.params.targetId, req.body ?? {}, { actor: req.user.email })));

  // Companies
  api.get('/companies', route(null, ({ db, req }) => ledger.listCompanies(db, { userId: req.user.id })));
  api.post('/companies', route(null, ({ db, req, actor }) => {
    const { name, homeState, fiscalYearStartMonth, entityType, booksStartDate } = req.body ?? {};
    return ledger.createCompany(db, { name, homeState, fiscalYearStartMonth, entityType, booksStartDate, actor, ownerUserId: req.user.id });
  }, 201));
  // The new-company setup wizard: business type, books start date, and "setup finished".
  api.put('/companies/:companyId/setup', route('admin', ({ db, req, companyId, actor }) => {
    const { entityType, booksStartDate, setupDone } = req.body ?? {};
    return ledger.updateSetup(db, companyId, { entityType, booksStartDate, setupDone, actor });
  }));
  // Company name, home state, fiscal-year start (CPA review G4/G5; limits in ledgerService.updateCompanyProfile).
  api.patch('/companies/:companyId/profile', route('admin', ({ db, req, companyId, actor }) => {
    const { name, homeState, fiscalYearStartMonth } = req.body ?? {};
    return ledger.updateCompanyProfile(db, companyId, { name, homeState, fiscalYearStartMonth, actor });
  }));
  api.get('/companies/:companyId/setup', route('member', ({ db, companyId }) => ledger.setupStatus(db, companyId)));
  api.get('/companies/:companyId', route('member', async ({ db, companyId, access }) => ({
    ...(await ledger.getCompany(db, companyId)), role: access.role, roleName: access.roleName, permissions: [...access.permissions], departmentId: access.departmentId,
    ...(await plans.getCompanyPlan(db, companyId)),
    logoVersion: await invoiceSetup.hasLogo(db, companyId), // null when there is no logo; changes when it does
  })));

  // Invoice setup: saved rates and items, the usual sales tax rate, the letterhead and the logo.
  api.get('/companies/:companyId/invoice-items', route(['invoices', 'view_books', 'admin'], ({ db, req, companyId }) =>
    invoiceSetup.listItems(db, companyId, { includeInactive: req.query.all === '1' })));
  api.post('/companies/:companyId/invoice-items', route('admin', ({ db, req, companyId, actor }) => {
    const { name, kind, rate, taxable, accountId } = req.body ?? {};
    return invoiceSetup.createItem(db, companyId, { name, kind, rate, taxable, accountId, actor });
  }, 201));
  api.post('/companies/:companyId/invoice-items/starter', route('admin', ({ db, req, companyId, actor }) =>
    invoiceSetup.addStarterItems(db, companyId, { accountId: req.body?.accountId, actor })));
  api.patch('/companies/:companyId/invoice-items/:itemId', route('admin', ({ db, req, companyId, actor }) => {
    const { name, kind, rate, taxable, accountId, isActive } = req.body ?? {};
    return invoiceSetup.updateItem(db, companyId, req.params.itemId, { name, kind, rate, taxable, accountId, isActive, actor });
  }));
  // Anyone who writes invoices may pin the rate they use most (it only fills in the box on new invoices).
  api.put('/companies/:companyId/default-tax-rate', route('invoices', ({ db, req, companyId, actor }) =>
    invoiceSetup.setDefaultTaxRate(db, companyId, { rate: req.body?.rate, actor })));
  api.put('/companies/:companyId/letterhead', route('admin', ({ db, req, companyId, actor }) => {
    const { address, note, footer } = req.body ?? {};
    return invoiceSetup.setLetterhead(db, companyId, { address, note, footer, actor });
  }));
  api.put('/companies/:companyId/logo', route('admin', ({ db, req, companyId, actor }) =>
    invoiceSetup.setLogo(db, companyId, { picture: req.body?.picture ?? null, actor })));
  api.get('/companies/:companyId/logo', route('member', async ({ db, companyId }) => ({ [FILE]: await invoiceSetup.getLogo(db, companyId) })));
  api.patch('/companies/:companyId/settings', route('admin', ({ db, req, companyId, actor }) => {
    const { suiRatePct, calculateOnlyPayroll, famliHeadcount, futaCreditReduction } = req.body ?? {};
    return ledger.updateCompanySettings(db, companyId, { suiRatePct, calculateOnlyPayroll, famliHeadcount, futaCreditReduction, actor });
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
  api.put('/companies/:companyId/departments/:departmentId', route('admin', ({ db, req, companyId, actor }) => roles.renameDepartment(db, companyId, req.params.departmentId, req.body ?? {}, { actor })));
  api.delete('/companies/:companyId/departments/:departmentId', route('admin', ({ db, req, companyId, actor }) => roles.deleteDepartment(db, companyId, req.params.departmentId, { actor })));

  // Accounts
  api.get('/companies/:companyId/accounts', route(['view_books', 'invoices', 'bills'], ({ db, companyId }) => ledger.listAccounts(db, companyId)));
  api.post('/companies/:companyId/accounts', route('accounts', ({ db, req, companyId, actor }) => {
    const { code, name, type, subtype } = req.body ?? {};
    return ledger.createAccount(db, companyId, { code, name, type, subtype, actor });
  }, 201));
  api.put('/companies/:companyId/accounts/:accountId/name', route('accounts', ({ db, req, companyId, actor }) =>
    ledger.renameAccount(db, companyId, req.params.accountId, { name: req.body?.name, actor })));
  api.patch('/companies/:companyId/accounts/:accountId', route('accounts', ({ db, req, companyId, actor }) =>
    ledger.updateAccount(db, companyId, req.params.accountId, { subtype: req.body?.subtype, isActive: req.body?.isActive, actor })));
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
  // Edit = reverse + corrected entry in one step.
  api.put('/companies/:companyId/entries/:entryId', route('post', ({ db, req, companyId, actor }) =>
    ledger.correctEntry(db, companyId, req.params.entryId, req.body ?? {}, { actor, idempotencyKey: idemKey(req) })));
  api.post('/companies/:companyId/entries/:entryId/reverse', route('post', ({ db, req, companyId, actor }) =>
    ledger.reverseEntry(db, companyId, req.params.entryId, { date: req.body?.date, memo: req.body?.memo, actor, idempotencyKey: idemKey(req) }), 201));

  // Recurring entries
  api.get('/companies/:companyId/recurring', route('view_books', ({ db, companyId }) => ledger.listRecurring(db, companyId)));
  api.post('/companies/:companyId/recurring', route('post', ({ db, req, companyId, actor }) => {
    const { name, frequency, startDate, endDate, memo, lines } = req.body ?? {};
    return ledger.createRecurring(db, companyId, { name, frequency, startDate, endDate, memo, lines, actor });
  }, 201));
  api.put('/companies/:companyId/recurring/:recurringId', route('post', ({ db, req, companyId, actor }) => {
    const { name, memo, lines, endDate, restart } = req.body ?? {};
    return ledger.updateRecurring(db, companyId, req.params.recurringId, { name, memo, lines, endDate, restart: restart === true, actor });
  }));
  api.post('/companies/:companyId/recurring/:recurringId/stop', route('post', ({ db, req, companyId, actor }) =>
    ledger.stopRecurring(db, companyId, req.params.recurringId, { actor })));
  api.post('/companies/:companyId/recurring/post-due', route('post', ({ db, companyId, actor }) =>
    ledger.postDueRecurring(db, companyId, { asOf: centralToday(), actor })));

  // Banking
  const B = '/companies/:companyId/bank-accounts/:bankAccountId';
  api.post(`${B}/import`, route('post', ({ db, req, companyId, actor }) =>
    bank.importStatement(db, companyId, { bankAccountId: req.params.bankAccountId, fileName: req.body?.fileName, content: req.body?.content, pdf: req.body?.pdf, preview: req.body?.preview === true, actor })));
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
  api.put('/companies/:companyId/bank-rules/:ruleId', route('post', ({ db, req, companyId, actor }) => {
    const { matchText, direction, min, max, accountId, priority } = req.body ?? {};
    return bank.updateRule(db, companyId, req.params.ruleId, { matchText, direction, min, max, accountId, priority: priority ?? 100, actor });
  }));
  api.delete('/companies/:companyId/bank-rules/:ruleId', route('post', ({ db, req, companyId, actor }) => bank.deleteRule(db, companyId, req.params.ruleId, { actor })));
  const R = '/companies/:companyId/reconciliations/:reconId';
  api.get(R, route('view_books', ({ db, req, companyId }) => bank.getReconciliation(db, companyId, req.params.reconId)));
  api.post(`${R}/lines`, route('post', ({ db, req, companyId }) => bank.setCleared(db, companyId, req.params.reconId, { lineIds: req.body?.lineIds, cleared: req.body?.cleared !== false })));
  api.post(`${R}/complete`, route('post', ({ db, req, companyId, actor }) => bank.completeReconciliation(db, companyId, req.params.reconId, { actor })));
  api.delete(R, route('post', ({ db, req, companyId, actor }) => bank.cancelReconciliation(db, companyId, req.params.reconId, { actor })));
  // Reopening a finished reconciliation undoes a control, so it takes the "close the books" permission.
  api.post(`${R}/reopen`, route('close', ({ db, req, companyId, actor }) => bank.reopenReconciliation(db, companyId, req.params.reconId, { reason: req.body?.reason, actor })));
  api.get(`${B}/imports`, route('view_books', ({ db, req, companyId }) => bank.listImports(db, companyId, { bankAccountId: req.params.bankAccountId })));
  api.post('/companies/:companyId/bank-imports/:batch/undo', route('post', ({ db, req, companyId, actor }) => bank.undoImport(db, companyId, req.params.batch, { actor })));

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
  // An old invoice PDF (Homer's Excel layout) read into the New invoice form; nothing is saved until the person saves it.
  api.post('/companies/:companyId/invoices/read-pdf', route('invoices', ({ db, req, companyId }) => oldInvoices.readOldInvoice(db, companyId, req.body ?? {})));
  for (const [path, kind] of [['invoices', 'invoice'], ['bills', 'bill']]) {
    api.get(`/companies/:companyId/${path}`, route(['view_books', SIDE_PERM[kind]], ({ db, req, companyId }) =>
      arap.listDocuments(db, companyId, { kind, status: q(req.query.status) ?? 'open', contactId: q(req.query.contactId), today: centralToday() })));
    api.post(`/companies/:companyId/${path}`, route(SIDE_PERM[kind], ({ db, req, companyId, actor }) => {
      const { contactId, number, date, dueDate, memo, project, jobId, taxRate, lines, attention, careOf, sendTo, clientRef, plan, noLateCharges } = req.body ?? {};
      return arap.createDocument(db, companyId, { kind, contactId, number, date, dueDate, memo, project, jobId, taxRate, lines, attention, careOf, sendTo, clientRef, plan, noLateCharges, idempotencyKey: idemKey(req), actor });
    }, 201));
  }
  api.get('/companies/:companyId/documents/:documentId', route(['view_books', 'invoices', 'bills'], async ({ db, req, companyId, can }) => {
    await seeSide(db, can, 'documents', req.params.documentId);
    return arap.getDocument(db, companyId, req.params.documentId, { today: centralToday() });
  }));
  api.post('/companies/:companyId/documents/:documentId/void', route('post', ({ db, req, companyId, actor }) =>
    arap.voidDocument(db, companyId, req.params.documentId, { date: req.body?.date, actor })));
  // Edit = void + corrected copy in one step, so it needs the same permission as Void.
  api.put('/companies/:companyId/documents/:documentId', route('post', async ({ db, req, companyId, can, actor }) => {
    await needSide(db, can, 'documents', req.params.documentId);
    const { contactId, number, date, dueDate, memo, project, jobId, taxRate, lines, attention, careOf, sendTo, clientRef, plan, noLateCharges } = req.body ?? {};
    return arap.replaceDocument(db, companyId, req.params.documentId, { contactId, number, date, dueDate, memo, project, jobId, taxRate, lines, attention, careOf, sendTo, clientRef, plan, noLateCharges, idempotencyKey: idemKey(req), actor });
  }));
  // Details that never reach the ledger (memo, due date, PO, project block, attention, send-to, payment plan): changed in place, even when paid.
  api.patch('/companies/:companyId/documents/:documentId', route(['invoices', 'bills'], async ({ db, req, companyId, can, actor }) => {
    if (/^[0-9a-f-]{36}$/i.test(req.params.documentId)) await needSide(db, can, 'documents', req.params.documentId);
    const { memo, dueDate, clientRef, project, attention, careOf, sendTo, plan, noLateCharges } = req.body ?? {};
    return arap.updateDocumentDetails(db, companyId, req.params.documentId, { memo, dueDate, clientRef, project, attention, careOf, sendTo, plan, noLateCharges, actor });
  }));
  // Late charges: the rate, fee and grace periods (owner), and the monthly run (whoever writes invoices).
  api.get('/companies/:companyId/late-charges/settings', route(['view_books', 'invoices', 'admin'], ({ db, companyId }) => lateCharges.getLateSettings(db, companyId)));
  api.put('/companies/:companyId/late-charges/settings', route('admin', ({ db, req, companyId, actor }) => {
    const { apr, fee, graceDays, holidayGraceDays } = req.body ?? {};
    return lateCharges.setLateSettings(db, companyId, { apr, fee, graceDays, holidayGraceDays, actor });
  }));
  api.get('/companies/:companyId/late-charges/preview', route('invoices', ({ db, req, companyId }) =>
    lateCharges.previewLateCharges(db, companyId, { asOf: q(req.query.asOf) ?? centralToday() })));
  api.post('/companies/:companyId/late-charges', route('invoices', ({ db, req, companyId, actor }) =>
    lateCharges.postLateCharges(db, companyId, { asOf: req.body?.asOf, contactIds: req.body?.contactIds ?? null, actor }), 201));
  // Billable time and costs not yet on an invoice, for the invoice form's "Pull in unbilled time and costs".
  api.get('/companies/:companyId/unbilled', route('invoices', ({ db, req, companyId }) =>
    projects.listUnbilled(db, companyId, { jobId: q(req.query.jobId), customerId: q(req.query.customerId), from: q(req.query.from), to: q(req.query.to) })));
  // Trips: shared travel costs and travel time, billed to each project by its share. Costs are spending, so "bills".
  const TR = '/companies/:companyId/trips';
  const TC = '/companies/:companyId/trip-costs/:costId';
  // The Road page: keys for the phone (each person sees and revokes only their own) and the inbox of what it sent.
  const RK = '/companies/:companyId/road-keys';
  const RI = '/companies/:companyId/road-items';
  const siteOrigin = (req) => `${req.protocol}://${(req.headers.host ?? '').toLowerCase()}`;
  api.get(RK, route('bills', ({ db, req, companyId }) => roadSvc.listRoadKeys(db, companyId, req.user.id)));
  api.post(RK, route('bills', ({ db, req, companyId, actor }) => roadSvc.createRoadKey(db, companyId, req.user.id, req.body ?? {}, { origin: siteOrigin(req), actor }), 201));
  api.post(`${RK}/:keyId/revoke`, route('bills', ({ db, req, companyId, actor }) => roadSvc.revokeRoadKey(db, companyId, req.user.id, req.params.keyId, { actor })));
  api.get(RI, route(['view_books', 'bills', 'invoices'], ({ db, req, companyId }) => roadSvc.listRoadItems(db, companyId, { status: req.query.status })));
  api.get(`${RI}/:itemId/photos/:photoId`, route(['view_books', 'bills', 'invoices'], async ({ db, req, companyId }) =>
    ({ [FILE]: await roadSvc.getRoadPhoto(db, companyId, req.params.itemId, req.params.photoId) })));
  api.post(`${RI}/:itemId/accept`, route('bills', ({ db, req, companyId, viewer, actor }) => roadSvc.acceptRoadItem(db, companyId, viewer, req.params.itemId, req.body ?? {}, { actor })));
  api.post(`${RI}/:itemId/accept-check`, route('invoices', ({ db, req, companyId, actor }) => roadSvc.acceptRoadCheck(db, companyId, req.params.itemId, req.body ?? {}, { actor })));
  api.post(`${RI}/:itemId/dismiss`, route(['bills', 'invoices'], ({ db, req, companyId, actor }) => roadSvc.dismissRoadItem(db, companyId, req.params.itemId, { actor })));
  api.get(TR, route(['view_books', 'bills'], ({ db, req, companyId }) => trips.listTrips(db, companyId, { includeClosed: req.query.closed !== '0' })));
  api.post(TR, route('bills', ({ db, req, companyId, actor }) => trips.createTrip(db, companyId, req.body ?? {}, { actor }), 201));
  api.get(`${TR}/:tripId`, route(['view_books', 'bills'], ({ db, req, companyId }) => trips.getTrip(db, companyId, req.params.tripId)));
  api.patch(`${TR}/:tripId`, route('bills', ({ db, req, companyId, actor }) => trips.updateTrip(db, companyId, req.params.tripId, req.body ?? {}, { actor })));
  api.post(`${TR}/:tripId/costs`, route('bills', ({ db, req, companyId, actor }) =>
    trips.addTripCost(db, companyId, req.params.tripId, req.body ?? {}, { actor, idempotencyKey: idemKey(req) }), 201));
  api.post(`${TR}/:tripId/travel-time`, route('bills', ({ db, req, companyId, viewer, actor }) =>
    trips.addTravelTime(db, companyId, viewer, req.params.tripId, req.body ?? {}, { actor }), 201));
  api.patch(`${TR}/:tripId/travel-time/:timeEntryId`, route('bills', ({ db, req, companyId, viewer, actor }) =>
    trips.updateTravelTime(db, companyId, viewer, req.params.tripId, req.params.timeEntryId, req.body ?? {}, { actor })));
  api.delete(`${TR}/:tripId/travel-time/:timeEntryId`, route('bills', ({ db, req, companyId, viewer, actor }) =>
    trips.removeTravelTime(db, companyId, viewer, req.params.tripId, req.params.timeEntryId, { actor })));
  // Edit = void + corrected copy, and Void reverses a posted entry: the same permission as for bills ("post").
  api.put(TC, route('post', ({ db, req, companyId, actor }) => trips.replaceTripCost(db, companyId, req.params.costId, req.body ?? {}, { actor, idempotencyKey: idemKey(req) })));
  api.post(`${TC}/void`, route('post', ({ db, req, companyId, actor }) => trips.voidTripCost(db, companyId, req.params.costId, { actor })));
  api.get(`${TC}/photos`, route(['view_books', 'bills'], ({ db, req, companyId }) => trips.listCostPhotos(db, companyId, req.params.costId)));
  api.get(`${TC}/photos/:photoId`, route(['view_books', 'bills'], async ({ db, req, companyId }) =>
    ({ [FILE]: await trips.getCostPhoto(db, companyId, req.params.costId, req.params.photoId) })));
  api.post(`${TC}/photos`, route('bills', ({ db, req, companyId, actor }) => trips.addCostPhoto(db, companyId, req.params.costId, { picture: req.body?.picture, actor }), 201));
  api.delete(`${TC}/photos/:photoId`, route('bills', ({ db, req, companyId, actor }) => trips.deleteCostPhoto(db, companyId, req.params.costId, req.params.photoId, { actor })));
  // MileIQ's monthly drive report → mileage costs on trips (src/services/mileIqService.js).
  api.post('/companies/:companyId/mileiq/preview', route('bills', ({ db, req, companyId }) => mileIq.previewMileIq(db, companyId, { content: req.body?.content })));
  api.post('/companies/:companyId/mileiq/import', route('bills', ({ db, req, companyId, actor }) => mileIq.importMileIq(db, companyId, req.body ?? {}, { actor }), 201));

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
  // Photos of the check and remittance, kept with the payment.
  api.get('/companies/:companyId/payments/:paymentId/photos', route(['view_books', 'invoices', 'bills'], async ({ db, req, companyId, can }) => {
    await seeSide(db, can, 'payments', req.params.paymentId);
    return photos.listPaymentPhotos(db, companyId, req.params.paymentId);
  }));
  api.get('/companies/:companyId/payments/:paymentId/photos/:photoId', route(['view_books', 'invoices', 'bills'], async ({ db, req, companyId, can }) => {
    await seeSide(db, can, 'payments', req.params.paymentId);
    return { [FILE]: await photos.getPaymentPhoto(db, companyId, req.params.paymentId, req.params.photoId) };
  }));
  api.post('/companies/:companyId/payments/:paymentId/photos', route(['invoices', 'bills'], async ({ db, req, companyId, can, actor }) => {
    await needSide(db, can, 'payments', req.params.paymentId);
    return photos.addPaymentPhoto(db, companyId, req.params.paymentId, { picture: req.body?.picture, actor });
  }, 201));
  api.delete('/companies/:companyId/payments/:paymentId/photos/:photoId', route(['invoices', 'bills'], async ({ db, req, companyId, can, actor }) => {
    await needSide(db, can, 'payments', req.params.paymentId);
    return photos.deletePaymentPhoto(db, companyId, req.params.paymentId, req.params.photoId, { actor });
  }));
  api.put('/companies/:companyId/payments/:paymentId', route('post', async ({ db, req, companyId, can, actor }) => {
    await needSide(db, can, 'payments', req.params.paymentId);
    const { contactId, date, accountId, method, reference, memo, applications } = req.body ?? {};
    return arap.replacePayment(db, companyId, req.params.paymentId, { contactId, date, accountId, method, reference, memo, applications, idempotencyKey: idemKey(req), actor });
  }));
  api.get('/companies/:companyId/reports/ar-aging', report(['view_books', 'invoices'], 'Accounts Receivable Aging',
    ({ db, req, companyId }) => arap.getAging(db, companyId, { kind: 'invoice', asOf: q(req.query.asOf) ?? centralToday() }), agingRows));
  api.get('/companies/:companyId/reports/ap-aging', report(['view_books', 'bills'], 'Accounts Payable Aging',
    ({ db, req, companyId }) => arap.getAging(db, companyId, { kind: 'bill', asOf: q(req.query.asOf) ?? centralToday() }), agingRows));

  // Importing books (QuickBooks / spreadsheets). Accountant-level: it can change many periods at once.
  const importOpts = (req, actor) => ({ kind: req.body?.kind, asOf: req.body?.asOf, actor,
    file: { fileName: req.body?.fileName, content: req.body?.content, base64: req.body?.base64 ?? null } });
  api.post('/companies/:companyId/imports/preview', route('accounts', ({ db, req, companyId, actor }) => imports.previewImport(db, companyId, importOpts(req, actor))));
  api.post('/companies/:companyId/imports', route('accounts', ({ db, req, companyId, actor }) => imports.commitImport(db, companyId, importOpts(req, actor)), 201));
  api.get('/companies/:companyId/imports', route('view_books', ({ db, companyId }) => imports.listImports(db, companyId)));
  api.post('/companies/:companyId/imports/:batchId/undo', route('accounts', ({ db, req, companyId, actor }) => imports.undoImport(db, companyId, req.params.batchId, { actor })));

  // Reports
  api.get('/companies/:companyId/reports/dashboard', route('view_books', ({ db, req, companyId }) => reports.getDashboard(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  api.get('/companies/:companyId/reports/statistics', route('view_books', ({ db, req, companyId }) => reports.getStatistics(db, companyId, { asOf: q(req.query.asOf) ?? today() })));
  // Each person's own Home cards (any member: it's their page, not the company's books).
  api.get('/companies/:companyId/home-layout', route('member', ({ db, req, companyId }) => homeLayout.getHomeLayout(db, companyId, req.user.id)));
  api.put('/companies/:companyId/home-layout', route('member', ({ db, req, companyId }) => homeLayout.saveHomeLayout(db, companyId, req.user.id, req.body ?? {})));
  // Back up your books: the chart of accounts and every journal entry, in our import templates' layout.
  const backupFile = (title, rowsFor) => route('view_books', async ({ db, companyId }) => {
    const company = (await ledger.getCompany(db, companyId)).name;
    return { [FILE]: { name: csvFileName(company, title, centralToday()), type: 'text/csv; charset=utf-8', body: toCsv(await rowsFor(db, companyId)) } };
  });
  api.get('/companies/:companyId/backup/accounts', backupFile('Chart of accounts', backup.chartRows));
  api.get('/companies/:companyId/backup/journal', backupFile('All transactions', backup.journalRows));
  // The whole company as one .zacc file (src/services/bookFileService.js): owner-level, since it holds payroll and everything else.
  api.get('/companies/:companyId/book-file', route('admin', async ({ db, companyId, actor }) => {
    const f = await bookFiles.bookFile(db, companyId, { actor, appVersion: appVersion() });
    return { [FILE]: { name: f.name, type: 'application/zip', body: f.body } };
  }));
  const qbName = async (db, companyId, ext) => `${(await ledger.getCompany(db, companyId)).name.replace(/[^\w .,()&-]+/g, '').trim().slice(0, 80)} for QuickBooks ${centralToday()}.${ext}`;
  api.get('/companies/:companyId/export/quickbooks-desktop', route('view_books', async ({ db, companyId }) =>
    ({ [FILE]: { name: await qbName(db, companyId, 'iif'), type: 'text/plain; charset=utf-8', body: await bookFiles.quickbooksIif(db, companyId) } })));
  api.get('/companies/:companyId/export/quickbooks-online', route('view_books', async ({ db, companyId }) =>
    ({ [FILE]: { name: await qbName(db, companyId, 'csv'), type: 'text/csv; charset=utf-8', body: await bookFiles.quickbooksOnlineCsv(db, companyId) } })));

  api.get('/companies/:companyId/reports/trial-balance', report('view_books', 'Trial Balance',
    ({ db, req, companyId }) => reports.getTrialBalance(db, companyId, { asOf: q(req.query.asOf) ?? today() }), statement('trial-balance')));
  api.get('/companies/:companyId/reports/balance-sheet', report('view_books', 'Balance Sheet',
    ({ db, req, companyId }) => reports.getBalanceSheet(db, companyId, { asOf: q(req.query.asOf) ?? today(), compare: q(req.query.compare) }), statement('balance-sheet')));
  api.get('/companies/:companyId/reports/income-statement', report('view_books', 'Profit and Loss',
    ({ db, req, companyId }) => reports.getIncomeStatement(db, companyId, { from: q(req.query.from), to: q(req.query.to), compare: q(req.query.compare) }), statement('income-statement')));
  api.get('/companies/:companyId/reports/cash-flow', report('view_books', 'Statement of Cash Flows',
    ({ db, req, companyId }) => reports.getCashFlow(db, companyId, { from: q(req.query.from), to: q(req.query.to) }), statement('cash-flow')));
  api.get('/companies/:companyId/audit/verify', route('audit', ({ db, companyId }) => verifyChain(db, companyId)));
  api.get('/companies/:companyId/books-check', route('view_books', ({ db, companyId }) => latestBooksCheck(db, companyId)));
  api.post('/companies/:companyId/books-check', route('audit', ({ db, companyId }) => runBooksCheck(db, companyId)));

  // Tax-ready, level 1: totals for the tax preparer (no forms printed or filed).
  api.get('/companies/:companyId/tax-categories', route('view_books', ({ db, companyId }) => tax.getTaxCategories(db, companyId)));
  api.put('/companies/:companyId/tax-categories', route('accounts', ({ db, req, companyId, actor }) =>
    tax.setTaxCategories(db, companyId, { items: req.body?.items, actor })));
  api.get('/companies/:companyId/reports/tax-summary', report('view_books', 'Tax Summary',
    ({ db, req, companyId }) => tax.getTaxSummary(db, companyId, { from: q(req.query.from), to: q(req.query.to) }), taxSummaryRows));
  api.get('/companies/:companyId/reports/tax-1099', report(['view_books', 'bills'], '1099-NEC Totals',
    ({ db, req, companyId }) => tax.get1099Totals(db, companyId, { year: q(req.query.year) }), nec1099Rows));
  // W-2 totals show pay details, so they need the payroll role.
  api.get('/companies/:companyId/reports/tax-w2', report('payroll', 'W-2 and W-3 Totals',
    ({ db, req, companyId }) => tax.getW2Totals(db, companyId, { year: q(req.query.year) }), w2Rows));

  // Payroll
  api.get('/companies/:companyId/employees', route(['view_books', 'payroll'], ({ db, companyId }) => payroll.listEmployees(db, companyId)));
  api.post('/companies/:companyId/employees', route('payroll', ({ db, req, companyId, actor }) => payroll.createEmployee(db, companyId, req.body ?? {}, { actor }), 201));
  api.put('/companies/:companyId/employees/:employeeId', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.updateEmployee(db, companyId, req.params.employeeId, req.body ?? {}, { actor })));
  api.post('/companies/:companyId/employees/:employeeId/terminate', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.setEmployeeStatus(db, companyId, req.params.employeeId, { active: false, date: req.body?.date, reason: req.body?.reason, actor })));
  api.post('/companies/:companyId/employees/:employeeId/rehire', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.setEmployeeStatus(db, companyId, req.params.employeeId, { active: true, date: req.body?.date, actor })));
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
  api.post('/companies/:companyId/payroll-runs/:runId/void', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.voidRun(db, companyId, req.params.runId, { date: req.body?.date, reason: req.body?.reason, actor })));
  api.get('/companies/:companyId/payroll-runs/:runId', route(['view_books', 'payroll'], ({ db, req, companyId }) => payroll.getRun(db, companyId, req.params.runId)));
  // Pay stubs and tax totals show pay details, so they need the payroll role (not every member).
  api.get('/companies/:companyId/paychecks/:paycheckId/stub', route('payroll', ({ db, req, companyId }) => payroll.getPayStub(db, companyId, req.params.paycheckId)));
  api.get('/companies/:companyId/reports/payroll-register', report('payroll', 'Payroll Register',
    ({ db, req, companyId }) => payroll.getPayrollRegister(db, companyId, { from: q(req.query.from), to: q(req.query.to) }), payrollRegisterRows));
  api.get('/companies/:companyId/reports/payroll-liabilities', route('payroll', ({ db, req, companyId }) =>
    payroll.getPayrollLiabilities(db, companyId, { from: q(req.query.from), to: q(req.query.to) })));
  api.post('/companies/:companyId/payroll-deposits', route('payroll', ({ db, req, companyId, actor }) => {
    const { agency, form, periodStart, periodEnd, depositDate, paidFromAccountId, reference } = req.body ?? {};
    return payroll.recordDeposit(db, companyId, { agency, form, periodStart, periodEnd, depositDate, paidFromAccountId, reference, idempotencyKey: idemKey(req) }, { actor });
  }, 201));
  api.post('/companies/:companyId/payroll-deposits/:depositId/void', route('payroll', ({ db, req, companyId, actor }) =>
    payroll.voidDeposit(db, companyId, req.params.depositId, { date: req.body?.date, actor })));
  api.get('/companies/:companyId/paychecks', route(['view_books', 'payroll'], ({ db, req, companyId }) =>
    payroll.listPaychecks(db, companyId, { year: req.query.year ? Number(req.query.year) : undefined })));

  api.patch('/companies/:companyId/employees/:employeeId/user', route(['payroll', 'admin'], ({ db, req, companyId, actor }) =>
    time.linkEmployeeUser(db, companyId, req.params.employeeId, req.body?.userId ?? null, { actor })));
  api.get('/companies/:companyId/payroll-hours', route('payroll', ({ db, req, companyId }) =>
    time.getPayrollHours(db, companyId, { payFrequency: q(req.query.payFrequency), periodStart: q(req.query.periodStart), periodEnd: q(req.query.periodEnd) })));

  // Jobs and timesheets. Who may see or change whose time is checked inside the service
  // (own time, your department's time with "approve time", or everyone's with "all time").
  const TIME = ['time_own', 'time_approve', 'time_all'];
  // Jobs are also the projects invoices and bills name, so whoever writes invoices can add them.
  const JOB_ADMIN = ['time_approve', 'time_all', 'admin', 'invoices'];
  api.get('/companies/:companyId/jobs', route('member', ({ db, req, companyId }) => time.listJobs(db, companyId, { includeInactive: req.query.inactive === '1' })));
  api.post('/companies/:companyId/jobs', route(JOB_ADMIN, ({ db, req, companyId, actor }) => time.createJob(db, companyId, req.body ?? {}, { actor }), 201));
  api.post('/companies/:companyId/jobs/import', route(JOB_ADMIN, ({ db, req, companyId, can, actor }) =>
    projects.importProjects(db, companyId, { text: req.body?.text, customerId: req.body?.customerId || null,
      // Adding customers from the names needs the right to add customers (invoices), not just to manage jobs.
      makeCustomers: req.body?.makeCustomers === true && (can('invoices') || can('admin')), preview: req.body?.preview === true }, { actor })));
  api.patch('/companies/:companyId/jobs/:jobId', route(JOB_ADMIN, ({ db, req, companyId, actor }) => time.updateJob(db, companyId, req.params.jobId, req.body ?? {}, { actor })));
  const TE = '/companies/:companyId/time-entries';
  api.get(TE, route(TIME, ({ db, req, companyId, viewer }) => time.listTimeEntries(db, companyId, viewer, {
    from: q(req.query.from), to: q(req.query.to), userId: q(req.query.userId), status: q(req.query.status), jobId: q(req.query.jobId) })));
  api.post(TE, route(TIME, ({ db, req, companyId, viewer, actor }) => time.createTimeEntry(db, companyId, viewer, req.body ?? {}, { actor }), 201));
  api.post(`${TE}/submit`, route(TIME, ({ db, req, companyId, viewer }) => time.submitTimeEntries(db, companyId, viewer, { ids: req.body?.ids })));
  api.post(`${TE}/review`, route(['time_approve', 'time_all'], ({ db, req, companyId, viewer, actor }) =>
    time.reviewTimeEntries(db, companyId, viewer, { ids: req.body?.ids, approve: req.body?.approve, note: req.body?.note }, { actor })));
  api.post(`${TE}/import`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.importTimesheet(db, companyId, viewer, {
    fileName: req.body?.fileName, content: req.body?.content, pdf: req.body?.pdf, preview: req.body?.preview === true, userId: req.body?.userId || null, createJobs: req.body?.createJobs === true }, { actor })));
  api.get('/companies/:companyId/reports/time-summary', route(TIME, ({ db, req, companyId, viewer }) =>
    time.getTimeSummary(db, companyId, viewer, { from: q(req.query.from), to: q(req.query.to) })));
  api.patch(`${TE}/:timeEntryId`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.updateTimeEntry(db, companyId, viewer, req.params.timeEntryId, req.body ?? {}, { actor })));
  api.delete(`${TE}/:timeEntryId`, route(TIME, ({ db, req, companyId, viewer, actor }) => time.deleteTimeEntry(db, companyId, viewer, req.params.timeEntryId, { actor })));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Static UI
  const vuePath = fileURLToPath(new URL('../node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url));
  app.get('/vendor/vue.js', (req, res) => res.type('text/javascript').sendFile(vuePath));
  // Draws a picture of the screen for Beta feedback (loaded only when the dialog asks for one).
  const htmlToImagePath = fileURLToPath(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url));
  app.get('/vendor/html-to-image.js', (req, res) => res.type('text/javascript').sendFile(htmlToImagePath));
  // The front page (services, security, sign-in) is at /, prices at /prices; the app itself is at /app.
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', (req, res) => res.sendFile('welcome.html', { root: publicDir }));
  app.get('/prices', (req, res) => res.sendFile('prices.html', { root: publicDir }));
  // The app and the Road page: the HTML shell, and its screens compiled on the server (src/core/pages.js).
  const pageRoutes = (paths, file, id, script) => {
    const load = () => page(`${publicDir}${file}`, id);
    app.get(paths, (req, res) => res.type('html').send(load().shell));
    app.get(script, (req, res) => res.type('text/javascript').set('Cache-Control', 'no-cache').send(load().code));
  };
  pageRoutes(['/app', '/app/'], 'index.html', 'app', '/app.render.js');
  pageRoutes('/road', 'road.html', 'road', '/road.render.js');
  app.use(express.static(publicDir, { index: false }));

  // Errors -> JSON. User mistakes are 4xx with a readable message; anything else is 500 without internals.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    if (err instanceof LedgerError || err instanceof PayrollError) {
      const status = /not found/i.test(err.message) ? 404 : 400;
      return res.status(status).json({ error: err.message, details: err.details ?? [] });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: `That is too large to send (the limit here is ${Math.round(err.limit / 1_048_576)} MB). Try a smaller file or picture.` });
    }
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
    console.error(JSON.stringify({ level: 'error', msg: err.message, code: err.code, reqId: req.id, route: req.route?.path ?? 'unmatched' }));
    serverErrors.push({ at: new Date().toISOString(), message: String(err.message).slice(0, 300), code: err.code ?? null, reqId: req.id,
      method: req.method, route: `${req.baseUrl ?? ''}${req.route?.path ?? ''}` || 'unmatched' });
    if (serverErrors.length > 100) serverErrors.shift();
    res.status(500).json({ error: 'Something went wrong on our side. Nothing was saved.' });
  });
  return app;
}

