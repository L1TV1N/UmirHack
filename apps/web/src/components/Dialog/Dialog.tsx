import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.scss';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
}

// Несколько окон могут быть открыты друг над другом: прокрутку страницы возвращаем, когда закрылось последнее
let scrollLocks = 0;
let savedOverflow = '';

export function Dialog({ open, onClose, title, subtitle, width = 520, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // фокус на отмеченный элемент, иначе на первое поле формы, а не на крестик закрытия
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        bodyRef.current?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      target?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLocks += 1;
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
    };
  }, [open]);

  // Окно выносится в body: внутри формы страницы получилась бы вложенная форма, и Chrome не доставляет её submit до React
  return createPortal(
    <dialog
      ref={ref}
      className={styles.dialog}
      style={{ ['--dialog-width' as string]: `${width}px` }}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // клик по затемнению, но не по содержимому
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className={styles.head}>
            <div>
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p className={styles.sub}>{subtitle}</p>}
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>
          <div className={styles.body} ref={bodyRef}>{children}</div>
          {footer && <div className={styles.foot}>{footer}</div>}
        </>
      )}
    </dialog>,
    document.body,
  );
}
