import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { toIsoDate, unitFrom, type RawInvoice } from './raw';

/** Чтение накладной с фотографии. Реализация подменяется в тестах. */
export interface InvoiceReader {
  read(image: Buffer, mediaType: string): Promise<RawInvoice>;
}

const Extracted = z.object({
  supplier_name: z.string().nullable(),
  supplier_inn: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  total: z.number().nullable(),
  lines: z.array(
    z.object({
      name: z.string(),
      code: z.string().nullable(),
      unit: z.string().nullable(),
      quantity: z.number(),
      price_without_vat: z.number().nullable(),
      expires_on: z.string().nullable(),
    }),
  ),
});

const INSTRUCTION = [
  'Это фотография или скан товарной накладной или УПД российского поставщика. Извлеки данные.',
  'Поставщик это продавец (грузоотправитель), не покупатель. ИНН бери только цифрами, если он напечатан.',
  'Дату записывай как напечатана (например 09.10.2026). Строки товаров переписывай по порядку, названия слово в слово.',
  'unit: единица измерения как напечатана (кг, г, л, мл, шт, упак). price_without_vat: цена за единицу без НДС, если есть только цена с НДС, пересчитай по ставке, если ставки нет, оставь цену как есть.',
  'expires_on: срок годности по строке, если он указан, иначе null. Если значение не читается или его нет, ставь null, ничего не выдумывай.',
].join('\n');

/** Распознавание через Claude: картинка уходит в сервис Anthropic, на сервере не сохраняется и не пишется в журнал. */
export class ClaudeInvoiceReader implements InvoiceReader {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 1, timeout: 90_000 });
  }

  async read(image: Buffer, mediaType: string): Promise<RawInvoice> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16_000,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: image.toString('base64') } },
            { type: 'text', text: INSTRUCTION },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(Extracted) },
    });
    const data = response.parsed_output;
    if (!data) throw new Error('Модель не вернула разбор накладной');

    const warnings: string[] = ['Данные распознаны с фото: сверьте количество, цены и сроки с бумагой'];
    const lines = data.lines
      .filter((l) => l.name.trim() && l.quantity > 0)
      .slice(0, 200)
      .map((l) => ({
        name: l.name.trim(),
        code: l.code?.trim() || null,
        gtin: l.code && /^\d{8,14}$/.test(l.code.trim()) ? l.code.trim() : null,
        unit: unitFrom(null, l.unit),
        quantity: l.quantity,
        price: l.price_without_vat,
        expiresOn: toIsoDate(l.expires_on),
        batch: null,
        vsd: null,
        marks: [],
      }));
    if (data.lines.length > lines.length) warnings.push('Часть строк без названия или количества пропущена');
    return {
      number: data.number?.trim() || null,
      date: toIsoDate(data.date),
      supplier: data.supplier_name ? { name: data.supplier_name.trim(), inn: data.supplier_inn?.replace(/\D/g, '') || null } : null,
      total: data.total,
      lines,
      warnings,
    };
  }
}
