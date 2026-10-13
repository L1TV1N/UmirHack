import { fetch as undiciFetch } from 'undici';
import { socksDispatcher } from 'fetch-socks';

export interface SocksTarget {
  type: 5 | 4;
  host: string;
  port: number;
  userId?: string;
  password?: string;
}

/** Разбирает адрес вида socks5://логин:пароль@хост:порт. Ошибка не содержит самого адреса: в нём может быть пароль. */
export function parseSocksUrl(raw: string): SocksTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('TELEGRAM_PROXY_URL: некорректный адрес, ожидается socks5://логин:пароль@хост:порт');
  }
  const type = url.protocol === 'socks5:' || url.protocol === 'socks5h:' ? 5 : url.protocol === 'socks4:' || url.protocol === 'socks4a:' ? 4 : null;
  if (type === null) throw new Error('TELEGRAM_PROXY_URL: поддерживаются только socks5 и socks4');
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TELEGRAM_PROXY_URL: не указан хост или порт');
  return {
    type,
    host: url.hostname,
    port,
    ...(url.username ? { userId: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/** fetch, который ходит через SOCKS-прокси. Нужен там, где api.telegram.org недоступен напрямую. */
export function socksFetch(raw: string): typeof fetch {
  const dispatcher = socksDispatcher(parseSocksUrl(raw), { connect: { timeout: 10_000 } });
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}
