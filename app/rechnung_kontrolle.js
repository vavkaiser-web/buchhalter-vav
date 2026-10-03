'use strict';
// Контроль входящего счёта (beleg) против заказа/договора (bestellung).
// Правила и граничные условия:
//  1. Превышение суммы заказа → задача Олегу, счёт НЕ готов к оплате автоматически.
//  2. Доп.работы без основания → задача через Олега к Андрею.
//  3. Итоговый счёт (schlussrechnung): Σ(все частичные счета + этот) ≤ сумма заказа.
//  4. Различаем fakturiert (сумма счетов) и bezahlt (фактически оплачено).
//  5. Отсутствие документа создаёт задачу, не дублируя уже открытую.
//  6. Срок оплаты виден Андрею вместе с причиной задержки и недостающими подтверждениями.
//  7. Исключение — только Андрей (gf). Сохраняет: основание, дату, сумму, хэш счёта.
//     Изменение счёта (другой хэш) делает исключение недействительным.
//  8. Исключение НЕ отключает проверку дублетов и IBAN-стоп.
//  9. После оплаты (beleg.bezahlt=true) незакрытая задача по документам остаётся открытой.

const { Pool } = require('pg');
const aufgaben = require('./aufgaben.js');

const pool = new Pool({ connectionString: process.env.PILOT_IMPORT_DB });
function mit(fn) {
  return pool.connect().then(cl => fn(cl).then(r => { cl.release(); return r; }).catch(e => { cl.release(); throw e; }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function eur(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function fmt(cent) {
  return (cent / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

// ── Главная проверка счёта ────────────────────────────────────────────────────

// pruefung(beleg_id, bestellung_id, login)
// Запускает прогон проверки и создаёт задачу при необходимости.
// bestellung_id: если null — проверяется только факт отсутствия соответствующего заказа.
async function pruefung(beleg_id, bestellung_id, login) {
  return mit(async (cl) => {
    const beleg = (await cl.query(
      'SELECT id, lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, faellig, iban, datei_hash, status, bezahlt, gesperrt_grund FROM beleg WHERE id=$1',
      [beleg_id])).rows[0];
    if (!beleg) throw new Error('счёт не найден');

    const bId = bestellung_id ? Number(bestellung_id) : null;
    let best = null;
    if (bId) {
      best = (await cl.query(
        'SELECT b.id, b.objekt_nr, b.lieferant, b.summe_cent, b.status, b.basis, b.umfang, ' +
        'coalesce((SELECT sum(betrag_cent) FROM bestellung_rechnung r WHERE r.bestellung_id=b.id),0) fakturiert ' +
        'FROM bestellung b WHERE b.id=$1',
        [bId])).rows[0];
      if (!best) throw new Error('заказ не найден');
    }

    const betrag = Number(beleg.betrag_cent || 0);
    const items = [];
    let ergebnis = 'ok';

    // ── Проверка 1: подрядчик совпадает ──────────────────────────────────────
    if (best) {
      const lKey = beleg.lieferant_key;
      const bLief = String(best.lieferant || '');
      // Простое сравнение: ключ из beleg должен содержать ключ из заказа (или совпадать)
      // Детальная дедупликация — kern_dubletten.js; здесь флаг для бухгалтера.
      const liefOk = lKey && bLief && (
        bLief.toLowerCase().includes((lKey || '').toLowerCase().slice(0, 6)) ||
        (lKey || '').toLowerCase().includes(bLief.toLowerCase().slice(0, 6))
      );
      items.push({
        art: 'lieferant',
        status: liefOk ? 'ok' : 'hinweis',
        notiz: liefOk
          ? 'Подрядчик совпадает: ' + beleg.lieferant
          : 'Счёт: «' + beleg.lieferant + '» → Заказ: «' + best.lieferant + '» — проверить вручную.',
      });
      if (!liefOk && ergebnis === 'ok') ergebnis = 'hinweis';
    } else {
      items.push({ art: 'lieferant', status: 'fehlt', notiz: 'Заказ не указан — нет основания для оплаты.' });
      ergebnis = 'blockiert';
    }

    // ── Проверка 2: сумма vs заказ ───────────────────────────────────────────
    if (best) {
      const summeBest = Number(best.summe_cent || 0);
      const fakturiert = Number(best.fakturiert || 0);
      const neuGesamt = fakturiert + betrag;

      if (neuGesamt > summeBest) {
        const ueber = neuGesamt - summeBest;
        items.push({
          art: 'summe',
          status: 'blockiert',
          soll_cent: summeBest,
          ist_cent: neuGesamt,
          diff_cent: ueber,
          notiz: 'Σ счетов ' + fmt(neuGesamt) + ' превышает заказ ' + fmt(summeBest) +
                 ' на ' + fmt(ueber) + '. Ранее выставлено: ' + fmt(fakturiert) + '.',
        });
        ergebnis = 'blockiert';
      } else {
        items.push({
          art: 'summe',
          status: 'ok',
          soll_cent: summeBest,
          ist_cent: neuGesamt,
          diff_cent: neuGesamt - summeBest,
          notiz: 'В рамках заказа: ' + fmt(neuGesamt) + ' из ' + fmt(summeBest) + '.',
        });
      }
    }

    // ── Проверка 3: итоговый счёт (schlussrechnung) ───────────────────────────
    // Определяем тип счёта по rechnung_nr или явной метке
    const isSchluss = best && (
      /schluss/i.test(String(beleg.rechnung_nr || '')) ||
      /final|schlu|итог/i.test(String(beleg.rechnung_nr || ''))
    );
    if (best && isSchluss) {
      const summeBest = Number(best.summe_cent || 0);
      const fakturiert = Number(best.fakturiert || 0);
      const erwarteterRest = summeBest - fakturiert;
      const abweichung = betrag - erwarteterRest;

      if (Math.abs(abweichung) > 0) {
        items.push({
          art: 'schluss',
          status: abweichung > 0 ? 'abweichung' : 'hinweis',
          soll_cent: erwarteterRest,
          ist_cent: betrag,
          diff_cent: abweichung,
          notiz: 'Итоговый счёт: ожидается ' + fmt(erwarteterRest) +
                 ', выставлено ' + fmt(betrag) +
                 ' (разница ' + fmt(Math.abs(abweichung)) + ').' +
                 (abweichung < 0 ? ' Ранее выставлено больше — проверить кредит-ноту.' : ''),
        });
        if (abweichung > 0 && ergebnis !== 'blockiert') ergebnis = 'pruefen';
      } else {
        items.push({ art: 'schluss', status: 'ok', soll_cent: erwarteterRest, ist_cent: betrag, diff_cent: 0,
          notiz: 'Итоговый счёт: сумма совпадает с остатком заказа.' });
      }
    }

    // ── Проверка 4: уже оплачено (fakturiert ≠ bezahlt) ─────────────────────
    if (best) {
      const bezahlt = Number((await cl.query(
        `SELECT coalesce(sum(zz.betrag_cent),0) s
         FROM zahlung_zuordnung zz
         JOIN beleg b2 ON b2.id=zz.beleg_id
         JOIN bestellung_rechnung br ON br.rechnung_ref=b2.rechnung_nr::text
         WHERE br.bestellung_id=$1 AND NOT zz.storniert`, [bId])).rows[0].s);

      const fakturiert = Number(best.fakturiert || 0);
      if (fakturiert !== bezahlt) {
        items.push({
          art: 'kette',
          status: 'hinweis',
          soll_cent: fakturiert,
          ist_cent: bezahlt,
          diff_cent: fakturiert - bezahlt,
          notiz: 'Выставлено: ' + fmt(fakturiert) + ', фактически оплачено: ' + fmt(bezahlt) +
                 '. Разница ' + fmt(fakturiert - bezahlt) + ' — ещё не перечислена.',
        });
        if (ergebnis === 'ok') ergebnis = 'hinweis';
      }
    }

    // ── Проверка 5: документ (полнота) ──────────────────────────────────────
    const dokStatus = String(beleg.status || 'neu');
    const geprueft = dokStatus === 'verbucht' || dokStatus === 'geprueft';
    if (!geprueft) {
      items.push({
        art: 'dokument',
        status: 'fehlt',
        notiz: 'Счёт ещё не проверен бухгалтером (статус: ' + dokStatus + ').',
      });
      if (ergebnis === 'ok') ergebnis = 'hinweis';
    }

    // ── Проверка 6: срок оплаты ─────────────────────────────────────────────
    if (beleg.faellig) {
      const heute = new Date().toISOString().slice(0, 10);
      const uberfaellig = String(beleg.faellig) < heute;
      items.push({
        art: 'faellig',
        status: uberfaellig ? 'abweichung' : 'ok',
        notiz: 'Срок: ' + beleg.faellig + (uberfaellig ? ' — ПРОСРОЧЕНО.' : '.') +
               (!geprueft ? ' Счёт ещё не проверен.' : '') +
               (best && ergebnis === 'blockiert' ? ' Превышение заказа — необходимо одобрение.' : ''),
      });
      if (uberfaellig && ergebnis === 'ok') ergebnis = 'hinweis';
    }

    // ── Записать прогон ──────────────────────────────────────────────────────
    const lauf = (await cl.query(
      'INSERT INTO rechnung_prueflauf (beleg_id,bestellung_id,lieferant,lieferant_key,objekt_nr,betrag_cent,art,ergebnis,von) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [beleg_id, bId, beleg.lieferant, beleg.lieferant_key,
       best ? best.objekt_nr : null, betrag,
       isSchluss ? 'schlussrechnung' : 'teilrechnung',
       ergebnis, login])).rows[0];

    for (const item of items) {
      await cl.query(
        'INSERT INTO rechnung_pruef_item (prueflauf_id,art,status,soll_cent,ist_cent,diff_cent,notiz) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [lauf.id, item.art, item.status, item.soll_cent ?? null, item.ist_cent ?? null, item.diff_cent ?? null, item.notiz ?? null]);
    }

    // ── Задача при blockiert ─────────────────────────────────────────────────
    let aufgabeId = null;
    if (ergebnis === 'blockiert') {
      // Проверяем, нет ли уже открытой задачи по этому счёту.
      const offen = aufgaben.offeneNachArt('rechnung_pruefen', { ref: String(beleg_id) });
      if (!offen || offen.length === 0) {
        const a = await aufgaben.systemAufgabe({
          art: 'rechnung_pruefen',
          titel: 'Счёт превышает заказ: ' + (beleg.lieferant || '?'),
          text: 'Счёт №' + (beleg.rechnung_nr || beleg_id) + ' от ' + (beleg.lieferant || '?') +
                ' превышает согласованную сумму заказа. Требуется одобрение Олега и/или Андрея.',
          ref: String(beleg_id),
          fuer: 'disponent',
        });
        aufgabeId = a && a.id;
        if (aufgabeId) await cl.query('UPDATE rechnung_prueflauf SET aufgabe_id=$2 WHERE id=$1', [lauf.id, aufgabeId]);
      }
    }

    return {
      ok: true,
      prueflauf_id: lauf.id,
      ergebnis,
      items,
      aufgabe_id: aufgabeId,
    };
  });
}

// ── Список прогонов ───────────────────────────────────────────────────────────

async function pruefungsliste(filter) {
  return mit(async (cl) => {
    const { beleg_id, bestellung_id, ergebnis, limit: lim = 50 } = filter || {};
    const conds = [], vals = [];
    if (beleg_id) { conds.push(`beleg_id=$${vals.length + 1}`); vals.push(beleg_id); }
    if (bestellung_id) { conds.push(`bestellung_id=$${vals.length + 1}`); vals.push(bestellung_id); }
    if (ergebnis) { conds.push(`ergebnis=$${vals.length + 1}`); vals.push(ergebnis); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = (await cl.query(
      `SELECT p.id, p.beleg_id, p.bestellung_id, p.lieferant, p.objekt_nr,
              p.betrag_cent, p.art, p.ergebnis, p.aufgabe_id, p.von, p.angelegt,
              (SELECT a.ergebnis FROM rechnung_ausnahme a WHERE a.prueflauf_id=p.id AND a.aktiv LIMIT 1) ausnahme_aktiv
       FROM rechnung_prueflauf p ${where}
       ORDER BY p.angelegt DESC LIMIT $${vals.length + 1}`,
      [...vals, lim])).rows;
    return rows;
  });
}

async function pruefungEins(id) {
  return mit(async (cl) => {
    const lauf = (await cl.query('SELECT * FROM rechnung_prueflauf WHERE id=$1', [id])).rows[0];
    if (!lauf) throw new Error('прогон не найден');
    const items = (await cl.query('SELECT * FROM rechnung_pruef_item WHERE prueflauf_id=$1 ORDER BY id', [id])).rows;
    const ausnahme = (await cl.query('SELECT * FROM rechnung_ausnahme WHERE prueflauf_id=$1 AND aktiv ORDER BY angelegt DESC LIMIT 1', [id])).rows[0] || null;
    const anfrage = (await cl.query("SELECT * FROM rechnung_ausnahme_anfrage WHERE prueflauf_id=$1 AND status NOT IN ('genehmigt','abgelehnt') ORDER BY angelegt DESC LIMIT 1", [id])).rows[0] || null;
    return { ...lauf, items, ausnahme, anfrage };
  });
}

// ── Запрос исключения (бухгалтер → Олег → Андрей) ────────────────────────────

// Бухгалтер передаёт вопрос через Олега при доп.работах или превышении.
async function ausnahmeBeantragen(prueflauf_id, { grund, notiz }, login) {
  return mit(async (cl) => {
    const lauf = (await cl.query('SELECT * FROM rechnung_prueflauf WHERE id=$1', [prueflauf_id])).rows[0];
    if (!lauf) throw new Error('прогон не найден');
    if (!grund || !String(grund).trim()) throw new Error('нужно основание для запроса исключения');

    // Нет ли уже активного запроса?
    const akt = (await cl.query(
      "SELECT id FROM rechnung_ausnahme_anfrage WHERE prueflauf_id=$1 AND status NOT IN ('abgelehnt')",
      [prueflauf_id])).rows[0];
    if (akt) throw new Error('запрос исключения уже создан (id ' + akt.id + ')');

    const diff = lauf.betrag_cent && lauf.bestellung_id
      ? await cl.query(
          'SELECT b.summe_cent, coalesce((SELECT sum(betrag_cent) FROM bestellung_rechnung r WHERE r.bestellung_id=b.id),0) fakt ' +
          'FROM bestellung b WHERE b.id=$1', [lauf.bestellung_id])
          .then(r => r.rows[0] ? Number(lauf.betrag_cent) + Number(r.rows[0].fakt) - Number(r.rows[0].summe_cent) : null)
      : null;

    const a = await aufgaben.systemAufgabe({
      art: 'ausnahme_anfrage',
      titel: 'Исключение по счёту: ' + (lauf.lieferant || '?'),
      text: 'Бухгалтер запрашивает исключение. Причина: ' + grund +
            (diff && diff > 0 ? '. Превышение: ' + fmt(diff) + '.' : '') +
            (notiz ? ' Примечание: ' + notiz : ''),
      ref: String(prueflauf_id),
      fuer: 'disponent',
    });

    const row = (await cl.query(
      'INSERT INTO rechnung_ausnahme_anfrage (prueflauf_id,beleg_id,bestellung_id,ueberschuss_cent,grund,notiz,status,aufgabe_id_oleg,von) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [prueflauf_id, lauf.beleg_id, lauf.bestellung_id,
       diff && diff > 0 ? diff : null,
       String(grund).slice(0, 400), notiz ? String(notiz).slice(0, 400) : null,
       'an_oleg', a && a.id ? a.id : null, login])).rows[0];

    return { ok: true, anfrage_id: row.id };
  });
}

// Андрей одобряет исключение (только gf). Сохраняем: basis, betrag, datei_hash (версию счёта).
async function ausnahmeGenehmigen(prueflauf_id, { basis, grund }, user) {
  if (!user || user.rolle !== 'gf') throw new Error('исключение утверждает только Андрей (роль gf)');
  return mit(async (cl) => {
    const lauf = (await cl.query('SELECT * FROM rechnung_prueflauf WHERE id=$1', [prueflauf_id])).rows[0];
    if (!lauf) throw new Error('прогон не найден');
    if (!grund || !String(grund).trim()) throw new Error('нужно основание');

    // Хэш текущей версии счёта (при изменении файла исключение теряет силу)
    const belegHash = lauf.beleg_id
      ? (await cl.query('SELECT datei_hash FROM beleg WHERE id=$1', [lauf.beleg_id])).rows[0]?.datei_hash
      : null;

    await cl.query(
      'INSERT INTO rechnung_ausnahme (prueflauf_id,beleg_id,bestellung_id,betrag_cent,beleg_hash,grund,basis,genehmigt_von) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [prueflauf_id, lauf.beleg_id, lauf.bestellung_id,
       lauf.betrag_cent, belegHash,
       String(grund).slice(0, 400), basis ? String(basis).slice(0, 200) : null,
       user.login]);

    // Обновить статус прогона и закрыть запрос
    await cl.query("UPDATE rechnung_prueflauf SET ergebnis='ausnahme_genehmigt' WHERE id=$1", [prueflauf_id]);
    await cl.query("UPDATE rechnung_ausnahme_anfrage SET status='genehmigt' WHERE prueflauf_id=$1 AND status='an_andrej'", [prueflauf_id]);

    return { ok: true };
  });
}

// Передача запроса Олегом Андрею
async function anfragAnAndrej(anfrage_id, login) {
  return mit(async (cl) => {
    const a = (await cl.query("SELECT * FROM rechnung_ausnahme_anfrage WHERE id=$1 AND status='an_oleg'", [anfrage_id])).rows[0];
    if (!a) throw new Error('запрос не найден или уже передан');

    const aufg = await aufgaben.systemAufgabe({
      art: 'ausnahme_genehmigung',
      titel: 'Одобрить исключение по счёту',
      text: 'Олег передал запрос на исключение. Причина: ' + (a.grund || '?'),
      ref: String(anfrage_id),
      fuer: 'gf',
    });

    await cl.query("UPDATE rechnung_ausnahme_anfrage SET status='an_andrej', aufgabe_id_andrej=$2 WHERE id=$1",
      [anfrage_id, aufg && aufg.id ? aufg.id : null]);
    return { ok: true };
  });
}

// ── Проверка: изменился ли счёт после исключения ────────────────────────────

// Вызывать при обновлении beleg.datei_hash. Если хэш изменился → исключение недействительно.
async function belegGeaendertPruefen(beleg_id) {
  return mit(async (cl) => {
    const b = (await cl.query('SELECT datei_hash FROM beleg WHERE id=$1', [beleg_id])).rows[0];
    if (!b) return { ok: true, ausnahmen_deaktiviert: 0 };
    const neuHash = b.datei_hash;

    const aus = (await cl.query(
      'SELECT id, beleg_hash, prueflauf_id FROM rechnung_ausnahme WHERE beleg_id=$1 AND aktiv', [beleg_id])).rows;

    let deaktiviert = 0;
    for (const a of aus) {
      if (a.beleg_hash && a.beleg_hash !== neuHash) {
        await cl.query('UPDATE rechnung_ausnahme SET aktiv=false WHERE id=$1', [a.id]);
        deaktiviert++;
        // Восстановить ergebnis прогона до blockiert (требуется повторная проверка)
        await cl.query("UPDATE rechnung_prueflauf SET ergebnis='blockiert' WHERE id=$1", [a.prueflauf_id]);
      }
    }
    return { ok: true, ausnahmen_deaktiviert: deaktiviert };
  });
}

// ── После оплаты: документная задача не закрывается автоматически ────────────

// Вызывать при beleg.bezahlt = true. Возвращает открытые задачи по документам.
async function nachZahlungPruefen(beleg_id) {
  return mit(async (cl) => {
    const b = (await cl.query('SELECT id, rechnung_nr, lieferant, status, bezahlt FROM beleg WHERE id=$1', [beleg_id])).rows[0];
    if (!b) throw new Error('счёт не найден');

    const dokStatus = String(b.status || '');
    if (dokStatus === 'verbucht' || dokStatus === 'geprueft') {
      return { ok: true, hinweis: null };
    }

    // Документная задача должна остаться открытой — проверяем, существует ли она.
    const offen = aufgaben.offeneNachArt('beleg_pruef', { ref: String(beleg_id) });
    const hint = 'Счёт ' + (b.rechnung_nr || beleg_id) + ' от ' + (b.lieferant || '?') +
      ' оплачен, но документная задача ещё открыта. Проверьте полноту и подпишите счёт.';

    if (!offen || offen.length === 0) {
      // Создать задачу, если её нет
      await aufgaben.systemAufgabe({
        art: 'beleg_pruef',
        titel: 'Документная задача после оплаты: ' + (b.lieferant || '?'),
        text: hint,
        ref: String(beleg_id),
        fuer: 'buchhaltung',
      });
    }

    return { ok: true, hinweis: hint };
  });
}

// ── Список просроченных / требующих внимания Андрея ─────────────────────────

// Возвращает счета с истекающим сроком и причиной задержки (для Андрея).
async function faelligkeitsUebersicht() {
  return mit(async (cl) => {
    const heute = new Date().toISOString().slice(0, 10);
    const dreiTage = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

    const rows = (await cl.query(
      `SELECT b.id, b.lieferant, b.rechnung_nr, b.betrag_cent, b.faellig, b.status, b.gesperrt_grund,
              p.ergebnis pruef_ergebnis, p.id pruef_id,
              (SELECT a.aktiv FROM rechnung_ausnahme a WHERE a.beleg_id=b.id AND a.aktiv LIMIT 1) ausnahme_aktiv,
              CASE WHEN b.faellig < $1 THEN 'uberfaellig'
                   WHEN b.faellig <= $2 THEN 'bald_faellig'
                   ELSE 'ok' END faellig_status
       FROM beleg b
       LEFT JOIN LATERAL (SELECT id,ergebnis FROM rechnung_prueflauf WHERE beleg_id=b.id ORDER BY angelegt DESC LIMIT 1) p ON true
       WHERE b.faellig IS NOT NULL AND NOT b.bezahlt
         AND b.status NOT IN ('dubup','kopie')
       ORDER BY b.faellig ASC, b.betrag_cent DESC
       LIMIT 100`,
      [heute, dreiTage])).rows;

    return rows.map(r => ({
      beleg_id: r.id,
      lieferant: r.lieferant,
      rechnung_nr: r.rechnung_nr,
      betrag: Number(r.betrag_cent) / 100,
      faellig: r.faellig,
      faellig_status: r.faellig_status,
      gruende: [
        r.gesperrt_grund ? 'Заблокирован: ' + r.gesperrt_grund : null,
        r.pruef_ergebnis === 'blockiert' ? 'Превышение заказа — нужно одобрение' : null,
        r.pruef_ergebnis === 'pruefen' ? 'Требует проверки' : null,
        r.status !== 'verbucht' && r.status !== 'geprueft' ? 'Счёт не проверен бухгалтером' : null,
        r.ausnahme_aktiv ? null : (r.pruef_ergebnis === 'blockiert' ? 'Нет активного исключения' : null),
      ].filter(Boolean),
    }));
  });
}

module.exports = {
  pruefung,
  pruefungsliste,
  pruefungEins,
  ausnahmeBeantragen,
  ausnahmeGenehmigen,
  anfragAnAndrej,
  belegGeaendertPruefen,
  nachZahlungPruefen,
  faelligkeitsUebersicht,
};
