import { CheckCircle2, OctagonX, X } from 'lucide-react';
import type { StopAlert } from '../../lib/useStopAlerts';
import styles from './Waiter.module.scss';

/** Сообщения сверху экрана официанта: блюдо ушло в стоп-лист или снова доступно. */
export function StopAlerts({ alerts, onDismiss }: { alerts: StopAlert[]; onDismiss: (id: string) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div className={styles.alerts} role="alert" aria-live="assertive">
      {alerts.map((a) => (
        <div key={a.id} className={`${styles.alert} ${a.kind === 'stop' ? styles.alertStop : styles.alertBack}`}>
          {a.kind === 'stop' ? <OctagonX size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
          <span>{a.text}</span>
          <button type="button" onClick={() => onDismiss(a.id)} aria-label="Закрыть сообщение">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
