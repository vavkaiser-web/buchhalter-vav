# Касса VAV — критерии приёмки

## Gate 0: Скелет — ЗАКРЫТ ✅ (2026-10-03)

### Проверено
- [x] Сервер стартует на порту 3127 без ошибок
- [x] Вход с ролью `buchhaltung` → 200, cookie `kassesess`
- [x] Вход с ролью `buero` → 403
- [x] Вход с неверным PIN → 401
- [x] `/api/ich` без сессии → 401
- [x] `/api/ich` с сессией → 200, правильная роль
- [x] `/api/integration/*` без токена → 401
- [x] Path traversal → не 200
- [x] Тесты: 24 ✓, 0 ✗
- [x] Desktop 1100px: правильный дизайн, цвета, шрифт
- [x] Mobile 400px: горизонтальная навигация, адаптивный хедер
- [x] Иконки Lucide загружаются
- [x] Корневые ресурсы (icon-192.png, vendor/lucide.min.js) доступны

## Gate 1: БД — ЗАКРЫТ ✅ (2026-10-03)

### Проверено
- [x] Миграция 002_kasse_integration.up.sql применена без ошибок
- [x] `/api/k/lage` возвращает 200 с данными (konten, belege, plaene, personen, objekte...)
- [x] Рабочий стол: остатки (Основная касса 0,00€, У Олег 1,00€), последние движения ✓
- [x] Очередь: загружается, "Очередь пуста" (нет входящих) ✓
- [x] Касса: журнал движений, Передача наличных 25 Sept. → Олег 1,00€ ✓
- [x] Запросы: "Открытых вопросов нет" ✓
- [x] npm пакет pg установлен в app/node_modules/
- [x] BUCH_MAILOPS_ENV= путь к mailops.env dev базы
- [ ] Создание плана аванса сохраняется в БД (Gate 1.5)
- [ ] Загрузка чека сохраняется в БД (Gate 1.5)
- [ ] Смена статуса работает через state machine (Gate 1.5)

## Gate 2: Интеграция — ЗАКРЫТ ✅ (2026-10-03)

### Проверено
- [x] vavapp → kasse: POST /api/integration/vorschuss → 200, kasse_ref = EA-<id>
- [x] Идемпотентность: повторный запрос с тем же ereignis_id → bereits_vorhanden=true
- [x] kasse → vavapp: очередь kasse_ereignis_queue → POST /integration/kasse-ereignis в ~30с
- [x] Статус: GET /api/integration/status/EA-<id> → zustand=EMPFANGEN
- [x] Аутентификация обоих направлений через Bearer KASSE_INTEGRATION_TOKEN
- [x] E2E тест: 9 ✓, 0 ✗
- [x] Миграция 040_kasse_integration.sql создаёт kasse_antrag в vavapp_prod
- [x] vavapp принимает события от Кассы: POST /integration/kasse-ereignis (Bearer)

### Компоненты
- `kasse/integratsiya.js` — приём заявок, очередь событий, планировщик 30с
- `migrations/040_kasse_integration.sql` — таблица kasse_antrag в vavapp_prod
- `src/kasse-integration.ts` — клиент и обработчик событий для vavapp
- `src/server.ts` — эндпоинты /api/kasse/vorschuss, /api/kasse/antraege, /integration/kasse-ereignis

## Gate 3: Продакшн — ЗАКРЫТ ✅ (2026-10-03)

### Проверено
- [x] nginx config применён, SSL работает (https://kasse-178-105-169-97.sslip.io)
- [x] pm2 запускает сервис через start.sh (set -a; source .env; exec node) — env vars сохраняются при перезагрузке
- [x] Миграции 001 и 002 применены в prod Supabase (buch_konto, buch_plan, buch_beleg и др.)
- [x] vavapp интеграция задеплоена (kasse-integration.ts, kasse_antrag, KASSE_INTEGRATION_TOKEN)
- [x] Пользователь andrei (gf/владелец) добавлен, вход и рабочий стол работают
- [ ] SW кэширует страницы в HTTPS-окружении (следующий этап)
- [ ] Мониторинг ошибок настроен (следующий этап)

## Gate 4: Кассовые операции — ЗАКРЫТ ✅ (2026-10-03)

### Проверено
- [x] "+ Аванс" в Очередь → форма "Заявка на аванс" (Получатель + Сумма + Назначение)
- [x] Отправка формы → `POST /api/k/plan/einfach` → план сохранён в `buch_geldplan` (Черновик)
- [x] Очередь показывает счётчик (+1) и план в списке "Входящие"
- [x] Уведомление "Заявка на аванс подана" после сохранения
- [x] SW v2 (kasse-vav-v2) — обновление кэша без ручного сброса
- [x] `eingaenge` (kasse_extern_anfrage) возвращаются в `/api/k/lage` для буро-ролей
- [x] `eingang/:id/bewilligen` и `eingang/:id/ablehnen` — маршруты GF-одобрения EA-запросов

### Компоненты
- `kasse/dienst.js` — `planEinfach()`, `eingangBewilligen()`, `eingangAblehnen()`, `eingaenge` в `lage()`
- `kasse/api.js` — маршруты `plan/einfach`, `eingang/:id/bewilligen`, `eingang/:id/ablehnen`
- `public/kasse/index.html` — "+ Аванс" кнопка, форма плана, блок "От VAV App", EA-детали
- `public/kasse/sw.js` — версия кэша `kasse-vav-v2`
