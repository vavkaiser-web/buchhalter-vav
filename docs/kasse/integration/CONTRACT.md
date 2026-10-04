# Контракт интеграции: Касса VAV ↔ VAV Kaiser (Учёт часов)

Версия: 1.0 · 2026-10-03 · design-only

## Границы владения

| Сущность | Создаёт | Читает | Не трогает |
|---|---|---|---|
| Заявка на аванс | vavapp (работник) | Касса VAV (бухгалтер) | — |
| Статус заявки | Касса VAV | vavapp (работник) | — |
| Чек расхода | vavapp (работник) | Касса VAV (бухгалтер) | — |
| Вопрос по чеку | Касса VAV (бухгалтер) | vavapp (работник) | — |
| Ответ на вопрос | vavapp (работник) | Касса VAV (бухгалтер) | — |
| Кассовый остаток | Касса VAV | Только Касса VAV | vavapp |
| Квитанция выдачи | Касса VAV | Касса VAV, vavapp (read) | — |

## API Эндпоинты

### vavapp → Касса VAV

```
POST /api/integration/vorschuss
  body: { ereignis_id, person_id, person_name, objekt_id, betrag_cent, zweck, erstellt_am }
  response: { ok, kasse_ref }
  Идемпотент: повторная отправка с тем же ereignis_id ← 200 + тот же kasse_ref

POST /api/integration/beleg
  body: { ereignis_id, person_id, betrag_cent, art, objekt_id, fahrzeug_id?, foto_url, erstellt_am }
  response: { ok, kasse_ref }

GET /api/integration/status/:kasse_ref
  response: { zustand, nachricht?, aktualisiert_am }
```

### Касса VAV → vavapp

```
POST /integration/kasse-ereignis  (на сервере vavapp)
  body: { kasse_ref, ereignis_id, zustand, nachricht?, zeitpunkt }
  auth: Bearer ${KASSE_INTEGRATION_TOKEN}
  Идемпотент: kasse_ref + zustand = unique constraint
```

## Состояния заявки (7 состояний)

```
ENTWURF           → черновик / ожидает отправки
EMPFANGEN         → получено сервером Кассы
PRUEFEN           → на проверке у бухгалтера
KLAEREN           → требуется уточнение (nachricht = вопрос)
ABGELEHNT         → отклонено (nachricht = причина)
BEWILLIGT         → одобрено, ожидает выдачи Олегом
AUSGEGEBEN        → деньги выданы (zeitpunkt = фактическое время)
```

## Требования к надёжности

- Очередь исходящих событий: таблица `kasse_ereignis_queue` (Касса) и `vavapp_ereignis_queue` (vavapp)
- Retry: экспоненциальный с max 6 попыток, затем задача ответственному
- Уникальный `ereignis_id` (UUID v4) генерирует отправитель
- `kasse_ref` генерирует Касса VAV при первом приёме
- Защита от повторов: `ON CONFLICT (ereignis_id) DO NOTHING` на обеих сторонах
- Версия сущности: `version INTEGER NOT NULL DEFAULT 1` + CHECK
- Устаревшие обновления: если `version` < текущей → 409 Conflict
- Журнал ошибок: таблица `integration_fehler` (kasse_ref, zeitpunkt, versuch, fehler)

## Авторизация

- `KASSE_INTEGRATION_TOKEN` — случайный 32-байтный токен, хранится в /opt/kasse-vav/.env
- vavapp принимает его как Bearer в заголовке Authorization
- Токен НЕ передаётся в браузер, НЕ логируется

## Что не реализовано в этой версии

- Часы и маршруты (следующий этап)
- Банковская выписка (только через Buchhalter)
- Push-уведомления
