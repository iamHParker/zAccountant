// Photos kept with a payment: the check and the printed remittance (Homer, 2026-10-25). The browser shrinks
// each picture before sending it (a JPEG data: URL). ⚠️ A check photo carries the payer's bank account and
// routing numbers: the audit trail records that a photo was added or removed and its size, never the picture.
import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../core/ledger.js';
import { appendAudit } from './audit.js';
import { readPicture } from './feedbackService.js';

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PHOTO_BYTES = 3_145_728;
export const MAX_PHOTOS_PER_PAYMENT = 6;

async function payment(c, companyId, paymentId) {
  if (typeof paymentId !== 'string' || !UUIDISH.test(paymentId)) throw new LedgerError('Payment not found');
  const { rows: [p] } = await c.query('SELECT id, status FROM payments WHERE company_id = $1 AND id = $2', [companyId, paymentId]);
  if (!p) throw new LedgerError('Payment not found');
  return p;
}

/** The photos of a payment: ids and dates (the pictures themselves come from getPaymentPhoto). */
export async function listPaymentPhotos(db, companyId, paymentId) {
  await payment(db, companyId, paymentId);
  const { rows } = await db.query(
    'SELECT id, picture_type, octet_length(picture) AS bytes, created_at, created_by FROM payment_photos WHERE company_id = $1 AND payment_id = $2 ORDER BY created_at, id',
    [companyId, paymentId]);
  return rows.map((r) => ({ id: r.id, type: r.picture_type, bytes: Number(r.bytes), createdAt: r.created_at, createdBy: r.created_by }));
}

export async function addPaymentPhoto(pool, companyId, paymentId, { picture, actor = null }) {
  const p = readPicture(picture);
  if (!p) throw new LedgerError('Choose a photo');
  if (p.bytes.length > MAX_PHOTO_BYTES) throw new LedgerError('The photo is too large (3 MB at most)');
  return withTransaction(pool, async (c) => {
    const pay = await payment(c, companyId, paymentId);
    if (pay.status === 'void') throw new LedgerError('This payment is void; add the photo to the payment that replaced it');
    const { rows: [{ n }] } = await c.query('SELECT count(*)::int AS n FROM payment_photos WHERE company_id = $1 AND payment_id = $2', [companyId, paymentId]);
    if (n >= MAX_PHOTOS_PER_PAYMENT) throw new LedgerError(`A payment can have at most ${MAX_PHOTOS_PER_PAYMENT} photos`);
    const { rows: [r] } = await c.query(
      'INSERT INTO payment_photos (company_id, payment_id, picture, picture_type, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
      [companyId, paymentId, p.bytes, p.type, actor]);
    await appendAudit(c, companyId, { action: 'add_photo', entity: 'payment', entityId: paymentId, actor, payload: { photoId: r.id, bytes: p.bytes.length } });
    return { id: r.id, type: p.type, bytes: p.bytes.length, createdAt: r.created_at, createdBy: actor };
  });
}

export async function getPaymentPhoto(db, companyId, paymentId, photoId) {
  if (typeof photoId !== 'string' || !UUIDISH.test(photoId)) throw new LedgerError('Photo not found');
  const { rows: [r] } = await db.query('SELECT picture, picture_type FROM payment_photos WHERE company_id = $1 AND payment_id = $2 AND id = $3',
    [companyId, paymentId, photoId]);
  if (!r) throw new LedgerError('Photo not found');
  return { name: `payment-photo.${r.picture_type === 'image/png' ? 'png' : 'jpg'}`, type: r.picture_type, body: r.picture, inline: true };
}

/** Remove a photo taken by mistake (only from a payment that is not void, so a voided payment keeps its record). */
export async function deletePaymentPhoto(pool, companyId, paymentId, photoId, { actor = null } = {}) {
  if (typeof photoId !== 'string' || !UUIDISH.test(photoId)) throw new LedgerError('Photo not found');
  return withTransaction(pool, async (c) => {
    const pay = await payment(c, companyId, paymentId);
    if (pay.status === 'void') throw new LedgerError('This payment is void; its photos are kept with its history');
    const { rowCount } = await c.query('DELETE FROM payment_photos WHERE company_id = $1 AND payment_id = $2 AND id = $3', [companyId, paymentId, photoId]);
    if (!rowCount) throw new LedgerError('Photo not found');
    await appendAudit(c, companyId, { action: 'remove_photo', entity: 'payment', entityId: paymentId, actor, payload: { photoId } });
    return { removed: true };
  });
}

/** Copy a payment's photos to the payment that replaces it (Edit). Runs inside replacePayment's transaction. */
export async function copyPaymentPhotos(c, companyId, fromPaymentId, toPaymentId) {
  await c.query(
    `INSERT INTO payment_photos (company_id, payment_id, picture, picture_type, created_at, created_by)
     SELECT company_id, $3, picture, picture_type, created_at, created_by FROM payment_photos WHERE company_id = $1 AND payment_id = $2`,
    [companyId, fromPaymentId, toPaymentId]);
}
