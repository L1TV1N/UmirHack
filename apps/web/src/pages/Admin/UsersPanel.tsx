import {
  createUserBody,
  ROLE_LABELS,
  ROLES,
  seesAllLocations,
  setPasswordBody,
  type CreatedUserDto,
  type LocationDto,
  type Page,
  type Role,
  type UserDto,
} from '@zapas/shared';
import { Copy, KeyRound, Plus } from 'lucide-react';
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
import { useConfirm } from '../../components/Toast/Confirm';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';

const ROLE_TONE: Record<Role, Tone> = { admin: 'danger', manager: 'info', storekeeper: 'ok', viewer: 'neutral', waiter: 'amber' };

// Без похожих знаков (0/O, 1/l/I): пароль читают с экрана и диктуют по телефону
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
}

const ROLE_HINT: Record<Role, string> = {
  admin: 'Всё, включая заведения, сотрудников и подключения',
  manager: 'Остатки, заказы поставщикам, заявки гостей, отчёты',
  storekeeper: 'Приход, списание, перемещение, инвентаризация',
  viewer: 'Только просмотр остатков и стоп-листа',
  waiter: 'Принимает заказы гостей, видит стоп-лист и горячие предложения',
};

function UserDialog({ user, open, onClose, onCreated, locations }: { user: UserDto | null; open: boolean; onClose: () => void; onCreated: (u: CreatedUserDto) => void; locations: LocationDto[] }) {
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

  const save = useAction((body: object) => (editing ? patch<UserDto>(`/users/${user.id}`, body) : post<CreatedUserDto>('/users', body)), ['/users']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const locationIds = seesAllLocations(role) ? [] : picked;
    let body: object;
    if (editing) {
      body = { fullName: fullName.trim(), role, isActive, locationIds };
    } else {
      const parsed = createUserBody.safeParse({ email, fullName, role, locationIds, ...(password ? { password } : {}) });
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
      onSuccess: (res) => {
        toast.success(editing ? 'Пользователь сохранён' : 'Пользователь создан');
        onClose();
        if (!editing) onCreated(res as CreatedUserDto);
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
            <Field label="Пароль" error={errors.password} hint="Оставьте пустым: система создаст временный, а человек сменит его при первом входе">
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
            </Field>
          )}
        </FieldRow>
        {seesAllLocations(role) ? (
          <p className="muted">Эта роль видит все заведения организации.</p>
        ) : (
          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', margin: 0 }}>
            <legend style={{ padding: '0 6px', fontWeight: 600, fontSize: 12.5, color: 'var(--ink-700)' }}>Доступные заведения</legend>
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
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {ROLE_HINT[role]}
        </p>
        {editing && <Checkbox label="Учётная запись активна" checked={isActive} onChange={(e) => setActive(e.target.checked)} />}
        {formError && <ErrorNote message={formError} />}
      </form>
    </Dialog>
  );
}

/** Данные для входа нового сотрудника. Пароль виден только сейчас: после закрытия окна его не восстановить. */
function CredentialsDialog({ created, onClose }: { created: CreatedUserDto | null; onClose: () => void }) {
  const toast = useToast();
  const text = created ? `Запас: ${window.location.origin}\nПочта: ${created.email}\nВременный пароль: ${created.temporaryPassword ?? ''}\nПри первом входе система попросит сменить пароль.` : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Данные для входа скопированы');
    } catch {
      toast.error('Не удалось скопировать, выделите текст вручную');
    }
  };
  return (
    <Dialog
      open={created !== null}
      onClose={onClose}
      title={created?.temporaryPassword ? 'Данные для входа' : 'Пользователь создан'}
      subtitle={created?.fullName}
      width={480}
      footer={
        <>
          {created?.temporaryPassword && (
            <Button icon={<Copy size={15} />} onClick={() => void copy()}>
              Скопировать
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Готово
          </Button>
        </>
      }
    >
      {created?.temporaryPassword ? (
        <>
          <pre style={{ margin: 0, padding: 14, background: 'var(--surface-100)', borderRadius: 'var(--radius)', whiteSpace: 'pre-wrap', fontSize: 14, userSelect: 'all' }}>{text}</pre>
          <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
            Пароль показан один раз. Письмо не отправляется: почта на сервере пока не подключена, передайте данные сотруднику сами. Первый вход потребует сменить пароль.
          </p>
        </>
      ) : (
        <p>Пароль задан вами, при первом входе сотрудник должен его сменить.</p>
      )}
    </Dialog>
  );
}

function PasswordDialog({ user, onClose, onSet }: { user: UserDto | null; onClose: () => void; onSet: (u: UserDto, password: string) => void }) {
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
          if (user) onSet(user, password);
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
        <Field label="Пароль" hint="При первом входе человек выберет свой. Передайте этот пароль безопасным способом." error={error ?? undefined} required>
          {(p) => <Input {...p} type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
        </Field>
        <Button size="sm" icon={<KeyRound size={14} />} onClick={() => setPassword(randomPassword())} style={{ marginTop: 10 }}>
          Сгенерировать
        </Button>
      </form>
    </Dialog>
  );
}

export function UsersPanel() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const users = useGet<Page<UserDto>>('/users', { limit: 200 });
  const locations = useGet<LocationDto[]>('/locations');
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const [passwordFor, setPasswordFor] = useState<UserDto | null>(null);
  const [credentials, setCredentials] = useState<CreatedUserDto | null>(null);
  const unlock = useAction((id: string) => post(`/users/${id}/unlock`), ['/users']);
  const resetTwoFactor = useAction((id: string) => post(`/users/${id}/two-factor/reset`), ['/users']);

  const askReset = async (u: UserDto) => {
    const ok = await confirm({
      title: 'Сбросить подтверждение входа?',
      message: `${u.fullName} сможет войти по одному паролю, его сессии закроются. Делайте это, только убедившись, что человек потерял и Telegram, и резервные коды. Действие попадёт в журнал.`,
      confirmLabel: 'Сбросить',
      danger: true,
    });
    if (!ok) return;
    resetTwoFactor.mutate(u.id, { onSuccess: () => toast.success('Подтверждение входа сброшено'), onError: (err) => toast.error(errorMessage(err)) });
  };
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
    {
      key: 'role',
      header: 'Роль',
      cell: (u) => (
        <>
          <Chip tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Chip>
          {u.role === 'admin' && (
            <span className="muted" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
              {u.twoFactorEnabled ? 'вход с кодом из Telegram' : 'вход по паролю'}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'locs',
      header: 'Точки',
      cell: (u) => (seesAllLocations(u.role) ? <span className="muted">все</span> : u.locationIds.length ? u.locationIds.map((id) => names.get(id) ?? '-').join(', ') : <span className="muted">не назначены</span>),
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
          {u.twoFactorEnabled && u.id !== me?.id && (
            <Button size="sm" onClick={() => void askReset(u)}>
              Сбросить защиту
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
      <UserDialog open={editing !== null} user={editing && editing !== 'new' ? editing : null} onClose={() => setEditing(null)} onCreated={setCredentials} locations={(locations.data ?? []).filter((l) => l.isActive)} />
      <PasswordDialog user={passwordFor} onClose={() => setPasswordFor(null)} onSet={(u, password) => setCredentials({ ...u, temporaryPassword: password })} />
      <CredentialsDialog created={credentials} onClose={() => setCredentials(null)} />
    </>
  );
}
