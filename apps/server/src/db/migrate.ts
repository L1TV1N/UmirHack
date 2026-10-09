import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const LOCK_KEY = 7_203_411;

// Таблицы, где прикладной роли нужен DELETE. Всё остальное удаляется только «мягко».
const DELETABLE = [
  'user_locations',
  'dish_items',
  'inventory_lines',
  'refresh_tokens',
  'stop_list_state',
  'notification_log',
  'telegram_links',
  'supplier_item_map',
  'telegram_link_codes',
  'webhook_endpoints',
  'webhook_deliveries',
  'purchase_order_lines',
  'calendar_days',
];
// Журналы только на добавление: даже владелец приложения не может переписать историю.
const APPEND_ONLY = ['stock_movements', 'audit_log', 'batch_marks'];

export interface MigrateOptions {
  url: string;
  appRole: string;
  dir?: string;
  log?: (message: string) => void;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function applyGrants(client: pg.PoolClient, appRole: string, log: (m: string) => void): Promise<void> {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appRole]);
  if (exists.rowCount === 0) {
    log(`Роль ${appRole} не найдена, права не выдаются (подключение будет под владельцем схемы)`);
    return;
  }
  const role = `"${appRole}"`;
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT DELETE ON ${DELETABLE.join(', ')} TO ${role}`);
  await client.query(`REVOKE UPDATE ON ${APPEND_ONLY.join(', ')} FROM ${role}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
}

export async function migrate(options: MigrateOptions): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const dir = options.dir ?? fileURLToPath(new URL('./migrations', import.meta.url));
  const pool = new pg.Pool({ connectionString: options.url, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>();
    const rows = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    for (const r of rows.rows) done.set(r.name, r.checksum);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(`${dir}/${file}`, 'utf8');
      const sum = checksum(sql);
      const known = done.get(file);
      if (known) {
        if (known !== sum) throw new Error(`Миграция ${file} изменена после применения`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${file} не применена: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`Применена миграция ${file}`);
    }
    await applyGrants(client, options.appRole, log);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}
