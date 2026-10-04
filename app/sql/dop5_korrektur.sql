-- Дополнение №5 Ф2 — запрос на исправление. Оригинал документа не переписываем:
-- храним исходное и предлагаемое значение отдельно. Проверенные данные обычный
-- сотрудник напрямую не меняет — только через запрос и подтверждение Натальи.

CREATE TABLE IF NOT EXISTS korrektur_antrag (
  id            serial PRIMARY KEY,
  art           text NOT NULL DEFAULT 'datenkorrektur',
  -- datenkorrektur (правка извлечённых данных) | zuordnung (замена привязки) | korrekturbeleg (новый корректирующий документ)
  firma         text,           -- затрагиваемый период (для повторной проверки, Ф3)
  jahr          int,
  monat         int,
  objekt_nr     text,           -- если относится к объекту
  bezug         text NOT NULL,  -- что исправляем: документ/поле/ссылка
  grund         text NOT NULL,  -- причина
  basis         text,           -- основание
  alt_wert      text,           -- исходное значение (не перезаписываем оригинал)
  neu_wert      text,           -- предлагаемое новое значение
  belege        text,           -- ссылки на документы
  autor         text NOT NULL,
  status        text NOT NULL DEFAULT 'offen',   -- offen | bestaetigt | zurueck | angewandt
  bestaetigt_von text, bestaetigt_am timestamptz,
  angewandt_von  text, angewandt_am  timestamptz,
  auswirkung    text,           -- связанные изменения расчётов
  notiz         text,
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_korrektur_status ON korrektur_antrag(status, angelegt);
CREATE INDEX IF NOT EXISTS ix_korrektur_periode ON korrektur_antrag(firma, jahr, monat);

CREATE TABLE IF NOT EXISTS korrektur_log (
  id        serial PRIMARY KEY,
  antrag_id int NOT NULL,
  ereignis  text,       -- angelegt | bestaetigt | zurueck | angewandt | notiz
  von       text, nach text,
  autor     text, notiz text,
  wann      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_korrektur_log ON korrektur_log(antrag_id, wann);
