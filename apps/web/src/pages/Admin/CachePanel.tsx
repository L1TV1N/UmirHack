import type { CacheStatsDto, CacheStatusDto } from '@zapas/shared';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import styles from './CachePanel.module.scss';

const pct = (v: number) => `${String(Math.round(v * 1000) / 10).replace('.', ',')}%`;
const ms = (v: number) => `${String(v).replace('.', ',')} мс`;

function Tile({ label, value, hint, good }: { label: string; value: string | number; hint?: string; good?: boolean }) {
  return (
    <div className={`${styles.tile} ${good ? styles.good : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Stats({ title, hint, s }: { title: string; hint: string; s: CacheStatsDto }) {
  return (
    <Panel title={title} subtitle={hint}>
      <div className={styles.grid}>
        <Tile label="Из кеша" value={pct(s.hitRatio)} hint={`${s.hits + s.joined + s.stale} из ${s.hits + s.misses + s.joined + s.stale}`} good />
        <Tile label="Попадания" value={s.hits} />
        <Tile label="Промахи" value={s.misses} hint="срез загружен из базы" />
        <Tile label="Общая загрузка" value={s.joined} hint="запрос присоединился к идущей" />
        <Tile label="Прежний срез" value={s.stale} hint="пока тяжёлый пересчитывается" />
        <Tile label="Загрузка" value={ms(s.avgLoadMs)} hint={`последняя ${ms(s.lastLoadMs)}, максимум ${ms(s.maxLoadMs)}`} />
        <Tile label="Ключей" value={`${s.entries} из ${s.maxEntries}`} hint={`срок жизни ${s.ttlSeconds} с`} />
        <Tile label="Сбросов" value={s.invalidations} hint={`только своей организации: ${s.taggedInvalidations}`} />
        {s.failures > 0 && <Tile label="Ошибок загрузки" value={s.failures} />}
      </div>
    </Panel>
  );
}

/** Состояние серверного кеша расчётов: счётчики, сброс и синхронизация экземпляров. */
export function CachePanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useGet<CacheStatusDto>('/admin/cache', undefined, { refetchInterval: 5000 });
  const flush = useAction(() => post('/admin/cache/flush'), ['/admin/cache']);

  const askFlush = async () => {
    const ok = await confirm({
      title: 'Сбросить кеш расчётов?',
      message: 'Следующий запрос панели, стоп-листа и рекомендаций пересчитает данные из базы. Данные не теряются. Нужно после правок в базе мимо приложения.',
      confirmLabel: 'Сбросить',
    });
    if (!ok) return;
    flush.mutate(undefined, { onSuccess: () => toast.success('Кеш сброшен'), onError: (err) => toast.error(errorMessage(err)) });
  };

  if (status.isError) return <ErrorNote error={status.error} onRetry={() => void status.refetch()} />;
  const d = status.data;
  if (!d) return <p className="muted">Загрузка…</p>;

  return (
    <>
      <Panel
        title="Кеш расчётов"
        subtitle="Срез данных для панели, стоп-листа и рекомендаций хранится в памяти процесса и сбрасывается любой записью"
        actions={
          <Button size="sm" onClick={() => void askFlush()} loading={flush.isPending}>
            Сбросить кеш
          </Button>
        }
      >
        <div className={styles.head}>
          <Chip tone={d.cluster.enabled ? (d.cluster.connected ? 'ok' : 'danger') : 'neutral'}>
            {d.cluster.enabled ? (d.cluster.connected ? 'Синхронизация экземпляров работает' : 'Синхронизация потеряна, переподключаемся') : 'Один экземпляр'}
          </Chip>
          <span className="muted" style={{ fontWeight: 500 }}>
            клиентов с живым обновлением: {d.liveClients}
          </span>
        </div>
        <p className={styles.note}>
          {d.cluster.enabled
            ? `Отправлено сообщений: ${d.cluster.sent}, получено: ${d.cluster.received}, переподключений: ${d.cluster.reconnects}.${d.cluster.lastError ? ` Последняя ошибка: ${d.cluster.lastError}.` : ''}`
            : 'Сейчас приложение работает одним экземпляром. Чтобы запустить несколько, включите CLUSTER_SYNC: сброс кеша и сигналы обновления пойдут между экземплярами через PostgreSQL (LISTEN/NOTIFY).'}
        </p>
      </Panel>
      <Stats title="Срезы данных" hint="партии, остатки, скорости продаж" s={d.snapshots} />
      <Stats title="Агрегаты панели" hint="потери и выручка за 30 суток" s={d.aggregates} />
    </>
  );
}
