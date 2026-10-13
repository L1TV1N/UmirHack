import {
  daysWord,
  describeDaysLeft,
  formatMoneyWhole,
  formatQty,
  hasForbiddenChars,
  hasRole,
  plural,
  ROLE_LABELS,
  type Role,
  type StockRowDto,
} from '@zapas/shared';
import type { Deps, Principal } from '../../lib/context';
import { locationFilter } from '../../lib/scope';
import { getHotDishes, getRecommendations } from '../analytics/service';
import { buildDigest } from '../notifications/digest';
import { escapeHtml } from '../notifications/notifier';
import { stockSummary } from '../stock/queries';
import { getStopForecast, getStopList } from '../stoplist/service';
import type { UserRow } from '../users/users';
import { encodeAction } from './actions';
import type { Buttons } from './api';
import { subscriptionsView, topicsOf } from './subscriptions';

export interface CommandContext {
  deps: Deps;
  principal: Extract<Principal, { kind: 'user' }>;
  user: UserRow;
}

/** Ответ бота: текст и, если нужно, кнопки под ним. */
export interface Reply {
  text: string;
  buttons?: Buttons;
}

/** Главное меню под приветствием и сводкой. Каждая кнопка запускает команду без параметров. */
export const MAIN_MENU: Buttons = [
  [
    { text: 'Сводка', data: 'cmd:today' },
    { text: 'Требует действий', data: 'cmd:risks' },
  ],
  [
    { text: 'Стоп-лист', data: 'cmd:stoplist' },
    { text: 'Горячие блюда', data: 'cmd:hot' },
  ],
  [
    { text: 'Что заказать', data: 'cmd:order' },
    { text: 'Уведомления', data: 'cmd:subscribe' },
  ],
];

/** Команды, которые можно запустить кнопкой. */
export const BUTTON_COMMANDS = new Set(['today', 'risks', 'order', 'stoplist', 'hot', 'subscribe']);

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface ParsedCommand {
  name: string;
  args: string;
}

/** Предел одного сообщения Telegram с запасом: обрезать разметку посередине тега нельзя. */
const MESSAGE_LIMIT = 3800;
const LIST_LIMIT = 10;

/** «/stock@zapashack_bot молоко» → { name: 'stock', args: 'молоко' }. Команду для другого бота пропускаем. */
export function parseCommand(text: string, botUsername?: string): ParsedCommand | null {
  const m = /^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && botUsername && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: (m[1] as string).toLowerCase(), args: (m[3] ?? '').replace(/\s+/g, ' ').trim() };
}

/** Складывает строки, пока помещаются в сообщение. Остальное заменяется пометкой. */
export function fit(lines: string[], limit = MESSAGE_LIMIT): string {
  let used = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (used + line.length + 1 > limit) {
      out.push('…');
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

const e = escapeHtml;
/** «Через 5 ч» или «через 2 дня». */
const eta = (hours: number) => (hours < 1 ? 'меньше чем через час' : hours < 24 ? `через ${hours} ч` : `через ${daysWord(Math.round(hours / 24))}`);
const more = (shown: number, total: number) => (total > shown ? [`и ещё ${total - shown}`] : []);

export const HELP_TEXT = [
  '<b>Запас: команды</b>',
  '/today - сводка по вашим точкам',
  '/risks - что требует действий: списать, уценить, переместить',
  '/order - что заказать',
  '/stoplist - стоп-лист и прогноз, когда блюда закончатся',
  '/hot - горячие предложения: какие блюда продвигать',
  '/subscribe - на какие уведомления вы подписаны',
  '/stock молоко - остатки продукта по точкам',
  '/expiring - что скоро истекает',
  '/expired - просрочено, ждёт списания',
  '/low - ниже минимального остатка',
  '/points - ваши точки',
  '/unlink - отвязать этот чат',
  '',
  'К большинству команд можно добавить название точки: <code>/risks Центр</code>',
  'Бот только показывает данные. Операции выполняются в веб-интерфейсе.',
].join('\n');

interface Scope {
  /** Какие точки запрашивать у сервисов. null означает «все». */
  ids: string[] | null;
  /** Точка, если названа в команде. */
  locationId?: string;
  label: string | null;
}

/** Точка из текста команды. Видны только доступные пользователю точки, чужая выглядит как несуществующая. */
async function resolveScope(ctx: CommandContext, text: string): Promise<Scope | { error: string }> {
  if (!text) return { ids: locationFilter(ctx.principal), label: null };
  if (hasForbiddenChars(text)) return { error: 'Название точки содержит недопустимые символы.' };
  const allowed = await ctx.deps.db
    .selectFrom('locations')
    .select(['id', 'name'])
    .where('is_active', '=', true)
    .$if(ctx.principal.locationIds !== 'all', (qb) => qb.where('id', 'in', ctx.principal.locationIds === 'all' ? [] : ctx.principal.locationIds.length ? ctx.principal.locationIds : ['00000000-0000-0000-0000-000000000000']))
    .orderBy('name')
    .execute();
  const needle = text.toLowerCase();
  const hits = allowed.filter((l) => l.name.toLowerCase().includes(needle));
  const exact = hits.filter((l) => l.name.toLowerCase() === needle);
  const pick = exact.length === 1 ? exact : hits;
  if (pick.length === 0) return { error: `Точка «${e(text)}» не найдена. Список: /points` };
  if (pick.length > 1) return { error: `Уточните точку: ${pick.map((l) => `«${e(l.name)}»`).join(', ')}` };
  const only = pick[0] as { id: string; name: string };
  return { ids: [only.id], locationId: only.id, label: only.name };
}

const scoped = (title: string, scope: Scope) => (scope.label ? `${title}, ${e(scope.label)}` : title);

function stockLine(r: StockRowDto): string {
  const where = e(r.locationName);
  const parts: string[] = [];
  if (r.available > 0) parts.push(`${formatQty(r.available, r.unit)}`);
  else parts.push('нет годного остатка');
  if (r.expired > 0) parts.push(`просрочено ${formatQty(r.expired, r.unit)}`);
  if (r.daysLeft !== null && r.onHand > 0) parts.push(`ближайший срок: ${describeDaysLeft(r.daysLeft)}`);
  if (r.belowMin) parts.push('ниже минимума');
  return `• <b>${e(r.name)}</b>, ${where}: ${parts.join(', ')}`;
}

async function today(ctx: CommandContext, args: string): Promise<Reply> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return { text: scope.error };
  return { text: await buildDigest(ctx.deps, ctx.principal, scope.locationId), buttons: MAIN_MENU };
}

async function risks(ctx: CommandContext, args: string, kind: 'risks' | 'order'): Promise<Reply> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return { text: scope.error };
  const plan = await getRecommendations(ctx.deps, ctx.principal, scope.locationId);
  const wanted = kind === 'order' ? plan.items.filter((r) => r.type === 'reorder') : plan.items.filter((r) => r.type !== 'reorder' && r.type !== 'promote');
  const total = kind === 'order' ? plan.counts.reorder : plan.counts.writeoff + plan.counts.discount + plan.counts.transfer;
  const title = kind === 'order' ? 'Что заказать' : 'Что требует действий';
  if (total === 0) return { text: `${scoped(title, scope)}: сейчас ничего.` };

  const shown = wanted.slice(0, LIST_LIMIT);
  const lines = [`<b>${scoped(title, scope)}: ${total}</b>`];
  shown.forEach((r, i) => {
    const when = r.daysLeft !== null ? `, ${describeDaysLeft(r.daysLeft)}` : '';
    const money = r.atRiskValue > 0 ? `. Под угрозой ${formatMoneyWhole(r.atRiskValue)}` : '';
    lines.push(`${i + 1}. <b>${e(r.headline)}</b>: ${e(r.productName)}, ${e(r.locationName)}${when}${money}`);
  });
  lines.push(...more(shown.length, total), '', 'Применить рекомендацию можно в веб-интерфейсе.');

  // три первые рекомендации, которые сотрудник вправе применить, можно выполнить кнопкой после подтверждения
  const buttons: Buttons = [];
  for (const r of shown) {
    if (buttons.length >= 3 || !r.batchId) continue;
    if (r.action.kind === 'discount' && r.action.percent && hasRole(ctx.principal.role, 'manager')) {
      buttons.push([{ text: cut(`Скидка ${r.action.percent}%: ${r.productName}`, 40), data: `a:${encodeAction({ kind: 'discount', batchId: r.batchId, percent: r.action.percent })}` }]);
    } else if (r.action.kind === 'writeoff' && hasRole(ctx.principal.role, 'storekeeper')) {
      buttons.push([{ text: cut(`Списать: ${r.productName}`, 40), data: `a:${encodeAction({ kind: 'writeoff', batchId: r.batchId })}` }]);
    }
  }
  if (buttons.length > 0) lines.push('Кнопки ниже применяют рекомендацию после подтверждения.');
  return { text: fit(lines), ...(buttons.length > 0 ? { buttons } : {}) };
}

async function hot(ctx: CommandContext, args: string): Promise<Reply> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return { text: scope.error };
  const { items } = await getHotDishes(ctx.deps, ctx.principal, scope.locationId);
  if (items.length === 0) return { text: `${scoped('Горячие предложения', scope)}: продвигать пока нечего, срок ингредиентов не поджимает.` };
  const shown = items.slice(0, 5);
  const lines = [`<b>${scoped('Горячие предложения', scope)}: ${items.length}</b>`];
  shown.forEach((d, i) => {
    const why = d.reasons[0];
    const reason = why ? `${e(why.productName)}: ${describeDaysLeft(why.daysLeft)}. ` : '';
    lines.push(`${i + 1}. <b>${e(d.dishName)}</b>, ${e(d.locationName)}, приоритет ${d.priority}. ${reason}Хватит на ${d.portions} порц., продать около ${d.portionsToPush}.`);
  });
  lines.push(...more(shown.length, items.length));
  return { text: fit(lines) };
}

async function subscribe(ctx: CommandContext): Promise<Reply> {
  return subscriptionsView(await topicsOf(ctx.deps.db, ctx.user.id));
}

const clock = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));

async function stopList(ctx: CommandContext, args: string): Promise<string> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return scope.error;
  const list = await getStopList(ctx.deps, scope.ids);
  const forecast = (await getStopForecast(ctx.deps, ctx.principal)).filter((f) => !scope.ids || scope.ids.includes(f.locationId)).slice(0, 5);
  const forecastLines = forecast.length
    ? [
        '',
        '<b>Прогноз: остановятся без новой поставки</b>',
        ...forecast.map((f) => `• ${e(f.dishName)}, ${e(f.locationName)}: ${eta(f.hoursLeft)}, ${f.cause === 'expiry' ? 'истечёт срок' : 'не хватит'}: ${e(f.limiting.productName)}`),
      ]
    : [];
  if (list.entries.length === 0 && list.warnings.length === 0) return fit([`${scoped('Стоп-лист', scope)}: пусто, всё есть в наличии.`, ...forecastLines]);

  const tz = ctx.deps.config.businessTz;
  const shown = list.entries.slice(0, 15);
  const lines = [`<b>${scoped('Стоп-лист', scope)}: ${list.entries.length}</b>`];
  for (const s of shown) {
    const kind = s.entityType === 'dish' ? 'блюдо' : 'продукт';
    const reason = s.reasons[0]?.text ?? '';
    lines.push(`• <b>${e(s.name)}</b> (${kind}), ${e(s.locationName)}: ${e(reason)}, с ${clock(s.since, tz)}`);
  }
  lines.push(...more(shown.length, list.entries.length));
  if (list.warnings.length > 0) {
    lines.push('', '<b>Скоро закончатся</b>');
    for (const w of list.warnings.slice(0, 5)) lines.push(`• ${e(w.name)}, ${e(w.locationName)}: ${w.portions} ${plural(w.portions, ['порция', 'порции', 'порций'])}`);
  }
  lines.push(...forecastLines);
  return fit(lines);
}

async function stockByFlag(ctx: CommandContext, args: string, flag: 'expiring' | 'expired' | 'low'): Promise<string> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return scope.error;
  const page = await stockSummary(ctx.deps, { locationIds: scope.ids, flag, limit: LIST_LIMIT + 5, offset: 0 });
  const title = { expiring: 'Скоро истекает', expired: 'Просрочено', low: 'Ниже минимума' }[flag];
  if (page.total === 0) return `${scoped(title, scope)}: ничего нет.`;
  const lines = [`<b>${scoped(title, scope)}: ${page.total}</b>`];
  for (const r of page.items) {
    if (flag === 'expired') {
      lines.push(`• <b>${e(r.name)}</b>, ${e(r.locationName)}: просрочено ${formatQty(r.expired, r.unit)} на ${formatMoneyWhole(r.expiredValue)}`);
    } else {
      lines.push(stockLine(r));
    }
  }
  lines.push(...more(page.items.length, page.total));
  return fit(lines);
}

async function stock(ctx: CommandContext, args: string): Promise<string> {
  if (args.length < 2) return 'Что искать? Например: <code>/stock молоко</code>';
  if (args.length > 60 || hasForbiddenChars(args)) return 'Слишком длинный или странный запрос. Назовите продукт или артикул.';
  const page = await stockSummary(ctx.deps, { locationIds: locationFilter(ctx.principal), q: args, flag: 'all', limit: LIST_LIMIT + 5, offset: 0 });
  if (page.total === 0) return `По запросу «${e(args)}» ничего не найдено на ваших точках.`;
  const lines = [`<b>«${e(args)}»: ${page.total} ${plural(page.total, ['позиция', 'позиции', 'позиций'])}</b>`, ...page.items.map(stockLine), ...more(page.items.length, page.total)];
  if (page.total > page.items.length) lines.push('Уточните запрос, чтобы увидеть остальное.');
  return fit(lines);
}

async function points(ctx: CommandContext): Promise<string> {
  const rows = await ctx.deps.db
    .selectFrom('locations')
    .select(['name', 'kind'])
    .where('is_active', '=', true)
    .$if(ctx.principal.locationIds !== 'all', (qb) => qb.where('id', 'in', ctx.principal.locationIds === 'all' ? [] : ctx.principal.locationIds.length ? ctx.principal.locationIds : ['00000000-0000-0000-0000-000000000000']))
    .orderBy('name')
    .execute();
  if (rows.length === 0) return 'За вами не закреплено ни одной точки. Обратитесь к администратору.';
  return fit(['<b>Ваши точки</b>', ...rows.map((r) => `• ${e(r.name)}`)]);
}

function whoami(ctx: CommandContext): string {
  return `${e(ctx.user.full_name)}, ${ROLE_LABELS[ctx.user.role as Role].toLowerCase()}.`;
}

export function greeting(ctx: CommandContext): string {
  return `Здравствуйте! Вы вошли как ${whoami(ctx)}\n\n${HELP_TEXT}`;
}

/** Выполняет команду от имени привязанного пользователя. Привязку и отвязку обрабатывает бот. */
export async function runCommand(ctx: CommandContext, cmd: ParsedCommand): Promise<Reply | null> {
  const plain = async (text: Promise<string> | string): Promise<Reply> => ({ text: await text });
  switch (cmd.name) {
    case 'help':
      return { text: HELP_TEXT, buttons: MAIN_MENU };
    case 'today':
    case 'summary':
      return today(ctx, cmd.args);
    case 'risks':
      return risks(ctx, cmd.args, 'risks');
    case 'order':
      return risks(ctx, cmd.args, 'order');
    case 'stoplist':
    case 'stop':
      return plain(stopList(ctx, cmd.args));
    case 'hot':
      return hot(ctx, cmd.args);
    case 'subscribe':
    case 'settings':
      return subscribe(ctx);
    case 'expiring':
      return plain(stockByFlag(ctx, cmd.args, 'expiring'));
    case 'expired':
      return plain(stockByFlag(ctx, cmd.args, 'expired'));
    case 'low':
      return plain(stockByFlag(ctx, cmd.args, 'low'));
    case 'stock':
      return plain(stock(ctx, cmd.args));
    case 'points':
      return plain(points(ctx));
    case 'whoami':
      return plain(whoami(ctx));
    default:
      return null;
  }
}

/** Команды для меню бота в Telegram. */
export const MENU_COMMANDS = [
  { command: 'today', description: 'Сводка по моим точкам' },
  { command: 'risks', description: 'Что требует действий' },
  { command: 'order', description: 'Что заказать' },
  { command: 'stoplist', description: 'Стоп-лист и прогноз' },
  { command: 'hot', description: 'Горячие предложения' },
  { command: 'subscribe', description: 'Уведомления' },
  { command: 'stock', description: 'Остатки продукта: /stock молоко' },
  { command: 'expiring', description: 'Скоро истекает' },
  { command: 'expired', description: 'Просрочено' },
  { command: 'low', description: 'Ниже минимума' },
  { command: 'points', description: 'Мои точки' },
  { command: 'help', description: 'Список команд' },
  { command: 'unlink', description: 'Отвязать этот чат' },
];
