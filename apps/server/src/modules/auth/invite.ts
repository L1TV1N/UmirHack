import type { Deps } from '../../lib/context';
import { describeMailError } from '../orders/mailer';

export interface InviteResult {
  sent: boolean;
  error: string | null;
}

/** Письмо с временным паролем. Без настроенной почты или при сбое пароль остаётся у администратора на экране. */
export async function sendTemporaryPassword(
  deps: Deps,
  to: { email: string; fullName: string; organizationName: string },
  password: string,
  kind: 'invite' | 'reset',
): Promise<InviteResult> {
  if (!deps.mailer || !deps.config.smtp) return { sent: false, error: 'почта на сервере не настроена' };
  const origin = deps.config.appOrigins[0];
  const intro =
    kind === 'invite'
      ? `Вас добавили в «Запас» (${to.organizationName}).`
      : `Администратор сбросил ваш пароль в «Запасе» (${to.organizationName}).`;
  const text = [
    `Здравствуйте, ${to.fullName}!`,
    '',
    intro,
    ...(origin ? ['', `Войти: ${origin}`] : []),
    `Логин: ${to.email}`,
    `Временный пароль: ${password}`,
    '',
    'При первом входе система попросит заменить его на свой. Письмо лучше удалить после смены пароля.',
  ].join('\n');
  try {
    await deps.mailer.send({ to: to.email, subject: kind === 'invite' ? 'Приглашение в «Запас»' : 'Новый временный пароль в «Запасе»', text });
    return { sent: true, error: null };
  } catch (err) {
    deps.log.warn({ reason: describeMailError(err) }, 'не удалось отправить письмо с временным паролем');
    return { sent: false, error: describeMailError(err) };
  }
}
