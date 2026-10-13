import { plural } from '@zapas/shared';
import type { Actor, Deps } from '../../lib/context';
import { AppError } from '../../lib/errors';
import { businessToday } from '../../lib/time';
import { writeOffExpired } from './operations';

const SYSTEM_ACTOR: Actor = {
  principal: { kind: 'system', name: 'Система', locationIds: 'all' },
  meta: { ip: null, userAgent: null, requestId: 'system' },
};

export interface AutoWriteoffResult {
  /** Сколько документов списания создано. */
  documents: number;
  /** Точки, на которых списать не получилось. */
  failed: string[];
}

/**
 * Списывает просроченные партии на всех активных точках одним документом на точку.
 * Ключ идемпотентности привязан к дате и точке, поэтому повторный запуск в те же сутки ничего не задвоит.
 */
export async function autoWriteoffExpired(deps: Deps): Promise<AutoWriteoffResult> {
  const today = businessToday(deps);
  const rows = await deps.db
    .selectFrom('batches as b')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .select('b.location_id')
    .distinct()
    .where('l.is_active', '=', true)
    .where('b.remaining_qty', '>', '0')
    .where('b.expires_on', '<', today)
    .execute();

  let documents = 0;
  const failed: string[] = [];
  for (const { location_id: locationId } of rows) {
    try {
      const doc = await writeOffExpired(deps, SYSTEM_ACTOR, { locationId, comment: 'Автоматическое списание просроченного' }, `auto-expired:${today}:${locationId}`);
      if (!doc.duplicate) documents += 1;
    } catch (err) {
      // остаток могли списать вручную между выборкой и документом
      if (err instanceof AppError && err.code === 'nothing_to_write_off') continue;
      deps.log.error({ err, locationId }, 'не удалось списать просроченное автоматически');
      failed.push(locationId);
    }
  }
  return { documents, failed };
}

export function describeAutoWriteoff(documents: number): string {
  return `Автоматически списано просроченное: ${documents} ${plural(documents, ['документ', 'документа', 'документов'])}. Подробности в журнале операций.`;
}
