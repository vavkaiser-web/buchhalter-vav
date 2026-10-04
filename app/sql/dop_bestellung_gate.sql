-- Решение владельца №1 — гейт утверждения закупок (Bestellung).
-- ≤3000 € brutto в пределах бюджета — утверждает Олег. >3000 € или сверх бюджета —
-- решение Андрея вместе с Олегом. Дробление связанных закупок для обхода порога — на Андрея.
-- Во время отсутствия Андрея крупные закупки ЖДУТ его (без авто-делегирования/тайм-аута).

ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS braucht_andrej boolean NOT NULL DEFAULT false;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS braucht_grund  text;   -- summe | budget | kein_budget | split
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS oleg_von text;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS oleg_am  timestamptz;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS gf_von   text;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS gf_am    timestamptz;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS ablehn_grund text;
ALTER TABLE bestellung ADD COLUMN IF NOT EXISTS ablehn_von text;

CREATE TABLE IF NOT EXISTS bestellung_genehmigung_log (
  id serial PRIMARY KEY, bestellung_id int NOT NULL, ereignis text, rolle text, autor text, notiz text, wann timestamptz NOT NULL DEFAULT now()
);
