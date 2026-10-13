import { useEffect } from 'react';
import { PageHeader } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useUrlState } from '../../lib/useUrlState';
import { AuditPanel } from './AuditPanel';
import { ExchangePanel } from './ExchangePanel';
import { ForecastPanel } from './ForecastPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { LocationsPanel } from './LocationsPanel';
import { PosPanel } from './PosPanel';
import { SettingsPanel } from './SettingsPanel';
import { UsersPanel } from './UsersPanel';

type Tab = 'users' | 'locations' | 'settings' | 'forecast' | 'keys' | 'exchange' | 'integrations' | 'audit';
const TABS: Tab[] = ['users', 'locations', 'settings', 'forecast', 'keys', 'exchange', 'integrations', 'audit'];

export default function AdminPage() {
  const [url, setUrl] = useUrlState({ tab: 'users' });
  const tab: Tab = TABS.includes(url.tab as Tab) ? (url.tab as Tab) : 'users';

  useEffect(() => {
    document.title = 'Администрирование - Запас';
  }, []);

  return (
    <>
      <PageHeader title="Администрирование" subtitle="Пользователи и их права, точки, параметры расчётов, интеграции с кассой, доставкой и учётными системами, журнал действий." />
      <Tabs<Tab>
        label="Разделы администрирования"
        value={tab}
        onChange={(v) => setUrl({ tab: v })}
        items={[
          { value: 'users', label: 'Пользователи' },
          { value: 'locations', label: 'Точки' },
          { value: 'settings', label: 'Параметры' },
          { value: 'forecast', label: 'Погода и календарь' },
          { value: 'keys', label: 'Кассы' },
          { value: 'exchange', label: 'Учётные системы' },
          { value: 'integrations', label: 'Интеграции' },
          { value: 'audit', label: 'Журнал аудита' },
        ]}
      />
      {tab === 'users' && <UsersPanel />}
      {tab === 'locations' && <LocationsPanel />}
      {tab === 'settings' && <SettingsPanel />}
      {tab === 'forecast' && <ForecastPanel />}
      {tab === 'keys' && <PosPanel />}
      {tab === 'exchange' && <ExchangePanel />}
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'audit' && <AuditPanel />}
    </>
  );
}
