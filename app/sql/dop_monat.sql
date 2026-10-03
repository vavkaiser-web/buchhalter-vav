-- Статус периода (месяца) по фирмам VAV Kaiser.
-- Не подача отчётности и не годовое закрытие — внутренний учёт этапов.
-- 6 состояний: gesammelt → geprueft → natalia_geprueft →
--              paket_uebergeben → erklaerung_eingereicht → jahr_zu

CREATE TABLE IF NOT EXISTS monatsstatus (
  id            serial PRIMARY KEY,
  firma         text NOT NULL,                    -- kaiser | trockenbau
  jahr          integer NOT NULL,
  monat         integer NOT NULL,                 -- 1..12
  status        text NOT NULL DEFAULT 'gesammelt',
  wiedervorlage boolean NOT NULL DEFAULT false,   -- требует повторной проверки Натальей
  natalia_von   text,                             -- login ответственного при natalia_geprueft
  natalia_am    timestamptz,
  notiz         text,
  stand         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (firma, jahr, monat)
);

-- Append-only журнал переходов.
CREATE TABLE IF NOT EXISTS monatsstatus_log (
  id       serial PRIMARY KEY,
  firma    text NOT NULL,
  jahr     integer NOT NULL,
  monat    integer NOT NULL,
  von      text,      -- статус до
  nach     text,      -- статус после
  ereignis text,      -- statuswechsel | rebestaetigung | wiedervorlage_an | wiedervorlage_ab
  autor    text,
  notiz    text,
  wann     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_monatslog ON monatsstatus_log (firma, jahr, monat, wann);
