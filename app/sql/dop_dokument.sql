-- Контроль полноты документов. Расширяет поиск документов, сверку и задачи.
-- Ничего не дублируем: причина «Нет подтверждающего документа» добавляется к
-- существующей задаче по нераспределённому платежу (её срок и уведомления).
-- Всё в buchpilot (тест). Реальные данные и история сохраняются.

-- Статус проверки документа (комплект/полнота). Skonto/оплаты — в других таблицах.
ALTER TABLE beleg ADD COLUMN IF NOT EXISTS dok_status text DEFAULT 'offen';  -- offen | unvollstaendig | geprueft
ALTER TABLE beleg ADD COLUMN IF NOT EXISTS dok_geprueft_von text;
ALTER TABLE beleg ADD COLUMN IF NOT EXISTS dok_geprueft_am timestamptz;

-- Лог поиска подтверждающего документа по банковской операции (append-only).
CREATE TABLE IF NOT EXISTS dok_suche (
  id            serial PRIMARY KEY,
  bewegung_id   int NOT NULL,
  ergebnis      text NOT NULL,        -- gefunden | mehrere | nicht_gefunden | nicht_abgeschlossen
  quellen       jsonb,                -- проверенные источники и их состояние
  grenzen       jsonb,                -- границы поиска (что не проверено и почему)
  kandidaten    jsonb,                -- найденные кандидаты с совпадениями/расхождениями
  von           text,
  am            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ds_bew ON dok_suche(bewegung_id);

-- Подтверждённая бухгалтером связь операция ↔ документ.
CREATE TABLE IF NOT EXISTS dok_verknuepfung (
  id           serial PRIMARY KEY,
  bewegung_id  int NOT NULL,
  beleg_id     int NOT NULL,
  grund        text,
  von          text,
  am           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dv_bew ON dok_verknuepfung(bewegung_id);
CREATE INDEX IF NOT EXISTS dv_beleg ON dok_verknuepfung(beleg_id);

-- Неполнота/нечитаемость документа. Предположения (vermutet) ≠ достоверные пропуски (bestaetigt).
CREATE TABLE IF NOT EXISTS dok_mangel (
  id           serial PRIMARY KEY,
  beleg_id     int NOT NULL,
  art          text NOT NULL,        -- seite_fehlt | anhang_fehlt | unleserlich | feld_zweifel
  feld         text,                 -- какое поле под сомнением (сумма/номер/реквизиты)
  sicherheit   text DEFAULT 'bestaetigt', -- vermutet | bestaetigt
  beschreibung text,
  status       text DEFAULT 'offen', -- offen | erledigt
  von          text,
  erledigt_von text,
  am           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dm_beleg ON dok_mangel(beleg_id);

-- append-only (используем существующую функцию-страж из сверки)
DROP TRIGGER IF EXISTS ds_append ON dok_suche;
CREATE TRIGGER ds_append BEFORE UPDATE OR DELETE ON dok_suche FOR EACH ROW EXECUTE FUNCTION bank_kein_loeschen();
DROP TRIGGER IF EXISTS dv_append ON dok_verknuepfung;
CREATE TRIGGER dv_append BEFORE DELETE ON dok_verknuepfung FOR EACH ROW EXECUTE FUNCTION bank_kein_loeschen();
