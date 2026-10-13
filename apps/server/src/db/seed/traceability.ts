import { canonicalBarcode, VSD_REDEEM_HOURS, addDays } from '@zapas/shared';
import type { Transaction } from 'kysely';
import { createHash } from 'node:crypto';
import type { Database } from '../types';

/** Псевдослучайное число от 0 до 1, одно и то же для одной строки: демо-данные не меняются от запуска к запуску. */
const unit = (seed: string) => parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const serial = (seed: string) => {
  const bytes = createHash('sha1').update(seed).digest();
  return Array.from({ length: 13 }, (_, i) => ALPHABET[(bytes[i] as number) % ALPHABET.length]).join('');
};

/** Номер ВСД в виде UUID, один и тот же для одной партии. */
function vsdNumber(batchId: string): string {
  const hex = createHash('sha1').update(`vsd:${batchId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * ВСД и коды маркировки к недавним приходам, чтобы раздел «Прослеживаемость» не был пустым: часть ВСД ждёт
 * погашения, часть просрочена, остальные погашены. Старше двух суток всё погашено и в демо не нужно.
 */
export async function seedTraceability(trx: Transaction<Database>, now: Date, today: string): Promise<void> {
  const recent = await trx
    .selectFrom('batches as b')
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .select(['b.id', 'b.product_id', 'b.supplier_id', 'b.location_id', 'b.received_on', 'b.initial_qty', 'b.created_at', 'p.unit', 'p.barcode', 'p.requires_vsd', 'p.requires_marking'])
    .where('b.received_on', '>=', addDays(today, -2))
    .where((eb) => eb.or([eb('p.requires_vsd', '=', true), eb('p.requires_marking', '=', true)]))
    .orderBy('b.created_at')
    .orderBy('b.id')
    .execute();

  const redeemer = await trx.selectFrom('users').select('id').where('email', '=', 'keeper@zapas.local').executeTakeFirst();

  const certs = recent
    .filter((b) => b.requires_vsd)
    .map((b) => {
      const due = new Date(b.created_at.getTime() + VSD_REDEEM_HOURS * 3_600_000);
      const redeemed =
        b.received_on === today ? false : b.received_on === addDays(today, -1) ? unit(`vsd:${b.id}`) < 0.85 : unit(`vsd:${b.id}`) < 0.95;
      const at = new Date(b.created_at.getTime() + (1 + unit(`at:${b.id}`) * 9) * 3_600_000);
      return {
        number: vsdNumber(b.id),
        batch_id: b.id,
        product_id: b.product_id,
        supplier_id: b.supplier_id,
        location_id: b.location_id,
        quantity: b.initial_qty,
        received_at: b.created_at,
        due_at: due,
        status: redeemed ? ('redeemed' as const) : ('pending' as const),
        redeemed_at: redeemed ? (at.getTime() < now.getTime() ? at : now) : null,
        redeemed_by: redeemed ? (redeemer?.id ?? null) : null,
      };
    });
  for (let i = 0; i < certs.length; i += 300) await trx.insertInto('vet_certificates').values(certs.slice(i, i + 300)).execute();

  const marks = recent
    .filter((b) => b.requires_marking && b.barcode && canonicalBarcode(b.barcode) && b.received_on >= addDays(today, -1))
    .flatMap((b) => {
      const gtin = canonicalBarcode(b.barcode as string) as string;
      const count = Math.min(Math.round(Number(b.initial_qty)), b.unit === 'pcs' ? 200 : 100);
      return Array.from({ length: count }, (_, i) => {
        const s = serial(`${b.id}:${i}`);
        return { batch_id: b.id, gtin, serial: s, code: `01${gtin}21${s}91EE1192${serial(`tail:${b.id}:${i}`)}`, created_at: b.created_at };
      });
    });
  for (let i = 0; i < marks.length; i += 500) await trx.insertInto('batch_marks').values(marks.slice(i, i + 500)).execute();
}
