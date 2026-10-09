import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Ask | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((o) => {
    // второй вопрос поверх первого считается отказом от первого, иначе тот так и остался бы без ответа
    resolver.current?.(false);
    setOptions(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (answer: boolean) => {
    resolver.current?.(answer);
    resolver.current = null;
    setOptions(null);
  };

  const value = useMemo(() => ask, [ask]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <Dialog
        open={options !== null}
        onClose={() => close(false)}
        title={options?.title ?? ''}
        width={440}
        footer={
          <>
            <Button onClick={() => close(false)} data-autofocus={options?.danger ? '' : undefined}>
              Отмена
            </Button>
            <Button variant={options?.danger ? 'dangerSolid' : 'primary'} onClick={() => close(true)} data-autofocus={options?.danger ? undefined : ''}>
              {options?.confirmLabel ?? 'Подтвердить'}
            </Button>
          </>
        }
      >
        {options?.message && <div style={{ color: 'var(--ink-700)' }}>{options.message}</div>}
      </Dialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): Ask {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ConfirmProvider не подключён');
  return ctx;
}
