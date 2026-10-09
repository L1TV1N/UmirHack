import { settingsBody, type SettingsDto } from '@zapas/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { post, put } from '../../api/client';
import { useAction, useGet } from '../../api/hooks';
import { Button } from '../../components/Button/Button';
import { Chip } from '../../components/Chip/Chip';
import { Field, FieldRow, Input } from '../../components/Controls/Controls';
import { ErrorNote, Loading } from '../../components/Feedback/Feedback';
import { Panel } from '../../components/Panel/Panel';
import { useToast } from '../../components/Toast/Toast';
import { errorMessage } from '../../lib/errors';

type Keys = 'expiringSoonDays' | 'criticalDays' | 'forecastWindowDays' | 'reorderCoverDays' | 'lowPortionThreshold' | 'digestHour';

export function SettingsPanel() {
  const toast = useToast();
  const settings = useGet<SettingsDto>('/settings');
  const [values, setValues] = useState<Record<Keys, string>>({
    expiringSoonDays: '',
    criticalDays: '',
    forecastWindowDays: '',
    reorderCoverDays: '',
    lowPortionThreshold: '',
    digestHour: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) {
      const s = settings.data;
      setValues({
        expiringSoonDays: String(s.expiringSoonDays),
        criticalDays: String(s.criticalDays),
        forecastWindowDays: String(s.forecastWindowDays),
        reorderCoverDays: String(s.reorderCoverDays),
        lowPortionThreshold: String(s.lowPortionThreshold),
        digestHour: String(s.digestHour),
      });
    }
  }, [settings.data]);

  const save = useAction((body: object) => put<SettingsDto>('/settings', body), ['/settings', '/stock', '/analytics', '/stop-list']);
  const test = useAction(() => post('/notifications/test'));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = settingsBody.safeParse(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? Number.NaN : Number(v)])));
    if (!parsed.success) {
      const out: Record<string, string> = {};
      for (const issue of parsed.error.issues) out[String(issue.path[0])] ??= issue.message;
      return setErrors(out);
    }
    setErrors({});
    save.mutate(parsed.data, {
      onSuccess: () => toast.success('Настройки сохранены'),
      onError: (err) => setFormError(errorMessage(err)),
    });
  };

  const field = (key: Keys, label: string, hint: string) => (
    <Field label={label} hint={hint} error={errors[key]} required>
      {(p) => <Input {...p} inputMode="numeric" value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />}
    </Field>
  );

  if (settings.isLoading) return <Loading />;
  if (settings.isError) return <ErrorNote error={settings.error} onRetry={() => void settings.refetch()} />;

  return (
    <Panel title="Параметры расчётов" subtitle="Влияют на статусы сроков, прогноз и рекомендации у всех пользователей" padded>
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
        <FieldRow>
          {field('expiringSoonDays', 'Скоро истекает, суток', 'За сколько суток до конца срока партия получает статус «Скоро истекает»')}
          {field('criticalDays', 'Критично, суток', 'Не больше порога слева. Срок 0 означает «истекает сегодня»')}
        </FieldRow>
        <FieldRow>
          {field('forecastWindowDays', 'Окно прогноза, суток', 'За какой период считать скорость продаж (7–90)')}
          {field('reorderCoverDays', 'Запас для заказа, суток', 'На сколько суток продаж предлагать заказ')}
        </FieldRow>
        <FieldRow>
          {field('lowPortionThreshold', 'Мало порций, шт.', 'Блюдо с таким числом порций и меньше попадёт в предупреждения')}
          {field('digestHour', 'Час ежедневной сводки', 'По часовому поясу бизнеса, от 0 до 23')}
        </FieldRow>
        {formError && <ErrorNote message={formError} />}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary" type="submit" loading={save.isPending}>
            Сохранить
          </Button>
          <span className="muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            Telegram: <Chip tone={settings.data?.telegramConfigured ? 'ok' : 'neutral'}>{settings.data?.telegramConfigured ? 'подключён' : 'не настроен'}</Chip>
          </span>
          {settings.data?.telegramConfigured && (
            <Button
              loading={test.isPending}
              onClick={() => test.mutate(undefined, { onSuccess: () => toast.success('Тестовая сводка отправлена'), onError: (err) => toast.error(errorMessage(err)) })}
            >
              Отправить тестовую сводку
            </Button>
          )}
        </div>
        {!settings.data?.telegramConfigured && (
          <p className="muted">Чтобы получать сводки и сообщения о стоп-листе в Telegram, задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в настройках сервера.</p>
        )}
      </form>
    </Panel>
  );
}
