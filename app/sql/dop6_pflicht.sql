-- Дополнение №6 Ф8 — обязанность сдать чек, напоминания и эскалация.
-- Цепочка ТОЛЬКО для неотправленных документов: сотрудник → бухгалтер (2 раб. дня)
-- → Олег (1 раб. день). Андрея в эту цепочку не включаем.

CREATE TABLE IF NOT EXISTS beleg_pflicht (
  id            serial PRIMARY KEY,
  person        text NOT NULL,        -- логин сотрудника
  was           text NOT NULL,        -- что должен сдать (обязанность)
  objekt_nr     text,
  betrag_cent   bigint,
  seit          date,                 -- с какого дня обязанность
  erste_erinnerung date,              -- дата первого напоминания (основание отсчёта)
  stufe         text NOT NULL DEFAULT 'mitarbeiter', -- mitarbeiter | buchhaltung | oleg
  eskal_aufgabe_buch text,            -- id задачи бухгалтеру (дедуп)
  eskal_aufgabe_oleg text,            -- id задачи Олегу (дедуп)
  erledigt      boolean NOT NULL DEFAULT false,
  erledigt_am   timestamptz,
  erledigt_quelle text,               -- чем закрыто (operation_id/beleg)
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pflicht_offen ON beleg_pflicht(erledigt, person);

-- Журнал напоминаний — дедуп (одно на обязанность в день) и история.
CREATE TABLE IF NOT EXISTS erinnerung_log (
  id        serial PRIMARY KEY,
  pflicht_id int NOT NULL,
  tag       date NOT NULL,            -- день напоминания (Europe/Berlin)
  stufe     text,                     -- кому: mitarbeiter | buchhaltung | oleg
  ereignis  text,                     -- erinnerung | eskalation | erledigt | storniert
  notiz     text,
  wann      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(pflicht_id, tag, stufe)
);
