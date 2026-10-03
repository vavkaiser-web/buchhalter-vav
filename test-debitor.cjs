'use strict';
// Тесты debitor.js — поступления от заказчиков, дебиторская задолженность.
// Запуск: PILOT_IMPORT_DB=postgres://buch@127.0.0.1:55481/buchpilot NODE_PATH=app/node_modules node test-debitor.cjs

const { Pool } = require('pg');
const db = require('./app/debitor.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
let passed = 0, failed = 0;

function ok(label, cond, actual) {
  if (cond) { console.log('  ✓', label); passed++; }
  else { console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : ''); failed++; }
}

async function q(sql, v) { return pool.query(sql, v); }

const user = { login: 'buch', rolle: 'buchhaltung' };
const nat  = { login: 'natalia', rolle: 'buchhaltung', verantwortlich: true };

// ── вспомогательные функции ────────────────────────────────────────────────────

async function mkAusgang(betrag_cent, opts) {
  opts = opts || {};
  const r = (await q(
    `INSERT INTO ausgang_rechnung (nummer, betrag_cent, empfaenger, objekt_nr, kunde, faellig)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    ['TN-' + Date.now(), betrag_cent, opts.empfaenger || 'Test GmbH',
     opts.objekt_nr || 'TEST-OBJ',
     opts.kunde || 'Test GmbH',
     opts.faellig || null])).rows[0];
  return r.id;
}

async function cleanBew(ids) {
  if (!ids.length) return;
  await q('UPDATE zahlung_zuordnung SET storniert=true WHERE bewegung_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM bank_bewegung WHERE id=ANY($1)', [ids]).catch(() => {});
}
async function cleanAusgang(ids) {
  if (!ids.length) return;
  // сначала занулим ссылки, потом удалим
  await q('UPDATE zahlung_zuordnung SET ausgang_id=null WHERE ausgang_id=ANY($1)', [ids]).catch(() => {});
  await q('UPDATE debitor_einbehalt SET ausgang_id=null WHERE ausgang_id=ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM ausgang_rechnung WHERE id=ANY($1)', [ids]).catch(() => {});
}
async function cleanKredit(bewIds) {
  if (!bewIds.length) return;
  await q('DELETE FROM debitor_kredit WHERE bewegung_id=ANY($1)', [bewIds]).catch(() => {});
}

// ── 1. eingangImport: идемпотентность + задача при нераспределённом ────────────
async function test01() {
  console.log('\n1. eingangImport: идемпотентность + ohne_grund');
  const bewIds = [];
  try {
    const r1 = await db.eingangImport({ extern_id: 'TEST-D1-001', betrag: 5, gegenpartei: 'Unbekannt GmbH', datum: '2026-01-15' }, user);
    bewIds.push(r1.id);
    ok('импорт: ok', r1.ok === true, r1);
    ok('без предложения: ohne_grund', r1.ohne_grund === true, r1.ohne_grund);

    // повторный импорт → wiederholung
    const r2 = await db.eingangImport({ extern_id: 'TEST-D1-001', betrag: 500 }, user);
    ok('повторный импорт: wiederholung', r2.wiederholung === true, r2.wiederholung);
    ok('повторный: тот же id', r2.id === r1.id, r2.id);
  } finally { await cleanBew(bewIds); }
}

// ── 2. vorschlag + zuordnen: полная оплата нашего счёта ──────────────────────
async function test02() {
  console.log('\n2. vorschlag + zuordnen: полная оплата');
  const bewIds = [], ausgIds = [];
  try {
    const aId = await mkAusgang(200000, { kunde: 'Muster AG' }); // betrag_cent = 200000 = 2000 €
    ausgIds.push(aId);

    // поступление 2000 € (betrag в евро → cent() × 100)
    const ri = await db.eingangImport({ betrag: 2000, gegenpartei: 'Muster AG', datum: '2026-02-01' }, user);
    bewIds.push(ri.id);

    // предложение должно найти наш счёт
    const vor = ri.vorschlag;
    ok('vorschlag: нашёл счёт', vor.length >= 1, vor.length);
    ok('vorschlag: ausgang_id', vor[0].ausgang_id === aId, vor[0].ausgang_id);

    // распределяем
    const rz = await db.zuordnen({ bewegung_id: ri.id, teile: [{ ausgang_id: aId, betrag: 2000 }] }, user);
    ok('zuordnen: ok', rz.ok === true, rz);
    ok('zuordnen: status=zugeordnet', rz.status === 'zugeordnet', rz.status);
    ok('zuordnen: invariante', rz.invariante_ok === true, rz.invariante_ok);

    const detail = await db.eins(ri.id);
    ok('eins: verteilt == betrag', detail.verteilt === 200000, detail.verteilt);
    ok('eins: rest_zahlung=0', detail.rest_zahlung === 0, detail.rest_zahlung);
    ok('eins: zuordnungen=1', detail.zuordnungen.length === 1, detail.zuordnungen.length);
  } finally {
    await cleanBew(bewIds);
    await cleanAusgang(ausgIds);
  }
}

// ── 3. zuordnen: превышение суммы поступления → ошибка ──────────────────────
async function test03() {
  console.log('\n3. zuordnen: нельзя превысить сумму поступления');
  const bewIds = [], ausgIds = [];
  try {
    // invoice 1000 €, payment 500 € → assign 1000 € → overflow
    const aId = await mkAusgang(100000); ausgIds.push(aId);
    const ri = await db.eingangImport({ betrag: 500, gegenpartei: 'Anon AG', datum: '2026-02-05' }, user);
    bewIds.push(ri.id);

    let e1 = null;
    try { await db.zuordnen({ bewegung_id: ri.id, teile: [{ ausgang_id: aId, betrag: 1000 }] }, user); } catch (e) { e1 = e; }
    ok('превышение → ошибка', !!e1, e1 && e1.message);
  } finally {
    await cleanBew(bewIds);
    await cleanAusgang(ausgIds);
  }
}

// ── 4. zuordnungStorno: снятие распределения ──────────────────────────────────
async function test04() {
  console.log('\n4. zuordnungStorno: снятие + идемпотентность');
  const bewIds = [], ausgIds = [];
  try {
    // invoice 800 €, payment 800 €
    const aId = await mkAusgang(80000); ausgIds.push(aId);
    const ri = await db.eingangImport({ betrag: 800, gegenpartei: 'Test GmbH', datum: '2026-02-10' }, user);
    bewIds.push(ri.id);
    const rz = await db.zuordnen({ bewegung_id: ri.id, teile: [{ ausgang_id: aId, betrag: 800 }] }, user);
    ok('test04 setup: status=zugeordnet', rz.status === 'zugeordnet', rz.status);

    const zId = (await q('SELECT id FROM zahlung_zuordnung WHERE bewegung_id=$1 AND NOT storniert ORDER BY id LIMIT 1', [ri.id])).rows[0].id;
    const rs = await db.zuordnungStorno({ id: zId }, user);
    ok('storno: ok', rs.ok === true, rs);

    const bew = (await q('SELECT status FROM bank_bewegung WHERE id=$1', [ri.id])).rows[0];
    ok('после storno: status=nicht_zugeordnet', bew.status === 'nicht_zugeordnet', bew.status);

    // повторный storno → wiederholt
    const rs2 = await db.zuordnungStorno({ id: zId }, user);
    ok('повторный storno: wiederholt', rs2.wiederholt === true, rs2);
  } finally {
    await cleanBew(bewIds);
    await cleanAusgang(ausgIds);
  }
}

// ── 5. ueberzahlungKunde: переплата остаётся за клиентом ─────────────────────
async function test05() {
  console.log('\n5. ueberzahlungKunde: остаток → kredit за клиентом');
  const bewIds = [], ausgIds = [];
  try {
    // invoice 500 €, payment 700 € → 200 € остаток → kredit
    const aId = await mkAusgang(50000); ausgIds.push(aId);
    // Overpay AG — имя как у счёта, чтобы прошла zuordnen без third-party check
    const ri = await db.eingangImport({ betrag: 700, datum: '2026-02-15', gegenpartei: 'Test GmbH' }, user);
    bewIds.push(ri.id);
    // распределяем 500 €
    await db.zuordnen({ bewegung_id: ri.id, teile: [{ ausgang_id: aId, betrag: 500 }] }, user);
    // остаток 200 € → kredit
    const ru = await db.ueberzahlungKunde({ bewegung_id: ri.id, art: 'anzahlung', grund: 'аванс по будущему заказу' }, user);
    ok('ueberzahlung: ok', ru.ok === true, ru);
    ok('ueberzahlung: rest_cent=20000', ru.rest_cent === 20000, ru.rest_cent);
    ok('ueberzahlung: art=anzahlung', ru.art === 'anzahlung', ru.art);

    const bew = (await q('SELECT status FROM bank_bewegung WHERE id=$1', [ri.id])).rows[0];
    ok('статус: ueberzahlt', bew.status === 'ueberzahlt', bew.status);
  } finally {
    await cleanKredit(bewIds);
    await cleanBew(bewIds);
    await cleanAusgang(ausgIds);
  }
}

// ── 6. unterzahlung + einbehaltErfassen + einbehaltBestaetigen ───────────────
async function test06() {
  console.log('\n6. unterzahlung + гарантийное удержание');
  const ausgIds = [];
  try {
    // invoice 3000 €
    const aId = await mkAusgang(300000, { faellig: '2026-03-01' }); ausgIds.push(aId);

    // недоплата: фиксируем причину (betrag = 50 € → 5000 cents)
    const ru = await db.unterzahlung({ ausgang_id: aId, art: 'anspruch', betrag: 50, grund: 'клиент считает работу неполной' }, user);
    ok('unterzahlung: ok', ru.ok === true, ru);
    ok('unterzahlung: hinweis есть', !!ru.hinweis, ru.hinweis);

    // гарантийное удержание 150 € (betrag=150)
    const re = await db.einbehaltErfassen({ ausgang_id: aId, betrag: 150, grundlage: '5% по договору', rueckgabe: '2027-01-01' }, user);
    ok('einbehalt: ok', re.ok === true, re);
    ok('einbehalt: srok=2027-01-01', re.srok === '2027-01-01', re.srok);
    ok('einbehalt: status=unbestaetigt', re.status === 'unbestaetigt', re.status);

    // подтвердить
    const rb = await db.einbehaltBestaetigen({ id: re.id }, nat);
    ok('bestaetigen: ok', rb.ok === true, rb);
    const row = (await q('SELECT status FROM debitor_einbehalt WHERE id=$1', [re.id])).rows[0];
    ok('einbehalt статус=bestaetigt', row.status === 'bestaetigt', row.status);

    // событийное удержание 50 € (betrag=50)
    const ree = await db.einbehaltErfassen({ ausgang_id: aId, betrag: 50, ereignis_abhaengig: true }, user);
    ok('ereignis: srok=не определён', ree.srok === 'не определён', ree.srok);
  } finally {
    // einbehalt append-only — только пометим
    await q("UPDATE debitor_einbehalt SET status='zurueck' WHERE ausgang_id=ANY($1)", [ausgIds]).catch(() => {});
    await cleanAusgang(ausgIds);
  }
}

// ── 7. mahnWarnung: предупреждение перед напоминанием ────────────────────────
async function test07() {
  console.log('\n7. mahnWarnung: предупреждение перед напоминанием');
  const bewIds = [], ausgIds = [];
  try {
    const aId = await mkAusgang(100000, { kunde: 'Warnung AG' }); ausgIds.push(aId);

    // нераспределённое поступление 1000 € от того же клиента — создаст предупреждение
    const ri = await db.eingangImport({ betrag: 1000, gegenpartei: 'Warnung AG', datum: '2026-02-20' }, user);
    bewIds.push(ri.id);

    const rw = await db.mahnWarnung({ ausgang_id: aId });
    ok('mahnWarnung: ok', rw.ok === true, rw);
    ok('verwandte ≥ 1', rw.verwandte.length >= 1, rw.verwandte.length);
    ok('warnung есть', !!rw.warnung, rw.warnung);
  } finally {
    await cleanBew(bewIds);
    await cleanAusgang(ausgIds);
  }
}

async function main() {
  console.log('=== debitor — тесты ===');
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
