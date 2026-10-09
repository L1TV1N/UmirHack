import type { TelegramLinkCodeDto, TelegramStatusDto } from '@zapas/shared';
import { useEffect, useState } from 'react';
import { del, post } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { errorMessage } from '../../lib/errors';
import { fmtDateTime } from '../../lib/format';
import { Button } from '../Button/Button';
import { Dialog } from '../Dialog/Dialog';
import { ErrorNote } from '../Feedback/Feedback';
import { useConfirm } from '../Toast/Confirm';
import { useToast } from '../Toast/Toast';
import styles from './TelegramDialog.module.scss';

const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const hhmm = (iso: string) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function TelegramDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [code, setCode] = useState<TelegramLinkCodeDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // пока показан код, раз в три секунды смотрим, не привязал ли человек чат
  const status = useGet<TelegramStatusDto>('/telegram', undefined, { enabled: open, refetchInterval: open && code ? 3000 : false });
  const data = status.data;

  const issue = useAction(() => post<TelegramLinkCodeDto>('/telegram/link-code'), ['/telegram']);
  const unlink = useAction(() => del('/telegram/link'), ['/telegram']);

  useEffect(() => {
    if (!open) {
      setCode(null);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (code && data?.linked) {
      setCode(null);
      toast.success('Telegram привязан');
    }
  }, [code, data?.linked, toast]);

  const getCode = () => {
    setError(null);
    issue.mutate(undefined, { onSuccess: setCode, onError: (err) => setError(errorMessage(err)) });
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      toast.success('Код скопирован');
    } catch {
      toast.error('Не удалось скопировать, выделите код вручную');
    }
  };

  const detach = async () => {
    const ok = await confirm({
      title: 'Отвязать Telegram?',
      message: 'Бот перестанет отвечать в этом чате. Привязать снова можно в любой момент по новому коду.',
      confirmLabel: 'Отвязать',
      danger: true,
    });
    if (!ok) return;
    unlink.mutate(undefined, {
      onSuccess: () => toast.success('Чат отвязан'),
      onError: (err) => toast.error(errorMessage(err)),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Telegram"
      subtitle="Бот отвечает на команды с вашими правами и точками"
      width={460}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      {status.isLoading && <p className="muted">Загрузка…</p>}
      {status.isError && <ErrorNote error={status.error} onRetry={() => void status.refetch()} />}
      {error && <ErrorNote message={error} />}

      {data && !data.enabled && (
        <p className={styles.note}>
          Бот не подключён к серверу. Администратор включает его переменными <code>TELEGRAM_BOT_TOKEN</code> и <code>TELEGRAM_CHAT_ID</code>.
        </p>
      )}

      {data?.enabled && data.linked && (
        <div className={styles.stack}>
          <p className={styles.state}>
            <span className={styles.dot} aria-hidden="true" />
            Чат привязан{data.chatUsername ? `, @${data.chatUsername}` : ''}
            <small>с {data.linkedAt ? fmtDateTime(data.linkedAt) : ''}</small>
          </p>
          <p className={styles.note}>
            Напишите боту <code>/help</code>, чтобы увидеть команды: остатки, стоп-лист, что требует действий. Бот только показывает данные, операции остаются в веб-интерфейсе.
          </p>
          <div>
            <Button variant="danger" onClick={() => void detach()} loading={unlink.isPending}>
              Отвязать чат
            </Button>
          </div>
        </div>
      )}

      {data?.enabled && !data.linked && !code && (
        <div className={styles.stack}>
          <p className={styles.note}>
            Привяжите свой личный чат с ботом, и данные станут доступны прямо в Telegram. Для этого нужен одноразовый код, он действует 10 минут.
          </p>
          <div>
            <Button variant="primary" onClick={getCode} loading={issue.isPending}>
              Получить код
            </Button>
          </div>
        </div>
      )}

      {data?.enabled && !data.linked && code && (
        <div className={styles.stack}>
          <ol className={styles.steps}>
            <li>
              Откройте бота{data.botUsername ? <> <strong>@{data.botUsername}</strong></> : ''} в Telegram и нажмите «Запустить».
            </li>
            <li>Отправьте ему команду с этим кодом.</li>
          </ol>
          <div className={styles.codeBox}>
            <code className={styles.code} aria-label={`Код привязки ${code.code.split('').join(' ')}`}>
              {spaced(code.code)}
            </code>
            <small>действует до {hhmm(code.expiresAt)}, использовать можно один раз</small>
          </div>
          <div className={styles.row}>
            {code.deepLink && (
              <a className={styles.open} href={code.deepLink} target="_blank" rel="noopener noreferrer">
                Открыть бота с кодом
              </a>
            )}
            <Button onClick={() => void copy()}>Скопировать код</Button>
            <Button variant="ghost" onClick={getCode} loading={issue.isPending}>
              Новый код
            </Button>
          </div>
          <p className={styles.note}>
            Ссылка сама отправит код боту. Если открыли бота вручную, напишите <code>/link {spaced(code.code).replace(' ', '')}</code>. Окно можно держать открытым: привязка заметится сама.
          </p>
        </div>
      )}
    </Dialog>
  );
}
