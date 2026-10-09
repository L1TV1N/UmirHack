import {
  describeDaysLeft,
  formatMoney,
  formatMoneyWhole,
  formatNumber,
  formatQty,
  type BatchDto,
  type CategoryDto,
  type Page,
  type StockRowDto,
} from '@zapas/shared';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Chip, LifeBar, StatusChip } from '../../components/Chip/Chip';
import { Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { Segmented, Tabs } from '../../components/Tabs/Tabs';
import { fmtDate } from '../../lib/format';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { useUrlState } from '../../lib/useUrlState';
import { StockDetailDialog } from './StockDetailDialog';
import styles from './StockPage.module.scss';

const LIMIT = 50;

type Flag = 'all' | 'low' | 'expiring' | 'expired';
type BatchFilter = 'active' | 'expiring' | 'expired' | 'depleted';

export default function StockPage() {
  const scope = useScope();
  const [url, setUrl] = useUrlState({ tab: 'items', q: '', flag: 'all', status: 'active', category: '', offset: '0' });
  const [search, setSearch] = useState(url.q);
  const debounced = useDebouncedValue(search, 300);
  const [selected, setSelected] = useState<StockRowDto | null>(null);
  const offset = Number(url.offset) || 0;

  useEffect(() => {
    document.title = 'Остатки — Запас';
  }, []);
  useEffect(() => {
    if (debounced !== url.q) setUrl({ q: debounced });
  }, [debounced, url.q, setUrl]);

  const categories = useGet<CategoryDto[]>('/categories', undefined, { staleTime: 120_000 });
  const showItems = url.tab !== 'batches';

  const items = useGet<Page<StockRowDto>>(
    '/stock/summary',
    { locationId: scope.locationId, q: url.q, flag: url.flag, categoryId: url.category, limit: LIMIT, offset },
    { enabled: showItems },
  );
  const batches = useGet<Page<BatchDto>>(
    '/stock/batches',
    { locationId: scope.locationId, q: url.q, status: url.status, limit: LIMIT, offset },
    { enabled: !showItems },
  );

  const hideLocation = Boolean(scope.locationId);

  const itemColumns: Column<StockRowDto>[] = [
    {
      key: 'name',
      header: 'Продукт',
      cell: (r) => (
        <>
          <strong>{r.name}</strong>
          <span className={styles.sub}>
            {r.sku} · {r.categoryName}
          </span>
        </>
      ),
    },
    ...(hideLocation ? [] : [{ key: 'loc', header: 'Точка', cell: (r: StockRowDto) => r.locationName }]),
    {
      key: 'avail',
      header: 'Доступно',
      align: 'right',
      cell: (r) => (
        <>
          <span className="num">{formatQty(r.available, r.unit)}</span>
          {r.expired > 0 && <span className={`${styles.sub} ${styles.bad}`}>+ просрочено {formatQty(r.expired, r.unit)}</span>}
        </>
      ),
    },
    {
      key: 'min',
      header: 'Минимум',
      align: 'right',
      cell: (r) => (r.minStock > 0 ? <span className={r.belowMin ? styles.bad : 'muted'}>{formatQty(r.minStock, r.unit)}</span> : <span className="muted">—</span>),
    },
    {
      key: 'next',
      header: 'Ближайший срок',
      cell: (r) =>
        r.nearestExpiry && r.daysLeft !== null ? (
          <>
            <span className="num">{fmtDate(r.nearestExpiry)}</span>
            <span className={styles.sub}>{describeDaysLeft(r.daysLeft)}</span>
          </>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (r) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusChip status={r.status} />
          {r.belowMin && <Chip tone="warn">ниже минимума</Chip>}
        </div>
      ),
    },
    { key: 'batches', header: 'Партий', align: 'right', cell: (r) => <span className="num">{formatNumber(r.batches)}</span> },
    { key: 'value', header: 'Стоимость', align: 'right', cell: (r) => <span className="num">{formatMoneyWhole(r.value)}</span> },
  ];

  const batchColumns: Column<BatchDto>[] = [
    {
      key: 'name',
      header: 'Продукт',
      cell: (b) => (
        <>
          <strong>{b.productName}</strong>
          <span className={styles.sub}>
            {b.sku}
            {b.supplierName ? ` · ${b.supplierName}` : ''}
          </span>
        </>
      ),
    },
    ...(hideLocation ? [] : [{ key: 'loc', header: 'Точка', cell: (b: BatchDto) => b.locationName }]),
    { key: 'received', header: 'Принято', cell: (b) => <span className="num">{fmtDate(b.receivedOn)}</span> },
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
    { key: 'life', header: 'Срок', cell: (b) => <LifeBar elapsed={b.lifeElapsed} status={b.status} />, width: '76px' },
    {
      key: 'qty',
      header: 'Остаток',
      align: 'right',
      cell: (b) => (
        <>
          <span className="num">{formatQty(b.remainingQty, b.unit)}</span>
          <span className={styles.sub}>из {formatNumber(b.initialQty)}</span>
        </>
      ),
    },
    { key: 'cost', header: 'Себест.', align: 'right', cell: (b) => <span className="num">{formatMoney(b.unitCost)}</span> },
    { key: 'value', header: 'Стоимость', align: 'right', cell: (b) => <span className="num">{formatMoneyWhole(b.value)}</span> },
    {
      key: 'status',
      header: 'Статус',
      cell: (b) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusChip status={b.status} />
          {b.promotion && <Chip tone="info">−{b.promotion.percent}%</Chip>}
        </div>
      ),
    },
  ];

  const active = showItems ? items : batches;

  return (
    <>
      <PageHeader title="Остатки" subtitle="Сколько чего есть, что скоро испортится и чего не хватает. Строка открывает партии, расход и историю." />
      <Tabs
        label="Вид остатков"
        value={showItems ? 'items' : 'batches'}
        onChange={(v) => setUrl({ tab: v, offset: '0' })}
        items={[
          { value: 'items', label: 'Позиции' },
          { value: 'batches', label: 'Партии' },
        ]}
      />
      <Panel>
        <Toolbar>
          <div className={styles.search} style={{ position: 'relative' }}>
            <Search size={16} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ink-400)' }} aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Название или артикул" aria-label="Поиск по остаткам" style={{ paddingLeft: 32 }} type="search" />
          </div>
          {showItems ? (
            <>
              <Select className={styles.filter} value={url.category} onChange={(e) => setUrl({ category: e.target.value })} aria-label="Категория">
                <option value="">Все категории</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Segmented<Flag>
                label="Фильтр по состоянию"
                value={(url.flag as Flag) || 'all'}
                onChange={(v) => setUrl({ flag: v })}
                items={[
                  { value: 'all', label: 'Все' },
                  { value: 'low', label: 'Ниже минимума' },
                  { value: 'expiring', label: 'Истекают' },
                  { value: 'expired', label: 'Просрочены' },
                ]}
              />
            </>
          ) : (
            <Segmented<BatchFilter>
              label="Фильтр партий"
              value={url.status as BatchFilter}
              onChange={(v) => setUrl({ status: v })}
              items={[
                { value: 'active', label: 'С остатком' },
                { value: 'expiring', label: 'Истекают' },
                { value: 'expired', label: 'Просрочены' },
                { value: 'depleted', label: 'Израсходованы' },
              ]}
            />
          )}
        </Toolbar>
        {active.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={active.error} onRetry={() => void active.refetch()} />
          </div>
        ) : showItems ? (
          <DataTable columns={itemColumns} rows={items.data?.items} rowKey={(r) => `${r.productId}|${r.locationId}`} loading={items.isLoading} onRowClick={setSelected} caption="Остатки по позициям" empty="Нет позиций по этим условиям" />
        ) : (
          <DataTable
            columns={batchColumns}
            rows={batches.data?.items}
            rowKey={(b) => b.id}
            loading={batches.isLoading}
            caption="Партии"
            empty="Нет партий по этим условиям"
          />
        )}
        {active.data && <Pagination total={active.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
      </Panel>
      <StockDetailDialog key={selected ? `${selected.productId}|${selected.locationId}` : 'none'} row={selected} onClose={() => setSelected(null)} />
    </>
  );
}
