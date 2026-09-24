/* Сценарные проверки по IMPLEMENTATION.md (приёмка, пункты 3–6).
   Запуск: node --test --test-concurrency=1 tests/  (нужна локальная база на 55481). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { starten, sql, P, jpeg, idem } = require('./helfer.js');
const wt = require('../app/kasse/werktage.js');

let s;
test.before(async () => { s = await starten(); });
test.after(() => s && s.stop());

const saldo = async (l, id) => (await s.lage(l)).konten.find(k => k.id === id);
async function belegNeu(l, extra) {
  const f = await s.datei(l);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  const b = { idem: idem(), art: 'kraftstoff', betrag: '83,47', verwendung: 'fahrzeug', fahrzeug_ref: P.AUTO_A,
    zahlart: 'privat', datei_sha: f.body.sha, ...(extra || {}) };
  return s.post(l, 'beleg', b);
}
async function geldAnOleg(betrag) {
  const a = await s.post('andrej', 'abhebung', { betrag, idem: idem() });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const u = await s.post('andrej', 'uebergabe', { quelle_id: a.body.id, an_konto: 'halter:oleg', betrag, idem: idem() });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal((await s.post('oleg', `bewegung/${u.body.id}/bestaetigen`, {})).status, 200);
  return a.body.id;
}

test('3. Наличные: заявка → утверждение → квитанция → выдача → подпись/фото → оригинал → чек → проверка → остаток/возврат', async () => {
  // Счёт Олега появляется при первом обращении.
  await s.lage('oleg');
  const plan = await s.post('buch', 'plan', { titel: 'Авансы на неделю', idem: idem(), zeilen: [
    { empfaenger_ref: P.A, zweck: 'vorschuss', betrag: '300,00' },
    { empfaenger_ref: P.B, zweck: 'lohn', betrag: '200,00' }] });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  const [q1] = plan.body.quittungen;

  // Подготовленная квитанция — ещё не выдача: остатки не меняются.
  assert.equal((await s.post('oleg', `quittung/${q1.id}/ausgeben`)).status, 409, 'без утверждения выдавать нельзя');
  assert.equal((await s.post('buch', `plan/${plan.body.id}/einreichen`)).status, 200);
  assert.equal((await s.post('buch', `plan/${plan.body.id}/entscheiden`, { genehmigt: true })).status, 403, 'утверждает только Андрей');
  assert.equal((await s.post('andrej', `plan/${plan.body.id}/entscheiden`, { genehmigt: true })).status, 200);

  // Снятие: отмечает только Андрей; снятие само по себе получателя не подтверждает.
  assert.equal((await s.post('buch', 'abhebung', { betrag: '2000,00' })).status, 403);
  const ab = await s.post('andrej', 'abhebung', { betrag: '2000,00', idem: idem() });
  assert.equal(ab.status, 200);
  const u1 = await s.post('andrej', 'uebergabe', { quelle_id: ab.body.id, an_konto: 'halter:oleg', betrag: '1200,00', idem: idem() });
  assert.equal(u1.status, 200);
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, 0, 'до подтверждения Олегом деньги ему не зачислены');
  assert.equal((await s.post('andrej', `bewegung/${u1.body.id}/bestaetigen`)).status, 403, 'передающий не подтверждает сам');
  assert.equal((await s.post('oleg', `bewegung/${u1.body.id}/bestaetigen`)).status, 200);
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, 120000);

  const u2 = await s.post('andrej', 'uebergabe', { quelle_id: ab.body.id, an_konto: 'hauptkasse', betrag: '800,00', idem: idem() });
  assert.equal((await s.post('buch', `bewegung/${u2.body.id}/bestaetigen`)).status, 200);
  const zuviel = await s.post('andrej', 'uebergabe', { quelle_id: ab.body.id, an_konto: 'hauptkasse', betrag: '0,01', idem: idem() });
  assert.equal(zuviel.status, 409, 'из снятия нельзя передать больше снятого');

  // Выдача по квитанции — только теперь уходят деньги.
  const aus = await s.post('oleg', `quittung/${q1.id}/ausgeben`);
  assert.equal(aus.status, 200, JSON.stringify(aus.body));
  assert.equal((await s.post('oleg', `quittung/${q1.id}/ausgeben`)).body.wiederholt, true, 'повторное нажатие не выдаёт второй раз');
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, 90000);

  // Фото подписи — Олег; оригинал — только бухгалтерия.
  const f = await s.datei('oleg');
  assert.equal((await s.post('oleg', `quittung/${q1.id}/foto`, { sha: f.body.sha })).status, 200);
  assert.equal((await s.post('oleg', `quittung/${q1.id}/original`)).status, 403);
  assert.equal((await s.post('buch', `quittung/${q1.id}/original`)).status, 200);

  // Чек из аванса: аванс и чек — не два расхода; остаток Олега не меняется.
  const bel = await belegNeu('ma_a', { art: 'material', verwendung: 'objekt', objekt_nr: 'VK-26-901', zahlart: 'vorschuss', betrag: '120,50' });
  assert.equal(bel.status, 200, JSON.stringify(bel.body));
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, 90000);
  const vor = await saldo('ma_a', 'vorschuss:' + P.A);
  assert.equal(vor.erhalten, 30000); assert.equal(vor.saldo, 30000 - 12050);
  assert.equal((await s.post('buch', `beleg/${bel.body.id}/pruefen`, { ergebnis: 'ok' })).status, 200);
  assert.equal(Number(sql(`SELECT count(*) FROM mailops_prod.buch_erstattung`)), 0, 'чек из аванса не создаёт возмещение');

  // Возврат: у Олега уменьшается сразу, касса растёт только после подтверждения бухгалтером.
  const rk = await s.post('oleg', 'rueckgabe', { betrag: '100,00', idem: idem() });
  assert.equal(rk.status, 200);
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, 80000);
  assert.equal((await saldo('buch', 'hauptkasse')).saldo, 80000);
  assert.equal((await s.post('oleg', `bewegung/${rk.body.id}/bestaetigen`)).status, 403);
  assert.equal((await s.post('buch', `bewegung/${rk.body.id}/bestaetigen`)).status, 200);
  assert.equal((await saldo('buch', 'hauptkasse')).saldo, 90000);

  // Превышение остатка при срочной выдаче; срочно подрядчику — нельзя.
  assert.equal((await s.post('oleg', 'quittung/dringend', { empfaenger_ref: P.B, zweck: 'lohn', betrag: '800,01', idem: idem() })).status, 409);
  assert.equal((await s.post('oleg', 'quittung/dringend', { empfaenger_ref: P.NU1, zweck: 'nu', betrag: '10,00', idem: idem() })).status, 400);
  const dr = await s.post('oleg', 'quittung/dringend', { empfaenger_ref: P.B, zweck: 'lohn', betrag: '50,00', idem: idem() });
  assert.equal(dr.status, 200, JSON.stringify(dr.body));
  // Расчётный остаток не выдаётся за пересчёт: в данных нет признака «сверено».
  const l = await s.lage('buch');
  assert.ok(!JSON.stringify(l).includes('gezaehlt'));
});

test('4. Личный чек: проверка → наличное возмещение через Олега; перевод — через Андрея; двойного расхода нет', async () => {
  await geldAnOleg('500,00');
  const b1 = await belegNeu('ma_b', { betrag: '64,10' });
  assert.equal(b1.status, 200);
  assert.equal((await s.lage('ma_b')).belege.find(b => b.id === b1.body.id).erstattung, null, 'до проверки возмещения нет');
  assert.equal((await s.post('ma_b', `beleg/${b1.body.id}/pruefen`, { ergebnis: 'ok' })).status, 403);
  assert.equal((await s.post('buch', `beleg/${b1.body.id}/pruefen`, { ergebnis: 'ok' })).status, 200);
  const e1 = (await s.lage('buch')).erstattungen.find(e => e.beleg_id === b1.body.id);
  assert.equal(e1.status, 'offen', 'проверенный чек ≠ выплаченное возмещение');
  const vorher = (await saldo('oleg', 'halter:oleg')).saldo;
  assert.equal((await s.post('oleg', `erstattung/${e1.id}/bar`)).status, 200);
  assert.equal((await s.post('oleg', `erstattung/${e1.id}/bar`)).body.wiederholt, true);
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, vorher - 6410);
  assert.equal(Number(sql(`SELECT count(*) FROM mailops_prod.buch_beleg WHERE betrag_cent = 6410`)), 1, 'расход один — сам чек');

  const b2 = await belegNeu('ma_b', { betrag: '20,00' });
  await s.post('buch', `beleg/${b2.body.id}/pruefen`, { ergebnis: 'ok' });
  const e2 = (await s.lage('buch')).erstattungen.find(e => e.beleg_id === b2.body.id);
  assert.equal((await s.post('buch', `erstattung/${e2.id}/weg`, { weg: 'ueberweisung' })).status, 200);
  assert.equal((await s.post('buch', `erstattung/${e2.id}/an-gf`)).status, 409, 'сначала согласование Олега');
  assert.equal((await s.post('oleg', `erstattung/${e2.id}/bar`)).status, 409, 'перевод не выдаётся наличными');
  assert.equal((await s.post('oleg', `erstattung/${e2.id}/oleg-ok`)).status, 200);
  assert.equal((await s.post('buch', `erstattung/${e2.id}/an-gf`)).status, 200);
  assert.equal((await s.post('buch', `erstattung/${e2.id}/ueberwiesen`)).status, 403, 'перевод выполняет Андрей');
  assert.equal((await s.post('andrej', `erstattung/${e2.id}/ueberwiesen`)).status, 200);
});

test('5. Подрядчик: полный счёт → подтверждение Олега → квитанции → зачёт → остаток → отдельный комплект; повторный зачёт невозможен', async () => {
  await geldAnOleg('1000,00');
  const plan = await s.post('buch', 'plan', { idem: idem(), zeilen: [
    { empfaenger_ref: P.NU1, zweck: 'nu', betrag: '500,00' }, { empfaenger_ref: P.NU2, zweck: 'nu', betrag: '300,00' },
    { empfaenger_ref: P.NUB, zweck: 'nu', betrag: '50,00' }] });
  await s.post('buch', `plan/${plan.body.id}/einreichen`);
  await s.post('andrej', `plan/${plan.body.id}/entscheiden`, { genehmigt: true });
  const [qa, qb, qfremd] = plan.body.quittungen;
  for (const q of [qa, qb, qfremd]) assert.equal((await s.post('oleg', `quittung/${q.id}/ausgeben`)).status, 200);

  const rechnung = await s.datei('buch', Buffer.from('%PDF-1.4 test ' + Math.random()), 'application/pdf');
  const pk = await s.post('buch', 'paket', { idem: idem(), lieferant_name: 'Подрядчик А · пример', rechnung_nr: 'RE-0923', brutto: '10000,00',
    datei_sha: rechnung.body.sha, objekt_nr: 'VK-26-901' });
  assert.equal(pk.status, 200, JSON.stringify(pk.body));
  assert.equal((await s.post('buch', 'paket', { idem: idem(), lieferant_name: 'Подрядчик А · пример', rechnung_nr: 'RE-0923', brutto: '1,00', datei_sha: rechnung.body.sha })).status, 409, 'один счёт — один комплект');

  assert.equal((await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: qa.id })).status, 200);
  assert.equal((await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: qa.id })).status, 409, 'повторный зачёт');
  assert.equal((await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: qfremd.id })).status, 409, 'чужой подрядчик');
  const teil = await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: qb.id, betrag: '200,00' });
  assert.equal(teil.body.rest_quittung, 10000, 'остаток квитанции хранится');

  const pk2 = await s.post('buch', 'paket', { idem: idem(), lieferant_name: 'Подрядчик А · пример', rechnung_nr: 'RE-0924', brutto: '500,00', datei_sha: rechnung.body.sha });
  assert.equal((await s.post('buch', `paket/${pk2.body.id}/verrechnen`, { quittung_id: qb.id, betrag: '100,01' })).status, 409);
  assert.equal((await s.post('buch', `paket/${pk2.body.id}/verrechnen`, { quittung_id: qb.id })).status, 200);
  assert.equal((await s.post('buch', `paket/${pk2.body.id}/verrechnen`, { quittung_id: qa.id })).status, 409, 'квитанция уже зачтена в другом счёте');

  let p = (await s.lage('buch')).pakete.find(x => x.id === pk.body.id);
  assert.equal(p.brutto, 1000000, 'полная сумма работ не уменьшается');
  assert.equal(p.verrechnet, 70000); assert.equal(p.zu_zahlen, 930000);

  assert.equal((await s.post('buch', `paket/${pk.body.id}/an-gf`)).status, 409, 'без Олега и проверки не передаётся');
  assert.equal((await s.post('buch', `paket/${pk.body.id}/oleg`, { status: 'bestaetigt' })).status, 400, 'бухгалтер фиксирует только с документом Олега');
  assert.equal((await s.post('oleg', `paket/${pk.body.id}/oleg`, { status: 'bestaetigt', text: 'Объём сверил на объекте' })).status, 200);
  assert.equal((await s.post('buch', `paket/${pk.body.id}/geprueft`)).status, 200);
  const blockiert = await s.post('buch', `paket/${pk.body.id}/an-gf`);
  assert.equal(blockiert.status, 409); assert.match(blockiert.body.fehler, /Q-/);
  for (const q of [qa, qb]) {
    const f = await s.datei('oleg');
    await s.post('oleg', `quittung/${q.id}/foto`, { sha: f.body.sha });
    assert.equal((await s.post('buch', `quittung/${q.id}/nu-bestaetigt`, { notiz: 'Письмо подрядчика 23.09' })).status, 200);
  }
  assert.equal((await s.post('buch', `paket/${pk.body.id}/iban`, { iban: 'DE89 3704 0044 0532 0130 01', quelle: '' })).status, 400, 'без источника реквизитов');
  assert.equal((await s.post('buch', `paket/${pk.body.id}/iban`, { iban: 'DE89 3704 0044 0532 0130 02', quelle: 'Счёт стр. 1' })).status, 400, 'неверный IBAN');
  assert.equal((await s.post('buch', `paket/${pk.body.id}/an-gf`)).status, 200);
  assert.equal((await s.post('buch', `paket/${pk.body.id}/verrechnen`, { quittung_id: qb.id })).status, 409, 'после передачи зачёт не меняется');
  assert.equal((await s.post('buch', `paket/${pk.body.id}/bezahlt`)).status, 403);
  assert.equal((await s.post('andrej', `paket/${pk.body.id}/gesehen`)).status, 200);
  assert.equal((await s.post('andrej', `paket/${pk.body.id}/bezahlt`)).status, 200);
  p = (await s.lage('buch')).pakete.find(x => x.id === pk.body.id);
  assert.equal(p.status, 'bezahlt_gemeldet'); assert.equal(p.bank_op, null, 'банком перевод не подтверждён, пока нет связи с операцией');
  assert.equal(p.iban, null, 'реквизиты не подставлены');
});

test('6a. Запросы: 2 рабочих дня сотруднику, 1 — Олегу, затем Андрей; потерянный чек — сразу бухгалтеру и Андрею', async () => {
  // Среда 23.09.2026 → сотруднику до пятницы 25.09, Олегу — понедельник 28.09.
  assert.equal(wt.fristEnde('2026-09-23T08:00:00Z', 2), '2026-09-25');
  assert.equal(wt.fristEnde('2026-09-23T08:00:00Z', 3), '2026-09-28');
  assert.equal(wt.stufe('2026-09-23T08:00:00Z', Date.parse('2026-09-25T20:00:00Z')).stufe, 'mitarbeiter');
  assert.equal(wt.stufe('2026-09-23T08:00:00Z', Date.parse('2026-09-26T08:00:00Z')).stufe, 'oleg');
  assert.equal(wt.stufe('2026-09-23T08:00:00Z', Date.parse('2026-09-29T06:00:00Z')).stufe, 'gf');
  // Праздник 03.10 (суббота в 2026) и Allerheiligen 01.11 (воскресенье); 06.01.2027 — среда, праздник Баварии.
  assert.equal(wt.fristEnde('2027-01-05T10:00:00Z', 1), '2027-01-07');
  assert.equal(wt.istWerktag('2026-08-15'), false, 'суббота');
  assert.equal(wt.istWerktag('2027-08-16'), true);

  const r = await s.post('buch', 'rueckfrage', { idem: idem(), bezug_art: 'bank', bezug_id: 'op-1', titel: 'Не хватает чека',
    betrag: '64,90', person_ref: P.A, zahlart_text: 'Карта фирмы', objekt_text: 'Автомобиль А', text: 'Пришлите чек' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.benachrichtigung, /не отправлялись/);
  assert.ok((await s.lage('ma_a')).rueckfragen.some(x => x.id === r.body.id));
  assert.ok(!(await s.lage('ma_b')).rueckfragen.some(x => x.id === r.body.id), 'чужой запрос не виден');
  assert.ok(!(await s.lage('oleg')).rueckfragen.some(x => x.id === r.body.id), 'Олегу — только после 2 рабочих дней');
  sql(`UPDATE mailops_prod.buch_rueckfrage SET frist_basis = now() - interval '4 days' - interval '1 hour' WHERE id = ${r.body.id}`);
  const beiOleg = (await s.lage('buch')).rueckfragen.find(x => x.id === r.body.id).stufe;
  assert.ok(['oleg', 'gf'].includes(beiOleg));
  sql(`UPDATE mailops_prod.buch_rueckfrage SET frist_basis = now() - interval '9 days' WHERE id = ${r.body.id}`);
  assert.equal((await s.lage('buch')).rueckfragen.find(x => x.id === r.body.id).stufe, 'gf');
  assert.ok((await s.lage('oleg')).rueckfragen.some(x => x.id === r.body.id));

  // Ответ не закрывает вопрос; закрывает бухгалтер с записью проверки.
  const f = await s.datei('ma_a');
  const bel = await s.post('ma_a', 'beleg', { idem: idem(), art: 'kraftstoff', betrag: '64,90', verwendung: 'fahrzeug', fahrzeug_ref: P.AUTO_A,
    zahlart: 'firmenkarte', datei_sha: f.body.sha, rueckfrage_id: r.body.id });
  assert.equal(bel.status, 200, JSON.stringify(bel.body));
  let rf = (await s.lage('buch')).rueckfragen.find(x => x.id === r.body.id);
  assert.equal(rf.status, 'beantwortet');
  assert.equal((await s.post('ma_a', `rueckfrage/${r.body.id}/schliessen`, { notiz: 'x' })).status, 403);
  assert.equal((await s.post('buch', `rueckfrage/${r.body.id}/schliessen`, {})).status, 400);
  assert.equal((await s.post('buch', `rueckfrage/${r.body.id}/schliessen`, { notiz: 'Чек читается, сумма совпадает с картой' })).status, 200);

  const r2 = await s.post('buch', 'rueckfrage', { idem: idem(), bezug_art: 'frei', titel: 'Чек за материалы', person_ref: P.A, text: 'Где чек?' });
  assert.equal((await s.post('ma_a', `rueckfrage/${r2.body.id}/verlust`, { text: 'Потерял на объекте' })).status, 200);
  rf = (await s.lage('buch')).rueckfragen.find(x => x.id === r2.body.id);
  assert.equal(rf.stufe, 'gf'); assert.equal(rf.verlust, true); assert.equal(rf.status, 'beantwortet');
  assert.ok(!(await s.lage('oleg')).rueckfragen.some(x => x.id === r2.body.id), 'потеря идёт бухгалтеру и Андрею, не Олегу');
  assert.ok((await s.lage('andrej')).rueckfragen.some(x => x.id === r2.body.id));
});

test('6b. Двойное нажатие, отказ сети с повтором, одинаковый файл параллельно', async () => {
  const f = await s.datei('ma_a');
  const body = { idem: idem(), art: 'kraftstoff', betrag: '10,00', verwendung: 'kanister', zahlart: 'privat', datei_sha: f.body.sha };
  const res = await Promise.all(Array.from({ length: 6 }, () => s.post('ma_a', 'beleg', body)));
  assert.ok(res.every(r => r.status === 200), JSON.stringify(res.map(r => r.body)));
  assert.equal(new Set(res.map(r => r.body.nr)).size, 1, 'шесть нажатий — один чек');
  // «Сеть оборвалась после отправки»: повтор с тем же ключом возвращает тот же чек.
  const nochmal = await s.post('ma_a', 'beleg', body);
  assert.equal(nochmal.body.wiederholt, true);

  // Один и тот же снимок с разными ключами параллельно — принят ровно один.
  const g = await s.datei('ma_a');
  const par = await Promise.all(Array.from({ length: 5 }, () => s.post('ma_a', 'beleg', { ...body, idem: idem(), datei_sha: g.body.sha })));
  assert.equal(par.filter(r => r.status === 200).length, 1, JSON.stringify(par.map(r => [r.status, r.body])));
  assert.ok(par.filter(r => r.status !== 200).every(r => r.status === 409));
  assert.equal(Number(sql(`SELECT count(*) FROM mailops_prod.buch_beleg WHERE datei_sha = '${g.body.sha}'`)), 1);
  // Повторная загрузка того же файла сообщает, что он уже есть.
  const erneut = await fetch(s.basis + '/api/k/datei', { method: 'POST', headers: { Cookie: await s.login('ma_a'), 'Content-Type': 'image/jpeg' }, body: jpeg() });
  assert.equal(erneut.status, 200);
  assert.equal((await s.datei('ma_a', Buffer.from('not an image'), 'image/jpeg')).status, 415, 'подмена типа файла');
});

test('6c. Превышение остатка при параллельной выдаче', async () => {
  const vorher = (await saldo('oleg', 'halter:oleg')).saldo;
  const teil = Math.floor(vorher * 0.6);
  const betrag = (teil / 100).toFixed(2).replace('.', ',');
  const res = await Promise.all([1, 2].map(() => s.post('oleg', 'quittung/dringend', { empfaenger_ref: P.A, zweck: 'vorschuss', betrag, idem: idem() })));
  assert.deepEqual(res.map(r => r.status).sort(), [200, 409]);
  assert.ok((await saldo('oleg', 'halter:oleg')).saldo >= 0, 'остаток не уходит в минус');
});

test('6d. Права доступа', async () => {
  const b = await belegNeu('ma_a', { betrag: '5,55' });
  const sha = (await s.lage('ma_a')).belege.find(x => x.id === b.body.id).datei;
  assert.equal((await s.api('ma_b', 'GET', '/api/k/datei/' + sha)).status, 404, 'чужой документ не открывается');
  assert.equal((await s.api('ma_a', 'GET', '/api/k/datei/' + sha)).status, 200);
  assert.equal((await s.api('ma_a', 'GET', '/api/razn')).status, 403, 'классические разделы сотруднику закрыты');
  assert.equal((await s.api('oleg', 'PUT', '/api/state', { collection: 'zuordnung', id: 'x', wert: {} })).status, 403);
  assert.equal((await s.api('office', 'GET', '/api/k/lage')).status, 403, 'офису касса не открыта');
  assert.equal((await s.api('ma_a', 'GET', '/api/k/bank')).status, 403);
  const lm = await s.lage('ma_a');
  assert.equal(lm.personen.length, 0, 'сотрудник не видит список людей');
  assert.ok(lm.belege.every(x => x.person_ref === P.A), 'только свои чеки');
  assert.ok(!lm.konten.some(k => k.id === 'hauptkasse' || k.art === 'halter'), 'сотрудник не видит кассу и деньги Олега');
  assert.ok((await s.lage('oleg')).belege.every(x => x.person_ref === P.OLEG), 'Олег не видит чужие чеки');
  assert.equal((await s.post('ma_a', 'rueckfrage', { titel: 'x', person_ref: P.B, text: 'x' })).status, 403);
  assert.equal((await s.post('oleg', 'abhebung', { betrag: '1,00' })).status, 403);
  const k = await fetch(s.basis + '/api/k/lage');
  assert.equal(k.status, 401, 'без входа ничего');
  const start = await s.api('ma_a', 'GET', '/');
  assert.equal(start.status, 302, 'сотрудник со входа попадает в кассу');
});

test('Регресс: бухгалтер проверяет чек, который внёс за рабочего; свой расход — нет', async () => {
  const f = await s.datei('buch');
  const fuer = await s.post('buch', 'beleg', { idem: idem(), art: 'material', betrag: '42,00', verwendung: 'objekt', objekt_nr: 'VK-26-902',
    zahlart: 'privat', datei_sha: f.body.sha, person_ref: P.B });
  assert.equal(fuer.status, 200, JSON.stringify(fuer.body));
  assert.equal((await s.lage('buch')).belege.find(x => x.id === fuer.body.id).eigen, false);
  assert.equal((await s.post('buch', `beleg/${fuer.body.id}/pruefen`, { ergebnis: 'ok' })).status, 200);

  const g = await s.datei('buch');
  const eigen = await s.post('buch', 'beleg', { idem: idem(), art: 'material', betrag: '12,00', verwendung: 'mehrere', zahlart: 'privat', datei_sha: g.body.sha });
  assert.equal((await s.post('buch', `beleg/${eigen.body.id}/pruefen`, { ergebnis: 'ok' })).status, 403);
  assert.equal((await s.post('andrej', `beleg/${eigen.body.id}/pruefen`, { ergebnis: 'ok' })).status, 200);
});

test('Регресс: отклонение чека не возвращает деньги в остаток', async () => {
  await geldAnOleg('100,00');
  const vorher = (await saldo('oleg', 'halter:oleg')).saldo;
  const b = await belegNeu('oleg', { art: 'material', verwendung: 'objekt', objekt_nr: 'VK-26-901', zahlart: 'vorschuss', betrag: '30,00' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, vorher - 3000);
  assert.equal((await s.post('buch', `beleg/${b.body.id}/pruefen`, { ergebnis: 'abgelehnt' })).status, 400, 'нужна причина');
  assert.equal((await s.post('buch', `beleg/${b.body.id}/pruefen`, { ergebnis: 'abgelehnt', notiz: 'Чек нечитаем' })).status, 200);
  assert.equal((await saldo('oleg', 'halter:oleg')).saldo, vorher - 3000, 'остаток не вырос');
  assert.equal((await s.lage('buch')).belege.find(x => x.id === b.body.id).geld_ohne_beleg, true);
});

test('Регресс: оплата из основной кассы проверяет остаток под блокировкой', async () => {
  const kasse = (await saldo('buch', 'hauptkasse')).saldo;
  const f = await s.datei('buch');
  const zuviel = await s.post('buch', 'beleg', { idem: idem(), art: 'material', betrag: ((kasse + 1) / 100).toFixed(2).replace('.', ','),
    verwendung: 'mehrere', zahlart: 'kasse', datei_sha: f.body.sha, person_ref: P.B });
  assert.equal(zuviel.status, 409, JSON.stringify(zuviel.body));
  const half = Math.floor(kasse * 0.6);
  const betrag = (half / 100).toFixed(2).replace('.', ',');
  const par = await Promise.all([1, 2].map(async () => {
    const d = await s.datei('buch');
    return s.post('buch', 'beleg', { idem: idem(), art: 'material', betrag, verwendung: 'mehrere', zahlart: 'kasse', datei_sha: d.body.sha, person_ref: P.B });
  }));
  assert.deepEqual(par.map(r => r.status).sort(), [200, 409]);
  assert.ok((await saldo('buch', 'hauptkasse')).saldo >= 0);
});

test('Банк: без FinMap честно сообщает недоступность, данные не подставляются', async () => {
  const r = await s.api('buch', 'GET', '/api/k/bank?monat=2026-09');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false); assert.deepEqual(r.body.liste, []);
});

test('Журнал: каждое действие записано с автором и временем', async () => {
  const n = Number(sql(`SELECT count(*) FROM mailops_prod.buch_ereignis`));
  assert.ok(n > 40, 'событий ' + n);
  assert.equal(Number(sql(`SELECT count(*) FROM mailops_prod.buch_ereignis WHERE wer IS NULL OR wann IS NULL`)), 0);
});
