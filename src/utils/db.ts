import { Pool, PoolClient, QueryResult } from 'pg';
import config from '../config';

const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

export type DbPool = Pool;
export type DbClient = PoolClient;
export type QueryExecutor = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export const getDb = (): DbPool => pool;

/**
 * Runs a parametrized query using either the shared pool or a provided client.
 */
export const runQuery = async <T = any>(
  sql: string,
  params: unknown[] = [],
  executor?: QueryExecutor
): Promise<QueryResult<T>> => {
  const target = executor ?? pool;
  return target.query<T>(sql, params);
};

/**
 * Wraps a callback in a BEGIN/COMMIT transaction.
 */
export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
