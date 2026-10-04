-- Дополнение №5 — схема (пилот, buchpilot). Боевые данные не трогаем.

-- Ф1. Состояние месяца по фирме. 6 состояний, «Месяц проверен Натальей» — внутренний статус.
CREATE TABLE IF NOT EXISTS monatsstatus (
  id            serial PRIMARY KEY,
  firma         text NOT NULL,                    -- 'kaiser' | 'trockenbau'
  jahr          int  NOT NULL,
  monat         int  NOT NULL,                    -- 1..12
  status        text NOT NULL DEFAULT 'gesammelt',
  -- gesammelt · geprueft · natalia_geprueft · paket_uebergeben · erklaerung_eingereicht · jahr_zu
  wiedervorlage boolean NOT NULL DEFAULT false,   -- Ф3: есть изменения, требующие повторной проверки
  natalia_von   text,                             -- кто поставил natalia_geprueft
  natalia_am    timestamptz,
  notiz         text,
  stand         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(firma, jahr, monat)
);

-- История переходов статуса месяца (§13).
CREATE TABLE IF NOT EXISTS monatsstatus_log (
  id       serial PRIMARY KEY,
  firma    text NOT NULL,
  jahr     int  NOT NULL,
  monat    int  NOT NULL,
  von      text,            -- прежний статус
  nach     text,            -- новый статус
  ereignis text,            -- statuswechsel | wiedervorlage_an | wiedervorlage_ab
  autor    text,
  notiz    text,
  wann     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_monatslog ON monatsstatus_log(firma, jahr, monat, wann);
