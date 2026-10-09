import { useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useConfirm } from '../components/Toast/Confirm';

/**
 * Не даёт случайно потерять несохранённую работу: закрытие вкладки спрашивает браузер, переход по ссылке
 * внутри приложения спрашиваем сами. Кнопки «назад» и «вперёд» в браузере остаются без защиты.
 */
export function useUnsavedGuard(dirty: boolean, message: ReactNode): void {
  const confirm = useConfirm();
  const navigate = useNavigate();

  useEffect(() => {
    if (!dirty) return;

    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || link.target === '_blank' || link.origin !== window.location.origin || link.hasAttribute('download')) return;
      const href = link.pathname + link.search + link.hash;
      if (href === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({ title: 'Уйти без сохранения?', message, confirmLabel: 'Уйти', danger: true }).then((ok) => {
        if (ok) navigate(href);
      });
    };

    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, confirm, navigate, message]);
}
