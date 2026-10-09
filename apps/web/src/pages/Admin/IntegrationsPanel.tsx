import {
  fmtDelivery,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_LABELS,
  type LocationDto,
  type WebhookCreatedDto,
  type WebhookDeliveryDto,
  type WebhookDto,
  type WebhookEvent,
} from '@zapas/shared';
import { Copy, History, KeyRound, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, del, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import styles from './IntegrationsPanel.module.scss';

const PAYLOAD_EXAMPLE = `POST <ваш адрес>
Content-Type: application/json
X-Zapas-Event: stoplist.changed
X-Zapas-Delivery: <идентификатор доставки, повтор приходит с тем же>
X-Zapas-Timestamp: 1791540000
X-Zapas-Signature: sha256=<HMAC-SHA256 от «время.тело» с вашим секретом>

{
  "event": "stoplist.changed",
  "locationId": "…", "locationName": "Магазин «Центр»",
  "createdAt": "2026-10-09T09:00:00.000Z",
  "added":   [{ "type": "product", "code": "MLK-001", "barcode": "4607…", "name": "Молоко", "reason": "Нет в наличии", … }],
  "removed": [],
  "entries": [ …всё, что в стопе на точке сейчас… ],
  "truncated": false
}`;

const VERIFY_EXAMPLE = `// Node.js: проверка подписи
const crypto = require('node:crypto');
function valid(secret, headers, rawBody) {
  const ts = headers['x-zapas-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
  const given = String(headers['x-zapas-signature']).replace('sha256=', '');
  return given.length === mac.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(mac));
}`;

const FEED_EXAMPLE = `GET /api/pos/stop-list        X-Api-Key: <ключ кассы>   →  { generatedAt, locationId, entries: [...] }
GET /api/pos/products?limit=200&offset=0         →  { items: [{ sku, barcode, name, unit, price, … }], total }`;

const STATUS_TEXT: Record<WebhookDeliveryDto['status'], string> = { pending: 'ждёт отправки', delivered: 'доставлено', failed: 'не удалось' };
const STATUS_TONE: Record<WebhookDeliveryDto['status'], 'amber' | 'ok' | 'danger'> = { pending: 'amber', delivered: 'ok', failed: 'danger' };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface FormState {
  name: string;
  url: string;
  events: WebhookEvent[];
  locationId: string;
  enabled: boolean;
}

function EndpointDialog({ open, endpoint, locations, onClose, onCreated }: { open: boolean; endpoint: WebhookDto | null; locations: LocationDto[]; onClose: () => void; onCreated: (created: WebhookCreatedDto) => void }) {
  const toast = useToast();
  const editing = endpoint !== null;
  const [s, setS] = useState<FormState>({ name: '', url: '', events: [...WEBHOOK_EVENTS], locationId: '', enabled: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction(
    (body: object) => (editing ? patch<WebhookDto>(`/integrations/webhooks/${endpoint.id}`, body) : post<WebhookCreatedDto>('/integrations/webhooks', body)),
    ['/integrations'],
  );

  useEffect(() => {
    if (!open) return;
    setS(endpoint ? { name: endpoint.name, url: endpoint.url, events: endpoint.events, locationId: endpoint.locationId ?? '', enabled: endpoint.enabled } : { name: '', url: '', events: [...WEBHOOK_EVENTS], locationId: '', enabled: true });
    setErrors({});
    setFormError(null);
  }, [open, endpoint]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found: Record<string, string> = {};
    if (!s.name.trim()) found.name = 'Назовите адрес, например «Доставка»';
    if (!s.url.trim()) found.url = 'Укажите адрес приёмника';
    if (s.events.length === 0) found.events = 'Выберите хотя бы одно событие';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = { name: s.name.trim(), url: s.url.trim(), events: s.events, locationId: s.locationId || null, ...(editing ? { enabled: s.enabled } : {}) };
    save.mutate(body, {
      onSuccess: (r) => {
        if (editing) toast.success('Сохранено');
        else onCreated(r as WebhookCreatedDto);
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && Object.keys(err.fieldErrors()).length) setErrors(err.fieldErrors());
        else setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Адрес для событий' : 'Новый адрес для событий'}
      subtitle="Сюда «Запас» отправляет изменения стоп-листа: доставке, кассе, вашему сервису"
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="webhook-form" loading={save.isPending}>
            {editing ? 'Сохранить' : 'Создать'}
          </Button>
        </>
      }
    >
      <form id="webhook-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Название" error={errors.name} required>
          {(p) => <Input {...p} value={s.name} maxLength={80} onChange={(e) => setS({ ...s, name: e.target.value })} autoFocus />}
        </Field>
        <Field label="Адрес приёмника" error={errors.url} hint="Только https. Адреса внутренней сети разрешает администратор сервера" required>
          {(p) => <Input {...p} type="url" inputMode="url" value={s.url} maxLength={500} placeholder="https://example.ru/zapas-hook" onChange={(e) => setS({ ...s, url: e.target.value })} />}
        </Field>
        <Field label="Точка" hint="Какие точки слушает приёмник">
          {(p) => (
            <Select {...p} value={s.locationId} onChange={(e) => setS({ ...s, locationId: e.target.value })}>
              <option value="">Все точки</option>
              {locations.filter((l) => l.isActive).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>События</legend>
          <div className={styles.events}>
            {WEBHOOK_EVENTS.map((ev) => (
              <Checkbox
                key={ev}
                label={WEBHOOK_EVENT_LABELS[ev]}
                checked={s.events.includes(ev)}
                onChange={(e) => setS({ ...s, events: e.target.checked ? [...s.events, ev] : s.events.filter((x) => x !== ev) })}
              />
            ))}
          </div>
          {errors.events && <span role="alert" style={{ color: 'var(--danger-700)', fontSize: 12.5 }}>{errors.events}</span>}
        </fieldset>
        {editing && <Checkbox label="Отправка включена" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />}
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}

function DeliveriesDialog({ endpoint, onClose }: { endpoint: WebhookDto | null; onClose: () => void }) {
  const list = useGet<WebhookDeliveryDto[]>(`/integrations/webhooks/${endpoint?.id ?? 'none'}/deliveries`, { limit: 50 }, { enabled: endpoint !== null, refetchInterval: 10_000 });
  const columns: Column<WebhookDeliveryDto>[] = [
    { key: 'when', header: 'Когда', cell: (d) => <span className="num">{fmtDateTime(d.createdAt)}</span> },
    { key: 'event', header: 'Событие', cell: (d) => (d.event === 'ping' ? 'проверка связи' : (WEBHOOK_EVENT_LABELS[d.event as WebhookEvent] ?? d.event)) },
    { key: 'status', header: 'Статус', cell: (d) => <Chip tone={STATUS_TONE[d.status]}>{STATUS_TEXT[d.status]}</Chip> },
    { key: 'tries', header: 'Попыток', align: 'right', cell: (d) => <span className="num">{d.attempts}</span> },
    { key: 'result', header: 'Ответ', cell: (d) => fmtDelivery(d) },
  ];
  return (
    <Dialog open={endpoint !== null} onClose={onClose} title={`Журнал отправки: ${endpoint?.name ?? ''}`} subtitle="Последние 50 событий. Неудачные повторяются через 30 секунд, 2 минуты, 10 минут, час и 6 часов" width={760} footer={<Button onClick={onClose}>Закрыть</Button>}>
      {list.isError ? <ErrorNote error={list.error} onRetry={() => void list.refetch()} /> : <DataTable columns={columns} rows={list.data} rowKey={(d) => d.id} loading={list.isLoading} empty="Событий пока не было" caption="Журнал отправки" dense />}
    </Dialog>
  );
}

export function IntegrationsPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const hooks = useGet<WebhookDto[]>('/integrations/webhooks');
  const locations = useGet<LocationDto[]>('/locations');
  const [editing, setEditing] = useState<WebhookDto | 'new' | null>(null);
  const [journal, setJournal] = useState<WebhookDto | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const remove = useAction((id: string) => del(`/integrations/webhooks/${id}`), ['/integrations']);
  const rotate = useAction((id: string) => post<{ secret: string }>(`/integrations/webhooks/${id}/rotate-secret`), ['/integrations']);
  const test = useAction((id: string) => post<WebhookDeliveryDto>(`/integrations/webhooks/${id}/test`), ['/integrations']);
  const sync = useAction((id: string) => post<{ queued: number }>(`/integrations/webhooks/${id}/sync`), ['/integrations']);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Скопировано');
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  const onTest = (h: WebhookDto) => {
    setBusy(`test:${h.id}`);
    test.mutate(h.id, {
      onSuccess: (d) => (d.status === 'delivered' ? toast.success(`Приёмник ответил: код ${d.lastStatus}`) : toast.error(`Не дошло: ${fmtDelivery(d)}`)),
      onError: (err) => toast.error(errorMessage(err)),
      onSettled: () => setBusy(null),
    });
  };

  const onSync = (h: WebhookDto) => {
    setBusy(`sync:${h.id}`);
    sync.mutate(h.id, {
      onSuccess: (r) => toast.success(`Поставлено в очередь событий: ${r.queued}. Они уйдут в течение нескольких секунд`),
      onError: (err) => toast.error(errorMessage(err)),
      onSettled: () => setBusy(null),
    });
  };

  const onRotate = async (h: WebhookDto) => {
    const ok = await confirm({ title: 'Сменить секрет?', message: `Подпись событий для «${h.name}» начнёт считаться по новому секрету. Приёмник нужно будет обновить.`, confirmLabel: 'Сменить' });
    if (!ok) return;
    rotate.mutate(h.id, { onSuccess: (r) => setSecret({ name: h.name, value: r.secret }), onError: (err) => toast.error(errorMessage(err)) });
  };

  const onDelete = async (h: WebhookDto) => {
    const ok = await confirm({ title: 'Удалить адрес?', message: `События перестанут уходить на «${h.name}», журнал отправки удалится.`, confirmLabel: 'Удалить', danger: true });
    if (!ok) return;
    remove.mutate(h.id, { onSuccess: () => toast.success('Адрес удалён'), onError: (err) => toast.error(errorMessage(err)) });
  };

  const columns: Column<WebhookDto>[] = [
    {
      key: 'name',
      header: 'Адрес',
      cell: (h) => (
        <>
          <strong>{h.name}</strong>
          <span className={styles.sub}>{hostOf(h.url)}</span>
        </>
      ),
    },
    { key: 'events', header: 'События', cell: (h) => h.events.map((e) => WEBHOOK_EVENT_LABELS[e]).join(', ') },
    { key: 'loc', header: 'Точка', cell: (h) => h.locationName ?? 'Все' },
    {
      key: 'state',
      header: 'Состояние',
      cell: (h) => (
        <>
          <Chip tone={h.enabled ? 'ok' : 'danger'}>{h.enabled ? 'Работает' : 'Выключен'}</Chip>
          {!h.enabled && h.disabledReason && <span className={styles.sub}>{h.disabledReason}</span>}
          {h.enabled && h.failureStreak > 0 && <span className={styles.sub}>неудач подряд: {h.failureStreak}</span>}
          <span className={styles.sub}>{h.lastSuccessAt ? `доставлено ${fmtDateTime(h.lastSuccessAt)}` : 'ещё не доставлялось'}</span>
        </>
      ),
    },
    {
      key: 'act',
      header: '',
      align: 'right',
      cell: (h) => (
        <div className={styles.actions}>
          <Button size="sm" icon={<Send size={14} />} loading={busy === `test:${h.id}`} onClick={() => onTest(h)}>
            Проверить
          </Button>
          <Button size="sm" icon={<RefreshCw size={14} />} loading={busy === `sync:${h.id}`} onClick={() => onSync(h)} title="Отправить полное текущее состояние стоп-листа, например при первом подключении">
            Отправить состояние
          </Button>
          <Button size="sm" icon={<History size={14} />} onClick={() => setJournal(h)}>
            Журнал
          </Button>
          <Button size="sm" onClick={() => setEditing(h)}>
            Изменить
          </Button>
          <Button size="sm" icon={<KeyRound size={14} />} onClick={() => void onRotate(h)} aria-label={`Сменить секрет: ${h.name}`}>
            Секрет
          </Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={14} />} onClick={() => void onDelete(h)} aria-label={`Удалить: ${h.name}`} />
        </div>
      ),
    },
  ];

  return (
    <>
      <Panel
        title="Отправка событий"
        subtitle="Стоп-лист уходит в доставку, кассу или ваш сервис сразу после изменения, с подписью и повторами при сбоях"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>
            Добавить адрес
          </Button>
        }
      >
        {hooks.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={hooks.error} onRetry={() => void hooks.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={hooks.data} rowKey={(h) => h.id} loading={hooks.isLoading} empty="Адресов пока нет" caption="Адреса для событий" />
        )}
      </Panel>

      <div className={styles.gap} />
      <Panel title="Что получает приёмник" padded>
        <pre className={styles.code}>{PAYLOAD_EXAMPLE}</pre>
        <p className={styles.note}>
          В каждом событии есть полное состояние точки (<code>entries</code>), поэтому приёмнику достаточно заменить своё: потерянное или пришедшее позже событие ничего не ломает, свежесть видна по <code>createdAt</code>. Артикул продукта и код блюда в <code>code</code> совпадают с теми, что заведены в «Запасе». Код блюда задаётся в карточке блюда.
        </p>
        <pre className={styles.code} style={{ marginTop: 12 }}>{VERIFY_EXAMPLE}</pre>
      </Panel>

      <div className={styles.gap} />
      <Panel title="Если приёмнику проще забирать самому" padded>
        <pre className={styles.code}>{FEED_EXAMPLE}</pre>
        <p className={styles.note}>Ключ кассы выпускается на вкладке «Ключи кассы», он привязан к одной точке: лента показывает стоп-лист только этой точки.</p>
      </Panel>

      <EndpointDialog
        open={editing !== null}
        endpoint={editing && editing !== 'new' ? editing : null}
        locations={locations.data ?? []}
        onClose={() => setEditing(null)}
        onCreated={(c) => setSecret({ name: c.name, value: c.secret })}
      />
      <DeliveriesDialog endpoint={journal} onClose={() => setJournal(null)} />
      <Dialog open={secret !== null} onClose={() => setSecret(null)} title="Секрет для проверки подписи" subtitle={`«${secret?.name ?? ''}». Сохраните его сейчас: повторно показать не получится`} width={580} footer={<Button variant="primary" onClick={() => setSecret(null)}>Я сохранил секрет</Button>}>
        <div className={styles.secret}>
          <input readOnly value={secret?.value ?? ''} aria-label="Секрет" onFocus={(e) => e.currentTarget.select()} />
          <Button icon={<Copy size={15} />} onClick={() => secret && void copy(secret.value)}>
            Копировать
          </Button>
        </div>
        <p className={styles.note}>Подпись каждого события это HMAC-SHA256 от строки «время.тело» с этим секретом, пример проверки есть под таблицей адресов.</p>
      </Dialog>
    </>
  );
}
