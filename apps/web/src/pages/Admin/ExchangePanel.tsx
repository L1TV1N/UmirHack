import {
  EXCHANGE_DOC_KINDS,
  EXCHANGE_DOC_LABELS,
  LINK_ENTITY_LABELS,
  oneCProfile,
  type ExchangeCheckDto,
  type ExchangeDocKind,
  type ExchangeJobDto,
  type ExchangeMissingDto,
  type ExchangePresetDto,
  type ExternalSystemDto,
  type LocationDto,
  type OneCPreset,
  type RemoteItemDto,
} from '@zapas/shared';
import { CheckCheck, Link2, Plus, RotateCw, Settings2, Trash2, Zap } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { del, get, patch, post, put } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Checkbox, Field, Input, Select, Textarea } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import styles from './Exchange.module.scss';

const JOB_TEXT: Record<ExchangeJobDto['status'], string> = { pending: 'в очереди', done: 'выгружен', blocked: 'ждёт связей', failed: 'не удалось' };
const JOB_TONE: Record<ExchangeJobDto['status'], Tone> = { pending: 'amber', done: 'ok', blocked: 'info', failed: 'danger' };

function CheckList({ result }: { result: ExchangeCheckDto }) {
  return (
    <ul className={styles.checks}>
      {result.items.map((i, n) => (
        <li key={n}>
          <span className={`${styles.mark} ${i.ok ? styles.markOk : styles.markBad}`} aria-hidden="true">{i.ok ? '✓' : '!'}</span>
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}

function CheckDialog({ system, onClose }: { system: ExternalSystemDto | null; onClose: () => void }) {
  const [result, setResult] = useState<ExchangeCheckDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useAction((id: string) => post<ExchangeCheckDto>(`/exchange/systems/${id}/check`), ['/exchange']);
  useEffect(() => {
    if (!system) return;
    setResult(null);
    setError(null);
    run.mutate(system.id, { onSuccess: setResult, onError: (e) => setError(errorMessage(e)) });
    // запускается один раз при открытии окна
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system?.id]);
  return (
    <Dialog
      open={system !== null}
      onClose={onClose}
      title="Проверка подключения"
      subtitle={system?.name}
      width={640}
      footer={
        <>
          <Button loading={run.isPending} icon={<CheckCheck size={15} />} onClick={() => system && run.mutate(system.id, { onSuccess: setResult, onError: (e) => setError(errorMessage(e)) })}>Проверить ещё раз</Button>
          <Button variant="primary" onClick={onClose}>Закрыть</Button>
        </>
      }
    >
      {run.isPending && !result && <p className="muted">Подключаемся к 1С и читаем описание интерфейса…</p>}
      {error && <ErrorNote message={error} />}
      {result && (
        <>
          <p className={styles.hint}>{result.ok ? 'Всё на месте: документы можно выгружать.' : 'Есть замечания. Исправьте имена объектов и реквизитов в настройке и проверьте снова.'}</p>
          <div style={{ height: 12 }} />
          <CheckList result={result} />
        </>
      )}
    </Dialog>
  );
}

function LinkRow({ systemId, item, onLinked }: { systemId: string; item: ExchangeMissingDto; onLinked: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(item.entity === 'product' ? item.name : item.name);
  const [found, setFound] = useState<RemoteItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useAction((text: string) => get<RemoteItemDto[]>(`/exchange/systems/${systemId}/search`, { entity: item.entity, q: text }));
  const link = useAction((remoteKey: string) => put<{ woke: number }>(`/exchange/systems/${systemId}/links`, { entity: item.entity, localId: item.localId, remoteKey }), ['/exchange']);
  const run = () => {
    setError(null);
    search.mutate(q, { onSuccess: setFound, onError: (e) => setError(errorMessage(e)) });
  };
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div className={styles.row}>
        <div>
          <strong>{item.name}</strong> <Chip>{LINK_ENTITY_LABELS[item.entity]}</Chip>
          {item.code && <span className={styles.sub}>{item.entity === 'supplier' ? 'ИНН' : 'артикул'} {item.code}</span>}
        </div>
      </div>
      <div className={styles.row} style={{ marginTop: 8 }}>
        <Input aria-label={`Поиск в 1С для ${item.name}`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } }} placeholder="Название или код в 1С" />
        <Button size="sm" loading={search.isPending} onClick={run}>Найти в 1С</Button>
      </div>
      {error && <div style={{ marginTop: 8 }}><ErrorNote message={error} /></div>}
      {found && (
        <div className={styles.found}>
          {found.length === 0 && <span className="muted">В 1С ничего не нашлось</span>}
          {found.map((f) => (
            <div key={f.key} className={styles.pick}>
              <span>{f.name}{f.code && <span className={styles.sub}>{f.code}</span>}</span>
              <Button size="sm" variant="primary" loading={link.isPending} onClick={() => link.mutate(f.key, { onSuccess: () => { toast.success('Связано'); onLinked(); }, onError: (e) => toast.error(errorMessage(e)) })}>Связать</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkDialog({ system, onClose }: { system: ExternalSystemDto | null; onClose: () => void }) {
  const toast = useToast();
  const list = useGet<ExchangeMissingDto[]>(`/exchange/systems/${system?.id ?? 'none'}/unlinked`, undefined, { enabled: system !== null });
  const auto = useAction(() => post<{ linked: number; left: number }>(`/exchange/systems/${system?.id}/autolink`), ['/exchange']);
  const items = list.data ?? [];
  return (
    <Dialog
      open={system !== null}
      onClose={onClose}
      title="Что связать с 1С"
      subtitle={system?.name}
      width={680}
      footer={<Button variant="primary" onClick={onClose}>Закрыть</Button>}
    >
      <p className={styles.hint}>Чтобы документ ушёл в 1С, каждому продукту, поставщику и складу нужно соответствие в справочниках 1С. Связь запоминается, повторять не придётся.</p>
      <div style={{ margin: '12px 0' }}>
        <Button icon={<Zap size={15} />} loading={auto.isPending} onClick={() => auto.mutate(undefined, { onSuccess: (r) => { toast.success(`Связано автоматически: ${r.linked}, осталось: ${r.left}`); void list.refetch(); }, onError: (e) => toast.error(errorMessage(e)) })}>
          Связать по артикулу автоматически
        </Button>
      </div>
      {list.isError && <ErrorNote error={list.error} onRetry={() => void list.refetch()} />}
      {list.isSuccess && items.length === 0 && <p className="muted">Всё связано. Ждущие документы уйдут в 1С сами.</p>}
      {system && items.map((m) => <LinkRow key={`${m.entity}${m.localId}`} systemId={system.id} item={m} onLinked={() => void list.refetch()} />)}
    </Dialog>
  );
}

function SystemDialog({ open, system, presets, locations, onClose, onSaved }: { open: boolean; system: ExternalSystemDto | null; presets: ExchangePresetDto[]; locations: LocationDto[]; onClose: () => void; onSaved: (s: ExternalSystemDto) => void }) {
  const [preset, setPreset] = useState<OneCPreset>('bp3');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [org, setOrg] = useState('');
  const [kinds, setKinds] = useState<ExchangeDocKind[]>(['receipt', 'writeoff', 'transfer']);
  const [locationId, setLocationId] = useState('');
  const [profileText, setProfileText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState<string | null>(null);
  const save = useAction((body: object) => (system ? patch<ExternalSystemDto>(`/exchange/systems/${system.id}`, body) : post<ExternalSystemDto>('/exchange/systems', { kind: 'onec', ...body })), ['/exchange']);

  const key = open ? (system?.id ?? 'new') : null;
  if (key !== null && seen !== key) {
    setSeen(key);
    setError(null);
    setPassword('');
    if (system) {
      setPreset(system.profile.preset);
      setName(system.name);
      setBaseUrl(system.baseUrl);
      setUsername(system.username ?? '');
      setOrg(system.profile.organizationKey ?? '');
      setKinds(system.docKinds);
      setLocationId(system.locationId ?? '');
      setProfileText(JSON.stringify(system.profile, null, 2));
    } else {
      setName('');
      setBaseUrl('');
      setUsername('');
      setOrg('');
      setKinds(['receipt', 'writeoff', 'transfer']);
      setLocationId('');
      const p = presets.find((x) => x.preset === 'bp3');
      setPreset('bp3');
      setProfileText(p ? JSON.stringify(p.profile, null, 2) : '');
    }
  }
  if (key === null && seen !== null) setSeen(null);

  const choosePreset = (v: OneCPreset) => {
    setPreset(v);
    const p = presets.find((x) => x.preset === v);
    if (p) setProfileText(JSON.stringify({ ...p.profile, ...(org ? { organizationKey: org } : {}) }, null, 2));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Назовите подключение, например «Бухгалтерия»');
    if (!baseUrl.trim()) return setError('Укажите адрес сервера 1С');
    let raw: unknown;
    try {
      raw = JSON.parse(profileText);
    } catch {
      return setError('Сопоставление записано не в формате JSON');
    }
    const merged = { ...(raw as object), preset, ...(org.trim() ? { organizationKey: org.trim() } : {}) };
    const check = oneCProfile.safeParse(merged);
    if (!check.success) return setError(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (kinds.length === 0) return setError('Выберите хотя бы один вид документа');
    setError(null);
    save.mutate(
      { name: name.trim(), baseUrl: baseUrl.trim(), username: username.trim() || undefined, ...(password ? { password } : {}), profile: check.data, docKinds: kinds, locationId: locationId || null },
      { onSuccess: onSaved, onError: (err) => setError(errorMessage(err)) },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={system ? 'Настройка обмена' : 'Подключить 1С'}
      subtitle="Документы «Запаса» будут создаваться в вашей 1С по стандартному интерфейсу OData"
      width={720}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="exchange-form" loading={save.isPending}>{system ? 'Сохранить' : 'Подключить'}</Button>
        </>
      }
    >
      <form id="exchange-form" onSubmit={submit} noValidate className={styles.form}>
        <p className={styles.hint}>В 1С должен быть опубликован стандартный интерфейс OData, а для обмена заведён отдельный пользователь с правом чтения и записи нужных документов. Серверы во внутренней сети разрешает администратор сервера (EXCHANGE_ALLOW_HOSTS).</p>
        <Field label="Название" required>{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Конфигурация 1С" hint="Подставляет типовые имена документов. Их можно поправить ниже, а кнопка «Проверить» покажет, чего не хватает.">
          {(p) => (
            <Select {...p} value={preset} onChange={(e) => choosePreset(e.target.value as OneCPreset)}>
              {presets.map((x) => (
                <option key={x.preset} value={x.preset}>{x.label}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Адрес сервера 1С" required hint="Например, https://1c.example.ru/base. Путь OData берётся из сопоставления.">{(p) => <Input {...p} value={baseUrl} maxLength={500} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" />}</Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Пользователь 1С">{(p) => <Input {...p} value={username} maxLength={120} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />}</Field>
          <Field label="Пароль" hint={system?.hasPassword ? 'Оставьте пустым, чтобы не менять' : undefined}>{(p) => <Input {...p} type="password" value={password} maxLength={200} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />}</Field>
        </div>
        <Field label="Организация (Ref_Key)" hint="Идентификатор организации, от имени которой создаются документы.">{(p) => <Input {...p} value={org} maxLength={36} onChange={(e) => setOrg(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />}</Field>
        <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>Какие документы выгружать</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px' }}>
            {EXCHANGE_DOC_KINDS.map((k) => (
              <Checkbox key={k} label={EXCHANGE_DOC_LABELS[k]} checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} />
            ))}
          </div>
        </fieldset>
        <Field label="Точка" hint="Пусто: документы всех точек">
          {(p) => (
            <Select {...p} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Все точки</option>
              {locations.filter((l) => l.isActive).map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Сопоставление объектов и реквизитов</summary>
          <p className={styles.note}>Имена документов, табличных частей и реквизитов зависят от конфигурации и релиза. Правьте здесь, если проверка показала расхождения.</p>
          <Textarea aria-label="Сопоставление в формате JSON" value={profileText} rows={16} className={styles.profile} onChange={(e) => setProfileText(e.target.value)} spellCheck={false} />
        </details>
        {error && <ErrorNote message={error} />}
      </form>
    </Dialog>
  );
}

export function ExchangePanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const systems = useGet<ExternalSystemDto[]>('/exchange/systems', undefined, { refetchInterval: 15_000 });
  const presets = useGet<ExchangePresetDto[]>('/exchange/presets');
  const locations = useGet<LocationDto[]>('/locations');
  const [jobFilter, setJobFilter] = useState('');
  const jobs = useGet<ExchangeJobDto[]>('/exchange/jobs', { limit: 40, status: jobFilter || undefined }, { refetchInterval: 15_000 });
  const [editing, setEditing] = useState<{ system: ExternalSystemDto | null } | null>(null);
  const [checking, setChecking] = useState<ExternalSystemDto | null>(null);
  const [linking, setLinking] = useState<ExternalSystemDto | null>(null);
  const toggle = useAction((v: { id: string; enabled: boolean }) => patch(`/exchange/systems/${v.id}`, { enabled: v.enabled }), ['/exchange']);
  const remove = useAction((id: string) => del(`/exchange/systems/${id}`), ['/exchange']);
  const retry = useAction((id: string) => post(`/exchange/jobs/${id}/retry`), ['/exchange']);

  const onRemove = async (s: ExternalSystemDto) => {
    const ok = await confirm({ title: 'Удалить подключение?', message: `«${s.name}» и очередь выгрузки будут удалены. Документы в самой 1С останутся.`, confirmLabel: 'Удалить', danger: true });
    if (!ok) return;
    remove.mutate(s.id, { onSuccess: () => toast.success('Подключение удалено'), onError: (e) => toast.error(errorMessage(e)) });
  };

  const stateOf = (s: ExternalSystemDto): { tone: Tone; text: string } =>
    !s.enabled ? { tone: 'neutral', text: 'Выключено' } : s.lastError ? { tone: 'danger', text: 'Есть ошибка' } : s.lastOkAt ? { tone: 'ok', text: 'Работает' } : { tone: 'amber', text: 'Не проверено' };

  const columns: Column<ExternalSystemDto>[] = [
    { key: 'name', header: 'Система', cell: (s) => <span><strong>{s.name}</strong><span className={styles.sub}>{s.baseUrl}</span></span> },
    { key: 'kinds', header: 'Документы', cell: (s) => s.docKinds.map((k) => EXCHANGE_DOC_LABELS[k]).join(', ') + (s.locationName ? ` · ${s.locationName}` : '') },
    {
      key: 'state',
      header: 'Состояние',
      cell: (s) => (
        <span>
          <Chip tone={stateOf(s).tone}>{stateOf(s).text}</Chip>
          {s.lastError && <span className={styles.sub}>{s.lastError}</span>}
          {!s.lastError && s.lastOkAt && <span className={styles.sub}>последняя выгрузка {fmtDateTime(s.lastOkAt)}</span>}
        </span>
      ),
    },
    { key: 'queue', header: 'Очередь', cell: (s) => <span><span className="num">{s.counts.done}</span> выгружено<span className={styles.sub}>{[s.counts.pending ? `в очереди: ${s.counts.pending}` : '', s.counts.blocked ? `ждут связей: ${s.counts.blocked}` : '', s.counts.failed ? `не удалось: ${s.counts.failed}` : ''].filter(Boolean).join(' · ') || 'всё ушло'}</span></span> },
    {
      key: 'act',
      header: '',
      align: 'right',
      cell: (s) => (
        <div className={styles.actions}>
          <Button size="sm" icon={<CheckCheck size={14} />} onClick={() => setChecking(s)}>Проверить</Button>
          <Button size="sm" icon={<Link2 size={14} />} onClick={() => setLinking(s)}>Что связать{s.counts.blocked ? ` (${s.counts.blocked})` : ''}</Button>
          <Button size="sm" icon={<Settings2 size={14} />} onClick={() => setEditing({ system: s })}>Настроить</Button>
          <Button size="sm" onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}>{s.enabled ? 'Выключить' : 'Включить'}</Button>
          <Button size="sm" variant="danger" icon={<Trash2 size={14} />} aria-label={`Удалить ${s.name}`} onClick={() => void onRemove(s)} />
        </div>
      ),
    },
  ];

  const jobColumns: Column<ExchangeJobDto>[] = [
    { key: 'when', header: 'Когда', cell: (j) => <span className="num">{fmtDateTime(j.createdAt)}</span> },
    { key: 'sys', header: 'Система', cell: (j) => j.systemName },
    { key: 'doc', header: 'Документ', cell: (j) => <span><span className="mono">{j.documentNumber}</span><span className={styles.sub}>{j.locationName}</span></span> },
    { key: 'status', header: 'Состояние', cell: (j) => <Chip tone={JOB_TONE[j.status]}>{JOB_TEXT[j.status]}</Chip> },
    { key: 'remote', header: 'В 1С', cell: (j) => (j.remoteNumber ? <span className="mono">{j.remoteNumber}</span> : <span className="muted">-</span>) },
    { key: 'err', header: 'Комментарий', cell: (j) => (j.lastError ? <span>{j.lastError}</span> : j.status === 'pending' && j.attempts > 0 ? <span className="muted">повтор {fmtDateTime(j.nextAttemptAt ?? '')}</span> : <span className="muted">-</span>) },
    { key: 'act', header: '', align: 'right', cell: (j) => (j.status === 'failed' || j.status === 'blocked') && <Button size="sm" icon={<RotateCw size={14} />} onClick={() => retry.mutate(j.id, { onSuccess: () => toast.success('Поставлено в очередь'), onError: (e) => toast.error(errorMessage(e)) })}>Повторить</Button> },
  ];

  return (
    <>
      <Panel
        title="Учётные системы"
        subtitle="Приходы, списания и перемещения дублируются в 1С. Повторная выгрузка обновляет тот же документ и не создаёт дубль"
        actions={<Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEditing({ system: null })}>Подключить 1С</Button>}
      >
        <DataTable columns={columns} rows={systems.data} rowKey={(s) => s.id} loading={systems.isLoading} empty="Подключений пока нет. Нажмите «Подключить 1С»" caption="Учётные системы" />
      </Panel>

      <div className={styles.gap} />
      <Panel
        title="Журнал выгрузки"
        subtitle="Каждый документ, который ушёл или должен уйти в учётную систему"
        actions={
          <Select aria-label="Состояние выгрузки" value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
            <option value="">Все</option>
            <option value="pending">В очереди</option>
            <option value="blocked">Ждут связей</option>
            <option value="failed">Не удались</option>
            <option value="done">Выгружены</option>
          </Select>
        }
      >
        {jobs.isError ? <ErrorNote error={jobs.error} onRetry={() => void jobs.refetch()} /> : <DataTable columns={jobColumns} rows={jobs.data} rowKey={(j) => j.id} loading={jobs.isLoading} empty="Документов для выгрузки пока не было" caption="Журнал выгрузки" />}
      </Panel>

      <div className={styles.gap} />
      <Panel title="Другие форматы" padded>
        <p className={styles.note} style={{ marginTop: 0 }}>
          Для iiko приходную накладную можно скачать файлом XML в формате загрузки iiko: откройте документ в «Операции → Журнал» и нажмите «XML для iiko». Стоп-лист в виде, близком к iikoCloud, отдаёт адрес <code>GET /api/pos/stop-list/iiko</code> с ключом кассы.
        </p>
      </Panel>

      <SystemDialog
        open={editing !== null}
        system={editing?.system ?? null}
        presets={presets.data ?? []}
        locations={locations.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={(s) => {
          const created = editing?.system === null;
          setEditing(null);
          toast.success(created ? 'Подключение создано' : 'Настройки сохранены');
          if (created) setChecking(s);
        }}
      />
      <CheckDialog system={checking} onClose={() => setChecking(null)} />
      <LinkDialog system={linking} onClose={() => setLinking(null)} />
    </>
  );
}
