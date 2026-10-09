import { useEffect } from 'react';
import { PageHeader } from '../../components/Panel/Panel';
import { Tabs } from '../../components/Tabs/Tabs';
import { useUrlState } from '../../lib/useUrlState';
import { ApiKeysPanel } from './ApiKeysPanel';
import { AuditPanel } from './AuditPanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { LocationsPanel } from './LocationsPanel';
import { SettingsPanel } from './SettingsPanel';
import { UsersPanel } from './UsersPanel';

type Tab = 'users' | 'locations' | 'settings' | 'keys' | 'integrations' | 'audit';
const TABS: Tab[] = ['users', 'locations', 'settings', 'keys', 'integrations', 'audit'];

export default function AdminPage() {
  const [url, setUrl] = useUrlState({ tab: 'users' });
  const tab: Tab = TABS.includes(url.tab as Tab) ? (url.tab as Tab) : 'users';

  useEffect(() => {
    document.title = 'Администрирование — Запас';
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
          { value: 'keys', label: 'Ключи кассы' },
          { value: 'integrations', label: 'Интеграции' },
          { value: 'audit', label: 'Журнал аудита' },
        ]}
      />
      {tab === 'users' && <UsersPanel />}
      {tab === 'locations' && <LocationsPanel />}
      {tab === 'settings' && <SettingsPanel />}
      {tab === 'keys' && <ApiKeysPanel />}
      {tab === 'integrations' && <IntegrationsPanel />}
      {tab === 'audit' && <AuditPanel />}
    </>
  );
}
