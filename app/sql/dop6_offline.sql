-- Дополнение №6 Ф6 — офлайн-чеки: серверный приём с устойчивым operation_id.
-- Повтор после потери ответа возвращает существующую запись, а не копию.
-- Смена привязки к объекту после сохранения не переписывается молча — конфликт на проверку.

CREATE TABLE IF NOT EXISTS beleg_eingang (
  id            serial PRIMARY KEY,
  operation_id  text UNIQUE NOT NULL,   -- устойчивый идентификатор операции (с устройства)
  autor         text NOT NULL,          -- владелец = вошедший пользователь (не из офлайн-поля)
  objekt_nr     text,
  betrag_cent   bigint,
  zweck         text,
  aufnahme_datum    timestamptz,        -- дата съёмки (с устройства)
  gespeichert_lokal timestamptz,        -- когда сохранено на устройстве
  upload_datum  timestamptz NOT NULL DEFAULT now(),
  datei_ref     text,                   -- имя/ссылка файла
  status        text NOT NULL DEFAULT 'empfangen',  -- empfangen | konflikt
  konflikt      text,                   -- описание конфликта привязки
  notiz         text,
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_beleg_eingang_autor ON beleg_eingang(autor, upload_datum DESC);
