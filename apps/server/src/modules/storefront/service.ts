import { createHmac, randomInt } from 'node:crypto';
import {
  roundMoney,
  STOREFRONT_CODE_ALPHABET,
  STOREFRONT_CODE_LENGTH,
  STOREFRONT_MAX_ACTIVE_PER_LOCATION,
  STOREFRONT_MAX_ACTIVE_PER_PHONE,
  type CancelReservationBody,
  type CreateOfferBody,
  type PublicOfferDto,
  type PublicRescueDto,
  type PublicVenueDto,
  type ReservationReceiptDto,
  type ReserveBody,
  type StaffOfferDto,
  type StaffReservationDto,
  type StorefrontSettingsBody,
  type StorefrontSettingsDto,
} from '@zapas/shared';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../db/types';
import type { Actor, Deps, UserPrincipal } from '../../lib/context';
import { AppError, conflict, notFound, PG_UNIQUE_VIOLATION, pgCode } from '../../lib/errors';
import { hubFor } from '../../lib/events';
import { assertLocation, locationFilter } from '../../lib/scope';
import { addMilliseconds, businessToday } from '../../lib/time';
import { writeAudit } from '../audit/audit';
import { sell } from '../stock/operations';

const NO_ROWS = ['00000000-0000-0000-0000-000000000000'];

const mac = (deps: Deps, scope: string, value: string): string => createHmac('sha256', deps.config.jwtSecret).update(`zapas.storefront:${scope}:${value}`).digest('hex');

function newCode(): string {
  let out = '';
  for (let i = 0; i < STOREFRONT_CODE_LENGTH; i += 1) out += STOREFRONT_CODE_ALPHABET[randomInt(STOREFRONT_CODE_ALPHABET.length)];
  return out;
}

const priceWith = (price: number, percent: number): number => roundMoney(price * (1 - percent / 100));
const rounded = (n: number): number => Math.round(n * 1000) / 1000;

interface OfferRow {
  id: string;
  batch_id: string;
  location_id: string;
  location_name: string;
  org_id: string;
  address: string | null;
  note: string | null;
  slug: string | null;
  storefront_enabled: boolean;
  quantity: string;
  per_guest_max: number;
  created_at: Date;
  closed_at: Date | null;
  remaining: string;
  expires_on: string;
  percent: number | null;
  product_id: string;
  product_name: string;
  unit: string;
  price: string;
  reserved: string;
  sold: string;
}

/** Предложения вместе со всем, что нужно для расчёта остатка и цены. Условия отбора добавляет вызывающий. */
async function loadOffers(deps: Deps, where: ReturnType<typeof sql>, executor: Kysely<Database> | Transaction<Database> = deps.db): Promise<OfferRow[]> {
  const today = businessToday(deps);
  const now = deps.clock();
  const res = await sql<OfferRow>`
    SELECT o.id, o.batch_id, o.location_id, o.quantity, o.per_guest_max, o.created_at, o.closed_at,
           l.name AS location_name, l.org_id, l.address, l.storefront_note AS note, l.storefront_slug AS slug, l.storefront_enabled,
           b.remaining_qty AS remaining, b.expires_on::text AS expires_on,
           p.id AS product_id, p.name AS product_name, p.unit, p.price,
           pr.percent,
           COALESCE((SELECT SUM(r.quantity) FROM storefront_reservations r WHERE r.offer_id = o.id AND r.status = 'reserved' AND r.expires_at > ${now}), 0) AS reserved,
           COALESCE((SELECT SUM(r.quantity) FROM storefront_reservations r WHERE r.offer_id = o.id AND r.status = 'picked_up'), 0) AS sold
    FROM storefront_offers o
    JOIN locations l ON l.id = o.location_id
    JOIN batches b ON b.id = o.batch_id
    JOIN products p ON p.id = b.product_id
    LEFT JOIN promotions pr ON pr.batch_id = b.id AND pr.cancelled_at IS NULL AND pr.ends_on >= ${today}::date
    WHERE ${where}
    ORDER BY l.name, b.expires_on, p.name`.execute(executor);
  return res.rows;
}

const daysLeftOf = (deps: Deps, expiresOn: string): number => {
  const today = businessToday(deps);
  return Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
};

/** Сколько ещё можно забронировать: не больше выставленного за вычетом выданного и не больше фактического остатка партии. */
function availableOf(row: OfferRow): number {
  const cap = Math.min(Number(row.quantity) - Number(row.sold), Number(row.remaining));
  const free = Math.max(0, rounded(cap - Number(row.reserved)));
  return row.unit === 'pcs' ? Math.floor(free) : free;
}

/** Почему предложение не видно гостям. null: видно. */
function hiddenReason(deps: Deps, row: OfferRow, soldOutHides = true): string | null {
  if (row.closed_at) return 'Снято с витрины';
  if (!row.storefront_enabled) return 'Витрина на точке выключена';
  if (daysLeftOf(deps, row.expires_on) < 0) return 'Срок годности вышел';
  if (row.percent === null) return 'Уценка закончилась или отменена';
  if (Number(row.remaining) <= 0) return 'Партия закончилась';
  if (soldOutHides && availableOf(row) <= 0) return 'Всё забронировано или продано';
  return null;
}

const publicOffer = (deps: Deps, row: OfferRow): PublicOfferDto => ({
  id: row.id,
  productName: row.product_name,
  unit: row.unit,
  available: availableOf(row),
  price: priceWith(Number(row.price), row.percent ?? 0),
  oldPrice: Number(row.price),
  percent: row.percent ?? 0,
  expiresOn: row.expires_on,
  daysLeft: daysLeftOf(deps, row.expires_on),
  perGuestMax: Math.min(row.per_guest_max, Math.max(1, availableOf(row))),
});

/** Публичная витрина: только точки, где её включили, и только то, что можно забронировать. */
export async function publicRescue(deps: Deps, slug?: string): Promise<PublicRescueDto> {
  const rows = await loadOffers(
    deps,
    sql`o.closed_at IS NULL AND l.is_active AND l.storefront_enabled AND l.storefront_slug IS NOT NULL ${slug ? sql`AND l.storefront_slug = ${slug}` : sql``}`,
  );
  const venues = new Map<string, PublicVenueDto>();
  for (const row of rows) {
    if (hiddenReason(deps, row) !== null || !row.slug) continue;
    let venue = venues.get(row.slug);
    if (!venue) {
      venue = { slug: row.slug, name: row.location_name, address: row.address, note: row.note, offers: [] };
      venues.set(row.slug, venue);
    }
    venue.offers.push(publicOffer(deps, row));
  }
  return { venues: [...venues.values()], holdMinutes: deps.config.storefront.holdMinutes };
}

/** Брони, у которых вышло время, закрываются: они больше не держат товар и не занимают код. */
export async function expireReservations(deps: Deps, offerId?: string): Promise<void> {
  const now = deps.clock();
  await deps.db
    .updateTable('storefront_reservations')
    .set({ status: 'expired', closed_at: now })
    .where('status', '=', 'reserved')
    .where('expires_at', '<=', now)
    .$if(Boolean(offerId), (qb) => qb.where('offer_id', '=', offerId as string))
    .execute();
}

/**
 * Бронь без оплаты. Предложение блокируется на время проверки и записи, поэтому два гостя не займут один и тот же
 * остаток. Гость не входит в систему: защищаемся лимитами (в маршруте), потолком броней на телефон и на точку.
 */
export async function reserve(deps: Deps, body: ReserveBody, ip: string | null): Promise<ReservationReceiptDto> {
  await expireReservations(deps, body.offerId);
  const now = deps.clock();
  const phoneHash = mac(deps, 'phone', body.phone);
  const expiresAt = addMilliseconds(now, deps.config.storefront.holdMinutes * 60_000);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const receipt = await deps.db.transaction().execute(async (trx) => {
        // блокировка строки предложения: остаток считается и занимается одной очередью
        const locked = await trx.selectFrom('storefront_offers').select('id').where('id', '=', body.offerId).forUpdate().executeTakeFirst();
        if (!locked) throw new AppError(404, 'offer_unavailable', 'Это предложение уже недоступно');
        const rows = await loadOffers(deps, sql`o.id = ${body.offerId}::uuid`, trx);
        const row = rows[0];
        if (!row || hiddenReason(deps, row, false) !== null) throw new AppError(404, 'offer_unavailable', 'Это предложение уже недоступно');

        const available = availableOf(row);
        const qty = row.unit === 'pcs' ? Math.floor(body.quantity) : rounded(body.quantity);
        if (qty <= 0 || (row.unit === 'pcs' && qty !== body.quantity)) throw new AppError(400, 'bad_quantity', 'Штучный товар бронируется целым количеством');
        if (qty > row.per_guest_max) throw new AppError(409, 'too_many', `Можно забронировать не больше ${row.per_guest_max} за раз`);
        if (qty > available) throw new AppError(409, 'not_enough', available > 0 ? `Осталось только ${available}` : 'Всё уже забронировано', { available });

        const mine = await trx
          .selectFrom('storefront_reservations')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('phone_hash', '=', phoneHash)
          .where('status', '=', 'reserved')
          .where('expires_at', '>', now)
          .executeTakeFirstOrThrow();
        if (Number(mine.n) >= STOREFRONT_MAX_ACTIVE_PER_PHONE) {
          throw new AppError(429, 'too_many_reservations', `На один телефон можно держать не больше ${STOREFRONT_MAX_ACTIVE_PER_PHONE} броней одновременно`);
        }
        const busy = await trx
          .selectFrom('storefront_reservations')
          .select(({ fn }) => fn.countAll<number>().as('n'))
          .where('location_id', '=', row.location_id)
          .where('status', '=', 'reserved')
          .where('expires_at', '>', now)
          .executeTakeFirstOrThrow();
        if (Number(busy.n) >= STOREFRONT_MAX_ACTIVE_PER_LOCATION) throw new AppError(429, 'venue_busy', 'На этой точке сейчас слишком много броней, попробуйте позже');

        const code = newCode();
        await trx
          .insertInto('storefront_reservations')
          .values({
            offer_id: row.id,
            location_id: row.location_id,
            code,
            quantity: qty,
            guest_name: body.name,
            guest_phone: body.phone,
            phone_hash: phoneHash,
            ip_hash: ip ? mac(deps, 'ip', ip) : null,
            created_at: now,
            expires_at: expiresAt,
          })
          .execute();
        await writeAudit(trx, {
          action: 'storefront.reserve',
          entity: 'storefront_offer',
          entityId: row.id,
          orgId: row.org_id,
          at: now,
          details: { quantity: qty, locationId: row.location_id },
        });
        return {
          orgId: row.org_id,
          receipt: {
            code,
            expiresAt: expiresAt.toISOString(),
            venue: row.location_name,
            address: row.address,
            note: row.note,
            productName: row.product_name,
            unit: row.unit,
            quantity: qty,
            total: roundMoney(qty * priceWith(Number(row.price), row.percent ?? 0)),
          } satisfies ReservationReceiptDto,
        };
      });
      hubFor(deps.db).publish(receipt.orgId);
      return receipt.receipt;
    } catch (err) {
      // два гостя получили один код одновременно: повторяем с новым
      if (pgCode(err) === PG_UNIQUE_VIOLATION && attempt < 4) continue;
      throw err;
    }
  }
  throw new AppError(503, 'busy', 'Не удалось оформить бронь, попробуйте ещё раз');
}

/** Отмена брони самим гостем: нужны код и телефон. Ответ одинаков для любого неверного сочетания. */
export async function cancelByGuest(deps: Deps, body: CancelReservationBody): Promise<void> {
  const now = deps.clock();
  const res = await deps.db
    .updateTable('storefront_reservations')
    .set({ status: 'cancelled', closed_at: now, cancel_reason: 'Отменил гость' })
    .where('code', '=', body.code)
    .where('status', '=', 'reserved')
    .where('expires_at', '>', now)
    .where('phone_hash', '=', mac(deps, 'phone', body.phone))
    .returning(['id', 'location_id'])
    .executeTakeFirst();
  if (!res) throw new AppError(404, 'reservation_not_found', 'Бронь не найдена. Проверьте код и телефон.');
  const org = await deps.db.selectFrom('locations').select('org_id').where('id', '=', res.location_id).executeTakeFirst();
  if (org) hubFor(deps.db).publish(org.org_id);
}

// ---------------------------------------------------------------------------
// Работа сотрудников
// ---------------------------------------------------------------------------

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function slugFrom(name: string): string {
  const base = [...name.toLowerCase()].map((c) => CYR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return base.length >= 3 ? base : `${base}-tochka`.replace(/^-/, '');
}

async function scopedLocation(deps: Deps, principal: UserPrincipal, id: string) {
  assertLocation(principal, id);
  const loc = await deps.db.selectFrom('locations').select(['id', 'name', 'org_id', 'storefront_enabled', 'storefront_slug', 'storefront_note']).where('id', '=', id).where('org_id', '=', principal.orgId).executeTakeFirst();
  if (!loc) throw notFound('Точка');
  return loc;
}

const settingsDto = (loc: { id: string; name: string; storefront_enabled: boolean; storefront_slug: string | null; storefront_note: string | null }): StorefrontSettingsDto => ({
  locationId: loc.id,
  locationName: loc.name,
  enabled: loc.storefront_enabled,
  slug: loc.storefront_slug,
  note: loc.storefront_note,
  publicPath: loc.storefront_slug ? `/rescue/${loc.storefront_slug}` : null,
});

export async function listSettings(deps: Deps, principal: UserPrincipal): Promise<StorefrontSettingsDto[]> {
  const allowed = locationFilter(principal);
  const rows = await deps.db
    .selectFrom('locations')
    .select(['id', 'name', 'storefront_enabled', 'storefront_slug', 'storefront_note'])
    .where('org_id', '=', principal.orgId)
    .where('is_active', '=', true)
    .$if(allowed !== null, (qb) => qb.where('id', 'in', allowed?.length ? allowed : NO_ROWS))
    .orderBy('name')
    .execute();
  return rows.map(settingsDto);
}

export async function saveSettings(deps: Deps, actor: Actor, body: StorefrontSettingsBody): Promise<StorefrontSettingsDto> {
  const principal = actor.principal as UserPrincipal;
  const loc = await scopedLocation(deps, principal, body.locationId);
  const now = deps.clock();
  let slug = body.slug ?? loc.storefront_slug;
  if (body.enabled && !slug) slug = slugFrom(loc.name);
  try {
    const updated = await deps.db.transaction().execute(async (trx) => {
      let candidate = slug;
      // автоматически выбранный адрес может быть занят другой организацией: добавляем число
      for (let n = 2; ; n += 1) {
        const taken = candidate ? await trx.selectFrom('locations').select('id').where('storefront_slug', '=', candidate).where('id', '<>', loc.id).executeTakeFirst() : undefined;
        if (!taken) break;
        if (body.slug) throw conflict('Такой адрес уже занят, выберите другой', undefined, 'slug_taken');
        candidate = `${slug}-${n}`;
      }
      const row = await trx
        .updateTable('locations')
        .set({ storefront_enabled: body.enabled, storefront_slug: candidate, storefront_note: body.note ?? null })
        .where('id', '=', loc.id)
        .returning(['id', 'name', 'storefront_enabled', 'storefront_slug', 'storefront_note'])
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { action: 'storefront.settings', entity: 'location', entityId: loc.id, principal, meta: actor.meta, at: now, details: { enabled: body.enabled, slug: candidate } });
      return row;
    });
    hubFor(deps.db).publish(principal.orgId);
    return settingsDto(updated);
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Такой адрес уже занят, выберите другой', undefined, 'slug_taken');
    throw err;
  }
}

function staffOffer(deps: Deps, row: OfferRow): StaffOfferDto {
  const percent = row.percent ?? 0;
  return {
    id: row.id,
    batchId: row.batch_id,
    locationId: row.location_id,
    locationName: row.location_name,
    productName: row.product_name,
    unit: row.unit,
    offered: Number(row.quantity),
    reserved: Number(row.reserved),
    sold: Number(row.sold),
    available: availableOf(row),
    price: priceWith(Number(row.price), percent),
    percent,
    expiresOn: row.expires_on,
    daysLeft: daysLeftOf(deps, row.expires_on),
    perGuestMax: row.per_guest_max,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
    hiddenReason: hiddenReason(deps, row),
  };
}

export async function listOffers(deps: Deps, principal: UserPrincipal, locationId?: string): Promise<StaffOfferDto[]> {
  if (locationId) assertLocation(principal, locationId);
  const allowed = locationFilter(principal);
  const ids = locationId ? [locationId] : allowed;
  const rows = await loadOffers(
    deps,
    sql`o.closed_at IS NULL AND l.org_id = ${principal.orgId}::uuid ${ids ? sql`AND o.location_id IN (${sql.join((ids.length ? ids : NO_ROWS).map((i) => sql`${i}::uuid`))})` : sql``}`,
  );
  return rows.map((r) => staffOffer(deps, r));
}

export async function createOffer(deps: Deps, actor: Actor, body: CreateOfferBody): Promise<StaffOfferDto> {
  const principal = actor.principal as UserPrincipal;
  const now = deps.clock();
  const batch = await deps.db
    .selectFrom('batches as b')
    .innerJoin('locations as l', 'l.id', 'b.location_id')
    .select(['b.id', 'b.location_id', 'b.remaining_qty', 'b.expires_on', 'l.storefront_enabled', 'l.org_id'])
    .where('b.id', '=', body.batchId)
    .where('l.org_id', '=', principal.orgId)
    .executeTakeFirst();
  if (!batch) throw notFound('Партия');
  assertLocation(principal, batch.location_id);
  if (!batch.storefront_enabled) throw conflict('Сначала включите витрину на этой точке', undefined, 'storefront_off');
  if (daysLeftOf(deps, batch.expires_on) < 0) throw conflict('Срок годности партии вышел, продавать её нельзя', undefined, 'expired');
  if (Number(batch.remaining_qty) <= 0) throw conflict('Партия закончилась', undefined, 'depleted');
  if (body.quantity > Number(batch.remaining_qty)) throw conflict(`В партии только ${Number(batch.remaining_qty)}`, undefined, 'too_much');
  const promo = await deps.db
    .selectFrom('promotions')
    .select('id')
    .where('batch_id', '=', body.batchId)
    .where('cancelled_at', 'is', null)
    .where('ends_on', '>=', businessToday(deps))
    .executeTakeFirst();
  if (!promo) throw conflict('На витрину попадают только уценённые партии: сначала назначьте скидку', undefined, 'no_promotion');

  try {
    const id = await deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('storefront_offers')
        .values({ batch_id: body.batchId, location_id: batch.location_id, quantity: body.quantity, per_guest_max: body.perGuestMax ?? 3, created_by: principal.id, created_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { action: 'storefront.offer', entity: 'storefront_offer', entityId: row.id, principal, meta: actor.meta, at: now, details: { batchId: body.batchId, quantity: body.quantity } });
      return row.id;
    });
    hubFor(deps.db).publish(principal.orgId);
    const rows = await loadOffers(deps, sql`o.id = ${id}::uuid`);
    return staffOffer(deps, rows[0] as OfferRow);
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) throw conflict('Эта партия уже выставлена на витрину', undefined, 'already_offered');
    throw err;
  }
}

export async function closeOffer(deps: Deps, actor: Actor, id: string): Promise<void> {
  const principal = actor.principal as UserPrincipal;
  const now = deps.clock();
  const offer = await deps.db
    .selectFrom('storefront_offers as o')
    .innerJoin('locations as l', 'l.id', 'o.location_id')
    .select(['o.id', 'o.location_id', 'o.closed_at'])
    .where('o.id', '=', id)
    .where('l.org_id', '=', principal.orgId)
    .executeTakeFirst();
  if (!offer) throw notFound('Предложение');
  assertLocation(principal, offer.location_id);
  if (offer.closed_at) return;
  await deps.db.transaction().execute(async (trx) => {
    await trx.updateTable('storefront_offers').set({ closed_at: now }).where('id', '=', id).execute();
    await writeAudit(trx, { action: 'storefront.offer_close', entity: 'storefront_offer', entityId: id, principal, meta: actor.meta, at: now, details: {} });
  });
  hubFor(deps.db).publish(principal.orgId);
}

interface ReservationRow {
  id: string;
  code: string;
  status: StaffReservationDto['status'];
  location_id: string;
  location_name: string;
  product_id: string;
  product_name: string;
  unit: string;
  price: string;
  percent: number | null;
  quantity: string;
  guest_name: string | null;
  guest_phone: string | null;
  created_at: Date;
  expires_at: Date;
  closed_at: Date | null;
  cancel_reason: string | null;
}

async function loadReservations(deps: Deps, principal: UserPrincipal, where: ReturnType<typeof sql>): Promise<ReservationRow[]> {
  const allowed = locationFilter(principal);
  const res = await sql<ReservationRow>`
    SELECT r.id, r.code, r.status, r.location_id, l.name AS location_name, p.id AS product_id, p.name AS product_name, p.unit, p.price,
           (SELECT pr.percent FROM promotions pr WHERE pr.batch_id = o.batch_id ORDER BY pr.created_at DESC LIMIT 1) AS percent,
           r.quantity, r.guest_name, r.guest_phone, r.created_at, r.expires_at, r.closed_at, r.cancel_reason
    FROM storefront_reservations r
    JOIN storefront_offers o ON o.id = r.offer_id
    JOIN batches b ON b.id = o.batch_id
    JOIN products p ON p.id = b.product_id
    JOIN locations l ON l.id = r.location_id
    WHERE l.org_id = ${principal.orgId}::uuid
      ${allowed ? sql`AND r.location_id IN (${sql.join((allowed.length ? allowed : NO_ROWS).map((i) => sql`${i}::uuid`))})` : sql``}
      AND ${where}
    ORDER BY (r.status = 'reserved') DESC, r.created_at DESC
    LIMIT 200`.execute(deps.db);
  return res.rows;
}

function reservationDto(deps: Deps, r: ReservationRow): StaffReservationDto {
  const expired = r.status === 'reserved' && r.expires_at.getTime() <= deps.clock().getTime();
  return {
    id: r.id,
    code: r.code,
    status: expired ? 'expired' : r.status,
    locationId: r.location_id,
    locationName: r.location_name,
    productName: r.product_name,
    unit: r.unit,
    quantity: Number(r.quantity),
    total: roundMoney(Number(r.quantity) * priceWith(Number(r.price), r.percent ?? 0)),
    guestName: r.guest_name,
    guestPhone: r.guest_phone,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    closedAt: r.closed_at?.toISOString() ?? null,
    cancelReason: r.cancel_reason,
  };
}

export async function listReservations(deps: Deps, principal: UserPrincipal, opts: { locationId?: string; code?: string }): Promise<StaffReservationDto[]> {
  if (opts.locationId) assertLocation(principal, opts.locationId);
  await expireReservations(deps);
  const rows = await loadReservations(
    deps,
    principal,
    sql`TRUE ${opts.locationId ? sql`AND r.location_id = ${opts.locationId}::uuid` : sql``} ${opts.code ? sql`AND r.code = ${opts.code.toUpperCase()}` : sql``}`,
  );
  return rows.map((r) => reservationDto(deps, r));
}

async function ownReservation(deps: Deps, principal: UserPrincipal, id: string): Promise<ReservationRow> {
  const rows = await loadReservations(deps, principal, sql`r.id = ${id}::uuid`);
  const row = rows[0];
  if (!row) throw notFound('Бронь');
  return row;
}

/** Гость пришёл и забрал: товар списывается обычной продажей, цена берётся из действующей уценки партии. */
export async function pickUp(deps: Deps, actor: Actor, id: string): Promise<StaffReservationDto> {
  const principal = actor.principal as UserPrincipal;
  const row = await ownReservation(deps, principal, id);
  assertLocation(principal, row.location_id);
  if (row.status === 'picked_up') return reservationDto(deps, row);
  if (row.status !== 'reserved') throw conflict('Бронь уже закрыта', undefined, 'reservation_closed');
  if (row.expires_at.getTime() <= deps.clock().getTime()) throw conflict('Время брони вышло: гостю нужно оформить новую', undefined, 'reservation_expired');

  const sale = await sell(deps, actor, { locationId: row.location_id, comment: `Витрина: бронь ${row.code}`, lines: [{ productId: row.product_id, quantity: Number(row.quantity) }] }, `storefront:${row.id}`);
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('storefront_reservations')
      .set({ status: 'picked_up', closed_at: now, closed_by: principal.id, document_id: sale.documentId })
      .where('id', '=', row.id)
      .where('status', '=', 'reserved')
      .execute();
    await writeAudit(trx, { action: 'storefront.pickup', entity: 'storefront_reservation', entityId: row.id, principal, meta: actor.meta, at: now, details: { code: row.code, documentId: sale.documentId } });
  });
  hubFor(deps.db).publish(principal.orgId);
  return reservationDto(deps, await ownReservation(deps, principal, id));
}

export async function cancelByStaff(deps: Deps, actor: Actor, id: string, reason?: string): Promise<StaffReservationDto> {
  const principal = actor.principal as UserPrincipal;
  const row = await ownReservation(deps, principal, id);
  assertLocation(principal, row.location_id);
  if (row.status !== 'reserved') throw conflict('Бронь уже закрыта', undefined, 'reservation_closed');
  const now = deps.clock();
  await deps.db.transaction().execute(async (trx) => {
    await trx.updateTable('storefront_reservations').set({ status: 'cancelled', closed_at: now, closed_by: principal.id, cancel_reason: reason ?? 'Отменил сотрудник' }).where('id', '=', id).where('status', '=', 'reserved').execute();
    await writeAudit(trx, { action: 'storefront.cancel', entity: 'storefront_reservation', entityId: id, principal, meta: actor.meta, at: now, details: { code: row.code } });
  });
  hubFor(deps.db).publish(principal.orgId);
  return reservationDto(deps, await ownReservation(deps, principal, id));
}

/** Закрывает просроченные брони и стирает имена и телефоны, которые больше не нужны. */
export async function purgeStorefront(deps: Deps): Promise<void> {
  await expireReservations(deps);
  const cutoff = new Date(deps.clock().getTime() - deps.config.storefront.retentionDays * 86_400_000);
  await deps.db
    .updateTable('storefront_reservations')
    .set({ guest_name: null, guest_phone: null })
    .where('created_at', '<', cutoff)
    .where('status', '<>', 'reserved')
    .where((eb) => eb.or([eb('guest_name', 'is not', null), eb('guest_phone', 'is not', null)]))
    .execute();
}

