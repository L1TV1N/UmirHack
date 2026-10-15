import {
  formatMoney,
  GUEST_ORDER_STATUS_LABELS,
  INCIDENT_BLAME_LABELS,
  INCIDENT_BLAMES,
  INCIDENT_KIND_LABELS,
  INCIDENT_KINDS,
  INCIDENT_STATUS_LABELS,
  type GuestOrderDetailDto,
  type GuestOrderDto,
  type GuestOrderStatus,
  type IncidentBlame,
  type IncidentKind,
} from '@zapas/shared';
import { AlertTriangle, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import type { Tone } from '../../components/Chip/Chip';
import { Chip } from '../../components/Chip/Chip';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { flushOutbox, removeItem, retryItem, useOutbox } from '../../lib/outbox';
import { useWaiterGet } from '../../lib/useWaiterGet';
import { OfflineEmpty, OfflineNote } from './OfflineNote';
import styles from './Waiter.module.scss';

export const STATUS_TONE: Record<GuestOrderStatus, Tone> = { new: 'info', in_progress: 'amber', served: 'ok', cancelled: 'neutral' };

/** Мои заказы: что готовится, что выдано, и кнопка, если что-то пошло не так. */
export default function WaiterOrdersPage() {
  const scope = useScope();
  const toast = useToast();
  const { user } = useAuth();
  const locationId = scope.locationId;
  const queue = useOutbox(user?.id).filter((i) => i.path === '/guest-orders');
  const list = useWaiterGet<GuestOrderDto[]>('/guest-orders', { locationId, status: 'all', mine: '1' }, { enabled: Boolean(locationId), refetchInterval: 20_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useGet<GuestOrderDetailDto>(`/guest-orders/${openId}`, undefined, { enabled: Boolean(openId) });
  const [incident, setIncident] = useState(false);
  const [cancel, setCancel] = useState(false);

  if (list.unreachable && queue.length === 0) return <OfflineEmpty what="список заказов" />;
  if (list.isLoading || (list.data === undefined && !list.error && queue.length === 0)) return <Loading label="Загружаем заказы" />;
  if (list.error && queue.length === 0) return <ErrorNote error={list.error} onRetry={() => void list.refetch()} />;
  const orders = list.data ?? [];

  return (
    <>
      <OfflineNote savedAt={list.savedAt} />
      {queue.length > 0 && (
        <ul className={styles.queued} aria-label="Заказы, которые ещё не дошли до кухни">
          {queue.map((item) => (
            <li key={item.id} className={item.error ? styles.refused : ''}>
              <div>
                <strong>{item.label}</strong>
                <small>Принят в {fmtDateTime(new Date(item.createdAt).toISOString())}</small>
                <span>{item.error ? `Кухня не приняла: ${item.error}` : 'Ждёт связи, уйдёт на кухню сам'}</span>
              </div>
              {item.error ? (
                <div style={{ flexDirection: 'row', gap: 6 }}>
                  <Button size="sm" onClick={() => void retryItem(item.id).then(() => user && flushOutbox(user.id))}>
                    Повторить
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void removeItem(item.id)}>
                    Убрать
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {orders.length === 0 && queue.length > 0 ? null : orders.length === 0 ? (
        <EmptyState title="Заказов пока нет">Принятые заказы появятся здесь, и вы увидите, когда кухня возьмёт их в работу.</EmptyState>
      ) : (
        <ul className={styles.orders}>
          {orders.map((o) => (
            <li key={o.id}>
              <button type="button" className={styles.orderCard} onClick={() => setOpenId(o.id)}>
                <span className={styles.orderTop}>
                  <strong>
                    Стол {o.tableLabel} <span className={styles.num}>{o.number}</span>
                  </strong>
                  <Chip tone={STATUS_TONE[o.status]}>{GUEST_ORDER_STATUS_LABELS[o.status]}</Chip>
                </span>
                <span className={styles.orderLines}>{o.lines.map((l) => `${l.dishName} × ${l.quantity}${l.isRemake ? ' (переделка)' : ''}`).join(', ')}</span>
                <span className={styles.orderFoot}>
                  <span>{fmtDateTime(o.placedAt ?? o.createdAt)}</span>
                  {o.openIncidents > 0 && (
                    <span className={styles.warnTag}>
                      <AlertTriangle size={13} aria-hidden="true" /> ждёт решения менеджера
                    </span>
                  )}
                  <strong>{formatMoney(o.total)}</strong>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={openId !== null} onClose={() => setOpenId(null)} title={detail.data ? `Заказ ${detail.data.number}` : 'Заказ'} subtitle={detail.data ? `Стол ${detail.data.tableLabel}, ${GUEST_ORDER_STATUS_LABELS[detail.data.status]}` : undefined} width={560}>
        {detail.isLoading || !detail.data ? (
          <Loading />
        ) : (
          <div className={styles.detail}>
            <ul className={styles.detailLines}>
              {detail.data.lines.map((l) => (
                <li key={l.id}>
                  <span>
                    {l.dishName} × {l.quantity}
                    {l.note && <small>{l.note}</small>}
                  </span>
                  <span>{l.isRemake ? 'бесплатно' : formatMoney(l.price * l.quantity)}</span>
                </li>
              ))}
            </ul>
            {detail.data.incidents.map((i) => (
              <div key={i.id} className={styles.incident}>
                <b>{INCIDENT_KIND_LABELS[i.kind]}</b> ({INCIDENT_BLAME_LABELS[i.blame].toLowerCase()}): {i.comment}
                <small>
                  {INCIDENT_STATUS_LABELS[i.status]}
                  {i.resolutionComment ? `: ${i.resolutionComment}` : ''}
                </small>
              </div>
            ))}
            <ol className={styles.events}>
              {detail.data.events.map((e) => (
                <li key={e.id}>
                  <time>{fmtDateTime(e.at)}</time> {e.text}
                </li>
              ))}
            </ol>
            <div className={styles.detailActions}>
              {(detail.data.status === 'in_progress' || detail.data.status === 'served') && (
                <Button icon={<AlertTriangle size={16} />} onClick={() => setIncident(true)}>
                  Что-то пошло не так
                </Button>
              )}
              {detail.data.status === 'new' && (
                <Button variant="danger" icon={<X size={16} />} onClick={() => setCancel(true)}>
                  Отменить заказ
                </Button>
              )}
            </div>
          </div>
        )}
      </Dialog>

      {detail.data && (
        <>
          <IncidentDialog
            open={incident}
            order={detail.data}
            onClose={() => setIncident(false)}
            onDone={() => {
              setIncident(false);
              toast.success('Менеджер увидит обращение и решит, как быть');
              void detail.refetch();
              void list.refetch();
            }}
          />
          <CancelDialog
            open={cancel}
            orderId={detail.data.id}
            onClose={() => setCancel(false)}
            onDone={() => {
              setCancel(false);
              setOpenId(null);
              void list.refetch();
            }}
          />
        </>
      )}
    </>
  );
}

export function IncidentDialog({ open, order, onClose, onDone }: { open: boolean; order: GuestOrderDetailDto; onClose: () => void; onDone: () => void }) {
  const [lineId, setLineId] = useState('');
  const [kind, setKind] = useState<IncidentKind>('dropped');
  const [blame, setBlame] = useState<IncidentBlame>('venue');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => post(`/guest-orders/${order.id}/incidents`, body), ['/guest-orders']);
  const lines = order.lines.filter((l) => !l.isRemake);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!comment.trim()) return setError('Опишите, что случилось');
    save.mutate({ ...(lineId || lines.length === 1 ? { lineId: lineId || lines[0]?.id } : {}), kind, blame, comment: comment.trim() }, { onSuccess: () => { setComment(''); onDone(); }, onError: (err) => setError(errorMessage(err)) });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Что-то пошло не так"
      subtitle={`Заказ ${order.number}, стол ${order.tableLabel}`}
      width={500}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="incident-form" loading={save.isPending}>
            Передать менеджеру
          </Button>
        </>
      }
    >
      <form id="incident-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {lines.length > 1 && (
          <Field label="Какое блюдо">
            {(p) => (
              <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">Весь заказ</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.dishName} × {l.quantity}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Что случилось">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as IncidentKind)}>
              {INCIDENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {INCIDENT_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Чья вина" hint="Менеджер примет окончательное решение">
          {(p) => (
            <Select {...p} value={blame} onChange={(e) => setBlame(e.target.value as IncidentBlame)}>
              {INCIDENT_BLAMES.map((b) => (
                <option key={b} value={b}>
                  {INCIDENT_BLAME_LABELS[b]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Комментарий" required>
          {(p) => <Input {...p} value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} placeholder="Например, тарелка разбилась по дороге к столу" />}
        </Field>
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

function CancelDialog({ open, orderId, onClose, onDone }: { open: boolean; orderId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => post(`/guest-orders/${orderId}/status`, body), ['/guest-orders']);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setError('Укажите причину');
    save.mutate({ status: 'cancelled', comment: reason.trim() }, { onSuccess: () => { setReason(''); onDone(); }, onError: (err) => setError(errorMessage(err)) });
  };
  return (
    <Dialog open={open} onClose={onClose} title="Отменить заказ" width={440} footer={<><Button onClick={onClose}>Не отменять</Button><Button variant="dangerSolid" type="submit" form="cancel-form" loading={save.isPending}>Отменить заказ</Button></>}>
      <form id="cancel-form" onSubmit={submit} noValidate>
        <Field label="Причина" required>{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Например, гость передумал" />}</Field>
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}
