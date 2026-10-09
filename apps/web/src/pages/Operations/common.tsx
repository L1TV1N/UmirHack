import type { LocationDto } from '@zapas/shared';
import { useEffect, useRef, useState } from 'react';
import { newIdempotencyKey } from '../../api/client';
import { useScope } from '../../auth/ScopeProvider';
import { Field, Select } from '../../components/Controls/Controls';

/**
 * Точка операции: выбранная в шапке. Если в шапке «Все точки», выбор остаётся за человеком: молча подставить
 * первую точку значило бы провести продажу или списание не там, где он думает.
 */
export function useOperationLocation(): [string, (id: string) => void, LocationDto[]] {
  const scope = useScope();
  const options = scope.activeLocations;
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [scope.activeId]);
  const preset = scope.locationId ?? '';
  const current = picked && options.some((o) => o.id === picked) ? picked : preset;
  return [current, setPicked, options];
}

export function LocationField({
  label = 'Точка',
  value,
  onChange,
  options,
  exclude,
  error,
}: {
  label?: string;
  value: string;
  onChange: (id: string) => void;
  options: LocationDto[];
  exclude?: string;
  error?: string | undefined;
}) {
  return (
    <Field label={label} required error={error}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
          {value === '' && (
            <option value="" disabled>
              Выберите точку
            </option>
          )}
          {options
            .filter((o) => o.id !== exclude)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}

/** Один ключ на попытку: повтор после обрыва связи не создаст второй документ. */
export function useIdempotencyKey(): [() => string, () => void] {
  const ref = useRef(newIdempotencyKey());
  return [() => ref.current, () => (ref.current = newIdempotencyKey())];
}

/** После неудачной проверки переносит фокус на первое поле с ошибкой, чтобы не искать его глазами. */
export function focusFirstInvalid(form: HTMLFormElement): void {
  window.setTimeout(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
}
