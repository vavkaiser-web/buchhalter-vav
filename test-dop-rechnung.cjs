'use strict';
// Тесты для rechnung_kontrolle.js (dop_rechnung_kontrolle.sql).
// Запуск: PILOT_IMPORT_DB=postgres://... node test-dop-rechnung.cjs
// Используется тестовая БД — боевые данные не затрагиваются.
// Каждый тест работает со своими строками и после себя их удаляет (схема не сбрасывается).

const { Pool } = require('pg');
const rk = require('./app/rechnung_kontrolle.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });

// ── Утилиты ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(label, cond, actual) {
  if (cond) {
    console.log('  ✓', label);
    passed++;
  } else {
    console.error('  ✗', label, actual !== undefined ? '→ ' + JSON.stringify(actual) : '');
    failed++;
  }
}

async function q(sql, vals) { return pool.query(sql, vals); }

// Вставить минимальную запись beleg, вернуть id.
async function mkBeleg({ lieferant = 'Muster GmbH', lieferant_key = 'muster', rechnung_nr = 'R-001', betrag = 1000, faellig = null, status = 'neu', gesperrt_grund = null, datei_hash = 'abc123' } = {}) {
  const r = await q(
    `INSERT INTO beleg (lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, faellig, status, gesperrt_grund, datei_hash, bezahlt)
     VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,false) RETURNING id`,
    [lieferant, lieferant_key, rechnung_nr, Math.round(betrag * 100), faellig, status, gesperrt_grund, datei_hash]);
  return r.rows[0].id;
}

// Вставить bestellung, вернуть id.
async function mkBestellung({ lieferant = 'Muster GmbH', objekt_nr = 'VK-25-001', summe = 5000, status = 'genehmigt' } = {}) {
  const r = await q(
    `INSERT INTO bestellung (lieferant, objekt_nr, summe_cent, status)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [lieferant, objekt_nr, Math.round(summe * 100), status]);
  return r.rows[0].id;
}

// Вставить bestellung_rechnung (fakturiert link).
async function mkBestRechnung(bestellung_id, rechnung_nr, betrag) {
  await q(`INSERT INTO bestellung_rechnung (bestellung_id, rechnung_ref, betrag_cent) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
    [bestellung_id, rechnung_nr, Math.round(betrag * 100)]);
}

// Убрать тестовые строки по id (чтобы тест был изолированным).
async function clean(table, ids) {
  if (!ids || ids.length === 0) return;
  await q(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]);
}

async function cleanBeleg(ids) {
  await q('DELETE FROM rechnung_pruef_item WHERE prueflauf_id IN (SELECT id FROM rechnung_prueflauf WHERE beleg_id = ANY($1))', [ids]);
  await q('DELETE FROM rechnung_ausnahme_anfrage WHERE beleg_id = ANY($1)', [ids]);
  await q('DELETE FROM rechnung_ausnahme WHERE beleg_id = ANY($1)', [ids]);
  await q('DELETE FROM rechnung_prueflauf WHERE beleg_id = ANY($1)', [ids]);
  await q('DELETE FROM bestellung_rechnung WHERE beleg_id = ANY($1)', [ids]).catch(() => {});
  await q('DELETE FROM beleg WHERE id = ANY($1)', [ids]);
}

async function cleanBest(ids) {
  await q('DELETE FROM bestellung WHERE id = ANY($1)', [ids]).catch(() => {});
}

// ── Сценарий 1: счёт в норме (ОК) ────────────────────────────────────────────
async function test01() {
  console.log('\n1. Счёт в пределах заказа — результат ok');
  const bId = await mkBeleg({ betrag: 1000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'test');
    ok('ergebnis ok или hinweis', ['ok', 'hinweis'].includes(r.ergebnis), r.ergebnis);
    ok('нет blockiert', r.ergebnis !== 'blockiert');
    ok('нет задачи', !r.aufgabe_id);
    const summeItem = r.items.find(i => i.art === 'summe');
    ok('summe: ok', summeItem && summeItem.status === 'ok', summeItem);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 2: счёт превышает заказ → blockiert + задача ────────────────────
async function test02() {
  console.log('\n2. Счёт превышает заказ → blockiert');
  const bId = await mkBeleg({ betrag: 6000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'test');
    ok('ergebnis blockiert', r.ergebnis === 'blockiert', r.ergebnis);
    const summeItem = r.items.find(i => i.art === 'summe');
    ok('summe blockiert', summeItem && summeItem.status === 'blockiert', summeItem);
    ok('превышение 100 €', summeItem && summeItem.diff_cent === 100000, summeItem?.diff_cent);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 3: дублирующий импорт — второй прогон по тому же счёту ───────────
async function test03() {
  console.log('\n3. Дублирующий импорт — нет дублирующей задачи');
  const bId = await mkBeleg({ betrag: 6000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r1 = await rk.pruefung(bId, bestId, 'test');
    const r2 = await rk.pruefung(bId, bestId, 'test');
    ok('оба прогона blockiert', r1.ergebnis === 'blockiert' && r2.ergebnis === 'blockiert');
    // Второй прогон НЕ должен создать новую задачу (первая уже открыта)
    ok('второй прогон не создаёт дополнительную задачу', !r2.aufgabe_id);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 4: счёт без заказа → blockiert ──────────────────────────────────
async function test04() {
  console.log('\n4. Счёт без заказа → blockiert (нет основания)');
  const bId = await mkBeleg({ betrag: 2000 });
  try {
    const r = await rk.pruefung(bId, null, 'test');
    ok('ergebnis blockiert', r.ergebnis === 'blockiert', r.ergebnis);
    const lief = r.items.find(i => i.art === 'lieferant');
    ok('lieferant fehlt', lief && lief.status === 'fehlt', lief?.status);
  } finally {
    await cleanBeleg([bId]);
  }
}

// ── Сценарий 5: частичная оплата (fakturiert ≠ bezahlt) ─────────────────────
async function test05() {
  console.log('\n5. Fakturiert ≠ bezahlt → hinweis');
  const nr = 'R-T05-' + Date.now();
  const bId = await mkBeleg({ rechnung_nr: nr, betrag: 2000, status: 'geprueft' });
  const bestId = await mkBestellung({ summe: 5000 });
  // Регистрируем счёт как выставленный по заказу
  await mkBestRechnung(bestId, nr, 2000);
  // НЕ добавляем zahlung_zuordnung → bezahlt = 0, fakturiert = 2000
  try {
    const r = await rk.pruefung(bId, bestId, 'test');
    const ketteItem = r.items.find(i => i.art === 'kette');
    ok('kette hinweis (разница 2000)', ketteItem && ketteItem.status === 'hinweis', ketteItem?.status);
    ok('diff 200000 cent', ketteItem && Number(ketteItem.diff_cent) === 200000, ketteItem?.diff_cent);
  } finally {
    await cleanBeleg([bId]);
    await q('DELETE FROM bestellung_rechnung WHERE bestellung_id=$1', [bestId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 6: один платёж, два счёта по одному заказу ──────────────────────
async function test06() {
  console.log('\n6. Один заказ, два счёта — cumulative summe проверяется корректно');
  const bestId = await mkBestellung({ summe: 3000 });
  const bId1 = await mkBeleg({ rechnung_nr: 'R-T06A-' + Date.now(), betrag: 1500 });
  // Сначала проводим первый счёт и регистрируем его в bestellung_rechnung
  await mkBestRechnung(bestId, 'R-T06A-' + Date.now(), 1500);
  // Второй счёт +1400 = 2900 < 3000 → ok
  const bId2 = await mkBeleg({ rechnung_nr: 'R-T06B-' + Date.now(), betrag: 1400 });
  try {
    const r = await rk.pruefung(bId2, bestId, 'test');
    ok('суммарно в пределах заказа', r.ergebnis !== 'blockiert', r.ergebnis);
  } finally {
    await cleanBeleg([bId1, bId2]);
    await q('DELETE FROM bestellung_rechnung WHERE bestellung_id=$1', [bestId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 7: счёт на несколько объектов — нет двойного расхода ─────────────
async function test07() {
  console.log('\n7. Нет двойного расхода — один счёт, два объекта (два заказа)');
  const bId = await mkBeleg({ betrag: 2000 });
  const bestId1 = await mkBestellung({ objekt_nr: 'VK-25-010', summe: 1500 });
  const bestId2 = await mkBestellung({ objekt_nr: 'VK-25-011', summe: 1500 });
  try {
    // Запускаем проверку для каждого заказа — оба должны дать свои результаты
    const r1 = await rk.pruefung(bId, bestId1, 'test');
    const r2 = await rk.pruefung(bId, bestId2, 'test');
    // Сумма счёта 2000 > каждый заказ по 1500 → blockiert по обоим
    ok('blockiert по объекту 1', r1.ergebnis === 'blockiert', r1.ergebnis);
    ok('blockiert по объекту 2', r2.ergebnis === 'blockiert', r2.ergebnis);
    // Но сами прогоны независимые — нет перекрёстного вычитания
    ok('разные prueflauf_id', r1.prueflauf_id !== r2.prueflauf_id);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId1, bestId2]);
  }
}

// ── Сценарий 8: исключение Андрея — счёт одобрен ────────────────────────────
async function test08() {
  console.log('\n8. Исключение: бухгалтер → Олег → Андрей → genehmigt');
  const bId = await mkBeleg({ betrag: 6000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'buchhaltung');
    ok('blockiert перед исключением', r.ergebnis === 'blockiert');

    const a = await rk.ausnahmeBeantragen(r.prueflauf_id, { grund: 'Сверхурочные работы утверждены', notiz: 'см. протокол' }, 'buchhaltung');
    ok('anfrage создана', a.ok && a.anfrage_id > 0);

    await rk.anfragAnAndrej(a.anfrage_id, 'oleg');
    ok('anfrag передан Андрею без ошибки', true);

    const g = await rk.ausnahmeGenehmigen(r.prueflauf_id, { basis: 'Протокол №5', grund: 'Одобрено Андреем' }, { login: 'andrej', rolle: 'gf' });
    ok('genehmigt без ошибки', g.ok);

    // Проверим, что прогон теперь ausnahme_genehmigt
    const detail = await rk.pruefungEins(r.prueflauf_id);
    ok('ergebnis = ausnahme_genehmigt', detail.ergebnis === 'ausnahme_genehmigt', detail.ergebnis);
    ok('ausnahme.aktiv', detail.ausnahme && detail.ausnahme.aktiv);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 9: изменение файла счёта деактивирует исключение ────────────────
async function test09() {
  console.log('\n9. После изменения счёта исключение деактивируется');
  const bId = await mkBeleg({ betrag: 6000, datei_hash: 'hash_v1' });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'buchhaltung');
    const a = await rk.ausnahmeBeantragen(r.prueflauf_id, { grund: 'Утверждено' }, 'buchhaltung');
    await rk.anfragAnAndrej(a.anfrage_id, 'oleg');
    await rk.ausnahmeGenehmigen(r.prueflauf_id, { basis: 'ok', grund: 'Подтверждено' }, { login: 'andrej', rolle: 'gf' });

    // Обновить хэш файла — симулируем изменение счёта
    await q('UPDATE beleg SET datei_hash=$2 WHERE id=$1', [bId, 'hash_v2_changed']);
    const check = await rk.belegGeaendertPruefen(bId);
    ok('1 исключение деактивировано', check.ausnahmen_deaktiviert === 1, check.ausnahmen_deaktiviert);

    // Проверить: прогон снова blockiert
    const detail = await rk.pruefungEins(r.prueflauf_id);
    ok('ergebnis снова blockiert', detail.ergebnis === 'blockiert', detail.ergebnis);
    ok('ausnahme неактивна', detail.ausnahme === null || !detail.ausnahme?.aktiv);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 10: задача по документам открыта после оплаты ───────────────────
async function test10() {
  console.log('\n10. Документная задача остаётся после оплаты');
  const bId = await mkBeleg({ betrag: 1000, status: 'neu', datei_hash: 'xyz' });
  try {
    await q('UPDATE beleg SET bezahlt=true WHERE id=$1', [bId]);
    const r = await rk.nachZahlungPruefen(bId);
    ok('hinweis о задаче', r.hinweis && r.hinweis.length > 0, r.hinweis);
  } finally {
    await cleanBeleg([bId]);
  }
}

// ── Сценарий 11: просрочка виден в faelligkeitsUebersicht ────────────────────
async function test11() {
  console.log('\n11. Просроченный счёт виден в faelligkeitsUebersicht');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const bId = await mkBeleg({ betrag: 1500, faellig: yesterday, status: 'neu' });
  try {
    const r = await rk.faelligkeitsUebersicht();
    const found = r.find(x => x.beleg_id === bId);
    ok('счёт найден в просрочке', !!found, 'id=' + bId + ', all=' + r.map(x=>x.beleg_id).join(','));
    ok('faellig_status uberfaellig', found && found.faellig_status === 'uberfaellig', found?.faellig_status);
  } finally {
    await cleanBeleg([bId]);
  }
}

// ── Сценарий 12: нельзя запросить исключение дважды ─────────────────────────
async function test12() {
  console.log('\n12. Повторный запрос исключения — ошибка');
  const bId = await mkBeleg({ betrag: 6000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'buchhaltung');
    await rk.ausnahmeBeantragen(r.prueflauf_id, { grund: 'Первый запрос' }, 'buchhaltung');
    let errMsg = '';
    try {
      await rk.ausnahmeBeantragen(r.prueflauf_id, { grund: 'Дублирующий запрос' }, 'buchhaltung');
    } catch (e) { errMsg = e.message; }
    ok('ошибка при дублировании запроса', errMsg.includes('уже создан'), errMsg);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Сценарий 13: исключение не отключает IBAN/дублет-проверку ────────────────
async function test13() {
  console.log('\n13. Исключение — флаги iban_check и duplikat_check всегда true');
  const bId = await mkBeleg({ betrag: 6000 });
  const bestId = await mkBestellung({ summe: 5000 });
  try {
    const r = await rk.pruefung(bId, bestId, 'buchhaltung');
    const a = await rk.ausnahmeBeantragen(r.prueflauf_id, { grund: 'Тест' }, 'buchhaltung');
    await rk.anfragAnAndrej(a.anfrage_id, 'oleg');
    await rk.ausnahmeGenehmigen(r.prueflauf_id, { basis: 'ok', grund: 'Тест' }, { login: 'andrej', rolle: 'gf' });

    const detail = await rk.pruefungEins(r.prueflauf_id);
    ok('iban_check_aktiv=true', detail.ausnahme?.iban_check_aktiv === true, detail.ausnahme?.iban_check_aktiv);
    ok('duplikat_check_aktiv=true', detail.ausnahme?.duplikat_check_aktiv === true, detail.ausnahme?.duplikat_check_aktiv);
  } finally {
    await cleanBeleg([bId]);
    await cleanBest([bestId]);
  }
}

// ── Запуск всех тестов ────────────────────────────────────────────────────────

async function main() {
  console.log('=== rechnung_kontrolle — тесты ===');
  try {
    await test01();
    await test02();
    await test03();
    await test04();
    await test05();
    await test06();
    await test07();
    await test08();
    await test09();
    await test10();
    await test11();
    await test12();
    await test13();
  } catch (e) {
    console.error('\nНепредвиденная ошибка:', e.message);
    failed++;
  }

  await pool.end();
  console.log(`\n=== Итог: ${passed} ✓  ${failed} ✗ ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
