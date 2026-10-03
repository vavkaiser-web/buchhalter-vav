/* ---------------------------------------------------------------
   Дополнение №6 Ф1–Ф3 — состояние интеграций.
   Ф1: по каждому источнику — соединение, последнее успешное получение,
       до какого момента обработано, необработанный остаток, причина
       ошибки, состояние повтора. Доступность соединения ≠ полнота
       синхронизации. При сбое: хранить последние данные, показать их
       дату, одна задача ответственному (без дублей), неизвестное ≠ ноль.
   Ф2: устаревшие банковские данные → прогноз предварительный; порог —
       явная настройка (по умолчанию помечена «требует согласования»).
   Ф3: восстановление — контрольная точка (verarbeitet_bis), последняя
       версия, отметка задачи о сбое. Идемпотентность приёма событий и
       защита от устаревших версий — в objekt.integrationEreignis
       (integration_journal).
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');
const aufgaben = require('./aufgaben.js');

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}
function jetzt() { return process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date(); }

// Известные источники (пополняются по мере готовности).
const QUELLEN = [
  { quelle: 'finmap', titel: 'FinMap — банк и деньги', bank: true },
  { quelle: 'mail', titel: 'Почта — входящие документы' },
  { quelle: 'zeiterfassung', titel: 'VAV Kaiser — Учёт часов' },
  { quelle: 'kasse', titel: 'Касса — наличные' },
];
const IST_BANK = new Set(QUELLEN.filter(q => q.bank).map(q => q.quelle));

function verantwortlicherLogin() {
  try {
    const data = process.env.BUCH_DATA || path.join(__dirname, 'data');
    const liste = JSON.parse(fs.readFileSync(path.join(data, 'benutzer.json'), 'utf8'));
    const v = liste.find(x => x.rolle === 'buchhaltung' && x.verantwortlich === true);
    return v ? v.login : null;
  } catch (e) { return null; }
}

async function ensure(cl) {
  for (const q of QUELLEN) {
    await cl.query('INSERT INTO integration_quelle (quelle, titel) VALUES ($1,$2) ON CONFLICT (quelle) DO UPDATE SET titel=EXCLUDED.titel', [q.quelle, q.titel]);
  }
}

function ausgabe(r) {
  const now = jetzt().getTime();
  const letzter = r.letzter_erfolg ? new Date(r.letzter_erfolg).getTime() : null;
  const alter_min = letzter != null ? Math.round((now - letzter) / 60000) : null;
  const veraltet = letzter != null ? (now - letzter) > r.schwelle_minuten * 60000 : (r.verbindung !== 'ok');
  return {
    quelle: r.quelle, titel: r.titel || r.quelle, bank: IST_BANK.has(r.quelle),
    verbindung: r.verbindung,                        // доступность соединения
    letzter_erfolg: r.letzter_erfolg || null,
    verarbeitet_bis: r.verarbeitet_bis || null,      // полнота синхронизации (контрольная точка)
    rueckstand: r.rueckstand,                        // -1 = неизвестно, не путать с 0
    rueckstand_bekannt: r.rueckstand >= 0,
    fehler_text: r.fehler_text || null,
    wiederholung: r.wiederholung || null,
    stand_daten: r.stand_daten || null,
    aufgabe_id: r.aufgabe_id || null,
    letzte_version: r.letzte_version != null ? String(r.letzte_version) : null,
    schwelle_minuten: r.schwelle_minuten, schwelle_bestaetigt: r.schwelle_bestaetigt === true,
    alter_minuten: alter_min, veraltet,
    // соединение доступно, но синхронизация неполная — отдельный сигнал
    sync_unvollstaendig: r.verbindung === 'ok' && r.rueckstand > 0,
  };
}

async function statusListe() {
  return mit(async cl => {
    await ensure(cl);
    const rows = (await cl.query('SELECT * FROM integration_quelle ORDER BY quelle')).rows;
    const quellen = rows.map(ausgabe);
    const bank = quellen.find(q => q.bank) || null;
    return {
      quellen,
      bank_vorlaeufig: bank ? (bank.veraltet || bank.verbindung !== 'ok') : true, // прогноз предварительный?
      bank_stand: bank ? bank.stand_daten || bank.letzter_erfolg : null,
      stand: jetzt().toISOString(),
    };
  });
}

// Событие о состоянии источника: ergebnis = 'erfolg' | 'fehler'.
async function meldung(body) {
  const quelle = String(body.quelle || '').slice(0, 40);
  if (!quelle) throw new Error('нет источника');
  const erfolg = body.ergebnis === 'erfolg';
  return mit(async cl => {
    await ensure(cl);
    const cur = (await cl.query('SELECT * FROM integration_quelle WHERE quelle=$1', [quelle])).rows[0]
      || (await cl.query('INSERT INTO integration_quelle (quelle,titel) VALUES ($1,$1) RETURNING *', [quelle])).rows[0];
    const now = jetzt();

    if (erfolg) {
      const rueck = (body.rueckstand != null && Number.isFinite(Number(body.rueckstand))) ? Number(body.rueckstand) : 0;
      const vbis = body.verarbeitet_bis ? new Date(body.verarbeitet_bis) : now;
      const ver = (body.version != null && Number.isFinite(Number(body.version)))
        ? Math.max(Number(body.version), cur.letzte_version || 0) : cur.letzte_version;
      await cl.query(
        `UPDATE integration_quelle SET verbindung='ok', letzter_erfolg=$2, verarbeitet_bis=$3,
           rueckstand=$4, stand_daten=$2, fehler_text=NULL, wiederholung=NULL, letzte_version=$5, stand=now()
         WHERE quelle=$1`, [quelle, now.toISOString(), vbis.toISOString(), rueck, ver]);
      // Ф3: если была открытая задача о сбое — отметить восстановление (не закрываем: расхождения проверяет человек)
      let vermerk = null;
      if (cur.aufgabe_id) {
        aufgaben.notiz(cur.aufgabe_id, 'Соединение с «' + (cur.titel || quelle) + '» восстановлено. Проверьте расхождения и закройте задачу.', 'system');
        await cl.query('UPDATE integration_quelle SET aufgabe_id=NULL WHERE quelle=$1', [quelle]);
        vermerk = cur.aufgabe_id;
      }
      return { ok: true, quelle, verbindung: 'ok', wiederhergestellt: vermerk };
    }

    // сбой: последние успешные данные не трогаем; неизвестное не превращаем в ноль
    const fehler = String(body.fehler_text || 'Не удалось получить данные').slice(0, 400);
    const wied = String(body.wiederholung || 'повтор запланирован').slice(0, 120);
    // rueckstand не задан → не сбрасываем в 0, ставим -1 (неизвестно), если ранее было 0/пусто
    let rueck = cur.rueckstand;
    if (body.rueckstand != null && Number.isFinite(Number(body.rueckstand))) rueck = Number(body.rueckstand);
    else if (cur.rueckstand === 0) rueck = -1;
    await cl.query(
      `UPDATE integration_quelle SET verbindung='fehler', fehler_text=$2, wiederholung=$3, rueckstand=$4, stand=now() WHERE quelle=$1`,
      [quelle, fehler, wied, rueck]);
    // служебный журнал (без секретов)
    await cl.query('INSERT INTO integration_fehlerlog (quelle,code,detail) VALUES ($1,$2,$3)',
      [quelle, String(body.code || '').slice(0, 80) || null, String(body.detail || '').slice(0, 1000) || null]);
    // одна задача ответственному — без дублей
    let aufgabe_id = cur.aufgabe_id;
    const offen = aufgaben.offeneNachArt('integration_fehler').find(a => a.bezug === quelle);
    if (!offen) {
      const v = verantwortlicherLogin();
      const r = aufgaben.systemAufgabe({
        titel: 'Сбой интеграции: ' + (cur.titel || quelle),
        text: 'Источник «' + (cur.titel || quelle) + '» не отвечает: ' + fehler
          + '. Показаны последние данные' + (cur.stand_daten ? ' от ' + new Date(cur.stand_daten).toLocaleString('de-DE') : '')
          + '. Проверьте и при восстановлении сверьте расхождения.',
        art: 'integration_fehler', bezug: quelle,
        ziel_person: v || undefined, ziel_rolle: 'buchhaltung',
      });
      aufgabe_id = r.id;
      await cl.query('UPDATE integration_quelle SET aufgabe_id=$2 WHERE quelle=$1', [quelle, aufgabe_id]);
    } else {
      aufgabe_id = offen.id;
      if (cur.aufgabe_id !== aufgabe_id) await cl.query('UPDATE integration_quelle SET aufgabe_id=$2 WHERE quelle=$1', [quelle, aufgabe_id]);
    }
    return { ok: true, quelle, verbindung: 'fehler', aufgabe_id, neue_aufgabe: !offen };
  });
}

// Порог устаревания — явная настройка владельца.
async function schwelleSetzen(body) {
  const quelle = String(body.quelle || '').slice(0, 40);
  const min = Number(body.schwelle_minuten);
  if (!IST_BANK.has(quelle) && !QUELLEN.find(q => q.quelle === quelle)) throw new Error('неизвестный источник');
  if (!Number.isFinite(min) || min < 5) throw new Error('порог в минутах, не меньше 5');
  return mit(async cl => {
    await ensure(cl);
    await cl.query('UPDATE integration_quelle SET schwelle_minuten=$2, schwelle_bestaetigt=true, stand=now() WHERE quelle=$1', [quelle, Math.round(min)]);
    return { ok: true, quelle, schwelle_minuten: Math.round(min), schwelle_bestaetigt: true };
  });
}

async function fehlerlog(quelle, limit) {
  return mit(async cl => (await cl.query(
    'SELECT quelle,code,detail,wann FROM integration_fehlerlog' + (quelle ? ' WHERE quelle=$1' : '')
    + ' ORDER BY wann DESC LIMIT ' + Math.min(200, Number(limit) || 50), quelle ? [quelle] : [])).rows);
}

module.exports = { QUELLEN, statusListe, meldung, schwelleSetzen, fehlerlog, mit };
