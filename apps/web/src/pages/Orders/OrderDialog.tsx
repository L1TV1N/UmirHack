import {
  formatMoney,
  formatQty,
  ORDER_STATUS_LABELS,
  UNIT_LABELS,
  type OrderDetailDto,
  type OrderLineDto,
  type OrderStatus,
  type ProductDto,
} from '@zapas/shared';
import { Copy, Download, Mail, Plus, Send, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { downloadFile, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Field, Input } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { ProductPicker } from '../../components/ProductPicker/ProductPicker';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDate, fmtDateTime, parseDecimal } from '../../lib/format';
import styles from './Orders.module.scss';

export const STATUS_TONE: Record<OrderStatus, Tone> = { draft: 'neutral', sent: 'info', partial: 'amber', received: 'ok', cancelled: 'neutral' };

interface Row {
  productId: string;
  name: string;
  sku: string;
  unit: OrderLineDto['unit'];
  quantity: string;
  unitCost: string;
}

const toRow = (l: OrderLineDto): Row => ({ productId: l.productId, name: l.productName, sku: l.sku, unit: l.unit, quantity: String(l.quantity), unitCost: String(l.unitCost) });

export function OrderDialog({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const query = useGet<OrderDetailDto>(`/orders/${orderId ?? 'none'}`, undefined, { enabled: orderId !== null });
  const order = query.data;
  const [rows, setRows] = useState<Row[]>([]);
  const [expectedOn, setExpectedOn] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);

  const act = useAction((v: { path: string; method?: 'post' | 'patch'; body?: object }) => (v.method === 'patch' ? patch<OrderDetailDto>(v.path, v.body) : post<OrderDetailDto>(v.path, v.body)), ['/orders', '/stock']);

  useEffect(() => {
    if (!order) return;
    setRows(order.items.map(toRow));
    setExpectedOn(order.expectedOn ?? '');
    setComment(order.comment ?? '');
    setError(null);
    setShowText(false);
    setClosing(null);
    setAdding(false);
  }, [order]);

  const draft = order?.status === 'draft';
  const open = order?.status === 'sent' || order?.status === 'partial';

  const collect = (): { productId: string; quantity: number; unitCost: number }[] | null => {
    const lines = rows.map((r) => ({ productId: r.productId, quantity: parseDecimal(r.quantity), unitCost: parseDecimal(r.unitCost) }));
    const bad = lines.findIndex((l) => l.quantity === null || l.quantity <= 0 || l.unitCost === null || l.unitCost < 0);
    if (bad >= 0) {
      setError(`Строка ${bad + 1}: проверьте количество и цену`);
      return null;
    }
    return lines as { productId: string; quantity: number; unitCost: number }[];
  };

  const run = (v: Parameters<typeof act.mutate>[0], done: string, then?: () => void) => {
    setError(null);
    act.mutate(v, {
      onSuccess: () => {
        toast.success(done);
        then?.();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const save = (then?: () => void) => {
    if (!order) return;
    const lines = collect();
    if (!lines) return;
    run({ path: `/orders/${order.id}`, method: 'patch', body: { lines, expectedOn: expectedOn || null, comment: comment.trim() || null } }, 'Черновик сохранён', then);
  };

  const send = async () => {
    if (!order) return;
    const lines = collect();
    if (!lines) return;
    const ok = await confirm({
      title: 'Отправить заказ поставщику?',
      message: order.supplierEmail ? `Письмо с заказом на ${formatMoney(total)} уйдёт на ${order.supplierEmail}. После отправки менять заказ нельзя.` : `У поставщика не указана почта: заказ будет отмечен отправленным, текст нужно передать ему самостоятельно. После отправки менять заказ нельзя.`,
      confirmLabel: 'Отправить',
    });
    if (!ok) return;
    // сначала сохраняем правки, затем отправляем: иначе уйдёт то, что было в базе до них
    act.mutate(
      { path: `/orders/${order.id}`, method: 'patch', body: { lines, expectedOn: expectedOn || null, comment: comment.trim() || null } },
      {
        onSuccess: () =>
          act.mutate(
            { path: `/orders/${order.id}/send` },
            {
              onSuccess: (sent) => (sent.emailError ? toast.info(`Заказ отправлен, но письмо не ушло: ${sent.emailError}`) : toast.success(sent.emailedAt ? 'Заказ отправлен, письмо ушло поставщику' : 'Заказ отправлен')),
              onError: (err) => setError(errorMessage(err)),
            },
          ),
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const cancel = async () => {
    if (!order) return;
    const ok = await confirm({ title: 'Отменить заказ?', message: `Заказ ${order.number} будет отменён${order.status === 'sent' ? '. Поставщику нужно сообщить самостоятельно' : ''}.`, confirmLabel: 'Отменить заказ', danger: true });
    if (ok) run({ path: `/orders/${order.id}/cancel` }, 'Заказ отменён');
  };

  const copyText = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(order.text);
      toast.success('Текст заказа скопирован');
    } catch {
      setShowText(true);
      toast.error('Не удалось скопировать, текст показан ниже');
    }
  };

  const exportCsv = async () => {
    if (!order) return;
    setExporting(true);
    try {
      await downloadFile(`/orders/${order.id}/export.csv`, undefined, `order-${order.number}.csv`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const setRow = (i: number, patchRow: Partial<Row>) => setRows((all) => all.map((r, k) => (k === i ? { ...r, ...patchRow } : r)));
  const total = rows.reduce((s, r) => s + (parseDecimal(r.quantity) ?? 0) * (parseDecimal(r.unitCost) ?? 0), 0);

  const addProduct = (p: ProductDto | null) => {
    if (!p) return;
    if (rows.some((r) => r.productId === p.id)) {
      toast.info('Этот продукт уже в заказе');
      return;
    }
    setRows((all) => [...all, { productId: p.id, name: p.name, sku: p.sku, unit: p.unit, quantity: String(p.packSize), unitCost: String(p.cost) }]);
    setAdding(false);
  };

  return (
    <Dialog
      open={orderId !== null}
      onClose={onClose}
      title={order ? `Заказ ${order.number}` : 'Заказ'}
      subtitle={order ? `${order.supplierName}, ${order.locationName}` : undefined}
      width={880}
      footer={
        <>
          <Button onClick={onClose}>Закрыть окно</Button>
          {draft && (
            <>
              <Button onClick={() => save()} loading={act.isPending}>
                Сохранить черновик
              </Button>
              <Button variant="primary" icon={<Send size={15} />} onClick={() => void send()} loading={act.isPending}>
                Отправить поставщику
              </Button>
            </>
          )}
        </>
      }
    >
      {query.isError && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
      {order && (
        <>
          <dl className={styles.facts}>
            <div>
              <dt>Статус</dt>
              <dd>
                <Chip tone={STATUS_TONE[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Chip>
              </dd>
            </div>
            <div>
              <dt>Создан</dt>
              <dd>
                {fmtDateTime(order.createdAt)}
                <span className={styles.sub}>{order.createdBy ?? 'собран автоматически'}</span>
              </dd>
            </div>
            <div>
              <dt>Отправлен</dt>
              <dd>{order.sentAt ? fmtDateTime(order.sentAt) : '-'}</dd>
            </div>
            <div>
              <dt>Письмо поставщику</dt>
              <dd>
                {order.emailedAt ? <Chip tone="ok">отправлено {fmtDateTime(order.emailedAt)}</Chip> : order.emailError ? <Chip tone="amber">{order.emailError}</Chip> : <span className="muted">{draft ? 'уйдёт при отправке' : '-'}</span>}
              </dd>
            </div>
          </dl>

          {draft && !order.supplierEmail && <p className={styles.warn}>У поставщика не указана почта. Заказ можно отправить, но письмо не уйдёт: текст придётся передать самостоятельно (кнопка «Скопировать текст»).</p>}
          {order.status === 'partial' && <p className={styles.warn}>Часть заказа принята. Если поставщик больше ничего не привезёт, закройте заказ: недопоставка перестанет считаться «в пути».</p>}

          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Продукт</th>
                  <th className={styles.num}>Количество</th>
                  <th className={styles.num}>Цена, ₽</th>
                  <th className={styles.num}>Сумма</th>
                  {!draft && <th className={styles.num}>Принято</th>}
                  {draft && <th aria-label="Убрать" />}
                </tr>
              </thead>
              <tbody>
                {draft
                  ? rows.map((r, i) => (
                      <tr key={r.productId}>
                        <td>
                          <strong>{r.name}</strong>
                          <span className={styles.sub}>{r.sku}</span>
                        </td>
                        <td className={styles.num}>
                          <Input numeric aria-label={`Количество: ${r.name}`} value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} /> <span className="muted">{UNIT_LABELS[r.unit]}</span>
                        </td>
                        <td className={styles.num}>
                          <Input numeric aria-label={`Цена: ${r.name}`} value={r.unitCost} onChange={(e) => setRow(i, { unitCost: e.target.value })} />
                        </td>
                        <td className={styles.num}>{formatMoney(Math.round((parseDecimal(r.quantity) ?? 0) * (parseDecimal(r.unitCost) ?? 0) * 100) / 100)}</td>
                        <td>
                          <Button size="sm" icon={<Trash2 size={14} />} aria-label={`Убрать: ${r.name}`} disabled={rows.length === 1} onClick={() => setRows((all) => all.filter((_, k) => k !== i))} />
                        </td>
                      </tr>
                    ))
                  : order.items.map((l) => (
                      <tr key={l.productId}>
                        <td>
                          <strong>{l.productName}</strong>
                          <span className={styles.sub}>{l.sku}</span>
                        </td>
                        <td className={styles.num}>{formatQty(l.quantity, l.unit)}</td>
                        <td className={styles.num}>{formatMoney(l.unitCost)}</td>
                        <td className={styles.num}>{formatMoney(l.sum)}</td>
                        <td className={styles.num}>{l.receivedQty > 0 ? <Chip tone={l.receivedQty >= l.quantity ? 'ok' : 'amber'}>{formatQty(l.receivedQty, l.unit)}</Chip> : <span className="muted">-</span>}</td>
                      </tr>
                    ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className={styles.num}>
                    <strong>Итого</strong>
                  </td>
                  <td className={styles.num}>
                    <strong>{formatMoney(draft ? Math.round(total * 100) / 100 : order.total)}</strong>
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {draft && (
            <>
              <div className={styles.actions} style={{ marginBottom: 12 }}>
                {!adding ? (
                  <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                    Добавить продукт
                  </Button>
                ) : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <ProductPicker value={null} onChange={addProduct} placeholder="Название или артикул продукта" />
                    </div>
                    <Button size="sm" icon={<X size={14} />} onClick={() => setAdding(false)}>
                      Не добавлять
                    </Button>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <Field label="Желаемая дата поставки">{(p) => <Input {...p} type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />}</Field>
                <Field label="Комментарий поставщику">{(p) => <Input {...p} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />}</Field>
              </div>
            </>
          )}
          {!draft && (order.expectedOn || order.comment) && (
            <p className={styles.note}>
              {order.expectedOn ? `Желаемая дата поставки: ${fmtDate(order.expectedOn)}. ` : ''}
              {order.comment ? `Комментарий: ${order.comment}` : ''}
            </p>
          )}

          {error && (
            <div style={{ marginTop: 12 }}>
              <ErrorNote message={error} />
            </div>
          )}

          <div className={styles.actions} style={{ marginTop: 16 }}>
            <Button size="sm" icon={<Copy size={14} />} onClick={() => void copyText()}>
              Скопировать текст
            </Button>
            <Button size="sm" icon={<Download size={14} />} loading={exporting} onClick={() => void exportCsv()}>
              Скачать CSV
            </Button>
            {open && (
              <Button size="sm" icon={<Mail size={14} />} loading={act.isPending} onClick={() => run({ path: `/orders/${order.id}/resend` }, 'Письмо обработано, статус виден выше')}>
                Отправить письмо ещё раз
              </Button>
            )}
            {open && closing === null && (
              <Button size="sm" onClick={() => setClosing('')}>
                Закрыть заказ
              </Button>
            )}
            {(draft || order.status === 'sent') && (
              <Button size="sm" variant="danger" onClick={() => void cancel()}>
                Отменить заказ
              </Button>
            )}
            <Button size="sm" onClick={() => setShowText((v) => !v)}>
              {showText ? 'Скрыть текст' : 'Показать текст'}
            </Button>
          </div>

          {open && closing !== null && (
            <div className={styles.close}>
              <Field label="Почему закрываем (необязательно)">{(p) => <Input {...p} value={closing} maxLength={300} placeholder="Поставщик довёз меньше" onChange={(e) => setClosing(e.target.value)} />}</Field>
              <Button variant="primary" loading={act.isPending} onClick={() => run({ path: `/orders/${order.id}/close`, body: closing.trim() ? { comment: closing.trim() } : {} }, 'Заказ закрыт', onClose)}>
                Закрыть заказ
              </Button>
              <Button onClick={() => setClosing(null)}>Не закрывать</Button>
            </div>
          )}

          {showText && <pre className={styles.text}>{order.text}</pre>}
        </>
      )}
    </Dialog>
  );
}

