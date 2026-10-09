-- Признаки, которые требуют учёта при приёмке: ветеринарный сопроводительный документ («Меркурий») и маркировка
ALTER TABLE products ADD COLUMN requires_vsd boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN requires_marking boolean NOT NULL DEFAULT false;

-- Коды маркировки («Честный знак»), принятые с партией. Один код можно принять только один раз.
CREATE TABLE batch_marks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   uuid NOT NULL REFERENCES batches (id),
  gtin       text NOT NULL,
  serial     text NOT NULL,
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_marks_unique UNIQUE (gtin, serial)
);
CREATE INDEX batch_marks_batch_idx ON batch_marks (batch_id);

-- Ветеринарные сопроводительные документы, принятые с партией. Погасить в «Меркурии» нужно в срок после приёмки.
CREATE TABLE vet_certificates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number      text NOT NULL,
  batch_id    uuid NOT NULL REFERENCES batches (id),
  product_id  uuid NOT NULL REFERENCES products (id),
  supplier_id uuid REFERENCES suppliers (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  quantity    numeric(14, 3) NOT NULL CHECK (quantity > 0),
  received_at timestamptz NOT NULL,
  due_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed')),
  redeemed_at timestamptz,
  redeemed_by uuid REFERENCES users (id),
  comment     text,
  CONSTRAINT vet_certificates_number_key UNIQUE (number),
  CONSTRAINT vet_certificates_redeemed_consistent CHECK ((status = 'redeemed') = (redeemed_at IS NOT NULL))
);
CREATE INDEX vet_certificates_status_idx ON vet_certificates (status, due_at);
CREATE INDEX vet_certificates_location_idx ON vet_certificates (location_id, status);
