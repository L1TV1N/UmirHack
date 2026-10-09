import type { Role } from '@zapas/shared';
import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'zapas';
const AUDIENCE = 'zapas-web';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Семейство сессии (refresh-токенов), к которому привязан токен доступа. */
  sid: string;
  iat: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  secret: string,
  user: { id: string; role: Role; sid: string },
  ttlSeconds: number,
  now: Date,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({ role: user.role, sid: user.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(key(secret));
}

export async function verifyAccessToken(secret: string, token: string, now: Date): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: now,
    });
    if (typeof payload.sub !== 'string' || typeof payload.iat !== 'number' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, role: payload.role as Role, sid: payload.sid, iat: payload.iat };
  } catch {
    return null;
  }
}
