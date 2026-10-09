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
