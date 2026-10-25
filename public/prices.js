// The Prices page's list (/prices), from the same plan catalog the Admin dashboard uses (src/core/plans.js).
// Each plan is a subscription, monthly or a reduced annual price (Homer, 2026-10-25). A price not set yet
// shows "to be announced"; prices are Homer's to set.
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
const price = (cents, per) => (cents == null ? 'to be announced' : cents === 0 ? 'free' : `${dollars(cents)} a ${per}`);

function card(title, p, note) {
  const div = document.createElement('div');
  div.className = 'card';
  const h = document.createElement('h3'); h.textContent = title;
  const m = document.createElement('p'); m.className = 'price'; m.textContent = `Monthly: ${price(p.monthlyCents, 'month')}`;
  const y = document.createElement('p'); y.className = 'price-annual'; y.textContent = `Yearly (reduced): ${price(p.annualCents, 'year')}`;
  div.append(h, m, y);
  if (note) { const n = document.createElement('p'); n.textContent = note; div.append(n); }
  return div;
}

try {
  const r = await fetch('/api/public/plans');
  if (r.ok) {
    const { plans, addOns } = await r.json();
    document.getElementById('plan-list').replaceChildren(...plans.filter((p) => p.key !== 'beta').map((p) => card(p.name, p, p.note)));
    document.getElementById('addon-list').replaceChildren(...addOns.map((a) => card(`Add ${a.name}`, a)));
  }
} catch { /* keep the "to be announced" cards already on the page */ }
