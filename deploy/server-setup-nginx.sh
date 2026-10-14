#!/usr/bin/env bash
# Развёртывание «Запаса» на сервере, где уже работает nginx с сертификатом Let's Encrypt.
# Старый сайт на этом домене останавливается и уезжает в резервную копию, другие сайты на сервере не затрагиваются.
# Запуск от root:  bash deploy/server-setup-nginx.sh litvinskiy-dev.ru
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="/root/old-site-backup-$(date +%Y%m%d-%H%M%S)"
APP_PORT=3000

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ask_yes() { local a; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[YyДд]$ ]]; }

[[ $EUID -eq 0 ]] || { echo "Запустите от root"; exit 1; }
[[ -n "$DOMAIN" ]] || read -r -p "Домен: " DOMAIN
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "Некорректный домен"; exit 1; }
CERT="/etc/letsencrypt/live/$DOMAIN"
[[ -f "$CERT/fullchain.pem" ]] || { echo "Нет сертификата $CERT. Выпустите его: certbot certonly --webroot -w /var/www/letsencrypt -d $DOMAIN"; exit 1; }

say "1. Что обслуживает домен $DOMAIN"
mapfile -t SITES < <(grep -rlE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null || true)
printf 'Конфиги nginx этого домена: %s\n' "${SITES[*]:-нет}"
OLD_UNITS=()
for f in "${SITES[@]}"; do
  for port in $(grep -oE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$f" | grep -oE '[0-9]+$' | sort -u); do
    pid="$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
    unit="$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    echo "  порт $port: процесс ${pid:-?}, служба ${unit:-?}"
    [[ "$unit" == *.service ]] && OLD_UNITS+=("$unit")
  done
done
echo "Другие сайты (их скрипт не трогает):"
ls -1 /etc/nginx/sites-enabled | grep -vxF "$(basename "${SITES[0]:-none}")" || true

say "2. Снос старого сайта на домене"
echo "Остановятся службы: ${OLD_UNITS[*]:-нет}. Их файлы, данные и конфиг nginx этого домена будут ПЕРЕНЕСЕНЫ в $BACKUP"
echo "(перенесены, а не удалены: вернуть можно). Остальные сайты на сервере не меняются."
read -r -p "Чтобы снести старый сайт, напечатайте слово СНЕСТИ (иначе скрипт остановится): " CONFIRM
[[ "$CONFIRM" == "СНЕСТИ" ]] || { echo "Остановлено, ничего не изменено."; exit 1; }
mkdir -p "$BACKUP"/{opt,var-lib,etc,systemd,nginx}
# перенос идемпотентен: что уже перенесено или отсутствует, пропускается
move() { [[ -e "$1" ]] && mv "$1" "$2/" || true; }
for u in "${OLD_UNITS[@]}"; do
  systemctl disable --now "$u" >/dev/null 2>&1 || true
  base="${u%.service}"
  [[ -f "/etc/systemd/system/$u" ]] && cp -a "/etc/systemd/system/$u" "$BACKUP/systemd/" || true
  move "/opt/$base" "$BACKUP/opt"
  move "/var/lib/$base" "$BACKUP/var-lib"
  move "/etc/$base.env" "$BACKUP/etc"
done
for f in "${SITES[@]}"; do
  [[ -e "$f" ]] || continue
  cp -a "$f" "$BACKUP/nginx/"
  rm -f "/etc/nginx/sites-enabled/$(basename "$f")" "$f"
done
echo "Старый сайт остановлен, копия в $BACKUP"

say "3. Docker"
if ! docker compose version >/dev/null 2>&1; then
  ask_yes "Docker с Compose не найден. Установить из репозитория Ubuntu?" || { echo "Без Docker продолжить нельзя"; exit 1; }
  apt-get update -y
  apt-get install -y docker.io docker-compose-v2 || curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version

say "4. Настройки (.env)"
cd "$APP_DIR"
if [[ -f .env ]]; then
  echo ".env уже есть, секреты базы не меняются"
else
  umask 077
  cat > .env <<ENV
DB_ADMIN_PASSWORD=$(openssl rand -hex 24)
DB_OWNER_PASSWORD=$(openssl rand -hex 24)
DB_APP_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
COMPOSE_FILE=docker-compose.yml
APP_PORT=$APP_PORT
BUSINESS_TZ=Europe/Moscow
COOKIE_SECURE=true
TRUST_PROXY=1
APP_ORIGINS=https://$DOMAIN
ENV
fi
set_env() {
  [[ "$2" == *"'"* ]] && { echo "В значении $1 не должно быть одинарной кавычки"; exit 1; }
  sed -i "/^$1=/d" .env
  printf "%s='%s'\n" "$1" "$2" >> .env
}
echo "Telegram (Enter пропускает, значения при вводе не показываются)."
read -r -s -p "Токен бота: " TG_TOKEN; echo
if [[ -n "$TG_TOKEN" ]]; then
  read -r -p "Chat ID для сводок: " TG_CHAT
  read -r -s -p "SOCKS5-прокси (socks5://логин:пароль@IP:порт, Enter без прокси): " TG_PROXY; echo
  set_env TELEGRAM_BOT_TOKEN "$TG_TOKEN"
  set_env TELEGRAM_CHAT_ID "$TG_CHAT"
  [[ -n "$TG_PROXY" ]] && set_env TELEGRAM_PROXY_URL "$TG_PROXY"
fi
chmod 600 .env

say "5. Запуск приложения"
docker compose up -d --build
echo "Жду, пока приложение станет здоровым..."
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break
  sleep 3
done
curl -fsS "http://127.0.0.1:$APP_PORT/api/health" || { echo "Приложение не ответило: docker compose logs --tail 80 app"; exit 1; }

say "6. nginx"
cat > /etc/nginx/sites-available/zapas <<NGINX
# «Запас»: $DOMAIN. Сертификат выпущен certbot, продление идёт через /.well-known
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate $CERT/fullchain.pem;
    ssl_certificate_key $CERT/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:zapas_ssl:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    add_header Strict-Transport-Security "max-age=604800" always;

    client_max_body_size 4m;
    gzip on;
    gzip_types text/css application/javascript text/javascript application/json text/csv image/svg+xml;

    # адрес клиента перезаписываем, а не дописываем: подделанный X-Forwarded-For не пройдёт
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;

    # поток обновлений: без буфера и без сжатия, события должны доходить сразу
    location = /api/events {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 1h;
        proxy_set_header Connection "";
    }

    # Отгрузка: кабинет поставщика, отдельная система на этом же домене
    location /supplier/ {
        proxy_pass http://127.0.0.1:3100;
        # заголовки повторяем: в location с собственным proxy_set_header серверные не наследуются
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Connection "";
    }
}
NGINX
ln -sf /etc/nginx/sites-available/zapas /etc/nginx/sites-enabled/zapas
nginx -t
systemctl reload nginx
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
sleep 2
curl -fsS "https://$DOMAIN/api/health" && echo && echo "Сайт отвечает: https://$DOMAIN" || echo "По https пока не отвечает: tail /var/log/nginx/error.log"

say "7. Данные"
if ask_yes "Загрузить демо-данные за 60 дней (пароли демо-пользователей публичны)?"; then
  docker compose --profile demo run --rm seed
else
  echo "Создаём первого администратора (почту, имя и пароль спросит программа):"
  docker compose --profile admin run --rm create-admin
fi

say "Итог"
docker compose ps
echo "Логи бота: docker compose logs app | grep -i telegram"
echo "Старый сайт сохранён в $BACKUP. Если тот же токен бота работает ещё и на другом компьютере, там поставьте TELEGRAM_COMMANDS=false."
