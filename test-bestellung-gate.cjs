'use strict';
// Тесты bestellung_gate.js + Правило 10 в rechnung_kontrolle.js.
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-bestellung-gate.cjs

const { Pool } = require('pg');
const bg = require('./app/bestellung_gate.js');
const rk = require('./app/rechnung_kontrolle.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, v) { return pool.query(sql, v); }

async function mkBestellung({ lieferant = 'Test GmbH', summe = 2000, basis = 'Budget-2026', status = 'offen' } = {}) {
  const r = await q(
    `INSERT INTO bestellung (lieferant, objekt_nr, summe_cent, status, basis)
     VALUES ($1,'VK-TEST',$2,$3,$4) RETURNING id`,
    [lieferant, Math.round(summe * 100), status, basis]);
  return r.rows[0].id;
}

async function mkBeleg({ lieferant = 'Test GmbH', betrag = 500, status = 'geprueft' } = {}) {
  const r = await q(
    `INSERT INTO beleg (lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, status, datei_hash, bezahlt)
     VALUES ($1,'test','R-G-001',$2,now(),$3,md5(random()::text),false) RETURNING id`,
    [lieferant, Math.round(betrag * 100), status]);
  return r.rows[0].id;
}

async function cleanBest(ids) {
  if (!ids.length) return;
  await q('DELETE FROM bestellung_genehmigung_log WHERE bestellung_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM bestellung WHERE id=ANY($1)', [ids]).catch(() => {});
}

async function cleanBeleg(ids) {
  if (!ids.length) return;
  await q('DELETE FROM rechnung_pruef_item WHERE prueflauf_id IN (SELECT id FROM rechnung_prueflauf WHERE beleg_id=ANY($1))', [ids]).catch(() => {});
  await q('DELETE FROM rechnung_ausnahme WHERE beleg_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM rechnung_prueflauf WHERE beleg_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM beleg WHERE id=ANY($1)', [ids]).catch(() => {});
}

const oleg = { login: 'oleg', rolle: 'disponent' };
const andrej = { login: 'andrej', rolle: 'gf' };

// ── 1. Заказ ≤3000 €: достаточно Олега ──────────────────────────────────────
async function test01() {
  console.log('\n1. Заказ ≤3000 €: гейт проходит только после одобрения Олега');
  let bIds = [], lIds = [];
  try {
    const bestId = await mkBestellung({ summe: 2000 });
    bIds.push(bestId);
    await bg.beurteilen(bestId, 'system');

    const belegId = await mkBeleg({ betrag: 500 });
    lIds.push(belegId);

    // До одобрения Олега — счёт blockiert
    const r1 = await rk.pruefung(belegId, bestId, 'test');
    ok('до Олега: gate blockiert', r1.ergebnis === 'blockiert', r1.ergebnis);
    const gateItem1 = r1.items.find(i => i.art === 'gate');
    ok('gate item: Олег не одобрил', gateItem1 && gateItem1.notiz.includes('Олег'), gateItem1?.notiz);

    // Олег одобряет
    const g = await bg.oleGenehmigen({ bestellung_id: bestId }, oleg);
    ok('Олег одобрил', g.ok && g.naechster_schritt === 'genehmigt', g);

    // Теперь счёт проходит gate
    const r2 = await rk.pruefung(belegId, bestId, 'test');
    const gateItem2 = r2.items.find(i => i.art === 'gate');
    ok('после Олега: gate ok', gateItem2 && gateItem2.status === 'ok', gateItem2?.status);
  } finally {
    await cleanBeleg(lIds);
    await cleanBest(bIds);
  }
}

// ── 2. Заказ >3000 €: нужен Андрей ──────────────────────────────────────────
async function test02() {
  console.log('\n2. Заказ >3000 €: нужна подпись Андрея');
  let bIds = [], lIds = [];
  try {
    const bestId = await mkBestellung({ summe: 5000 });
    bIds.push(bestId);
    const beurt = await bg.beurteilen(bestId, 'system');
    ok('braucht_andrej=true', beurt.braucht_andrej === true, beurt);
    ok('grund=summe', beurt.braucht_grund === 'summe', beurt.braucht_grund);

    const belegId = await mkBeleg({ betrag: 1000 });
    lIds.push(belegId);

    // После Олега — всё ещё blockiert
    await bg.oleGenehmigen({ bestellung_id: bestId }, oleg);
    const r1 = await rk.pruefung(belegId, bestId, 'test');
    const gi1 = r1.items.find(i => i.art === 'gate');
    ok('после Олега ещё blockiert (нет Андрея)', gi1 && gi1.status === 'blockiert', gi1?.status);
    ok('gate: нужен Андрей', gi1 && gi1.notiz.includes('Андрея'), gi1?.notiz);

    // Андрей одобряет
    await bg.gfGenehmigen({ bestellung_id: bestId }, andrej);

    // Теперь ok
    const r2 = await rk.pruefung(belegId, bestId, 'test');
    const gi2 = r2.items.find(i => i.art === 'gate');
    ok('после Андрея: gate ok', gi2 && gi2.status === 'ok', gi2?.status);
  } finally {
    await cleanBeleg(lIds);
    await cleanBest(bIds);
  }
}

// ── 3. Заказ отклонён ────────────────────────────────────────────────────────
async function test03() {
  console.log('\n3. Отклонённый заказ: gate blockiert');
  let bIds = [], lIds = [];
  try {
    const bestId = await mkBestellung({ summe: 1500 });
    bIds.push(bestId);
    await bg.beurteilen(bestId, 'system');
    await bg.ablehnen({ bestellung_id: bestId, grund: 'бюджет исчерпан' }, oleg);

    const belegId = await mkBeleg({ betrag: 300 });
    lIds.push(belegId);
    const r = await rk.pruefung(belegId, bestId, 'test');
    const gi = r.items.find(i => i.art === 'gate');
    ok('отклонённый заказ: gate blockiert', gi && gi.status === 'blockiert', gi?.status);
    ok('gate: отклонён', gi && gi.notiz.includes('отклонён'), gi?.notiz);
  } finally {
    await cleanBeleg(lIds);
    await cleanBest(bIds);
  }
}

// ── 4. Нарезка: два заказа по 2000 € одному поставщику → split ──────────────
async function test04() {
  console.log('\n4. Нарезка заказов: split детектируется');
  let bIds = [];
  try {
    // Первый заказ ниже порога — без флага
    const b1 = await mkBestellung({ summe: 2000, lieferant: 'Split Lieferant GmbH' });
    bIds.push(b1);
    const r1 = await bg.beurteilen(b1, 'system');
    ok('1-й заказ 2000€: без split', !r1.split, r1);

    // Второй заказ тому же поставщику — суммарно 4000 → split
    const b2 = await mkBestellung({ summe: 2000, lieferant: 'Split Lieferant GmbH' });
    bIds.push(b2);
    const r2 = await bg.beurteilen(b2, 'system');
    ok('2-й заказ 2000€: split флаг', r2.split === true, r2);
    ok('grund=split', r2.braucht_grund === 'split', r2.braucht_grund);
  } finally {
    await cleanBest(bIds);
  }
}

// ── 5. gateStatus: лог истории ───────────────────────────────────────────────
async function test05() {
  console.log('\n5. gateStatus: история одобрений в логе');
  let bIds = [];
  try {
    const bestId = await mkBestellung({ summe: 1000 });
    bIds.push(bestId);
    await bg.beurteilen(bestId, 'system');
    await bg.oleGenehmigen({ bestellung_id: bestId, notiz: 'всё ок' }, oleg);
    const st = await bg.gateStatus(bestId);
    ok('status=genehmigt', st.status === 'genehmigt', st.status);
    ok('oleg_von записан', st.oleg_von === 'oleg', st.oleg_von);
    ok('лог содержит события', st.log.length >= 2, st.log.length);
  } finally {
    await cleanBest(bIds);
  }
}

async function main() {
  console.log('=== bestellung_gate — тесты ===');
  try {
    await test01();
    await test02();
    await test03();
    await test04();
    await test05();
  } catch (e) {
    console.error('\nНепредвиденная ошибка:', e);
    failed++;
  }
  await pool.end();
  console.log(`\n=== Итог: ${passed} ✓  ${failed} ✗ ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
