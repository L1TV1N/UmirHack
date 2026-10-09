import type { ApiKeyCreatedDto, ApiKeyDto, LocationDto } from '@zapas/shared';
import { Copy, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { del, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';

const EXAMPLE = `POST /api/pos/sales
X-Api-Key: <ключ>
Content-Type: application/json

{
  "externalId": "чек-2026-10-08-0001",
  "lines": [
    { "productId": "<id продукта>", "quantity": 2 },
    { "dishId": "<id блюда>", "quantity": 1 }
  ]
}`;

export function ApiKeysPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useGet<ApiKeyDto[]>('/api-keys');
  const locations = useGet<LocationDto[]>('/locations');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreatedDto | null>(null);
  const create = useAction((body: object) => post<ApiKeyCreatedDto>('/api-keys', body), ['/api-keys']);
  const revoke = useAction((id: string) => del(`/api-keys/${id}`), ['/api-keys']);

  const active = (locations.data ?? []).filter((l) => l.isActive);
  const chosen = locationId || active[0]?.id || '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Назовите ключ, например «Касса 1, Центр»');
    setError(null);
    create.mutate(
      { name: name.trim(), locationId: chosen },
      {
        onSuccess: (k) => {
          setCreating(false);
          setName('');
          setCreated(k);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const onRevoke = async (k: ApiKeyDto) => {
    const ok = await confirm({ title: 'Отозвать ключ?', message: `Касса «${k.name}» перестанет отправлять продажи. Это действие нельзя отменить.`, confirmLabel: 'Отозвать', danger: true });
    if (!ok) return;
    revoke.mutate(k.id, { onSuccess: () => toast.success('Ключ отозван'), onError: (err) => toast.error(errorMessage(err)) });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Скопировано');
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  const columns: Column<ApiKeyDto>[] = [
    { key: 'name', header: 'Касса', cell: (k) => <strong>{k.name}</strong> },
    { key: 'prefix', header: 'Ключ', cell: (k) => <span className="mono">{k.prefix}…</span> },
    { key: 'loc', header: 'Точка', cell: (k) => k.locationName },
    { key: 'created', header: 'Создан', cell: (k) => <span className="num">{fmtDateTime(k.createdAt)}</span> },
    { key: 'used', header: 'Последний запрос', cell: (k) => (k.lastUsedAt ? <span className="num">{fmtDateTime(k.lastUsedAt)}</span> : <span className="muted">не использовался</span>) },
    { key: 'state', header: 'Статус', cell: (k) => <Chip tone={k.revokedAt ? 'neutral' : 'ok'}>{k.revokedAt ? 'Отозван' : 'Действует'}</Chip> },
    { key: 'act', header: '', align: 'right', cell: (k) => !k.revokedAt && <Button size="sm" variant="danger" onClick={() => void onRevoke(k)}>Отозвать</Button> },
  ];

  return (
    <>
      <Panel
        title="Ключи кассы"
        subtitle="Касса отправляет продажи по API, ключ привязан к одной точке и ничего другого делать не может"
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
            Выпустить ключ
          </Button>
        }
      >
        <DataTable columns={columns} rows={keys.data} rowKey={(k) => k.id} loading={keys.isLoading} empty="Ключей пока нет" caption="Ключи кассы" />
      </Panel>

      <div style={{ height: 16 }} />
      <Panel title="Как подключить кассу" padded>
        <pre style={{ margin: 0, padding: 14, background: 'var(--ink-900)', color: '#e5e7eb', borderRadius: 6, overflowX: 'auto', fontSize: 12.5, lineHeight: 1.6 }}>{EXAMPLE}</pre>
        <p className="muted" style={{ marginTop: 10 }}>
          Повторная отправка с тем же externalId не спишет остатки второй раз, поэтому при обрыве связи запрос можно безопасно повторять.
        </p>
      </Panel>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Новый ключ кассы"
        width={460}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Отмена</Button>
            <Button variant="primary" type="submit" form="apikey-form" loading={create.isPending}>
              Выпустить
            </Button>
          </>
        }
      >
        <form id="apikey-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Название" required>{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label="Точка" required>
            {(p) => (
              <Select {...p} value={chosen} onChange={(e) => setLocationId(e.target.value)}>
                {active.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {error && <ErrorNote message={error} />}
        </form>
      </Dialog>

      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title="Ключ выпущен"
        subtitle="Сохраните его сейчас: повторно показать не получится"
        width={560}
        footer={<Button variant="primary" onClick={() => setCreated(null)}>Я сохранил ключ</Button>}
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input readOnly value={created?.key ?? ''} aria-label="Ключ" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, height: 36, padding: '0 10px', border: '1px solid var(--ink-300)', borderRadius: 6, fontFamily: 'ui-monospace, monospace', fontSize: 13 }} />
          <Button icon={<Copy size={15} />} onClick={() => created && void copy(created.key)}>
            Копировать
          </Button>
        </div>
      </Dialog>
    </>
  );
}
