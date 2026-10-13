#!/usr/bin/env bash
# Меняет токен бота на сервере: проверяет его через настроенный прокси и только при успехе записывает в .env и перезапускает приложение.
# Запуск в папке проекта на сервере:  bash deploy/set-telegram.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Нет .env"; exit 1; }

PROXY="$(grep -E '^TELEGRAM_PROXY_URL=' .env | head -1 | cut -d= -f2- | sed "s/^'//; s/'$//")"
read -r -s -p "Токен бота (из BotFather, вид 123456:AA...): " TOKEN; echo
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{30,}$ ]] || { echo "Токен выглядит неверно: должен быть вида 123456789:AAxxxxxxxx (без пробелов и кавычек)"; exit 1; }

ARGS=(-sS -m 20)
[[ -n "$PROXY" ]] && ARGS+=(-x "${PROXY/socks5:/socks5h:}")
REPLY="$(curl "${ARGS[@]}" "https://api.telegram.org/bot${TOKEN}/getMe" || true)"
if ! grep -q '"ok":true' <<<"$REPLY"; then
  echo "Telegram не принял токен: $(grep -oE '"description":"[^"]*"' <<<"$REPLY" || echo 'нет ответа через прокси')"
  echo "Проверьте токен в BotFather (команда /token) или выпустите новый (/revoke)."
  exit 1
fi
echo "Токен принят, бот: @$(grep -oE '"username":"[^"]*"' <<<"$REPLY" | cut -d'"' -f4)"

read -r -p "Chat ID для сводок (Enter оставить прежний): " CHAT
sed -i '/^TELEGRAM_BOT_TOKEN=/d' .env
printf "TELEGRAM_BOT_TOKEN='%s'\n" "$TOKEN" >> .env
if [[ -n "$CHAT" ]]; then
  sed -i '/^TELEGRAM_CHAT_ID=/d' .env
  printf "TELEGRAM_CHAT_ID='%s'\n" "$CHAT" >> .env
fi
chmod 600 .env
docker compose up -d app
sleep 6
docker compose logs --no-color --tail 40 app | grep -iE 'telegram' | tail -5 || true
echo "Готово. Напишите боту /start."
