import { loadEnvFile, parseConfig } from '../src/config';
import { migrate } from '../src/db/migrate';

export default async function setup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  loadEnvFile('test');
  const config = parseConfig();
  await migrate({ url: config.migrationDatabaseUrl, appRole: config.dbAppRole });
}
