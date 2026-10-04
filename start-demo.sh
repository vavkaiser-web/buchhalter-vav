#!/bin/zsh
# Локальный просмотр Бухгалтера VAV на демо-базе (вымышленные данные эталона).
#   ./start-demo.sh          — запустить (база и демо-данные создаются при первом запуске)
#   ./start-demo.sh --neu    — пересоздать демо-данные с нуля
# Адрес: http://127.0.0.1:3126/arbeit · входы andrej, buch, oleg, ma_a, ma_b · ПИН demo-2409
# Ничего не отправляет наружу и не трогает боевой сервер.
set -e
cd "$(dirname $0)"
PGBIN=/opt/homebrew/opt/postgresql@18/bin
PGDATA=${BUCH_PGDATA:-/Users/akais/Documents/agents/buchhalter-implementation/dev/pgdata}
if ! $PGBIN/pg_ctl -D $PGDATA status >/dev/null 2>&1; then
  $PGBIN/pg_ctl -D $PGDATA -l $PGDATA/../pg.log start >/dev/null && sleep 2
fi
$PGBIN/createdb -h 127.0.0.1 -p 55481 -U buch buchdemo 2>/dev/null || true
[[ -d app/node_modules ]] || (cd app && npm ci --silent)
[[ -d tools/node/node_modules ]] || (cd tools/node && npm ci --silent)
if [[ "$1" == "--neu" || ! -f dev/demo/data/benutzer.json ]]; then node dev/demo-seed.js; fi
echo "Открыть: http://127.0.0.1:3126/arbeit"
exec ./dev/demo-start.sh
