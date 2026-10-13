import {
  POS_VENDOR_LABELS,
  POS_VENDORS,
  posRules,
  type DishDto,
  type LocationDto,
  type PosConnectionCreatedDto,
  type PosConnectionDto,
  type PosInboxDto,
  type PosPresetDto,
  type PosPreviewDto,
  type PosUnmatchedDto,
  type PosVendor,
} from '@zapas/shared';
import { Copy, FlaskConical, Plus, RotateCw, Settings2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, patch, post, put } from '../../api/client';
import { STOCK_PREFIXES, useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Field, Input, Select, Textarea } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { ProductPicker, type PickedProduct } from '../../components/ProductPicker/ProductPicker';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import styles from './Exchange.module.scss';

const STATUS_TEXT: Record<PosInboxDto['status'], string> = { done: 'принят', pending_match: 'ждёт сопоставления', rejected: 'отклонён', return_logged: 'возврат записан' };
const STATUS_TONE: Record<PosInboxDto['status'], Tone> = { done: 'ok', pending_match: 'amber', rejected: 'danger', return_logged: 'info' };

function ago(iso: string | null): string {
  if (!iso) return 'не было';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  if (min < 1440) return `${Math.round(min / 60)} ч назад`;
  return fmtDateTime(iso);
}

async function copyText(text: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Скопировано');
  } catch {
    toast.error('Не удалось скопировать');
  }
}

/** Проверка на образце: чек не записывается, видно, как он разобран и что найдено в номенклатуре. */
function TryPanel({ connection, preset }: { connection: Pick<PosConnectionDto, 'id'>; preset: PosPresetDto | undefined }) {
  const [payload, setPayload] = useState(preset?.sample ?? '');
  const [result, setResult] = useState<PosPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useAction((body: { payload: string }) => post<PosPreviewDto>(`/pos/connections/${connection.id}/preview`, body));
  return (
    <div className={styles.form}>
      <Field label="Образец чека" hint="Вставьте то, что присылает касса. Ничего не записывается.">
        {(p) => <Textarea {...p} value={payload} rows={8} className={styles.profile} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />}
      </Field>
      <div>
        <Button
          icon={<FlaskConical size={15} />}
          loading={run.isPending}
          onClick={() => {
            setError(null);
            run.mutate({ payload }, { onSuccess: setResult, onError: (e) => { setResult(null); setError(errorMessage(e)); } });
          }}
        >
          Проверить
        </Button>
      </div>
      {error && <ErrorNote message={error} />}
      {result?.receipts.map((r) => (
        <div key={r.externalId} className={styles.table}>
          <div style={{ padding: '8px 12px', background: 'var(--surface-50)', fontSize: 13 }}>
            Чек <strong>{r.externalId}</strong> <Chip tone={r.kind === 'return' ? 'info' : 'neutral'}>{r.kind === 'return' ? 'возврат' : 'продажа'}</Chip>
          </div>
          <DataTable
            dense
            rows={r.lines}
            rowKey={(l) => `${l.code}${l.barcode}${l.name}`}
            caption={`Строки чека ${r.externalId}`}
            columns={[
              { key: 'n', header: 'Позиция', cell: (l) => <span>{l.name ?? l.code ?? l.barcode}<span className={styles.sub}>{[l.code, l.barcode].filter(Boolean).join(' · ')}</span></span> },
              { key: 'q', header: 'Кол-во', align: 'right', cell: (l) => <span className="num">{l.quantity}</span> },
              {
                key: 'm',
                header: 'В «Запасе»',
                cell: (l) =>
                  l.match === null ? (
                    <Chip tone="amber">не найдено</Chip>
                  ) : l.match.entity === 'ignore' ? (
                    <Chip tone="neutral">не считать</Chip>
                  ) : (
                    <Chip tone="ok">{l.match.name} ({l.match.entity === 'dish' ? 'блюдо' : 'продукт'})</Chip>
                  ),
              },
            ]}
          />
        </div>
      ))}
    </div>
  );
}

function RulesDialog({ connection, onClose }: { connection: PosConnectionDto | null; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  if (connection && seen !== connection.id) {
    setSeen(connection.id);
    setText(JSON.stringify(connection.rules, null, 2));
    setError(null);
  }
  const save = useAction((body: { rules: unknown }) => patch<PosConnectionDto>(`/pos/connections/${connection?.id}`, body), ['/pos']);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return setError('Правила записаны не в формате JSON');
    }
    const check = posRules.safeParse(parsed);
    if (!check.success) return setError(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    setError(null);
    save.mutate({ rules: check.data }, { onSuccess: () => { toast.success('Правила сохранены'); onClose(); }, onError: (err) => setError(errorMessage(err)) });
  };
  return (
    <Dialog
      open={connection !== null}
      onClose={onClose}
      title="Правила разбора чека"
      subtitle={connection?.name}
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="pos-rules-form" loading={save.isPending}>Сохранить</Button>
        </>
      }
    >
      <form id="pos-rules-form" onSubmit={submit} noValidate className={styles.form}>
        <p className={styles.hint}>
          Пути записываются через точку: <code>body.positions</code>. Для файлов CSV это названия колонок. Если поле может называться по-разному, перечислите варианты в списке, берётся первый найденный.
        </p>
        <Textarea aria-label="Правила в формате JSON" value={text} rows={18} className={styles.profile} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

function Connect({ open, onClose, presets, locations, onCreated }: { open: boolean; onClose: () => void; presets: PosPresetDto[]; locations: LocationDto[]; onCreated: (c: PosConnectionCreatedDto) => void }) {
  const [name, setName] = useState('');
  const [vendor, setVendor] = useState<PosVendor>('evotor');
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((body: object) => post<PosConnectionCreatedDto>('/pos/connections', body), ['/pos']);
  const active = locations.filter((l) => l.isActive);
  const chosen = locationId || active[0]?.id || '';
  const preset = presets.find((p) => p.vendor === vendor);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Назовите кассу, например «Касса 1, Центр»');
    setError(null);
    create.mutate({ name: name.trim(), locationId: chosen, vendor }, { onSuccess: (c) => { setName(''); onCreated(c); }, onError: (err) => setError(errorMessage(err)) });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Подключить кассу"
      subtitle="Шаг 1 из 2: какая касса и на какой точке"
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="pos-connect-form" loading={create.isPending}>Далее</Button>
        </>
      }
    >
      <form id="pos-connect-form" onSubmit={submit} noValidate className={styles.form}>
        <Field label="Название" required>{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Касса или кассовая программа" required>
          {(p) => (
            <Select {...p} value={vendor} onChange={(e) => setVendor(e.target.value as PosVendor)}>
              {POS_VENDORS.map((v) => (
                <option key={v} value={v}>{POS_VENDOR_LABELS[v]}</option>
              ))}
            </Select>
          )}
        </Field>
        {preset && <p className={styles.hint}>{preset.hint}</p>}
        <Field label="Точка" required>
          {(p) => (
            <Select {...p} value={chosen} onChange={(e) => setLocationId(e.target.value)}>
              {active.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          )}
        </Field>
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

function Created({ created, presets, onClose }: { created: PosConnectionCreatedDto | null; presets: PosPresetDto[]; onClose: () => void }) {
  const toast = useToast();
  const preset = presets.find((p) => p.vendor === created?.vendor);
  const url = `${window.location.origin}/api/pos/ingest`;
  return (
    <Dialog
      open={created !== null}
      onClose={onClose}
      title="Касса подключена"
      subtitle="Шаг 2 из 2: ключ, адрес и проверка на образце"
      width={720}
      footer={<Button variant="primary" onClick={onClose}>Готово</Button>}
    >
      {created && (
        <div className={styles.form}>
          <Field label="Ключ" hint="Сохраните его сейчас: повторно показать не получится">
            {() => (
              <div className={styles.secret}>
                <input readOnly value={created.key} aria-label="Ключ" onFocus={(e) => e.currentTarget.select()} />
                <Button icon={<Copy size={15} />} onClick={() => void copyText(created.key, toast)}>Копировать</Button>
              </div>
            )}
          </Field>
          <Field label="Куда отправлять чеки">
            {() => (
              <div className={styles.secret}>
                <input readOnly value={url} aria-label="Адрес приёма" onFocus={(e) => e.currentTarget.select()} />
                <Button icon={<Copy size={15} />} onClick={() => void copyText(url, toast)}>Копировать</Button>
              </div>
            )}
          </Field>
          <pre className={styles.code}>{`POST ${url}\nX-Api-Key: <ключ>\nContent-Type: ${preset?.sampleType ?? 'application/json'}\n\n${preset?.sample ?? ''}`}</pre>
          <p className={styles.note}>Повторная отправка того же чека не спишет остатки второй раз. Чек, где есть неизвестная позиция, ждёт в разделе «Неопознанные позиции».</p>
          <TryPanel connection={created} preset={preset} />
        </div>
      )}
    </Dialog>
  );
}

function MapDialog({ target, onClose }: { target: PosUnmatchedDto | null; onClose: () => void }) {
  const toast = useToast();
  const dishes = useGet<DishDto[]>('/dishes', undefined, { enabled: target !== null });
  const [kind, setKind] = useState<'product' | 'dish' | 'ignore'>('product');
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [dishId, setDishId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((body: object) => put<{ replayed: number }>('/pos/map', body), ['/pos', ...STOCK_PREFIXES]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (kind === 'product' && !product) return setError('Выберите продукт');
    if (kind === 'dish' && !dishId) return setError('Выберите блюдо');
    setError(null);
    save.mutate(
      { keyId: target.keyId, ref: target.ref, entity: kind, ...(kind === 'product' ? { entityId: product?.id } : kind === 'dish' ? { entityId: dishId } : {}) },
      {
        onSuccess: (r) => {
          toast.success(r.replayed > 0 ? `Сопоставлено, обработано чеков: ${r.replayed}` : 'Сопоставлено');
          setProduct(null);
          setDishId('');
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title="Сопоставить позицию кассы"
      subtitle={target ? `${target.name ?? target.ref} · код «${target.ref}»` : undefined}
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="pos-map-form" loading={save.isPending}>Сохранить</Button>
        </>
      }
    >
      <form id="pos-map-form" onSubmit={submit} noValidate className={styles.form}>
        <Field label="Что это в «Запасе»">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="product">Продукт со склада</option>
              <option value="dish">Блюдо с рецептурой</option>
              <option value="ignore">Не считать (пакет, услуга)</option>
            </Select>
          )}
        </Field>
        {kind === 'product' && <Field label="Продукт" required>{(p) => <ProductPicker id={p.id} value={product} onChange={setProduct} sellableOnly />}</Field>}
        {kind === 'dish' && (
          <Field label="Блюдо" required>
            {(p) => (
              <Select {...p} value={dishId} onChange={(e) => setDishId(e.target.value)}>
                <option value="">Выберите блюдо</option>
                {(dishes.data ?? []).filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

export function PosPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const conns = useGet<PosConnectionDto[]>('/pos/connections', undefined, { refetchInterval: 15_000 });
  const presets = useGet<PosPresetDto[]>('/pos/presets');
  const locations = useGet<LocationDto[]>('/locations');
  const unmatched = useGet<PosUnmatchedDto[]>('/pos/unmatched', undefined, { refetchInterval: 15_000 });
  const [filter, setFilter] = useState('');
  const inbox = useGet<PosInboxDto[]>('/pos/inbox', { limit: 30, status: filter || undefined }, { refetchInterval: 15_000 });

  const [connecting, setConnecting] = useState(false);
  const [created, setCreated] = useState<PosConnectionCreatedDto | null>(null);
  const [trying, setTrying] = useState<PosConnectionDto | null>(null);
  const [rules, setRules] = useState<PosConnectionDto | null>(null);
  const [mapping, setMapping] = useState<PosUnmatchedDto | null>(null);
  const revoke = useAction((id: string) => del(`/api-keys/${id}`), ['/pos', '/api-keys']);
  const retry = useAction((id: string) => post<{ status: PosInboxDto['status']; error: string | null }>(`/pos/inbox/${id}/retry`), ['/pos', ...STOCK_PREFIXES]);

  const onRevoke = async (c: PosConnectionDto) => {
    const ok = await confirm({ title: 'Отключить кассу?', message: `Касса «${c.name}» перестанет отправлять продажи. Это действие нельзя отменить.`, confirmLabel: 'Отключить', danger: true });
    if (!ok) return;
    revoke.mutate(c.id, { onSuccess: () => toast.success('Касса отключена'), onError: (err) => toast.error(errorMessage(err)) });
  };

  const columns: Column<PosConnectionDto>[] = [
    { key: 'name', header: 'Касса', cell: (c) => <span><strong>{c.name}</strong><span className={styles.sub}><span className="mono">{c.keyPrefix}…</span></span></span> },
    { key: 'vendor', header: 'Тип', cell: (c) => POS_VENDOR_LABELS[c.vendor] },
    { key: 'loc', header: 'Точка', cell: (c) => c.locationName },
    { key: 'used', header: 'Последний чек', cell: (c) => (c.lastUsedAt ? <span className="num">{ago(c.lastUsedAt)}</span> : <span className="muted">не было</span>) },
    {
      key: 'counts',
      header: 'Чеки',
      cell: (c) => (
        <span>
          <span className="num">{c.counts.done}</span> принято
          <span className={styles.sub}>
            {[c.counts.pending ? `ждут сопоставления: ${c.counts.pending}` : '', c.counts.rejected ? `отклонено: ${c.counts.rejected}` : '', c.counts.returns ? `возвратов: ${c.counts.returns}` : ''].filter(Boolean).join(' · ') || 'без замечаний'}
          </span>
        </span>
      ),
    },
    { key: 'state', header: 'Статус', cell: (c) => <Chip tone={c.revokedAt ? 'neutral' : 'ok'}>{c.revokedAt ? 'Отключена' : 'Работает'}</Chip> },
    {
      key: 'act',
      header: '',
      align: 'right',
      cell: (c) =>
        !c.revokedAt && (
          <div className={styles.actions}>
            <Button size="sm" icon={<FlaskConical size={14} />} onClick={() => setTrying(c)}>Проверить</Button>
            <Button size="sm" icon={<Settings2 size={14} />} onClick={() => setRules(c)}>Правила</Button>
            <Button size="sm" variant="danger" onClick={() => void onRevoke(c)}>Отключить</Button>
          </div>
        ),
    },
  ];

  const unmatchedColumns: Column<PosUnmatchedDto>[] = [
    { key: 'ref', header: 'Позиция', cell: (u) => <span><strong>{u.name ?? u.ref}</strong><span className={styles.sub}>код «{u.ref}»</span></span> },
    { key: 'conn', header: 'Касса', cell: (u) => u.connectionName },
    { key: 'receipts', header: 'Чеков ждёт', align: 'right', cell: (u) => <span className="num">{u.receipts}</span> },
    { key: 'qty', header: 'Штук', align: 'right', cell: (u) => <span className="num">{u.quantity}</span> },
    { key: 'act', header: '', align: 'right', cell: (u) => <Button size="sm" variant="primary" onClick={() => setMapping(u)}>Сопоставить</Button> },
  ];

  const inboxColumns: Column<PosInboxDto>[] = [
    { key: 'when', header: 'Когда', cell: (r) => <span className="num">{fmtDateTime(r.receivedAt)}</span> },
    { key: 'conn', header: 'Касса', cell: (r) => r.connectionName },
    { key: 'id', header: 'Чек', cell: (r) => <span className="mono">{r.externalId}</span> },
    { key: 'status', header: 'Состояние', cell: (r) => <Chip tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Chip> },
    { key: 'lines', header: 'Позиций', align: 'right', cell: (r) => <span className="num">{r.lines.length}</span> },
    { key: 'doc', header: 'Документ или причина', cell: (r) => (r.documentNumber ? <span className="mono">{r.documentNumber}</span> : r.error ? <span>{r.error}</span> : r.unmatched.length > 0 ? <span className="muted">нет в учёте: {r.unmatched.join(', ')}</span> : <span className="muted">-</span>) },
    {
      key: 'act',
      header: '',
      align: 'right',
      cell: (r) =>
        r.status === 'rejected' && (
          <Button size="sm" icon={<RotateCw size={14} />} loading={retry.isPending} onClick={() => retry.mutate(r.id, { onSuccess: (x) => (x.status === 'done' ? toast.success('Чек принят') : toast.error(x.error ?? 'Чек снова отклонён')), onError: (err) => toast.error(errorMessage(err)) })}>
            Повторить
          </Button>
        ),
    },
  ];

  return (
    <>
      <Panel
        title="Кассы"
        subtitle="Кассы и кассовые программы Эвотор, Фронтол, АТОЛ, iiko, Sigma и любые другие присылают чеки в «Запас», остатки списываются сами"
        actions={<Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setConnecting(true)}>Подключить кассу</Button>}
      >
        <DataTable columns={columns} rows={conns.data} rowKey={(c) => c.id} loading={conns.isLoading} empty="Касс пока нет. Нажмите «Подключить кассу»" caption="Подключённые кассы" />
      </Panel>

      <div className={styles.gap} />
      <Panel title="Неопознанные позиции" subtitle="Касса прислала позицию, которой нет в номенклатуре или среди блюд. Чек ждёт, пока вы её сопоставите">
        <DataTable columns={unmatchedColumns} rows={unmatched.data} rowKey={(u) => `${u.keyId}${u.ref}`} loading={unmatched.isLoading} empty="Всё опознано" caption="Неопознанные позиции" />
      </Panel>

      <div className={styles.gap} />
      <Panel
        title="Принятые чеки"
        subtitle="Последние чеки от касс и что с ними стало"
        actions={
          <Select aria-label="Состояние чека" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Все</option>
            <option value="pending_match">Ждут сопоставления</option>
            <option value="rejected">Отклонены</option>
            <option value="return_logged">Возвраты</option>
            <option value="done">Приняты</option>
          </Select>
        }
      >
        {inbox.isError ? <ErrorNote error={inbox.error} onRetry={() => void inbox.refetch()} /> : <DataTable columns={inboxColumns} rows={inbox.data} rowKey={(r) => r.id} loading={inbox.isLoading} empty="Чеков пока не было" caption="Принятые чеки" />}
      </Panel>

      <Connect open={connecting} onClose={() => setConnecting(false)} presets={presets.data ?? []} locations={locations.data ?? []} onCreated={(c) => { setConnecting(false); setCreated(c); }} />
      <Created created={created} presets={presets.data ?? []} onClose={() => setCreated(null)} />
      <Dialog open={trying !== null} onClose={() => setTrying(null)} title="Проверка кассы" subtitle={trying?.name} width={720} footer={<Button onClick={() => setTrying(null)}>Закрыть</Button>}>
        {trying && <TryPanel key={trying.id} connection={trying} preset={presets.data?.find((p) => p.vendor === trying.vendor)} />}
      </Dialog>
      <RulesDialog connection={rules} onClose={() => setRules(null)} />
      <MapDialog target={mapping} onClose={() => setMapping(null)} />
    </>
  );
}
