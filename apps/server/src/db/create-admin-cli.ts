import { checkPassword, loginBody, hasForbiddenChars } from '@zapas/shared';
import { createInterface } from 'node:readline/promises';
import { loadEnvFile, parseConfig } from '../config';
import { hashPassword } from '../modules/auth/password';
import { writeAudit } from '../modules/audit/audit';
import { createDb } from './client';

/**
 * Первый администратор. На пустой базе зайти в систему нельзя, а загрузка демо-данных в production
 * запрещена, поэтому учётную запись заводят этой командой. Пароль лучше вводить в ответ на вопрос:
 * так он не попадает ни в историю командной строки, ни в список процессов.
 */
async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Нет терминала для ввода пароля. Задайте его переменной ADMIN_PASSWORD.');
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          process.stdin.setRawMode(false);
          return reject(new Error('Прервано'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  loadEnvFile();
  const config = parseConfig();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const email = (process.env.ADMIN_EMAIL ?? (await rl.question('Почта администратора: '))).trim().toLowerCase();
  const fullName = (process.env.ADMIN_NAME ?? (await rl.question('Фамилия, имя, отчество: '))).trim();
  rl.close();
  const password = process.env.ADMIN_PASSWORD ?? (await askHidden('Пароль (от 10 символов): '));

  if (!fullName || fullName.length > 120 || hasForbiddenChars(fullName)) throw new Error('Укажите имя без служебных символов, до 120 знаков');
  if (!loginBody.shape.email.safeParse(email).success) throw new Error('Некорректный адрес почты');
  const problem = checkPassword(password, { email, fullName });
  if (problem) throw new Error(problem);

  const handle = createDb(config.migrationDatabaseUrl, 2);
  try {
    const passwordHash = await hashPassword(password);
    const now = new Date();
    await handle.db.transaction().execute(async (trx) => {
      const exists = await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
      if (exists) throw new Error('Пользователь с такой почтой уже есть');
      const row = await trx
        .insertInto('users')
        .values({
          email,
          full_name: fullName,
          password_hash: passwordHash,
          role: 'admin',
          locked_until: null,
          last_login_at: null,
          password_changed_at: now,
          created_at: now,
          updated_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { action: 'user.create', entity: 'user', entityId: row.id, email, details: { email, role: 'admin', source: 'cli' }, at: now });
    });
    console.log(`Администратор ${email} создан`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
