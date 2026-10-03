-- Дополнение №6 Ф1–Ф3 — состояние интеграций, устаревшие данные, восстановление.
-- Доступность соединения ≠ полнота синхронизации: храним отдельно.

CREATE TABLE IF NOT EXISTS integration_quelle (
  quelle           text PRIMARY KEY,      -- finmap | mail | zeiterfassung | kasse | ...
  titel            text,
  verbindung       text NOT NULL DEFAULT 'unbekannt', -- ok | fehler | unbekannt (доступность)
  letzter_erfolg   timestamptz,           -- время последнего успешного получения
  verarbeitet_bis  timestamptz,           -- до какого момента данные обработаны (контрольная точка)
  rueckstand       int NOT NULL DEFAULT 0, -- необработанный остаток (кол-во), -1 = неизвестно
  fehler_text      text,                  -- понятная причина ошибки (без секретов)
  wiederholung     text,                  -- состояние повторной попытки
  stand_daten      timestamptz,           -- дата последних успешно полученных данных
  aufgabe_id       text,                  -- id открытой задачи о сбое (чтобы не дублировать)
  letzte_version   bigint,                -- последняя обработанная версия (защита от устаревших)
  schwelle_minuten int NOT NULL DEFAULT 1440,   -- порог устаревания: 24 ч (решение владельца от 25.09)
  schwelle_bestaetigt boolean NOT NULL DEFAULT true, -- согласован ли порог владельцем
  stand            timestamptz NOT NULL DEFAULT now()
);

-- Служебный журнал технических ошибок (без секретов). Пользователю не показываем детали.
CREATE TABLE IF NOT EXISTS integration_fehlerlog (
  id      serial PRIMARY KEY,
  quelle  text NOT NULL,
  code    text,
  detail  text,
  wann    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_intfehler ON integration_fehlerlog(quelle, wann);
