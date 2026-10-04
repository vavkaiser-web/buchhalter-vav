/* ---------------------------------------------------------------
   Дополнение №8 — начальные остатки на 01.01.2026 и правила учёта.
   Источник остатков — Steuerberater; вводит и подтверждает ответственный
   бухгалтер (Наталья), без отдельного утверждения Андрея (право процесса,
   не разрешение разработчику писать в бой). Неизвестное ≠ ноль. Уточнение
   не переписывает молча — новая версия + история. Расхождение не
   подтверждается автоматически. Погашение начального долга уменьшает
   остаток, НЕ создаёт новый расход. Настройки учёта: источник/версия/
   период/статус; неизвестное не подставляем.
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

const KATEGORIEN = {
  bank: 'Банковский счёт', kasse: 'Касса', forderung: 'Задолженность клиента',
  verbindlichkeit: 'Долг поставщику/подрядчику', anzahlung_erhalten: 'Полученный аванс',
  anzahlung_geleistet: 'Выданный аванс', sonstiges: 'Прочее',
};
const MIT_REST = new Set(['forderung', 'verbindlichkeit', 'anzahlung_erhalten', 'anzahlung_geleistet']);
const STATUS_T = { offen: 'Не проверено', auf_klaerung: 'На уточнении', bestaetigt: 'Подтверждено' };
const darfPflegen = u => monat.istVerantwortlich(u);   // Наталья или владелец

function ausgabe(r, tilg) {
  const rest = MIT_REST.has(r.kategorie) && r.betrag_cent != null
    ? Number(r.betrag_cent) - (tilg || 0) : null;
  return {
    id: r.id, kategorie: r.kategorie, kategorie_text: KATEGORIEN[r.kategorie] || r.kategorie,
    bezeichnung: r.bezeichnung, konto: r.konto || null,
    betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null,
    bekannt: r.betrag_cent != null,                     // false = не получено (не ноль)
    waehrung: r.waehrung, stichtag: r.stichtag, quelle: r.quelle || null, beleg_ref: r.beleg_ref || null,
    status: r.status, status_text: STATUS_T[r.status] || r.status, sverka_stand: r.sverka_stand || null,
    geprueft_von: r.geprueft_von || null, geprueft_am: r.geprueft_am || null, version: r.version,
    getilgt_cent: MIT_REST.has(r.kategorie) ? (tilg || 0) : null, offen_rest_cent: rest,
    notiz: r.notiz || null, angelegt: r.angelegt,
  };
}

async function tilgSumme(cl, id) {
  return Number((await cl.query('SELECT COALESCE(SUM(betrag_cent),0) s FROM anfangsbestand_tilgung WHERE bestand_id=$1', [id])).rows[0].s);
}

async function liste(filter) {
  filter = filter || {};
  return mit(async cl => {
    const w = [], a = [];
    if (filter.kategorie) { a.push(filter.kategorie); w.push('kategorie=$' + a.length); }
    if (filter.status) { a.push(filter.status); w.push('status=$' + a.length); }
    const rows = (await cl.query('SELECT * FROM anfangsbestand' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY kategorie, bezeichnung', a)).rows;
    const out = [];
    for (const r of rows) out.push(ausgabe(r, MIT_REST.has(r.kategorie) ? await tilgSumme(cl, r.id) : 0));
    return out;
  });
}

async function uebersicht() {
  return mit(async cl => {
    const rows = (await cl.query('SELECT * FROM anfangsbestand')).rows;
    const kat = {};
    for (const k of Object.keys(KATEGORIEN)) kat[k] = { kategorie: k, text: KATEGORIEN[k], anzahl: 0, bestaetigt: 0, offen: 0, klaerung: 0, unbekannt: 0, summe_cent: 0 };
    for (const r of rows) {
      const g = kat[r.kategorie]; if (!g) continue;
      g.anzahl++;
      if (r.betrag_cent == null) g.unbekannt++;
      if (r.status === 'bestaetigt') { g.bestaetigt++; g.summe_cent += Number(r.betrag_cent || 0); }
      else if (r.status === 'auf_klaerung') g.klaerung++;
      else g.offen++;
    }
    const arr = Object.values(kat);
    const vollstaendig = arr.every(g => g.anzahl === 0 || (g.offen === 0 && g.klaerung === 0 && g.unbekannt === 0));
    return { kategorien: arr, vollstaendig, unvollstaendig: !vollstaendig, stichtag: '2026-01-01' };
  });
}

async function eins(id) {
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM anfangsbestand WHERE id=$1', [Number(id)])).rows[0];
    if (!r) throw new Error('нет такого остатка');
    const ver = (await cl.query('SELECT version,betrag_cent,quelle,beleg_ref,status,autor,grund,wann FROM anfangsbestand_version WHERE bestand_id=$1 ORDER BY wann DESC', [r.id])).rows;
    const tilg = (await cl.query('SELECT id,betrag_cent,datum,quelle_ref,notiz,autor,wann FROM anfangsbestand_tilgung WHERE bestand_id=$1 ORDER BY wann', [r.id])).rows;
    return { ...ausgabe(r, tilg.reduce((s, x) => s + Number(x.betrag_cent), 0)), verlauf: ver, tilgungen: tilg };
  });
}

function parseCent(v) {
  if (v === '' || v == null) return null;
  const x = Math.round(Number(v));
  if (!Number.isFinite(x)) throw new Error('сумма не число');
  return x;
}

async function anlegen(body, user) {
  if (!darfPflegen(user)) throw new Error('вводит ответственный бухгалтер или владелец');
  const kategorie = String(body.kategorie || '');
  if (!KATEGORIEN[kategorie]) throw new Error('неизвестная категория');
  const bez = String(body.bezeichnung || '').trim();
  if (!bez) throw new Error('нужен счёт/контрагент');
  const betrag = parseCent(body.betrag_cent);
  return mit(async cl => {
    if (body.idem) {
      const alt = (await cl.query('SELECT * FROM anfangsbestand WHERE idem=$1', [String(body.idem)])).rows[0];
      if (alt) return { ok: true, duplikat: true, ...ausgabe(alt, MIT_REST.has(alt.kategorie) ? await tilgSumme(cl, alt.id) : 0) };
    }
    const r = (await cl.query(
      `INSERT INTO anfangsbestand (kategorie,bezeichnung,konto,betrag_cent,waehrung,stichtag,quelle,beleg_ref,idem,notiz)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [kategorie, bez, body.konto || null, betrag, body.waehrung || 'EUR', body.stichtag || '2026-01-01',
       body.quelle || null, body.beleg_ref || null, body.idem || null, body.notiz || null])).rows[0];
    await cl.query('INSERT INTO anfangsbestand_version (bestand_id,version,betrag_cent,quelle,beleg_ref,status,autor,grund) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, 1, betrag, r.quelle, r.beleg_ref, r.status, user.login, 'создан']);
    return { ok: true, duplikat: false, ...ausgabe(r, 0) };
  });
}

// Уточнение суммы/источника — новая версия, прежнее сохраняется; статус → требует проверки.
async function aktualisieren(body, user) {
  if (!darfPflegen(user)) throw new Error('меняет ответственный бухгалтер или владелец');
  const betrag = parseCent(body.betrag_cent);
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM anfangsbestand WHERE id=$1', [Number(body.id)])).rows[0];
    if (!r) throw new Error('нет такого остатка');
    const alt = r.betrag_cent != null ? Number(r.betrag_cent) : null;
    const upd = (await cl.query(
      'UPDATE anfangsbestand SET betrag_cent=$2, quelle=COALESCE($3,quelle), beleg_ref=COALESCE($4,beleg_ref), status=$5, version=version+1, geprueft_von=NULL, geprueft_am=NULL WHERE id=$1 RETURNING *',
      [r.id, betrag, body.quelle || null, body.beleg_ref || null, 'offen'])).rows[0];
    await cl.query('INSERT INTO anfangsbestand_version (bestand_id,version,betrag_cent,quelle,beleg_ref,status,autor,grund) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, upd.version, betrag, upd.quelle, upd.beleg_ref, 'offen', user.login, String(body.grund || 'уточнение').slice(0, 400)]);
    return { ok: true, alt_cent: alt, neu_cent: betrag, delta_cent: (alt != null && betrag != null) ? betrag - alt : null, ...ausgabe(upd, MIT_REST.has(upd.kategorie) ? await tilgSumme(cl, upd.id) : 0) };
  });
}

async function klaerung(body, user) {
  if (!darfPflegen(user)) throw new Error('только ответственный бухгалтер или владелец');
  return mit(async cl => {
    const r = (await cl.query("UPDATE anfangsbestand SET status='auf_klaerung', sverka_stand=$2 WHERE id=$1 RETURNING *", [Number(body.id), String(body.grund || 'расхождение').slice(0, 400)])).rows[0];
    if (!r) throw new Error('нет такого остатка');
    await cl.query('INSERT INTO anfangsbestand_version (bestand_id,version,betrag_cent,quelle,beleg_ref,status,autor,grund) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, r.version, r.betrag_cent, r.quelle, r.beleg_ref, 'auf_klaerung', user.login, String(body.grund || '').slice(0, 400)]);
    return { ok: true, ...ausgabe(r, MIT_REST.has(r.kategorie) ? await tilgSumme(cl, r.id) : 0) };
  });
}

// Подтверждение Натальей. Нельзя подтвердить неизвестную сумму или спорную позицию.
async function bestaetigen(body, user) {
  if (!darfPflegen(user)) throw new Error('подтверждает ответственный бухгалтер или владелец');
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM anfangsbestand WHERE id=$1', [Number(body.id)])).rows[0];
    if (!r) throw new Error('нет такого остатка');
    if (r.status === 'bestaetigt') return { ok: true, unchanged: true, ...ausgabe(r, MIT_REST.has(r.kategorie) ? await tilgSumme(cl, r.id) : 0) };
    if (r.betrag_cent == null) throw new Error('нельзя подтвердить неизвестную сумму (получите данные)');
    if (r.status === 'auf_klaerung') throw new Error('позиция на уточнении — сначала снять расхождение');
    const upd = (await cl.query("UPDATE anfangsbestand SET status='bestaetigt', geprueft_von=$2, geprueft_am=now() WHERE id=$1 RETURNING *", [r.id, user.login])).rows[0];
    await cl.query('INSERT INTO anfangsbestand_version (bestand_id,version,betrag_cent,quelle,beleg_ref,status,autor,grund) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, r.version, r.betrag_cent, r.quelle, r.beleg_ref, 'bestaetigt', user.login, 'подтверждено']);
    return { ok: true, ...ausgabe(upd, MIT_REST.has(upd.kategorie) ? await tilgSumme(cl, upd.id) : 0) };
  });
}

// Погашение начального долга/аванса оплатой 2026 — уменьшает остаток, НЕ создаёт расход.
async function tilgung(body, user) {
  if (!darfPflegen(user)) throw new Error('только ответственный бухгалтер или владелец');
  const betrag = parseCent(body.betrag_cent);
  if (!betrag || betrag <= 0) throw new Error('нужна сумма погашения');
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM anfangsbestand WHERE id=$1', [Number(body.bestand_id)])).rows[0];
    if (!r) throw new Error('нет такого остатка');
    if (!MIT_REST.has(r.kategorie)) throw new Error('погашение применимо к долгам и авансам');
    if (r.betrag_cent == null) throw new Error('остаток неизвестен — сначала получить данные');
    if (body.idem) {
      const alt = (await cl.query('SELECT id FROM anfangsbestand_tilgung WHERE idem=$1', [String(body.idem)])).rows[0];
      if (alt) return { ok: true, duplikat: true, id: alt.id };
    }
    const schon = await tilgSumme(cl, r.id);
    if (schon + betrag > Number(r.betrag_cent)) throw new Error('погашение больше остатка (осталось ' + ((Number(r.betrag_cent) - schon) / 100).toFixed(2) + ')');
    const t = (await cl.query('INSERT INTO anfangsbestand_tilgung (bestand_id,betrag_cent,datum,quelle_ref,idem,notiz,autor) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [r.id, betrag, body.datum || null, body.quelle_ref || null, body.idem || null, body.notiz || null, user.login])).rows[0];
    const rest = Number(r.betrag_cent) - (schon + betrag);
    return { ok: true, id: t.id, getilgt_cent: schon + betrag, offen_rest_cent: rest };
  });
}

/* ===== §10 настройки/правила учёта ===== */
const SCHLUESSEL = {
  kontenplan: 'План счетов', ust: 'НДС (USt)', ertrag: 'Признание доходов', aufwand: 'Признание расходов',
  steuer: 'Налоговые настройки', abschreibung: 'Амортизация', uebergang: 'Переходящие позиции/авансы', datev: 'Передача данных (DATEV)',
};
const E_STATUS_T = { unbekannt: 'Неизвестно', vorgeschlagen: 'Предложено', bestaetigt: 'Подтверждено' };

async function einstellungListe() {
  return mit(async cl => {
    const rows = (await cl.query('SELECT DISTINCT ON (schluessel) * FROM einstellung ORDER BY schluessel, version DESC')).rows;
    const map = new Map(rows.map(r => [r.schluessel, r]));
    return Object.keys(SCHLUESSEL).map(k => {
      const r = map.get(k);
      return r ? { schluessel: k, text: SCHLUESSEL[k], wert: r.wert || null, quelle: r.quelle || null, beleg_ref: r.beleg_ref || null,
        ab_datum: r.ab_datum || null, version: r.version, status: r.status, status_text: E_STATUS_T[r.status] || r.status }
        : { schluessel: k, text: SCHLUESSEL[k], wert: null, quelle: null, ab_datum: null, version: 0, status: 'unbekannt', status_text: 'Неизвестно' };
    });
  });
}

async function einstellungSetzen(body, user) {
  if (!darfPflegen(user)) throw new Error('настройку задаёт ответственный бухгалтер или владелец');
  const schluessel = String(body.schluessel || '');
  if (!SCHLUESSEL[schluessel]) throw new Error('неизвестная настройка');
  const wert = body.wert != null ? String(body.wert).slice(0, 2000) : null;
  const status = wert ? 'vorgeschlagen' : 'unbekannt';   // без значения — не подставляем, помечаем неизвестным
  return mit(async cl => {
    const max = (await cl.query('SELECT COALESCE(MAX(version),0) v FROM einstellung WHERE schluessel=$1', [schluessel])).rows[0].v;
    const ver = Number(max) + 1;
    const r = (await cl.query('INSERT INTO einstellung (schluessel,wert,quelle,beleg_ref,ab_datum,version,status,autor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [schluessel, wert, body.quelle || null, body.beleg_ref || null, body.ab_datum || null, ver, status, user.login])).rows[0];
    await cl.query('INSERT INTO einstellung_version (schluessel,version,wert,quelle,ab_datum,status,autor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [schluessel, ver, wert, r.quelle, r.ab_datum, status, user.login]);
    return { ok: true, schluessel, version: ver, status };
  });
}

async function einstellungBestaetigen(body, user) {
  if (!darfPflegen(user)) throw new Error('подтверждает ответственный бухгалтер или владелец');
  const schluessel = String(body.schluessel || '');
  return mit(async cl => {
    const r = (await cl.query('SELECT * FROM einstellung WHERE schluessel=$1 ORDER BY version DESC LIMIT 1', [schluessel])).rows[0];
    if (!r) throw new Error('настройка не задана');
    if (!r.wert) throw new Error('нельзя подтвердить пустую настройку');
    await cl.query("UPDATE einstellung SET status='bestaetigt' WHERE id=$1", [r.id]);
    await cl.query('INSERT INTO einstellung_version (schluessel,version,wert,quelle,ab_datum,status,autor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [schluessel, r.version, r.wert, r.quelle, r.ab_datum, 'bestaetigt', user.login]);
    return { ok: true, schluessel, status: 'bestaetigt' };
  });
}

module.exports = {
  KATEGORIEN, STATUS_T, SCHLUESSEL, darfPflegen,
  liste, uebersicht, eins, anlegen, aktualisieren, klaerung, bestaetigen, tilgung,
  einstellungListe, einstellungSetzen, einstellungBestaetigen, mit,
};
