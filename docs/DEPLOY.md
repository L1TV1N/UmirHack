# Развёртывание на сервере

Приложение, база и Caddy (он сам получает сертификат и даёт HTTPS) запускаются одной командой через Docker Compose. HTTPS нужен не для красоты: без него браузер не даст камере доступ, и сканер штрихкодов не заработает.

## Что нужно

- Сервер с Linux, Docker и Docker Compose не старше 2.24 (в `docker-compose.prod.yml` используется `!reset`). Хватит 1 ядра и 1–2 ГБ памяти.
- Открытые порты 80 и 443. Порт 80 нужен Caddy для получения сертификата.
- Домен, который указывает на сервер. Если своего нет, подойдёт адрес вида `203-0-113-5.sslip.io` (вместо точек в IP дефисы): он сам ведёт на этот IP, и на него выдаётся обычный сертификат.

## Быстрый путь: один скрипт

На сервере Ubuntu от root:

```bash
bash deploy/server-setup.sh ваш-домен.ru
```

Скрипт показывает, что стоит на сервере, и только после слова `СНЕСТИ` удаляет старый проект (контейнеры, образы и тома Docker; настройки nginx, apache и caddy сохраняются в `/root/old-site-backup-*`). Затем ставит Docker, проверяет, что домен указывает на сервер, генерирует секреты в `.env`, спрашивает токен бота и SOCKS5-прокси для Telegram (ввод скрыт), запускает приложение и ждёт сертификат. Дальше предлагает загрузить демо-данные или создать администратора.

Проект можно передать на сервер архивом, не публикуя репозиторий:

```bash
tar czf /tmp/zapas.tgz --exclude=node_modules --exclude=.git --exclude=dist --exclude='.env*' -C .. Umir-hack-2026
scp /tmp/zapas.tgz root@IP:/root/
ssh root@IP 'mkdir -p /opt/zapas && tar xzf /root/zapas.tgz -C /opt/zapas --strip-components=1 && cd /opt/zapas && bash deploy/server-setup.sh ваш-домен.ru'
```

## Первый запуск вручную

```bash
git clone https://github.com/L1TV1N/UmirHack.git zapas && cd zapas
cp .env.example .env
```

В `.env` задайте:

- `DB_ADMIN_PASSWORD`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`: `openssl rand -hex 24`;
- `JWT_SECRET`: `openssl rand -base64 48`;
- `DOMAIN`: ваш домен;
- `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`, чтобы дальше не писать `-f` в каждой команде.

Запуск:

```bash
docker compose up -d --build
docker compose ps        # app и db должны стать healthy
```

Миграции применяются при старте контейнера. Через минуту после запуска `https://<домен>/api/health` отвечает `{"status":"ok"}`.

## Данные

Для показа с демо-данными за 60 дней:

```bash
docker compose --profile demo run --rm seed
```

Учётные записи демо-стенда перечислены в README. Их пароли публичны, поэтому такой стенд держите только для показа.

Для рабочей установки без демо-данных заведите первого администратора:

```bash
docker compose --profile admin run --rm create-admin
```

## Показ вживую

Чтобы панель, стоп-лист и горячие предложения менялись на глазах, запустите генератор событий. Он присылает поставки и заказы гостей через API:

```bash
docker compose --profile demo up -d emulate
docker compose logs -f emulate     # что он делает
docker compose stop emulate        # остановить
```

Скорость задаёт `EMULATE_SPEED` в `.env` (по умолчанию 1: заказ раз в 4 секунды, поставка раз в 30). Часть заказов намеренно большие и упираются в нехватку: система отказывает и называет, чего не хватило.

## Проверка после запуска

```bash
curl -s https://<домен>/api/health
curl -N -H "Authorization: Bearer <токен доступа>" https://<домен>/api/events
```

Вторая команда держит соединение; при любой операции в системе в ответе появляется `event: changed`. Если событий нет или они приходят пачкой через минуты, между приложением и браузером стоит прокси с буферизацией (за Caddy из этого репозитория такого не бывает).

## Обновление

```bash
git pull
docker compose up -d --build
```

Данные остаются в томе `pgdata`, миграции применяются сами.

## Резервная копия

```bash
docker compose exec -T db pg_dump -U zapas_admin zapas | gzip > zapas-$(date +%F).sql.gz
```

## Что настроить по желанию

- Telegram: `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. Токен опрашивает только один экземпляр приложения. Если сервер не достаёт до `api.telegram.org`, задайте `TELEGRAM_PROXY_URL=socks5://логин:пароль@IP:порт`: бот, сводки и уведомления пойдут через прокси.
- Письма поставщикам: `SMTP_URL` и `SMTP_FROM`.
- Распознавание фото накладной: `ANTHROPIC_API_KEY`.

Все переменные описаны в README.

## Ограничения

- Приложение рассчитано на один экземпляр: поток событий, планировщик и бот Telegram держатся в памяти процесса. Несколько копий за балансировщиком потребуют `LISTEN/NOTIFY` для событий.
- Секреты и файл `.env` в репозиторий не попадают (`.gitignore`). Если токен бота или ключ когда-либо показывали в переписке, перевыпустите их.
