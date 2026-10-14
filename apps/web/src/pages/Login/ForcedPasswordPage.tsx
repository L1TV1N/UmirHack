import { useState, type FormEvent } from 'react';
import { ApiError, post } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
import { BrandMark } from '../../components/Layout/Brand';
import styles from './LoginPage.module.scss';

/** Первый вход с временным паролем: прежде чем работать, человек выбирает свой. */
export default function ForcedPasswordPage() {
  const { user, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== repeat) return setFieldErrors({ repeat: 'Пароли не совпадают' });
    setFieldErrors({});
    setBusy(true);
    try {
      await post('/auth/change-password', { currentPassword: current, newPassword: next });
      // сервер закрыл все сессии: входим заново уже с новым паролем
      await logout();
    } catch (err) {
      if (err instanceof ApiError) {
        const fe: Record<string, string> = {};
        const details = Array.isArray(err.details) ? (err.details as { path?: (string | number)[]; message?: string }[]) : [];
        for (const d of details) if (d.path?.[0] && d.message) fe[String(d.path[0])] = d.message;
        setFieldErrors(fe);
        setError(err.message);
      } else setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page} style={{ gridTemplateColumns: '1fr' }}>
      <section className={styles.formSide}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <div className={styles.brand} style={{ color: 'var(--ink-900)', marginBottom: 8 }}>
            <BrandMark size={30} />
            Запас
          </div>
          <h2>Смените временный пароль</h2>
          <p>{user?.fullName}, администратор выдал вам временный пароль. Придумайте свой: после этого нужно будет войти ещё раз.</p>
          {error && (
            <div className={styles.alert} role="alert">
              {error}
            </div>
          )}
          <Field label="Временный пароль" error={fieldErrors.currentPassword} required>
            {(p) => <Input {...p} type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label="Новый пароль" error={fieldErrors.newPassword} hint="Не короче 10 знаков" required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
          <Field label="Повторите новый пароль" error={fieldErrors.repeat} required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />}
          </Field>
          <Button variant="primary" type="submit" loading={busy} style={{ height: 40 }}>
            Сохранить пароль
          </Button>
          <p className={styles.alt}>
            <button type="button" onClick={() => void logout()} style={{ background: 'none', border: 0, color: 'var(--brand-700)', cursor: 'pointer', font: 'inherit' }}>
              Выйти
            </button>
          </p>
        </form>
      </section>
    </div>
  );
}
