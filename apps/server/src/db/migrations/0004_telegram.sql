-- Привязка чата Telegram к пользователю: команды бота выполняются с правами этого пользователя.
-- Один пользователь это один чат и наоборот.
CREATE TABLE telegram_links (
  user_id   uuid PRIMARY KEY REFERENCES users (id),
  chat_id   bigint NOT NULL UNIQUE,
  username  text,
  linked_at timestamptz NOT NULL DEFAULT now()
);

-- Одноразовые коды привязки. Хранится только хэш, код живёт несколько минут и один раз.
CREATE TABLE telegram_link_codes (
  code_hash  text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id);
