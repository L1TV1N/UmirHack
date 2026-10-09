import {
  createUserBody,
  ROLE_LABELS,
  ROLES,
  seesAllLocations,
  setPasswordBody,
  type LocationDto,
  type Page,
  type Role,
  type UserDto,
} from '@zapas/shared';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, patch, post, put } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Chip, type Tone } from '../../components/Chip/Chip';
import { Checkbox, Field, FieldRow, Input, Select } from '../../components/Controls/Controls';
import { DataTable, type Column } from '../../components/DataTable/DataTable';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorNote } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';

const ROLE_TONE: Record<Role, Tone> = { admin: 'danger', manager: 'info', storekeeper: 'ok', viewer: 'neutral' };

function UserDialog({ user, open, onClose, locations }: { user: UserDto | null; open: boolean; onClose: () => void; locations: LocationDto[] }) {
  const toast = useToast();
  const editing = user !== null;
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('storekeeper');
  const [password, setPassword] = useState('');
  const [isActive, setActive] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail(user?.email ?? '');
    setFullName(user?.fullName ?? '');
    setRole(user?.role ?? 'storekeeper');
    setPassword('');
    setActive(user?.isActive ?? true);
    setPicked(user?.locationIds ?? []);
    setErrors({});
    setFormError(null);
  }, [open, user]);

  const save = useAction((body: object) => (editing ? patch(`/users/${user.id}`, body) : post('/users', body)), ['/users']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const locationIds = seesAllLocations(role) ? [] : picked;
    let body: object;
    if (editing) {
      body = { fullName: fullName.trim(), role, isActive, locationIds };
    } else {
      const parsed = createUserBody.safeParse({ email, fullName, role, password, locationIds });
      if (!parsed.success) {
        const out: Record<string, string> = {};
        for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.message;
        setErrors(out);
        return;
      }
      body = parsed.data;
    }
    if (editing && !fullName.trim()) return setErrors({ fullName: 'Введите имя' });
    setErrors({});
    save.mutate(body, {
      onSuccess: () => {
        toast.success(editing ? 'Пользователь сохранён' : 'Пользователь создан');
        onClose();
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === 'duplicate_email') setErrors({ email: err.message });
        else if (err instanceof ApiError && Object.keys(err.fieldErrors()).length) setErrors(err.fieldErrors());
        else setFormError(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Пользователь' : 'Новый пользователь'}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="user-form" loading={save.isPending}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldRow>
          <Field label="ФИО" error={errors.fullName} required>
            {(p) => <Input {...p} value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} autoFocus />}
          </Field>
          <Field label="Почта" error={errors.email} required>
            {(p) => <Input {...p} type="email" value={email} disabled={editing} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Роль" required>
            {(p) => (
              <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {!editing && (
            <Field label="Пароль" error={errors.password} hint="Не короче 10 символов" required>
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          )}
        </FieldRow>
        {seesAllLocations(role) ? (
          <p className="muted">Эта роль видит все точки.</p>
        ) : (
          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', margin: 0 }}>
            <legend style={{ padding: '0 6px', fontWeight: 600, fontSize: 12.5, color: 'var(--ink-700)' }}>Доступные точки</legend>
            <div style={{ display: 'grid', gap: 8 }}>
              {locations.map((l) => (
                <Checkbox
                  key={l.id}
                  label={l.name}
                  checked={picked.includes(l.id)}
                  onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, l.id] : cur.filter((x) => x !== l.id)))}
                />
              ))}
            </div>
          </fieldset>
        )}
        {editing && <Checkbox label="Учётная запись активна" checked={isActive} onChange={(e) => setActive(e.target.checked)} />}
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}

function PasswordDialog({ user, onClose }: { user: UserDto | null; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useAction((v: { id: string; password: string }) => put(`/users/${v.id}/password`, { password: v.password }), ['/users']);

  useEffect(() => {
    setPassword('');
    setError(null);
  }, [user]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = setPasswordBody.safeParse({ password });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Некорректный пароль');
    save.mutate(
      { id: (user as UserDto).id, password },
      {
        onSuccess: () => {
          toast.success('Пароль задан, активные сессии пользователя закрыты');
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title="Новый пароль"
      subtitle={user?.fullName}
      width={420}
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" type="submit" form="password-form" loading={save.isPending}>
            Задать пароль
          </Button>
        </>
      }
    >
      <form id="password-form" onSubmit={submit} noValidate>
        <Field label="Пароль" hint="Передайте его пользователю безопасным способом. Он сможет сменить его сам." error={error ?? undefined} required>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
        </Field>
      </form>
    </Dialog>
  );
}

export function UsersPanel() {
  const { user: me } = useAuth();
  const toast = useToast();
  const users = useGet<Page<UserDto>>('/users', { limit: 200 });
  const locations = useGet<LocationDto[]>('/locations');
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const [passwordFor, setPasswordFor] = useState<UserDto | null>(null);
  const unlock = useAction((id: string) => post(`/users/${id}/unlock`), ['/users']);
  const names = new Map((locations.data ?? []).map((l) => [l.id, l.name]));

  const columns: Column<UserDto>[] = [
    {
      key: 'name',
      header: 'Сотрудник',
      cell: (u) => (
        <>
          <strong>{u.fullName}</strong>
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            {u.email}
          </span>
        </>
      ),
    },
    { key: 'role', header: 'Роль', cell: (u) => <Chip tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Chip> },
    {
      key: 'locs',
      header: 'Точки',
      cell: (u) => (seesAllLocations(u.role) ? <span className="muted">все</span> : u.locationIds.length ? u.locationIds.map((id) => names.get(id) ?? '—').join(', ') : <span className="muted">не назначены</span>),
    },
    {
      key: 'state',
      header: 'Статус',
      cell: (u) =>
        u.lockedUntil ? <Chip tone="warn">Заблокирован до {fmtDateTime(u.lockedUntil)}</Chip> : <Chip tone={u.isActive ? 'ok' : 'neutral'}>{u.isActive ? 'Активен' : 'Отключён'}</Chip>,
    },
    { key: 'login', header: 'Последний вход', cell: (u) => (u.lastLoginAt ? <span className="num">{fmtDateTime(u.lastLoginAt)}</span> : <span className="muted">не входил</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (u) => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          {u.lockedUntil && (
            <Button
              size="sm"
              onClick={() =>
                unlock.mutate(u.id, { onSuccess: () => toast.success('Блокировка снята'), onError: (err) => toast.error(errorMessage(err)) })
              }
            >
              Разблокировать
            </Button>
          )}
          <Button size="sm" onClick={() => setPasswordFor(u)}>
            Пароль
          </Button>
          <Button size="sm" onClick={() => setEditing(u)}>
            Изменить
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <Panel
        title="Пользователи"
        subtitle={me ? `Вы вошли как ${me.email}` : undefined}
        actions={
          <Button size="sm" variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>
            Добавить
          </Button>
        }
      >
        {users.isError ? (
          <div style={{ padding: 16 }}>
            <ErrorNote error={users.error} onRetry={() => void users.refetch()} />
          </div>
        ) : (
          <DataTable columns={columns} rows={users.data?.items} rowKey={(u) => u.id} loading={users.isLoading} caption="Пользователи" />
        )}
      </Panel>
      <UserDialog open={editing !== null} user={editing && editing !== 'new' ? editing : null} onClose={() => setEditing(null)} locations={(locations.data ?? []).filter((l) => l.isActive)} />
      <PasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} />
    </>
  );
}
