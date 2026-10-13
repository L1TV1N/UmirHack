import { createHash } from 'node:crypto';

/** Один и тот же код всегда даёт один и тот же ключ: после перезапуска имитации 1С связи в «Запасе» остаются верными. */
export function guidOf(entity: string, code: string): string {
  const h = createHash('sha1').update(`${entity}:${code}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
