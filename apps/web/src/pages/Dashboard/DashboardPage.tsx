import {
  formatMoneyWhole,
  WRITEOFF_REASON_LABELS,
  type DashboardDto,
} from '@zapas/shared';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { ExpiryBars, KpiStrip, TrendChart } from '../../components/Charts/Charts';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Panel, PageHeader } from '../../components/Panel/Panel';
import { RecoItem } from '../../components/Recommendation/RecoItem';
import { fmtDateTime } from '../../lib/format';
import styles from './DashboardPage.module.scss';

export default function DashboardPage() {
  const scope = useScope();
  const { can } = useAuth();
  const query = useGet<DashboardDto>('/analytics/dashboard', { locationId: scope.locationId }, { refetchInterval: 60_000 });
  const d = query.data;

  useEffect(() => {
    document.title = 'Обзор — Запас';
  }, []);

  // чистая установка: показывать нули по пустой системе незачем, лучше подсказать, с чего начать
  const noLocations = !scope.loading && scope.activeLocations.length === 0;
  const where = scope.locationId ? scope.nameOf(scope.locationId) : 'все точки';

  return (
    <>
      <PageHeader
        title="Обзор"
        subtitle={d ? `${where[0]?.toUpperCase()}${where.slice(1)}. Данные на ${fmtDateTime(d.asOf)}` : undefined}
        actions={
          <Button size="sm" onClick={() => void query.refetch()} loading={query.isFetching && !query.isLoading}>
            Обновить
          </Button>
        }
      />

      {noLocations && (
        <Panel>
          <EmptyState
            title="В системе пока нет ни одной точки"
            {...(can('admin') ? { action: <Link to="/admin">Перейти к администрированию</Link> } : {})}
          >
            {can('admin')
              ? 'Начните с создания точки, затем добавьте продукты в номенклатуру и оформите первый приход. После этого здесь появятся остатки, сроки и рекомендации.'
              : 'Точки создаёт администратор. Как только они появятся, здесь будут остатки, сроки и рекомендации.'}
          </EmptyState>
        </Panel>
      )}
      {!noLocations && query.isError && <ErrorNote error={query.error} onRetry={() => void query.refetch()} />}
      {!noLocations && query.isLoading && <Loading />}

      {!noLocations && d && (
        <>
          <KpiStrip
            items={[
              { label: 'Остатки', value: formatMoneyWhole(d.kpis.stockValue), hint: 'по себестоимости' },
              {
                label: 'Под угрозой',
                value: formatMoneyWhole(d.kpis.atRiskValue),
                hint: 'не успеем продать до конца срока',
                ...(d.kpis.atRiskValue > 0 ? { tone: 'warn' as const } : {}),
              },
              {
                label: 'Просрочено',
                value: formatMoneyWhole(d.kpis.expiredValue),
                hint: d.kpis.expiredBatches > 0 ? `${d.kpis.expiredBatches} парт. ждут списания` : 'нет просроченных партий',
                ...(d.kpis.expiredValue > 0 ? { tone: 'danger' as const } : {}),
              },
              {
                label: 'Скоро истекает',
                value: formatMoneyWhole(d.kpis.expiringSoonValue),
                hint: `${d.kpis.expiringSoonBatches} парт. в ближайшие дни`,
              },
              {
                label: 'В стоп-листе',
                value: String(d.kpis.stopListCount),
                hint: `ниже минимума: ${d.kpis.lowStockCount}`,
              },
              {
                label: 'Списано за 30 дней',
                value: formatMoneyWhole(d.kpis.writeoff30dValue),
                hint: `выручка ${formatMoneyWhole(d.kpis.revenue30d)}`,
              },
            ]}
          />

          <div className={styles.grid}>
            <div className={styles.col}>
              <Panel
                title="Что требует действий"
                subtitle="Сначала просроченное, затем то, что скоро истечёт"
                actions={<Link to="/recommendations">Все рекомендации</Link>}
              >
                {d.topRisks.length === 0 ? (
                  <div className={styles.empty}>Прямо сейчас ничего не горит. Следите за сроками в разделе «Остатки».</div>
                ) : (
                  <ul className={styles.list}>
                    {d.topRisks.map((r) => (
                      <RecoItem key={r.id} rec={r} compact />
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Списания за 30 дней" subtitle="Сколько денег ушло по себестоимости" padded>
                <TrendChart points={d.writeoffTrend} />
                {d.writeoffByReason.length > 0 && (
                  <ul className={styles.reasons}>
                    {d.writeoffByReason.map((r) => (
                      <li key={r.reason}>
                        <span>{WRITEOFF_REASON_LABELS[r.reason]}</span>
                        <strong className="num">{formatMoneyWhole(r.value)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <div className={styles.col}>
              <Panel title="Остатки по срокам годности" subtitle="Стоимость по себестоимости" padded>
                <ExpiryBars buckets={d.expiryBuckets} />
              </Panel>

              <Panel title="Стоп-лист" subtitle={`Позиций и блюд: ${d.kpis.stopListCount}`} actions={<Link to="/stop-list">Открыть</Link>}>
                {d.stopList.length === 0 ? (
                  <div className={styles.empty}>Всё есть в наличии</div>
                ) : (
                  <ul className={styles.stop}>
                    {d.stopList.map((s) => (
                      <li key={s.key}>
                        <span>
                          <strong>{s.name}</strong>
                          <small>
                            {s.locationName} · {s.reasons[0]?.text}
                          </small>
                        </span>
                        <Chip tone={s.source === 'manual' ? 'neutral' : 'danger'}>{s.source === 'manual' ? 'вручную' : s.entityType === 'dish' ? 'блюдо' : 'нет'}</Chip>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </>
      )}
    </>
  );
}
