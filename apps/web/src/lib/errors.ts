import { formatQty, type Unit } from '@zapas/shared';
import { ApiError } from '../api/client';

interface Shortage {
  name: string;
  unit?: Unit;
  requested: number;
  available: number;
}

/** Текст ошибки для пользователя: подробно для нехватки остатка, иначе сообщение сервера. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Не удалось выполнить операцию. Проверьте связь и повторите.';
  if (err.code === 'insufficient_stock' && Array.isArray(err.details)) {
    const lines = (err.details as Shortage[]).map(
      (d) => `${d.name}: нужно ${formatQty(d.requested, d.unit)}, доступно ${formatQty(d.available, d.unit)}`,
    );
    return `Недостаточно остатка. ${lines.join('; ')}`;
  }
  if (err.code === 'surplus_date_required' && Array.isArray(err.details)) {
    return (err.details as { message: string }[]).map((d) => d.message).join('; ');
  }
  if (err.status === 429) return 'Слишком много запросов, подождите немного.';
  if (err.status === 403) return 'Недостаточно прав для этого действия.';
  return err.message;
}
