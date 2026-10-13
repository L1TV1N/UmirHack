import { formatQty, UNIT_LABELS, type DishDto, type ProductDto, type StopListDto } from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { submitDocument } from '../../api/documents';
import { STOCK_PREFIXES, useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Field, Input, Select } from '../../components/Controls/Controls';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { LineRow, Lines, LinesFooter, LinesHead, useLines } from '../../components/Lines/Lines';
import { ProductPicker } from '../../components/ProductPicker/ProductPicker';
import { ScanButton, type ScanHit } from '../../components/Scanner/ScanButton';
import type { ScanFeedback } from '../../components/Scanner/ScannerDialog';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { parseDecimal } from '../../lib/format';
import { focusFirstInvalid, LocationField, useIdempotencyKey, useOperationLocation } from './common';
import styles from './Forms.module.scss';

interface Line {
  key: number;
  kind: 'product' | 'dish';
  product: ProductDto | null;
  dishId: string;
  quantity: string;
}

const TEMPLATE = '120px minmax(220px, 2.4fr) 130px 36px';
const LABELS = ['Что заказано', 'Позиция', 'Количество', ''];

export function SaleForm() {
  const toast = useToast();
  const { user } = useAuth();
  const [locationId, setLocation, locations] = useOperationLocation();
  const dishes = useGet<DishDto[]>('/dishes', undefined, { staleTime: 60_000 });
  const stopList = useGet<StopListDto>('/stop-list', { locationId }, { enabled: Boolean(locationId), refetchInterval: 30_000 });
  const stoppedDishes = new Set(stopList.data?.entries.filter((e) => e.entityType === 'dish' && e.locationId === locationId).map((e) => e.entityId));
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [locationError, setLocationError] = useState<string | undefined>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const { lines, add, remove, update, reset, upsert } = useLines<Line>(() => ({ kind: 'product', product: null, dishId: '', quantity: '' }));
  const create = useAction(
    (body: object) =>
      submitDocument<{ number: string }>(user?.id ?? '', { path: '/documents/sales', body, key: key(), label: `Заказ, ${(body as { lines: unknown[] }).lines.length} поз.` }),
    STOCK_PREFIXES,
  );

  const onScan = ({ product }: ScanHit): ScanFeedback => {
    if (!product.sellable) return { ok: false, message: `${product.name}: не продаётся отдельно` };
    const { line } = upsert(
      (l) => l.kind === 'product' && l.product?.id === product.id,
      (l) => ({ quantity: String((parseDecimal(l.quantity) ?? 0) + 1) }),
      { kind: 'product', product, dishId: '', quantity: '1' },
      (l) => l.kind === 'product' && !l.product,
    );
    return { ok: true, message: `${product.name}: ${formatQty(parseDecimal(line.quantity) ?? 1, product.unit)}` };
  };

  const activeDishes = dishes.data?.filter((d) => d.isActive) ?? [];

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setServerError(null);
    const found: Record<number, string> = {};
    const payload = lines.map((l) => {
      const quantity = parseDecimal(l.quantity);
      if (l.kind === 'product' && !l.product) found[l.key] = 'Выберите продукт';
      else if (l.kind === 'dish' && !l.dishId) found[l.key] = 'Выберите блюдо';
      else if (quantity === null || quantity <= 0) found[l.key] = 'Укажите количество';
      else if (l.kind === 'dish' && !Number.isInteger(quantity)) found[l.key] = 'Блюда считаются целыми порциями';
      return l.kind === 'dish' ? { dishId: l.dishId, quantity } : { productId: l.product?.id, quantity };
    });
    setErrors(found);
    setLocationError(locationId ? undefined : 'Выберите точку, на которой принимается заказ');
    if (Object.keys(found).length > 0 || !locationId) {
      focusFirstInvalid(form);
      return;
    }

    create.mutate(
      { locationId, ...(comment.trim() ? { comment: comment.trim() } : {}), lines: payload },
      {
        onSuccess: (r) => {
          if (r.queued) toast.info('Нет связи: заказ сохранён в очереди и уйдёт сам, когда связь вернётся');
          else toast.success(`Заказ ${r.result.number} принят, продукты списаны`);
          reset();
          setComment('');
          renewKey();
        },
        onError: (err) => setServerError(errorMessage(err)),
      },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.info}>
        Заказ гостя проверяет, хватает ли ингредиентов, и списывает их по рецептуре, начиная с партий, что раньше испортятся. Если чего-то не хватает, заказ отклоняется целиком и показывается, чего именно. Блюда из стоп-листа выбрать нельзя. Просроченное не продаётся. Обычно заказы приходят из кассы через API, форма нужна для ручного ввода и отдельных товаров.
      </div>
      <div className={styles.top}>
        <LocationField value={locationId} onChange={(id) => { setLocation(id); setLocationError(undefined); }} options={locations} error={locationError} />
        <Field label="Комментарий">{(p) => <Input {...p} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />}</Field>
      </div>

      <Lines.Wrap>
        <LinesHead template={TEMPLATE} labels={LABELS} />
        {lines.map((l) => (
          <LineRow
            labels={LABELS}
            key={l.key}
            template={TEMPLATE}
            canRemove={lines.length > 1}
            onRemove={() => remove(l.key)}
            error={errors[l.key]}
            cells={[
              <Select key="k" aria-label="Что заказано" value={l.kind} onChange={(e) => update(l.key, { kind: e.target.value as Line['kind'], product: null, dishId: '' })}>
                <option value="product">Товар</option>
                <option value="dish">Блюдо</option>
              </Select>,
              l.kind === 'product' ? (
                <ProductPicker key="p" sellableOnly value={l.product} onChange={(p) => update(l.key, { product: p })} invalid={Boolean(errors[l.key])} />
              ) : (
                <Select key="d" aria-label="Блюдо" value={l.dishId} onChange={(e) => update(l.key, { dishId: e.target.value })}>
                  <option value="">Выберите блюдо</option>
                  {activeDishes.map((d) => (
                    <option key={d.id} value={d.id} disabled={stoppedDishes.has(d.id)}>
                      {d.name}
                      {stoppedDishes.has(d.id) ? ' - в стоп-листе' : ''}
                    </option>
                  ))}
                </Select>
              ),
              <>
                <Input numeric aria-label="Количество" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} placeholder="0" />
                <span className={Lines.unit}>{l.kind === 'dish' ? 'порций' : l.product ? UNIT_LABELS[l.product.unit] : ''}</span>
              </>,
            ]}
          />
        ))}
        <LinesFooter onAdd={add}>
          <ScanButton onProduct={onScan} title="Сканирование заказа" hint="Каждый скан добавляет единицу товара в заказ" />
        </LinesFooter>
      </Lines.Wrap>

      {serverError && <ErrorNote message={serverError} />}
      <div className={styles.foot}>
        <span />
        <Button variant="primary" type="submit" loading={create.isPending}>
          Принять заказ
        </Button>
      </div>
    </form>
  );
}
