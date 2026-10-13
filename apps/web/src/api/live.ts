import { refreshSession, session } from './client';

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const NO_TOKEN_WAIT_MS = 5000;

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Разбирает поток событий: отдаёт названия событий по мере прихода полных блоков. */
export function parseEvents(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: string[] = [];
  for (const block of blocks) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    if (name) events.push(name.trim());
  }
  return { events, rest };
}

export interface LiveHandlers {
  /** Данные изменились (или связь с сервером восстановилась и могли быть пропущенные изменения). */
  onChange(): void;
  /** Поток открыт или оборвался. */
  onState?(live: boolean): void;
}

/**
 * Держит поток изменений с сервера (Server-Sent Events). EventSource не умеет передавать заголовок авторизации,
 * поэтому используется обычный fetch. Обрыв переживается переподключением с нарастающей паузой.
 */
export function connectLive({ onChange, onState }: LiveHandlers): () => void {
  const stop = new AbortController();
  let connectedBefore = false;

  async function once(signal: AbortSignal): Promise<'closed' | 'unauthorized' | 'failed'> {
    const token = session.token();
    if (!token) return 'unauthorized';
    const res = await fetch('/api/events', {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      credentials: 'same-origin',
      signal,
    });
    if (res.status === 401) return 'unauthorized';
    if (!res.ok || !res.body) return 'failed';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return 'closed';
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseEvents(buffer);
      buffer = parsed.rest;
      for (const name of parsed.events) {
        if (name === 'ready') {
          onState?.(true);
          // после обрыва могли пропуститься изменения, поэтому при повторном подключении данные перечитываем
          if (connectedBefore) onChange();
          connectedBefore = true;
        } else if (name === 'changed') {
          onChange();
        }
      }
    }
  }

  void (async () => {
    let delay = RETRY_MIN_MS;
    while (!stop.signal.aborted) {
      let outcome: Awaited<ReturnType<typeof once>> = 'failed';
      try {
        outcome = await once(stop.signal);
        if (outcome === 'closed') delay = RETRY_MIN_MS;
      } catch {
        outcome = stop.signal.aborted ? 'closed' : 'failed';
      }
      onState?.(false);
      if (stop.signal.aborted) return;
      if (outcome === 'unauthorized') {
        // токен мог истечь: пробуем обновить сессию, а если токена нет вовсе (работа без связи), ждём
        const refreshed = session.token() ? await refreshSession().catch(() => null) : null;
        await wait(refreshed ? RETRY_MIN_MS : NO_TOKEN_WAIT_MS, stop.signal);
      } else if (outcome === 'closed') {
        await wait(RETRY_MIN_MS, stop.signal);
      } else {
        await wait(delay, stop.signal);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      }
    }
  })();

  return () => stop.abort();
}
