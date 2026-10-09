export interface Notifier {
  readonly enabled: boolean;
  send(text: string): Promise<void>;
}

export class NoopNotifier implements Notifier {
  readonly enabled = false;
  async send(): Promise<void> {}
}

/** Для тестов: складывает сообщения в массив. */
export class MemoryNotifier implements Notifier {
  readonly enabled = true;
  readonly messages: string[] = [];
  async send(text: string): Promise<void> {
    this.messages.push(text);
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Хост зашит в коде: адрес куда уходят данные нельзя подменить конфигурацией или запросом. */
export const TELEGRAM_HOST = 'https://api.telegram.org';

export class TelegramNotifier implements Notifier {
  readonly enabled = true;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<void> {
    const res = await this.fetchImpl(`${TELEGRAM_HOST}/bot${encodeURIComponent(this.token)}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: text.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`Telegram ответил статусом ${res.status}`);
    }
  }
}
