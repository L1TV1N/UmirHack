import { pgCode } from './errors';

const DEADLOCK = '40P01';
const SERIALIZATION = '40001';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Повторяет транзакцию, которую PostgreSQL прервал из-за взаимной блокировки или конфликта версий.
 * Такие отказы временные: после небольшой паузы то же действие обычно проходит. Повторять можно только
 * целую транзакцию, у которой нет побочных эффектов вне базы.
 */
export async function retryOnConflict<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = pgCode(err);
      if ((code === DEADLOCK || code === SERIALIZATION) && attempt < attempts) {
        await pause(15 * attempt + Math.random() * 25);
        continue;
      }
      throw err;
    }
  }
}
