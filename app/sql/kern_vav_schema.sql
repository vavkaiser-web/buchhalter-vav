-- §8-A: тестовая модель живого ядра vav_kern в ТОЙ ЖЕ базе, где таблицы пилота.
-- В бою vav_kern и схема пилота лежат в одном Postgres (Supabase) — межсхемные JOIN
-- работают так же, как здесь. Боевую базу этот файл НЕ трогает: он для локального теста.
-- Точные колонки боевого vav_kern.objekt подтверждаются на T-7 (решение A плана запуска).

CREATE SCHEMA IF NOT EXISTS vav_kern;

-- Реестр объектов: один объект — один номер (VK-YY-NNN), номера не переиспользуются.
CREATE TABLE IF NOT EXISTS vav_kern.objekt (
  nummer     text PRIMARY KEY,
  bez        text,
  kunde      text,
  adresse    text,
  firma      text,               -- VAVK / VAVT
  status     text,               -- aktiv / fertig / zu / ruht
  quelle     text,
  vavapp_id  text,
  von        text,
  angelegt   timestamptz DEFAULT now()
);

-- Сведение дублей: альтернативное написание/номер -> канонический номер.
-- «Wolf System GmbH» и «WOLF SYSTEM GMBH», автономер N-VK-#### и т.п.
CREATE TABLE IF NOT EXISTS vav_kern.objekt_alias (
  alias   text PRIMARY KEY,      -- как встретилось (имя или чужой номер)
  nummer  text NOT NULL REFERENCES vav_kern.objekt(nummer),
  quelle  text,
  angelegt timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS objekt_alias_nummer ON vav_kern.objekt_alias(nummer);

-- Совместимое представление в форме зеркала kern_objekt, чтобы код пилота
-- переключался на живой реестр сменой одного имени источника.
-- В живой модели дубли сведены через objekt_alias, поэтому dup_gruppe/merged_into = NULL.
CREATE OR REPLACE VIEW vav_kern.objekt_kompat AS
SELECT o.nummer,
       o.bez,
       o.kunde,
       o.kunde        AS kunde_name,
       NULL::text     AS kunden_nr,
       NULL::text     AS debitor_nr,
       o.firma,
       o.status,
       NULL::text     AS dup_gruppe,
       NULL::text     AS merged_into,
       o.adresse,
       o.vavapp_id
FROM vav_kern.objekt o;
