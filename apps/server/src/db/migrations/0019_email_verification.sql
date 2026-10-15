-- Подтверждение почты. Прежние пользователи и созданные администратором считаются подтверждёнными:
-- у таких записей колонка заполняется по умолчанию. Новая организация без подтверждения получает NULL.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz DEFAULT now();

CREATE TABLE email_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash    char(64) NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL,
  last_sent_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX email_codes_user_idx ON email_codes (user_id, created_at DESC);
