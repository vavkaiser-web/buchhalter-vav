'use strict';
// Тесты steuerberater.js — Ф4 (bestätigung), Ф6 (pakete), Ф7 (fragen).
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-steuerberater.cjs

const { Pool } = require('pg');
const sb = require('./app/steuerberater.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, v) { return pool.query(sql, v); }

const nat  = { login: 'natalia', rolle: 'buchhaltung', verantwortlich: true };
const buch = { login: 'buch',    rolle: 'buchhaltung' };

async function cleanBest(ids) {
  if (!ids.length) return;
  await q('DELETE FROM steuerberater_bestaetigung WHERE id=ANY($1)', [ids]).catch(() => {});
}
async function cleanPaket(ids) {
  if (!ids.length) return;
  await q('DELETE FROM steuerberater_uebergabe WHERE paket_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM steuerberater_paket_position WHERE paket_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM steuerberater_paket WHERE id=ANY($1)', [ids]).catch(() => {});
}
async function cleanFrage(ids) {
  if (!ids.length) return;
  await q('DELETE FROM steuerberater_antwort WHERE frage_id=ANY($1)', [ids]).catch(() => {});
  await q('UPDATE steuerberater_frage SET paket_id=null WHERE id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM steuerberater_frage WHERE id=ANY($1)', [ids]).catch(() => {});
}

// ── 1. Ф4 — bestätigung schriftlich: валидация + anlegen ─────────────────────
async function test01() {
  console.log('\n1. Ф4 bestätigung schriftlich: валидация + создание');
  const ids = [];
  try {
    // пустой art → ошибка
    let e1 = null;
    try { await sb.bestaetigungAnlegen({ art: 'fax', autor: 'test' }); } catch (e) { e1 = e; }
    ok('неверный вид → ошибка', !!e1, e1 && e1.message);

    // schriftlich без ссылки → ошибка
    let e2 = null;
    try { await sb.bestaetigungAnlegen({ art: 'schriftlich', autor: 'test' }); } catch (e) { e2 = e; }
    ok('schriftlich без dokument_ref → ошибка', !!e2, e2 && e2.message);

    // schriftlich с ссылкой → ok
    const r = await sb.bestaetigungAnlegen({
      art: 'schriftlich', dokument_ref: 'Email SB 2026-01-10',
      vereinbart: 'исправление Q4', auswirkung: 'UStVA', autor: 'andrej'
    });
    ids.push(r.id);
    ok('schriftlich: создана', !!r.id, r.id);
    ok('art_text правильный', r.art_text === 'Письменное подтверждение', r.art_text);

    // hatBestaetigung без korrektur_id — проверяем просто, что функция работает
    const hat = await sb.hatBestaetigung(999999);
    ok('hatBestaetigung: нет → false', hat === false, hat);
  } finally { await cleanBest(ids); }
}

// ── 2. Ф4 — bestätigung telefonisch: валидация ───────────────────────────────
async function test02() {
  console.log('\n2. Ф4 bestätigung telefonisch: валидация + создание');
  const ids = [];
  try {
    let e1 = null;
    try { await sb.bestaetigungAnlegen({ art: 'telefonisch', autor: 'nat' }); } catch (e) { e1 = e; }
    ok('telefonisch без mit_wem → ошибка', !!e1, e1 && e1.message);

    let e2 = null;
    try { await sb.bestaetigungAnlegen({ art: 'telefonisch', mit_wem: 'Frau Müller', autor: 'nat' }); } catch (e) { e2 = e; }
    ok('telefonisch без vereinbart → ошибка', !!e2, e2 && e2.message);

    const r = await sb.bestaetigungAnlegen({
      art: 'telefonisch', mit_wem: 'Frau Müller SB', vereinbart: 'доп. амортизация', autor: 'natalia'
    });
    ids.push(r.id);
    ok('telefonisch: создана', !!r.id, r.id);
    ok('art_text', r.art_text === 'Запись телефонного согласования', r.art_text);
  } finally { await cleanBest(ids); }
}

// ── 3. Ф6 — паket: цикл anlegen → position → vollständig → uebergeben ────────
async function test03() {
  console.log('\n3. Ф6 паket: полный цикл');
  const pIds = [];
  try {
    const p = await sb.paketAnlegen({ firma: 'kaiser', jahr: 2026, monat: 1, nummer: 'P-01-2026' }, buch);
    pIds.push(p.id);
    ok('паket создан', !!p.id, p.id);
    ok('статус vorbereitet', p.status === 'vorbereitet', p.status);
    ok('vollständig=true (пустой — нет недостающих)', p.vollstaendig === true, p.vollstaendig);

    // добавляем позицию «fehlt»
    const pos1 = await sb.positionAdd({ paket_id: p.id, bezeichnung: 'Kassenblatt Jan', status: 'fehlt' });
    ok('позиция fehlt: id', !!pos1.id, pos1.id);

    let detail = await sb.paketEins(p.id);
    ok('paketEins: 1 позиция', detail.positionen.length === 1, detail.positionen.length);
    ok('fehlt=1', detail.fehlt === 1, detail.fehlt);
    ok('vollständig=false', detail.vollstaendig === false, detail.vollstaendig);

    // позиция → bereit → paket.vollständig=true
    await sb.positionStatus({ id: pos1.id, status: 'bereit' });
    detail = await sb.paketEins(p.id);
    ok('после bereit: fehlt=0', detail.fehlt === 0, detail.fehlt);
    ok('vollständig=true', detail.vollstaendig === true, detail.vollstaendig);

    // uebergeben
    const u = await sb.paketUebergeben({ paket_id: p.id, art: 'erstuebergabe', an: 'Frau SB', datum: '2026-02-01' }, buch);
    ok('uebergabe ok', u.ok === true, u);
    ok('art_text', u.art_text === 'Первичная передача', u.art_text);

    detail = await sb.paketEins(p.id);
    ok('статус: uebergeben', detail.status === 'uebergeben', detail.status);
    ok('uebergaben=1', detail.uebergaben.length === 1, detail.uebergaben.length);

    // неверная фирма
    let e1 = null;
    try { await sb.paketAnlegen({ firma: 'falsch', jahr: 2026 }, buch); } catch (e) { e1 = e; }
    ok('неверная фирма → ошибка', !!e1, e1 && e1.message);
  } finally { await cleanPaket(pIds); }
}

// ── 4. Ф7 — fragen: цикл anlegen → zuweisen → antwort → pruefen → im_paket ──
async function test04() {
  console.log('\n4. Ф7 fragen: полный цикл');
  const fIds = [], pIds = [];
  try {
    // anlegen
    const f = await sb.frageAnlegen({ inhalt: 'Что с возвратом НДС Q1?', firma: 'kaiser', jahr: 2026, monat: 1 }, buch);
    fIds.push(f.id);
    ok('frage создана', !!f.id, f.id);
    ok('статус: offen', f.status === 'offen', f.status);

    // zuweisen
    const fz = await sb.frageZuweisen({ id: f.id, bearbeiter: 'natalia', frist_intern: '2026-03-01' }, buch);
    ok('zugewiesen: bearbeiter', fz.bearbeiter === 'natalia', fz.bearbeiter);
    ok('статус: zugewiesen', fz.status === 'zugewiesen', fz.status);

    // antwort anlegen
    const a = await sb.antwortAnlegen({ frage_id: f.id, text: 'Возврат на счёт 2026-02-15, подтверждено.' }, nat);
    ok('ответ создан', !!a.id, a.id);

    let detail = await sb.frageEins(f.id);
    ok('статус: antwort_vorbereitet', detail.status === 'antwort_vorbereitet', detail.status);
    ok('antworten: 1', detail.antworten.length === 1, detail.antworten.length);

    // pruefen ok → natalia_geprueft
    await sb.antwortPruefen({ id: a.id, ok: true }, nat);
    detail = await sb.frageEins(f.id);
    ok('статус: natalia_geprueft', detail.status === 'natalia_geprueft', detail.status);

    // включить в комплект
    const p = await sb.paketAnlegen({ firma: 'kaiser', jahr: 2026 }, buch);
    pIds.push(p.id);
    const fp = await sb.frageInPaket({ id: f.id, paket_id: p.id }, buch);
    ok('статус: im_paket', fp.status === 'im_paket', fp.status);
    ok('paket_id записан', fp.paket_id === p.id, fp.paket_id);
  } finally {
    await cleanFrage(fIds);
    await cleanPaket(pIds);
  }
}

// ── 5. Ф7 — pruefen nachfrage + валидация frageInPaket ───────────────────────
async function test05() {
  console.log('\n5. Ф7 pruefen: nachfrage; frageInPaket только для natalia_geprueft');
  const fIds = [];
  try {
    const f = await sb.frageAnlegen({ inhalt: 'Уточнить базу для пенсионных взносов' }, buch);
    fIds.push(f.id);
    const a = await sb.antwortAnlegen({ frage_id: f.id, text: 'Предварительный ответ' }, buch);

    // Наталья возвращает на доработку
    await sb.antwortPruefen({ id: a.id, ok: false, notiz: 'неполная документация' }, nat);
    const detail = await sb.frageEins(f.id);
    ok('статус: nachfrage', detail.status === 'nachfrage', detail.status);

    // frageInPaket при nachfrage → ошибка
    let e1 = null;
    try { await sb.frageInPaket({ id: f.id }, buch); } catch (e) { e1 = e; }
    ok('frageInPaket без natalia_geprueft → ошибка', !!e1, e1 && e1.message);

    // frageListe фильтр по статусу
    const list = await sb.frageListe({ status: 'nachfrage' });
    ok('frageListe(nachfrage) ≥ 1', list.length >= 1, list.length);
    ok('наш вопрос в списке', list.some(x => x.id === f.id), list.map(x => x.id));
  } finally { await cleanFrage(fIds); }
}

async function main() {
  console.log('=== steuerberater — тесты ===');
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
