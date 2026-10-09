export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// Самые частые пароли, которые подходят под длину. Сверяем без регистра и без хвоста из цифр.
const COMMON = new Set([
  'password',
  'passwordpassword',
  'qwertyuiop',
  'qwertyuiopasdf',
  'qwertyqwerty',
  'qwerty1234',
  'qwertyuiop123',
  'asdfghjkl',
  'asdfghjklqwerty',
  'zxcvbnm123',
  'iloveyou',
  'iloveyou12',
  'administrator',
  'adminadmin',
  'admin12345',
  'welcome123',
  'letmein123',
  'changeme',
  'changeme123',
  'monkey1234',
  'dragon1234',
  'football12',
  'baseball12',
  'superman12',
  'abcdefghij',
  'abcdefghijk',
  'abc1234567',
  'trustno1',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
  'йцукенгшщз',
  'йцукенгшщзх',
  'пароль',
  'парольпароль',
  'пароль1234',
  'админадмин',
  'привет1234',
  'любовь1234',
  'warehouse',
  'sklad12345',
  'restaurant',
]);

function stripTrailingDigits(value: string): string {
  return value.replace(/\d+$/, '');
}

function isSingleRepeatedChar(value: string): boolean {
  return new Set(value).size === 1;
}

function isSequence(value: string): boolean {
  if (value.length < 6) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (diff !== 1) up = false;
    if (diff !== -1) down = false;
  }
  return up || down;
}

/** Возвращает текст ошибки или null, если пароль подходит. */
export function checkPassword(password: string, context: { email?: string; fullName?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Пароль должен быть не длиннее ${PASSWORD_MAX_LENGTH} символов`;
  }
  if (password.trim() !== password) {
    return 'Пароль не должен начинаться или заканчиваться пробелом';
  }
  const lower = password.toLowerCase();
  if (isSingleRepeatedChar(lower) || isSequence(lower)) {
    return 'Пароль слишком простой';
  }
  if (COMMON.has(lower) || COMMON.has(stripTrailingDigits(lower))) {
    return 'Пароль слишком распространён';
  }
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) {
    return 'Пароль не должен содержать часть адреса почты';
  }
  const nameParts = (context.fullName ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 4);
  if (nameParts.some((p) => lower.includes(p))) {
    return 'Пароль не должен содержать имя или фамилию';
  }
  return null;
}
