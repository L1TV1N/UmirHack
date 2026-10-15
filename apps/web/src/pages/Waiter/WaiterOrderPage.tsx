import { formatMoney, type GuestOrderDetailDto, type WaiterDishDto } from '@zapas/shared';
import { Flame, Minus, OctagonX, Plus, Search, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { submitDocument } from '../../api/documents';
import { useAction } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Input } from '../../components/Controls/Controls';
import { EmptyState, ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { useWaiterGet } from '../../lib/useWaiterGet';
import { OfflineEmpty, OfflineNote } from './OfflineNote';

import styles from './Waiter.module.scss';

/** Новый заказ: блюда из меню, блюда из стоп-листа выбрать нельзя. */
export default function WaiterOrderPage() {
  const scope = useScope();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const locationId = scope.locationId ?? '';
  const menu = useWaiterGet<WaiterDishDto[]>('/waiter/menu', { locationId }, { enabled: Boolean(locationId) });
  const [cart, setCart] = useState<Record<string, { qty: number; note: string }>>({});
  const [table, setTable] = useState('');
  const [comment, setComment] = useState('');
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  // один ключ на заказ: если ответ потерялся или заказ ушёл в очередь, повторная отправка не создаст второй заказ
  const orderKey = useRef(crypto.randomUUID());
  const send = useAction(
    (body: { tableLabel: string } & Record<string, unknown>) =>
      submitDocument<GuestOrderDetailDto>((user as { id: string }).id, {
        path: '/guest-orders',
        body,
        key: `order-${orderKey.current}`,
        label: `Заказ, стол ${body.tableLabel}`,
      }),
    ['/guest-orders', '/waiter'],
  );

  // блюдо ушло в стоп-лист, пока заказ собирался: убираем его из заказа и говорим об этом, иначе сервер откажет при отправке
  useEffect(() => {
    const stopped = (menu.data ?? []).filter((d) => d.stopped && (cart[d.id]?.qty ?? 0) > 0);
    if (stopped.length === 0) return;
    setCart((c) => {
      const next = { ...c };
      for (const d of stopped) next[d.id] = { qty: 0, note: c[d.id]?.note ?? '' };
      return next;
    });
    toast.error(`Убрано из заказа, блюдо в стоп-листе: ${stopped.map((d) => d.name).join(', ')}`);
  }, [menu.data, cart, toast]);

  const shown = useMemo(() => {
    const list = menu.data ?? [];
    const s = q.trim().toLowerCase();
    const filtered = s ? list.filter((d) => d.name.toLowerCase().includes(s)) : list;
    // горячие блюда выше, затем доступные, стоп-лист в конце
    return [...filtered].sort((a, b) => Number(a.stopped) - Number(b.stopped) || Number(b.hot) - Number(a.hot) || a.name.localeCompare(b.name, 'ru'));
  }, [menu.data, q]);

  const byId = new Map((menu.data ?? []).map((d) => [d.id, d]));
  const lines = Object.entries(cart).filter(([, v]) => v.qty > 0);
  const total = lines.reduce((s, [id, v]) => s + (byId.get(id)?.price ?? 0) * v.qty, 0);
  const count = lines.reduce((s, [, v]) => s + v.qty, 0);

  const add = (id: string, d: number) =>
    setCart((c) => {
      const qty = Math.max(0, Math.min(50, (c[id]?.qty ?? 0) + d));
      return { ...c, [id]: { qty, note: c[id]?.note ?? '' } };
    });

  const submit = () => {
    setError(null);
    if (!table.trim()) return setError('Укажите стол или номер заказа');
    if (lines.length === 0) return setError('Добавьте хотя бы одно блюдо');
    send.mutate(
      { locationId, tableLabel: table.trim(), placedAt: new Date().toISOString(), comment: comment.trim() || undefined, lines: lines.map(([dishId, v]) => ({ dishId, quantity: v.qty, ...(v.note.trim() ? { note: v.note.trim() } : {}) })) },
      {
        onSuccess: (res) => {
          if (res.queued) toast.info('Нет связи: заказ сохранён на телефоне и уйдёт на кухню, как только связь вернётся');
          else toast.success(`Заказ ${res.result.number} принят`);
          orderKey.current = crypto.randomUUID();
          setCart({});
          setTable('');
          setComment('');
          navigate('/waiter/orders');
        },
        onError: (err) => {
          setError(errorMessage(err));
          void menu.refetch();
        },
      },
    );
  };

  if (menu.unreachable) return <OfflineEmpty what="меню" />;
  if (menu.isLoading || (menu.data === undefined && !menu.error)) return <Loading label="Загружаем меню" />;
  if (menu.error) return <ErrorNote error={menu.error} onRetry={() => void menu.refetch()} />;
  if ((menu.data ?? []).length === 0) return <EmptyState title="Меню пусто">Блюда заводит менеджер в разделе «Блюда».</EmptyState>;

  return (
    <div className={styles.orderLayout}>
      <section className={styles.menu}>
        <OfflineNote savedAt={menu.savedAt} />
        <div className={styles.search}>
          <Search size={16} aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти блюдо" aria-label="Найти блюдо" />
        </div>
        <ul className={styles.dishes}>
          {shown.map((d) => {
            const qty = cart[d.id]?.qty ?? 0;
            return (
              <li key={d.id} className={`${styles.dish} ${d.stopped ? styles.stopped : ''}`}>
                <div className={styles.dishInfo}>
                  <strong>
                    {d.name}
                    {d.hot && !d.stopped && (
                      <span className={styles.hot} title="Горячее предложение">
                        <Flame size={13} aria-hidden="true" /> горячее
                      </span>
                    )}
                  </strong>
                  <span className={styles.ing}>{d.ingredients.join(', ')}</span>
                  {d.stopped && (
                    <span className={styles.stopNote}>
                      <OctagonX size={13} aria-hidden="true" /> В стоп-листе: {d.stopNote}
                    </span>
                  )}
                </div>
                <span className={styles.price}>{formatMoney(d.price)}</span>
                {d.stopped ? (
                  <span className={styles.na}>Недоступно</span>
                ) : (
                  <div className={styles.stepper}>
                    <button type="button" onClick={() => add(d.id, -1)} disabled={qty === 0} aria-label={`Убрать ${d.name}`}>
                      <Minus size={16} />
                    </button>
                    <output aria-label={`Порций ${d.name}`}>{qty}</output>
                    <button type="button" onClick={() => add(d.id, 1)} aria-label={`Добавить ${d.name}`}>
                      <Plus size={16} />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <aside className={styles.cart} aria-label="Заказ">
        <h2>Заказ</h2>
        <label className={styles.cartField}>
          Стол
          <Input value={table} maxLength={30} onChange={(e) => setTable(e.target.value)} placeholder="Например, 12" />
        </label>
        {lines.length === 0 ? (
          <p className={styles.muted}>Выберите блюда в меню.</p>
        ) : (
          <ul className={styles.cartLines}>
            {lines.map(([id, v]) => (
              <li key={id}>
                <span>
                  {byId.get(id)?.name} <b>× {v.qty}</b>
                </span>
                <span>{formatMoney((byId.get(id)?.price ?? 0) * v.qty)}</span>
                <Input
                  className={styles.note}
                  value={v.note}
                  maxLength={120}
                  placeholder="Пожелание, например без лука"
                  aria-label={`Пожелание к ${byId.get(id)?.name}`}
                  onChange={(e) => setCart((c) => ({ ...c, [id]: { qty: v.qty, note: e.target.value } }))}
                />
              </li>
            ))}
          </ul>
        )}
        <label className={styles.cartField}>
          Комментарий к заказу
          <Input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} placeholder="Не обязательно" />
        </label>
        <div className={styles.sum}>
          <span>{count} порц.</span>
          <strong>{formatMoney(total)}</strong>
        </div>
        {error && <ErrorNote message={error} />}
        <Button variant="primary" icon={<Send size={16} />} loading={send.isPending} onClick={submit} style={{ height: 46, justifyContent: 'center' }}>
          Отправить на кухню
        </Button>
      </aside>
    </div>
  );
}
