import { TELEGRAM_HOST } from '../notifications/notifier';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface BotCommand {
  command: string;
  description: string;
}

/** Всё, что серверу нужно от Telegram. Интерфейс позволяет подменять сеть в тестах. */
export interface TelegramApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  setCommands(commands: BotCommand[]): Promise<void>;
}

interface ApiReply<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/**
 * Клиент Bot API. Адрес сервера зашит в коде (как и у отправки уведомлений): токен и данные уходят только
 * в Telegram, подменить их получателя настройкой или запросом нельзя. Токен в тексте ошибок не показывается.
 */
export class HttpTelegramApi implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const guard = AbortSignal.timeout(timeoutMs);
    const res = await this.fetchImpl(`${TELEGRAM_HOST}/bot${encodeURIComponent(this.token)}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, guard]) : guard,
    });
    let reply: ApiReply<T> | null = null;
    try {
      reply = (await res.json()) as ApiReply<T>;
    } catch {
      reply = null;
    }
    if (!res.ok || !reply?.ok) {
      throw new TelegramApiError(method, res.status, `Telegram ${method}: ${res.status} ${reply?.description ?? ''}`.trim());
    }
    return reply.result as T;
  }

  async getMe(): Promise<{ username: string }> {
    const me = await this.call<{ username?: string }>('getMe', {}, 10_000);
    return { username: me.username ?? '' };
  }

  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
      (timeoutSeconds + 10) * 1000,
      signal,
    );
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, 10_000);
  }

  async setCommands(commands: BotCommand[]): Promise<void> {
    await this.call('setMyCommands', { commands, scope: { type: 'all_private_chats' } }, 10_000);
  }
}
