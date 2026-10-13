#!/usr/bin/env bash
# Развёртывание «Запаса» на сервере Ubuntu одной командой, с вопросами на каждом опасном шаге.
# Запуск от root в папке, куда распакован проект:  bash deploy/server-setup.sh litvinskiy-dev.ru
# Скрипт ничего не удаляет без вашего ответа, секреты спрашивает без отображения на экране и пишет только в .env (права 600).
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="/root/old-site-backup-$(date +%Y%m%d-%H%M%S)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ask_yes() { local a; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[YyДд]$ ]]; }

[[ $EUID -eq 0 ]] || { echo "Запустите от root"; exit 1; }
[[ -n "$DOMAIN" ]] || read -r -p "Домен (например litvinskiy-dev.ru): " DOMAIN
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "Некорректный домен"; exit 1; }

say "1. Что сейчас стоит на сервере"
echo "--- Docker-контейнеры:"; (docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || echo "docker не установлен")
echo "--- Кто слушает порты 80 и 443:"; (ss -ltnp 2>/dev/null | grep -E ':(80|443)\s' || echo "никто")
echo "--- Веб-серверы:"; for s in nginx apache2 caddy; do systemctl is-active --quiet "$s" 2>/dev/null && echo "$s работает"; done || true
echo "--- Каталоги сайтов:"; ls -1 /var/www /opt /srv 2>/dev/null | head -30 || true

say "2. Снос старого проекта"
echo "Будут остановлены и удалены ВСЕ контейнеры, образы и тома Docker, остановлены nginx/apache/caddy,"
echo "их настройки сайтов перенесены в $BACKUP (их можно вернуть). Каталоги /var/www, /opt, /srv скрипт не трогает."
read -r -p "Чтобы снести старый проект, напечатайте слово СНЕСТИ (иначе шаг пропускается): " CONFIRM
if [[ "$CONFIRM" == "СНЕСТИ" ]]; then
  mkdir -p "$BACKUP"
  if command -v docker >/dev/null 2>&1; then
    docker ps -aq | xargs -r docker rm -f
    docker system prune -af --volumes >/dev/null
  fi
  for s in nginx apache2 caddy; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^$s\.service"; then
      systemctl disable --now "$s" >/dev/null 2>&1 || true
    fi
  done
  for d in /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/apache2/sites-enabled /etc/caddy; do
    [[ -d "$d" ]] && cp -a "$d" "$BACKUP/" 2>/dev/null || true
  done
  [[ -d /etc/nginx/sites-enabled ]] && find /etc/nginx/sites-enabled -type l -delete 2>/dev/null || true
  echo "Старый проект снесён. Копия настроек: $BACKUP"
else
  echo "Пропущено. Если порты 80 и 443 заняты, запуск не удастся."
fi

say "3. Docker"
if ! docker compose version >/dev/null 2>&1; then
  if ask_yes "Docker с Compose не найден. Установить из репозитория Ubuntu?"; then
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2 || { curl -fsSL https://get.docker.com | sh; }
  else
    echo "Без Docker продолжить нельзя"; exit 1
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version

say "4. Домен и сертификат"
SERVER_IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
echo "Сервер: ${SERVER_IP:-?}, домен $DOMAIN указывает на: ${DOMAIN_IP:-ничего}"
if [[ "$SERVER_IP" != "$DOMAIN_IP" ]]; then
  echo "ВНИМАНИЕ: домен не указывает на этот сервер. Без этого Caddy не получит сертификат."
  ask_yes "Всё равно продолжить?" || exit 1
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  echo "Порты 22, 80, 443 открыты в ufw"
fi

say "5. Настройки (.env)"
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
DOMAIN=$DOMAIN
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
BUSINESS_TZ=Europe/Moscow
COOKIE_SECURE=true
ENV
fi

set_env() { # set_env ИМЯ ЗНАЧЕНИЕ: одинарные кавычки, чтобы Compose не раскрывал $ в значении
  [[ "$2" == *"'"* ]] && { echo "В значении $1 не должно быть одинарной кавычки"; exit 1; }
  sed -i "/^$1=/d" .env
  printf "%s='%s'\n" "$1" "$2" >> .env
}

echo "Telegram (Enter пропускает, значения при вводе не показываются)."
read -r -s -p "Токен бота: " TG_TOKEN; echo
if [[ -n "$TG_TOKEN" ]]; then
  read -r -p "Chat ID для сводок: " TG_CHAT
  read -r -s -p "SOCKS5-прокси для Telegram (socks5://логин:пароль@IP:порт, Enter без прокси): " TG_PROXY; echo
  set_env TELEGRAM_BOT_TOKEN "$TG_TOKEN"
  set_env TELEGRAM_CHAT_ID "$TG_CHAT"
  [[ -n "$TG_PROXY" ]] && set_env TELEGRAM_PROXY_URL "$TG_PROXY"
fi
chmod 600 .env

say "6. Запуск"
docker compose up -d --build
echo "Жду, пока приложение ответит по https (сертификат выдаётся до минуты)..."
ok=""
for _ in $(seq 1 40); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [[ -n "$ok" ]]; then echo "Готово: https://$DOMAIN"; else echo "Сайт пока не отвечает. Смотрите: docker compose logs --tail 80 app caddy"; fi

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
echo "Если тот же токен бота работает ещё и на другом компьютере, там поставьте TELEGRAM_COMMANDS=false: опрашивать токен может один экземпляр."
