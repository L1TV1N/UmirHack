import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InvoiceDto } from '@zapas/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceImportDialog, toBase64 } from './InvoiceImportDialog';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const product = { id: 'p1', name: 'Молоко 3,2% пастеризованное', unit: 'l' as const, sku: 'MLK-1', cost: 62, shelfLifeDays: 7 };

const invoice = (over: Partial<InvoiceDto> = {}): InvoiceDto => ({
  source: 'upd',
  number: 'ДН-100',
  date: '2026-10-09',
  supplier: { name: 'ООО «Донской»', inn: '7707083893', supplierId: 's1', how: 'inn' },
  total: null,
  warnings: [],
  alreadyReceived: null,
  lines: [
    { key: 'code:MLK', index: 0, name: 'Молоко «Донское» 3,2%', code: 'MLK', gtin: null, unit: 'l', quantity: 40, price: 61.5, expiresOn: null, batch: null, vsd: null, marks: [], converted: { quantity: 40, price: 61.5 }, unitMismatch: false, match: { product, how: 'similar' }, candidates: [] },
    { key: 'name:ананас', index: 1, name: 'Ананасы', code: null, gtin: null, unit: null, quantity: 3, price: 150, expiresOn: null, batch: null, vsd: null, marks: [], converted: null, unitMismatch: false, match: null, candidates: [{ productId: 'p9', name: 'Ананас свежий', unit: 'kg', cost: 200, shelfLifeDays: 10, score: 0.6 }] },
  ],
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
const answers = (parse: Response, photo = false) => {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/invoices/capabilities')) return json(200, { upd: true, photo });
    return parse.clone();
  });
};

function mount(onApply = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <InvoiceImportDialog open onClose={onClose} onApply={onApply} />
    </QueryClientProvider>,
  );
  return { onApply, onClose };
}

const upload = (name = 'upd.xml', text = '<Файл/>') => {
  const input = document.querySelector('input[type=file][accept*=xml]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], name, { type: 'text/xml' })] } });
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('загрузка накладной', () => {
  it('отправляет файл в base64 и показывает поставщика, строки и как найден продукт', async () => {
    answers(json(200, invoice()));
    mount();
    upload('upd.xml', '<Файл>привет</Файл>');
    expect(await screen.findByText('Молоко «Донское» 3,2%')).toBeTruthy();
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/invoices/parse'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ format: 'upd', content: Buffer.from('<Файл>привет</Файл>').toString('base64') });
    expect(screen.getByText('ООО «Донской»')).toBeTruthy();
    expect(screen.getByText('в справочнике')).toBeTruthy();
    expect(screen.getByText('похоже по названию, проверьте')).toBeTruthy();
    expect(screen.getByText(/без продукта: 1/)).toBeTruthy();
    expect(screen.getByText(/Похожие: Ананас свежий/)).toBeTruthy();
  });

  it('кнопка заполнения отдаёт накладную форме и закрывает окно', async () => {
    answers(json(200, invoice()));
    const { onApply, onClose } = mount();
    upload();
    const button = await screen.findByRole('button', { name: /Заполнить приход \(2\)/ });
    fireEvent.click(button);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect((onApply.mock.calls[0]?.[0] as InvoiceDto).number).toBe('ДН-100');
    expect(onClose).toHaveBeenCalled();
  });

  it('повторная накладная требует подтверждения, прежде чем её можно применить', async () => {
    answers(json(200, invoice({ alreadyReceived: { documentNumber: 'ПР-000123', receivedOn: '2026-10-08' }, warnings: ['Накладная №ДН-100 уже оприходована (ПР-000123)'] })));
    const { onApply } = mount();
    upload();
    const button = (await screen.findByRole('button', { name: /Заполнить приход/ })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/уже оприходована/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Это не повтор/));
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    expect(onApply).toHaveBeenCalled();
  });

  it('ошибка сервера показывается человеку, применить нечего', async () => {
    answers(json(400, { error: { code: 'invoice_format', message: 'Это не универсальный передаточный документ' }, requestId: 'r' }));
    mount();
    upload();
    expect(await screen.findByText(/Это не универсальный передаточный документ/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Заполнить приход/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('слишком большой файл не уходит на сервер', async () => {
    answers(json(200, invoice()));
    mount();
    const big = new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'big.xml');
    fireEvent.change(document.querySelector('input[type=file][accept*=xml]') as HTMLInputElement, { target: { files: [big] } });
    expect(await screen.findByText('Файл больше 3 МБ')).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/invoices/parse'))).toBe(false);
  });

  it('кнопка фото есть, только если распознавание подключено', async () => {
    answers(json(200, invoice()), false);
    mount();
    expect(await screen.findByText(/Распознавание фото выключено/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Сфотографировать/ })).toBeNull();
    cleanup();
    answers(json(200, invoice()), true);
    mount();
    expect(await screen.findByRole('button', { name: /Сфотографировать накладную/ })).toBeTruthy();
  });

  it('base64 большого файла собирается по кускам и совпадает с Buffer', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
