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

**Идемпотентность.** Операции, создающие документы, принимают заголовок `Idempotency-Key` (8–128 символов: буквы, цифры, `. _ : -`). Повтор с тем же ключом от того же пользователя возвращает уже созданный документ со статусом 200 и `"duplicate": true`, остатки второй раз не меняются. Тот же ключ с другим телом запроса это ошибка 422 с кодом `idempotency_conflict`: ключ нужно сменить, а не повторять.

## Вход

```http
POST /api/auth/login
{ "email": "manager@zapas.local", "password": "…" }
```

Ответ: `{ "accessToken": "…", "expiresIn": 900, "user": { … } }`, плюс cookie обновления. Неверный пароль, неизвестный адрес и блокировка дают одинаковый ответ 401 `invalid_credentials`.

| Метод и адрес | Назначение |
|---|---|
| `POST /auth/refresh` | новый токен по cookie, cookie ротируется |
| `POST /auth/logout` | закрыть сессию |
| `GET /auth/me` | текущий пользователь |
| `POST /auth/change-password` | смена пароля, закрывает все сессии |

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

## Приход по накладной

| Метод и адрес | Роль |
|---|---|
| `GET /invoices/capabilities` | кладовщик и выше: `{ upd: true, photo: bool }`, подключено ли распознавание фото |
| `POST /invoices/parse` | кладовщик и выше: `{ format: "upd", content: <base64 XML, до 3 МБ> }` → накладная `InvoiceDto` (поставщик, строки с найденными продуктами и подсказками, предупреждения, признак повтора). Ничего не создаёт |
| `POST /invoices/parse-photo` | кладовщик и выше: `{ mediaType, image: <base64, до 5 МБ> }` → тот же `InvoiceDto`. 409 `invoice_photo_disabled`, если ключ не задан; 502 `invoice_reader_failed` при сбое сервиса |
| `PUT /suppliers/:id/item-map` | кладовщик и выше: `{ items: [{ key, productId }] }`, запоминает соответствие строк накладной поставщика продуктам |

Приход создаёт обычный `POST /documents/receipts`: клиент подставляет в него строки из разобранной накладной.

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

У поставщика (`SupplierDto`) новые поля `email`, `leadTimeDays`, `minOrderSum`, `autoOrder`; у продукта (`ProductDto`) `defaultSupplierId`, `defaultSupplierName`, `packSize`. Вебхуки получили событие `order.sent` (`OrderSentPayload`: заказ, поставщик, точка, строки с артикулом и штрихкодом).

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
| `GET /pos/products?limit&offset` | страница каталога `{ items: [{ sku, barcode, name, unit, price, sellable, isActive }], total }`, без себестоимости |

Импорт номенклатуры (менеджер и выше):

| Метод и адрес | Что делает |
|---|---|
| `POST /products/import/preview` | `{ content: <CSV в base64, до 2 МБ>, createCategories? }` → `ImportPreviewDto`: кодировка, разделитель, распознанные колонки, число новых, изменяемых, без изменений и ошибочных строк, до 300 строк с пояснениями (ошибки первыми). Ничего не записывает. Не больше 5000 строк. 400 `import_format` на непригодный файл |
| `POST /products/import` | то же тело, записывает новые и изменённые строки одной транзакцией, строки с ошибками пропускает → `{ created, updated, skipped, categoriesCreated }`. Файл разбирается заново внутри транзакции. 409 `nothing_to_import`, если применять нечего, и `import_conflict`, если данные изменились во время записи |

В `DishDto` и в создании и изменении блюда есть необязательное `code` (код блюда в кассе, уникален без учёта регистра, 409 `duplicate_code`).

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
| `GET /settings` (все), `PUT /settings` | запись администратор |
| `GET/POST/DELETE /api-keys` | администратор |
| `GET /audit`, `GET /audit/verify` | администратор |
| `POST /notifications/test` | администратор |
| `GET /health`, `GET /health/ready` | без входа |

## Бот Telegram

Бот получает сообщения опросом `getUpdates` и отвечает от имени привязанного пользователя (роль и точки те же, что у него в веб-интерфейсе). Привязка: `POST /telegram/link-code` возвращает `{ code, expiresAt, deepLink }`, человек отправляет боту `/link КОД` или открывает `deepLink`. Команды: `/today`, `/risks`, `/order`, `/stoplist`, `/stock <запрос>`, `/expiring`, `/expired`, `/low`, `/points`, `/whoami`, `/unlink`, `/help`. К большинству можно добавить название точки. Только чтение, только личные чаты.
