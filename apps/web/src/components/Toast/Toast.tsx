import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Toast.module.scss';

interface ToastItem {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

interface ToastApi {
  success(text: string): void;
  error(text: string): void;
  info(text: string): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastItem['kind'], text: string) => {
      seq.current += 1;
      const id = seq.current;
      setItems((list) => [...list.slice(-3), { id, kind, text }]);
      window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ success: (t) => push('success', t), error: (t) => push('error', t), info: (t) => push('info', t) }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className={styles.region} role="region" aria-label="Уведомления" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`${styles.toast} ${t.kind === 'error' ? styles.error : t.kind === 'info' ? styles.info : ''}`}>
            <span>{t.text}</span>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Закрыть уведомление">
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ToastProvider не подключён');
  return ctx;
}
