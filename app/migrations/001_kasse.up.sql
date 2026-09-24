-- ---------------------------------------------------------------
-- Buchhalter VAV · миграция 001: наличные, квитанции, чеки,
-- возмещения, запросы, отдельные комплекты к оплате.
--
-- Только новые таблицы с префиксом buch_ в mailops_prod.
-- Существующие таблицы не меняются. Откат — 001_kasse.down.sql.
-- Деньги — целые центы (bigint). Ничего не удаляется: у всех
-- таблиц стоит запрет DELETE, исправления — сторно и журнал.
-- ---------------------------------------------------------------
BEGIN;

-- Счётчики человекочитаемых номеров (Q-0001, B-0001, …).
CREATE TABLE mailops_prod.buch_nummer (
  praefix text PRIMARY KEY,
  letzte  integer NOT NULL DEFAULT 0
);

-- Журнал событий: кто, когда, что. Только добавление.
CREATE TABLE mailops_prod.buch_ereignis (
  id      bigserial PRIMARY KEY,
  wann    timestamptz NOT NULL DEFAULT now(),
  wer     text NOT NULL,
  rolle   text NOT NULL,
  art     text NOT NULL,
  ziel    text NOT NULL,
  daten   jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX buch_ereignis_ziel ON mailops_prod.buch_ereignis (ziel);

-- Файлы (фото чеков, подписанных квитанций, счета). Ключ — SHA-256:
-- один и тот же файл дважды не сохраняется.
CREATE TABLE mailops_prod.buch_datei (
  sha      text PRIMARY KEY CHECK (sha ~ '^[0-9a-f]{64}$'),
  mime     text NOT NULL,
  groesse  bigint NOT NULL CHECK (groesse > 0),
  name     text,
  angelegt timestamptz NOT NULL DEFAULT now(),
  von      text NOT NULL
);

-- Места, где лежат наличные: основная касса, деньги у ответственного
-- (Олег), авансы у сотрудников.
CREATE TABLE mailops_prod.buch_konto (
  id         text PRIMARY KEY,
  art        text NOT NULL CHECK (art IN ('hauptkasse','halter','vorschuss')),
  firma      text NOT NULL DEFAULT 'VAVK',
  name       text NOT NULL,
  bei_text   text,
  login      text,
  person_ref text,
  angelegt   timestamptz NOT NULL DEFAULT now(),
  von        text NOT NULL
);

-- Заявка на наличные: список квитанций до снятия денег.
CREATE TABLE mailops_prod.buch_geldplan (
  id             bigserial PRIMARY KEY,
  nr             text NOT NULL UNIQUE,
  firma          text NOT NULL DEFAULT 'VAVK',
  titel          text NOT NULL,
  initiator      text NOT NULL,
  status         text NOT NULL DEFAULT 'entwurf'
                 CHECK (status IN ('entwurf','eingereicht','genehmigt','abgelehnt')),
  eingereicht_am timestamptz,
  eingereicht_von text,
  entschieden_am timestamptz,
  entschieden_von text,
  notiz          text,
  angelegt       timestamptz NOT NULL DEFAULT now(),
  von            text NOT NULL,
  idem           text UNIQUE
);

-- Движения наличных. Остатки считаются только отсюда.
CREATE TABLE mailops_prod.buch_bewegung (
  id            bigserial PRIMARY KEY,
  art           text NOT NULL CHECK (art IN ('abhebung','uebergabe','ausgabe','verbrauch','rueckgabe')),
  firma         text NOT NULL DEFAULT 'VAVK',
  von_konto     text REFERENCES mailops_prod.buch_konto(id),
  an_konto      text REFERENCES mailops_prod.buch_konto(id),
  quelle_id     bigint REFERENCES mailops_prod.buch_bewegung(id),
  betrag_cent   bigint NOT NULL CHECK (betrag_cent > 0),
  status        text NOT NULL CHECK (status IN ('gemeldet','bestaetigt','abgelehnt','storniert')),
  quittung_id   bigint,
  beleg_id      bigint,
  finmap_op     text,
  datum         date NOT NULL DEFAULT current_date,
  notiz         text,
  angelegt      timestamptz NOT NULL DEFAULT now(),
  von           text NOT NULL,
  bestaetigt_am timestamptz,
  bestaetigt_von text,
  idem          text UNIQUE,
  CHECK (von_konto IS DISTINCT FROM an_konto),
  CHECK (art <> 'abhebung' OR (von_konto IS NULL AND an_konto IS NULL))
);
CREATE INDEX buch_bewegung_von ON mailops_prod.buch_bewegung (von_konto);
CREATE INDEX buch_bewegung_an  ON mailops_prod.buch_bewegung (an_konto);

-- Квитанция на выдачу. «Подготовлена» ≠ «выдана»: движение денег
-- появляется только в момент выдачи.
CREATE TABLE mailops_prod.buch_quittung (
  id              bigserial PRIMARY KEY,
  nr              text NOT NULL UNIQUE,
  firma           text NOT NULL DEFAULT 'VAVK',
  plan_id         bigint REFERENCES mailops_prod.buch_geldplan(id),
  empfaenger_name text NOT NULL,
  empfaenger_ref  text,
  nu_name         text,
  nu_ref          text,
  zweck           text NOT NULL CHECK (zweck IN ('vorschuss','lohn','erstattung','nu')),
  betrag_cent     bigint NOT NULL CHECK (betrag_cent > 0),
  notiz           text,
  status          text NOT NULL DEFAULT 'vorbereitet'
                  CHECK (status IN ('vorbereitet','ausgegeben','storniert')),
  dringend        boolean NOT NULL DEFAULT false,
  von_konto       text REFERENCES mailops_prod.buch_konto(id),
  bewegung_id     bigint REFERENCES mailops_prod.buch_bewegung(id),
  ausgegeben_am   timestamptz,
  ausgegeben_von  text,
  foto_sha        text REFERENCES mailops_prod.buch_datei(sha),
  foto_am         timestamptz,
  foto_von        text,
  original_am     timestamptz,
  original_von    text,
  nu_bestaetigt_am  timestamptz,
  nu_bestaetigt_von text,
  nu_bestaetigt_notiz text,
  erstattung_id   bigint,
  angelegt        timestamptz NOT NULL DEFAULT now(),
  von             text NOT NULL,
  idem            text UNIQUE,
  CHECK (zweck <> 'nu' OR nu_name IS NOT NULL)
);

-- Чек / расход, который загрузил сотрудник или бухгалтерия.
CREATE TABLE mailops_prod.buch_beleg (
  id            bigserial PRIMARY KEY,
  nr            text NOT NULL UNIQUE,
  firma         text NOT NULL DEFAULT 'VAVK',
  art           text NOT NULL CHECK (art IN ('kraftstoff','material','sonstiges')),
  kurztext      text,
  person_ref    text,
  person_name   text NOT NULL,
  eingereicht_von text NOT NULL,
  betrag_cent   bigint NOT NULL CHECK (betrag_cent > 0),
  belegdatum    date NOT NULL,
  verwendung    text NOT NULL CHECK (verwendung IN ('fahrzeug','kanister','objekt','mehrere')),
  objekt_nr     text,
  objekt_text   text,
  fahrzeug_ref  text,
  fahrzeug_text text,
  zahlart       text NOT NULL CHECK (zahlart IN ('privat','vorschuss','firmenkarte','kasse')),
  konto_id      text REFERENCES mailops_prod.buch_konto(id),
  datei_sha     text REFERENCES mailops_prod.buch_datei(sha),
  dokument_name text,
  status        text NOT NULL DEFAULT 'eingereicht'
                CHECK (status IN ('eingereicht','geprueft','abgelehnt','storniert')),
  geprueft_am   timestamptz,
  geprueft_von  text,
  pruef_notiz   text,
  notiz         text,
  angelegt      timestamptz NOT NULL DEFAULT now(),
  idem          text UNIQUE,
  CHECK (zahlart NOT IN ('vorschuss','kasse') OR konto_id IS NOT NULL)
);
CREATE INDEX buch_beleg_person ON mailops_prod.buch_beleg (person_ref);

-- Возмещение личных расходов. Подтверждённый чек ≠ выплаченное возмещение.
CREATE TABLE mailops_prod.buch_erstattung (
  id              bigserial PRIMARY KEY,
  beleg_id        bigint NOT NULL UNIQUE REFERENCES mailops_prod.buch_beleg(id),
  betrag_cent     bigint NOT NULL CHECK (betrag_cent > 0),
  empfaenger_ref  text,
  empfaenger_name text NOT NULL,
  weg             text NOT NULL DEFAULT 'offen' CHECK (weg IN ('offen','bar','ueberweisung')),
  status          text NOT NULL DEFAULT 'offen'
                  CHECK (status IN ('offen','oleg_ok','an_gf','ausgezahlt','ueberwiesen_gemeldet','storniert')),
  quittung_id     bigint REFERENCES mailops_prod.buch_quittung(id),
  oleg_ok_am      timestamptz,
  oleg_ok_von     text,
  gemeldet_am     timestamptz,
  gemeldet_von    text,
  angelegt        timestamptz NOT NULL DEFAULT now(),
  von             text NOT NULL
);

-- Запрос документа / пояснения. Эскалация по рабочим дням.
CREATE TABLE mailops_prod.buch_rueckfrage (
  id            bigserial PRIMARY KEY,
  nr            text NOT NULL UNIQUE,
  firma         text NOT NULL DEFAULT 'VAVK',
  bezug_art     text NOT NULL CHECK (bezug_art IN ('beleg','bank','quittung','paket','frei')),
  bezug_id      text,
  titel         text NOT NULL,
  betrag_cent   bigint CHECK (betrag_cent IS NULL OR betrag_cent > 0),
  bezugsdatum   date,
  zahlart_text  text,
  objekt_text   text,
  person_ref    text,
  person_name   text NOT NULL,
  person_login  text,
  text          text NOT NULL,
  verlust       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','beantwortet','geschlossen')),
  frist_basis   timestamptz NOT NULL DEFAULT now(),
  angelegt      timestamptz NOT NULL DEFAULT now(),
  von           text NOT NULL,
  geschlossen_am  timestamptz,
  geschlossen_von text,
  schluss_notiz text,
  idem          text UNIQUE
);

CREATE TABLE mailops_prod.buch_rueckfrage_eintrag (
  id            bigserial PRIMARY KEY,
  rueckfrage_id bigint NOT NULL REFERENCES mailops_prod.buch_rueckfrage(id),
  art           text NOT NULL CHECK (art IN ('antwort','verlust','notiz','wiedereroeffnet')),
  text          text,
  datei_sha     text REFERENCES mailops_prod.buch_datei(sha),
  beleg_id      bigint REFERENCES mailops_prod.buch_beleg(id),
  angelegt      timestamptz NOT NULL DEFAULT now(),
  von           text NOT NULL,
  idem          text UNIQUE
);

-- Отдельный комплект к оплате: ровно один счёт подрядчика.
CREATE TABLE mailops_prod.buch_zahlpaket (
  id             bigserial PRIMARY KEY,
  nr             text NOT NULL UNIQUE,
  firma          text NOT NULL DEFAULT 'VAVK',
  lieferant_name text NOT NULL,
  lieferant_ref  text,
  rechnung_nr    text NOT NULL,
  rechnungsdatum date,
  brutto_cent    bigint NOT NULL CHECK (brutto_cent > 0),
  objekt_nr      text,
  objekt_text    text,
  mail_item_id   text,
  datei_sha      text REFERENCES mailops_prod.buch_datei(sha),
  oleg_status    text NOT NULL DEFAULT 'offen' CHECK (oleg_status IN ('offen','bestaetigt','abweichung')),
  oleg_am        timestamptz,
  oleg_von       text,
  oleg_text      text,
  oleg_datei_sha text REFERENCES mailops_prod.buch_datei(sha),
  geprueft_am    timestamptz,
  geprueft_von   text,
  status         text NOT NULL DEFAULT 'entwurf'
                 CHECK (status IN ('entwurf','an_gf','gf_gesehen','bezahlt_gemeldet','storniert')),
  an_gf_am       timestamptz,
  an_gf_von      text,
  gf_gesehen_am  timestamptz,
  bezahlt_gemeldet_am  timestamptz,
  bezahlt_gemeldet_von text,
  iban           text,
  iban_quelle    text,
  angelegt       timestamptz NOT NULL DEFAULT now(),
  von            text NOT NULL,
  idem           text UNIQUE,
  UNIQUE (lieferant_name, rechnung_nr)
);

-- Зачёт выданных квитанций в счёт подрядчика. Полная сумма работ
-- в счёте не уменьшается — уменьшается только остаток к оплате.
CREATE TABLE mailops_prod.buch_verrechnung (
  id           bigserial PRIMARY KEY,
  paket_id     bigint NOT NULL REFERENCES mailops_prod.buch_zahlpaket(id),
  quittung_id  bigint NOT NULL REFERENCES mailops_prod.buch_quittung(id),
  betrag_cent  bigint NOT NULL CHECK (betrag_cent > 0),
  angelegt     timestamptz NOT NULL DEFAULT now(),
  von          text NOT NULL,
  storniert_am timestamptz,
  storniert_von text
);
CREATE UNIQUE INDEX buch_verrechnung_einmal ON mailops_prod.buch_verrechnung (paket_id, quittung_id)
  WHERE storniert_am IS NULL;

-- Связь банковской операции FinMap (только чтение) с документом.
CREATE TABLE mailops_prod.buch_bank_link (
  id         bigserial PRIMARY KEY,
  finmap_op  text NOT NULL,
  ziel_art   text NOT NULL CHECK (ziel_art IN ('abhebung','paket','beleg','erstattung','rueckfrage')),
  ziel_id    text NOT NULL,
  angelegt   timestamptz NOT NULL DEFAULT now(),
  von        text NOT NULL,
  geloest_am timestamptz,
  geloest_von text
);
CREATE UNIQUE INDEX buch_bank_link_einmal ON mailops_prod.buch_bank_link (finmap_op, ziel_art, ziel_id)
  WHERE geloest_am IS NULL;

-- Ничего не удаляется бесследно.
CREATE FUNCTION mailops_prod.buch_kein_loeschen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Удаление из % запрещено: используйте сторно', TG_TABLE_NAME;
END $$;
CREATE FUNCTION mailops_prod.buch_ereignis_fest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Журнал событий не изменяется';
END $$;
CREATE TRIGGER buch_ereignis_fest BEFORE UPDATE OR DELETE ON mailops_prod.buch_ereignis
  FOR EACH ROW EXECUTE FUNCTION mailops_prod.buch_ereignis_fest();
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['buch_datei','buch_konto','buch_geldplan','buch_bewegung','buch_quittung',
    'buch_beleg','buch_erstattung','buch_rueckfrage','buch_rueckfrage_eintrag','buch_zahlpaket',
    'buch_verrechnung','buch_bank_link']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON mailops_prod.%I FOR EACH ROW EXECUTE FUNCTION mailops_prod.buch_kein_loeschen()',
                   t || '_kein_loeschen', t);
  END LOOP;
END $$;

-- Основная касса существует всегда; ответственный — бухгалтерия.
INSERT INTO mailops_prod.buch_konto (id, art, name, bei_text, von)
VALUES ('hauptkasse', 'hauptkasse', 'Основная касса', 'В основной кассе', 'migration-001');

COMMIT;
