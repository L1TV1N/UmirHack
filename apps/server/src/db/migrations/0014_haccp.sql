-- Журнал контроля (HACCP): контрольные точки с допустимыми границами температуры, замеры, корректирующие действия
-- и бракераж входящей продукции. Записи журнала не переписываются: ошибку исправляют новой записью

CREATE TABLE haccp_points (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations (id),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('fridge', 'freezer', 'hot', 'other')),
  min_temp    numeric(5, 1) NOT NULL CHECK (min_temp BETWEEN -60 AND 300),
  max_temp    numeric(5, 1) NOT NULL CHECK (max_temp BETWEEN -60 AND 300),
  -- как часто нужен замер
  every_hours integer NOT NULL DEFAULT 4 CHECK (every_hours BETWEEN 1 AND 168),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL,
  CHECK (min_temp <= max_temp)
);
CREATE INDEX haccp_points_location_idx ON haccp_points (location_id) WHERE is_active;

CREATE TABLE haccp_readings (
  id          bigserial PRIMARY KEY,
  point_id    uuid NOT NULL REFERENCES haccp_points (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  measured_at timestamptz NOT NULL,
  value       numeric(5, 1) NOT NULL CHECK (value BETWEEN -80 AND 400),
  -- попадание в границы на момент замера: правка границ позже не меняет старые записи
  min_temp    numeric(5, 1) NOT NULL,
  max_temp    numeric(5, 1) NOT NULL,
  in_range    boolean NOT NULL,
  comment     text,
  created_by  uuid REFERENCES users (id),
  actor_name  text NOT NULL,
  created_at  timestamptz NOT NULL
);
CREATE INDEX haccp_readings_point_idx ON haccp_readings (point_id, measured_at DESC);
CREATE INDEX haccp_readings_location_idx ON haccp_readings (location_id, measured_at DESC);
CREATE INDEX haccp_readings_deviation_idx ON haccp_readings (location_id, measured_at DESC) WHERE NOT in_range;

-- Что сделали с отклонением: на один замер одно действие
CREATE TABLE haccp_actions (
  reading_id bigint PRIMARY KEY REFERENCES haccp_readings (id),
  action     text NOT NULL,
  created_by uuid REFERENCES users (id),
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL
);

-- Бракераж партии при приёмке
CREATE TABLE haccp_inspections (
  id            bigserial PRIMARY KEY,
  batch_id      uuid NOT NULL UNIQUE REFERENCES batches (id),
  location_id   uuid NOT NULL REFERENCES locations (id),
  temperature   numeric(5, 1) CHECK (temperature BETWEEN -80 AND 400),
  appearance_ok boolean NOT NULL,
  packaging_ok  boolean NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('accepted', 'rejected')),
  comment       text,
  created_by    uuid REFERENCES users (id),
  actor_name    text NOT NULL,
  created_at    timestamptz NOT NULL
);
CREATE INDEX haccp_inspections_location_idx ON haccp_inspections (location_id, created_at DESC);
