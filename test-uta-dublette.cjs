'use strict';
// Тесты UTA-интеграции в dublette.js.
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-uta-dublette.cjs

const { Pool } = require('pg');
const dup = require('./app/dublette.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, vals) { return pool.query(sql, vals); }

async function cleanIds(ids) {
  if (!ids.length) return;
  await q('DELETE FROM beleg_signal WHERE beleg_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM beleg_entscheidung WHERE beleg_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM beleg_verknuepfung WHERE beleg_id = ANY($1) OR ziel_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM beleg WHERE id = ANY($1)', [ids]).catch(() => {});
}

const user = { login: 'test', rolle: 'buchhaltung' };
const DATUM = '2026-09-20';

// ── Сценарий 1: UTA-транзакция → затем ручной чек (та же дата+сумма) ─────────
async function test01() {
  console.log('\n1. UTA-транзакция + ручной чек — флаг возможного двойного расхода');
  let ids = [];
  try {
    const r1 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-20260920-001',
      betrag: 85.40, datum: DATUM, operation_id: 'test-uta-01-uta',
    }, user);
    ids.push(r1.id);
    ok('UTA-запись создана', r1.ok && r1.id, r1);
    ok('UTA-запись без блокировки (нет чека)', !r1.gesperrt, r1.gesperrt_grund);

    const r2 = await dup.belegEmpfang({
      quelle: 'kasse', lieferant: 'Shell Station Nürnberg', rechnung_nr: 'K-0042',
      betrag: 85.40, datum: DATUM, operation_id: 'test-uta-01-kasse',
    }, user);
    ids.push(r2.id);
    ok('чек создан', r2.ok && r2.id, r2);
    ok('чек заблокирован — UTA-перекрёст', r2.gesperrt, r2);
    ok('объяснение содержит UTA', r2.erklaerung.some(e => e.grund.includes('UTA')), r2.erklaerung);
  } finally {
    await cleanIds(ids);
  }
}

// ── Сценарий 2: ручной чек → затем UTA (обратный порядок) ────────────────────
async function test02() {
  console.log('\n2. Обратный порядок: сначала чек, потом UTA-транзакция');
  let ids = [];
  try {
    const r1 = await dup.belegEmpfang({
      quelle: 'email', lieferant: 'Aral Tankstelle', rechnung_nr: 'Q-0099',
      betrag: 120.00, datum: DATUM, operation_id: 'test-uta-02-quitt',
    }, user);
    ids.push(r1.id);
    ok('чек создан без блокировки', !r1.gesperrt, r1);

    const r2 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-20260920-002',
      betrag: 120.00, datum: DATUM, operation_id: 'test-uta-02-uta',
    }, user);
    ids.push(r2.id);
    ok('UTA заблокирован — перекрёст с чеком', r2.gesperrt, r2);
    ok('объяснение содержит "ручной чек"', r2.erklaerung.some(e => e.grund.includes('ручной чек')), r2.erklaerung);
  } finally {
    await cleanIds(ids);
  }
}

// ── Сценарий 3: две UTA-транзакции — НЕ флагировать как дублетов ─────────────
async function test03() {
  console.log('\n3. Две UTA-транзакции (та же сумма/дата) — НЕ двойной расход');
  let ids = [];
  try {
    const r1 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-TRUCK1',
      betrag: 200.00, datum: DATUM, operation_id: 'test-uta-03-a',
    }, user);
    ids.push(r1.id);

    const r2 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-TRUCK2',
      betrag: 200.00, datum: DATUM, operation_id: 'test-uta-03-b',
    }, user);
    ids.push(r2.id);

    // Обе UTA → lieferant_key совпадает, сумма совпадает → митель по стандартному правилу
    // Но UTA-перекрёст НЕ должен добавить дополнительный флаг "двойной расход"
    const utaMatch = r2.erklaerung.some(e => e.grund.includes('двойной расход'));
    ok('UTA↔UTA: нет флага двойного расхода', !utaMatch, r2.erklaerung);
  } finally {
    await cleanIds(ids);
  }
}

// ── Сценарий 4: разные даты — НЕ флагировать ─────────────────────────────────
async function test04() {
  console.log('\n4. UTA + чек — та же сумма, разные даты — нет флага');
  let ids = [];
  try {
    const r1 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-DATUMTEST',
      betrag: 55.00, datum: '2026-09-18', operation_id: 'test-uta-04-uta',
    }, user);
    ids.push(r1.id);

    const r2 = await dup.belegEmpfang({
      quelle: 'kasse', lieferant: 'Total Tankstelle', rechnung_nr: 'K-DATE',
      betrag: 55.00, datum: '2026-09-25', operation_id: 'test-uta-04-kasse',
    }, user);
    ids.push(r2.id);

    const utaMatch = r2.erklaerung.some(e => e.grund.includes('UTA'));
    ok('разные даты: нет UTA-флага', !utaMatch, r2.erklaerung);
  } finally {
    await cleanIds(ids);
  }
}

// ── Сценарий 5: verknuepfen — связать UTA и чек как одну операцию ─────────────
async function test05() {
  console.log('\n5. verknuepfen: UTA + чек = одна операция (решение бухгалтера)');
  let ids = [];
  try {
    const r1 = await dup.belegEmpfang({
      quelle: 'uta', lieferant: 'UTA Edenred', rechnung_nr: 'UTA-VK-01',
      betrag: 70.00, datum: DATUM, operation_id: 'test-uta-05-uta',
    }, user);
    ids.push(r1.id);
    const r2 = await dup.belegEmpfang({
      quelle: 'kasse', lieferant: 'Esso Nürnberg', rechnung_nr: 'Q-VK',
      betrag: 70.00, datum: DATUM, operation_id: 'test-uta-05-kasse',
    }, user);
    ids.push(r2.id);

    // Бухгалтер решает: это одна операция (не дубль, а детализация)
    const vk = await dup.verknuepfen({ beleg_id: r2.id, ziel_id: r1.id, art: 'operation', grund: 'UTA-транзакция — детализация этого чека' }, user);
    ok('verknuepfen ok', vk.ok, vk);

    // Затем решение по дублю — separate (раз это одна операция, чек это 'separate')
    await dup.entscheiden({ id: r2.id, entscheidung: 'separate', grund: 'UTA-детализация, не дубль' }, user);
    const row = (await pool.query('SELECT status, gesperrt_grund FROM beleg WHERE id=$1', [r2.id])).rows[0];
    ok('статус = separate', row.status === 'separate', row.status);
    ok('блокировка снята', !row.gesperrt_grund, row.gesperrt_grund);
  } finally {
    await cleanIds(ids);
  }
}

async function main() {
  console.log('=== UTA-интеграция — тесты ===');
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
