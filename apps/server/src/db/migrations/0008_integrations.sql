-- Код блюда в кассовой системе (iiko, 1С): по нему касса и доставка узнают позицию стоп-листа
ALTER TABLE dishes ADD COLUMN code text;
CREATE UNIQUE INDEX dishes_code_key ON dishes (lower(code)) WHERE code IS NOT NULL;

-- Адреса, куда отправляются события. Секрет подписи хранится зашифрованным
CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  url             text NOT NULL,
  secret_enc      text NOT NULL,
  events          text[] NOT NULL CHECK (cardinality(events) > 0),
  location_id     uuid REFERENCES locations (id),
  enabled         boolean NOT NULL DEFAULT true,
  failure_streak  integer NOT NULL DEFAULT 0,
  disabled_reason text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by      uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- Очередь доставки: событие ждёт отправки, повторяется с нарастающей паузой и остаётся в журнале
CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_status     integer,
  last_error      text,
  created_at      timestamptz NOT NULL,
  delivered_at    timestamptz
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);

-- Какой стоп-лист по точке был отправлен в прошлый раз: разница с текущим и есть событие
CREATE TABLE stoplist_published (
  location_id  uuid PRIMARY KEY REFERENCES locations (id),
  entries      jsonb NOT NULL,
  published_at timestamptz NOT NULL
);
