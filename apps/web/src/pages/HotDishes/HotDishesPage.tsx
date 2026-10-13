import type { HotDishesDto } from '@zapas/shared';
import { useEffect } from 'react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { Method, MethodItem } from '../../components/Method/Method';
import { HotDishItem } from '../../components/Recommendation/HotDishItem';
import { fmtDateTime } from '../../lib/format';
import styles from './HotDishesPage.module.scss';

export default function HotDishesPage() {
  const scope = useScope();
  const query = useGet<HotDishesDto>('/analytics/hot-dishes', { locationId: scope.locationId }, { refetchInterval: 60_000 });
  const items = query.data?.items ?? [];

  useEffect(() => {
    document.title = 'Горячие предложения - Запас';
  }, []);

  return (
    <>
      <PageHeader
        title="Горячие предложения"
        subtitle="Блюда, продажу которых стоит стимулировать, пока не истёк срок их ингредиентов. Список пересчитывается после каждой операции."
        actions={
          <Button size="sm" onClick={() => void query.refetch()} loading={query.isFetching && !query.isLoading}>
            Обновить
          </Button>
        }
      />

      <Method>
        <MethodItem title={<>Срок ингредиента</>}>Берётся ближайшая партия. В последний день срока вес 1, за сутки до конца 0,67, за двое суток 0,5. Дальше недели в расчёт не входит.</MethodItem>
        <MethodItem title={<>Остаток и порция</>}>Чем большую часть ближайших по сроку партий блюдо способно израсходовать, тем выше приоритет. Это зависит от запаса на кухне и расхода на порцию. Больше 24 порций одного блюда за смену не считаем.</MethodItem>
        <MethodItem title={<>Прогноз продаж</>}>Если по скорости продаж партия и так уйдёт, вес снижается. Если не успевает, растёт до полного.</MethodItem>
        <MethodItem title={<>Общий ингредиент</>}>Остаток, нужный нескольким блюдам, делится по очереди: блюдо с большим приоритетом забирает своё, остальным достаётся оставшееся.</MethodItem>
      </Method>

      <Panel>
        {query.isLoading && <Loading />}
        {query.isError && (
          <div style={{ padding: 16 }}>
            <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
          </div>
        )}
        {query.data && items.length === 0 && (
          <EmptyState title="Продвигать пока нечего">
            У ингредиентов кухонь нет сроков в ближайшую неделю, или блюда, которые из них готовятся, в стоп-листе.
          </EmptyState>
        )}
        {items.length > 0 && (
          <ul className={styles.list}>
            {items.map((d) => (
              <HotDishItem key={`${d.dishId}|${d.locationId}`} dish={d} />
            ))}
          </ul>
        )}
        {query.data && items.length > 0 && <p className={styles.asOf}>Данные на {fmtDateTime(query.data.asOf)}</p>}
      </Panel>
    </>
  );
}
