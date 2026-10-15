import type { GuestOrderDetailDto, GuestOrderDto } from '@zapas/shared';
import { AlertTriangle, ArrowLeft, Check, ChefHat, Maximize, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { post } from '../../api/client';
import { STOCK_PREFIXES, useAction, useGet } from '../../api/hooks';
import { useScope } from '../../auth/ScopeProvider';
import { errorMessage } from '../../lib/errors';
import { useLiveUpdates } from '../../lib/useLiveUpdates';
import styles from './Kitchen.module.scss';

const INVALIDATE = ['/guest-orders', ...STOCK_PREFIXES];
/** Через сколько минут ожидания карточка желтеет и краснеет. */
export const WARN_MINUTES = 8;
export const LATE_MINUTES = 15;

export type Urgency = 'ok' | 'warn' | 'late';

export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

export function urgencyOf(minutes: number): Urgency {
  return minutes >= LATE_MINUTES ? 'late' : minutes >= WARN_MINUTES ? 'warn' : 'ok';
}

/** Один короткий сигнал: на кухне уведомление должно быть слышно, но не раздражать. */
function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch {
    // звук недоступен, карточка всё равно появилась
  }
}

function OrderCard({ order, now, busy, onMove }: { order: GuestOrderDto; now: number; busy: boolean; onMove: (o: GuestOrderDto) => void }) {
  const since = order.status === 'new' ? (order.placedAt ?? order.createdAt) : (order.acceptedAt ?? order.createdAt);
  const minutes = minutesSince(since, now);
  const urgency = urgencyOf(minutes);
  return (
    <li className={`${styles.card} ${styles[urgency]}`} data-testid={`order-${order.number}`}>
      <header>
        <strong className={styles.table}>Стол {order.tableLabel}</strong>
        <span className={styles.timer} aria-label={`Ждёт ${minutes} минут`}>
          {minutes} мин
        </span>
      </header>
      <small className={styles.meta}>
        {order.number} · {order.waiterName}
      </small>
      <ul className={styles.lines}>
        {order.lines.map((l) => (
          <li key={l.id} className={l.isRemake ? styles.remake : undefined}>
            <b>{l.quantity}×</b> {l.dishName}
            {l.isRemake && <em>ПЕРЕДЕЛКА</em>}
            {l.note && <span className={styles.note}>{l.note}</span>}
          </li>
        ))}
      </ul>
      {order.comment && <p className={styles.comment}>{order.comment}</p>}
      {order.openIncidents > 0 && (
        <p className={styles.incident}>
          <AlertTriangle size={16} aria-hidden="true" /> Есть обращение, смотрит менеджер
        </p>
      )}
      <button type="button" className={order.status === 'new' ? styles.take : styles.done} disabled={busy} onClick={() => onMove(order)}>
        {order.status === 'new' ? (
          'Взять в работу'
        ) : (
          <>
            <Check size={22} aria-hidden="true" /> Готово
          </>
        )}
      </button>
    </li>
  );
}

/** Экран кухни: заказы крупно, у каждого таймер ожидания и одна кнопка. Для монитора над плитой. */
export default function KitchenPage() {
  const scope = useScope();
  const { live } = useLiveUpdates();
  const [now, setNow] = useState(() => Date.now());
  const [sound, setSound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useGet<GuestOrderDto[]>('/guest-orders', { locationId: scope.locationId, status: 'open' }, { enabled: Boolean(scope.locationId), refetchInterval: 10_000 });
  const move = useAction((v: { id: string; status: 'in_progress' | 'served' }) => post<GuestOrderDetailDto>(`/guest-orders/${v.id}/status`, { status: v.status }), INVALIDATE);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    document.title = 'Кухня - Запас';
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const orders = [...(list.data ?? [])].sort((a, b) => ((a.placedAt ?? a.createdAt) < (b.placedAt ?? b.createdAt) ? -1 : 1));
  const fresh = orders.filter((o) => o.status === 'new');
  const cooking = orders.filter((o) => o.status === 'in_progress');

  // новый заказ: короткий сигнал, но не при первой загрузке
  useEffect(() => {
    if (!list.data) return;
    if (seen.current !== null && fresh.length > seen.current && sound) beep();
    seen.current = fresh.length;
  }, [list.data, fresh.length, sound]);

  const onMove = (o: GuestOrderDto) => {
    setError(null);
    move.mutate({ id: o.id, status: o.status === 'new' ? 'in_progress' : 'served' }, { onError: (err) => setError(errorMessage(err)) });
  };

  const fullscreen = () => {
    try {
      void document.documentElement.requestFullscreen?.();
    } catch {
      // браузер не разрешил, экран остаётся обычным
    }
  };

  return (
    <div className={styles.screen}>
      <header className={styles.bar}>
        <Link to="/" className={styles.back} aria-label="Вернуться в систему">
          <ArrowLeft size={20} /> Запас
        </Link>
        <h1>
          <ChefHat size={26} aria-hidden="true" /> Кухня, {scope.selected?.name}
        </h1>
        <span className={styles.counts}>
          Новые: <b>{fresh.length}</b> · В работе: <b>{cooking.length}</b>
        </span>
        <span className={`${styles.live} ${live ? styles.liveOn : ''}`} role="status">
          <i aria-hidden="true" /> {live ? 'на связи' : 'нет живого обновления'}
        </span>
        <button type="button" onClick={() => setSound((s) => !s)} aria-pressed={sound} aria-label={sound ? 'Выключить звук' : 'Включить звук'}>
          {sound ? <Volume2 size={20} /> : <VolumeX size={20} />}
        </button>
        <button type="button" onClick={fullscreen} aria-label="На весь экран">
          <Maximize size={20} />
        </button>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {list.error && (
        <p className={styles.error} role="alert">
          {errorMessage(list.error)}
        </p>
      )}

      {list.isLoading ? (
        <p className={styles.empty}>Загружаем заказы</p>
      ) : orders.length === 0 ? (
        <p className={styles.empty}>Заказов нет. Новые появятся здесь сами.</p>
      ) : (
        <div className={styles.columns}>
          <section aria-label="Новые заказы">
            <h2>Новые</h2>
            {fresh.length === 0 && <p className={styles.none}>Новых нет</p>}
            <ul className={styles.cards}>
              {fresh.map((o) => (
                <OrderCard key={o.id} order={o} now={now} busy={move.isPending} onMove={onMove} />
              ))}
            </ul>
          </section>
          <section aria-label="Заказы в работе">
            <h2>В работе</h2>
            {cooking.length === 0 && <p className={styles.none}>Сейчас ничего не готовится</p>}
            <ul className={styles.cards}>
              {cooking.map((o) => (
                <OrderCard key={o.id} order={o} now={now} busy={move.isPending} onMove={onMove} />
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
