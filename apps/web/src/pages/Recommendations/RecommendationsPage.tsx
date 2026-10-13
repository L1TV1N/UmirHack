import {
  RECOMMENDATION_TYPE_LABELS,
  RECOMMENDATION_TYPES,
  formatQty,
  type RecommendationDto,
  type RecommendationsDto,
  type RecommendationType,
} from '@zapas/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { newIdempotencyKey, post } from '../../api/client';
import { STOCK_PREFIXES, useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { Method, MethodItem } from '../../components/Method/Method';
import { RecoItem } from '../../components/Recommendation/RecoItem';
import { AccuracyPanel } from './AccuracyPanel';
import { Segmented } from '../../components/Tabs/Tabs';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import styles from './RecommendationsPage.module.scss';

type Filter = 'all' | RecommendationType;

export default function RecommendationsPage() {
  const { can } = useAuth();
  const scope = useScope();
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const query = useGet<RecommendationsDto>('/analytics/recommendations', {
    locationId: scope.locationId,
    type: filter === 'all' ? undefined : filter,
  }, { placeholderData: keepPreviousData });;

  useEffect(() => {
    document.title = 'Рекомендации - Запас';
  }, []);

  const run = useAction(async (rec: RecommendationDto): Promise<string> => {
    const headers = { 'idempotency-key': newIdempotencyKey() };
    if (rec.action.kind === 'discount' && rec.batchId) {
      await post('/promotions', { batchId: rec.batchId, percent: rec.action.percent });
      return `Скидка ${rec.action.percent}% включена`;
    }
    if (rec.action.kind === 'writeoff' && rec.batchId) {
      const r = await post<{ number: string }>(
        '/documents/writeoffs',
        { locationId: rec.locationId, reason: 'expired', lines: [{ productId: rec.productId, batchId: rec.batchId, quantity: rec.quantity }] },
        headers,
      );
      return `Списано, документ ${r.number}`;
    }
    if (rec.action.kind === 'transfer' && rec.batchId && rec.action.targetLocationId) {
      const r = await post<{ number: string }>(
        '/documents/transfers',
        { fromLocationId: rec.locationId, toLocationId: rec.action.targetLocationId, lines: [{ productId: rec.productId, batchId: rec.batchId, quantity: rec.quantity }] },
        headers,
      );
      return `Перемещение ${r.number} проведено`;
    }
    throw new Error('Для этой рекомендации нет действия');
  }, STOCK_PREFIXES);

  const apply = async (rec: RecommendationDto) => {
    const text =
      rec.action.kind === 'discount'
        ? `Включить скидку ${rec.action.percent}% на ${formatQty(rec.quantity, rec.unit)} «${rec.productName}»?`
        : rec.action.kind === 'writeoff'
          ? `Списать ${formatQty(rec.quantity, rec.unit)} «${rec.productName}» как просроченное?`
          : `Переместить ${formatQty(rec.quantity, rec.unit)} «${rec.productName}» на точку «${rec.targetLocationName ?? ''}»?`;
    const ok = await confirm({
      title: 'Применить рекомендацию',
      message: text,
      confirmLabel: rec.action.kind === 'writeoff' ? 'Списать' : 'Применить',
      danger: rec.action.kind === 'writeoff',
    });
    if (!ok) return;
    setBusy(rec.id);
    run.mutate(rec, {
      onSuccess: (msg) => toast.success(msg),
      onError: (err) => toast.error(errorMessage(err)),
      onSettled: () => setBusy(null),
    });
  };

  const copyOrder = async (list: RecommendationDto[]) => {
    const text = list.map((r) => `${r.productName} (${r.locationName}) - ${formatQty(r.quantity, r.unit)}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Список заказа скопирован');
    } catch {
      toast.error('Не удалось скопировать, выделите текст вручную');
    }
  };

  const all = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const counts = new Map<Filter, number>([['all', total]]);
  for (const t of RECOMMENDATION_TYPES) counts.set(t, query.data?.counts[t] ?? 0);
  // пока тип загружается, показываем уже имеющееся, отфильтрованное на месте
  const shown = filter === 'all' ? all : all.filter((r) => r.type === filter);
  const filteredTotal = filter === 'all' ? total : (counts.get(filter) ?? 0);
  const truncated = filteredTotal > shown.length;

  const actionFor = (rec: RecommendationDto) => {
    const loading = busy === rec.id;
    if (rec.action.kind === 'discount' && can('manager')) {
      return (
        <Button variant="primary" size="sm" loading={loading} onClick={() => void apply(rec)}>
          Включить скидку {rec.action.percent}%
        </Button>
      );
    }
    if (rec.action.kind === 'writeoff' && can('storekeeper')) {
      return (
        <Button variant="dangerSolid" size="sm" loading={loading} onClick={() => void apply(rec)}>
          Списать
        </Button>
      );
    }
    if (rec.action.kind === 'transfer' && can('manager')) {
      return (
        <Button variant="primary" size="sm" loading={loading} onClick={() => void apply(rec)}>
          Переместить в «{rec.targetLocationName}»
        </Button>
      );
    }
    if (rec.type === 'reorder') {
      return (
        <Button size="sm" onClick={() => void copyOrder([rec])}>
          Скопировать для заказа
        </Button>
      );
    }
    return null;
  };

  return (
    <>
      <PageHeader title="Рекомендации" subtitle="Что сделать, чтобы продукты не пропали: списать, уценить, переместить, продвинуть через блюда или заказать." />

      <Method>
        <MethodItem title={<>Прогноз продаж</>}>Скорость расхода считается за последние 4 недели, последняя неделя весит больше, с поправкой на день недели, праздники, погоду и акции.</MethodItem>
        <MethodItem title={<>Сроки по партиям</>}>Партии расходуются от ближайшего срока, поэтому поздняя партия ждёт, пока уйдёт ранняя.</MethodItem>
        <MethodItem title={<>Скидка не в убыток</>}>Цена со скидкой не опускается ниже себестоимости, кроме последних суток.</MethodItem>
      </Method>

      {can('manager') && (
        <>
          <AccuracyPanel locationId={scope.locationId} />
          <div style={{ height: 16 }} />
        </>
      )}

      <Panel>
        <Toolbar>
          <Segmented<Filter>
            label="Тип рекомендации"
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: `Все (${counts.get('all') ?? 0})` },
              ...RECOMMENDATION_TYPES.map((t) => ({ value: t, label: `${RECOMMENDATION_TYPE_LABELS[t]} (${counts.get(t) ?? 0})` })),
            ]}
          />
          {filter === 'reorder' && shown.length > 0 && (
            <Button size="sm" onClick={() => void copyOrder(shown)}>
              Скопировать весь список
            </Button>
          )}
        </Toolbar>
        {query.isLoading && <Loading />}
        {query.isError && (
          <div style={{ padding: 16 }}>
            <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
          </div>
        )}
        {query.data && shown.length === 0 && <EmptyState title="Здесь пока пусто">Для выбранной точки и типа рекомендаций нет. Это хороший знак.</EmptyState>}
        {shown.length > 0 && (
          <ul className={styles.list}>
            {shown.map((r) => (
              <RecoItem key={r.id} rec={r} actions={actionFor(r)} />
            ))}
          </ul>
        )}
        {truncated && (
          <p className={styles.more}>
            Показаны {shown.length} самых важных из {filteredTotal}. Разберите эти, остальные появятся следом.
          </p>
        )}
      </Panel>
    </>
  );
}
