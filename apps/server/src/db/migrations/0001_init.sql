-- Начальная схема. Журналы (stock_movements, audit_log) только на добавление.

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL,
  full_name           text NOT NULL,
  password_hash       text NOT NULL,
  role                text NOT NULL CHECK (role IN ('admin', 'manager', 'storekeeper', 'viewer')),
  is_active           boolean NOT NULL DEFAULT true,
  failed_attempts     integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('warehouse', 'kitchen', 'shop')),
  address    text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locations_code_key ON locations (lower(code));

CREATE TABLE user_locations (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_agent  text,
  ip          text
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  key_hash     char(64) NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  location_id  uuid NOT NULL REFERENCES locations (id),
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE categories (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE UNIQUE INDEX categories_name_key ON categories (lower(name));

CREATE TABLE suppliers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  phone     text,
  note      text,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (lower(name));

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL,
  barcode         text,
  name            text NOT NULL,
  category_id     uuid NOT NULL REFERENCES categories (id),
  unit            text NOT NULL CHECK (unit IN ('kg', 'l', 'pcs')),
  min_stock       numeric(14, 3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  shelf_life_days integer CHECK (shelf_life_days > 0),
  price           numeric(14, 2) NOT NULL CHECK (price >= 0),
  cost            numeric(14, 2) NOT NULL CHECK (cost >= 0),
  sellable        boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_key ON products (lower(sku));
CREATE UNIQUE INDEX products_barcode_key ON products (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE dishes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  price      numeric(14, 2) NOT NULL CHECK (price >= 0),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dishes_name_key ON dishes (lower(name));

CREATE TABLE dish_items (
  dish_id    uuid NOT NULL REFERENCES dishes (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  quantity   numeric(14, 3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (dish_id, product_id)
);
CREATE INDEX dish_items_product_idx ON dish_items (product_id);

CREATE SEQUENCE document_number_seq START 1;

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('receipt', 'sale', 'writeoff', 'transfer', 'inventory')),
  number            text NOT NULL UNIQUE,
  location_id       uuid NOT NULL REFERENCES locations (id),
  to_location_id    uuid REFERENCES locations (id),
  created_by        uuid REFERENCES users (id),
  actor_name        text NOT NULL,
  comment           text,
  idempotency_scope text,
  idempotency_key   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((idempotency_scope IS NULL) = (idempotency_key IS NULL))
);
CREATE UNIQUE INDEX documents_idempotency_key ON documents (idempotency_scope, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX documents_location_created_idx ON documents (location_id, created_at DESC);
CREATE INDEX documents_kind_created_idx ON documents (kind, created_at DESC);

CREATE TABLE batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id         uuid NOT NULL REFERENCES products (id),
  location_id        uuid NOT NULL REFERENCES locations (id),
  supplier_id        uuid REFERENCES suppliers (id),
  origin_document_id uuid REFERENCES documents (id),
  document_no        text,
  received_on        date NOT NULL,
  expires_on         date NOT NULL,
  initial_qty        numeric(14, 3) NOT NULL CHECK (initial_qty > 0),
  remaining_qty      numeric(14, 3) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost          numeric(14, 2) NOT NULL CHECK (unit_cost >= 0),
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining_qty <= initial_qty)
);
-- выбор партий по FEFO идёт только по строкам с остатком
CREATE INDEX batches_fefo_idx ON batches (product_id, location_id, expires_on, received_on, id)
  WHERE remaining_qty > 0;
CREATE INDEX batches_location_expiry_idx ON batches (location_id, expires_on) WHERE remaining_qty > 0;
CREATE INDEX batches_product_location_idx ON batches (product_id, location_id);

CREATE TABLE stock_movements (
  id          bigserial PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES documents (id),
  batch_id    uuid NOT NULL REFERENCES batches (id),
  product_id  uuid NOT NULL REFERENCES products (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  type        text NOT NULL CHECK (type IN
    ('receipt', 'sale', 'writeoff', 'adjustment_in', 'adjustment_out', 'transfer_in', 'transfer_out')),
  quantity    numeric(14, 3) NOT NULL,
  unit_cost   numeric(14, 2) NOT NULL CHECK (unit_cost >= 0),
  unit_price  numeric(14, 2) CHECK (unit_price >= 0),
  reason      text CHECK (reason IN ('expired', 'spoiled', 'damaged', 'shortage', 'other')),
  dish_id     uuid REFERENCES dishes (id),
  comment     text,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (type IN ('receipt', 'adjustment_in', 'transfer_in') AND quantity > 0)
    OR (type IN ('sale', 'writeoff', 'adjustment_out', 'transfer_out') AND quantity < 0)
  ),
  CHECK (type <> 'writeoff' OR reason IS NOT NULL)
);
CREATE INDEX stock_movements_scope_idx ON stock_movements (location_id, product_id, created_at DESC);
CREATE INDEX stock_movements_document_idx ON stock_movements (document_id);
CREATE INDEX stock_movements_batch_idx ON stock_movements (batch_id);
CREATE INDEX stock_movements_type_idx ON stock_movements (type, created_at DESC);
CREATE INDEX stock_movements_created_idx ON stock_movements (created_at DESC);

CREATE TABLE promotions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id     uuid NOT NULL REFERENCES batches (id),
  percent      smallint NOT NULL CHECK (percent BETWEEN 1 AND 90),
  ends_on      date NOT NULL,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE UNIQUE INDEX promotions_one_active_key ON promotions (batch_id) WHERE cancelled_at IS NULL;

CREATE TABLE inventories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES locations (id),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'committed', 'cancelled')),
  comment      text,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  document_id  uuid REFERENCES documents (id)
);
CREATE INDEX inventories_location_idx ON inventories (location_id, created_at DESC);
-- на точке одновременно одна открытая инвентаризация
CREATE UNIQUE INDEX inventories_one_draft_key ON inventories (location_id) WHERE status = 'draft';

CREATE TABLE inventory_lines (
  inventory_id       uuid NOT NULL REFERENCES inventories (id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES products (id),
  expected_qty       numeric(14, 3) NOT NULL CHECK (expected_qty >= 0),
  counted_qty        numeric(14, 3) CHECK (counted_qty >= 0),
  surplus_expires_on date,
  PRIMARY KEY (inventory_id, product_id)
);

CREATE TABLE stop_list_manual (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations (id),
  product_id  uuid REFERENCES products (id),
  dish_id     uuid REFERENCES dishes (id),
  reason      text NOT NULL,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  until       timestamptz,
  released_at timestamptz,
  released_by uuid REFERENCES users (id),
  CHECK ((product_id IS NOT NULL) <> (dish_id IS NOT NULL))
);
CREATE UNIQUE INDEX stop_list_manual_product_key ON stop_list_manual (location_id, product_id)
  WHERE released_at IS NULL AND product_id IS NOT NULL;
CREATE UNIQUE INDEX stop_list_manual_dish_key ON stop_list_manual (location_id, dish_id)
  WHERE released_at IS NULL AND dish_id IS NOT NULL;

CREATE TABLE stop_list_state (
  location_id uuid NOT NULL REFERENCES locations (id),
  entity_type text NOT NULL CHECK (entity_type IN ('product', 'dish')),
  entity_id   uuid NOT NULL,
  since       timestamptz NOT NULL DEFAULT now(),
  reasons     jsonb NOT NULL,
  PRIMARY KEY (location_id, entity_type, entity_id)
);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  user_email text,
  action     text NOT NULL,
  entity     text,
  entity_id  text,
  ip         text,
  user_agent text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  char(64) NOT NULL,
  hash       char(64) NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, at DESC);

CREATE TABLE notification_log (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,
  dedupe_key text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, dedupe_key)
);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Таблица % только для добавления записей', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_movements_immutable
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
