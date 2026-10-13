#!/usr/bin/env bash
# Подключает чтение фото накладных через GigaChat: проверяет ключ (просит у сервиса токен) и только потом пишет его в .env и перезапускает приложение.
# Запуск в папке проекта на сервере:  bash deploy/set-gigachat.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "Нет .env"; exit 1; }

read -r -s -p "Ключ авторизации GigaChat (длинная строка base64 из кабинета разработчика): " KEY; echo
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
[[ "$KEY" =~ ^[A-Za-z0-9+/]{40,}={0,2}$ ]] || { echo "Ключ выглядит неверно: нужна одна строка base64 без пробелов и кавычек"; exit 1; }

# сертификат сервиса подписан российским корневым, в системном хранилище его нет, поэтому проверку здесь отключаем (-k)
REPLY="$(curl -sSk -m 25 -X POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth \
  -H "Authorization: Basic ${KEY}" -H "RqUID: $(cat /proc/sys/kernel/random/uuid)" \
  -H 'Content-Type: application/x-www-form-urlencoded' -d 'scope=GIGACHAT_API_PERS' || true)"
if ! grep -q '"access_token"' <<<"$REPLY"; then
  echo "GigaChat не дал токен: ${REPLY:-нет ответа}"
  echo "Проверьте ключ и пространство (GIGACHAT_API_PERS для физлиц), а также что сервер достаёт до ngw.devices.sberbank.ru:9443."
  exit 1
fi
echo "Ключ принят."

sed -i '/^GIGACHAT_AUTH_KEY=/d; /^GIGACHAT_INSECURE_TLS=/d' .env
printf "GIGACHAT_AUTH_KEY='%s'\nGIGACHAT_INSECURE_TLS=true\n" "$KEY" >> .env
chmod 600 .env
docker compose up -d app
sleep 6
curl -fsS http://127.0.0.1:3000/api/health && echo
echo "Готово. В «Тестирование → Накладные» кнопка «Разобрать здесь» теперь работает и для фото."
