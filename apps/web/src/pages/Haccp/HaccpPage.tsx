import {
  formatQty,
  haccpActionBody,
  HACCP_DEFAULT_RANGE,
  HACCP_KIND_LABELS,
  HACCP_KINDS,
  type HaccpInspectionDto,
  type HaccpKind,
  type HaccpPendingBatchDto,
  type HaccpPointDto,
  type HaccpReadingDto,
  type Page,
} from '@zapas/shared';
import { Download, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { downloadFile, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime, parseDecimal } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';
import styles from './Haccp.module.scss';

type Tab = 'today' | 'journal' | 'receiving';
const TABS: Tab[] = ['today', 'journal', 'receiving'];
const KEYS = ['/haccp'];

function ActionDialog({ reading, onClose }: { reading: HaccpReadingDto | null; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: { action: string }) => post(`/haccp/readings/${reading?.id}/action`, body), KEYS);
  useEffect(() => {
    setText('');
    setError(null);
  }, [reading]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = haccpActionBody.safeParse({ action: text });
    if (!parsed.success) return setError('Опишите, что сделали с отклонением');
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success('Действие записано');
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open={reading !== null}
      onClose={onClose}
      title="Что сделали с отклонением"
      subtitle={reading ? `${reading.pointName}: ${reading.value} °C при норме от ${reading.minTemp} до ${reading.maxTemp} °C` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Позже</Button>
          <Button variant="primary" type="submit" form="haccp-action" loading={save.isPending}>
            Записать
          </Button>
        </>
      }
    >
      <form id="haccp-action" onSubmit={submit} noValidate>
        <Field label="Корректирующее действие" error={error ?? undefined} required hint="Например: продукты перенесены, вызван мастер, дверь закрыта">
          {(p) => <Input {...p} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} autoFocus />}
        </Field>
      </form>
    </Dialog>
  );
}

function PointDialog({ point, locationId, onClose }: { point: HaccpPointDto | 'new' | null; locationId: string; onClose: () => void }) {
  const toast = useToast();
  const existing = point && point !== 'new' ? point : null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<HaccpKind>('fridge');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [every, setEvery] = useState('4');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => (existing ? patch(`/haccp/points/${existing.id}`, body) : post('/haccp/points', body)), KEYS);

  useEffect(() => {
    if (point === null) return;
    const range = HACCP_DEFAULT_RANGE[existing?.kind ?? 'fridge'];
    setName(existing?.name ?? '');
    setKind(existing?.kind ?? 'fridge');
    setMin(String(existing?.minTemp ?? range.min));
    setMax(String(existing?.maxTemp ?? range.max));
    setEvery(String(existing?.everyHours ?? 4));
    setActive(existing?.isActive ?? true);
    setError(null);
  }, [point, existing]);

  const pickKind = (k: HaccpKind) => {
    setKind(k);
    if (!existing) {
      setMin(String(HACCP_DEFAULT_RANGE[k].min));
      setMax(String(HACCP_DEFAULT_RANGE[k].max));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const lo = parseDecimal(min);
    const hi = parseDecimal(max);
    const hours = Number(every);
    if (!name.trim()) return setError('Введите название');
    if (lo === null || hi === null) return setError('Границы температуры: числа, например 0 и 6');
    if (lo > hi) return setError('Верхняя граница не ниже нижней');
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return setError('Частота замеров: целое число часов от 1 до 168');
    const body = existing ? { name: name.trim(), minTemp: lo, maxTemp: hi, everyHours: hours, isActive: active } : { locationId, name: name.trim(), kind, minTemp: lo, maxTemp: hi, everyHours: hours };
    save.mutate(body, {
      onSuccess: () => {
        toast.success('Контрольная точка сохранена');
        onClose();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open={point !== null}
      onClose={onClose}
      title={existing ? 'Контрольная точка' : 'Новая контрольная точка'}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="haccp-point" loading={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="haccp-point" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Название" required>{(p) => <Input {...p} value={name} maxLength={80} placeholder="Холодильник у раздачи" onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        {!existing && (
          <Field label="Вид" required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => pickKind(e.target.value as HaccpKind)}>
                {HACCP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {HACCP_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <FieldRow cols={3}>
          <Field label="От, °C" required>{(p) => <Input {...p} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
          <Field label="До, °C" required>{(p) => <Input {...p} inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
          <Field label="Замер раз в, ч" required>{(p) => <Input {...p} inputMode="numeric" value={every} onChange={(e) => setEvery(e.target.value)} />}</Field>
        </FieldRow>
        {existing && <Checkbox label="Точка работает" checked={active} onChange={(e) => setActive(e.target.checked)} />}
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

function PointCard({ point, onDeviation, onEdit }: { point: HaccpPointDto; onDeviation: (r: HaccpReadingDto) => void; onEdit?: () => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const [value, setValue] = useState('');
  const save = useAction((body: object) => post<HaccpReadingDto>('/haccp/readings', body), KEYS);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = parseDecimal(value);
    if (v === null) return toast.error('Введите температуру числом, например 4,5');
    save.mutate(
      { pointId: point.id, value: v },
      {
        onSuccess: (r) => {
          setValue('');
          if (r.inRange) toast.success(`${point.name}: ${r.value} °C, в норме`);
          else {
            toast.error(`${point.name}: ${r.value} °C, вне нормы. Запишите, что сделали`);
            onDeviation(r);
          }
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const state = !point.isActive ? <Chip>Отключена</Chip> : point.overdue ? <Chip tone="danger">Замер просрочен</Chip> : point.last && !point.last.inRange ? <Chip tone="warn">Последний вне нормы</Chip> : <Chip tone="ok">В норме</Chip>;

  return (
    <li className={`${styles.card} ${point.overdue || point.openDeviations > 0 ? styles.alert : ''}`}>
      <div className={styles.head}>
        <strong>{point.name}</strong>
        {state}
      </div>
      <div className={styles.sub}>
        {point.locationName} · {HACCP_KIND_LABELS[point.kind]} · норма от {point.minTemp} до {point.maxTemp} °C · замер раз в {point.everyHours} ч
      </div>
      <div className={styles.last}>
        {point.last ? (
          <>
            <span className={styles.temp}>{point.last.value} °C</span>
            <span className={styles.sub}>{fmtDateTime(point.last.at)}</span>
          </>
        ) : (
          <span className={styles.sub}>Замеров ещё не было</span>
        )}
      </div>
      {point.openDeviations > 0 && <div className={styles.warn}>Отклонений без действия: {point.openDeviations}. Откройте журнал.</div>}
      <div className={styles.foot}>
        {can('storekeeper') && point.isActive && (
          <form className={styles.measure} onSubmit={submit} noValidate>
            <Input numeric aria-label={`Температура: ${point.name}`} placeholder="°C" value={value} onChange={(e) => setValue(e.target.value)} />
            <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
              Записать
            </Button>
          </form>
        )}
        {onEdit && (
          <Button size="sm" onClick={onEdit}>
            Изменить
          </Button>
        )}
      </div>
    </li>
  );
}

function Today({ locationId }: { locationId: string | undefined }) {
  const { can } = useAuth();
  const points = useGet<HaccpPointDto[]>('/haccp/points', { locationId }, { refetchInterval: 60_000 });
  const [editing, setEditing] = useState<HaccpPointDto | 'new' | null>(null);
  const [deviation, setDeviation] = useState<HaccpReadingDto | null>(null);
  const locations = useScope();
  const target = locationId ?? locations.activeLocations[0]?.id ?? '';

  return (
    <>
      <Panel
        title="Контрольные точки"
        subtitle="Холодильники, морозильники и горячая линия. Каждой точке задана норма температуры и как часто нужен замер"
        actions={
          can('manager') && (
            <Button size="sm" icon={<Plus size={15} />} onClick={() => setEditing('new')} disabled={!target}>
              Добавить точку
            </Button>
          )
        }
      >
        {points.isLoading && <Loading />}
        {points.isError && (
          <div style={{ padding: 16 }}>
            <ErrorNote error={points.error} onRetry={() => void points.refetch()} />
          </div>
        )}
        {points.data && points.data.length === 0 && <EmptyState title="Контрольных точек пока нет">{can('manager') ? 'Добавьте холодильники и морозильники, температуру которых нужно записывать.' : 'Менеджер добавит контрольные точки.'}</EmptyState>}
        {points.data && points.data.length > 0 && (
          <ul className={styles.grid}>
            {points.data.map((p) => (
              <PointCard key={p.id} point={p} onDeviation={setDeviation} {...(can('manager') ? { onEdit: () => setEditing(p) } : {})} />
            ))}
          </ul>
        )}
      </Panel>
      <PointDialog point={editing} locationId={target} onClose={() => setEditing(null)} />
      <ActionDialog reading={deviation} onClose={() => setDeviation(null)} />
    </>
  );
}

function Journal({ locationId }: { locationId: string | undefined }) {
  const { can } = useAuth();
  const toast = useToast();
  const [onlyBad, setOnlyBad] = useState(false);
  const [open, setOpen] = useState<HaccpReadingDto | null>(null);
  const page = useGet<Page<HaccpReadingDto>>('/haccp/readings', { locationId, deviations: onlyBad ? 'true' : undefined, limit: 50 }, { refetchInterval: 60_000 });

  const columns: Column<HaccpReadingDto>[] = [
    { key: 'when', header: 'Когда', cell: (r) => <span className="num">{fmtDateTime(r.measuredAt)}</span> },
    { key: 'point', header: 'Точка', cell: (r) => <><strong>{r.pointName}</strong><span className={styles.sub}> {r.locationName}</span></> },
    { key: 'value', header: 'Температура', align: 'right', cell: (r) => <span className="num">{r.value} °C</span> },
    { key: 'norm', header: 'Норма', align: 'right', cell: (r) => <span className="num muted">{r.minTemp} … {r.maxTemp}</span> },
    { key: 'state', header: '', cell: (r) => (r.inRange ? <Chip tone="ok">В норме</Chip> : r.action ? <Chip tone="amber">Отклонение, действие записано</Chip> : <Chip tone="danger">Отклонение</Chip>) },
    { key: 'who', header: 'Кто', cell: (r) => r.authorName },
    {
      key: 'action',
      header: 'Что сделали',
      cell: (r) =>
        r.action ? (
          <span>
            {r.action.text}
            <span className={styles.sub}> {r.action.authorName}</span>
          </span>
        ) : !r.inRange && can('storekeeper') ? (
          <Button size="sm" onClick={() => setOpen(r)}>
            Записать
          </Button>
        ) : (
          ''
        ),
    },
  ];

  return (
    <>
      <Panel>
        <Toolbar>
          <Checkbox label="Только отклонения" checked={onlyBad} onChange={(e) => setOnlyBad(e.target.checked)} />
          {can('manager') && (
            <Button size="sm" icon={<Download size={15} />} onClick={() => void downloadFile('/reports/haccp.csv', { locationId }, 'haccp.csv').catch((err) => toast.error(errorMessage(err)))}>
              Выгрузить для проверки
            </Button>
          )}
        </Toolbar>
        {page.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={page.error} onRetry={() => void page.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={page.isLoading ? undefined : page.data?.items} rowKey={(r) => String(r.id)} loading={page.isLoading} caption="Журнал температур" empty="Замеров пока нет" />
        )}
      </Panel>
      <ActionDialog reading={open} onClose={() => setOpen(null)} />
    </>
  );
}

function InspectDialog({ batch, onClose }: { batch: HaccpPendingBatchDto | null; onClose: () => void }) {
  const toast = useToast();
  const [temp, setTemp] = useState('');
  const [appearance, setAppearance] = useState(true);
  const [packaging, setPackaging] = useState(true);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => post('/haccp/inspections', body), KEYS);
  useEffect(() => {
    setTemp('');
    setAppearance(true);
    setPackaging(true);
    setComment('');
    setError(null);
  }, [batch]);

  const submit = (decision: 'accepted' | 'rejected') => {
    if (!batch) return;
    const t = temp.trim() === '' ? null : parseDecimal(temp);
    if (temp.trim() !== '' && t === null) return setError('Температура числом, например 4,2');
    save.mutate(
      { batchId: batch.batchId, temperature: t, appearanceOk: appearance, packagingOk: packaging, decision, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      {
        onSuccess: () => {
          toast.success(decision === 'accepted' ? 'Партия принята' : 'Партия не принята, оформите возврат или списание');
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open={batch !== null}
      onClose={onClose}
      title="Бракераж при приёмке"
      subtitle={batch ? `${batch.productName}, ${formatQty(batch.quantity, batch.unit)} · ${batch.locationName}` : undefined}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="dangerSolid" loading={save.isPending} onClick={() => submit('rejected')}>
            Не принимать
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => submit('accepted')}>
            Принять
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Температура продукта, °C" hint="Если измеряли">{(p) => <Input {...p} inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} />}</Field>
        <Checkbox label="Внешний вид, запах и цвет в норме" checked={appearance} onChange={(e) => setAppearance(e.target.checked)} />
        <Checkbox label="Упаковка цела, маркировка читается" checked={packaging} onChange={(e) => setPackaging(e.target.checked)} />
        <Field label="Комментарий">{(p) => <Input {...p} value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} />}</Field>
        {error && <ErrorNote message={error} />}
      </div>
    </Dialog>
  );
}

function Receiving({ locationId }: { locationId: string | undefined }) {
  const { can } = useAuth();
  const pending = useGet<HaccpPendingBatchDto[]>('/haccp/inspections/pending', { locationId }, { enabled: can('storekeeper'), refetchInterval: 60_000 });
  const done = useGet<Page<HaccpInspectionDto>>('/haccp/inspections', { locationId, limit: 20 });
  const [batch, setBatch] = useState<HaccpPendingBatchDto | null>(null);

  const pendingColumns: Column<HaccpPendingBatchDto>[] = [
    { key: 'p', header: 'Продукт', cell: (b) => <strong>{b.productName}</strong> },
    { key: 'q', header: 'Количество', align: 'right', cell: (b) => <span className="num">{formatQty(b.quantity, b.unit)}</span> },
    { key: 'l', header: 'Точка', cell: (b) => b.locationName },
    { key: 's', header: 'Поставщик', cell: (b) => <span className="muted">{b.supplierName ?? ''}{b.documentNo ? `, ${b.documentNo}` : ''}</span> },
    { key: 'd', header: 'Принято', cell: (b) => b.receivedOn },
    { key: 'a', header: '', align: 'right', cell: (b) => <Button size="sm" variant="primary" onClick={() => setBatch(b)}>Осмотреть</Button> },
  ];
  const doneColumns: Column<HaccpInspectionDto>[] = [
    { key: 'w', header: 'Когда', cell: (i) => <span className="num">{fmtDateTime(i.createdAt)}</span> },
    { key: 'p', header: 'Продукт', cell: (i) => <><strong>{i.productName}</strong><span className={styles.sub}> {i.locationName}</span></> },
    { key: 't', header: 'Температура', align: 'right', cell: (i) => (i.temperature === null ? '-' : `${i.temperature} °C`) },
    { key: 'ok', header: 'Осмотр', cell: (i) => (i.appearanceOk && i.packagingOk ? 'без замечаний' : [!i.appearanceOk && 'внешний вид', !i.packagingOk && 'упаковка'].filter(Boolean).join(', ')) },
    { key: 'd', header: 'Решение', cell: (i) => <Chip tone={i.decision === 'accepted' ? 'ok' : 'danger'}>{i.decision === 'accepted' ? 'Принято' : 'Не принято'}</Chip> },
    { key: 'c', header: 'Комментарий', cell: (i) => <span className="muted">{i.comment ?? ''}</span> },
    { key: 'u', header: 'Кто', cell: (i) => i.authorName },
  ];

  return (
    <>
      {can('storekeeper') && (
        <Panel title="Ждут осмотра" subtitle="Скоропортящееся и продукция с ветеринарным документом, принятая за последние три дня">
          {pending.isError ? (
            <div style={{ padding: 16 }}>
              <ErrorNote error={pending.error} onRetry={() => void pending.refetch()} />
            </div>
          ) : (
            <DataTable columns={pendingColumns} rows={pending.isLoading ? undefined : pending.data} rowKey={(b) => b.batchId} loading={pending.isLoading} caption="Партии на осмотр" empty="Все партии осмотрены" />
          )}
        </Panel>
      )}
      <div style={{ height: 16 }} />
      <Panel title="Журнал бракеража" subtitle="Последние осмотры">
        <DataTable columns={doneColumns} rows={done.isLoading ? undefined : done.data?.items} rowKey={(i) => String(i.id)} loading={done.isLoading} caption="Журнал бракеража" empty="Осмотров пока не было" />
      </Panel>
      <InspectDialog batch={batch} onClose={() => setBatch(null)} />
    </>
  );
}

export default function HaccpPage() {
  const scope = useScope();
  const [url, setUrl] = useUrlState({ tab: 'today' });
  const tab: Tab = TABS.includes(url.tab as Tab) ? (url.tab as Tab) : 'today';

  useEffect(() => {
    document.title = 'Журнал HACCP - Запас';
  }, []);

  return (
    <>
      <PageHeader title="Журнал HACCP" subtitle="Температурный режим холодильников и линий раздачи, отклонения с корректирующими действиями и бракераж продукции при приёмке. Записи журнала не переписываются." />
      <Tabs<Tab>
        label="Разделы журнала"
        value={tab}
        onChange={(v) => setUrl({ tab: v })}
        items={[
          { value: 'today', label: 'Замеры' },
          { value: 'journal', label: 'Журнал температур' },
          { value: 'receiving', label: 'Бракераж' },
        ]}
      />
      {tab === 'today' && <Today locationId={scope.locationId} />}
      {tab === 'journal' && <Journal locationId={scope.locationId} />}
      {tab === 'receiving' && <Receiving locationId={scope.locationId} />}
    </>
  );
}
