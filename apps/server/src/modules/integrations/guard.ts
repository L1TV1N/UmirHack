import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { badRequest } from '../../lib/errors';

export interface TargetPolicy {
  /** Разрешить адреса во внутренней сети и на этом же компьютере. */
  allowPrivate: boolean;
  /** Разрешить http. Иначе только https. */
  allowHttp: boolean;
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function privateV4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Разворачивает запись IPv6 в восемь групп. Возвращает null, если запись некорректна. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0] as string;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = ipv4Parts(dotted[1] as string);
    if (!v4) return null;
    const hex = (x: number, y: number) => ((x << 8) | y).toString(16);
    text = `${text.slice(0, -(dotted[1] as string).length)}${hex(v4[0] as number, v4[1] as number)}:${hex(v4[2] as number, v4[3] as number)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...tail];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : Number.NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

function privateV6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const first96zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (first96zero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: и ::1
  // IPv4, спрятанный в IPv6 (::ffff:a.b.c.d и устаревшая запись ::a.b.c.d): судим по IPv4
  if (first96zero && (g5 === 0xffff || g5 === 0)) return privateV4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10
    (g0 & 0xff00) === 0xff00 || // ff00::/8
    (g0 === 0x2001 && g1 === 0x0db8) || // документация
    (g0 === 0x2001 && g1 === 0) || // Teredo
    g0 === 0x2002 || // 6to4: внутри обычный IPv4, который мы не разбираем
    (g0 === 0x0064 && g1 === 0xff9b) // NAT64
  );
}

/** Адрес не из публичного интернета: loopback, внутренняя сеть, link-local, метаданные облака, служебные диапазоны. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return true;
}

const INTERNAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/** Проверка адреса при сохранении: схема, учётные данные, явно внутренние имена и IP. Имя из DNS проверяется при отправке. */
export function assertWebhookUrl(raw: string, policy: TargetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Некорректный адрес', [{ path: ['url'], message: 'Некорректный адрес' }], 'bad_webhook_url');
  }
  const fail = (message: string): never => {
    throw badRequest(message, [{ path: ['url'], message }], 'bad_webhook_url');
  };
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    fail(policy.allowHttp ? 'Нужен адрес http или https' : 'Отправка разрешена только на https-адреса');
  }
  if (url.username || url.password) fail('В адресе не должно быть логина и пароля');
  if (url.hash) fail('В адресе не должно быть «#»');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivate) {
    if (isIP(host) ? isPrivateAddress(host) : INTERNAL_NAMES.test(host) || !host.includes('.')) {
      fail('Адрес указывает во внутреннюю сеть. Разрешить такие адреса может только администратор сервера (WEBHOOK_ALLOW_PRIVATE)');
    }
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Функция поиска адреса для соединения. Проверка идёт на том адресе, к которому действительно подключаемся,
 * поэтому подмена DNS между проверкой и соединением не помогает.
 */
export function guardedLookup(policy: Pick<TargetPolicy, 'allowPrivate'>) {
  return (hostname: string, options: { all?: boolean; family?: number | string; hints?: number }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true, family: typeof options.family === 'number' ? options.family : 0, hints: options.hints ?? 0 }, (err, addresses) => {
      if (err) return callback(err, '');
      const list = addresses;
      if (list.length === 0) return callback(Object.assign(new Error('Адрес не найден'), { code: 'ENOTFOUND' }), '');
      if (!policy.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(Object.assign(new Error('Адрес указывает во внутреннюю сеть'), { code: 'ESSRF' }), '');
      }
      if (options.all) return callback(null, list);
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}
