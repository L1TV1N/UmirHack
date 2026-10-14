import { buildApp } from './app';
import { parseConfig } from './config';
import { openDb } from './db';
import { HttpZapasClient } from './zapas';

const config = parseConfig();
const db = openDb(config.dbFile);
const app = await buildApp({ db, config, zapas: new HttpZapasClient(config.zapasUrl, config.portalSecret), clock: () => new Date() });

await app.listen({ host: config.host, port: config.port });
app.log.info(`Отгрузка: http://${config.host}:${config.port}${config.basePath}/`);

const stop = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'останавливаем кабинет поставщика');
  const timer = setTimeout(() => process.exit(1), 10_000);
  timer.unref();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
