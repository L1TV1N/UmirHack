import { CloudOff, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { STOCK_PREFIXES, useInvalidate } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { loadCatalog, refreshCatalog } from '../../lib/catalog';
import { fmtDateTime } from '../../lib/format';
import { flushOutbox, loadOutbox, removeItem, retryItem, useOutbox } from '../../lib/outbox';
import { useOnline } from '../../lib/useOnline';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import { useConfirm } from '../Toast/Confirm';
import { useToast } from '../Toast/Toast';
import styles from './OfflineStatus.module.scss';

const RETRY_EVERY_MS = 30_000;

/** Подгружает в кеш страницы, которые нужны без связи, пока связь есть. */
function warmChunks(): void {
  const run = () => {
    void import('../../pages/Operations/OperationsPage');
    void import('../../pages/Inventory/InventoryPage');
    void import('../Scanner/decoder').then((m) => m.createDecoder()).catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 8000 });
  else window.setTimeout(run, 3000);
}

/** Экраны официанта подгружаются заранее: без связи открыть вкладку, которую ещё не открывали, было бы нечем. */
function warmWaiterChunks(): void {
  const run = () => {
    void import('../../pages/Waiter/WaiterOrderPage');
    void import('../../pages/Waiter/WaiterOrdersPage');
    void import('../../pages/Waiter/WaiterHotPage');
    void import('../../pages/Waiter/WaiterStopPage');
  };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 8000 });
  else window.setTimeout(run, 3000);
}

/**
 * Связь и очередь документов. Пока связь есть и очередь пуста, не видно. Без связи показывает плашку, а
 * документы, оформленные в это время, ждут здесь и уходят сами при возвращении связи.
 */
export function OfflineStatus() {
  const { user } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const invalidate = useInvalidate();
  const online = useOnline();
  const items = useOutbox(user?.id);
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const userId = user?.id;
  const role = user?.role;
  const waiting = items.filter((i) => !i.error).length;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  // Свежие toast и invalidate берём из ссылок: если бы send зависел от них, он менялся бы при каждой перерисовке,
  // а эффекты ниже запускали бы отправку заново, и очередь отправлялась бы бесконечно
  const latest = useRef({ toast, invalidate });
  latest.current = { toast, invalidate };

  const send = useCallback(
    async (manual: boolean) => {
      if (!userId) return;
      setSending(true);
      try {
        const res = await flushOutbox(userId);
        const { toast: t, invalidate: refresh } = latest.current;
        if (res.sent > 0) {
          t.success(`Из очереди отправлено документов: ${res.sent}`);
          void refresh([...STOCK_PREFIXES, '/guest-orders', '/waiter']);
        }
        if (res.rejected > 0) t.error(`Не приняты сервером: ${res.rejected}. Откройте очередь, чтобы разобраться`);
        if (manual && res.offline) t.error('Связи с сервером всё ещё нет');
      } finally {
        setSending(false);
      }
    },
    [userId],
  );

  // каталог и очередь поднимаем сразу после входа, чтобы сканер и формы работали без связи
  useEffect(() => {
    if (!userId) return;
    void loadOutbox().then(() => send(false));
    // сканеру и формам документов нужен каталог, официанту нет: ему хватает меню на экране заказа
    if (role === 'waiter') warmWaiterChunks();
    else {
      void loadCatalog().then(() => refreshCatalog()).catch(() => undefined);
      warmChunks();
    }
  }, [userId, role, send]);

  // связь вернулась или пришло время повторить
  useEffect(() => {
    if (!userId) return;
    const onOnline = () => {
      void send(false);
      if (role !== 'waiter') void refreshCatalog().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    const timer = window.setInterval(() => {
      if (navigator.onLine && waitingRef.current > 0) void send(false);
    }, RETRY_EVERY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(timer);
    };
  }, [userId, role, send]);

  if (!userId || (online && items.length === 0)) return null;

  const remove = async (id: string) => {
    const ok = await confirm({ title: 'Удалить документ из очереди?', message: 'Он не будет отправлен на сервер, остатки не изменятся.', confirmLabel: 'Удалить', danger: true });
    if (ok) await removeItem(id);
  };

  return (
    <>
      <button type="button" className={`${styles.chip} ${!online ? styles.offline : ''}`} onClick={() => setOpen(true)} aria-label={`Связь: ${online ? 'есть' : 'нет'}, в очереди документов: ${items.length}`}>
        {online ? <UploadCloud size={15} aria-hidden="true" /> : <CloudOff size={15} aria-hidden="true" />}
        <span>{online ? 'Очередь' : 'Нет связи'}</span>
        {items.length > 0 && <b>{items.length}</b>}
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Очередь документов"
        subtitle={online ? 'Документы, оформленные без связи, отправляются сами' : role === 'waiter' ? 'Связи нет. Заказы сохраняются на телефоне и уйдут на кухню, когда связь вернётся' : 'Связи нет. Сканер и формы работают, документы уйдут, когда связь вернётся'}
        width={520}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Закрыть</Button>
            <Button variant="primary" onClick={() => void send(true)} loading={sending} disabled={!online || waiting === 0}>
              Отправить сейчас
            </Button>
          </>
        }
      >
        {items.length === 0 ? (
          <p className="muted">Очередь пуста.</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id} className={item.error ? styles.rejected : ''}>
                <div>
                  <strong>{item.label}</strong>
                  <small>{fmtDateTime(new Date(item.createdAt).toISOString())}</small>
                  <span>{item.error ? `Не принят: ${item.error}` : item.attempts > 0 ? `Ждёт связи, попыток: ${item.attempts}` : 'Ждёт отправки'}</span>
                </div>
                <div className={styles.actions}>
                  {item.error && (
                    <Button size="sm" onClick={() => void retryItem(item.id).then(() => send(true))}>
                      Повторить
                    </Button>
                  )}
                  <Button size="sm" variant="danger" onClick={() => void remove(item.id)}>
                    Удалить
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
