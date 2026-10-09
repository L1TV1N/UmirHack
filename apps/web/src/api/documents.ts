import { post } from './client';
import { isTransient } from './transient';
import { enqueue } from '../lib/outbox';

export type Submitted<T> = { queued: false; result: T } | { queued: true };

interface Document {
  path: string;
  body: object;
  /** Ключ идемпотентности попытки. Он же сопровождает документ в очереди. */
  key: string;
  /** Как назвать документ в очереди: «Приход, 12 позиций». */
  label: string;
}

/**
 * Оформляет документ. Нет связи или сервер недоступен: документ остаётся в очереди на устройстве и
 * уйдёт сам, когда связь вернётся. Отказ по существу (400, 409, 422) пробрасывается как обычно.
 */
export async function submitDocument<T>(userId: string, doc: Document): Promise<Submitted<T>> {
  const queue = async (): Promise<Submitted<T>> => {
    await enqueue({ userId, label: doc.label, path: doc.path, body: doc.body, key: doc.key });
    return { queued: true };
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return queue();
  try {
    return { queued: false, result: await post<T>(doc.path, doc.body, { 'idempotency-key': doc.key }) };
  } catch (err) {
    if (isTransient(err)) return queue();
    throw err;
  }
}
