// zAccountant Road (Homer, 2026-10-25): the phone page for business trips. Vue 3, no build step, like app.js.
//
// ℹ️ How it works. Everything typed here is saved on the phone first (IndexedDB, the browser's own small database),
// so it survives no signal, a dead battery or closing the page. When there is signal it is sent to zAccountant with
// the phone's road key, item by item; each item carries its own id, so sending twice never makes two. At the desk,
// Trips → "From the road" shows what arrived; nothing is in the books until it is accepted there.
import { createApp } from '/vendor/vue.js';

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
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(String(miles ?? '').trim());
  const r = /^\$?(\d{1,2})(?:\.(\d{1,4}))?$/.exec(String(rate ?? '').trim());
  if (!m || !r) return null;
  const hundredthsMiles = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  const tenThousandthsDollars = BigInt(r[1]) * 10000n + BigInt((r[2] ?? '').padEnd(4, '0'));
  const n = hundredthsMiles * tenThousandthsDollars; // in 1/10000 of a cent
  return Number((n + 5000n) / 10000n);
}
const money = (c) => (c == null ? '' : `$${(c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`);
const KINDS = { airfare: 'Airfare', rental_car: 'Rental car', lodging: 'Lodging', meals: 'Meals', tolls: 'Tolls', mileage: 'Mileage', other: 'Other' };

class KeyProblem extends Error {}

createApp({
  data() {
    return {
      key: getLocal(KEY_STORE), pasted: '', keyProblem: '', message: null,
      summary: (() => { try { return JSON.parse(getLocal(SUMMARY_STORE) ?? 'null'); } catch { return null; } })(),
      online: navigator.onLine, syncing: false, busy: false,
      items: [], tripKey: getLocal('zacc.roadTrip') ?? '',
      tripForm: null, projectSearch: '', costForm: null, timeForm: null, kinds: KINDS,
    };
  },
  computed: {
    waiting() { return this.items.filter((i) => !i.sentItem || (i.photos ?? []).some((p) => !(i.sentPhotos ?? []).includes(p.clientId))).length; },
    localTrips() { return this.items.filter((i) => i.kind === 'trip' && i.status !== 'dismissed'); },
    /** Trips in zAccountant, less the ones this phone started (an accepted one shows up in both lists). */
    serverTrips() {
      const mine = new Set(this.localTrips.map((t) => `${t.data.name}|${t.data.startDate}`));
      return (this.summary?.trips ?? []).filter((t) => !mine.has(`${t.name}|${t.startDate}`));
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
    projectMatches() {
      const q = this.projectSearch.toLowerCase();
      return (this.summary?.projects ?? []).filter((p) => `${p.code ?? ''} ${p.name}`.toLowerCase().includes(q)).slice(0, 30);
    },
    mileageText() {
      const c = mileageCents(this.costForm?.miles, this.costForm?.mileRate);
      return c == null ? '' : `${this.costForm.miles} mi × $${this.costForm.mileRate} = ${money(c)}`;
    },
  },
  watch: {
    tripKey(v) { setLocal('zacc.roadTrip', v || null); this.costForm = null; this.timeForm = null; },
  },
  async mounted() {
    // The QR code opens /road#key=zr_…: keep the key on the phone and take it out of the address bar.
    const m = /^#key=(zr_[A-Za-z0-9_-]+)$/.exec(location.hash);
    if (m) { this.setKey(m[1]); history.replaceState(null, '', '/road'); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/road-sw.js', { scope: '/road' }).catch(() => {});
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
    flash(text, kind = 'ok') { this.message = { text, kind }; if (kind === 'ok') setTimeout(() => { if (this.message?.text === text) this.message = null; }, 4000); },
    setKey(k) { this.key = k; this.keyProblem = ''; setLocal(KEY_STORE, k); },
    useLink() {
      const m = /#key=(zr_[A-Za-z0-9_-]+)/.exec(this.pasted);
      if (!m) { this.flash('That is not a road link. It ends with #key=zr_…', 'bad'); return; }
      this.setKey(m[1]); this.pasted = ''; this.refresh().then(() => this.sync());
    },
    forgetKey() { this.key = null; this.keyProblem = ''; setLocal(KEY_STORE, null); },
    async call(method, path, body) {
      const res = await fetch(`/api/road${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
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
    projectLabel(id) { const p = this.summary?.projects?.find((x) => x.id === id); return p ? (p.code ?? p.name) : 'project'; },
    toggleJob(id) { const j = this.tripForm.jobIds; const i = j.indexOf(id); if (i >= 0) j.splice(i, 1); else j.push(id); },
    newTrip() { this.tripForm = { name: '', startDate: today(), endDate: '', jobIds: [], newProjects: '', notes: '' }; this.projectSearch = ''; },
    async addItem(kind, data, photos = []) {
      const item = { clientId: `${kind}-${newId()}`, kind, data, photos, sentItem: false, sentPhotos: [], status: 'on phone', error: '', createdAt: new Date().toISOString() };
      try { await putItem(item); } catch { this.flash('Could not save on this phone. Is its storage full?', 'bad'); return null; }
      this.items.push(item);
      this.sync();
      return item;
    },
    async saveTrip() {
      const f = this.tripForm;
      const item = await this.addItem('trip', { name: f.name.trim(), startDate: f.startDate, endDate: f.endDate || null, notes: f.notes.trim() || null,
        jobIds: f.jobIds, newProjects: f.newProjects.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) });
      if (!item) return;
      this.tripForm = null;
      this.tripKey = `c:${item.clientId}`;
      this.flash('Trip saved on this phone.');
    },
    lastDate() { return this.tripItems.filter((i) => i.data.date).at(-1)?.data.date ?? today(); },
    newCost() { this.timeForm = null; this.costForm = { kind: 'other', date: this.lastDate(), amount: '', miles: '', mileRate: lastMileRate(), vendor: '', description: '', photos: [] }; },
    newTime() { this.costForm = null; this.timeForm = { date: this.lastDate(), hours: '', notes: '' }; },
    async addPhotos(ev) {
      const files = [...(ev.target.files ?? [])];
      ev.target.value = '';
      this.busy = true;
      try {
        for (const f of files) {
          if (this.costForm.photos.length >= 6) { this.flash('A cost can have at most 6 photos.', 'bad'); break; }
          this.costForm.photos.push({ clientId: `photo-${newId()}`, dataUrl: await shrinkPhoto(f) });
        }
      } catch { this.flash('That photo could not be read. Try taking it again.', 'bad'); } finally { this.busy = false; }
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
      if (await this.addItem('cost', data, f.photos)) { this.costForm = null; this.flash('Saved on this phone.'); }
    },
    async saveTime() {
      const f = this.timeForm;
      if (await this.addItem('time', { trip: this.tripRef, date: f.date, hours: f.hours, notes: f.notes.trim() || null })) { this.timeForm = null; this.flash('Saved on this phone.'); }
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
      if (i.kind === 'time') return `Travel time ${i.data.hours} h${i.data.notes ? ' · ' + i.data.notes : ''}`;
      const amount = i.data.kind === 'mileage' ? `${i.data.miles} mi × $${i.data.mileRate} = ${money(mileageCents(i.data.miles, i.data.mileRate))}` : money(Math.round(Number(i.data.amount) * 100));
      return `${i.data.description}${i.data.vendor ? ' · ' + i.data.vendor : ''} · ${amount}${i.photos?.length ? ` · 📷 ${i.photos.length}` : ''}`;
    },
    statusText(i) {
      if (i.status === 'accepted') return 'In the books';
      if (i.status === 'dismissed') return 'Dismissed at desk';
      if (i.error) return 'Needs a fix';
      if (!i.sentItem || (i.photos ?? []).some((p) => !(i.sentPhotos ?? []).includes(p.clientId))) return 'On phone';
      return 'Sent';
    },
    statusClass(i) { return { ok: i.status === 'accepted' || (this.statusText(i) === 'Sent'), warn: this.statusText(i) === 'On phone', bad: Boolean(i.error) }; },
    /** Send what hasn't been sent: trips first (their costs name them), then the rest in the order they were made. */
    async sync() {
      if (this.syncing || !this.key || !this.online) return;
      this.syncing = true;
      try {
        const order = [...this.items].sort((a, b) => (a.kind === 'trip') === (b.kind === 'trip') ? a.createdAt.localeCompare(b.createdAt) : (a.kind === 'trip' ? -1 : 1));
        for (const i of order) {
          try {
            if (!i.sentItem) {
              await this.call('POST', '/items', { clientId: i.clientId, kind: i.kind, data: i.data });
              i.sentItem = true; i.status = 'pending'; i.error = '';
              await putItem(i);
            }
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
        // Which have been accepted at the desk?
        const sent = this.items.filter((i) => i.sentItem && i.status === 'pending').map((i) => i.clientId);
        if (sent.length) {
          for (const s of await this.call('POST', '/status', { clientIds: sent })) {
            const i = this.items.find((x) => x.clientId === s.clientId);
            if (i && i.status !== s.status) { i.status = s.status; await putItem(i); }
          }
        }
        if (this.items.some((i) => i.kind === 'trip' && i.status === 'accepted')) await this.refresh();
      } catch (e) {
        if (e instanceof KeyProblem) this.keyProblem = e.message;
      } finally { this.syncing = false; }
    },
  },
}).mount('#road');
