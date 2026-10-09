import {
  describeDaysLeft,
  formatQty,
  UNIT_LABELS,
  WRITEOFF_REASONS,
  WRITEOFF_REASON_LABELS,
  type BatchDto,
  type Page,
  type ProductDto,
  type WriteoffReason,
} from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { post } from '../../api/client';
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
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDate, parseDecimal } from '../../lib/format';
import { focusFirstInvalid, LocationField, useIdempotencyKey, useOperationLocation } from './common';
import styles from './Forms.module.scss';

interface Line {
  key: number;
  product: ProductDto | null;
  batchId: string;
  quantity: string;
}

const TEMPLATE = 'minmax(220px, 2.2fr) minmax(190px, 1.6fr) 130px 36px';
const LABELS = ['Продукт', 'Партия', 'Количество', ''];

function BatchSelect({ productId, locationId, value, onChange }: { productId: string | undefined; locationId: string; value: string; onChange: (id: string) => void }) {
  const batches = useGet<Page<BatchDto>>(
    '/stock/batches',
    { productId, locationId, status: 'active', limit: 50 },
    { enabled: Boolean(productId && locationId) },
  );
  return (
    <Select aria-label="Партия" value={value} onChange={(e) => onChange(e.target.value)} disabled={!productId}>
      <option value="">С ближайшим сроком</option>
      {batches.data?.items.map((b) => (
        <option key={b.id} value={b.id}>
          {fmtDate(b.expiresOn)} · {formatQty(b.remainingQty, b.unit)} · {describeDaysLeft(b.daysLeft)}
        </option>
      ))}
    </Select>
  );
}

export function WriteoffForm() {
  const toast = useToast();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [locationId, setLocation, locations] = useOperationLocation();
  const [reason, setReason] = useState<WriteoffReason>('spoiled');
  const [comment, setComment] = useState('');
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [locationError, setLocationError] = useState<string | undefined>();
  const [serverError, setServerError] = useState<string | null>(null);
  const [key, renewKey] = useIdempotencyKey();
  const { lines, add, remove, update, reset, upsert } = useLines<Line>(() => ({ product: null, batchId: '', quantity: '' }));

  const create = useAction(
    (body: object) =>
      submitDocument<{ number: string }>(user?.id ?? '', { path: '/documents/writeoffs', body, key: key(), label: `Списание, ${(body as { lines: unknown[] }).lines.length} поз.` }),
    STOCK_PREFIXES,
  );

  const onScan = ({ product }: ScanHit): ScanFeedback => {
    const { line } = upsert(
      (l) => l.product?.id === product.id && !l.batchId,
      (l) => ({ quantity: String((parseDecimal(l.quantity) ?? 0) + 1) }),
      { product, batchId: '', quantity: '1' },
      (l) => !l.product,
    );
    return { ok: true, message: `${product.name}: ${formatQty(parseDecimal(line.quantity) ?? 1, product.unit)} к списанию` };
  };
  const expired = useGet<Page<BatchDto>>('/stock/batches', { locationId, status: 'expired', limit: 1 }, { enabled: Boolean(locationId) });
  const writeOffExpired = useAction(() => post<{ number: string }>('/documents/writeoffs/expired', { locationId }), STOCK_PREFIXES);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setServerError(null);
    const found: Record<number, string> = {};
    const payload = lines.map((l) => {
      const quantity = parseDecimal(l.quantity);
      if (!l.product) found[l.key] = 'Выберите продукт';
      else if (quantity === null || quantity <= 0) found[l.key] = 'Укажите количество';
      return { productId: l.product?.id, ...(l.batchId ? { batchId: l.batchId } : {}), quantity };
    });
    setErrors(found);
    setLocationError(locationId ? undefined : 'Выберите точку, с которой списываем');
    if (Object.keys(found).length > 0 || !locationId) {
      focusFirstInvalid(form);
      return;
    }

    create.mutate(
      { locationId, reason, ...(comment.trim() ? { comment: comment.trim() } : {}), lines: payload },
      {
        onSuccess: (r) => {
          if (r.queued) toast.info('Нет связи: списание сохранено в очереди и уйдёт само, когда связь вернётся');
          else toast.success(`Списание ${r.result.number} проведено`);
          reset();
          setComment('');
          renewKey();
        },
        onError: (err) => setServerError(errorMessage(err)),
      },
    );
  };

  const clearExpired = async () => {
    const ok = await confirm({
      title: 'Списать всё просроченное?',
      message: 'Все партии с истёкшим сроком на этой точке будут списаны одним документом с причиной «Истёк срок».',
      confirmLabel: 'Списать',
      danger: true,
    });
    if (!ok) return;
    writeOffExpired.mutate(undefined, {
      onSuccess: (r) => toast.success(`Просроченное списано, документ ${r.number}`),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  const expiredCount = expired.data?.total ?? 0;

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {expiredCount > 0 && (
        <div className={styles.notice}>
          <span>На точке просроченных партий: {expiredCount}</span>
          <Button size="sm" variant="danger" onClick={() => void clearExpired()} loading={writeOffExpired.isPending}>
            Списать всё просроченное
          </Button>
        </div>
      )}
      <div className={styles.top}>
        <LocationField
          value={locationId}
          onChange={(id) => {
            setLocation(id);
            setLocationError(undefined);
            // партии принадлежат точке: выбранные на прежней теряют смысл
            for (const l of lines) if (l.batchId) update(l.key, { batchId: '' });
          }}
          options={locations}
          error={locationError}
        />
        <Field label="Причина" required>
          {(p) => (
            <Select {...p} value={reason} onChange={(e) => setReason(e.target.value as WriteoffReason)}>
              {WRITEOFF_REASONS.map((r) => (
                <option key={r} value={r}>
                  {WRITEOFF_REASON_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
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
              <ProductPicker key="p" value={l.product} onChange={(p) => update(l.key, { product: p, batchId: '' })} invalid={Boolean(errors[l.key])} />,
              <BatchSelect key="b" productId={l.product?.id} locationId={locationId} value={l.batchId} onChange={(id) => update(l.key, { batchId: id })} />,
              <>
                <Input numeric aria-label="Количество" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} placeholder="0" />
                {l.product && <span className={Lines.unit}>{UNIT_LABELS[l.product.unit]}</span>}
              </>,
            ]}
          />
        ))}
        <LinesFooter onAdd={add}>
          <ScanButton onProduct={onScan} title="Сканирование списания" hint="Каждый скан добавляет единицу товара к списанию. Партию можно выбрать в форме" />
        </LinesFooter>
      </Lines.Wrap>

      {serverError && <ErrorNote message={serverError} />}
      <div className={styles.foot}>
        <span className="muted">Без выбора партии списывается та, что раньше всех истекает.</span>
        <Button variant="dangerSolid" type="submit" loading={create.isPending}>
          Провести списание
        </Button>
      </div>
    </form>
  );
}
