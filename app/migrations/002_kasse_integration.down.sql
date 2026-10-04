-- Откат миграции 002: таблицы интеграции.
-- ВНИМАНИЕ: удаляет все записи очереди и журнала.

SET search_path = mailops_prod, public;

DROP TABLE IF EXISTS integration_fehler;
DROP TABLE IF EXISTS kasse_extern_anfrage;
DROP TABLE IF EXISTS kasse_ereignis_queue;
