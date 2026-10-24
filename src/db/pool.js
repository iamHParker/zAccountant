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

/**
 * Run fn(client) inside a transaction; rolls back on any error.
 * If `pool` is already a client inside a request transaction (see withScope), a SAVEPOINT is used
 * instead, and deferred checks (e.g. "entry must balance") are forced to run before it is released,
 * so a failed step is rolled back on its own and reported immediately.
 */
export async function withTransaction(pool, fn) {
  if (pool.__inTx) {
    const sp = `sp_${++pool.__spCount}`;
    await pool.query(`SAVEPOINT ${sp}`);
    try {
      const result = await fn(pool);
      await pool.query('SET CONSTRAINTS ALL IMMEDIATE');
      await pool.query('SET CONSTRAINTS ALL DEFERRED');
      await pool.query(`RELEASE SAVEPOINT ${sp}`);
      return result;
    } catch (err) {
      await pool.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      await pool.query('SET CONSTRAINTS ALL DEFERRED').catch(() => {});
      throw err;
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    client.__inTx = true; // services called inside fn nest as savepoints in this same transaction
    client.__spCount = 0;
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.__inTx = false;
    client.release();
  }
}

/**
 * One database transaction per web request, tagged with who is signed in and which company the
 * request is for. Row-level security policies read these values (zacc.user_id / zacc.company_id).
 */
export async function withScope(pool, { userId = null, companyId = null, platformRole = null }, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('zacc.user_id', $1, true), set_config('zacc.company_id', $2, true), set_config('zacc.platform_role', $3, true)",
      [userId ?? '', companyId ?? '', platformRole ?? '']);
    client.__inTx = true;
    client.__spCount = 0;
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.__inTx = false;
    client.release();
  }
}

/** Point the current request transaction at a company (used right after creating one). */
export async function setScopeCompany(client, companyId) {
  await client.query("SELECT set_config('zacc.company_id', $1, true)", [companyId]);
}
