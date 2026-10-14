import {
  formatMoney,
  GUEST_ORDER_STATUS_LABELS,
  INCIDENT_BLAME_LABELS,
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUS_LABELS,
  type GuestIncidentDto,
  type GuestOrderDetailDto,
  type GuestOrderDto,
} from '@zapas/shared';
import { AlertTriangle, Check, ChefHat, RefreshCw, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { post } from '../../api/client';
import { useAction, useGet, STOCK_PREFIXES } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Segmented } from '../../components/Tabs/Tabs';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { IncidentDialog, STATUS_TONE } from '../Waiter/WaiterOrdersPage';
import styles from './GuestOrders.module.scss';

type View = 'open' | 'all';
const INVALIDATE = ['/guest-orders', ...STOCK_PREFIXES];

/** Заявки гостей от официантов: принять в работу (продукты списываются), выдать, отменить, разобрать обращения. */
export function GuestOrdersPanel() {
  const scope = useScope();
  const toast = useToast();
  const [view, setView] = useState<View>('open');
  const list = useGet<GuestOrderDto[]>('/guest-orders', { locationId: scope.locationId, status: view }, { enabled: Boolean(scope.locationId), refetchInterval: 15_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = useAction((v: { id: string; status: string; comment?: string }) => post<GuestOrderDetailDto>(`/guest-orders/${v.id}/status`, { status: v.status, ...(v.comment ? { comment: v.comment } : {}) }), INVALIDATE);

  const move = (o: GuestOrderDto, next: 'in_progress' | 'served', done: string) => {
    setError(null);
    status.mutate({ id: o.id, status: next }, { onSuccess: () => toast.success(done), onError: (err) => setError(errorMessage(err)) });
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <Segmented<View>
          label="Какие заявки показывать"
          value={view}
          onChange={setView}
          items={[
            { value: 'open', label: 'Открытые' },
            { value: 'all', label: 'Все' },
          ]}
        />
        <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void list.refetch()}>
          Обновить
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {list.isLoading ? (
        <Loading label="Загружаем заявки" />
      ) : list.error ? (
        <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState title={view === 'open' ? 'Открытых заявок нет' : 'Заявок пока не было'}>Официанты оформляют заказы на своём экране, и они сразу появляются здесь.</EmptyState>
      ) : (
        <ul className={styles.list}>
          {(list.data ?? []).map((o) => (
            <li key={o.id} className={styles.card}>
              <div className={styles.head}>
                <button type="button" className={styles.title} onClick={() => setOpenId(o.id)}>
                  Стол {o.tableLabel} <span>{o.number}</span>
                </button>
                <Chip tone={STATUS_TONE[o.status]}>{GUEST_ORDER_STATUS_LABELS[o.status]}</Chip>
                {o.openIncidents > 0 && (
                  <Chip tone="warn">
                    <AlertTriangle size={12} aria-hidden="true" /> обращений: {o.openIncidents}
                  </Chip>
                )}
              </div>
              <p className={styles.lines}>{o.lines.map((l) => `${l.dishName} × ${l.quantity}${l.isRemake ? ' (бесплатная переделка)' : ''}`).join(', ')}</p>
              {o.comment && <p className={styles.comment}>Комментарий: {o.comment}</p>}
              <div className={styles.foot}>
                <span>
                  {o.waiterName}, {fmtDateTime(o.createdAt)}
                </span>
                <strong>{formatMoney(o.total)}</strong>
                <span className={styles.actions}>
                  {o.status === 'new' && (
                    <Button size="sm" variant="primary" icon={<ChefHat size={14} />} loading={status.isPending} onClick={() => move(o, 'in_progress', `Заказ ${o.number} в работе, продукты списаны`)}>
                      Взять в работу
                    </Button>
                  )}
                  {o.status === 'in_progress' && (
                    <Button size="sm" variant="primary" icon={<Check size={14} />} loading={status.isPending} onClick={() => move(o, 'served', `Заказ ${o.number} выдан`)}>
                      Выдан
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setOpenId(o.id)}>
                    Подробнее
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <OrderDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function OrderDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const q = useGet<GuestOrderDetailDto>(`/guest-orders/${id ?? 'none'}`, undefined, { enabled: id !== null });
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [reporting, setReporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<GuestIncidentDto | null>(null);
  const [note, setNote] = useState('');
  const [pickedLine, setPickedLine] = useState('');
  const order = q.data;
  const cancel = useAction((v: { id: string; comment: string }) => post(`/guest-orders/${v.id}/status`, { status: 'cancelled', comment: v.comment }), INVALIDATE);
  const resolve = useAction((v: { id: string; action: 'remake' | 'dismiss'; comment?: string | undefined; lineId?: string | undefined }) => post(`/guest-orders/incidents/${v.id}/resolve`, { action: v.action, ...(v.comment ? { comment: v.comment } : {}), ...(v.lineId ? { lineId: v.lineId } : {}) }), INVALIDATE);

  const submitCancel = (e: FormEvent) => {
    e.preventDefault();
    if (!order) return;
    if (!reason.trim()) return setError('Укажите причину');
    setError(null);
    cancel.mutate({ id: order.id, comment: reason.trim() }, { onSuccess: () => { toast.success('Заказ отменён'); setCancelling(false); setReason(''); void q.refetch(); }, onError: (err) => setError(errorMessage(err)) });
  };

  const doResolve = (action: 'remake' | 'dismiss') => {
    if (!resolving) return;
    setError(null);
    resolve.mutate(
      { id: resolving.id, action, comment: note.trim() || undefined, lineId: action === 'remake' && !resolving.lineId ? pickedLine || undefined : undefined },
      {
        onSuccess: () => {
          toast.success(action === 'remake' ? 'Блюдо списано как потеря, переделка добавлена в заказ' : 'Обращение отклонено');
          setResolving(null);
          setNote('');
          void q.refetch();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <>
      <Dialog open={id !== null} onClose={onClose} title={order ? `Заказ ${order.number}` : 'Заказ'} subtitle={order ? `Стол ${order.tableLabel}, ${order.locationName}, официант ${order.waiterName}` : undefined} width={680}>
        {q.isLoading || !order ? (
          <Loading />
        ) : (
          <div className={styles.detail}>
            <div className={styles.row}>
              <Chip tone={STATUS_TONE[order.status]}>{GUEST_ORDER_STATUS_LABELS[order.status]}</Chip>
              <strong>{formatMoney(order.total)}</strong>
            </div>
            <table className={styles.table}>
              <tbody>
                {order.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.dishName} × {l.quantity}
                      {l.note && <small>{l.note}</small>}
                    </td>
                    <td className={styles.right}>{l.isRemake ? 'бесплатно' : formatMoney(l.price * l.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {order.incidents.length > 0 && (
              <section aria-label="Обращения">
                <h3>Что пошло не так</h3>
                {order.incidents.map((i) => (
                  <div key={i.id} className={`${styles.incident} ${i.status === 'reported' ? styles.pending : ''}`}>
                    <div>
                      <b>{INCIDENT_KIND_LABELS[i.kind]}</b>
                      {i.dishName ? `, ${i.dishName}` : ''} - {INCIDENT_BLAME_LABELS[i.blame].toLowerCase()}
                      <p>{i.comment}</p>
                      <small>
                        {i.reportedBy}, {fmtDateTime(i.reportedAt)}. {INCIDENT_STATUS_LABELS[i.status]}
                        {i.lossCost !== null ? `, потеря ${formatMoney(i.lossCost)}` : ''}
                        {i.resolutionComment ? `: ${i.resolutionComment}` : ''}
                      </small>
                    </div>
                    {i.status === 'reported' && (
                      <Button size="sm" variant="primary" onClick={() => { setResolving(i); setPickedLine(order.lines.find((l) => !l.isRemake)?.id ?? ''); setError(null); }}>
                        Решить
                      </Button>
                    )}
                  </div>
                ))}
              </section>
            )}

            <section aria-label="История">
              <h3>История</h3>
              <ol className={styles.events}>
                {[...order.events].reverse().map((e) => (
                  <li key={e.id}>
                    <time>{fmtDateTime(e.at)}</time> <b>{e.actor}</b>: {e.text}
                  </li>
                ))}
              </ol>
            </section>

            {error && !resolving && !cancelling && <ErrorNote message={error} />}
            <div className={styles.actions}>
              {(order.status === 'in_progress' || order.status === 'served') && (
                <Button icon={<AlertTriangle size={15} />} onClick={() => setReporting(true)}>
                  Сообщить о проблеме
                </Button>
              )}
              {(order.status === 'new' || order.status === 'in_progress') && (
                <Button variant="danger" icon={<X size={15} />} onClick={() => { setCancelling(true); setError(null); }}>
                  Отменить заказ
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Отменить заказ"
        subtitle={order && order.status === 'in_progress' ? 'Продукты уже списаны и не вернутся на склад' : undefined}
        width={440}
        footer={
          <>
            <Button onClick={() => setCancelling(false)}>Не отменять</Button>
            <Button variant="dangerSolid" type="submit" form="gcancel-form" loading={cancel.isPending}>
              Отменить заказ
            </Button>
          </>
        }
      >
        <form id="gcancel-form" onSubmit={submitCancel} noValidate>
          <Field label="Причина" required>
            {(p) => <Input {...p} value={reason} maxLength={300} autoFocus onChange={(e) => setReason(e.target.value)} />}
          </Field>
          {error && <ErrorNote message={error} />}
        </form>
      </Dialog>

      <Dialog
        open={resolving !== null}
        onClose={() => setResolving(null)}
        title="Как поступить"
        subtitle={resolving ? `${INCIDENT_KIND_LABELS[resolving.kind]}: ${resolving.comment}` : undefined}
        width={520}
        footer={
          <>
            <Button onClick={() => setResolving(null)}>Отмена</Button>
            <Button onClick={() => doResolve('dismiss')} loading={resolve.isPending}>
              Отклонить
            </Button>
            <Button variant="primary" onClick={() => doResolve('remake')} loading={resolve.isPending}>
              Переделать бесплатно
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          «Переделать бесплатно» добавит блюдо в заказ без оплаты и спишет продукты на него как потерю ({resolving ? INCIDENT_BLAME_LABELS[resolving.blame].toLowerCase() : ''}). «Отклонить» ничего не спишет.
        </p>
        {resolving && !resolving.lineId && order && order.lines.filter((l) => !l.isRemake).length > 1 && (
          <Field label="Какое блюдо переделать">
            {(p) => (
              <Select {...p} value={pickedLine} onChange={(e) => setPickedLine(e.target.value)}>
                {order.lines
                  .filter((l) => !l.isRemake)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.dishName} × {l.quantity}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Комментарий к решению" hint="Не обязательно">
          {(p) => <Input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        {error && <ErrorNote message={error} />}
      </Dialog>

      {order && (
        <IncidentDialog
          open={reporting}
          order={order}
          onClose={() => setReporting(false)}
          onDone={() => {
            setReporting(false);
            toast.success('Обращение записано');
            void q.refetch();
          }}
        />
      )}
    </>
  );
}
