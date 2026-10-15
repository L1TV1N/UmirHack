-- Заказы, принятые официантом без связи: ключ защищает от дубля при повторной отправке,
-- время хранит момент, когда заказ приняли на самом деле
ALTER TABLE guest_orders ADD COLUMN client_key text;
ALTER TABLE guest_orders ADD COLUMN placed_at timestamptz;
CREATE UNIQUE INDEX guest_orders_client_key_idx ON guest_orders (waiter_id, client_key) WHERE client_key IS NOT NULL;
