// zAccountant browser app (Vue 3, no build step).
// ℹ️ Vue keeps the page in sync with the data below: change `this.tab` and the screen switches.
import { createApp } from '/vendor/vue.js';
// The screens (the HTML in index.html), compiled by the server into a render function (src/core/pages.js).
import { render } from '/app.render.js';
import { HELP, helpForTab, searchHelp } from '/help.js';
import { startRecorder, noteError, captureContext, pictureOfScreen, pictureFromFile } from '/feedback.js';
import { picturesFromClipboard } from '/paste.js';
import { clockTime, hhmm, nextDay } from '/clock.js';
import { payeeKey, payeeRuleText } from '/payee.js';

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => today().slice(0, 4) + '-01-01';

/** Format integer cents for people. Kept in sync with src/core/money.js formatMoney. */
function money(c) {
  if (c == null) return '';
  const abs = Math.abs(c);
  const s = `$${Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(abs % 100).padStart(2, '0')}`;
  return c < 0 ? `(${s})` : s;
}

/** Exact decimal → cents (no floating point), mirrors toCents on the server. Returns null if invalid. */
function cents(v) {
  const m = /^\s*\$?(\d{0,3}(?:,?\d{3})*|\d*)(?:\.(\d{0,2}))?\s*$/.exec(v ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1].replace(/,/g, '') || 0) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Quantity × price → cents, rounded half-up exactly like the server (BigInt, no floating point). */
function lineCents(qty, price) {
  const p = cents(price);
  const f = /^(\d{1,4})\/(\d{1,4})$/.exec(String(qty || '').trim()); // a share like 1/3 (split across jobs)
  if (f) return p == null || Number(f[2]) === 0 ? null : Number((BigInt(f[1]) * BigInt(p) * 2n + BigInt(f[2])) / (2n * BigInt(f[2])));
  const m = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec(String(qty || '1').trim().replace(/^\./, '0.').replace(/\.$/, '')); // ".5" is 0.5
  if (p == null || !m) return null;
  const n = (BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'))) * BigInt(p);
  return Number((n * 2n + 10000n) / 20000n);
}
/** Sales tax on taxable cents at a percent like "8.25", half-up. */
function taxCents(taxable, pct) {
  const m = /^(\d*)(?:\.(\d{0,4}))?$/.exec(String(pct ?? '').trim());
  if (!m || (!m[1] && !m[2])) return 0;
  const ppm = BigInt(m[1] || 0) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'));
  return Number((BigInt(taxable) * ppm * 2n + 1000000n) / 2000000n);
}

// Passkeys (Face ID, Touch ID, Windows Hello): the browser works in raw bytes; the server takes base64url text.
const toBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const canPasskey = () => typeof window !== 'undefined' && Boolean(window.PublicKeyCredential && navigator.credentials);
/** A friendly name for this device, to start the passkey's name with. */
function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'computer';
}
/** What the browser says when a passkey step doesn't finish, in plain words. */
function passkeyProblem(e) {
  if (e?.name === 'NotAllowedError') return 'The passkey step was cancelled or timed out. Try again when ready.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (e?.name === 'SecurityError') return 'Passkeys work only on the real zAccountant address (https).';
  return 'This browser could not use a passkey here.';
}

// Sales (invoices to customers) and Bills (from vendors) share one screen; these are the differences.
const SIDES = {
  sales: { kind: 'invoice', perm: 'invoices', Doc: 'Invoice', docs: 'Invoices', who: 'customer', Who: 'Customer', Whos: 'Customers', contacts: 'customers', docPath: 'invoices',
    payPath: 'payments-received', agingPath: 'ar-aging', payVerb: 'Receive payment', control: 'Accounts Receivable', lineHint: 'Income account' },
  bills: { kind: 'bill', perm: 'bills', Doc: 'Bill', docs: 'Bills', who: 'vendor', Who: 'Vendor', Whos: 'Vendors', contacts: 'vendors', docPath: 'bills',
    payPath: 'payments-made', agingPath: 'ap-aging', payVerb: 'Pay bills', control: 'Accounts Payable', lineHint: 'Expense account' },
};
const ENTITY_TYPES = [
  ['individual', 'Individual (personal books)'], ['sole_proprietor', 'Sole proprietor'], ['single_member_llc', 'Single-member LLC'],
  ['partnership', 'Partnership or multi-member LLC'], ['s_corp', 'S corporation (or LLC taxed as one)'], ['c_corp', 'C corporation'],
];
const blankCompany = () => ({ name: '', homeState: 'TX', fiscalYearStartMonth: 1, entityType: '', booksStartDate: `${today().slice(0, 4)}-01-01` });
// A bill line can name its project and be billed to that client; an invoice line can come from a time entry or such a cost.
// `row` is a tag for the screen only (never sent): when the lines are sorted by date, each row's boxes move with it.
let lineRow = 0;
const blankLine = () => ({ itemId: '', serviceDate: '', accountId: '', description: '', quantity: '1', unitPrice: '', taxable: false,
  jobId: '', billable: false, timeEntryId: '', billedLineId: '', tripCostId: '', from: '', row: ++lineRow });
const blankProject = () => ({ name: '', code: '', customerId: '', address: '' });
const blankTrip = () => ({ name: '', startDate: today(), endDate: '', notes: '', jobs: [{ jobId: '', share: '' }] });
const blankTripCost = (date = today()) => ({ date, kind: 'other', vendor: '', description: '', amount: '', miles: '', mileRate: '',
  expenseAccountId: '', paidFromAccountId: '', photos: [], photoBusy: false, key: newKey() });
// The rate per mile last used on this computer or phone, offered on the next mileage cost (never a built-in number).
// Zoom (the status bar's slider, like Word's): this browser's choice, kept between visits. 100 = normal size.
const ZOOM_MIN = 50; const ZOOM_MAX = 200;
const projectSort = () => { try { const s = JSON.parse(localStorage.getItem('zacc.projectSort')); if (['code', 'name', 'customer'].includes(s?.key)) return { key: s.key, dir: s.dir < 0 ? -1 : 1 }; } catch { /* none kept */ } return { key: 'code', dir: 1 }; };
const NEW_CONTACT = '+new'; // the "+ Add new customer…" (and "+ Add new project…") choice in the invoice/bill form's lists
const lastZoom = () => { try { const z = Number(localStorage.getItem('zacc.zoom')); return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 100; } catch { return 100; } };
const keepZoom = (z) => { try { localStorage.setItem('zacc.zoom', String(z)); } catch { /* private window: not kept */ } };
const applyZoom = (z) => document.documentElement.style.setProperty('--zoom', String(z / 100));
// Options menu (⋮ on the status bar): this browser's display settings, kept between visits. Each item names its choices;
// `ready: false` marks a setting whose place is ready but which doesn't do anything yet (shown with a "coming" tag).
// `showIf` shows an item only when another has a value (Theme appears when Theme override is Yes).
const STATUS_OPTIONS = [
  { id: 'display', title: 'Display', items: [
    { id: 'themeOverride', label: 'Theme override', choices: [['no', 'No (follow this device)'], ['yes', 'Yes']], ready: false },
    { id: 'theme', label: 'Theme', choices: [['light', 'Light'], ['dark', 'Dark']], ready: false, showIf: { id: 'themeOverride', is: 'yes' } },
  ] },
];
const PREF_DEFAULTS = { themeOverride: 'no', theme: 'light' };
const lastPrefs = () => { try { return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('zacc.prefs') ?? '{}') }; } catch { return { ...PREF_DEFAULTS }; } };
const keepPrefs = (p) => { try { localStorage.setItem('zacc.prefs', JSON.stringify(p)); } catch { /* private window: not kept */ } };
const lastMileRate = () => { try { return localStorage.getItem('zacc.mileRate') ?? ''; } catch { return ''; } };
const keepMileRate = (r) => { try { localStorage.setItem('zacc.mileRate', r); } catch { /* private window: not kept */ } };
// The accounts last used for costs that came in from the Road page.
const lastRoadAccounts = () => { try { return JSON.parse(localStorage.getItem('zacc.roadAccounts') ?? '{}') ?? {}; } catch { return {}; } };
const keepRoadAccounts = (v) => { try { localStorage.setItem('zacc.roadAccounts', JSON.stringify(v)); } catch { /* not kept */ } };
// The card last used for each kind of trip cost (Homer, 2026-10-30: airfare and hotels on the card with the upgrades).
const cardsByKind = () => { try { return JSON.parse(localStorage.getItem('zacc.cardByKind') ?? '{}') ?? {}; } catch { return {}; } };
const keepCardFor = (kind, id) => { try { if (kind && id) localStorage.setItem('zacc.cardByKind', JSON.stringify({ ...cardsByKind(), [kind]: id })); } catch { /* not kept */ } };
const blankDoc = (taxRate = '') => ({ contactId: '', number: '', date: today(), dueDate: '', planCount: '', planFirstDue: '', noLateCharges: false, memo: '', project: '', jobId: '', attention: '', careOf: '', sendTo: '', clientRef: '', savePerson: true, taxRate, splitJobs: 1, lines: [blankLine()], key: newKey() });
const blankItem = () => ({ name: '', kind: 'service', rate: '', taxable: false, accountId: '' });
const blankContact = () => ({ name: '', email: '', phone: '', address: '', termsDays: 30, is1099: false, isHomeowner: false, noLateCharges: false, groupName: '', people: [] });
const blankPerson = () => ({ name: '', email: '', phone: '' });
const blankPay = () => ({ contactId: '', date: today(), accountId: '', method: 'check', reference: '', memo: '', open: [], amounts: {}, photos: [], keptPhotos: 0, photoBusy: false, key: newKey() });
// Check photos: shrunk in the browser to 2000 pixels on the longer side (enough to read a check), JPEG.
const PHOTO_SIDE = 2000;

let onSignInNeeded = () => {};

/** Download a file the server makes (a CSV report) with the signed-in session, under the server's file name. */
async function download(url) {
  const res = await fetch(`/api${url}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) onSignInNeeded(data.next);
    throw new Error(data.error ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'report.csv';
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const REQUEST_TIMEOUT_MS = 120_000; // a big import can take a while; anything longer has stalled
async function api(method, url, body, headers = {}) {
  if (method !== 'GET' && body === undefined) body = {}; // writes are always JSON (server CSRF rule)
  const where = `${method} ${url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')}`;
  let res;
  try {
    res = await fetch(`/api${url}`, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // ℹ️ No answer at all: the connection dropped, or the server is restarting. For a save we can't know whether
    // it arrived, so say so. Entries, invoices, bills and payments carry an Idempotency-Key, so pressing Save
    // again on those never records them twice.
    const timedOut = e?.name === 'TimeoutError';
    noteError('network', `${where} → ${timedOut ? 'timed out' : 'no connection'}`);
    const what = timedOut ? 'zAccountant took too long to answer' : "Can't reach zAccountant. Check your internet connection";
    throw Object.assign(new Error(method === 'GET' ? `${what}, then try again.` : `${what}. Your change may not have been saved: check, then try again.`), { details: [], network: true });
  }
  const data = await res.json().catch(() => (res.ok ? {} : { error: res.status >= 500
    ? `zAccountant is restarting or briefly unavailable (error ${res.status}). Wait a minute and try again.`
    : `The request was refused (error ${res.status}).` }));
  if (res.status === 401 && !url.startsWith('/auth/') && !url.includes('/lock')) onSignInNeeded(data.next);
  if (!res.ok && res.status !== 401) noteError('server', `${where} → ${res.status}: ${data.error ?? ''}`, res.headers.get('x-request-id'));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { details: data.details ?? [] });
  return data;
}

// Which tabs need which permission (any of). The server is the real gatekeeper; this just hides
// screens someone can't use.
const TAB_PERMS = {
  home: ['view_books'], journal: ['view_books'], sales: ['view_books', 'invoices'], bills: ['view_books', 'bills'], trips: ['view_books', 'bills'], bank: ['view_books'],
  reports: ['view_books', 'payroll'], accounts: ['view_books'], payroll: ['view_books', 'payroll'], time: ['time_own', 'time_approve', 'time_all'],
  setup: ['admin'],
};

// Tabs that need a feature of the company's plan (src/core/plans.js on the server).
const TAB_FEATURE = { payroll: 'payroll', time: 'timesheets' };

// Home page cards (Homer, 2026-10-25): shortcuts to the common jobs, next to "Record a transaction", that each person
// adds, removes and moves (kept per person per company: /home-layout). `perms`: any one of them shows the card;
// `feature`: the plan must include it. `go` runs on a press. The server keeps only the ids; an unknown id is skipped.
const HOME_CARDS = [
  { id: 'stats', icon: '📊', title: 'Statistics', hint: 'Income, expenses and cash, month by month', perms: ['view_books'] },
  { id: 'invoice', icon: '🧾', title: 'New invoice', hint: 'Bill a customer', perms: ['invoices'], go: { tab: 'sales', then: 'newDoc' } },
  { id: 'paid', icon: '💵', title: 'Customer paid', hint: 'Record a payment received', perms: ['invoices'], go: { tab: 'sales', then: 'startPay' } },
  { id: 'plans', icon: '🗓️', title: 'Payment plans', hint: 'Next payments, record one, print a statement', perms: ['invoices'], go: { tab: 'sales', then: 'openPlans' } },
  { id: 'bill', icon: '📄', title: 'Enter a bill', hint: 'Something you owe a vendor', perms: ['bills'], go: { tab: 'bills', then: 'newDoc' } },
  { id: 'paybill', icon: '💸', title: 'Pay a bill', hint: 'Record a bill payment', perms: ['bills'], go: { tab: 'bills', then: 'startPay' } },
  { id: 'bank', icon: '🏦', title: 'Banking', hint: 'Review imported bank transactions', perms: ['view_books'], go: { tab: 'bank' } },
  { id: 'card', icon: '💳', title: 'Credit cards', hint: 'Statement charges, matching and reconciling', perms: ['view_books'], go: { tab: 'bank', before: 'pickCard' } },
  { id: 'paycard', icon: '🔁', title: 'Pay the credit card', hint: 'Money from the bank to the card', perms: ['post'], go: { tab: 'home', then: 'payCard' } },
  { id: 'trip', icon: '✈️', title: 'New trip', hint: 'Costs and travel time for a trip', perms: ['bills'], go: { tab: 'trips', then: 'newTrip' } },
  { id: 'mileiq', icon: '🚗', title: 'Import from MileIQ', hint: "Your monthly drive report", perms: ['bills'], go: { tab: 'trips', then: 'openMileIq' } },
  { id: 'time', icon: '⏱️', title: 'Timesheet', hint: 'Enter or approve hours', perms: ['time_own', 'time_approve', 'time_all'], feature: 'timesheets', go: { tab: 'time' } },
  { id: 'payroll', icon: '💼', title: 'Payroll', hint: 'Run paychecks', perms: ['payroll'], feature: 'payroll', go: { tab: 'payroll' } },
  { id: 'pnl', icon: '📈', title: 'Profit & Loss', hint: 'This year so far', perms: ['view_books'], go: { tab: 'reports', report: 'income-statement' } },
  { id: 'balance', icon: '⚖️', title: 'Balance Sheet', hint: 'What you own and owe today', perms: ['view_books'], go: { tab: 'reports', report: 'balance-sheet' } },
  { id: 'journal', icon: '📒', title: 'Transactions', hint: 'Search everything recorded', perms: ['view_books'], go: { tab: 'journal' } },
  { id: 'entry', icon: '✍️', title: 'Journal entry', hint: 'Debits and credits by hand', perms: ['post'], go: { tab: 'journal', then: 'openJE' } },
  { id: 'backup', icon: '💾', title: 'Back up your books', hint: 'Download the .zacc book file', perms: ['admin'], go: { tab: 'settings', then: 'scrollToBackup' } },
];
// Entries that belong to another record: the Transactions tab sends people there instead of offering "reverse"
// (the server refuses it, CPA review B3). Same list as DOCUMENT_ENTRY in ledgerService.js, plus payroll and Banking.
const ENTRY_OWNER = {
  invoice: { where: 'Sales', what: 'invoice' }, bill: { where: 'Bills', what: 'bill' }, payment: { where: 'Sales or Bills', what: 'payment' },
  trip: { where: 'Trips', what: 'trip' }, payroll: { where: 'Payroll', what: "year-to-date pay" }, bank: { where: 'Banking (Undo)', what: 'bank line' },
};
// Entries the Transactions tab can Edit (reverse + corrected copy); same list as CORRECTABLE in ledgerService.js.
const CORRECTABLE = ['manual', 'simple', 'recurring', 'import'];
const DEFAULT_HOME = { left: ['stats'], right: ['invoice', 'paid', 'plans', 'bill', 'bank', 'card', 'trip', 'pnl'] };

/** Sunday on or before an ISO date (workweeks run Sunday to Saturday). */
function weekStartOf(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() - d.getUTCDay() * 86_400_000).toISOString().slice(0, 10);
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const blankTime = (date = today()) => ({ date, jobId: '', start: '', end: '', hours: '', notes: '', billable: true });
/** Minutes -> hours with 2 decimals, rounded half-up like the server ("7.53"). */
const hrs = (m) => { const h = Math.floor((m * 100 + 30) / 60); return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`; };

// One key per "Save" click: if the request is retried (double click, flaky Wi-Fi), the server posts it only once.
const newKey = () => crypto.randomUUID();
const blankSearch = () => ({ text: '', from: '', to: '', accountId: '', source: '' });
const blankRepeat = () => ({ on: false, name: '', frequency: 'monthly', endDate: '' });

const blankEmployee = () => ({
  firstName: '', lastName: '', ssn: '', workState: 'TX', payFrequency: 'biweekly', payType: 'hourly', payRate: '',
  w4: { formYear: 2020, allowances: 0, filingStatus: 'single', step2: false, dependentsCredit: '', extraWithholding: '', exempt: false, exemptYear: Number(today().slice(0, 4)) },
  ca: { filingStatus: 'single', allowances: 1, exempt: false, exemptYear: Number(today().slice(0, 4)) }, co: { annualAllowance: '' }, dc: { filingStatus: 'single', allowances: 0 },
  address: { line1: '', line2: '', city: '', state: '', zip: '' }, hireDate: '',
});

/** An employee from the server, as the Add employee form holds it (for edit). */
const employeeForm = (e) => {
  const b = blankEmployee();
  const el = e.stateElections ?? {};
  const money = (c) => (c == null || c === '' ? '' : String(c));
  return {
    ...b, id: e.id, ssnLast4: e.ssnLast4, elections: el,
    firstName: e.firstName, lastName: e.lastName, workState: e.workState, payFrequency: e.payFrequency, payType: e.payType,
    payRate: (e.payRateCents / 100).toFixed(2), hireDate: e.hireDate ?? '',
    w4: { ...b.w4, ...e.w4, exempt: Boolean(e.w4?.exempt), dependentsCredit: money(e.w4?.dependentsCredit), extraWithholding: money(e.w4?.extraWithholding) },
    ca: { ...b.ca, ...el.CA, exempt: Boolean(el.CA?.exempt) }, co: { ...b.co, ...el.CO }, dc: { ...b.dc, ...el.DC },
    address: { ...b.address, ...e.address },
  };
};

createApp({
  render,
  data() {
    return {
      companies: [], companyId: null, company: null, tab: 'home', message: null,
      auth: { screen: 'loading', user: null, email: '', password: '', name: '', code: '', setup: null, recoveryCodes: null, useRecovery: false },
      passkeys: { list: [], name: '', code: '', busy: false, supported: canPasskey() },
      members: [], newMember: { email: '', role: 'bookkeeper', departmentId: '' },
      roleLabels: { owner: 'Owner', accountant: 'Accountant', bookkeeper: 'Bookkeeper', viewer: 'Viewer (read only)' },
      months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      tabs: [
        { id: 'home', label: 'Home' }, { id: 'journal', label: 'Transactions' }, { id: 'sales', label: 'Sales' }, { id: 'bills', label: 'Bills' }, { id: 'trips', label: 'Trips' }, { id: 'bank', label: 'Banking' },
        { id: 'reports', label: 'Reports' }, { id: 'time', label: 'Time' },
        { id: 'accounts', label: 'Accounts' }, { id: 'payroll', label: 'Payroll' }, { id: 'settings', label: 'Settings' },
      ],
      help: { q: '', id: 'start', from: 'home' },
      version: '',
      zoom: lastZoom(), ZOOM_MIN, ZOOM_MAX, NEW_CONTACT, renaming: null, ENTRY_OWNER, CORRECTABLE, mine: { name: '', current: '', next: '', code: '' }, profile: null,
      MONTHS: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      fullscreen: false, fullscreenOk: !!document.documentElement.requestFullscreen,
      statusMenu: false, prefs: lastPrefs(), STATUS_OPTIONS,
      fb: { open: false, note: '', picture: null, pictureSource: null, busy: false, error: '' },
      adm: { from: 'home', data: null, changes: [], edit: null, q: '' },
      dev: { from: 'home', summary: null, status: 'new', list: null, report: null, text: '', note: '', copied: false },
      roles: { permissions: [], presets: [], custom: [] }, departments: [], newDept: '',
      roleEdit: null,
      typeLabel: { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Income', expense: 'Expense' },
      newCompany: blankCompany(),
      // The new-company setup wizard (steps 1-5) and the "Finish setting up" list on Home.
      setup: { step: 1, status: null, entityType: '', booksStartDate: '', books: 'fresh', fromImport: false,
        newAcct: { name: '', kind: 'bank' }, balances: {}, busy: false },
      entityTypes: ENTITY_TYPES,
      home: { layout: null, editing: false, view: 'cards', stats: null, plans: null, adding: '' },
      accounts: [], dash: null, entries: [], entriesTotal: 0, search: blankSearch(), recurring: [], showRecurring: false, booksCheck: null,
      quick: { kind: 'out', date: today(), memo: '', amount: '', bank: '', other: '', key: newKey() },
      showJE: false, je: { date: today(), memo: '', key: newKey(), repeat: blankRepeat(), lines: [{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }] },
      reportTypes: [
        { id: 'balance-sheet', label: 'Balance Sheet', perm: 'view_books' }, { id: 'income-statement', label: 'Profit & Loss', perm: 'view_books', range: true },
        { id: 'cash-flow', label: 'Cash Flow', perm: 'view_books', range: true }, { id: 'trial-balance', label: 'Trial Balance', perm: 'view_books' },
        { id: 'payroll-register', label: 'Payroll Register', perm: 'payroll', feature: 'payroll', range: true },
        { id: 'tax-summary', label: 'Tax Summary', perm: 'view_books', feature: 'tax', range: true },
        { id: 'tax-1099', label: '1099-NEC', perm: 'view_books', feature: 'tax', yearly: true },
        { id: 'tax-w2', label: 'W-2 / W-3', perm: 'payroll', feature: 'tax', yearly: true },
      ],
      report: { type: 'balance-sheet', from: yearStart(), to: today(), year: Number(today().slice(0, 4)), compare: 'none', data: null },
      taxCats: null,
      showNewAcct: false, newAcct: { code: '', name: '', type: 'expense', subtype: 'operating' }, register: null,
      subtypeChoices: {
        asset: [['current', 'Current asset (prepaid, deposits…)'], ['bank', 'Bank or cash account'], ['cash', 'Cash on hand (petty cash)'], ['receivable', 'Money owed to you'], ['fixed', 'Equipment, vehicle, building'], ['contra', 'Accumulated depreciation'], ['investment', 'Long-term investment']],
        liability: [['current', 'Due within a year'], ['payable', 'Bills you owe'], ['credit_card', 'Credit card'], ['long_term', 'Long-term loan']],
        equity: [['capital', 'Owner contribution'], ['draws', 'Owner draws / distributions']],
        revenue: [['operating', 'Sales or services'], ['other', 'Other income (interest…)']],
        expense: [['operating', 'Operating expense'], ['cogs', 'Cost of goods sold'], ['other', 'Other expense (interest…)']],
      },
      paychecks: [], runs: [], stub: null,
      prun: { show: false, payFrequency: 'biweekly', periodStart: '', periodEnd: '', payDate: today(), paidFrom: '', rows: [], preview: null, key: newKey(), fromTimesheets: false, hoursNotes: [] },
      time: { week: weekStartOf(today()), userId: '', entries: [], jobs: [], form: blankTime(), editing: null, pending: [], picked: {}, note: '',
        file: null, importFor: '', createJobs: false, preview: null, summary: null, showJobs: false, newJob: { name: '', code: '', customerId: '' }, customers: [] },
      liab: { from: today().slice(0, 8) + '01', to: today(), data: null },
      dep: { agency: null, form: '', date: today(), paidFrom: '', reference: '', key: newKey() },
      employees: [], showNewEmp: false, newEmp: blankEmployee(),
      pc: { employee: null, payDate: today(), hours: '', overtimeHours: '', k401: '', paidFrom: '', result: null },
      items: [], inv: { item: blankItem(), editId: null, popupLine: null, letterhead: { address: '', note: '', footer: '' }, late: { apr: '', fee: '', graceDays: 30, holidayGraceDays: 60 }, logoBusy: false, logoOver: false },
      lockDate: '', suiRate: '', famliCount: null, audit: null, futaCr: {},
      imp: { show: false, kind: 'journal', asOf: '', file: null, preview: null, problems: null, busy: false, history: [] },
      importKinds: [
        { id: 'accounts', label: 'Chart of accounts', template: 'chart-of-accounts.csv', help: 'QuickBooks: Reports → Account List → Export to Excel/CSV. Or fill in our template.' },
        { id: 'opening', label: 'Opening balances (trial balance)', template: 'opening-balances.csv', help: 'Balances on the day before you start in zAccountant. QuickBooks: Reports → Trial Balance as of that day → Export.' },
        { id: 'journal', label: 'Transactions (journal)', template: 'journal-entries.csv', help: 'QuickBooks: Reports → Journal for the date range → Export to CSV. Or fill in our template (one row per line; rows with the same Entry number form one entry).' },
        { id: 'iif', label: 'QuickBooks Desktop IIF file', template: null, help: 'QuickBooks Desktop: File → Utilities → Export → Lists/Transactions to IIF. Accounts in the file are created automatically.' },
      ],
      ar: { panel: 'docs', view: 'open', docs: [], contacts: [], payments: [], aging: null, agingAsOf: today(), detail: null, details: null,
        pdfOver: false, pdfBusy: false, roadChecks: [], plans: [], planStatement: null, late: null, lateAsOf: today(), showContact: false, contactPopup: false, contact: blankContact(), showDoc: false, doc: blankDoc(), showPay: false, pay: blankPay(), photoView: null,
        jobs: [], proj: { form: blankProject(), editId: null, show: false, popup: false, sort: projectSort(), paste: '', pasteCustomer: '', makeCustomers: true, preview: null }, pull: null },
      // Trips: list, the open trip, and its forms (a cost with receipt photos, travel time).
      trip: { list: [], cur: null, form: null, editing: false, cost: null, editCostId: null, travel: null, photoView: null, viewRow: null, find: { q: '', pick: {}, newJob: null, customers: [] } },
      road: { items: [], keys: [], keyName: '', made: null, expenseId: '', paidFromId: '', tripFor: {}, cardFor: {}, busy: false },
      mileiq: { file: null, preview: null, pick: {}, tripFor: {}, bulkTrip: '', newTripName: '', rate: '', expenseId: '', paidFromId: '', busy: false },
      bank: { accountId: '', file: null, preview: null, txs: [], view: 'review', choice: {}, sameAs: {}, matches: {}, rules: [], newRule: { matchText: '', direction: 'out', accountId: '' },
        imports: [], recons: [], recon: null, newRecon: { statementDate: '', endingBalance: '' } },
    };
  },
  computed: {
    S() { return SIDES[this.tab] ?? SIDES.sales; },
    // "Part of" names already used, offered when typing one (DWH for DWH - SATX, DWH - AUS).
    contactGroups() { return [...new Set(this.ar.contacts.map((c) => c.groupName).filter(Boolean))].sort(); },
    docLineAccounts() {
      const income = this.S.kind === 'invoice';
      return this.accounts.filter((a) => a.isActive && a.cashFlow !== 'cash' && !['accounts_receivable', 'accounts_payable', 'retained_earnings', 'sales_tax_payable'].includes(a.key)
        && (income ? a.type === 'revenue' || a.type === 'liability' : a.type !== 'revenue'));
    },
    payAccounts() { return this.accounts.filter((a) => a.isActive && (a.cashFlow === 'cash' || (this.S.kind === 'bill' && a.subtype === 'credit_card'))); },
    docTotals() {
      const d = this.ar.doc;
      let sub = 0; let taxable = 0;
      for (const l of d.lines) { const c = lineCents(l.quantity, l.unitPrice) ?? 0; sub += c; if (l.taxable) taxable += c; }
      const tax = this.S.kind === 'invoice' && d.taxRate ? taxCents(taxable, d.taxRate) : 0;
      return { sub, tax, total: sub + tax };
    },
    payTotal() { return Object.values(this.ar.pay.amounts).reduce((s, v) => s + (cents(v) ?? 0), 0); },
    bankAccounts() { return this.accounts.filter((a) => a.cashFlow === 'cash'); },
    /** Record a transaction's bank list: Money out can also be charged to a credit card. */
    quickBanks() { return this.quick.kind === 'out' ? this.bankAccounts.concat(this.accounts.filter((a) => a.isActive && a.subtype === 'credit_card')) : this.bankAccounts; },
    bankLike() { return this.accounts.filter((a) => a.cashFlow === 'cash' || a.subtype === 'credit_card'); },
    categoryChoices() { return this.accounts.filter((a) => a.id !== this.bank.accountId && a.isActive && a.key !== 'retained_earnings'); },
    quickChoices() {
      const k = this.quick.kind;
      if (k === 'out') return this.accounts.filter((a) => a.type === 'expense' || ['liability', 'equity'].includes(a.type) || (a.type === 'asset' && a.cashFlow !== 'cash'));
      if (k === 'in') return this.accounts.filter((a) => a.type === 'revenue' || ['liability', 'equity'].includes(a.type) || (a.type === 'asset' && a.cashFlow !== 'cash'));
      return this.bankAccounts.filter((a) => a.id !== this.quick.bank).concat(this.accounts.filter((a) => a.subtype === 'credit_card'));
    },
    jeDiff() {
      let d = 0;
      for (const l of this.je.lines) d += (cents(l.debit) ?? 0) - (cents(l.credit) ?? 0);
      return d;
    },
    reportCheck() { return (this.report.data?.check ?? 0) || (this.report.data?.comparison?.check ?? 0); },
    helpList() { return searchHelp(this.help.q); },
    helpArticle() { return HELP.find((h) => h.id === this.help.id) ?? HELP[0]; },
    reportIsRange() { return Boolean(this.reportTypes.find((x) => x.id === this.report.type)?.range); },
    reportIsYearly() { return Boolean(this.reportTypes.find((x) => x.id === this.report.type)?.yearly); },
    reportTies() { return ['balance-sheet', 'income-statement', 'cash-flow', 'trial-balance'].includes(this.report.type); },
    reportQuery() {
      const r = this.report;
      if (this.reportIsYearly) return `year=${r.year}`;
      const base = this.reportIsRange ? `from=${r.from}&to=${r.to}` : `asOf=${r.to}`;
      return ['balance-sheet', 'income-statement'].includes(r.type) && r.compare !== 'none' ? `${base}&compare=${r.compare}` : base;
    },
    cmpCols() { return this.report.data?.comparison ? 5 : 2; },
    cmpHeads() {
      const d = this.report.data;
      const c = d.comparison;
      return [d.asOf ?? `${d.from} to ${d.to}`, c.asOf ?? `${c.from} to ${c.to}`, 'Change', 'Change %'];
    },
  },
  watch: {
    companyId() { this.loadCompany(); },
    tab(t) {
      if (t === 'reports') this.loadReport();
      if (t === 'journal') { this.loadEntries(); this.loadRecurring(); }
      if ((t === 'payroll' || t === 'settings') && this.has('payroll') && (this.can('view_books') || this.can('payroll'))) this.loadEmployees();
      if (t === 'payroll' && this.can('payroll')) this.loadMembers();
      if (t === 'settings') { this.editProfile(); this.mine = { name: this.auth.user?.name ?? '', current: '', next: '', code: '' }; if (this.passkeys.supported) this.loadPasskeys(); this.editFutaCr(); this.editLetterhead(); if (this.can('admin')) { this.loadItems(true); this.loadLateSettings(); } this.loadAccess(); if (this.can('view_books') || this.can('admin')) this.loadMembers(); if (this.can('view_books')) this.loadBooksCheck(); }
      if (t === 'home') this.loadDash();
      if (t === 'setup') this.loadSetup();
      if (t === 'bank') this.loadBank();
      if (t === 'trips') this.loadTrips();
      if (t === 'bills' && ['plans', 'late'].includes(this.ar.panel)) this.ar.panel = 'docs'; // payment plans and late charges are for invoices
      if (t === 'sales' || t === 'bills') { Object.assign(this.ar, { view: 'open', detail: null, aging: null, docs: [], payments: [], contacts: [], planStatement: null }); this.ar.showDoc = this.ar.showPay = this.ar.showContact = false; this.loadAr(); }
      if (t === 'accounts') this.loadImports();
      if (t === 'time') this.loadTime(true);
    },
    'quick.kind'() {
      this.quick.other = '';
      if (!this.quickBanks.some((a) => a.id === this.quick.bank)) this.quick.bank = this.bankAccounts[0]?.id ?? '';
    },
  },
  async mounted() {
    applyZoom(this.zoom);
    document.addEventListener('fullscreenchange', () => { this.fullscreen = !!document.fullscreenElement; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.statusMenu = false; });
    startRecorder();
    onSignInNeeded = (next) => this.goAuth(next ?? 'signin');
    try {
      const me = await api('GET', '/auth/me');
      this.auth.user = me.user;
      this.version = me.version ?? '';
      if (me.next) return this.goAuth(me.next);
      await this.enterApp();
    } catch { this.goAuth(location.hash === '#signup' ? 'signup' : 'signin'); }
  },
  methods: {
    money,
    blankLine,
    usDate(d) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : (d ?? ''); },
    can(perm) { return Boolean(this.company?.permissions?.includes(perm)); },
    /** Features come from the company's plan (the server refuses the rest). */
    has(feature) { return Boolean(this.company?.features?.includes(feature)); },
    canTab(id) {
      const need = TAB_PERMS[id];
      if (TAB_FEATURE[id] && !this.has(TAB_FEATURE[id])) return false;
      return !need || need.some((p) => this.can(p));
    },
    async goAuth(screen) {
      this.auth.screen = screen; this.auth.code = '';
      if (screen === 'mfa_setup' && !this.auth.setup) {
        try { this.auth.setup = await api('POST', '/auth/mfa/setup', {}); } catch (e) { this.flash(e.message, 'bad'); }
      }
    },
    async enterApp() {
      this.auth.screen = null;
      this.companies = await api('GET', '/companies');
      this.companyId = this.companies[0]?.id ?? null;
      if (!this.companyId) this.company = null;
    },
    async signIn() {
      const a = this.auth;
      const r = await this.run(() => api('POST', '/auth/login', { email: a.email, password: a.password }));
      if (!r) return;
      a.password = ''; a.user = r.user; this.version = r.version ?? '';
      this.goAuth(r.next);
    },
    async signUp() {
      const a = this.auth;
      const r = await this.run(() => api('POST', '/auth/signup', { email: a.email, password: a.password, name: a.name }));
      if (!r) return;
      a.password = ''; a.user = r.user; this.version = r.version ?? '';
      this.goAuth(r.next);
    },
    async enableMfa() {
      const r = await this.run(() => api('POST', '/auth/mfa/enable', { code: this.auth.code }));
      if (r) { this.auth.recoveryCodes = r.recoveryCodes; this.auth.screen = 'recovery_codes'; }
    },
    async verifyMfa() {
      const a = this.auth;
      const body = a.useRecovery ? { recoveryCode: a.code } : { code: a.code };
      if (await this.run(() => api('POST', '/auth/mfa/verify', body))) await this.enterApp();
    },
    /** Sign in with Face ID / Touch ID / Windows Hello: the device signs the server's challenge; no password typed. */
    async signInPasskey() {
      const o = await this.run(() => api('POST', '/auth/passkey/options', {}));
      if (!o) return;
      let cred;
      try {
        cred = await navigator.credentials.get({ publicKey: { challenge: toBytes(o.challenge), rpId: o.rpId, userVerification: 'required', timeout: o.timeout } });
      } catch (e) { this.flash(passkeyProblem(e), 'bad'); return; }
      const r = cred.response;
      const credential = { id: cred.id, rawId: toB64url(cred.rawId), type: cred.type, response: {
        clientDataJSON: toB64url(r.clientDataJSON), authenticatorData: toB64url(r.authenticatorData), signature: toB64url(r.signature),
        userHandle: r.userHandle ? toB64url(r.userHandle) : null } };
      const res = await this.run(() => api('POST', '/auth/passkey/login', { credential }));
      if (!res) return;
      this.auth.user = res.user; this.version = res.version ?? '';
      await this.enterApp();
    },
    async saveMyName() {
      const u = await this.run(() => api('PATCH', '/auth/me', { name: this.mine.name }), 'Name saved.');
      if (u) this.auth.user = { ...this.auth.user, name: u.name };
    },
    async changePassword() {
      const m = this.mine;
      const r = await this.run(() => api('POST', '/auth/password', { currentPassword: m.current, newPassword: m.next, code: m.code }));
      if (r) this.flash(`Password changed.${r.otherSessionsEnded ? ` ${r.otherSessionsEnded} other sign-in${r.otherSessionsEnded === 1 ? ' was' : 's were'} ended.` : ''}`);
      this.mine = { ...m, current: '', next: '', code: '' };
    },
    async loadPasskeys() {
      this.passkeys.list = (await this.run(() => api('GET', '/auth/passkeys'))) ?? [];
      if (!this.passkeys.name) this.passkeys.name = `${this.auth.user?.name?.split(' ')[0] ?? 'My'}'s ${deviceName()}`.slice(0, 60);
    },
    async addPasskey() {
      const p = this.passkeys;
      p.busy = true;
      try {
        const o = await this.run(() => api('POST', '/auth/passkeys/options', { mfaCode: p.code }));
        if (!o) return;
        p.code = '';
        let cred;
        try {
          cred = await navigator.credentials.create({ publicKey: {
            challenge: toBytes(o.challenge), rp: o.rp, user: { id: toBytes(o.user.id), name: o.user.name, displayName: o.user.displayName },
            pubKeyCredParams: o.algorithms.map((alg) => ({ type: 'public-key', alg })), timeout: o.timeout, attestation: 'none',
            authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
            excludeCredentials: o.excludeCredentials.map((k) => ({ type: 'public-key', id: toBytes(k.id), transports: k.transports })),
          } });
        } catch (e) { this.flash(passkeyProblem(e), 'bad'); return; }
        const r = cred.response;
        const credential = { id: cred.id, rawId: toB64url(cred.rawId), type: cred.type, response: {
          clientDataJSON: toB64url(r.clientDataJSON), attestationObject: toB64url(r.attestationObject),
          transports: typeof r.getTransports === 'function' ? r.getTransports() : [] } };
        if (await this.run(() => api('POST', '/auth/passkeys', { credential, name: p.name }), 'Passkey added. Next time, choose "Sign in with Face ID or a passkey".')) {
          p.name = ''; await this.loadPasskeys();
        }
      } finally { p.busy = false; }
    },
    async renamePasskey(k) {
      const name = prompt('New name for this passkey', k.name);
      if (name == null || !name.trim() || name.trim() === k.name) return;
      if (await this.run(() => api('PUT', `/auth/passkeys/${k.id}`, { name }), 'Passkey renamed.')) this.loadPasskeys();
    },
    async removePasskey(k) {
      if (!confirm(`Remove the passkey "${k.name}"? That device will need your password and code again.`)) return;
      if (await this.run(() => api('DELETE', `/auth/passkeys/${k.id}`), 'Passkey removed.')) await this.loadPasskeys();
    },
    async signOut() {
      await api('POST', '/auth/logout', {}).catch(() => {});
      Object.assign(this, { companies: [], companyId: null, company: null, tab: 'home' });
      this.auth = { ...this.auth, user: null, setup: null, recoveryCodes: null, screen: 'signin' };
    },
    hrs, blankTime,
    async loadMembers() { this.members = (await this.run(() => api('GET', `/companies/${this.companyId}/members`))) ?? []; },
    async addMember() {
      const m = await this.run(() => api('POST', `/companies/${this.companyId}/members`, { ...this.newMember, departmentId: this.newMember.departmentId || null }), 'Member saved.');
      if (m) { this.newMember = { email: '', role: 'bookkeeper', departmentId: '' }; this.loadMembers(); this.loadAccess(); }
    },
    editMember(m) { this.newMember = { email: m.email, role: m.role === 'custom' ? m.roleId : m.role, departmentId: m.departmentId ?? '' }; },
    async loadAccess() {
      this.roles = (await this.run(() => api('GET', `/companies/${this.companyId}/roles`))) ?? this.roles;
      this.departments = (await this.run(() => api('GET', `/companies/${this.companyId}/departments`))) ?? [];
    },
    newRole() { this.roleEdit = { id: null, name: '', permissions: [] }; },
    editRole(r) { this.roleEdit = { id: r.id, name: r.name, permissions: [...r.permissions] }; },
    async saveRole() {
      const r = this.roleEdit;
      const body = { name: r.name, permissions: r.permissions };
      const ok = await this.run(() => (r.id ? api('PATCH', `/companies/${this.companyId}/roles/${r.id}`, body) : api('POST', `/companies/${this.companyId}/roles`, body)), 'Role saved.');
      if (ok) { this.roleEdit = null; this.loadAccess(); this.loadMembers(); }
    },
    async deleteRole(r) {
      if (!confirm(`Delete the role "${r.name}"?`)) return;
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/roles/${r.id}`), 'Role deleted.')) this.loadAccess();
    },
    async addDept() {
      if (await this.run(() => api('POST', `/companies/${this.companyId}/departments`, { name: this.newDept }), 'Department added.')) { this.newDept = ''; this.loadAccess(); }
    },
    async renameDept(d) {
      const name = prompt('New name for this department', d.name);
      if (name == null || !name.trim() || name.trim() === d.name) return;
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/departments/${d.id}`, { name }), 'Department renamed.')) this.loadAccess();
    },
    async deleteDept(d) {
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/departments/${d.id}`), 'Department deleted.')) this.loadAccess();
    },
    async removeMember(m) {
      if (!confirm(`Remove ${m.name} from ${this.company.name}?`)) return;
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/members/${m.id}`), 'Removed.')) this.loadMembers();
    },
    /** Print just the card the button is in (or the section's report), so "Save as PDF" makes a clean document. */
    printPage(e) {
      const btn = e?.target;
      const target = btn?.closest?.('.card') ?? btn?.closest?.('section')?.querySelector('.print-me');
      if (target) { target.classList.add('printing'); document.body.classList.add('print-focus'); }
      const done = () => {
        target?.classList.remove('printing');
        document.body.classList.remove('print-focus');
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      window.print();
    },
    /** Beta feedback: open the dialog (the picture is taken only if the tester asks for one). */
    openFeedback() { Object.assign(this.fb, { open: true, error: '' }); },
    closeFeedback() { this.fb.open = false; },
    async takePicture() {
      const f = this.fb;
      f.busy = true; f.error = '';
      try { f.picture = await pictureOfScreen(); f.pictureSource = 'screen'; } catch (e) { f.error = `The screen picture didn't work (${e.message}). You can attach a photo instead.`; }
      f.busy = false;
    },
    async choosePhoto(e) {
      const f = this.fb;
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      f.busy = true; f.error = '';
      try { f.picture = await pictureFromFile(file); f.pictureSource = 'photo'; } catch (err) { f.error = err.message; }
      f.busy = false;
    },
    removePicture() { this.fb.picture = null; this.fb.pictureSource = null; },
    async sendFeedback() {
      const f = this.fb;
      if (!f.note.trim()) { f.error = 'Say in a few words what went wrong.'; return; }
      f.busy = true; f.error = '';
      const tabLabel = this.tab === 'help' ? 'Help' : this.tab === 'developer' ? 'Developer' : (this.tabs.find((t) => t.id === this.tab)?.label ?? this.tab);
      const panel = this.tab === 'reports' ? this.reportTypes.find((r) => r.id === this.report.type)?.label
        : ['sales', 'bills'].includes(this.tab) ? { docs: this.S.docs, contacts: this.S.Whos, payments: 'Payments', aging: 'Aging report' }[this.ar.panel]
          : this.tab === 'bank' ? this.bank.view : '';
      try {
        const r = await api('POST', '/feedback', {
          note: f.note, companyId: this.company ? this.companyId : null, picture: f.picture, pictureSource: f.pictureSource,
          context: captureContext({ tab: this.company ? tabLabel : 'Welcome (no company yet)', panel: panel ?? '', role: this.company?.roleName ?? '' }),
        });
        Object.assign(f, { open: false, note: '', picture: null, pictureSource: null });
        this.flash(`Report ${r.number} sent. Thank you!`);
      } catch (e) { f.error = e.message; }
      f.busy = false;
    },
    /** Admin dashboard: plans for every company (platform admins and developers; the server checks too). */
    openAdmin() {
      if (this.tab === 'admin') { this.tab = this.adm.from; return; }
      this.adm.from = ['help', 'developer'].includes(this.tab) ? this.dev.from : this.tab;
      this.tab = 'admin';
      this.loadAdmin();
    },
    async loadAdmin() {
      this.adm.data = await this.run(() => api('GET', '/admin/companies'));
      this.adm.changes = (await this.run(() => api('GET', '/admin/plan-changes'))) ?? [];
    },
    editPlan(c) { this.adm.edit = { id: c.id, name: c.name, plan: c.plan, addOns: [...c.addOns], reason: '' }; },
    async savePlan() {
      const e = this.adm.edit;
      const ok = await this.run(() => api('PUT', `/admin/companies/${e.id}/plan`, { plan: e.plan, addOns: e.addOns, reason: e.reason }), `${e.name}: plan saved.`);
      if (!ok) return;
      this.adm.edit = null;
      await this.loadAdmin();
      if (e.id === this.companyId) this.loadCompany(); // your own company: switch tabs on or off now
    },
    planPrice(p) {
      const one = (c, per) => (c == null ? `${per} price not set` : c === 0 ? 'free' : `${money(c)}/${per}`);
      return p.monthlyCents === 0 ? 'free' : `${one(p.monthlyCents, 'month')}, ${one(p.annualCents, 'year')}`;
    },
    /** Developer dashboard (platform developers only; the server checks too). */
    openDeveloper() {
      if (this.tab === 'developer') { this.tab = this.dev.from; return; }
      this.dev.from = this.tab === 'help' ? this.help.from : this.tab;
      this.tab = 'developer';
      this.loadDev();
    },
    async loadDev() {
      this.dev.summary = await this.run(() => api('GET', '/developer/summary'));
      await this.loadDevReports();
    },
    async loadDevReports() {
      this.dev.list = await this.run(() => api('GET', `/developer/reports${this.dev.status ? `?status=${this.dev.status}` : ''}`));
    },
    async openDevReport(id) {
      const r = await this.run(() => api('GET', `/developer/reports/${id}`));
      if (!r) return;
      Object.assign(this.dev, { report: r, text: r.claudeDraft, note: r.developerNote, copied: false });
    },
    async saveDevReport(change, done = 'Saved.') {
      const d = this.dev;
      const ok = await this.run(() => api('PATCH', `/developer/reports/${d.report.id}`, change), done);
      if (ok) { await this.openDevReport(d.report.id); this.loadDevReports(); }
      return ok;
    },
    async copyForClaude() {
      const d = this.dev;
      try { await navigator.clipboard.writeText(d.text); } catch { this.flash('The browser would not copy. Select the text and copy it yourself.', 'bad'); return; }
      await this.saveDevReport({ claudeText: d.text, status: 'sent_to_claude' }, 'Copied. Paste it into your Claude project chat (and attach the picture if it helps).');
      d.copied = true;
    },
    resetClaudeText() { this.saveDevReport({ claudeText: null }, 'Back to the automatic write-up.'); },
    /** The "?" button: open the guide for the screen you're on. */
    openHelp() {
      if (this.tab === 'help') { this.tab = this.help.from; return; }
      this.help.from = this.tab;
      this.help.id = helpForTab(this.tab);
      this.help.q = '';
      this.tab = 'help';
    },
    /** Links inside a guide (<a data-help="id">) open another guide. */
    helpClick(e) {
      const id = e.target.closest?.('a[data-help]')?.dataset.help;
      if (id) { e.preventDefault(); this.help.id = id; }
    },
    async downloadCsv(path) { await this.run(() => download(path)); },
    downloadReport() { this.downloadCsv(`/companies/${this.companyId}/reports/${this.report.type}?${this.reportQuery}&format=csv`); },
    pctText(p) { return p == null ? '—' : `${p.startsWith('-') ? '' : '+'}${p}%`; },
    /** Amount cells for one statement line: this period, or this period / earlier / change / change %. */
    lineCells(l, sign = 1) {
      const c = [money(sign * l.amountCents)];
      if (this.report.data.comparison) c.push(money(sign * l.priorCents), money(sign * l.changeCents), this.pctText(l.changePct));
      return c;
    },
    secCells(sec) {
      const c = [money(sec.totalCents)];
      if (this.report.data.comparison) c.push(money(sec.totalPriorCents), money(sec.totalChangeCents), this.pctText(sec.totalChangePct));
      return c;
    },
    totCells(key) {
      const d = this.report.data;
      const c = [money(d[key])];
      if (d.comparison) { const t = d.comparison.totals[key]; c.push(money(t.priorCents), money(t.changeCents), this.pctText(t.changePct)); }
      return c;
    },
    flash(text, kind = 'ok') { this.message = { text, kind }; if (kind === 'ok') setTimeout(() => { if (this.message?.text === text) this.message = null; }, 4000); },
    async run(fn, success) {
      try { const r = await fn(); if (success) this.flash(success); return r; } catch (e) { this.flash(e.message, 'bad'); return undefined; }
    },
    async loadCompany() {
      if (!this.companyId) { this.company = null; return; }
      this.company = await api('GET', `/companies/${this.companyId}`);
      this.accounts = await api('GET', `/companies/${this.companyId}/accounts`);
      this.quick.bank = this.bankAccounts[0]?.id ?? '';
      this.register = null; this.pc.employee = null;
      if (this.tab === 'new-company' || !this.canTab(this.tab)) this.tab = this.tabs.find((t) => this.canTab(t.id))?.id ?? 'settings';
      this.tab === 'home' ? this.loadDash() : this.$options.watch.tab.call(this, this.tab);
    },
    async loadDash() {
      if (!this.companyId) return;
      this.dash = await this.run(() => api('GET', `/companies/${this.companyId}/reports/dashboard?asOf=${today()}`));
      const saved = await api('GET', `/companies/${this.companyId}/home-layout`).catch(() => null);
      this.home.layout = saved?.layout ?? structuredClone(DEFAULT_HOME);
      this.home.view = 'cards';
      if (this.homeCards('left').concat(this.homeCards('right')).some((c) => c.id === 'stats')) this.loadStats();
      if (this.homeCards('left').concat(this.homeCards('right')).some((c) => c.id === 'plans')) this.loadHomePlans();
      if (this.can('admin')) this.setup.status = await api('GET', `/companies/${this.companyId}/setup`).catch(() => null);
    },
    // ---------------------------------------------------------------- Home cards and Statistics
    homeCardOk(c) { return c && c.perms.some((p) => this.can(p)) && (!c.feature || this.has(c.feature)); },
    /** The cards in one column (left: under Record a transaction; right: beside it) this person can use. */
    homeCards(side) { return (this.home.layout?.[side] ?? []).map((id) => HOME_CARDS.find((c) => c.id === id)).filter((c) => this.homeCardOk(c)); },
    homeUnused() {
      const used = new Set([...(this.home.layout?.left ?? []), ...(this.home.layout?.right ?? [])]);
      return HOME_CARDS.filter((c) => !used.has(c.id) && this.homeCardOk(c));
    },
    async saveHome() {
      await this.run(() => api('PUT', `/companies/${this.companyId}/home-layout`, this.home.layout));
    },
    /** Move a card: dir -1 up/left in its list, +1 down/right; 'other' to the other column. */
    moveHomeCard(side, id, dir) {
      const L = this.home.layout;
      const list = L[side];
      const i = list.indexOf(id);
      if (i < 0) return;
      if (dir === 'other') { list.splice(i, 1); L[side === 'left' ? 'right' : 'left'].push(id); }
      else {
        const j = i + dir;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
      }
      this.saveHome();
    },
    removeHomeCard(side, id) { this.home.layout[side] = this.home.layout[side].filter((x) => x !== id); this.saveHome(); },
    addHomeCard() {
      const id = this.home.adding;
      if (!id) return;
      this.home.layout.right.push(id); this.home.adding = '';
      if (id === 'stats') this.loadStats();
      if (id === 'plans') this.loadHomePlans();
      this.saveHome();
    },
    resetHome() { this.home.layout = structuredClone(DEFAULT_HOME); this.loadStats(); this.saveHome(); },
    // Drag and drop on a desk computer (the arrows do the same on a phone).
    homeDragStart(ev, side, id) { ev.dataTransfer.setData('text/plain', JSON.stringify({ side, id })); ev.dataTransfer.effectAllowed = 'move'; },
    homeDrop(ev, side, beforeId = null) {
      let from;
      try { from = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
      const L = this.home.layout;
      if (!from?.id || !L[from.side]?.includes(from.id) || from.id === beforeId) return;
      L[from.side] = L[from.side].filter((x) => x !== from.id);
      const at = beforeId ? L[side].indexOf(beforeId) : -1;
      if (at < 0) L[side].push(from.id); else L[side].splice(at, 0, from.id);
      this.saveHome();
    },
    async pressHomeCard(c) {
      if (this.home.editing) return;
      if (c.id === 'stats') { this.home.view = 'stats'; if (!this.home.stats) await this.loadStats(); return; }
      const g = c.go;
      if (g.before && (await this[g.before]()) === false) return;
      if (g.report) { this.report.type = g.report; this.report.data = null; }
      this.tab = g.tab;
      await this.$nextTick();
      if (g.then) await this[g.then]();
    },
    openJE() { this.showJE = true; },
    /** Status bar ⤢: the whole browser window becomes the app (Esc, or the button again, leaves). */
    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { this.flash("This browser won't go full screen here.", 'bad'); }
    },
    savePrefs() { keepPrefs(this.prefs); },
    /** Status bar zoom: whole steps of 10%, between ZOOM_MIN and ZOOM_MAX. */
    setZoom(z) {
      this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / 10) * 10));
      applyZoom(this.zoom);
      keepZoom(this.zoom);
    },
    cardAccounts() { return this.accounts.filter((a) => a.isActive && a.subtype === 'credit_card'); },
    /** Credit cards card: open Banking on the first card (cards import statements and reconcile like a bank). */
    pickCard() {
      const card = this.cardAccounts()[0];
      if (!card) { this.flash('Add your credit card on the Accounts page first (type Liability, kind Credit card).', 'bad'); this.tab = 'accounts'; return false; }
      this.bank.accountId = card.id;
      return true;
    },
    /** Pay the credit card: Record a transaction as a Transfer from the bank to the card. */
    payCard() {
      const card = this.cardAccounts()[0];
      if (!card) { this.flash('Add your credit card on the Accounts page first (type Liability, kind Credit card).', 'bad'); this.tab = 'accounts'; return; }
      this.quick.kind = 'transfer';
      this.$nextTick(() => {
        this.quick.other = card.id;
        if (!this.quick.memo) this.quick.memo = `Payment to ${card.name}`;
        document.querySelector('.record-card input[inputmode="decimal"]')?.focus();
      });
    },
    openMileIq() { this.$nextTick(() => { const d = document.querySelector('details.mileiq'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth' }); } }); },
    scrollToBackup() { this.$nextTick(() => document.querySelector('.backup-card')?.scrollIntoView({ behavior: 'smooth' })); },
    // The Payment plans card: open invoices on a plan, the next payment first.
    async loadHomePlans() {
      const open = (await this.run(() => api('GET', `/companies/${this.companyId}/invoices?status=open`))) ?? [];
      this.home.plans = open.filter((d) => d.plan?.next).sort((a, b) => a.plan.next.dueDate.localeCompare(b.plan.next.dueDate));
    },
    async loadStats() { this.home.stats = await this.run(() => api('GET', `/companies/${this.companyId}/reports/statistics?asOf=${today()}`)); },
    /** "2026-10" → "Oct" (or "Oct 2026" with year). */
    monthLabel(ym, year = false) {
      const d = new Date(`${ym}-15T12:00:00`);
      return d.toLocaleString('en-US', year ? { month: 'short', year: 'numeric' } : { month: 'short' });
    },
    /** Bar height in percent of the tallest value in the list (0 stays 0; anything above 0 shows at least a sliver). */
    barPct(v, list) {
      const max = Math.max(1, ...list.map((x) => Math.abs(x)));
      return v ? Math.max(2, Math.round((Math.abs(v) / max) * 100)) : 0;
    },
    // ---------------------------------------------------------------- New-company setup wizard
    async loadSetup() {
      const s = this.setup;
      s.status = await this.run(() => api('GET', `/companies/${this.companyId}/setup`));
      s.entityType = s.status?.entityType ?? ''; s.booksStartDate = s.status?.booksStartDate ?? '';
      s.balances = {};
    },
    setupGo(step) { this.setup.step = step; this.tab = 'setup'; },
    async saveBasics() {
      const s = this.setup;
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/setup`, { entityType: s.entityType, booksStartDate: s.booksStartDate }), 'Saved.')) { await this.loadSetup(); s.step = 2; }
    },
    /** Open the importer on the Accounts tab; it shows a "Back to setup" link. */
    setupImport(kind) {
      this.setup.fromImport = true; this.imp.kind = kind; this.imp.show = true; this.tab = 'accounts';
      if (kind === 'opening' && !this.imp.asOf) this.imp.asOf = this.openingDate();
    },
    backToSetup() { this.setup.fromImport = false; this.setupGo(3); },
    /** The next free account code in a block (bank 1010-1099, credit card 2100-2199). */
    nextCode(from, to) {
      const used = new Set(this.accounts.map((a) => a.code));
      for (let n = from; n <= to; n += 10) if (!used.has(String(n))) return String(n);
      for (let n = from; n <= to; n++) if (!used.has(String(n))) return String(n);
      return null;
    },
    async addMoneyAccount() {
      const n = this.setup.newAcct;
      const card = n.kind === 'card';
      const code = card ? this.nextCode(2100, 2199) : this.nextCode(1010, 1099);
      const body = { code, name: n.name, type: card ? 'liability' : 'asset', subtype: card ? 'credit_card' : 'bank' };
      if (await this.run(() => api('POST', `/companies/${this.companyId}/accounts`, body), `${n.name} added.`)) {
        this.setup.newAcct = { name: '', kind: n.kind };
        this.accounts = await api('GET', `/companies/${this.companyId}/accounts`);
      }
    },
    moneyAccounts() { return this.accounts.filter((a) => a.isActive && ['bank', 'cash', 'credit_card'].includes(a.subtype)); },
    /** The day before the books start: opening balances are "as of" then. */
    openingDate() {
      const d = this.setup.booksStartDate || this.setup.status?.booksStartDate;
      if (!d) return today();
      const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - 1); return t.toISOString().slice(0, 10);
    },
    /** Starting fresh: each balance becomes one entry against Owner's Capital (a card balance is money owed). */
    async saveBalances() {
      const s = this.setup;
      const capital = this.accounts.find((a) => a.code === '3000') ?? this.accounts.find((a) => a.type === 'equity' && a.subtype === 'capital');
      if (!capital) { this.flash("No Owner's Capital account to balance against.", 'bad'); return; }
      const date = this.openingDate();
      s.busy = true;
      try {
        for (const a of this.moneyAccounts()) {
          const amount = String(s.balances[a.id] ?? '').trim();
          if (!amount || cents(amount) === 0) continue;
          const card = a.subtype === 'credit_card';
          const body = { date, memo: `Opening balance, ${a.name}`, amount,
            fromAccountId: card ? a.id : capital.id, toAccountId: card ? capital.id : a.id };
          if (!(await this.run(() => api('POST', `/companies/${this.companyId}/entries/simple`, body, { 'Idempotency-Key': `opening-${a.id}` })))) return;
        }
        this.flash('Opening balances saved.'); s.balances = {}; await this.loadSetup(); s.step = 4;
      } finally { s.busy = false; }
    },
    async finishSetup(done = true) {
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/setup`, { setupDone: done }), done ? 'Setup finished.' : undefined)) {
        this.setup.status = { ...this.setup.status, setupDone: done }; this.tab = 'home';
      }
    },
    async loadEntries(more = false) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(this.search)) if (v) p.set(k, v);
      p.set('limit', '100');
      if (more) p.set('offset', String(this.entries.length));
      const r = await this.run(() => api('GET', `/companies/${this.companyId}/entries?${p}`));
      if (!r) return;
      this.entries = more ? this.entries.concat(r.entries) : r.entries;
      this.entriesTotal = r.total;
    },
    clearSearch() { this.search = blankSearch(); this.loadEntries(); },
    async loadRecurring() { this.recurring = (await this.run(() => api('GET', `/companies/${this.companyId}/recurring`))) ?? []; },
    async postDueRecurring() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/recurring/post-due`, {}));
      if (!r) return;
      const msg = r.posted.length ? `Posted ${r.posted.length} recurring ${r.posted.length === 1 ? 'entry' : 'entries'}.` : 'Nothing is due.';
      this.flash(r.problems.length ? `${msg} ${r.problems.length} could not be posted — see the list.` : msg, r.problems.length ? 'bad' : 'ok');
      this.loadRecurring(); this.loadEntries();
    },
    /** Open a recurring entry in the journal-entry form to change its amount, accounts, memo, name or end date. */
    editRecurring(r) {
      const d = (c) => (c ? (c / 100).toFixed(2) : '');
      this.je = { date: r.nextDate ?? r.startDate, memo: r.memo ?? '', key: newKey(), editId: r.id,
        repeat: { on: true, name: r.name, frequency: r.frequency, endDate: r.endDate ?? '' },
        lines: r.lines.map((l) => ({ accountId: l.accountId, debit: d(l.debitCents), credit: d(l.creditCents) })) };
      this.showJE = true;
      this.$nextTick(() => document.querySelector('.je-card')?.scrollIntoView({ behavior: 'smooth' }));
    },
    async restartRecurring(r) {
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/recurring/${r.id}`, { restart: true }), 'Restarted.')) this.loadRecurring();
    },
    async stopRecurring(r) {
      if (!confirm(`Stop "${r.name}"? Entries already posted stay on the books.`)) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/recurring/${r.id}/stop`, {}), 'Stopped.')) this.loadRecurring();
    },
    async loadBooksCheck() { this.booksCheck = await this.run(() => api('GET', `/companies/${this.companyId}/books-check`)); },
    async runBooksCheck() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/books-check`, {}));
      if (r) { this.flash(r.ok ? 'Books check passed.' : 'Books check found problems.', r.ok ? 'ok' : 'bad'); this.loadBooksCheck(); }
    },
    async loadEmployees() {
      this.employees = (await this.run(() => api('GET', `/companies/${this.companyId}/employees`))) ?? [];
      this.paychecks = (await this.run(() => api('GET', `/companies/${this.companyId}/paychecks`))) ?? [];
      if (this.can('payroll')) this.runs = (await this.run(() => api('GET', `/companies/${this.companyId}/payroll-runs`))) ?? [];
    },
    // ---------------------------------------------------------------- Payroll runs
    startRun() {
      const r = this.prun;
      Object.assign(r, { show: true, preview: null, key: newKey(), paidFrom: r.paidFrom || this.bankAccounts[0]?.id || '' });
      this.pc.employee = null;
      this.runRows();
    },
    runRows() {
      const r = this.prun;
      r.preview = null;
      r.fromTimesheets = false; r.hoursNotes = [];
      r.rows = this.employees.filter((e) => e.active && e.payFrequency === r.payFrequency).map((e) => ({ emp: e, include: true, hours: '', overtimeHours: '', doubleTimeHours: '', k401: '' }));
    },
    runBody() {
      const r = this.prun;
      return { payFrequency: r.payFrequency, periodStart: r.periodStart, periodEnd: r.periodEnd, payDate: r.payDate, paidFromAccountId: r.paidFrom || undefined,
        items: r.rows.filter((x) => x.include).map((x) => {
          const k = cents(x.k401);
          return { employeeId: x.emp.id, hours: x.hours || undefined, overtimeHours: x.overtimeHours || undefined, doubleTimeHours: x.doubleTimeHours || undefined,
            preTaxDeductions: k ? [{ name: '401(k)', amountCents: k, kind: 'retirement_401k' }] : [] };
        }), fromTimesheets: r.fromTimesheets };
    },
    /** Fill hourly employees' hours from approved, unpaid timesheets for the period. */
    async fillFromTimesheets() {
      const r = this.prun;
      const q = new URLSearchParams({ payFrequency: r.payFrequency, periodStart: r.periodStart, periodEnd: r.periodEnd });
      const h = await this.run(() => api('GET', `/companies/${this.companyId}/payroll-hours?${q}`));
      if (!h) return;
      const notes = [];
      for (const x of r.rows) {
        const e = h.employees.find((y) => y.employeeId === x.emp.id);
        if (!e) continue;
        if (x.emp.payType === 'hourly' && e.linked) {
          x.hours = e.hours; x.overtimeHours = e.overtimeHours === '0.00' ? '' : e.overtimeHours; x.doubleTimeHours = e.doubleTimeHours === '0.00' ? '' : e.doubleTimeHours;
        }
        for (const w of e.warnings) notes.push(`${e.name}: ${w}`);
      }
      r.fromTimesheets = true; r.hoursNotes = notes; r.preview = null;
      this.flash('Hours filled in from approved timesheets. Check them, then Calculate.');
    },
    async linkEmployee(e, userId) {
      if (await this.run(() => api('PATCH', `/companies/${this.companyId}/employees/${e.id}/user`, { userId: userId || null }), 'Saved.')) this.loadEmployees();
      else this.loadEmployees();
    },
    async voidRun(r) {
      const reason = prompt(`Void the whole ${r.payFrequency} payroll paid ${this.usDate(r.payDate)} (${r.paycheckCount} paycheck${r.paycheckCount === 1 ? '' : 's'})? Every paycheck in it is voided and you can run the period again. Why?`);
      if (!reason) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/payroll-runs/${r.id}/void`, { reason }), 'Payroll run voided. Run the period again with the right numbers.')) this.loadEmployees();
    },
    async previewRun() { this.prun.preview = await this.run(() => api('POST', `/companies/${this.companyId}/payroll-runs/preview`, this.runBody())); },
    async postRun() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/payroll-runs`, this.runBody(), { 'Idempotency-Key': this.prun.key }),
        'Payroll recorded in your books.');
      if (r?.timeEntriesPaid) this.flash(`Payroll recorded in your books. ${r.timeEntriesPaid} timesheet entr${r.timeEntriesPaid === 1 ? 'y is' : 'ies are'} now marked paid.`);
      if (r) { this.prun.show = false; this.prun.preview = null; this.loadEmployees(); }
    },
    async openStub(p) { this.stub = await this.run(() => api('GET', `/companies/${this.companyId}/paychecks/${p.id}/stub`)); },
    startDeposit(a) { Object.assign(this.dep, { agency: a.agency, form: a.form, date: today(), paidFrom: this.dep.paidFrom || this.bankAccounts[0]?.id || '', reference: '', key: newKey() }); },
    async saveDeposit() {
      const d = this.dep;
      const body = { agency: d.agency, form: d.form, periodStart: this.liab.from, periodEnd: this.liab.to, depositDate: d.date, paidFromAccountId: d.paidFrom, reference: d.reference };
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/payroll-deposits`, body, { 'Idempotency-Key': d.key }));
      if (r) { this.flash(`Deposit of ${money(r.amountCents)} recorded (entry #${r.entryNumber ?? ''}).`); d.agency = null; this.loadLiab(); }
    },
    async voidDeposit(dp) {
      if (!confirm(`Void the ${money(dp.amountCents)} deposit of ${dp.depositDate}? Use this only if it was recorded by mistake.`)) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/payroll-deposits/${dp.id}/void`, {}), 'Deposit voided.')) this.loadLiab();
    },
    async loadLiab() { this.liab.data = await this.run(() => api('GET', `/companies/${this.companyId}/reports/payroll-liabilities?from=${this.liab.from}&to=${this.liab.to}`)); },
    // ---------------------------------------------------------------- Time
    canManageTime() { return this.can('time_approve') || this.can('time_all'); },
    weekDays() { return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(this.time.week, i)); },
    async loadTime(first = false) {
      const t = this.time;
      const base = `/companies/${this.companyId}`;
      if (first) {
        t.jobs = (await this.run(() => api('GET', `${base}/jobs`))) ?? [];
        if (this.canManageTime()) await this.loadMembers();
        if (this.can('invoices') || this.can('view_books')) t.customers = (await this.run(() => api('GET', `${base}/customers`))) ?? [];
      }
      const q = new URLSearchParams({ from: t.week, to: addDays(t.week, 6), userId: t.userId || this.auth.user.id });
      t.entries = (await this.run(() => api('GET', `${base}/time-entries?${q}`))) ?? [];
      t.summary = await this.run(() => api('GET', `${base}/reports/time-summary?from=${t.week}&to=${addDays(t.week, 6)}`));
      if (this.canManageTime()) { t.pending = (await this.run(() => api('GET', `${base}/time-entries?status=submitted`))) ?? []; t.picked = {}; }
    },
    moveWeek(n) { this.time.week = addDays(this.time.week, 7 * n); this.time.form = blankTime(this.time.week); this.loadTime(); },
    timeBody(f) {
      return { date: f.date, jobId: f.jobId || null, start: f.start || undefined, end: f.end || undefined, hours: f.hours || undefined, notes: f.notes, billable: f.billable };
    },
    async saveTime() {
      const t = this.time;
      const base = `/companies/${this.companyId}/time-entries`;
      const body = { ...this.timeBody(t.form), userId: t.userId || undefined };
      const ok = t.editing
        ? await this.run(() => api('PATCH', `${base}/${t.editing}`, body), 'Time saved.')
        : await this.run(() => api('POST', base, body), 'Time added.');
      if (ok) { const keep = { date: t.form.date, jobId: t.form.jobId }; t.form = { ...blankTime(), ...keep }; t.editing = null; this.loadTime(); }
    },
    editTime(e) {
      this.time.editing = e.id;
      this.time.form = { date: e.date, jobId: e.jobId ?? '', start: e.start ?? '', end: e.end ?? '', hours: e.start ? '' : e.hours, notes: e.notes ?? '', billable: e.billable };
    },
    async deleteTime(e) {
      if (!confirm(`Delete ${e.hours} hours on ${e.date}?`)) return;
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/time-entries/${e.id}`), 'Deleted.')) this.loadTime();
    },
    async submitWeek() {
      const ids = this.time.entries.filter((e) => ['draft', 'rejected'].includes(e.status)).map((e) => e.id);
      if (ids.length && await this.run(() => api('POST', `/companies/${this.companyId}/time-entries/submit`, { ids }), `Sent ${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} for approval.`)) this.loadTime();
    },
    async review(approve) {
      const ids = Object.keys(this.time.picked).filter((k) => this.time.picked[k]);
      if (!ids.length) return this.flash('Tick the entries first.', 'bad');
      if (!approve && !this.time.note) return this.flash('Add a note saying what to fix.', 'bad');
      const ok = await this.run(() => api('POST', `/companies/${this.companyId}/time-entries/review`, { ids, approve, note: this.time.note || undefined }),
        approve ? `Approved ${ids.length}.` : `Sent back ${ids.length}.`);
      if (ok) { this.time.note = ''; this.loadTime(); }
    },
    pickAll(on) { for (const e of this.time.pending) this.time.picked[e.id] = on; },
    async pickTimeFile(ev) {
      const f = ev.target.files[0];
      this.time.preview = null;
      this.time.file = f ? { name: f.name, content: await f.text() } : null;
    },
    importTimeBody(preview) {
      const t = this.time;
      return { fileName: t.file.name, content: t.file.content, preview, userId: t.importFor || undefined, createJobs: t.createJobs };
    },
    async previewTimeImport() {
      this.time.preview = await this.run(() => api('POST', `/companies/${this.companyId}/time-entries/import`, this.importTimeBody(true)));
    },
    async commitTimeImport() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/time-entries/import`, this.importTimeBody(false)));
      if (r) {
        this.flash(`Imported ${r.imported} entr${r.imported === 1 ? 'y' : 'ies'} (${r.hours} hours) as drafts${r.duplicates ? `; skipped ${r.duplicates} already imported` : ''}. Review them, then submit the week.`);
        Object.assign(this.time, { file: null, preview: null });
        if (r.from) this.time.week = weekStartOf(r.from);
        this.loadTime(true);
      }
    },
    async addJob() {
      const j = this.time.newJob;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/jobs`, { ...j, customerId: j.customerId || null }), 'Job added.')) {
        this.time.newJob = { name: '', code: '', customerId: '' };
        this.loadTime(true);
      }
    },
    async closeJob(j) {
      if (await this.run(() => api('PATCH', `/companies/${this.companyId}/jobs/${j.id}`, { name: j.name, code: j.code, customerId: j.customerId, isActive: false }), 'Job closed.')) this.loadTime(true);
    },
    async checkAgain() {
      const list = await this.run(() => api('GET', '/companies'));
      if (!list) return;
      this.companies = list;
      if (list.length) { this.message = null; this.companyId = list[0].id; this.tab = 'home'; } else this.flash('Not added yet. Ask the company owner to add your email, then check again.', 'bad');
    },
    async createCompany() {
      const c = await this.run(() => api('POST', '/companies', this.newCompany), 'Company created. Your books are ready.');
      if (!c) return;
      this.companies.push(c); this.tab = 'setup'; this.setup.step = 2; this.companyId = c.id;
      this.newCompany = blankCompany();
    },
    async recordQuick() {
      const q = this.quick;
      const body = { date: q.date, memo: q.memo, amount: q.amount,
        fromAccountId: q.kind === 'in' ? q.other : q.bank,
        toAccountId: q.kind === 'in' ? q.bank : q.other };
      const ok = await this.run(() => api('POST', `/companies/${this.companyId}/entries/simple`, body, { 'Idempotency-Key': q.key }), 'Saved.');
      if (ok) { q.memo = ''; q.amount = ''; q.key = newKey(); this.loadDash(); }
    },
    async postJE() {
      const lines = this.je.lines.map((l) => ({ accountId: l.accountId, debit: l.debit || null, credit: l.credit || null }));
      const je = this.je;
      let ok;
      if (je.editId) {
        // Changing a recurring entry: from its next date on (start date and frequency stay).
        ok = await this.run(() => api('PUT', `/companies/${this.companyId}/recurring/${je.editId}`, {
          name: je.repeat.name || je.memo, memo: je.memo, lines, endDate: je.repeat.endDate || null }), 'Recurring entry changed. Entries already posted stay as they were.');
        if (ok) { this.je = { date: today(), memo: '', key: newKey(), repeat: blankRepeat(), lines: [{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }] }; this.showJE = false; this.loadRecurring(); }
        return;
      }
      if (je.correctsId) {
        ok = await this.run(() => api('PUT', `/companies/${this.companyId}/entries/${je.correctsId}`, { date: je.date, memo: je.memo, lines }, { 'Idempotency-Key': je.key }));
        if (ok) { this.flash(`Entry #${je.correctsNumber} corrected: reversed by #${ok.reversalNumber}, corrected entry is #${ok.entry_number}.`); this.cancelCorrection(); this.loadEntries(); }
        return;
      }
      if (je.repeat.on) {
        // A repeating entry is saved as a template; the ones already due are posted right away.
        ok = await this.run(() => api('POST', `/companies/${this.companyId}/recurring`, {
          name: je.repeat.name || je.memo, frequency: je.repeat.frequency, startDate: je.date, endDate: je.repeat.endDate || null, memo: je.memo, lines }));
        if (ok && je.date <= today()) await this.postDueRecurring();
        else if (ok) this.flash('Recurring entry saved.');
      } else {
        ok = await this.run(() => api('POST', `/companies/${this.companyId}/entries`, { date: je.date, memo: je.memo, lines }, { 'Idempotency-Key': je.key }), 'Entry posted.');
      }
      if (ok) {
        this.je = { date: je.date, memo: '', key: newKey(), repeat: blankRepeat(), lines: [{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }] };
        this.showJE = false; this.loadEntries(); this.loadRecurring();
      }
    },
    editEntry(e) {
      const d = (c) => (c ? (c / 100).toFixed(2) : '');
      this.je = { date: e.date, memo: e.memo ?? '', key: newKey(), correctsId: e.id, correctsNumber: e.number, repeat: blankRepeat(),
        lines: e.lines.map((l) => ({ accountId: l.accountId, debit: d(l.debitCents), credit: d(l.creditCents) })) };
      this.showJE = true;
      this.$nextTick(() => document.querySelector('.je-card')?.scrollIntoView({ behavior: 'smooth' }));
    },
    cancelCorrection() {
      this.je = { date: today(), memo: '', key: newKey(), repeat: blankRepeat(), lines: [{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }] };
      this.showJE = false;
    },
    async reverse(e) {
      if (!confirm(`Reverse entry #${e.number}? A new entry will cancel it out; the original stays on record.`)) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/entries/${e.id}/reverse`, {}), `Entry #${e.number} reversed.`)) this.loadEntries();
    },
    async loadReport() {
      const r = this.report; r.data = null;
      if (!this.can(this.reportTypes.find((x) => x.id === r.type)?.perm)) r.type = this.reportTypes.find((x) => this.can(x.perm))?.id;
      if (!r.type) return;
      const type = r.type;
      const data = await this.run(() => api('GET', `/companies/${this.companyId}/reports/${type}?${this.reportQuery}`));
      if (r.type === type) r.data = data; // ignore an answer for a report the user has already switched away from
      if (type === 'tax-summary' && data?.form) this.taxCats = await this.run(() => api('GET', `/companies/${this.companyId}/tax-categories`));
    },
    /** Tax-ready: give accounts a tax category (null = back to the suggestion), then refresh the summary. */
    async saveTaxCategories(items, done) {
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/tax-categories`, { items }), done)) this.loadReport();
    },
    acceptTaxSuggestions() {
      const items = (this.taxCats?.accounts ?? []).filter((a) => a.suggested).map((a) => ({ accountId: a.id, category: a.category }));
      if (items.length) this.saveTaxCategories(items, `${items.length} suggestions saved.`);
    },
    async createAccount() {
      const a = await this.run(() => api('POST', `/companies/${this.companyId}/accounts`, this.newAcct), 'Account added.');
      if (a) { this.accounts = await api('GET', `/companies/${this.companyId}/accounts`); this.newAcct = { code: '', name: '', type: 'expense', subtype: 'operating' }; this.showNewAcct = false; }
    },
    async openRegister(a) { this.register = await this.run(() => api('GET', `/companies/${this.companyId}/accounts/${a.id}/register`)); this.renaming = null; },
    /** Change the open account's kind, or turn it off/on (the server explains why when it can't). */
    async changeAccount(patch) {
      const a = this.register?.account;
      if (!a) return;
      if (patch.isActive === false && !confirm(`Turn off ${a.code} · ${a.name}? Its history stays; it just won't be offered for new entries.`)) return;
      const r = await this.run(() => api('PATCH', `/companies/${this.companyId}/accounts/${a.id}`, patch), patch.isActive === undefined ? 'Kind changed.' : (patch.isActive ? 'Account turned back on.' : 'Account turned off.'));
      this.accounts = await api('GET', `/companies/${this.companyId}/accounts`);
      if (r) Object.assign(a, { subtype: r.subtype, cashFlow: r.cashFlow, isActive: r.isActive });
      else this.register = { ...this.register, account: { ...a } }; // put the select back
    },
    /** Rename the account open on the right (only the name; the number and kind stay). */
    async renameAccount() {
      const a = this.register?.account;
      if (!a || !this.renaming?.trim()) return;
      const r = await this.run(() => api('PUT', `/companies/${this.companyId}/accounts/${a.id}/name`, { name: this.renaming }), 'Account renamed.');
      if (!r) return;
      this.accounts = await api('GET', `/companies/${this.companyId}/accounts`);
      a.name = r.name; this.renaming = null;
    },
    async createEmployee() {
      const e = this.newEmp;
      // An exempt claim is kept with the year it covers (it lapses after February 15 of the next year).
      const exemptOnly = (x) => { const { exempt, exemptYear, ...rest } = x; return exempt ? { ...rest, exempt: true, exemptYear } : rest; };
      const stateElections = { CA: exemptOnly(e.ca), CO: e.co.annualAllowance ? e.co : {}, DC: e.dc };
      const w4 = exemptOnly({ ...e.w4, dependentsCredit: e.w4.dependentsCredit || '0', extraWithholding: e.w4.extraWithholding || '0' });
      const body = { ssn: e.ssn || undefined, firstName: e.firstName, lastName: e.lastName, workState: e.workState, payFrequency: e.payFrequency, payType: e.payType, payRate: e.payRate, w4,
        stateElections: { ...e.elections, [e.workState]: stateElections[e.workState] }, address: e.address, hireDate: e.hireDate || undefined };
      const ok = await this.run(() => (e.id ? api('PUT', `/companies/${this.companyId}/employees/${e.id}`, body) : api('POST', `/companies/${this.companyId}/employees`, body)),
        e.id ? 'Employee changed. Paychecks already made keep the details they were figured with.' : 'Employee saved.');
      if (ok) { this.newEmp = blankEmployee(); this.showNewEmp = false; this.loadEmployees(); }
    },
    editEmployee(e) {
      this.newEmp = employeeForm(e); this.showNewEmp = true;
      this.$nextTick(() => document.querySelector('.emp-form')?.scrollIntoView({ block: 'start' }));
    },
    closeEmployeeForm() { this.newEmp = blankEmployee(); this.showNewEmp = false; },
    async terminateEmployee(e) {
      const date = prompt(`Last day of work for ${e.firstName} ${e.lastName} (YYYY-MM-DD). Run their final paycheck first: after this they drop out of payroll runs.`, today());
      if (!date) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/employees/${e.id}/terminate`, { date: date.trim() }), `${e.firstName} marked as left.`)) this.loadEmployees();
    },
    async rehireEmployee(e) {
      const date = prompt(`Date ${e.firstName} ${e.lastName} starts again (YYYY-MM-DD)`, today());
      if (!date) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/employees/${e.id}/rehire`, { date: date.trim() }), `${e.firstName} is back on payroll.`)) this.loadEmployees();
    },
    startPaycheck(e) {
      this.pc = { employee: e, payDate: today(), hours: '', overtimeHours: '', k401: '', paidFrom: this.bankAccounts[0]?.id ?? '', result: null, key: crypto.randomUUID() };
    },
    paycheckBody() {
      const p = this.pc;
      const k = cents(p.k401);
      return { payDate: p.payDate, hours: p.hours || undefined, overtimeHours: p.overtimeHours || undefined,
        paidFromAccountId: p.paidFrom || undefined, idempotencyKey: p.key,
        preTaxDeductions: k ? [{ name: '401(k)', amountCents: k, kind: 'retirement_401k' }] : [] };
    },
    async previewPaycheck() {
      this.pc.result = await this.run(() => api('POST', `/companies/${this.companyId}/employees/${this.pc.employee.id}/paychecks/preview`, this.paycheckBody()));
    },
    async postPaycheck() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/employees/${this.pc.employee.id}/paychecks`, this.paycheckBody()), 'Paycheck recorded in your books.');
      if (r) { this.pc.employee = null; this.loadEmployees(); }
    },
    async voidPaycheck(p) {
      const reason = prompt(`Void ${p.employee}'s paycheck of ${p.payDate}? This reverses it in your books and year-to-date wages.\n\nReason:`);
      if (!reason) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/paychecks/${p.id}/void`, { reason }), 'Paycheck voided.')) this.loadEmployees();
    },
    async lockBooks() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/lock`, { through: this.lockDate }), `Books closed through ${this.lockDate}.`);
      if (r) this.company.locked_through = r.lockedThrough;
    },
    async reopenBooks() {
      const reason = prompt('Reopening lets transactions in closed periods be changed. Why are you reopening?');
      if (!reason) return;
      const mfaCode = prompt('For your security, enter the 6-digit code from your authenticator app:');
      if (!mfaCode) return;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/lock`, { through: null, reason, mfaCode: mfaCode.trim() }), 'Books reopened.');
      if (r) this.company.locked_through = null;
    },
    async saveFamli() {
      const c = await this.run(() => api('PATCH', `/companies/${this.companyId}/settings`, { famliHeadcount: this.famliCount }), 'Saved.');
      if (c) this.company = { ...this.company, ...c };
    },
    async saveSui() {
      const c = await this.run(() => api('PATCH', `/companies/${this.companyId}/settings`, { suiRatePct: this.suiRate }), 'Rate saved.');
      if (c) this.company = { ...this.company, ...c };
    },
    payrollStates() { return [...new Set([this.company?.home_state, ...this.employees.map((e) => e.workState)].filter(Boolean))].sort(); },
    editProfile() { const c = this.company; this.profile = c ? { name: c.name, homeState: c.home_state, fiscalYearStartMonth: c.fiscal_year_start_month } : null; },
    async saveProfile() {
      const c = await this.run(() => api('PATCH', `/companies/${this.companyId}/profile`, this.profile), 'Company saved.');
      if (!c) return;
      this.company = { ...this.company, ...c };
      const row = this.companies.find((x) => x.id === this.companyId);
      if (row) row.name = c.name;
      this.editProfile();
    },
    editFutaCr() { this.futaCr = { ...(this.company?.futa_credit_reduction ?? {}) }; },
    async saveFutaCr() {
      const c = await this.run(() => api('PATCH', `/companies/${this.companyId}/settings`, { futaCreditReduction: this.futaCr }), 'Saved.');
      if (c) { this.company = { ...this.company, ...c }; this.editFutaCr(); }
    },
    // ---------------------------------------------------------------- Importing books
    async loadImports() { this.imp.history = (await this.run(() => api('GET', `/companies/${this.companyId}/imports`))) ?? []; },
    importBody() {
      const i = this.imp;
      return { kind: i.kind, asOf: i.asOf || undefined, fileName: i.file.name, ...(i.file.base64 ? { base64: i.file.base64 } : { content: i.file.content }) };
    },
    async pickImportFile(ev) {
      const i = this.imp;
      const f = ev.target.files[0];
      i.preview = null; i.problems = null; i.file = null;
      if (!f) return;
      if (f.size > 10_000_000) { this.flash('That file is larger than 10 MB. Export a shorter date range.', 'bad'); return; }
      if (/\.xlsx$/i.test(f.name)) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = ''; for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
        i.file = { name: f.name, base64: btoa(bin) };
      } else if (/\.xls$/i.test(f.name)) {
        this.flash('Old .xls files can\'t be read. In Excel use File → Save As → Excel Workbook (.xlsx) or CSV.', 'bad'); return;
      } else i.file = { name: f.name, content: await f.text() };
      if (/\.iif$/i.test(f.name)) i.kind = 'iif';
      await this.previewImport();
    },
    async previewImport() {
      const i = this.imp;
      if (!i.file) return;
      if (i.kind === 'opening' && !i.asOf) { i.problems = { error: 'Choose the date of the opening balances first.', details: [] }; return; }
      i.busy = true; i.preview = null; i.problems = null;
      try { i.preview = await api('POST', `/companies/${this.companyId}/imports/preview`, this.importBody()); }
      catch (e) { i.problems = { error: e.message.replace(/:.*$/, ''), details: e.details ?? [] }; }
      finally { i.busy = false; }
    },
    async commitImport() {
      const i = this.imp;
      i.busy = true;
      try {
        const r = await api('POST', `/companies/${this.companyId}/imports`, this.importBody());
        this.flash(`Imported${r.entries ? ` ${r.entries} entries` : ''}${r.accountsCreated.length ? `, ${r.accountsCreated.length} new accounts` : ''}. Verified against the file to the penny.`);
        i.preview = null; i.file = null;
        if (this.$refs.importFile) this.$refs.importFile.value = '';
        this.accounts = await api('GET', `/companies/${this.companyId}/accounts`);
        this.loadImports();
      } catch (e) { i.problems = { error: e.message.replace(/:.*$/, ''), details: e.details ?? [] }; }
      finally { i.busy = false; }
    },
    async undoImport(b) {
      if (!confirm(`Undo the import of ${b.fileName || 'this file'}? Each of its ${b.entries} entries gets a reversing entry; accounts it created stay.`)) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/imports/${b.id}/undo`, {}), 'Import undone.')) this.loadImports();
    },
    // ---------------------------------------------------------------- Banking
    async loadBank() {
      const b = this.bank;
      if (!this.bankLike.some((a) => a.id === b.accountId)) b.accountId = this.bankLike[0]?.id ?? '';
      if (!b.accountId) return;
      const base = `/companies/${this.companyId}/bank-accounts/${b.accountId}`;
      b.txs = (await this.run(() => api('GET', `${base}/transactions?status=${b.view}`))) ?? [];
      b.choice = Object.fromEntries(b.txs.map((t) => [t.id, t.suggestedAccountId ?? '']));
      b.sameAs = {};
      b.matches = {};
      b.rules = (await this.run(() => api('GET', `/companies/${this.companyId}/bank-rules`))) ?? [];
      b.recons = (await this.run(() => api('GET', `${base}/reconciliations`))) ?? [];
      b.imports = (await this.run(() => api('GET', `${base}/imports`))) ?? [];
      const open = b.recons.find((r) => r.status === 'open');
      b.recon = open ? await this.run(() => api('GET', `/companies/${this.companyId}/reconciliations/${open.id}`)) : null;
    },
    lineCents,
    // ---------------------------------------------------------------- Sales & Bills
    arBase() { return `/companies/${this.companyId}`; },
    async loadAr() {
      const ar = this.ar; const S = this.S; const base = this.arBase();
      ar.contacts = (await this.run(() => api('GET', `${base}/${S.contacts}`))) ?? [];
      ar.jobs = (await this.run(() => api('GET', `${base}/jobs?inactive=1`))) ?? [];
      if (ar.panel === 'docs') ar.docs = (await this.run(() => api('GET', `${base}/${S.docPath}?status=${ar.view}`))) ?? [];
      if (ar.panel === 'plans') ar.plans = ((await this.run(() => api('GET', `${base}/${S.docPath}?status=open`))) ?? []).filter((d) => d.plan)
        .sort((a, b) => (a.plan.next?.dueDate ?? '').localeCompare(b.plan.next?.dueDate ?? ''));
      if (ar.panel === 'late') ar.late = await this.run(() => api('GET', `${base}/late-charges/preview?asOf=${ar.lateAsOf}`));
      if (ar.panel === 'payments') ar.payments = (await this.run(() => api('GET', `${base}/${S.payPath}`))) ?? [];
      if (ar.panel === 'aging') ar.aging = await this.run(() => api('GET', `${base}/reports/${S.agingPath}?asOf=${ar.agingAsOf}`));
      if (S.kind === 'invoice') ar.roadChecks = ((await this.run(() => api('GET', `${base}/road-items`))) ?? []).filter((i) => i.kind === 'check');
    },
    // ---- Checks received on the road (Road page → "Check received"): each becomes a payment here.
    roadCheckPhotoUrl(i, id) { return `/api${this.arBase()}/road-items/${i.id}/photos/${id}`; },
    /** Opens Receive payment filled in from the check: the customer and invoices it names, the amount spread over them. */
    async recordRoadCheck(i) {
      await this.startPay(i.invoices[0]?.contactId ?? '');
      const p = this.ar.pay;
      Object.assign(p, { date: i.data.date, reference: i.data.checkNumber ?? '', memo: [i.data.from && `From ${i.data.from}`, i.data.notes].filter(Boolean).join(' · ').slice(0, 500),
        roadItem: i, keptPhotos: i.photos.length });
      let left = i.data.amountCents;
      for (const inv of i.invoices.filter((x) => x.contactId === p.contactId)) {
        const d = p.open.find((x) => x.id === inv.id);
        if (!d || left <= 0) continue;
        const c = Math.min(left, d.balanceCents); p.amounts[d.id] = (c / 100).toFixed(2); left -= c;
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async dismissRoadCheck(i) {
      if (!confirm('Dismiss this check from the road? It will not go into the books.')) return;
      if (await this.run(() => api('POST', `${this.arBase()}/road-items/${i.id}/dismiss`), 'Dismissed.')) this.loadAr();
    },
    arPanel(p) { this.ar.panel = p; this.ar.detail = null; this.ar.photoView = null; this.ar.planStatement = null; this.loadAr(); },
    // ---- Late charges (Sales → Late charges): what a run as of a date would charge, then post it.
    async postLateCharges() {
      const l = this.ar.late;
      if (!l?.count) return;
      if (!confirm(`Post ${l.count} late-charge invoice${l.count === 1 ? '' : 's'} for ${this.money(l.totalCents)}, dated ${this.usDate(l.asOf)}?`)) return;
      const r = await this.run(() => api('POST', `${this.arBase()}/late-charges`, { asOf: l.asOf }));
      if (r) { this.flash(`Posted ${r.invoices.length} late-charge invoice${r.invoices.length === 1 ? '' : 's'} (${r.invoices.map((x) => x.number).join(', ')}).`); this.loadAr(); }
    },
    // ---- Payment plans (Sales → Payment plans, and the Home card): each plan, its next payment, a statement.
    async openPlans() { this.arPanel('plans'); },
    async planStatementFor(d) { this.ar.planStatement = await this.run(() => api('GET', `${this.arBase()}/documents/${d.id}`)); },
    /** Receive payment for this customer, with the next plan payment filled in against this invoice. */
    async payPlan(d) {
      this.ar.planStatement = null;
      await this.startPay(d.contactId);
      const p = this.ar.pay;
      if (d.plan?.next && p.open.some((x) => x.id === d.id)) p.amounts[d.id] = (Math.min(d.plan.next.amountCents, d.balanceCents) / 100).toFixed(2);
    },
    // ---------------------------------------------------------------- Projects (the jobs time is entered against)
    activeJobs() { return this.ar.jobs.filter((j) => j.isActive); },
    // Sales → Projects: click Number, Project or Customer to sort; again to reverse. Kept on this computer.
    // "Project" sorts by the name without its number (2601 Smith Residence sorts under S), so it differs from Number.
    sortProjects(key) {
      const s = this.ar.proj.sort;
      this.ar.proj.sort = { key, dir: s.key === key ? -s.dir : 1 };
      try { localStorage.setItem('zacc.projectSort', JSON.stringify(this.ar.proj.sort)); } catch { /* private window */ }
    },
    sortedJobs() {
      const { key, dir } = this.ar.proj.sort;
      const text = (j) => key === 'code' ? (j.code ?? '') : key === 'customer' ? (j.customerName ?? '')
        : (j.code && j.name.startsWith(j.code) ? j.name.slice(j.code.length).replace(/^[\s\-–·:]+/, '') : j.name);
      return [...this.ar.jobs].sort((a, b) => {
        const x = text(a), y = text(b);
        if (!x !== !y) return x ? -1 : 1; // blanks last either way
        return dir * x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' }) || a.name.localeCompare(b.name, 'en', { numeric: true });
      });
    },
    jobLabel(j) { return j.code && !j.name.startsWith(j.code) ? `${j.code} · ${j.name}` : j.name; },
    editProject(j) {
      this.ar.proj.editId = j?.id ?? null; this.ar.proj.show = true;
      this.ar.proj.form = j ? { name: j.name, code: j.code ?? '', customerId: j.customerId ?? '', address: j.address ?? '' } : blankProject();
    },
    async saveProject() {
      const p = this.ar.proj; const f = { ...p.form, customerId: p.form.customerId || null };
      const r = p.editId
        ? await this.run(() => api('PATCH', `${this.arBase()}/jobs/${p.editId}`, { ...f, isActive: this.ar.jobs.find((j) => j.id === p.editId)?.isActive !== false }), 'Project saved.')
        : await this.run(() => api('POST', `${this.arBase()}/jobs`, f), 'Project added.');
      if (!r) return;
      const popup = p.popup;
      Object.assign(p, { editId: null, show: false, popup: false, form: blankProject() });
      await this.loadAr();
      // From the invoice's "+ Add new project…": pick it there and fill in the project block and number.
      if (popup && this.ar.showDoc) { this.ar.doc.jobId = r.id; this.pickDocProject(); }
    },
    quickAddProject() {
      Object.assign(this.ar.proj, { editId: null, popup: true, form: { ...blankProject(), customerId: this.ar.doc.contactId || '' } });
      this.ar.doc.jobId = '';
    },
    closeProjectPopup() { Object.assign(this.ar.proj, { popup: false, form: blankProject() }); },
    async toggleProject(j) {
      if (await this.run(() => api('PATCH', `${this.arBase()}/jobs/${j.id}`, { name: j.name, code: j.code, customerId: j.customerId, isActive: !j.isActive }),
        j.isActive ? 'Project closed.' : 'Project reopened.')) this.loadAr();
    },
    // Folder names pasted from File Explorer ("Copy as path") become projects: 2601 Smith Residence → number 2601.
    async pasteProjects(preview) {
      const p = this.ar.proj;
      const r = await this.run(() => api('POST', `${this.arBase()}/jobs/import`,
        { text: p.paste, customerId: p.pasteCustomer || null, makeCustomers: !p.pasteCustomer && p.makeCustomers, preview }));
      if (!r) return;
      if (preview) { p.preview = r; return; }
      const said = [r.added && `added ${r.added} project${r.added === 1 ? '' : 's'}`, r.updated && `filled in ${r.updated}`,
        r.customersAdded && `added ${r.customersAdded} customer${r.customersAdded === 1 ? '' : 's'}`].filter(Boolean);
      this.flash(said.length ? `Done: ${said.join(', ')}.` : 'All of those projects were already on the list.');
      p.paste = ''; p.preview = null; this.loadAr();
    },
    projectImportLabel() {
      const rows = this.ar.proj.preview?.projects ?? [];
      const n = rows.filter((x) => x.status === 'new').length; const f = rows.filter((x) => x.status === 'fills in').length;
      return [n && `Add ${n} new project${n === 1 ? '' : 's'}`, f && `fill in ${f}`].filter(Boolean).join(' and ').replace(/^f/, 'F');
    },
    // The invoice's project: fills in the customer, the printed project block, and its number as the invoice number.
    pickDocProject() {
      const d = this.ar.doc; const j = this.ar.jobs.find((x) => x.id === d.jobId);
      if (!j) return;
      if (!d.contactId && j.customerId) d.contactId = j.customerId;
      if (!d.project.trim()) d.project = [j.name, j.address].filter(Boolean).join('\n');
      if (!d.number && !d.editId && j.code) d.number = j.code;
    },
    // ---------------------------------------------------------------- Trips
    tripBase() { return `/companies/${this.companyId}`; },
    async loadTrips() {
      const tr = this.trip;
      tr.list = (await this.run(() => api('GET', `${this.tripBase()}/trips`))) ?? [];
      if (!this.ar.jobs.length) this.ar.jobs = (await this.run(() => api('GET', `${this.tripBase()}/jobs?inactive=1`))) ?? [];
      if (tr.cur) await this.openTrip(tr.cur.id);
      await this.loadRoad();
    },
    // ---- The Road page: keys for the phone, and the inbox of what it sent (src/services/roadService.js)
    async loadRoad() {
      const r = this.road;
      r.items = ((await this.run(() => api('GET', `${this.tripBase()}/road-items`))) ?? []).filter((i) => i.kind !== 'check'); // checks: on Sales
      if (this.can('bills')) r.keys = (await this.run(() => api('GET', `${this.tripBase()}/road-keys`))) ?? [];
      const last = lastRoadAccounts();
      if (!r.expenseId) r.expenseId = last.expenseId ?? this.tripExpenseAccounts().find((a) => /travel/i.test(a.name))?.id ?? '';
      if (!r.paidFromId) r.paidFromId = last.paidFromId ?? this.tripPaidFromAccounts().find((a) => a.subtype === 'credit_card')?.id ?? '';
      if (!r.keyName) r.keyName = `${this.auth.user?.name?.split(' ')[0] ?? 'My'}'s phone`;
    },
    async makeRoadKey() {
      const r = this.road;
      const k = await this.run(() => api('POST', `${this.tripBase()}/road-keys`, { name: r.keyName }));
      if (k) { r.made = { ...k, qr: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(k.qrSvg)}` }; r.keys = (await this.run(() => api('GET', `${this.tripBase()}/road-keys`))) ?? []; }
    },
    async copyRoadLink() {
      try { await navigator.clipboard.writeText(this.road.made.url); this.flash('Link copied. Send it to your phone (Messages to yourself works) and open it there.'); }
      catch { this.flash('The browser would not copy. Select the link and copy it yourself.', 'bad'); }
    },
    async revokeRoadKey(k) {
      if (!confirm(`Turn off the road key "${k.name}"? That phone will no longer be able to send anything.`)) return;
      if (await this.run(() => api('POST', `${this.tripBase()}/road-keys/${k.id}/revoke`), 'Road key turned off.')) this.loadRoad();
    },
    roadGroups() {
      const groups = new Map();
      for (const i of this.road.items) {
        const name = i.trip?.name ?? 'Trip';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(i);
      }
      return [...groups].map(([name, items]) => ({ name, items }));
    },
    roadLabel(i) {
      if (i.kind === 'trip') {
        const codes = [...(i.data.jobIds ?? []).map((id) => this.jobLabel(this.ar.jobs.find((j) => j.id === id) ?? { name: 'a project' })),
          ...(i.data.newProjects ?? []).map((p) => `${p.name} (new)`)];
        return `New trip${i.data.endDate ? ' to ' + this.usDate(i.data.endDate) : ''}${codes.length ? ' · ' + codes.join(', ') : ''}`;
      }
      if (i.kind === 'time') return `Travel time ${i.hours} h${i.data.notes ? ' · ' + i.data.notes : ''}`;
      const what = i.data.kind === 'mileage' ? `${i.data.description} · ${i.data.miles} mi × $${i.data.mileRate}` : i.data.description;
      return `${what}${i.data.vendor ? ' · ' + i.data.vendor : ''}`;
    },
    /** A cost or travel time whose trip isn't in the books yet (or was dismissed) needs a trip chosen here. */
    roadNeedsTrip(i) { return i.kind !== 'trip' && !i.trip?.tripId && i.trip?.tripStatus !== 'pending'; },
    /** The card a waiting cost goes on: the one picked on its row, else the card last used for its kind, else Paid with. */
    roadCard(i) {
      const picked = this.road.cardFor[i.id];
      if (picked) return picked;
      const last = cardsByKind()[i.data.kind ?? 'other'];
      return last && this.tripPaidFromAccounts().some((a) => a.id === last) ? last : this.road.paidFromId;
    },
    pickCostKind(k) {
      const c = this.trip.cost;
      c.kind = k;
      const last = cardsByKind()[k];
      if (!this.trip.editCostId && last && this.tripPaidFromAccounts().some((a) => a.id === last)) c.paidFromAccountId = last;
    },
    roadPhotoUrl(i, id) { return `/api${this.tripBase()}/road-items/${i.id}/photos/${id}`; },
    async acceptRoad(i) {
      const r = this.road;
      const body = {};
      if (i.kind === 'cost') {
        if (!r.expenseId || !r.paidFromId) { this.flash('Choose the expense account and what it was paid with (top of this box) first.', 'bad'); return; }
        Object.assign(body, { expenseAccountId: r.expenseId, paidFromAccountId: this.roadCard(i) });
        keepRoadAccounts({ expenseId: r.expenseId, paidFromId: r.paidFromId });
        keepCardFor(i.data.kind ?? 'other', body.paidFromAccountId);
      }
      if (i.kind !== 'trip' && r.tripFor[i.id]) body.tripId = r.tripFor[i.id];
      r.busy = true;
      try {
        const ok = await this.run(() => api('POST', `${this.tripBase()}/road-items/${i.id}/accept`, body),
          i.kind === 'trip' ? 'Trip added, with its projects sharing it evenly. Open it to change the shares.' : 'Added to the trip.');
        if (ok) await this.loadTrips();
      } finally { r.busy = false; }
    },
    /** Accept all: every item of one trip in the inbox (the trip itself first), in one step. */
    async acceptRoadGroup(items) {
      const r = this.road;
      if (items.some((i) => i.kind === 'cost') && (!r.expenseId || !r.paidFromId)) { this.flash('Choose the expense account and what it was paid with first.', 'bad'); return; }
      const lost = items.find((i) => this.roadNeedsTrip(i) && !r.tripFor[i.id]);
      if (lost) { this.flash(`Choose a trip for "${this.roadLabel(lost)}" first.`, 'bad'); return; }
      const costs = items.filter((i) => i.kind === 'cost').reduce((t, i) => t + i.data.amountCents, 0);
      if (!confirm(`Put all ${items.length} into the books${costs ? ` (${money(costs)} of costs)` : ''}?`)) return;
      // Items needing a trip chosen here go one at a time; the rest in one step.
      const chosen = items.filter((i) => i.kind !== 'trip' && r.tripFor[i.id]);
      const rest = items.filter((i) => !chosen.includes(i));
      r.busy = true;
      try {
        if (r.expenseId) keepRoadAccounts({ expenseId: r.expenseId, paidFromId: r.paidFromId });
        // Each cost goes on its own row's card.
        const cards = Object.fromEntries(items.filter((i) => i.kind === 'cost').map((i) => [i.id, this.roadCard(i)]));
        let ok = !rest.length || await this.run(() => api('POST', `${this.tripBase()}/road-items/accept-all`,
          { itemIds: rest.map((i) => i.id), expenseAccountId: r.expenseId || undefined, paidFromAccountId: r.paidFromId || undefined, paidFrom: cards }));
        for (const i of chosen) if (ok) ok = await this.run(() => api('POST', `${this.tripBase()}/road-items/${i.id}/accept`,
          { tripId: r.tripFor[i.id], expenseAccountId: r.expenseId || undefined, paidFromAccountId: cards[i.id] || r.paidFromId || undefined }));
        if (ok) for (const i of items.filter((x) => x.kind === 'cost')) keepCardFor(i.data.kind ?? 'other', cards[i.id]);
        if (ok) this.flash(`${items.length} item${items.length === 1 ? '' : 's'} put into the books.`);
        await this.loadTrips();
      } finally { r.busy = false; }
    },
    /**
     * Each project's share of the trip by kind of cost (Homer, 2026-10-30): air, hotel, rental car and the rest.
     * Worked one cost at a time, rounded half-up, the way the invoice bills it (cost × share on each line).
     */
    tripShareTable() {
      const t = this.trip.cur;
      const groupOf = (kind) => ({ airfare: 'air', lodging: 'hotel', rental_car: 'car' }[kind] ?? 'rest');
      const cols = [{ key: 'air', label: 'Air' }, { key: 'hotel', label: 'Hotel' }, { key: 'car', label: 'Rental car' }, { key: 'rest', label: 'Rest' }]
        .map((c) => ({ ...c, cents: 0 }));
      const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
      const posted = t.costs.filter((x) => x.status === 'posted');
      for (const x of posted) byKey[groupOf(x.kind)].cents += x.amountCents;
      const rows = t.jobs.map((j) => {
        const r = { air: 0, hotel: 0, car: 0, rest: 0, total: 0 };
        for (const x of posted) {
          const part = Math.floor((x.amountCents * j.shareBp * 2 + 10000) / 20000);
          r[groupOf(x.kind)] += part; r.total += part;
        }
        return { job: j, ...r };
      });
      return { cols, rows };
    },
    // ---- Projects on a trip: search by number or name ("NM"), tick, add; or add a new project (Homer, 2026-10-30).
    tripJobMatches() {
      const q = this.trip.find.q.trim().toLowerCase();
      if (!q || !this.trip.cur) return [];
      const on = new Set(this.trip.cur.jobs.map((j) => j.jobId));
      return this.ar.jobs.filter((j) => j.isActive && !on.has(j.id)
        && [j.code, j.name, j.customerName].some((t) => (t ?? '').toLowerCase().includes(q))).slice(0, 40);
    },
    /** Add the ticked projects (and any just made); every project on the trip then shares it evenly. */
    async addTripJobs(extraIds = []) {
      const t = this.trip.cur; const f = this.trip.find;
      const ids = [...Object.keys(f.pick).filter((id) => f.pick[id]), ...extraIds];
      if (!ids.length) return;
      const all = [...t.jobs.map((j) => j.jobId), ...ids.filter((id) => !t.jobs.some((j) => j.jobId === id))];
      if (t.jobs.length && !confirm(`Add ${ids.length} project${ids.length === 1 ? '' : 's'} and split the trip evenly across all ${all.length}? You can change the shares with edit.`)) return;
      const each = Math.floor(10000 / all.length);
      const jobs = all.map((jobId, i) => ({ jobId, share: ((i === all.length - 1 ? 10000 - each * (all.length - 1) : each) / 100).toFixed(2) }));
      const r = await this.run(() => api('PATCH', `${this.tripBase()}/trips/${t.id}`, { jobs }), 'Projects added.');
      if (r) { this.trip.cur = r; Object.assign(f, { q: '', pick: {}, newJob: null }); }
    },
    async startTripNewJob() {
      const f = this.trip.find;
      const q = f.q.trim();
      f.newJob = /^[\w-]*\d[\w-]*$/.test(q) ? { code: q, name: '', customerId: '' } : { code: '', name: q, customerId: '' };
      if (!f.customers.length) f.customers = (await this.run(() => api('GET', `${this.tripBase()}/customers`))) ?? [];
    },
    async saveTripNewJob() {
      const n = this.trip.find.newJob;
      const j = await this.run(() => api('POST', `${this.tripBase()}/jobs`, { code: n.code, name: n.name, customerId: n.customerId || undefined }), 'Project added.');
      if (!j) return;
      this.ar.jobs = (await this.run(() => api('GET', `${this.tripBase()}/jobs?inactive=1`))) ?? this.ar.jobs;
      await this.addTripJobs([j.id]);
    },
    /** Pick a trip from the pull-down (newest first); empty goes back to the list. */
    pickTrip(id) { if (id) { Object.assign(this.trip, { form: null, cost: null, editCostId: null, travel: null, viewRow: null, find: { q: '', pick: {}, newJob: null, customers: this.trip.find.customers } }); this.openTrip(id); } else this.closeTripView(); },
    /** Road items waiting for the open trip (sent from the phone, not in the books yet). */
    tripRoadItems() { return this.trip.cur ? this.road.items.filter((i) => i.kind !== 'trip' && i.trip?.tripId === this.trip.cur.id) : []; },
    /** The open trip's grid: costs, travel time and what the phone sent for it, by date. */
    tripGrid() {
      const t = this.trip.cur;
      if (!t) return [];
      const rows = [
        ...this.tripRoadItems().map((i) => ({ key: `r${i.id}`, type: 'road', item: i, date: i.data.date,
          entry: i.kind === 'time' ? `Travel time${i.data.notes ? ' · ' + i.data.notes : ''}` : this.roadLabel(i),
          cents: i.kind === 'cost' ? i.data.amountCents : null, hours: i.kind === 'time' ? i.hours : null, photos: i.photos.length })),
        ...t.costs.map((x) => ({ key: `c${x.id}`, type: 'cost', x, date: x.date, cents: x.amountCents, photos: x.photoCount,
          entry: `${x.description}${x.vendor ? ' · ' + x.vendor : ''}${x.kind === 'mileage' ? ' · ' + x.miles + ' mi × ' + x.mileRateCents + '¢' : ''}` })),
        ...t.time.map((x) => ({ key: `t${x.id}`, type: 'time', x, date: x.date, hours: x.hours, entry: `Travel time${x.notes ? ' · ' + x.notes : ''}` })),
      ];
      return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'road') - (b.type === 'road'));
    },
    canEditRow(g) {
      if (g.type === 'road') return this.can('bills');
      if (g.type === 'cost') return g.x.status === 'posted' && !g.x.billed.length && this.can('post');
      return !g.x.billed.length && this.can('bills');
    },
    editRow(g) {
      this.trip.viewRow = null;
      if (g.type === 'cost') return this.editTripCost(g.x);
      if (g.type === 'time') return this.editTravel(g.x);
      const i = g.item; const d = i.data;
      if (i.kind === 'cost') {
        const r = this.road;
        Object.assign(this.trip, { editCostId: null, travel: null, cost: { ...blankTripCost(d.date), roadItem: i, kind: d.kind ?? 'other', vendor: d.vendor ?? '',
          description: d.description ?? '', miles: d.miles ?? '', mileRate: d.mileRate ?? '', amount: d.amountCents != null ? (d.amountCents / 100).toFixed(2) : '',
          expenseAccountId: r.expenseId || this.tripExpenseAccounts().find((a) => /travel/i.test(a.name))?.id || '',
          paidFromAccountId: this.roadCard(i) || this.tripPaidFromAccounts().find((a) => a.subtype === 'credit_card')?.id || '', keptPhotos: i.photos.length } });
      } else {
        const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
        Object.assign(this.trip, { cost: null, travel: { roadItem: i, date: d.date, hours: d.start ? '' : hm(d.minutes), start: d.start ?? '', end: d.end ?? '',
          breaks: d.breakMinutes ? hm(d.breakMinutes) : '', notes: d.notes ?? '' } });
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    deleteRow(g) {
      if (g.type === 'road') return this.dismissRoad(g.item).then(() => this.openTrip(this.trip.cur.id));
      if (g.type === 'cost') return this.voidTripCost(g.x);
      return this.removeTravel(g.x);
    },
    viewRow(g) {
      if (g.type === 'cost') { this.trip.viewRow = null; return this.openTripPhotos(g.x); }
      this.trip.photoView = null;
      this.trip.viewRow = this.trip.viewRow === g.key ? null : g.key;
    },
    /** A road item changed at the desk goes into the books with its changes ("Save to books"). */
    async saveRoadEdit(i, data, accounts = {}) {
      const r = await this.run(() => api('POST', `${this.tripBase()}/road-items/${i.id}/accept`, { data, tripId: this.trip.cur.id, ...accounts }), 'Saved to the books.');
      if (r) await this.loadTrips();
      return r;
    },
    async dismissRoad(i) {
      if (!confirm('Dismiss this? It will not go into the books.')) return;
      if (await this.run(() => api('POST', `${this.tripBase()}/road-items/${i.id}/dismiss`), 'Dismissed.')) this.loadRoad();
    },
    // ---- MileIQ import: the monthly drive report → mileage on trips (src/services/mileIqService.js)
    async pickMileIq(ev) {
      const m = this.mileiq;
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      const content = await f.text();
      const p = await this.run(() => api('POST', `${this.tripBase()}/mileiq/preview`, { content }));
      if (!p) return;
      m.file = { name: f.name, content };
      m.preview = p;
      m.pick = {}; m.tripFor = {};
      for (const d of p.drives) if (d.business && !d.imported) { m.pick[d.key] = true; m.tripFor[d.key] = d.tripId ?? 'new'; }
      const month = new Date(`${p.from}T12:00:00`).toLocaleString('en-US', { month: 'long', year: 'numeric' });
      m.newTripName = `Local driving, ${month}`;
      m.rate = p.rates.business ?? '';
      const exp = this.tripExpenseAccounts(); const from = this.tripPaidFromAccounts();
      if (!m.expenseId) m.expenseId = exp.find((a) => /vehicle|car|auto|mileage/i.test(a.name))?.id ?? exp.find((a) => /travel/i.test(a.name))?.id ?? '';
      if (!m.paidFromId) m.paidFromId = from.find((a) => a.type === 'equity')?.id ?? '';
    },
    /** The file's drives, a day at a time. */
    mileIqDays() {
      const days = new Map();
      for (const d of this.mileiq.preview?.drives ?? []) {
        if (!days.has(d.date)) days.set(d.date, []);
        days.get(d.date).push(d);
      }
      return [...days].map(([date, drives]) => ({ date, drives }));
    },
    mileIqPlace(p) { return String(p ?? '').split(',')[0].trim() || '?'; },
    mileIqTicked() { return (this.mileiq.preview?.drives ?? []).filter((d) => this.mileiq.pick[d.key]); },
    mileIqTickedMiles() {
      const h = this.mileIqTicked().reduce((t, d) => { const [w, f = ''] = d.miles.split('.'); return t + Number(w) * 100 + Number(f.padEnd(2, '0')); }, 0);
      return (h / 100).toFixed(1);
    },
    mileIqAll(on) { for (const d of this.mileiq.preview.drives) if (d.business && !d.imported) this.mileiq.pick[d.key] = on; },
    mileIqBulk() {
      const m = this.mileiq;
      if (!m.bulkTrip) return;
      for (const d of this.mileIqTicked()) m.tripFor[d.key] = m.bulkTrip;
    },
    async importMileIq() {
      const m = this.mileiq;
      const drives = this.mileIqTicked().map((d) => ({ key: d.key, tripId: m.tripFor[d.key] || '' }));
      if (!drives.length) return this.flash('Tick the drives to import first.', 'bad');
      if (!m.expenseId || !m.paidFromId) return this.flash('Choose the expense account and what paid for the driving first.', 'bad');
      const rate = m.rate && m.rate !== m.preview.rates.business ? m.rate : undefined;
      m.busy = true;
      try {
        const r = await this.run(() => api('POST', `${this.tripBase()}/mileiq/import`, { content: m.file.content, drives, newTripName: m.newTripName, rate,
          expenseAccountId: m.expenseId, paidFromAccountId: m.paidFromId }));
        if (r) {
          this.flash(`Imported ${r.drives} drive${r.drives === 1 ? '' : 's'} (${r.miles} mi) as ${r.costs} cost${r.costs === 1 ? '' : 's'}, ${money(r.amountCents)} in all.`);
          Object.assign(m, { file: null, preview: null, pick: {}, tripFor: {}, bulkTrip: '' });
          await this.loadTrips();
        }
      } finally { m.busy = false; }
    },
    async openTrip(id) {
      const t = await this.run(() => api('GET', `${this.tripBase()}/trips/${id}`));
      if (t) { this.trip.cur = t; this.trip.photoView = null; }
    },
    closeTripView() { Object.assign(this.trip, { cur: null, form: null, editing: false, cost: null, editCostId: null, travel: null, photoView: null }); this.loadTrips(); },
    newTrip() { Object.assign(this.trip, { cur: null, form: blankTrip(), editing: false }); },
    editTrip() {
      const t = this.trip.cur;
      this.trip.form = { name: t.name, startDate: t.startDate, endDate: t.endDate ?? '', notes: t.notes ?? '',
        jobs: t.jobs.length ? t.jobs.map((j) => ({ jobId: j.jobId, share: j.share })) : [{ jobId: '', share: '' }] };
      this.trip.editing = true;
    },
    /** Shares typed so far, in percent (for the running total under the table). */
    tripShareTotal() { return (this.trip.form?.jobs ?? []).reduce((s, j) => s + (Number(j.share) || 0), 0); },
    /** Split the trip evenly across the projects listed (100 / N, the last one taking the rounding). */
    evenShares() {
      const rows = this.trip.form.jobs.filter((j) => j.jobId);
      if (!rows.length) return;
      const each = Math.floor(10000 / rows.length);
      rows.forEach((j, i) => { const bp = i === rows.length - 1 ? 10000 - each * (rows.length - 1) : each; j.share = (bp / 100).toFixed(2).replace(/\.?0+$/, ''); });
    },
    async saveTrip() {
      const tr = this.trip; const f = tr.form;
      const body = { ...f, endDate: f.endDate || null, jobs: f.jobs.filter((j) => j.jobId || j.share) };
      const r = tr.editing
        ? await this.run(() => api('PATCH', `${this.tripBase()}/trips/${tr.cur.id}`, body), 'Trip saved.')
        : await this.run(() => api('POST', `${this.tripBase()}/trips`, body), 'Trip added. Now add its costs.');
      if (r) { tr.cur = r; tr.form = null; tr.editing = false; }
    },
    async toggleTripOpen() {
      const t = this.trip.cur;
      const r = await this.run(() => api('PATCH', `${this.tripBase()}/trips/${t.id}`, { isActive: !t.isActive }), t.isActive ? 'Trip closed.' : 'Trip reopened.');
      if (r) this.trip.cur = r;
    },
    /** Miles × rate per mile → cents, half-up, exactly like the server (BigInt). */
    mileageCents(c) {
      const m = /^\s*(\d{0,6})(?:\.(\d{1,2}))?\s*$/.exec(c.miles ?? ''); const r = /^\s*\$?(\d{0,2})(?:\.(\d{1,4}))?\s*$/.exec(c.mileRate ?? '');
      if (!m || !r || (!m[1] && !m[2]) || (!r[1] && !r[2])) return null;
      const n = (BigInt(m[1] || 0) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))) * (BigInt(r[1] || 0) * 10000n + BigInt((r[2] ?? '').padEnd(4, '0')));
      return Number((n * 2n + 10000n) / 20000n);
    },
    tripPaidFromAccounts() { return this.accounts.filter((a) => a.isActive && (a.cashFlow === 'cash' || a.subtype === 'credit_card' || (a.type === 'equity' && a.key !== 'retained_earnings'))); },
    tripExpenseAccounts() { return this.accounts.filter((a) => a.isActive && a.type === 'expense'); },
    newTripCost() {
      const last = this.trip.cur.costs.filter((x) => x.status === 'posted').at(-1);
      const c = blankTripCost(last?.date ?? this.trip.cur.startDate);
      c.expenseAccountId = last?.expenseAccountId ?? this.tripExpenseAccounts().find((a) => /travel/i.test(a.name))?.id ?? '';
      c.paidFromAccountId = last?.paidFromAccountId ?? this.tripPaidFromAccounts().find((a) => a.subtype === 'credit_card')?.id ?? '';
      c.mileRate = lastMileRate();
      Object.assign(this.trip, { cost: c, editCostId: null, travel: null });
    },
    editTripCost(x) {
      Object.assign(this.trip, { editCostId: x.id, travel: null, cost: { ...blankTripCost(x.date), kind: x.kind, vendor: x.vendor ?? '', description: x.description,
        miles: x.miles ?? '', mileRate: x.mileRateCents != null ? String(Number(x.mileRateCents) / 100) : '',
        amount: (x.amountCents / 100).toFixed(2), expenseAccountId: x.expenseAccountId, paidFromAccountId: x.paidFromAccountId, keptPhotos: x.photoCount } });
    },
    async addTripCostPhotos(e) {
      const files = [...(e.target.files ?? [])]; e.target.value = '';
      const c = this.trip.cost; c.photoBusy = true;
      try { for (const f of files) if (c.photos.length + (c.keptPhotos ?? 0) < 6) c.photos.push(await pictureFromFile(f, { maxSide: PHOTO_SIDE })); }
      catch (err) { this.flash(err.message, 'bad'); } finally { c.photoBusy = false; }
    },
    async saveTripCost() {
      const tr = this.trip; const c = tr.cost;
      const body = { date: c.date, kind: c.kind, vendor: c.vendor, description: c.description, amount: c.amount, miles: c.miles, mileRate: c.mileRate,
        expenseAccountId: c.expenseAccountId, paidFromAccountId: c.paidFromAccountId };
      if (c.kind === 'mileage') keepMileRate(c.mileRate);
      if (!c.roadItem) keepCardFor(c.kind, c.paidFromAccountId);
      if (c.roadItem) {
        const { date, kind, vendor, description, amount, miles, mileRate } = body;
        const done = await this.saveRoadEdit(c.roadItem, { date, kind, vendor, description, amount, miles, mileRate },
          { expenseAccountId: c.expenseAccountId, paidFromAccountId: c.paidFromAccountId });
        if (!done) return;
        keepRoadAccounts({ expenseId: c.expenseAccountId, paidFromId: this.road.paidFromId || c.paidFromAccountId });
        keepCardFor(c.kind, c.paidFromAccountId);
        for (const picture of c.photos) await this.run(() => api('POST', `${this.tripBase()}/trip-costs/${done.costId}/photos`, { picture }));
        tr.cost = null;
        return this.openTrip(tr.cur.id);
      }
      const r = tr.editCostId
        ? await this.run(() => api('PUT', `${this.tripBase()}/trip-costs/${tr.editCostId}`, body, { 'Idempotency-Key': c.key }), 'Cost corrected.')
        : await this.run(() => api('POST', `${this.tripBase()}/trips/${tr.cur.id}/costs`, body, { 'Idempotency-Key': c.key }), 'Cost saved.');
      if (!r) return;
      // The receipt photos go up after the cost is saved (each is up to 3 MB).
      const costId = r.costId ?? r.costs.filter((x) => x.status === 'posted').find((x) => x.description === body.description && x.date === body.date)?.id;
      let failed = 0;
      for (const picture of c.photos) if (!costId || !(await this.run(() => api('POST', `${this.tripBase()}/trip-costs/${costId}/photos`, { picture })))) failed++;
      if (failed) this.flash(`The cost is saved, but ${failed} receipt photo${failed === 1 ? '' : 's'} could not be. Add ${failed === 1 ? 'it' : 'them'} from the cost's photos.`, 'bad');
      tr.cost = null; tr.editCostId = null;
      await this.openTrip(tr.cur.id);
    },
    async voidTripCost(x) {
      if (!confirm(`Void ${x.description} (${money(x.amountCents)})? Its entry in your books is reversed; it stays on record, marked void.`)) return;
      const r = await this.run(() => api('POST', `${this.tripBase()}/trip-costs/${x.id}/void`, {}), 'Cost voided.');
      if (r) this.trip.cur = r;
    },
    async openTripPhotos(x) {
      const photos = (await this.run(() => api('GET', `${this.tripBase()}/trip-costs/${x.id}/photos`))) ?? [];
      this.trip.photoView = { cost: x, photos, busy: false };
    },
    tripPhotoUrl(x, ph) { return `/api${this.tripBase()}/trip-costs/${x.id}/photos/${ph.id}`; },
    async uploadTripPhotos(e) {
      const files = [...(e.target.files ?? [])]; e.target.value = '';
      const v = this.trip.photoView; v.busy = true;
      try {
        for (const f of files) {
          const picture = await pictureFromFile(f, { maxSide: PHOTO_SIDE });
          if (!(await this.run(() => api('POST', `${this.tripBase()}/trip-costs/${v.cost.id}/photos`, { picture }), 'Photo saved.'))) break;
        }
      } catch (err) { this.flash(err.message, 'bad'); } finally { v.busy = false; }
      await this.openTripPhotos(v.cost); await this.openTrip(this.trip.cur.id); this.trip.photoView = this.trip.photoView ?? v;
    },
    async removeTripPhoto(ph) {
      if (!confirm('Remove this photo?')) return;
      const v = this.trip.photoView;
      if (await this.run(() => api('DELETE', `${this.tripBase()}/trip-costs/${v.cost.id}/photos/${ph.id}`), 'Photo removed.')) await this.openTripPhotos(v.cost);
    },
    newTravel() { Object.assign(this.trip, { travel: { date: this.trip.cur.startDate, hours: '', start: '', end: '', breaks: '', notes: '' }, cost: null }); },
    clockTime,
    /** One day's travel: the hours, or start and end less breaks. "Save, then next day" keeps the times for the next date. */
    async saveTravel(next = false) {
      const t = this.trip.travel; const clock = clockTime(t.start, t.end, t.breaks);
      if (clock?.error) { this.flash(clock.error, 'bad'); return; }
      const body = clock ? { date: t.date, start: t.start, end: t.end, breaks: t.breaks, notes: t.notes } : { date: t.date, hours: t.hours, notes: t.notes };
      if (t.roadItem) {
        if (await this.saveRoadEdit(t.roadItem, clock ? body : { ...body, start: '', end: '', breaks: '' })) this.trip.travel = null;
        return;
      }
      const r = await this.run(() => (t.editId
        ? api('PATCH', `${this.tripBase()}/trips/${this.trip.cur.id}/travel-time/${t.editId}`, body)
        : api('POST', `${this.tripBase()}/trips/${this.trip.cur.id}/travel-time`, body)), 'Travel time saved.');
      if (!r) return;
      this.trip.cur = r;
      this.trip.travel = next ? { ...t, editId: null, date: nextDay(t.date), hours: clock ? '' : t.hours } : null;
    },
    /** Fix a day of travel time (a wrong date, say): the same form, filled in. Breaks are what the times leave over. */
    editTravel(x) {
      const span = x.start && x.end ? clockTime(x.start, x.end, '')?.minutes : null;
      const breaks = span && span > x.minutes ? hhmm(span - x.minutes) : '';
      Object.assign(this.trip, { travel: { editId: x.id, date: x.date, hours: x.start ? '' : x.hours, start: x.start ?? '', end: x.end ?? '', breaks, notes: x.notes ?? '' }, cost: null });
    },
    async removeTravel(x) {
      if (!confirm(`Delete ${x.hours} h of travel time on ${x.date}?`)) return;
      const r = await this.run(() => api('DELETE', `${this.tripBase()}/trips/${this.trip.cur.id}/travel-time/${x.id}`), 'Travel time deleted.');
      if (r) this.trip.cur = r;
    },
    /** Which invoices have billed a trip cost or hour, by project: "2601 on invoice 2601A". */
    billedText(x) {
      return (x.billed ?? []).map((b) => `${this.ar.jobs.find((j) => j.id === b.jobId)?.code ?? 'project'} on invoice ${b.number}`).join(', ');
    },
    // ---------------------------------------------------------------- Pull in unbilled time and costs
    async openPull() {
      const d = this.ar.doc;
      if (!d.jobId && !d.contactId) { this.flash('Choose the project (or the customer) first.', 'bad'); return; }
      const service = this.items.find((x) => x.kind === 'service'); const expense = this.items.find((x) => x.kind === 'expense');
      this.ar.pull = { from: '', to: '', time: [], costs: [], tripCosts: [], pick: {}, loaded: false,
        serviceItemId: service?.id ?? '', expenseItemId: expense?.id ?? '', accountId: service?.accountId ?? this.incomeAccounts()[0]?.id ?? '' };
      await this.loadPull();
    },
    async loadPull() {
      const d = this.ar.doc; const pl = this.ar.pull;
      const q = new URLSearchParams(d.jobId ? { jobId: d.jobId } : { customerId: d.contactId });
      if (pl.from) q.set('from', pl.from);
      if (pl.to) q.set('to', pl.to);
      const r = await this.run(() => api('GET', `${this.arBase()}/unbilled?${q}`));
      if (!r) return;
      // Anything already on this form (pulled earlier, or kept from the invoice being edited) is left out.
      // A trip's time or cost is keyed with its project too (each project bills its own share).
      const onForm = new Set(d.lines.flatMap((l) => [l.timeEntryId && `t${l.timeEntryId}${l.jobId || ''}`, l.billedLineId && `c${l.billedLineId}`,
        l.tripCostId && `p${l.tripCostId}${l.jobId}`]).filter(Boolean));
      pl.time = r.time.filter((x) => !onForm.has(this.pullKey('t', x))); pl.costs = r.costs.filter((x) => !onForm.has(`c${x.id}`));
      pl.tripCosts = r.tripCosts.filter((x) => !onForm.has(this.pullKey('p', x)));
      pl.pick = Object.fromEntries([...pl.time.map((x) => [this.pullKey('t', x), true]), ...pl.costs.map((x) => [`c${x.id}`, true]),
        ...pl.tripCosts.map((x) => [this.pullKey('p', x), true])]);
      pl.loaded = true;
    },
    pullKey(kind, x) { return kind === 't' ? `t${x.id}${x.lineJobId || ''}` : `p${x.id}${x.jobId}`; },
    pullCount() { return Object.values(this.ar.pull?.pick ?? {}).filter(Boolean).length; },
    addPulled() {
      const d = this.ar.doc; const pl = this.ar.pull;
      const svc = this.items.find((x) => x.id === pl.serviceItemId); const exp = this.items.find((x) => x.id === pl.expenseItemId);
      const people = new Set(pl.time.filter((x) => pl.pick[this.pullKey('t', x)]).map((x) => x.userName));
      const manyJobs = !d.jobId;
      const tag = (x) => (manyJobs && x.jobCode ? ` (${x.jobCode})` : '');
      const lines = [
        ...pl.time.filter((x) => pl.pick[this.pullKey('t', x)]).map((x) => ({ ...blankLine(), itemId: svc?.id ?? '', serviceDate: x.date,
          description: (x.tripName ? `Travel, ${x.tripName}${x.notes ? `: ${x.notes}` : ''} (${x.share}% of ${x.fullHours} h)${tag(x)}`
            : `${people.size > 1 ? `${x.userName}: ` : ''}${x.notes || x.jobName}${tag(x)}`).slice(0, 300), quantity: x.quantity, qtyTyped: true,
          unitPrice: svc?.rateCents != null ? (svc.rateCents / 100).toFixed(2) : '', taxable: !!svc?.taxable, accountId: svc?.accountId ?? pl.accountId,
          timeEntryId: x.id, jobId: x.lineJobId || '', from: x.tripName ? `trip ${x.tripName}, ${x.share}%` : `timesheet, ${x.hours} h` })),
        // A trip cost: the full cost as the price, the project's share as the quantity (type a different share to override).
        ...pl.tripCosts.filter((x) => pl.pick[this.pullKey('p', x)]).map((x) => ({ ...blankLine(), itemId: exp?.id ?? '', serviceDate: x.date,
          description: `${x.description} (${x.share}% of trip ${x.tripName})${tag(x)}`.slice(0, 300), quantity: x.quantity, qtyTyped: true,
          unitPrice: (x.amountCents / 100).toFixed(2), taxable: !!exp?.taxable, accountId: exp?.accountId ?? pl.accountId,
          tripCostId: x.id, jobId: x.jobId, from: `trip ${x.tripName}, ${x.share}%` })),
        ...pl.costs.filter((x) => pl.pick[`c${x.id}`]).map((x) => ({ ...blankLine(), itemId: exp?.id ?? '', serviceDate: x.date,
          description: `${x.description || x.vendorName}${tag(x)}`.slice(0, 300), quantity: '1', qtyTyped: true, unitPrice: (x.amountCents / 100).toFixed(2),
          taxable: !!exp?.taxable, accountId: exp?.accountId ?? pl.accountId, billedLineId: x.id, from: `bill ${x.billNumber} · ${x.vendorName}` })),
      ];
      if (!lines.length) return;
      if (lines.some((l) => !l.accountId)) { this.flash('Choose an income account for these lines.', 'bad'); return; }
      // The empty starting line is replaced; lines already typed stay.
      d.lines = [...d.lines.filter((l) => l.accountId || l.unitPrice || l.description), ...lines];
      this.sortLines();
      this.ar.pull = null;
      this.flash(`Added ${lines.length} line${lines.length === 1 ? '' : 's'}. Check the rates, then save.`);
    },
    // ---------------------------------------------------------------- Old invoices from a PDF (Homer's Excel layout)
    dropOldInvoice(e) { this.ar.pdfOver = false; return this.readOldInvoice(e.dataTransfer?.files?.[0]); },
    chooseOldInvoice(e) { const f = e.target.files?.[0]; e.target.value = ''; return this.readOldInvoice(f); },
    /** The server reads the PDF; the answer fills a New invoice form. Nothing is saved until Save. */
    async readOldInvoice(file) {
      if (!file || this.ar.pdfBusy) return;
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { this.flash('Choose the invoice as a PDF.', 'bad'); return; }
      this.ar.pdfBusy = true;
      try {
        const pdf = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
        const r = await this.run(() => api('POST', `/companies/${this.companyId}/invoices/read-pdf`, { pdf }));
        if (!r) return;
        this.newDoc();
        const d = this.ar.doc;
        Object.assign(d, { number: r.number ?? '', date: r.date ?? d.date, dueDate: r.dueDate ?? '', careOf: r.careOf ?? '', project: r.project ?? '',
          taxRate: r.taxRate ?? '', contactId: r.customerId ?? '', fromPdf: { file: file.name, totalCents: r.totalCents ?? 0, problems: r.problems ?? [] } });
        const income = this.newLine().accountId;
        d.lines = r.lines.map((l) => ({ ...blankLine(), ...l, accountId: income, qtyTyped: true }));
        if (!d.lines.length) d.lines = [this.newLine()];
        this.sortLines();
        // A customer not saved yet: the customer form pops up with the Bill To name and address filled in.
        if (!r.customerId && r.customerName) {
          this.quickAddContact('doc');
          Object.assign(this.ar.contact, { name: r.customerName.slice(0, 120), address: (r.address ?? '').split('\n').join(', ').slice(0, 500), termsDays: r.termsDays ?? this.ar.contact.termsDays });
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } finally { this.ar.pdfBusy = false; }
    },
    newContact() {
      const open = this.ar.showContact && !this.ar.contact.id;
      this.ar.contact = blankContact(); this.ar.showContact = !open; this.ar.contactPopup = false;
    },
    // "+ Add new customer…" in the invoice's (or bill's) list, or a project's: the customer form pops up over it;
    // saving picks the new customer there (saveContact), Cancel leaves the list as it was before.
    quickAddContact(forWhat) {
      Object.assign(this.ar, { contact: blankContact(), showContact: true, contactPopup: forWhat });
      if (forWhat === 'proj') this.ar.proj.form.customerId = ''; else this.ar.doc.contactId = '';
    },
    closeContact() { Object.assign(this.ar, { showContact: false, contactPopup: false }); },
    // Edit a customer or vendor: the same form, filled in; saving sends only the form's fields (PATCH).
    editContact(c) {
      this.ar.contact = { id: c.id, name: c.name, email: c.email ?? '', phone: c.phone ?? '', address: c.address ?? '', termsDays: c.termsDays, is1099: !!c.is1099,
        isHomeowner: !!c.isHomeowner, noLateCharges: !!c.noLateCharges, groupName: c.groupName ?? '', people: (c.people ?? []).map((p) => ({ name: p.name, email: p.email ?? '', phone: p.phone ?? '' })) };
      this.ar.showContact = true; this.ar.contactPopup = false;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async saveContact() {
      const { id, ...fields } = this.ar.contact;
      if (this.S.kind !== 'bill') delete fields.is1099;
      else { delete fields.isHomeowner; delete fields.noLateCharges; }
      const r = id
        ? await this.run(() => api('PATCH', `${this.arBase()}/contacts/${id}`, fields), `${this.S.Who} updated.`)
        : await this.run(() => api('POST', `${this.arBase()}/${this.S.contacts}`, fields), `${this.S.Who} added.`);
      if (!r) return;
      const forWhat = this.ar.contactPopup;
      this.ar.contact = blankContact(); this.closeContact();
      if (!id && forWhat === 'proj') this.ar.proj.form.customerId = r.id;
      else if (!id && this.ar.showDoc && !this.ar.doc.contactId) this.ar.doc.contactId = r.id;
      this.loadAr();
    },
    addPerson() { this.ar.contact.people.push(blankPerson()); },
    // The people (claims adjusters) saved on the customer chosen on the invoice form.
    docPeople() { return this.ar.contacts.find((c) => c.id === this.ar.doc.contactId)?.people ?? []; },
    docPersonIsNew() {
      const name = this.ar.doc.attention.trim().toLowerCase();
      return !!name && !this.docPeople().some((p) => p.name.toLowerCase() === name);
    },
    // Picking a saved adjuster fills in where the invoice is sent.
    pickAttention() {
      const p = this.docPeople().find((x) => x.name.toLowerCase() === this.ar.doc.attention.trim().toLowerCase());
      if (p?.email) this.ar.doc.sendTo = p.email;
    },
    async toggleContactActive(c) {
      if (await this.run(() => api('PATCH', `${this.arBase()}/contacts/${c.id}`, { isActive: !c.isActive }))) this.loadAr();
    },
    newDoc() {
      const invoice = this.S.kind === 'invoice';
      this.ar.doc = blankDoc(invoice ? this.company?.default_sales_tax_rate ?? '' : '');
      this.ar.showDoc = true; this.ar.showPay = false; this.ar.detail = null; this.ar.pull = null;
      if (invoice) { this.loadItems(); this.ar.doc.lines = [this.newLine()]; }
    },
    // ---------------------------------------------------------------- Invoice setup: saved rates, sales tax, letterhead, logo
    async loadItems(all = false) { this.items = (await this.run(() => api('GET', `/companies/${this.companyId}/invoice-items${all ? '?all=1' : ''}`))) ?? []; },
    /**
     * A new invoice line starts on the income account used last on this computer (or Service Revenue) and the date of
     * the line above. Bills start empty: their lines are expenses chosen each time.
     */
    /** Invoice lines in date order, oldest first (Homer, Oct 2026); lines without a date stay at the bottom.
     *  Runs after a date is changed, a line is added, and before saving. The sort is stable, so same-day lines keep their order. */
    sortLines() {
      if (this.S.kind !== 'invoice') return;
      this.ar.doc.lines.sort((a, b) => (!a.serviceDate) - (!b.serviceDate) || (a.serviceDate < b.serviceDate ? -1 : a.serviceDate > b.serviceDate ? 1 : 0));
    },
    addLine() { this.ar.doc.lines.push(this.newLine()); this.sortLines(); },
    newLine() {
      const l = blankLine();
      if (this.S.kind !== 'invoice') return l;
      const income = this.incomeAccounts();
      let last = null; try { last = localStorage.getItem(`zacc.lastIncome.${this.companyId}`); } catch { /* private window */ }
      l.accountId = income.find((a) => a.id === last)?.id ?? income.find((a) => a.code === '4100')?.id ?? '';
      l.serviceDate = this.ar.doc.lines?.at(-1)?.serviceDate || '';
      return l;
    },
    /** A saved rate was picked on an invoice line: fill in its price, tax and income account (all still changeable). */
    pickItem(l) {
      // "+ Add new rate…": the rate form pops up; saving it picks the new rate on this line (saveItem).
      if (l.itemId === NEW_CONTACT) { l.itemId = ''; Object.assign(this.inv, { popupLine: l, editId: null, item: { ...blankItem(), accountId: l.accountId } }); return; }
      const it = this.items.find((x) => x.id === l.itemId);
      if (!it) return;
      l.accountId = it.accountId; l.taxable = it.taxable;
      if (it.rateCents != null) l.unitPrice = (it.rateCents / 100).toFixed(2);
      if (it.kind === 'expense') { l.quantity = this.shareText(); l.qtyTyped = false; }
      if (!l.serviceDate) { l.serviceDate = this.ar.doc.date; this.sortLines(); }
    },
    /** Expenses split evenly across jobs: "1" for one job, "1/3" for three. Never fewer than 1 job. */
    shareText() { const n = Math.max(1, Math.floor(Number(this.ar.doc.splitJobs) || 1)); return n === 1 ? '1' : `1/${n}`; },
    setSplitJobs() {
      this.ar.doc.splitJobs = Math.max(1, Math.min(99, Math.floor(Number(this.ar.doc.splitJobs) || 1)));
      const q = this.shareText();
      // A quantity typed by hand on a line is the user's override: leave it alone.
      for (const l of this.ar.doc.lines) if (!l.qtyTyped && this.items.find((x) => x.id === l.itemId)?.kind === 'expense') l.quantity = q;
    },
    itemLabel(it) { return `${it.name}${it.rateCents != null ? ` · ${this.money(it.rateCents)}${it.kind === 'service' ? '/hr' : ''}` : ''}`; },
    async pinTaxRate() {
      const rate = String(this.ar.doc.taxRate ?? '').trim();
      const r = await this.run(() => api('PUT', `/companies/${this.companyId}/default-tax-rate`, { rate }),
        rate ? `New invoices will start with ${rate}% sales tax.` : 'New invoices will start with no sales tax rate.');
      if (r) this.company = { ...this.company, default_sales_tax_rate: r.defaultSalesTaxRate };
    },
    incomeAccounts() { return this.accounts.filter((a) => a.isActive && a.type === 'revenue'); },
    editItem(it) { this.inv.editId = it.id; this.inv.item = { name: it.name, kind: it.kind, rate: it.rateCents == null ? '' : (it.rateCents / 100).toFixed(2), taxable: it.taxable, accountId: it.accountId }; },
    cancelItem() { Object.assign(this.inv, { editId: null, item: blankItem(), popupLine: null }); },
    async saveItem() {
      const v = this.inv.item; const id = this.inv.editId;
      const r = await this.run(() => (id ? api('PATCH', `/companies/${this.companyId}/invoice-items/${id}`, v) : api('POST', `/companies/${this.companyId}/invoice-items`, v)),
        id ? 'Rate saved.' : 'Rate added.');
      if (!r) return;
      const line = this.inv.popupLine;
      this.cancelItem();
      // From an invoice line's "+ Add new rate…": pick the new rate on that line.
      if (line) { await this.loadItems(); line.itemId = r.id; this.pickItem(line); } else this.loadItems(true);
    },
    /** A saved rate with no price yet: keep the price typed on this invoice line as the rate's price. */
    async saveLinePrice(l) {
      const it = this.itemOf(l);
      if (!it || !l.unitPrice) return;
      if (await this.run(() => api('PATCH', `/companies/${this.companyId}/invoice-items/${it.id}`, { rate: l.unitPrice }), `${it.name} is now ${money(Math.round(Number(l.unitPrice) * 100))}.`)) await this.loadItems();
    },
    itemOf(l) { return this.items.find((x) => x.id === l.itemId); },
    async toggleItem(it) {
      if (await this.run(() => api('PATCH', `/companies/${this.companyId}/invoice-items/${it.id}`, { isActive: !it.isActive }))) this.loadItems(true);
    },
    async addStarterItems() {
      const accountId = this.inv.item.accountId || this.incomeAccounts().find((a) => /service/i.test(a.name))?.id || this.incomeAccounts()[0]?.id;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/invoice-items/starter`, { accountId }));
      if (r) { this.flash(r.added ? `Added ${r.added} rates. Type in your prices next.` : 'You already have all of them.'); this.loadItems(true); }
    },
    editLetterhead() {
      const c = this.company ?? {};
      this.inv.letterhead = { address: c.invoice_address ?? '', note: c.invoice_note ?? '', footer: c.invoice_footer ?? '' };
    },
    async saveLetterhead() {
      const r = await this.run(() => api('PUT', `/companies/${this.companyId}/letterhead`, this.inv.letterhead), 'Letterhead saved.');
      if (r) { this.company = { ...this.company, invoice_address: r.address, invoice_note: r.note, invoice_footer: r.footer }; this.editLetterhead(); }
    },
    async loadLateSettings() {
      const r = await this.run(() => api('GET', `/companies/${this.companyId}/late-charges/settings`));
      if (r) this.inv.late = { apr: r.apr ?? '', fee: r.feeCents ? (r.feeCents / 100).toFixed(2) : '', graceDays: r.graceDays, holidayGraceDays: r.holidayGraceDays };
    },
    async saveLateSettings() {
      const r = await this.run(() => api('PUT', `/companies/${this.companyId}/late-charges/settings`, this.inv.late),
        'Late-charge settings saved.');
      if (r) this.loadLateSettings();
    },
    logoUrl() { return this.company?.logoVersion ? `/api/companies/${this.companyId}/logo?v=${this.company.logoVersion}` : null; },
    chooseLogo(e) { const file = e.target.files?.[0]; e.target.value = ''; return this.saveLogo(file); },
    dropLogo(e) { this.inv.logoOver = false; return this.saveLogo(e.dataTransfer?.files?.[0]); },
    async saveLogo(file) {
      if (!file || this.inv.logoBusy) return;
      if (!['image/png', 'image/jpeg'].includes(file.type)) { this.flash('The logo must be a PNG or JPEG picture.', 'bad'); return; }
      this.inv.logoBusy = true;
      try {
        const picture = await pictureFromFile(file, { maxSide: 600, type: 'image/png' });
        const r = await this.run(() => api('PUT', `/companies/${this.companyId}/logo`, { picture }), 'Logo saved.');
        if (r) this.company = { ...this.company, logoVersion: Date.now() };
      } catch (err) { this.flash(err.message, 'bad'); } finally { this.inv.logoBusy = false; }
    },
    async removeLogo() {
      if (!confirm('Remove the logo from your invoices?')) return;
      if (await this.run(() => api('PUT', `/companies/${this.companyId}/logo`, { picture: null }), 'Logo removed.')) this.company = { ...this.company, logoVersion: null };
    },
    // Edit an invoice or bill: the form, filled in from the saved one. Saving voids it and posts the corrected copy.
    editDoc(doc) {
      const invoice = this.S.kind === 'invoice';
      const dollars = (c) => (c / 100).toFixed(2);
      this.ar.doc = { ...blankDoc(doc.taxRate ?? ''), editId: doc.id, editNumber: doc.number, contactId: doc.contactId, number: doc.number,
        date: doc.date, dueDate: doc.plan ? '' : doc.dueDate ?? '', planCount: doc.plan ? String(doc.plan.count) : '', planFirstDue: doc.plan?.firstDue ?? '', noLateCharges: !!doc.noLateCharges, memo: doc.memo ?? '', project: doc.project ?? '', jobId: doc.jobId ?? '',
        attention: doc.attention ?? '', careOf: doc.careOf ?? '', sendTo: doc.sendTo ?? '', clientRef: doc.clientRef ?? '',
        lines: doc.lines.map((l) => ({ ...blankLine(), itemId: l.itemId ?? '', serviceDate: l.serviceDate ?? '', accountId: l.accountId,
          description: l.description ?? '', quantity: l.quantity ?? '1', unitPrice: dollars(l.unitPriceCents), taxable: !!l.taxable, qtyTyped: true,
          jobId: l.jobId ?? '', billable: !!l.billable, timeEntryId: l.timeEntryId ?? '', billedLineId: l.billedLineId ?? '', tripCostId: l.tripCostId ?? '',
          from: l.tripCostId || (l.timeEntryId && l.jobId) ? 'a trip' : l.timeEntryId ? 'timesheet' : l.billedLineId ? 'a bill' : '' })) };
      this.ar.showDoc = true; this.ar.showPay = false; this.ar.detail = null;
      if (invoice) this.loadItems();
      this.ar.pull = null;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async saveDoc() {
      const d = this.ar.doc;
      this.sortLines();
      // A line counts once something is typed or picked on it (a new invoice line starts with its income account filled in).
      const lines = d.lines.filter((l) => l.unitPrice || l.description?.trim() || l.itemId || (l.accountId && this.S.kind === 'bill')).map((l) => ({ accountId: l.accountId, description: l.description, quantity: l.quantity || '1',
        unitPrice: l.unitPrice, taxable: l.taxable, serviceDate: l.serviceDate || undefined, itemId: l.itemId || undefined,
        jobId: l.jobId || undefined, billable: !!l.jobId && l.billable, timeEntryId: l.timeEntryId || undefined, billedLineId: l.billedLineId || undefined,
        tripCostId: l.tripCostId || undefined }));
      const body = { contactId: d.contactId, number: d.number || undefined, date: d.date, dueDate: d.dueDate || undefined, memo: d.memo,
        project: this.S.kind === 'invoice' ? d.project : undefined, jobId: this.S.kind === 'invoice' ? d.jobId || undefined : undefined,
        taxRate: d.taxRate || undefined, lines };
      if (this.S.kind === 'invoice') Object.assign(body, { attention: d.attention, careOf: d.careOf, sendTo: d.sendTo, clientRef: d.clientRef,
        plan: String(d.planCount || '').trim() ? { count: d.planCount, firstDue: d.planFirstDue } : undefined, noLateCharges: !!d.noLateCharges });
      const newPerson = this.S.kind === 'invoice' && d.savePerson && this.docPersonIsNew()
        ? { name: d.attention.trim(), email: d.sendTo.trim(), phone: '' } : null;
      const customer = this.ar.contacts.find((c) => c.id === d.contactId);
      const r = d.editId
        ? await this.run(() => api('PUT', `${this.arBase()}/documents/${d.editId}`, body, { 'Idempotency-Key': d.key }), `${this.S.Doc} ${d.editNumber} corrected.`)
        : await this.run(() => api('POST', `${this.arBase()}/${this.S.docPath}`, body, { 'Idempotency-Key': d.key }), `${this.S.Doc} saved.`);
      if (!r) return;
      const income = lines.find((l) => l.accountId)?.accountId;
      if (this.S.kind === 'invoice' && income) try { localStorage.setItem(`zacc.lastIncome.${this.companyId}`, income); } catch { /* private window */ }
      if (r.numberWasTaken) this.flash(`Saved as invoice ${r.number} (${r.numberWasTaken} was already used).`);
      // A new adjuster typed on the invoice is added to the customer, for next time.
      if (newPerson && customer) {
        await this.run(() => api('PATCH', `${this.arBase()}/contacts/${customer.id}`, { people: [...(customer.people ?? []), newPerson] }));
      }
      this.ar.showDoc = false; this.ar.doc = blankDoc(); this.ar.panel = 'docs'; this.ar.view = 'open';
      await this.loadAr();
      this.ar.detail = r;
    },
    // Opens the computer's email program (Outlook, Mail…) with the invoice's address and subject filled in.
    // The PDF is attached by hand: print the invoice to PDF first.
    emailLink(doc) {
      const subject = [`Invoice ${doc.number}`, doc.clientRef ? `Claim/Job ${doc.clientRef}` : '', doc.project ? doc.project.split('\n')[0] : '']
        .filter(Boolean).join(' · ');
      const hello = doc.attention ? `${doc.attention},` : 'Hello,';
      const body = `${hello}\n\nAttached is invoice ${doc.number} for ${this.money(doc.totalCents)}, due ${doc.dueDate}.\n\nThank you,\n${this.company?.name ?? ''}`;
      return `mailto:${encodeURIComponent(doc.sendTo ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    },
    openEmail(doc) { window.location.href = this.emailLink(doc); },
    async openDoc(d) { this.ar.details = null; this.ar.detail = await this.run(() => api('GET', `${this.arBase()}/documents/${d.id}`)); },
    startDetails(d) {
      this.ar.details = { memo: d.memo ?? '', dueDate: d.dueDate, clientRef: d.clientRef ?? '', planCount: d.plan ? String(d.plan.count) : '', planFirstDue: d.plan?.firstDue ?? '',
        noLateCharges: !!d.noLateCharges };
    },
    async saveDetails() {
      const d = this.ar.detail;
      const { planCount, planFirstDue, ...body } = this.ar.details;
      if (this.S.kind === 'invoice') body.plan = String(planCount || '').trim() ? { count: planCount, firstDue: planFirstDue } : null;
      else delete body.noLateCharges;
      if (body.plan) delete body.dueDate; // a plan sets the due date to its last payment
      const r = await this.run(() => api('PATCH', `/companies/${this.companyId}/documents/${d.id}`, body), 'Details changed. The amounts stay as they were.');
      if (r) { this.ar.detail = { ...d, ...r }; this.ar.details = null; this.loadAr(); }
    },
    async voidDoc(d) {
      if (!confirm(`Void ${this.S.Doc.toLowerCase()} ${d.number}? Its entry is reversed; this can't be undone.`)) return;
      const r = await this.run(() => api('POST', `${this.arBase()}/documents/${d.id}/void`, {}), `${this.S.Doc} ${d.number} voided.`);
      if (r) { if (this.ar.detail?.id === d.id) this.ar.detail = r; this.loadAr(); }
    },
    async startPay(contactId = '') {
      this.ar.pay = blankPay(); this.ar.pay.accountId = this.payAccounts[0]?.id ?? '';
      this.ar.showPay = true; this.ar.showDoc = false; this.ar.detail = null;
      if (contactId) { this.ar.pay.contactId = contactId; await this.loadPayDocs(); }
    },
    async loadPayDocs() {
      const p = this.ar.pay;
      p.open = p.contactId ? ((await this.run(() => api('GET', `${this.arBase()}/${this.S.docPath}?status=open&contactId=${p.contactId}`))) ?? []).reverse() : [];
      p.amounts = {};
    },
    // Edit a payment: the form, filled in. The invoices it paid are listed with their balance before this payment.
    async editPay(p) {
      this.ar.pay = { ...blankPay(), editId: p.id, contactId: p.contactId, date: p.date, accountId: p.accountId, method: p.method || 'check',
        reference: p.reference ?? '', memo: p.memo ?? '', keptPhotos: p.photoCount ?? 0 };
      this.ar.showPay = true; this.ar.showDoc = false; this.ar.detail = null;
      await this.loadPayDocs();
      const pay = this.ar.pay;
      for (const a of p.applications) {
        const d = pay.open.find((x) => x.id === a.documentId);
        if (d) d.balanceCents += a.amountCents;
        else {
          const full = await this.run(() => api('GET', `${this.arBase()}/documents/${a.documentId}`));
          if (full) pay.open.push({ ...full, balanceCents: full.balanceCents + a.amountCents });
        }
        pay.amounts[a.documentId] = (a.amountCents / 100).toFixed(2);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    payInFull() { for (const d of this.ar.pay.open) this.ar.pay.amounts[d.id] = (d.balanceCents / 100).toFixed(2); },
    async savePay() {
      const p = this.ar.pay;
      const applications = p.open.filter((d) => cents(p.amounts[d.id]) > 0).map((d) => ({ documentId: d.id, amount: p.amounts[d.id] }));
      const body = { contactId: p.contactId, date: p.date, accountId: p.accountId, method: p.method, reference: p.reference, memo: p.memo, applications };
      const r = p.editId
        ? await this.run(() => api('PUT', `${this.arBase()}/payments/${p.editId}`, body, { 'Idempotency-Key': p.key }), `Payment corrected: ${money(this.payTotal)}.`)
        : await this.run(() => api('POST', `${this.arBase()}/${this.S.payPath}`, body, { 'Idempotency-Key': p.key }), `Payment of ${money(this.payTotal)} recorded.`);
      if (!r) return;
      // Then the photos, one at a time (each is up to a few hundred KB). The payment is already saved either way.
      let failed = 0;
      for (const picture of p.photos) {
        if (!(await this.run(() => api('POST', `${this.arBase()}/payments/${r.id}/photos`, { picture })))) failed++;
      }
      if (failed) this.flash(`The payment is saved, but ${failed} photo${failed === 1 ? '' : 's'} could not be. Add ${failed === 1 ? 'it' : 'them'} from the Payments tab.`, 'bad');
      // A check from the road: mark it done and copy the phone's photos to the payment.
      if (p.roadItem && !p.editId) await this.run(() => api('POST', `${this.arBase()}/road-items/${p.roadItem.id}/accept-check`, { paymentId: r.id }));
      this.ar.showPay = false; this.ar.pay = blankPay(); this.loadAr();
    },
    /** 📋 Paste beside a photo box: the copied screenshot or photo goes to that box's own handler, as if chosen. */
    async pastePhotos(handler) {
      let files;
      try { files = await picturesFromClipboard(); } catch (err) { this.flash(err.message, 'bad'); return; }
      await this[handler]({ target: { files, value: '' } });
    },
    /** Photos picked or taken for the payment being entered: shrunk now, sent after the payment is saved. */
    // A photo is shrunk in the browser; a PDF (a deposit confirmation, an emailed remittance) goes as it is, 3 MB at most.
    async payAttachment(f) {
      if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return pictureFromFile(f, { maxSide: PHOTO_SIDE });
      if (f.size > 3_145_728) throw new Error(`${f.name} is larger than 3 MB.`);
      return new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).replace(/^data:[^;,]*/, 'data:application/pdf')); r.onerror = fail; r.readAsDataURL(f); });
    },
    isPdf(ph) { return typeof ph === 'string' ? ph.startsWith('data:application/pdf') : ph?.type === 'application/pdf'; },
    async addPayPhotos(e) {
      const files = [...(e.target.files ?? [])]; e.target.value = '';
      const pay = this.ar.pay; pay.photoBusy = true;
      try { for (const f of files) if (pay.photos.length + pay.keptPhotos < 6) pay.photos.push(await this.payAttachment(f)); }
      catch (err) { this.flash(err.message, 'bad'); } finally { pay.photoBusy = false; }
      if (pay.photos.length + pay.keptPhotos >= 6) this.flash('A payment can have at most 6 photos.');
    },
    photoUrl(p, ph) { return `/api${this.arBase()}/payments/${p.id}/photos/${ph.id}`; },
    async openPhotos(p) {
      const photos = (await this.run(() => api('GET', `${this.arBase()}/payments/${p.id}/photos`))) ?? [];
      this.ar.photoView = { payment: p, photos, busy: false };
    },
    async uploadPhotos(e) {
      const files = [...(e.target.files ?? [])]; e.target.value = '';
      const v = this.ar.photoView; v.busy = true;
      try {
        for (const f of files) {
          const picture = await this.payAttachment(f);
          if (!(await this.run(() => api('POST', `${this.arBase()}/payments/${v.payment.id}/photos`, { picture }), this.isPdf(picture) ? 'PDF saved.' : 'Photo saved.'))) break;
        }
      } catch (err) { this.flash(err.message, 'bad'); } finally { v.busy = false; }
      await this.openPhotos(v.payment); this.loadAr();
    },
    async removePhoto(ph) {
      if (!confirm('Remove this photo?')) return;
      const v = this.ar.photoView;
      if (await this.run(() => api('DELETE', `${this.arBase()}/payments/${v.payment.id}/photos/${ph.id}`), 'Photo removed.')) { await this.openPhotos(v.payment); this.loadAr(); }
    },
    async voidPay(p) {
      if (!confirm(`Void this ${money(p.amountCents)} payment (for example, a bounced check)? The ${this.S.docs.toLowerCase()} it paid become open again.`)) return;
      if (await this.run(() => api('POST', `${this.arBase()}/payments/${p.id}/void`, {}), 'Payment voided.')) this.loadAr();
    },
    // An invoice on a payment plan shows its next payment's date instead of the date it is due in full.
    dueShown(d) { return d.plan?.next ? `${d.plan.next.dueDate} (plan ${d.plan.next.n} of ${d.plan.count})` : d.dueDate; },
    todayIso() { return today(); },
    planPreview(totalCents, count, firstDue) {
      const n = Number(String(count || '').trim());
      if (!Number.isInteger(n) || n < 2 || n > 60 || totalCents <= 0) return '';
      const each = Math.floor(totalCents / n);
      const last = firstDue ? (() => { const [y, m, d] = firstDue.split('-').map(Number); const t = y * 12 + m - 1 + n - 1; return `${(t % 12) + 1}/${Math.min(d, new Date(Date.UTC(Math.floor(t / 12), (t % 12) + 1, 0)).getUTCDate())}/${Math.floor(t / 12)}`; })() : '';
      return `${n} payments of ${this.money(each)}${totalCents - each * n ? ' (a cent more on the first ones)' : ''}, monthly${last ? `, the last on ${last}` : ''}. No interest.`;
    },
    statusLabel(s) { return { open: 'Open', partial: 'Partly paid', overdue: 'Overdue', paid: 'Paid', void: 'Void' }[s] ?? s; },
    acctName(id) { const a = this.accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; },
    async pickStatement(ev) {
      const f = ev.target.files[0];
      this.bank.preview = null;
      if (!f) return;
      // A PDF statement goes to the server as base64 and is read there; CSV and QFX go as text.
      const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
      if (f.size > (isPdf ? 8_000_000 : 5_000_000)) { this.flash(`That file is larger than ${isPdf ? 8 : 5} MB. Download a shorter date range.`, 'bad'); return; }
      this.bank.file = isPdf
        ? { name: f.name, pdf: await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(f); }) }
        : { name: f.name, content: await f.text() };
      this.bank.preview = await this.run(() => api('POST', `/companies/${this.companyId}/bank-accounts/${this.bank.accountId}/import`,
        { fileName: f.name, content: this.bank.file.content, pdf: this.bank.file.pdf, preview: true }));
    },
    async importStatement() {
      const b = this.bank;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-accounts/${b.accountId}/import`, { fileName: b.file.name, content: b.file.content, pdf: b.file.pdf }));
      if (!r) return;
      this.flash(`Imported ${r.new} transaction${r.new === 1 ? '' : 's'}${r.duplicates ? ` (${r.duplicates} already imported, skipped)` : ''}.`);
      b.file = null; b.preview = null; b.view = 'review';
      if (this.$refs.statementFile) this.$refs.statementFile.value = '';
      this.loadBank();
    },
    async postBankTx(t) {
      const accountId = this.bank.choice[t.id];
      if (!accountId) { this.flash('Choose an account first.', 'bad'); return; }
      if (await this.run(() => api('POST', `/companies/${this.companyId}/bank-transactions/${t.id}/post`, { accountId }))) {
        this.bank.txs = this.bank.txs.filter((x) => x.id !== t.id);
      }
    },
    // Choosing an account for one line fills the same account into every other waiting line from the same payee
    // (ATMOS, BLUECOSMO… repeat each month) that has nothing chosen yet, or was filled the same way before.
    chooseBankAccount(t) {
      const b = this.bank; const key = payeeKey(t.description); const out = t.amountCents < 0;
      delete b.sameAs[t.id];
      if (!key) return;
      let n = 0;
      for (const x of b.txs) {
        if (x.id === t.id || payeeKey(x.description) !== key || (x.amountCents < 0) !== out) continue;
        if (b.choice[x.id] && !b.sameAs[x.id]) continue; // chosen by hand or by a rule: leave it
        b.choice[x.id] = b.choice[t.id];
        if (b.choice[t.id]) { b.sameAs[x.id] = key; n++; } else delete b.sameAs[x.id];
      }
      if (n) this.flash(`Also chose it for ${n} other ${key.toUpperCase()} line${n === 1 ? '' : 's'}. Check them, then Add.`);
    },
    bankChosen() { return this.bank.txs.filter((t) => this.bank.choice[t.id]); },
    async postAllChosen() {
      const list = this.bankChosen();
      if (!list.length || !confirm(`Add ${list.length} line${list.length === 1 ? '' : 's'} to the books, each to the account chosen beside it?`)) return;
      let done = 0;
      for (const t of list) {
        const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-transactions/${t.id}/post`, { accountId: this.bank.choice[t.id] }));
        if (!r) break; // the error is shown; the rest stay waiting
        this.bank.txs = this.bank.txs.filter((x) => x.id !== t.id);
        done++;
      }
      if (done) this.flash(`Added ${done} line${done === 1 ? '' : 's'} to the books.`);
    },
    // A rule for this payee, so next month's statement arrives already filled in.
    payeeRuleText(t) { return payeeRuleText(t.description); },
    hasPayeeRule(t) {
      const text = payeeRuleText(t.description);
      return !text || this.bank.rules.some((r) => t.description.toLowerCase().includes(r.matchText.toLowerCase()));
    },
    async rememberPayee(t) {
      const body = { matchText: payeeRuleText(t.description), direction: t.amountCents > 0 ? 'in' : 'out', accountId: this.bank.choice[t.id] };
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-rules`, body));
      if (!r) return;
      this.bank.rules = (await this.run(() => api('GET', `/companies/${this.companyId}/bank-rules`))) ?? this.bank.rules;
      this.flash(`From now on, lines with “${body.matchText}” come in with ${this.acctName(body.accountId)} chosen.`);
    },
    async findBankMatches(t) {
      const m = await this.run(() => api('GET', `/companies/${this.companyId}/bank-transactions/${t.id}/matches`));
      if (m) this.bank.matches = { ...this.bank.matches, [t.id]: m };
      if (m && !m.length) this.flash('No entry in the books has this exact amount within 10 days.', 'bad');
    },
    async matchBankTx(t, e) {
      if (await this.run(() => api('POST', `/companies/${this.companyId}/bank-transactions/${t.id}/match`, { entryId: e.id }), `Matched to entry #${e.number}.`)) {
        this.bank.txs = this.bank.txs.filter((x) => x.id !== t.id);
      }
    },
    async excludeBankTx(t) {
      const reason = prompt('Why leave this out of the books? (e.g. "duplicate", "personal — paid back")');
      if (!reason) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/bank-transactions/${t.id}/exclude`, { reason }))) {
        this.bank.txs = this.bank.txs.filter((x) => x.id !== t.id);
      }
    },
    async undoBankTx(t) {
      const what = t.status === 'posted' ? `This reverses entry #${t.entryNumber} and puts the bank transaction back in the review list.` : 'This puts the bank transaction back in the review list.';
      if (!confirm(what)) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/bank-transactions/${t.id}/undo`, {}), 'Moved back to review.')) this.loadBank();
    },
    editRule(r) { this.bank.newRule = { id: r.id, matchText: r.matchText, direction: r.direction, accountId: r.accountId, min: r.minCents != null ? (Number(r.minCents) / 100).toFixed(2) : '', max: r.maxCents != null ? (Number(r.maxCents) / 100).toFixed(2) : '', priority: r.priority }; },
    async addRule() {
      const nr = this.bank.newRule;
      if (nr.id) {
        const { id, ...body } = nr;
        if (await this.run(() => api('PUT', `/companies/${this.companyId}/bank-rules/${id}`, body), 'Rule saved. It changes suggestions from now on.')) {
          this.bank.newRule = { matchText: '', direction: 'out', accountId: '' }; this.loadBank();
        }
        return;
      }
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-rules`, this.bank.newRule));
      if (!r) return;
      this.flash(r.applied ? `Rule saved. It suggested an account for ${r.applied} waiting transaction${r.applied === 1 ? '' : 's'}.` : 'Rule saved.');
      this.bank.newRule = { matchText: '', direction: 'out', accountId: '' };
      this.loadBank();
    },
    async deleteRule(r) {
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/bank-rules/${r.id}`), 'Rule removed.')) this.loadBank();
    },
    async startRecon() {
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-accounts/${this.bank.accountId}/reconciliations`, this.bank.newRecon));
      if (r) { this.bank.newRecon = { statementDate: '', endingBalance: '' }; this.loadBank(); }
    },
    async tickRecon(l) {
      const b = this.bank;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/reconciliations/${b.recon.id}/lines`, { lineIds: [l.id], cleared: !l.cleared }));
      if (r) b.recon = r;
    },
    async tickAllRecon(cleared) {
      const b = this.bank;
      const ids = b.recon.lines.filter((l) => l.cleared !== cleared).map((l) => l.id);
      if (!ids.length) return;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/reconciliations/${b.recon.id}/lines`, { lineIds: ids, cleared }));
      if (r) b.recon = r;
    },
    async finishRecon() {
      if (await this.run(() => api('POST', `/companies/${this.companyId}/reconciliations/${this.bank.recon.id}/complete`, {}), 'Reconciled. This statement is now locked in.')) this.loadBank();
    },
    async reopenRecon(r) {
      const reason = prompt(`Reopen the ${this.usDate(r.statementDate)} reconciliation? Your ticks stay, ready to fix. Why is it being reopened?`);
      if (!reason) return;
      if (await this.run(() => api('POST', `/companies/${this.companyId}/reconciliations/${r.id}/reopen`, { reason }), 'Reopened. Fix it, then finish it again.')) this.loadBank();
    },
    async undoImport(i) {
      if (!confirm(`Undo the import of ${i.fileName || 'this file'}? Its ${i.undoable} line${i.undoable === 1 ? '' : 's'} still waiting for review will be removed.`)) return;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-imports/${i.batch}/undo`, {}));
      if (r) { this.flash(`Removed ${r.removed} line${r.removed === 1 ? '' : 's'}${r.kept ? `; ${r.kept} already in the books stay` : ''}.`); this.loadBank(); }
    },
    async cancelRecon() {
      if (!confirm('Cancel this reconciliation? Your ticks will be cleared; nothing in the books changes.')) return;
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/reconciliations/${this.bank.recon.id}`), 'Cancelled.')) this.loadBank();
    },
    async verifyAudit() { this.audit = await this.run(() => api('GET', `/companies/${this.companyId}/audit/verify`)); },
  },
})
  .use({
    install(app) {
      // A mistake in a screen's own code: record it for Beta feedback and tell the person, instead of a blank or frozen screen.
      app.config.errorHandler = (err, vm) => {
        noteError('screen', err?.message ?? String(err));
        console.error(err);
        window.zaccBootError?.(err?.message ?? err); // shown by boot.js if the first screen never appears
        vm?.$root?.flash?.('Something on this screen went wrong. Your saved work is safe; reload the page. 🐞 Beta feedback will send us the details.', 'bad');
      };
    },
  })
  .mount('#app');
