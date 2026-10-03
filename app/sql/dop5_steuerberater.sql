-- Дополнение №5 Ф4 — исправления, требующие согласования со Steuerberater.
-- Явно различаем ПИСЬМЕННОЕ подтверждение и ЗАПИСЬ ТЕЛЕФОННОГО согласования.

ALTER TABLE korrektur_antrag ADD COLUMN IF NOT EXISTS steuerberater_pflicht boolean NOT NULL DEFAULT false;
ALTER TABLE korrektur_antrag ADD COLUMN IF NOT EXISTS betroffen text;
-- betroffen: eingereichte_erklaerung | geschlossener_zeitraum | jahresabschluss

CREATE TABLE IF NOT EXISTS steuerberater_bestaetigung (
  id            serial PRIMARY KEY,
  korrektur_id  int,                 -- к какому исправлению относится (может быть NULL)
  art           text NOT NULL,       -- 'schriftlich' | 'telefonisch'  (НЕ смешивать)
  datum         date,
  -- письменное:
  dokument_ref  text,                -- ссылка на письмо/документ Steuerberater
  -- телефонное (запись Натальи о согласовании):
  mit_wem       text,                -- с кем говорили
  besprochen    text,                -- какие документы обсуждались
  vereinbart    text,                -- согласованные изменения
  betraege_perioden text,            -- суммы/периоды/условия
  weiter        text,                -- дальнейшие действия
  auswirkung    text,                -- расчёт влияния
  autor         text NOT NULL,
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_stb_best ON steuerberater_bestaetigung(korrektur_id, angelegt);
