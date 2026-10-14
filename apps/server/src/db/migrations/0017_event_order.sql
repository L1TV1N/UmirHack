-- События заказов в одну секунду должны идти в том порядке, в каком произошли: порядок задаёт счётчик, а не случайный идентификатор
ALTER TABLE guest_order_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE purchase_order_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX guest_order_events_seq_idx ON guest_order_events (order_id, seq);
CREATE INDEX purchase_order_events_seq_idx ON purchase_order_events (order_id, seq);
