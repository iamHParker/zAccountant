// zAccountant Road (Homer, 2026-10-25): the phone page for business trips. Vue 3, no build step, like app.js.
//
// ℹ️ How it works. Everything typed here is saved on the phone first (IndexedDB, the browser's own small database),
// so it survives no signal, a dead battery or closing the page. When there is signal it is sent to zAccountant with
// the phone's road key, item by item; each item carries its own id, so sending twice never makes two. At the desk,
// Trips → "From the road" shows what arrived; nothing is in the books until it is accepted there.
import { createApp } from '/vendor/vue.js';
// The screens (the HTML in road.html), compiled by the server into a render function (src/core/pages.js).
import { render } from '/road.render.js';
import { picturesFromClipboard } from '/paste.js';
import { clockTime, clock12, nextDay, durationMinutes, hhmm } from '/clock.js';
import { fillFromReceipt, filledText, droppedPictures } from '/receipt.js';
import { projectChoices, projectLabel as projectPickText } from '/projectPick.js';

const KEY_STORE = 'zacc.roadKey';
const SUMMARY_STORE = 'zacc.roadSummary';
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); // the phone's own date
};
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
const getLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const setLocal = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } };
const lastMileRate = () => getLocal('zacc.mileRate') ?? '';

// ---- The phone's own storage (IndexedDB): one record per item, photos inside it.
let dbPromise = null;
function idb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('zacc-road', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('items', { keyPath: 'clientId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function store(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('items', mode);
    const r = fn(tx.objectStore('items'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const allItems = () => store('readonly', (s) => s.getAll());
const putItem = (item) => store('readwrite', (s) => s.put(JSON.parse(JSON.stringify(item))));
const deleteItem = (id) => store('readwrite', (s) => s.delete(id));

/** A phone photo → a JPEG data URL at most 1600 px on its long side (a receipt stays readable; about 300 KB). */
async function shrinkPhoto(file) {
  const url = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
  const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale); canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

/** miles × rate, exactly as the server does it (half-up once, in cents). */
function mileageCents(miles, rate) {
  const m = /^(\d{0,6})(?:\.(\d{1,2}))?$/.exec(String(miles ?? '').trim()); // ".5" and "$.725" work too
  const r = /^\$?(\d{0,2})(?:\.(\d{1,4}))?$/.exec(String(rate ?? '').trim());
  if (!m || !r || (!m[1] && !m[2]) || (!r[1] && !r[2])) return null;
  const hundredthsMiles = BigInt(m[1] || 0) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  const tenThousandthsDollars = BigInt(r[1] || 0) * 10000n + BigInt((r[2] ?? '').padEnd(4, '0'));
  const n = hundredthsMiles * tenThousandthsDollars; // in 1/10000 of a cent
  return Number((n + 5000n) / 10000n);
}
const money = (c) => (c == null ? '' : `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
// The screens behind the four home buttons: title and icon colour (classes in styles.css, .road-icon.c-*).
const SCREENS = {
  check: { title: 'Check in', color: 'c-check' },
  trip: { title: 'Trip now', color: 'c-trip' },
  plan: { title: 'Future trip', color: 'c-plan' },
  time: { title: 'Time', color: 'c-time' },
  equipment: { title: 'Equipment', color: 'c-equip' },
  supplies: { title: 'Supplies', color: 'c-supply' },
  projects: { title: 'Projects', color: 'c-proj' },
};
// The project number at the front of a name, the way the server reads it (src/core/projects.js parseProjectFolder).
const leadingNumber = (name) => /^([A-Za-z]{0,3}\d[\d.-]*[A-Za-z]?)(?=$|[\s_–—:,;()-])/.exec(String(name ?? '').trim())?.[1].replace(/[.-]+$/, '') ?? '';
const NEW_CUSTOMER = '+new';
/** The "+ New project" choice in a form's project list (Homer, 2026-11-19). */
const NEW_PROJECT = '+newproject';
// Time in blocks (Homer, 2026-11-06): travel, site time, office/drafting; lunch is the gap between two blocks.
const BLOCK_TYPES = { travel: 'Travel', site: 'Site', office: 'Office / drafting' };
const BLOCK_ICON = { travel: '🚗', site: '🏗️', office: '📐' };
const keyRef = (k) => (k?.startsWith('c:') ? { clientId: k.slice(2) } : k?.startsWith('s:') ? { id: k.slice(2) } : null);
const KINDS = { airfare: 'Airfare', rental_car: 'Rental car', lodging: 'Lodging', meals: 'Meals', tolls: 'Tolls', mileage: 'Mileage', other: 'Other' };
// Bookings on a trip planned ahead (Homer, 2026-11-06): the reservation, not money. The words for its two dates.
const BOOKING_KINDS = { airfare: 'Flight', lodging: 'Hotel', rental_car: 'Rental car', other: 'Other' };
const BOOKING_ICON = { airfare: '✈', lodging: '🏨', rental_car: '🚗', other: '📌' };
const BOOKING_DATES = { airfare: ['Depart', 'Return'], lodging: ['Check in', 'Check out'], rental_car: ['Pick up', 'Drop off'], other: ['From', 'To'] };

class KeyProblem extends Error {}

createApp({
  render,
  data() {
    return {
      key: getLocal(KEY_STORE), pasted: '', keyProblem: '', message: null,
      summary: (() => { try { return JSON.parse(getLocal(SUMMARY_STORE) ?? 'null'); } catch { return null; } })(),
      online: navigator.onLine, syncing: false, syncAgain: false, busy: false,
      items: [], tripKey: getLocal('zacc.roadTrip') ?? '',
      tripForm: null, projectSearch: '', costForm: null, timeForm: null, checkForm: null, bookingForm: null, buyForm: null, blockForm: null, blockDay: today(), blockTypes: BLOCK_TYPES, blockIcon: BLOCK_ICON, kinds: KINDS, reading: false,
      bookingKinds: BOOKING_KINDS, bookingIcon: BOOKING_ICON, bookingDates: BOOKING_DATES,
      // Projects (Homer, 2026-11-16): look one up, or add one from the field.
      projectForm: null, customerForm: null, projectQuery: '', openProjectKey: '', projectTab: 'projects', customerQuery: '', openCustomerId: '', newCustomer: NEW_CUSTOMER, newProjectChoice: NEW_PROJECT,
      // A form left for "+ New project": { screen, formKey, form }. Saving the project brings it back, with the project picked.
      projectReturn: null,
      screen: 'home', screens: SCREENS,
      // Amounts start hidden (blurred) and the phone remembers the choice: someone beside you sees no deposit totals.
      hide: getLocal('zacc.roadHide') !== 'show',
    };
  },
  computed: {
    /** Open jobs for the time pick lists by job number, highest first (26-148 above 26-147); jobs with no number after, A to Z
     *  (Homer, 2026-11-15). Same order and labels as the desk's project drop-downs (public/projectPick.js). */
    projectsByNumber() { return projectChoices(this.summary?.projects); },
    waiting() { return this.items.filter((i) => this.notSent(i)).length; },
    checkItems() { return this.items.filter((i) => i.kind === 'check').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20); },
    /** Equipment or supplies on this phone for the screen showing (newest first). */
    buyItems() { return this.items.filter((i) => i.kind === 'purchase' && i.data.category === this.screen).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20); },
    buysWaiting() { return (cat) => this.items.filter((i) => i.kind === 'purchase' && i.data.category === cat && !['accepted', 'dismissed'].includes(i.status)).length; },
    checksWaiting() { return this.items.filter((i) => i.kind === 'check' && !['accepted', 'dismissed'].includes(i.status)).length; },
    tripName() {
      const ref = this.tripRef;
      if (!ref) return '';
      if (ref.clientId) return this.localTrips.find((t) => t.clientId === ref.clientId)?.data.name ?? '';
      return (this.summary?.trips ?? []).find((t) => t.id === ref.id)?.name ?? '';
    },
    /** Trips that start after today, from this phone and from zAccountant, soonest first. */
    upcomingTrips() { return this.tripChoices.ahead; },
    /** The Time screen lists only travel time; Trip now lists everything on the trip. */
    shownTripItems() { return this.tripEntries; },
    /** The day's blocks on this phone, in time order (blocks typed as hours only go last). */
    dayBlocks() {
      return this.items.filter((i) => i.kind === 'block' && i.data.date === this.blockDay)
        .sort((a, b) => (a.data.start ?? '99').localeCompare(b.data.start ?? '99') || a.createdAt.localeCompare(b.createdAt));
    },
    dayMinutes() { return this.dayBlocks.reduce((t, i) => t + this.blockMinutes(i.data), 0); },
    localTrips() { return this.items.filter((i) => i.kind === 'trip' && i.status !== 'dismissed'); },
    /**
     * Every trip to pick from, split into "Coming up" (planned ahead: it starts after today) and the rest, soonest
     * first for the ones coming up and newest first for the rest (Homer, 2026-11-06).
     */
    tripChoices() {
      const day = today();
      const all = [
        ...this.localTrips.filter((t) => !this.serverTripFor(t.clientId)).map((t) => ({ key: `c:${t.clientId}`, name: t.data.name, startDate: t.data.startDate, endDate: t.data.endDate })),
        ...(this.summary?.trips ?? []).map((t) => ({ key: t.fromClientId && this.items.some((i) => i.clientId === t.fromClientId) ? `c:${t.fromClientId}` : `s:${t.id}`,
          name: t.name, startDate: t.startDate, endDate: t.endDate })),
      ];
      const ahead = all.filter((t) => t.startDate > day).sort((a, b) => a.startDate.localeCompare(b.startDate));
      const rest = all.filter((t) => t.startDate <= day).sort((a, b) => b.startDate.localeCompare(a.startDate));
      return { ahead, rest };
    },
    tripRef() {
      if (this.tripKey.startsWith('c:')) return { clientId: this.tripKey.slice(2) };
      if (this.tripKey.startsWith('s:')) return { id: this.tripKey.slice(2) };
      return null;
    },
    tripItems() {
      const ref = this.tripRef;
      if (!ref) return [];
      return this.items.filter((i) => (ref.clientId && i.clientId === ref.clientId)
        || (i.data.trip && (ref.clientId ? i.data.trip.clientId === ref.clientId : i.data.trip.id === ref.id)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    /** The trip picked, as zAccountant knows it (a trip this phone sent counts once it is accepted at the desk). */
    savedTripId() {
      const ref = this.tripRef;
      return ref?.id ?? (ref?.clientId ? this.serverTripFor(ref.clientId)?.id ?? null : null);
    },
    /**
     * The trip's plan: its bookings, in date order. The desk's copy wins (it knows paid and cancelled); a booking still
     * on the phone or waiting in the inbox shows from the phone.
     */
    tripBookings() {
      const ref = this.tripRef;
      if (!ref) return [];
      const saved = (this.summary?.bookings ?? []).filter((b) => b.tripId === this.savedTripId)
        .map((b) => ({ key: `s:${b.id}`, b, ref: { id: b.id }, item: null }));
      const onDesk = new Set(saved.map((x) => x.b.fromClientId).filter(Boolean));
      const mine = this.tripItems.filter((i) => i.kind === 'booking' && i.status !== 'dismissed' && !onDesk.has(i.clientId))
        .map((i) => ({ key: `c:${i.clientId}`, b: i.data, ref: { clientId: i.clientId }, item: i }));
      return [...saved, ...mine].sort((x, y) => `${x.b.startsOn} ${x.b.startTime ?? '99'}`.localeCompare(`${y.b.startsOn} ${y.b.startTime ?? '99'}`));
    },
    /** What this phone sent for the trip, less its bookings (they are in the plan above). */
    tripEntries() { return this.tripItems.filter((i) => i.kind !== 'booking'); },
    projectMatches() {
      const q = this.projectSearch.toLowerCase();
      return (this.summary?.projects ?? []).filter((p) => `${p.code ?? ''} ${p.name}`.toLowerCase().includes(q)).slice(0, 30);
    },
    canRead() { return Boolean(this.summary?.receiptReading); },
    canAddProjects() { return Boolean(this.summary?.canAddProjects); },
    /** Projects added on this phone and not yet on zAccountant's list (no signal, or a problem to fix). */
    phoneProjects() { return this.items.filter((i) => i.kind === 'project' && i.status !== 'accepted').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    /**
     * The project list for the Projects screen, by job number, highest first (26-148 above 26-147), so the numbers
     * already taken are easy to see (Homer, 2026-11-16). Typed words match the number, name, customer or site address
     * (every word must match somewhere, so "2601 smith" or "buda" both work).
     */
    projectList() {
      const words = this.projectQuery.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return this.projectsByNumber.slice(0, 100);
      return this.projectsByNumber.filter((p) => { const hay = `${p.code ?? ''} ${p.name} ${p.customerName ?? ''} ${p.address ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
        .slice(0, 50);
    },
    /** Customers on the Projects screen's Customers tab (Homer, 2026-11-21): typed words match name, phone, email or address; A to Z. */
    customerList() {
      const words = this.customerQuery.toLowerCase().split(/\s+/).filter(Boolean);
      return (this.summary?.customers ?? [])
        .filter((c) => { const hay = `${c.name} ${c.phone ?? ''} ${c.email ?? ''} ${c.address ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
        .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).slice(0, 100);
    },
    /** Open projects for a customer, highest number first. */
    customerProjects() { return (id) => this.projectsByNumber.filter((p) => p.customerId === id); },
    /** Every project number in use: zAccountant's list plus projects still waiting on this phone. */
    takenNumbers() {
      const saved = (this.summary?.projects ?? []).map((p) => ({ id: p.id, code: p.code || leadingNumber(p.name), name: p.name }));
      const phone = this.phoneProjects.filter((i) => !i.projectId).map((i) => ({ id: null, code: i.data.code || leadingNumber(i.data.name), name: i.data.name }));
      return [...saved, ...phone].filter((x) => x.code);
    },
    /** The next free number after the highest one in use: 26-148 → 26-149, 2610 → 2611; 26-148 in 2027 → 27-001. */
    nextNumber() {
      const cmp = (x, y) => x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' });
      const codes = this.takenNumbers.map((x) => x.code).filter((c) => /\d$/.test(c)).sort((a, b) => cmp(b, a));
      if (!codes.length) return '';
      const [, head, digits] = /^(.*?)(\d+)$/.exec(codes[0]);
      const yy = String(new Date().getFullYear()).slice(-2);
      const year = /^(\d{2})([-.])$/.exec(head);
      const next = year && year[1] < yy ? `${yy}${year[2]}${'1'.padStart(digits.length, '0')}`
        : head + String(Number(digits) + 1).padStart(digits.length, '0');
      const taken = new Set(this.takenNumbers.map((x) => x.code.toLowerCase()));
      return taken.has(next.toLowerCase()) ? '' : next;
    },
    /** The project already using the number on the project form (typed, or taken from the front of the name), if any. */
    numberClash() {
      const f = this.projectForm;
      if (!f) return null;
      const code = (f.code.trim() || leadingNumber(f.name)).toLowerCase();
      return code ? this.takenNumbers.find((x) => x.code.toLowerCase() === code && (!f.serverId || x.id !== f.serverId)) ?? null : null;
    },
    /** The project opened on the Projects screen: one on zAccountant's list (s:id) or one still on this phone (c:clientId). */
    openProject() {
      const k = this.openProjectKey;
      if (k.startsWith('c:')) {
        const i = this.items.find((x) => x.clientId === k.slice(2));
        if (!i) return null;
        const saved = i.projectId && this.summary?.projects?.find((p) => p.id === i.projectId);
        if (saved) return { ...saved, item: i };
        return { id: null, code: i.data.code || leadingNumber(i.data.name) || null, name: i.data.name, address: i.data.address,
          customerName: i.data.customerName ?? this.customerName(i.data.customerId), item: i };
      }
      return k.startsWith('s:') ? this.summary?.projects?.find((p) => p.id === k.slice(2)) ?? null : null;
    },
    mileageText() {
      const c = mileageCents(this.costForm?.miles, this.costForm?.mileRate);
      return c == null ? '' : `${this.costForm.miles} mi × $${this.costForm.mileRate} = ${money(c)}`;
    },
  },
  watch: {
    hide: { immediate: true, handler(v) { document.body.classList.toggle('hush', v); } },
    tripKey(v) { setLocal('zacc.roadTrip', v || null); this.costForm = null; this.timeForm = null; this.bookingForm = null; },
  },
  async mounted() {
    // The QR code opens /road#key=zr_…: keep the key on the phone and take it out of the address bar.
    const m = /^#key=(zr_[A-Za-z0-9_-]+)$/.exec(location.hash);
    if (m) { this.setKey(m[1]); history.replaceState(null, '', '/road'); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/road-sw.js', { scope: '/road' }).catch(() => {});
    // The phone's own Back button goes from a screen back to the four buttons.
    // Back from a new project started in a form's project list returns to that form, as it was typed.
    window.addEventListener('popstate', () => {
      const back = this.projectReturn;
      this.closeForms();
      this.screen = SCREENS[history.state?.road] ? history.state.road : 'home';
      if (back && this.screen === back.screen) this.restoreForm(back);
    });
    window.addEventListener('online', () => { this.online = true; this.sync(); });
    window.addEventListener('offline', () => { this.online = false; });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.sync(); });
    try { this.items = await allItems(); } catch { this.flash('This browser is not letting the page save anything (private browsing?). Items can\'t be kept offline.', 'bad'); }
    if (this.key) { await this.refresh(); await this.sync(); }
    setInterval(() => { if (this.waiting && this.online) this.sync(); }, 60_000);
  },
  methods: {
    money,
    usDate(d) { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? ''); return x ? `${x[2]}/${x[3]}/${x[1]}` : (d ?? ''); },
    /** A message at the bottom. Good news goes after 4 seconds, a problem after 10 (Homer, 2026-11-19: it stayed on screen). */
    flash(text, kind = 'ok') {
      const id = (this.message?.id ?? 0) + 1;
      this.message = { text, kind, id };
      setTimeout(() => { if (this.message?.id === id) this.message = null; }, kind === 'ok' ? 4000 : 10000);
    },
    setKey(k) { this.key = k; this.keyProblem = ''; setLocal(KEY_STORE, k); },
    useLink() {
      const m = /#key=(zr_[A-Za-z0-9_-]+)/.exec(this.pasted);
      if (!m) { this.flash('That is not a road link. It ends with #key=zr_…', 'bad'); return; }
      this.setKey(m[1]); this.pasted = ''; this.refresh().then(() => this.sync());
    },
    forgetKey() { this.key = null; this.keyProblem = ''; setLocal(KEY_STORE, null); },
    async call(method, path, body, { seconds = 30 } = {}) {
      const res = await fetch(`/api/road${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(seconds * 1000) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw new KeyProblem(data.error ?? 'This road key no longer works.');
      if (!res.ok) { const e = new Error([data.error, ...(data.details ?? [])].filter(Boolean).join(': ')); e.status = res.status; throw e; }
      return data;
    },
    /** Open trips and project names from zAccountant, kept on the phone for when there's no signal. */
    async refresh() {
      if (!this.online) return;
      try {
        this.summary = await this.call('GET', '/');
        setLocal(SUMMARY_STORE, JSON.stringify(this.summary));
      } catch (e) {
        if (e instanceof KeyProblem) this.keyProblem = e.message;
      }
    },
    serverTripFor(clientId) { return (this.summary?.trips ?? []).find((t) => t.fromClientId === clientId) ?? null; },
    pickLabel(p) { return projectPickText(p); },
    projectLabel(id) { const p = this.summary?.projects?.find((x) => x.id === id); return p ? (p.code ?? p.name) : 'project'; },
    toggleJob(id) { const j = this.tripForm.jobIds; const i = j.indexOf(id); if (i >= 0) j.splice(i, 1); else j.push(id); },
    // ---- The four home buttons. Each screen is a history entry, so Back (or the ‹ Home link) returns to them.
    go(screen) {
      this.closeForms();
      if (this.screen === 'home') history.pushState({ road: screen }, ''); else history.replaceState({ road: screen }, '');
      this.screen = screen;
      window.scrollTo({ top: 0 });
    },
    goHome() {
      const steps = this.projectReturn ? 2 : 1; // from a new project started in a form: past the form's screen too
      this.closeForms();
      if (history.state?.road) history.go(-steps); else this.screen = 'home';
    },
    goTime() { this.go('time'); },
    openTrip(key) { this.tripKey = key; this.go('trip'); },
    closeForms() { this.tripForm = null; this.costForm = null; this.timeForm = null; this.checkForm = null; this.bookingForm = null; this.buyForm = null; this.blockForm = null; this.projectForm = null; this.customerForm = null; this.openProjectKey = ''; this.projectReturn = null; },
    toggleHide() { this.hide = !this.hide; setLocal('zacc.roadHide', this.hide ? null : 'show'); },
    newTrip() { this.tripForm = { name: '', startDate: today(), endDate: '', jobIds: [], newProjects: '', notes: '' }; this.projectSearch = ''; },
    /** A trip planned ahead (Homer, 2026-11-06): the New trip form starting tomorrow; its bookings go on it once saved. */
    planTrip() { this.newTrip(); this.tripForm.startDate = nextDay(today()); this.tripForm.planning = true; },
    /**
     * Change an item (Homer, 2026-10-28): one still on the phone, or one sent but not yet reviewed at the desk. The same
     * form opens, filled in; Save sends the change. Once accepted it is in the books, and it's changed at the desk.
     */
    canChange(i) { return !['accepted', 'dismissed'].includes(i.status); },
    changeItem(i) {
      this.closeForms();
      const d = i.data; const base = { editId: i.clientId, sentPhotos: [...(i.sentPhotos ?? [])] };
      if (i.kind === 'trip') {
        this.tripForm = { ...base, name: d.name, startDate: d.startDate, endDate: d.endDate ?? '', jobIds: [...(d.jobIds ?? [])],
          newProjects: (d.newProjects ?? []).join('\n'), notes: d.notes ?? '' };
        this.projectSearch = '';
      } else if (i.kind === 'cost') {
        this.costForm = { ...base, kind: d.kind, date: d.date, amount: d.amount ?? '', miles: d.miles ?? '', mileRate: d.mileRate ?? lastMileRate(),
          vendor: d.vendor ?? '', description: d.description === KINDS[d.kind] ? '' : (d.description ?? ''), photos: [...(i.photos ?? [])], booking: d.booking ?? null };
      } else if (i.kind === 'booking') {
        this.bookingForm = { ...base, kind: d.kind, vendor: d.vendor ?? '', confirmation: d.confirmation ?? '', startsOn: d.startsOn, startTime: d.startTime ?? '',
          endsOn: d.endsOn ?? '', endTime: d.endTime ?? '', amount: d.amount ?? '', details: d.details ?? '' };
      } else if (i.kind === 'time') {
        this.timeForm = { ...base, date: d.date, hours: d.start ? '' : d.hours, start: d.start ?? '', end: d.end ?? '', breaks: d.breaks ?? '', notes: d.notes ?? '' };
      } else if (i.kind === 'check') {
        this.checkForm = { ...base, date: d.date, amount: d.amount, from: d.from ?? '', checkNumber: d.checkNumber ?? '', invoices: d.invoices ?? '',
          notes: d.notes ?? '', photos: [...(i.photos ?? [])] };
      } else if (i.kind === 'block') {
        this.blockForm = { ...base, type: d.type, date: d.date, start: d.start ?? '', end: d.end ?? '', hours: d.start ? '' : d.hours ?? '',
          jobId: d.jobId ?? '', splitJobId: d.splitJobId ?? '', splitPercent: d.splitPercent ?? 50, tripKey: d.trip ? (d.trip.clientId ? `c:${d.trip.clientId}` : `s:${d.trip.id}`) : '', notes: d.notes ?? '' };
      } else if (i.kind === 'project') {
        this.projectForm = { ...base, code: d.code ?? '', name: d.name, customerId: d.customerId ?? (d.customerName ? NEW_CUSTOMER : ''), customerName: d.customerName ?? '', address: d.address ?? '' };
      } else if (i.kind === 'purchase') {
        this.buyForm = { ...base, kind: 'purchase', category: d.category, date: d.date, amount: d.amount ?? '', vendor: d.vendor ?? '',
          description: d.description ?? '', serialNumber: d.serialNumber ?? '', jobId: d.jobId ?? '', photos: [...(i.photos ?? [])] };
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    /** A photo already sent can't be taken back from the phone (remove it at the desk). */
    photoSent(form, p) { return (form.sentPhotos ?? []).includes(p.clientId); },
    /** Save a form: a new item, or the changed one (form.editId) with its new data, sent again when there is signal. */
    async saveItem(kind, form, data, photos = []) {
      if (!form.editId) return this.addItem(kind, data, photos);
      const i = this.items.find((x) => x.clientId === form.editId);
      if (!i || !this.canChange(i)) { this.flash('That was already reviewed at your desk; change it there.', 'bad'); return null; }
      Object.assign(i, { data, photos, error: '', edited: i.sentItem });
      try { await putItem(i); } catch { this.flash('Could not save on this phone. Is its storage full?', 'bad'); return null; }
      this.sync();
      return i;
    },
    async addItem(kind, data, photos = []) {
      const item = { clientId: `${kind}-${newId()}`, kind, data, photos, sentItem: false, sentPhotos: [], status: 'on phone', error: '', createdAt: new Date().toISOString() };
      try { await putItem(item); } catch { this.flash('Could not save on this phone. Is its storage full?', 'bad'); return null; }
      this.items.push(item);
      this.sync();
      return item;
    },
    async saveTrip() {
      const f = this.tripForm;
      const item = await this.saveItem('trip', f, { name: f.name.trim(), startDate: f.startDate, endDate: f.endDate || null, notes: f.notes.trim() || null,
        jobIds: f.jobIds, newProjects: f.newProjects.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
      if (!item) return;
      this.tripForm = null;
      if (!f.editId) this.tripKey = `c:${item.clientId}`;
      if (!f.editId && this.screen === 'plan') this.go('trip'); // a planned trip: on to Trip now, where its bookings go
      this.flash(f.editId ? 'Change saved.' : f.planning || f.startDate > today() ? 'Trip saved on this phone. Now add its bookings: + Booking.' : 'Trip saved on this phone.');
    },
    // A new cost or day of travel starts on today's date (it used to copy the last item's date, which was easy to miss:
    // Homer, 2026-10-28). For the days after, "Save, then next day".
    newCost() { this.timeForm = null; this.bookingForm = null; this.costForm = { kind: 'other', date: today(), dateDefault: today(), amount: '', miles: '', mileRate: lastMileRate(), vendor: '', description: '', photos: [], booking: null }; },
    // ---- Bookings: the flight, hotel and rental car for a trip planned ahead. Not money until paid.
    newBooking() {
      this.costForm = null; this.timeForm = null;
      const t = this.tripChoices.ahead.concat(this.tripChoices.rest).find((x) => x.key === this.tripKey);
      this.bookingForm = { kind: 'airfare', vendor: '', confirmation: '', startsOn: t?.startDate ?? today(), startTime: '', endsOn: t?.endDate ?? '', endTime: '', amount: '', details: '' };
    },
    async saveBooking() {
      const f = this.bookingForm;
      if (f.amount && (!/\d/.test(f.amount) || !/^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d*(\.\d{1,2})?$/.test(f.amount))) { this.flash('Enter the price like 412.30, or leave it empty.', 'bad'); return; }
      if (!f.vendor.trim() && !f.confirmation.trim() && !f.details.trim()) { this.flash('Say who it is with (Southwest, Hilton, Avis…) or the confirmation number.', 'bad'); return; }
      if (f.endsOn && f.endsOn < f.startsOn) { this.flash(`The ${BOOKING_DATES[f.kind][1].toLowerCase()} date is before the ${BOOKING_DATES[f.kind][0].toLowerCase()} date.`, 'bad'); return; }
      const data = { trip: this.tripRef, kind: f.kind, vendor: f.vendor.trim() || null, confirmation: f.confirmation.trim() || null, startsOn: f.startsOn,
        startTime: f.startTime || null, endsOn: f.endsOn || null, endTime: f.endTime || null, amount: f.amount.replace(/[$,]/g, '') || null, details: f.details.trim() || null };
      if (await this.saveItem('booking', f, data)) { this.bookingForm = null; this.flash(f.editId ? 'Change saved.' : 'Booking saved on this phone.'); }
    },
    /** A booking paid for: the cost form, filled in from it, and the cost is linked to the booking when accepted. */
    payBooking(x) {
      this.timeForm = null; this.bookingForm = null;
      const b = x.b;
      this.costForm = { kind: b.kind, date: today(), dateDefault: today(), amount: b.amountCents != null ? (b.amountCents / 100).toFixed(2) : (b.amount ?? ''), miles: '', mileRate: lastMileRate(),
        vendor: b.vendor ?? '', description: b.confirmation ? `${KINDS[b.kind]}, confirmation ${b.confirmation}` : '', photos: [], booking: x.ref };
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    /** Paid, as far as this phone knows: the desk says so, or a cost for it was saved here. */
    bookingPaid(x) {
      if (x.b.paid) return true;
      return this.items.some((i) => i.kind === 'cost' && i.status !== 'dismissed' && i.data.booking
        && ((x.ref.id && i.data.booking.id === x.ref.id) || (x.ref.clientId && i.data.booking.clientId === x.ref.clientId)
          || (x.b.fromClientId && i.data.booking.clientId === x.b.fromClientId)));
    },
    bookingWhen(b) {
      const [a, z] = BOOKING_DATES[b.kind] ?? BOOKING_DATES.other;
      const at = (d, t) => `${this.usDate(d)}${t ? ' ' + clock12(t) : ''}`;
      return `${a} ${at(b.startsOn, b.startTime)}${b.endsOn ? ` · ${z} ${at(b.endsOn, b.endTime)}` : ''}`;
    },
    bookingPrice(b) { return b.amountCents != null ? money(b.amountCents) : (b.amount ? money(Math.round(Number(b.amount) * 100)) : ''); },
    newCheck() { this.costForm = null; this.timeForm = null; this.bookingForm = null; this.checkForm = { date: today(), amount: '', from: '', checkNumber: '', invoices: '', notes: '', photos: [] }; },
    async saveCheck() {
      const f = this.checkForm;
      if (!/^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d*(\.\d{1,2})?$/.test(f.amount) || !/\d/.test(f.amount)) { this.flash('Enter the amount like 4915.83', 'bad'); return; }
      if (!f.from.trim() && !f.invoices.trim()) { this.flash('Say who paid or which invoice it pays.', 'bad'); return; }
      const data = { date: f.date, amount: f.amount.replace(/[$,]/g, ''), from: f.from.trim() || null, checkNumber: f.checkNumber.trim() || null,
        invoices: f.invoices.trim() || null, notes: f.notes.trim() || null };
      if (await this.saveItem('check', f, data, f.photos)) { this.checkForm = null; this.flash(f.editId ? 'Change saved.' : 'Saved on this phone.'); }
    },
    // ---- Equipment and supplies bought, not on a trip (Homer, 2026-11-06). Equipment lasts and goes on the equipment
    // list at the desk (with its serial number); supplies are used up. The desk puts each in the right account.
    newBuy() {
      this.closeForms();
      this.buyForm = { kind: 'purchase', category: this.screen, date: today(), dateDefault: today(), amount: '', vendor: '', description: '', serialNumber: '', jobId: '', photos: [] };
    },
    async saveBuy() {
      const f = this.buyForm;
      if (!/^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d*(\.\d{1,2})?$/.test(f.amount) || !/\d/.test(f.amount)) { this.flash('Enter the amount like 23.47', 'bad'); return; }
      const data = { date: f.date, category: f.category, amount: f.amount.replace(/[$,]/g, ''), vendor: f.vendor.trim() || null,
        description: f.description.trim() || SCREENS[f.category].title, jobId: f.jobId || null };
      if (f.category === 'equipment') data.serialNumber = f.serialNumber.trim() || null;
      if (await this.saveItem('purchase', f, data, f.photos)) { this.buyForm = null; this.flash(f.editId ? 'Change saved.' : 'Saved on this phone.'); }
    },
    // ---- Projects (Homer, 2026-11-16): look a project up in the field (number, customer, site address, a map), or add
    // one the way the desk's Projects → Add project does. A new project goes straight onto zAccountant's list when there
    // is signal (it isn't money, so it doesn't wait in the From the road box); with no signal it waits on the phone.
    customerName(id) { return id ? this.summary?.customers?.find((c) => c.id === id)?.name ?? null : null; },
    newProject() {
      this.closeForms();
      const words = this.projectQuery.trim();
      // Typed a number or name that isn't on the list: start the new project with it.
      // Nothing typed: the box starts with the next free number, filled in (Homer, 2026-11-16: "make it solid").
      this.projectForm = { code: /^\S*\d\S*$/.test(words) ? words : this.nextNumber, name: words && !/^\S*\d\S*$/.test(words) ? words : '', customerId: '', customerName: '', address: '' };
      window.scrollTo({ top: 0 });
    },
    showProject(key) { this.projectForm = null; this.customerForm = null; this.openProjectKey = this.openProjectKey === key ? '' : key; },
    /** The site address as one line for a map search ("285 Bridgestone Way, Buda, TX"). */
    mapLink(address) { return `https://maps.apple.com/?q=${encodeURIComponent(String(address ?? '').replace(/\s*\n\s*/g, ', '))}`; },
    firstLine(address) { return String(address ?? '').split('\n')[0]; },
    /** "+ Time on this project": the Time screen, a new site block on this project. */
    timeOnProject(p) { this.go('time'); this.newBlock('site'); this.blockForm.jobId = p.id; },
    async saveProject() {
      const f = this.projectForm;
      const name = f.name.trim(); const code = f.code.trim() || leadingNumber(name);
      if (!name) { this.flash('Type the project name, like 2610 Garcia Barn.', 'bad'); return; }
      // "26-147, 26-148" is two projects, not one (Homer, 2026-11-16).
      if (/^[A-Za-z]{0,3}\d[\d.-]*[A-Za-z]?(\s*([,;&/+]|\band\b)\s*[A-Za-z]{0,3}\d[\d.-]*[A-Za-z]?)+$/i.test(name)) {
        this.flash('One project at a time: that looks like a list of project numbers.', 'bad'); return;
      }
      const list = (this.summary?.projects ?? []).filter((p) => p.id !== f.serverId);
      const same = list.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
      if (same && f.serverId) { this.flash(`There is already a project named ${same.name}.`, 'bad'); return; }
      if (same && this.projectReturn) { this.returnFromProject(same.id); this.flash(`${same.name} was already on the list: it is picked.`); return; }
      if (same) { this.projectForm = null; this.openProjectKey = `s:${same.id}`; this.flash(`${name} is already on the list.`); return; }
      const clash = this.numberClash;
      if (clash && !confirm(`Number ${code} is already used by ${clash.name}. ${f.serverId ? 'Save' : 'Add this project'} anyway?`)) return;
      const newCust = f.customerId === NEW_CUSTOMER;
      if (newCust && !f.customerName.trim()) { this.flash('Type the new customer\'s name, or choose None.', 'bad'); return; }
      const data = { code: f.code.trim() || null, name, address: f.address.trim() || null,
        customerId: newCust ? null : f.customerId || null, customerName: newCust ? f.customerName.trim() : null };
      // A project already on zAccountant's list is changed there and then (it needs signal), like Add project at the desk.
      if (f.serverId) {
        if (!(await this.sendNow('PUT', `/projects/${f.serverId}`, data))) return;
        this.projectForm = null; this.openProjectKey = `s:${f.serverId}`;
        this.flash('Project saved.');
        return;
      }
      const item = await this.saveItem('project', f, data);
      if (!item) return;
      if (this.projectReturn) { await this.backWithNewProject(item); return; }
      this.projectForm = null; this.projectQuery = '';
      this.openProjectKey = `c:${item.clientId}`;
      this.flash(this.online ? 'Adding the project…' : 'No signal: the project is kept on this phone and added when there is signal.');
    },
    /**
     * "+ New project" chosen in a form's project list (Homer, 2026-11-19): the Projects screen's new project form, then
     * back to the form, with what was typed kept and the new project picked. It is its own history entry, so the phone's
     * Back button (or Cancel) returns to the form too.
     */
    pickProject(formKey) {
      const form = this[formKey];
      if (form?.jobId !== NEW_PROJECT) return;
      form.jobId = form.lastJobId ?? '';
      const back = { screen: this.screen, formKey, form };
      this.closeForms();
      history.pushState({ road: 'projects' }, '');
      this.screen = 'projects';
      this.projectQuery = '';
      this.newProject();
      this.projectReturn = back;
    },
    /** Remember the project picked, so choosing "+ New project" and coming back without one leaves it as it was. */
    keepJob(form) { if (form && form.jobId !== NEW_PROJECT) form.lastJobId = form.jobId; },
    restoreForm(back) {
      this[back.formKey] = back.form;
      if (back.pickId) { back.form.jobId = back.pickId; back.form.lastJobId = back.pickId; }
      this.$nextTick(() => document.querySelector('.project-pick')?.scrollIntoView({ block: 'center' }));
    },
    /** Back to the form left for "+ New project", with this project picked (null: none, it isn't on the list yet). */
    returnFromProject(id) {
      const back = this.projectReturn;
      back.pickId = id;
      history.back(); // the popstate above puts the form back
    },
    cancelProject() { if (this.projectReturn) history.back(); else this.projectForm = null; },
    /** A new project from a form: it goes onto zAccountant's list at once with signal; wait for that, then pick it. */
    async backWithNewProject(item) {
      this.busy = true;
      try {
        const until = Date.now() + 30_000;
        while (!item.projectId && !item.error && this.syncing && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      } finally { this.busy = false; }
      if (!this.projectReturn) return; // left the screen meanwhile
      const id = item.projectId && this.summary?.projects?.some((p) => p.id === item.projectId) ? item.projectId : null;
      this.returnFromProject(id);
      if (id) this.flash(`Project ${item.data.name} added and picked.`);
      else this.flash(this.online && item.error ? item.error : 'No signal: the project is kept on this phone. Pick it here once it is added (it goes when there is signal).', 'bad');
    },
    /** "✏️ Edit project": the same form, filled in from the project on zAccountant's list. */
    editProject(p) {
      this.closeForms();
      this.projectForm = { serverId: p.id, code: p.code ?? '', name: p.name, customerId: p.customerId ?? '', customerName: '', address: p.address ?? '' };
      window.scrollTo({ top: 0 });
    },
    customerOf(p) { return p?.customerId ? this.summary?.customers?.find((c) => c.id === p.customerId) ?? null : null; },
    /** "✏️ Edit customer": the customer's name, phone, email and address (the desk's Customers → edit, the main boxes). */
    editCustomer(p) {
      const c = this.customerOf(p);
      if (c) this.editCustomerCard(c, p.id);
    },
    /** The same form from the Customers tab (back = null: it returns to that customer on the tab). */
    editCustomerCard(c, back = null) {
      this.closeForms();
      this.customerForm = { id: c.id, back, name: c.name, phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '' };
      window.scrollTo({ top: 0 });
    },
    async saveCustomer() {
      const f = this.customerForm;
      if (!f.name.trim()) { this.flash('The customer needs a name.', 'bad'); return; }
      if (!(await this.sendNow('PATCH', `/customers/${f.id}`, { name: f.name.trim(), phone: f.phone.trim(), email: f.email.trim(), address: f.address.trim() }))) return;
      this.customerForm = null;
      if (f.back) this.openProjectKey = `s:${f.back}`; else this.openCustomerId = f.id;
      this.flash('Customer saved.');
    },
    /** Send a change now (it needs signal), then fetch the lists again so every screen shows it. False if it didn't go. */
    async sendNow(method, path, body) {
      if (!this.online) { this.flash('Changing a project or customer needs signal. Try again when you have some.', 'bad'); return false; }
      this.busy = true;
      try {
        await this.call(method, path, body);
        await this.refresh();
        return true;
      } catch (e) {
        if (e instanceof KeyProblem) this.keyProblem = e.message;
        else this.flash(e.name === 'TimeoutError' || e instanceof TypeError ? 'No answer from zAccountant. Check the signal and try again.' : e.message, 'bad');
        return false;
      } finally { this.busy = false; }
    },
    telLink(phone) { return `tel:${String(phone ?? '').replace(/[^\d+]/g, '')}`; },
    // ---- Time in blocks: a day is travel out, site time (lunch is the gap), travel on or home, office or drafting.
    blockMinutes(d) { return d.start && d.end ? clockTime(d.start, d.end, '')?.minutes ?? 0 : durationMinutes(d.hours) ?? 0; },
    blockHours(d) { return hhmm(this.blockMinutes(d)); },
    /** A new block starts where the day's last one ended, on the same project. */
    newBlock(type) {
      const last = this.dayBlocks.filter((i) => i.data.end).at(-1)?.data;
      this.closeForms();
      this.blockForm = { type, date: this.blockDay, start: last?.end ?? '', end: '', hours: '', jobId: last?.jobId ?? '', splitJobId: '', splitPercent: 50, tripKey: '', notes: '' };
    },
    async saveBlock(next = false) {
      const f = this.blockForm;
      if (!(f.start && f.end) && !durationMinutes(f.hours)) { this.flash('Type the start and end times, or the hours.', 'bad'); return; }
      if (f.type !== 'office' && !f.jobId && !(f.type === 'travel' && f.tripKey)) { this.flash(f.type === 'travel' ? 'Choose the project, or the trip.' : 'Choose the project.', 'bad'); return; }
      if (f.splitJobId && f.splitJobId === f.jobId) { this.flash('Split it with a different project.', 'bad'); return; }
      const pct = Number(f.splitPercent);
      if (f.splitJobId && !(Number.isInteger(pct) && pct >= 1 && pct <= 99)) { this.flash('The first project\'s share is a whole percent from 1 to 99.', 'bad'); return; }
      const data = { date: f.date, type: f.type, notes: f.notes.trim() || null,
        ...(f.start && f.end ? { start: f.start, end: f.end } : { hours: f.hours }) };
      const trip = f.type === 'travel' ? keyRef(f.tripKey) : null;
      if (trip) data.trip = trip;
      else { data.jobId = f.jobId || null; if (f.type === 'travel' && f.splitJobId) Object.assign(data, { splitJobId: f.splitJobId, splitPercent: pct }); }
      if (!(await this.saveItem('block', f, data))) return;
      this.blockDay = f.date;
      this.blockForm = null;
      if (next && f.end) this.newBlock(f.type === 'travel' ? 'site' : 'travel');
      this.flash(f.editId ? 'Change saved.' : 'Saved on this phone.');
    },
    hhmm,
    /** "0:31 and 0:30": the two parts of a split block (the same half-up rounding as the server's splitBlock). */
    hhmmSplit(d) {
      const m = this.blockMinutes(d), first = Math.floor((m * (Number(d.splitPercent) || 50) + 50) / 100);
      return `${hhmm(first)} and ${hhmm(m - first)}`;
    },
    projectName(id) { const p = this.summary?.projects?.find((x) => x.id === id); return p ? (p.code ? `${p.code} ${p.name}` : p.name) : 'a project'; },
    newTime() { this.costForm = null; this.bookingForm = null; this.timeForm = { date: today(), hours: '', start: '', end: '', breaks: '', notes: '' }; },
    clockTime,
    // A screenshot or photo copied to the clipboard: the same as choosing it.
    async pastePhotos() {
      try { await this.addPhotos({ target: { files: await picturesFromClipboard(), value: '' } }); }
      catch (err) { this.flash(err.message, 'bad'); }
    },
    async addPhotos(ev) {
      const files = [...(ev.target.files ?? [])];
      ev.target.value = '';
      const form = this.checkForm ?? this.buyForm ?? this.costForm;
      const first = form.photos.length;
      let problem = false;
      this.busy = true;
      try {
        for (const f of files) {
          if (form.photos.length >= 6) { this.flash('At most 6 photos.', 'bad'); problem = true; break; }
          form.photos.push({ clientId: `photo-${newId()}`, dataUrl: await shrinkPhoto(f) });
        }
      } catch { this.flash('That photo could not be read. Try taking it again.', 'bad'); problem = true; } finally { this.busy = false; }
      // A photo went in: an old problem message ("no picture on the clipboard") no longer applies.
      if (form.photos.length > first && !problem && this.message?.kind === 'bad') this.message = null;
      // A new cost's first receipt is read right away (with signal), to fill in the amount, date and who was paid.
      if ((form === this.costForm || form === this.buyForm) && first === 0 && form.photos.length && !form.editId && this.canRead && this.online && !String(form.amount).trim()) {
        this.readReceipt();
      }
    },
    // A receipt picture dragged onto the photo boxes (a computer, or an iPad): the same as choosing it.
    dropPhotos(ev) {
      const files = droppedPictures(ev);
      if (files.length) this.addPhotos({ target: { files, value: '' } });
    },
    /** Read the cost's newest receipt photo and fill in the boxes still empty (public/receipt.js). Nothing is saved. */
    async readReceipt() {
      const form = this.costForm ?? this.buyForm;
      const photo = form?.photos.at(-1);
      if (!photo || this.reading) return;
      if (!this.online) { this.flash('Reading a receipt needs signal. Type it in, or tap "Fill in from the receipt" later.', 'bad'); return; }
      this.reading = true;
      try {
        const read = await this.call('POST', '/receipt', { picture: photo.dataUrl }, { seconds: 90 });
        if (this.costForm !== form && this.buyForm !== form) return; // the form was closed meanwhile
        this.flash(filledText(fillFromReceipt(form, read), read));
      } catch (e) {
        if (e instanceof KeyProblem) this.keyProblem = e.message;
        else this.flash(e.message || 'The receipt could not be read just now. Type it in.', 'bad');
      } finally { this.reading = false; }
    },
    async saveCost() {
      const f = this.costForm;
      if (f.kind === 'mileage') {
        if (mileageCents(f.miles, f.mileRate) == null) { this.flash('Enter the miles (like 212.4) and the rate per mile (like 0.70).', 'bad'); return; }
        setLocal('zacc.mileRate', f.mileRate);
      } else if (!/^\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^\$?\d+(\.\d{1,2})?$/.test(f.amount)) { this.flash('Enter the amount like 412.30', 'bad'); return; }
      const data = { trip: this.tripRef, date: f.date, kind: f.kind, vendor: f.vendor.trim() || null, description: f.description.trim() || KINDS[f.kind] };
      if (f.kind === 'mileage') Object.assign(data, { miles: f.miles, mileRate: f.mileRate });
      else data.amount = f.amount.replace(/[$,]/g, '');
      if (f.booking) data.booking = f.booking;
      if (await this.saveItem('cost', f, data, f.photos)) { this.costForm = null; this.flash(f.editId ? 'Change saved.' : 'Saved on this phone.'); }
    },
    // One day's travel: the hours, or start and end less breaks. "Save, then next day" keeps the times for the next date.
    async saveTime(next = false) {
      const f = this.timeForm; const clock = clockTime(f.start, f.end, f.breaks);
      if (clock?.error) { this.flash(clock.error, 'bad'); return; }
      const data = { trip: this.tripRef, date: f.date, notes: f.notes.trim() || null,
        ...(clock ? { start: f.start, end: f.end, breaks: f.breaks, hours: clock.hours } : { hours: f.hours }) };
      if (!(await this.saveItem('time', f, data))) return;
      this.timeForm = next ? { ...f, editId: null, sentPhotos: [], date: nextDay(f.date), hours: clock ? '' : f.hours } : null;
      this.flash(next ? `Saved on this phone. Now ${this.usDate(nextDay(f.date))}.` : (f.editId ? 'Change saved.' : 'Saved on this phone.'));
    },
    async removeItem(i) {
      if (!confirm('Remove this from the phone? It has not been sent.')) return;
      await deleteItem(i.clientId).catch(() => {});
      this.items = this.items.filter((x) => x.clientId !== i.clientId);
    },
    async clearDone() {
      for (const i of this.items.filter((x) => ['accepted', 'dismissed'].includes(x.status))) await deleteItem(i.clientId).catch(() => {});
      this.items = this.items.filter((x) => !['accepted', 'dismissed'].includes(x.status));
    },
    itemText(i) {
      if (i.kind === 'trip') return `Trip: ${i.data.name}`;
      if (i.kind === 'booking') return `${BOOKING_KINDS[i.data.kind]}${i.data.vendor ? ' · ' + i.data.vendor : ''}${i.data.confirmation ? ' · ' + i.data.confirmation : ''}`;
      if (i.kind === 'block') {
        const d = i.data;
        const where = d.trip ? 'trip' : d.jobId ? this.projectName(d.jobId) + (d.splitJobId ? ' + ' + this.projectName(d.splitJobId) + ` (split ${d.splitPercent ?? 50}/${100 - (d.splitPercent ?? 50)})` : '') : 'no project';
        return `${BLOCK_ICON[d.type]} ${d.start ? clock12(d.start) + '–' + clock12(d.end) + ' ' : ''}${this.blockHours(d)} h · ${where}${d.notes ? ' · ' + d.notes : ''}`;
      }
      if (i.kind === 'project') return `${i.data.code && !i.data.name.startsWith(i.data.code) ? i.data.code + ' · ' : ''}${i.data.name}`;
      if (i.kind === 'purchase') return `${i.data.description}${i.data.vendor ? ' · ' + i.data.vendor : ''}${i.data.serialNumber ? ' · serial ' + i.data.serialNumber : ''}${i.photos?.length ? ` · 📷 ${i.photos.length}` : ''} ·`;
      if (i.kind === 'check') return `Check${i.data.checkNumber ? ' #' + i.data.checkNumber : ''}${i.data.from ? ' from ' + i.data.from : ''}${i.data.invoices ? ' · inv ' + i.data.invoices : ''}${i.photos?.length ? ` · 📷 ${i.photos.length}` : ''} ·`;
      if (i.kind === 'time') return `Travel time ${i.data.hours} h${i.data.notes ? ' · ' + i.data.notes : ''}`;
      return `${i.data.description}${i.data.vendor ? ' · ' + i.data.vendor : ''}${i.photos?.length ? ` · 📷 ${i.photos.length}` : ''} ·`;
    },
    /** The money part of an item, shown on its own so the privacy switch can blur it (empty for trips and time). */
    itemAmount(i) {
      if (i.kind === 'cost' && i.data.kind === 'mileage') return `${i.data.miles} mi × $${i.data.mileRate} = ${money(mileageCents(i.data.miles, i.data.mileRate))}`;
      if (i.kind === 'cost' || i.kind === 'check' || i.kind === 'purchase') return money(Math.round(Number(i.data.amount) * 100));
      return '';
    },
    /** Something of this item still to send: the item, a change to it, or a photo. */
    notSent(i) {
      return !i.sentItem || (i.edited && i.status === 'pending') || (this.canChange(i) && (i.photos ?? []).some((p) => !(i.sentPhotos ?? []).includes(p.clientId)));
    },
    statusText(i) {
      if (i.status === 'accepted') return i.kind === 'booking' ? 'On the trip' : i.kind === 'project' ? 'On the list' : 'In the books';
      if (i.status === 'dismissed') return 'Dismissed at desk';
      if (i.error) return 'Needs a fix';
      if (this.notSent(i)) return 'On phone';
      return 'Sent';
    },
    statusClass(i) { return { ok: i.status === 'accepted' || (this.statusText(i) === 'Sent'), warn: this.statusText(i) === 'On phone', bad: Boolean(i.error) }; },
    /**
     * Send what hasn't been sent: new projects first (they go straight onto the list), then trips (their costs name
     * them), then bookings (a cost may name one), then the rest in order.
     */
    async sync() {
      if (this.syncing) { this.syncAgain = true; return; } // something was saved while sending: one more round after
      if (!this.key || !this.online) return;
      this.syncing = true;
      let newProjects = false;
      try {
        const rank = (i) => ({ project: -1, trip: 0, booking: 1 }[i.kind] ?? 2);
        const order = [...this.items].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
        for (const i of order) {
          try {
            if (i.kind === 'project') {
              if (i.status === 'accepted') continue;
              const r = await this.call('POST', '/projects', { ...i.data });
              Object.assign(i, { sentItem: true, status: 'accepted', edited: false, error: '', projectId: r.project.id, alreadyThere: r.alreadyThere });
              await putItem(i);
              this.flash(r.alreadyThere ? `${r.project.name} was already on the list.` : `Project ${r.project.name} added.`);
              newProjects = true;
              continue;
            }
            if (!i.sentItem) {
              await this.call('POST', '/items', { clientId: i.clientId, kind: i.kind, data: i.data });
              i.sentItem = true; i.status = 'pending'; i.error = ''; i.edited = false;
              await putItem(i);
            } else if (i.edited && i.status === 'pending') {
              await this.call('PUT', `/items/${i.clientId}`, { data: i.data });
              i.edited = false; i.error = '';
              await putItem(i);
            }
            if (!this.canChange(i)) continue;
            for (const p of i.photos ?? []) {
              if ((i.sentPhotos ??= []).includes(p.clientId)) continue;
              await this.call('POST', `/items/${i.clientId}/photos`, { clientId: p.clientId, picture: p.dataUrl });
              i.sentPhotos.push(p.clientId);
              await putItem(i);
            }
          } catch (e) {
            if (e instanceof KeyProblem) throw e;
            if (e.status === 400) { i.error = e.message; await putItem(i); continue; } // this one needs fixing; send the others
            throw e; // no signal after all: try again later
          }
        }
        // Which have been accepted at the desk? (A dismissed one is asked about too: the desk can restore it.)
        const sent = this.items.filter((i) => i.sentItem && ['pending', 'dismissed'].includes(i.status)).map((i) => i.clientId);
        let changed = false;
        if (sent.length) {
          for (const s of await this.call('POST', '/status', { clientIds: sent })) {
            const i = this.items.find((x) => x.clientId === s.clientId);
            if (i && i.status !== s.status) { i.status = s.status; await putItem(i); changed = true; }
          }
        }
        // Something was accepted at the desk, or a project added: fetch the lists again (a planned trip's bookings and a
        // new project show from there).
        if (changed || newProjects) await this.refresh();
      } catch (e) {
        if (e instanceof KeyProblem) this.keyProblem = e.message;
        if (newProjects) await this.refresh();
      } finally {
        this.syncing = false;
        if (this.syncAgain) { this.syncAgain = false; this.sync(); }
      }
    },
  },
}).mount('#road');
