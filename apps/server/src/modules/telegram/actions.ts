import { daysBetween, describeDaysLeft, formatMoneyWhole, formatQty, hasRole, type Unit } from '@zapas/shared';
import { AppError, notFound } from '../../lib/errors';
import { canSeeLocation } from '../../lib/scope';
import { businessToday } from '../../lib/time';
import { getRecommendations } from '../analytics/service';
import { escapeHtml } from '../notifications/notifier';
import { createPromotion } from '../promotions/service';
import { writeOff } from '../stock/operations';
import type { CommandContext } from './commands';
import { BOT_META } from './links';

/** Действия над рекомендацией, которые можно выполнить кнопкой. Данные кнопки не длиннее 64 байт. */
export type Action = { kind: 'discount'; batchId: string; percent: number } | { kind: 'writeoff'; batchId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const e = escapeHtml;

export function encodeAction(a: Action): string {
  return a.kind === 'discount' ? `d:${a.batchId}:${a.percent}` : `w:${a.batchId}`;
}

/** Строго разбирает данные кнопки: всё, что не похоже на созданное самим ботом, отбрасывается. */
export function parseAction(code: string): Action | null {
  const parts = code.split(':');
  if (parts[0] === 'd' && parts.length === 3 && UUID.test(parts[1] as string) && /^\d{1,2}$/.test(parts[2] as string)) {
    const percent = Number(parts[2]);
    return percent >= 1 && percent <= 90 ? { kind: 'discount', batchId: parts[1] as string, percent } : null;
  }
  if (parts[0] === 'w' && parts.length === 2 && UUID.test(parts[1] as string)) return { kind: 'writeoff', batchId: parts[1] as string };
  return null;
}

export type Prepared = { ok: true; text: string } | { ok: false; error: string };

async function loadBatch(ctx: CommandContext, batchId: string) {
  const row = await ctx.deps.db
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .select(['b.id', 'b.location_id', 'b.remaining_qty', 'b.expires_on', 'p.name', 'p.unit', 'l.name as location_name'])
    .where('b.id', '=', batchId)
    .executeTakeFirst();
  // чужая точка выглядит как несуществующая партия
  if (!row || !canSeeLocation(ctx.principal, row.location_id)) throw notFound('Партия');
  return row;
}

function need(ctx: CommandContext, action: Action): string | null {
  if (action.kind === 'discount') return hasRole(ctx.principal.role, 'manager') ? null : 'Скидки включает менеджер или администратор.';
  return hasRole(ctx.principal.role, 'storekeeper') ? null : 'Списывать может кладовщик, менеджер или администратор.';
}

const message = (err: unknown): string => (err instanceof AppError ? err.message : 'Не удалось выполнить действие. Попробуйте в веб-интерфейсе.');

/** Что произойдёт, если нажать «Да»: текст подтверждения. Права и актуальность проверяются сразу. */
export async function prepareAction(ctx: CommandContext, action: Action): Promise<Prepared> {
  const denied = need(ctx, action);
  if (denied) return { ok: false, error: denied };
  try {
    const batch = await loadBatch(ctx, action.batchId);
    const qty = Number(batch.remaining_qty);
    const left = daysBetween(businessToday(ctx.deps), batch.expires_on);
    if (action.kind === 'discount') {
      if (qty <= 0) return { ok: false, error: 'Партия уже распродана.' };
      if (left < 0) return { ok: false, error: 'Срок партии истёк, скидка не нужна: её нужно списать.' };
      return { ok: true, text: `Включить скидку ${action.percent}% на «${e(batch.name)}» (${e(batch.location_name)})? Осталось ${formatQty(qty, batch.unit as Unit)}, срок: ${describeDaysLeft(left)}.` };
    }
    const rec = (await getRecommendations(ctx.deps, ctx.principal, batch.location_id, 'writeoff')).items.find((r) => r.batchId === action.batchId);
    if (!rec) return { ok: false, error: 'Эта партия уже не требует списания.' };
    return { ok: true, text: `Списать ${formatQty(rec.quantity, rec.unit)} «${e(rec.productName)}» (${e(rec.locationName)}) как просроченное? Потеря ${formatMoneyWhole(rec.atRiskValue)} по себестоимости.` };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Выполняет действие от имени сотрудника через те же сервисы, что и веб-интерфейс, с теми же проверками и записью в аудит. */
export async function executeAction(ctx: CommandContext, action: Action, key: string): Promise<string> {
  const denied = need(ctx, action);
  if (denied) return denied;
  try {
    const batch = await loadBatch(ctx, action.batchId);
    if (action.kind === 'discount') {
      await createPromotion(ctx.deps, ctx.principal, BOT_META, { batchId: action.batchId, percent: action.percent });
      return `Скидка ${action.percent}% включена: «${e(batch.name)}» (${e(batch.location_name)}). Касса увидит новую цену.`;
    }
    const rec = (await getRecommendations(ctx.deps, ctx.principal, batch.location_id, 'writeoff')).items.find((r) => r.batchId === action.batchId);
    if (!rec) return 'Эта партия уже не требует списания.';
    const doc = await writeOff(
      ctx.deps,
      { principal: ctx.principal, meta: BOT_META },
      { locationId: batch.location_id, reason: 'expired', comment: 'Списано из Telegram', lines: [{ productId: rec.productId, batchId: action.batchId, quantity: rec.quantity }] },
      key,
    );
    return `Списано ${formatQty(rec.quantity, rec.unit)} «${e(rec.productName)}». Документ ${doc.number}.`;
  } catch (err) {
    return message(err);
  }
}
