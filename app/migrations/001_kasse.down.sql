-- Откат миграции 001. Перед запуском на боевой базе — выгрузка
-- этих таблиц (см. docs/BACKUP-MIGRATION-PLAN.md): откат удаляет
-- таблицы вместе с записями. Существующие таблицы не затрагиваются.
BEGIN;
DROP TABLE IF EXISTS
  mailops_prod.buch_bank_link,
  mailops_prod.buch_verrechnung,
  mailops_prod.buch_zahlpaket,
  mailops_prod.buch_rueckfrage_eintrag,
  mailops_prod.buch_rueckfrage,
  mailops_prod.buch_erstattung,
  mailops_prod.buch_beleg,
  mailops_prod.buch_quittung,
  mailops_prod.buch_bewegung,
  mailops_prod.buch_geldplan,
  mailops_prod.buch_konto,
  mailops_prod.buch_datei,
  mailops_prod.buch_ereignis,
  mailops_prod.buch_nummer CASCADE;
DROP FUNCTION IF EXISTS mailops_prod.buch_kein_loeschen();
DROP FUNCTION IF EXISTS mailops_prod.buch_ereignis_fest();
COMMIT;
