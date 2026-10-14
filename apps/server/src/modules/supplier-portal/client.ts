import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SUPPLIER_PORTAL_MAX_SKEW_SECONDS,
  SUPPLIER_PORTAL_SIGNATURE_HEADER,
  SUPPLIER_PORTAL_TIMESTAMP_HEADER,
  type PortalOrderPush,
} from '@zapas/shared';
import { canonicalJson } from '../../lib/crypto';

/** Подпись запроса между «Запасом» и кабинетом поставщика: HMAC-SHA256 от времени и содержимого. */
export function signPortalPayload(secret: string, timestamp: string, payload: unknown): string {
  return createHmac('sha256', secret).update(`${timestamp}.${canonicalJson(payload)}`).digest('hex');
}

export function verifyPortalSignature(secret: string, timestamp: string | undefined, signature: string | undefined, payload: unknown, now: Date): boolean {
  if (!timestamp || !signature || !/^\d{9,13}$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SUPPLIER_PORTAL_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(signPortalPayload(secret, timestamp, payload), 'hex');
  const given = Buffer.from(signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Кабинет поставщика: принимает заказы и сообщает, что с ними стало. */
export interface SupplierPortal {
  /** Адрес кабинета для ссылок в интерфейсе. */
  readonly publicUrl: string;
  push(order: PortalOrderPush): Promise<{ ok: true } | { ok: false; error: string }>;
}

export class HttpSupplierPortal implements SupplierPortal {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    readonly publicUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async push(order: PortalOrderPush): Promise<{ ok: true } | { ok: false; error: string }> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await this.fetchFn(`${this.url.replace(/\/$/, '')}/api/gateway/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SUPPLIER_PORTAL_TIMESTAMP_HEADER]: timestamp,
          [SUPPLIER_PORTAL_SIGNATURE_HEADER]: signPortalPayload(this.secret, timestamp, order),
        },
        body: JSON.stringify(order),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) return { ok: true };
      const detail = await res.json().then((j) => (j as { error?: { message?: string } }).error?.message).catch(() => undefined);
      return { ok: false, error: detail ? `кабинет поставщика ответил: ${detail}` : `кабинет поставщика ответил ${res.status}` };
    } catch {
      return { ok: false, error: 'кабинет поставщика не отвечает' };
    }
  }
}
