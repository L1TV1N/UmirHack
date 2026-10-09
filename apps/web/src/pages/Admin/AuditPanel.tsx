import type { AuditEntryDto, AuditVerifyDto, Page } from '@zapas/shared';
import { useState } from 'react';
import { get } from '../../api/client';
import { useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Input } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Pagination } from '../../components/Pagination/Pagination';
import { Panel, Toolbar } from '../../components/Panel/Panel';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { useDebouncedValue } from '../../lib/useDebouncedValue';

const LIMIT = 40;

const LABELS: Record<string, string> = {
  'auth.login': 'Вход',
  'auth.login_failed': 'Неудачный вход',
  'auth.locked': 'Блокировка учётной записи',
  'auth.logout': 'Выход',
  'auth.password_changed': 'Смена пароля',
  'auth.refresh_reuse': 'Повторное использование токена',
  'document.receipt': 'Приход',
  'document.sale': 'Продажа',
  'document.writeoff': 'Списание',
  'document.writeoff_expired': 'Списание просроченного',
  'document.transfer': 'Перемещение',
  'inventory.commit': 'Проведена инвентаризация',
  'inventory.create': 'Начата инвентаризация',
  'inventory.cancel': 'Отменена инвентаризация',
  'product.create': 'Новый продукт',
  'product.update': 'Изменён продукт',
  'user.create': 'Новый пользователь',
  'user.update': 'Изменён пользователь',
  'user.password_set': 'Пароль задан администратором',
  'user.unlock': 'Снята блокировка',
  'promotion.create': 'Скидка на партию',
  'promotion.cancel': 'Скидка отменена',
  'stoplist.add': 'Стоп-лист: добавлено',
  'stoplist.release': 'Стоп-лист: снято',
  'settings.update': 'Изменены настройки',
  'apikey.create': 'Выпущен ключ кассы',
  'apikey.revoke': 'Отозван ключ кассы',
  'report.export': 'Выгрузка отчёта',
};

function tone(action: string) {
  if (action.includes('failed') || action.includes('locked') || action.includes('reuse')) return 'danger' as const;
  if (action.startsWith('document.') || action.startsWith('inventory.')) return 'info' as const;
  return 'neutral' as const;
}

export function AuditPanel() {
  const [action, setAction] = useState('');
  const [email, setEmail] = useState('');
  const [offset, setOffset] = useState(0);
  const a = useDebouncedValue(action, 300);
  const e = useDebouncedValue(email, 300);
  const list = useGet<Page<AuditEntryDto>>('/audit', { action: a, userEmail: e, limit: LIMIT, offset });
  const [verify, setVerify] = useState<AuditVerifyDto | string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      setVerify(await get<AuditVerifyDto>('/audit/verify'));
    } catch (err) {
      setVerify(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const columns: Column<AuditEntryDto>[] = [
    { key: 'when', header: 'Когда', cell: (r) => <span className="num">{fmtDateTime(r.at)}</span> },
    { key: 'who', header: 'Кто', cell: (r) => r.userEmail ?? <span className="muted">система</span> },
    { key: 'what', header: 'Действие', cell: (r) => <Chip tone={tone(r.action)}>{LABELS[r.action] ?? r.action}</Chip> },
    { key: 'entity', header: 'Объект', cell: (r) => (r.entityId ? <span className="mono">{r.entityId.slice(0, 8)}</span> : <span className="muted">—</span>) },
    { key: 'ip', header: 'IP', cell: (r) => <span className="mono">{r.ip ?? '—'}</span> },
    {
      key: 'details',
      header: 'Подробности',
      cell: (r) => {
        const text = JSON.stringify(r.details);
        return <span className="muted mono" title={text}>{text.length > 90 ? `${text.slice(0, 90)}…` : text}</span>;
      },
    },
  ];

  return (
    <Panel
      title="Журнал аудита"
      subtitle="Записи нельзя изменить или удалить, они связаны цепочкой контрольных сумм"
      actions={
        <Button size="sm" onClick={() => void check()} loading={checking}>
          Проверить целостность
        </Button>
      }
    >
      {verify && (
        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', background: typeof verify !== 'string' && verify.ok ? 'var(--ok-50)' : 'var(--danger-50)', fontWeight: 600 }}>
          {typeof verify === 'string'
            ? verify
            : verify.ok
              ? `Цепочка цела: проверено записей ${verify.checked}`
              : `Нарушена целостность в записи №${verify.brokenAt}. До неё проверено записей: ${verify.checked}`}
        </div>
      )}
      <Toolbar>
        <div style={{ width: 240 }}>
          <Input type="search" value={action} onChange={(ev) => { setAction(ev.target.value); setOffset(0); }} placeholder="Действие, например document" aria-label="Фильтр по действию" />
        </div>
        <div style={{ width: 240 }}>
          <Input type="search" value={email} onChange={(ev) => { setEmail(ev.target.value); setOffset(0); }} placeholder="Почта пользователя" aria-label="Фильтр по пользователю" />
        </div>
      </Toolbar>
      {list.isError ? (
        <div style={{ padding: 16 }}>
          <ErrorNote error={list.error} onRetry={() => void list.refetch()} />
        </div>
      ) : (
        <DataTable columns={columns} rows={list.data?.items} rowKey={(r) => String(r.id)} loading={list.isLoading} dense caption="Журнал аудита" />
      )}
      {list.data && <Pagination total={list.data.total} limit={LIMIT} offset={offset} onChange={setOffset} />}
    </Panel>
  );
}
