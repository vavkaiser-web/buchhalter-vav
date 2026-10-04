/* ----------------------------------------------------------------
   Контроль полноты документов.

   По банковской операции без подтверждающего документа ищем кандидатов в
   ПОДКЛЮЧЁННЫХ источниках, показываем проверенные источники и границы поиска.
   Честно: в пилоте реально подключён только источник «Собранные документы»
   (таблица beleg). Почта и папки объявлены, но НЕ подключены — поиск по ним
   не изображаем, помечаем «Поиск не завершён» с источником и причиной.

   Не дублируем задачи: причину «Нет подтверждающего документа» добавляем к
   существующей задаче по нераспределённому платежу (её срок и уведомления).
   Совпадение одной суммы — не основание. Получение файла не закрывает задачу.
   Нечитаемые реквизиты не угадываем. Реальные письма не отправляем.
   ---------------------------------------------------------------- */
'use strict';
const razn = require('./razn.js');
const aufgaben = require('./aufgaben.js');
let audit = null; try { audit = require('./audit.js'); } catch (e) {}

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) { const cl = pg(); try { await cl.connect(); return await fn(cl); } finally { try { await cl.end(); } catch (e) {} } }
function tag(d) { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const z = new Date(d); return new Date(z.getTime() - z.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function task(b) { try { return aufgaben.systemAufgabe(b); } catch (e) { return null; } }
async function jlog(e) { if (audit) { try { await audit.schreiben(e); } catch (x) {} } }

/* Поиск по собранным документам (реально подключённый источник). */
async function sammlungSuche(cl, bew) {
  const zweck = String(bew.verwendungszweck || '').toLowerCase();
  const rows = (await cl.query(
    "SELECT id, lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, datei_name FROM beleg WHERE status<>'storniert'")).rows;
  const out = [];
  for (const r of rows) {
    const treffer = [], abweichung = []; let staerke = null;
    const nrMatch = r.rechnung_nr && zweck.includes(String(r.rechnung_nr).toLowerCase());
    const lkMatch = r.lieferant_key && bew.gegenpartei_key && r.lieferant_key === bew.gegenpartei_key;
    const betrMatch = r.betrag_cent != null && Number(r.betrag_cent) === Number(bew.betrag_cent);
    if (nrMatch) { treffer.push('номер счёта в назначении'); staerke = 'stark'; }
    if (lkMatch) treffer.push('тот же контрагент'); else if (r.lieferant) abweichung.push('контрагент: ' + r.lieferant + ' ≠ ' + (bew.gegenpartei || '?'));
    if (betrMatch) treffer.push('сумма совпадает'); else if (r.betrag_cent != null) abweichung.push('сумма ' + (Number(r.betrag_cent) / 100).toFixed(2) + ' ≠ ' + (Number(bew.betrag_cent) / 100).toFixed(2));
    if (!staerke) { if (lkMatch && betrMatch) staerke = 'mittel'; else if (betrMatch && !lkMatch) staerke = 'schwach'; else if (lkMatch) staerke = 'schwach'; }
    if (!treffer.length) continue;
    if (staerke === 'schwach' && betrMatch && !lkMatch && !nrMatch) treffer.push('только сумма — недостаточно для связи');
    out.push({ beleg_id: r.id, lieferant: r.lieferant, rechnung_nr: r.rechnung_nr, betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, datum: tag(r.datum), datei_name: r.datei_name, treffer, abweichung, staerke });
  }
  out.sort((a, b) => ({ stark: 0, mittel: 1, schwach: 2 }[a.staerke] - { stark: 0, mittel: 1, schwach: 2 }[b.staerke]));
  return out;
}

/* Реестр источников. verbunden=true только у реально подключённых. Для тестов — setQuellen. */
let QUELLEN = [
  { key: 'sammlung', titel: 'Собранные документы (Бухгалтер)', verbunden: true, suche: sammlungSuche },
  { key: 'mail', titel: 'Почта (MailOps/Gmail)', verbunden: false, grund: 'в пилоте поиск по почте не подключён' },
  { key: 'drive', titel: 'Папки (Google Drive)', verbunden: false, grund: 'в пилоте поиск по папкам не подключён' },
];
function setQuellen(q) { QUELLEN = q; }
function quellenStatus() { return QUELLEN.map(q => ({ key: q.key, titel: q.titel, verbunden: !!q.verbunden, grund: q.grund || null })); }

async function suche(cl, bew) {
  const kandidaten = [], quellen = [], grenzen = []; let abgeschlossen = true;
  for (const q of QUELLEN) {
    if (q.verbunden && typeof q.suche === 'function') {
      const found = await q.suche(cl, bew);
      quellen.push({ key: q.key, titel: q.titel, verbunden: true, status: 'geprueft', anzahl: found.length });
      for (const f of found) kandidaten.push({ ...f, quelle: q.key });
    } else {
      quellen.push({ key: q.key, titel: q.titel, verbunden: false, status: 'nicht_verbunden', grund: q.grund || 'источник не подключён' });
      grenzen.push({ key: q.key, titel: q.titel, grund: q.grund || 'источник не подключён' });
      abgeschlossen = false;
    }
  }
  const ergebnis = kandidaten.length > 1 ? 'mehrere' : (kandidaten.length === 1 ? 'gefunden' : (abgeschlossen ? 'nicht_gefunden' : 'nicht_abgeschlossen'));
  return { ergebnis, kandidaten, quellen, grenzen, abgeschlossen };
}

function entwurfAnfrage(bew) {
  return ['Запрос подтверждающего документа (черновик — не отправлено автоматически):',
    'Операция: ' + tag(bew.datum) + ', сумма ' + (Number(bew.betrag_cent) / 100).toFixed(2) + ' ' + (bew.waehrung || 'EUR'),
    'Контрагент: ' + (bew.gegenpartei || '—'),
    'Назначение: ' + (bew.verwendungszweck || '—'),
    'Просьба прислать счёт/квитанцию по этой операции. Передать через ответственного за покупку или контрагента.'].join('\n');
}

module.exports = {};

const GRUND = {
  nicht_gefunden: 'Нет подтверждающего документа: не найден в проверенных источниках',
  nicht_abgeschlossen: 'Нет подтверждающего документа: поиск не завершён',
};

// Проверка наличия подтверждающего документа по операции.
async function dokPruefung(d, user) {
  return mit(async (cl) => {
    const bew = (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1', [Number(d.bewegung_id)])).rows[0];
    if (!bew) throw new Error('операция не найдена');
    const von = (user && user.login) || 'system';
    if ((await cl.query('SELECT 1 FROM dok_verknuepfung WHERE bewegung_id=$1 LIMIT 1', [bew.id])).rows[0])
      return { ok: true, schon_verknuepft: true };
    const res = await suche(cl, bew);
    const log = await cl.query('INSERT INTO dok_suche (bewegung_id, ergebnis, quellen, grenzen, kandidaten, von) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [bew.id, res.ergebnis, JSON.stringify(res.quellen), JSON.stringify(res.grenzen), JSON.stringify(res.kandidaten), von]);
    let entwurf = null;
    if (res.ergebnis === 'nicht_gefunden' || res.ergebnis === 'nicht_abgeschlossen') {
      let grund = GRUND[res.ergebnis];
      if (res.ergebnis === 'nicht_abgeschlossen') grund += ' (' + res.grenzen.map(g => g.titel).join(', ') + ')';
      // не дублируем: причину добавляем к существующей задаче по нераспределённому платежу
      const schon = (await cl.query("SELECT 1 FROM zahlung_ereignis WHERE bewegung_id=$1 AND art='dok_fehlt' AND am > now()-interval '3 days' LIMIT 1", [bew.id])).rows[0];
      if (!schon) {
        const ex = (await cl.query("SELECT aufgabe_id FROM zahlung_ereignis WHERE bewegung_id=$1 AND aufgabe_id IS NOT NULL AND art IN ('nicht_zugeordnet','eingang_offen') ORDER BY id DESC LIMIT 1", [bew.id])).rows[0];
        let aid = ex && ex.aufgabe_id || null;
        if (aid) { try { aufgaben.notiz(aid, 'Причина: ' + grund, von); } catch (e) {} }   // тот же срок/уведомления
        else { const t = task({ titel: 'Нет подтверждающего документа', ziel_rolle: 'buchhaltung', art: 'dok_fehlt',
          text: 'Операция #' + bew.id + ' (' + (bew.gegenpartei || '') + ', ' + (Number(bew.betrag_cent) / 100).toFixed(2) + ' €): ' + grund + '. Черновик запроса готов; отправить через ответственного, письма автоматически не слать.',
          frist: tag(bew.pruef_frist) || undefined, bezug: 'bank:' + bew.id }); aid = t && t.id; }
        await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, aufgabe_id, von) VALUES ($1,'dok_fehlt',$2,$3,$4)", [bew.id, grund, aid, von]);
      }
      if (res.ergebnis === 'nicht_gefunden') entwurf = entwurfAnfrage(bew);
    }
    await jlog({ wer: von, rolle: user && user.rolle, art: 'dok_suche', ziel: 'bank:' + bew.id, neu: res.ergebnis });
    return { ok: true, suche_id: log.rows[0].id, ergebnis: res.ergebnis, quellen: res.quellen, grenzen: res.grenzen, kandidaten: res.kandidaten, entwurf };
  });
}

// Подтверждение связи операция↔документ бухгалтером. Задачу НЕ закрывает.
async function verknuepfen(d, user) {
  return mit(async (cl) => {
    const b = Number(d.bewegung_id), bl = Number(d.beleg_id);
    if (!b || !bl) throw new Error('нужны операция и документ');
    if (!(await cl.query('SELECT 1 FROM bank_bewegung WHERE id=$1', [b])).rows[0]) throw new Error('операция не найдена');
    if (!(await cl.query('SELECT 1 FROM beleg WHERE id=$1', [bl])).rows[0]) throw new Error('документ не найден');
    if ((await cl.query('SELECT 1 FROM dok_verknuepfung WHERE bewegung_id=$1 AND beleg_id=$2', [b, bl])).rows[0]) return { ok: true, wiederholt: true };
    await cl.query('INSERT INTO dok_verknuepfung (bewegung_id, beleg_id, grund, von) VALUES ($1,$2,$3,$4)', [b, bl, String(d.grund || '').slice(0, 300), (user && user.login) || 'system']);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, beleg_id, art, text, von) VALUES ($1,$2,'dok_verknuepft',$3,$4)", [b, bl, 'документ связан с операцией', (user && user.login) || 'system']);
    return { ok: true, hinweis: 'получение файла не закрывает задачу — проверьте содержание и полноту, затем подтвердите завершение' };
  });
}

// 7) поздний документ: связать с операцией и открытой задачей, без повторного расхода/задачи.
async function spaeterDokument(d, user) {
  return mit(async (cl) => {
    const b = Number(d.bewegung_id), bl = Number(d.beleg_id);
    if (!b || !bl) throw new Error('нужны операция и документ');
    if ((await cl.query('SELECT 1 FROM dok_verknuepfung WHERE bewegung_id=$1 AND beleg_id=$2', [b, bl])).rows[0]) return { ok: true, wiederholt: true, hinweis: 'уже связан — повтор не создаём' };
    await cl.query('INSERT INTO dok_verknuepfung (bewegung_id, beleg_id, grund, von) VALUES ($1,$2,$3,$4)', [b, bl, 'документ поступил позже', (user && user.login) || 'system']);
    const ex = (await cl.query("SELECT aufgabe_id FROM zahlung_ereignis WHERE bewegung_id=$1 AND aufgabe_id IS NOT NULL ORDER BY id DESC LIMIT 1", [b])).rows[0];
    if (ex && ex.aufgabe_id) { try { aufgaben.notiz(ex.aufgabe_id, 'Документ поступил позже — на проверке (повтор не создаём).', (user && user.login) || 'system'); } catch (e) {} }
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, beleg_id, art, text, aufgabe_id, von) VALUES ($1,$2,'dok_nachgereicht',$3,$4,$5)", [b, bl, 'документ поступил позже, связан с операцией', ex && ex.aufgabe_id || null, (user && user.login) || 'system']);
    return { ok: true, hinweis: 'связан с операцией и задачей; повторный расход/задача не создаются; завершение — после проверки' };
  });
}

// 5,6) неполнота/нечитаемость. Пропуски: предположение (vermutet) vs достоверно (bestaetigt). Не угадываем.
async function mangelErfassen(d, user) {
  return mit(async (cl) => {
    const bl = Number(d.beleg_id); if (!bl) throw new Error('нет документа');
    if (!(await cl.query('SELECT 1 FROM beleg WHERE id=$1', [bl])).rows[0]) throw new Error('документ не найден');
    const art = ['seite_fehlt', 'anhang_fehlt', 'unleserlich', 'feld_zweifel'].includes(d.art) ? d.art : 'seite_fehlt';
    const sicherheit = d.sicherheit === 'vermutet' ? 'vermutet' : 'bestaetigt';
    const r = await cl.query('INSERT INTO dok_mangel (beleg_id, art, feld, sicherheit, beschreibung, von) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [bl, art, d.feld ? String(d.feld).slice(0, 60) : null, sicherheit, String(d.beschreibung || '').slice(0, 300), (user && user.login) || 'system']);
    await cl.query("UPDATE beleg SET dok_status='unvollstaendig' WHERE id=$1", [bl]);
    const hinweis = (art === 'unleserlich' || art === 'feld_zweifel')
      ? 'запрошена лучшая копия; неразборчивые суммы/номера/реквизиты не угадываем и подтверждёнными не считаем'
      : 'комплект неполный — создан пункт на получение недостающего; документ не считается полностью проверенным';
    return { ok: true, id: r.rows[0].id, hinweis };
  });
}
async function mangelErledigt(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id); const m = (await cl.query('SELECT * FROM dok_mangel WHERE id=$1', [id])).rows[0];
    if (!m) throw new Error('запись не найдена');
    await cl.query("UPDATE dok_mangel SET status='erledigt', erledigt_von=$2 WHERE id=$1", [id, (user && user.login) || 'system']);
    const offen = Number((await cl.query("SELECT count(*) c FROM dok_mangel WHERE beleg_id=$1 AND status='offen'", [m.beleg_id])).rows[0].c);
    if (offen === 0) await cl.query("UPDATE beleg SET dok_status='offen' WHERE id=$1 AND dok_status='unvollstaendig'", [m.beleg_id]);
    return { ok: true, offen_verbleibend: offen };
  });
}

// 8) завершение проверки бухгалтером: содержание и полнота проверены. Требует отсутствия открытых пропусков.
async function abschluss(d, user) {
  return mit(async (cl) => {
    const bl = Number(d.beleg_id); if (!bl) throw new Error('нет документа');
    const offen = Number((await cl.query("SELECT count(*) c FROM dok_mangel WHERE beleg_id=$1 AND status='offen'", [bl])).rows[0].c);
    if (offen > 0) throw new Error('есть открытые пропуски/нечитаемость — сначала закрыть их');
    await cl.query("UPDATE beleg SET dok_status='geprueft', dok_geprueft_von=$2, dok_geprueft_am=now() WHERE id=$1", [bl, (user && user.login) || 'system']);
    return { ok: true, status: 'geprueft' };
  });
}

async function liste() {
  return mit(async (cl) => {
    const quellen = quellenStatus();
    // операции без подтверждающего документа (с уже выполненным поиском или нераспределённые)
    const brows = (await cl.query(
      `SELECT * FROM bank_bewegung b WHERE NOT storniert
         AND NOT EXISTS (SELECT 1 FROM dok_verknuepfung v WHERE v.bewegung_id=b.id)
         AND (b.status IN ('nicht_zugeordnet','teilweise') OR EXISTS (SELECT 1 FROM dok_suche s WHERE s.bewegung_id=b.id))
       ORDER BY b.datum DESC`)).rows;
    const ohne_dokument = [];
    for (const b of brows) {
      const su = (await cl.query('SELECT ergebnis, quellen, grenzen, kandidaten, am FROM dok_suche WHERE bewegung_id=$1 ORDER BY id DESC LIMIT 1', [b.id])).rows[0];
      ohne_dokument.push({ id: b.id, richtung: b.richtung, datum: tag(b.datum), gegenpartei: b.gegenpartei, verwendungszweck: b.verwendungszweck,
        betrag_cent: Number(b.betrag_cent), status: b.status,
        suche: su ? { ergebnis: su.ergebnis, quellen: su.quellen, grenzen: su.grenzen, kandidaten: su.kandidaten, am: su.am } : null });
    }
    const mrows = (await cl.query("SELECT id, lieferant, rechnung_nr, dok_status FROM beleg WHERE dok_status='unvollstaendig' ORDER BY id DESC")).rows;
    const unvollstaendig = [];
    for (const m of mrows) {
      const maengel = (await cl.query("SELECT id, art, feld, sicherheit, beschreibung, status FROM dok_mangel WHERE beleg_id=$1 AND status='offen' ORDER BY id", [m.id])).rows;
      unvollstaendig.push({ beleg_id: m.id, lieferant: m.lieferant, rechnung_nr: m.rechnung_nr, maengel });
    }
    return { quellen, ohne_dokument, unvollstaendig };
  });
}

async function eins(id) {
  return mit(async (cl) => {
    const b = (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1', [Number(id)])).rows[0]; if (!b) throw new Error('операция не найдена');
    const suchen = (await cl.query('SELECT * FROM dok_suche WHERE bewegung_id=$1 ORDER BY id DESC', [b.id])).rows;
    const verkn = (await cl.query('SELECT v.*, bl.lieferant, bl.rechnung_nr, bl.dok_status FROM dok_verknuepfung v LEFT JOIN beleg bl ON bl.id=v.beleg_id WHERE v.bewegung_id=$1 ORDER BY v.id', [b.id])).rows;
    return { bewegung: { ...b, betrag_cent: Number(b.betrag_cent), datum: tag(b.datum) }, suchen, verknuepfungen: verkn, entwurf: entwurfAnfrage(b) };
  });
}

module.exports = { suche, dokPruefung, verknuepfen, spaeterDokument, mangelErfassen, mangelErledigt, abschluss,
  liste, eins, quellenStatus, setQuellen, entwurfAnfrage, sammlungSuche };
