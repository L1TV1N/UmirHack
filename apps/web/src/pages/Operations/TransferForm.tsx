import { formatQty, UNIT_LABELS, type ProductDto } from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { submitDocument } from '../../api/documents';
import { STOCK_PREFIXES, useAction } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
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
  product: ProductDto | null;
  quantity: string;
}

const TEMPLATE = 'minmax(220px, 2.4fr) 130px 36px';
const LABELS = ['Продукт', 'Количество', ''];

export function TransferForm() {
  const toast = useToast();
  const { user } = useAuth();
  const [from, setFrom, locations] = useOperationLocation();
  const [to, setTo] = useState('');
  const [fromError, setFromError] = useState<string | undefined>();
  const [toError, setToError] = useState<string | undefined>();
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const { lines, add, remove, update, reset, upsert } = useLines<Line>(() => ({ product: null, quantity: '' }));
  const create = useAction(
    (body: object) =>
      submitDocument<{ number: string }>(user?.id ?? '', { path: '/documents/transfers', body, key: key(), label: `Перемещение, ${(body as { lines: unknown[] }).lines.length} поз.` }),
    STOCK_PREFIXES,
  );

  const onScan = ({ product }: ScanHit): ScanFeedback => {
    const { line } = upsert(
      (l) => l.product?.id === product.id,
      (l) => ({ quantity: String((parseDecimal(l.quantity) ?? 0) + 1) }),
      { product, quantity: '1' },
      (l) => !l.product,
    );
    return { ok: true, message: `${product.name}: ${formatQty(parseDecimal(line.quantity) ?? 1, product.unit)} к перемещению` };
  };

  // получатель подставляется сам, только когда вариант единственный
  const others = locations.filter((l) => l.id !== from);
  const target = others.find((l) => l.id === to)?.id ?? (others.length === 1 ? (others[0]?.id ?? '') : '');

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setServerError(null);
    const found: Record<number, string> = {};
    const payload = lines.map((l) => {
      const quantity = parseDecimal(l.quantity);
      if (!l.product) found[l.key] = 'Выберите продукт';
      else if (quantity === null || quantity <= 0) found[l.key] = 'Укажите количество';
      return { productId: l.product?.id, quantity };
    });
    setErrors(found);
    setFromError(from ? undefined : 'Выберите точку отправления');
    setToError(target ? undefined : locations.length < 2 ? 'Для перемещения нужна вторая точка' : 'Выберите точку получения');
    if (Object.keys(found).length > 0 || !from || !target) {
      focusFirstInvalid(form);
      return;
    }

    create.mutate(
      { fromLocationId: from, toLocationId: target, ...(comment.trim() ? { comment: comment.trim() } : {}), lines: payload },
      {
        onSuccess: (r) => {
          if (r.queued) toast.info('Нет связи: перемещение сохранено в очереди и уйдёт само, когда связь вернётся');
          else toast.success(`Перемещение ${r.result.number} проведено`);
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
      <div className={styles.info}>Сроки и себестоимость партий переходят на новую точку без изменений. Берутся партии с ближайшим сроком, просроченное не перемещается.</div>
      <div className={styles.top}>
        <LocationField label="Откуда" value={from} onChange={(id) => { setFrom(id); setFromError(undefined); }} options={locations} error={fromError} />
        <LocationField label="Куда" value={target} onChange={(id) => { setTo(id); setToError(undefined); }} options={locations} exclude={from} error={toError} />
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
              <ProductPicker key="p" value={l.product} onChange={(p) => update(l.key, { product: p })} invalid={Boolean(errors[l.key])} />,
              <>
                <Input numeric aria-label="Количество" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} placeholder="0" />
                {l.product && <span className={Lines.unit}>{UNIT_LABELS[l.product.unit]}</span>}
              </>,
            ]}
          />
        ))}
        <LinesFooter onAdd={add}>
          <ScanButton onProduct={onScan} title="Сканирование перемещения" hint="Каждый скан добавляет единицу товара к перемещению" />
        </LinesFooter>
      </Lines.Wrap>

      {serverError && <ErrorNote message={serverError} />}
      <div className={styles.foot}>
        <span />
        <Button variant="primary" type="submit" loading={create.isPending}>
          Провести перемещение
        </Button>
      </div>
    </form>
  );
}
