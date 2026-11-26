// When a photo was taken, from inside the photo file (Homer, 2026-11-26: a gas pump that prints no receipt; "take a
// picture of the gallons and cost and use meta data to get … date, time").
//
// ℹ️ A JPEG photo carries a small block of facts about itself, called EXIF: the camera, the size, and the moment the
// picture was taken ("DateTimeOriginal", written like 2026:11:26 15:47:07, the phone's own clock). The Road page
// shrinks every photo before sending it, and shrinking makes a new picture without that block, so the date is read
// here first, from the original file. iPhone Safari usually removes the location from a photo given to a web page, so
// only the date and time are read; a photo taken with the camera button is simply "now".
//
// How the block is laid out (the TIFF format, like a small file inside the file): the JPEG's APP1 section starts with
// "Exif\0\0", then a byte-order mark ("II" little-endian or "MM" big-endian), then a directory of 12-byte entries
// (tag, type, count, value-or-offset). Directory 0 points (tag 0x8769) at the EXIF directory, which holds
// DateTimeOriginal (0x9003) and, failing that, DateTime (0x0132) in directory 0.

/** "2026:11:26 15:47:07" → { date: "2026-11-26", time: "15:47" }; anything else → null. */
export function exifStamp(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(String(text ?? ''));
  if (!m || m[1] < '2000' || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}

/**
 * The moment a JPEG was taken, from its bytes (an ArrayBuffer): { date, time } or null (no EXIF, a PNG, a screenshot).
 * Never throws: a damaged or unusual file just gives null.
 */
export function photoTakenAt(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.getUint16(0) !== 0xffd8) return null; // not a JPEG
    let p = 2;
    while (p + 4 <= v.byteLength) {
      const marker = v.getUint16(p);
      const size = v.getUint16(p + 2);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) return null; // image data starts: no EXIF before it
      if (marker === 0xffe1 && v.getUint32(p + 4) === 0x45786966) return readTiff(v, p + 10); // "Exif"
      p += 2 + size;
    }
  } catch { /* a damaged file */ }
  return null;
}

function readTiff(v, start) {
  const little = v.getUint16(start) === 0x4949; // "II"
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
  const text = (o, n) => { let s = ''; for (let i = 0; i < n; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  /** One directory → { tag: value } for the tags we want (an ASCII value, or an offset for the EXIF pointer). */
  const dir = (o) => {
    const out = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === 0x8769) out[tag] = u32(e + 8);
      else if ((tag === 0x9003 || tag === 0x0132) && type === 2) out[tag] = text(count > 4 ? u32(e + 8) : e + 8, count);
    }
    return out;
  };
  const ifd0 = dir(u32(4));
  const exif = ifd0[0x8769] ? dir(ifd0[0x8769]) : {};
  return exifStamp(exif[0x9003]) ?? exifStamp(ifd0[0x0132]);
}

/** A chosen or camera photo (a File) → { date, time } it was taken, or null. */
export async function fileTakenAt(file) {
  if (!file || !/jpe?g/i.test(file.type)) return null;
  // The EXIF block is near the start of the file: 128 KB is plenty and keeps a big photo from being read twice.
  return photoTakenAt(await file.slice(0, 128 * 1024).arrayBuffer());
}
