import { describe, expect, it } from 'vitest';
import { GigaChatInvoiceReader } from '../../src/modules/invoices/reader';

type Call = { url: string; method: string; body?: unknown };

/** Подделка сервиса: отвечает на выдачу токена, загрузку файла, запрос к модели и удаление файла. */
function fakeService(reply: string, opts: { authStatus?: number; chatStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: { method: string; body?: unknown }) => {
    calls.push({ url, method: init.method, body: init.body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/oauth')) return opts.authStatus ? json({}, opts.authStatus) : json({ access_token: 'tok', expires_at: Date.now() + 30 * 60_000 });
    if (url.endsWith('/files')) return json({ id: 'file-1' });
    if (url.includes('/delete')) return json({ deleted: true });
    if (url.endsWith('/chat/completions')) return opts.chatStatus ? json({}, opts.chatStatus) : json({ choices: [{ message: { content: reply } }] });
    return json({}, 404);
  }) as never;
  return { calls, fetchFn };
}

const reader = (fetchFn: never) => new GigaChatInvoiceReader({ authKey: 'key', scope: 'GIGACHAT_API_PERS', model: 'GigaChat-2-Max', fetchFn });
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('чтение накладной через GigaChat', () => {
  it('приводит ответ модели к виду накладной: числа строками, ответ в markdown, лишние пробелы', async () => {
    const answer = [
      'Вот разбор:',
      '```json',
      JSON.stringify({
        supplier_name: ' Хлебозавод №4 ',
        supplier_inn: '6165 056782',
        number: '77/10',
        date: '13.10.2026',
        total: '10 131,00',
        lines: [
          { name: ' Батон нарезной ', code: '4607000011546', unit: 'шт', quantity: '120', price_without_vat: '24,50', expires_on: '15.10.2026' },
          { name: 'Без количества', unit: 'шт', quantity: null, price_without_vat: 10 },
        ],
      }),
      '```',
    ].join('\n');
    const { fetchFn } = fakeService(answer);

    const inv = await reader(fetchFn).read(jpeg, 'image/jpeg');

    expect(inv.number).toBe('77/10');
    expect(inv.date).toBe('2026-10-13');
    expect(inv.total).toBe(10131);
    expect(inv.supplier).toEqual({ name: 'Хлебозавод №4', inn: '6165056782' });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ name: 'Батон нарезной', gtin: '4607000011546', quantity: 120, price: 24.5, expiresOn: '2026-10-15' });
    expect(inv.warnings.join(' ')).toContain('сверьте');
    expect(inv.warnings.join(' ')).toContain('пропущена');
  });

  it('берёт токен один раз, загружает файл, просит модель разобрать его и удаляет файл', async () => {
    const { calls, fetchFn } = fakeService(JSON.stringify({ lines: [] }));
    const r = reader(fetchFn);
    await r.read(jpeg, 'image/jpeg');
    await r.read(jpeg, 'image/jpeg');

    const urls = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(urls.filter((u) => u.includes('/oauth'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/files'))).toHaveLength(2);
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'));
    expect(JSON.parse(chat?.body as string).messages[0].attachments).toEqual(['file-1']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(urls.filter((u) => u.includes('/files/file-1/delete'))).toHaveLength(2);
  });

  it('сообщает об отказе сервиса и о ненастоящем ответе модели', async () => {
    await expect(reader(fakeService('', { authStatus: 401 }).fetchFn).read(jpeg, 'image/jpeg')).rejects.toThrow('токен');
    await expect(reader(fakeService('', { chatStatus: 500 }).fetchFn).read(jpeg, 'image/jpeg')).rejects.toThrow('не ответил');
    await expect(reader(fakeService('Извините, не могу разобрать').fetchFn).read(jpeg, 'image/jpeg')).rejects.toThrow('не вернула');
    await expect(reader(fakeService('{"lines": "много"}').fetchFn).read(jpeg, 'image/jpeg')).rejects.toThrow('неверном виде');
  });
});
