import { AsyncLocalStorage } from 'node:async_hooks';

type Outcome = 'hit' | 'miss' | 'joined' | 'stale';

interface Trace {
  outcome?: Outcome;
  waitedMs: number;
  lookups: number;
}

const store = new AsyncLocalStorage<Trace>();

/** Самый «дорогой» исход побеждает: если запрос хоть раз промахнулся, ответ помечается промахом. */
const WEIGHT: Record<Outcome, number> = { hit: 0, stale: 1, joined: 2, miss: 3 };

/** Запускает обработку запроса с записью обращений к кешу. */
export function withCacheTrace<R>(fn: () => R): R {
  return store.run({ waitedMs: 0, lookups: 0 }, fn);
}

/** Вызывается кешем при каждом обращении. Вне запроса (фоновые задачи, тесты) ничего не делает. */
export function recordCacheTrace(outcome: Outcome, waitedMs: number): void {
  const trace = store.getStore();
  if (!trace) return;
  trace.lookups += 1;
  trace.waitedMs += waitedMs;
  if (!trace.outcome || WEIGHT[outcome] > WEIGHT[trace.outcome]) trace.outcome = outcome;
}

export function readCacheTrace(): Trace | undefined {
  return store.getStore();
}

/** Заголовки ответа: X-Cache для людей и Server-Timing для панели разработчика в браузере. */
export function cacheHeaders(trace: Trace | undefined): Record<string, string> | null {
  if (!trace || !trace.outcome) return null;
  const label = trace.outcome.toUpperCase();
  return {
    'X-Cache': label,
    'Server-Timing': `cache;desc="${label}";dur=${trace.waitedMs.toFixed(1)}`,
  };
}
