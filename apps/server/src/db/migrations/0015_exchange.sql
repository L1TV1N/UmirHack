-- Обмен с учётными системами (1С, iiko) и подключение касс

-- Внешняя система, в которую выгружаются документы. Пароль хранится зашифрованным
CREATE TABLE external_systems (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('onec', 'iiko')),
  name        text NOT NULL,
  base_url    text NOT NULL,
  username    text,
  secret_enc  text,
  -- сопоставление объектов и полей: имена документов, табличных частей и реквизитов зависят от конфигурации
  profile     jsonb NOT NULL,
  doc_kinds   text[] NOT NULL CHECK (cardinality(doc_kinds) > 0),
  location_id uuid REFERENCES locations (id),
  enabled     boolean NOT NULL DEFAULT true,
  last_ok_at  timestamptz,
  last_error  text,
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- Какому объекту «Запаса» соответствует объект на той стороне. По этой связи повторная выгрузка обновляет документ, а не дублирует его
CREATE TABLE external_refs (
  system_id     uuid NOT NULL REFERENCES external_systems (id) ON DELETE CASCADE,
  entity        text NOT NULL CHECK (entity IN ('product', 'supplier', 'location', 'document')),
  local_id      uuid NOT NULL,
  remote_key    text NOT NULL,
  remote_number text,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (system_id, entity, local_id)
);
CREATE INDEX external_refs_remote_idx ON external_refs (system_id, entity, remote_key);

-- Очередь выгрузки: документ ждёт отправки, повторяется с нарастающей паузой, а если не хватает связей, ждёт, пока их укажут
CREATE TABLE exchange_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id       uuid NOT NULL REFERENCES external_systems (id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents (id),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'blocked', 'failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error      text,
  remote_key      text,
  remote_number   text,
  -- что нужно связать, чтобы документ ушёл: [{ entity, localId, name, code }]
  missing         jsonb,
  created_at      timestamptz NOT NULL,
  done_at         timestamptz,
  UNIQUE (system_id, document_id)
);
CREATE INDEX exchange_jobs_due_idx ON exchange_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX exchange_jobs_status_idx ON exchange_jobs (system_id, status, created_at DESC);

-- Кассы: чья это касса и по каким правилам разбирать её чеки
ALTER TABLE api_keys ADD COLUMN vendor text NOT NULL DEFAULT 'generic' CHECK (vendor IN ('generic', 'evotor', 'frontol', 'atol', 'iiko', 'sigma'));
ALTER TABLE api_keys ADD COLUMN rules jsonb;

-- Каждый принятый чек: что пришло, во что превратилось и почему не прошло
CREATE TABLE pos_inbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       uuid NOT NULL REFERENCES api_keys (id),
  location_id  uuid NOT NULL REFERENCES locations (id),
  external_id  text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sale', 'return')),
  status       text NOT NULL CHECK (status IN ('done', 'pending_match', 'rejected', 'return_logged')),
  lines        jsonb NOT NULL,
  unmatched    text[] NOT NULL DEFAULT '{}',
  error        text,
  document_id  uuid REFERENCES documents (id),
  received_at  timestamptz NOT NULL,
  processed_at timestamptz,
  UNIQUE (key_id, external_id)
);
CREATE INDEX pos_inbox_status_idx ON pos_inbox (status, received_at DESC);
CREATE INDEX pos_inbox_key_idx ON pos_inbox (key_id, received_at DESC);

-- Сопоставление кодов кассы с продуктами и блюдами «Запаса»: «ignore» значит, что позицию в учёте считать не нужно
CREATE TABLE pos_code_map (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id     uuid NOT NULL REFERENCES api_keys (id),
  ref        text NOT NULL,
  entity     text NOT NULL CHECK (entity IN ('product', 'dish', 'ignore')),
  entity_id  uuid,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  CHECK ((entity = 'ignore') = (entity_id IS NULL)),
  UNIQUE (key_id, ref)
);
