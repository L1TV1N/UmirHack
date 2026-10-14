import { describeDaysLeft, plural } from '@zapas/shared';
import type { AutoStop } from '../../domain/stoplist';
import type { Deps } from '../../lib/context';
import { canSeeLocation } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { getHotDishes } from '../analytics/service';
import { buildDigest } from '../notifications/digest';
import { escapeHtml } from '../notifications/notifier';
import { loadUser, userPrincipal } from '../users/users';
import { MAIN_MENU } from './commands';
import { subscribersOf } from './subscriptions';

const e = escapeHtml;
const SHOWN = 15;

/** Текст о новых позициях в стоп-листе. Один для общего чата и для личных подписок. */
export function newStopsText(stops: readonly AutoStop[]): string {
  const lines = stops.slice(0, SHOWN).map((a) => `• <b>${e(a.name)}</b> (${e(a.locationName)}): ${e(a.reasons[0]?.text ?? '')}`);
  const more = stops.length > SHOWN ? `\nи ещё ${stops.length - SHOWN}` : '';
  return `<b>Новые позиции в стоп-листе</b>\n${lines.join('\n')}${more}`;
}

async function principalOf(deps: Deps, userId: string) {
  const loaded = await loadUser(deps.db, userId);
  return loaded && loaded.row.is_active ? userPrincipal(loaded) : null;
}

/** Личные уведомления тем, кто подписан на стоп-лист: каждому только то, что на его точках. */
export async function notifyStopListSubscribers(deps: Deps, stops: readonly AutoStop[]): Promise<void> {
  if (!deps.telegram || stops.length === 0) return;
  for (const sub of await subscribersOf(deps.db, 'stoplist')) {
    try {
      const principal = await principalOf(deps, sub.userId);
      if (!principal) continue;
      const mine = stops.filter((s) => canSeeLocation(principal, s.locationId));
      if (mine.length > 0) await deps.telegram.sendMessage(sub.chatId, newStopsText(mine));
    } catch (err) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'не удалось отправить личное уведомление о стоп-листе');
    }
  }
}

/** Горячие блюда для сводки: коротко, тремя строками. */
async function hotSection(deps: Deps, principal: NonNullable<Awaited<ReturnType<typeof principalOf>>>): Promise<string> {
  const items = (await getHotDishes(deps, principal)).items.slice(0, 3);
  if (items.length === 0) return '';
  const lines = items.map((d) => {
    const why = d.reasons[0];
    return `• <b>${e(d.dishName)}</b> (${e(d.locationName)}): ${why ? `${e(why.productName)} ${describeDaysLeft(why.daysLeft)}, ` : ''}продать около ${d.portionsToPush} ${plural(d.portionsToPush, ['порции', 'порций', 'порций'])}`;
  });
  return `\n\n<b>Горячие предложения</b>\n${lines.join('\n')}`;
}

/**
 * Личные утренние сводки: каждому подписанному по его точкам. Отметка в журнале не даёт отправить сводку дважды за сутки,
 * при сбое отметка снимается и следующий проход планировщика повторит.
 */
export async function sendPersonalDigests(deps: Deps): Promise<number> {
  if (!deps.telegram) return 0;
  const day = businessToday(deps);
  const now = deps.clock();
  let sent = 0;
  for (const sub of await subscribersOf(deps.db, 'digest')) {
    const marker = await deps.db
      .insertInto('notification_log')
      .values({ kind: 'digest_user', dedupe_key: `${day}:${sub.userId}`, sent_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!marker) continue;
    try {
      const principal = await principalOf(deps, sub.userId);
      if (!principal) continue;
      const text = (await buildDigest(deps, principal)) + (sub.topics.includes('hot') ? await hotSection(deps, principal) : '');
      await deps.telegram.sendMessage(sub.chatId, text, MAIN_MENU);
      sent += 1;
    } catch (err) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'не удалось отправить личную сводку');
      await deps.db.deleteFrom('notification_log').where('id', '=', marker.id).execute();
    }
  }
  return sent;
}
