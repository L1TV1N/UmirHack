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

/** Нажатие кнопки под сообщением бота. */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Кнопка под сообщением. data приходит боту при нажатии, не длиннее 64 байт. */
export interface InlineButton {
  text: string;
  data: string;
}
/** Ряды кнопок. */
export type Buttons = InlineButton[][];

export interface BotCommand {
  command: string;
  description: string;
}

/** Всё, что серверу нужно от Telegram. Интерфейс позволяет подменять сеть в тестах. */
export interface TelegramApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, buttons?: Buttons): Promise<void>;
  /** Заменяет текст и кнопки уже отправленного сообщения. Пустые кнопки убирают клавиатуру. */
  editMessage(chatId: number, messageId: number, text: string, buttons?: Buttons): Promise<void>;
  /** Отвечает на нажатие кнопки: без этого у человека крутится индикатор ожидания. */
  answerCallback(callbackId: string, text?: string): Promise<void>;
  setCommands(commands: BotCommand[]): Promise<void>;
}

function markup(buttons?: Buttons): { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  if (!buttons) return {};
  return { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } };
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
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      (timeoutSeconds + 10) * 1000,
      signal,
    );
  }

  async sendMessage(chatId: number, text: string, buttons?: Buttons): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...markup(buttons) }, 10_000);
  }

  async editMessage(chatId: number, messageId: number, text: string, buttons?: Buttons): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...markup(buttons ?? []) }, 10_000);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) }, 10_000);
  }

  async setCommands(commands: BotCommand[]): Promise<void> {
    await this.call('setMyCommands', { commands, scope: { type: 'all_private_chats' } }, 10_000);
  }
}
