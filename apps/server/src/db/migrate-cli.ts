import { loadEnvFile, parseConfig } from '../config';
import { migrate } from './migrate';

loadEnvFile();
const config = parseConfig();

migrate({
  url: config.migrationDatabaseUrl,
  appRole: config.dbAppRole,
  log: (m) => console.log(m),
})
  .then((applied) => {
    console.log(applied.length ? `Готово, применено миграций: ${applied.length}` : 'Схема актуальна');
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
