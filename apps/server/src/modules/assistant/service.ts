import { hasRole, type AskBody, type AssistantAnswerDto, type AssistantPlanner, type AssistantStatusDto } from '@zapas/shared';
import type { Deps, Principal, RequestMeta, UserPrincipal } from '../../lib/context';
import { assertLocation, locationFilter } from '../../lib/scope';
import { writeAudit } from '../audit/audit';
import { INTENT_BY_ID, intentsFor, type AnswerBody, type IntentContext } from './intents';
import { RulePlanner, type Plan } from './planner';

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** Сколько подсказок «что спросить дальше» показывать. */
const SUGGESTIONS = 3;

export function assistantStatus(deps: Deps, principal: UserPrincipal): AssistantStatusDto {
  return {
    model: Boolean(deps.questionPlanner),
    examples: intentsFor(principal.role).flatMap((i) => i.examples.slice(0, 1)).slice(0, 6),
  };
}

async function visibleLocations(deps: Deps, principal: UserPrincipal): Promise<{ id: string; name: string }[]> {
  const allowed = locationFilter(principal);
  return deps.db
    .selectFrom('locations')
    .select(['id', 'name'])
    .where('is_active', '=', true)
    .where('org_id', '=', principal.orgId)
    .$if(allowed !== null, (qb) => qb.where('id', 'in', allowed?.length ? allowed : ['00000000-0000-0000-0000-000000000000']))
    .execute();
}

/** Сначала модель, если она подключена и ответила понятно, иначе простые правила. */
async function planQuestion(deps: Deps, question: string, intents: ReturnType<typeof intentsFor>, names: string[]): Promise<{ plan: Plan | null; by: AssistantPlanner }> {
  if (deps.questionPlanner) {
    try {
      const plan = await deps.questionPlanner.plan(question, intents);
      if (plan && intents.some((i) => i.id === plan.intent)) return { plan, by: 'model' };
    } catch (err) {
      // сервис недоступен или ответил не так: вопрос не пропадает, его разбирают правила
      deps.log.warn({ reason: err instanceof Error ? err.message : String(err) }, 'помощник: модель не разобрала вопрос, берём правила');
    }
  }
  const plan = await new RulePlanner(() => names).plan(question, intents);
  return plan ? { plan, by: 'rules' } : { plan: null, by: 'none' };
}

/**
 * Отвечает на вопрос сотрудника. Модель только выбирает готовый запрос и параметры, а текст ответа собирается из данных
 * теми же сервисами и с теми же правами, что и экраны. Запросы только читают: изменить данные помощник не может.
 */
export async function ask(deps: Deps, principal: Principal, body: AskBody, meta: RequestMeta): Promise<AssistantAnswerDto> {
  const user = principal as UserPrincipal;
  const intents = intentsFor(user.role);
  if (body.locationId) assertLocation(principal, body.locationId);
  const places = await visibleLocations(deps, user);
  const { plan, by } = await planQuestion(deps, body.question, intents, places.map((p) => p.name));

  const suggestions = (except: string | null) =>
    intents
      .filter((i) => i.id !== except)
      .flatMap((i) => i.examples.slice(0, 1))
      .slice(0, SUGGESTIONS);
  const unknown = (): AssistantAnswerDto => ({
    question: body.question,
    intent: null,
    planner: 'none',
    title: 'Не понял вопрос',
    lines: ['Я отвечаю на вопросы об остатках, сроках, стоп-листе, горячих блюдах и заказах. Попробуйте один из примеров.'],
    link: null,
    suggestions: intents.flatMap((i) => i.examples.slice(0, 1)).slice(0, 5),
  });

  const intent = plan ? INTENT_BY_ID.get(plan.intent) : undefined;
  const params = intent && plan ? intent.parse(plan.params) : null;
  if (!plan || !intent || !params || !hasRole(user.role, intent.min)) {
    await writeAudit(deps.db, { action: 'assistant.ask', entity: 'assistant', principal, meta, at: deps.clock(), details: { intent: null, planner: 'none' } });
    return unknown();
  }

  // точка: явная из запроса, иначе названная в вопросе; чужую точку модель выбрать не может, список строится по правам
  let place = body.locationId ? places.find((p) => p.id === body.locationId) : undefined;
  let note: string | null = null;
  if (!place && plan.location) {
    const wanted = norm(plan.location);
    place = places.find((p) => norm(p.name) === wanted) ?? places.find((p) => norm(p.name).includes(wanted) || wanted.includes(norm(p.name)));
    if (!place) note = `Точку «${plan.location}» не нашёл, показываю все ваши точки.`;
  }
  const ctx: IntentContext = {
    deps,
    principal: user,
    scopeIds: place ? [place.id] : locationFilter(principal),
    locationId: place?.id,
    locationName: place?.name ?? null,
  };

  let result: AnswerBody;
  try {
    result = await intent.run(ctx, params);
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err), intent: intent.id }, 'помощник: запрос не выполнен');
    throw err;
  }
  await writeAudit(deps.db, { action: 'assistant.ask', entity: 'assistant', principal, meta, at: deps.clock(), details: { intent: intent.id, planner: by, scoped: Boolean(place) } });

  return {
    question: body.question,
    intent: intent.id,
    planner: by,
    title: result.title,
    lines: note ? [note, ...result.lines] : result.lines,
    link: result.link ?? null,
    suggestions: suggestions(intent.id),
  };
}
