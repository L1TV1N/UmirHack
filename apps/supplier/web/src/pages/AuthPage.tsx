import { isValidInn } from '@zapas/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AccountDto } from '../../../src/types';
import { api, ApiError } from '../api';

interface Props {
  mode: 'login' | 'register';
  onDone(a: AccountDto): void;
}

export function AuthPage({ mode, onDone }: Props) {
  const reg = mode === 'register';
  const [f, setF] = useState({ company: '', inn: '', contactName: '', email: '', phone: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const innOk = f.inn === '' || isValidInn(f.inn.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = reg
        ? await api<{ account: AccountDto }>('POST', '/auth/register', { company: f.company, inn: f.inn.trim(), contactName: f.contactName, email: f.email, phone: f.phone || undefined, password: f.password })
        : await api<{ account: AccountDto }>('POST', '/auth/login', { email: f.email, password: f.password });
      onDone(res.account);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        const fe: Record<string, string> = {};
        for (const d of err.details ?? []) if (d.path && d.message) fe[d.path.replace(/^\//, '')] = d.message;
        setFieldErrors(fe);
      } else setError('Не удалось выполнить запрос');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand brand-light">
          <span className="brand-mark" aria-hidden="true" />
          <span>Отгрузка</span>
        </div>
        <h1>Заказы от ресторанов и магазинов в одном месте</h1>
        <p>Покупатели присылают заказы из своих систем учёта. Вы подтверждаете, отгружаете или отказываете, а они сразу видят ваш ответ.</p>
        <ul>
          <li>Регистрация по ИНН: заказы находят вас сами</li>
          <li>Подтверждение и отгрузка в два нажатия</li>
          <li>Статус приёмки у покупателя виден здесь же</li>
        </ul>
      </aside>
      <section className="auth-form">
        <h2>{reg ? 'Регистрация поставщика' : 'Вход в кабинет'}</h2>
        <p className="muted">{reg ? 'Укажите данные компании: по ИНН к вам привяжутся заказы покупателей.' : 'Используйте почту и пароль, указанные при регистрации.'}</p>
        {error && <div className="alert" role="alert">{error}</div>}
        <form onSubmit={(e) => void submit(e)} noValidate>
          {reg && (
            <>
              <label>
                Название компании
                <input value={f.company} onChange={set('company')} required maxLength={160} autoComplete="organization" />
                {fieldErrors.company && <span className="field-error">{fieldErrors.company}</span>}
              </label>
              <label>
                ИНН
                <input value={f.inn} onChange={set('inn')} required inputMode="numeric" maxLength={12} aria-invalid={!innOk} />
                {!innOk && <span className="field-error">Неверный ИНН: 10 или 12 цифр с верной контрольной цифрой</span>}
                {fieldErrors.inn && <span className="field-error">{fieldErrors.inn}</span>}
              </label>
              <label>
                Контактное лицо
                <input value={f.contactName} onChange={set('contactName')} required maxLength={120} autoComplete="name" />
              </label>
              <label>
                Телефон
                <input value={f.phone} onChange={set('phone')} maxLength={40} autoComplete="tel" />
              </label>
            </>
          )}
          <label>
            Почта
            <input type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
            {fieldErrors.email && <span className="field-error">{fieldErrors.email}</span>}
          </label>
          <label>
            Пароль
            <input type="password" value={f.password} onChange={set('password')} required minLength={reg ? 10 : 1} autoComplete={reg ? 'new-password' : 'current-password'} />
            {reg && <span className="hint">Не короче 10 знаков</span>}
          </label>
          <button className="btn primary" type="submit" disabled={busy || !innOk}>
            {busy ? 'Подождите…' : reg ? 'Создать кабинет' : 'Войти'}
          </button>
        </form>
        <p className="switch">
          {reg ? (
            <>
              Уже есть кабинет? <Link to="/login">Войти</Link>
            </>
          ) : (
            <>
              Ещё не зарегистрированы? <Link to="/register">Создать кабинет</Link>
            </>
          )}
        </p>
      </section>
    </div>
  );
}
