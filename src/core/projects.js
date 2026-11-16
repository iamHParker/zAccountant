// Projects from folder names (Homer, 2026-10-25). Homer keeps one folder per project, named by project number
// and name ("2601 Smith Residence", "2602 - DWH Jones roof"). In File Explorer, select the folders, Shift +
// right-click → "Copy as path", and paste: each line is a path in quotes ("C:\Jobs\2026\2601 Smith Residence").
// A plain list of names (one per line, or `dir /b` output) works too.
//
// Pure: no database. The service adds the projects that aren't on the list yet.

const MAX_LINES = 2000;

/** The last part of a path, without quotes or a trailing slash: "C:\Jobs\2601 Smith\" → "2601 Smith". */
export function folderName(line) {
  let s = String(line ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); // eslint-disable-line no-control-regex
  s = s.replace(/^["']+|["']+$/g, '').trim().replace(/[\\/]+$/, '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1].replace(/\s+/g, ' ').trim();
}

/**
 * One folder name → { name, code }. The project number is the leading run of digits (with an optional
 * letter prefix or suffix and dashes or dots inside, e.g. 2601, 26-014, P2601, 2601A); the name keeps the
 * whole folder name, so two "Smith Residence" projects with different numbers stay apart.
 * A name with no number gets code null.
 */
export function parseProjectFolder(line) {
  const name = folderName(line);
  if (!name) return null;
  // A comma, semicolon or bracket also ends the number ("26-147, Smith" → 26-147; before 2026-11-16 the comma didn't,
  // and "26-147, 26-148" was read as number 26).
  const m = /^([A-Za-z]{0,3}\d[\d.-]*[A-Za-z]?)(?=$|[\s_–—:,;()-])/.exec(name);
  const code = m ? m[1].replace(/[.-]+$/, '') : null;
  return { name: name.slice(0, 80), code: code && code.length <= 30 ? code : null };
}

const NUMBER = '[A-Za-z]{0,3}\\d[\\d.-]*[A-Za-z]?';
const NUMBER_LIST = new RegExp(`^${NUMBER}(?:\\s*(?:[,;&/+]|\\band\\b)\\s*${NUMBER})+$`, 'i');

/**
 * A line that is only project numbers ("26-147, 26-148", "2601 & 2602", "26-147 and 26-148") → the numbers, else null.
 * Homer, 2026-11-16: a trip typed with "26-147, 26-148" in New project numbers became one project numbered 26.
 */
export function numberList(line) {
  const s = String(line ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); // eslint-disable-line no-control-regex
  if (!NUMBER_LIST.test(s)) return null;
  return s.split(/\s*(?:[,;&/+]|\band\b)\s*/i).map((x) => x.replace(/[.-]+$/, '')).filter(Boolean);
}

/**
 * Project numbers or names typed on the phone (a trip's "New project numbers") → { name, code } each, one per project:
 * a line of numbers only is split into its numbers; any other line is one project, read like a folder name.
 * Repeats are dropped. A number alone has the number as its name too, so it matches that project if it is on the list.
 */
export function typedProjects(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines ?? []) {
    const list = numberList(line);
    const found = list ? list.map((n) => ({ name: n.slice(0, 80), code: n.length <= 30 ? n : null })) : [parseProjectFolder(line)].filter(Boolean);
    for (const p of found) {
      if (seen.has(p.name.toLowerCase())) continue;
      seen.add(p.name.toLowerCase());
      out.push(p);
    }
  }
  return out;
}

/** Pasted text → unique projects (by name, ignoring case), in the order pasted; blank lines skipped. */
export function parseProjectList(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length > MAX_LINES) throw new Error(`Paste at most ${MAX_LINES} folders at a time`);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const p = parseProjectFolder(line);
    if (!p || seen.has(p.name.toLowerCase())) continue;
    // A divider folder ("26-010 ----------") is not a project.
    if (!/[A-Za-z0-9]/.test(p.code ? p.name.slice(p.code.length) : p.name)) continue;
    seen.add(p.name.toLowerCase());
    out.push(p);
  }
  return out;
}

const STATES = { texas: 'TX', colorado: 'CO', california: 'CA', 'district of columbia': 'DC' };
const STREET = /(^|\s)(\d{1,6}[A-Za-z]?\s+[A-Za-z])/; // "285 Bridgestone", "4602 Finley"; not "TX40571901"

/**
 * The parts of a folder name after its number (Homer, 2026-10-26): "26-002 DWH, 285 Bridgestone Way, Buda, TX DIR".
 * Up to the first comma is the customer; then, until the street address, a reference (claim number, attorney,
 * builder); then the street, the city and the state; anything after the state is a note ("DIR", "- XO Opinion").
 * A street that starts inside the first part splits it: "Garner NHWIC TX40571901 4602 Finley, Austin, TX".
 * A name with no comma has no parts ("26-007 Trophy Oak" stays a project name). Returns
 * { customer, reference, address ("street\ncity, ST"), note, name (the folder name without the address) }.
 */
export function splitProjectName(name, code) {
  const none = { customer: null, reference: null, address: null, note: null, name };
  let rest = name;
  if (code && rest.startsWith(code)) rest = rest.slice(code.length).replace(/^[\s_–—:-]+/, '');
  if (!rest.includes(',')) return none;
  const segs = rest.split(',').map((s) => s.trim()).filter(Boolean);
  // Where the street starts: the first part holding "digits + word".
  let at = -1; let street = null;
  for (let i = 0; i < segs.length; i++) {
    const m = STREET.exec(segs[i]);
    if (m) { at = i; street = segs[i].slice(m.index + m[1].length); if (i === 0) segs.splice(0, 1, segs[0].slice(0, m.index).trim(), street); break; }
  }
  if (at === 0) at = 1; // the first part was split in two
  const customer = segs[0] || null;
  if (at < 0) return { ...none, customer, reference: segs.slice(1).join(', ') || null };
  const reference = segs.slice(1, at).join(', ') || null;
  const after = segs.slice(at + 1);
  // The state is the last part that starts with a state (TX, Texas…); the city is the part before it.
  let note = null; let city = null; let state = null;
  const last = after.at(-1) ?? '';
  const sm = /^([A-Za-z]{2}|texas|colorado|california|district of columbia)\b\.?\s*(?:\d{5}(?:-\d{4})?)?\s*[-–—]?\s*(.*)$/i.exec(last);
  if (after.length >= 2 && sm) {
    state = STATES[sm[1].toLowerCase()] ?? sm[1].toUpperCase();
    note = sm[2].trim() || null;
    city = after.slice(0, -1).join(', ');
  } else city = after.join(', ') || null;
  const address = [segs[at], [city, state].filter(Boolean).join(', ')].filter(Boolean).join('\n').slice(0, 300) || null;
  const short = [code, [customer, reference].filter(Boolean).join(', ')].filter(Boolean).join(' ') + (note ? ` - ${note}` : '');
  return { customer, reference, address, note, name: (short || name).slice(0, 80) };
}
