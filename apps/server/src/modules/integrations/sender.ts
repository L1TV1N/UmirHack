import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { guardedLookup, isPrivateAddress } from './guard';

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookSender {
  /** Возвращает код ответа. Сетевая ошибка и таймаут это исключение с понятным текстом. */
  send(req: WebhookRequest): Promise<{ status: number }>;
}

const MAX_DRAIN_BYTES = 16 * 1024;

/** Короткое описание сбоя для журнала доставок: без внутренностей и без адресов. */
export function describeSendError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'ESSRF') return 'адрес указывает во внутреннюю сеть';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'адрес не найден (DNS)';
  if (code === 'ECONNREFUSED') return 'соединение отклонено';
  if (code === 'ECONNRESET') return 'соединение разорвано';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'не ответил вовремя';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'ошибка сертификата';
  if (err instanceof Error && err.message === 'timeout') return 'не ответил вовремя';
  return 'сбой соединения';
}

/**
 * Настоящая отправка: только POST, без переходов по перенаправлениям, с проверкой адреса в момент соединения,
 * с ограничением времени и без чтения ответа дальше первых килобайт.
 */
export class HttpWebhookSender implements WebhookSender {
  constructor(
    private readonly opts: { allowPrivate: boolean; timeoutMs?: number },
  ) {}

  send(req: WebhookRequest): Promise<{ status: number }> {
    const url = new URL(req.url);
    // у адреса из цифр поиск по DNS не выполняется, поэтому проверяем его здесь
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (!this.opts.allowPrivate && isIP(literal) && isPrivateAddress(literal)) {
      return Promise.reject(Object.assign(new Error('Адрес указывает во внутреннюю сеть'), { code: 'ESSRF' }));
    }
    const transport = url.protocol === 'https:' ? https : http;
    const timeoutMs = this.opts.timeoutMs ?? 8000;
    return new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: 'POST',
          agent: false,
          lookup: guardedLookup({ allowPrivate: this.opts.allowPrivate }) as never,
          headers: { ...req.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(req.body)), 'user-agent': 'Zapas-Webhook/1' },
        },
        (res) => {
          let drained = 0;
          res.on('data', (chunk: Buffer) => {
            drained += chunk.length;
            if (drained > MAX_DRAIN_BYTES) res.destroy();
          });
          res.on('error', () => undefined);
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      const timer = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
      request.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      request.on('close', () => clearTimeout(timer));
      request.end(req.body);
    });
  }
}

/** Для тестов: запоминает запросы, отвечает заданным кодом или ошибкой. */
export class FakeWebhookSender implements WebhookSender {
  readonly requests: WebhookRequest[] = [];
  /** Сколько ближайших запросов должны упасть. */
  failNext = 0;
  failStatus: number | null = null;
  status = 200;

  async send(req: WebhookRequest): Promise<{ status: number }> {
    this.requests.push(req);
    if (this.failNext > 0) {
      this.failNext -= 1;
      if (this.failStatus !== null) return { status: this.failStatus };
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
    }
    return { status: this.status };
  }
}
