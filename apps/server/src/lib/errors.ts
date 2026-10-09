export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown, code = 'bad_request') =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход', code = 'unauthorized') => new AppError(401, code, message);
export const forbidden = (message = 'Недостаточно прав', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (what = 'Объект') => new AppError(404, 'not_found', `${what} не найден`);
export const conflict = (message: string, details?: unknown, code = 'conflict') =>
  new AppError(409, code, message, details);
export const unprocessable = (message: string, details?: unknown, code = 'unprocessable') =>
  new AppError(422, code, message, details);

/** Код ошибки PostgreSQL, если это она. */
export function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FK_VIOLATION = '23503';
export const PG_CHECK_VIOLATION = '23514';

/** Имя нарушенного ограничения PostgreSQL. */
export function pgConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    const c = (err as { constraint: unknown }).constraint;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}
