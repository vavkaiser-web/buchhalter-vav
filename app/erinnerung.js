/* ---------------------------------------------------------------
   Дополнение №6 Ф8 — напоминания о неотправленных чеках и эскалация.
   Напоминание в 18:00 Europe/Berlin (в т.ч. сб/вс, если сотрудник в этот
   день работал — при подтверждённых данных; отсутствие данных не считаем
   доказательством того, что не работал). Цепочка ТОЛЬКО для неотправленных
   документов: сотрудник → бухгалтер (2 раб. дня) → Олег (1 раб. день).
   Андрея в эту цепочку не включаем. Повторные напоминания не обнуляют срок.
   Внешние сообщения не отправляем — движок фиксирует, что и кому причитается;
   живой канал уведомлений сотруднику подключается отдельным шагом.
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}
const wt = require('./kasse/werktage.js');
const aufgaben = require('./aufgaben.js');

function jetztDate(j) { return j ? new Date(j) : (process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date()); }
function berlinStunde(d) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(d)); }

function ausgabe(r) {
  return {
    id: r.id, person: r.person, was: r.was, objekt_nr: r.objekt_nr || null,
    betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, seit: r.seit || null,
    erste_erinnerung: r.erste_erinnerung || null, stufe: r.stufe, erledigt: r.erledigt === true,
    erledigt_am: r.erledigt_am || null, angelegt: r.angelegt,
  };
}

async function pflichtAnlegen(body, user) {
  const person = String(body.person || '').trim().toLowerCase();
  const was = String(body.was || '').trim();
  if (!person) throw new Error('нужен сотрудник');
  if (!was) throw new Error('нужно описание обязанности');
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO beleg_pflicht (person,was,objekt_nr,betrag_cent,seit) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [person, was, body.objekt_nr || null, body.betrag_cent != null ? Math.round(Number(body.betrag_cent)) : null,
       body.seit || wt.berlinTag(jetztDate().getTime())])).rows[0];
    return ausgabe(r);
  });
}

async function pflichtListe(user, nurEigene) {
  return mit(async cl => {
    const rows = nurEigene
      ? (await cl.query('SELECT * FROM beleg_pflicht WHERE person=$1 ORDER BY erledigt, angelegt DESC', [user.login])).rows
      : (await cl.query('SELECT * FROM beleg_pflicht ORDER BY erledigt, angelegt DESC LIMIT 300')).rows;
    // приложить недавние напоминания/эскалации
    const out = [];
    for (const r of rows) {
      const log = (await cl.query('SELECT tag,stufe,ereignis,wann FROM erinnerung_log WHERE pflicht_id=$1 ORDER BY wann DESC LIMIT 20', [r.id])).rows;
      out.push({ ...ausgabe(r), verlauf: log });
    }
    return out;
  });
}

// Выполнено: сотрудник сдал чек. Останавливает напоминания, гасит устаревшие,
// но НЕ считает документ проверенным бухгалтерией (отправка ≠ проверка).
async function pflichtErledigt(body, user) {
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM beleg_pflicht WHERE id=$1', [Number(body.id)])).rows[0];
    if (!r) throw new Error('нет такой обязанности');
    if (r.erledigt) return { ok: true, unchanged: true, ...ausgabe(r) };
    const upd = (await cl.query('UPDATE beleg_pflicht SET erledigt=true, erledigt_am=now(), erledigt_quelle=$2 WHERE id=$1 RETURNING *',
      [r.id, body.quelle ? String(body.quelle).slice(0, 120) : null])).rows[0];
    await cl.query('INSERT INTO erinnerung_log (pflicht_id,tag,stufe,ereignis,notiz) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [r.id, wt.berlinTag(jetztDate().getTime()), 'erledigt', 'erledigt', 'обязанность выполнена — напоминания сняты']);
    // погасить устаревшие эскалации: пометкой в задачах (не считаем проверенным бухгалтерией)
    for (const aid of [r.eskal_aufgabe_buch, r.eskal_aufgabe_oleg]) {
      if (aid) aufgaben.notiz(aid, 'Чек сдан — напоминания по неотправке сняты. Бухгалтерская проверка — отдельно.', 'system');
    }
    return { ok: true, ...ausgabe(upd) };
  });
}

// Движок напоминаний/эскалации. jetzt — момент запуска (обычно 18:00 Europe/Berlin).
// gearbeitet — множество 'person|YYYY-MM-DD' подтверждённых рабочих дней (для выходных).
// force — игнорировать окно 18:00 (для тестов).
async function lauf(opts) {
  opts = opts || {};
  const jetzt = jetztDate(opts.jetzt);
  const tag = wt.berlinTag(jetzt.getTime());
  const stunde = berlinStunde(jetzt);
  const fenster = opts.force === true || stunde >= 18;    // 18:00 Europe/Berlin
  const werktag = wt.istWerktag(tag);
  const gearbeitet = new Set(opts.gearbeitet || []);
  const ergebnis = { tag, fenster, erinnert: [], eskaliert: [] };
  await mit(async cl => {
    const offen = (await cl.query('SELECT * FROM beleg_pflicht WHERE erledigt=false')).rows;
    for (const r of offen) {
      // 1) напоминание сотруднику в окне 18:00 (будни всегда; выходной — если работал)
      const darfHeute = werktag || gearbeitet.has(r.person + '|' + tag);
      let erste = r.erste_erinnerung ? wt.berlinTag(new Date(r.erste_erinnerung).getTime()) : null;
      if (fenster && darfHeute) {
        if (!erste) {
          await cl.query('UPDATE beleg_pflicht SET erste_erinnerung=$2 WHERE id=$1', [r.id, tag]);
          erste = tag;
        }
        const ins = await cl.query('INSERT INTO erinnerung_log (pflicht_id,tag,stufe,ereignis) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',
          [r.id, tag, 'mitarbeiter', 'erinnerung']);
        if (ins.rows.length) ergebnis.erinnert.push({ pflicht: r.id, person: r.person });
      }
      // 2) эскалация по рабочим дням от первого напоминания (не зависит от часа)
      if (erste) {
        const fBuch = wt.fristEnde(erste + 'T12:00:00Z', 2);   // +2 раб. дня → бухгалтер
        const fOleg = wt.fristEnde(fBuch + 'T12:00:00Z', 1);   // +1 раб. день → Олег
        let neueStufe = 'mitarbeiter';
        if (tag > fOleg) neueStufe = 'oleg';
        else if (tag > fBuch) neueStufe = 'buchhaltung';
        if (neueStufe !== r.stufe && (neueStufe === 'buchhaltung' || neueStufe === 'oleg')) {
          await cl.query('UPDATE beleg_pflicht SET stufe=$2 WHERE id=$1', [r.id, neueStufe]);
        }
        if (neueStufe === 'buchhaltung' && !r.eskal_aufgabe_buch) {
          const a = aufgaben.systemAufgabe({ titel: 'Неотправленный чек — эскалация бухгалтеру',
            text: r.person + ': ' + r.was + (r.objekt_nr ? ' (объект ' + r.objekt_nr + ')' : '') + '. Первое напоминание ' + erste + '.',
            art: 'beleg_eskalation', bezug: 'pflicht:' + r.id, ziel_rolle: 'buchhaltung' });
          await cl.query('UPDATE beleg_pflicht SET eskal_aufgabe_buch=$2 WHERE id=$1', [r.id, a.id]);
          await cl.query('INSERT INTO erinnerung_log (pflicht_id,tag,stufe,ereignis) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [r.id, tag, 'buchhaltung', 'eskalation']);
          ergebnis.eskaliert.push({ pflicht: r.id, stufe: 'buchhaltung' });
        }
        if (neueStufe === 'oleg' && !r.eskal_aufgabe_oleg) {
          const a = aufgaben.systemAufgabe({ titel: 'Неотправленный чек — эскалация Олегу',
            text: r.person + ': ' + r.was + (r.objekt_nr ? ' (объект ' + r.objekt_nr + ')' : '') + '. Первое напоминание ' + erste + '.',
            art: 'beleg_eskalation', bezug: 'pflicht:' + r.id, ziel_person: 'oleg', ziel_rolle: 'disponent' });
          await cl.query('UPDATE beleg_pflicht SET eskal_aufgabe_oleg=$2 WHERE id=$1', [r.id, a.id]);
          await cl.query('INSERT INTO erinnerung_log (pflicht_id,tag,stufe,ereignis) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [r.id, tag, 'oleg', 'eskalation']);
          ergebnis.eskaliert.push({ pflicht: r.id, stufe: 'oleg' });
        }
      }
    }
  });
  return ergebnis;
}

module.exports = { pflichtAnlegen, pflichtListe, pflichtErledigt, lauf, mit };
