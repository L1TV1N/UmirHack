import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSocksUrl, socksFetch } from '../src/modules/telegram/proxy';

describe('адрес прокси', () => {
  it('разбирает логин, пароль, хост и порт, спецсимволы в пароле раскрываются', () => {
    expect(parseSocksUrl('socks5://user:p%40ss@10.0.0.1:8000')).toEqual({ type: 5, host: '10.0.0.1', port: 8000, userId: 'user', password: 'p@ss' });
    expect(parseSocksUrl('socks5://example.com:1080')).toEqual({ type: 5, host: 'example.com', port: 1080 });
  });

  it('чужие протоколы и мусор отклоняются, пароль в тексте ошибки не светится', () => {
    expect(() => parseSocksUrl('http://u:secret@h:1')).toThrow(/socks5/);
    expect(() => parseSocksUrl('socks5://u:secret@h')).toThrow(/порт/);
    for (const bad of ['не адрес', 'socks5://u:secret@h:99999']) {
      try {
        parseSocksUrl(bad);
        throw new Error('должно упасть');
      } catch (e) {
        expect((e as Error).message).not.toContain('secret');
      }
    }
  });
});

describe('запрос через SOCKS5', () => {
  let target: http.Server;
  let proxy: net.Server;
  const seen: { auth: string; host: string }[] = [];

  beforeAll(async () => {
    target = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true, via: 'target' })));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    // минимальный SOCKS5-сервер: вход по логину и паролю, команда CONNECT, дальше трубопровод
    proxy = net.createServer((client) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      let creds = '';
      client.on('data', (chunk) => {
        if (stage === 3) return;
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0 && buf.length >= 2 && buf.length >= 2 + (buf[1] as number)) {
          client.write(Buffer.from([5, 2]));
          buf = Buffer.alloc(0);
          stage = 1;
        } else if (stage === 1 && buf.length >= 2) {
          const ul = buf[1] as number;
          if (buf.length < 3 + ul) return;
          const pl = buf[2 + ul] as number;
          if (buf.length < 3 + ul + pl) return;
          creds = `${buf.subarray(2, 2 + ul).toString()}:${buf.subarray(3 + ul, 3 + ul + pl).toString()}`;
          client.write(Buffer.from([1, creds === 'tgbot:s3cret' ? 0 : 1]));
          buf = Buffer.alloc(0);
          stage = creds === 'tgbot:s3cret' ? 2 : 4;
          if (stage === 4) client.end();
        } else if (stage === 2 && buf.length >= 10) {
          const atyp = buf[3];
          let host = '';
          let off = 4;
          if (atyp === 1) {
            host = [...buf.subarray(4, 8)].join('.');
            off = 8;
          } else if (atyp === 3) {
            const l = buf[4] as number;
            host = buf.subarray(5, 5 + l).toString();
            off = 5 + l;
          }
          const port = buf.readUInt16BE(off);
          seen.push({ auth: creds, host });
          stage = 3;
          // вместо настоящего адреса ведём на локальный сервер: проверяем, что соединение прошло через прокси
          const upstream = net.connect((target.address() as AddressInfo).port, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            client.pipe(upstream);
            upstream.pipe(client);
          });
          upstream.on('error', () => client.destroy());
          void port;
        }
      });
      client.on('error', () => undefined);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    proxy.close();
    target.close();
  });

  it('запрос к api.telegram.org уходит на прокси с логином и паролем, а не напрямую', async () => {
    const port = (proxy.address() as AddressInfo).port;
    const f = socksFetch(`socks5://tgbot:s3cret@127.0.0.1:${port}`);
    const res = await f('http://api.telegram.org/botTOKEN/getMe', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(await res.json()).toEqual({ ok: true, via: 'target' });
    expect(seen.at(-1)).toEqual({ auth: 'tgbot:s3cret', host: 'api.telegram.org' });
  });

  it('с неверным паролем прокси запрос не проходит', async () => {
    const port = (proxy.address() as AddressInfo).port;
    const f = socksFetch(`socks5://tgbot:wrong@127.0.0.1:${port}`);
    await expect(f('http://api.telegram.org/x')).rejects.toBeTruthy();
  });
});
