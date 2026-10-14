#!/usr/bin/env bash
# Подключает кабинет поставщика «Отгрузка» к уже работающему «Запасу»: секреты в .env, адрес /supplier в nginx.
# Запуск от root в папке проекта на сервере:  bash deploy/enable-supplier.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=.env
[[ -f $ENV_FILE ]] || { echo "Нет файла .env: запускайте из папки проекта"; exit 1; }

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
setenv() { grep -q "^$1=" "$ENV_FILE" || echo "$1=$2" >> "$ENV_FILE"; }

say "1. Секреты и адреса в .env"
setenv SUPPLIER_PORTAL_SECRET "$(openssl rand -hex 24)"
setenv SUPPLIER_SESSION_SECRET "$(openssl rand -hex 24)"
ORIGIN="$(grep -E '^APP_ORIGINS=' "$ENV_FILE" | head -1 | cut -d= -f2 | cut -d, -f1)"
[[ -n "$ORIGIN" ]] && setenv SUPPLIER_PORTAL_PUBLIC_URL "$ORIGIN/supplier"
echo "Готово (значения секретов не показываются)"

say "2. nginx"
# в sites-enabled лежат символические ссылки, поэтому перебираем файлы явно, а не рекурсивным поиском
SITE=""
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [[ -e "$f" ]] || continue
  if grep -qE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$f" && grep -q '/api/events' "$f"; then SITE="$(readlink -f "$f")"; break; fi
done
if [[ -z "$SITE" ]]; then echo "Не нашёл конфиг nginx «Запаса»: добавьте location /supplier/ вручную (proxy_pass http://127.0.0.1:3100)"; exit 1; fi
if grep -q 'location /supplier/' "$SITE"; then
  echo "Адрес /supplier уже есть в $SITE"
else
  cp -a "$SITE" "$SITE.bak-supplier"
  python3 - "$SITE" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
block = '''    # Отгрузка: кабинет поставщика, отдельная система на этом же домене
    location /supplier/ {
        proxy_pass http://127.0.0.1:3100;
        # заголовки повторяем: в location с собственным proxy_set_header серверные не наследуются
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }

'''
# вставляем перед основным location /, который ведёт в приложение (последний в блоке 443)
idx = text.rfind('    location / {')
if idx < 0:
    sys.exit('location / не найден')
open(path, 'w', encoding='utf-8').write(text[:idx] + block + text[idx:])
PY
  nginx -t
  systemctl reload nginx
  echo "nginx обновлён, копия прежнего конфига: $SITE.bak-supplier"
fi

say "3. Сборка и запуск"
docker compose up -d --build app supplier
for _ in $(seq 1 40); do
  curl -fsS http://127.0.0.1:3100/supplier/api/health >/dev/null 2>&1 && break
  sleep 3
done
curl -fsS http://127.0.0.1:3100/supplier/api/health && echo
echo "Кабинет поставщика: ${ORIGIN:-https://ваш-домен}/supplier/"
echo "Демо-кабинеты и заказы: docker compose --profile demo run --rm seed-platform && docker compose --profile demo run --rm supplier-seed && docker compose --profile demo run --rm portal-sync"
