import { EMAIL_CODE_LENGTH, EMAIL_CODE_TTL_SECONDS, type EmailVerificationPendingDto } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Button } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
import styles from './LoginPage.module.scss';

interface Props {
  pending: EmailVerificationPendingDto;
  /** Проверяет код. Успех завершает вход, ошибка приходит исключением. */
  onVerify(code: string): Promise<void>;
  /** Просит новое письмо. */
  onResend(): Promise<{ resendAfter: number }>;
  onBack(): void;
}

/** Ошибки, после которых этот код уже не принять: нужно запросить новый. */
const STALE = new Set(['code_exhausted']);

/** Подтверждение почты кодом из письма: после регистрации или при первом входе. */
export function EmailCodeStep({ pending, onVerify, onResend, onBack }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(pending.delivered ? null : 'Письмо не удалось отправить. Нажмите «Отправить ещё раз».');
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + pending.resendAfter * 1000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!new RegExp(`^\\d{${EMAIL_CODE_LENGTH}}$`).test(code.trim())) {
      setError(`Код состоит из ${EMAIL_CODE_LENGTH} цифр`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onVerify(code.trim());
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && STALE.has(err.code ?? '')) setError(`${err.message}`);
      else if (err instanceof ApiError) setError(err.status === 429 ? 'Слишком много попыток. Подождите минуту и повторите.' : err.message);
      else setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await onResend();
      setWaitUntil(Date.now() + next.resendAfter * 1000);
      setNotice('Если адрес верный, новое письмо уже в пути.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <h2>Подтвердите почту</h2>
      <p>
        Мы отправили код на {pending.email}. Он действует {EMAIL_CODE_TTL_SECONDS / 60} минут. Если письма нет, загляните в «Спам».
      </p>
      {notice && !error && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className={styles.alert} role="alert">
          {error}
        </div>
      )}
      <Field label="Код из письма" hint={`${EMAIL_CODE_LENGTH} цифр`}>
        {(p) => <Input {...p} inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={EMAIL_CODE_LENGTH} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}
      </Field>
      <Button variant="primary" type="submit" loading={busy} style={{ height: 40 }}>
        Подтвердить
      </Button>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <Button variant="ghost" type="button" onClick={() => void resend()} disabled={busy || wait > 0}>
          {wait > 0 ? `Отправить ещё раз через ${wait} с` : 'Отправить письмо ещё раз'}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack}>
          Назад
        </Button>
      </div>
    </form>
  );
}
