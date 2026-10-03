-- Контроль входящего счёта (beleg) против заказа (bestellung).
-- Правила: превышение суммы заказа → задача Олегу, счёт не в «готов к оплате»;
-- доп.работы → задача через Олега; итоговый счёт проверяет всю цепочку;
-- исключение — только Андрей, с основанием и версией счёта; после оплаты — задача по документам не закрывается.

-- Прогон проверки: один prueflauf на каждое соответствие beleg ↔ bestellung (или только beleg).
CREATE TABLE IF NOT EXISTS rechnung_prueflauf (
  id              serial PRIMARY KEY,
  beleg_id        int,                        -- входящий счёт (beleg.id), nullable если беглый прогон
  bestellung_id   int,                        -- заказ (bestellung.id), nullable если нет совпадения
  lieferant       text,                       -- поставщик/подрядчик из beleg
  lieferant_key   text,                       -- нормализованный ключ поиска
  objekt_nr       text,                       -- объект из bestellung (или null)
  betrag_cent     bigint,                     -- сумма счёта в центах
  art             text,                       -- teilrechnung | schlussrechnung | korrektur
  ergebnis        text NOT NULL DEFAULT 'offen',
                                              -- offen | ok | hinweis | pruefen | blockiert | ausnahme_genehmigt
  aufgabe_id      text,                       -- id задачи (без дублирования)
  von             text,                       -- кто запустил проверку
  angelegt        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rkp_beleg   ON rechnung_prueflauf (beleg_id, angelegt DESC);
CREATE INDEX IF NOT EXISTS ix_rkp_best    ON rechnung_prueflauf (bestellung_id, angelegt DESC);
CREATE INDEX IF NOT EXISTS ix_rkp_ergeb   ON rechnung_prueflauf (ergebnis, angelegt DESC);

-- Отдельные позиции проверки: по каждому критерию отдельная строка.
CREATE TABLE IF NOT EXISTS rechnung_pruef_item (
  id              serial PRIMARY KEY,
  prueflauf_id    int NOT NULL REFERENCES rechnung_prueflauf(id),
  art             text NOT NULL,
                  -- lieferant | objekt | summe | kette | schluss | nachtrag | dokument | faellig
  status          text NOT NULL DEFAULT 'ok',
                  -- ok | hinweis | abweichung | blockiert | fehlt
  soll_cent       bigint,                     -- ожидаемая сумма (для summe/kette/schluss)
  ist_cent        bigint,                     -- фактическая сумма
  diff_cent       bigint,                     -- разница (ist - soll)
  notiz           text,                       -- объяснение для бухгалтера
  angelegt        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rki_lauf ON rechnung_pruef_item (prueflauf_id);

-- Исключение, утверждённое Андреем. Одно активное исключение на связку beleg+bestellung.
CREATE TABLE IF NOT EXISTS rechnung_ausnahme (
  id              serial PRIMARY KEY,
  prueflauf_id    int NOT NULL,
  beleg_id        int NOT NULL,
  bestellung_id   int,
  betrag_cent     bigint NOT NULL,            -- сумма счёта на момент утверждения
  beleg_hash      text,                       -- datei_hash из beleg (изменился → требуется повторная проверка)
  grund           text NOT NULL,              -- основание исключения (обязательно)
  basis           text,                       -- ссылка на документ/решение
  genehmigt_von   text NOT NULL,              -- только gf
  genehmigt_am    timestamptz NOT NULL DEFAULT now(),
  -- Исключение НЕ отключает проверку на дублеты и остановку при смене IBAN.
  -- Эти флаги всегда true — храним явно для ясности.
  iban_check_aktiv      boolean NOT NULL DEFAULT true,
  duplikat_check_aktiv  boolean NOT NULL DEFAULT true,
  aktiv           boolean NOT NULL DEFAULT true,  -- снимается при изменении счёта или отзыве
  angelegt        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rka_beleg ON rechnung_ausnahme (beleg_id, aktiv);

-- Запрос исключения (бухгалтер → Андрей через Олега).
CREATE TABLE IF NOT EXISTS rechnung_ausnahme_anfrage (
  id              serial PRIMARY KEY,
  prueflauf_id    int NOT NULL,
  beleg_id        int NOT NULL,
  bestellung_id   int,
  ueberschuss_cent bigint,                    -- сумма превышения
  grund           text,                       -- объяснение бухгалтера
  notiz           text,                       -- дополнительный контекст (доп.работы, причина)
  status          text NOT NULL DEFAULT 'offen',
                  -- offen | an_oleg | an_andrej | genehmigt | abgelehnt
  aufgabe_id_oleg text,
  aufgabe_id_andrej text,
  von             text NOT NULL,
  angelegt        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rkaa_beleg ON rechnung_ausnahme_anfrage (beleg_id, status);
