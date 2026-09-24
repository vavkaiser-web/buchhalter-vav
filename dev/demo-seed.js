/* ---------------------------------------------------------------
   ЛОКАЛЬНАЯ ДЕМО-БАЗА (buchdemo на 127.0.0.1:55481). Только вымышленные
   данные эталона: те же суммы и подписи, что в approved-design.html,
   чтобы сравнивать экраны при одинаковых данных. На сервер не переносится.
   Создаёт: схему + миграцию, записи, файлы-образцы, входы, файл банка.
   Запуск: node dev/demo-seed.js  → затем dev/demo-start.sh
   ---------------------------------------------------------------- */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const DEMO = path.join(__dirname, 'demo');
const DB = 'postgres://buch@127.0.0.1:55481/buchdemo';
const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const PIN = 'demo-2409';     // только локальная демо-база

const psqlDatei = f => execFileSync(PSQL, [DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', f], { stdio: ['ignore', 'ignore', 'inherit'] });

async function bilder() {
  const { chromium } = require(path.join(ROOT, 'tools/node/node_modules/playwright-core'));
  const b = await chromium.launch({ channel: 'chrome' });
  const p = await b.newPage({ viewport: { width: 360, height: 480 } });
  const out = {};
  const muster = [
    ['fuel', 'ЧЕК АЗС № 0418', ['Diesel 52,17 л', 'ИТОГО 83,47 €']],
    ['material', 'ЧЕК МАГАЗИНА № 0721', ['Крепёж, анкеры', 'ИТОГО 246,80 €']],
    ['oleg', 'ЧЕК АЗС № 0402', ['Diesel', 'ИТОГО 297,82 €']],
    ['q1', 'КВИТАНЦИЯ Q-0091', ['500,00 € · подпись', '(образец)']],
    ['q2', 'КВИТАНЦИЯ Q-0092', ['300,00 € · подпись', '(образец)']],
    ['q3', 'КВИТАНЦИЯ Q-0093', ['246,80 € · подпись', '(образец)']],
  ];
  for (const [k, t, z] of muster) {
    await p.setContent(`<body style="margin:0;background:#fff;font:16px monospace;display:grid;place-items:center;height:480px"><div style="border:1px dashed #999;padding:24px;text-align:center;width:260px"><b>ОБРАЗЕЦ · НЕ ДОКУМЕНТ</b><p>${t}</p>${z.map(x => `<p>${x}</p>`).join('')}<p>Локальная демо-база</p></div></body>`);
    out[k] = await p.screenshot({ type: 'png' });
  }
  const pdf = await p.pdf({ width: '210mm', height: '297mm' }).catch(() => null);
  await p.setContent('<body style="font:14px sans-serif;padding:40px"><h2>ОБРАЗЕЦ · Rechnung RE-0923</h2><p>Подрядчик А · пример</p><p>Gesamtbetrag 10.000,00 €</p><p>abzüglich bar erhalten lt. Quittungen Q-0091, Q-0092: 800,00 €</p><p>Zahlbetrag 9.200,00 €</p><p>Локальная демо-база, не документ.</p></body>');
  out.rechnung = await p.pdf({ format: 'A4' });
  await b.close();
  return out;
}

(async () => {
  fs.rmSync(DEMO, { recursive: true, force: true });
  fs.mkdirSync(path.join(DEMO, 'data'), { recursive: true });
  fs.mkdirSync(path.join(DEMO, 'daten'), { recursive: true });
  psqlDatei(path.join(ROOT, 'dev/quellen-lokal.sql'));
  psqlDatei(path.join(ROOT, 'app/migrations/001_kasse.down.sql'));
  psqlDatei(path.join(ROOT, 'app/migrations/001_kasse.up.sql'));
  psqlDatei(path.join(ROOT, 'tests/quellen-test.sql'));

  // Файлы-образцы в хранилище демо-копии.
  const img = await bilder();
  const sha = {};
  for (const [k, buf] of Object.entries(img)) {
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    const ziel = path.join(DEMO, 'dateien', h.slice(0, 2), h);
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    fs.writeFileSync(ziel, buf);
    sha[k] = { h, mime: k === 'rechnung' ? 'application/pdf' : 'image/png', n: buf.length };
  }

  const pg = require(path.join(ROOT, 'app/node_modules/pg'));
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  const q = (s, a) => c.query(s, a || []).then(r => r.rows);
  const P = { A: '00000000-0000-4000-8000-000000000001', B: '00000000-0000-4000-8000-000000000002', OLEG: '00000000-0000-4000-8000-000000000003',
    NU1: '00000000-0000-4000-8000-000000000011', NU2: '00000000-0000-4000-8000-000000000012', AUTO_A: '00000000-0000-4000-8000-0000000000c1' };
  const M = 'mailops_prod.';
  await q(`INSERT INTO vav_kern.einstellung (schluessel, wert, notiz) VALUES ('buch_demo', 'ja', 'Локальная демо-база') ON CONFLICT (schluessel) DO UPDATE SET wert = 'ja'`);
  await q(`UPDATE vavapp_prod.persons SET full_name = 'Рабочий подрядчика 1' WHERE id = $1`, [P.NU1]);
  for (const [k, v] of Object.entries(sha)) await q(`INSERT INTO ${M}buch_datei (sha, mime, groesse, name, von) VALUES ($1,$2,$3,$4,'demo')`, [v.h, v.mime, v.n, k]);

  await q(`INSERT INTO ${M}buch_konto (id, art, name, bei_text, login, person_ref, von) VALUES
    ('halter:oleg','halter','Олег','У Олега','oleg',$1,'demo'), ('vorschuss:${P.B}','vorschuss','Сотрудник Б','Аванс · Сотрудник Б',NULL,$2,'demo')`, [P.OLEG, P.B]);
  const t = s => `2026-09-${s}+02`;
  const bew = async (art, von, an, quelle, betrag, status, datum, wer, extra) => (await q(`INSERT INTO ${M}buch_bewegung
    (art, von_konto, an_konto, quelle_id, betrag_cent, status, datum, von, angelegt, bestaetigt_am, bestaetigt_von, quittung_id, beleg_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [art, von, an, quelle, betrag, status, datum, wer, t(datum.slice(8) + ' 09:00'), status === 'bestaetigt' ? t(datum.slice(8) + ' 10:00') : null,
      status === 'bestaetigt' ? (extra && extra.bv) || wer : null, extra && extra.q || null, extra && extra.b || null]))[0].id;

  // 01.09: ранее снятые 800 € — в основную кассу (из них выданы Q-0091/0092).
  const a0 = await bew('abhebung', null, null, null, 80000, 'bestaetigt', '2026-09-01', 'andrej');
  await bew('uebergabe', null, 'hauptkasse', a0, 80000, 'bestaetigt', '2026-09-01', 'andrej', { bv: 'buch' });
  // Заявки: P-0001 рабочим подрядчика, P-0002 аванс сотруднику Б.
  await q(`INSERT INTO ${M}buch_geldplan (nr, titel, initiator, status, eingereicht_am, eingereicht_von, entschieden_am, entschieden_von, von, angelegt) VALUES
    ('P-0001','Рабочие подрядчика А · RE-0923','oleg','genehmigt',$1,'buch',$1,'andrej','buch',$1),
    ('P-0002','Аванс на материалы','oleg','genehmigt',$2,'buch',$2,'andrej','buch',$2)`, [t('08 12:00'), t('14 12:00')]);
  const quit = async (nr, plan, name, ref, nu, zweck, betrag, konto, wer, datum, foto) => {
    const id = (await q(`INSERT INTO ${M}buch_quittung (nr, plan_id, empfaenger_name, empfaenger_ref, nu_name, zweck, betrag_cent, status, von_konto,
      ausgegeben_am, ausgegeben_von, foto_sha, foto_am, foto_von, original_am, original_von, nu_bestaetigt_am, nu_bestaetigt_von, nu_bestaetigt_notiz, von, angelegt)
      VALUES ($1,(SELECT id FROM ${M}buch_geldplan WHERE nr=$2),$3,$4,$5,$6,$7,'ausgegeben',$8,$9,$10,$11,$9,$10,$9,'buch',$12,$13,$14,'buch',$15) RETURNING id`,
      [nr, plan, name, ref, nu, zweck, betrag, konto, t(datum + ' 11:00'), wer, foto, nu ? t(datum + ' 16:00') : null, nu ? 'buch' : null,
        nu ? 'Подрядчик подтвердил письмом (образец)' : null, t(datum + ' 08:00')]))[0].id;
    const m = await bew('ausgabe', konto, zweck === 'vorschuss' ? 'vorschuss:' + ref : null, null, betrag, 'bestaetigt', '2026-09-' + datum, wer, { q: id });
    await q(`UPDATE ${M}buch_quittung SET bewegung_id = $2 WHERE id = $1`, [id, m]);
    return id;
  };
  const q1 = await quit('Q-0091', 'P-0001', 'Рабочий подрядчика 1', P.NU1, 'Подрядчик А · пример', 'nu', 50000, 'hauptkasse', 'buch', '10', sha.q1.h);
  const q2 = await quit('Q-0092', 'P-0001', 'Рабочий подрядчика 2', P.NU2, 'Подрядчик А · пример', 'nu', 30000, 'hauptkasse', 'buch', '10', sha.q2.h);

  // 15.09: снятие 2.000 € → 1.200 Олегу, 800 в основную кассу; связь с банком сверена.
  const a1 = await bew('abhebung', null, null, null, 200000, 'bestaetigt', '2026-09-15', 'andrej');
  await bew('uebergabe', null, 'halter:oleg', a1, 120000, 'bestaetigt', '2026-09-15', 'andrej', { bv: 'oleg' });
  await bew('uebergabe', null, 'hauptkasse', a1, 80000, 'bestaetigt', '2026-09-15', 'andrej', { bv: 'buch' });
  await q(`INSERT INTO ${M}buch_bank_link (finmap_op, ziel_art, ziel_id, status, op_betrag_cent, ziel_betrag_cent, op_datum, op_quelle, von)
    VALUES ('demo-op-1','abhebung',$1,'abgeglichen',200000,200000,'2026-09-15','Демо-файл (локально)','buch')`, [String(a1)]);
  // Расходы из денег Олега: аванс Сотруднику Б 246,80 и своя заправка 297,82.
  await quit('Q-0093', 'P-0002', 'Сотрудник Б', P.B, null, 'vorschuss', 24680, 'halter:oleg', 'oleg', '16', sha.q3.h);
  await q(`INSERT INTO ${M}buch_nummer (praefix, letzte) VALUES ('Q', 93), ('P', 2), ('B', 242), ('Z', 1), ('R', 1)`);
  const beleg = async (nr, art, kurz, ref, name, von, betrag, datum, verw, objNr, objTxt, fz, fzTxt, zahl, konto, datei, dok, status, pruef) => {
    const id = (await q(`INSERT INTO ${M}buch_beleg (nr, art, kurztext, person_ref, person_name, eingereicht_von, betrag_cent, belegdatum, verwendung,
      objekt_nr, objekt_text, fahrzeug_ref, fahrzeug_text, zahlart, konto_id, datei_sha, dokument_name, status, geprueft_am, geprueft_von, angelegt)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [nr, art, kurz, ref, name, von, betrag, datum, verw, objNr, objTxt, fz, fzTxt, zahl, konto, datei, dok, status,
        pruef ? t('19 10:00') : null, pruef ? 'buch' : null, `${datum} 15:30+02`]))[0].id;
    if (konto) await bew('verbrauch', konto, null, null, betrag, 'bestaetigt', datum, von, { b: id });
    return id;
  };
  await beleg('B-0239', 'kraftstoff', 'Diesel', P.OLEG, 'Олег', 'oleg', 29782, '2026-09-18', 'fahrzeug', null, null, P.AUTO_A, 'Автомобиль А · пример', 'vorschuss', 'halter:oleg', sha.oleg.h, 'Чек АЗС № 0402', 'geprueft', true);
  await beleg('B-0241', 'kraftstoff', 'Diesel', P.A, 'Сотрудник А', 'ma_a', 8347, '2026-09-24', 'fahrzeug', 'VK-26-901', 'Объект А · Nürnberg', P.AUTO_A, 'Автомобиль А · пример', 'privat', null, sha.fuel.h, 'Чек АЗС № 0418', 'eingereicht', false);
  await beleg('B-0242', 'material', 'крепёж', P.B, 'Сотрудник Б', 'ma_b', 24680, '2026-09-24', 'objekt', 'VK-26-902', 'Объект Б · Fürth', null, null, 'vorschuss', 'vorschuss:' + P.B, sha.material.h, 'Чек магазина № 0721', 'eingereicht', false);

  // 23.09: счёт подрядчика RE-0923 — отдельный комплект, передан Андрею.
  const pk = (await q(`INSERT INTO ${M}buch_zahlpaket (nr, lieferant_name, rechnung_nr, rechnungsdatum, brutto_cent, objekt_nr, objekt_text, datei_sha,
    oleg_status, oleg_am, oleg_von, oleg_text, geprueft_am, geprueft_von, status, an_gf_am, an_gf_von, von, angelegt)
    VALUES ('Z-0001','Подрядчик А · пример','RE-0923','2026-09-23',1000000,'VK-26-901','Объект А · Nürnberg',$1,'bestaetigt',$2,'oleg','Объём сверен на объекте (образец)',$2,'buch','an_gf',$3,'buch','buch',$4) RETURNING id`,
    [sha.rechnung.h, t('23 14:00'), t('23 16:00'), t('23 09:00')]))[0].id;
  await q(`INSERT INTO ${M}buch_verrechnung (paket_id, quittung_id, betrag_cent, von, angelegt) VALUES ($1,$2,50000,'buch',$4), ($1,$3,30000,'buch',$4)`, [pk, q1, q2, t('23 10:00')]);

  // 22.09: оплата картой без чека → запрос сотруднику (создан 23.09, срок до 25.09).
  const rf = (await q(`INSERT INTO ${M}buch_rueckfrage (nr, beleg_art, bezug_art, bezug_id, titel, betrag_cent, bezugsdatum, zahlart_text, objekt_text,
    person_ref, person_name, person_login, text, frist_basis, angelegt, von)
    VALUES ('R-0001','kraftstoff','bank','demo-op-2','Не хватает чека',6490,'2026-09-22','Карта фирмы','Автомобиль А',$1,'Сотрудник А','ma_a',
    'Пришлите чек по оплате картой 22.09 на 64,90 €.',$2,$2,'buch') RETURNING id`, [P.A, t('23 08:30')]))[0].id;
  await q(`INSERT INTO ${M}buch_bank_link (finmap_op, ziel_art, ziel_id, status, op_betrag_cent, ziel_betrag_cent, op_datum, op_quelle, von)
    VALUES ('demo-op-2','rueckfrage',$1,'abgeglichen',6490,6490,'2026-09-22','Демо-файл (локально)','buch')`, [String(rf)]);

  // 24.09: Андрей снял 500 € и передаёт Олегу — ждёт подтверждения.
  const a2 = await bew('abhebung', null, null, null, 50000, 'bestaetigt', '2026-09-24', 'andrej');
  await bew('uebergabe', null, 'halter:oleg', a2, 50000, 'gemeldet', '2026-09-24', 'andrej');
  await c.end();

  fs.writeFileSync(path.join(DEMO, 'bank.json'), JSON.stringify([
    { id: 'demo-op-1', datum: '2026-09-15', typ: 'expense', betrag: 200000, konto: 'Демо', partner: 'Снятие наличных', kommentar: '' },
    { id: 'demo-op-2', datum: '2026-09-22', typ: 'expense', betrag: 6490, konto: 'Демо', partner: 'Оплата картой · АЗС', kommentar: '' },
  ], null, 1));
  const nutzer = [
    { login: 'andrej', name: 'Андрей Кайзер', rolle: 'gf', kurz: 'АК' },
    { login: 'buch', name: 'Бухгалтерия', rolle: 'buchhaltung', kurz: 'БХ' },
    { login: 'oleg', name: 'Олег', rolle: 'disponent', person: P.OLEG, kurz: 'ОХ', bei: 'У Олега', dativ: 'Олегу' },
    { login: 'ma_a', name: 'Сотрудник А', rolle: 'mitarbeiter', person: P.A, kurz: 'СА' },
    { login: 'ma_b', name: 'Сотрудник Б', rolle: 'mitarbeiter', person: P.B, kurz: 'СБ' },
  ].map(n => { const s = crypto.randomBytes(16); return { ...n, salz: s.toString('hex'), hash: crypto.scryptSync(PIN, s, 32).toString('hex') }; });
  fs.writeFileSync(path.join(DEMO, 'data', 'benutzer.json'), JSON.stringify(nutzer, null, 1), { mode: 0o600 });
  fs.writeFileSync(path.join(DEMO, 'data', 'start'), '2026-09-06');
  fs.writeFileSync(path.join(DEMO, 'mailops.env'), 'DATABASE_URL=' + DB + '\n');
  console.log('Демо-база готова. Входы: andrej, buch, oleg, ma_a, ma_b · ПИН для локальной демо-базы: ' + PIN);
})().catch(e => { console.error(e); process.exit(1); });
