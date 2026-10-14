import { SUPPLIER_PORTAL_SIGNATURE_HEADER, SUPPLIER_PORTAL_TIMESTAMP_HEADER, type PortalOrderPush, type SupplierSideStatus } from '@zapas/shared';
import { signedHeaders } from './security';

/** Запросы в «Запас». Каждый подписан общим секретом. */
export interface ZapasClient {
  pushStatus(input: { externalId: string; status: SupplierSideStatus; note?: string | undefined; deliveryOn?: string | undefined }): Promise<{ ok: true } | { ok: false; error: string; status: number }>;
  lookup(inn: string): Promise<{ known: boolean; name: string | null; buyers: number } | null>;
  pull(externalId: string): Promise<PortalOrderPush | null>;
}

export class HttpZapasClient implements ZapasClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async request(method: 'GET' | 'POST', path: string, payload: unknown): Promise<Response> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...signedHeaders(this.secret, payload) },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(8_000),
    });
  }

  async pushStatus(input: { externalId: string; status: SupplierSideStatus; note?: string | undefined; deliveryOn?: string | undefined }) {
    const body = { externalId: input.externalId, status: input.status, ...(input.note ? { note: input.note } : {}), ...(input.deliveryOn ? { deliveryOn: input.deliveryOn } : {}) };
    try {
      const res = await this.request('POST', '/api/supplier-gateway/status', body);
      if (res.ok) return { ok: true as const };
      const message = await res.json().then((j) => (j as { error?: { message?: string } }).error?.message).catch(() => undefined);
      return { ok: false as const, status: res.status, error: message ?? `«Запас» ответил ${res.status}` };
    } catch {
      return { ok: false as const, status: 502, error: '«Запас» не отвечает, попробуйте через минуту' };
    }
  }

  async lookup(inn: string) {
    try {
      const res = await this.request('POST', '/api/supplier-gateway/lookup', { inn });
      return res.ok ? ((await res.json()) as { known: boolean; name: string | null; buyers: number }) : null;
    } catch {
      return null;
    }
  }

  async pull(externalId: string) {
    try {
      const res = await this.request('GET', `/api/supplier-gateway/orders/${externalId}`, { id: externalId });
      return res.ok ? ((await res.json()) as PortalOrderPush) : null;
    } catch {
      return null;
    }
  }
}

export { SUPPLIER_PORTAL_SIGNATURE_HEADER, SUPPLIER_PORTAL_TIMESTAMP_HEADER };
