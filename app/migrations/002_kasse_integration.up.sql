-- Миграция 002: таблицы интеграции Касса VAV ↔ vavapp
-- Применять только к базам с уже существующей схемой mailops_prod (миграция 001).
-- Идемпотентна: использует IF NOT EXISTS / ON CONFLICT.

SET search_path = mailops_prod, public;

-- Очередь исходящих событий в vavapp.
CREATE TABLE IF NOT EXISTS kasse_ereignis_queue (
  id                BIGSERIAL PRIMARY KEY,
  kasse_ref         TEXT        NOT NULL,
  ereignis_id       UUID        NOT NULL UNIQUE,
  zustand           TEXT        NOT NULL
                      CHECK (zustand IN ('ENTWURF','EMPFANGEN','PRUEFEN','KLAEREN',
                                         'ABGELEHNT','BEWILLIGT','AUSGEGEBEN')),
  nachricht         TEXT,
  zeitpunkt         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  versuche          SMALLINT    NOT NULL DEFAULT 0,
  naechster_versuch TIMESTAMPTZ,
  verarbeitet_am    TIMESTAMPTZ,
  fehler            TEXT
);
CREATE INDEX IF NOT EXISTS kasse_ereignis_queue_pending
  ON kasse_ereignis_queue (naechster_versuch)
  WHERE verarbeitet_am IS NULL;

-- Журнал входящих заявок/чеков от vavapp.
CREATE TABLE IF NOT EXISTS kasse_extern_anfrage (
  id             BIGSERIAL   PRIMARY KEY,
  ereignis_id    UUID        NOT NULL UNIQUE,
  quelle         TEXT        NOT NULL DEFAULT 'vavapp',
  art            TEXT        NOT NULL CHECK (art IN ('vorschuss','beleg')),
  person_id      TEXT,
  person_name    TEXT,
  objekt_id      TEXT,
  fahrzeug_id    TEXT,
  betrag_cent    BIGINT,
  zweck          TEXT,
  foto_url       TEXT,
  rohdaten       JSONB       NOT NULL DEFAULT '{}',
  kasse_ref      TEXT,
  erstellt_am    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verarbeitet_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS kasse_extern_anfrage_person
  ON kasse_extern_anfrage (person_id);

-- Журнал ошибок интеграции.
CREATE TABLE IF NOT EXISTS integration_fehler (
  id         BIGSERIAL   PRIMARY KEY,
  kasse_ref  TEXT,
  zeitpunkt  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  versuch    SMALLINT,
  fehler     TEXT
);

COMMENT ON TABLE kasse_ereignis_queue IS
  'Исходящие события статусов из Кассы VAV в vavapp. Retry до 6 раз с экспоненциальной задержкой.';
COMMENT ON TABLE kasse_extern_anfrage IS
  'Входящие заявки на аванс и чеки из vavapp. Уникальность по ereignis_id (защита от повторов).';
