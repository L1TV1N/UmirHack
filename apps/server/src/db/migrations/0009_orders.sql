-- Условия поставщика для заказов: куда писать, за сколько дней привозит, с какой суммы принимает заказ
ALTER TABLE suppliers ADD COLUMN email text;
ALTER TABLE suppliers ADD COLUMN lead_time_days integer NOT NULL DEFAULT 1 CHECK (lead_time_days BETWEEN 0 AND 30);
ALTER TABLE suppliers ADD COLUMN min_order_sum numeric(14, 2) NOT NULL DEFAULT 0 CHECK (min_order_sum >= 0);
ALTER TABLE suppliers ADD COLUMN auto_order boolean NOT NULL DEFAULT false;

-- У продукта: у кого заказываем по умолчанию и кратность заказа (фасовка, ящик)
ALTER TABLE products ADD COLUMN default_supplier_id uuid REFERENCES suppliers (id);
ALTER TABLE products ADD COLUMN pack_size numeric(14, 3) NOT NULL DEFAULT 1 CHECK (pack_size > 0);
CREATE INDEX products_default_supplier_idx ON products (default_supplier_id) WHERE default_supplier_id IS NOT NULL;

CREATE SEQUENCE purchase_order_seq START 1;

-- Заказ поставщику на точку: черновик, отправлен, принят целиком или частично, отменён
CREATE TABLE purchase_orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  supplier_id  uuid NOT NULL REFERENCES suppliers (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'partial', 'received', 'cancelled')),
  expected_on  date,
  comment      text,
  total        numeric(14, 2) NOT NULL DEFAULT 0,
  -- пусто у черновика, который собрала система
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  sent_at      timestamptz,
  sent_by      uuid REFERENCES users (id),
  closed_at    timestamptz,
  emailed_at   timestamptz,
  email_error  text
);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status, created_at DESC);
CREATE INDEX purchase_orders_location_idx ON purchase_orders (location_id, status);
-- на одного поставщика и точку не больше одного черновика: повторное «создать» открывает прежний
CREATE UNIQUE INDEX purchase_orders_one_draft_key ON purchase_orders (supplier_id, location_id) WHERE status = 'draft';

CREATE TABLE purchase_order_lines (
  order_id     uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products (id),
  quantity     numeric(14, 3) NOT NULL CHECK (quantity > 0),
  unit_cost    numeric(14, 2) NOT NULL CHECK (unit_cost >= 0),
  received_qty numeric(14, 3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX purchase_order_lines_product_idx ON purchase_order_lines (product_id);
