-- Приход, принятый по заказу поставщику. По первой такой поставке считается, вовремя ли поставщик привёз заказ
ALTER TABLE documents ADD COLUMN order_id uuid REFERENCES purchase_orders (id);
CREATE INDEX documents_order_idx ON documents (order_id) WHERE order_id IS NOT NULL;
