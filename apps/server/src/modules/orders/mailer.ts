import nodemailer, { type Transporter } from 'nodemailer';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Короткая причина сбоя для журнала и интерфейса: без адресов, логинов и текста ответа сервера. */
export function describeMailError(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'EAUTH') return 'почтовый сервер не принял логин и пароль';
  if (code === 'EENVELOPE') return 'адрес получателя отклонён';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED') return 'нет соединения с почтовым сервером';
  if (code === 'ESTREAM' || code === 'EMESSAGE') return 'почтовый сервер не принял письмо';
  return 'не удалось отправить письмо';
}

/** Письма через SMTP. Адрес сервера, логин и пароль берутся из SMTP_URL и в журналы не попадают. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({ url, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}) });
  }
}

/** Для тестов: складывает письма в массив или падает с заданным кодом. */
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  failure: { code: string } | null = null;

  async send(mail: Mail): Promise<void> {
    if (this.failure) throw Object.assign(new Error('smtp: секретная подробность'), this.failure);
    this.sent.push(mail);
  }
}
