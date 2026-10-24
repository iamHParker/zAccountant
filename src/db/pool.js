// PostgreSQL connection pool. DATABASE_URL example: postgres://user:pass@localhost:5432/zacc
import pg from 'pg';

// Return BIGINT (int8) columns as JS numbers. Safe because all money is cents and
// Number.MAX_SAFE_INTEGER cents is about $90 trillion; values beyond that throw.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`bigint ${v} exceeds safe integer range`);
  return n;
});
// Keep DATE columns as 'YYYY-MM-DD' strings (no time-zone surprises).
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 10) });
}

/** Run fn(client) inside a transaction; rolls back on any error. */
export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
