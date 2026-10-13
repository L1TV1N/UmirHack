import { ScanBarcode } from 'lucide-react';
import { useEffect } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { LinkButton } from '../../components/Button/Button';
import { EmptyState } from '../../components/Feedback/Feedback';
import { PageHeader, Panel } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useUrlState } from '../../lib/useUrlState';
import { Journal } from './Journal';
import { ReceiptForm } from './ReceiptForm';
import { SaleForm } from './SaleForm';
import { TransferForm } from './TransferForm';
import { WriteoffForm } from './WriteoffForm';

type Tab = 'receipt' | 'sale' | 'writeoff' | 'transfer' | 'journal';
const TABS: Tab[] = ['receipt', 'sale', 'writeoff', 'transfer', 'journal'];

export default function OperationsPage() {
  const { can } = useAuth();
  const scope = useScope();
  const [url, setUrl] = useUrlState({ tab: 'receipt' });
  const canWrite = can('storekeeper');
  const tab: Tab = TABS.includes(url.tab as Tab) ? (url.tab as Tab) : 'receipt';
  const current: Tab = canWrite ? tab : 'journal';
  const noLocations = !scope.loading && scope.activeLocations.length === 0;

  useEffect(() => {
    document.title = 'Операции - Запас';
  }, []);

  return (
    <>
      <PageHeader title="Операции" subtitle="Приход, заказ гостя, списание и перемещение. Каждая операция создаёт документ и движения по партиям."
        actions={can('manager') ? <LinkButton to="/testing?tab=barcodes" icon={<ScanBarcode size={16} />}>Штрихкоды для проверки</LinkButton> : undefined}
      />
      <Tabs<Tab>
        label="Операции"
        value={current}
        onChange={(v) => setUrl({ tab: v })}
        items={[
          ...(canWrite
            ? ([
                { value: 'receipt', label: 'Приход' },
                { value: 'sale', label: 'Заказ гостя' },
                { value: 'writeoff', label: 'Списание' },
                { value: 'transfer', label: 'Перемещение' },
              ] as const)
            : []),
          { value: 'journal', label: 'Журнал' },
        ]}
      />
      <Panel>
        {!canWrite && current === 'journal' && (
          <div style={{ padding: '10px 18px', background: 'var(--surface-50)', borderBottom: '1px solid var(--line)', color: 'var(--ink-600)' }}>
            Оформлять операции может кладовщик и выше. Вам доступен журнал.
          </div>
        )}
        {noLocations && current !== 'journal' ? (
          <EmptyState title="Нет ни одной активной точки">Операции проводятся по точкам. Администратор создаёт их в разделе «Администрирование».</EmptyState>
        ) : (
          <>
            {current === 'receipt' && <ReceiptForm />}
            {current === 'sale' && <SaleForm />}
            {current === 'writeoff' && <WriteoffForm />}
            {current === 'transfer' && <TransferForm />}
            {current === 'journal' && <Journal />}
          </>
        )}
      </Panel>
    </>
  );
}
