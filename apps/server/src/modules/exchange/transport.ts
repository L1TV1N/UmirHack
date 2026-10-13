import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { guardedLookup, isPrivateAddress } from '../integrations/guard';
import { describeSendError } from '../integrations/sender';

export interface ExchangeRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ExchangeResponse {
  status: number;
  body: string;
}

export interface ExchangeTransport {
  /** Сетевая ошибка и таймаут это исключение. Любой полученный ответ, в том числе 4xx и 5xx, возвращается как есть. */
  request(req: ExchangeRequest): Promise<ExchangeResponse>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Адрес сервера обмена допустим, если он по https во внешней сети или явно разрешён администратором сервера. */
export function exchangeHostAllowed(host: string, allowHosts: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return allowHosts.some((a) => a.toLowerCase() === h);
}

export function describeExchangeError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'EEXCHANGE_HTTP') return 'адрес по http допустим только из списка разрешённых (EXCHANGE_ALLOW_HOSTS)';
  return describeSendError(err);
}

/**
 * Настоящий обмен: без переходов по перенаправлениям, с проверкой адреса в момент соединения и с ограничением времени и размера ответа.
 * Серверы 1С обычно стоят во внутренней сети, поэтому такие адреса и обычный http разрешены только тем хостам, что перечислены в EXCHANGE_ALLOW_HOSTS.
 */
export class HttpExchangeTransport implements ExchangeTransport {
  constructor(private readonly opts: { allowHosts: string[]; timeoutMs?: number }) {}

  request(req: ExchangeRequest): Promise<ExchangeResponse> {
    const url = new URL(req.url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const trusted = exchangeHostAllowed(host, this.opts.allowHosts);
    if (url.protocol !== 'https:' && !trusted) {
      return Promise.reject(Object.assign(new Error('Нужен https'), { code: 'EEXCHANGE_HTTP' }));
    }
    if (!trusted && isIP(host) && isPrivateAddress(host)) {
      return Promise.reject(Object.assign(new Error('Адрес указывает во внутреннюю сеть'), { code: 'ESSRF' }));
    }
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const payload = req.body ?? '';
      const request = transport.request(
        url,
        {
          method: req.method,
          agent: false,
          lookup: guardedLookup({ allowPrivate: trusted }) as never,
          headers: {
            ...req.headers,
            ...(payload ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
            'user-agent': 'Zapas-Exchange/1',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              res.destroy(Object.assign(new Error('Ответ слишком большой'), { code: 'EEXCHANGE_BIG' }));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      const timer = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
      request.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      request.on('close', () => clearTimeout(timer));
      request.end(payload || undefined);
    });
  }
}
