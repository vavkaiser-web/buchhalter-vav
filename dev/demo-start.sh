#!/bin/zsh
# Локальный запуск Бухгалтера на демо-базе (вымышленные данные эталона).
# Часы демо зафиксированы на 24.09.2026 12:00 (как в эталоне); на сервере
# BUCH_JETZT и BUCH_DEMO_BANK не задаются.
cd "$(dirname $0)/.."
D=$PWD/dev/demo
export PORT=${PORT:-3126} BUCH_DATA=$D/data BUCH_DATEN=$D/daten BUCH_DATEIEN=$D/dateien \
  BUCH_MAILOPS_ENV=$D/mailops.env BUCH_LOKAL_HTTP=1 BUCH_DEMO_BANK=$D/bank.json \
  BUCH_JETZT=${BUCH_JETZT:-2026-09-24T10:00:00Z}
exec node app/server.js
