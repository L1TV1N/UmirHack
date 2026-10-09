import {
  formatQty,
  WRITEOFF_REASONS,
  WRITEOFF_REASON_LABELS,
  UNIT_LABELS,
  type BatchDto,
  type WriteoffReason,
} from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { newIdempotencyKey, post } from '../../api/client';
import { STOCK_PREFIXES, useAction } from '../../api/hooks';
import { errorMessage } from '../../lib/errors';
import { fmtDate, parseDecimal } from '../../lib/format';
import { Button } from '../Button/Button';
import { Field, FieldRow, Input, Select } from '../Controls/Controls';
import { Dialog } from '../Dialog/Dialog';
import { useToast } from '../Toast/Toast';

interface BatchDialogProps {
  batch: BatchDto | null;
  onClose: () => void;
}

export function PromotionDialog({ batch, onClose }: BatchDialogProps) {
  const toast = useToast();
  const [percent, setPercent] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const create = useAction((vars: { batchId: string; percent: number }) => post('/promotions', vars), STOCK_PREFIXES);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseDecimal(percent);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 90) {
      setError('Целое число от 1 до 90');
      return;
    }
    create.mutate(
      { batchId: (batch as BatchDto).id, percent: n },
      {
        onSuccess: () => {
          toast.success(`Скидка ${n}% включена`);
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open={batch !== null}
      onClose={onClose}
      title="Скидка на партию"
      subtitle={batch ? `${batch.productName}, годен до ${fmtDate(batch.expiresOn)}` : undefined}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="promotion-form" loading={create.isPending}>
            Включить скидку
          </Button>
        </>
      }
    >
      <form id="promotion-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ color: 'var(--ink-700)' }}>
          Остаток {batch ? formatQty(batch.remainingQty, batch.unit) : ''}. Скидка действует на эту партию до конца срока годности и применяется при продаже автоматически.
        </p>
        <Field label="Размер скидки, %" error={error ?? undefined} required>
          {(p) => <Input {...p} numeric value={percent} onChange={(e) => setPercent(e.target.value)} autoFocus />}
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          {[15, 30, 50].map((n) => (
            <Button key={n} size="sm" onClick={() => setPercent(String(n))}>
              {n}%
            </Button>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

export function WriteoffDialog({ batch, onClose, defaultReason = 'spoiled' }: BatchDialogProps & { defaultReason?: WriteoffReason }) {
  const toast = useToast();
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState<WriteoffReason>(defaultReason);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useAction(
    (vars: { locationId: string; productId: string; batchId: string; quantity: number; reason: WriteoffReason; comment: string }) =>
      post<{ number: string }>(
        '/documents/writeoffs',
        {
          locationId: vars.locationId,
          reason: vars.reason,
          ...(vars.comment ? { comment: vars.comment } : {}),
          lines: [{ productId: vars.productId, batchId: vars.batchId, quantity: vars.quantity }],
        },
        { 'idempotency-key': newIdempotencyKey() },
      ),
    STOCK_PREFIXES,
  );

  if (!batch) return <Dialog open={false} onClose={onClose} title="" children={null} />;
  const shown = qty === '' ? String(batch.remainingQty) : qty;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = parseDecimal(shown);
    if (n === null || n <= 0 || n > batch.remainingQty) {
      setError(`Не больше остатка: ${formatQty(batch.remainingQty, batch.unit)}`);
      return;
    }
    create.mutate(
      { locationId: batch.locationId, productId: batch.productId, batchId: batch.id, quantity: n, reason, comment: comment.trim() },
      {
        onSuccess: (r) => {
          toast.success(`Списано, документ ${r.number}`);
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Списание партии"
      subtitle={`${batch.productName}, годен до ${fmtDate(batch.expiresOn)}`}
      width={440}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="dangerSolid" type="submit" form="writeoff-form" loading={create.isPending}>
            Списать
          </Button>
        </>
      }
    >
      <form id="writeoff-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldRow>
          <Field label={`Количество, ${UNIT_LABELS[batch.unit]}`} error={error ?? undefined} required>
            {(p) => <Input {...p} numeric value={shown} onChange={(e) => setQty(e.target.value)} autoFocus />}
          </Field>
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
        </FieldRow>
        <Field label="Комментарий">{(p) => <Input {...p} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}
