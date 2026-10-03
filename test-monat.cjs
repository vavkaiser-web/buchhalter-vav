'use strict';
// Тесты monat.js — статус периода по фирмам VAV Kaiser.
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-monat.cjs

const { Pool } = require('pg');
const mn = require('./app/monat.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, v) { return pool.query(sql, v); }

// Тестовый год/месяц: далёкое будущее, не трогает реальные данные
const J = 2099;

const nat  = { login: 'natalia', rolle: 'buchhaltung', verantwortlich: true };
const buch = { login: 'buch',    rolle: 'buchhaltung', verantwortlich: false };
const gf   = { login: 'andrej',  rolle: 'gf' };

async function clean(firma, monate) {
  for (const m of monate) {
    await q('DELETE FROM monatsstatus_log WHERE firma=$1 AND jahr=$2 AND monat=$3', [firma, J, m]).catch(() => {});
    await q('DELETE FROM monatsstatus WHERE firma=$1 AND jahr=$2 AND monat=$3', [firma, J, m]).catch(() => {});
  }
}

// ── 1. uebersicht: 12 месяцев, обе фирмы, каталог статусов ───────────────────
async function test01() {
  console.log('\n1. uebersicht: структура ответа');
  const r = await mn.uebersicht(J);
  ok('год совпадает', r.jahr === J, r.jahr);
  ok('две фирмы', r.firmen.length === 2, r.firmen.length);
  ok('12 месяцев у каждой', r.firmen.every(f => f.monate.length === 12), r.firmen.map(f => f.monate.length));
  ok('статус_каталог 6 элементов', r.status_katalog.length === 6, r.status_katalog.length);
  ok('первый статус = gesammelt', r.firmen[0].monate[0].status === 'gesammelt', r.firmen[0].monate[0].status);
}

// ── 2. statusSetzen: цепочка переходов gesammelt → geprueft → natalia_geprueft ─
async function test02() {
  console.log('\n2. statusSetzen: цепочка статусов');
  const f = 'kaiser'; const m = 3;
  try {
    const r1 = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'geprueft' }, buch);
    ok('geprueft: ok', r1.ok === true, r1);
    ok('geprueft: статус', r1.status === 'geprueft', r1.status);

    const r2 = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'natalia_geprueft' }, nat);
    ok('natalia_geprueft: ok', r2.ok === true, r2);
    ok('natalia_geprueft: natalia_von', r2.natalia_von === 'natalia', r2.natalia_von);

    const r3 = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'paket_uebergeben' }, gf);
    ok('paket_uebergeben: ok', r3.ok === true, r3);

    // eins: история в log
    const detail = await mn.eins(f, J, m);
    ok('verlauf ≥ 3 записи', detail.verlauf.length >= 3, detail.verlauf.length);
  } finally { await clean(f, [m]); }
}

// ── 3. Идемпотентность: повторный тот же статус → unchanged ──────────────────
async function test03() {
  console.log('\n3. Идемпотентность: тот же статус → unchanged');
  const f = 'kaiser'; const m = 4;
  try {
    await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'geprueft' }, buch);
    const r2 = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'geprueft' }, buch);
    ok('unchanged=true', r2.unchanged === true, r2);
  } finally { await clean(f, [m]); }
}

// ── 4. Права: обычный buchhaltung не может natalia_geprueft ──────────────────
async function test04() {
  console.log('\n4. Права: обычный buchhaltung не может natalia_geprueft');
  const f = 'trockenbau'; const m = 5;
  try {
    await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'geprueft' }, buch);
    let err = null;
    try { await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'natalia_geprueft' }, buch); }
    catch (e) { err = e; }
    ok('ошибка доступа для обычного buchhaltung', !!err, err && err.message);
    ok('gf может natalia_geprueft', true); // gf всегда может
    const r = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'natalia_geprueft' }, gf);
    ok('gf: natalia_geprueft ok', r.ok === true, r);
  } finally { await clean(f, [m]); }
}

// ── 5. wiedervorlage: пометить → снять; реподтверждение Натальей ─────────────
async function test05() {
  console.log('\n5. wiedervorlage + реподтверждение Натальей');
  const f = 'kaiser'; const m = 6;
  try {
    await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'natalia_geprueft' }, nat);

    const w1 = await mn.wiedervorlageSetzen({ firma: f, jahr: J, monat: m, an: true }, gf);
    ok('wiedervorlage=true', w1.wiedervorlage === true, w1.wiedervorlage);
    // статус не изменился
    ok('статус остался natalia_geprueft', w1.status === 'natalia_geprueft', w1.status);

    // повторная установка → unchanged
    const w2 = await mn.wiedervorlageSetzen({ firma: f, jahr: J, monat: m, an: true }, gf);
    ok('повторно wiedervorlage → unchanged', w2.unchanged === true, w2);

    // Наталья подтверждает ещё раз → rebestaetigung (сбрасывает wiedervorlage)
    const r2 = await mn.statusSetzen({ firma: f, jahr: J, monat: m, status: 'natalia_geprueft' }, nat);
    ok('rebestaetigung=true', r2.rebestaetigung === true, r2.rebestaetigung);
    ok('wiedervorlage сброшена', r2.wiedervorlage === false, r2.wiedervorlage);

    // снять wiedervorlage явно
    const w3 = await mn.wiedervorlageSetzen({ firma: f, jahr: J, monat: m, an: false }, gf);
    ok('wiedervorlage снята', w3.wiedervorlage === false, w3.wiedervorlage);
  } finally { await clean(f, [m]); }
}

// ── 6. Неверная фирма / месяц → ошибка ───────────────────────────────────────
async function test06() {
  console.log('\n6. Валидация: неверная фирма и месяц');
  let e1 = null, e2 = null, e3 = null;
  try { await mn.eins('nein', J, 1); } catch (e) { e1 = e; }
  ok('неверная фирма → ошибка', !!e1, e1 && e1.message);
  try { await mn.statusSetzen({ firma: 'kaiser', jahr: J, monat: 13, status: 'geprueft' }, buch); } catch (e) { e2 = e; }
  ok('месяц 13 → ошибка', !!e2, e2 && e2.message);
  try { await mn.statusSetzen({ firma: 'kaiser', jahr: J, monat: 1, status: 'unbekannt' }, buch); } catch (e) { e3 = e; }
  ok('неизвестный статус → ошибка', !!e3, e3 && e3.message);
}

async function main() {
  console.log('=== monat — тесты ===');
  try {
    await test01();
    await test02();
    await test03();
    await test04();
    await test05();
    await test06();
  } catch (e) {
    console.error('\nНепредвиденная ошибка:', e);
    failed++;
  }
  await pool.end();
  console.log(`\n=== Итог: ${passed} ✓  ${failed} ✗ ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
