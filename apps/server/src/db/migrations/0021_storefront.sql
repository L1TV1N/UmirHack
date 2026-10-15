-- Витрина «Спаси продукты»: публичная страница с уценёнными партиями и бронь без оплаты.
-- Витрина включается на точке отдельно, по умолчанию выключена.
ALTER TABLE locations ADD COLUMN storefront_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE locations ADD COLUMN storefront_slug text;
ALTER TABLE locations ADD COLUMN storefront_note text;
CREATE UNIQUE INDEX locations_storefront_slug_key ON locations (storefront_slug) WHERE storefront_slug IS NOT NULL;

-- Что выставлено на витрину: партия с действующей уценкой и сколько из неё можно забронировать
CREATE TABLE storefront_offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid NOT NULL REFERENCES batches (id),
  location_id   uuid NOT NULL REFERENCES locations (id),
  quantity      numeric(14, 3) NOT NULL CHECK (quantity > 0),
  per_guest_max integer NOT NULL DEFAULT 3 CHECK (per_guest_max BETWEEN 1 AND 50),
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL,
  closed_at     timestamptz
);
CREATE UNIQUE INDEX storefront_offers_open_batch_key ON storefront_offers (batch_id) WHERE closed_at IS NULL;
CREATE INDEX storefront_offers_location_idx ON storefront_offers (location_id) WHERE closed_at IS NULL;

-- Брони гостей. Имя и телефон хранятся только пока бронь нужна, потом стираются (остаётся хэш телефона для лимитов).
CREATE TABLE storefront_reservations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    uuid NOT NULL REFERENCES storefront_offers (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  code        text NOT NULL,
  quantity    numeric(14, 3) NOT NULL CHECK (quantity > 0),
  guest_name  text,
  guest_phone text,
  phone_hash  char(64) NOT NULL,
  ip_hash     char(64),
  status      text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'picked_up', 'cancelled', 'expired')),
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  closed_at   timestamptz,
  closed_by   uuid REFERENCES users (id),
  document_id uuid REFERENCES documents (id),
  cancel_reason text
);
-- код однозначно определяет действующую бронь
CREATE UNIQUE INDEX storefront_reservations_code_key ON storefront_reservations (code) WHERE status = 'reserved';
CREATE INDEX storefront_reservations_offer_idx ON storefront_reservations (offer_id, status);
CREATE INDEX storefront_reservations_phone_idx ON storefront_reservations (phone_hash, status);
CREATE INDEX storefront_reservations_location_idx ON storefront_reservations (location_id, created_at DESC);
