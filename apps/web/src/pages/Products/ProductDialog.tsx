import {
  createProductBody,
  UNITS,
  UNIT_LABELS,
  updateProductBody,
  type CategoryDto,
  type ProductDto,
  type SupplierDto,
  type Unit,
} from '@zapas/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, patch, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Checkbox, Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { parseDecimal } from '../../lib/format';


interface State {
  sku: string;
  barcode: string;
  name: string;
  categoryId: string;
  unit: Unit;
  minStock: string;
  shelfLifeDays: string;
  price: string;
  cost: string;
  sellable: boolean;
  requiresVsd: boolean;
  requiresMarking: boolean;
  defaultSupplierId: string;
  packSize: string;
  isActive: boolean;
}

function empty(categoryId: string): State {
  return { sku: '', barcode: '', name: '', categoryId, unit: 'kg', minStock: '0', shelfLifeDays: '', price: '', cost: '', sellable: true, requiresVsd: false, requiresMarking: false, defaultSupplierId: '', packSize: '1', isActive: true };
}

function fromProduct(p: ProductDto): State {
  return {
    sku: p.sku,
    barcode: p.barcode ?? '',
    name: p.name,
    categoryId: p.categoryId,
    unit: p.unit,
    minStock: String(p.minStock),
    shelfLifeDays: p.shelfLifeDays ? String(p.shelfLifeDays) : '',
    price: String(p.price),
    cost: String(p.cost),
    sellable: p.sellable,
    requiresVsd: p.requiresVsd,
    requiresMarking: p.requiresMarking,
    defaultSupplierId: p.defaultSupplierId ?? '',
    packSize: String(p.packSize),
    isActive: p.isActive,
  };
}

export function ProductDialog({ open, product, categories, onClose }: { open: boolean; product: ProductDto | null; categories: CategoryDto[]; onClose: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<State>(() => empty(categories[0]?.id ?? ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const editing = product !== null;
  const suppliers = useGet<SupplierDto[]>('/suppliers', undefined, { enabled: open, staleTime: 120_000 });

  // список категорий может обновиться в фоне, пока окно открыто: введённое при этом сбрасывать нельзя
  const firstCategory = useRef(categories[0]?.id ?? '');
  firstCategory.current = categories[0]?.id ?? '';
  useEffect(() => {
    if (open) {
      setS(product ? fromProduct(product) : empty(firstCategory.current));
      setErrors({});
      setFormError(null);
    }
  }, [open, product]);

  const save = useAction((body: object) => (editing ? patch<ProductDto>(`/products/${product.id}`, body) : post<ProductDto>('/products', body)), ['/products', '/stock']);
  const set = <K extends keyof State>(key: K, value: State[K]) => setS((cur) => ({ ...cur, [key]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const shelf = s.shelfLifeDays.trim() === '' ? undefined : Number(s.shelfLifeDays);
    const common = {
      sku: s.sku.trim(),
      name: s.name.trim(),
      categoryId: s.categoryId,
      unit: s.unit,
      minStock: parseDecimal(s.minStock) ?? Number.NaN,
      price: parseDecimal(s.price) ?? Number.NaN,
      cost: parseDecimal(s.cost) ?? Number.NaN,
      sellable: s.sellable,
      requiresVsd: s.requiresVsd,
      requiresMarking: s.requiresMarking,
      packSize: parseDecimal(s.packSize) ?? Number.NaN,
    };
    const parsed = editing
      ? updateProductBody.safeParse({ ...common, barcode: s.barcode.trim() || null, shelfLifeDays: shelf ?? null, defaultSupplierId: s.defaultSupplierId || null, isActive: s.isActive })
      : createProductBody.safeParse({ ...common, ...(s.barcode.trim() ? { barcode: s.barcode.trim() } : {}), ...(shelf !== undefined ? { shelfLifeDays: shelf } : {}), ...(s.defaultSupplierId ? { defaultSupplierId: s.defaultSupplierId } : {}) });
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.message;
      setErrors(out);
      return;
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(editing ? 'Карточка сохранена' : 'Продукт добавлен');
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && Object.keys(err.fieldErrors()).length) setErrors(err.fieldErrors());
        else setFormError(errorMessage(err));
        if (err instanceof ApiError && err.code.startsWith('duplicate_')) setErrors({ [err.code === 'duplicate_sku' ? 'sku' : 'barcode']: err.message });
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Карточка продукта' : 'Новый продукт'}
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="product-form" loading={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Название" error={errors.name} required>
          {(p) => <Input {...p} value={s.name} maxLength={160} onChange={(e) => set('name', e.target.value)} autoFocus />}
        </Field>
        <FieldRow>
          <Field label="Артикул" error={errors.sku} required>
            {(p) => <Input {...p} value={s.sku} maxLength={32} onChange={(e) => set('sku', e.target.value)} />}
          </Field>
          <Field label="Штрихкод" error={errors.barcode} hint="8–14 цифр">
            {(p) => <Input {...p} inputMode="numeric" value={s.barcode} maxLength={14} onChange={(e) => set('barcode', e.target.value)} />}
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Категория" error={errors.categoryId} hint={categories.length === 0 ? 'Категорий пока нет, добавьте их на вкладке «Категории»' : undefined} required>
            {(p) => (
              <Select {...p} value={s.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Единица" hint={editing ? 'Меняется только до первого прихода' : undefined} required>
            {(p) => (
              <Select {...p} value={s.unit} onChange={(e) => set('unit', e.target.value as Unit)}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {UNIT_LABELS[u]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </FieldRow>
        <FieldRow cols={3}>
          <Field label="Цена продажи, ₽" error={errors.price} required>
            {(p) => <Input {...p} numeric value={s.price} onChange={(e) => set('price', e.target.value)} />}
          </Field>
          <Field label="Себестоимость, ₽" error={errors.cost} required>
            {(p) => <Input {...p} numeric value={s.cost} onChange={(e) => set('cost', e.target.value)} />}
          </Field>
          <Field label={`Минимум, ${UNIT_LABELS[s.unit]}`} error={errors.minStock} hint="Ниже порога позиция попадёт в «Ниже минимума»">
            {(p) => <Input {...p} numeric value={s.minStock} onChange={(e) => set('minStock', e.target.value)} />}
          </Field>
        </FieldRow>
        <Field label="Срок годности, суток" error={errors.shelfLifeDays} hint="Подставляется при приходе, можно изменить">
          {(p) => <Input {...p} inputMode="numeric" value={s.shelfLifeDays} onChange={(e) => set('shelfLifeDays', e.target.value)} />}
        </Field>
        <FieldRow>
          <Field label="Поставщик по умолчанию" hint="У него «Запас» предложит заказывать этот продукт">
            {(p) => (
              <Select {...p} value={s.defaultSupplierId} onChange={(e) => set('defaultSupplierId', e.target.value)}>
                <option value="">Не задан</option>
                {(suppliers.data ?? [])
                  .filter((x) => x.isActive || x.id === s.defaultSupplierId)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={`Фасовка заказа, ${UNIT_LABELS[s.unit]}`} error={errors.packSize} hint="Заказ округляется вверх до целого числа таких упаковок">
            {(p) => <Input {...p} numeric value={s.packSize} onChange={(e) => set('packSize', e.target.value)} />}
          </Field>
        </FieldRow>
        <Checkbox label="Продаётся отдельно (не только ингредиент для блюд)" checked={s.sellable} onChange={(e) => set('sellable', e.target.checked)} />
        <Checkbox label="Идёт с ветеринарным документом (ВСД, «Меркурий»)" checked={s.requiresVsd} onChange={(e) => set('requiresVsd', e.target.checked)} />
        <Checkbox label="Маркированный товар («Честный знак»)" checked={s.requiresMarking} onChange={(e) => set('requiresMarking', e.target.checked)} />
        {editing && <Checkbox label="Активен" checked={s.isActive} onChange={(e) => set('isActive', e.target.checked)} />}
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}
