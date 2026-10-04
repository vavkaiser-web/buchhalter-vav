-- Сверка банковских платежей со счетами. Всё в buchpilot (тест). Боевую базу не трогаем.
-- Банковский источник — существующий (в бою FinMap/синхронизация банка); здесь его
-- локальное представление, идемпотентное по extern_id. Второй параллельный учёт не заводим.

-- Банковское движение (перевод/списание/поступление). Один ряд = одна операция банка.
CREATE TABLE IF NOT EXISTS bank_bewegung (
  id            serial PRIMARY KEY,
  extern_id     text UNIQUE,          -- id операции банка (идемпотентность импорта)
  richtung      text DEFAULT 'ausgang',-- ausgang (платёж) | eingang (поступление)
  betrag_cent   bigint NOT NULL,      -- абсолютная сумма операции
  waehrung      text DEFAULT 'EUR',
  datum         date,
  gegenpartei   text,
  gegenpartei_key text,
  verwendungszweck text,
  iban          text,
  konto         text,
  art           text DEFAULT 'ueberweisung', -- ueberweisung | lastschrift (автосписание)
  status        text DEFAULT 'nicht_zugeordnet', -- nicht_zugeordnet|teilweise|zugeordnet|ueberzahlt|rueckbuchung_pruefen|zurueckgebucht
  ueberzahlung_entscheidung text,      -- rueckzahlung | verrechnung (решение по переплате)
  pruef_frist   date,                  -- срок разбора (1 р.д.)
  storniert     boolean DEFAULT false,
  import_am     timestamptz DEFAULT now(),
  notiz         text,
  von           text
);
CREATE INDEX IF NOT EXISTS bb_key ON bank_bewegung(gegenpartei_key);
CREATE INDEX IF NOT EXISTS bb_status ON bank_bewegung(status);

-- Распределение платежа на счета (beleg). Автор/дата/основание. Skonto — отдельно.
CREATE TABLE IF NOT EXISTS zahlung_zuordnung (
  id          serial PRIMARY KEY,
  bewegung_id int NOT NULL,
  beleg_id    int NOT NULL,
  betrag_cent bigint NOT NULL,         -- сумма платежа, отнесённая на счёт
  skonto_cent bigint DEFAULT 0,        -- скидка (хранится отдельно от платежа)
  art         text DEFAULT 'zahlung',  -- zahlung | skonto
  storniert   boolean DEFAULT false,
  grund       text,
  von         text,
  am          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zz_bew ON zahlung_zuordnung(bewegung_id);
CREATE INDEX IF NOT EXISTS zz_beleg ON zahlung_zuordnung(beleg_id);

-- История/задачи: возвраты, нераспределённые, расхождения, переплаты, Skonto, сторно.
CREATE TABLE IF NOT EXISTS zahlung_ereignis (
  id          serial PRIMARY KEY,
  bewegung_id int,
  beleg_id    int,
  art         text NOT NULL,
  text        text,
  betrag_cent bigint,
  aufgabe_id  text,
  von         text,
  am          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ze_bew ON zahlung_ereignis(bewegung_id);

-- Атрибуты оплаты счёта (автосписание). Skonto пишется в zahlung_zuordnung.
ALTER TABLE beleg ADD COLUMN IF NOT EXISTS autolastschrift boolean DEFAULT false;
ALTER TABLE beleg ADD COLUMN IF NOT EXISTS auto_faellig date;

-- Append-only история: ереignis не удаляем/не меняем; распределения снимаем флагом storniert.
CREATE OR REPLACE FUNCTION bank_kein_loeschen() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Удаление истории сверки запрещено (append-only)'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS ze_append ON zahlung_ereignis;
CREATE TRIGGER ze_append BEFORE UPDATE OR DELETE ON zahlung_ereignis
  FOR EACH ROW EXECUTE FUNCTION bank_kein_loeschen();
DROP TRIGGER IF EXISTS zz_append ON zahlung_zuordnung;
CREATE TRIGGER zz_append BEFORE DELETE ON zahlung_zuordnung
  FOR EACH ROW EXECUTE FUNCTION bank_kein_loeschen();
