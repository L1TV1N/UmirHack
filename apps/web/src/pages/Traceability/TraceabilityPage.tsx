import { formatQty, VSD_REDEEM_HOURS, type MarkBatchDto, type Page, type TraceabilitySummaryDto, type VsdDto } from '@zapas/shared';
import { Download, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { downloadFile, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, Input } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { Segmented, Tabs } from '../../components/Tabs/Tabs';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useUrlState } from '../../lib/useUrlState';
import styles from './Traceability.module.scss';

const LIMIT = 50;
type Tab = 'vsd' | 'marks';
type Status = 'pending' | 'redeemed';

function timeLeft(v: VsdDto): { tone: 'danger' | 'warn' | 'ok'; text: string } {
  const hours = (new Date(v.dueAt).getTime() - Date.now()) / 3_600_000;
  if (v.overdue || hours < 0) {
    const late = Math.max(1, Math.round(-hours));
    return { tone: 'danger', text: late >= 48 ? `просрочен на ${Math.round(late / 24)} дн.` : `просрочен на ${late} ч` };
  }
  const left = Math.max(1, Math.ceil(hours));
  return { tone: left <= 6 ? 'warn' : 'ok', text: `осталось ${left} ч` };
}

export default function TraceabilityPage() {
  const { can } = useAuth();
  const scope = useScope();
  const toast = useToast();
  const [url, setUrl] = useUrlState({ tab: 'vsd', status: 'pending', offset: '0' });
  const tab: Tab = url.tab === 'marks' ? 'marks' : 'vsd';
  const status: Status = url.status === 'redeemed' ? 'redeemed' : 'pending';
  const offset = Number(url.offset) || 0;
  const [redeeming, setRedeeming] = useState<VsdDto | null>(null);
  const [comment, setComment] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    document.title = 'Прослеживаемость — Запас';
  }, []);

  const query = { ...(scope.locationId ? { locationId: scope.locationId } : {}), limit: LIMIT, offset };
  const summary = useGet<TraceabilitySummaryDto>('/traceability/summary');
  const vsd = useGet<Page<VsdDto>>('/traceability/vsd', { ...query, status }, { enabled: tab === 'vsd' });
  const marks = useGet<Page<MarkBatchDto>>('/traceability/marks', query, { enabled: tab === 'marks' });

  const redeem = useAction(({ id, note }: { id: string; note: string }) => post<void>(`/traceability/vsd/${id}/redeem`, note ? { comment: note } : {}), ['/traceability']);
  const reopen = useAction((id: string) => post<void>(`/traceability/vsd/${id}/reopen`), ['/traceability']);

  const confirmRedeem = () => {
    if (!redeeming) return;
    redeem.mutate(
      { id: redeeming.id, note: comment.trim() },
      {
        onSuccess: () => {
          toast.success('ВСД отмечен погашенным');
          setRedeeming(null);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const exportMarks = async () => {
    setExporting(true);
    try {
      await downloadFile('/reports/marks.csv', { locationId: scope.locationId }, 'marks.csv');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(false);
    }
  };

  const vsdColumns: Column<VsdDto>[] = [
    { key: 'number', header: 'Номер ВСД', cell: (v) => <code className={styles.number}>{v.number}</code> },
    {
      key: 'product',
      header: 'Продукт',
      cell: (v) => (
        <>
          <strong>{v.productName}</strong>
          <span className={styles.sub}>
            {formatQty(v.quantity, v.unit)}
            {v.supplierName ? ` · ${v.supplierName}` : ''}
            {v.documentNumber ? ` · ${v.documentNumber}` : ''}
          </span>
        </>
      ),
    },
    { key: 'location', header: 'Точка', cell: (v) => v.locationName },
    { key: 'received', header: 'Принят', cell: (v) => fmtDateTime(v.receivedAt) },
    {
      key: 'due',
      header: status === 'pending' ? 'Срок погашения' : 'Погашен',
      cell: (v) => {
        if (v.status === 'redeemed') {
          return (
            <>
              <span>{v.redeemedAt ? fmtDateTime(v.redeemedAt) : '—'}</span>
              <span className={styles.sub}>{[v.redeemedBy, v.comment].filter(Boolean).join(' · ')}</span>
            </>
          );
        }
        const t = timeLeft(v);
        return (
          <>
            <span>{fmtDateTime(v.dueAt)}</span>
            <Chip tone={t.tone}>{t.text}</Chip>
          </>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (v) =>
        v.status === 'pending' ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setComment('');
              setRedeeming(v);
            }}
          >
            Погашен в «Меркурии»
          </Button>
        ) : can('manager') ? (
          <Button size="sm" icon={<Undo2 size={14} />} loading={reopen.isPending && reopen.variables === v.id} onClick={() => reopen.mutate(v.id, { onError: (err) => toast.error(errorMessage(err)) })}>
            Вернуть в очередь
          </Button>
        ) : null,
    },
  ];

  const markColumns: Column<MarkBatchDto>[] = [
    {
      key: 'product',
      header: 'Продукт',
      cell: (m) => (
        <>
          <strong>{m.productName}</strong>
          <span className={styles.sub}>
            {m.supplierName ?? 'поставщик не указан'}
            {m.documentNumber ? ` · ${m.documentNumber}` : ''}
          </span>
        </>
      ),
    },
    { key: 'location', header: 'Точка', cell: (m) => m.locationName },
    { key: 'received', header: 'Принято', cell: (m) => fmtDate(m.receivedOn) },
    { key: 'marks', header: 'Марок', align: 'right', cell: (m) => <span className="num">{m.marks}</span> },
    { key: 'remaining', header: 'Остаток партии', align: 'right', cell: (m) => <span className="num">{formatQty(m.remaining, m.unit)}</span> },
    {
      key: 'disposed',
      header: 'Должно выбыть',
      align: 'right',
      cell: (m) => (m.disposed === null ? <span className="muted">—</span> : m.disposed > 0 ? <Chip tone="amber">{m.disposed} шт.</Chip> : <span className="muted">0</span>),
    },
  ];

  const s = summary.data;
  const where = scope.locationId ? scope.nameOf(scope.locationId) : 'все точки';

  return (
    <>
      <PageHeader
        title="Прослеживаемость"
        subtitle={`ВСД «Меркурия» и марки «Честного знака». Точка: ${where}. Запас ведёт реестр и напоминает о сроках, а гасить документы нужно в самих государственных системах.`}
        actions={
          tab === 'marks' &&
          can('manager') && (
            <Button icon={<Download size={16} />} loading={exporting} onClick={() => void exportMarks()}>
              Выгрузить марки (CSV)
            </Button>
          )
        }
      />

      {s && (s.vsdPending > 0 || s.vsdOverdue > 0) && (
        <div className={styles.summary} role="status">
          {s.vsdOverdue > 0 && <Chip tone="danger" dot>просрочено погашений: {s.vsdOverdue}</Chip>}
          <Chip tone={s.vsdPending > s.vsdOverdue ? 'amber' : 'neutral'} dot>ждут погашения: {s.vsdPending}</Chip>
          <span className="muted">Срок на погашение после приёмки: {VSD_REDEEM_HOURS} ч</span>
        </div>
      )}

      <Tabs<Tab>
        label="Разделы прослеживаемости"
        value={tab}
        onChange={(v) => setUrl({ tab: v, offset: '0' })}
        items={[
          { value: 'vsd', label: s && s.vsdPending > 0 ? `ВСД (${s.vsdPending})` : 'ВСД' },
          { value: 'marks', label: s && s.marksTotal > 0 ? `Марки (${s.marksTotal})` : 'Марки' },
        ]}
      />

      {tab === 'vsd' && (
        <Panel>
          <Toolbar>
            <Segmented<Status>
              label="Статус ВСД"
              value={status}
              onChange={(v) => setUrl({ status: v, offset: '0' })}
              items={[
                { value: 'pending', label: 'Ждут погашения' },
                { value: 'redeemed', label: 'Погашены' },
              ]}
            />
          </Toolbar>
          {vsd.isError ? (
            <div style={{ padding: 16 }}>
              <ErrorNote error={vsd.error} onRetry={() => void vsd.refetch()} />
            </div>
          ) : (
            <DataTable
              columns={vsdColumns}
              rows={vsd.data?.items}
              rowKey={(v) => v.id}
              loading={vsd.isLoading}
              caption="Ветеринарные сопроводительные документы"
              rowClass={(v) => (v.overdue ? styles.overdue : undefined)}
              empty={status === 'pending' ? 'Все ВСД погашены. Номер вводится при приходе, в строке продукта.' : 'Погашенных ВСД пока нет'}
            />
          )}
          {vsd.data && <Pagination total={vsd.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
        </Panel>
      )}

      {tab === 'marks' && (
        <Panel>
          {marks.isError ? (
            <div style={{ padding: 16 }}>
              <ErrorNote error={marks.error} onRetry={() => void marks.refetch()} />
            </div>
          ) : (
            <DataTable
              columns={markColumns}
              rows={marks.data?.items}
              rowKey={(m) => m.batchId}
              loading={marks.isLoading}
              caption="Партии с принятыми марками"
              empty="Марки появятся после прихода, где отсканированы коды маркировки"
            />
          )}
          {marks.data && <Pagination total={marks.data.total} limit={LIMIT} offset={offset} onChange={(o) => setUrl({ offset: String(o) })} />}
        </Panel>
      )}

      <Dialog
        open={redeeming !== null}
        onClose={() => setRedeeming(null)}
        title="Отметить ВСД погашенным"
        subtitle="Сначала погасите документ в «Меркурии». Здесь только отметка, что это сделано"
        width={520}
        footer={
          <>
            <Button onClick={() => setRedeeming(null)}>Отмена</Button>
            <Button variant="primary" loading={redeem.isPending} onClick={confirmRedeem}>
              Отметить погашенным
            </Button>
          </>
        }
      >
        {redeeming && (
          <div className={styles.dialog}>
            <code className={styles.number}>{redeeming.number}</code>
            <span>
              {redeeming.productName}, {formatQty(redeeming.quantity, redeeming.unit)}, {redeeming.locationName}
            </span>
            <Field label="Комментарий" hint="Необязательно, например кто погасил и во сколько">
              {(p) => <Input {...p} value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} />}
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
