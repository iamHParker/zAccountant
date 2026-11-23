// "Is this project already on the list?" (Homer, 2026-11-23). He had 26-143 "Richards, NHWIC OK007208-01..." and,
// later, 26-151 "Richards (OK007208-01)" for the same insurance claim, and the trip costs landed on one while the
// office time went on the other. Before a new project is added, the desk and the phone look for one that already
// carries the same claim number or the same street address, and ask first. It never stops the save: two projects for
// one site can be right (a second claim on the same house).
// Shared by the desk (app.js) and the phone (road.js); runs on the phone with no signal, from its project list.

/** Letters and digits only, upper case: "OK007208-01" -> "OK00720801". */
const squash = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Claim and policy numbers in a project's name: a run of letters, digits and dashes with at least 5 digits that also
 * has a letter ("OK007208-01", "CLM12345"), or with 7 digits or more ("0043218876"). The project's own number
 * (26-151), a house number (9112) and a ZIP code (73099) are not claim numbers.
 */
export function claimNumbers(text, ownNumber = '') {
  const own = squash(ownNumber);
  const out = [];
  for (const m of String(text ?? '').matchAll(/[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]/g)) {
    const s = squash(m[0]);
    const digits = s.replace(/\D/g, '').length;
    if (s === own) continue;
    if ((digits >= 5 && /[A-Z]/.test(s)) || (digits >= 7 && digits === s.length)) { if (!out.includes(s)) out.push(s); }
  }
  return out;
}

// Street words written different ways: "9112 NW 142nd Street" and "9112 N.W. 142nd St" are the same place.
const WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln', boulevard: 'blvd', court: 'ct', circle: 'cir',
  place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter', trail: 'trl', way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w', northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se',
};

const SUFFIX = new Set(['st', 'ave', 'rd', 'dr', 'ln', 'blvd', 'ct', 'cir', 'pl', 'pkwy', 'hwy', 'ter', 'trl', 'way']);

/**
 * The street part of an address, the same way however it was typed: house number + street, lower case, short
 * street words, no street type at the end, no punctuation. Only the first line, and only up to the first comma ("9112 NW 142nd, Yukon, OK" ->
 * "9112 nw 142nd"). '' unless it starts with a house number.
 */
export function streetKey(address) {
  const first = String(address ?? '').split(/\r?\n/)[0].split(',')[0];
  const words = first.toLowerCase().replace(/(\b[nsew])\.\s*([nsew])\./g, '$1$2').replace(/[.#]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => WORDS[w] ?? w);
  // "9112 NW 142nd" and "9112 NW 142nd Street" are the same place, so the street type at the end is left off.
  if (words.length >= 3 && SUFFIX.has(words[words.length - 1])) words.pop();
  return words.length >= 2 && /^\d+[a-z]?$/.test(words[0]) ? words.join(' ') : '';
}

/** A street address written into a project's name ("26-002 DWH, 285 Bridgestone Way, Buda, TX"), as streetKey. */
function streetsInName(name) {
  return String(name ?? '').split(',').map((part) => streetKey(part.trim())).filter((k) => k && /\s[a-z]/.test(k));
}

/**
 * Projects on the list that look like the one being added: [{ job, why }], `why` in plain words
 * ("same claim number OK00720801", "same address (9112 NW 142nd)"). form = { name, code, address }; exceptId = the
 * project being edited (it never matches itself).
 */
export function similarProjects(jobs, form, exceptId = null) {
  const claims = claimNumbers(`${form?.name ?? ''} ${form?.code ?? ''}`, form?.code);
  const streets = [streetKey(form?.address), ...streetsInName(form?.name)].filter(Boolean);
  const out = [];
  for (const j of jobs ?? []) {
    if (!j || (exceptId && j.id === exceptId)) continue;
    const text = squash(`${j.name ?? ''} ${j.code ?? ''}`);
    const claim = claims.find((c) => text.includes(c));
    if (claim) { out.push({ job: j, why: `same claim number ${claim}` }); continue; }
    const theirs = [streetKey(j.address), ...streetsInName(j.name)].filter(Boolean);
    const street = streets.find((s) => theirs.includes(s));
    if (street) out.push({ job: j, why: `same address (${String(j.address ?? '').split(/\r?\n/)[0].split(',')[0].trim() || street})` });
  }
  return out;
}
