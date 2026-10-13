import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, FormData, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { toIsoDate, unitFrom, type RawInvoice } from './raw';

/** Чтение накладной с фотографии. В тестах вместо настоящего чтения подставляется заглушка. */
export interface InvoiceReader {
  read(image: Buffer, mediaType: string): Promise<RawInvoice>;
}

// Модель любит отдавать числа строками ("24", "62,50"), поэтому приводим всё к нормальному виду сами
const text = z.preprocess((v) => (v == null || v === '' ? null : String(v)), z.string().nullable());
const number = z.preprocess((v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}, z.number().nullable());

const Extracted = z.object({
  supplier_name: text.optional(),
  supplier_inn: text.optional(),
  number: text.optional(),
  date: text.optional(),
  total: number.optional(),
  lines: z.array(
    z.object({
      name: z.string(),
      code: text.optional(),
      unit: text.optional(),
      quantity: number,
      price_without_vat: number.optional(),
      expires_on: text.optional(),
    }),
  ),
});

const INSTRUCTION = [
  'Это фото или скан товарной накладной (или УПД) российского поставщика. Вытащи из неё данные.',
  'Ответь одним JSON-объектом, без пояснений и без markdown. Ключи:',
  '{"supplier_name": строка, "supplier_inn": строка из цифр, "number": строка, "date": строка, "total": число,',
  ' "lines": [{"name": строка, "code": строка или null, "unit": строка, "quantity": число, "price_without_vat": число или null, "expires_on": строка или null}]}',
  'Поставщик это продавец (грузоотправитель), а не покупатель, и ИНН нужен именно поставщика, не покупателя. ИНН пиши только цифрами и только если он напечатан.',
  'Дату оставь как на бумаге (например, 09.10.2026). Строки товаров иди по порядку, названия переписывай слово в слово.',
  'unit: единица как напечатана (кг, г, л, мл, шт, упак). price_without_vat: цена за единицу без НДС; если на бумаге только цена с НДС, пересчитай по ставке, а если ставки нет, оставь как есть.',
  'expires_on: срок годности строки, если он указан. Если значения нет или оно не читается, ставь null и ничего не выдумывай.',
].join('\n');

const AUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API_URL = 'https://gigachat.devices.sberbank.ru/api/v1';

export interface GigaChatOptions {
  /** Ключ авторизации из личного кабинета (base64 от «идентификатор:секрет»). */
  authKey: string;
  scope: string;
  model: string;
  /** Путь к корневому сертификату Минцифры. Сертификаты Сбера в стандартное хранилище Node не входят. */
  caFile?: string | null;
  /** Крайняя мера для стендов: не проверять сертификат сервиса. */
  insecureTls?: boolean;
  fetchFn?: typeof undiciFetch;
}

/**
 * Распознавание накладной через GigaChat. Картинка уходит в сервис Сбера, мы её там же сразу удаляем,
 * у себя не храним и в журнал не пишем.
 */
export class GigaChatInvoiceReader implements InvoiceReader {
  private readonly fetchFn: typeof undiciFetch;
  private readonly dispatcher: Agent | undefined;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: GigaChatOptions) {
    this.fetchFn = opts.fetchFn ?? undiciFetch;
    if (opts.caFile || opts.insecureTls) {
      this.dispatcher = new Agent({
        connect: { ca: opts.caFile ? readFileSync(opts.caFile) : undefined, rejectUnauthorized: !opts.insecureTls },
      });
    }
  }

  private call(url: string, init: Record<string, unknown>) {
    return this.fetchFn(url, { ...init, dispatcher: this.dispatcher, signal: AbortSignal.timeout(90_000) } as never);
  }

  /** Токен живёт около получаса: берём из кэша, а за минуту до конца просим новый. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const res = await this.call(AUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.opts.authKey}`,
        RqUID: randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope: this.opts.scope }).toString(),
    });
    if (!res.ok) throw new Error(`GigaChat не дал токен (${res.status})`);
    const data = (await res.json()) as { access_token?: string; expires_at?: number };
    if (!data.access_token) throw new Error('GigaChat не дал токен');
    this.token = { value: data.access_token, expiresAt: data.expires_at ?? Date.now() + 25 * 60_000 };
    return this.token.value;
  }

  async read(image: Buffer, mediaType: string): Promise<RawInvoice> {
    const token = await this.accessToken();
    const auth = { Authorization: `Bearer ${token}` };

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: mediaType }), 'invoice.' + (mediaType.split('/')[1] ?? 'jpg'));
    form.append('purpose', 'general');
    const upload = await this.call(`${API_URL}/files`, { method: 'POST', headers: auth, body: form });
    if (!upload.ok) throw new Error(`GigaChat не принял файл (${upload.status})`);
    const fileId = ((await upload.json()) as { id?: string }).id;
    if (!fileId) throw new Error('GigaChat не вернул идентификатор файла');

    try {
      const res = await this.call(`${API_URL}/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: 0.1,
          messages: [{ role: 'user', content: INSTRUCTION, attachments: [fileId] }],
        }),
      });
      if (!res.ok) throw new Error(`GigaChat не ответил (${res.status})`);
      const reply = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '';
      return this.toInvoice(this.parse(reply));
    } finally {
      // Файл на стороне сервиса нам больше не нужен. Не вышло удалить - не страшно, он приватный
      this.call(`${API_URL}/files/${fileId}/delete`, { method: 'POST', headers: auth }).catch(() => undefined);
    }
  }

  /** Модель иногда оборачивает ответ в ```json или добавляет слова вокруг, поэтому берём всё от первой «{» до последней «}». */
  private parse(reply: string): z.infer<typeof Extracted> {
    const from = reply.indexOf('{');
    const to = reply.lastIndexOf('}');
    if (from < 0 || to <= from) throw new Error('Модель не вернула разбор накладной');
    let json: unknown;
    try {
      json = JSON.parse(reply.slice(from, to + 1));
    } catch {
      throw new Error('Модель вернула разбор накладной в неверном виде');
    }
    const parsed = Extracted.safeParse(json);
    if (!parsed.success) throw new Error('Модель вернула разбор накладной в неверном виде');
    return parsed.data;
  }

  private toInvoice(data: z.infer<typeof Extracted>): RawInvoice {
    const warnings: string[] = ['Данные распознаны с фото: сверьте количество, цены и сроки с бумагой'];
    const lines = data.lines
      .filter((l) => l.name.trim() && l.quantity != null && l.quantity > 0)
      .slice(0, 200)
      .map((l) => ({
        name: l.name.trim(),
        code: l.code?.trim() || null,
        gtin: l.code && /^\d{8,14}$/.test(l.code.trim()) ? l.code.trim() : null,
        unit: unitFrom(null, l.unit ?? null),
        quantity: l.quantity as number,
        price: l.price_without_vat ?? null,
        expiresOn: toIsoDate(l.expires_on ?? null),
        batch: null,
        vsd: null,
        marks: [],
      }));
    if (data.lines.length > lines.length) warnings.push('Часть строк без названия или количества пропущена');
    return {
      number: data.number?.trim() || null,
      date: toIsoDate(data.date ?? null),
      supplier: data.supplier_name ? { name: data.supplier_name.trim(), inn: data.supplier_inn?.replace(/\D/g, '') || null } : null,
      total: data.total ?? null,
      lines,
      warnings,
    };
  }
}
