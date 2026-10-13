import {
  describeDaysLeft,
  formatMoney,
  formatMoneyWhole,
  formatNumber,
  formatQty,
  MOVEMENT_TYPE_LABELS,
  type BatchDto,
  type ForecastDto,
  type MovementDto,
  type Page,
  type StockRowDto,
} from '@zapas/shared';
import { useState } from 'react';
import { useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { PromotionDialog, WriteoffDialog } from '../../components/Actions/Dialogs';
import { Button } from '../../components/Button/Button';
import { Chip, LifeBar, StatusChip } from '../../components/Chip/Chip';
import { SalesHistory } from '../../components/Charts/Charts';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { DemandSection } from './DemandSection';
import styles from './StockPage.module.scss';

export function StockDetailDialog({ row, onClose }: { row: StockRowDto | null; onClose: () => void }) {
  const { can } = useAuth();
  const [promo, setPromo] = useState<BatchDto | null>(null);
  const [writeoff, setWriteoff] = useState<BatchDto | null>(null);

  const params = row ? { productId: row.productId, locationId: row.locationId } : undefined;
  const batches = useGet<Page<BatchDto>>('/stock/batches', params && { ...params, status: 'active', limit: 100 }, { enabled: Boolean(row) });
  const forecast = useGet<ForecastDto>(row ? `/analytics/forecast/${row.productId}` : '/analytics/forecast/none', row ? { locationId: row.locationId } : undefined, { enabled: Boolean(row) });
  const moves = useGet<Page<MovementDto>>('/stock/movements', params && { ...params, limit: 12 }, { enabled: Boolean(row) });

  const risk = new Map((forecast.data?.batches ?? []).map((b) => [b.batchId, b.atRisk]));

  const batchColumns: Column<BatchDto>[] = [
    {
      key: 'expires',
      header: 'Годен до',
      cell: (b) => (
        <>
          <span className="num">{fmtDate(b.expiresOn)}</span>
          <span className={styles.sub}>{describeDaysLeft(b.daysLeft)}</span>
        </>
      ),
    },
    { key: 'life', header: 'Срок', cell: (b) => <LifeBar elapsed={b.lifeElapsed} status={b.status} />, width: '70px' },
    {
      key: 'qty',
      header: 'Остаток',
      align: 'right',
      cell: (b) => (
        <>
          {formatQty(b.remainingQty, b.unit)}
          <span className={styles.sub}>из {formatNumber(b.initialQty)}</span>
        </>
      ),
    },
    {
      key: 'risk',
      header: 'Не успеем',
      align: 'right',
      cell: (b) => {
        const r = risk.get(b.id) ?? 0;
        return r > 0 ? <span className={b.daysLeft < 0 ? styles.bad : ''}>{formatQty(r, b.unit)}</span> : <span className="muted">-</span>;
      },
    },
    { key: 'cost', header: 'Себест.', align: 'right', cell: (b) => <span className="num">{formatMoney(b.unitCost)}</span> },
    {
      key: 'status',
      header: 'Статус',
      cell: (b) => (
        <>
          <StatusChip status={b.status} />
          {b.promotion && (
            <span className={styles.promo}>
              <Chip tone="info">−{b.promotion.percent}%</Chip>
            </span>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (b) => (
        <div className={styles.actions}>
          {can('manager') && b.daysLeft >= 0 && (
            <Button size="sm" onClick={() => setPromo(b)}>
              Скидка
            </Button>
          )}
          {can('storekeeper') && (
            <Button size="sm" variant="danger" onClick={() => setWriteoff(b)}>
              Списать
            </Button>
          )}
        </div>
      ),
    },
  ];

  const moveColumns: Column<MovementDto>[] = [
    { key: 'when', header: 'Когда', cell: (m) => <span className="num">{fmtDateTime(m.createdAt)}</span> },
    { key: 'type', header: 'Операция', cell: (m) => MOVEMENT_TYPE_LABELS[m.type] },
    { key: 'qty', header: 'Количество', align: 'right', cell: (m) => <span className={m.quantity < 0 ? '' : styles.sub}>{formatQty(m.quantity, m.unit)}</span> },
    { key: 'doc', header: 'Документ', cell: (m) => <span className="mono">{m.documentNumber}</span> },
    { key: 'who', header: 'Кто', cell: (m) => m.authorName },
  ];

  const f = forecast.data;
  return (
    <>
      <Dialog open={row !== null} onClose={onClose} title={row?.name ?? ''} subtitle={row ? `${row.sku} · ${row.locationName}` : undefined} width={900}>
        {row && (
          <>
            <dl className={styles.stats}>
              <div>
                <dt>Доступно</dt>
                <dd className="num">{formatQty(row.available, row.unit)}</dd>
              </div>
              <div>
                <dt>Просрочено</dt>
                <dd className={`num ${row.expired > 0 ? styles.bad : ''}`}>{formatQty(row.expired, row.unit)}</dd>
              </div>
              <div>
                <dt>Минимум</dt>
                <dd className="num">{row.minStock > 0 ? formatQty(row.minStock, row.unit) : '-'}</dd>
              </div>
              <div>
                <dt>Расход в сутки</dt>
                <dd className="num">{f ? formatQty(f.velocityPerDay, row.unit) : '…'}</dd>
              </div>
              <div>
                <dt>Хватит на</dt>
                <dd className="num">{f ? (f.daysToZero === null ? '-' : `${formatNumber(f.daysToZero)} дн.`) : '…'}</dd>
              </div>
              <div>
                <dt>Стоимость</dt>
                <dd className="num">{formatMoneyWhole(row.value)}</dd>
              </div>
            </dl>

            <div className={styles.section}>
              <h3>Партии с остатком</h3>
              {batches.isError ? (
                <ErrorNote error={batches.error} onRetry={() => void batches.refetch()} />
              ) : (
                <div className={styles.bordered}>
                  <DataTable dense columns={batchColumns} rows={batches.data?.items} rowKey={(b) => b.id} loading={batches.isLoading} empty="Остатка нет" />
                </div>
              )}
            </div>

            <div className={styles.section}>
              <h3>Расход за 28 дней</h3>
              {f ? (
                <>
                  <SalesHistory history={f.history} velocity={f.velocityPerDay} unit={row.unit === 'pcs' ? 'шт' : row.unit === 'kg' ? 'кг' : 'л'} />
                  {f.confidence < 0.5 && <p className="muted">Истории продаж мало (надёжность {Math.round(f.confidence * 100)}%), поэтому рекомендации опираются в основном на сроки.</p>}
                </>
              ) : (
                <p className="muted">{forecast.isError ? 'Прогноз недоступен' : 'Считаем…'}</p>
              )}
            </div>

            {can('storekeeper') && <DemandSection key={`${row.productId}|${row.locationId}`} row={row} />}

            <div className={styles.section}>
              <h3>Последние движения</h3>
              <div className={styles.bordered}>
                <DataTable dense columns={moveColumns} rows={moves.data?.items} rowKey={(m) => m.id} loading={moves.isLoading} empty="Движений нет" />
              </div>
            </div>
          </>
        )}
      </Dialog>
      <PromotionDialog key={`p-${promo?.id}`} batch={promo} onClose={() => setPromo(null)} />
      <WriteoffDialog key={`w-${writeoff?.id}`} batch={writeoff} onClose={() => setWriteoff(null)} defaultReason={writeoff && writeoff.daysLeft < 0 ? 'expired' : 'spoiled'} />
    </>
  );
}
