import { completeInn } from '@zapas/shared';
import { parseConfig } from './config';
import { openDb } from './db';
import { hashPassword } from './security';
import { accountByInn, insertAccount } from './store';

/** Учётные записи демо-поставщиков: те же компании и ИНН, что в справочнике «Запаса», чтобы заказы находили своего адресата. */
const DEMO = [
  { company: 'Молочный комбинат «Донской»', inn: completeInn('616301234'), contactName: 'Ковалёв Игорь Петрович', email: 'zakaz@donskoy-moloko.example', phone: '+7 863 200-11-22' },
  { company: 'Агрофирма «Зерновая»', inn: completeInn('616302345'), contactName: 'Миронова Алла Сергеевна', email: 'orders@zernovaya.example', phone: '+7 863 210-34-56' },
  { company: 'Мясокомбинат «Азовский»', inn: completeInn('616103456'), contactName: 'Рахимов Тимур Маратович', email: 'zakaz@azovskiy-meat.example', phone: '+7 863 255-90-14' },
  { company: 'ТД «Свежий урожай»', inn: completeInn('616404567'), contactName: 'Лебедева Ольга Игоревна', email: 'sale@svezhiy-urozhay.example', phone: '+7 863 240-77-08' },
  { company: 'Хлебозавод №4', inn: completeInn('616505678'), contactName: 'Воронин Павел Андреевич', email: 'zakaz@hleb4.example', phone: '+7 863 221-45-60' },
  { company: 'Рыбный двор', inn: completeInn('616606789'), contactName: 'Гусев Роман Викторович', email: 'sale@rybnyi-dvor.example', phone: '+7 863 266-18-33' },
];

export const DEMO_PASSWORD = 'Отгрузка-Склад-27-ключ';

const config = parseConfig();
const db = openDb(config.dbFile);
const passwordHash = await hashPassword(process.env.SUPPLIER_DEMO_PASSWORD ?? DEMO_PASSWORD);
let created = 0;
for (const d of DEMO) {
  if (accountByInn(db, d.inn)) continue;
  insertAccount(db, { ...d, passwordHash }, new Date());
  created += 1;
}
console.log(`Демо-поставщиков добавлено: ${created} из ${DEMO.length}`);
db.close();
