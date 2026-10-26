// Pictures copied to the clipboard (Homer, 2026-10-26: a screenshot or a photo already taken, not only a new photo).
// On an iPhone: take the screenshot, tap its thumbnail, Share → Copy; then tap "Paste" here. Safari shows a small
// "Paste" bubble to confirm, so the page only reads the clipboard when the person taps it.
// Returns the pictures as File objects, the same as a file chooser gives, so each page's photo code takes them as is.
export async function picturesFromClipboard() {
  if (!navigator.clipboard?.read) throw new Error('This browser cannot paste pictures here. Use "Choose photo" instead.');
  let items;
  try { items = await navigator.clipboard.read(); } catch { throw new Error('Nothing was pasted. Copy a screenshot or photo first, then tap Paste.'); }
  const files = [];
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (type) files.push(new File([await item.getType(type)], `pasted-${files.length + 1}.${type.split('/')[1]}`, { type }));
  }
  if (!files.length) throw new Error('There is no picture on the clipboard. Copy a screenshot or photo first, then tap Paste.');
  return files;
}
