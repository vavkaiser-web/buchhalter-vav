/* ---------------------------------------------------------------
   Дополнение №5 Ф5 — уведомления владельцу (Андрею).
   Когда ранее показанные прибыль / налог / задолженность меняются:
   что изменилось · прежняя сумма · новая · причина · период/объект ·
   кто подтвердил · основание согласования.
   Одно исправление — одно сообщение (объединяем изменения). Дедуп по
   источнику. Различаем предварительное влияние и применённое.
   Согласованное окно уведомлений владельца — отдельно (канал не
   подключаем); здесь готовим содержимое сообщения.
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}

const ART_T = { ergebnis: 'Прибыль', steuer: 'Налог', schuld: 'Задолженность' };

function ausgabe(r) {
  return {
    id: r.id, ziel: r.ziel, quelle: r.quelle || null, vorlaeufig: r.vorlaeufig === true,
    firma: r.firma || null, jahr: r.jahr || null, monat: r.monat || null, objekt_nr: r.objekt_nr || null,
    aenderungen: (r.aenderungen || []).map(a => ({ ...a, art_text: ART_T[a.art] || a.art })),
    grund: r.grund || '', wer_bestaetigt: r.wer_bestaetigt || '', basis: r.basis || '',
    status: r.status, angelegt: r.angelegt, gesehen_am: r.gesehen_am || null,
  };
}

// Создать/обновить уведомление (дедуп по quelle+vorlaeufig).
async function anlegen(b) {
  const aenderungen = Array.isArray(b.aenderungen) ? b.aenderungen
    .filter(a => a && a.art && ART_T[a.art])
    .map(a => ({ art: a.art, alt: (a.alt == null ? '' : String(a.alt)), neu: (a.neu == null ? '' : String(a.neu)) })) : [];
  if (!aenderungen.length) return { ok: false, leer: true };  // без затронутых показателей — не уведомляем
  return mit(async cl => {
    const r = (await cl.query(
      `INSERT INTO benachrichtigung (ziel,quelle,vorlaeufig,firma,jahr,monat,objekt_nr,aenderungen,grund,wer_bestaetigt,basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (quelle,vorlaeufig) WHERE quelle IS NOT NULL
       DO UPDATE SET aenderungen=EXCLUDED.aenderungen, grund=EXCLUDED.grund,
         wer_bestaetigt=EXCLUDED.wer_bestaetigt, basis=EXCLUDED.basis, firma=EXCLUDED.firma,
         jahr=EXCLUDED.jahr, monat=EXCLUDED.monat, objekt_nr=EXCLUDED.objekt_nr,
         status='offen', angelegt=now(), gesehen_am=NULL
       RETURNING *`,
      [b.ziel || 'gf', b.quelle || null, b.vorlaeufig === true, b.firma || null,
       b.jahr || null, b.monat || null, b.objekt_nr || null, JSON.stringify(aenderungen),
       String(b.grund || '').slice(0, 800) || null, String(b.wer_bestaetigt || '').slice(0, 120) || null,
       String(b.basis || '').slice(0, 800) || null])).rows[0];
    return { ok: true, ...ausgabe(r) };
  });
}

async function liste(filter) {
  filter = filter || {};
  return mit(async cl => {
    const w = ['ziel=$1'], a = [filter.ziel || 'gf'];
    if (filter.status) { a.push(filter.status); w.push('status=$' + a.length); }
    const rows = (await cl.query(
      'SELECT * FROM benachrichtigung WHERE ' + w.join(' AND ') + ' ORDER BY (status=$' + (a.length + 1) + ') DESC, angelegt DESC LIMIT 200',
      a.concat(['offen']))).rows;
    return rows.map(ausgabe);
  });
}

async function zaehle(ziel) {
  return mit(async cl => (await cl.query(
    "SELECT count(*)::int c FROM benachrichtigung WHERE ziel=$1 AND status='offen'", [ziel || 'gf'])).rows[0].c);
}

async function gesehen(id) {
  return mit(async cl => {
    const r = (await cl.query("UPDATE benachrichtigung SET status='gesehen', gesehen_am=now() WHERE id=$1 RETURNING *", [Number(id)])).rows[0];
    if (!r) throw new Error('нет такого уведомления');
    return ausgabe(r);
  });
}

module.exports = { ART_T, anlegen, liste, zaehle, gesehen, mit };
