// Project pick lists (Homer, 2026-11-23): every drop-down that picks a project (invoice, bill lines, trip shares,
// Road time blocks) lists projects by number, newest number first (26-153 above 26-152 above 25-107A), and labels
// every entry the same way: "26-153 · Walberto Rodríguez · Walberto Rodriguez" (number · project · customer).
// Projects imported from folder names often have no separate number; their name starts with it ("26-002 DWH, 285
// Bridgestone Way"), so the number is read from the front of the name. Projects with no number go last, A to Z.
// Shared by the desk (app.js) and the phone (road.js).

const cmp = (x, y) => x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' });

/** The project's number: its code, or the number its name starts with ("26-002 DWH, ..." -> "26-002"), or ''. */
export function projectNumber(j) {
  const code = String(j?.code ?? '').trim();
  if (code) return code;
  return (/^\d[\w.-]*/.exec(String(j?.name ?? '').trim())?.[0] ?? '');
}

/** The name without the number in front of it ("26-002 DWH, 285 ..." -> "DWH, 285 ..."). */
export function projectName(j) {
  const name = String(j?.name ?? '').trim();
  const n = projectNumber(j);
  return n && name.startsWith(n) ? name.slice(n.length).replace(/^[\s\-–—·:,.]+/, '').trim() : name;
}

/** "number · project · customer", leaving out any part that is empty or just repeats the one before. */
export function projectLabel(j) {
  const n = projectNumber(j), name = projectName(j), who = String(j?.customerName ?? '').trim();
  const parts = [n, name];
  if (who && who !== name) parts.push(who);
  return parts.filter(Boolean).join(' · ') || String(j?.name ?? '');
}

/** Highest number first; letter suffixes after their number (26-152A above 26-152); no number last, A to Z. */
export function byNumberNewestFirst(a, b) {
  const x = projectNumber(a), y = projectNumber(b);
  return (!x - !y) || cmp(y, x) || cmp(projectName(a), projectName(b));
}

/** The projects to offer: open ones, plus the one already picked (keepId) even if it has since been closed. */
export function projectChoices(jobs, keepId) {
  return (jobs ?? []).filter((j) => j.isActive !== false || (keepId && j.id === keepId)).sort(byNumberNewestFirst);
}
