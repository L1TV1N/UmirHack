import { daysWord, isValidInn, type CategoryDto, type SupplierDto } from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, FieldRow, Input } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { parseDecimal } from '../../lib/format';

export function CategoriesPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const list = useGet<CategoryDto[]>('/categories');
  const [editing, setEditing] = useState<CategoryDto | 'new' | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction(
    (v: { id?: string; name: string }) => (v.id ? patch(`/categories/${v.id}`, { name: v.name }) : post('/categories', { name: v.name })),
    ['/categories', '/products', '/stock'],
  );

  const open = (c: CategoryDto | 'new') => {
    setEditing(c);
    setName(c === 'new' ? '' : c.name);
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Введите название');
    save.mutate(
      { ...(editing && editing !== 'new' ? { id: editing.id } : {}), name: name.trim() },
      {
        onSuccess: () => {
          toast.success('Категория сохранена');
          setEditing(null);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const columns: Column<CategoryDto>[] = [
    { key: 'name', header: 'Категория', cell: (c) => <strong>{c.name}</strong> },
    { key: 'edit', header: '', align: 'right', cell: (c) => can('manager') && <Button size="sm" onClick={() => open(c)}>Переименовать</Button> },
  ];

  return (
    <>
      <Panel title="Категории" actions={can('manager') && <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => open('new')}>Добавить</Button>}>
        <DataTable columns={columns} rows={list.data} rowKey={(c) => c.id} loading={list.isLoading} empty="Категорий нет" />
      </Panel>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Новая категория' : 'Переименовать категорию'}
        width={400}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Отмена</Button>
            <Button variant="primary" type="submit" form="category-form" loading={save.isPending}>
              Сохранить
            </Button>
          </>
        }
      >
        <form id="category-form" onSubmit={submit} noValidate>
          <Field label="Название" error={error ?? undefined} required>
            {(p) => <Input {...p} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
        </form>
      </Dialog>
    </>
  );
}

const EMPTY_SUPPLIER = { name: '', inn: '', phone: '', note: '', email: '', leadTimeDays: '1', minOrderSum: '0', autoOrder: false, isActive: true };

export function SuppliersPanel() {
  const { can } = useAuth();
  const toast = useToast();
  const list = useGet<SupplierDto[]>('/suppliers');
  const [editing, setEditing] = useState<SupplierDto | 'new' | null>(null);
  const [form, setForm] = useState(EMPTY_SUPPLIER);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const save = useAction(
    (v: { id?: string; body: object }) => (v.id ? patch(`/suppliers/${v.id}`, v.body) : post('/suppliers', v.body)),
    ['/suppliers'],
  );

  const open = (s: SupplierDto | 'new') => {
    setEditing(s);
    setForm(
      s === 'new'
        ? EMPTY_SUPPLIER
        : { name: s.name, inn: s.inn ?? '', phone: s.phone ?? '', note: s.note ?? '', email: s.email ?? '', leadTimeDays: String(s.leadTimeDays), minOrderSum: String(s.minOrderSum), autoOrder: s.autoOrder, isActive: s.isActive },
    );
    setError(null);
    setFieldError({});
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setFieldError({ name: 'Введите название' });
    if (form.inn.trim() && !isValidInn(form.inn.trim())) return setFieldError({ inn: 'Некорректный ИНН: 10 или 12 цифр' });
    const lead = Number(form.leadTimeDays);
    if (!Number.isInteger(lead) || lead < 0 || lead > 30) return setFieldError({ leadTimeDays: 'От 0 до 30 суток' });
    const minSum = parseDecimal(form.minOrderSum || '0');
    if (minSum === null || minSum < 0) return setFieldError({ minOrderSum: 'Сумма не меньше нуля' });
    if (form.autoOrder && !form.email.trim()) return setFieldError({ email: 'Для автозаказа укажите почту: заказ уходит письмом' });
    setFieldError({});
    save.mutate(
      {
        ...(editing && editing !== 'new' ? { id: editing.id } : {}),
        body: {
          name: form.name.trim(),
          inn: form.inn.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(form.note.trim() ? { note: form.note.trim() } : {}),
          email: form.email.trim(),
          leadTimeDays: lead,
          minOrderSum: minSum,
          autoOrder: form.autoOrder,
          isActive: form.isActive,
        },
      },
      {
        onSuccess: () => {
          toast.success('Поставщик сохранён');
          setEditing(null);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'duplicate_name') setFieldError({ name: err.message });
          else if (err instanceof ApiError && Object.keys(err.fieldErrors()).length > 0) setFieldError(err.fieldErrors());
          else setError(errorMessage(err));
        },
      },
    );
  };

  const columns: Column<SupplierDto>[] = [
    { key: 'name', header: 'Поставщик', cell: (s) => <strong>{s.name}</strong> },
    { key: 'inn', header: 'ИНН', cell: (s) => (s.inn ? <span className="num">{s.inn}</span> : <span className="muted">—</span>) },
    { key: 'phone', header: 'Телефон', cell: (s) => s.phone ?? <span className="muted">—</span> },
    { key: 'email', header: 'Почта для заказов', cell: (s) => s.email ?? <span className="muted">—</span> },
    { key: 'lead', header: 'Привозит за', align: 'right', cell: (s) => <span className="num">{s.leadTimeDays === 0 ? 'в тот же день' : daysWord(s.leadTimeDays)}</span> },
    { key: 'status', header: 'Статус', cell: (s) => <Chip tone={s.isActive ? 'ok' : 'neutral'}>{s.isActive ? 'Работаем' : 'Отключён'}</Chip> },
    { key: 'edit', header: '', align: 'right', cell: (s) => can('manager') && <Button size="sm" onClick={() => open(s)}>Изменить</Button> },
  ];

  return (
    <>
      <Panel title="Поставщики" actions={can('manager') && <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => open('new')}>Добавить</Button>}>
        <DataTable columns={columns} rows={list.data} rowKey={(s) => s.id} loading={list.isLoading} empty="Поставщиков нет" />
      </Panel>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Новый поставщик' : 'Поставщик'}
        width={480}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Отмена</Button>
            <Button variant="primary" type="submit" form="supplier-form" loading={save.isPending}>
              Сохранить
            </Button>
          </>
        }
      >
        <form id="supplier-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Название" error={fieldError.name} required>
            {(p) => <Input {...p} value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />}
          </Field>
          <Field label="ИНН" error={fieldError.inn} hint="По нему накладная из ЭДО находит поставщика сама">
            {(p) => <Input {...p} inputMode="numeric" value={form.inn} maxLength={12} onChange={(e) => setForm({ ...form, inn: e.target.value.replace(/\D/g, '') })} />}
          </Field>
          <FieldRow>
            <Field label="Телефон">{(p) => <Input {...p} value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
            <Field label="Заметка">{(p) => <Input {...p} value={form.note} maxLength={300} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field>
          </FieldRow>
          <Field label="Почта для заказов" error={fieldError.email} hint="Один адрес. На него уходит текст заказа, ответ придёт отправившему менеджеру">
            {(p) => <Input {...p} type="email" inputMode="email" value={form.email} maxLength={254} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
          </Field>
          <FieldRow>
            <Field label="Привозит за, суток" error={fieldError.leadTimeDays} hint="Заказ считается с учётом срока поставки">
              {(p) => <Input {...p} inputMode="numeric" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value.replace(/\D/g, '') })} />}
            </Field>
            <Field label="Минимальный заказ, ₽" error={fieldError.minOrderSum} hint="Меньше этой суммы поставщик заказ не берёт">
              {(p) => <Input {...p} numeric value={form.minOrderSum} onChange={(e) => setForm({ ...form, minOrderSum: e.target.value })} />}
            </Field>
          </FieldRow>
          <Checkbox label="Каждое утро готовить черновик заказа по остаткам (отправляет человек)" checked={form.autoOrder} onChange={(e) => setForm({ ...form, autoOrder: e.target.checked })} />
          <Checkbox label="Работаем с поставщиком" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          {error && <ErrorNote message={error} />}
        </form>
      </Dialog>
    </>
  );
}
