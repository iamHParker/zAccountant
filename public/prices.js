// The Prices page's cards (/prices), from the same plan catalog the Admin dashboard uses (src/core/plans.js).
// Each plan is a subscription, monthly or a reduced annual price (Homer, 2026-10-25). Card layout follows
// Homer's RepairWerks pricing page: name, big price, short points, a button. A price not set yet shows a
// "[$ / mo]" placeholder; prices are Homer's to set.
const dollars = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
const per = (cents, unit) => (cents == null ? `[$ / ${unit}]` : `${dollars(cents)} / ${unit}`);

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** One price card. `featured` gets the highlighted border and the filled button. */
function card(p, { featured = false, button = null } = {}) {
  const div = el('div', featured ? 'price-card featured' : 'price-card');
  div.append(el('h3', null, p.name));
  const big = el('p', 'price-big');
  if (p.monthlyCents === 0) {
    big.textContent = 'Free';
    big.append(' ', el('span', 'price-small', 'while testing'));
    div.append(big);
  } else {
    big.textContent = per(p.monthlyCents, 'mo');
    div.append(big, el('p', 'price-annual', `or ${per(p.annualCents, 'yr')}, reduced, paid yearly`));
  }
  const ul = el('ul', 'price-points');
  for (const x of p.points ?? []) ul.append(el('li', null, x));
  div.append(ul);
  if (button) {
    const a = el('a', featured ? 'button primary' : 'button', button.text);
    a.href = button.href;
    div.append(a);
  }
  return div;
}

const BUTTONS = {
  beta: { text: 'Create an account', href: '/app#signup' },
  individual: { text: 'Start', href: '/app#signup' },
  company: { text: 'Start', href: '/app#signup' },
};

try {
  const r = await fetch('/api/public/plans');
  if (r.ok) {
    const { plans, addOns } = await r.json();
    document.getElementById('plan-list').replaceChildren(
      ...plans.map((p) => card(p, { featured: p.key === 'company', button: BUTTONS[p.key] })));
    document.getElementById('addon-list').replaceChildren(...addOns.map((a) => card({ ...a, name: `Add ${a.name}` })));
  }
} catch { /* keep the placeholder cards already on the page */ }
