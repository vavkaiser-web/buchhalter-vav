-- Дополнение №5 Ф7 — вопросы от Steuerberater.
-- Срок задаёт Наталья с учётом срока Steuerberater (не универсальные 1/2/5 дней).
-- Ответ готовит исполнитель → проверяет Наталья → включается в комплект.
-- Способ электронной передачи не выбран — новый канал не подключаем.

CREATE TABLE IF NOT EXISTS steuerberater_frage (
  id            serial PRIMARY KEY,
  quelle        text,               -- источник вопроса
  datum         date,               -- когда поступил
  inhalt        text NOT NULL,      -- содержание вопроса
  bezug_dok     text,               -- документы/период, к которым относится
  firma         text, jahr int, monat int,
  frist_steuerberater date,         -- срок Steuerberater (может быть неизвестен)
  frist_intern  date,               -- внутренний срок (ставит Наталья)
  bearbeiter    text,               -- кому поручено
  status        text NOT NULL DEFAULT 'offen',
  -- offen | zugewiesen | antwort_vorbereitet | natalia_geprueft | im_paket | uebergeben | nachfrage | erledigt
  paket_id      int,                -- в каком комплекте ответов передан
  autor         text NOT NULL,
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_frage_status ON steuerberater_frage(status, angelegt);

CREATE TABLE IF NOT EXISTS steuerberater_antwort (
  id          serial PRIMARY KEY,
  frage_id    int NOT NULL,
  text        text NOT NULL,
  materialien text,
  autor       text NOT NULL,
  status      text NOT NULL DEFAULT 'vorbereitet', -- vorbereitet | geprueft | nachfrage
  geprueft_von text, geprueft_am timestamptz,
  notiz       text,
  angelegt    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_antwort_frage ON steuerberater_antwort(frage_id, angelegt);
