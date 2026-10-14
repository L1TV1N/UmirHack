import { loginBody } from '@zapas/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { useScope } from '../../auth/ScopeProvider';
import { Truck } from 'lucide-react';
import { Button, ExternalButton } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
import { BrandMark } from '../../components/Layout/Brand';
import { usePortalLink } from '../../lib/usePortalLink';
import { TeamMark } from '../../components/TeamBanner/TeamMark';
import styles from './LoginPage.module.scss';

export default function LoginPage() {
  const { status, login, sessionEnded } = useAuth();
  const scope = useScope();
  const portal = usePortalLink();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Вход - Запас';
  }, []);

  if (status === 'authenticated') {
    // после входа всегда выбор заведения; вернуться на прежнюю страницу можно, только если заведение уже выбрано
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={scope.selected && from ? from : '/select'} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = loginBody.safeParse({ email, password });
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.path[0] === 'email' ? 'Введите адрес почты полностью' : 'Введите пароль';
      setErrors(out);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await login(parsed.data.email, parsed.data.password);
    } catch (err) {
      // после неудачи пароль стирается, и фокус сразу в поле: исправить опечатку можно без лишних кликов
      setPassword('');
      passwordRef.current?.focus();
      if (err instanceof ApiError && err.status === 429) setFormError('Слишком много попыток. Подождите минуту и повторите.');
      else if (err instanceof ApiError) setFormError(err.message);
      else setFormError('Нет связи с сервером');
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
          <h1>Остатки, сроки годности и стоп-лист в одном месте</h1>
          <p>Система показывает, что и где лежит, что испортится раньше, чем его купят, и что продавать в первую очередь.</p>
          <ul className={styles.facts}>
            <li>Учёт по партиям, расход по принципу «первым уходит то, что раньше испортится»</li>
            <li>Стоп-лист из остатков и рецептур блюд, с причиной по каждой позиции</li>
            <li>Рекомендации: списать, уценить, переместить, заказать</li>
          </ul>
        </div>
        <div className={styles.foot}>
          <span className={styles.team}>
            <TeamMark size={22} />
            Сделано командой CyberPink228
          </span>
          <span>Все действия пользователей фиксируются в журнале.</span>
        </div>
      </section>

      <section className={styles.formSide}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <h2>Вход в систему</h2>
          <p>Используйте рабочую почту и пароль, выданные администратором, или создайте аккаунт своей организации.</p>
          {sessionEnded && !formError && (
            <div className={styles.notice} role="status">
              Сессия закончилась. Войдите снова, чтобы продолжить работу.
            </div>
          )}
          {formError && (
            <div className={styles.alert} role="alert">
              {formError}
            </div>
          )}
          <Field label="Почта" error={errors.email}>
            {(p) => <Input {...p} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Пароль" error={errors.password}>
            {(p) => <Input {...p} ref={passwordRef} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button variant="primary" type="submit" loading={busy} style={{ height: 40 }}>
            Войти
          </Button>
          <p className={styles.alt}>
            Нет учётной записи? <Link to="/register">Создать аккаунт организации</Link>
          </p>
          {portal && (
            <div className={styles.supplier}>
              <span>Вы поставщик?</span>
              <ExternalButton href={portal} target="_self" icon={<Truck size={16} />} style={{ height: 40, justifyContent: 'center' }}>
                Перейти в «Отгрузку»
              </ExternalButton>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
