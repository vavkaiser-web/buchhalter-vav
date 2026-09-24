/* Регрессии по ревью 24.09: парсер bigint, сверка связи с банком,
   порядок блокировок при отмене зачёта. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { starten, sql, P, idem } = require('./helfer.js');

const BANK = path.join(os.tmpdir(), 'buch-demo-bank-' + process.pid + '.json');
fs.writeFileSync(BANK, JSON.stringify([
  { id: 'op-abh', datum: '2026-09-15', typ: 'expense', betrag: 200000, konto: 'Демо', partner: 'Снятие', kommentar: '' },
  { id: 'op-pay', datum: '2026-09-25', typ: 'expense', betrag: 20000, konto: 'Демо', partner: 'Подрядчик А', kommentar: '' },
]));
let s;
test.before(async () => { s = await starten({ env: { BUCH_DEMO_BANK: BANK } }); });
test.after(() => { s && s.stop(); fs.rmSync(BANK, { force: true }); });

test('bigint-парсер действует только в пуле кассы', async () => {
  const pg = require('../app/node_modules/pg');
  const vorher = pg.types.getTypeParser(20, 'text');
  const db = require('../app/kasse/db.js');
  process.env.BUCH_MAILOPS_ENV = path.join(s.dir, 'mailops.env');
  const r = await db.lesen(q => q('SELECT 5::bigint AS x'));
  assert.equal(r[0].x, 5, 'в кассе — число');
  assert.equal(pg.types.getTypeParser(20, 'text'), vorher, 'глобальный парсер не изменён');
  const c = new pg.Client({ connectionString: fs.readFileSync(path.join(s.dir, 'mailops.env'), 'utf8').trim().slice('DATABASE_URL='.length) });
  await c.connect();
  const alt = await c.query('SELECT 5::bigint AS x');
  await c.end();
  assert.equal(alt.rows[0].x, '5', 'прежние модули (razn, live) получают строку, как раньше');
  await db.ende();
});

async function paketMitVerrechnung(betragQ, brutto) {
  const a = await s.post('andrej', 'abhebung', { betrag: '1000,00', idem: idem() });
  const u = await s.post('andrej', 'uebergabe', { quelle_id: a.body.id, an_konto: 'hauptkasse', betrag: '1000,00', idem: idem() });
  await s.post('buch', `bewegung/${u.body.id}/bestaetigen`);
  const plan = await s.post('buch', 'plan', { idem: idem(), zeilen: [{ empfaenger_ref: P.NU1, zweck: 'nu', betrag: betragQ }] });
  await s.post('buch', `plan/${plan.body.id}/einreichen`);
  await s.post('andrej', `plan/${plan.body.id}/entscheiden`, { genehmigt: true });
  const q = plan.body.quittungen[0];
  assert.equal((await s.post('buch', `quittung/${q.id}/ausgeben`)).status, 200);
  const f = await s.datei('buch');
  await s.post('buch', `quittung/${q.id}/foto`, { sha: f.body.sha });
  await s.post('buch', `quittung/${q.id}/nu-bestaetigt`, { notiz: 'Подтвердил письмом' });
  const r = await s.datei('buch', Buffer.from('%PDF-1.4 ' + Math.random()), 'application/pdf');
  const pk = await s.post('buch', 'paket', { idem: idem(), lieferant_name: 'Подрядчик А · пример', rechnung_nr: 'RE-' + Math.random().toString(36).slice(2, 8),
    brutto, datei_sha: r.body.sha });
  await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: q.id });
  await s.post('oleg', `paket/${pk.body.id}/oleg`, { status: 'bestaetigt', text: 'ok' });
  await s.post('buch', `paket/${pk.body.id}/geprueft`);
  const v = Number(sql(`SELECT id FROM mailops_prod.buch_verrechnung WHERE paket_id = ${pk.body.id}`));
  return { paket: pk.body.id, verrechnung: v, quittung: q.id };
}

test('Связь с банком: только реальная операция; сумма сверяется; расхождение — явно и не как подтверждение', async () => {
  const x = await paketMitVerrechnung('50,00', '250,00');   // к оплате 200,00
  assert.equal((await s.post('buch', 'bank/link', { finmap_op: 'op-nope', ziel_art: 'paket', ziel_id: x.paket })).status, 404, 'выдуманная операция');
  const abh = Number(sql(`SELECT id FROM mailops_prod.buch_bewegung WHERE art = 'abhebung' ORDER BY id LIMIT 1`));
  const falsch = await s.post('buch', 'bank/link', { finmap_op: 'op-abh', ziel_art: 'abhebung', ziel_id: abh });
  assert.equal(falsch.status, 409, 'сумма 2.000 ≠ 1.000');
  const bewusst = await s.post('buch', 'bank/link', { finmap_op: 'op-abh', ziel_art: 'abhebung', ziel_id: abh, trotz_abweichung: true, notiz: 'Сняли вместе с другим' });
  assert.equal(bewusst.body.status, 'abweichung');
  const ok = await s.post('buch', 'bank/link', { finmap_op: 'op-pay', ziel_art: 'paket', ziel_id: x.paket });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.status, 'abgeglichen');
  const p = (await s.lage('buch')).pakete.find(y => y.id === x.paket);
  assert.equal(p.bank_op, 'op-pay');
  assert.equal((await s.post('oleg', 'bank/link', { finmap_op: 'op-pay', ziel_art: 'paket', ziel_id: x.paket })).status, 403);
});

test('Отмена зачёта и передача Андрею не проходят одновременно', async () => {
  for (let i = 0; i < 8; i++) {
    const x = await paketMitVerrechnung('10,00', '100,00');
    const [st, gf] = await Promise.all([
      s.post('buch', `verrechnung/${x.verrechnung}/storno`),
      s.post('buch', `paket/${x.paket}/an-gf`),
    ]);
    const zeile = sql(`SELECT p.status || '|' || COALESCE(to_char(v.storniert_am, 'x'), '') || '|' || COALESCE(to_char(p.an_gf_am, 'x'), '')
      FROM mailops_prod.buch_zahlpaket p JOIN mailops_prod.buch_verrechnung v ON v.paket_id = p.id WHERE p.id = ${x.paket}`);
    const [status, storno] = zeile.split('|');
    if (status === 'an_gf' && storno) {
      // Отмена прошла раньше — значит передача видела уже отменённый зачёт.
      const vorher = sql(`SELECT (v.storniert_am < p.an_gf_am)::text FROM mailops_prod.buch_zahlpaket p JOIN mailops_prod.buch_verrechnung v ON v.paket_id = p.id WHERE p.id = ${x.paket}`);
      assert.equal(vorher, 'true', `итерация ${i}: отмена зачёта после передачи Андрею`);
    }
    assert.ok([st.status, gf.status].includes(200), JSON.stringify([st.body, gf.body]));
    if (st.status === 409) assert.match(st.body.fehler, /передан/);
  }
});
