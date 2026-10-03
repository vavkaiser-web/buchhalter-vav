-- Дополнение №5 Ф6 — комплекты для Steuerberater.
-- Передаются бумажные КОПИИ лично; оригиналы остаются у VAV (процесса возврата нет).
-- «Подготовлено» ≠ «передано». Эл. счёт: хранить исходный XML — бумага его не заменяет.
-- Повторная передача копии — отдельное событие, НЕ документ и НЕ проводка.

CREATE TABLE IF NOT EXISTS steuerberater_paket (
  id             serial PRIMARY KEY,
  firma          text NOT NULL,
  jahr           int  NOT NULL,
  monat          int,                 -- период (может быть годовой)
  nummer         text,                -- номер/идентификатор комплекта
  version        int  NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'vorbereitet',  -- vorbereitet | uebergeben
  vollstaendig   boolean NOT NULL DEFAULT true,        -- комплект полный?
  vorbereitet_von text, vorbereitet_am timestamptz DEFAULT now(),
  geprueft_von   text, geprueft_am timestamptz,
  kommentar      text,
  angelegt       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_paket_periode ON steuerberater_paket(firma, jahr, monat);

-- Состав комплекта: документы/копии, ссылки на эл. оригинал и исходный XML, недостающие.
CREATE TABLE IF NOT EXISTS steuerberater_paket_position (
  id          serial PRIMARY KEY,
  paket_id    int NOT NULL,
  bezeichnung text NOT NULL,
  beleg_ref   text,                 -- ссылка на документ/эл. оригинал
  xml_ref     text,                 -- исходный XML эл. счёта (бумага его не заменяет)
  status      text NOT NULL DEFAULT 'bereit',  -- bereit | fehlt
  notiz       text,
  angelegt    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_paket_pos ON steuerberater_paket_position(paket_id);

-- Передачи как отдельные прослеживаемые события (не документ, не проводка).
CREATE TABLE IF NOT EXISTS steuerberater_uebergabe (
  id         serial PRIMARY KEY,
  paket_id   int NOT NULL,
  art        text NOT NULL,         -- erstuebergabe | ergaenzung | erneut
  datum      date,
  an         text,                  -- кому передано (лично)
  umfang     text,                  -- что именно передано / какие позиции закрыты
  kommentar  text,
  autor      text NOT NULL,
  angelegt   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_paket_ueb ON steuerberater_uebergabe(paket_id, angelegt);
