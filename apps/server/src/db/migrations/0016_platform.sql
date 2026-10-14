-- Много организаций, официанты с заказами гостей, статусы заказов поставщикам и связь с кабинетом поставщика.

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Организация по умолчанию: в неё попадают все прежние данные и всё, что создано без явного указания организации
INSERT INTO organizations (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Ресторанная группа «Набережная»');

ALTER TABLE users ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'manager', 'storekeeper', 'viewer', 'waiter'));
CREATE INDEX users_org_idx ON users (org_id);

ALTER TABLE locations ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
ALTER TABLE locations DROP CONSTRAINT locations_kind_check;
ALTER TABLE locations ADD CONSTRAINT locations_kind_check CHECK (kind IN ('warehouse', 'kitchen', 'shop', 'cafe', 'bar'));
DROP INDEX locations_code_key;
CREATE UNIQUE INDEX locations_code_key ON locations (org_id, lower(code));
CREATE INDEX locations_org_idx ON locations (org_id);

-- Справочники у каждой организации свои: артикулы, штрихкоды и названия уникальны внутри организации
ALTER TABLE categories ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
DROP INDEX categories_name_key;
CREATE UNIQUE INDEX categories_name_key ON categories (org_id, lower(name));

ALTER TABLE suppliers ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
DROP INDEX suppliers_name_key;
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (org_id, lower(name));
DROP INDEX suppliers_inn_key;
CREATE UNIQUE INDEX suppliers_inn_key ON suppliers (org_id, inn) WHERE inn IS NOT NULL;

ALTER TABLE products ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
DROP INDEX products_sku_key;
CREATE UNIQUE INDEX products_sku_key ON products (org_id, lower(sku));
DROP INDEX products_barcode_key;
CREATE UNIQUE INDEX products_barcode_key ON products (org_id, barcode) WHERE barcode IS NOT NULL;

ALTER TABLE dishes ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
DROP INDEX dishes_name_key;
CREATE UNIQUE INDEX dishes_name_key ON dishes (org_id, lower(name));
DROP INDEX dishes_code_key;
CREATE UNIQUE INDEX dishes_code_key ON dishes (org_id, lower(code)) WHERE code IS NOT NULL;

ALTER TABLE webhook_endpoints ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);
ALTER TABLE external_systems ADD COLUMN org_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations (id);

-- Журнал аудита по организациям: колонка не входит в контрольную сумму, цепочка остаётся общей
-- Прежние записи (триггер запрещает их менять) получают организацию по умолчанию через значение колонки по умолчанию,
-- новые пишут организацию явно или оставляют пустой
ALTER TABLE audit_log ADD COLUMN org_id uuid DEFAULT '00000000-0000-4000-8000-000000000001';
CREATE INDEX audit_log_org_idx ON audit_log (org_id, id DESC);

-- Заказы поставщикам: новые статусы и связь с кабинетом поставщика
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft', 'sent', 'confirmed', 'shipped', 'partial', 'received', 'declined', 'refused', 'cancelled'));
ALTER TABLE purchase_orders ADD COLUMN delivery_on date;
ALTER TABLE purchase_orders ADD COLUMN supplier_note text;
ALTER TABLE purchase_orders ADD COLUMN buyer_note text;
ALTER TABLE purchase_orders ADD COLUMN portal_pushed_at timestamptz;
ALTER TABLE purchase_orders ADD COLUMN portal_error text;

CREATE TABLE purchase_order_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  -- кто сделал: покупатель или кабинет поставщика
  side       text NOT NULL CHECK (side IN ('buyer', 'supplier')),
  status     text NOT NULL,
  text       text NOT NULL,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX purchase_order_events_order_idx ON purchase_order_events (order_id, created_at);

-- Заказы гостей
CREATE SEQUENCE guest_order_seq START 1;

CREATE TABLE guest_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  location_id  uuid NOT NULL REFERENCES locations (id),
  table_label  text NOT NULL,
  waiter_id    uuid NOT NULL REFERENCES users (id),
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'served', 'cancelled')),
  comment      text,
  -- документ продажи, по которому ушли продукты, когда заказ взяли в работу
  document_id  uuid REFERENCES documents (id),
  cancel_reason text,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  served_at    timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX guest_orders_location_idx ON guest_orders (location_id, status, created_at DESC);
CREATE INDEX guest_orders_waiter_idx ON guest_orders (waiter_id, created_at DESC);

CREATE TABLE guest_order_lines (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id  uuid NOT NULL REFERENCES guest_orders (id) ON DELETE CASCADE,
  dish_id   uuid NOT NULL REFERENCES dishes (id),
  quantity  integer NOT NULL CHECK (quantity > 0),
  -- цена на момент заказа: меню потом может поменяться
  price     numeric(14, 2) NOT NULL CHECK (price >= 0),
  note      text,
  is_remake boolean NOT NULL DEFAULT false
);
CREATE INDEX guest_order_lines_order_idx ON guest_order_lines (order_id);

CREATE TABLE guest_order_incidents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES guest_orders (id) ON DELETE CASCADE,
  line_id             uuid REFERENCES guest_order_lines (id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('dropped', 'wrong_dish', 'complaint', 'kitchen_defect', 'other')),
  blame               text NOT NULL CHECK (blame IN ('waiter', 'kitchen', 'guest', 'venue')),
  comment             text NOT NULL,
  status              text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported', 'remade', 'dismissed')),
  reported_by         uuid NOT NULL REFERENCES users (id),
  reported_at         timestamptz NOT NULL,
  resolved_by         uuid REFERENCES users (id),
  resolved_at         timestamptz,
  resolution_comment  text,
  writeoff_document_id uuid REFERENCES documents (id),
  loss_cost           numeric(14, 2)
);
CREATE INDEX guest_order_incidents_order_idx ON guest_order_incidents (order_id);
CREATE INDEX guest_order_incidents_open_idx ON guest_order_incidents (status) WHERE status = 'reported';

CREATE TABLE guest_order_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES guest_orders (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  text       text NOT NULL,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX guest_order_events_order_idx ON guest_order_events (order_id, created_at);
