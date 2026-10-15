import { daysWord, formatQty, type DishDto, type ProductDto, type StopForecastCoveredDto, type StopForecastDto, type StopListDto, type StopListEntryDto } from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { del, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { ProductPicker } from '../../components/ProductPicker/ProductPicker';
import { Segmented } from '../../components/Tabs/Tabs';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { describeIncoming } from '../../lib/incoming';
import styles from './StopListPage.module.scss';

type Source = 'all' | 'auto' | 'manual';

const FORECAST_SHOWN = 8;

/** «Через 5 ч» или «через 2 дня»: на таком масштабе минуты не нужны. */
function formatEta(hours: number): string {
  if (hours < 1) return 'меньше чем через час';
  if (hours < 24) return `через ${hours} ч`;
  return `через ${daysWord(Math.round(hours / 24))}`;
}

function etaTone(hours: number): Tone {
  if (hours < 24) return 'warn';
  if (hours < 72) return 'amber';
  return 'neutral';
}

export function ForecastPanel({ items }: { items: StopForecastDto[] }) {
  const shown = items.slice(0, FORECAST_SHOWN);
  return (
    <Panel
      title="Прогноз стоп-листа"
      subtitle="Когда блюда перестанут готовиться при текущих продажах, с учётом поставок, которые уже едут"
    >
      <ul className={styles.forecast}>
        {shown.map((f) => (
          <li key={`${f.dishId}|${f.locationId}`}>
            <div>
              <strong>{f.dishName}</strong>
              <span className={styles.sub}>
                {f.locationName} · сейчас на {f.portionsNow} порц. ·{' '}
                {f.cause === 'expiry'
                  ? `закончится срок годности: ${f.limiting.productName}`
                  : `ограничивает ${f.limiting.productName}: осталось ${formatQty(f.limiting.availableNow, f.limiting.unit)}${f.limiting.perDay ? `, уходит около ${formatQty(Math.round(f.limiting.perDay * 10) / 10, f.limiting.unit)} в сутки` : ''}`}
              </span>
              {f.incoming && (
                <span className={f.incoming.afterStop ? styles.lateDelivery : styles.delivery}>
                  {f.incoming.afterStop ? 'Поставка не успевает: ' : 'Едет поставка: '}
                  {describeIncoming(f.incoming)}
                </span>
              )}
            </div>
            <span className={styles.eta} title={fmtDateTime(f.expectedAt)}>
              <Chip tone={etaTone(f.hoursLeft)}>{formatEta(f.hoursLeft)}</Chip>
            </span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className={styles.more}>и ещё {items.length - shown.length}</p>}
    </Panel>
  );
}

/** Блюда, которым стоп не грозит только потому, что поставка уже едет. */
export function CoveredPanel({ items }: { items: StopForecastCoveredDto[] }) {
  const shown = items.slice(0, FORECAST_SHOWN);
  return (
    <Panel title="Выручит поставка" subtitle="Без неё эти блюда скоро остановились бы, а с ней стоп не грозит">
      <ul className={styles.forecast}>
        {shown.map((c) => (
          <li key={`${c.dishId}|${c.locationId}`}>
            <div>
              <strong>{c.dishName}</strong>
              <span className={styles.sub}>{c.locationName}</span>
              <span className={styles.delivery}>{describeIncoming(c.incoming)}</span>
            </div>
            <span className={styles.eta}>
              <Chip tone="ok">без неё {formatEta(c.hoursWithoutDelivery)}</Chip>
            </span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && <p className={styles.more}>и ещё {items.length - shown.length}</p>}
    </Panel>
  );
}

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const scope = useScope();
  const toast = useToast();
  const dishes = useGet<DishDto[]>('/dishes', undefined, { enabled: open, staleTime: 60_000 });
  const [locationId, setLocationId] = useState('');
  const [kind, setKind] = useState<'product' | 'dish'>('product');
  const [product, setProduct] = useState<ProductDto | null>(null);
  const [dishId, setDishId] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((body: object) => post('/stop-list/manual', body), ['/stop-list', '/analytics']);

  const options = scope.activeLocations;
  const chosen = locationId || scope.locationId || options[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (kind === 'product' && !product) return setError('Выберите продукт');
    if (kind === 'dish' && !dishId) return setError('Выберите блюдо');
    if (!reason.trim()) return setError('Укажите причину, её увидят коллеги');
    create.mutate(
      {
        locationId: chosen,
        ...(kind === 'product' ? { productId: product?.id } : { dishId }),
        reason: reason.trim(),
        ...(until ? { until: new Date(until).toISOString() } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Позиция добавлена в стоп-лист');
          setProduct(null);
          setDishId('');
          setReason('');
          setUntil('');
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Добавить в стоп-лист вручную"
      subtitle="Например, если партия под вопросом или блюдо снято с продажи"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="stop-add" loading={create.isPending}>
            Добавить
          </Button>
        </>
      }
    >
      <form id="stop-add" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldRow>
          <Field label="Точка" required>
            {(p) => (
              <Select {...p} value={chosen} onChange={(e) => setLocationId(e.target.value)}>
                {options.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Что останавливаем" required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'product' | 'dish')}>
                <option value="product">Продукт</option>
                <option value="dish">Блюдо</option>
              </Select>
            )}
          </Field>
        </FieldRow>
        {kind === 'product' ? (
          <Field label="Продукт" required>{(p) => <ProductPicker id={p.id} value={product} onChange={setProduct} />}</Field>
        ) : (
          <Field label="Блюдо" required>
            {(p) => (
              <Select {...p} value={dishId} onChange={(e) => setDishId(e.target.value)}>
                <option value="">Выберите блюдо</option>
                {dishes.data
                  ?.filter((d) => d.isActive)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Причина" required>{(p) => <Input {...p} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Field label="Действует до" hint="Если не указать, пока не снимут вручную">
          {(p) => <Input {...p} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

export default function StopListPage() {
  const { can } = useAuth();
  const scope = useScope();
  const toast = useToast();
  const confirm = useConfirm();
  const [source, setSource] = useState<Source>('all');
  const [adding, setAdding] = useState(false);
  const query = useGet<StopListDto>('/stop-list', { locationId: scope.locationId }, { refetchInterval: 60_000 });
  const forecast = useGet<StopForecastDto[]>('/stop-list/forecast', { locationId: scope.locationId }, { refetchInterval: 60_000 });
  const covered = useGet<StopForecastCoveredDto[]>('/stop-list/covered', { locationId: scope.locationId }, { refetchInterval: 60_000 });
  const release = useAction((id: string) => del(`/stop-list/manual/${id}`), ['/stop-list', '/analytics']);

  useEffect(() => {
    document.title = 'Стоп-лист - Запас';
  }, []);

  const entries = (query.data?.entries ?? []).filter((e) => source === 'all' || e.source === source);

  const onRelease = async (e: StopListEntryDto) => {
    if (!e.manualId) return;
    const ok = await confirm({ title: 'Снять со стоп-листа?', message: `«${e.name}» снова станет доступна на точке «${e.locationName}».`, confirmLabel: 'Снять' });
    if (!ok) return;
    release.mutate(e.manualId, {
      onSuccess: () => toast.success('Позиция снята со стоп-листа'),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const columns: Column<StopListEntryDto>[] = [
    {
      key: 'name',
      header: 'Позиция',
      cell: (e) => (
        <>
          <strong>{e.name}</strong>
          <span className={styles.sub}>{e.entityType === 'dish' ? 'Блюдо' : 'Продукт'}</span>
        </>
      ),
    },
    { key: 'loc', header: 'Точка', cell: (e) => e.locationName },
    {
      key: 'why',
      header: 'Причина',
      cell: (e) => {
        const r = e.reasons[0];
        return (
          <>
            <p className={styles.reasons}>{r?.code === 'missing_ingredients' ? 'Не хватает ингредиентов' : r?.text}</p>
            {r?.missing && (
              <ul className={styles.ingredients}>
                {r.missing.map((m) => (
                  <li key={m.productId}>
                    <Chip tone="danger">
                      {m.name}: нужно {formatQty(m.required, m.unit)}, есть {formatQty(m.available, m.unit)}
                    </Chip>
                  </li>
                ))}
              </ul>
            )}
            {e.incoming && e.incoming.length > 0 && (
              <ul className={styles.ingredients}>
                {e.incoming.map((i) => (
                  <li key={`${i.orderId}|${i.productId}`}>
                    <Chip tone="ok">Едет: {describeIncoming(i)}</Chip>
                  </li>
                ))}
              </ul>
            )}
          </>
        );
      },
    },
    {
      key: 'since',
      header: 'В стопе с',
      cell: (e) => (
        <>
          <span className="num">{fmtDateTime(e.since)}</span>
          {e.until && <span className={styles.sub}>до {fmtDateTime(e.until)}</span>}
        </>
      ),
    },
    {
      key: 'source',
      header: 'Источник',
      cell: (e) => (
        <>
          <Chip tone={e.source === 'manual' ? 'neutral' : 'info'}>{e.source === 'manual' ? 'Вручную' : 'Автоматически'}</Chip>
          {e.createdBy && <span className={styles.sub}>{e.createdBy}</span>}
        </>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (e) =>
        e.manualId && can('manager') ? (
          <Button size="sm" onClick={() => void onRelease(e)}>
            Снять
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Стоп-лист"
        subtitle="Продукты, у которых нет годного остатка, и блюда, которым не хватает ингредиентов. Список пересчитывается после каждой операции."
        actions={
          can('manager') && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
              Добавить вручную
            </Button>
          )
        }
      />

      {query.data && query.data.warnings.length > 0 && (
        <Panel title="Скоро закончатся" subtitle="Порций осталось немного, но блюдо ещё можно продавать">
          <div className={styles.warn}>
            {query.data.warnings.map((w) => (
              <Chip key={`${w.dishId}${w.locationId}`} tone="amber">
                {w.name}: {w.portions} порц. · {w.locationName}
              </Chip>
            ))}
          </div>
        </Panel>
      )}

      {forecast.data && forecast.data.length > 0 && (
        <>
          <div style={{ height: 16 }} />
          <ForecastPanel items={forecast.data} />
        </>
      )}

      {covered.data && covered.data.length > 0 && (
        <>
          <div style={{ height: 16 }} />
          <CoveredPanel items={covered.data} />
        </>
      )}

      <div style={{ height: 16 }} />
      <Panel>
        <Toolbar>
          <Segmented<Source>
            label="Источник"
            value={source}
            onChange={setSource}
            items={[
              { value: 'all', label: `Все (${query.data?.entries.length ?? 0})` },
              { value: 'auto', label: 'Автоматически' },
              { value: 'manual', label: 'Вручную' },
            ]}
          />
        </Toolbar>
        {query.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={query.isLoading ? undefined : entries} rowKey={(e) => e.key} loading={query.isLoading} caption="Стоп-лист" empty="Стоп-лист пуст: всё есть в наличии" />
        )}
      </Panel>
      <AddDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
