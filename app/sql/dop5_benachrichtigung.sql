-- Дополнение №5 Ф5 — уведомления Андрею об изменении показанных прибыли/налога/долга.
-- Одно исправление = одно сообщение (объединяем изменения), дедуп по источнику.
-- Различаем предварительное влияние запроса и уже применённое исправление.

CREATE TABLE IF NOT EXISTS benachrichtigung (
  id            serial PRIMARY KEY,
  ziel          text NOT NULL DEFAULT 'gf',   -- кому (владелец)
  quelle        text,                          -- 'korrektur:2' — для дедупа
  vorlaeufig    boolean NOT NULL DEFAULT false,-- предварительное влияние (true) vs применённое (false)
  firma         text, jahr int, monat int, objekt_nr text,
  aenderungen   jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{art:'ergebnis|steuer|schuld', alt, neu}]
  grund         text,
  wer_bestaetigt text,                         -- кто подтвердил (Наталья)
  basis         text,                          -- основание согласования (письмо/телефон Steuerberater)
  status        text NOT NULL DEFAULT 'offen', -- offen | gesehen
  angelegt      timestamptz NOT NULL DEFAULT now(),
  gesehen_am    timestamptz
);
-- дедуп: одно применённое и одно предварительное сообщение на источник
CREATE UNIQUE INDEX IF NOT EXISTS ux_benach_quelle ON benachrichtigung(quelle, vorlaeufig) WHERE quelle IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_benach_ziel ON benachrichtigung(ziel, status, angelegt);
