import { formatMoney, formatQty, ORDER_STATUS_LABELS, type OrderDto, type OrderSuggestionDto, type OrderSuggestionLineDto, type Page } from '@zapas/shared';
import { Mail, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { EmptyState, ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { Segmented, Tabs } from '../../components/Tabs/Tabs';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';
import { OrderDialog, STATUS_TONE } from './OrderDialog';
import styles from './Orders.module.scss';

const LIMIT = 30;
type Tab = 'suggest' | 'orders';
type Filter = 'open' | 'draft' | 'received' | 'all';

const lineColumns: Column<OrderSuggestionLineDto>[] = [
  {
    key: 'product',
    header: 'Продукт',
    cell: (l) => (
      <>
        <strong>{l.productName}</strong>
        <span className={styles.sub}>{l.sku}</span>
      </>
    ),
  },
  { key: 'qty', header: 'Заказать', align: 'right', cell: (l) => <strong className="num">{formatQty(l.quantity, l.unit)}</strong> },
  { key: 'cost', header: 'Цена', align: 'right', cell: (l) => <span className="num">{formatMoney(l.unitCost)}</span> },
  { key: 'sum', header: 'Сумма', align: 'right', cell: (l) => <span className="num">{formatMoney(l.sum)}</span> },
  {
    key: 'now',
    header: 'Сейчас',
    align: 'right',
    cell: (l) => (
      <>
        <span className="num">{formatQty(l.available, l.unit)}</span>
        {l.incoming > 0 && <span className={styles.sub}>ещё в пути {formatQty(l.incoming, l.unit)}</span>}
      </>
    ),
  },
  { key: 'why', header: 'Почему', cell: (l) => <span className={styles.reason}>{l.reason}</span> },
];

function Suggestion({ group, onOpen }: { group: OrderSuggestionDto; onOpen: (id: string) => void }) {
  const toast = useToast();
  const create = useAction(() => post<{ id: string }>('/orders/from-suggestion', { supplierId: group.supplierId, locationId: group.locationId }), ['/orders']);
  const make = () =>
    create.mutate(undefined, {
      onSuccess: (o) => onOpen(o.id),
      onError: (err) => {
        // черновик уже есть: открываем его, а не пугаем ошибкой
        if (err instanceof ApiError && err.code === 'draft_exists' && typeof (err.details as { orderId?: string } | undefined)?.orderId === 'string') onOpen((err.details as { orderId: string }).orderId);
        else toast.error(errorMessage(err));
      },
    });

  return (
    <Panel
      title={`${group.supplierName} · ${group.locationName}`}
      subtitle={`${group.lines.length} поз. на ${formatMoney(group.total)}, поставка занимает ${group.leadTimeDays === 0 ? 'меньше суток' : `${group.leadTimeDays} сут.`}`}
      actions={
        group.draftId ? (
          <Button size="sm" onClick={() => onOpen(group.draftId as string)}>
            Открыть черновик
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Plus size={15} />} loading={create.isPending} onClick={make}>
            Создать черновик
          </Button>
        )
      }
    >
      <div className={styles.chips}>
        {group.belowMinimum && <Chip tone="amber">до минимального заказа {formatMoney(group.minOrderSum)} не хватает {formatMoney(Math.round((group.minOrderSum - group.total) * 100) / 100)}</Chip>}
        {!group.supplierEmail && (
          <Chip tone="neutral" title="В справочнике поставщиков можно указать почту: тогда заказ уйдёт письмом">
            <Mail size={12} aria-hidden="true" /> почта не указана
          </Chip>
        )}
      </div>
      <DataTable columns={lineColumns} rows={group.lines} rowKey={(l) => l.productId} caption={`Что заказать у ${group.supplierName}`} dense />
    </Panel>
  );
}

export default function OrdersPage() {
  const navigate = useNavigate();
  const scope = useScope();
  const [url, setUrl] = useUrlState({ tab: 'suggest', filter: 'open', offset: '0' });
  const tab: Tab = url.tab === 'orders' ? 'orders' : 'suggest';
  const filter: Filter = url.filter === 'draft' || url.filter === 'received' || url.filter === 'all' ? url.filter : 'open';
  const offset = Number(url.offset) || 0;
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Заказы - Запас';
  }, []);

  const where = scope.locationId ? { locationId: scope.locationId } : {};
  const suggestions = useGet<OrderSuggestionDto[]>('/orders/suggestions', where, { enabled: tab === 'suggest' });
  const orders = useGet<Page<OrderDto>>('/orders', { ...where, status: filter, limit: LIMIT, offset }, { enabled: tab === 'orders' });
  const drafts = useGet<Page<OrderDto>>('/orders', { ...where, status: 'draft', limit: 1 });

  const columns: Column<OrderDto>[] = [
    {
      key: 'number',
      header: 'Заказ',
      cell: (o) => (
        <>
          <strong>{o.number}</strong>
          <span className={styles.sub}>{fmtDateTime(o.createdAt)}</span>
        </>
      ),
    },
    { key: 'supplier', header: 'Поставщик', cell: (o) => o.supplierName },
    { key: 'loc', header: 'Точка', cell: (o) => o.locationName },
    { key: 'lines', header: 'Позиций', align: 'right', cell: (o) => <span className="num">{o.lines}</span> },
    { key: 'total', header: 'Сумма', align: 'right', cell: (o) => <span className="num">{formatMoney(o.total)}</span> },
    { key: 'expected', header: 'Ждём к', cell: (o) => (o.expectedOn ? fmtDate(o.expectedOn) : <span className="muted">-</span>) },
    { key: 'status', header: 'Статус', cell: (o) => <Chip tone={STATUS_TONE[o.status]}>{ORDER_STATUS_LABELS[o.status]}</Chip> },
  ];

  const draftCount = drafts.data?.total ?? 0;
  const where_ = scope.locationId ? scope.nameOf(scope.locationId) : 'все точки';

  return (
    <>
      <PageHeader
        title="Заказы поставщикам"
        subtitle={`Что и сколько заказать считается по остаткам, скорости продаж и сроку поставки, с учётом уже заказанного. Точка: ${where_}. Отправляет заказ человек.`}
      />
      <Tabs<Tab>
        label="Разделы заказов"
        value={tab}
        onChange={(v) => setUrl({ tab: v, offset: '0' })}
        items={[
          { value: 'suggest', label: 'Что заказать' },
          { value: 'orders', label: draftCount > 0 ? `Заказы (черновиков ${draftCount})` : 'Заказы' },
        ]}
      />

      {tab === 'suggest' &&
        (suggestions.isError ? (
          <ErrorNote error={suggestions.error} onRetry={() => void suggestions.refetch()} />
        ) : suggestions.data && suggestions.data.length === 0 ? (
          <EmptyState title="Сейчас ничего заказывать не нужно">
            Остатков хватает до следующей поставки. Продукты попадают в расчёт, если в их карточке указан поставщик по умолчанию: <Link to="/products">Номенклатура</Link>.
          </EmptyState>
        ) : (
          <div className={styles.groups}>
            {(suggestions.data ?? []).map((g) => (
              <Suggestion key={`${g.supplierId}|${g.locationId}`} group={g} onOpen={setOpenId} />
            ))}
          </div>
        ))}

      {tab === 'orders' && (
        <Panel>
          <div style={{ padding: '12px 16px' }}>
            <Segmented<Filter>
              label="Какие заказы показать"
              value={filter}
              onChange={(v) => setUrl({ filter: v, offset: '0' })}
              items={[
                { value: 'open', label: 'Ждём поставку' },
                { value: 'draft', label: 'Черновики' },
                { value: 'received', label: 'Принятые' },
                { value: 'all', label: 'Все' },
              ]}
            />
          </div>
          {orders.isError ? (
            <div style={{ padding: 16 }}>
              <ErrorNote error={orders.error} onRetry={() => void orders.refetch()} />
            </div>
          ) : (
            <DataTable columns={columns} rows={orders.data?.items} rowKey={(o) => o.id} loading={orders.isLoading} onRowClick={(o) => setOpenId(o.id)} caption="Заказы поставщикам" empty="Заказов пока нет" />
          )}
          {orders.data && <Pagination total={orders.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
        </Panel>
      )}

      <OrderDialog orderId={openId} onClose={() => setOpenId(null)} onReceive={(id) => navigate(`/operations?tab=receipt&order=${id}`)} />
    </>
  );
}
