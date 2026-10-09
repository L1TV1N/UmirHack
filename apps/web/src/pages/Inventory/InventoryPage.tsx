import {
  formatMoney,
  formatMoneyWhole,
  formatQty,
  INVENTORY_STATUS_LABELS,
  UNIT_LABELS,
  type InventoryDetailDto,
  type InventoryLineDto,
} from '@zapas/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { post, put } from '../../api/client';
import { useAction, useGet, STOCK_PREFIXES } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Input } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { PageHeader, Panel, Toolbar } from '../../components/Panel/Panel';
import { ScanButton, type ScanHit } from '../../components/Scanner/ScanButton';
import type { ScanFeedback } from '../../components/Scanner/ScannerDialog';
import { Segmented } from '../../components/Tabs/Tabs';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime, parseDecimal, todayLocal } from '../../lib/format';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard';
import styles from './Inventory.module.scss';

interface Edit {
  counted: string;
  surplus: string;
}

type View = 'all' | 'diff' | 'open';

function initial(lines: InventoryLineDto[]): Record<string, Edit> {
  return Object.fromEntries(lines.map((l) => [l.productId, { counted: l.countedQty === null ? '' : String(l.countedQty), surplus: l.surplusExpiresOn ?? '' }]));
}

export default function InventoryPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const query = useGet<InventoryDetailDto>(`/inventories/${id}`);
  const inv = query.data;
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Инвентаризация — Запас';
  }, []);
  // Фоновое обновление (например, при возврате на вкладку) не должно стирать то, что человек ещё не сохранил
  const serverRef = useRef<Record<string, Edit>>({});
  useEffect(() => {
    if (!inv) return;
    const fresh = initial(inv.lines);
    const known = serverRef.current;
    serverRef.current = fresh;
    setEdits((prev) => {
      const next = { ...fresh };
      for (const [productId, edit] of Object.entries(prev)) {
        const was = known[productId];
        if (was && (edit.counted !== was.counted || edit.surplus !== was.surplus)) next[productId] = edit;
      }
      return next;
    });
  }, [inv]);

  const save = useAction((lines: object[]) => put<InventoryDetailDto>(`/inventories/${id}/lines`, { lines }), [`/inventories`]);
  const commit = useAction(() => post(`/inventories/${id}/commit`), [...STOCK_PREFIXES]);
  const cancel = useAction(() => post(`/inventories/${id}/cancel`), ['/inventories']);

  const editable = inv?.status === 'draft';
  const busy = save.isPending || commit.isPending || cancel.isPending;

  const rows = useMemo(() => {
    if (!inv) return [];
    return inv.lines.map((l) => {
      const e = edits[l.productId] ?? { counted: '', surplus: '' };
      const counted = e.counted.trim() === '' ? null : parseDecimal(e.counted);
      const diff = counted === null ? null : Math.round((counted - l.expectedQty) * 1000) / 1000;
      return { line: l, edit: e, counted, diff };
    });
  }, [inv, edits]);

  const totals = useMemo(() => {
    let shortage = 0;
    let surplus = 0;
    let counted = 0;
    for (const r of rows) {
      if (r.counted !== null) counted += 1;
      if (r.diff !== null && r.diff < 0) shortage += -r.diff * r.line.unitCost;
      if (r.diff !== null && r.diff > 0) surplus += r.diff * r.line.unitCost;
    }
    return { shortage, surplus, counted };
  }, [rows]);

  const shown = rows.filter((r) => {
    if (search && !`${r.line.productName} ${r.line.sku}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (view === 'diff') return r.diff !== null && r.diff !== 0;
    if (view === 'open') return r.counted === null;
    return true;
  });

  const changed = rows.filter((r) => {
    const l = r.line;
    const was = l.countedQty === null ? '' : String(l.countedQty);
    return r.edit.counted.trim() !== was || (r.edit.surplus || '') !== (l.surplusExpiresOn ?? '');
  });

  useUnsavedGuard(editable === true && changed.length > 0, 'Результаты пересчёта, которые вы не сохранили, будут потеряны.');

  const buildPayload = () => {
    for (const r of changed) {
      if (r.edit.counted.trim() !== '' && (r.counted === null || r.counted < 0)) {
        throw new Error(`«${r.line.productName}»: введите количество числом`);
      }
    }
    return changed.map((r) => ({
      productId: r.line.productId,
      countedQty: r.counted,
      ...(r.edit.surplus ? { surplusExpiresOn: r.edit.surplus } : {}),
    }));
  };

  const doSave = async (): Promise<boolean> => {
    setError(null);
    if (changed.length === 0) return true;
    try {
      await save.mutateAsync(buildPayload());
      await query.refetch();
      return true;
    } catch (err) {
      setError(err instanceof Error && !('code' in err) ? err.message : errorMessage(err));
      return false;
    }
  };

  const onSave = async () => {
    if (await doSave()) toast.success('Результаты пересчёта сохранены');
  };

  const onCommit = async () => {
    if (!(await doSave())) return;
    const ok = await confirm({
      title: 'Провести инвентаризацию?',
      message: (
        <>
          Будет посчитано позиций: <strong>{totals.counted}</strong>. Недостача на <strong>{formatMoneyWhole(totals.shortage)}</strong> спишется по сроку годности, излишек на{' '}
          <strong>{formatMoneyWhole(totals.surplus)}</strong> станет новой партией. Это действие нельзя отменить.
        </>
      ),
      confirmLabel: 'Провести',
    });
    if (!ok) return;
    commit.mutate(undefined, {
      onSuccess: () => {
        toast.success('Инвентаризация проведена, остатки скорректированы');
        void query.refetch();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const onCancel = async () => {
    const ok = await confirm({ title: 'Отменить инвентаризацию?', message: 'Введённые результаты будут потеряны, остатки не изменятся.', confirmLabel: 'Отменить инвентаризацию', danger: true });
    if (!ok) return;
    cancel.mutate(undefined, {
      onSuccess: () => {
        toast.success('Инвентаризация отменена');
        void query.refetch();
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  // Копия «сейчас», а не на момент рендера: сканер присылает коды чаще, чем страница успевает перерисоваться
  const latestEdits = useRef(edits);
  latestEdits.current = edits;
  const setEdit = (productId: string, patch: Partial<Edit>) => {
    const next = { ...latestEdits.current, [productId]: { ...(latestEdits.current[productId] ?? { counted: '', surplus: '' }), ...patch } };
    latestEdits.current = next;
    setEdits(next);
  };

  // Скан штучного товара прибавляет единицу к посчитанному. Весовой и объёмный нужно взвесить: окно закрывается
  // и фокус уходит в поле строки
  const onScan = ({ product }: ScanHit): ScanFeedback => {
    if (!editable) return { ok: false, message: 'Инвентаризация закрыта, считать нельзя' };
    const line = inv?.lines.find((l) => l.productId === product.id);
    if (!line) return { ok: false, message: `${product.name}: нет в этой инвентаризации` };
    if (product.unit === 'pcs') {
      const now = latestEdits.current[product.id]?.counted ?? '';
      const next = (now.trim() === '' ? 0 : (parseDecimal(now) ?? 0)) + 1;
      setEdit(product.id, { counted: String(next) });
      return { ok: true, message: `${product.name}: посчитано ${formatQty(next, product.unit)}, по учёту ${formatQty(line.expectedQty, product.unit)}` };
    }
    setView('all');
    setSearch(product.name);
    window.setTimeout(() => document.querySelector<HTMLInputElement>(`[data-count-input="${product.id}"]`)?.focus(), 250);
    return { ok: true, message: `${product.name}: введите количество в строке (${formatQty(line.expectedQty, product.unit)} по учёту)`, close: true };
  };

  type Row = (typeof rows)[number];
  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Продукт',
      cell: (r) => (
        <>
          <strong>{r.line.productName}</strong>
          <span className={styles.sub}>{r.line.sku}</span>
        </>
      ),
    },
    { key: 'expected', header: 'По учёту', align: 'right', cell: (r) => <span className="num">{formatQty(r.line.expectedQty, r.line.unit)}</span> },
    {
      key: 'counted',
      header: 'Фактически',
      align: 'right',
      cell: (r) =>
        editable ? (
          <Input
            numeric
            className={styles.countInput}
            aria-label={`Фактическое количество: ${r.line.productName}`}
            value={r.edit.counted}
            data-count-input={r.line.productId}
            placeholder={UNIT_LABELS[r.line.unit]}
            onChange={(e) => setEdit(r.line.productId, { counted: e.target.value })}
            disabled={busy}
            style={{ marginLeft: 'auto' }}
          />
        ) : r.counted === null ? (
          <span className="muted">не считали</span>
        ) : (
          <span className="num">{formatQty(r.counted, r.line.unit)}</span>
        ),
    },
    {
      key: 'diff',
      header: 'Расхождение',
      align: 'right',
      cell: (r) =>
        r.diff === null || r.diff === 0 ? (
          <span className="muted">{r.diff === 0 ? 'совпало' : '—'}</span>
        ) : (
          <span className={r.diff < 0 ? styles.neg : styles.pos}>
            <strong className="num">
              {r.diff > 0 ? '+' : '−'}
              {formatQty(Math.abs(r.diff), r.line.unit)}
            </strong>
            <span className={styles.sub}>{formatMoney(Math.abs(r.diff) * r.line.unitCost)}</span>
          </span>
        ),
    },
    {
      key: 'surplus',
      header: 'Срок излишка',
      cell: (r) =>
        r.diff !== null && r.diff > 0 ? (
          editable ? (
            <Input
              type="date"
              className={styles.dateInput}
              aria-label={`Срок годности излишка: ${r.line.productName}`}
              min={todayLocal()}
              value={r.edit.surplus}
              onChange={(e) => setEdit(r.line.productId, { surplus: e.target.value })}
              disabled={busy}
              aria-invalid={!r.edit.surplus || undefined}
            />
          ) : (
            <span className="num">{r.line.surplusExpiresOn ?? '—'}</span>
          )
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  if (query.isLoading) return <Loading />;
  if (query.isError || !inv) return <ErrorNote error={query.error} onRetry={() => void query.refetch()} />;

  return (
    <>
      <Link to="/inventory" className={styles.back}>
        ← Все инвентаризации
      </Link>
      <PageHeader
        title={`Инвентаризация: ${inv.locationName}`}
        subtitle={`Начата ${fmtDateTime(inv.createdAt)}, ${inv.authorName}${inv.committedAt ? `. Проведена ${fmtDateTime(inv.committedAt)}` : ''}`}
        actions={<Chip tone={inv.status === 'draft' ? 'amber' : inv.status === 'committed' ? 'ok' : 'neutral'}>{INVENTORY_STATUS_LABELS[inv.status]}</Chip>}
      />

      <dl className={styles.summary}>
        <div>
          <dt>Посчитано</dt>
          <dd>
            {totals.counted} из {rows.length}
          </dd>
        </div>
        <div>
          <dt>Недостача</dt>
          <dd className={totals.shortage > 0 ? styles.neg : ''}>{formatMoneyWhole(totals.shortage)}</dd>
        </div>
        <div>
          <dt>Излишек</dt>
          <dd className={totals.surplus > 0 ? styles.pos : ''}>{formatMoneyWhole(totals.surplus)}</dd>
        </div>
      </dl>

      <Panel>
        <Toolbar>
          <div style={{ flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Найти позицию" aria-label="Найти позицию" />
          </div>
          {editable && <ScanButton onProduct={onScan} title="Сканирование при пересчёте" hint="Каждый скан штучного товара добавляет единицу к посчитанному" />}
          <Segmented<View>
            label="Показать"
            value={view}
            onChange={setView}
            items={[
              { value: 'all', label: 'Все' },
              { value: 'open', label: 'Не посчитаны' },
              { value: 'diff', label: 'С расхождением' },
            ]}
          />
        </Toolbar>
        <DataTable columns={columns} rows={shown} rowKey={(r) => r.line.productId} dense caption="Позиции инвентаризации" empty="Нет позиций по этим условиям" />
        {error && (
          <div style={{ padding: '12px 18px' }}>
            <ErrorNote message={error} />
          </div>
        )}
        {editable && (
          <div className={styles.footer}>
            <span className="muted">{changed.length > 0 ? `Несохранённых изменений: ${changed.length}` : 'Все изменения сохранены'}</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="danger" onClick={() => void onCancel()} loading={cancel.isPending}>
                Отменить инвентаризацию
              </Button>
              <Button onClick={() => void onSave()} loading={save.isPending} disabled={changed.length === 0}>
                Сохранить
              </Button>
              {can('manager') && (
                <Button variant="primary" onClick={() => void onCommit()} loading={commit.isPending} disabled={totals.counted === 0}>
                  Провести
                </Button>
              )}
            </div>
          </div>
        )}
      </Panel>
      {editable && !can('manager') && <p className="muted" style={{ marginTop: 10 }}>Провести инвентаризацию и скорректировать остатки может менеджер.</p>}
    </>
  );
}
