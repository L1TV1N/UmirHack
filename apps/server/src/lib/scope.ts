import { notFound } from './errors';
import type { Principal } from './context';

export function canSeeLocation(p: Principal, locationId: string): boolean {
  return p.locationIds === 'all' || p.locationIds.includes(locationId);
}

/** Чужая точка выглядит как несуществующая. */
export function assertLocation(p: Principal, locationId: string): void {
  if (!canSeeLocation(p, locationId)) throw notFound('Точка');
}

/**
 * Список точек для выборки. null означает «без ограничения» (только для тех, кто видит все точки
 * и не просил конкретную). Пустой массив означает «ничего не доступно».
 */
export function locationFilter(p: Principal, requested?: string): string[] | null {
  if (requested) {
    assertLocation(p, requested);
    return [requested];
  }
  return p.locationIds === 'all' ? null : p.locationIds;
}
