/* ---------------------------------------------------------------
   Дополнение №5 — работа со Steuerberater.
   Ф4: подтверждения согласования исправлений, затрагивающих поданную
   отчётность / закрытый период / годовое закрытие.
   ВАЖНО: письменное подтверждение и запись телефонного согласования —
   РАЗНЫЕ вещи, никогда не смешиваем. Телефонная запись — внутренняя,
   не подписанный документ.
   Внешние системы автоматически не меняем.
   (Ф6 — комплекты, Ф7 — вопросы: добавляются ниже отдельными разделами.)
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}

const ART_T = { schriftlich: 'Письменное подтверждение', telefonisch: 'Запись телефонного согласования' };
const BETROFFEN_T = {
  eingereichte_erklaerung: 'Поданная отчётность',
  geschlossener_zeitraum:  'Закрытый период',
  jahresabschluss:         'Годовое закрытие',
};

function bAusgabe(r) {
  return {
    id: r.id, korrektur_id: r.korrektur_id || null,
    art: r.art, art_text: ART_T[r.art] || r.art,
    datum: r.datum || null, dokument_ref: r.dokument_ref || '',
    mit_wem: r.mit_wem || '', besprochen: r.besprochen || '', vereinbart: r.vereinbart || '',
    betraege_perioden: r.betraege_perioden || '', weiter: r.weiter || '',
    auswirkung: r.auswirkung || '', autor: r.autor, angelegt: r.angelegt,
  };
}

// Добавить подтверждение согласования. Только ответственный/владелец (проверяется в сервере).
async function bestaetigungAnlegen(body) {
  const art = String(body.art || '').trim();
  if (!ART_T[art]) throw new Error('вид: schriftlich или telefonisch');
  if (art === 'schriftlich' && !String(body.dokument_ref || '').trim())
    throw new Error('для письменного нужна ссылка на письмо/документ Steuerberater');
  if (art === 'telefonisch') {
    if (!String(body.mit_wem || '').trim()) throw new Error('для телефонного укажите, с кем согласовано');
    if (!String(body.vereinbart || '').trim()) throw new Error('для телефонного укажите согласованные изменения');
  }
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO steuerberater_bestaetigung
        (korrektur_id,art,datum,dokument_ref,mit_wem,besprochen,vereinbart,betraege_perioden,weiter,auswirkung,autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [body.korrektur_id ? Number(body.korrektur_id) : null, art, body.datum || null,
       String(body.dokument_ref || '').slice(0, 800) || null, String(body.mit_wem || '').slice(0, 300) || null,
       String(body.besprochen || '').slice(0, 1000) || null, String(body.vereinbart || '').slice(0, 1500) || null,
       String(body.betraege_perioden || '').slice(0, 1000) || null, String(body.weiter || '').slice(0, 800) || null,
       String(body.auswirkung || '').slice(0, 1500) || null, body.autor])).rows[0];
    return bAusgabe(r);
  });
}

async function bestaetigungListe(korrektur_id) {
  return mit(async cl => {
    const r = (await cl.query(
      'SELECT * FROM steuerberater_bestaetigung WHERE korrektur_id=$1 ORDER BY angelegt', [Number(korrektur_id)])).rows;
    return r.map(bAusgabe);
  });
}

// Есть ли хотя бы одно согласование по исправлению.
async function hatBestaetigung(korrektur_id) {
  return mit(async cl => {
    const r = (await cl.query('SELECT count(*)::int c FROM steuerberater_bestaetigung WHERE korrektur_id=$1', [Number(korrektur_id)])).rows[0];
    return r.c > 0;
  });
}

/* ===== Ф6 — комплекты для Steuerberater ===== */
const monat = require('./monat.js');
const PAKET_STATUS_T = { vorbereitet: 'Подготовлен', uebergeben: 'Передан' };
const UEB_ART_T = { erstuebergabe: 'Первичная передача', ergaenzung: 'Дополнение', erneut: 'Повторная передача копии' };

function paketAusgabe(r) {
  return {
    id: r.id, firma: r.firma, firma_name: (monat.FIRMEN[r.firma] || r.firma),
    jahr: r.jahr, monat: r.monat || null, nummer: r.nummer || null, version: r.version,
    status: r.status, status_text: PAKET_STATUS_T[r.status] || r.status,
    vollstaendig: r.vollstaendig === true,
    vorbereitet_von: r.vorbereitet_von || null, vorbereitet_am: r.vorbereitet_am || null,
    geprueft_von: r.geprueft_von || null, geprueft_am: r.geprueft_am || null,
    kommentar: r.kommentar || '', angelegt: r.angelegt,
  };
}

async function paketAnlegen(body, user) {
  const firma = monat.FIRMEN[body.firma] ? body.firma : (() => { throw new Error('неизвестная фирма'); })();
  const jahr = Number(body.jahr); if (!jahr) throw new Error('нужен год');
  const mon = body.monat ? Number(body.monat) : null;
  if (mon != null && (mon < 1 || mon > 12)) throw new Error('месяц 1..12');
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO steuerberater_paket (firma,jahr,monat,nummer,kommentar,vorbereitet_von)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [firma, jahr, mon, String(body.nummer || '').slice(0, 100) || null,
       String(body.kommentar || '').slice(0, 1000) || null, user.login])).rows[0];
    return paketAusgabe(r);
  });
}

async function paketListe(filter) {
  filter = filter || {};
  return mit(async cl => {
    const w = [], a = [];
    if (filter.firma) { a.push(filter.firma); w.push('firma=$' + a.length); }
    if (filter.jahr) { a.push(Number(filter.jahr)); w.push('jahr=$' + a.length); }
    if (filter.status) { a.push(filter.status); w.push('status=$' + a.length); }
    const rows = (await cl.query('SELECT * FROM steuerberater_paket'
      + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY jahr DESC, monat DESC NULLS LAST, id DESC LIMIT 200', a)).rows;
    // подсчёт позиций/недостающих
    const out = [];
    for (const r of rows) {
      const c = (await cl.query("SELECT count(*)::int g, count(*) FILTER (WHERE status='fehlt')::int f FROM steuerberater_paket_position WHERE paket_id=$1", [r.id])).rows[0];
      const u = (await cl.query('SELECT count(*)::int c FROM steuerberater_uebergabe WHERE paket_id=$1', [r.id])).rows[0];
      out.push({ ...paketAusgabe(r), positionen: c.g, fehlt: c.f, uebergaben: u.c });
    }
    return out;
  });
}

async function paketEins(id) {
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM steuerberater_paket WHERE id=$1', [Number(id)])).rows[0];
    if (!r) throw new Error('нет такого комплекта');
    const pos = (await cl.query('SELECT id,bezeichnung,beleg_ref,xml_ref,status,notiz FROM steuerberater_paket_position WHERE paket_id=$1 ORDER BY id', [r.id])).rows;
    const ueb = (await cl.query('SELECT id,art,datum,an,umfang,kommentar,autor,angelegt FROM steuerberater_uebergabe WHERE paket_id=$1 ORDER BY angelegt', [r.id])).rows
      .map(x => ({ ...x, art_text: UEB_ART_T[x.art] || x.art }));
    return { ...paketAusgabe(r), positionen: pos, fehlt: pos.filter(x => x.status === 'fehlt').length, uebergaben: ueb };
  });
}

async function positionAdd(body) {
  const bez = String(body.bezeichnung || '').trim();
  if (!bez) throw new Error('нужна позиция');
  const status = body.status === 'fehlt' ? 'fehlt' : 'bereit';
  return mit(async cl => {
    const p = (await cl.query('SELECT id FROM steuerberater_paket WHERE id=$1', [Number(body.paket_id)])).rows[0];
    if (!p) throw new Error('нет такого комплекта');
    const r = (await cl.query(
      `INSERT INTO steuerberater_paket_position (paket_id,bezeichnung,beleg_ref,xml_ref,status,notiz)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [Number(body.paket_id), bez, String(body.beleg_ref || '').slice(0, 500) || null,
       String(body.xml_ref || '').slice(0, 500) || null, status, String(body.notiz || '').slice(0, 500) || null])).rows[0];
    // если добавили недостающую позицию — комплект неполный
    if (status === 'fehlt') await cl.query('UPDATE steuerberater_paket SET vollstaendig=false WHERE id=$1', [Number(body.paket_id)]);
    return { ok: true, id: r.id };
  });
}

async function positionStatus(body) {
  const status = body.status === 'fehlt' ? 'fehlt' : 'bereit';
  return mit(async cl => {
    const r = (await cl.query('UPDATE steuerberater_paket_position SET status=$2, beleg_ref=COALESCE($3,beleg_ref), xml_ref=COALESCE($4,xml_ref) WHERE id=$1 RETURNING paket_id', [Number(body.id), status, body.beleg_ref || null, body.xml_ref || null])).rows[0];
    if (!r) throw new Error('нет такой позиции');
    const f = (await cl.query("SELECT count(*) FILTER (WHERE status='fehlt')::int f FROM steuerberater_paket_position WHERE paket_id=$1", [r.paket_id])).rows[0];
    await cl.query('UPDATE steuerberater_paket SET vollstaendig=$2 WHERE id=$1', [r.paket_id, f.f === 0]);
    return { ok: true };
  });
}

// Передача комплекта — отдельное событие. НЕ создаёт документ/проводку.
// Повторная передача копии допускается как новое событие.
async function paketUebergeben(body, user) {
  const art = UEB_ART_T[body.art] ? body.art : 'erstuebergabe';
  return mit(async cl => {
    const p = (await cl.query('SELECT * FROM steuerberater_paket WHERE id=$1', [Number(body.paket_id)])).rows[0];
    if (!p) throw new Error('нет такого комплекта');
    await cl.query(
      `INSERT INTO steuerberater_uebergabe (paket_id,art,datum,an,umfang,kommentar,autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [p.id, art, body.datum || null, String(body.an || '').slice(0, 200) || null,
       String(body.umfang || '').slice(0, 1000) || null, String(body.kommentar || '').slice(0, 1000) || null, user.login]);
    // статус комплекта -> передан (первичная/повторная/дополнение — все фиксируют факт передачи)
    await cl.query("UPDATE steuerberater_paket SET status='uebergeben' WHERE id=$1", [p.id]);
    return { ok: true, art, art_text: UEB_ART_T[art] };
  });
}

/* ===== Ф7 — вопросы от Steuerberater ===== */
const FRAGE_STATUS_T = {
  offen: 'Новый', zugewiesen: 'Поручен', antwort_vorbereitet: 'Ответ подготовлен',
  natalia_geprueft: 'Проверен Натальей', im_paket: 'В комплекте ответов', uebergeben: 'Передан',
  nachfrage: 'Нужно уточнение', erledigt: 'Закрыт',
};
function heuteISO() {
  const j = process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date();
  return (isNaN(j) ? new Date() : j).toISOString().slice(0, 10);
}
// pg возвращает DATE как объект Date (в локальной полуночи) — приводим к ISO-дате аккуратно
function isoD(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
const OFFEN_STATUS = ['offen', 'zugewiesen', 'antwort_vorbereitet', 'nachfrage'];

function frageAusgabe(r) {
  const heute = heuteISO();
  const frist = isoD(r.frist_intern) || isoD(r.frist_steuerberater);
  const offen = OFFEN_STATUS.includes(r.status);
  const tage = frist ? Math.round((new Date(frist + 'T00:00:00Z') - new Date(heute + 'T00:00:00Z')) / 864e5) : null;
  return {
    id: r.id, quelle: r.quelle || '', datum: r.datum || null, inhalt: r.inhalt,
    bezug_dok: r.bezug_dok || '', firma: r.firma || null, jahr: r.jahr || null, monat: r.monat || null,
    frist_steuerberater: r.frist_steuerberater || null, frist_intern: r.frist_intern || null,
    frist_unbekannt: !r.frist_steuerberater && !r.frist_intern,   // «нужно уточнить срок»
    bearbeiter: r.bearbeiter || null, status: r.status, status_text: FRAGE_STATUS_T[r.status] || r.status,
    paket_id: r.paket_id || null, autor: r.autor, angelegt: r.angelegt,
    tage, ueberfaellig: offen && tage != null && tage < 0, bald: offen && tage != null && tage >= 0 && tage <= 3,
    an_gf: offen && tage != null && tage < 0,   // нерешённое и просрочено → внимание владельцу
  };
}

async function frageAnlegen(body, user) {
  const inhalt = String(body.inhalt || '').trim();
  if (!inhalt) throw new Error('нужен текст вопроса');
  const mon = body.monat ? Number(body.monat) : null;
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO steuerberater_frage (quelle,datum,inhalt,bezug_dok,firma,jahr,monat,frist_steuerberater,autor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [String(body.quelle || '').slice(0, 200) || null, body.datum || null, inhalt,
       String(body.bezug_dok || '').slice(0, 800) || null, body.firma || null,
       body.jahr ? Number(body.jahr) : null, mon, body.frist_steuerberater || null, user.login])).rows[0];
    return frageAusgabe(r);
  });
}

async function frageListe(filter) {
  filter = filter || {};
  return mit(async cl => {
    const w = [], a = [];
    if (filter.status) { a.push(filter.status); w.push('status=$' + a.length); }
    if (filter.bearbeiter) { a.push(filter.bearbeiter); w.push('bearbeiter=$' + a.length); }
    const rows = (await cl.query('SELECT * FROM steuerberater_frage'
      + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY (status=$' + (a.length + 1) + ') DESC, angelegt DESC LIMIT 300',
      a.concat(['offen']))).rows;
    return rows.map(frageAusgabe);
  });
}

async function frageEins(id) {
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM steuerberater_frage WHERE id=$1', [Number(id)])).rows[0];
    if (!r) throw new Error('нет такого вопроса');
    const ant = (await cl.query('SELECT id,text,materialien,autor,status,geprueft_von,geprueft_am,notiz,angelegt FROM steuerberater_antwort WHERE frage_id=$1 ORDER BY angelegt', [r.id])).rows;
    return { ...frageAusgabe(r), antworten: ant };
  });
}

// Назначить исполнителя и внутренний срок. Срок ставит Наталья с учётом срока Steuerberater.
async function frageZuweisen(body, user) {
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM steuerberater_frage WHERE id=$1', [Number(body.id)])).rows[0];
    if (!r) throw new Error('нет такого вопроса');
    const st = r.status === 'offen' ? 'zugewiesen' : r.status;
    const upd = (await cl.query(
      'UPDATE steuerberater_frage SET bearbeiter=$2, frist_intern=COALESCE($3,frist_intern), status=$4 WHERE id=$1 RETURNING *',
      [r.id, String(body.bearbeiter || '').slice(0, 60) || null, body.frist_intern || null, st])).rows[0];
    return frageAusgabe(upd);
  });
}

// Исполнитель готовит ответ.
async function antwortAnlegen(body, user) {
  const text = String(body.text || '').trim();
  if (!text) throw new Error('нужен текст ответа');
  return mit(async cl => {
    const f = (await cl.query('SELECT * FROM steuerberater_frage WHERE id=$1', [Number(body.frage_id)])).rows[0];
    if (!f) throw new Error('нет такого вопроса');
    const r = (await cl.query(
      'INSERT INTO steuerberater_antwort (frage_id,text,materialien,autor) VALUES ($1,$2,$3,$4) RETURNING *',
      [f.id, text, String(body.materialien || '').slice(0, 1000) || null, user.login])).rows[0];
    await cl.query("UPDATE steuerberater_frage SET status='antwort_vorbereitet' WHERE id=$1", [f.id]);
    return { ok: true, id: r.id };
  });
}

// Наталья проверяет ответ: принять (geprueft) или вернуть на уточнение (nachfrage).
async function antwortPruefen(body, user) {
  const ok = body.ok !== false;
  return mit(async cl => {
    const a = (await cl.query('SELECT * FROM steuerberater_antwort WHERE id=$1', [Number(body.id)])).rows[0];
    if (!a) throw new Error('нет такого ответа');
    await cl.query('UPDATE steuerberater_antwort SET status=$2, geprueft_von=$3, geprueft_am=now(), notiz=COALESCE($4,notiz) WHERE id=$1',
      [a.id, ok ? 'geprueft' : 'nachfrage', user.login, body.notiz ? String(body.notiz).slice(0, 800) : null]);
    await cl.query('UPDATE steuerberater_frage SET status=$2 WHERE id=$1',
      [a.frage_id, ok ? 'natalia_geprueft' : 'nachfrage']);
    return { ok: true, geprueft: ok };
  });
}

// Включить проверенный ответ в комплект ответов (общий комплект).
async function frageInPaket(body, user) {
  return mit(async cl => {
    const f = (await cl.query('SELECT * FROM steuerberater_frage WHERE id=$1', [Number(body.id)])).rows[0];
    if (!f) throw new Error('нет такого вопроса');
    if (f.status !== 'natalia_geprueft' && f.status !== 'im_paket') throw new Error('в комплект включается только проверенный Натальей ответ');
    const upd = (await cl.query("UPDATE steuerberater_frage SET status='im_paket', paket_id=$2 WHERE id=$1 RETURNING *",
      [f.id, body.paket_id ? Number(body.paket_id) : null])).rows[0];
    return frageAusgabe(upd);
  });
}

module.exports = {
  ART_T, BETROFFEN_T, bestaetigungAnlegen, bestaetigungListe, hatBestaetigung, mit,
  PAKET_STATUS_T, UEB_ART_T, paketAnlegen, paketListe, paketEins, positionAdd, positionStatus, paketUebergeben,
  FRAGE_STATUS_T, frageAnlegen, frageListe, frageEins, frageZuweisen, antwortAnlegen, antwortPruefen, frageInPaket,
};
