#!/bin/sh
# Выполняется один раз при первом создании базы. Разводит права:
#   zapas_owner  владеет схемой, им применяются миграции
#   zapas_app    рабочая роль приложения, без права менять схему и переписывать журналы
set -eu

psql -v ON_ERROR_STOP=1 \
  -v owner_pw="$DB_OWNER_PASSWORD" \
  -v app_pw="$DB_APP_PASSWORD" \
  -v dbname="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE zapas_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE zapas_app LOGIN PASSWORD :'app_pw';
ALTER DATABASE :"dbname" OWNER TO zapas_owner;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO zapas_app;
SQL
