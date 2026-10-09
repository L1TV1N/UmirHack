-- ИНН поставщика: по нему накладная из ЭДО находит поставщика в справочнике
ALTER TABLE suppliers ADD COLUMN inn text;
CREATE UNIQUE INDEX suppliers_inn_key ON suppliers (inn) WHERE inn IS NOT NULL;

-- Как строки накладных поставщика соответствуют нашим продуктам: запоминается после первой приёмки
CREATE TABLE supplier_item_map (
  supplier_id uuid NOT NULL REFERENCES suppliers (id),
  item_key    text NOT NULL,
  product_id  uuid NOT NULL REFERENCES products (id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, item_key)
);
CREATE INDEX supplier_item_map_product_idx ON supplier_item_map (product_id);
