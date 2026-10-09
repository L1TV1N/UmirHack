-- Отпечаток тела запроса: повтор с тем же ключом, но другими данными, больше не принимается молча.
ALTER TABLE documents ADD COLUMN idempotency_hash char(64);

-- Очистка просроченных сессий идёт по сроку
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);
