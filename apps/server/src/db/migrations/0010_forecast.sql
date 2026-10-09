-- Координаты точки: по ним берётся прогноз погоды. Пара задаётся целиком или не задаётся вовсе
ALTER TABLE locations ADD COLUMN latitude numeric(8, 5) CHECK (latitude BETWEEN -90 AND 90);
ALTER TABLE locations ADD COLUMN longitude numeric(8, 5) CHECK (longitude BETWEEN -180 AND 180);
ALTER TABLE locations ADD CONSTRAINT locations_coordinates_pair CHECK ((latitude IS NULL) = (longitude IS NULL));

-- Погода по суткам: прошедшая и прогноз на ближайшие дни. Нужна и для обучения (как погода влияет на продажи), и для прогноза
CREATE TABLE weather_daily (
  location_id uuid NOT NULL REFERENCES locations (id),
  day         date NOT NULL,
  t_max       numeric(5, 2),
  t_min       numeric(5, 2),
  precip_mm   numeric(6, 2),
  is_forecast boolean NOT NULL DEFAULT false,
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (location_id, day)
);

-- Ручные исправления производственного календаря: перенос выходного, рабочая суббота, местный нерабочий день
CREATE TABLE calendar_days (
  day        date PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('off', 'work')),
  note       text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL
);

-- Поправка к скорости продаж на ближайшую неделю: рекомендации, стоп-лист и заказы читают её, а не считают модель каждый раз
CREATE TABLE demand_outlook (
  location_id uuid NOT NULL REFERENCES locations (id),
  product_id  uuid NOT NULL REFERENCES products (id),
  factor      numeric(6, 3) NOT NULL CHECK (factor > 0),
  computed_for date NOT NULL,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (location_id, product_id)
);
