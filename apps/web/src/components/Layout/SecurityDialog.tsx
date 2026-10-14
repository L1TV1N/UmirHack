import { formatRecoveryCode, type TwoFactorConfirmDto, type TwoFactorPurpose, type TwoFactorStartDto, type TwoFactorStatusDto } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { Button } from '../Button/Button';
import { Field, Input } from '../Controls/Controls';
import { Dialog } from '../Dialog/Dialog';
import { ErrorNote } from '../Feedback/Feedback';
import { useToast } from '../Toast/Toast';
import styles from './TelegramDialog.module.scss';

type Flow = { purpose: TwoFactorPurpose; challengeId: string | null; delivered: boolean };

const TITLES: Record<TwoFactorPurpose, string> = {
  enable: 'Включение подтверждения входа',
  disable: 'Отключение подтверждения входа',
  recovery: 'Новые резервные коды',
};

/** Подтверждение входа кодом из Telegram: включение, отключение, резервные коды. Меню видит только администратор. */
export function SecurityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const status = useGet<TwoFactorStatusDto>('/auth/2fa', undefined, { enabled: open });
  const data = status.data;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const start = useAction((vars: { purpose: TwoFactorPurpose; password?: string }) => post<TwoFactorStartDto>('/auth/2fa/start', vars));
  const confirm = useAction((vars: { challengeId: string; code: string }) => post<TwoFactorConfirmDto>('/auth/2fa/confirm', vars), ['/auth/2fa', '/users']);

  useEffect(() => {
    if (!open) {
      setFlow(null);
      setPassword('');
      setCode('');
      setError(null);
      setCodes(null);
      setSaved(false);
    }
  }, [open]);

  const begin = (purpose: TwoFactorPurpose) => {
    setError(null);
    setCode('');
    setPassword('');
    if (purpose === 'enable') requestCode(purpose);
    else setFlow({ purpose, challengeId: null, delivered: true });
  };

  const requestCode = (purpose: TwoFactorPurpose, pwd?: string) => {
    setError(null);
    start.mutate(
      { purpose, ...(pwd ? { password: pwd } : {}) },
      {
        onSuccess: (res) => setFlow({ purpose, challengeId: res.challengeId, delivered: res.delivered }),
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (!flow) return;
    if (!password) return setError('Введите пароль');
    requestCode(flow.purpose, password);
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (!flow?.challengeId) return;
    if (!code.trim()) return setError('Введите код');
    setError(null);
    confirm.mutate(
      { challengeId: flow.challengeId, code: code.trim() },
      {
        onSuccess: (res) => {
          setCode('');
          if (res.recoveryCodes) {
            setCodes(res.recoveryCodes);
            setSaved(false);
          } else {
            toast.success('Подтверждение входа выключено');
          }
          setFlow(null);
        },
        onError: (err) => {
          setCode('');
          setError(errorMessage(err));
        },
      },
    );
  };

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(codes.map(formatRecoveryCode).join('\n'));
      toast.success('Коды скопированы');
    } catch {
      toast.error('Не удалось скопировать, выделите коды вручную');
    }
  };

  const download = () => {
    if (!codes) return;
    const text = `Резервные коды для входа в «Запас»\nКаждый код работает один раз.\n\n${codes.map(formatRecoveryCode).join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'zapas-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const footer = codes ? (
    <Button variant="primary" disabled={!saved} onClick={() => setCodes(null)}>
      Готово
    </Button>
  ) : (
    <Button onClick={onClose}>Закрыть</Button>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Безопасность" subtitle="Подтверждение входа кодом из Telegram" width={480} footer={footer}>
      {status.isLoading && <p className="muted">Загрузка…</p>}
      {status.isError && <ErrorNote error={status.error} onRetry={() => void status.refetch()} />}
      {error && <ErrorNote message={error} />}

      {codes && (
        <div className={styles.stack}>
          <p className={styles.note}>
            <strong>Сохраните резервные коды.</strong> Они нужны, если Telegram будет недоступен: каждый работает один раз. Показаны только сейчас, потом их не восстановить.
          </p>
          <div className={styles.codeBox}>
            <ul aria-label="Резервные коды" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 28px' }}>
              {codes.map((c) => (
                <li key={c}>
                  <code className={styles.code} style={{ fontSize: 16 }}>
                    {formatRecoveryCode(c)}
                  </code>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.row}>
            <Button onClick={() => void copy()}>Скопировать</Button>
            <Button onClick={download}>Скачать файл</Button>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            Я сохранил коды в надёжном месте
          </label>
        </div>
      )}

      {!codes && flow && !flow.challengeId && (
        <form className={styles.stack} onSubmit={submitPassword} noValidate>
          <p className={styles.note}>{TITLES[flow.purpose]}: подтвердите действие паролем, затем введите код из Telegram.</p>
          <Field label="Пароль" required>
            {(p) => <Input {...p} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <div className={styles.row}>
            <Button variant="primary" type="submit" loading={start.isPending}>
              Получить код
            </Button>
            <Button variant="ghost" type="button" onClick={() => setFlow(null)}>
              Отмена
            </Button>
          </div>
        </form>
      )}

      {!codes && flow?.challengeId && (
        <form className={styles.stack} onSubmit={submitCode} noValidate>
          <p className={styles.note}>
            {flow.delivered
              ? 'Код отправлен в Telegram, он действует 5 минут.'
              : 'Код в Telegram отправить не удалось. Введите один из резервных кодов.'}
          </p>
          <Field label="Код" required>
            {(p) => <Input {...p} autoComplete="one-time-code" autoFocus maxLength={24} value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <div className={styles.row}>
            <Button variant="primary" type="submit" loading={confirm.isPending}>
              Подтвердить
            </Button>
            <Button variant="ghost" type="button" onClick={() => setFlow(null)}>
              Отмена
            </Button>
          </div>
        </form>
      )}

      {!codes && !flow && data && !data.eligible && <p className={styles.note}>Подтверждение входа доступно администраторам.</p>}

      {!codes && !flow && data?.eligible && !data.botConfigured && (
        <p className={styles.note}>
          Бот Telegram не подключён к серверу. Подтверждение входа работает через него: сначала бота настраивает администратор сервера (<code>TELEGRAM_BOT_TOKEN</code>).
        </p>
      )}

      {!codes && !flow && data?.eligible && data.botConfigured && data.enabled && (
        <div className={styles.stack}>
          <p className={styles.state}>
            <span className={styles.dot} aria-hidden="true" />
            Подтверждение входа включено
            <small>с {data.enabledAt ? fmtDateTime(data.enabledAt) : ''}</small>
          </p>
          <p className={styles.note}>
            При входе по паролю код приходит в ваш чат с ботом. Резервных кодов осталось: <strong>{data.recoveryCodesLeft}</strong>.
            {data.recoveryCodesLeft <= 2 && ' Выпустите новые, пока они не закончились.'}
          </p>
          <div className={styles.row}>
            <Button onClick={() => begin('recovery')}>Новые резервные коды</Button>
            <Button variant="danger" onClick={() => begin('disable')}>
              Отключить
            </Button>
          </div>
        </div>
      )}

      {!codes && !flow && data?.eligible && data.botConfigured && !data.enabled && (
        <div className={styles.stack}>
          <p className={styles.note}>
            Пароль администратора защищает все данные организации. Подтверждение входа добавляет второй шаг: после пароля бот присылает код, и без него войти нельзя.
          </p>
          {!data.telegramLinked ? (
            <p className={styles.note}>
              <strong>Сначала привяжите Telegram:</strong> меню пользователя, пункт «Telegram». Код подтверждения придёт в тот же чат.
            </p>
          ) : (
            <div>
              <Button variant="primary" onClick={() => begin('enable')} loading={start.isPending}>
                Включить
              </Button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
