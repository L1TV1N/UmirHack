import {
  createOfferBody,
  formatMoney,
  storefrontSettingsBody,
  type BatchDto,
  type Page,
  type StaffOfferDto,
  type StaffReservationDto,
  type StorefrontSettingsDto,
} from '@zapas/shared';
import { ExternalLink, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { post, put } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Checkbox, Field, Input, Select } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { useLiveUpdates } from '../../lib/useLiveUpdates';
import styles from './StorefrontPage.module.scss';

const UNITS: Record<string, string> = { kg: 'кг', g: 'г', l: 'л', ml: 'мл', pcs: 'шт' };
const unitName = (u: string): string => UNITS[u] ?? u;

export const STATUS_TEXT: Record<StaffReservationDto['status'], { label: string; tone: Tone }> = {
  reserved: { label: 'Ждёт гостя', tone: 'info' },
  picked_up: { label: 'Выдано', tone: 'ok' },
  cancelled: { label: 'Отменено', tone: 'neutral' },
  expired: { label: 'Время вышло', tone: 'amber' },
};

function Reservations({ locationId }: { locationId: string | undefined }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [code, setCode] = useState('');
  const list = useGet<StaffReservationDto[]>('/storefront/reservations', { locationId, ...(code.trim() ? { code: code.trim() } : {}) }, { refetchInterval: 20_000 });
  const pickup = useAction((id: string) => post(`/storefront/reservations/${id}/pickup`), ['/storefront', '/stock', '/documents', '/analytics', '/stop-list']);
  const cancel = useAction((v: { id: string; reason?: string }) => post(`/storefront/reservations/${v.id}/cancel`, v.reason ? { reason: v.reason } : {}), ['/storefront']);

  const giveOut = async (r: StaffReservationDto) => {
    const ok = await confirm({
      title: `Выдать бронь ${r.code}?`,
      message: `${r.productName}: ${r.quantity} ${unitName(r.unit)}, ${formatMoney(r.total)}. Товар спишется со склада как продажа. Возьмите оплату на кассе.`,
      confirmLabel: 'Выдать',
    });
    if (!ok) return;
    pickup.mutate(r.id, { onSuccess: () => toast.success(`Бронь ${r.code} выдана`), onError: (err) => toast.error(errorMessage(err)) });
  };
  const refuse = async (r: StaffReservationDto) => {
    const ok = await confirm({ title: `Отменить бронь ${r.code}?`, message: 'Товар вернётся на витрину.', confirmLabel: 'Отменить бронь', danger: true });
    if (!ok) return;
    cancel.mutate({ id: r.id }, { onSuccess: () => toast.success('Бронь отменена'), onError: (err) => toast.error(errorMessage(err)) });
  };

  return (
    <Panel
      title="Брони гостей"
      actions={<Input aria-label="Найти бронь по коду" placeholder="Код брони" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 150 }} />}
    >
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && list.data.length === 0 && <EmptyState title="Броней нет">Когда гость забронирует товар на витрине, бронь появится здесь.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul className={styles.list}>
          {list.data.map((r) => (
            <li key={r.id} className={r.status === 'reserved' ? styles.live : ''}>
              <span className={styles.code}>{r.code}</span>
              <div className={styles.body}>
                <strong>
                  {r.productName}: {r.quantity} {unitName(r.unit)}
                </strong>
                <span>
                  {formatMoney(r.total)} · {r.locationName} · {r.guestName ? `${r.guestName}, +${r.guestPhone}` : 'данные гостя стёрты'}
                </span>
                <small>
                  {r.status === 'reserved' ? `до ${fmtDateTime(r.expiresAt)}` : r.closedAt ? fmtDateTime(r.closedAt) : fmtDateTime(r.createdAt)}
                  {r.cancelReason ? ` · ${r.cancelReason}` : ''}
                </small>
              </div>
              <Chip tone={STATUS_TEXT[r.status].tone}>{STATUS_TEXT[r.status].label}</Chip>
              {r.status === 'reserved' && (
                <div className={styles.actions}>
                  <Button size="sm" variant="primary" onClick={() => void giveOut(r)} loading={pickup.isPending && pickup.variables === r.id}>
                    Выдать
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void refuse(r)}>
                    Отменить
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PublishDialog({ open, locationId, onClose }: { open: boolean; locationId: string | undefined; onClose: () => void }) {
  const toast = useToast();
  const batches = useGet<Page<BatchDto>>('/stock/batches', { locationId, status: 'active', limit: 200 }, { enabled: open && Boolean(locationId) });
  const [batchId, setBatchId] = useState('');
  const [qty, setQty] = useState('');
  const [max, setMax] = useState('3');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => post('/storefront/offers', body), ['/storefront']);
  const eligible = (batches.data?.items ?? []).filter((b) => b.promotion !== null && b.daysLeft >= 0);

  useEffect(() => {
    if (open) {
      setBatchId('');
      setQty('');
      setMax('3');
      setError(null);
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = createOfferBody.safeParse({ batchId, quantity: Number(qty.replace(',', '.')), perGuestMax: Number(max) });
    if (!parsed.success) return setError(batchId ? 'Укажите количество больше нуля и лимит на гостя от 1 до 50' : 'Выберите партию');
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Предложение на витрине');
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Выставить на витрину"
      subtitle="Только партии с действующей скидкой"
      width={500}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="offer-form" loading={save.isPending}>
            Выставить
          </Button>
        </>
      }
    >
      <form id="offer-form" onSubmit={submit} noValidate className={styles.form}>
        {error && <ErrorNote message={error} />}
        {batches.isSuccess && eligible.length === 0 && <p className={styles.muted}>Уценённых партий нет. Назначьте скидку в «Рекомендациях» или в «Остатках».</p>}
        <Field label="Партия">
          {(p) => (
            <Select {...p} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              <option value="">Выберите партию</option>
              {eligible.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.productName} · -{b.promotion?.percent}% · {b.remainingQty} {unitName(b.unit)} · до {b.expiresOn.split('-').reverse().join('.')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Сколько выставить" hint="Остальное останется для кассы">
          {(p) => <Input {...p} numeric value={qty} onChange={(e) => setQty(e.target.value)} />}
        </Field>
        <Field label="Не больше на одного гостя">{(p) => <Input {...p} numeric value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

function Offers({ locationId, canEdit }: { locationId: string | undefined; canEdit: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const list = useGet<StaffOfferDto[]>('/storefront/offers', { locationId }, { refetchInterval: 30_000 });
  const [publish, setPublish] = useState(false);
  const close = useAction((id: string) => post(`/storefront/offers/${id}/close`), ['/storefront']);

  const withdraw = async (o: StaffOfferDto) => {
    const ok = await confirm({ title: 'Снять с витрины?', message: `${o.productName} пропадёт с публичной страницы. Уже оформленные брони останутся в силе.`, confirmLabel: 'Снять', danger: true });
    if (ok) close.mutate(o.id, { onSuccess: () => toast.success('Снято с витрины'), onError: (err) => toast.error(errorMessage(err)) });
  };

  return (
    <Panel title="На витрине" actions={canEdit ? <Button size="sm" icon={<Plus size={14} />} onClick={() => setPublish(true)}>Выставить</Button> : undefined}>
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && list.data.length === 0 && <EmptyState title="Пока ничего не выставлено">Выставьте уценённую партию, и она появится на публичной странице.</EmptyState>}
      {list.data && list.data.length > 0 && (
        <ul className={styles.list}>
          {list.data.map((o) => (
            <li key={o.id}>
              <div className={styles.body}>
                <strong>{o.productName}</strong>
                <span>
                  {o.locationName} · -{o.percent}% = {formatMoney(o.price)} · до {o.expiresOn.split('-').reverse().join('.')}
                </span>
                <small>
                  Выставлено {o.offered} {unitName(o.unit)}, в брони {o.reserved}, выдано {o.sold}, свободно {o.available}
                </small>
              </div>
              <Chip tone={o.hiddenReason ? 'amber' : 'ok'}>{o.hiddenReason ?? 'Видно гостям'}</Chip>
              {canEdit && (
                <Button size="sm" variant="danger" onClick={() => void withdraw(o)}>
                  Снять
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <PublishDialog open={publish} locationId={locationId} onClose={() => setPublish(false)} />
    </Panel>
  );
}

function SettingsRow({ s }: { s: StorefrontSettingsDto }) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(s.enabled);
  const [slug, setSlug] = useState(s.slug ?? '');
  const [note, setNote] = useState(s.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => put<StorefrontSettingsDto>('/storefront/settings', body), ['/storefront']);

  useEffect(() => {
    setEnabled(s.enabled);
    setSlug(s.slug ?? '');
    setNote(s.note ?? '');
  }, [s]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const parsed = storefrontSettingsBody.safeParse({ locationId: s.locationId, enabled, ...(slug.trim() ? { slug } : {}), ...(note.trim() ? { note } : {}) });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Проверьте поля');
    save.mutate(parsed.data, { onSuccess: () => toast.success('Настройки витрины сохранены'), onError: (err) => setError(errorMessage(err)) });
  };

  return (
    <li>
      <form onSubmit={submit} className={styles.settings} noValidate>
        <strong>{s.locationName}</strong>
        <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} label="Показывать витрину гостям" />
        <Field label="Адрес страницы" hint="Латиницей. Пусто: создастся из названия" error={error ?? undefined}>
          {(p) => <Input {...p} value={slug} onChange={(e) => setSlug(e.target.value)} />}
        </Field>
        <Field label="Подсказка гостю" hint="Где забирать, до скольки работает касса">
          {(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <div className={styles.row}>
          <Button type="submit" size="sm" variant="primary" loading={save.isPending}>
            Сохранить
          </Button>
          {s.enabled && s.publicPath && (
            <a href={s.publicPath} target="_blank" rel="noreferrer" className={styles.open}>
              Открыть страницу <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
        </div>
      </form>
    </li>
  );
}

function Settings() {
  const list = useGet<StorefrontSettingsDto[]>('/storefront/settings');
  return (
    <Panel title="Настройки по точкам" subtitle="Витрина выключена, пока вы её не включите">
      {list.isLoading && <Loading />}
      {list.error && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && <ul className={styles.settingsList}>{list.data.map((s) => <SettingsRow key={s.locationId} s={s} />)}</ul>}
    </Panel>
  );
}

/** Витрина «Спаси продукты» для сотрудников: брони гостей, что выставлено, настройки точек. */
export default function StorefrontPage() {
  const scope = useScope();
  const { can } = useAuth();
  useLiveUpdates();
  useEffect(() => {
    document.title = 'Витрина - Запас';
  }, []);
  const manager = can('manager');
  return (
    <>
      <PageHeader
        title="Витрина «Спаси продукты»"
        subtitle="Уценённые продукты на публичной странице. Гость бронирует без оплаты и приходит за товаром, вы выдаёте его по коду."
        actions={
          <a href="/rescue" target="_blank" rel="noreferrer" className={styles.open}>
            Публичная страница <ExternalLink size={13} aria-hidden="true" />
          </a>
        }
      />
      <Reservations locationId={scope.locationId ?? undefined} />
      <Offers locationId={scope.locationId ?? undefined} canEdit={manager} />
      {manager && <Settings />}
    </>
  );
}
