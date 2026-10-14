import type { TwoFactorChallengeDto } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Button } from '../../components/Button/Button';
import { Field, Input } from '../../components/Controls/Controls';
import styles from './LoginPage.module.scss';

interface Props {
  challenge: TwoFactorChallengeDto;
  /** Проверяет код. Успех завершает вход, ошибка приходит исключением. */
  onVerify(code: string): Promise<void>;
  /** Просит новый код и возвращает обновлённый запрос. */
  onResend(): Promise<TwoFactorChallengeDto>;
  /** Вернуться к вводу пароля: запрос закрыт или человек передумал. */
  onBack(reason?: string): void;
}

/** Ошибки, после которых запрос кода закрыт и вводить код бессмысленно. */
const DEAD = new Set(['invalid_challenge', 'challenge_exhausted']);

/** Второй шаг входа администратора: код из Telegram или резервный код. */
export function TwoFactorStep({ challenge, onVerify, onResend, onBack }: Props) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState(challenge);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + challenge.resendAfter * 1000);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError('Введите код');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onVerify(code.trim());
    } catch (err) {
      setCode('');
      if (err instanceof ApiError && DEAD.has(err.code ?? '')) onBack(err.message);
      else if (err instanceof ApiError) setError(err.status === 429 ? 'Слишком много попыток. Подождите минуту и повторите.' : err.message);
      else setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await onResend();
      setCurrent({ ...current, ...next, twoFactorRequired: true });
      setWaitUntil(Date.now() + next.resendAfter * 1000);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_challenge') onBack(err.message);
      else setError(err instanceof ApiError ? err.message : 'Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <h2>Подтвердите вход</h2>
      <p>
        {current.delivered
          ? 'Мы отправили код в ваш Telegram. Он действует 5 минут. Введите его ниже.'
          : 'Не удалось отправить код в Telegram. Введите один из резервных кодов, которые вы сохранили при включении защиты.'}
      </p>
      {error && (
        <div className={styles.alert} role="alert">
          {error}
        </div>
      )}
      <Field label="Код из Telegram или резервный код" error={undefined} hint="Шесть цифр или десять знаков резервного кода">
        {(p) => <Input {...p} autoComplete="one-time-code" autoFocus maxLength={24} value={code} onChange={(e) => setCode(e.target.value)} />}
      </Field>
      <Button variant="primary" type="submit" loading={busy} style={{ height: 40 }}>
        Подтвердить
      </Button>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <Button variant="ghost" type="button" onClick={() => void resend()} disabled={busy || wait > 0}>
          {wait > 0 ? `Отправить ещё раз через ${wait} с` : 'Отправить код ещё раз'}
        </Button>
        <Button variant="ghost" type="button" onClick={() => onBack()}>
          Назад
        </Button>
      </div>
    </form>
  );
}
