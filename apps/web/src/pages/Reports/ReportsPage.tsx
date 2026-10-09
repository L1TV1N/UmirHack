import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { downloadFile } from '../../api/client';
import { useScope } from '../../auth/ScopeProvider';
import { Button } from '../../components/Button/Button';
import { Field, FieldRow, Input } from '../../components/Controls/Controls';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { addDays, todayLocal } from '../../lib/format';
import styles from './Reports.module.scss';

export default function ReportsPage() {
  const scope = useScope();
  const toast = useToast();
  const [from, setFrom] = useState(() => addDays(todayLocal(), -29));
  const [to, setTo] = useState(todayLocal);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Отчёты — Запас';
  }, []);

  const get = async (key: string, path: string, query: Record<string, string | undefined>, name: string) => {
    setBusy(key);
    try {
      await downloadFile(path, query, name);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const where = scope.locationId ? scope.nameOf(scope.locationId) : 'все точки';

  return (
    <>
      <PageHeader title="Отчёты" subtitle={`Выгрузки в CSV для Excel. Точка: ${where}. Её можно сменить в шапке.`} />
      <div className={styles.grid}>
        <Panel title="Остатки на сегодня" subtitle="Все партии с остатком, сроки, стоимость" padded>
          <p className={styles.text}>Для ревизии и сверки с бухгалтерией: каждая партия отдельной строкой с числом дней до срока и статусом.</p>
          <Button icon={<Download size={16} />} loading={busy === 'stock'} onClick={() => void get('stock', '/reports/stock.csv', { locationId: scope.locationId }, 'stock.csv')}>
            Скачать остатки
          </Button>
        </Panel>

        <Panel title="Списания" subtitle="Просрочка, порча, бой, недостача" padded>
          <FieldRow>
            <Field label="С">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="По">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </FieldRow>
          <Button
            icon={<Download size={16} />}
            loading={busy === 'writeoffs'}
            onClick={() => void get('writeoffs', '/reports/writeoffs.csv', { locationId: scope.locationId, from, to }, 'writeoffs.csv')}
          >
            Скачать списания
          </Button>
        </Panel>

        <Panel title="Все движения" subtitle="Журнал приходов, продаж, списаний и перемещений" padded>
          <p className={styles.text}>Период берётся из соседней карточки. Для больших объёмов лучше сузить даты: выгружается до 50 000 строк.</p>
          <Button
            icon={<Download size={16} />}
            loading={busy === 'movements'}
            onClick={() => void get('movements', '/reports/movements.csv', { locationId: scope.locationId, from, to }, 'movements.csv')}
          >
            Скачать движения
          </Button>
        </Panel>
      </div>
    </>
  );
}
