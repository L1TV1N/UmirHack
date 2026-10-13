-- Дефицит ингредиентов: сколько времени продукт на точке не давал приготовить блюдо или совсем закончился.
-- Эпизод открывается, когда продукт появляется в причинах стоп-листа, и закрывается, когда исчезает из них
CREATE TABLE shortage_episodes (
  id             bigserial PRIMARY KEY,
  location_id    uuid NOT NULL REFERENCES locations (id),
  product_id     uuid NOT NULL REFERENCES products (id),
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  -- наибольшее число блюд, которые одновременно не могли готовиться из-за этого продукта
  dishes_blocked integer NOT NULL DEFAULT 0 CHECK (dishes_blocked >= 0),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- у продукта на точке не бывает двух открытых эпизодов сразу
CREATE UNIQUE INDEX shortage_episodes_open_key ON shortage_episodes (location_id, product_id) WHERE ended_at IS NULL;
CREATE INDEX shortage_episodes_started_idx ON shortage_episodes (started_at);

-- Заказы, которые система отклонила из-за нехватки ингредиентов
CREATE TABLE sale_refusals (
  id          bigserial PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES locations (id),
  created_at  timestamptz NOT NULL,
  -- сумма отклонённого заказа по ценам продажи: оценка упущенной выручки
  order_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (order_total >= 0),
  -- продукты, которых не хватило
  missing     uuid[] NOT NULL,
  source      text NOT NULL CHECK (source IN ('user', 'pos'))
);
CREATE INDEX sale_refusals_created_idx ON sale_refusals (created_at);

-- Позиции, которые уже в стопе на момент обновления: считаем эпизоды открытыми с того же времени
INSERT INTO shortage_episodes (location_id, product_id, started_at, dishes_blocked)
SELECT location_id, product_id, min(since), count(DISTINCT dish_id)
FROM (
  SELECT s.location_id, s.entity_id AS product_id, s.since, NULL::uuid AS dish_id
  FROM stop_list_state s
  WHERE s.entity_type = 'product'
  UNION ALL
  SELECT s.location_id, (m ->> 'productId')::uuid, s.since, s.entity_id
  FROM stop_list_state s
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.reasons -> 0 -> 'missing', '[]'::jsonb)) AS m
  WHERE s.entity_type = 'dish'
) x
GROUP BY location_id, product_id;
