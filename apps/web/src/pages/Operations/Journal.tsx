import {
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  formatMoney,
  formatQty,
  MOVEMENT_TYPE_LABELS,
  WRITEOFF_REASON_LABELS,
  type DocumentDetailDto,
  type DocumentDto,
  type DocumentKind,
  type MovementDto,
  type Page,
} from '@zapas/shared';
import { useState } from 'react';
import { useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { Toolbar } from '../../components/Panel/Panel';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';

const LIMIT = 30;

const KIND_TONE: Record<DocumentKind, Tone> = {
  receipt: 'ok',
  sale: 'info',
  writeoff: 'danger',
  transfer: 'amber',
  inventory: 'neutral',
};

function DocumentDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const doc = useGet<DocumentDetailDto>(`/documents/${id ?? 'none'}`, undefined, { enabled: Boolean(id) });
  const d = doc.data;
  const columns: Column<MovementDto>[] = [
    { key: 'type', header: 'Операция', cell: (m) => MOVEMENT_TYPE_LABELS[m.type] },
    { key: 'product', header: 'Продукт', cell: (m) => <strong>{m.productName}</strong> },
    { key: 'loc', header: 'Точка', cell: (m) => m.locationName },
    { key: 'exp', header: 'Годен до', cell: (m) => <span className="num">{fmtDate(m.expiresOn)}</span> },
    { key: 'qty', header: 'Количество', align: 'right', cell: (m) => formatQty(m.quantity, m.unit) },
    { key: 'cost', header: 'Себест.', align: 'right', cell: (m) => <span className="num">{formatMoney(m.unitCost)}</span> },
    { key: 'price', header: 'Цена', align: 'right', cell: (m) => (m.unitPrice === null ? <span className="muted">—</span> : <span className="num">{formatMoney(m.unitPrice)}</span>) },
    { key: 'reason', header: 'Причина', cell: (m) => (m.reason ? WRITEOFF_REASON_LABELS[m.reason] : m.dishName ? `Блюдо: ${m.dishName}` : <span className="muted">—</span>) },
  ];
  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      title={d ? `${DOCUMENT_KIND_LABELS[d.kind]} ${d.number}` : 'Документ'}
      subtitle={d ? `${d.locationName} · ${fmtDateTime(d.createdAt)} · ${d.authorName}` : undefined}
      width={960}
    >
      {doc.isError && <ErrorNote error={doc.error} />}
      {d?.comment && <p style={{ color: 'var(--ink-700)' }}>{d.comment}</p>}
      <div style={{ border: '1px solid var(--line)', borderRadius: 6, overflow: 'hidden' }}>
        <DataTable dense columns={columns} rows={d?.movements} rowKey={(m) => m.id} loading={doc.isLoading} />
      </div>
    </Dialog>
  );
}

export function Journal() {
  const scope = useScope();
  const [url, setUrl] = useUrlState({ kind: '', from: '', to: '', offset: '0' });
  const [open, setOpen] = useState<string | null>(null);
  const offset = Number(url.offset) || 0;
  const docs = useGet<Page<DocumentDto>>('/documents', { locationId: scope.locationId, kind: url.kind, from: url.from, to: url.to, limit: LIMIT, offset });

  const columns: Column<DocumentDto>[] = [
    { key: 'number', header: 'Документ', cell: (d) => <span className="mono">{d.number}</span> },
    { key: 'kind', header: 'Вид', cell: (d) => <Chip tone={KIND_TONE[d.kind]}>{DOCUMENT_KIND_LABELS[d.kind]}</Chip> },
    { key: 'when', header: 'Когда', cell: (d) => <span className="num">{fmtDateTime(d.createdAt)}</span> },
    { key: 'loc', header: 'Точка', cell: (d) => d.locationName },
    { key: 'lines', header: 'Строк', align: 'right', cell: (d) => <span className="num">{d.lines}</span> },
    { key: 'sum', header: 'По себестоимости', align: 'right', cell: (d) => <span className="num">{formatMoney(d.totalAmount)}</span> },
    { key: 'who', header: 'Автор', cell: (d) => d.authorName },
    { key: 'note', header: 'Комментарий', cell: (d) => <span className="muted">{d.comment ?? ''}</span> },
  ];

  return (
    <>
      <Toolbar>
        <div style={{ minWidth: 180 }}>
          <Select aria-label="Вид документа" value={url.kind} onChange={(e) => setUrl({ kind: e.target.value })}>
            <option value="">Все виды</option>
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <FieldRow cols={2}>
          <Field label="С">{(p) => <Input {...p} type="date" value={url.from} onChange={(e) => setUrl({ from: e.target.value })} />}</Field>
          <Field label="По">{(p) => <Input {...p} type="date" value={url.to} onChange={(e) => setUrl({ to: e.target.value })} />}</Field>
        </FieldRow>
      </Toolbar>
      {docs.isError ? (
        <div style={{ padding: 16 }}>
          <ErrorNote error={docs.error} onRetry={() => void docs.refetch()} />
        </div>
      ) : (
        <DataTable columns={columns} rows={docs.data?.items} rowKey={(d) => d.id} loading={docs.isLoading} onRowClick={(d) => setOpen(d.id)} caption="Журнал документов" empty="Документов за выбранный период нет" />
      )}
      {docs.data && <Pagination total={docs.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
      <DocumentDialog id={open} onClose={() => setOpen(null)} />
    </>
  );
}
