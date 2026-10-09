import { ApiError } from './client';

/**
 * Сбой, который пройдёт сам: нет сети, сервер перегружен или недоступен. Запрос можно повторить позже.
 * Отказ по существу (400, 403, 404, 409, 422) к ним не относится: повтор даст тот же ответ.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 502 || err.status === 503 || err.status === 504 || err.status === 0;
  return err instanceof TypeError || (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'NetworkError'));
}
