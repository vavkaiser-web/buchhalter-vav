-- Дополнение №6 Ф4/Ф5 — блокировка кассы и расхождения.
-- Живёт в той же БД, что и кассовый движок (mailops_prod), чтобы проверка
-- блокировки шла в той же транзакции и под тем же advisory-lock, что и выдача.

CREATE TABLE IF NOT EXISTS mailops_prod.kasse_sperre (
  konto              text PRIMARY KEY,
  gesperrt           boolean NOT NULL DEFAULT true,
  grund              text,
  gesperrt_von       text, gesperrt_am timestamptz DEFAULT now(),
  sverka_stand       text,          -- состояние сверки
  halter_bestaetigt_cent bigint,    -- фактический остаток, подтверждённый держателем
  halter_bestaetigt_von  text, halter_bestaetigt_am timestamptz,
  freigegeben_von    text, freigegeben_am timestamptz,
  stand              timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mailops_prod.kasse_sperre_log (
  id serial PRIMARY KEY, konto text, ereignis text, autor text, notiz text, wann timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mailops_prod.kasse_differenz (
  id            serial PRIMARY KEY,
  konto         text NOT NULL,
  ist_cent      bigint,             -- фактический пересчёт
  soll_cent     bigint,             -- расчётный остаток
  differenz_cent bigint,
  status        text NOT NULL DEFAULT 'erkannt',
  -- erkannt | ursache | vorschlag | genehmigt | angewandt
  ursache       text,
  vorschlag     text,               -- предлагаемая корректировка (основание+расчёт)
  betrag_cent   bigint,             -- сумма корректировки
  erkannt_von   text, erkannt_am timestamptz DEFAULT now(),
  genehmigt_von text, genehmigt_am timestamptz,
  angewandt_von text, angewandt_am timestamptz,
  bewegung_id   bigint              -- отдельная прослеживаемая корректирующая проводка
);
CREATE INDEX IF NOT EXISTS ix_kasse_diff ON mailops_prod.kasse_differenz(konto, status);
