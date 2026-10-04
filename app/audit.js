/* ---------------------------------------------------------------
   Дополнение №7 §11 — единый журнал значимых действий для владельца.
   Пишем только значимые события; секреты (пароли/токены/ключи) не пишем.
   Единый просмотр сводит записи из нескольких контуров пилота:
   audit_log (права/сессии/блокировки/суммы), korrektur_log (исправления),
   monatsstatus_log (статусы месяцев). Кассовый контур ведёт свой журнал
   buch_ereignis (mailops_prod) — на него ссылаемся отдельно.
   Записи журнала не редактируются: исправление — новым событием.
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}

const GEHEIM = /pin|pass|token|secret|schluessel|key|hash|salz/i;
function sauber(v) { return v == null ? null : String(v).slice(0, 2000); }

// Записать значимое событие. Никогда не передавать сюда секреты.
async function schreiben(e) {
  const art = String(e.art || '').slice(0, 60);
  if (!art) return { ok: false };
  if (GEHEIM.test(art)) return { ok: false, verweigert: 'секрет не пишем' };
  return mit(async cl => {
    await cl.query(
      'INSERT INTO audit_log (wer,rolle,art,ziel,alt,neu,grund,basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [e.wer || null, e.rolle || null, art, e.ziel ? String(e.ziel).slice(0, 120) : null,
       sauber(e.alt), sauber(e.neu), e.grund ? String(e.grund).slice(0, 500) : null, e.basis ? String(e.basis).slice(0, 500) : null]);
    return { ok: true };
  });
}

const ART_T = {
  betrag: 'Изменение суммы', bank_requisiten: 'Банковские реквизиты', rechte: 'Права доступа',
  zahlung: 'Подтверждение оплаты', entscheidung: 'Решение', status: 'Изменение статуса',
  sperre: 'Блокировка доступа', entsperrt: 'Снятие блокировки', sessions: 'Завершение всех сеансов',
  aufgabe_uebergabe: 'Передача задачи', korrektur: 'Исправление', monat: 'Статус месяца',
};

// Единый просмотр значимых событий (только владелец). filter: {art, seit, q}
async function liste(filter) {
  filter = filter || {};
  return mit(async cl => {
    const rows = [];
    // 1) центральный журнал
    (await cl.query('SELECT wann,wer,rolle,art,ziel,alt,neu,grund,basis FROM audit_log ORDER BY wann DESC LIMIT 500')).rows
      .forEach(r => rows.push({ quelle: 'audit', wann: r.wann, wer: r.wer, art: r.art, art_text: ART_T[r.art] || r.art,
        ziel: r.ziel, alt: r.alt, neu: r.neu, grund: r.grund, basis: r.basis }));
    // 2) исправления (суммы/данные)
    (await cl.query("SELECT l.wann,l.autor wer,l.ereignis,l.von,l.nach,l.notiz,l.antrag_id, k.bezug FROM korrektur_log l LEFT JOIN korrektur_antrag k ON k.id=l.antrag_id ORDER BY l.wann DESC LIMIT 300")).rows
      .forEach(r => rows.push({ quelle: 'korrektur', wann: r.wann, wer: r.wer, art: 'korrektur', art_text: 'Исправление · ' + r.ereignis,
        ziel: 'korrektur:' + r.antrag_id, alt: r.von, neu: r.nach, grund: r.bezug || r.notiz, basis: null }));
    // 3) статусы месяцев
    (await cl.query('SELECT wann,autor wer,ereignis,von,nach,firma,jahr,monat,notiz FROM monatsstatus_log ORDER BY wann DESC LIMIT 300')).rows
      .forEach(r => rows.push({ quelle: 'monat', wann: r.wann, wer: r.wer, art: 'monat', art_text: 'Статус месяца · ' + r.ereignis,
        ziel: r.firma + ' ' + r.monat + '.' + r.jahr, alt: r.von, neu: r.nach, grund: r.notiz, basis: null }));
    let out = rows;
    if (filter.art) out = out.filter(x => x.art === filter.art);
    if (filter.seit) out = out.filter(x => new Date(x.wann) >= new Date(filter.seit));
    if (filter.q) { const q = String(filter.q).toLowerCase(); out = out.filter(x => JSON.stringify(x).toLowerCase().includes(q)); }
    out.sort((a, b) => new Date(b.wann) - new Date(a.wann));
    return out.slice(0, 500);
  });
}

module.exports = { schreiben, liste, ART_T, mit };
