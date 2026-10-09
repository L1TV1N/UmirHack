import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './types';

// date отдаём как есть («2026-10-08»), иначе pg превратит её в Date по локальному поясу и сдвинет сутки
pg.types.setTypeParser(1082, (value) => value);
// bigint (счётчики и идентификаторы журналов) укладывается в безопасное целое
pg.types.setTypeParser(20, (value) => Number(value));

export type Db = Kysely<Database>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max: number): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 20_000,
  });
  // ошибка на простаивающем соединении не должна ронять процесс
  pool.on('error', () => undefined);
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    close: () => db.destroy(),
  };
}
