#!/usr/bin/env node
/* daten-aktualisieren.js
   Обновляет снимки в ./daten/*.json из живых источников:
     • ust.json     — из mailops_prod.mail_items (Supabase)
     • geld.json    — из FinMap API (разнос по категориям)
     • zahlungen.json — из FinMap API (список платежей)

   Запуск на сервере:
     BUCH_MAILOPS_ENV=/opt/mailops/.env node /opt/buchhalter/scripts/daten-aktualisieren.js

   Или из директории /opt/buchhalter:
     BUCH_MAILOPS_ENV=/opt/mailops/.env node scripts/daten-aktualisieren.js
*/
'use strict';
const fs   = require('fs');
const path = require('path');

const MAILOPS_ENV = process.env.BUCH_MAILOPS_ENV || '/opt/mailops/.env';
const DATEN_DIR   = process.env.BUCH_DATEN || path.join(__dirname, '..', 'daten');
const FINMAP_TAGE = Number(process.env.FINMAP_TAGE || 60);

/* ---------- helpers ---------- */
function env() {
  const o = {};
  try {
    for (const z of fs.readFileSync(MAILOPS_ENV, 'utf8').split('\n')) {
      const i = z.indexOf('=');
      if (i < 1 || z.trim().startsWith('#')) continue;
      o[z.slice(0, i).trim()] = z.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* env недоступен */ }
  return o;
}

function schreib(name, data) {
  const p = path.join(DATEN_DIR, name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, p);
  console.log('[OK]', name, '—', JSON.stringify(data).length, 'байт');
}

const eur = n => Math.round(Number(n || 0) * 100) / 100;

/* ---------- Supabase / mailops_prod ---------- */
async function mitPg(fn) {
  const e = env();
  if (!e.DATABASE_URL) throw new Error('DATABASE_URL не задан в ' + MAILOPS_ENV);
  const { Client } = require('pg');
  const c = new Client({ connectionString: e.DATABASE_URL });
  await c.connect();
  try { return await fn(c); }
  finally { try { await c.end(); } catch (_) {} }
}

/* ---------- ust.json: VST из mail_items (входящие Eingangsrechnungen 2026) ---------- */
async function ustAktualisieren() {
  return mitPg(async c => {
    /* Базовая агрегация: betrag_cent с 19% MwSt (brutto * 19/119) */
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE betrag_geprueft = true)                                            AS n_geprueft,
        COUNT(*) FILTER (WHERE betrag_geprueft IS NOT TRUE)                                       AS n_ungeprueft,
        COALESCE(SUM(betrag_cent) FILTER (WHERE betrag_geprueft = true), 0)                       AS brutto_geprueft,
        COALESCE(SUM(betrag_cent) FILTER (WHERE betrag_geprueft IS NOT TRUE), 0)                  AS brutto_ungeprueft,
        COALESCE(SUM(CASE WHEN betrag_geprueft THEN ROUND(betrag_cent * 19.0 / 119) ELSE 0 END), 0) AS vst_geschaetzt,
        COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)                                          AS n_duplikat,
        COALESCE(SUM(betrag_cent) FILTER (WHERE duplicate_of IS NOT NULL), 0)                     AS brutto_duplikat
      FROM mailops_prod.mail_items
      WHERE COALESCE(richtung,'eingang') <> 'ausgang'
        AND doc_type IN ('RECHNUNG','MAHNUNG','INKASSO','GUTSCHRIFT')
        AND created_at >= '2026-01-01'
    `;
    const g = (await c.query(sql)).rows[0];

    /* Рисковые belege — расхождение суммы betrag_cent vs betrag_regex_cent */
    const risikoSql = `
      SELECT
        id::text,
        COALESCE(kontrahent, '')                  AS partner,
        COALESCE(betrag_cent, 0) / 100.0          AS brutto,
        ROUND(COALESCE(betrag_cent,0) * 19.0/119) / 100.0 AS vst,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN betrag_geprueft IS NOT TRUE THEN 'сумма не подтверждена' END,
          CASE WHEN betrag_regex_cent IS NOT NULL
                AND betrag_cent IS NOT NULL
                AND ABS(betrag_regex_cent - betrag_cent) > 10
               THEN 'сумма в документе не совпадает с извлечённой' END,
          CASE WHEN kontrahent IS NULL THEN 'контрагент не определён' END
        ], NULL) AS gruende
      FROM mailops_prod.mail_items
      WHERE COALESCE(richtung,'eingang') <> 'ausgang'
        AND doc_type = 'RECHNUNG'
        AND duplicate_of IS NULL
        AND created_at >= '2026-01-01'
        AND (betrag_geprueft IS NOT TRUE
             OR (betrag_regex_cent IS NOT NULL AND betrag_cent IS NOT NULL AND ABS(betrag_regex_cent - betrag_cent) > 10)
             OR kontrahent IS NULL)
      ORDER BY betrag_cent DESC NULLS LAST
      LIMIT 20
    `;
    let risiko = [];
    try {
      const r = await c.query(risikoSql);
      risiko = r.rows
        .filter(x => x.gruende && x.gruende.length > 0)
        .map(x => ({
          id: x.id,
          partner: x.partner,
          brutto: eur(x.brutto),
          vst: eur(x.vst),
          gruende: x.gruende
        }));
    } catch (e) {
      console.warn('[WARN] risiko запрос не удался:', e.message);
    }

    const n_mit    = Number(g.n_geprueft);
    const n_ohne   = Number(g.n_ungeprueft);
    const n_unklar = 0;
    const brutto_mit  = eur(Number(g.brutto_geprueft) / 100);
    const brutto_ohne = eur(Number(g.brutto_ungeprueft) / 100);
    const vst_mit     = eur(Number(g.vst_geschaetzt) / 100);
    const dubletten_vst = eur(
      Math.round(Number(g.brutto_duplikat) * 19 / 119) / 100
    );

    return {
      gruppen: {
        mit_ust:  { n: n_mit,    brutto: brutto_mit,   vst: vst_mit },
        ohne_ust: { n: n_ohne,   brutto: brutto_ohne,  vst: 0 },
        unklar:   { n: n_unklar, brutto: 0,             vst: 0 }
      },
      risiko,
      vst_gesamt: vst_mit,
      vst_risiko: eur(risiko.reduce((s, x) => s + x.vst, 0)),
      dubletten_vst,
      stand: new Date().toISOString()
    };
  });
}

/* ---------- FinMap API ---------- */
const FM_BASE = 'https://api.finmap.online/v2.2';

async function fm(pfad, methode = 'GET', koerper = null) {
  const k = env().FINMAP_API_KEY;
  if (!k) throw new Error('FINMAP_API_KEY не задан в ' + MAILOPS_ENV);
  const r = await fetch(FM_BASE + pfad, {
    method: methode,
    headers: { accept: 'application/json', 'Content-Type': 'application/json', apiKey: k },
    body: koerper ? JSON.stringify(koerper) : undefined
  });
  const t = await r.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch (_) { d = t; }
  if (!r.ok) throw new Error('FinMap ' + r.status + ': ' + String(t).slice(0, 200));
  return d;
}

async function finmapOperationen(tage) {
  const bis = Date.now(), von = bis - tage * 86400000;
  let alle = [], off = 0, total = 0;
  for (;;) {
    const d = await fm('/operations/list', 'POST', { startDate: von, endDate: bis, limit: 100, offset: off });
    total = Number(d.total || 0);
    const l = Array.isArray(d.list) ? d.list : [];
    alle = alle.concat(l);
    off += 100;
    if (off >= total || l.length === 0 || off > 3000) break;
    await new Promise(s => setTimeout(s, 600));
  }
  return alle;
}

/* ---------- geld.json: расходы из FinMap ---------- */
async function geldAktualisieren() {
  /* Берём только расходы (отрицательные операции = тип 'expense' или sum < 0) */
  const ops = await finmapOperationen(FINMAP_TAGE);
  const ausgaben = ops.filter(o => {
    const s = Number(o.sum || 0);
    return s < 0 || String(o.type || '').toLowerCase().includes('expense');
  });

  let gesamt = 0;
  const nach_tabelle = {};
  const nach_echt = {};

  /* Buchhalter-подтверждённые категории из buch_zuordnung */
  let bestaetigt = {};
  try {
    bestaetigt = await mitPg(async c => {
      const r = await c.query(
        `SELECT quelle_id, kategorie FROM mailops_prod.buch_zuordnung
         WHERE quelle = 'finmap' AND status = 'bestaetigt'`
      );
      const m = {};
      for (const x of r.rows) m[String(x.quelle_id)] = x.kategorie;
      return m;
    });
  } catch (e) {
    console.warn('[WARN] buch_zuordnung недоступна:', e.message);
  }

  for (const op of ausgaben) {
    const betrag = Math.abs(eur(op.sum));
    gesamt += betrag;

    const fmKat = op.categoryName || '(без категории)';
    nach_tabelle[fmKat] = eur((nach_tabelle[fmKat] || 0) + betrag);

    const echteKat = bestaetigt[String(op.id || op.operationId)] || fmKat;
    nach_echt[echteKat] = eur((nach_echt[echteKat] || 0) + betrag);
  }

  return {
    gesamt: eur(gesamt),
    tage: FINMAP_TAGE,
    nach_tabelle,
    nach_echt,
    falsch_miete: [],
    stand: new Date().toISOString()
  };
}

/* ---------- zahlungen.json: список платежей ---------- */
async function zahlungenAktualisieren() {
  const ops = await finmapOperationen(FINMAP_TAGE);
  const items = ops.map(op => ({
    id: String(op.id || op.operationId || ''),
    datum: new Date(Number(op.dateOfPayment || op.date)).toISOString().slice(0, 10),
    betrag: eur(op.sum),
    typ: op.type || '',
    partner: op.counterpartyName || '',
    kommentar: String(op.comment || '').slice(0, 200),
    konto: op.accountFromName || op.accountName || '',
    kategorie: op.categoryName || ''
  }));

  return {
    stand: new Date().toISOString(),
    zeitraum: FINMAP_TAGE + ' Tage',
    quelle: 'finmap',
    items
  };
}

/* ---------- main ---------- */
async function main() {
  console.log('Обновление daten/*.json —', new Date().toLocaleString('de-DE'));
  console.log('Дата dir:', DATEN_DIR);
  console.log('Env:    ', MAILOPS_ENV);
  console.log('FinMap: ', FINMAP_TAGE, 'дней\n');

  const tasks = [
    { name: 'ust.json',      fn: ustAktualisieren },
    { name: 'geld.json',     fn: geldAktualisieren },
    { name: 'zahlungen.json', fn: zahlungenAktualisieren },
  ];

  for (const t of tasks) {
    try {
      process.stdout.write('Обновляю ' + t.name + ' ... ');
      const d = await t.fn();
      schreib(t.name, d);
    } catch (e) {
      console.error('[ОШИБКА]', t.name, '—', e.message);
    }
  }
  console.log('\nГотово.');
}

main().catch(e => { console.error('ФАТАЛЬНО:', e.message); process.exit(1); });
