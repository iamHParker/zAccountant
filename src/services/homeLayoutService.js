// The Home page's cards, as each person arranged them (migration 029). The server keeps the arrangement and checks
// its shape; which cards exist, and what each one does, is decided in the browser (public/app.js HOME_CARDS).
import { LedgerError } from '../core/ledger.js';

const CARD_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_CARDS = 30;

/** { left, right } lists of card ids, or null when the person hasn't arranged anything yet (the browser's default). */
export async function getHomeLayout(db, companyId, userId) {
  const { rows: [r] } = await db.query('SELECT layout FROM home_layouts WHERE company_id = $1 AND user_id = $2', [companyId, userId]);
  return { layout: r?.layout ?? null };
}

export async function saveHomeLayout(db, companyId, userId, input) {
  const seen = new Set();
  const clean = (list) => {
    if (!Array.isArray(list) || list.length > MAX_CARDS) throw new LedgerError('The card list is not valid');
    return list.map((id) => {
      if (typeof id !== 'string' || !CARD_ID.test(id) || seen.has(id)) throw new LedgerError('The card list is not valid');
      seen.add(id);
      return id;
    });
  };
  const layout = { left: clean(input?.left ?? []), right: clean(input?.right ?? []) };
  await db.query(
    `INSERT INTO home_layouts (company_id, user_id, layout) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, user_id) DO UPDATE SET layout = EXCLUDED.layout, updated_at = now()`, [companyId, userId, layout]);
  return { layout };
}
