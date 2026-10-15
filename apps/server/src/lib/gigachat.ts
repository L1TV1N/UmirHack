import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, fetch as undiciFetch } from 'undici';

const AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_API_URL = 'https://gigachat.devices.sberbank.ru/api/v1';

export interface GigaChatOptions {
  /** Ключ авторизации из личного кабинета (base64 от «идентификатор:секрет»). */
  authKey: string;
  scope: string;
  model: string;
  /** Путь к корневому сертификату Минцифры. Сертификаты Сбера в стандартное хранилище Node не входят. */
  caFile?: string | null;
  /** Крайняя мера для стендов: не проверять сертификат сервиса. */
  insecureTls?: boolean;
  fetchFn?: typeof undiciFetch;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
  attachments?: string[];
}

/** Общий доступ к GigaChat: токен с кешем, запросы с тайм-аутом, ответ модели одним текстом. */
export class GigaChatApi {
  private readonly fetchFn: typeof undiciFetch;
  private readonly dispatcher: Agent | undefined;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GigaChatOptions) {
    this.fetchFn = opts.fetchFn ?? undiciFetch;
    if (opts.caFile || opts.insecureTls) {
      this.dispatcher = new Agent({
        connect: { ca: opts.caFile ? readFileSync(opts.caFile) : undefined, rejectUnauthorized: !opts.insecureTls },
      });
    }
  }

  call(url: string, init: Record<string, unknown>, timeoutMs = 90_000) {
    return this.fetchFn(url, { ...init, dispatcher: this.dispatcher, signal: AbortSignal.timeout(timeoutMs) } as never);
  }

  /** Токен живёт около получаса: берём из кеша, а за минуту до конца просим новый. */
  async authHeaders(): Promise<{ Authorization: string }> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return { Authorization: `Bearer ${this.token.value}` };
    const res = await this.call(AUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.opts.authKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope: this.opts.scope }).toString(),
    });
    if (!res.ok) throw new Error(`GigaChat не дал токен (${res.status})`);
    const data = (await res.json()) as { access_token?: string; expires_at?: number };
    if (!data.access_token) throw new Error('GigaChat не дал токен');
    this.token = { value: data.access_token, expiresAt: data.expires_at ?? Date.now() + 25 * 60_000 };
    return { Authorization: `Bearer ${this.token.value}` };
  }

  /** Один запрос к модели. Возвращает текст ответа. */
  async complete(messages: ChatMessage[], opts: { model?: string; temperature?: number; maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
    const auth = await this.authHeaders();
    const res = await this.call(
      `${GIGACHAT_API_URL}/chat/completions`,
      {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: opts.model ?? this.opts.model,
          temperature: opts.temperature ?? 0.1,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          messages,
        }),
      },
      opts.timeoutMs,
    );
    if (!res.ok) throw new Error(`GigaChat не ответил (${res.status})`);
    return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
  }
}
