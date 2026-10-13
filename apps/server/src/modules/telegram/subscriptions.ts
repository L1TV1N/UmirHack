import { sql } from 'kysely';
import type { Db } from '../../db/client';
import type { Buttons } from './api';

/** Темы, на которые подписывается чат. Подписка личная: сводка и стоп-лист строятся по точкам самого сотрудника. */
export const TOPICS = ['digest', 'stoplist', 'hot'] as const;
export type Topic = (typeof TOPICS)[number];

export const TOPIC_LABELS: Record<Topic, string> = {
  digest: 'Утренняя сводка',
  stoplist: 'Новые позиции в стоп-листе',
  hot: 'Горячие блюда в сводке',
};

const TOPIC_HINTS: Record<Topic, string> = {
  digest: 'раз в день в назначенный час: просрочка, скоро истекающее, деньги под угрозой, главные действия',
  stoplist: 'сразу, когда блюдо или продукт на вашей точке попал в стоп-лист',
  hot: 'в утренней сводке: какие блюда продвигать, пока не истёк срок продуктов',
};

export const isTopic = (value: string): value is Topic => (TOPICS as readonly string[]).includes(value);

const normalize = (list: readonly string[]): Topic[] => TOPICS.filter((t) => list.includes(t));

export async function topicsOf(db: Db, userId: string): Promise<Topic[]> {
  const row = await db.selectFrom('telegram_links').select('topics').where('user_id', '=', userId).executeTakeFirst();
  return row ? normalize(row.topics) : [];
}

/** Включает или выключает тему и возвращает новый набор. */
export async function toggleTopic(db: Db, userId: string, topic: Topic): Promise<Topic[]> {
  const current = await topicsOf(db, userId);
  const next = current.includes(topic) ? current.filter((t) => t !== topic) : normalize([...current, topic]);
  await db.updateTable('telegram_links').set({ topics: next }).where('user_id', '=', userId).execute();
  return next;
}

/** Текст и кнопки экрана «Уведомления». Нажатие на кнопку переключает тему. */
export function subscriptionsView(topics: readonly Topic[]): { text: string; buttons: Buttons } {
  const lines = ['<b>Уведомления в этот чат</b>', ''];
  for (const t of TOPICS) lines.push(`${topics.includes(t) ? 'Включено' : 'Выключено'}: ${TOPIC_LABELS[t]}. ${TOPIC_HINTS[t]}.`);
  lines.push('', 'Нажмите кнопку, чтобы включить или выключить тему.');
  return {
    text: lines.join('\n'),
    buttons: TOPICS.map((t) => [{ text: `${TOPIC_LABELS[t]}: ${topics.includes(t) ? 'вкл' : 'выкл'}`, data: `sub:${t}` }]),
  };
}

export interface Subscriber {
  userId: string;
  chatId: number;
  topics: Topic[];
}

/** Привязанные чаты, подписанные на тему. Отключённые пользователи не включаются. */
export async function subscribersOf(db: Db, topic: Topic): Promise<Subscriber[]> {
  const rows = await db
    .selectFrom('telegram_links as l')
    .innerJoin('users as u', 'u.id', 'l.user_id')
    .select(['l.user_id', 'l.chat_id', 'l.topics'])
    .where('u.is_active', '=', true)
    .where(sql<boolean>`${topic} = ANY(l.topics)`)
    .execute();
  return rows.map((r) => ({ userId: r.user_id, chatId: Number(r.chat_id), topics: normalize(r.topics) }));
}
