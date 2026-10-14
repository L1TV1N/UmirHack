-- Вход администратора с подтверждением кодом из Telegram

ALTER TABLE users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN two_factor_enabled_at timestamptz;

-- Одноразовые коды: для входа, включения и выключения защиты, выпуска новых резервных кодов.
-- Сам код нигде не хранится, только его HMAC с привязкой к идентификатору запроса.
CREATE TABLE login_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('login', 'enable', 'disable', 'recovery')),
  code_hash    char(64) NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  sends        integer NOT NULL DEFAULT 1,
  -- код ушёл в чат: если Telegram недоступен, остаётся вход по резервному коду
  delivered    boolean NOT NULL DEFAULT true,
  ip           text,
  created_at   timestamptz NOT NULL,
  last_sent_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX login_challenges_user_idx ON login_challenges (user_id, created_at DESC);
CREATE INDEX login_challenges_expires_idx ON login_challenges (expires_at);

-- Резервные коды на случай, когда Telegram недоступен: каждый работает один раз
CREATE TABLE recovery_codes (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  used_at    timestamptz,
  PRIMARY KEY (user_id, code_hash)
);
