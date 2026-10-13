import { loadEnvFile, parseConfig } from './config';
import { createDb } from './db/client';
import { buildApp } from './app';
import { NoopNotifier, TelegramNotifier } from './modules/notifications/notifier';
import { startScheduler } from './modules/notifications/scheduler';
import { GigaChatInvoiceReader } from './modules/invoices/reader';
import { HttpWebhookSender } from './modules/integrations/sender';
import { startWebhookWorker } from './modules/integrations/service';
import { HttpExchangeTransport } from './modules/exchange/transport';
import { startExchangeWorker } from './modules/exchange/service';
import { startForecastWorker } from './modules/forecast/service';
import { OpenMeteoProvider } from './modules/forecast/weather';
import { SmtpMailer } from './modules/orders/mailer';
import { HttpTelegramApi } from './modules/telegram/api';
import { TelegramBot } from './modules/telegram/bot';
import { drainStopListSync } from './modules/stoplist/service';
import { socksFetch } from './modules/telegram/proxy';

loadEnvFile();
const config = parseConfig();
const handle = createDb(config.databaseUrl, config.dbPoolMax);
const telegramFetch = config.telegram?.proxy ? socksFetch(config.telegram.proxy) : fetch;
const notifier = config.telegram
  ? new TelegramNotifier(config.telegram.token, config.telegram.chatId, telegramFetch)
  : new NoopNotifier();

const telegram = config.telegram?.commands ? new HttpTelegramApi(config.telegram.token, telegramFetch) : null;
const invoiceReader = config.invoicePhoto ? new GigaChatInvoiceReader(config.invoicePhoto) : null;
const webhookSender = new HttpWebhookSender({ allowPrivate: config.webhooks.allowPrivate });
const exchangeTransport = new HttpExchangeTransport({ allowHosts: config.exchange.allowHosts });
const mailer = config.smtp ? new SmtpMailer(config.smtp.url, config.smtp.from) : null;
const weather = config.weatherEnabled ? new OpenMeteoProvider() : null;
const base = { db: handle.db, config, clock: () => new Date(), notifier, telegram, invoiceReader, webhookSender, exchangeTransport, mailer, weather };
const app = await buildApp(base);
const runtime = { ...base, log: app.log };
const stopScheduler = config.scheduler ? startScheduler(runtime) : () => undefined;
const stopWebhooks = config.scheduler ? startWebhookWorker(runtime) : () => undefined;
const stopExchange = config.scheduler ? startExchangeWorker(runtime) : () => undefined;
const stopForecast = config.scheduler ? startForecastWorker(runtime) : () => undefined;
const stopBot = telegram ? new TelegramBot(runtime, telegram).start() : async () => undefined;

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'останавливаем сервер');
  const timer = setTimeout(() => process.exit(1), 15_000);
  timer.unref();
  try {
    stopScheduler();
    stopWebhooks();
    stopExchange();
    stopForecast();
    await stopBot();
    await app.close();
    await drainStopListSync(runtime);
    await handle.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'ошибка при остановке');
    process.exit(1);
  }
}
// необработанная ошибка оставляет процесс в неизвестном состоянии: пишем её в журнал и перезапускаемся
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    app.log.fatal({ err }, event);
    void shutdown(event).finally(() => process.exit(1));
  });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, 'не удалось запустить сервер');
  process.exit(1);
}
