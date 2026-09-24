/* stufeVon: разнос учитывает ступень KLR-Bau
---------------------------------------------------------------
   Buchhalter VAV — разнос по объектам и категориям.

   Принцип: FinMap даёт факт оплаты, но не истину о том, куда она
   пошла. Категории и теги FinMap показываются как подсказка и
   помечены как неподтверждённые — в расчёт не идут никогда.

   Система учится только на подтверждениях человека. Ни одно
   предложение не берётся из FinMap: если по контрагенту нет ни
   одного вашего решения, поле остаётся пустым.

   Дата отсечки: всё, что позже, разбирается заново и становится
   учебным материалом. Всё, что раньше — отдельный аудит, по запросу.

   Ключ FinMap и строка подключения — из /opt/mailops/.env.
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');

let Client = null;
for (const p of ['pg', '/opt/mailops/node_modules/pg']) {
  try { Client = require(p).Client; break; } catch (e) { /* ищем дальше */ }
}

const MAILOPS_ENV = process.env.BUCH_MAILOPS_ENV || '/opt/mailops/.env';
function umgebung() {
  const o = {};
  try {
    for (const zeile of fs.readFileSync(MAILOPS_ENV, 'utf8').split('\n')) {
      const i = zeile.indexOf('=');
      if (i < 1 || zeile.trim().startsWith('#')) continue;
      o[zeile.slice(0, i).trim()] = zeile.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* .env недоступен */ }
  return o;
}

const SCHEMA = 'mailops_prod.';
const eur = n => Math.round(Number(n || 0) * 100) / 100;
const tagOf = d => new Date(Number(d) || Date.now()).toISOString().slice(0, 10);

/* Ключ контрагента: сводит написания одного и того же имени.
   Юридические формы выбрасываются, слова сортируются —
   «Kaiser Andreas» и «Andreas Kaiser» дают один ключ. */
const MUELL = new Set(['sp', 'spo', 'spolka', 'spolki', 'ka', 'z', 'o', 'oo', 'zoo', 'ograniczona',
  'ograniczon', 'odpowiedzialnoscia', 'odpowiedzia', 'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug',
  'ek', 'co', 'company', 'ltd', 'sro', 'se', 'und', 'the', 'gbr', 'kgaa']);
function schluessel(name) {
  const w = String(name || '').toLowerCase()
    .replace(/[.,;:()"'`\-\/\\+&]/g, ' ')
    .replace(/[^a-zа-яёäöüß0-9 ]/g, ' ')
    .split(/\s+/).filter(x => x && !MUELL.has(x));
  return w.sort().join(' ').slice(0, 60);
}

/* ---------------- база ---------------- */

async function mitBase(fn) {
  const env = umgebung();
  if (!Client || !env.DATABASE_URL) throw new Error('база недоступна');
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  try { return await fn((sql, args) => c.query(sql, args || []).then(r => r.rows)); }
  finally { try { await c.end(); } catch (e) { /* уже закрыт */ } }
}

/* ---------------- FinMap ---------------- */

const BASIS = 'https://api.finmap.online/v2.2';
const cache = { zeit: 0, ops: null, stamm: null };

async function fm(pfad, methode = 'GET', koerper = null) {
  const k = umgebung().FINMAP_API_KEY;
  if (!k) throw new Error('FINMAP_API_KEY не задан');
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { accept: 'application/json', 'Content-Type': 'application/json', apiKey: k },
    body: koerper ? JSON.stringify(koerper) : undefined
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch (e) { d = t; }
  if (!r.ok) throw new Error('Finmap ' + r.status + ': ' + String(t).slice(0, 140));
  return d;
}

async function stammdaten() {
  if (cache.stamm && Date.now() - cache.zeit < 600000) return cache.stamm;
  const hol = async p => { try { return await fm(p); } catch (e) { return []; } };
  const arr = d => Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
  const nam = o => o.label || o.name || o.title || '';
  const [konten, projekte, tags] = await Promise.all([
    hol('/accounts?withBalances=true'), hol('/projects'), hol('/tags')
  ]);
  const s = {
    konten: arr(konten).map(o => ({ id: o.id, name: nam(o), saldo: eur(o.balance), waehrung: o.currencyId })),
    projekte: arr(projekte).map(o => ({ id: o.id, name: nam(o) })),
    tags: arr(tags).map(o => ({ id: o.id, name: nam(o) })),
    stand: new Date().toISOString()
  };
  cache.stamm = s; cache.zeit = Date.now();
  return s;
}

/** Операции за N дней. Постранично по 100 — предел FinMap. */
async function operationen(tage) {
  const t = Number(tage) || 120;
  if (cache.ops && cache.ops.tage === t && Date.now() - cache.ops.zeit < 300000) return cache.ops.liste;
  const bis = Date.now(), von = bis - t * 86400000;
  let alle = [], off = 0, total = 0;
  for (;;) {
    const d = await fm('/operations/list', 'POST', { startDate: von, endDate: bis, limit: 100, offset: off });
    total = Number(d.total || 0);
    const l = Array.isArray(d.list) ? d.list : [];
    alle = alle.concat(l);
    off += 100;
    if (off >= total || l.length === 0 || off > 6000) break;
    await new Promise(s => setTimeout(s, 550));
  }
  const stamm = await stammdaten();
  const nameVon = (liste, ids) => (ids || []).filter(x => x && x !== 'empty')
    .map(id => (liste.find(o => o.id === id) || {}).name || '').filter(Boolean);
  const liste = alle.map(o => {
    const partner = o.counterpartyName || '';
    return {
      id: o.id || o.operationId,
      datum: tagOf(o.dateOfPayment || o.date),
      typ: o.type,
      betrag: eur(o.sum),
      konto: o.accountFromName || o.accountName || '',
      partner,
      schluessel: schluessel(partner || o.comment),
      kommentar: String(o.comment || '').slice(0, 300),
      fm_kategorie: o.categoryName || '',
      fm_tag: nameVon(stamm.tags, o.tagIds).join(', '),
      fm_projekt: nameVon(stamm.projekte, o.projectIds).join(', ')
    };
  });
  cache.ops = { tage: t, zeit: Date.now(), liste };
  return liste;
}

/* ---------------- справочники ---------------- */

/**
 * Объекты, заведённые в почтовом приложении, подтягиваются сами.
 * Номер берём тот, что дали там: один объект — один номер во всех программах.
 * Уже заведённое не трогаем: правки в бухгалтере важнее переноса.
 */
async function objekteSync(q) {
  const roh = await q(
    'SELECT ref, objektnummer, bez, client, address, aktiv FROM ' + SCHEMA + 'objekt_ref');
  let neu = 0;
  for (const o of roh) {
    const nr = String(o.objektnummer || '').trim();
    if (!nr) continue;                                  // без номера в справочник не берём
    if (/^Офис/i.test(String(o.bez || ''))) continue;   // офис уже есть под O-0100
    const da = await q('SELECT nr FROM ' + SCHEMA + 'buch_objekt WHERE nr = $1', [nr]);
    if (da.length) continue;
    await q('INSERT INTO ' + SCHEMA + 'buch_objekt (nr, bez, kunde, adresse, status, quelle, von)'
      + ' VALUES ($1,$2,$3,$4,$5, ' + String.fromCharCode(39) + 'postzentrale' + String.fromCharCode(39) + ', ' + String.fromCharCode(39) + 'system' + String.fromCharCode(39) + ')',
      [nr, o.bez || nr, o.client || '', o.address || '', o.aktiv === false ? 'ruht' : 'aktiv']);
    neu++;
  }
  return neu;
}

async function objekte() {
  return mitBase(async q => {
    try { await objekteSync(q); } catch (e) { /* перенос не удался — отдаём что есть */ }
    return q('SELECT nr, bez, kunde, adresse, firma, status, quelle FROM '
      + SCHEMA + 'buch_objekt ORDER BY (status <> $1), nr', ['aktiv']);
  });
}
async function kategorien() {
  return mitBase(q => q('SELECT kz, bez, art, stufe FROM ' + SCHEMA
    + 'buch_kategorie WHERE aktiv ORDER BY sortier, bez'));
}
async function personen() {
  return mitBase(q => q('SELECT id, name, email, rolle, aktiv FROM ' + SCHEMA
    + 'buch_person ORDER BY (aktiv IS NOT TRUE), name'));
}
async function einstellung(k, v) {
  return mitBase(async q => {
    if (v === undefined) {
      const r = await q('SELECT v FROM ' + SCHEMA + 'buch_einstellung WHERE k = $1', [k]);
      return r.length ? r[0].v : null;
    }
    await q('INSERT INTO ' + SCHEMA + 'buch_einstellung (k,v,wann) VALUES ($1,$2,now())'
      + ' ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, wann = now()', [k, String(v)]);
    return String(v);
  });
}

/* ---------------- очередь разноса ---------------- */

/**
 * tage   — глубина выборки из FinMap
 * modus  — 'neu' (с даты отсечки, обязательный разбор) или 'audit' (до отсечки)
 */
async function warteschlange(tage, modus, monat) {
  const ops = await operationen(tage);
  const daten = await mitBase(async q => ({
    zuord: await q('SELECT quelle_id, objekt, kategorie, grund, wer, wann, verteilung FROM ' + SCHEMA
      + 'buch_zuordnung WHERE quelle = $1', ['finmap']),
    lern: await q('SELECT schluessel, feld, wert, treffer FROM ' + SCHEMA + 'buch_lernen'),
    teile: await q('SELECT id, quelle_id, objekt, kategorie, betrag, verteilung, grund, wer FROM '
      + SCHEMA + 'buch_teil WHERE quelle = $1 ORDER BY id', ['finmap']),
    stich: await q('SELECT v FROM ' + SCHEMA + 'buch_einstellung WHERE k = $1', ['stichtag']),
    anfr: await q('SELECT quelle_id, email, gesendet, antwort_text, status FROM ' + SCHEMA
      + 'buch_anfrage WHERE quelle = $1 AND status <> $2', ['finmap', 'erledigt'])
  }));
  // оригиналы из отсканированных писем: к платежу подбираем счета того же контрагента
  const scans = await mitBase(q => q('SELECT id, kontrahent, doc_nr, betrag_cent, rechnungsdatum, received_at, drive_file_ids FROM '
    + SCHEMA + 'mail_items WHERE drive_file_ids IS NOT NULL AND coalesce(array_length(drive_file_ids,1),0) > 0'));
  const belIdx = scans.map(s2 => ({
    key: schluessel(s2.kontrahent), eur: eur((s2.betrag_cent || 0) / 100),
    mail_id: s2.id, drive_id: (s2.drive_file_ids || [])[0] || '',
    kontrahent: s2.kontrahent || '', doc_nr: s2.doc_nr || '',
    datum: s2.rechnungsdatum ? new Date(s2.rechnungsdatum).toISOString().slice(0, 10)
         : (s2.received_at ? new Date(s2.received_at).toISOString().slice(0, 10) : '')
  })).filter(x => x.drive_id && x.key);
  function belegeFinden(zeile) {
    const betrag = Math.abs(zeile.betrag);
    const rang = s2 => (betrag > 0 && Math.abs(s2.eur - betrag) < 0.5) ? 3
                     : (betrag > 0 && Math.abs(s2.eur - betrag) / betrag < 0.03) ? 2 : 1;
    return belIdx.filter(s2 => s2.key === zeile.schluessel)
      .map(s2 => ({ mail_id: s2.mail_id, drive_id: s2.drive_id, kontrahent: s2.kontrahent,
        doc_nr: s2.doc_nr, betrag: s2.eur, datum: s2.datum, r: rang(s2) }))
      .sort((a, b) => b.r - a.r || String(b.datum).localeCompare(String(a.datum)))
      .slice(0, 6)
      .map(s2 => ({ mail_id: s2.mail_id, drive_id: s2.drive_id, kontrahent: s2.kontrahent,
        doc_nr: s2.doc_nr, betrag: s2.betrag, datum: s2.datum,
        treffer: s2.r === 3 ? 'genau' : s2.r === 2 ? 'nah' : 'name' }));
  }
  const stichtag = daten.stich.length ? daten.stich[0].v : '2026-09-01';
  const zMap = new Map(daten.zuord.map(r => [r.quelle_id, r]));
  const tMap = new Map();
  for (const t of daten.teile) {
    const l = tMap.get(t.quelle_id) || [];
    l.push({ id: t.id, objekt: t.objekt || '', kategorie: t.kategorie || '',
             betrag: eur(t.betrag), verteilung: t.verteilung || 'direkt',
             grund: t.grund || '', wer: t.wer || '' });
    tMap.set(t.quelle_id, l);
  }
  const aMap = new Map(daten.anfr.map(r => [r.quelle_id, r]));

  // выученное: по ключу контрагента берём вариант с наибольшим числом подтверждений
  const best = new Map();
  for (const r of daten.lern) {
    const k = r.schluessel + '|' + r.feld;
    const v = best.get(k);
    if (!v || r.treffer > v.treffer) best.set(k, { wert: r.wert, treffer: r.treffer });
  }
  const gelernt = (s, feld) => best.get(s + '|' + feld) || null;

  const neu = [], fertig = [], alt = [];
  for (const o of ops) {
    const z = zMap.get(o.id);
    const zeile = Object.assign({}, o, {
      objekt: z ? (z.objekt || '') : '',
      kategorie: z ? (z.kategorie || '') : '',
      grund: z ? (z.grund || '') : '',
      wer: z ? (z.wer || '') : '',
      wann: z && z.wann ? new Date(z.wann).toISOString().slice(0, 10) : '',
      verteilung: z ? (z.verteilung || 'direkt') : 'direkt',
      lern_objekt: gelernt(o.schluessel, 'objekt'),
      lern_kategorie: gelernt(o.schluessel, 'kategorie'),
      anfrage: aMap.get(o.id) || null,
      teile: tMap.get(o.id) || [],
      verteilt: eur((tMap.get(o.id) || []).reduce((s2, t) => s2 + t.betrag, 0))
    });
    zeile.rest = eur(Math.abs(zeile.betrag) - zeile.verteilt);
    zeile.belege = belegeFinden(zeile);
    // прямые затраты не закрыты без объекта; общие закрываются категорией
    // платёж закрыт либо целиком, либо когда части свели остаток к нулю
    const ganz = !!(zeile.kategorie && (zeile.verteilung !== 'direkt' || zeile.objekt));
    const geteilt = zeile.teile.length > 0 && Math.abs(zeile.rest) < 0.01;
    const erledigt = ganz || geteilt;
    if (erledigt) fertig.push(zeile);
    else if (monat ? o.datum.slice(0, 7) === monat : o.datum >= stichtag) neu.push(zeile);
    else alt.push(zeile);
  }
  neu.sort((a, b) => b.betrag - a.betrag);
  alt.sort((a, b) => b.betrag - a.betrag);
  fertig.sort((a, b) => (a.datum < b.datum ? 1 : -1));
  const sum = a => eur(a.reduce((s, x) => s + (x.typ === 'expense' ? x.betrag : 0), 0));

  // сводка по месяцам: сколько осталось разобрать и на какую сумму расхода
  const mon = new Map();
  for (const o of ops) {
    const k = String(o.datum).slice(0, 7);
    if (!k) continue;
    const v = mon.get(k) || { monat: k, ges: 0, offen: 0, eur: 0 };
    v.ges++;
    if (!zMap.has(o.id)) { v.offen++; if (o.typ === 'expense') v.eur = eur(v.eur + o.betrag); }
    mon.set(k, v);
  }
  const monate = [...mon.values()].sort((a, b) => a.monat < b.monat ? 1 : -1);

  const zahlen = {
    stichtag, tage: Number(tage) || 120,
    neu_stk: neu.length, neu_eur: sum(neu),
    alt_stk: alt.length, alt_eur: sum(alt),
    fertig_stk: fertig.length, fertig_eur: sum(fertig),
    gelernt: best.size, monat: monat || '', stand: new Date().toISOString()
  };
  return { zahlen, monate, offen: modus === 'audit' ? alt : neu, erledigt: fertig,
           modus: modus === 'audit' ? 'audit' : 'neu' };
}

/* ---------------- подтверждение ---------------- */

/**
 * Решение человека. Пишется в разнос и — только отсюда — в обучение.
 * Пустые поля не стирают уже подтверждённое, для снятия есть loeschen.
 */
async function setze(opId, feld, wer) {
  const id = String(opId || '').trim();
  if (!id) throw new Error('нет операции');
  let objekt = String(feld.objekt || '').trim();
  const kategorie = String(feld.kategorie || '').trim();
  const grund = String(feld.grund || '').slice(0, 300);
  const key = String(feld.schluessel || '').trim();
  return mitBase(async q => {
    // ступень решает, нужен ли объект вообще
    let verteilung = 'direkt';
    if (kategorie) {
      const st = await q('SELECT stufe FROM ' + SCHEMA + 'buch_kategorie WHERE kz = $1', [kategorie]);
      const stufe = st.length ? (st[0].stufe || '') : '';
      if (stufe === 'BGK') verteilung = 'schluessel';
      else if (stufe === 'AGK') verteilung = 'firma';
      else if (stufe && stufe !== 'EKT') verteilung = 'firma';
    }
    if (verteilung === 'firma' && !objekt) objekt = 'O-0100';
    if (objekt) {
      const d = await q('SELECT nr FROM ' + SCHEMA + 'buch_objekt WHERE nr = $1', [objekt]);
      if (!d.length) throw new Error('объекта ' + objekt + ' нет в справочнике');
    }
    if (kategorie) {
      const d = await q('SELECT kz FROM ' + SCHEMA + 'buch_kategorie WHERE kz = $1', [kategorie]);
      if (!d.length) throw new Error('категории ' + kategorie + ' нет в справочнике');
    }
    const alt = await q('SELECT objekt, kategorie, verteilung FROM ' + SCHEMA
      + 'buch_zuordnung WHERE quelle = $1 AND quelle_id = $2', ['finmap', id]);
    const altVert = alt.length ? (alt[0].verteilung || 'direkt') : verteilung;
    const erbe = altVert === verteilung ? (alt.length ? alt[0].objekt : '') : '';
    const o = objekt || erbe || '';
    const k = kategorie || (alt.length ? alt[0].kategorie : '') || '';
    await q('INSERT INTO ' + SCHEMA + 'buch_zuordnung (quelle, quelle_id, objekt, kategorie, grund, wer, wann, status, verteilung)'
      + ' VALUES ($1,$2,$3,$4,$5,$6, now(), $7, $8)'
      + ' ON CONFLICT (quelle, quelle_id) DO UPDATE SET objekt = EXCLUDED.objekt,'
      + ' kategorie = EXCLUDED.kategorie, grund = EXCLUDED.grund, wer = EXCLUDED.wer,'
      + ' wann = now(), status = EXCLUDED.status, verteilung = EXCLUDED.verteilung',
      ['finmap', id, o, k, grund, String(wer || ''), 'bestaetigt', verteilung]);
    // обучение: только на подтверждениях, и только когда есть по кому учиться
    if (key) {
      for (const [f, v] of [['objekt', objekt], ['kategorie', kategorie]]) {
        if (!v) continue;
        await q('INSERT INTO ' + SCHEMA + 'buch_lernen (schluessel, feld, wert, treffer, letzte, wer)'
          + ' VALUES ($1,$2,$3,1, now(), $4)'
          + ' ON CONFLICT (schluessel, feld, wert) DO UPDATE SET treffer = ' + SCHEMA + 'buch_lernen.treffer + 1,'
          + ' letzte = now(), wer = EXCLUDED.wer', [key, f, v, String(wer || '')]);
      }
    }
    if (k && (verteilung !== 'direkt' || o)) {
      await q('UPDATE ' + SCHEMA + 'buch_anfrage SET status = $1, objekt = $2'
        + ' WHERE quelle = $3 AND quelle_id = $4 AND status <> $1', ['erledigt', o, 'finmap', id]);
    }
    return { ok: true, objekt: o, kategorie: k, verteilung,
             fertig: !!(k && (verteilung !== 'direkt' || o)) };
  });
}

async function loeschen(opId) {
  const id = String(opId || '').trim();
  return mitBase(async q => {
    await q('DELETE FROM ' + SCHEMA + 'buch_zuordnung WHERE quelle = $1 AND quelle_id = $2', ['finmap', id]);
    return { ok: true };
  });
}

/**
 * Новый объект. Номер даётся из своей серии O-01xx, чтобы объекты,
 * заведённые в работе, отличались от перенесённых из планов.
 */
async function objektAnlegen(d, wer) {
  const bez = String(d.bez || '').trim();
  if (bez.length < 3) throw new Error('название объекта слишком короткое');
  return mitBase(async q => {
    let nr = String(d.nr || '').trim().toUpperCase();
    if (nr) {
      const da = await q('SELECT nr FROM ' + SCHEMA + 'buch_objekt WHERE nr = $1', [nr]);
      if (da.length) throw new Error('объект с номером ' + nr + ' уже есть');
    } else {
      const r = await q('SELECT nr FROM ' + SCHEMA + 'buch_objekt WHERE nr ~ ' + "'^O-[0-9]{4}$'" + ' ORDER BY nr DESC LIMIT 1');
      const letzte = r.length ? parseInt(r[0].nr.slice(2), 10) : 100;
      nr = 'O-' + String(Math.max(letzte, 100) + 1).padStart(4, '0');
    }
    await q('INSERT INTO ' + SCHEMA + 'buch_objekt (nr, bez, kunde, adresse, firma, status, quelle, von)'
      + " VALUES ($1,$2,$3,$4,$5,'aktiv','hand',$6)",
      [nr, bez, String(d.kunde || '').trim(), String(d.adresse || '').trim(),
       String(d.firma || '').trim(), String(wer || '')]);
    return { ok: true, nr, bez };
  });
}


/**
 * Часть платежа на объект. Остаток считается от суммы операции:
 * пока он не ноль, платёж остаётся в очереди.
 */
async function teilSetzen(opId, feld, wer) {
  const id = String(opId || '').trim();
  if (!id) throw new Error('нет операции');
  const betrag = Math.round(Number(String(feld.betrag || '').replace(',', '.')) * 100) / 100;
  if (!(betrag > 0)) throw new Error('нужна сумма больше нуля');
  const objekt = String(feld.objekt || '').trim();
  const kategorie = String(feld.kategorie || '').trim();
  if (!kategorie) throw new Error('нужна категория');
  return mitBase(async q => {
    let verteilung = 'direkt';
    const st = await q('SELECT stufe FROM ' + SCHEMA + 'buch_kategorie WHERE kz = $1', [kategorie]);
    if (!st.length) throw new Error('категории ' + kategorie + ' нет в справочнике');
    const stufe = st[0].stufe || '';
    if (stufe === 'BGK') verteilung = 'schluessel';
    else if (stufe && stufe !== 'EKT') verteilung = 'firma';
    let ziel = objekt;
    if (verteilung === 'firma' && !ziel) ziel = 'O-0100';
    if (verteilung === 'direkt' && !ziel) throw new Error('прямые затраты нужно отнести на объект');
    if (ziel) {
      const d = await q('SELECT nr FROM ' + SCHEMA + 'buch_objekt WHERE nr = $1', [ziel]);
      if (!d.length) throw new Error('объекта ' + ziel + ' нет в справочнике');
    }
    const vorhanden = await q('SELECT objekt, kategorie, betrag FROM ' + SCHEMA
      + 'buch_teil WHERE quelle = $1 AND quelle_id = $2', ['finmap', id]);
    const schon = vorhanden.reduce((a, r) => a + Number(r.betrag), 0);
    const ops = await operationen(400);
    const op = ops.find(o => String(o.id) === id);
    const gesamt = op ? Math.abs(Number(op.betrag)) : null;
    if (gesamt != null && Math.round((schon + betrag) * 100) / 100 > gesamt + 0.01)
      throw new Error('сумма частей превысит платёж: уже разнесено ' + schon.toFixed(2)
        + ' + ' + betrag.toFixed(2) + ' больше ' + gesamt.toFixed(2) + ' €');
    if (vorhanden.some(r => r.objekt === ziel && r.kategorie === kategorie
        && Math.abs(Number(r.betrag) - betrag) < 0.005))
      throw new Error('такая часть уже есть (тот же объект, категория и сумма) — похоже на двойное нажатие');

    await q('INSERT INTO ' + SCHEMA + 'buch_teil (quelle, quelle_id, objekt, kategorie, betrag, verteilung, grund, wer)'
      + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      ['finmap', id, ziel, kategorie, betrag, verteilung,
       String(feld.grund || '').slice(0, 300), String(wer || '')]);
    // учим только категорию: объект в частях у каждой свой
    const key = String(feld.schluessel || '').trim();
    if (key) {
      await q('INSERT INTO ' + SCHEMA + 'buch_lernen (schluessel, feld, wert, treffer, letzte, wer)'
        + ' VALUES ($1, $2, $3, 1, now(), $4)'
        + ' ON CONFLICT (schluessel, feld, wert) DO UPDATE SET treffer = ' + SCHEMA + 'buch_lernen.treffer + 1,'
        + ' letzte = now(), wer = EXCLUDED.wer', [key, 'kategorie', kategorie, String(wer || '')]);
    }
    const alle = await q('SELECT betrag FROM ' + SCHEMA + 'buch_teil WHERE quelle = $1 AND quelle_id = $2', ['finmap', id]);
    const verteilt = alle.reduce((a, r) => a + Number(r.betrag), 0);
    return { ok: true, verteilt: Math.round(verteilt * 100) / 100 };
  });
}

async function teilLoeschen(teilId) {
  const i = Number(teilId);
  if (!(i > 0)) throw new Error('нет части');
  return mitBase(async q => {
    await q('DELETE FROM ' + SCHEMA + 'buch_teil WHERE id = $1', [i]);
    return { ok: true };
  });
}

module.exports = { teilSetzen, teilLoeschen, objektAnlegen, objekteSync, stammdaten, operationen, objekte, kategorien, personen, einstellung,
                   warteschlange, setze, loeschen, mitBase, schluessel, SCHEMA };
