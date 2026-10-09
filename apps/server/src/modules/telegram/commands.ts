import {
  describeDaysLeft,
  formatMoneyWhole,
  formatQty,
  hasForbiddenChars,
  plural,
  ROLE_LABELS,
  type Role,
  type StockRowDto,
} from '@zapas/shared';
import type { Deps, Principal } from '../../lib/context';
import { locationFilter } from '../../lib/scope';
import { getRecommendations } from '../analytics/service';
import { buildDigest } from '../notifications/digest';
import { escapeHtml } from '../notifications/notifier';
import { stockSummary } from '../stock/queries';
import { getStopList } from '../stoplist/service';
import type { UserRow } from '../users/users';

export interface CommandContext {
  deps: Deps;
  principal: Extract<Principal, { kind: 'user' }>;
  user: UserRow;
}

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
const more = (shown: number, total: number) => (total > shown ? [`и ещё ${total - shown}`] : []);

export const HELP_TEXT = [
  '<b>Запас: команды</b>',
  '/today — сводка по вашим точкам',
  '/risks — что требует действий: списать, уценить, переместить',
  '/order — что заказать',
  '/stoplist — стоп-лист',
  '/stock молоко — остатки продукта по точкам',
  '/expiring — что скоро истекает',
  '/expired — просрочено, ждёт списания',
  '/low — ниже минимального остатка',
  '/points — ваши точки',
  '/unlink — отвязать этот чат',
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

async function today(ctx: CommandContext, args: string): Promise<string> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return scope.error;
  return buildDigest(ctx.deps, ctx.principal, scope.locationId);
}

async function risks(ctx: CommandContext, args: string, kind: 'risks' | 'order'): Promise<string> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return scope.error;
  const plan = await getRecommendations(ctx.deps, ctx.principal, scope.locationId);
  const wanted = kind === 'order' ? plan.items.filter((r) => r.type === 'reorder') : plan.items.filter((r) => r.type !== 'reorder' && r.type !== 'promote');
  const total = kind === 'order' ? plan.counts.reorder : plan.counts.writeoff + plan.counts.discount + plan.counts.transfer;
  const title = kind === 'order' ? 'Что заказать' : 'Что требует действий';
  if (total === 0) return `${scoped(title, scope)}: сейчас ничего.`;

  const shown = wanted.slice(0, LIST_LIMIT);
  const lines = [`<b>${scoped(title, scope)}: ${total}</b>`];
  shown.forEach((r, i) => {
    const when = r.daysLeft !== null ? `, ${describeDaysLeft(r.daysLeft)}` : '';
    const money = r.atRiskValue > 0 ? `. Под угрозой ${formatMoneyWhole(r.atRiskValue)}` : '';
    lines.push(`${i + 1}. <b>${e(r.headline)}</b>: ${e(r.productName)}, ${e(r.locationName)}${when}${money}`);
  });
  lines.push(...more(shown.length, total), '', 'Применить рекомендацию можно в веб-интерфейсе.');
  return fit(lines);
}

const clock = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));

async function stopList(ctx: CommandContext, args: string): Promise<string> {
  const scope = await resolveScope(ctx, args);
  if ('error' in scope) return scope.error;
  const list = await getStopList(ctx.deps, scope.ids);
  if (list.entries.length === 0 && list.warnings.length === 0) return `${scoped('Стоп-лист', scope)}: пусто, всё есть в наличии.`;

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
export async function runCommand(ctx: CommandContext, cmd: ParsedCommand): Promise<string | null> {
  switch (cmd.name) {
    case 'help':
      return HELP_TEXT;
    case 'today':
    case 'summary':
      return today(ctx, cmd.args);
    case 'risks':
      return risks(ctx, cmd.args, 'risks');
    case 'order':
      return risks(ctx, cmd.args, 'order');
    case 'stoplist':
    case 'stop':
      return stopList(ctx, cmd.args);
    case 'expiring':
      return stockByFlag(ctx, cmd.args, 'expiring');
    case 'expired':
      return stockByFlag(ctx, cmd.args, 'expired');
    case 'low':
      return stockByFlag(ctx, cmd.args, 'low');
    case 'stock':
      return stock(ctx, cmd.args);
    case 'points':
      return points(ctx);
    case 'whoami':
      return whoami(ctx);
    default:
      return null;
  }
}

/** Команды для меню бота в Telegram. */
export const MENU_COMMANDS = [
  { command: 'today', description: 'Сводка по моим точкам' },
  { command: 'risks', description: 'Что требует действий' },
  { command: 'order', description: 'Что заказать' },
  { command: 'stoplist', description: 'Стоп-лист' },
  { command: 'stock', description: 'Остатки продукта: /stock молоко' },
  { command: 'expiring', description: 'Скоро истекает' },
  { command: 'expired', description: 'Просрочено' },
  { command: 'low', description: 'Ниже минимума' },
  { command: 'points', description: 'Мои точки' },
  { command: 'help', description: 'Список команд' },
  { command: 'unlink', description: 'Отвязать этот чат' },
];
