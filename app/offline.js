/* ---------------------------------------------------------------
   Дополнение №6 Ф6 — офлайн-чеки, серверная сторона.
   Устойчивый operation_id: повтор после потери связи/ответа/двойного
   нажатия возвращает существующую запись, а не создаёт копию.
   Владелец = вошедший пользователь (офлайн-поле автора не доверяем).
   Смена привязки к объекту после сохранения не переписывается молча —
   фиксируется конфликт на проверку. Сотрудник видит только свою очередь.
   Границы видимости (§11): центр знает только то, что до него дошло.
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}
function num(v) { const x = Math.round(Number(v)); return Number.isFinite(x) ? x : null; }

function ausgabe(r) {
  return {
    id: r.id, operation_id: r.operation_id, autor: r.autor, objekt_nr: r.objekt_nr || null,
    betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, zweck: r.zweck || null,
    aufnahme_datum: r.aufnahme_datum || null, gespeichert_lokal: r.gespeichert_lokal || null,
    upload_datum: r.upload_datum, datei_ref: r.datei_ref || null, status: r.status,
    konflikt: r.konflikt || null, notiz: r.notiz || null,
  };
}

// Приём чека. Идемпотентно по operation_id. Возвращает {duplikat} при повторе.
async function belegEmpfang(body, user) {
  const op = String(body.operation_id || '').trim().slice(0, 120);
  if (!op) throw new Error('нет устойчивого идентификатора операции');
  const objekt = body.objekt_nr ? String(body.objekt_nr).slice(0, 20) : null;
  return mit(async cl => {
    // повтор доставки — вернуть существующее (не копию)
    const alt = (await cl.query('SELECT * FROM beleg_eingang WHERE operation_id=$1', [op])).rows[0];
    if (alt) {
      // §12: смена привязки к объекту после сохранения — не переписываем молча
      if (objekt && alt.objekt_nr && objekt !== alt.objekt_nr && alt.status !== 'konflikt') {
        const upd = (await cl.query(
          "UPDATE beleg_eingang SET status='konflikt', konflikt=$2 WHERE id=$1 RETURNING *",
          [alt.id, 'привязка изменилась: было ' + alt.objekt_nr + ', пришло ' + objekt + ' — на проверку'])).rows[0];
        return { ok: true, duplikat: true, konflikt: true, ...ausgabe(upd) };
      }
      return { ok: true, duplikat: true, ...ausgabe(alt) };
    }
    const r = (await cl.query(
      `INSERT INTO beleg_eingang (operation_id,autor,objekt_nr,betrag_cent,zweck,aufnahme_datum,gespeichert_lokal,datei_ref,notiz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [op, user.login, objekt, num(body.betrag_cent), body.zweck ? String(body.zweck).slice(0, 40) : null,
       body.aufnahme_datum || null, body.gespeichert_lokal || null,
       body.datei_ref ? String(body.datei_ref).slice(0, 300) : null,
       body.notiz ? String(body.notiz).slice(0, 500) : null])).rows[0];
    return { ok: true, duplikat: false, ...ausgabe(r) };
  });
}

// Очередь пользователя на сервере (что до центра дошло). Сотрудник — только свои.
async function meine(user, alle) {
  return mit(async cl => {
    const rows = alle && ['gf', 'buchhaltung'].includes(user.rolle)
      ? (await cl.query('SELECT * FROM beleg_eingang ORDER BY upload_datum DESC LIMIT 300')).rows
      : (await cl.query('SELECT * FROM beleg_eingang WHERE autor=$1 ORDER BY upload_datum DESC LIMIT 300', [user.login])).rows;
    return rows.map(ausgabe);
  });
}

module.exports = { belegEmpfang, meine, mit };
