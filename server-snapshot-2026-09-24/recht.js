/* ---------------------------------------------------------------
   Buchhalter VAV — правовой контур.

   Что делает: находит в письмах даты со сроками и складывает их в
   один календарь. Что НЕ делает: правовую оценку. Каждый срок
   показан вместе с выдержкой из письма, чтобы человек проверил
   первоисточник, а не поверил машине.

   Срок берётся только тогда, когда дата стоит в тексте письма
   явно и не раньше даты самого письма. Ничего не досчитывается
   по умолчанию: если срока в письме нет, поле пустое.
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');

let Client = null;
for (const p of ['pg', '/opt/mailops/node_modules/pg']) {
  try { Client = require(p).Client; break; } catch (e) { /* ищем дальше */ }
}
const MAILOPS_ENV = '/opt/mailops/.env';
function umgebung() {
  const o = {};
  try {
    for (const z of fs.readFileSync(MAILOPS_ENV, 'utf8').split('\n')) {
      const i = z.indexOf('=');
      if (i < 1 || z.trim().startsWith('#')) continue;
      o[z.slice(0, i).trim()] = z.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* нет .env */ }
  return o;
}
const SCHEMA = 'mailops_prod.';
async function mitBase(fn) {
  const env = umgebung();
  if (!Client || !env.DATABASE_URL) throw new Error('база недоступна');
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  try { return await fn((sql, a) => c.query(sql, a || []).then(r => r.rows)); }
  finally { try { await c.end(); } catch (e) { /* уже закрыт */ } }
}

const iso = d => {
  if (!d) return '';
  const t = d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000) : new Date(d);
  return isNaN(t) ? '' : t.toISOString().slice(0, 10);
};
const heute = () => new Date().toISOString().slice(0, 10);
const tageBis = d => Math.round((new Date(d + 'T00:00:00Z') - new Date(heute() + 'T00:00:00Z')) / 864e5);

/* ---------- распознавание сроков ----------

   Ключевые слова определяют вид срока и его вес. Вес нужен только
   для сортировки внимания, а не для правовой оценки. */
const ARTEN = [
  { art: 'Gerichtstermin',      gewicht: 100, re: /gütetermin|kammertermin|verhandlungstermin|ladung|arbeitsgericht|amtsgericht|landgericht/i },
  { art: 'Zwangsvollstreckung', gewicht: 95,  re: /vollstreckung|pfändung|pfaendung|zwangsmaßnahme|zwangsmassnahme|vollstreckungsbescheid|vollstreckungsankündigung/i },
  { art: 'Einspruch / Widerspruch', gewicht: 90, re: /einspruch|widerspruch|rechtsbehelf|rechtsmittel/i },
  { art: 'Behördliche Frist',   gewicht: 85,  re: /behördlich|behoerdlich|finanzamt|zoll|auskunftsersuchen|aufforderung zur|ordnungsgeld|bußgeld|busgeld/i },
  { art: 'Vertragsfrist',       gewicht: 80,  re: /vertragsstrafe|vertragsgerecht|abnahme|behinderung|mängelrüge|maengelruege|nachbesserung|kündigung|kuendigung/i },
  { art: 'Zahlungsfrist',       gewicht: 60,  re: /zahlungsfrist|zahlung bis|letzte frist|mahnung|inkasso|ratenzahlung/i },
  { art: 'Unterlagen / Auskunft', gewicht: 50, re: /unterlagen|nachweis|bescheinigung|formular|rückantwort|rueckantwort|namensliste/i },
  { art: 'Frist',               gewicht: 30,  re: /frist|bis zum|spätestens|spaetestens/i },
];

const D_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[^0-9]{0,12}?(\d{1,2}):(\d{2}))?/g;

/** Все даты из текста, которые не раньше даты письма и не дальше года вперёд. */
function datenAus(text, ab) {
  const out = [];
  if (!text) return out;
  let m;
  D_RE.lastIndex = 0;
  while ((m = D_RE.exec(text)) !== null) {
    const t = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0'), j = m[3];
    const d = j + '-' + mo + '-' + t;
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)) continue;
    if (ab && d < ab) continue;                       // ссылка на прошлое письмо — не срок
    if (tageBis(d) > 400) continue;                   // явно не срок
    const kontext = text.slice(Math.max(0, m.index - 90), m.index + 40);
    out.push({ datum: d, uhrzeit: m[4] ? m[4].padStart(2, '0') + ':' + m[5] : '', kontext: kontext.trim() });
  }
  return out;
}

function artVon(text) {
  for (const a of ARTEN) if (a.re.test(text || '')) return a;
  return { art: 'Frist', gewicht: 20 };
}

/* ---------- сборка календаря ---------- */

const RELEVANT = "(needs_lawyer OR risk_level IN ('high','medium') OR doc_type IN ('BEHOERDE','BEHORDE','INKASSO','MAHNUNG','VERTRAG','PERSONAL'))";

async function fristen(tage) {
  const t = Math.min(400, Math.max(30, Number(tage) || 180));
  return mitBase(async q => {
    const briefe = await q(
      `SELECT id, received_at, doc_type, risk_level, needs_lawyer,
              COALESCE(kontrahent, from_name, from_addr, '') AS wer,
              COALESCE(subject,'') AS betreff,
              COALESCE(comment_recht,'') AS recht,
              COALESCE(antwort_frist::text,'') AS frist_feld,
              COALESCE(frist_art,'') AS frist_art,
              COALESCE(firma,'') AS firma,
              drive_file_ids
         FROM ${SCHEMA}mail_items
        WHERE ${RELEVANT} AND received_at >= now() - ($1 || ' days')::interval
        ORDER BY received_at DESC`, [String(t)]);

    const ent = await q(`SELECT schluessel, status, notiz, wer, wann FROM ${SCHEMA}buch_frist_status`);
    const eMap = new Map(ent.map(r => [r.schluessel, r]));

    const liste = [];
    const gesehen = new Set();
    for (const b of briefe) {
      const empfangen = iso(b.received_at);
      const quelle = [b.recht, b.betreff].filter(Boolean).join(' \n ');
      const a = artVon(quelle);
      const kandidaten = datenAus(b.recht, empfangen)
        .concat(b.frist_feld ? [{ datum: iso(b.frist_feld), uhrzeit: '', kontext: b.frist_art }] : []);
      for (const k of kandidaten) {
        if (!k.datum) continue;
        const schluessel = b.id + '|' + k.datum + '|' + a.art;
        if (gesehen.has(schluessel)) continue;
        gesehen.add(schluessel);
        const e = eMap.get(schluessel);
        liste.push({
          schluessel, mail_id: b.id, datum: k.datum, uhrzeit: k.uhrzeit,
          art: a.art, gewicht: a.gewicht + (b.needs_lawyer ? 10 : 0),
          wer: b.wer, betreff: b.betreff, typ: b.doc_type, risiko: b.risk_level,
          anwalt: b.needs_lawyer === true, firma: b.firma,
          empfangen, hinweis: String(b.recht || '').slice(0, 400),
          kontext: k.kontext,
          drive: Array.isArray(b.drive_file_ids) && b.drive_file_ids.length ? b.drive_file_ids[b.drive_file_ids.length - 1] : '',
          status: e ? e.status : 'offen', notiz: e ? (e.notiz || '') : '', bearbeiter: e ? (e.wer || '') : '',
          tage: tageBis(k.datum)
        });
      }
    }
    // одно письмо приходит на несколько ящиков — срок при этом один
    const gruppiert = new Map();
    for (const x of liste) {
      const wn = String(x.wer || '').toLowerCase().replace(/[^a-zа-яё0-9]/g, '').slice(0, 24);
      const g = 'g|' + x.datum + '|' + x.uhrzeit + '|' + x.art + '|' + wn;
      const da = gruppiert.get(g);
      if (da) { da.kopien++; if (x.mail_id && da.mail_ids.indexOf(x.mail_id) < 0) da.mail_ids.push(x.mail_id); continue; }
      const e2 = eMap.get(g);
      gruppiert.set(g, Object.assign({}, x, { schluessel: g, kopien: 1, mail_ids: [x.mail_id],
        status: e2 ? e2.status : 'offen', notiz: e2 ? (e2.notiz || '') : '', bearbeiter: e2 ? (e2.wer || '') : '' }));
    }
    const liste2 = [...gruppiert.values()];
    liste.length = 0;
    for (const x of liste2) liste.push(x);
    liste.sort((x, y) => x.datum === y.datum ? y.gewicht - x.gewicht : (x.datum < y.datum ? -1 : 1));

    const offen = liste.filter(x => x.status === 'offen');
    const zahlen = {
      briefe: briefe.length,
      anwalt: briefe.filter(b => b.needs_lawyer).length,
      hoch: briefe.filter(b => b.risk_level === 'high').length,
      fristen: liste.length,
      ueberfaellig: offen.filter(x => x.tage < 0).length,
      diese_woche: offen.filter(x => x.tage >= 0 && x.tage <= 7).length,
      erledigt: liste.filter(x => x.status === 'erledigt').length,
      tage: t, stand: new Date().toISOString(), heute: heute()
    };
    return { fristen: liste, zahlen };
  });
}

/* ---------- письма к юристу, ещё не разобранные ---------- */

async function anwaltsliste(tage) {
  const t = Math.min(400, Math.max(30, Number(tage) || 180));
  return mitBase(async q => {
    const r = await q(
      `SELECT id, received_at, doc_type, risk_level,
              COALESCE(kontrahent, from_name, from_addr,'') AS wer,
              COALESCE(subject,'') AS betreff,
              COALESCE(comment_recht,'') AS recht, drive_file_ids
         FROM ${SCHEMA}mail_items
        WHERE needs_lawyer AND received_at >= now() - ($1 || ' days')::interval
        ORDER BY received_at DESC`, [String(t)]);
    const ent = await q(`SELECT schluessel, status, notiz, wer FROM ${SCHEMA}buch_frist_status WHERE schluessel LIKE 'brief|%'`);
    const eMap = new Map(ent.map(x => [x.schluessel, x]));
    return r.map(b => {
      const s = 'brief|' + b.id;
      const e = eMap.get(s);
      return { schluessel: s, mail_id: b.id, empfangen: iso(b.received_at), typ: b.doc_type,
        risiko: b.risk_level, wer: b.wer, betreff: b.betreff, hinweis: String(b.recht || '').slice(0, 400),
        drive: Array.isArray(b.drive_file_ids) && b.drive_file_ids.length ? b.drive_file_ids[b.drive_file_ids.length - 1] : '',
        status: e ? e.status : 'offen', notiz: e ? (e.notiz || '') : '', bearbeiter: e ? (e.wer || '') : '' };
    });
  });
}

/** Решение человека по сроку или письму. */
async function setzeStatus(schluessel, status, notiz, wer) {
  const s = String(schluessel || '').trim();
  if (!s) throw new Error('нет ключа');
  if (!['offen', 'erledigt', 'verworfen', 'anwalt'].includes(status)) throw new Error('неизвестный статус');
  return mitBase(async q => {
    await q(`INSERT INTO ${SCHEMA}buch_frist_status (schluessel, status, notiz, wer, wann)
             VALUES ($1,$2,$3,$4, now())
             ON CONFLICT (schluessel) DO UPDATE SET status = EXCLUDED.status,
               notiz = EXCLUDED.notiz, wer = EXCLUDED.wer, wann = now()`,
      [s, status, String(notiz || '').slice(0, 400), String(wer || '')]);
    return { ok: true, schluessel: s, status };
  });
}

module.exports = { fristen, anwaltsliste, setzeStatus, mitBase, SCHEMA };
