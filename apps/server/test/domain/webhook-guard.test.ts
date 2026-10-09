import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardedLookup, assertWebhookUrl, isPrivateAddress } from '../../src/modules/integrations/guard';
import { describeSendError, HttpWebhookSender } from '../../src/modules/integrations/sender';
import { decryptSecret, encryptSecret, signBody } from '../../src/lib/crypto';

describe('внутренние адреса', () => {
  it('узнаёт адреса вне публичного интернета', () => {
    const inner = [
      '0.0.0.0', '10.1.2.3', '127.0.0.1', '127.255.255.254', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '192.0.0.8', '198.18.0.1', '203.0.113.9', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1',
    ];
    for (const ip of inner) expect(isPrivateAddress(ip), ip).toBe(true);
  });

  it('публичные адреса пропускает', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('мусор вместо адреса считается небезопасным', () => {
    for (const v of ['', 'abc', '999.1.1.1', '1.2.3', '::g', '1::2::3']) expect(isPrivateAddress(v), v).toBe(true);
  });
});

describe('проверка адреса приёмника', () => {
  const strict = { allowPrivate: false, allowHttp: false };
  const open = { allowPrivate: true, allowHttp: true };

  it('внешний https проходит', () => {
    expect(assertWebhookUrl('https://hooks.example.com/stop?x=1', strict).host).toBe('hooks.example.com');
  });

  it('http без разрешения не проходит, с разрешением проходит', () => {
    expect(() => assertWebhookUrl('http://hooks.example.com/x', strict)).toThrow(/https/);
    expect(assertWebhookUrl('http://hooks.example.com/x', { ...strict, allowHttp: true }).protocol).toBe('http:');
  });

  it('внутренние адреса, имена без точки и служебные зоны не проходят', () => {
    for (const u of [
      'https://localhost/x', 'https://app.localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data',
      'https://printer/x', 'https://kassa.local/x', 'https://db.internal/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://[::ffff:127.0.0.1]/x',
    ]) {
      expect(() => assertWebhookUrl(u, { ...strict, allowHttp: true }), u).toThrow(/внутреннюю сеть/);
    }
  });

  it('с разрешением внутренние адреса проходят', () => {
    expect(assertWebhookUrl('http://192.168.1.20:8080/hook', open).port).toBe('8080');
  });

  it('логин в адресе и чужие схемы отклоняются', () => {
    expect(() => assertWebhookUrl('https://user:pw@hooks.example.com/', open)).toThrow(/логина/);
    expect(() => assertWebhookUrl('file:///etc/passwd', open)).toThrow();
    expect(() => assertWebhookUrl('gopher://hooks.example.com', open)).toThrow();
    expect(() => assertWebhookUrl('не адрес', open)).toThrow(/Некорректный/);
  });
});

describe('поиск адреса при соединении', () => {
  const run = (host: string, allowPrivate: boolean) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown }>((resolve) => {
      guardedLookup({ allowPrivate })(host, { all: true }, (err, address) => resolve({ err, address }));
    });

  it('имя, которое указывает на этот компьютер, отклоняется', async () => {
    const res = await run('localhost', false);
    expect(res.err?.code).toBe('ESSRF');
  });

  it('с разрешением localhost находится', async () => {
    const res = await run('localhost', true);
    expect(res.err).toBeNull();
    expect(Array.isArray(res.address) && res.address.length > 0).toBe(true);
  });
});

describe('секреты и подпись', () => {
  const master = 'x'.repeat(48);
  it('секрет шифруется и расшифровывается, чужим ключом не открывается', () => {
    const stored = encryptSecret(master, 'whsec_test');
    expect(stored).not.toContain('whsec_test');
    expect(decryptSecret(master, stored)).toBe('whsec_test');
    expect(() => decryptSecret('y'.repeat(48), stored)).toThrow();
    expect(() => decryptSecret(master, `${stored.slice(0, -2)}AA`)).toThrow();
    expect(encryptSecret(master, 'whsec_test')).not.toBe(stored);
  });
  it('подпись зависит от секрета, времени и тела', () => {
    const base = signBody('s', 1_700_000_000, '{"a":1}');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(signBody('s2', 1_700_000_000, '{"a":1}')).not.toBe(base);
    expect(signBody('s', 1_700_000_001, '{"a":1}')).not.toBe(base);
    expect(signBody('s', 1_700_000_000, '{"a":2}')).not.toBe(base);
  });
});

describe('отправка по сети', () => {
  let server: http.Server;
  let url: string;
  const seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body, path: req.url ?? '' });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/' });
          return res.end();
        }
        if (req.url === '/slow') return; // не отвечаем
        if (req.url === '/flood') {
          res.writeHead(200);
          return res.end(Buffer.alloc(2_000_000, 97));
        }
        res.writeHead(req.url === '/fail' ? 500 : 204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

  it('шлёт POST с телом и заголовками и возвращает код ответа', async () => {
    const sender = new HttpWebhookSender({ allowPrivate: true });
    const res = await sender.send({ url: `${url}/hook`, headers: { 'x-zapas-event': 'ping' }, body: '{"ok":true}' });
    expect(res.status).toBe(204);
    const got = seen.at(-1);
    expect(got?.body).toBe('{"ok":true}');
    expect(got?.headers['x-zapas-event']).toBe('ping');
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['user-agent']).toBe('Zapas-Webhook/1');
  });

  it('код ошибки возвращается как есть', async () => {
    const res = await new HttpWebhookSender({ allowPrivate: true }).send({ url: `${url}/fail`, headers: {}, body: '{}' });
    expect(res.status).toBe(500);
  });

  it('перенаправление не выполняется', async () => {
    const before = seen.length;
    const res = await new HttpWebhookSender({ allowPrivate: true }).send({ url: `${url}/redirect`, headers: {}, body: '{}' });
    expect(res.status).toBe(302);
    expect(seen.length - before).toBe(1);
  });

  it('молчащий приёмник обрывается по времени', async () => {
    const sender = new HttpWebhookSender({ allowPrivate: true, timeoutMs: 300 });
    const err = await sender.send({ url: `${url}/slow`, headers: {}, body: '{}' }).catch((e: unknown) => e);
    expect(describeSendError(err)).toBe('не ответил вовремя');
  });

  it('огромный ответ не тянется целиком', async () => {
    const res = await new HttpWebhookSender({ allowPrivate: true }).send({ url: `${url}/flood`, headers: {}, body: '{}' });
    expect(res.status).toBe(200);
  });

  it('без разрешения на внутренние адреса на цифровой адрес и на localhost не ходит', async () => {
    const sender = new HttpWebhookSender({ allowPrivate: false });
    const before = seen.length;
    const byIp = await sender.send({ url: `${url}/x`, headers: {}, body: '{}' }).catch((e: unknown) => e);
    const byName = await sender.send({ url: url.replace('127.0.0.1', 'localhost') + '/x', headers: {}, body: '{}' }).catch((e: unknown) => e);
    expect(describeSendError(byIp)).toBe('адрес указывает во внутреннюю сеть');
    expect(describeSendError(byName)).toBe('адрес указывает во внутреннюю сеть');
    expect(seen.length).toBe(before);
  });

  it('понятные тексты сбоев не раскрывают подробностей', () => {
    expect(describeSendError(Object.assign(new Error('connect ECONNREFUSED 10.1.1.1:443'), { code: 'ECONNREFUSED' }))).toBe('соединение отклонено');
    expect(describeSendError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('адрес не найден (DNS)');
    expect(describeSendError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }))).toBe('ошибка сертификата');
    expect(describeSendError(new Error('что-то со стеком и адресом 10.0.0.1'))).toBe('сбой соединения');
  });
});
