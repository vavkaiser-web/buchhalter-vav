-- Дополнение: защита от дублей и обработка повторных писем.
-- Все таблицы в buchpilot (тест). Боевую базу не трогаем.

-- Документ (счёт/чек/детализация), поступивший из письма/загрузки.
CREATE TABLE IF NOT EXISTS beleg (
  id            serial PRIMARY KEY,
  eingang_am    timestamptz DEFAULT now(),
  quelle        text,               -- email / upload / uta / bank
  mail_id       text,               -- id письма (история получения)
  datei_name    text,
  datei_hash    text,               -- sha256 файла (точная копия)
  lieferant     text,
  lieferant_key text,               -- ключ контрагента (razn.schluessel)
  rechnung_nr   text,
  betrag_cent   bigint,
  datum         date,               -- дата документа
  faellig       date,               -- срок оплаты
  iban          text,
  status        text DEFAULT 'neu', -- neu|moeglicher_dubup|verbucht|dubup|separate|korrektur|kopie
  gesperrt_grund text,              -- moeglicher_dubup|iban_stop|null (блок расхода/оплаты)
  operation_id  text,               -- идемпотентность повторного импорта
  verbucht      boolean DEFAULT false,  -- уже учтён как расход — не изменять
  bezahlt       boolean DEFAULT false,  -- уже оплачен
  primaer_id    int,                -- ссылка на исходный документ (для копии/дубля/исправления)
  pruef_frist   date,               -- срок проверки возможного дубля (1 р.д.)
  notiz         text,
  von           text
);
CREATE INDEX IF NOT EXISTS beleg_hash ON beleg(datei_hash);
CREATE INDEX IF NOT EXISTS beleg_lkey ON beleg(lieferant_key);
CREATE INDEX IF NOT EXISTS beleg_op ON beleg(operation_id);

-- Связи документов: дубль, копия, исправление, «одна операция» (чек + детализация UTA).
CREATE TABLE IF NOT EXISTS beleg_verknuepfung (
  id       serial PRIMARY KEY,
  beleg_id int NOT NULL,
  ziel_id  int NOT NULL,
  art      text NOT NULL,           -- operation|dubup|korrektur|kopie
  grund    text,
  von      text,
  am       timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bverk_beleg ON beleg_verknuepfung(beleg_id);

-- История решений бухгалтера (append-only).
CREATE TABLE IF NOT EXISTS beleg_entscheidung (
  id            serial PRIMARY KEY,
  beleg_id      int NOT NULL,
  entscheidung  text NOT NULL,      -- dubup|separate|korrektur|kopie|freigabe|iban_freigabe
  vorher_status text,
  nachher_status text,
  ziel_id       int,
  grund         text,
  von           text,
  am            timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bents_beleg ON beleg_entscheidung(beleg_id);

-- Сигналы из письма (независимо от вложения): напоминание/срок/претензия/mahn/IBAN.
CREATE TABLE IF NOT EXISTS beleg_signal (
  id         serial PRIMARY KEY,
  beleg_id   int,
  mail_id    text,
  art        text NOT NULL,         -- zahlungserinnerung|zahlungserinnerung_bezahlt|fristaenderung|anspruch|mahnung|iban_wechsel
  text       text,
  neuer_wert text,                  -- предлагаемое новое значение (срок/IBAN) — НЕ применяется авто
  angewandt  boolean DEFAULT false,
  erledigt   boolean DEFAULT false,
  aufgabe_id text,
  am         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bsig_beleg ON beleg_signal(beleg_id);

-- Mahngebühren и проценты — отдельно от основного долга.
CREATE TABLE IF NOT EXISTS beleg_extra (
  id           serial PRIMARY KEY,
  beleg_id     int NOT NULL,
  art          text NOT NULL,       -- mahngebuehr|zins
  betrag_cent  bigint,
  status       text DEFAULT 'neu',  -- neu|geprueft|an_andrej|entschieden|abgelehnt
  entscheidung text,
  von          text,
  geprueft_von text,
  andrej_von   text,
  am           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bextra_beleg ON beleg_extra(beleg_id);

-- Append-only для истории решений и связей: удаление/изменение запрещено.
CREATE OR REPLACE FUNCTION dublette_kein_loeschen() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Удаление/изменение истории запрещено (append-only)';
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bents_append ON beleg_entscheidung;
CREATE TRIGGER bents_append BEFORE UPDATE OR DELETE ON beleg_entscheidung
  FOR EACH ROW EXECUTE FUNCTION dublette_kein_loeschen();
DROP TRIGGER IF EXISTS bverk_append ON beleg_verknuepfung;
CREATE TRIGGER bverk_append BEFORE DELETE ON beleg_verknuepfung
  FOR EACH ROW EXECUTE FUNCTION dublette_kein_loeschen();
