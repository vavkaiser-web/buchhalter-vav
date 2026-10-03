-- Дополнение №8 — начальные остатки на 01.01.2026, правила учёта.
-- Неизвестное ≠ ноль: betrag_cent NULL = «не получено». Расхождение не подтверждается
-- автоматически. Уточнение не переписывает молча — новая версия + история.

CREATE TABLE IF NOT EXISTS anfangsbestand (
  id            serial PRIMARY KEY,
  kategorie     text NOT NULL,   -- bank | kasse | forderung | verbindlichkeit | anzahlung_erhalten | anzahlung_geleistet | sonstiges
  bezeichnung   text NOT NULL,   -- счёт/контрагент
  konto         text,            -- id счёта/касса или ref контрагента
  betrag_cent   bigint,          -- NULL = не получено (НЕ ноль)
  waehrung      text NOT NULL DEFAULT 'EUR',
  stichtag      date NOT NULL DEFAULT '2026-01-01',
  quelle        text,            -- Steuerberater | Bank | Kasse | ...
  beleg_ref     text,            -- подтверждающий документ
  status        text NOT NULL DEFAULT 'offen',   -- offen | auf_klaerung | bestaetigt
  sverka_stand  text,
  geprueft_von  text, geprueft_am timestamptz,
  version       int NOT NULL DEFAULT 1,
  idem          text UNIQUE,     -- идемпотентность ввода
  notiz         text,
  angelegt      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_anfang_kat ON anfangsbestand(kategorie, status);

-- История версий (уточнение не стирает прежнее)
CREATE TABLE IF NOT EXISTS anfangsbestand_version (
  id        serial PRIMARY KEY,
  bestand_id int NOT NULL,
  version   int,
  betrag_cent bigint,
  quelle    text, beleg_ref text, status text,
  autor     text, grund text, wann timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_anfang_ver ON anfangsbestand_version(bestand_id, wann);

-- Погашение начального долга/аванса: уменьшает остаток, НЕ создаёт новый расход.
CREATE TABLE IF NOT EXISTS anfangsbestand_tilgung (
  id         serial PRIMARY KEY,
  bestand_id int NOT NULL,
  betrag_cent bigint NOT NULL,
  datum      date,
  quelle_ref text,              -- ссылка на платёж/операцию 2026
  idem       text UNIQUE,
  notiz      text, autor text, wann timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_anfang_tilg ON anfangsbestand_tilgung(bestand_id);

-- Настройки/правила учёта (§10)
CREATE TABLE IF NOT EXISTS einstellung (
  id        serial PRIMARY KEY,
  schluessel text NOT NULL,      -- kontenplan | ust | ertrag | aufwand | steuer | abschreibung | uebergang | datev
  wert      text,
  quelle    text, beleg_ref text,
  ab_datum  date,
  version   int NOT NULL DEFAULT 1,
  status    text NOT NULL DEFAULT 'unbekannt',  -- unbekannt | vorgeschlagen | bestaetigt
  autor     text, wann timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schluessel, version)
);
CREATE TABLE IF NOT EXISTS einstellung_version (
  id serial PRIMARY KEY, schluessel text, version int, wert text, quelle text, ab_datum date, status text, autor text, wann timestamptz DEFAULT now()
);
