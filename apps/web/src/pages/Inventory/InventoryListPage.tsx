import { INVENTORY_STATUS_LABELS, type InventoryDto, type InventoryStatus, type Page } from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';
import styles from './Inventory.module.scss';

const LIMIT = 25;
const TONE: Record<InventoryStatus, Tone> = { draft: 'amber', committed: 'ok', cancelled: 'neutral' };

export default function InventoryListPage() {
  const { can } = useAuth();
  const scope = useScope();
  const navigate = useNavigate();
  const toast = useToast();
  const [url, setUrl] = useUrlState({ offset: '0' });
  const offset = Number(url.offset) || 0;
  const [creating, setCreating] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useGet<Page<InventoryDto>>('/inventories', { locationId: scope.locationId, limit: LIMIT, offset });
  const create = useAction((body: object) => post<InventoryDto>('/inventories', body), ['/inventories']);

  useEffect(() => {
    document.title = 'Инвентаризация — Запас';
  }, []);

  const options = scope.activeLocations;
  const chosen = locationId || scope.locationId || options[0]?.id || '';

  const start = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate(
      { locationId: chosen, ...(comment.trim() ? { comment: comment.trim() } : {}) },
      {
        onSuccess: (inv) => {
          toast.success('Инвентаризация начата');
          setCreating(false);
          navigate(`/inventory/${inv.id}`);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const columns: Column<InventoryDto>[] = [
    { key: 'when', header: 'Начата', cell: (i) => <span className="num">{fmtDateTime(i.createdAt)}</span> },
    { key: 'loc', header: 'Точка', cell: (i) => <strong>{i.locationName}</strong> },
    { key: 'status', header: 'Статус', cell: (i) => <Chip tone={TONE[i.status]}>{INVENTORY_STATUS_LABELS[i.status]}</Chip> },
    {
      key: 'progress',
      header: 'Посчитано',
      cell: (i) => (
        <div className={styles.progress}>
          <span className={styles.bar}>
            <span style={{ width: `${i.linesTotal ? (i.linesCounted / i.linesTotal) * 100 : 0}%` }} />
          </span>
          <span className="num">
            {i.linesCounted} из {i.linesTotal}
          </span>
        </div>
      ),
    },
    { key: 'author', header: 'Автор', cell: (i) => i.authorName },
    { key: 'closed', header: 'Проведена', cell: (i) => (i.committedAt ? <span className="num">{fmtDateTime(i.committedAt)}</span> : <span className="muted">—</span>) },
    { key: 'comment', header: 'Комментарий', cell: (i) => <span className="muted">{i.comment ?? ''}</span> },
  ];

  return (
    <>
      <PageHeader
        title="Инвентаризация"
        subtitle="Пересчёт остатков на точке. Недостача списывается, излишек оформляется новой партией со сроком годности."
        actions={
          can('storekeeper') && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              Начать инвентаризацию
            </Button>
          )
        }
      />
      <Panel>
        {list.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={list.data?.items} rowKey={(i) => i.id} loading={list.isLoading} onRowClick={(i) => navigate(`/inventory/${i.id}`)} caption="Инвентаризации" empty="Инвентаризаций пока не было" />
        )}
        {list.data && <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
      </Panel>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Новая инвентаризация"
        subtitle="Система зафиксирует ожидаемые остатки на точке"
        width={440}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Отмена</Button>
            <Button variant="primary" type="submit" form="inventory-new" loading={create.isPending}>
              Начать
            </Button>
          </>
        }
      >
        <form id="inventory-new" onSubmit={start} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
          <Field label="Комментарий">{(p) => <Input {...p} value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} />}</Field>
          {error && <ErrorNote message={error} />}
        </form>
      </Dialog>
    </>
  );
}
