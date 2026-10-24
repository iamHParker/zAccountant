// Beta feedback: a tester's "something went wrong" report, and the Developer dashboard's work on it.
// ℹ️ Like a field report from a job site: the tester writes what they saw, the page attaches the
// instrument readings on its own (page, browser, last clicks, recent errors), and optionally a picture.
// A developer then triages it and turns it into a write-up a Claude Code session can act on.
//
// Customer data: the picture can show a tester's books and the note is free text, so neither is ever
// logged, row-level security limits each row to its sender and developers, and the Claude write-up
// leaves out who sent it (Claude needs the problem, not the person).
import { LedgerError } from '../core/ledger.js';

export const MAX_NOTE = 4000;
export const MAX_PICTURE_BYTES = 4_000_000;
export const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_STRING = 1000;
const MAX_LIST = 40;
const MAX_DEPTH = 5;
export const STATUSES = ['new', 'reviewing', 'sent_to_claude', 'not_a_defect', 'fixed'];
export const STATUS_LABELS = { new: 'New', reviewing: 'Reviewing', sent_to_claude: 'Sent to Claude', not_a_defect: 'Not a defect', fixed: 'Fixed' };

/** Copy a JSON value with every size capped, so a broken or hostile page can't fill the database. */
export function boundValue(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(v)) return v.slice(-MAX_LIST).map((x) => boundValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, MAX_LIST)) {
      const b = boundValue(x, depth + 1);
      if (b !== undefined) out[String(k).slice(0, 100)] = b;
    }
    return out;
  }
  return undefined;
}

/**
 * A picture sent as a data URL ("data:image/png;base64,...") -> { bytes, type }, or null when none.
 * Only PNG and JPEG, checked by their first bytes (the "magic number"), not by what the page claims.
 */
export function readPicture(dataUrl) {
  if (dataUrl == null || dataUrl === '') return null;
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new LedgerError('The picture must be a PNG or JPEG image');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_PICTURE_BYTES) throw new LedgerError('The picture is too large (4 MB at most)');
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!(png && m[1] === 'image/png') && !(jpeg && m[1] === 'image/jpeg')) throw new LedgerError('The picture must be a PNG or JPEG image');
  return { bytes, type: m[1] };
}

/** Check what the Beta feedback dialog sent. */
export function checkFeedbackInput(raw) {
  const note = String(raw?.note ?? '').trim();
  if (!note) throw new LedgerError('Say in a few words what went wrong');
  if (note.length > MAX_NOTE) throw new LedgerError(`Keep the note under ${MAX_NOTE} characters`);
  const ctx = raw?.context && typeof raw.context === 'object' && !Array.isArray(raw.context) ? raw.context : {};
  const context = boundValue(ctx);
  if (Buffer.byteLength(JSON.stringify(context)) > MAX_CONTEXT_BYTES) throw new LedgerError('The captured details are too large to send');
  const picture = readPicture(raw?.picture);
  const pictureSource = picture ? (raw?.pictureSource === 'photo' ? 'photo' : 'screen') : null;
  return { note, context, picture, pictureSource };
}

export async function createReport(db, user, companyId, input, { appVersion = '' } = {}) {
  const v = checkFeedbackInput(input);
  const { rows: [r] } = await db.query(
    `INSERT INTO feedback_reports (user_id, reporter_name, reporter_email, company_id, app_version, note, context, picture, picture_type, picture_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, number`,
    [user.id, user.name, user.email, companyId, appVersion, v.note, v.context, v.picture?.bytes ?? null, v.picture?.type ?? null, v.pictureSource]);
  return { id: r.id, number: Number(r.number) };
}

const summary = (r) => ({
  id: r.id, number: Number(r.number), createdAt: r.created_at, reporterName: r.reporter_name, reporterEmail: r.reporter_email,
  companyId: r.company_id, appVersion: r.app_version, status: r.status, statusLabel: STATUS_LABELS[r.status],
  hasPicture: r.has_picture, pictureSource: r.picture_source, page: r.context?.location?.tab ?? '',
  noteStart: r.note.length > 120 ? `${r.note.slice(0, 120)}…` : r.note, updatedAt: r.updated_at, updatedBy: r.updated_by,
});

export async function listReports(db, { status = null } = {}) {
  if (status != null && !STATUSES.includes(status)) throw new LedgerError('Unknown status');
  const { rows } = await db.query(
    `SELECT id, number, created_at, reporter_name, reporter_email, company_id, app_version, status, note, context, picture_source,
            picture IS NOT NULL AS has_picture, updated_at, updated_by
       FROM feedback_reports WHERE ($1::text IS NULL OR status = $1) ORDER BY number DESC LIMIT 500`, [status]);
  const { rows: counts } = await db.query('SELECT status, count(*)::int AS n FROM feedback_reports GROUP BY status');
  return { reports: rows.map(summary), counts: Object.fromEntries(STATUSES.map((s) => [s, counts.find((c) => c.status === s)?.n ?? 0])), statuses: STATUS_LABELS };
}

export async function getReport(db, id, { siteUrl = '' } = {}) {
  const { rows: [r] } = await db.query(
    'SELECT *, picture IS NOT NULL AS has_picture, length(picture) AS picture_bytes FROM feedback_reports WHERE id = $1', [id]);
  if (!r) throw new LedgerError('Report not found');
  const full = { ...summary(r), note: r.note, context: r.context, pictureBytes: r.picture_bytes ?? 0,
    claudeText: r.claude_text, developerNote: r.developer_note };
  return { ...full, claudeDraft: r.claude_text ?? buildClaudeText(full, { siteUrl }) };
}

export async function getPicture(db, id) {
  const { rows: [r] } = await db.query('SELECT number, picture, picture_type FROM feedback_reports WHERE id = $1', [id]);
  if (!r?.picture) throw new LedgerError('That report has no picture');
  return { name: `report-${r.number}.${r.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: r.picture_type, body: r.picture };
}

/** A developer changes the status, their own note, or the write-up for Claude (any of the three). */
export async function updateReport(db, id, input, { actor }) {
  const sets = []; const vals = [];
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new LedgerError('Unknown status');
    vals.push(input.status); sets.push(`status = $${vals.length}`);
  }
  if (input.developerNote !== undefined) {
    const n = String(input.developerNote ?? '');
    if (n.length > 4000) throw new LedgerError('Keep the note under 4000 characters');
    vals.push(n); sets.push(`developer_note = $${vals.length}`);
  }
  if (input.claudeText !== undefined) {
    const t = input.claudeText == null ? null : String(input.claudeText);
    if (t != null && t.length > 20000) throw new LedgerError('Keep the write-up under 20,000 characters');
    vals.push(t?.trim() ? t : null); sets.push(`claude_text = $${vals.length}`);
  }
  if (!sets.length) throw new LedgerError('Nothing to change');
  vals.push(actor, id);
  const { rowCount } = await db.query(
    `UPDATE feedback_reports SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length - 1} WHERE id = $${vals.length}`, vals);
  if (!rowCount) throw new LedgerError('Report not found');
  return { ok: true };
}

const line = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fence = (s) => `\`\`\`\n${String(s ?? '').replace(/```/g, 'ʼʼʼ')}\n\`\`\``;

/**
 * The starting write-up a developer edits and gives to Claude Code: the problem and everything needed to
 * reproduce it, in Markdown. Leaves out the reporter's name and email and the company's name.
 */
export function buildClaudeText(r, { siteUrl = '' } = {}) {
  const c = r.context ?? {};
  const loc = c.location ?? {};
  const actions = Array.isArray(c.actions) ? c.actions : [];
  const errors = Array.isArray(c.errors) ? c.errors : [];
  const out = [];
  out.push(`## zAccountant beta report ${r.number} (version ${line(r.appVersion) || 'not captured'})`, '');
  out.push('**What the tester wrote:**', fence(r.note), '');
  out.push('| | |', '|---|---|');
  out.push(`| reported | ${new Date(r.createdAt).toISOString()} |`);
  out.push(`| screen | ${line(loc.tab) || '?'}${loc.panel ? ` › ${line(loc.panel)}` : ''} |`);
  out.push(`| their role in the company | ${line(loc.role) || 'no company open'} |`);
  out.push(`| browser | ${line(c.browser?.userAgent) || 'not captured'} |`);
  out.push(`| window | ${c.viewport?.width ?? '?'}×${c.viewport?.height ?? '?'} (screen ${c.screen?.width ?? '?'}×${c.screen?.height ?? '?'}) |`);
  out.push('', `**Last ${actions.length} clicks (oldest first):**`);
  out.push(actions.length ? actions.map((a, i) => `${i + 1}. ${line(a.at)} ${line(a.what)}`).join('\n') : 'none captured');
  out.push('', `**Recent errors (${errors.length}):**`);
  out.push(errors.length ? fence(errors.map((e) => `${line(e.at)} [${line(e.kind)}] ${line(e.message)}${e.reqId ? ` (request ${line(e.reqId)})` : ''}`).join('\n')) : 'none captured');
  out.push('');
  if (r.hasPicture) {
    out.push(`**Picture:** a ${r.pictureSource === 'photo' ? 'photo the tester attached' : 'picture of the screen'} is on the report${siteUrl ? ` (${siteUrl.replace(/\/$/, '')} → Developer → report ${r.number})` : ''}; attach it to this message if it shows the problem.`);
  } else out.push('**Picture:** none.');
  out.push('', 'Please find the cause, fix it with a test that fails before the fix, and open a PR.');
  return out.join('\n');
}

/** Numbers for the top of the Developer dashboard (counts only: no names, no amounts). */
export async function platformCounts(db) {
  const { rows: [c] } = await db.query('SELECT * FROM zacc_platform_counts()');
  return { users: Number(c.users), companies: Number(c.companies), signedInToday: Number(c.signed_in_today) };
}
