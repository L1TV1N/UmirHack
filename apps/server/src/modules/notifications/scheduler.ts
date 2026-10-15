import { retryPortalPushes } from '../supplier-portal/service';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { businessToday } from '../../lib/time';
import { getSettings } from '../settings/settings';
import { publishStopList } from '../integrations/service';
import { autoDraftOrders } from '../orders/service';
import { activeLocationIds, syncStopList } from '../stoplist/service';
import { autoWriteoffExpired, describeAutoWriteoff } from '../stock/auto-writeoff';
import { sendPersonalDigests } from '../telegram/delivery';
import { purgeStorefront } from '../storefront/service';
import { purgeExpiredCodes } from '../telegram/links';
import { sendDigest } from './digest';

const LOCK_KEY = 9_182_736_450;
const TICK_MS = 60_000;

function hourIn(timeZone: string, at: Date): number {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(at);
  return Number(h) % 24;
}

/**
 * Раз в минуту пересчитывает автоматический стоп-лист и в назначенный час отправляет сводку.
 * Блокировка в БД гарантирует, что при нескольких экземплярах работает только один.
 */
export async function schedulerTick(deps: Deps): Promise<void> {
  await deps.db.transaction().execute(async (trx) => {
    const lock = await sql<{ ok: boolean }>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS ok`.execute(trx);
    if (!lock.rows[0]?.ok) return;

    await syncStopList(deps, await activeLocationIds(deps));
    // ручные стопы с истёкшим сроком и всё, что не поймали операции, уходит подписчикам здесь
    await publishStopList(deps, null).catch((err) => deps.log.error({ err }, 'не удалось подготовить вебхуки стоп-листа'));
    await cleanup(deps);
    await retryPortalPushes(deps).catch((err) => deps.log.error({ err }, 'не удалось повторить отправку заказов в кабинет поставщика'));

    const settings = await getSettings(deps.db);
    const now = deps.clock();
    const key = businessToday(deps);

    // просроченное списывается один раз за сутки, в первую же минуту после полуночи по времени бизнеса или при первом запуске
    if (settings.autoWriteoffExpired) {
      const written = await trx
        .insertInto('notification_log')
        .values({ kind: 'auto_writeoff', dedupe_key: key, sent_at: now })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (written) {
        const result = await autoWriteoffExpired(deps).catch((err) => {
          deps.log.error({ err }, 'не удалось выполнить автоматическое списание');
          return null;
        });
        if (!result || result.failed.length > 0) {
          // не всё получилось: отметку снимаем, и на следующей минуте попробуем снова
          await trx.deleteFrom('notification_log').where('id', '=', written.id).execute();
        }
        if (result && result.documents > 0 && deps.notifier.enabled) {
          await deps.notifier.send(describeAutoWriteoff(result.documents)).catch((err) => deps.log.error({ err }, 'не удалось отправить сообщение об автосписании'));
        }
      }
    }

    if (hourIn(deps.config.businessTz, now) !== settings.digestHour) return;

    // черновики заказов по поставщикам с автозаказом: раз в сутки, независимо от того, подключён ли Telegram
    const orders = await trx
      .insertInto('notification_log')
      .values({ kind: 'auto_order', dedupe_key: key, sent_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (orders) {
      try {
        await autoDraftOrders(deps);
      } catch (err) {
        // не получилось: отметку снимаем, и на следующей минуте попробуем снова, а сводка не должна из-за этого задерживаться
        deps.log.error({ err }, 'не удалось подготовить черновики заказов');
        await trx.deleteFrom('notification_log').where('id', '=', orders.id).execute();
      }
    }

    // личные сводки по подпискам идут независимо от общего чата
    await sendPersonalDigests(deps).catch((err) => deps.log.error({ err }, 'не удалось разослать личные сводки'));

    if (!deps.notifier.enabled) return;
    const marker = await trx
      .insertInto('notification_log')
      .values({ kind: 'digest', dedupe_key: key, sent_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!marker) return;
    // при ошибке отправки исключение откатит транзакцию вместе с меткой, и сводку повторят на следующей минуте
    await sendDigest(deps);
  });
}

const CLEANUP_EVERY_MS = 3_600_000;
let lastCleanup = 0;

/** Раз в час убирает отработавшие сессии и старые отметки об уведомлениях, чтобы таблицы не росли вечно. */
async function cleanup(deps: Deps): Promise<void> {
  const now = deps.clock();
  if (now.getTime() - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now.getTime();
  const sessionCutoff = new Date(now.getTime() - 2 * 86_400_000);
  const logCutoff = new Date(now.getTime() - 45 * 86_400_000);
  await deps.db.deleteFrom('refresh_tokens').where('expires_at', '<', sessionCutoff).execute();
  await deps.db
    .deleteFrom('refresh_tokens')
    .where('revoked_at', 'is not', null)
    .where('revoked_at', '<', sessionCutoff)
    .execute();
  await deps.db.deleteFrom('notification_log').where('sent_at', '<', logCutoff).execute();
  await deps.db.deleteFrom('webhook_deliveries').where('status', '<>', 'pending').where('created_at', '<', new Date(now.getTime() - 30 * 86_400_000)).execute();
  await purgeExpiredCodes(deps.db, deps.clock());
  await purgeStorefront(deps);
}

export function startScheduler(deps: Deps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    schedulerTick(deps)
      .catch((err) => deps.log.error({ err }, 'ошибка планировщика'))
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
