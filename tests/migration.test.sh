#!/bin/zsh
# Реальная проверка миграции 001 на изолированной локальной базе:
# вверх → вставки (включая снятие) → запреты → вниз → вверх.
set -e
cd "$(dirname $0)/.."
p(){ /opt/homebrew/opt/libpq/bin/psql -h 127.0.0.1 -p 55481 -U buch -d buchlokal -v ON_ERROR_STOP=1 -qtA "$@"; }
erwartet_fehler(){ if p -c "$1" >/dev/null 2>&1; then echo "FAIL: должно было упасть: $1"; exit 1; else echo "ok (отклонено): $2"; fi; }

p -f app/migrations/001_kasse.down.sql >/dev/null
p -f app/migrations/001_kasse.up.sql >/dev/null
echo "ok: миграция вверх"

id=$(p -c "INSERT INTO mailops_prod.buch_bewegung (art, betrag_cent, status, von) VALUES ('abhebung', 200000, 'bestaetigt', 'test') RETURNING id")
[[ -n "$id" ]] && echo "ok: снятие вставлено (id $id, оба счёта NULL)"
p -c "INSERT INTO mailops_prod.buch_konto (id, art, name, von) VALUES ('halter:t', 'halter', 'Т', 'test')" >/dev/null
p -c "INSERT INTO mailops_prod.buch_bewegung (art, an_konto, quelle_id, betrag_cent, status, von) VALUES ('uebergabe', 'halter:t', $id, 120000, 'gemeldet', 'test')" >/dev/null
echo "ok: передача из снятия вставлена"
p -c "INSERT INTO mailops_prod.buch_bewegung (art, von_konto, betrag_cent, status, von) VALUES ('verbrauch', 'halter:t', 100, 'bestaetigt', 'test')" >/dev/null
echo "ok: расход со счёта без получателя вставлен"

erwartet_fehler "INSERT INTO mailops_prod.buch_bewegung (art, von_konto, an_konto, betrag_cent, status, von) VALUES ('uebergabe', 'halter:t', 'halter:t', 100, 'gemeldet', 'test')" "передача самому себе"
erwartet_fehler "INSERT INTO mailops_prod.buch_bewegung (art, an_konto, betrag_cent, status, von) VALUES ('abhebung', 'halter:t', 100, 'bestaetigt', 'test')" "снятие со счётом-получателем"
erwartet_fehler "INSERT INTO mailops_prod.buch_bewegung (art, betrag_cent, status, von) VALUES ('abhebung', 0, 'bestaetigt', 'test')" "нулевая сумма"
erwartet_fehler "DELETE FROM mailops_prod.buch_bewegung WHERE id = $id" "удаление движения"
p -c "INSERT INTO mailops_prod.buch_ereignis (wer, rolle, art, ziel) VALUES ('t','t','t','t')" >/dev/null
erwartet_fehler "UPDATE mailops_prod.buch_ereignis SET art = 'x'" "правка журнала"

p -f app/migrations/001_kasse.down.sql >/dev/null
[[ "$(p -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='mailops_prod' AND table_name LIKE 'buch_%'")" == "0" ]] && echo "ok: откат убрал все таблицы 001"
p -f app/migrations/001_kasse.up.sql >/dev/null
echo "ok: повторная миграция вверх"
echo "МИГРАЦИЯ: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ"
