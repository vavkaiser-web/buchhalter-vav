# Бухгалтер VAV — STATUS

Ветка: `buchhalter-vav`  
Worktree: `.claude/worktrees/buchhalter-vav`  
Порт: **3026** (accounting)

---

## Что сделано

### Этап 0 — Перенос из pilot (3 коммита)
- Перенесены все 17 модулей бухгалтера: `anfang`, `audit`, `aufgaben`, `bankabgleich`,
  `benachrichtigung`, `debitor`, `dokument`, `dublette`, `erinnerung`, `integration`,
  `kern`, `kern_dubletten`, `korrektur`, `monat`, `objekt`, `offline`, `steuerberater`
- Перенесены 18 SQL-схем в `app/sql/`
- Перенесены HTML-страницы бухгалтера (23 файла)
- Перенесён `app/server.js` с общими страницами

### Этап 1 — Контроль счёта против заказа/договора
**Модуль:** `app/rechnung_kontrolle.js`  
**SQL-схема:** `app/sql/dop_rechnung_kontrolle.sql`  
**HTTP-маршруты:** добавлены в `app/server.js`  
**Тесты:** `test-dop-rechnung.cjs`

Реализованные проверки (9 правил из 10 — правило про нарезку заказа в bestellung gate):
1. Подрядчик в счёте совпадает с заказом
2. Сумма счёта не превышает сумму заказа (накопительно)
3. Итоговый счёт (schlussrechnung): Σ всех предыдущих + этот = сумма заказа
4. Различение fakturiert (выставлено) vs bezahlt (оплачено)
5. Документная задача создаётся при неполноте (без дублирования открытых)
6. Срок оплаты с причиной задержки (обзор для Андрея)
7. Исключение — только Андрей (gf), сохраняет: основание, дату, хэш версии счёта
8. Исключение НЕ отключает проверку дублетов и IBAN-стоп
9. После оплаты задача по документам остаётся открытой

Эскалация: бухгалтер → задача Олегу → Олег передаёт Андрею → Андрей одобряет/отклоняет.

HTTP-маршруты (все требуют роль `gf` или `buchhaltung`):
- `POST /api/rechnung/pruefung` — запустить проверку
- `GET  /api/rechnung/pruefung` — список прогонов
- `GET  /api/rechnung/pruefung/eins?id=N` — один прогон с деталями
- `POST /api/rechnung/ausnahme-beantragen` — запрос исключения (бухгалтер)
- `POST /api/rechnung/ausnahme-andrej` — передать запрос Андрею (Олег, роль `disponent`)
- `POST /api/rechnung/ausnahme-genehmigen` — утвердить исключение (только `gf`)
- `GET  /api/rechnung/faellig` — просрочки / срочные платежи
- `POST /api/rechnung/nach-zahlung` — проверить задачу после оплаты

---

## Граница работ

| Область | Сессия |
|---|---|
| Контроль счёта vs заказ, bankabgleich, dokument, объектная экономика, monat, steuerberater | **buchhalter-vav** (эта) |
| kasse-модуль, роли disponent/mitarbeiter, /arbeit, учёт часов | kasse-vav (отдельно) |
| Боевой сервер `/opt/vav-platform` | не трогать |

---

## Дополнения Этапа 1 (завершены)

- [x] **HTML-страница `/rechnung`** — `app/public/rechnung-kontrolle.html` (3 вкладки: проверить счёт, список прогонов, просрочки; роль-зависимые кнопки исключения)
- [x] **Webhook bezahlt** — `server.js`: после `markieren(bezahlt=true)` вызывает `rk.nachZahlungPruefen()` async fire-and-forget
- [x] **Lieferant-matching fix** — `norm()` (ü→ue, ö→oe, ä→ae, ß→ss, юр. суффиксы); сравнение по полному имени `beleg.lieferant` с fallback на `lieferant_key`
- [x] **Kasse-заглушка** `app/kasse/api.js` — GET возвращает 200 с пустой структурой (zentrum/rolle.js загружается без 503)
- [x] **32/32 тестов** — `test-dop-rechnung.cjs` (13 сценариев)

- [x] **UTA-интеграция** — `dublette.js`: `kandidaten()` перекрёстно матчит `quelle='uta'` vs не-UTA по дате+сумме → `moeglicher_dubup`; 5 сценариев в `test-uta-dublette.cjs` (13/13 ✓). Флоу разрешения: `verknuepfen(art='operation')` + `entscheiden('separate')`.

- [x] **Правило 10 — bestellung gate** (`app/bestellung_gate.js`): порог 3.000 €, нарезка (≥2 заказа тому же поставщику за 60 дней >порога), Олег ≤3k, Олег+Андрей >3k/нет бюджета, без делегирования при отсутствии Андрея. `genehmigt` без гейт-записей → пропускается (backward compat). 5 маршрутов `/api/bestellung/gate/*`. 17/17 тестов в `test-bestellung-gate.cjs`. Итого: 62 ✓ 0 ✗.

- [x] **belegGeaendert** (`app/server.js` + `rechnung-kontrolle.html`): маршрут `POST /api/rechnung/beleg-geaendert` + кнопка «Файл заменён» в форме. Сбрасывает активные исключения с устаревшим `beleg_hash`; возвращает число сброшенных. Коммит `6682e0d`.

## Этап 2 — Bankabgleich (завершён)

Модуль, SQL-схема, маршруты и HTML перенесены в Этапе 0. В Этапе 2 добавлен тест-сюит.

- [x] **`test-bankabgleich.cjs`** — 7 сценариев, 31/31 ✓ (коммит `b2c9f0a`):
  1. Импорт идемпотентен по `extern_id`
  2. `vorschlag`: ключ контрагента + номер счёта → `stark`
  3. Полная оплата: `beleg.bezahlt=true`, `status=zugeordnet`
  4. Частичная оплата: `beleg` открыт; платёж полностью/частично распределён → `zugeordnet`/`teilweise`
  5. Сторно распределения: `beleg.bezahlt=false` восстанавливается
  6. Переплата: `ueberzahlung`, решение `verrechnung`/`rueckzahlung`
  7. Возврат: `rueckbuchung` → `bestaetigen` → `beleg` открывается

Страница `/bank` работает, данные из демо-БД загружаются.

**Итого тестов: 93 ✓ 0 ✗** (32 + 13 + 17 + 31)

## Этап 3 — Monat (завершён)

- [x] **`app/sql/dop_monat.sql`** — схема `monatsstatus` + `monatsstatus_log` (коммит `3cdfd56`)
- [x] **`test-monat.cjs`** — 6 сценариев, 24/24 ✓:
  1. `uebersicht`: 2 фирмы × 12 месяцев, каталог 6 статусов
  2. Цепочка `gesammelt → geprueft → natalia_geprueft → paket_uebergeben` + лог
  3. Идемпотентность: тот же статус → `unchanged`
  4. Права: обычный `buchhaltung` не может `natalia_geprueft`; `gf` — может
  5. `wiedervorlage`: поставить / снять; реподтверждение Натальей сбрасывает флаг
  6. Валидация: неверная фирма, месяц 13, неизвестный статус

Страница `/monat` работает: год 2026, реальные статусы из БД.

**Итого тестов: 117 ✓ 0 ✗** (32 + 13 + 17 + 31 + 24)

## Этап 4 — Steuerberater (завершён)

- [x] **`test-steuerberater.cjs`** — 5 сценариев, 37/37 ✓ (коммит `7ea65ef`):
  1. Ф4 bestätigung schriftlich: валидация (неверный вид, нет dokument_ref) + создание + art_text
  2. Ф4 bestätigung telefonisch: валидация (нет mit_wem, нет vereinbart) + создание
  3. Ф6 pakete: полный цикл — anlegen → positionAdd(fehlt) → vollständig=false → positionStatus(bereit) → vollständig=true → paketUebergeben → статус uebergeben
  4. Ф7 fragen: полный цикл — anlegen → frageZuweisen → antwortAnlegen → frageEins(antwort_vorbereitet) → antwortPruefen(ok) → natalia_geprueft → frageInPaket → im_paket
  5. Ф7 nachfrage: antwortPruefen(ok=false) → nachfrage; frageInPaket без natalia_geprueft → ошибка; frageListe фильтр

**Итого тестов: 154 ✓ 0 ✗** (32 + 13 + 17 + 31 + 24 + 37)

## Этап 5 — Debitor (завершён)

- [x] **`test-debitor.cjs`** — 7 сценариев, 32/32 ✓ (коммит `4260a0a`):
  1. eingangImport: идемпотентность по extern_id; задача при нераспределённом
  2. vorschlag + zuordnen: полная оплата нашего счёта → zugeordnet
  3. zuordnen: нельзя распределить больше суммы поступления → ошибка
  4. zuordnungStorno: снятие распределения → nicht_zugeordnet; идемпотентность
  5. ueberzahlungKunde: переплата 200 € → kredit (anzahlung), статус ueberzahlt
  6. unterzahlung + einbehaltErfassen (с датой → bestaetigt) + ereignis_abhaengig (без срока)
  7. mahnWarnung: нераспределённое поступление от клиента → warnung перед напоминанием

**Итого тестов: 186 ✓ 0 ✗** (32 + 13 + 17 + 31 + 24 + 37 + 32)

## Полный прогон (2026-10-03)

Все 7 тест-файлов прошли без ошибок:

| Файл | ✓ |
|---|---|
| test-dop-rechnung.cjs | 32 |
| test-uta-dublette.cjs | 13 |
| test-bestellung-gate.cjs | 17 |
| test-bankabgleich.cjs | 31 |
| test-monat.cjs | 24 |
| test-steuerberater.cjs | 37 |
| test-debitor.cjs | 32 |
| **Итого** | **186 ✓ 0 ✗** |

---

## Запуск

```bash
# Запустить сервер в worktree
PILOT_IMPORT_DB=postgres://... node app/server.js

# Запустить тесты (отдельная тест-БД)
PILOT_IMPORT_DB=postgres://...testdb... node test-dop-rechnung.cjs

# Применить новую схему
PILOT_IMPORT_DB=postgres://... psql < app/sql/dop_rechnung_kontrolle.sql
```

Перед запуском убедиться, что `app/sql/dop_dublette.sql` и `app/sql/dop_bankabgleich.sql` уже применены (зависимости: таблица `beleg`, `bestellung`, `bestellung_rechnung`, `zahlung_zuordnung`).
