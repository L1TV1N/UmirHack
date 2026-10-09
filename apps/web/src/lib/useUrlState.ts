import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Состояние страницы в адресе: фильтры и страницу можно сохранить в закладку и отправить коллеге.
 * Значения по умолчанию в адрес не попадают. При смене фильтра страница сбрасывается.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const [params, setParams] = useSearchParams();
  // defaults приходят литералом на каждый рендер, поэтому держим копию, пока содержимое не изменилось
  const key = JSON.stringify(defaults);
  const stable = useMemo(() => JSON.parse(key) as T, [key]);

  const values = useMemo(() => {
    const out: Record<string, string> = { ...stable };
    for (const name of Object.keys(stable)) {
      const v = params.get(name);
      if (v !== null) out[name] = v;
    }
    return out as T;
  }, [params, stable]);

  const set = useCallback(
    (patch: Partial<T>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined || v === stable[k] || v === '') next.delete(k);
            else next.set(k, v as string);
          }
          if (!('offset' in patch) && 'offset' in stable) next.delete('offset');
          return next;
        },
        { replace: true },
      );
    },
    [setParams, stable],
  );

  return [values, set];
}
