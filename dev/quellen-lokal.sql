-- ТОЛЬКО ДЛЯ ЛОКАЛЬНОЙ БАЗЫ. Минимальные копии структур источников
-- (колонки, которые читает модуль кассы). На сервере эти таблицы уже есть
-- и принадлежат другим приложениям: объекты — Учёт часов/ядро,
-- люди и машины — Учёт часов. Модуль кассы их только читает.
CREATE SCHEMA IF NOT EXISTS mailops_prod;
CREATE SCHEMA IF NOT EXISTS vav_kern;
CREATE SCHEMA IF NOT EXISTS vavapp_prod;

CREATE TABLE IF NOT EXISTS vav_kern.einstellung (schluessel text PRIMARY KEY, wert text, notiz text,
  geaendert timestamptz DEFAULT now(), von text);
CREATE TABLE IF NOT EXISTS vav_kern.objekt (nummer text PRIMARY KEY, jahr integer, lfd integer, bez text,
  kunde text, adresse text, firma text, status text, quelle text, vavapp_id uuid, objekt_ref integer,
  angelegt timestamptz DEFAULT now(), von text, fertig_am date, fertig_von text, zu_am date, zu_von text);
CREATE TABLE IF NOT EXISTS vavapp_prod.orgs (id uuid PRIMARY KEY, name text, type text, active boolean DEFAULT true);
CREATE TABLE IF NOT EXISTS vavapp_prod.persons (id uuid PRIMARY KEY, org_id uuid, full_name text, role text,
  active boolean DEFAULT true, is_test boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS vavapp_prod.vehicles (id uuid PRIMARY KEY, plate text, org_id uuid, model text,
  active boolean DEFAULT true, nummer text, art text, person_id uuid);
