/* ----------------------------------------------------------------
   Сверка банковских платежей со счетами.

   Банковский источник — существующий (в бою FinMap/синхронизация банка);
   здесь его локальное представление bank_bewegung, идемпотентное по extern_id.
   Второй параллельный учёт не заводим. Счета — существующая модель beleg.

   Правила: один перевод — несколько счетов (подтверждает бухгалтер, не по одной
   сумме); частичная оплата с сохранением срока остатка; переплата — отдельно за
   поставщиком; возврат — задача и восстановление остатка; нераспределённый — в
   остатке банка, но задача и без расхода; автосписание/UTA; свежесть данных перед
   выводом об отсутствии списания; расхождение суммы не списываем сами; Skonto после
   проверки, скидка отдельно; SLA 1 р.д. и риск Андрею; контроль сумм и повторов.
   Реальные переводы не выполняются.
   ---------------------------------------------------------------- */
'use strict';
const razn = require('./razn.js');
const wt = require('./kasse/werktage.js');
const aufgaben = require('./aufgaben.js');
let integration = null; try { integration = require('./integration.js'); } catch (e) {}
let audit = null; try { audit = require('./audit.js'); } catch (e) {}

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) { const cl = pg(); try { await cl.connect(); return await fn(cl); } finally { try { await cl.end(); } catch (e) {} } }

function jetzt() { return process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date(); }
function heute() { return wt.berlinTag(jetzt().getTime()); }
function tag(d) { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const z = new Date(d); return new Date(z.getTime() - z.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function cent(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : null; }
function task(b) { try { return aufgaben.systemAufgabe(b); } catch (e) { return null; } }
async function jlog(e) { if (audit) { try { await audit.schreiben(e); } catch (x) {} } }

// сумма платежа, уже распределённая (деньги из перевода); skonto сюда не входит
async function verteilt(cl, bewId) {
  return Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM zahlung_zuordnung WHERE bewegung_id=$1 AND NOT storniert", [bewId])).rows[0].s);
}
// оплачено по счёту = деньги + skonto; остаток = сумма счёта − оплачено
async function belegStand(cl, belegId) {
  const b = (await cl.query('SELECT betrag_cent FROM beleg WHERE id=$1', [belegId])).rows[0];
  if (!b) return null;
  const r = (await cl.query("SELECT coalesce(sum(betrag_cent),0) geld, coalesce(sum(skonto_cent),0) skonto FROM zahlung_zuordnung WHERE beleg_id=$1 AND NOT storniert", [belegId])).rows[0];
  const summe = Number(b.betrag_cent || 0), bezahlt = Number(r.geld) + Number(r.skonto), rest = summe - bezahlt;
  return { summe, geld: Number(r.geld), skonto: Number(r.skonto), bezahlt, rest, status: bezahlt <= 0 ? 'offen' : (rest > 0 ? 'teilweise' : 'bezahlt') };
}

// предложения сопоставления: контрагент, назначение (номера счетов), валюта, сумма. Не закрываем сами.
async function vorschlag(cl, bew) {
  const zweck = String(bew.verwendungszweck || '').toLowerCase();
  const rows = (await cl.query(
    "SELECT id, lieferant, lieferant_key, rechnung_nr, betrag_cent, waehrung_ok FROM (SELECT b.*, true waehrung_ok FROM beleg b) x WHERE lieferant_key=$1 AND status<>'storniert'", [bew.gegenpartei_key || '\u0000'])).rows;
  const out = [];
  for (const r of rows) {
    const st = await belegStand(cl, r.id); if (!st || st.rest <= 0) continue;
    const gruende = []; let staerke = 'schwach';
    if (r.rechnung_nr && zweck.includes(String(r.rechnung_nr).toLowerCase())) { gruende.push('номер счёта в назначении'); staerke = 'stark'; }
    if (st.rest === Number(bew.betrag_cent)) { gruende.push('сумма совпадает с остатком счёта'); if (staerke !== 'stark') staerke = 'mittel'; }
    if (bew.waehrung && bew.waehrung !== 'EUR') gruende.push('валюта ' + bew.waehrung);
    gruende.push('тот же контрагент');
    out.push({ beleg_id: r.id, lieferant: r.lieferant, rechnung_nr: r.rechnung_nr, betrag_cent: Number(r.betrag_cent), rest_cent: st.rest, gruende, staerke });
  }
  out.sort((a, b) => (a.staerke === 'stark' ? -1 : 1) - (b.staerke === 'stark' ? -1 : 1));
  return out;
}

// свежесть банковских данных (существующий индикатор интеграций)
async function bankFrisch() {
  if (!integration) return { veraltet: false, vorlaeufig: false, stand: null, bekannt: false };
  try { const s = await integration.statusListe(); return { veraltet: !!s.bank_vorlaeufig, vorlaeufig: !!s.bank_vorlaeufig, stand: s.bank_stand || null, bekannt: true }; }
  catch (e) { return { veraltet: false, vorlaeufig: false, stand: null, bekannt: false }; }
}

// Импорт банковского движения. Идемпотентно по extern_id. Расход из факта списания не создаём.
async function zahlungImport(d, user) {
  return mit(async (cl) => {
    const ext = d.extern_id ? String(d.extern_id) : null;
    if (ext) {
      const da = (await cl.query('SELECT id, status FROM bank_bewegung WHERE extern_id=$1', [ext])).rows[0];
      if (da) return { ok: true, wiederholung: true, id: da.id, status: da.status, grund: 'повторный импорт — движение уже есть' };
    }
    const betrag = cent(d.betrag != null ? d.betrag : d.betrag_cent);
    if (!(betrag > 0)) throw new Error('нужна сумма операции');
    const gp = String(d.gegenpartei || '').trim();
    const von = (user && user.login) || 'system';
    const ins = await cl.query(
      `INSERT INTO bank_bewegung (extern_id, richtung, betrag_cent, waehrung, datum, gegenpartei, gegenpartei_key, verwendungszweck, iban, konto, art, von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [ext, d.richtung === 'eingang' ? 'eingang' : 'ausgang', betrag, (d.waehrung || 'EUR').toUpperCase(),
       /^\d{4}-\d{2}-\d{2}$/.test(String(d.datum || '')) ? d.datum : heute(), gp || null, razn.schluessel(gp) || null,
       String(d.verwendungszweck || '').slice(0, 400) || null, String(d.iban || '').replace(/\s/g, '').toUpperCase() || null,
       String(d.konto || '').slice(0, 80) || null, d.art === 'lastschrift' ? 'lastschrift' : 'ueberweisung', von]);
    const bew = ins.rows[0];
    const vor = await vorschlag(cl, bew);
    // основание не найдено -> «Нераспределённый платёж» + задача + срок 1 р.д. (правила 5,10)
    let frist = null;
    if (!vor.length) {
      frist = wt.fristEnde(heute(), 1);
      await cl.query('UPDATE bank_bewegung SET pruef_frist=$2 WHERE id=$1', [bew.id, frist]);
      const t = task({ titel: 'Нераспределённый платёж — найти основание', ziel_rolle: 'buchhaltung', art: 'zahlung_offen',
        text: 'Платёж #' + bew.id + ' (' + (gp || 'контрагент?') + ', ' + (betrag / 100).toFixed(2) + ' €) без счёта-основания. Разобрать за 1 р.д. Расход из факта списания не создавать.', bezug: 'bank:' + bew.id });
      await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, aufgabe_id, von) VALUES ($1,'nicht_zugeordnet',$2,$3,$4,$5)", [bew.id, 'основание не найдено', betrag, t && t.id, von]);
    }
    await jlog({ wer: von, rolle: user && user.rolle, art: 'bank_import', ziel: 'bank:' + bew.id });
    return { ok: true, id: bew.id, status: bew.status, betrag_cent: betrag, vorschlag: vor, pruef_frist: frist, ohne_grund: !vor.length };
  });
}

module.exports = {};

async function bewLaden(cl, id) { return (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1 FOR UPDATE', [Number(id)])).rows[0]; }
async function statusNeu(cl, bew) {
  const v = await verteilt(cl, bew.id);
  let st = bew.status;
  if (bew.status !== 'zurueckgebucht' && bew.status !== 'rueckbuchung_pruefen') {
    st = v <= 0 ? 'nicht_zugeordnet' : (v >= Number(bew.betrag_cent) ? 'zugeordnet' : 'teilweise');
    if (bew.status === 'ueberzahlt') st = 'ueberzahlt';   // решение по переплате не сбрасываем
  }
  await cl.query('UPDATE bank_bewegung SET status=$2 WHERE id=$1', [bew.id, st]);
  return st;
}
async function belegSync(cl, belegId) {
  const st = await belegStand(cl, belegId);
  if (st) await cl.query('UPDATE beleg SET bezahlt=$2 WHERE id=$1', [belegId, st.rest <= 0 && st.bezahlt > 0]);
  return st;
}

// 1,2,9,11) распределение платежа на счета. Не сверх платежа и не сверх остатка счёта.
async function zuordnen(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id);
    if (!bew) throw new Error('платёж не найден');
    if (bew.storniert || bew.status === 'zurueckgebucht') throw new Error('платёж возвращён/сторнирован');
    const teile = Array.isArray(d.teile) ? d.teile : [];
    if (!teile.length) throw new Error('нет распределения');
    const von = (user && user.login) || 'system';
    const vorHer = await verteilt(cl, bew.id);
    let neu = 0; for (const t of teile) neu += Math.max(0, cent(t.betrag) || 0);
    if (vorHer + neu > Number(bew.betrag_cent)) throw new Error('сумма распределения превышает платёж (нельзя распределить одну сумму дважды)');
    const ergeb = [];
    for (const t of teile) {
      const belegId = Number(t.beleg_id); if (!belegId) throw new Error('нет счёта');
      const geld = Math.max(0, cent(t.betrag) || 0), sk = Math.max(0, cent(t.skonto) || 0);
      if (geld <= 0 && sk <= 0) continue;
      const st = await belegStand(cl, belegId); if (!st) throw new Error('счёт #' + belegId + ' не найден');
      if (geld + sk > st.rest) throw new Error('по счёту #' + belegId + ' сумма+скидка больше остатка (' + (st.rest / 100).toFixed(2) + ' €) — счёт не закрываем сверх долга');
      if (sk > 0 && !String(t.grund || d.grund || '').trim()) throw new Error('для Skonto укажите основание (условие и срок скидки)');
      await cl.query('INSERT INTO zahlung_zuordnung (bewegung_id, beleg_id, betrag_cent, skonto_cent, art, grund, von) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [bew.id, belegId, geld, sk, sk > 0 ? 'skonto' : 'zahlung', String(t.grund || d.grund || '').slice(0, 300), von]);
      await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, beleg_id, art, text, betrag_cent, von) VALUES ($1,$2,$3,$4,$5,$6)",
        [bew.id, belegId, sk > 0 ? 'skonto_gewaehrt' : 'zuordnung', sk > 0 ? ('оплата ' + (geld / 100).toFixed(2) + ' € + скидка ' + (sk / 100).toFixed(2) + ' €') : ('оплата ' + (geld / 100).toFixed(2) + ' €'), geld, von]);
      const st2 = await belegSync(cl, belegId);
      ergeb.push({ beleg_id: belegId, geld, skonto: sk, rest: st2.rest, status: st2.status });
    }
    const status = await statusNeu(cl, bew);
    const v = await verteilt(cl, bew.id);
    await jlog({ wer: von, rolle: user && user.rolle, art: 'bank_zuordnung', ziel: 'bank:' + bew.id });
    return { ok: true, status, verteilt: v, rest_zahlung: Number(bew.betrag_cent) - v, teile: ergeb,
      invariante_ok: (v + (Number(bew.betrag_cent) - v)) === Number(bew.betrag_cent) };
  });
}

async function zuordnungStorno(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id); if (!id) throw new Error('нет id');
    const z = (await cl.query('SELECT * FROM zahlung_zuordnung WHERE id=$1', [id])).rows[0];
    if (!z) throw new Error('распределение не найдено');
    if (z.storniert) return { ok: true, wiederholt: true };
    await cl.query('UPDATE zahlung_zuordnung SET storniert=true WHERE id=$1', [id]);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, beleg_id, art, text, betrag_cent, von) VALUES ($1,$2,'storno',$3,$4,$5)",
      [z.bewegung_id, z.beleg_id, 'снято распределение', z.betrag_cent, (user && user.login) || 'system']);
    const bew = (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1', [z.bewegung_id])).rows[0];
    await statusNeu(cl, bew); await belegSync(cl, z.beleg_id);
    return { ok: true };
  });
}

// 3) переплата: сумму сверх долга оставляем за поставщиком; решение — возврат или зачёт. Не распределяем сами.
async function ueberzahlung(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id); if (!bew) throw new Error('платёж не найден');
    const v = await verteilt(cl, bew.id);
    const rest = Number(bew.betrag_cent) - v;
    if (rest <= 0) throw new Error('переплаты нет (остаток платежа 0)');
    const ent = d.entscheidung === 'verrechnung' ? 'verrechnung' : 'rueckzahlung';
    await cl.query("UPDATE bank_bewegung SET status='ueberzahlt', ueberzahlung_entscheidung=$2 WHERE id=$1", [bew.id, ent]);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, von) VALUES ($1,'ueberzahlung',$2,$3,$4)",
      [bew.id, 'переплата за поставщиком: ' + (ent === 'verrechnung' ? 'зачёт в счёт будущих' : 'возврат') + '. ' + String(d.grund || '').slice(0, 200), rest, (user && user.login) || 'system']);
    return { ok: true, rest_cent: rest, entscheidung: ent };
  });
}

// 4) возврат/отмена платежа: задача бухгалтеру; подтверждение восстанавливает остаток, связь и историю сохраняются, риск просрочки, новый перевод не создаём.
async function rueckbuchung(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id); if (!bew) throw new Error('платёж не найден');
    if (bew.status === 'zurueckgebucht') return { ok: true, wiederholt: true };
    await cl.query("UPDATE bank_bewegung SET status='rueckbuchung_pruefen' WHERE id=$1", [bew.id]);
    const t = task({ titel: 'Возврат/отмена платежа — проверить', ziel_rolle: 'buchhaltung', art: 'rueckbuchung',
      text: 'Платёж #' + bew.id + ' (' + (bew.gegenpartei || '') + ', ' + (Number(bew.betrag_cent) / 100).toFixed(2) + ' €) вернулся/отменён. Проверить и подтвердить восстановление остатка. Новый перевод не создавать.', bezug: 'bank:' + bew.id });
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, aufgabe_id, von) VALUES ($1,'rueckbuchung',$2,$3,$4,$5)",
      [bew.id, 'возврат/отмена — на проверку', bew.betrag_cent, t && t.id, (user && user.login) || 'system']);
    return { ok: true, status: 'rueckbuchung_pruefen' };
  });
}
async function rueckbuchungBestaetigen(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id); if (!bew) throw new Error('платёж не найден');
    if (bew.status === 'zurueckgebucht') return { ok: true, wiederholt: true };
    const zs = (await cl.query('SELECT * FROM zahlung_zuordnung WHERE bewegung_id=$1 AND NOT storniert', [bew.id])).rows;
    const risiko = [];
    for (const z of zs) {
      await cl.query('UPDATE zahlung_zuordnung SET storniert=true WHERE id=$1', [z.id]);   // связь сохраняется строкой (storniert), не удаляется
      const st = await belegSync(cl, z.beleg_id);
      const b = (await cl.query('SELECT rechnung_nr, lieferant, faellig FROM beleg WHERE id=$1', [z.beleg_id])).rows[0];
      if (st && st.rest > 0 && b && b.faellig && tag(b.faellig) < heute()) risiko.push({ beleg_id: z.beleg_id, rest: st.rest, faellig: tag(b.faellig) });
    }
    await cl.query("UPDATE bank_bewegung SET status='zurueckgebucht', storniert=true WHERE id=$1", [bew.id]);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, von) VALUES ($1,'rueckbuchung',$2,$3,$4)",
      [bew.id, 'возврат подтверждён: восстановлены неоплаченные остатки, связь сохранена', bew.betrag_cent, (user && user.login) || 'system']);
    if (risiko.length) task({ titel: 'Риск просрочки после возврата платежа', ziel_rolle: 'gf', art: 'rueckbuchung_risiko',
      text: 'После возврата платежа #' + bew.id + ' восстановлены просроченные остатки по счетам: ' + risiko.map(r => '#' + r.beleg_id + ' (' + (r.rest / 100).toFixed(2) + ' €, срок ' + r.faellig + ')').join(', '), bezug: 'bank:' + bew.id });
    return { ok: true, status: 'zurueckgebucht', wiederhergestellt: zs.length, risiko_ueberfaellig: risiko };
  });
}

// 6) автосписание: явно по счёту (не огулом по всему поставщику).
async function autoSetzen(d, user) {
  return mit(async (cl) => {
    const id = Number(d.beleg_id); if (!id) throw new Error('нет счёта');
    const auto = d.autolastschrift !== false;
    const faellig = /^\d{4}-\d{2}-\d{2}$/.test(String(d.auto_faellig || '')) ? d.auto_faellig : null;
    await cl.query('UPDATE beleg SET autolastschrift=$2, auto_faellig=$3 WHERE id=$1', [id, auto, faellig]);
    return { ok: true, autolastschrift: auto, auto_faellig: faellig };
  });
}

// 7) отсутствующее автосписание: сначала свежесть данных; при устаревших — проблема обновления, не «списания не было». Ручной перевод не создаём.
async function autoPruefung(d, user) {
  return mit(async (cl) => {
    const frisch = await bankFrisch();
    const faellige = (await cl.query(
      "SELECT id, lieferant, betrag_cent, auto_faellig FROM beleg WHERE autolastschrift AND NOT bezahlt AND auto_faellig IS NOT NULL AND auto_faellig < $1 ORDER BY auto_faellig", [heute()])).rows;
    if (!faellige.length) return { ok: true, frisch, offen: [], hinweis: 'просроченных ожиданий автосписания нет' };
    if (frisch.veraltet) return { ok: true, frisch, daten_veraltet: true, offen: faellige.map(b => ({ beleg_id: b.id, lieferant: b.lieferant, auto_faellig: tag(b.auto_faellig) })),
      hinweis: 'банковские данные устарели — сначала обновить синхронизацию; вывод «списания не было» делать нельзя' };
    const aufgaben_neu = [];
    for (const b of faellige) {
      const schon = (await cl.query("SELECT 1 FROM zahlung_ereignis WHERE beleg_id=$1 AND art='auto_fehlt' AND am > now()-interval '3 days'", [b.id])).rows[0];
      if (schon) continue;
      const t = task({ titel: 'Автосписание не прошло — выяснить причину', ziel_rolle: 'buchhaltung', art: 'auto_fehlt',
        text: 'По счёту #' + b.id + ' (' + b.lieferant + ', ' + (Number(b.betrag_cent) / 100).toFixed(2) + ' €) ожидалось автосписание к ' + tag(b.auto_faellig) + ', его нет. Данные банка актуальны. Ручной перевод не создавать.', bezug: 'beleg:' + b.id });
      await cl.query("INSERT INTO zahlung_ereignis (beleg_id, art, text, aufgabe_id, von) VALUES ($1,'auto_fehlt',$2,$3,$4)", [b.id, 'ожидаемое автосписание не найдено', t && t.id, (user && user.login) || 'system']);
      aufgaben_neu.push(b.id);
    }
    return { ok: true, frisch, daten_veraltet: false, aufgaben: aufgaben_neu, offen: faellige.map(b => ({ beleg_id: b.id, lieferant: b.lieferant, auto_faellig: tag(b.auto_faellig) })) };
  });
}

// 8) расхождение суммы автосписания: фиксируем объяснение; полностью не закрываем и разницу не списываем сами.
async function differenzErklaeren(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id); if (!bew) throw new Error('платёж не найден');
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, von) VALUES ($1,'auto_differenz',$2,$3,$4)",
      [bew.id, String(d.erklaerung || 'расхождение суммы: несколько счетов / кредит-нота / комиссия').slice(0, 300), Number(bew.betrag_cent), (user && user.login) || 'system']);
    return { ok: true };
  });
}

// 9) Skonto: закрыть счёт меньшим платежом; скидка отдельно, без ложного остатка. Налоги — по правилам проекта (отдельно).
async function skontoAbschluss(d, user) {
  const teile = [{ beleg_id: d.beleg_id, betrag: d.betrag, skonto: d.skonto, grund: d.grund }];
  const r = await zuordnen({ bewegung_id: d.bewegung_id, teile }, user);
  return { ...r, hinweis: 'скидка сохранена отдельно от платежа; налоговую обработку провести по согласованным правилам проекта' };
}

// 5) остаток банка = сумма движений, независимо от распределения.
async function bankSaldo(cl) {
  const r = (await cl.query("SELECT coalesce(sum(CASE WHEN richtung='eingang' THEN betrag_cent ELSE -betrag_cent END),0) s FROM bank_bewegung WHERE NOT storniert")).rows[0];
  return Number(r.s);
}

async function eins(id) {
  return mit(async (cl) => {
    const bew = (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1', [Number(id)])).rows[0];
    if (!bew) throw new Error('платёж не найден');
    const zu = (await cl.query(
      `SELECT z.*, b.lieferant, b.rechnung_nr FROM zahlung_zuordnung z LEFT JOIN beleg b ON b.id=z.beleg_id WHERE z.bewegung_id=$1 ORDER BY z.id`, [bew.id])).rows;
    const hist = (await cl.query('SELECT * FROM zahlung_ereignis WHERE bewegung_id=$1 ORDER BY id', [bew.id])).rows;
    const v = await verteilt(cl, bew.id);
    const vor = await vorschlag(cl, bew);
    return { bewegung: { ...bew, betrag_cent: Number(bew.betrag_cent), datum: tag(bew.datum), pruef_frist: tag(bew.pruef_frist) },
      verteilt: v, rest_zahlung: Number(bew.betrag_cent) - v, zuordnungen: zu, historie: hist, vorschlag: vor };
  });
}

// Экран сверки: свежесть, остаток, платежи на разбор, ожидания автосписания, ручные переводы.
async function liste() {
  return mit(async (cl) => {
    const h = heute();
    const frisch = await bankFrisch();
    const saldo = await bankSaldo(cl);
    const brows = (await cl.query(
      "SELECT * FROM bank_bewegung WHERE status IN ('nicht_zugeordnet','teilweise','ueberzahlt','rueckbuchung_pruefen') AND NOT storniert ORDER BY (pruef_frist IS NULL), datum DESC")).rows;
    const zahlungen = [];
    for (const b of brows) {
      const v = await verteilt(cl, b.id);
      const zu = (await cl.query('SELECT z.*, bl.lieferant, bl.rechnung_nr FROM zahlung_zuordnung z LEFT JOIN beleg bl ON bl.id=z.beleg_id WHERE z.bewegung_id=$1 AND NOT z.storniert ORDER BY z.id', [b.id])).rows
        .map(z => ({ id: z.id, beleg_id: z.beleg_id, lieferant: z.lieferant, rechnung_nr: z.rechnung_nr, betrag_cent: Number(z.betrag_cent), skonto_cent: Number(z.skonto_cent) }));
      const vor = await vorschlag(cl, b);
      let differenz = null;
      if (b.art === 'lastschrift') { const stark = vor.filter(x => x.staerke === 'stark'); if (stark.length === 1 && stark[0].rest_cent !== Number(b.betrag_cent)) differenz = { erwartet_cent: stark[0].rest_cent, tatsaechlich_cent: Number(b.betrag_cent), diff_cent: Number(b.betrag_cent) - stark[0].rest_cent, erklaerungen: ['несколько счетов', 'кредит-нота', 'комиссия'] }; }
      zahlungen.push({ id: b.id, datum: tag(b.datum), gegenpartei: b.gegenpartei, verwendungszweck: b.verwendungszweck,
        betrag_cent: Number(b.betrag_cent), waehrung: b.waehrung, art: b.art, status: b.status, iban: b.iban,
        verteilt: v, rest_zahlung: Number(b.betrag_cent) - v, ueberzahlung_entscheidung: b.ueberzahlung_entscheidung,
        pruef_frist: tag(b.pruef_frist), ueberfaellig: !!(b.pruef_frist && tag(b.pruef_frist) < h),
        zuordnungen: zu, vorschlag: vor, differenz });
    }
    // ожидания автосписания (в прогноз движения денег; из ручных переводов исключены)
    const autoRows = (await cl.query("SELECT id, lieferant, rechnung_nr, betrag_cent, auto_faellig FROM beleg WHERE autolastschrift AND NOT bezahlt ORDER BY auto_faellig NULLS LAST")).rows;
    const erwartet_auto = [];
    for (const b of autoRows) { const st = await belegStand(cl, b.id); if (st && st.rest > 0) erwartet_auto.push({ beleg_id: b.id, lieferant: b.lieferant, rechnung_nr: b.rechnung_nr, rest_cent: st.rest, auto_faellig: tag(b.auto_faellig), ueberfaellig: !!(b.auto_faellig && tag(b.auto_faellig) < h) }); }
    // ручные переводы: открытые счета без автосписания
    const manRows = (await cl.query("SELECT id, lieferant, rechnung_nr, betrag_cent, faellig FROM beleg WHERE coalesce(autolastschrift,false)=false AND NOT coalesce(bezahlt,false) AND betrag_cent IS NOT NULL AND status NOT IN ('moeglicher_dubup','kopie','dubup') ORDER BY faellig NULLS LAST")).rows;
    const manuell = [];
    for (const b of manRows) { const st = await belegStand(cl, b.id); if (st && st.rest > 0) manuell.push({ beleg_id: b.id, lieferant: b.lieferant, rechnung_nr: b.rechnung_nr, rest_cent: st.rest, faellig: tag(b.faellig), status: st.status }); }
    const auto_summe = erwartet_auto.reduce((s, x) => s + x.rest_cent, 0);
    return { stand: h, frisch, saldo_cent: saldo, zahlungen, erwartet_auto, manuell,
      prognose: { erwartet_autolastschrift_cent: auto_summe, hinweis: frisch.vorlaeufig ? 'банковские данные предварительны (устарели) — прогноз ориентировочный' : null } };
  });
}

module.exports = { zahlungImport, vorschlag, zuordnen, zuordnungStorno, ueberzahlung,
  rueckbuchung, rueckbuchungBestaetigen, autoSetzen, autoPruefung, differenzErklaeren, skontoAbschluss,
  bankSaldo, eins, liste, belegStand };
