import pg from 'pg';

// numeric -> string (exakt), wird in Repos in Rappen umgerechnet
pg.types.setTypeParser(1700, v => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/**
 * Verbindung zu PostgreSQL. In Azure (Flexible Server) ist TLS Pflicht:
 * DATABASE_SSL=require prüft das Serverzertifikat gegen die System-CAs.
 */
export function createPool(url: string, ssl: 'disable' | 'require' = (process.env.DATABASE_SSL as 'require') ?? 'disable'): Db {
  return new pg.Pool({
    connectionString: url,
    max: 10,
    ssl: ssl === 'require' ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
