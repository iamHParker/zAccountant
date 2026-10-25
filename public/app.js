// zAccountant browser app (Vue 3, no build step).
// ℹ️ Vue keeps the page in sync with the data below: change `this.tab` and the screen switches.
import { createApp } from '/vendor/vue.js';
import { HELP, helpForTab, searchHelp } from '/help.js';
import { startRecorder, noteError, captureContext, pictureOfScreen, pictureFromFile } from '/feedback.js';

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
  const m = /^(\d{1,9})(?:\.(\d{1,4}))?$/.exec(String(qty || '1').trim());
  if (p == null || !m) return null;
  const n = (BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'))) * BigInt(p);
  return Number((n * 2n + 10000n) / 20000n);
}
/** Sales tax on taxable cents at a percent like "8.25", half-up. */
function taxCents(taxable, pct) {
  const m = /^(\d+)(?:\.(\d{0,4}))?$/.exec(String(pct ?? '').trim());
  if (!m) return 0;
  const ppm = BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'));
  return Number((BigInt(taxable) * ppm * 2n + 1000000n) / 2000000n);
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
const blankLine = () => ({ itemId: '', serviceDate: '', accountId: '', description: '', quantity: '1', unitPrice: '', taxable: false });
const blankDoc = (taxRate = '') => ({ contactId: '', number: '', date: today(), dueDate: '', memo: '', project: '', taxRate, splitJobs: 1, lines: [blankLine()], key: newKey() });
const blankItem = () => ({ name: '', kind: 'service', rate: '', taxable: false, accountId: '' });
const blankContact = () => ({ name: '', email: '', phone: '', address: '', termsDays: 30, is1099: false });
const blankPay = () => ({ contactId: '', date: today(), accountId: '', method: 'check', reference: '', memo: '', open: [], amounts: {}, key: newKey() });

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
  home: ['view_books'], journal: ['view_books'], sales: ['view_books', 'invoices'], bills: ['view_books', 'bills'], bank: ['view_books'],
  reports: ['view_books', 'payroll'], accounts: ['view_books'], payroll: ['view_books', 'payroll'], time: ['time_own', 'time_approve', 'time_all'],
  setup: ['admin'],
};

// Tabs that need a feature of the company's plan (src/core/plans.js on the server).
const TAB_FEATURE = { payroll: 'payroll', time: 'timesheets' };

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
});

createApp({
  data() {
    return {
      companies: [], companyId: null, company: null, tab: 'home', message: null,
      auth: { screen: 'loading', user: null, email: '', password: '', name: '', code: '', setup: null, recoveryCodes: null, useRecovery: false },
      members: [], newMember: { email: '', role: 'bookkeeper', departmentId: '' },
      roleLabels: { owner: 'Owner', accountant: 'Accountant', bookkeeper: 'Bookkeeper', viewer: 'Viewer (read only)' },
      months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      tabs: [
        { id: 'home', label: 'Home' }, { id: 'journal', label: 'Transactions' }, { id: 'sales', label: 'Sales' }, { id: 'bills', label: 'Bills' }, { id: 'bank', label: 'Banking' },
        { id: 'reports', label: 'Reports' }, { id: 'time', label: 'Time' },
        { id: 'accounts', label: 'Accounts' }, { id: 'payroll', label: 'Payroll' }, { id: 'settings', label: 'Settings' },
      ],
      help: { q: '', id: 'start', from: 'home' },
      version: '',
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
        asset: [['current', 'Current asset (prepaid, deposits…)'], ['bank', 'Bank or cash account'], ['receivable', 'Money owed to you'], ['fixed', 'Equipment, vehicle, building'], ['contra', 'Accumulated depreciation'], ['investment', 'Long-term investment']],
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
      items: [], inv: { item: blankItem(), editId: null, letterhead: { address: '', note: '', footer: '' }, logoBusy: false, logoOver: false },
      lockDate: '', suiRate: '', famliCount: null, audit: null, futaCr: {},
      imp: { show: false, kind: 'journal', asOf: '', file: null, preview: null, problems: null, busy: false, history: [] },
      importKinds: [
        { id: 'accounts', label: 'Chart of accounts', template: 'chart-of-accounts.csv', help: 'QuickBooks: Reports → Account List → Export to Excel/CSV. Or fill in our template.' },
        { id: 'opening', label: 'Opening balances (trial balance)', template: 'opening-balances.csv', help: 'Balances on the day before you start in zAccountant. QuickBooks: Reports → Trial Balance as of that day → Export.' },
        { id: 'journal', label: 'Transactions (journal)', template: 'journal-entries.csv', help: 'QuickBooks: Reports → Journal for the date range → Export to CSV. Or fill in our template (one row per line; rows with the same Entry number form one entry).' },
        { id: 'iif', label: 'QuickBooks Desktop IIF file', template: null, help: 'QuickBooks Desktop: File → Utilities → Export → Lists/Transactions to IIF. Accounts in the file are created automatically.' },
      ],
      ar: { panel: 'docs', view: 'open', docs: [], contacts: [], payments: [], aging: null, agingAsOf: today(), detail: null,
        showContact: false, contact: blankContact(), showDoc: false, doc: blankDoc(), showPay: false, pay: blankPay() },
      bank: { accountId: '', file: null, preview: null, txs: [], view: 'review', choice: {}, matches: {}, rules: [], newRule: { matchText: '', direction: 'out', accountId: '' },
        recons: [], recon: null, newRecon: { statementDate: '', endingBalance: '' } },
    };
  },
  computed: {
    S() { return SIDES[this.tab] ?? SIDES.sales; },
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
      if (t === 'settings') { this.editFutaCr(); this.editLetterhead(); if (this.can('admin')) this.loadItems(true); this.loadAccess(); if (this.can('view_books') || this.can('admin')) this.loadMembers(); if (this.can('view_books')) this.loadBooksCheck(); }
      if (t === 'home') this.loadDash();
      if (t === 'setup') this.loadSetup();
      if (t === 'bank') this.loadBank();
      if (t === 'sales' || t === 'bills') { Object.assign(this.ar, { view: 'open', detail: null, aging: null, docs: [], payments: [], contacts: [] }); this.ar.showDoc = this.ar.showPay = this.ar.showContact = false; this.loadAr(); }
      if (t === 'accounts') this.loadImports();
      if (t === 'time') this.loadTime(true);
    },
    'quick.kind'() { this.quick.other = ''; },
  },
  async mounted() {
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
      if (this.can('admin')) this.setup.status = await api('GET', `/companies/${this.companyId}/setup`).catch(() => null);
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
    async openRegister(a) { this.register = await this.run(() => api('GET', `/companies/${this.companyId}/accounts/${a.id}/register`)); },
    async createEmployee() {
      const e = this.newEmp;
      // An exempt claim is kept with the year it covers (it lapses after February 15 of the next year).
      const exemptOnly = (x) => { const { exempt, exemptYear, ...rest } = x; return exempt ? { ...rest, exempt: true, exemptYear } : rest; };
      const stateElections = { CA: exemptOnly(e.ca), CO: e.co.annualAllowance ? e.co : {}, DC: e.dc };
      const w4 = exemptOnly({ ...e.w4, dependentsCredit: e.w4.dependentsCredit || '0', extraWithholding: e.w4.extraWithholding || '0' });
      const body = { ssn: e.ssn || undefined, firstName: e.firstName, lastName: e.lastName, workState: e.workState, payFrequency: e.payFrequency, payType: e.payType, payRate: e.payRate, w4, stateElections: { [e.workState]: stateElections[e.workState] } };
      const ok = await this.run(() => api('POST', `/companies/${this.companyId}/employees`, body), 'Employee saved.');
      if (ok) { this.newEmp = blankEmployee(); this.showNewEmp = false; this.loadEmployees(); }
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
      b.matches = {};
      b.rules = (await this.run(() => api('GET', `/companies/${this.companyId}/bank-rules`))) ?? [];
      b.recons = (await this.run(() => api('GET', `${base}/reconciliations`))) ?? [];
      const open = b.recons.find((r) => r.status === 'open');
      b.recon = open ? await this.run(() => api('GET', `/companies/${this.companyId}/reconciliations/${open.id}`)) : null;
    },
    lineCents,
    // ---------------------------------------------------------------- Sales & Bills
    arBase() { return `/companies/${this.companyId}`; },
    async loadAr() {
      const ar = this.ar; const S = this.S; const base = this.arBase();
      ar.contacts = (await this.run(() => api('GET', `${base}/${S.contacts}`))) ?? [];
      if (ar.panel === 'docs') ar.docs = (await this.run(() => api('GET', `${base}/${S.docPath}?status=${ar.view}`))) ?? [];
      if (ar.panel === 'payments') ar.payments = (await this.run(() => api('GET', `${base}/${S.payPath}`))) ?? [];
      if (ar.panel === 'aging') ar.aging = await this.run(() => api('GET', `${base}/reports/${S.agingPath}?asOf=${ar.agingAsOf}`));
    },
    arPanel(p) { this.ar.panel = p; this.ar.detail = null; this.loadAr(); },
    newContact() {
      const open = this.ar.showContact && !this.ar.contact.id;
      this.ar.contact = blankContact(); this.ar.showContact = !open;
    },
    // Edit a customer or vendor: the same form, filled in; saving sends only the form's fields (PATCH).
    editContact(c) {
      this.ar.contact = { id: c.id, name: c.name, email: c.email ?? '', phone: c.phone ?? '', address: c.address ?? '', termsDays: c.termsDays, is1099: !!c.is1099 };
      this.ar.showContact = true;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async saveContact() {
      const { id, ...fields } = this.ar.contact;
      if (this.S.kind !== 'bill') delete fields.is1099;
      const r = id
        ? await this.run(() => api('PATCH', `${this.arBase()}/contacts/${id}`, fields), `${this.S.Who} updated.`)
        : await this.run(() => api('POST', `${this.arBase()}/${this.S.contacts}`, fields), `${this.S.Who} added.`);
      if (!r) return;
      this.ar.contact = blankContact(); this.ar.showContact = false;
      if (!id && this.ar.showDoc && !this.ar.doc.contactId) this.ar.doc.contactId = r.id;
      this.loadAr();
    },
    async toggleContactActive(c) {
      if (await this.run(() => api('PATCH', `${this.arBase()}/contacts/${c.id}`, { isActive: !c.isActive }))) this.loadAr();
    },
    newDoc() {
      const invoice = this.S.kind === 'invoice';
      this.ar.doc = blankDoc(invoice ? this.company?.default_sales_tax_rate ?? '' : '');
      this.ar.showDoc = true; this.ar.showPay = false; this.ar.detail = null;
      if (invoice) this.loadItems();
    },
    // ---------------------------------------------------------------- Invoice setup: saved rates, sales tax, letterhead, logo
    async loadItems(all = false) { this.items = (await this.run(() => api('GET', `/companies/${this.companyId}/invoice-items${all ? '?all=1' : ''}`))) ?? []; },
    /** A saved rate was picked on an invoice line: fill in its price, tax and income account (all still changeable). */
    pickItem(l) {
      const it = this.items.find((x) => x.id === l.itemId);
      if (!it) return;
      l.accountId = it.accountId; l.taxable = it.taxable;
      if (it.rateCents != null) l.unitPrice = (it.rateCents / 100).toFixed(2);
      if (it.kind === 'expense') { l.quantity = this.shareText(); l.qtyTyped = false; }
      if (!l.serviceDate) l.serviceDate = this.ar.doc.date;
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
    cancelItem() { this.inv.editId = null; this.inv.item = blankItem(); },
    async saveItem() {
      const v = this.inv.item; const id = this.inv.editId;
      const r = await this.run(() => (id ? api('PATCH', `/companies/${this.companyId}/invoice-items/${id}`, v) : api('POST', `/companies/${this.companyId}/invoice-items`, v)),
        id ? 'Rate saved.' : 'Rate added.');
      if (r) { this.cancelItem(); this.loadItems(true); }
    },
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
        date: doc.date, dueDate: doc.dueDate ?? '', memo: doc.memo ?? '', project: doc.project ?? '',
        lines: doc.lines.map((l) => ({ ...blankLine(), itemId: l.itemId ?? '', serviceDate: l.serviceDate ?? '', accountId: l.accountId,
          description: l.description ?? '', quantity: l.quantity ?? '1', unitPrice: dollars(l.unitPriceCents), taxable: !!l.taxable, qtyTyped: true })) };
      this.ar.showDoc = true; this.ar.showPay = false; this.ar.detail = null;
      if (invoice) this.loadItems();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    async saveDoc() {
      const d = this.ar.doc;
      const lines = d.lines.filter((l) => l.accountId || l.unitPrice).map((l) => ({ accountId: l.accountId, description: l.description, quantity: l.quantity || '1',
        unitPrice: l.unitPrice, taxable: l.taxable, serviceDate: l.serviceDate || undefined, itemId: l.itemId || undefined }));
      const body = { contactId: d.contactId, number: d.number || undefined, date: d.date, dueDate: d.dueDate || undefined, memo: d.memo,
        project: this.S.kind === 'invoice' ? d.project : undefined, taxRate: d.taxRate || undefined, lines };
      const r = d.editId
        ? await this.run(() => api('PUT', `${this.arBase()}/documents/${d.editId}`, body, { 'Idempotency-Key': d.key }), `${this.S.Doc} ${d.editNumber} corrected.`)
        : await this.run(() => api('POST', `${this.arBase()}/${this.S.docPath}`, body, { 'Idempotency-Key': d.key }), `${this.S.Doc} saved.`);
      if (!r) return;
      this.ar.showDoc = false; this.ar.doc = blankDoc(); this.ar.panel = 'docs'; this.ar.view = 'open';
      await this.loadAr();
      this.ar.detail = r;
    },
    async openDoc(d) { this.ar.detail = await this.run(() => api('GET', `${this.arBase()}/documents/${d.id}`)); },
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
        reference: p.reference ?? '', memo: p.memo ?? '' };
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
      this.ar.showPay = false; this.ar.pay = blankPay(); this.loadAr();
    },
    async voidPay(p) {
      if (!confirm(`Void this ${money(p.amountCents)} payment (for example, a bounced check)? The ${this.S.docs.toLowerCase()} it paid become open again.`)) return;
      if (await this.run(() => api('POST', `${this.arBase()}/payments/${p.id}/void`, {}), 'Payment voided.')) this.loadAr();
    },
    statusLabel(s) { return { open: 'Open', partial: 'Partly paid', overdue: 'Overdue', paid: 'Paid', void: 'Void' }[s] ?? s; },
    acctName(id) { const a = this.accounts.find((x) => x.id === id); return a ? `${a.code} · ${a.name}` : ''; },
    async pickStatement(ev) {
      const f = ev.target.files[0];
      this.bank.preview = null;
      if (!f) return;
      if (f.size > 5_000_000) { this.flash('That file is larger than 5 MB. Download a shorter date range.', 'bad'); return; }
      this.bank.file = { name: f.name, content: await f.text() };
      this.bank.preview = await this.run(() => api('POST', `/companies/${this.companyId}/bank-accounts/${this.bank.accountId}/import`,
        { fileName: f.name, content: this.bank.file.content, preview: true }));
    },
    async importStatement() {
      const b = this.bank;
      const r = await this.run(() => api('POST', `/companies/${this.companyId}/bank-accounts/${b.accountId}/import`, { fileName: b.file.name, content: b.file.content }));
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
    async addRule() {
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
        vm?.$root?.flash?.('Something on this screen went wrong. Your saved work is safe; reload the page. 🐞 Beta feedback will send us the details.', 'bad');
      };
    },
  })
  .mount('#app');
