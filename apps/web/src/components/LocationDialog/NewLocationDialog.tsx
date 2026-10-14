import { createLocationBody, LOCATION_KIND_LABELS, LOCATION_KINDS, type LocationDto, type LocationKind } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, post } from '../../api/client';
import { useAction } from '../../api/hooks';
import { Button } from '../Button/Button';
import { Field, Input, Select } from '../Controls/Controls';
import { Dialog } from '../Dialog/Dialog';
import { ErrorNote } from '../Feedback/Feedback';
import { errorMessage } from '../../lib/errors';

const LATIN: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

/** Код точки нужен системе, а не человеку: собираем его из названия и случайного хвоста. */
export function makeLocationCode(name: string): string {
  const base = [...name.toLowerCase()].map((c) => LATIN[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12) || 'point';
  const tail = Math.random().toString(36).slice(2, 6);
  return `${base}-${tail}`.slice(0, 20);
}

/** Новое заведение: название, тип и адрес. Создаёт администратор. */
export function NewLocationDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (l: LocationDto) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LocationKind>('kitchen');
  const [address, setAddress] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = useAction((body: object) => post<LocationDto>('/locations', body), ['/locations']);

  useEffect(() => {
    if (!open) return;
    setName('');
    setKind('kitchen');
    setAddress('');
    setErrors({});
    setFormError(null);
  }, [open]);

  const submit = (e: FormEvent, attempt = 0) => {
    e.preventDefault();
    const parsed = createLocationBody.safeParse({ code: makeLocationCode(name), name, kind, address });
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const issue of parsed.error.issues) out[String(issue.path[0]) === 'code' ? 'name' : String(issue.path[0])] ??= String(issue.path[0]) === 'code' ? 'Введите название' : issue.message;
      return setErrors(out);
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: (l) => onCreated(l),
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'duplicate_code' && attempt < 3) return submit(e, attempt + 1);
        setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Новое заведение"
      subtitle="Склад, ресторан, магазин, кафе или бар"
      width={480}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="new-location-form" loading={save.isPending}>
            Создать
          </Button>
        </>
      }
    >
      <form id="new-location-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Название" error={errors.name} required>
          {(p) => <Input {...p} value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Например, Ресторан «Набережная»" />}
        </Field>
        <Field label="Что это за заведение" required>
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
        <Field label="Адрес" hint="По желанию">
          {(p) => <Input {...p} value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} />}
        </Field>
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}
