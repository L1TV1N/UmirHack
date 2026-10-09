import { createDishBody, formatMoney, formatQty, updateDishBody, type DishDto, type ProductDto } from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Checkbox, Field, FieldRow, Input } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { LineRow, Lines, LinesFooter, LinesHead } from '../../components/Lines/Lines';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { ProductPicker, type PickedProduct } from '../../components/ProductPicker/ProductPicker';
import { useToast } from '../../components/Toast/Toast';
import { UNIT_LABELS } from '@zapas/shared';
import { errorMessage } from '../../lib/errors';
import { parseDecimal } from '../../lib/format';

interface ItemLine {
  key: number;
  product: PickedProduct | null;
  quantity: string;
}

const TEMPLATE = 'minmax(220px, 2.4fr) 130px 36px';
const LABELS = ['Ингредиент', 'На порцию', ''];
let seq = 0;
const blank = (): ItemLine => ({ key: ++seq, product: null, quantity: '' });

function DishDialog({ dish, open, onClose }: { dish: DishDto | null; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [code, setCode] = useState('');
  const [isActive, setActive] = useState(true);
  const [items, setItems] = useState<ItemLine[]>([blank()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const editing = dish !== null;

  useEffect(() => {
    if (!open) return;
    setName(dish?.name ?? '');
    setPrice(dish ? String(dish.price) : '');
    setCode(dish?.code ?? '');
    setActive(dish?.isActive ?? true);
    setItems(dish ? dish.items.map((i) => ({ key: ++seq, product: { id: i.productId, name: i.productName, unit: i.unit }, quantity: String(i.quantity) })) : [blank()]);
    setErrors({});
    setFormError(null);
  }, [open, dish]);

  const save = useAction((body: object) => (editing ? patch(`/dishes/${dish.id}`, body) : post('/dishes', body)), ['/dishes', '/stop-list', '/analytics']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const found: Record<string, string> = {};
    items.forEach((i) => {
      const q = parseDecimal(i.quantity);
      if (!i.product) found[`item${i.key}`] = 'Выберите продукт';
      else if (q === null || q <= 0) found[`item${i.key}`] = 'Укажите количество на порцию';
    });
    const draft = {
      name: name.trim(),
      price: parseDecimal(price) ?? Number.NaN,
      ...(editing ? { code: code.trim() === '' ? null : code.trim() } : code.trim() === '' ? {} : { code: code.trim() }),
      items: items.map((i) => ({ productId: i.product?.id ?? '', quantity: parseDecimal(i.quantity) ?? Number.NaN })),
      ...(editing ? { isActive } : {}),
    };
    const parsed = (editing ? updateDishBody : createDishBody).safeParse(draft);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.path[0] !== 'items') found[String(issue.path[0])] ??= issue.message;
        else if (issue.path.length === 1) setFormError(issue.message);
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(editing ? 'Блюдо сохранено' : 'Блюдо добавлено');
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'duplicate_code') setErrors({ code: err.message });
        else setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Блюдо' : 'Новое блюдо'}
      subtitle="Рецептура: сколько каждого ингредиента уходит на одну порцию"
      width={680}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="dish-form" loading={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="dish-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldRow>
          <Field label="Название" error={errors.name} required>
            {(p) => <Input {...p} value={name} maxLength={160} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <Field label="Цена, ₽" error={errors.price} required>
            {(p) => <Input {...p} numeric value={price} onChange={(e) => setPrice(e.target.value)} />}
          </Field>
        </FieldRow>
        <Field label="Код в кассе" error={errors.code} hint="Код блюда в iiko или 1С: по нему касса и доставка узнают позицию стоп-листа">
          {(p) => <Input {...p} value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <Lines.Wrap>
          <LinesHead template={TEMPLATE} labels={LABELS} />
          {items.map((i) => (
            <LineRow
            labels={LABELS}
              key={i.key}
              template={TEMPLATE}
              canRemove={items.length > 1}
              onRemove={() => setItems((all) => all.filter((x) => x.key !== i.key))}
              error={errors[`item${i.key}`]}
              cells={[
                <ProductPicker key="p" value={i.product} onChange={(p: ProductDto | null) => setItems((all) => all.map((x) => (x.key === i.key ? { ...x, product: p } : x)))} invalid={Boolean(errors[`item${i.key}`])} />,
                <>
                  <Input numeric aria-label="Количество на порцию" value={i.quantity} onChange={(e) => setItems((all) => all.map((x) => (x.key === i.key ? { ...x, quantity: e.target.value } : x)))} placeholder="0" />
                  {i.product && <span className={Lines.unit}>{UNIT_LABELS[i.product.unit]}</span>}
                </>,
              ]}
            />
          ))}
          <LinesFooter onAdd={() => setItems((all) => [...all, blank()])} />
        </Lines.Wrap>
        {editing && <Checkbox label="Блюдо в меню" checked={isActive} onChange={(e) => setActive(e.target.checked)} />}
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}

export default function DishesPage() {
  const { can } = useAuth();
  const dishes = useGet<DishDto[]>('/dishes');
  const [editing, setEditing] = useState<DishDto | 'new' | null>(null);

  useEffect(() => {
    document.title = 'Блюда — Запас';
  }, []);

  const columns: Column<DishDto>[] = [
    { key: 'name', header: 'Блюдо', cell: (d) => <strong>{d.name}</strong> },
    { key: 'code', header: 'Код в кассе', cell: (d) => (d.code ? <span className="mono">{d.code}</span> : <span className="muted">—</span>) },
    { key: 'price', header: 'Цена', align: 'right', cell: (d) => <span className="num">{formatMoney(d.price)}</span> },
    {
      key: 'items',
      header: 'Состав на порцию',
      cell: (d) => (
        <span style={{ color: 'var(--ink-700)' }}>
          {d.items.map((i) => `${i.productName} ${formatQty(i.quantity, i.unit)}`).join(', ')}
        </span>
      ),
    },
    { key: 'status', header: 'Статус', cell: (d) => <Chip tone={d.isActive ? 'ok' : 'neutral'}>{d.isActive ? 'В меню' : 'Снято'}</Chip> },
  ];

  return (
    <>
      <PageHeader
        title="Блюда"
        subtitle="Рецептуры нужны для двух вещей: при продаже блюда ингредиенты списываются сами, а стоп-лист показывает, чего не хватает."
        actions={
          can('manager') && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
              Новое блюдо
            </Button>
          )
        }
      />
      <Panel>
        {dishes.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={dishes.error} onRetry={() => void dishes.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={dishes.data} rowKey={(d) => d.id} loading={dishes.isLoading} onRowClick={can('manager') ? setEditing : undefined} caption="Блюда" empty="Блюд пока нет" />
        )}
      </Panel>
      <DishDialog open={editing !== null} dish={editing && editing !== 'new' ? editing : null} onClose={() => setEditing(null)} />
    </>
  );
}
