import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SUPPLIER_PORTAL_MAX_SKEW_SECONDS,
  SUPPLIER_PORTAL_SIGNATURE_HEADER,
  SUPPLIER_PORTAL_TIMESTAMP_HEADER,
} from '@zapas/shared';
import { hash, verify } from '@node-rs/argon2';
import { jwtVerify, SignJWT } from 'jose';

const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;
/** Проверка против заведомо неверного хэша: время ответа не выдаёт, есть ли такой адрес. */
export async function burnVerify(password: string): Promise<void> {
  dummy ??= hashPassword('не-существующий-пароль-для-выравнивания-времени');
  await verifyPassword(await dummy, password);
}

const SESSION_TTL_SECONDS = 12 * 3600;
export const SESSION_COOKIE = 'otgruzka_session';

export async function signSession(secret: string, accountId: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(accountId))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function readSession(secret: string, token: string | undefined): Promise<number | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    const id = Number(payload.sub);
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;

/** Сериализация с отсортированными ключами: подпись не зависит от порядка полей. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function signPayload(secret: string, timestamp: string, payload: unknown): string {
  return createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(payload)}`).digest('hex');
}

export function verifySignature(secret: string, timestamp: string | undefined, signature: string | undefined, payload: unknown, now: Date): boolean {
  if (!timestamp || !signature || !/^\d{9,13}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SUPPLIER_PORTAL_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, payload), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const signedHeaders = (secret: string, payload: unknown): Record<string, string> => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    [SUPPLIER_PORTAL_TIMESTAMP_HEADER]: timestamp,
    [SUPPLIER_PORTAL_SIGNATURE_HEADER]: signPayload(secret, timestamp, payload),
  };
};
