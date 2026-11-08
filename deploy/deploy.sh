#!/bin/sh
# Развёртывание «Смены» на VPS одной командой.
#   sh deploy/deploy.sh root@203.0.113.10 smena.example.ru
# Что делает: копирует код в /opt/smena, ставит Docker и Caddy (если нет),
# создаёт .env (права 600) при первом запуске, поднимает контейнер и HTTPS.
# Секреты в командной строке не передаются: .env заполняется на сервере.
set -eu
HOST="${1:?Укажите user@host}"
DOMAIN="${2:?Укажите домен, например smena.example.ru}"
DIR=/opt/smena
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Копирую код на $HOST:$DIR"
tar -C "$ROOT" -czf - package.json server.mjs index.html app.js app.css shared.mjs icon.svg lib Dockerfile compose.yaml .env.example deploy \
  | ssh "$HOST" "mkdir -p $DIR && tar -C $DIR -xzf -"

echo "→ Готовлю сервер"
ssh "$HOST" DOMAIN="$DOMAIN" DIR="$DIR" sh -s <<'REMOTE'
set -eu
cd "$DIR"
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
if ! command -v caddy >/dev/null; then
  if command -v apt-get >/dev/null; then apt-get update -q && apt-get install -yq caddy; else echo "Установите Caddy вручную" >&2; exit 1; fi
fi
if [ ! -f .env ]; then
  cp .env.example .env && chmod 600 .env
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#; s#^DATA_DIR=.*#DATA_DIR=/app/data#; s#^TRUST_PROXY=.*#TRUST_PROXY=1#" .env
  echo "!! Заполните BOT_TOKEN, BOT_USERNAME и OWNER_TELEGRAM_ID в $DIR/.env и запустите скрипт ещё раз." >&2
  exit 2
fi
grep -q '^BOT_TOKEN=replace_locally' .env && { echo "!! BOT_TOKEN в $DIR/.env не заполнен" >&2; exit 2; }
docker compose config --quiet
docker compose up -d --build
sed "s/smena.example.ru/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy
for i in $(seq 1 30); do curl -fs http://127.0.0.1:8732/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8732/health && echo
code=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/state" || true)
echo "Внешняя проверка: /api/state без входа → $code (ожидается 401)"
REMOTE
echo "Готово. Остановите старый тестовый бот на Windows (Stop-Local.ps1): getUpdates должен работать в одном месте."
