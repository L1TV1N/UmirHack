# API

Все адреса начинаются с `/api`, обмен в JSON. Схемы тел запросов находятся в `packages/shared/src/schemas.ts` и являются единственным источником правды: по ним проверяет и сервер, и формы интерфейса. В режиме разработки (`ENABLE_DOCS=true`, не в production) описание в формате OpenAPI отдаётся на `/api/docs/openapi.json`.

## Общие правила

**Авторизация.** Заголовок `Authorization: Bearer <токен доступа>`. Токен выдаёт `POST /auth/login`, живёт 15 минут. Обновление идёт по cookie `zapas_rt` (`POST /auth/refresh`). Касса вместо этого шлёт `X-Api-Key`.

**Ошибки** приходят в одном виде:

```json
{
  "error": {
    "code": "insufficient_stock",
    "message": "Недостаточно остатка",
    "details": [{ "productId": "…", "name": "Творог 5%", "unit": "kg", "requested": 3, "available": 2 }]
  },
  "requestId": "0b6a…"
}
```

Во всех текстовых полях недопустимы нулевой байт, управляющие и невидимые символы, символы смены направления письма (ответ 400 `validation_error`). Штучные товары принимаются только целым количеством.

`details` бывает у ошибок проверки (`validation_error`: список `{ path, message }`) и у нехватки остатка. Коды HTTP: 400 неверный запрос, 401 нет или истёк вход, 403 не хватает прав, 404 не найдено или чужая точка, 409 конфликт (дубликат, закрытая инвентаризация), 422 бизнес-правило не позволяет, 429 слишком много запросов, 503 база перегружена или недоступна (с заголовком `Retry-After`, запрос можно повторить).

**Списки** принимают `limit` (до 200) и `offset`, отвечают `{ items, total, limit, offset }`.

**Количества и деньги** передаются числами: количества до трёх знаков, деньги до двух. Даты без времени это `YYYY-MM-DD`, моменты времени в ISO 8601.

**Заголовки кеша.** Ответы, в которых участвовал серверный кеш расчётов, содержат `X-Cache: HIT | MISS | JOINED | STALE` и `Server-Timing: cache;desc="…";dur=…`. Остальные ответы идут с `Cache-Control: no-store`. Подробнее: [CACHING.md](CACHING.md).

**Идемпотентность.** Операции, создающие документы, принимают заголовок `Idempotency-Key` (8–128 символов: буквы, цифры, `. _ : -`). Повтор с тем же ключом от того же пользователя возвращает уже созданный документ со статусом 200 и `"duplicate": true`, остатки второй раз не меняются. Тот же ключ с другим телом запроса это ошибка 422 с кодом `idempotency_conflict`: ключ нужно сменить, а не повторять.

## Вход

```http
POST /api/auth/login
{ "email": "manager@zapas.local", "password": "…" }
```

Ответ: `{ "accessToken": "…", "expiresIn": 900, "user": { … } }`, плюс cookie обновления. Неверный пароль, неизвестный адрес и блокировка дают одинаковый ответ 401 `invalid_credentials`.

**Подтверждение входа администратора.** Если у администратора включено подтверждение, после верного пароля вместо сессии приходит запрос кода, токена и cookie в нём нет:

```json
{ "twoFactorRequired": true, "challengeId": "…", "delivered": true, "expiresIn": 300, "resendAfter": 30 }
```

`delivered: false` значит, что код в Telegram отправить не удалось: остаётся резервный код. Вход завершает `POST /auth/2fa/verify` с телом `{ "challengeId", "code" }`, код шесть цифр из Telegram или резервный (регистр, пробелы и дефис не важны). Ответ как у входа: токен и cookie. Ошибки 401: `invalid_code` (в сообщении остаток попыток), `invalid_challenge` (запрос устарел, закрыт или запись заблокирована), `challenge_exhausted` (пять неверных кодов). `POST /auth/2fa/resend` с `{ "challengeId" }` отправляет код ещё раз: 429 `resend_too_soon` раньше, чем через 30 секунд, 429 `resend_limit` после трёх отправок.

| Метод и адрес | Назначение |
|---|---|
| `POST /auth/refresh` | новый токен по cookie, cookie ротируется |
| `POST /auth/logout` | закрыть сессию |
| `GET /auth/me` | текущий пользователь |
| `POST /auth/register` | `{ organizationName, fullName, email, password }`: новая организация и её администратор, сразу открывает сессию (201). 409 `duplicate_email` |
| `GET /auth/2fa` | любой вошедший: `{ eligible, botConfigured, telegramLinked, enabled, enabledAt, recoveryCodesLeft }` |
| `POST /auth/2fa/start` | администратор: `{ purpose: enable \| disable \| recovery, password? }`, код уходит в Telegram, ответ `{ challengeId, delivered, expiresIn, resendAfter }`. Для `disable` и `recovery` нужен пароль. 409 `telegram_not_linked`, `telegram_not_configured`, `already_enabled`, `not_enabled`; 502 `telegram_unavailable` (включить нельзя, пока код не доставляется) |
| `POST /auth/2fa/confirm` | администратор: `{ challengeId, code }`. Для `enable` и `recovery` в ответе `recoveryCodes` (восемь кодов, показываются один раз), для `disable` `{ enabled: false }` |
| `POST /auth/change-password` | смена пароля, закрывает все сессии. Пока не сменён временный пароль, сервер отвечает 403 `password_change_required` на всё, кроме `/auth/me` и этого адреса |

## Операции

Все создают документ и возвращают `{ "documentId", "number", "duplicate" }`.

```http
POST /api/documents/receipts
Idempotency-Key: web-7d1c…
{
  "locationId": "…",
  "supplierId": "…",
  "documentNo": "УПД-118",
  "lines": [{ "productId": "…", "quantity": 24.5, "unitCost": 61.9, "expiresOn": "2026-10-15" }]
}
```

Срок годности строки задаётся одним из трёх способов: датой `expiresOn`, сроком хранения в днях `shelfLifeDays` (дата считается от дня приёмки) или не задаётся вовсе, тогда берётся срок хранения из карточки продукта. Дата и срок хранения вместе не принимаются (400). Если срока нет нигде, 400 `shelf_life_required`.

```http
POST /api/documents/sales
{ "locationId": "…", "lines": [{ "productId": "…", "quantity": 2 }, { "dishId": "…", "quantity": 1 }] }
```

Продажа не берёт просроченное и расходует партии с ближайшим сроком. Если остатка не хватает, документ отклоняется целиком (422 `insufficient_stock`).

```http
POST /api/documents/writeoffs
{ "locationId": "…", "reason": "spoiled", "lines": [{ "productId": "…", "batchId": "…", "quantity": 1.2 }] }

POST /api/documents/writeoffs/expired
{ "locationId": "…" }

POST /api/documents/transfers
{ "fromLocationId": "…", "toLocationId": "…", "lines": [{ "productId": "…", "quantity": 5 }] }
```

Причины списания: `expired`, `spoiled`, `damaged`, `shortage`, `other`.

## Касса

```http
POST /api/pos/sales
X-Api-Key: zk_…
{ "externalId": "чек-2026-10-08-0001", "lines": [{ "productId": "…", "quantity": 2 }] }
```

Точка берётся из ключа. `externalId` служит ключом идемпотентности.

### Приём чеков кассы

`POST /api/pos/ingest` с ключом кассы принимает чек в формате кассы (JSON, XML, CSV; тело и `Content-Type` как у кассы). Правила разбора берутся из подключения (пресет вендора или свои). Ответ всегда 200, если чек понят: `{ results: [{ externalId, kind: sale|return, status, duplicate, documentNumber, unmatched, error }] }`, где `status` это `done`, `pending_match` (есть неизвестная позиция), `rejected` (например, нехватка остатка) или `return_logged`. Нечитаемое тело даёт 400 `pos_unreadable` с объяснением, что не нашли. `?dryRun=1` разбирает чек, ничего не записывая.

Менеджер и выше: `GET /pos/connections`, `GET /pos/presets`, `POST /pos/connections/:id/preview { payload }` (проверка образца), `GET /pos/inbox?keyId&status&limit`, `GET /pos/unmatched`, `PUT /pos/map { keyId, ref, entity: product|dish|ignore, entityId? }` (сопоставление, ждавшие чеки обрабатываются сразу, ответ `{ replayed }`), `POST /pos/inbox/:id/retry`. Администратор: `POST /pos/connections { name, locationId, vendor, rules? }` → 201 с `key` (показывается один раз), `PATCH /pos/connections/:id`; отключение ключа `DELETE /api-keys/:id`.

Ленты кассы: `GET /pos/stop-list`, `GET /pos/stop-list/iiko` (вид, близкий к iikoCloud), `GET /pos/products`.

## Остатки и учёт

| Метод и адрес | Назначение |
|---|---|
| `GET /stock/summary` | остатки по позициям и точкам: доступно, просрочено, ближайший срок, ниже минимума |
| `GET /stock/batches` | партии, фильтр `status`: `active`, `expiring`, `expired`, `depleted` |
| `GET /stock/batches/:id` | одна партия |
| `GET /stock/movements` | журнал движений с фильтрами по точке, продукту, типу, датам |
| `GET /documents`, `GET /documents/:id` | журнал документов и состав документа |

Во всех выборках можно передать `locationId`. Без него возвращаются все точки, доступные пользователю.

## Инвентаризация

| Метод и адрес | Назначение |
|---|---|
| `POST /inventories` | начать на точке, фиксирует ожидаемые остатки |
| `GET /inventories`, `GET /inventories/:id` | список и карточка со строками |
| `PUT /inventories/:id/lines` | внести фактические количества, для излишка указать `surplusExpiresOn` |
| `POST /inventories/:id/commit` | провести (менеджер): недостача списывается по срокам, излишек становится партией |
| `POST /inventories/:id/cancel` | отменить черновик |

Проведение сравнивает факт с текущим остатком, а не со снимком на момент начала, поэтому операции, прошедшие во время пересчёта, не искажают результат.

## Стоп-лист, акции, аналитика

| Метод и адрес | Назначение |
|---|---|
| `GET /stop-list` | позиции в стопе с причинами и временем начала, плюс предупреждения о малом числе порций |
| `POST /stop-list/manual`, `DELETE /stop-list/manual/:id` | поставить и снять вручную (менеджер) |
| `GET /promotions`, `POST /promotions`, `DELETE /promotions/:id` | скидка на партию 1–90% до конца срока (менеджер) |
| `GET /analytics/dashboard` | показатели панели, остатки по срокам, списания за 30 дней, главные риски |
| `GET /analytics/recommendations` | `{ items, counts, total }`: рекомендации с действиями (до 500 самых приоритетных), счётчики по типам, общий итог. Фильтры `type` и `locationId` |
| `GET /analytics/forecast/:productId?locationId=…` | скорость расхода, расход по дням, риск по партиям |
| `GET /analytics/rescued` | сколько выручили с товара, проданного по скидке до конца срока, за `days` суток (1–90): выручка, себестоимость, сколько стоила скидка, число партий и товары. Фильтр `locationId` |
| `GET /analytics/suppliers` | рейтинг поставщиков за `days` суток (7–365, по умолчанию 90), менеджер и выше: оценка 0–100 и класс A/B/C, выполнение заказов, доля вовремя, свежесть при приёмке, потери по причинам, а также общие потери по причинам. Фильтр `locationId` |
| `GET /stop-list/forecast` | прогноз стоп-листа: блюда кухонь, которые перестанут готовиться в ближайшие 7 суток при текущих продажах и без новых поставок. Для каждого `expectedAt`, `hoursLeft`, `cause` (`depletion` или `expiry`) и ограничивающий ингредиент. Фильтр `locationId` |
| `GET /analytics/shortages` | дефицитные ингредиенты за `days` суток (1–90, по умолчанию 30): часы без остатка, число остановок, остановленные блюда, отклонённые заказы и их сумма. Фильтр `locationId` |
| `GET /haccp/summary`, `GET /haccp/points` | сводка (точек, просроченных замеров, открытых отклонений) и контрольные точки с последним замером, сроком следующего и числом отклонений без действия. Менеджер видит и отключённые точки |
| `POST /haccp/points`, `PATCH /haccp/points/:id` | менеджер: завести точку (`name`, `kind`, `minTemp`, `maxTemp`, `everyHours`) и изменить границы, частоту, отключить |
| `POST /haccp/readings` | кладовщик и выше: замер `{ pointId, value, comment?, action? }`. Вне границ это отклонение, оно сообщается в Telegram и остаётся открытым, пока не записано `action` |
| `POST /haccp/readings/:id/action` | записать, что сделали с отклонением (`{ action }`), 409 `action_exists`, `not_a_deviation` |
| `GET /haccp/readings` | журнал замеров. Фильтры `locationId`, `pointId`, `from`, `to`, `deviations=true`, `limit`, `offset`. Границы в записи это те, что действовали на момент замера |
| `GET /haccp/inspections/pending`, `GET /haccp/inspections`, `POST /haccp/inspections` | бракераж: партии, ждущие осмотра (скоропорт и продукция с ВСД за три дня), журнал и запись осмотра `{ batchId, temperature?, appearanceOk, packagingOk, decision: accepted или rejected, comment? }`. Отказ сообщается в Telegram. 409 `already_inspected` |
| `GET /reports/haccp.csv` | менеджер: журнал замеров за период для проверяющих |
| `GET /events` | поток Server-Sent Events: событие `ready` при подключении и `changed`, когда данные изменились (без тела). Токен в заголовке `Authorization`, до пяти потоков на пользователя (429 `too_many_streams`), поток закрывается сервером через ~14 минут |
| `GET /analytics/hot-dishes` | `{ asOf, locationId, items }`: горячие предложения, блюда кухонь по убыванию приоритета (до 30) с причинами по ингредиентам. Фильтр `locationId`. Первые пять также приходят в `hotDishes` ответа панели |

## Приход по накладной

| Метод и адрес | Роль |
|---|---|
| `GET /invoices/capabilities` | кладовщик и выше: `{ upd: true, photo: bool }`, подключено ли распознавание фото |
| `POST /invoices/parse` | кладовщик и выше: `{ format: "upd", content: <base64 XML, до 3 МБ> }` → накладная `InvoiceDto` (поставщик, строки с найденными продуктами и подсказками, предупреждения, признак повтора). Ничего не создаёт |
| `POST /invoices/parse-photo` | кладовщик и выше: `{ mediaType, image: <base64, до 5 МБ> }` → тот же `InvoiceDto`. 409 `invoice_photo_disabled`, если ключ не задан; 502 `invoice_reader_failed` при сбое сервиса |
| `PUT /suppliers/:id/item-map` | кладовщик и выше: `{ items: [{ key, productId }] }`, запоминает соответствие строк накладной поставщика продуктам |

Приход создаёт обычный `POST /documents/receipts`: клиент подставляет в него строки из разобранной накладной.

## Организации и официанты

У каждого пользователя есть организация. Заведения, справочники, настройки, пользователи, ключи касс, вебхуки, системы обмена и журнал аудита видны только внутри неё: чужая запись это 404. Администратор и менеджер видят все заведения организации, остальные назначенные.

| Метод и адрес | Что делает |
|---|---|
| `POST /users` | администратор: `{ email, fullName, role, locationIds, password? }`. Роли: `admin`, `manager`, `storekeeper`, `viewer`, `waiter`. Без `password` создаётся временный: ответ `CreatedUserDto` с `temporaryPassword` (виден только здесь), у пользователя `mustChangePassword: true` |
| `POST /locations` | администратор: `{ code, name, kind, address? }`, `kind`: `warehouse`, `kitchen`, `shop`, `cafe`, `bar`. Заведение попадает в организацию автора |
| `GET /waiter/menu?locationId` | меню заведения: блюда с ингредиентами, `stopped`, короткой причиной `stopNote` без количеств, пометкой `hot` |
| `GET /waiter/hot-dishes?locationId` | только блюдо, цена, сколько порций предложить, приоритет |
| `GET /waiter/stop-list?locationId` | что нельзя заказать и почему одной строкой |
| `POST /guest-orders` | официант, менеджер, администратор: `{ locationId, tableLabel, comment?, lines: [{ dishId, quantity, note? }] }` → 201. 409 `dish_stopped`, 422 `not_a_kitchen`, 404 для чужого заведения |
| `GET /guest-orders?locationId&status&mine` | `status`: `new`, `in_progress`, `served`, `cancelled`, `open`, `all`. Официант видит только свои |
| `GET /guest-orders/summary` | `{ open, incidents }` для счётчика в меню |
| `GET /guest-orders/:id` | заказ со строками, обращениями и историей |
| `POST /guest-orders/:id/status` | `{ status: in_progress \| served \| cancelled, comment? }`. Менеджер и администратор двигают заказ; `in_progress` списывает продукты по рецептуре (документ продажи), при нехватке заказ остаётся принятым; официант может только отменить свой заказ со статусом `new`, причина обязательна |
| `POST /guest-orders/:id/incidents` | `{ lineId?, kind, blame, comment }`: обращение по заказу, который готовят или выдан. `kind`: `dropped`, `wrong_dish`, `complaint`, `kitchen_defect`, `other`; `blame`: `waiter`, `kitchen`, `guest`, `venue` |
| `POST /guest-orders/incidents/:id/resolve` | менеджер: `{ action: remake \| dismiss, lineId?, comment? }`. `remake` добавляет блюдо без оплаты и списывает продукты как бой (документ списания, потеря в `lossCost`); 400 `incident_line_required`, если позиция не указана и блюд несколько |

Официанту закрыты все остальные маршруты учёта: для них нужна роль не ниже наблюдателя (403).

## Кабинет поставщика

Запросы между «Запасом» и кабинетом подписаны: заголовки `x-zapas-timestamp` (секунды) и `x-zapas-signature` (HMAC-SHA256 от `время.содержимое`, содержимое в каноничном JSON), общий секрет `SUPPLIER_PORTAL_SECRET`, допустимый разброс времени 5 минут. Без верной подписи 401 `bad_signature`.

| Метод и адрес | Что делает |
|---|---|
| `POST /supplier-gateway/status` | от кабинета: `{ externalId, status: confirmed \| declined \| shipped, note?, deliveryOn? }`. Допустимы переходы `sent` → любой, `confirmed` → `shipped` или `declined`; повтор того же статуса безвреден, обратный ход 409 `bad_transition` |
| `POST /supplier-gateway/lookup` | от кабинета: `{ inn }` → `{ known, name, buyers }` |
| `GET /supplier-gateway/orders/:id` | от кабинета: текущее состояние заказа в виде `PortalOrderPush` |
| `GET /supplier-portal/link` | открытый адрес: `{ url }` кабинета поставщика для кнопки на экране входа, `null`, если кабинет не подключён |
| `POST /orders/:id/decision` | менеджер: `{ decision: refuse \| remark, comment }`: отказ от поставки (статус `refused`) или замечание по приёмке; оба уходят в кабинет |

Заказ поставщику получил статусы `confirmed`, `shipped`, `declined`, `refused` и поля `deliveryOn`, `supplierNote`, `buyerNote`, `portalPushedAt`, `portalError`, историю `events`. Кабинет принимает заказ на `POST {SUPPLIER_PORTAL_URL}/api/gateway/orders`.

## Заказы поставщикам

Чтение заказов доступно кладовщику и выше по его точкам (нужно для приёма по заказу), всё остальное менеджеру и выше. Чужая точка это 404.

| Метод и адрес | Что делает |
|---|---|
| `GET /orders/suggestions?locationId&supplierId` | менеджер: что заказать, `OrderSuggestionDto[]` (поставщик, точка, строки с количеством, ценой, остатком, «в пути», причиной, сумма, `belowMinimum`, `draftId`) |
| `GET /orders?status&locationId&supplierId&limit&offset` | страница заказов; `status`: `draft`, `sent`, `partial`, `received`, `cancelled`, `open` (отправленные и принятые частично) или `all` |
| `GET /orders/:id` | `OrderDetailDto`: заказ со строками (`items`, у каждой `receivedQty`) и готовым текстом `text` |
| `POST /orders` | `{ supplierId, locationId, expectedOn?, comment?, lines: [{ productId, quantity, unitCost }] }` → 201, черновик. 409 `draft_exists` с `details.orderId`, если на эту пару уже есть черновик |
| `POST /orders/from-suggestion` | `{ supplierId, locationId, expectedOn? }`: черновик из расчёта, количества считает сервер. 409 `nothing_to_order`, `draft_exists` |
| `PATCH /orders/:id` | только черновик: `lines` (целиком), `expectedOn`, `comment`. 409 `order_not_draft` |
| `POST /orders/:id/send` | отправить: статус `sent`, письмо поставщику, событие `order.sent`, сообщение в Telegram. Сбой письма заказ не отменяет, причина в `emailError`. 409 `order_not_draft`, `supplier_inactive` |
| `POST /orders/:id/resend` | повторить письмо по отправленному заказу |
| `POST /orders/:id/cancel` | отменить черновик или отправленный заказ без прихода. 409 `order_partial`, `order_closed` |
| `POST /orders/:id/close` | `{ comment? }`: закрыть отправленный или принятый частично заказ (недопоставка) |
| `GET /orders/:id/export.csv` | менеджер: строки заказа в CSV, запись в журнале аудита |

В `POST /documents/receipts` добавлено необязательное `orderId`: принятое количество засчитывается в заказ, поставщик берётся из заказа. Ошибки: 400 `order_location_mismatch`, `order_supplier_mismatch`; 404, если заказа нет; 409 `order_not_open` (заказ не отправлен или уже закрыт). Продукты, которых не было в заказе, принимаются, но в заказ не засчитываются (в аудите `outsideOrder`).

У поставщика (`SupplierDto`) новые поля `email`, `leadTimeDays`, `minOrderSum`, `autoOrder`; у продукта (`ProductDto`) `defaultSupplierId`, `defaultSupplierName`, `packSize`. Вебхуки получили событие `order.sent`, а при изменении скидки на партию уходит `promotion.changed` (`PromotionChangedPayload`: точка, товар с артикулом и штрихкодом, действующая скидка `markdown` или `null`, если её отменили). Событие `order.sent` (`OrderSentPayload`: заказ, поставщик, точка, строки с артикулом и штрихкодом).

## Интеграции

Администратор. Секрет подписи показывается один раз, при создании и смене, и не возвращается никогда.

| Метод и адрес | Что делает |
|---|---|
| `GET /integrations/webhooks` | список адресов (`WebhookDto`: название, адрес, события, точка, состояние, серия неудач, последний успех) |
| `POST /integrations/webhooks` | `{ name, url, events: ["stoplist.changed"], locationId? }` → 201 `WebhookCreatedDto` с `secret`. 400 `bad_webhook_url`, если адрес не https или указывает во внутреннюю сеть; 409 `too_many_webhooks` (не больше 20). После создания запоминается текущее состояние стоп-листа: событием станет только то, что изменится потом |
| `PATCH /integrations/webhooks/:id` | любые из `name`, `url`, `events`, `locationId`, `enabled`. Ручное включение обнуляет серию неудач |
| `POST /integrations/webhooks/:id/rotate-secret` | `{ secret }`: новый секрет, старый перестаёт подходить сразу |
| `POST /integrations/webhooks/:id/test` | одно событие `ping`, одна попытка, в ответе результат доставки |
| `POST /integrations/webhooks/:id/sync` | `{ queued }`: полное текущее состояние стоп-листа по каждой точке адреса, для первой синхронизации приёмника |
| `GET /integrations/webhooks/:id/deliveries?limit` | журнал отправки без тел событий |
| `DELETE /integrations/webhooks/:id` | удаляет адрес и его журнал |

**Что получает приёмник.** `POST` с `Content-Type: application/json` и заголовками `X-Zapas-Event`, `X-Zapas-Delivery` (идентификатор доставки, при повторе тот же), `X-Zapas-Timestamp` (секунды), `X-Zapas-Signature: sha256=<hex>`. Подпись это `HMAC-SHA256(secret, "<timestamp>.<тело>")`; приёмнику стоит отвергать запросы со временем старше пяти минут. Любой ответ 2xx считается доставкой, всё остальное и таймаут (8 секунд) повтором. Тело события `stoplist.changed` (`StopListChangedPayload`): `locationId`, `locationName`, `createdAt`, `added` и `removed` (позиции, которые появились и ушли), `entries` (полное состояние точки), `truncated`. Позиция (`StopFeedEntryDto`): `id`, `type` (`product` или `dish`), `code` (артикул продукта или код блюда), `barcode`, `name`, `source` (`auto` или `manual`), `reason`, `since`. Порядок доставки между повторами не гарантируется, поэтому надёжнее брать `entries` с самым поздним `createdAt`.

Ключ кассы (`X-Api-Key`, привязан к одной точке):

| Метод и адрес | Что отдаёт |
|---|---|
| `GET /pos/stop-list` | `{ generatedAt, locationId, entries }`: стоп-лист точки ключа в том же виде, что в вебхуке |
| `GET /pos/products?limit&offset` | страница каталога `{ items: [{ sku, barcode, name, unit, price, markdown, sellable, isActive }], total }`, без себестоимости. `markdown` это скидка на ближайшую по сроку партию, по которой касса продаст следующую единицу: `{ percent, price, endsOn, quantity }`, а без скидки `null`. Продажа через `POST /pos/sales` сама идёт по цене со скидкой |

Импорт номенклатуры (менеджер и выше):

| Метод и адрес | Что делает |
|---|---|
| `POST /products/import/preview` | `{ content: <CSV в base64, до 2 МБ>, createCategories? }` → `ImportPreviewDto`: кодировка, разделитель, распознанные колонки, число новых, изменяемых, без изменений и ошибочных строк, до 300 строк с пояснениями (ошибки первыми). Ничего не записывает. Не больше 5000 строк. 400 `import_format` на непригодный файл |
| `POST /products/import` | то же тело, записывает новые и изменённые строки одной транзакцией, строки с ошибками пропускает → `{ created, updated, skipped, categoriesCreated }`. Файл разбирается заново внутри транзакции. 409 `nothing_to_import`, если применять нечего, и `import_conflict`, если данные изменились во время записи |

В `DishDto` и в создании и изменении блюда есть необязательное `code` (код блюда в кассе, уникален без учёта регистра, 409 `duplicate_code`).

## Обмен с учётными системами

Менеджер видит, администратор настраивает.

| Метод и адрес | Что делает |
|---|---|
| `GET /exchange/systems` | подключения с состоянием, последней ошибкой и счётчиками очереди |
| `POST /exchange/systems` | `{ kind: "onec", name, baseUrl, username?, password?, profile, docKinds, locationId? }` → 201. Пароль хранится зашифрованным и не возвращается. 400, если адрес внутренний или по http и хоста нет в `EXCHANGE_ALLOW_HOSTS` |
| `PATCH` и `DELETE /exchange/systems/:id` | правка (в том числе `enabled`) и удаление вместе с очередью |
| `GET /exchange/presets` | типовые профили 1С |
| `POST /exchange/systems/:id/check` | проверка: связь, логин, описание интерфейса, объекты и реквизиты. `{ ok, items: [{ ok, text }] }` |
| `GET /exchange/systems/:id/unlinked` | что нужно связать с 1С |
| `POST /exchange/systems/:id/autolink` | связь по артикулу и ИНН, только однозначные совпадения: `{ linked, left }` |
| `GET /exchange/systems/:id/search?entity&q` | поиск в справочнике 1С |
| `PUT /exchange/systems/:id/links` | `{ entity: product|supplier|location, localId, remoteKey }`, ждавшие документы возвращаются в очередь |
| `GET /exchange/jobs?systemId&status&limit` | журнал выгрузки |
| `POST /exchange/jobs/:id/retry` | вернуть в очередь (409, если не нужно) |
| `POST /documents/:id/exchange` | `{ systemId }`: одна попытка выгрузки сразу, повтор обновляет тот же документ 1С. `{ outcome, job }` |
| `GET /documents/:id/export/iiko.xml?store&supplier` | приход XML для iiko |

## Прослеживаемость

| Метод и адрес | Роль |
|---|---|
| `GET /traceability/summary` | кладовщик и выше: `{ vsdPending, vsdOverdue, marksTotal }` по доступным точкам |
| `GET /traceability/vsd?status=pending\|redeemed\|all&locationId&limit&offset` | кладовщик и выше: страница ВСД (`VsdDto`, у ждущих есть `dueAt` и признак `overdue`). Чужая точка это 404 |
| `POST /traceability/vsd/:id/redeem` | кладовщик и выше: `{ comment? }`, отметить погашенным, 204. Повтор: 409 `already_redeemed` |
| `POST /traceability/vsd/:id/reopen` | менеджер и выше: вернуть в очередь, 204. 409 `not_redeemed`, если ВСД и так ждёт |
| `GET /traceability/marks?locationId&limit&offset` | кладовщик и выше: партии с марками (`MarkBatchDto`: принято марок, остаток, сколько должно выбыть) |
| `GET /reports/marks.csv?locationId&from&to` | менеджер и выше: реестр принятых марок (до 50 000 строк), попадает в журнал аудита |

В строке `POST /documents/receipts` добавлены необязательные `vsd` (UUID) и `marks` (коды маркировки целиком, до 500 в строке и 1500 в документе). Ошибки: 400 `bad_mark`, `mark_duplicate` (повтор внутри документа), `vsd_duplicate`; 409 `mark_duplicate` и `vsd_duplicate` (уже принято раньше); 422 `mark_gtin_mismatch` (GTIN марки не совпал со штрихкодом продукта), `too_many_marks` (у штучного товара марок больше штук). В `ProductDto` и в создании и изменении продукта есть `requiresVsd` и `requiresMarking`; `InvoiceLineDto` содержит `vsd` и `marks`.

## Справочники

`GET /products/by-barcode/:code`: продукт по штрихкоду (8–14 цифр; EAN-13, UPC-A и GTIN-14 одного товара совпадают), 404, если такого нет. `GET /products/scan-index`: активные продукты со штрихкодом для сканера без связи (до 10 000).

`/categories`, `/suppliers`, `/products`, `/dishes`: чтение для всех, `POST` и `PATCH` для менеджера. Удаления нет, записи отключаются (`isActive`). Единицу измерения продукта нельзя менять после первого прихода.

## Отчёты и администрирование

| Метод и адрес | Роль |
|---|---|
| `GET /reports/stock.csv`, `/reports/writeoffs.csv`, `/reports/movements.csv` | менеджер |
| `GET/POST /users`, `PATCH /users/:id`, `PUT /users/:id/password`, `POST /users/:id/unlock` | администратор |
| `GET /telegram`, `POST /telegram/link-code`, `DELETE /telegram/link` | любой вошедший: статус привязки своего чата, одноразовый код привязки (`201`, действует 10 минут), отвязка |
| `GET /locations` (все), `POST/PATCH /locations` | запись администратор |
| `GET /settings` (все), `PUT /settings` | запись администратор. Помимо порогов: `useDemandModel` (поправка прогноза на день недели, праздники, погоду, акции) и `autoWriteoffExpired` (раз в сутки списывать просроченное от имени «Система») |
| `GET/POST/DELETE /api-keys` | администратор |
| `GET /audit`, `GET /audit/verify` | администратор |
| `POST /users/:id/two-factor/reset` | администратор: сбросить подтверждение входа коллеге (204). Не себе (400 `use_disable`), чужая организация 404, не включено 409 |
| `GET /admin/cache` | администратор: счётчики кеша расчётов (попадания, промахи, присоединения, прежние срезы, сбросы, длительность загрузок, число ключей), число клиентов живого обновления и состояние синхронизации экземпляров. Только числа, без ключей |
| `POST /admin/cache/flush` | администратор: сбросить кеш своей организации (204), пишется в журнал |
| `POST /notifications/test` | администратор |
| `GET /health`, `GET /health/ready` | без входа |

## Бот Telegram

Бот получает сообщения опросом `getUpdates` и отвечает от имени привязанного пользователя (роль и точки те же, что у него в веб-интерфейсе). Привязка: `POST /telegram/link-code` возвращает `{ code, expiresAt, deepLink }`, человек отправляет боту `/link КОД` или открывает `deepLink`. Команды: `/today`, `/risks`, `/order`, `/stoplist`, `/stock <запрос>`, `/expiring`, `/expired`, `/low`, `/points`, `/whoami`, `/unlink`, `/help`. К большинству можно добавить название точки. Только чтение, только личные чаты.
