'use strict';
/* ----------------------------------------------------------------
   Гейт утверждения закупок (Bestellung).
   Порог: ≤3000 € — утверждает Олег (disponent).
          >3000 € или вне бюджета — Андрей + Олег.
   Нарезка заказов (split) для обхода порога → на Андрея.
   Отсутствие Андрея: крупные закупки ЖДУТ — без делегирования.
   ---------------------------------------------------------------- */

const SCHWELLE_CENT = 300_000;   // 3 000 €
const SPLIT_TAGE   = 60;         // окно поиска нарезки (дней)
const SPLIT_MIN    = 1;          // минимум других заказов (итого ≥2) для флага нарезки

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) { const cl = pg(); try { await cl.connect(); return await fn(cl); } finally { try { await cl.end(); } catch (e) {} } }

async function log(cl, bestellung_id, ereignis, rolle, autor, notiz) {
  await cl.query(
    'INSERT INTO bestellung_genehmigung_log (bestellung_id,ereignis,rolle,autor,notiz) VALUES ($1,$2,$3,$4,$5)',
    [bestellung_id, ereignis, rolle, autor, notiz || null]);
}

// Внутренняя проверка нарезки: другие заказы тому же поставщику за SPLIT_TAGE дней.
async function splitPruefen(cl, bestellung_id) {
  const best = (await cl.query(
    'SELECT lieferant, summe_cent, angelegt FROM bestellung WHERE id=$1',
    [bestellung_id])).rows[0];
  if (!best || !best.lieferant) return { split: false };

  const since = new Date(best.angelegt || new Date());
  since.setDate(since.getDate() - SPLIT_TAGE);

  const rows = (await cl.query(
    `SELECT id, summe_cent FROM bestellung
     WHERE lieferant=$1 AND id<>$2
       AND summe_cent < $3
       AND angelegt >= $4
     ORDER BY angelegt`,
    [best.lieferant, bestellung_id, SCHWELLE_CENT, since.toISOString()]
  )).rows;

  if (rows.length < SPLIT_MIN) return { split: false };

  const gesamt = rows.reduce((s, r) => s + Number(r.summe_cent), Number(best.summe_cent));
  if (gesamt <= SCHWELLE_CENT) return { split: false };

  return {
    split: true,
    ids: rows.map(r => r.id),
    gesamt_cent: gesamt,
    notiz: `Нарезка: ${rows.length + 1} заказов тому же поставщику за ${SPLIT_TAGE} дней, итого ${(gesamt / 100).toFixed(2)} € > порога.`,
  };
}

// Оценить заказ: нужен ли Андрей, записать в bestellung + лог.
async function beurteilen(bestellung_id, login) {
  return mit(async (cl) => {
    const id = Number(bestellung_id);
    const best = (await cl.query(
      'SELECT * FROM bestellung WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!best) throw new Error('заказ не найден');

    const ueber   = Number(best.summe_cent) > SCHWELLE_CENT;
    const keinBud = !best.basis;   // basis = бюджетная строка; null = нет бюджета
    const sp      = await splitPruefen(cl, id);

    const braucht = ueber || keinBud || sp.split;
    const grund   = ueber ? 'summe' : sp.split ? 'split' : keinBud ? 'kein_budget' : null;

    await cl.query(
      'UPDATE bestellung SET braucht_andrej=$2, braucht_grund=$3 WHERE id=$1',
      [id, braucht, grund]);
    await log(cl, id, 'beurteilt', login ? 'system' : 'system', login || 'system',
      braucht ? `Требуется Андрей (${grund})` : 'Достаточно одобрения Олега');

    return { ok: true, braucht_andrej: braucht, braucht_grund: grund, split: sp.split || false };
  });
}

// Олег одобряет (для заказов, где braucht_andrej=false, или как первый шаг крупных).
async function oleGenehmigen(d, user) {
  return mit(async (cl) => {
    if (!user || !['disponent', 'gf'].includes(user.rolle))
      throw new Error('только Олег (disponent) или gf');
    const id = Number(d.bestellung_id); if (!id) throw new Error('нет bestellung_id');
    const best = (await cl.query('SELECT * FROM bestellung WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!best) throw new Error('заказ не найден');
    if (best.ablehn_von) throw new Error('заказ уже отклонён');
    if (best.oleg_am) throw new Error('Олег уже одобрил');

    await cl.query(
      'UPDATE bestellung SET oleg_von=$2, oleg_am=now() WHERE id=$1',
      [id, user.login]);
    await log(cl, id, 'oleg_genehmigt', user.rolle, user.login, d.notiz || null);

    // Если не нужен Андрей → заказ переходит в genehmigt
    if (!best.braucht_andrej) {
      await cl.query("UPDATE bestellung SET status='genehmigt' WHERE id=$1", [id]);
      await log(cl, id, 'genehmigt', user.rolle, user.login, 'автоматически после одобрения Олега');
    }
    return { ok: true, naechster_schritt: best.braucht_andrej ? 'andrej' : 'genehmigt' };
  });
}

// Андрей (gf) одобряет крупный/нестандартный заказ.
async function gfGenehmigen(d, user) {
  return mit(async (cl) => {
    if (!user || user.rolle !== 'gf') throw new Error('только Андрей (gf)');
    const id = Number(d.bestellung_id); if (!id) throw new Error('нет bestellung_id');
    const best = (await cl.query('SELECT * FROM bestellung WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!best) throw new Error('заказ не найден');
    if (best.ablehn_von) throw new Error('заказ уже отклонён');
    if (!best.braucht_andrej) throw new Error('этот заказ не требует подписи gf');
    if (!best.oleg_am) throw new Error('сначала одобрение Олега');
    if (best.gf_am) throw new Error('gf уже одобрил');

    await cl.query(
      'UPDATE bestellung SET gf_von=$2, gf_am=now(), status=$3 WHERE id=$1',
      [id, user.login, 'genehmigt']);
    await log(cl, id, 'gf_genehmigt', user.rolle, user.login, d.notiz || null);
    return { ok: true, status: 'genehmigt' };
  });
}

// Отклонить заказ (Олег или Андрей).
async function ablehnen(d, user) {
  return mit(async (cl) => {
    if (!user || !['disponent', 'gf'].includes(user.rolle))
      throw new Error('только disponent или gf');
    const id = Number(d.bestellung_id); if (!id) throw new Error('нет bestellung_id');
    const grund = String(d.grund || '').slice(0, 400);
    if (!grund) throw new Error('нужна причина отклонения');
    const best = (await cl.query('SELECT * FROM bestellung WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!best) throw new Error('заказ не найден');
    if (best.status === 'genehmigt') throw new Error('гenehmigter Auftrag не отклоняется здесь');

    await cl.query(
      "UPDATE bestellung SET ablehn_von=$2, ablehn_grund=$3, status='abgelehnt' WHERE id=$1",
      [id, user.login, grund]);
    await log(cl, id, 'abgelehnt', user.rolle, user.login, grund);
    return { ok: true, status: 'abgelehnt' };
  });
}

// Читать статус гейта одного заказа.
async function gateStatus(bestellung_id) {
  return mit(async (cl) => {
    const id = Number(bestellung_id);
    const best = (await cl.query(
      'SELECT id,lieferant,summe_cent,status,braucht_andrej,braucht_grund,oleg_von,oleg_am,gf_von,gf_am,ablehn_von,ablehn_grund FROM bestellung WHERE id=$1',
      [id])).rows[0];
    if (!best) throw new Error('заказ не найден');
    const history = (await cl.query(
      'SELECT * FROM bestellung_genehmigung_log WHERE bestellung_id=$1 ORDER BY wann',
      [id])).rows;
    const sp = await splitPruefen(cl, id);
    return { ...best, log: history, split: sp };
  });
}

// Проверка гейта для счёта (используется в rechnung_kontrolle).
// Возвращает {gateOk, grund, notiz}.
async function gateCheck(cl, bestellung_id) {
  const id = Number(bestellung_id);
  const best = (await cl.query(
    'SELECT braucht_andrej,braucht_grund,oleg_am,gf_am,ablehn_von,status FROM bestellung WHERE id=$1',
    [id])).rows[0];
  if (!best) return { gateOk: false, grund: 'nein', notiz: 'Заказ не найден.' };

  if (best.ablehn_von)
    return { gateOk: false, grund: 'abgelehnt', notiz: 'Заказ отклонён.' };
  // Заказы в статусе genehmigt без записей гейта — одобрены по старому процессу.
  if (best.status === 'genehmigt' && !best.oleg_am && !best.gf_am)
    return { gateOk: true, grund: null, notiz: 'Заказ одобрен (до введения гейта).' };
  if (!best.oleg_am)
    return { gateOk: false, grund: 'oleg_fehlt', notiz: 'Заказ ещё не одобрен Олегом.' };
  if (best.braucht_andrej && !best.gf_am)
    return { gateOk: false, grund: 'gf_fehlt', notiz: 'Заказ >3.000 € или вне бюджета — нужна подпись Андрея.' };

  // Проверка нарезки (через отдельный cl — уже внутри транзакции)
  const sp = await splitPruefen(cl, id);
  if (sp.split)
    return { gateOk: false, grund: 'split', notiz: sp.notiz };

  return { gateOk: true, grund: null, notiz: 'Гейт пройден.' };
}

module.exports = { beurteilen, oleGenehmigen, gfGenehmigen, ablehnen, gateStatus, gateCheck, SCHWELLE_CENT };
