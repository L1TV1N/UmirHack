import { formatMoney, formatQty, UNIT_LABELS, type CategoryDto, type Page, type ProductDto } from '@zapas/shared';
import { FileSpreadsheet, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { useUrlState } from '../../lib/useUrlState';
import { CategoriesPanel, SuppliersPanel } from './Directories';
import { ImportDialog } from './ImportDialog';
import { ProductDialog } from './ProductDialog';

const LIMIT = 50;
type Tab = 'products' | 'categories' | 'suppliers';

export default function ProductsPage() {
  const { can } = useAuth();
  const [url, setUrl] = useUrlState({ tab: 'products', q: '', category: '', state: 'active', offset: '0' });
  const [search, setSearch] = useState(url.q);
  const debounced = useDebouncedValue(search, 300);
  const [editing, setEditing] = useState<ProductDto | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const offset = Number(url.offset) || 0;
  const tab: Tab = url.tab === 'categories' || url.tab === 'suppliers' ? url.tab : 'products';

  useEffect(() => {
    document.title = 'Номенклатура - Запас';
  }, []);
  useEffect(() => {
    if (debounced !== url.q) setUrl({ q: debounced });
  }, [debounced, url.q, setUrl]);

  const categories = useGet<CategoryDto[]>('/categories', undefined, { staleTime: 120_000 });
  const products = useGet<Page<ProductDto>>(
    '/products',
    { q: url.q, categoryId: url.category, ...(url.state === 'active' ? { active: true } : url.state === 'off' ? { active: false } : {}), limit: LIMIT, offset },
    { enabled: tab === 'products' },
  );

  const columns: Column<ProductDto>[] = [
    {
      key: 'name',
      header: 'Продукт',
      cell: (p) => (
        <>
          <strong>{p.name}</strong>
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            {p.sku}
            {p.barcode ? ` · ${p.barcode}` : ''}
          </span>
        </>
      ),
    },
    { key: 'cat', header: 'Категория', cell: (p) => p.categoryName },
    { key: 'unit', header: 'Ед.', cell: (p) => UNIT_LABELS[p.unit] },
    { key: 'cost', header: 'Себестоимость', align: 'right', cell: (p) => <span className="num">{formatMoney(p.cost)}</span> },
    { key: 'price', header: 'Цена', align: 'right', cell: (p) => (p.sellable ? <span className="num">{formatMoney(p.price)}</span> : <span className="muted">-</span>) },
    { key: 'min', header: 'Минимум', align: 'right', cell: (p) => (p.minStock > 0 ? <span className="num">{formatQty(p.minStock, p.unit)}</span> : <span className="muted">-</span>) },
    { key: 'shelf', header: 'Срок, суток', align: 'right', cell: (p) => (p.shelfLifeDays ? <span className="num">{p.shelfLifeDays}</span> : <span className="muted">-</span>) },
    {
      key: 'state',
      header: 'Статус',
      cell: (p) => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip tone={p.isActive ? 'ok' : 'neutral'}>{p.isActive ? 'Активен' : 'Отключён'}</Chip>
          {!p.sellable && <Chip>ингредиент</Chip>}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Номенклатура"
        subtitle="Продукты, категории и поставщики. Цены и сроки из карточки подставляются при приходе и продаже."
        actions={
          can('manager') &&
          tab === 'products' && (
            <>
              <Button icon={<FileSpreadsheet size={16} />} onClick={() => setImporting(true)}>
                Импорт из CSV
              </Button>
              <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
                Новый продукт
              </Button>
            </>
          )
        }
      />
      <Tabs<Tab>
        label="Справочники"
        value={tab}
        onChange={(v) => setUrl({ tab: v, offset: '0' })}
        items={[
          { value: 'products', label: 'Продукты' },
          { value: 'categories', label: 'Категории' },
          { value: 'suppliers', label: 'Поставщики' },
        ]}
      />
      {tab === 'categories' && <CategoriesPanel />}
      {tab === 'suppliers' && <SuppliersPanel />}
      {tab === 'products' && (
        <Panel>
          <Toolbar>
            <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 340 }}>
              <Search size={16} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--ink-400)' }} aria-hidden="true" />
              <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Название, артикул, штрихкод" aria-label="Поиск продуктов" style={{ paddingLeft: 32 }} />
            </div>
            <Select value={url.category} onChange={(e) => setUrl({ category: e.target.value })} aria-label="Категория" style={{ width: 'auto', minWidth: 180 }}>
              <option value="">Все категории</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select value={url.state} onChange={(e) => setUrl({ state: e.target.value })} aria-label="Статус" style={{ width: 'auto', minWidth: 150 }}>
              <option value="active">Активные</option>
              <option value="off">Отключённые</option>
              <option value="all">Все</option>
            </Select>
          </Toolbar>
          {products.isError ? (
            <div style={{ padding: 16 }}>
              <ErrorNote error={products.error} onRetry={() => void products.refetch()} />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={products.data?.items}
              rowKey={(p) => p.id}
              loading={products.isLoading}
              onRowClick={can('manager') ? setEditing : undefined}
              caption="Продукты"
              empty="Продукты не найдены"
            />
          )}
          {products.data && <Pagination total={products.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
        </Panel>
      )}
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
      <ProductDialog open={editing !== null} product={editing && editing !== 'new' ? editing : null} categories={categories.data ?? []} onClose={() => setEditing(null)} />
    </>
  );
}
