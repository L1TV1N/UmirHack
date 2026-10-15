import type { WaiterDishDto } from '@zapas/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface StopAlert {
  id: string;
  kind: 'stop' | 'back';
  dishId: string;
  text: string;
}

/** Сколько висит сообщение, если его не закрыли. */
export const ALERT_LIFETIME_MS = 15_000;

/** Что изменилось в меню с прошлого раза: какие блюда ушли в стоп-лист и какие вернулись. */
export function diffStops(previous: ReadonlyMap<string, boolean>, menu: readonly WaiterDishDto[]): StopAlert[] {
  const out: StopAlert[] = [];
  for (const d of menu) {
    const was = previous.get(d.id);
    // блюдо, которого раньше не было, не считается изменением: меню могли дополнить
    if (was === undefined || was === d.stopped) continue;
    out.push(
      d.stopped
        ? { id: `${d.id}:stop:${Date.now()}`, kind: 'stop', dishId: d.id, text: `«${d.name}» ушло в стоп-лист${d.stopNote ? `: ${d.stopNote}` : ''}` }
        : { id: `${d.id}:back:${Date.now()}`, kind: 'back', dishId: d.id, text: `«${d.name}» снова можно заказывать` },
    );
  }
  return out;
}

/**
 * Следит за меню официанта и собирает сообщения, когда блюдо уходит в стоп-лист или возвращается.
 * Меню перечитывается само по сигналу сервера, поэтому сообщение появляется сразу после изменения остатков.
 * Первая загрузка сообщений не создаёт: сравнивать пока не с чем.
 */
export function useStopAlerts(menu: readonly WaiterDishDto[] | undefined): { alerts: StopAlert[]; dismiss: (id: string) => void } {
  const [alerts, setAlerts] = useState<StopAlert[]>([]);
  const previous = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (!menu) return;
    const known = previous.current;
    previous.current = new Map(menu.map((d) => [d.id, d.stopped]));
    if (!known) return;
    const fresh = diffStops(known, menu);
    if (fresh.length === 0) return;
    setAlerts((list) => [...list, ...fresh].slice(-4));
    if (fresh.some((a) => a.kind === 'stop')) {
      try {
        navigator.vibrate?.(120);
      } catch {
        // вибрации нет, сообщение всё равно видно
      }
    }
  }, [menu]);

  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setTimeout(() => setAlerts((list) => list.slice(1)), ALERT_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [alerts]);

  const dismiss = useCallback((id: string) => setAlerts((list) => list.filter((a) => a.id !== id)), []);
  return { alerts, dismiss };
}
