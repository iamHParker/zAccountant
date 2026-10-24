// Beta feedback: what the page records on its own so a tester only has to say what went wrong.
// ℹ️ Like a flight recorder: the last few clicks and error messages are kept in memory (never sent anywhere
// until the tester presses Send). Clicks are recorded by their button LABEL only, never anything typed.
const MAX_ACTIONS = 20;
const MAX_ERRORS = 20;
const MAX_LABEL = 60;
const actions = [];
const errors = [];

const stamp = () => new Date().toISOString().slice(11, 19);
const short = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > MAX_LABEL ? `${t.slice(0, MAX_LABEL)}…` : t; };
const keep = (list, item, max) => { list.push(item); if (list.length > max) list.shift(); };

const CLICKABLE = 'button, a, summary, select, input[type="checkbox"], input[type="radio"]';
function labelOf(el) {
  const named = el.getAttribute('aria-label') || el.getAttribute('title');
  if (named) return short(named);
  if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return short(el.closest('label')?.textContent || el.name || el.tagName.toLowerCase());
  return short(el.textContent);
}

/** Start recording (once, when the page loads). */
export function startRecorder() {
  document.addEventListener('click', (e) => {
    try {
      const el = e.target?.closest?.(CLICKABLE);
      if (!el || el.closest('.feedback-dialog')) return;
      keep(actions, { at: stamp(), what: `click ${el.tagName.toLowerCase()} "${labelOf(el)}"` }, MAX_ACTIONS);
    } catch { /* recording never breaks the page */ }
  }, true);
  window.addEventListener('error', (e) => noteError('error', `${e.message}${e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}` : ''}`));
  window.addEventListener('unhandledrejection', (e) => noteError('promise', e.reason?.message ?? e.reason));
}

/** Record an error: the page's own, or a request the server refused (with its request id for the logs). */
export function noteError(kind, message, reqId = null) {
  try { keep(errors, { at: stamp(), kind, message: String(message ?? '').slice(0, 300), ...(reqId ? { reqId } : {}) }, MAX_ERRORS); } catch { /* ignore */ }
}

/** Everything the report carries besides the note and the picture. `where` = { tab, panel, role }. */
export function captureContext(where) {
  return {
    capturedAt: new Date().toISOString(),
    browser: { userAgent: navigator.userAgent, language: navigator.language },
    screen: { width: screen.width, height: screen.height, dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    location: where,
    actions: actions.slice(),
    errors: errors.slice(),
  };
}

const MAX_SIDE = 1600;      // pixels: plenty to read an error message, small enough to send quickly
const MAX_PIXELS = 16_000_000; // iPhone Safari draws a blank canvas above about 16.7 million pixels

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.htmlToImage) return resolve();
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('the picture tool did not load')) });
    document.head.append(s);
  });
}

/** A picture of the visible window, leaving out the feedback dialog itself -> JPEG data URL. */
export async function pictureOfScreen() {
  await loadScript('/vendor/html-to-image.js');
  const w = window.innerWidth; const h = window.innerHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  const x = Math.round(window.scrollX); const y = Math.round(window.scrollY);
  const bg = getComputedStyle(document.body).backgroundColor;
  return window.htmlToImage.toJpeg(document.body, {
    quality: 0.85, width: w, height: h, canvasWidth: w, canvasHeight: h, pixelRatio: ratio, skipFonts: true,
    backgroundColor: bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#ffffff',
    style: x || y ? { transform: `translate(${-x}px, ${-y}px)`, transformOrigin: 'top left' } : undefined,
    filter: (n) => !(n?.nodeType === 1 && (n.classList?.contains('feedback-dialog') || n.classList?.contains('toast'))),
  });
}

/**
 * A photo or picture file the person chose, shrunk to at most `maxSide` pixels on its longer side -> data URL
 * (JPEG for photos; PNG keeps a logo's lines and lettering crisp).
 */
export async function pictureFromFile(file, { maxSide = MAX_SIDE, type = 'image/jpeg' } = {}) {
  if (!/^image\//.test(file?.type ?? '')) throw new Error('Choose a picture (a photo or a screenshot)');
  // Read as a data: URL (the page's security policy allows data: pictures, not blob: ones).
  const src = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('That picture could not be read'));
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That picture could not be opened. Try a JPEG or PNG.'));
    i.src = src;
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
}
