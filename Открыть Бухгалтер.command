#!/bin/zsh
# Двойной щелчок в Finder: запускает локальный Бухгалтер VAV на демо-базе
# (вымышленные данные) и открывает его в браузере. Боевой сервер не затрагивается.
# Входы: andrej, buch, oleg, ma_a, ma_b · ПИН demo-2409. Закрыть — закрыть это окно.
cd "$(dirname "$0")"
if curl -s -o /dev/null http://127.0.0.1:3126/login; then
  open "http://127.0.0.1:3126/arbeit"
  echo "Бухгалтер уже запущен: http://127.0.0.1:3126/arbeit"
  exit 0
fi
( for i in {1..40}; do sleep 0.5; curl -s -o /dev/null http://127.0.0.1:3126/login && open "http://127.0.0.1:3126/arbeit" && break; done ) &
exec ./start-demo.sh
