-- Дополнение №7 §11 — журнал значимых действий для владельца.
-- Секреты (пароли, токены, ключи) в журнал НЕ пишутся. Записи не редактируются
-- обычными пользователями; исправление — новым событием, не стиранием прежнего.

CREATE TABLE IF NOT EXISTS audit_log (
  id     serial PRIMARY KEY,
  wer    text,                 -- кто
  rolle  text,
  art    text NOT NULL,        -- betrag | bank_requisiten | rechte | zahlung | entscheidung | status | sperre | sessions | aufgabe_uebergabe
  ziel   text,                 -- связанная операция/документ (pflicht:5, user:oleg, konto:...)
  alt    text,                 -- прежнее значение
  neu    text,                 -- новое значение
  grund  text,                 -- причина
  basis  text,                 -- основание подтверждения
  wann   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit ON audit_log(wann DESC);
CREATE INDEX IF NOT EXISTS ix_audit_art ON audit_log(art, wann DESC);
