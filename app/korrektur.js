/* ---------------------------------------------------------------
   Дополнение №5 Ф2 — запрос на исправление.
   Обычный сотрудник НЕ меняет проверенные данные напрямую: он
   создаёт запрос (что, почему, старое→новое), а подтверждает и
   применяет ответственный бухгалтер (Наталья) или владелец.
   Оригинал документа не перезаписываем — храним исходное и новое
   значение отдельно, с полной историей.
   Применение к уже проверенному месяцу помечает его как требующий
   повторной проверки (связь с Ф3).
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}
const monat = require('./monat.js');
const steuerberater = require('./steuerberater.js');
const benachrichtigung = require('./benachrichtigung.js');

// собрать «изменения показателей» из тела запроса: {melde:{art,alt,neu}} или {aenderungen:[…]}
function meldeAenderungen(body) {
  if (Array.isArray(body.aenderungen)) return body.aenderungen;
  if (body.melde && body.melde.art) return [body.melde];
  return [];
}

const ARTEN = {
  datenkorrektur: 'Правка извлечённых данных',
  zuordnung:      'Замена привязки',
  korrekturbeleg: 'Новый корректирующий документ',
};
const STATUS_T = {
  offen: 'Ждёт подтверждения', bestaetigt: 'Подтверждён Натальей',
  zurueck: 'Возвращён', angewandt: 'Применён',
};

// Подтверждать/применять/возвращать может только ответственный бухгалтер или владелец.
function darfPruefen(u) { return monat.istVerantwortlich(u); }

function ausgabe(r) {
  return {
    id: r.id, art: r.art, art_text: ARTEN[r.art] || r.art,
    firma: r.firma || null, jahr: r.jahr || null, monat: r.monat || null,
    objekt_nr: r.objekt_nr || null, bezug: r.bezug, grund: r.grund, basis: r.basis || '',
    alt_wert: r.alt_wert || '', neu_wert: r.neu_wert || '', belege: r.belege || '',
    autor: r.autor, status: r.status, status_text: STATUS_T[r.status] || r.status,
    bestaetigt_von: r.bestaetigt_von || null, bestaetigt_am: r.bestaetigt_am || null,
    angewandt_von: r.angewandt_von || null, angewandt_am: r.angewandt_am || null,
    auswirkung: r.auswirkung || '', notiz: r.notiz || '', angelegt: r.angelegt,
    steuerberater_pflicht: r.steuerberater_pflicht === true,
    betroffen: r.betroffen || null, betroffen_text: steuerberater.BETROFFEN_T[r.betroffen] || null,
  };
}

async function liste(filter) {
  filter = filter || {};
  return mit(async cl => {
    const w = [], a = [];
    if (filter.status) { a.push(filter.status); w.push('status=$' + a.length); }
    if (filter.firma) { a.push(filter.firma); w.push('firma=$' + a.length); }
    if (filter.jahr) { a.push(Number(filter.jahr)); w.push('jahr=$' + a.length); }
    if (filter.monat) { a.push(Number(filter.monat)); w.push('monat=$' + a.length); }
    if (filter.objekt_nr) { a.push(filter.objekt_nr); w.push('objekt_nr=$' + a.length); }
    const sql = 'SELECT * FROM korrektur_antrag' + (w.length ? ' WHERE ' + w.join(' AND ') : '')
      + ' ORDER BY (status=$' + (a.length + 1) + ') DESC, angelegt DESC LIMIT 300';
    a.push('offen');
    const rows = (await cl.query(sql, a)).rows;
    return rows.map(ausgabe);
  });
}

async function eins(id) {
  const r = await mit(async cl => {
    const row = (await cl.query('SELECT * FROM korrektur_antrag WHERE id=$1', [Number(id)])).rows[0];
    if (!row) throw new Error('нет такого запроса');
    const log = (await cl.query('SELECT ereignis,von,nach,autor,notiz,wann FROM korrektur_log WHERE antrag_id=$1 ORDER BY wann', [row.id])).rows;
    return { ...ausgabe(row), verlauf: log };
  });
  // Ф4: согласования со Steuerberater по этому исправлению
  try { r.steuerberater_bestaetigungen = await steuerberater.bestaetigungListe(id); }
  catch (e) { r.steuerberater_bestaetigungen = []; }
  return r;
}

// Ф4: пометить исправление как затрагивающее Steuerberater (поданная отчётность /
// закрытый период / годовое закрытие). Только ответственный/владелец.
async function steuerberaterPflicht(body, user) {
  if (!darfPruefen(user)) throw new Error('только ответственный бухгалтер или владелец');
  const pflicht = body.pflicht !== false;
  const betroffen = body.betroffen ? String(body.betroffen) : null;
  if (pflicht && betroffen && !steuerberater.BETROFFEN_T[betroffen]) throw new Error('неизвестно, что затронуто');
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM korrektur_antrag WHERE id=$1', [Number(body.id)])).rows[0];
    if (!r) throw new Error('нет такого запроса');
    const upd = (await cl.query(
      'UPDATE korrektur_antrag SET steuerberater_pflicht=$2, betroffen=$3 WHERE id=$1 RETURNING *',
      [r.id, pflicht, pflicht ? betroffen : null])).rows[0];
    await cl.query('INSERT INTO korrektur_log (antrag_id,ereignis,autor,notiz) VALUES ($1,$2,$3,$4)',
      [r.id, pflicht ? 'steuerberater_pflicht' : 'steuerberater_frei', user.login,
       pflicht ? (steuerberater.BETROFFEN_T[betroffen] || '') : '']);
    return ausgabe(upd);
  });
}

// Создать запрос — доступно любому вошедшему (сотрудник тоже).
async function anlegen(body, user) {
  const art = String(body.art || 'datenkorrektur');
  if (!ARTEN[art]) throw new Error('неизвестный вид исправления');
  const bezug = String(body.bezug || '').trim();
  const grund = String(body.grund || '').trim();
  if (!bezug) throw new Error('укажите, что исправляем');
  if (!grund) throw new Error('укажите причину');
  let firma = null;
  if (body.firma) firma = monat.FIRMEN[body.firma] ? body.firma : (() => { throw new Error('неизвестная фирма'); })();
  const jahr = body.jahr ? Number(body.jahr) : null;
  const mon = body.monat ? Number(body.monat) : null;
  if (mon != null && (mon < 1 || mon > 12)) throw new Error('месяц 1..12');
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO korrektur_antrag (art,firma,jahr,monat,objekt_nr,bezug,grund,basis,alt_wert,neu_wert,belege,autor,notiz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [art, firma, jahr, mon, body.objekt_nr || null, bezug, grund,
       String(body.basis || '').slice(0, 800) || null, String(body.alt_wert || '').slice(0, 2000) || null,
       String(body.neu_wert || '').slice(0, 2000) || null, String(body.belege || '').slice(0, 800) || null,
       user.login, String(body.notiz || '').slice(0, 800) || null])).rows[0];
    await cl.query('INSERT INTO korrektur_log (antrag_id,ereignis,nach,autor) VALUES ($1,$2,$3,$4)',
      [r.id, 'angelegt', 'offen', user.login]);
    return ausgabe(r);
  });
}

async function uebergang(id, user, ziel, erlaubt, extra) {
  if (!darfPruefen(user)) throw new Error('только ответственный бухгалтер или владелец');
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM korrektur_antrag WHERE id=$1', [Number(id)])).rows[0];
    if (!r) throw new Error('нет такого запроса');
    if (r.status === ziel) return { ok: true, unchanged: true, ...ausgabe(r) };  // идемпотентно
    if (!erlaubt.includes(r.status)) throw new Error('нельзя из состояния «' + (STATUS_T[r.status] || r.status) + '»');
    const upd = await extra(cl, r);
    await cl.query('INSERT INTO korrektur_log (antrag_id,ereignis,von,nach,autor,notiz) VALUES ($1,$2,$3,$4,$5,$6)',
      [r.id, ziel, r.status, ziel, user.login, String((upd && upd.notiz) || '').slice(0, 800)]);
    const neu = (await cl.query('SELECT * FROM korrektur_antrag WHERE id=$1', [r.id])).rows[0];
    return { ok: true, ...ausgabe(neu) };
  });
}

async function bestaetigen(body, user) {
  const res = await uebergang(body.id, user, 'bestaetigt', ['offen'], async (cl, r) => {
    await cl.query('UPDATE korrektur_antrag SET status=$2, bestaetigt_von=$3, bestaetigt_am=now(), notiz=COALESCE($4,notiz) WHERE id=$1',
      [r.id, 'bestaetigt', user.login, body.notiz ? String(body.notiz).slice(0, 800) : null]);
    return { notiz: body.notiz };
  });
  // Ф5: предварительное влияние запроса (ещё не применено) — отдельное сообщение
  if (res.ok && !res.unchanged) {
    const aenderungen = meldeAenderungen(body);
    if (aenderungen.length) {
      try {
        await benachrichtigung.anlegen({ ziel: 'gf', quelle: 'korrektur:' + res.id, vorlaeufig: true,
          firma: res.firma, jahr: res.jahr, monat: res.monat, objekt_nr: res.objekt_nr,
          aenderungen, grund: res.grund, wer_bestaetigt: res.bestaetigt_von, basis: 'предварительно, до применения' });
        res.benachrichtigung_vorlaeufig = true;
      } catch (e) { res.benachrichtigung_fehler = e.message; }
    }
  }
  return res;
}

async function zurueck(body, user) {
  return uebergang(body.id, user, 'zurueck', ['offen', 'bestaetigt'], async (cl, r) => {
    await cl.query('UPDATE korrektur_antrag SET status=$2, notiz=COALESCE($3,notiz) WHERE id=$1',
      [r.id, 'zurueck', body.notiz ? String(body.notiz).slice(0, 800) : null]);
    return { notiz: body.notiz };
  });
}

// Применение: только из «подтверждён». Записываем влияние на расчёты и,
// если затронут уже проверенный месяц, помечаем его на повторную проверку (Ф3).
async function anwenden(body, user) {
  if (!darfPruefen(user)) throw new Error('только ответственный бухгалтер или владелец');
  // Ф4: исправление, затрагивающее Steuerberater, без согласования не применяется.
  const cur = await mit(async cl => (await cl.query('SELECT steuerberater_pflicht,status FROM korrektur_antrag WHERE id=$1', [Number(body.id)])).rows[0]);
  if (!cur) throw new Error('нет такого запроса');
  if (cur.steuerberater_pflicht && cur.status === 'bestaetigt') {
    const ok = await steuerberater.hatBestaetigung(body.id);
    if (!ok) throw new Error('нужно согласование со Steuerberater (письменное или запись телефонного) перед применением');
  }
  const res = await uebergang(body.id, user, 'angewandt', ['bestaetigt'], async (cl, r) => {
    await cl.query('UPDATE korrektur_antrag SET status=$2, angewandt_von=$3, angewandt_am=now(), auswirkung=COALESCE($4,auswirkung) WHERE id=$1',
      [r.id, 'angewandt', user.login, body.auswirkung ? String(body.auswirkung).slice(0, 2000) : null]);
    return { notiz: body.auswirkung };
  });
  // связь с Ф3: если исправление затронуло период — на повторную проверку
  if (res.ok && !res.unchanged && res.firma && res.jahr && res.monat) {
    try {
      await monat.wiedervorlageSetzen({ firma: res.firma, jahr: res.jahr, monat: res.monat, an: true,
        notiz: 'исправление #' + res.id + ' применено' }, user);
      res.wiedervorlage_gesetzt = true;
    } catch (e) { res.wiedervorlage_fehler = e.message; }
  }
  // Ф5: уведомление владельцу об изменении показанных прибыли/налога/долга (одно сообщение)
  if (res.ok && !res.unchanged) {
    const aenderungen = meldeAenderungen(body);
    if (aenderungen.length) {
      try {
        let basis = '';
        const bb = await steuerberater.bestaetigungListe(res.id);
        if (bb.length) { const l = bb[bb.length - 1]; basis = l.art_text + (l.mit_wem ? ' · ' + l.mit_wem : '') + (l.dokument_ref ? ' · ' + l.dokument_ref : ''); }
        const bn = await benachrichtigung.anlegen({ ziel: 'gf', quelle: 'korrektur:' + res.id, vorlaeufig: false,
          firma: res.firma, jahr: res.jahr, monat: res.monat, objekt_nr: res.objekt_nr,
          aenderungen, grund: res.grund, wer_bestaetigt: res.bestaetigt_von, basis });
        res.benachrichtigung = bn.ok ? bn.id : null;
      } catch (e) { res.benachrichtigung_fehler = e.message; }
    }
  }
  return res;
}

module.exports = { ARTEN, STATUS_T, darfPruefen, liste, eins, anlegen, bestaetigen, zurueck, anwenden, steuerberaterPflicht };
