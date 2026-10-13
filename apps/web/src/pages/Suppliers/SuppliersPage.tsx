import {
  FRESHNESS_FULL,
  formatMoneyWhole,
  SPOILAGE_ZERO_AT,
  SUPPLIER_SCORE_WEIGHTS,
  WRITEOFF_REASON_LABELS,
  WRITEOFF_REASONS,
  type SupplierRatingDto,
  type SupplierScoreDto,
  type WriteoffReason,
} from '@zapas/shared';
import { useEffect, useState } from 'react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { Method, MethodItem } from '../../components/Method/Method';
import { Segmented } from '../../components/Tabs/Tabs';
import styles from './SuppliersPage.module.scss';

type Period = '30' | '90' | '180';

const percent = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 100)}%`);
const GRADE_TONE: Record<NonNullable<SupplierScoreDto['grade']>, Tone> = { A: 'ok', B: 'amber', C: 'danger' };
const pct = (weight: number) => `${Math.round(weight * 100)}%`;

function LossBars({ data }: { data: SupplierRatingDto }) {
  const max = Math.max(1, ...data.lossesByReason.map((l) => l.value));
  if (data.lossesByReason.length === 0) return <div className={styles.empty}>За период списаний не было.</div>;
  return (
    <ul className={styles.bars} aria-label="Потери по причинам">
      {data.lossesByReason.map((l) => (
        <li key={l.reason}>
          <span className={styles.barLabel}>{WRITEOFF_REASON_LABELS[l.reason]}</span>
          <span className={styles.track}>
            <i style={{ width: `${Math.max(2, Math.round((l.value / max) * 100))}%` }} />
          </span>
          <span className={styles.barValue}>
            {formatMoneyWhole(l.value)}
            <small>{data.totalLoss > 0 ? `${Math.round((l.value / data.totalLoss) * 100)}%` : ''}</small>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function SuppliersPage() {
  const scope = useScope();
  const [period, setPeriod] = useState<Period>('90');
  const query = useGet<SupplierRatingDto>('/analytics/suppliers', { locationId: scope.locationId, days: Number(period) });
  const d = query.data;

  useEffect(() => {
    document.title = 'Поставщики - Запас';
  }, []);

  const columns: Column<SupplierScoreDto>[] = [
    { key: 'name', header: 'Поставщик', cell: (s) => <strong>{s.supplierName}</strong> },
    {
      key: 'score',
      header: 'Оценка',
      cell: (s) => (s.score === null || s.grade === null ? <span className="muted">нет данных</span> : <Chip tone={GRADE_TONE[s.grade]}>{s.grade} · {s.score}</Chip>),
    },
    { key: 'orders', header: 'Заказов', align: 'right', cell: (s) => <span className="num">{s.orders}</span> },
    { key: 'fill', header: 'Привезли от заказанного', align: 'right', cell: (s) => <span className="num">{percent(s.fillRate)}</span> },
    {
      key: 'time',
      header: 'В срок',
      align: 'right',
      cell: (s) => (
        <span className="num">
          {percent(s.onTimeRate)}
          {s.avgDelayDays !== null && s.avgDelayDays > 0 && <small className={styles.sub}>в среднем +{s.avgDelayDays.toLocaleString('ru-RU')} дн.</small>}
        </span>
      ),
    },
    { key: 'fresh', header: 'Срока при приёмке', align: 'right', cell: (s) => <span className="num">{percent(s.freshness)}</span> },
    {
      key: 'loss',
      header: 'Потери',
      align: 'right',
      cell: (s) => (
        <span className="num">
          {formatMoneyWhole(s.lossValue)}
          {s.spoilageRate !== null && <small className={styles.sub}>порча и бой {(Math.round(s.spoilageRate * 1000) / 10).toLocaleString('ru-RU')}% от принятого</small>}
        </span>
      ),
    },
  ];

  const reasons = WRITEOFF_REASONS.filter((r) => d?.suppliers.some((s) => s.losses.some((l) => l.reason === r)));
  const lossOf = (s: SupplierScoreDto, r: WriteoffReason) => s.losses.find((l) => l.reason === r)?.value ?? 0;

  return (
    <>
      <PageHeader
        title="Рейтинг поставщиков"
        subtitle="Кто привозит заказанное и вовремя, насколько свежее, и откуда берутся потери."
        actions={
          <Segmented<Period>
            label="Период"
            value={period}
            onChange={setPeriod}
            items={[
              { value: '30', label: '30 дней' },
              { value: '90', label: '90 дней' },
              { value: '180', label: '180 дней' },
            ]}
          />
        }
      />

      <Method>
        <MethodItem title={<>Выполнение заказов, {pct(SUPPLIER_SCORE_WEIGHTS.fill)}</>}>Какую часть заказанного по стоимости привезли. Считаются отправленные заказы, срок которых уже наступил.</MethodItem>
        <MethodItem title={<>Сроки, {pct(SUPPLIER_SCORE_WEIGHTS.onTime)}</>}>Доля заказов, первая поставка по которым пришла не позже обещанной даты.</MethodItem>
        <MethodItem title={<>Свежесть, {pct(SUPPLIER_SCORE_WEIGHTS.freshness)}</>}>Сколько срока годности оставалось при приёмке. От {Math.round(FRESHNESS_FULL * 100)}% и выше оценивается полностью.</MethodItem>
        <MethodItem title={<>Качество, {pct(SUPPLIER_SCORE_WEIGHTS.quality)}</>}>Порча и бой по его партиям к принятому. При {Math.round(SPOILAGE_ZERO_AT * 100)}% и больше оценка нулевая.</MethodItem>
      </Method>

      <Panel title="Поставщики" subtitle="A от 90 баллов, B от 80, ниже C. Без заказов оценка строится по свежести и потерям">
        {query.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : query.isLoading ? (
          <Loading />
        ) : d && d.suppliers.length === 0 ? (
          <EmptyState title="За период нет данных">Рейтинг строится по заказам поставщикам, приходам и списаниям. Как только они появятся, здесь будут оценки.</EmptyState>
        ) : (
          <DataTable columns={columns} rows={d?.suppliers} rowKey={(s) => s.supplierId} caption="Рейтинг поставщиков" />
        )}
      </Panel>

      <div style={{ height: 16 }} />
      <Panel title="Причины потерь" subtitle={d ? `Списано за ${d.days} дн.: ${formatMoneyWhole(d.totalLoss)} по себестоимости` : undefined}>
        {d && (
          <>
            <LossBars data={d} />
            {reasons.length > 0 && (
              <div className={styles.matrix}>
                <table aria-label="Потери по поставщикам и причинам">
                  <thead>
                    <tr>
                      <th scope="col">Поставщик</th>
                      {reasons.map((r) => (
                        <th scope="col" key={r}>
                          {WRITEOFF_REASON_LABELS[r]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.suppliers
                      .filter((s) => s.lossValue > 0)
                      .map((s) => (
                        <tr key={s.supplierId}>
                          <th scope="row">{s.supplierName}</th>
                          {reasons.map((r) => (
                            <td key={r} className="num">
                              {lossOf(s, r) > 0 ? formatMoneyWhole(lossOf(s, r)) : '-'}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
