import { hasForbiddenChars } from '@zapas/shared';
import type { Deps } from '../../lib/context';
import type { TelegramApi, TelegramMessage, TelegramUpdate } from './api';
import { greeting, HELP_TEXT, MENU_COMMANDS, parseCommand, runCommand, type CommandContext } from './commands';
import { BOT_META, consumeLinkCode, normalizeCode, principalOfChat, unlink } from './links';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
/** Подбор кода привязки: после стольких промахов подряд чат на время теряет право пробовать. */
const LINK_FAIL_MAX = 5;
const LINK_LOCK_MS = 15 * 60_000;
const TEXT_MAX = 300;

const CLOSED = [
  'Это закрытый бот системы «Запас». Данные видны только сотрудникам.',
  '',
  'Чтобы подключиться: войдите в веб-интерфейс, откройте меню пользователя, выберите «Telegram» и нажмите «Получить код».',
  'Затем отправьте мне <code>/link КОД</code> (или откройте ссылку из окна, она подставит код сама).',
].join('\n');

export interface BotOptions {
  /** Пауза между попытками после ошибки сети. В тестах подменяется. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Бот: принимает сообщения опросом (getUpdates, исходящее соединение, публичный адрес серверу не нужен) и
 * отвечает на команды от имени привязанного пользователя. Только чтение, только личные чаты.
 */
export class TelegramBot {
  private username = '';
  private readonly hits = new Map<number, number[]>();
  private readonly linkFails = new Map<number, { fails: number; until: number }>();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly deps: Deps,
    private readonly api: TelegramApi,
    options: BotOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Подпись бота и меню команд. Сбой не мешает работе: опрос всё равно пойдёт, а меню обновится при следующем запуске. */
  async prepare(): Promise<void> {
    try {
      this.username = (await this.api.getMe()).username;
      await this.api.setCommands(MENU_COMMANDS);
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'бот Telegram: не удалось получить имя бота или задать меню команд');
    }
  }

  private allowed(chatId: number): boolean {
    const now = this.deps.clock().getTime();
    const recent = (this.hits.get(chatId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    this.hits.set(chatId, recent);
    if (this.hits.size > 5000) {
      for (const [id, list] of this.hits) if (list.every((t) => now - t >= RATE_WINDOW_MS)) this.hits.delete(id);
    }
    return recent.length <= RATE_MAX;
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text);
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'бот Telegram: ответ не отправлен');
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || typeof msg.text !== 'string') return;
    // группы, каналы и сообщения других ботов не обслуживаем: команды видят данные только в личном чате с сотрудником
    if (msg.chat.type !== 'private' || msg.from?.is_bot || (msg.from && msg.from.id !== msg.chat.id)) return;
    const chatId = msg.chat.id;
    if (!this.allowed(chatId)) return;

    if (msg.text.length > TEXT_MAX || hasForbiddenChars(msg.text.replace(/\n/g, ' '))) {
      await this.reply(chatId, 'Не понял сообщение. Список команд: /help');
      return;
    }
    const cmd = parseCommand(msg.text, this.username);
    if (!cmd) {
      if (msg.text.trim().startsWith('/')) return; // команда другого бота
      const known = await principalOfChat(this.deps, chatId);
      await this.reply(chatId, known && known !== 'inactive' ? 'Я понимаю команды. Список: /help' : CLOSED);
      return;
    }

    if (cmd.name === 'start' || cmd.name === 'link') {
      await this.link(msg, cmd.args);
      return;
    }

    try {
      const known = await principalOfChat(this.deps, chatId);
      if (known === null) {
        await this.reply(chatId, cmd.name === 'help' ? `${CLOSED}\n\n${HELP_TEXT}` : CLOSED);
        return;
      }
      if (known === 'inactive') {
        await this.reply(chatId, 'Учётная запись отключена, доступ к боту закрыт.');
        return;
      }
      if (known.principal.kind !== 'user') return;
      const ctx: CommandContext = { deps: this.deps, principal: known.principal, user: known.row };

      if (cmd.name === 'unlink') {
        await unlink(this.deps, known.row.id, known.principal, BOT_META);
        await this.reply(chatId, 'Чат отвязан. Чтобы подключить снова, получите новый код в веб-интерфейсе.');
        return;
      }
      const text = await runCommand(ctx, cmd);
      await this.reply(chatId, text ?? 'Не знаю такой команды. Список: /help');
    } catch (err) {
      this.deps.log.error({ err: errorText(err) }, 'бот Telegram: команда не выполнена');
      await this.reply(chatId, 'Не удалось выполнить команду. Попробуйте ещё раз чуть позже.');
    }
  }

  private async link(msg: TelegramMessage, rawCode: string): Promise<void> {
    const chatId = msg.chat.id;
    const code = normalizeCode(rawCode);

    if (!code) {
      const known = await principalOfChat(this.deps, chatId);
      if (known && known !== 'inactive' && known.principal.kind === 'user') {
        await this.reply(chatId, greeting({ deps: this.deps, principal: known.principal, user: known.row }));
      } else {
        await this.reply(chatId, CLOSED);
      }
      return;
    }

    const now = this.deps.clock().getTime();
    const state = this.linkFails.get(chatId);
    if (state && state.until > now) {
      await this.reply(chatId, 'Слишком много неверных кодов. Подождите несколько минут и получите новый код в веб-интерфейсе.');
      return;
    }

    try {
      const result = await consumeLinkCode(this.deps, code, { id: chatId, username: msg.from?.username });
      if (!result.ok) {
        const fails = (state && state.until === 0 ? state.fails : 0) + 1;
        this.linkFails.set(chatId, { fails, until: fails >= LINK_FAIL_MAX ? now + LINK_LOCK_MS : 0 });
        if (this.linkFails.size > 5000) this.linkFails.clear();
        await this.reply(
          chatId,
          result.reason === 'inactive'
            ? 'Учётная запись отключена.'
            : result.reason === 'chat_taken'
              ? 'Этот чат уже привязан к другой учётной записи. Сначала отправьте /unlink из неё или обратитесь к администратору.'
              : 'Код не подошёл: он неверный, уже использован или истёк (действует 10 минут). Получите новый в веб-интерфейсе.',
        );
        return;
      }
      this.linkFails.delete(chatId);
      const known = await principalOfChat(this.deps, chatId);
      if (known && known !== 'inactive' && known.principal.kind === 'user') {
        await this.reply(chatId, `Готово, чат привязан.\n\n${greeting({ deps: this.deps, principal: known.principal, user: known.row })}`);
      }
    } catch (err) {
      this.deps.log.error({ err: errorText(err) }, 'бот Telegram: привязка не выполнена');
      await this.reply(chatId, 'Не удалось выполнить привязку. Попробуйте ещё раз чуть позже.');
    }
  }

  /** Опрос Telegram до сигнала остановки. Ошибки сети и чужой опрос с тем же токеном переживаем с нарастающей паузой. */
  async run(signal: AbortSignal): Promise<void> {
    await this.prepare();
    let offset = 0;
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = await this.api.getUpdates(offset, 25, signal);
        backoff = 1000;
        for (const update of updates) {
          // сдвигаем смещение до обработки: сообщение, на котором мы падаем, не должно прийти снова
          offset = update.update_id + 1;
          await this.handleUpdate(update).catch((err) => this.deps.log.error({ err: errorText(err) }, 'бот Telegram: сбой обработки'));
        }
      } catch (err) {
        if (signal.aborted) break;
        this.deps.log.warn({ err: errorText(err), retryInMs: backoff }, 'бот Telegram: опрос не удался');
        await this.sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Запускает опрос в фоне. Возвращает остановку, которая дожидается конца цикла. */
  start(): () => Promise<void> {
    const controller = new AbortController();
    const loop = this.run(controller.signal).catch((err) => this.deps.log.error({ err: errorText(err) }, 'бот Telegram остановлен ошибкой'));
    return async () => {
      controller.abort();
      await loop;
    };
  }
}

/** В журнал попадает только текст, без адреса запроса, где зашит токен. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/bot\d+:[\w-]+/g, 'bot***') : String(err);
}

