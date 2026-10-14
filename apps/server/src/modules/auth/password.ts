import { randomInt } from 'node:crypto';
import { checkPassword } from '@zapas/shared';
import { hash, verify } from '@node-rs/argon2';

// Argon2id, параметры не ниже минимума из рекомендаций OWASP (19 МиБ, 2 прохода, 1 поток)
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Проверка против заведомо неверного хэша, когда пользователя нет или он заблокирован:
 * время ответа не выдаёт, существует ли адрес.
 */
export async function burnVerify(password: string): Promise<void> {
  dummy ??= hashPassword('не-существующий-пароль-для-выравнивания-времени');
  await verifyPassword(await dummy, password);
}

// Без похожих знаков (0/O, 1/l/I): временный пароль читают с экрана и переписывают руками
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Временный пароль для нового сотрудника: 14 знаков, проходит те же проверки, что и обычный пароль. */
export function generatePassword(person: { email: string; fullName: string }): string {
  for (;;) {
    const candidate = Array.from({ length: 14 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    if (/\d/.test(candidate) && /[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && checkPassword(candidate, person) === null) return candidate;
  }
}
