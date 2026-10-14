import { registerBody } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
import { BrandMark } from '../../components/Layout/Brand';
import { TeamMark } from '../../components/TeamBanner/TeamMark';
import styles from './LoginPage.module.scss';

/** Регистрация организации: создаётся организация и её первый администратор, дальше он сам заводит заведения и сотрудников. */
export default function RegisterPage() {
  const { status, register } = useAuth();
  const [f, setF] = useState({ organizationName: '', fullName: '', email: '', password: '', repeat: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    document.title = 'Регистрация - Запас';
  }, []);

  if (status === 'authenticated') return <Navigate to="/select" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = registerBody.safeParse({ organizationName: f.organizationName, fullName: f.fullName, email: f.email, password: f.password });
    const out: Record<string, string> = {};
    if (!parsed.success) for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.path[0] === 'email' ? 'Введите адрес почты полностью' : issue.path[0] === 'password' ? issue.message : 'Заполните поле';
    if (f.password !== f.repeat) out.repeat = 'Пароли не совпадают';
    if (Object.keys(out).length > 0 || !parsed.success) return setErrors(out);
    setErrors({});
    setBusy(true);
    try {
      await register(parsed.data);
    } catch (err) {
      setFormError(err instanceof ApiError ? (err.status === 429 ? 'Слишком много попыток. Подождите минуту.' : err.message) : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.aside}>
        <div className={styles.brand}>
          <BrandMark size={34} />
          Запас
        </div>
        <div className={styles.pitch}>
          <h1>Заведите свою организацию за минуту</h1>
          <p>Вы станете её администратором: добавите заведения, пригласите сотрудников и официантов, подключите поставщиков.</p>
          <ul className={styles.facts}>
            <li>Свои склады, рестораны, магазины, кафе и бары</li>
            <li>Данные организации не видны другим организациям</li>
            <li>Сотрудникам система сама выдаёт временный пароль</li>
          </ul>
        </div>
        <div className={styles.foot}>
          <span className={styles.team}>
            <TeamMark size={22} />
            Сделано командой CyberPink228
          </span>
        </div>
      </section>
      <section className={styles.formSide}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <h2>Новая организация</h2>
          <p>Укажите название и данные администратора.</p>
          {formError && (
            <div className={styles.alert} role="alert">
              {formError}
            </div>
          )}
          <Field label="Название организации" error={errors.organizationName} required>
            {(p) => <Input {...p} value={f.organizationName} maxLength={120} autoFocus onChange={set('organizationName')} placeholder="Например, ООО «Вкус»" />}
          </Field>
          <Field label="Ваше имя" error={errors.fullName} required>
            {(p) => <Input {...p} autoComplete="name" value={f.fullName} maxLength={120} onChange={set('fullName')} />}
          </Field>
          <Field label="Почта" error={errors.email} required>
            {(p) => <Input {...p} type="email" autoComplete="username" value={f.email} onChange={set('email')} />}
          </Field>
          <Field label="Пароль" error={errors.password} hint="Не короче 10 знаков, не из самых частых" required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={f.password} onChange={set('password')} />}
          </Field>
          <Field label="Повторите пароль" error={errors.repeat} required>
            {(p) => <Input {...p} type="password" autoComplete="new-password" value={f.repeat} onChange={set('repeat')} />}
          </Field>
          <Button variant="primary" type="submit" loading={busy} style={{ height: 40 }}>
            Создать аккаунт
          </Button>
          <p className={styles.alt}>
            Уже есть учётная запись? <Link to="/login">Войти</Link>
          </p>
        </form>
      </section>
    </div>
  );
}
