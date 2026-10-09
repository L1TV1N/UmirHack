import type { ApiErrorBody, SessionDto } from '@zapas/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Ошибки полей формы: «lines.0.quantity» → текст. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { path?: (string | number)[]; message?: string }[]) {
        if (d && Array.isArray(d.path) && d.message) out[d.path.join('.')] = d.message;
      }
    }
    return out;
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function toQuery(q?: Query): string {
  if (!q) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

let accessToken: string | null = null;
let refreshing: Promise<SessionDto | null> | null = null;
const sessionListeners = new Set<(s: SessionDto | null) => void>();

export const session = {
  token: () => accessToken,
  set(token: string | null) {
    accessToken = token;
  },
  subscribe(fn: (s: SessionDto | null) => void) {
    sessionListeners.add(fn);
    return () => sessionListeners.delete(fn);
  },
};

function emit(s: SessionDto | null) {
  for (const fn of sessionListeners) fn(s);
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toError(res: Response, data: unknown): ApiError {
  const body = data as Partial<ApiErrorBody> | undefined;
  return new ApiError(
    res.status,
    body?.error?.code ?? 'http_error',
    body?.error?.message ?? 'Не удалось выполнить запрос',
    body?.error?.details,
    body?.requestId,
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requestRefresh(): Promise<SessionDto | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    const data = await parse(res);
    if (res.ok) return data as SessionDto;
    // другая вкладка только что обновила сессию, повторим с новой cookie
    if (res.status === 401 && (data as ApiErrorBody | undefined)?.error?.code === 'refresh_conflict') {
      await wait(350);
      continue;
    }
    return null;
  }
  return null;
}

/** Обновление сессии одной общей попыткой, сколько бы запросов ни ждали. */
export function refreshSession(): Promise<SessionDto | null> {
  refreshing ??= requestRefresh()
    .then((s) => {
      accessToken = s?.accessToken ?? null;
      emit(s);
      return s;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** false для входа: 401 там означает неверный пароль, а не истёкшую сессию. */
  auth?: boolean;
}

async function send(method: string, path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken && opts.auth !== false) headers.authorization = `Bearer ${accessToken}`;
  return fetch(`/api${path}${toQuery(opts.query)}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal ?? null,
  });
}

async function execute(method: string, path: string, opts: RequestOptions): Promise<Response> {
  let res = await send(method, path, opts);
  if (res.status === 401 && opts.auth !== false) {
    const refreshed = await refreshSession();
    if (!refreshed) return res;
    res = await send(method, path, opts);
  }
  return res;
}

export async function api<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await execute(method, path, opts);
  const data = await parse(res);
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) emit(null);
    throw toError(res, data);
  }
  return data as T;
}

export const get = <T>(path: string, query?: Query, signal?: AbortSignal) =>
  api<T>('GET', path, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) });
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  api<T>('POST', path, { body: body ?? {}, ...(headers ? { headers } : {}) });
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, { body });
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, { body });
export const del = <T = void>(path: string) => api<T>('DELETE', path);

/** Ключ идемпотентности: повтор запроса после обрыва связи не создаст второй документ. */
export function newIdempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export async function downloadFile(path: string, query: Query | undefined, fallbackName: string): Promise<void> {
  const res = await execute('GET', path, query ? { query } : {});
  if (!res.ok) throw toError(res, await parse(res));
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
