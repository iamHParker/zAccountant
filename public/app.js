// zAccountant browser app (Vue 3, no build step).
// ℹ️ Vue keeps the page in sync with the data below: change `this.tab` and the screen switches.
import { createApp } from '/vendor/vue.js';

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

let onSignInNeeded = () => {};

async function api(method, url, body, headers = {}) {
  if (method !== 'GET' && body === undefined) body = {}; // writes are always JSON (server CSRF rule)
  const res = await fetch(`/api${url}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/auth/') && !url.includes('/lock')) onSignInNeeded(data.next);
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

// What each role may do (mirrors PERMISSIONS in src/app.js; the server is the real gatekeeper).
const CAN = {
  post: ['owner', 'accountant', 'bookkeeper'], accounts: ['owner', 'accountant'], close: ['owner', 'accountant'],
  payroll: ['owner', 'accountant'], audit: ['owner', 'accountant'], admin: ['owner'],
};

// One key per "Save" click: if the request is retried (double click, flaky Wi-Fi), the server posts it only once.
const newKey = () => crypto.randomUUID();
const blankSearch = () => ({ text: '', from: '', to: '', accountId: '', source: '' });
const blankRepeat = () => ({ on: false, name: '', frequency: 'monthly', endDate: '' });

const blankEmployee = () => ({
  firstName: '', lastName: '', ssn: '', workState: 'TX', payFrequency: 'biweekly', payType: 'hourly', payRate: '',
  w4: { formYear: 2020, allowances: 0, filingStatus: 'single', step2: false, dependentsCredit: '', extraWithholding: '' },
  ca: { filingStatus: 'single', allowances: 1 }, co: { annualAllowance: '' }, dc: { filingStatus: 'single', allowances: 0 },
});

createApp({
  data() {
    return {
      companies: [], companyId: null, company: null, tab: 'home', message: null,
      auth: { screen: 'loading', user: null, email: '', password: '', name: '', code: '', setup: null, recoveryCodes: null, useRecovery: false },
      members: [], newMember: { email: '', role: 'bookkeeper' },
      roleLabels: { owner: 'Owner', accountant: 'Accountant', bookkeeper: 'Bookkeeper', viewer: 'Viewer (read only)' },
      months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      tabs: [
        { id: 'home', label: 'Home' }, { id: 'journal', label: 'Transactions' }, { id: 'bank', label: 'Banking' }, { id: 'reports', label: 'Reports' },
        { id: 'accounts', label: 'Accounts' }, { id: 'payroll', label: 'Payroll' }, { id: 'settings', label: 'Settings' },
      ],
      typeLabel: { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Income', expense: 'Expense' },
      newCompany: { name: '', homeState: 'TX', fiscalYearStartMonth: 1 },
      accounts: [], dash: null, entries: [], entriesTotal: 0, search: blankSearch(), recurring: [], showRecurring: false, booksCheck: null,
      quick: { kind: 'out', date: today(), memo: '', amount: '', bank: '', other: '', key: newKey() },
      showJE: false, je: { date: today(), memo: '', key: newKey(), repeat: blankRepeat(), lines: [{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }] },
      reportTypes: [
        { id: 'balance-sheet', label: 'Balance Sheet' }, { id: 'income-statement', label: 'Profit & Loss' },
        { id: 'cash-flow', label: 'Cash Flow' }, { id: 'trial-balance', label: 'Trial Balance' },
      ],
      report: { type: 'balance-sheet', from: yearStart(), to: today(), data: null },
      showNewAcct: false, newAcct: { code: '', name: '', type: 'expense', subtype: 'operating' }, register: null,
      subtypeChoices: {
        asset: [['current', 'Current asset (prepaid, deposits…)'], ['bank', 'Bank or cash account'], ['receivable', 'Money owed to you'], ['fixed', 'Equipment, vehicle, building'], ['contra', 'Accumulated depreciation'], ['investment', 'Long-term investment']],
        liability: [['current', 'Due within a year'], ['payable', 'Bills you owe'], ['credit_card', 'Credit card'], ['long_term', 'Long-term loan']],
        equity: [['capital', 'Owner contribution'], ['draws', 'Owner draws / distributions']],
        revenue: [['operating', 'Sales or services'], ['other', 'Other income (interest…)']],
        expense: [['operating', 'Operating expense'], ['cogs', 'Cost of goods sold'], ['other', 'Other expense (interest…)']],
      },
      paychecks: [],
      employees: [], showNewEmp: false, newEmp: blankEmployee(),
      pc: { employee: null, payDate: today(), hours: '', overtimeHours: '', k401: '', paidFrom: '', result: null },
      lockDate: '', suiRate: '', famliCount: null, audit: null,
      bank: { accountId: '', file: null, preview: null, txs: [], view: 'review', choice: {}, matches: {}, rules: [], newRule: { matchText: '', direction: 'out', accountId: '' },
        recons: [], recon: null, newRecon: { statementDate: '', endingBalance: '' } },
    };
  },
  computed: {
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
    reportCheck() { return this.report.data?.check ?? 0; },
  },
  watch: {
    companyId() { this.loadCompany(); },
    tab(t) {
      if (t === 'reports') this.loadReport();
      if (t === 'journal') { this.loadEntries(); this.loadRecurring(); }
      if (t === 'payroll' || t === 'settings') this.loadEmployees();
      if (t === 'settings') { this.loadMembers(); this.loadBooksCheck(); }
      if (t === 'home') this.loadDash();
      if (t === 'bank') this.loadBank();
    },
    'quick.kind'() { this.quick.other = ''; },
  },
  async mounted() {
    onSignInNeeded = (next) => this.goAuth(next ?? 'signin');
    try {
      const me = await api('GET', '/auth/me');
      this.auth.user = me.user;
      if (me.next) return this.goAuth(me.next);
      await this.enterApp();
    } catch { this.goAuth('signin'); }
  },
  methods: {
    money,
    can(perm) { return Boolean(this.company && CAN[perm].includes(this.company.role)); },
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
      a.password = ''; a.user = r.user;
      this.goAuth(r.next);
    },
    async signUp() {
      const a = this.auth;
      const r = await this.run(() => api('POST', '/auth/signup', { email: a.email, password: a.password, name: a.name }));
      if (!r) return;
      a.password = ''; a.user = r.user;
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
    async loadMembers() { this.members = (await this.run(() => api('GET', `/companies/${this.companyId}/members`))) ?? []; },
    async addMember() {
      const m = await this.run(() => api('POST', `/companies/${this.companyId}/members`, this.newMember), 'Member saved.');
      if (m) { this.newMember = { email: '', role: 'bookkeeper' }; this.loadMembers(); }
    },
    async removeMember(m) {
      if (!confirm(`Remove ${m.name} from ${this.company.name}?`)) return;
      if (await this.run(() => api('DELETE', `/companies/${this.companyId}/members/${m.id}`), 'Removed.')) this.loadMembers();
    },
    printPage() { window.print(); },
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
      if (this.tab === 'new-company') this.tab = 'home';
      this.tab === 'home' ? this.loadDash() : this.$options.watch.tab.call(this, this.tab);
    },
    async loadDash() { if (this.companyId) this.dash = await this.run(() => api('GET', `/companies/${this.companyId}/reports/dashboard?asOf=${today()}`)); },
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
    },
    async createCompany() {
      const c = await this.run(() => api('POST', '/companies', this.newCompany), 'Company created. Your books are ready.');
      if (!c) return;
      this.companies.push(c); this.companyId = c.id; this.tab = 'home';
      this.newCompany = { name: '', homeState: 'TX', fiscalYearStartMonth: 1 };
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
      const q = r.type === 'income-statement' || r.type === 'cash-flow' ? `from=${r.from}&to=${r.to}` : `asOf=${r.to}`;
      r.data = await this.run(() => api('GET', `/companies/${this.companyId}/reports/${r.type}?${q}`));
    },
    async createAccount() {
      const a = await this.run(() => api('POST', `/companies/${this.companyId}/accounts`, this.newAcct), 'Account added.');
      if (a) { this.accounts = await api('GET', `/companies/${this.companyId}/accounts`); this.newAcct = { code: '', name: '', type: 'expense', subtype: 'operating' }; this.showNewAcct = false; }
    },
    async openRegister(a) { this.register = await this.run(() => api('GET', `/companies/${this.companyId}/accounts/${a.id}/register`)); },
    async createEmployee() {
      const e = this.newEmp;
      const stateElections = { CA: e.ca, CO: e.co.annualAllowance ? e.co : {}, DC: e.dc };
      const w4 = { ...e.w4, dependentsCredit: e.w4.dependentsCredit || '0', extraWithholding: e.w4.extraWithholding || '0' };
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
      if (c) this.company = c;
    },
    async saveSui() {
      const c = await this.run(() => api('PATCH', `/companies/${this.companyId}/settings`, { suiRatePct: this.suiRate }), 'Rate saved.');
      if (c) this.company = c;
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
}).mount('#app');
