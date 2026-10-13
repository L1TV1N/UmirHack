import { hasForbiddenChars } from '@zapas/shared';
import type { Deps } from '../../lib/context';
import { executeAction, parseAction, prepareAction } from './actions';
import type { Buttons, TelegramApi, TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from './api';
import { BUTTON_COMMANDS, greeting, HELP_TEXT, MAIN_MENU, MENU_COMMANDS, parseCommand, runCommand, type CommandContext } from './commands';
import { isTopic, subscriptionsView, toggleTopic } from './subscriptions';
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
 * отвечает на команды и нажатия кнопок от имени привязанного пользователя. Только личные чаты. Изменения (скидка, списание) только по кнопке после подтверждения и с правами этого сотрудника.
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

  private async reply(chatId: number, text: string, buttons?: Buttons): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, buttons);
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'бот Telegram: ответ не отправлен');
    }
  }

  /** Заменяет сообщение с кнопками его новым видом. Если Telegram не дал (сообщение старое), отвечает новым. */
  private async replace(chatId: number, messageId: number | undefined, text: string, buttons: Buttons = []): Promise<void> {
    if (messageId !== undefined) {
      try {
        await this.api.editMessage(chatId, messageId, text, buttons);
        return;
      } catch (err) {
        this.deps.log.warn({ err: errorText(err) }, 'бот Telegram: сообщение не удалось изменить');
      }
    }
    await this.reply(chatId, text, buttons.length > 0 ? buttons : undefined);
  }

  /** Нажатие кнопки. Те же правила, что и для сообщений: личный чат, привязанный сотрудник, его права и точки. */
  private async handleCallback(q: TelegramCallbackQuery): Promise<void> {
    const answer = (text?: string) => this.api.answerCallback(q.id, text).catch(() => undefined);
    const chat = q.message?.chat;
    if (!chat || chat.type !== 'private' || q.from.is_bot || q.from.id !== chat.id || typeof q.data !== 'string' || q.data.length > 64) {
      await answer();
      return;
    }
    const chatId = chat.id;
    const messageId = q.message?.message_id;
    if (!this.allowed(chatId)) {
      await answer('Слишком часто, подождите минуту');
      return;
    }
    try {
      const known = await principalOfChat(this.deps, chatId);
      if (!known || known === 'inactive' || known.principal.kind !== 'user') {
        await answer('Нет доступа');
        return;
      }
      const ctx: CommandContext = { deps: this.deps, principal: known.principal, user: known.row };
      const sep = q.data.indexOf(':');
      const head = sep < 0 ? q.data : q.data.slice(0, sep);
      const rest = sep < 0 ? '' : q.data.slice(sep + 1);

      if (head === 'cmd' && BUTTON_COMMANDS.has(rest)) {
        const out = await runCommand(ctx, { name: rest, args: '' });
        if (out) await this.reply(chatId, out.text, out.buttons);
        await answer();
      } else if (head === 'sub' && isTopic(rest)) {
        const view = subscriptionsView(await toggleTopic(this.deps.db, known.row.id, rest));
        await this.replace(chatId, messageId, view.text, view.buttons);
        await answer('Сохранено');
      } else if (head === 'a') {
        const action = parseAction(rest);
        const prepared = action ? await prepareAction(ctx, action) : ({ ok: false, error: 'Кнопка устарела' } as const);
        if (!action || !prepared.ok) {
          await this.reply(chatId, prepared.ok ? 'Кнопка устарела.' : prepared.error);
          await answer();
        } else {
          await this.reply(chatId, prepared.text, [[{ text: 'Да, выполнить', data: `y:${rest}` }, { text: 'Отмена', data: 'n' }]]);
          await answer();
        }
      } else if (head === 'y') {
        const action = parseAction(rest);
        const result = action ? await executeAction(ctx, action, `tg-${q.id}`) : 'Кнопка устарела.';
        await this.replace(chatId, messageId, result);
        await answer('Готово');
      } else if (head === 'n') {
        await this.replace(chatId, messageId, 'Отменено.');
        await answer();
      } else {
        await answer();
      }
    } catch (err) {
      this.deps.log.error({ err: errorText(err) }, 'бот Telegram: нажатие кнопки не обработано');
      await answer('Не удалось выполнить');
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }
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
      const out = await runCommand(ctx, cmd);
      if (out) await this.reply(chatId, out.text, out.buttons);
      else await this.reply(chatId, 'Не знаю такой команды. Список: /help');
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
        await this.reply(chatId, greeting({ deps: this.deps, principal: known.principal, user: known.row }), MAIN_MENU);
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
        await this.reply(chatId, `Готово, чат привязан.\n\n${greeting({ deps: this.deps, principal: known.principal, user: known.row })}`, MAIN_MENU);
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

