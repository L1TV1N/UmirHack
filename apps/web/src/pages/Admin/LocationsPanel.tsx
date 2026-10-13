import { LOCATION_KIND_LABELS, LOCATION_KINDS, createLocationBody, type LocationDto, type LocationKind } from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { parseDecimal } from '../../lib/format';

export function LocationsPanel() {
  const toast = useToast();
  const list = useGet<LocationDto[]>('/locations');
  const [editing, setEditing] = useState<LocationDto | 'new' | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LocationKind>('shop');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [isActive, setActive] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const location = editing && editing !== 'new' ? editing : null;

  useEffect(() => {
    if (editing === null) return;
    setCode(location?.code ?? '');
    setName(location?.name ?? '');
    setKind(location?.kind ?? 'shop');
    setAddress(location?.address ?? '');
    setLatitude(location?.latitude != null ? String(location.latitude) : '');
    setLongitude(location?.longitude != null ? String(location.longitude) : '');
    setActive(location?.isActive ?? true);
    setErrors({});
    setFormError(null);
  }, [editing, location]);

  const save = useAction((body: object) => (location ? patch(`/locations/${location.id}`, body) : post('/locations', body)), ['/locations', '/stock', '/analytics']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // координаты задаются парой: по ним для точки берётся прогноз погоды
    const lat = latitude.trim() === '' ? null : parseDecimal(latitude);
    const lon = longitude.trim() === '' ? null : parseDecimal(longitude);
    if ((latitude.trim() !== '' && lat === null) || (longitude.trim() !== '' && lon === null)) {
      return setErrors({ ...(latitude.trim() !== '' && lat === null ? { latitude: 'Число, например 47.2357' } : {}), ...(longitude.trim() !== '' && lon === null ? { longitude: 'Число, например 39.7015' } : {}) });
    }
    if ((lat === null) !== (lon === null)) return setErrors({ [lat === null ? 'latitude' : 'longitude']: 'Укажите широту и долготу вместе' });
    let body: object;
    if (location) {
      if (!name.trim()) return setErrors({ name: 'Введите название' });
      body = { name: name.trim(), kind, address: address.trim() || null, latitude: lat, longitude: lon, isActive };
    } else {
      const parsed = createLocationBody.safeParse({ code, name, kind, address, latitude: lat, longitude: lon });
      if (!parsed.success) {
        const out: Record<string, string> = {};
        for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.message;
        return setErrors(out);
      }
      body = parsed.data;
    }
    setErrors({});
    save.mutate(body, {
      onSuccess: () => {
        toast.success('Точка сохранена');
        setEditing(null);
      },
      onError: (err) => (err instanceof ApiError && err.code === 'duplicate_code' ? setErrors({ code: err.message }) : setFormError(errorMessage(err))),
    });
  };

  const columns: Column<LocationDto>[] = [
    { key: 'name', header: 'Точка', cell: (l) => <strong>{l.name}</strong> },
    { key: 'code', header: 'Код', cell: (l) => <span className="mono">{l.code}</span> },
    { key: 'kind', header: 'Вид', cell: (l) => LOCATION_KIND_LABELS[l.kind] },
    { key: 'address', header: 'Адрес', cell: (l) => <span className="muted">{l.address ?? ''}</span> },
    { key: 'weather', header: 'Погода', cell: (l) => <Chip tone={l.latitude != null ? 'ok' : 'neutral'}>{l.latitude != null ? 'по координатам' : 'нет координат'}</Chip> },
    { key: 'state', header: 'Статус', cell: (l) => <Chip tone={l.isActive ? 'ok' : 'neutral'}>{l.isActive ? 'Работает' : 'Отключена'}</Chip> },
    { key: 'edit', header: '', align: 'right', cell: (l) => <Button size="sm" onClick={() => setEditing(l)}>Изменить</Button> },
  ];

  return (
    <>
      <Panel title="Точки" subtitle="Склады, кухни и магазины" actions={<Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>Добавить</Button>}>
        <DataTable columns={columns} rows={list.data} rowKey={(l) => l.id} loading={list.isLoading} caption="Точки" />
      </Panel>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={location ? 'Точка' : 'Новая точка'}
        width={520}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Отмена</Button>
            <Button variant="primary" type="submit" form="location-form" loading={save.isPending}>
              Сохранить
            </Button>
          </>
        }
      >
        <form id="location-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <FieldRow>
            <Field label="Название" error={errors.name} required>
              {(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />}
            </Field>
            <Field label="Код" error={errors.code} hint={location ? 'Не меняется' : 'Латиница, цифры, дефис'} required>
              {(p) => <Input {...p} value={code} disabled={Boolean(location)} maxLength={20} onChange={(e) => setCode(e.target.value)} />}
            </Field>
          </FieldRow>
          <Field label="Вид" required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as LocationKind)}>
                {LOCATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {LOCATION_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Адрес">{(p) => <Input {...p} value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />}</Field>
          <FieldRow>
            <Field label="Широта" error={errors.latitude} hint="Для прогноза погоды, по желанию">
              {(p) => <Input {...p} inputMode="decimal" value={latitude} maxLength={10} placeholder="47.2357" onChange={(e) => setLatitude(e.target.value)} />}
            </Field>
            <Field label="Долгота" error={errors.longitude}>
              {(p) => <Input {...p} inputMode="decimal" value={longitude} maxLength={10} placeholder="39.7015" onChange={(e) => setLongitude(e.target.value)} />}
            </Field>
          </FieldRow>
          {location && <Checkbox label="Точка работает" checked={isActive} onChange={(e) => setActive(e.target.checked)} />}
          {formError && <ErrorNote message={formError} />}
        </form>
      </Dialog>
    </>
  );
}
