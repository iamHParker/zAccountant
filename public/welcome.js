// The front page's price list, from the same plan catalog the Admin dashboard uses (src/core/plans.js).
// A plan with no price yet shows "Price to be announced"; prices are Homer's to set.
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
const price = (cents) => (cents == null ? 'Price to be announced' : cents === 0 ? 'Free' : `${dollars(cents)} a month`);

function card(title, cents, note) {
  const div = document.createElement('div');
  div.className = 'card';
  const h = document.createElement('h3'); h.textContent = title;
  const p = document.createElement('p'); p.className = 'price'; p.textContent = price(cents);
  div.append(h, p);
  if (note) { const n = document.createElement('p'); n.textContent = note; div.append(n); }
  return div;
}

try {
  const r = await fetch('/api/public/plans');
  if (r.ok) {
    const { plans, addOns } = await r.json();
    const list = document.getElementById('price-list');
    list.replaceChildren(
      ...plans.filter((p) => p.key !== 'beta').map((p) => card(p.name, p.monthlyCents, p.note)),
      ...addOns.map((a) => card(`${a.name} add-on`, a.monthlyCents)),
    );
  }
} catch { /* keep the "to be announced" cards already on the page */ }
