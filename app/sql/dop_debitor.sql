-- Поступления от заказчиков и контроль дебиторской задолженности.
-- Расширяет существующую сверку (bank_bewegung + zahlung_zuordnung), не заводя второй учёт.
-- Счета клиентам — существующая таблица ausgang_rechnung. Всё в buchpilot (тест).

-- Срок оплаты и клиент для контроля дебиторки (дополнение существующей таблицы).
ALTER TABLE ausgang_rechnung ADD COLUMN IF NOT EXISTS faellig date;
ALTER TABLE ausgang_rechnung ADD COLUMN IF NOT EXISTS kunde text;
ALTER TABLE ausgang_rechnung ADD COLUMN IF NOT EXISTS kunde_key text;

-- Одно распределение = деньги перевода на один счёт: поставщика (beleg_id) ИЛИ наш клиенту (ausgang_id).
ALTER TABLE zahlung_zuordnung ADD COLUMN IF NOT EXISTS ausgang_id int;
ALTER TABLE zahlung_zuordnung ALTER COLUMN beleg_id DROP NOT NULL;   -- beleg_id ИЛИ ausgang_id
ALTER TABLE zahlung_ereignis  ADD COLUMN IF NOT EXISTS ausgang_id int;
ALTER TABLE zahlung_ereignis  ADD COLUMN IF NOT EXISTS kunde text;

-- Гарантийное удержание (со стороны дебиторки): отдельно, но не теряется из контроля долга.
CREATE TABLE IF NOT EXISTS debitor_einbehalt (
  id            serial PRIMARY KEY,
  ausgang_id    int,                 -- исходный счёт
  kunde         text,
  objekt_nr     text,
  betrag_cent   bigint NOT NULL,
  grundlage     text,                -- договорное основание
  bedingungen   text,                -- условия возврата
  rueckgabe     date,                -- ожидаемый срок возврата (если известен)
  ereignis_abhaengig boolean DEFAULT false, -- срок зависит от события -> «Срок не определён»
  status        text DEFAULT 'unbestaetigt', -- unbestaetigt (недоподтверждённая недоплата) | bestaetigt | zurueck
  geprueft_von  text,
  von           text,
  am            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS de_ausgang ON debitor_einbehalt(ausgang_id);

-- Нераспределённое поступление за клиентом (переплата/аванс/ошибка). Не доход и не возврат автоматически.
CREATE TABLE IF NOT EXISTS debitor_kredit (
  id           serial PRIMARY KEY,
  bewegung_id  int,
  kunde        text,
  betrag_cent  bigint NOT NULL,
  art          text DEFAULT 'klaerung', -- klaerung | anzahlung | fehler
  status       text DEFAULT 'offen',    -- offen | geklaert
  grund        text,
  von          text,
  am           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dk_kunde ON debitor_kredit(kunde);

-- append-only история удержаний/кредитов дебиторки (используем существующую функцию-страж)
DROP TRIGGER IF EXISTS de_append ON debitor_einbehalt;
CREATE TRIGGER de_append BEFORE DELETE ON debitor_einbehalt
  FOR EACH ROW EXECUTE FUNCTION bank_kein_loeschen();
