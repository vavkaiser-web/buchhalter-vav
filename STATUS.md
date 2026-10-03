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

## Что НЕ сделано (следующие этапы)

- [ ] Интеграция с UTA (исключить двойной расход: чек + UTA) — через `dublette.js`
- [ ] Правило 10 (нарезка заказа против порога) — bestellung gate (`dop_bestellung_gate.sql`)
- [ ] `belegGeaendertPruefen` — вызов при замене файла счёта; маршрут `POST /api/rechnung/beleg-geaendert` есть, UI-кнопка не добавлена

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
