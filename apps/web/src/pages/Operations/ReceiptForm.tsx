import {
  addDays,
  convertInvoiceUnit,
  formatMoney,
  formatQty,
  INVOICE_MATCH_LABELS,
  markIdentity,
  normalizeVsd,
  UNIT_LABELS,
  type InvoiceCandidateDto,
  type InvoiceDto,
  type InvoiceMatchHow,
  type InvoiceUnit,
  type OrderDetailDto,
  type OrderDto,
  type Page,
  type ProductDto,
  type SupplierDto,
} from '@zapas/shared';
import { FileInput, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, get, put } from '../../api/client';
import { submitDocument } from '../../api/documents';
import { STOCK_PREFIXES, useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Checkbox, Field, Input, Select } from '../../components/Controls/Controls';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { LineRow, Lines, LinesFooter, LinesHead, useLines } from '../../components/Lines/Lines';
import { ProductPicker } from '../../components/ProductPicker/ProductPicker';
import { ScanButton, type ScanHit } from '../../components/Scanner/ScanButton';
import type { ScanFeedback } from '../../components/Scanner/ScannerDialog';
import { useToast } from '../../components/Toast/Toast';
import { Chip } from '../../components/Chip/Chip';
import { errorMessage } from '../../lib/errors';
import { fmtDate, parseDecimal, todayLocal } from '../../lib/format';
import { focusFirstInvalid, LocationField, useIdempotencyKey, useOperationLocation } from './common';
import { InvoiceImportDialog } from './InvoiceImportDialog';
import styles from './Forms.module.scss';

type LineProduct = Pick<ProductDto, 'id' | 'name' | 'unit' | 'cost' | 'shelfLifeDays'> & Partial<Pick<ProductDto, 'requiresVsd' | 'requiresMarking'>>;

/** Откуда строка пришла: строка накладной поставщика и то, что с ней было сопоставлено. */
interface LineSource {
  key: string;
  name: string;
  how: InvoiceMatchHow | null;
  matchedId: string | null;
  candidates: InvoiceCandidateDto[];
  quantity: number;
  price: number | null;
  unit: InvoiceUnit | null;
  expiresOn: string | null;
}

interface Line {
  key: number;
  product: LineProduct | null;
  quantity: string;
  unitCost: string;
  expiresOn: string;
  source: LineSource | null;
  /** Номер ветеринарного документа из «Меркурия». */
  vsd: string;
  /** Коды маркировки, отсканированные при приёмке. */
  marks: string[];
}

const TEMPLATE = 'minmax(220px, 2.4fr) 120px 130px 160px 36px';
const LABELS = ['Продукт', 'Количество', 'Себестоимость, ₽', 'Годен до', ''];

export function ReceiptForm({ presetOrder, onPresetUsed }: { presetOrder?: string | undefined; onPresetUsed?: () => void } = {}) {
  const toast = useToast();
  const { user } = useAuth();
  const [locationId, setLocation, locations] = useOperationLocation();
  const suppliers = useGet<SupplierDto[]>('/suppliers', undefined, { staleTime: 120_000 });
  const [supplierId, setSupplierId] = useState('');
  const [documentNo, setDocumentNo] = useState('');
  const [comment, setComment] = useState('');
  const [allowExpired, setAllowExpired] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [locationError, setLocationError] = useState<string | undefined>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [order, setOrder] = useState<{ id: string; number: string; locationId: string } | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const { lines, snapshot, add, remove, update, reset, upsert, replaceAll } = useLines<Line>(() => ({ product: null, quantity: '', unitCost: '', expiresOn: '', source: null, vsd: '', marks: [] }));

  const create = useAction(
    (body: object) =>
      submitDocument<{ number: string }>(user?.id ?? '', {
        path: '/documents/receipts',
        body,
        key: key(),
        label: `Приход, ${(body as { lines: unknown[] }).lines.length} поз.`,
      }),
    STOCK_PREFIXES,
  );

  const openOrders = useGet<Page<OrderDto>>('/orders', { status: 'open', locationId, limit: 50 }, { enabled: Boolean(locationId), staleTime: 30_000 });
  const orderOptions = openOrders.data?.items ?? [];

  // заказ привязан к точке: сменили точку, привязка снимается
  useEffect(() => {
    if (order && order.locationId !== locationId) setOrder(null);
  }, [order, locationId]);

  /** Строки заказа становятся строками прихода: остаток к приёмке, цена и срок из карточки продукта. */
  const takeOrder = async (id: string) => {
    if (!id) return setOrder(null);
    try {
      const o = await get<OrderDetailDto>(`/orders/${id}`);
      const todo = o.items.filter((i) => i.quantity - i.receivedQty > 0.0005);
      if (todo.length === 0) return toast.info('По этому заказу всё уже принято');
      setSupplierId(o.supplierId);
      replaceAll(
        todo.map((i) => ({
          product: { id: i.productId, name: i.productName, unit: i.unit, cost: i.unitCost, shelfLifeDays: i.shelfLifeDays },
          quantity: String(Math.round((i.quantity - i.receivedQty) * 1000) / 1000),
          unitCost: String(i.unitCost),
          expiresOn: i.shelfLifeDays ? addDays(todayLocal(), i.shelfLifeDays) : '',
        })),
      );
      setOrder({ id: o.id, number: o.number, locationId: o.locationId });
      setErrors({});
      toast.info(`Строки взяты из заказа ${o.number}. Проверьте количества и сроки годности`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  // ссылка «Принять поставку» из заказа открывает приход сразу с его строками
  useEffect(() => {
    if (!presetOrder) return;
    void takeOrder(presetOrder);
    onPresetUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetOrder]);

  const pick = (lineKey: number, product: LineProduct | null) => {
    const line = lines.find((l) => l.key === lineKey);
    const source = line?.source;
    const shelf = product?.shelfLifeDays ? addDays(todayLocal(), product.shelfLifeDays) : '';
    if (source && product) {
      // строка из накладной: количество и цену приводим к единицам выбранного продукта
      const conv = convertInvoiceUnit(source.quantity, source.price, source.unit, product.unit);
      update(lineKey, {
        product,
        quantity: String(conv?.quantity ?? source.quantity),
        unitCost: String(conv?.price ?? source.price ?? product.cost),
        expiresOn: source.expiresOn ?? shelf,
      });
      return;
    }
    update(lineKey, { product, unitCost: product ? String(product.cost) : '', expiresOn: shelf });
  };

  /** Строки накладной становятся строками прихода. Проверяет и проводит их человек. */
  const applyInvoice = (inv: InvoiceDto) => {
    if (inv.supplier?.supplierId) setSupplierId(inv.supplier.supplierId);
    if (inv.number) setDocumentNo(inv.number.slice(0, 40));
    replaceAll(
      inv.lines.map((l) => {
        const p = l.match?.product ?? null;
        const cost = l.converted?.price ?? l.price ?? p?.cost ?? null;
        return {
          product: p,
          quantity: String(l.converted?.quantity ?? l.quantity),
          unitCost: cost === null ? '' : String(cost),
          expiresOn: l.expiresOn ?? (p?.shelfLifeDays ? addDays(todayLocal(), p.shelfLifeDays) : ''),
          vsd: l.vsd ?? '',
          marks: l.marks,
          source: { key: l.key, name: l.name, how: l.match?.how ?? null, matchedId: p?.id ?? null, candidates: l.candidates, quantity: l.quantity, price: l.price, unit: l.unit, expiresOn: l.expiresOn },
        };
      }),
    );
    setErrors({});
    toast.info(`Из накладной взято строк: ${inv.lines.length}. Проверьте продукты, количества и сроки`);
  };

  /** После прихода запоминаем выбор человека: в следующей накладной этого поставщика строка найдётся сама. */
  const rememberChoices = (supplier: string, snapshot: Line[]) => {
    const items = new Map<string, string>();
    for (const l of snapshot) {
      if (!l.source || !l.product) continue;
      const trusted = l.source.how === 'barcode' || l.source.how === 'mapping';
      if (trusted && l.source.matchedId === l.product.id) continue;
      items.set(l.source.key, l.product.id);
    }
    if (supplier && items.size > 0) void put(`/suppliers/${supplier}/item-map`, { items: [...items].map(([k, productId]) => ({ key: k, productId })) }).catch(() => undefined);
  };

  // Скан добавляет единицу. У кода со сроком (GS1) партии с разными сроками это разные строки.
  // Марка «Честного знака» запоминается в строке, и одна и та же марка дважды не принимается
  const onScan = ({ product, scan }: ScanHit): ScanFeedback => {
    const expires = scan.expiresOn ?? (product.shelfLifeDays ? addDays(todayLocal(), product.shelfLifeDays) : '');
    const mark = scan.marked && markIdentity(scan.raw) ? scan.raw : null;
    if (mark) {
      const id = markIdentity(mark);
      if (snapshot().some((l) => l.marks.some((m) => markIdentity(m) === id))) {
        return { ok: false, message: `${product.name}: эта марка уже отсканирована в приходе` };
      }
    }
    const { line } = upsert(
      (l) => l.product?.id === product.id && l.expiresOn === expires,
      (l) => ({ quantity: String((parseDecimal(l.quantity) ?? 0) + 1), ...(mark ? { marks: [...l.marks, mark] } : {}) }),
      { product, quantity: '1', unitCost: String(product.cost), expiresOn: expires, ...(mark ? { marks: [mark] } : {}) },
      (l) => !l.product,
    );
    const tail = expires ? `годен до ${fmtDate(expires)}` : 'укажите срок годности в форме';
    const marks = line.marks.length > 0 ? `, марок: ${line.marks.length}` : '';
    return { ok: true, message: `${product.name}: ${formatQty(parseDecimal(line.quantity) ?? 1, product.unit)}${marks}, ${tail}` };
  };

  const total = lines.reduce((s, l) => s + (parseDecimal(l.quantity) ?? 0) * (parseDecimal(l.unitCost) ?? 0), 0);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setServerError(null);
    const found: Record<number, string> = {};
    const usedVsd = new Set<string>();
    const payload = lines.map((l) => {
      const quantity = parseDecimal(l.quantity);
      const unitCost = parseDecimal(l.unitCost);
      const vsd = l.vsd.trim() ? normalizeVsd(l.vsd) : null;
      if (!l.product) found[l.key] = 'Выберите продукт';
      else if (quantity === null || quantity <= 0) found[l.key] = 'Укажите количество';
      else if (unitCost === null || unitCost < 0) found[l.key] = 'Укажите себестоимость за единицу';
      else if (!l.expiresOn) found[l.key] = 'Укажите срок годности';
      else if (l.vsd.trim() && !vsd) found[l.key] = 'Номер ВСД это UUID вида 1a2b3c4d-1234-5678-9abc-def012345678';
      else if (vsd && usedVsd.has(vsd)) found[l.key] = 'Этот ВСД уже указан в другой строке';
      else if (l.product.unit === 'pcs' && l.marks.length > quantity) found[l.key] = `Марок (${l.marks.length}) больше, чем штук (${quantity}). Исправьте количество или уберите марки`;
      if (vsd) usedVsd.add(vsd);
      return { productId: l.product?.id, quantity, unitCost, expiresOn: l.expiresOn, ...(vsd ? { vsd } : {}), ...(l.marks.length > 0 ? { marks: l.marks } : {}) };
    });
    setErrors(found);
    setLocationError(locationId ? undefined : 'Выберите точку, на которую принимаем товар');
    if (Object.keys(found).length > 0 || !locationId) {
      focusFirstInvalid(form);
      return;
    }

    create.mutate(
      {
        locationId,
        ...(supplierId ? { supplierId } : {}),
        ...(order ? { orderId: order.id } : {}),
        ...(documentNo.trim() ? { documentNo: documentNo.trim() } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        allowExpired,
        lines: payload,
      },
      {
        onSuccess: (r) => {
          if (r.queued) toast.info('Нет связи: приход сохранён в очереди и уйдёт сам, когда связь вернётся');
          else {
            toast.success(`Приход ${r.result.number} проведён`);
            rememberChoices(supplierId, lines);
          }
          reset();
          setOrder(null);
          setDocumentNo('');
          setComment('');
          renewKey();
        },
        onError: (err) => {
          // дату «сегодня» знает сервер (часовой пояс бизнеса), поэтому ошибки строк берём у него
          const byLine: Record<number, string> = {};
          if (err instanceof ApiError) {
            for (const [path, message] of Object.entries(err.fieldErrors())) {
              const m = /^lines\.(\d+)\./.exec(path);
              const line = m ? lines[Number(m[1])] : undefined;
              if (line) byLine[line.key] = err.code === 'already_expired' ? 'Срок уже истёк. Для приёмки брака включите «Принять просроченный товар».' : message;
            }
          }
          if (Object.keys(byLine).length > 0) setErrors(byLine);
          else setServerError(errorMessage(err));
        },
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.top}>
        <LocationField value={locationId} onChange={(id) => { setLocation(id); setLocationError(undefined); }} options={locations} error={locationError} />
        <Field label="Поставщик">
          {(p) => (
            <Select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Не указан</option>
              {suppliers.data
                ?.filter((s) => s.isActive)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Номер накладной">{(p) => <Input {...p} value={documentNo} maxLength={40} onChange={(e) => setDocumentNo(e.target.value)} />}</Field>
      </div>

      {(orderOptions.length > 0 || order) && (
        <Field label="Принять по заказу" hint={order ? `Принятое количество засчитается в заказ ${order.number}` : 'Строки заполнятся из заказа поставщику'}>
          {(p) => (
            <Select {...p} value={order?.id ?? ''} onChange={(e) => void takeOrder(e.target.value)}>
              <option value="">Без заказа</option>
              {order && !orderOptions.some((o) => o.id === order.id) && <option value={order.id}>{order.number}</option>}
              {orderOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.number} · {o.supplierName} · {formatMoney(o.total)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <div className={styles.import}>
        <Button icon={<FileInput size={16} />} onClick={() => setInvoiceOpen(true)}>
          Загрузить накладную
        </Button>
        <span className="muted">УПД из ЭДО или 1С (XML), а где подключено, и фото накладной</span>
      </div>
      <InvoiceImportDialog open={invoiceOpen} onClose={() => setInvoiceOpen(false)} onApply={applyInvoice} />

      <Lines.Wrap>
        <LinesHead template={TEMPLATE} labels={LABELS} />
        {lines.map((l) => (
          <LineRow
            labels={LABELS}
            key={l.key}
            template={TEMPLATE}
            canRemove={lines.length > 1}
            onRemove={() => remove(l.key)}
            error={errors[l.key]}
            note={
              (l.source || hasTrace(l)) && (
                <>
                  {l.source && <SourceNote line={l} onChoose={(c) => pick(l.key, { id: c.productId, name: c.name, unit: c.unit, cost: c.cost, shelfLifeDays: c.shelfLifeDays })} />}
                  {hasTrace(l) && <TraceNote line={l} onVsd={(vsd) => update(l.key, { vsd })} onClearMarks={() => update(l.key, { marks: [] })} />}
                </>
              )
            }
            cells={[
              <ProductPicker key="p" value={l.product} onChange={(p) => pick(l.key, p)} invalid={Boolean(errors[l.key])} />,
              <>
                <Input numeric aria-label="Количество" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} placeholder="0" />
                {l.product && <span className={Lines.unit}>{UNIT_LABELS[l.product.unit]}</span>}
              </>,
              <Input key="c" numeric aria-label="Себестоимость за единицу" value={l.unitCost} onChange={(e) => update(l.key, { unitCost: e.target.value })} placeholder="0,00" />,
              <Input key="d" type="date" aria-label="Годен до" value={l.expiresOn} onChange={(e) => update(l.key, { expiresOn: e.target.value })} />,
            ]}
          />
        ))}
        <LinesFooter onAdd={add}>
          <ScanButton onProduct={onScan} title="Сканирование прихода" hint="Каждый скан добавляет единицу товара в приход" />
          <span className={styles.total}>
            <span>Сумма прихода: </span>
            {formatMoney(Math.round(total * 100) / 100)}
          </span>
        </LinesFooter>
      </Lines.Wrap>

      <Field label="Комментарий">{(p) => <Input {...p} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />}</Field>
      <Checkbox label="Принять просроченный товар (для учёта брака)" checked={allowExpired} onChange={(e) => setAllowExpired(e.target.checked)} />
      {serverError && <ErrorNote message={serverError} />}
      <div className={styles.foot}>
        <span className="muted">Срок годности подставляется из карточки продукта, его можно исправить.</span>
        <Button variant="primary" type="submit" loading={create.isPending}>
          Провести приход
        </Button>
      </div>
    </form>
  );
}


const hasTrace = (l: Line) => Boolean(l.product?.requiresVsd || l.product?.requiresMarking || l.vsd || l.marks.length > 0);

/** Под строкой: номер ВСД для продуктов, которые идут с ветеринарным документом, и принятые марки. */
function TraceNote({ line, onVsd, onClearMarks }: { line: Line; onVsd: (vsd: string) => void; onClearMarks: () => void }) {
  const product = line.product;
  if (!product) return null;
  const quantity = parseDecimal(line.quantity) ?? 0;
  const showVsd = product.requiresVsd || line.vsd !== '';
  const bad = line.vsd.trim() !== '' && normalizeVsd(line.vsd) === null;
  return (
    <>
      {showVsd && (
        <>
          <span className={styles.vsd}>
            <Input
              aria-label="Номер ВСД"
              aria-invalid={bad || undefined}
              value={line.vsd}
              maxLength={40}
              spellCheck={false}
              autoComplete="off"
              placeholder="Номер ВСД из «Меркурия»"
              onChange={(e) => onVsd(e.target.value)}
            />
          </span>
          {!line.vsd.trim() && <Chip tone="amber">нужен ВСД, погасить его в «Меркурии» надо за сутки</Chip>}
          {bad && <Chip tone="danger">это не номер ВСД</Chip>}
        </>
      )}
      {(product.requiresMarking || line.marks.length > 0) && (
        <>
          <Chip tone={line.marks.length === 0 ? 'amber' : product.unit === 'pcs' && line.marks.length < quantity ? 'info' : 'ok'}>
            {line.marks.length === 0 ? 'нужны марки: отсканируйте коды на упаковках' : product.unit === 'pcs' && quantity > 0 ? `марок: ${line.marks.length} из ${quantity}` : `марок: ${line.marks.length}`}
          </Chip>
          {line.marks.length > 0 && (
            <Button size="sm" icon={<X size={14} />} onClick={onClearMarks}>
              Сбросить марки
            </Button>
          )}
        </>
      )}
    </>
  );
}

/** Под строкой из накладной: что написано у поставщика, как найден продукт и похожие, если не найден. */
function SourceNote({ line, onChoose }: { line: Line; onChoose: (c: InvoiceCandidateDto) => void }) {
  const source = line.source;
  if (!source) return null;
  const changed = line.product !== null && source.matchedId !== line.product.id;
  const mismatch = line.product !== null && convertInvoiceUnit(source.quantity, source.price, source.unit, line.product.unit) === null;
  return (
    <>
      <span>В накладной: «{source.name}»</span>
      {line.product && source.how && !changed && <Chip tone={source.how === 'similar' ? 'amber' : 'ok'}>{INVOICE_MATCH_LABELS[source.how]}</Chip>}
      {changed && <Chip tone="info">выбор запомнится</Chip>}
      {mismatch && <Chip tone="danger">единицы накладной не сходятся с продуктом, проверьте количество</Chip>}
      {!line.product && source.candidates.length > 0 && (
        <>
          <span>Похожие:</span>
          {source.candidates.map((c) => (
            <Button key={c.productId} size="sm" onClick={() => onChoose(c)}>
              {c.name}
            </Button>
          ))}
        </>
      )}
    </>
  );
}
