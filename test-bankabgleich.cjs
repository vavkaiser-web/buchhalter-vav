'use strict';
// Тесты bankabgleich.js — сверка банковских платежей.
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-bankabgleich.cjs

const { Pool } = require('pg');
const ba = require('./app/bankabgleich.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, v) { return pool.query(sql, v); }

let seq = 0;
function uid() { return 'BKTEST-' + Date.now() + '-' + (++seq); }

const user = { login: 'test', rolle: 'buchhaltung' };

async function mkBeleg({ lieferant = 'Testbau GmbH', lkey = 'testbau', betrag = 100000, rn = 'R-BK-001' } = {}) {
  const r = await q(
    `INSERT INTO beleg (lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, status, datei_hash, bezahlt)
     VALUES ($1,$2,$3,$4,now(),'geprueft',md5(random()::text),false) RETURNING id`,
    [lieferant, lkey, rn, betrag]);
  return r.rows[0].id;
}

async function mkBewegung({ gp = 'Testbau GmbH', gpKey = 'testbau', betrag = 100000,
    zweck = 'R-BK-001', art = 'ueberweisung', ext = null } = {}) {
  const r = await q(
    `INSERT INTO bank_bewegung (extern_id, gegenpartei, gegenpartei_key, betrag_cent, waehrung, datum, verwendungszweck, art)
     VALUES ($1,$2,$3,$4,'EUR',now(),$5,$6) RETURNING id`,
    [ext || uid(), gp, gpKey, betrag, zweck, art]);
  return r.rows[0].id;
}

async function cleanBew(ids) {
  if (!ids.length) return;
  // zahlung_zuordnung DELETE запрещён триггером — помечаем storniert
  await q('UPDATE zahlung_zuordnung SET storniert=true WHERE bewegung_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM bank_bewegung WHERE id=ANY($1)', [ids]).catch(() => {});
}

async function cleanBeleg(ids) {
  if (!ids.length) return;
  await q('DELETE FROM beleg WHERE id=ANY($1)', [ids]).catch(() => {});
}

// ── 1. Импорт — идемпотентность по extern_id ──────────────────────────────────
async function test01() {
  console.log('\n1. Импорт идемпотентен: повторный extern_id → wiederholung');
  const ext = uid();
  const bIds = [];
  try {
    const r1 = await ba.zahlungImport({ extern_id: ext, gegenpartei: 'Test AG', betrag: '500', datum: '2026-01-10' }, user);
    ok('первый импорт ok', r1.ok === true && !r1.wiederholung, r1);
    bIds.push(r1.id);

    const r2 = await ba.zahlungImport({ extern_id: ext, gegenpartei: 'Test AG', betrag: '500', datum: '2026-01-10' }, user);
    ok('повторный: wiederholung=true', r2.wiederholung === true, r2);
    ok('повторный: тот же id', r2.id === r1.id, r2.id);
  } finally { await cleanBew(bIds); }
}

// ── 2. Vorschlag: совпадение по ключу и номеру счёта ─────────────────────────
async function test02() {
  console.log('\n2. Vorschlag: ключ контрагента + номер счёта → stark');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ lkey: 'baufix-test', rn: 'R-VOR-777', betrag: 200000 });
    lIds.push(belegId);

    const bewId = await mkBewegung({ gpKey: 'baufix-test', zweck: 'R-VOR-777', betrag: 200000 });
    bIds.push(bewId);

    const d = await ba.eins(bewId);
    const vor = d.vorschlag;
    ok('vorschlag не пустой', vor.length > 0, vor.length);
    const match = vor.find(v => v.beleg_id === belegId);
    ok('наш счёт в vorschlag', !!match, match);
    ok('staerke=stark (номер счёта в назначении)', match && match.staerke === 'stark', match && match.staerke);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

// ── 3. Полная оплата: beleg.bezahlt=true, status=zugeordnet ──────────────────
async function test03() {
  console.log('\n3. Полная оплата: beleg.bezahlt=true, bewegung=zugeordnet');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ betrag: 150000 });
    lIds.push(belegId);
    const bewId = await mkBewegung({ betrag: 150000 });
    bIds.push(bewId);

    const r = await ba.zuordnen({ bewegung_id: bewId, teile: [{ beleg_id: belegId, betrag: '1500', skonto: '0' }] }, user);
    ok('zuordnen ok', r.ok === true, r);
    ok('status=zugeordnet', r.status === 'zugeordnet', r.status);
    ok('rest_zahlung=0', r.rest_zahlung === 0, r.rest_zahlung);
    ok('invariante', r.invariante_ok === true, r.invariante_ok);

    const beleg = (await q('SELECT bezahlt FROM beleg WHERE id=$1', [belegId])).rows[0];
    ok('beleg.bezahlt=true', beleg.bezahlt === true, beleg.bezahlt);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

// ── 4. Частичная оплата: beleg остаётся открытым ─────────────────────────────
// Движение полностью распределено → status=zugeordnet.
// Beleg оплачен лишь частично → bezahlt=false, rest_cent > 0.
// Для status=teilweise нужно НЕ распределить часть платежа (см. ниже).
async function test04() {
  console.log('\n4. Частичная оплата: beleg открыт; движение=zugeordnet (весь платёж распределён)');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ betrag: 200000 }); // 2000 €
    lIds.push(belegId);
    const bewId = await mkBewegung({ betrag: 100000 }); // 1000 € — половина счёта
    bIds.push(bewId);

    const r = await ba.zuordnen({ bewegung_id: bewId, teile: [{ beleg_id: belegId, betrag: '1000' }] }, user);
    ok('zuordnen ok', r.ok === true, r);
    // платёж исчерпан целиком → zugeordnet (не teilweise)
    ok('status=zugeordnet (платёж распределён полностью)', r.status === 'zugeordnet', r.status);
    ok('rest_zahlung=0', r.rest_zahlung === 0, r.rest_zahlung);

    const beleg = (await q('SELECT bezahlt FROM beleg WHERE id=$1', [belegId])).rows[0];
    ok('beleg.bezahlt=false (счёт оплачен лишь частично)', beleg.bezahlt === false, beleg.bezahlt);

    const teil = r.teile[0];
    ok('rest счёта = 1000 €', teil.rest === 100000, teil.rest);

    // Дополнительно: bewegung с частичным распределением → teilweise
    const bewId2 = await mkBewegung({ betrag: 50000 }); // 500 €, назначим только 200 €
    bIds.push(bewId2);
    const r2 = await ba.zuordnen({ bewegung_id: bewId2, teile: [{ beleg_id: belegId, betrag: '200' }] }, user);
    ok('teil.платёж: status=teilweise (500 € но распределено 200 €)', r2.status === 'teilweise', r2.status);
    ok('teil.rest_zahlung=300 €', r2.rest_zahlung === 30000, r2.rest_zahlung);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

// ── 5. Сторно распределения: счёт снова открывается ─────────────────────────
async function test05() {
  console.log('\n5. Сторно распределения: beleg.bezahlt снова false');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ betrag: 80000 });
    lIds.push(belegId);
    const bewId = await mkBewegung({ betrag: 80000 });
    bIds.push(bewId);

    await ba.zuordnen({ bewegung_id: bewId, teile: [{ beleg_id: belegId, betrag: '800' }] }, user);

    const zz = (await q('SELECT id FROM zahlung_zuordnung WHERE bewegung_id=$1 AND NOT storniert', [bewId])).rows;
    ok('распределение записано', zz.length > 0, zz.length);

    const r = await ba.zuordnungStorno({ id: zz[0].id }, user);
    ok('storno ok', r.ok === true, r);

    const beleg = (await q('SELECT bezahlt FROM beleg WHERE id=$1', [belegId])).rows[0];
    ok('beleg.bezahlt=false после сторно', beleg.bezahlt === false, beleg.bezahlt);

    const bew = (await q('SELECT status FROM bank_bewegung WHERE id=$1', [bewId])).rows[0];
    ok('движение: nicht_zugeordnet', bew.status === 'nicht_zugeordnet', bew.status);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

// ── 6. Переплата: решение — зачёт ─────────────────────────────────────────────
async function test06() {
  console.log('\n6. Переплата: platёж > счёт → ueberzahlung с решением verrechnung');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ betrag: 50000 }); // 500 €
    lIds.push(belegId);
    const bewId = await mkBewegung({ betrag: 70000 }); // 700 € — больше
    bIds.push(bewId);

    await ba.zuordnen({ bewegung_id: bewId, teile: [{ beleg_id: belegId, betrag: '500' }] }, user);

    const r = await ba.ueberzahlung({ bewegung_id: bewId, entscheidung: 'verrechnung', grund: 'зачёт в счёт следующего заказа' }, user);
    ok('ueberzahlung ok', r.ok === true, r);
    ok('entscheidung=verrechnung', r.entscheidung === 'verrechnung', r.entscheidung);
    ok('rest=200 €', r.rest_cent === 20000, r.rest_cent);

    const bew = (await q('SELECT status FROM bank_bewegung WHERE id=$1', [bewId])).rows[0];
    ok('движение: ueberzahlt', bew.status === 'ueberzahlt', bew.status);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

// ── 7. Возврат платежа: rueckbuchung → bestaetigen → beleg снова открыт ──────
async function test07() {
  console.log('\n7. Возврат платежа: распределение откатывается, beleg открывается');
  const lIds = [], bIds = [];
  try {
    const belegId = await mkBeleg({ betrag: 120000 });
    lIds.push(belegId);
    const bewId = await mkBewegung({ betrag: 120000 });
    bIds.push(bewId);

    await ba.zuordnen({ bewegung_id: bewId, teile: [{ beleg_id: belegId, betrag: '1200' }] }, user);

    const r1 = await ba.rueckbuchung({ bewegung_id: bewId }, user);
    ok('rueckbuchung: pruefen', r1.status === 'rueckbuchung_pruefen', r1.status);

    const r2 = await ba.rueckbuchungBestaetigen({ bewegung_id: bewId }, user);
    ok('bestaetigen ok', r2.ok === true, r2);
    ok('status=zurueckgebucht', r2.status === 'zurueckgebucht', r2.status);
    ok('wiederhergestellt=1', r2.wiederhergestellt === 1, r2.wiederhergestellt);

    const beleg = (await q('SELECT bezahlt FROM beleg WHERE id=$1', [belegId])).rows[0];
    ok('beleg.bezahlt=false после возврата', beleg.bezahlt === false, beleg.bezahlt);
  } finally {
    await cleanBew(bIds);
    await cleanBeleg(lIds);
  }
}

async function main() {
  console.log('=== bankabgleich — тесты ===');
  try {
    await test01();
    await test02();
    await test03();
    await test04();
    await test05();
    await test06();
    await test07();
  } catch (e) {
    console.error('\nНепредвиденная ошибка:', e);
    failed++;
  }
  await pool.end();
  console.log(`\n=== Итог: ${passed} ✓  ${failed} ✗ ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
