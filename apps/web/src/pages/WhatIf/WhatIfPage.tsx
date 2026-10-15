import {
  formatMoneyWhole,
  servesDishes,
  whatIfBody,
  WHAT_IF_ACTION_LABELS,
  WHAT_IF_MAX_ACTIONS,
  type BatchDto,
  type DishDto,
  type LocationDto,
  type Page,
  type ProductDto,
  type WhatIfActionType,
  type WhatIfMetricsDto,
  type WhatIfResultDto,
} from '@zapas/shared';
import { Check, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { errorMessage } from '../../lib/errors';
import styles from './WhatIfPage.module.scss';

/** Шаг в том виде, как его вводит человек: все поля строками, разбираются при расчёте. */
export interface Draft {
  uid: number;
  type: WhatIfActionType;
  batchId: string;
  productId: string;
  locationId: string;
  toLocationId: string;
  dishId: string;
  quantity: string;
  shelfDays: string;
  portions: string;
  factor: string;
}

let uid = 0;
export const emptyDraft = (type: WhatIfActionType = 'writeoff'): Draft => ({
  uid: (uid += 1),
  type,
  batchId: '',
  productId: '',
  locationId: '',
  toLocationId: '',
  dishId: '',
  quantity: '',
  shelfDays: '',
  portions: '',
  factor: '1.5',
});

const num = (v: string): number => Number(v.replace(',', '.'));

/** Разбор шагов в тело запроса. Возвращает текст ошибки с номером шага, если что-то не заполнено. */
export function buildBody(drafts: Draft[], locationId: string | undefined): { body?: ReturnType<typeof whatIfBody.parse>; error?: string } {
  const actions: unknown[] = [];
  for (const [i, d] of drafts.entries()) {
    const at = `Шаг ${i + 1}`;
    if (d.type === 'writeoff') {
      if (!d.batchId) return { error: `${at}: выберите партию` };
      actions.push({ type: 'writeoff', batchId: d.batchId, ...(d.quantity.trim() ? { quantity: num(d.quantity) } : {}) });
    } else if (d.type === 'transfer') {
      if (!d.batchId) return { error: `${at}: выберите партию` };
      if (!d.toLocationId) return { error: `${at}: выберите, куда переместить` };
      actions.push({ type: 'transfer', batchId: d.batchId, toLocationId: d.toLocationId, ...(d.quantity.trim() ? { quantity: num(d.quantity) } : {}) });
    } else if (d.type === 'receive') {
      if (!d.productId || !d.locationId) return { error: `${at}: выберите продукт и точку` };
      if (!(num(d.quantity) > 0)) return { error: `${at}: укажите количество` };
      if (d.shelfDays.trim() === '' || !Number.isInteger(num(d.shelfDays)) || num(d.shelfDays) < 0) return { error: `${at}: укажите срок годности в сутках целым числом` };
      actions.push({ type: 'receive', productId: d.productId, locationId: d.locationId, quantity: num(d.quantity), shelfDays: num(d.shelfDays) });
    } else if (d.type === 'cook') {
      if (!d.dishId || !d.locationId) return { error: `${at}: выберите блюдо и кухню` };
      if (!Number.isInteger(num(d.portions)) || num(d.portions) < 1) return { error: `${at}: укажите число порций` };
      actions.push({ type: 'cook', dishId: d.dishId, locationId: d.locationId, portions: num(d.portions) });
    } else {
      if (!d.productId || !d.locationId) return { error: `${at}: выберите продукт и точку` };
      if (!(num(d.factor) >= 0.1 && num(d.factor) <= 5)) return { error: `${at}: во сколько раз изменится спрос, от 0,1 до 5` };
      actions.push({ type: 'demand', productId: d.productId, locationId: d.locationId, factor: num(d.factor) });
    }
  }
  const parsed = whatIfBody.safeParse({ ...(locationId ? { locationId } : {}), actions });
  return parsed.success ? { body: parsed.data } : { error: 'Проверьте числа: количество должно быть больше нуля' };
}

type Metric = { key: keyof WhatIfMetricsDto; label: string; money: boolean; /** Рост этого показателя плохо. */ upIsBad: boolean };
const METRICS: Metric[] = [
  { key: 'atRiskValue', label: 'Под угрозой', money: true, upIsBad: true },
  { key: 'expiredValue', label: 'Просрочено', money: true, upIsBad: true },
  { key: 'expiringSoonValue', label: 'Истекает скоро', money: true, upIsBad: true },
  { key: 'stockValue', label: 'Склад по себестоимости', money: true, upIsBad: false },
  { key: 'stopCount', label: 'Позиций в стоп-листе', money: false, upIsBad: true },
  { key: 'hotCount', label: 'Горячих блюд', money: false, upIsBad: false },
];

export function Delta({ before, after, money, upIsBad }: { before: number; after: number; money: boolean; upIsBad: boolean }) {
  const diff = Math.round((after - before) * 100) / 100;
  if (diff === 0) return <span className={styles.same}>без изменений</span>;
  const bad = upIsBad ? diff > 0 : false;
  const good = upIsBad ? diff < 0 : false;
  const text = `${diff > 0 ? '+' : '-'}${money ? formatMoneyWhole(Math.abs(diff)) : Math.abs(diff)}`;
  return <span className={bad ? styles.bad : good ? styles.good : styles.same}>{text}</span>;
}

const lineOf = (b: BatchDto) => `${b.productName} · ${b.locationName} · до ${b.expiresOn.split('-').reverse().join('.')} · ${b.remainingQty} ${b.unit}`;

function ActionEditor({
  draft,
  index,
  onChange,
  onRemove,
  data,
}: {
  draft: Draft;
  index: number;
  onChange: (d: Draft) => void;
  onRemove: () => void;
  data: { batches: BatchDto[]; products: ProductDto[]; locations: LocationDto[]; dishes: DishDto[] };
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const title = `Шаг ${index + 1}`;
  const kitchens = data.locations.filter((l) => l.isActive && servesDishes(l.kind));
  const places = data.locations.filter((l) => l.isActive);
  return (
    <li className={styles.action}>
      <div className={styles.actionHead}>
        <strong>{title}</strong>
        <Select aria-label={`${title}: действие`} value={draft.type} onChange={(e) => onChange({ ...emptyDraft(e.target.value as WhatIfActionType), uid: draft.uid })}>
          {(Object.keys(WHAT_IF_ACTION_LABELS) as WhatIfActionType[]).map((t) => (
            <option key={t} value={t}>
              {WHAT_IF_ACTION_LABELS[t]}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={onRemove} aria-label={`Убрать ${title.toLowerCase()}`} />
      </div>
      <div className={styles.fields}>
        {(draft.type === 'writeoff' || draft.type === 'transfer') && (
          <Field label="Партия">
            {(p) => (
              <Select {...p} value={draft.batchId} onChange={(e) => set({ batchId: e.target.value })}>
                <option value="">Выберите партию</option>
                {data.batches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {lineOf(b)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {draft.type === 'transfer' && (
          <Field label="Куда">
            {(p) => (
              <Select {...p} value={draft.toLocationId} onChange={(e) => set({ toLocationId: e.target.value })}>
                <option value="">Выберите точку</option>
                {places.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {(draft.type === 'writeoff' || draft.type === 'transfer') && (
          <Field label="Количество" hint="Пусто: вся партия">
            {(p) => <Input {...p} numeric value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} />}
          </Field>
        )}
        {(draft.type === 'receive' || draft.type === 'demand') && (
          <Field label="Продукт">
            {(p) => (
              <Select {...p} value={draft.productId} onChange={(e) => set({ productId: e.target.value })}>
                <option value="">Выберите продукт</option>
                {data.products.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {draft.type === 'cook' && (
          <Field label="Блюдо">
            {(p) => (
              <Select {...p} value={draft.dishId} onChange={(e) => set({ dishId: e.target.value })}>
                <option value="">Выберите блюдо</option>
                {data.dishes.filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {(draft.type === 'receive' || draft.type === 'demand' || draft.type === 'cook') && (
          <Field label={draft.type === 'cook' ? 'Кухня' : 'Точка'}>
            {(p) => (
              <Select {...p} value={draft.locationId} onChange={(e) => set({ locationId: e.target.value })}>
                <option value="">Выберите точку</option>
                {(draft.type === 'cook' ? kitchens : places).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {draft.type === 'receive' && (
          <>
            <Field label="Количество">{(p) => <Input {...p} numeric value={draft.quantity} onChange={(e) => set({ quantity: e.target.value })} />}</Field>
            <Field label="Срок годности, сут.">{(p) => <Input {...p} numeric value={draft.shelfDays} onChange={(e) => set({ shelfDays: e.target.value })} />}</Field>
          </>
        )}
        {draft.type === 'cook' && <Field label="Порций">{(p) => <Input {...p} numeric value={draft.portions} onChange={(e) => set({ portions: e.target.value })} />}</Field>}
        {draft.type === 'demand' && (
          <Field label="Спрос изменится в" hint="1,5 - на половину больше, 0,5 - вдвое меньше">
            {(p) => <Input {...p} numeric value={draft.factor} onChange={(e) => set({ factor: e.target.value })} />}
          </Field>
        )}
      </div>
    </li>
  );
}

export function WhatIfResult({ result }: { result: WhatIfResultDto }) {
  return (
    <div className={styles.result} aria-live="polite">
      <div className={styles.safe}>
        <ShieldCheck size={16} aria-hidden="true" /> Ничего не записано: остатки, стоп-лист и журнал остались как были
      </div>

      <ul className={styles.steps}>
        {result.steps.map((s) => (
          <li key={s.index} className={s.ok ? '' : styles.stepFail}>
            {s.ok ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
            <span>
              <b>Шаг {s.index + 1}.</b> {s.text}
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.metrics}>
        {METRICS.map((m) => (
          <div key={m.key} className={styles.metric}>
            <small>{m.label}</small>
            <strong>{m.money ? formatMoneyWhole(result.after[m.key]) : result.after[m.key]}</strong>
            <span className={styles.was}>было {m.money ? formatMoneyWhole(result.before[m.key]) : result.before[m.key]}</span>
            <Delta before={result.before[m.key]} after={result.after[m.key]} money={m.money} upIsBad={m.upIsBad} />
          </div>
        ))}
      </div>

      <div className={styles.cols}>
        <section>
          <h3>Уйдёт в стоп-лист</h3>
          {result.stopAdded.length === 0 ? (
            <p className={styles.none}>Ничего нового</p>
          ) : (
            <ul>
              {result.stopAdded.map((s) => (
                <li key={`${s.locationId}${s.entityId}`}>
                  <Chip tone="danger">{s.entityType === 'dish' ? 'Блюдо' : 'Продукт'}</Chip> {s.name} <small>{s.locationName}: {s.reason}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Выйдет из стоп-листа</h3>
          {result.stopRemoved.length === 0 ? (
            <p className={styles.none}>Ничего</p>
          ) : (
            <ul>
              {result.stopRemoved.map((s) => (
                <li key={`${s.locationId}${s.entityId}`}>
                  <Chip tone="ok">{s.entityType === 'dish' ? 'Блюдо' : 'Продукт'}</Chip> {s.name} <small>{s.locationName}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Горячие блюда сейчас</h3>
          {result.hotBefore.length === 0 ? <p className={styles.none}>Нет</p> : <ol>{result.hotBefore.map((h) => <li key={h.dishId + h.locationName}>{h.dishName} <small>{h.priority}</small></li>)}</ol>}
        </section>
        <section>
          <h3>Горячие блюда после</h3>
          {result.hotAfter.length === 0 ? <p className={styles.none}>Нет</p> : <ol>{result.hotAfter.map((h) => <li key={h.dishId + h.locationName}>{h.dishName} <small>{h.priority}</small></li>)}</ol>}
        </section>
      </div>

      <ul className={styles.notes}>
        {result.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

/** Песочница решений: сыграть списание, поставку, перемещение, продажу блюд или рост спроса и увидеть последствия, ничего не меняя. */
export default function WhatIfPage() {
  const scope = useScope();
  const [drafts, setDrafts] = useState<Draft[]>(() => [emptyDraft()]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WhatIfResultDto | null>(null);

  const batches = useGet<Page<BatchDto>>('/stock/batches', { locationId: scope.locationId, status: 'active', limit: 200 }, { enabled: Boolean(scope.locationId) });
  const products = useGet<Page<ProductDto>>('/products', { limit: 200, active: true }, { staleTime: 60_000 });
  const locations = useGet<LocationDto[]>('/locations', undefined, { staleTime: 60_000 });
  const dishes = useGet<DishDto[]>('/dishes', undefined, { staleTime: 60_000 });
  const run = useAction((body: object) => post<WhatIfResultDto>('/analytics/what-if', body));

  useEffect(() => {
    document.title = 'Что если - Запас';
  }, []);

  const data = useMemo(
    () => ({ batches: batches.data?.items ?? [], products: products.data?.items ?? [], locations: locations.data ?? [], dishes: dishes.data ?? [] }),
    [batches.data, products.data, locations.data, dishes.data],
  );

  const submit = () => {
    setError(null);
    const built = buildBody(drafts, scope.locationId ?? undefined);
    if (!built.body) return setError(built.error ?? 'Проверьте шаги');
    run.mutate(built.body, {
      onSuccess: (r) => setResult(r),
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const loadError = batches.error ?? products.error ?? locations.error ?? dishes.error;

  return (
    <>
      <PageHeader title="Что если" subtitle="Проиграйте решение до того, как его принимать: списание, поставку, перемещение, продажу блюд или рост спроса. Система покажет, что изменится в рисках и стоп-листе, и ничего не запишет." />
      {loadError && <ErrorNote error={loadError} />}
      <Panel padded title="Сценарий" actions={<Chip tone="info">Прогон в сухую</Chip>}>
        <ol className={styles.actions}>
          {drafts.map((d, i) => (
            <ActionEditor
              key={d.uid}
              draft={d}
              index={i}
              data={data}
              onChange={(next) => setDrafts((all) => all.map((x) => (x.uid === d.uid ? next : x)))}
              onRemove={() => setDrafts((all) => (all.length > 1 ? all.filter((x) => x.uid !== d.uid) : [emptyDraft()]))}
            />
          ))}
        </ol>
        {error && <ErrorNote message={error} />}
        <div className={styles.bar}>
          <Button icon={<Plus size={15} />} onClick={() => setDrafts((all) => [...all, emptyDraft()])} disabled={drafts.length >= WHAT_IF_MAX_ACTIONS}>
            Добавить шаг
          </Button>
          <Button variant="primary" onClick={submit} loading={run.isPending}>
            Посчитать
          </Button>
        </div>
      </Panel>
      {result && (
        <Panel padded title="Что получится">
          <WhatIfResult result={result} />
        </Panel>
      )}
    </>
  );
}
