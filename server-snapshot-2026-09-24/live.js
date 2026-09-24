/* ---------------------------------------------------------------
   Buchhalter VAV — живые данные из базы MailOps.

   Что здесь живое, а что снимок:
     живое  — belege (кредиторка), partner (контрагенты), post (почта)
     снимок — всё, что собрано из таблиц Google Sheets: дебиторка,
              маржа, ликвидность, нумерация, налоги, деньги, объекты.
   Снимок никогда не подменяется молча: если база недоступна,
   отдаётся файл из daten/ со своей датой, и это видно в приложении.

   Строка подключения не хранится здесь — читается из /opt/mailops/.env,
   чтобы секрет лежал в одном месте и с правами MailOps.
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');

let Client = null;
for (const p of ['pg', '/opt/mailops/node_modules/pg']) {
  try { Client = require(p).Client; break; } catch (e) { /* ищем дальше */ }
}

const MAILOPS_ENV = '/opt/mailops/.env';
function umgebung() {
  const o = {};
  try {
    for (const zeile of fs.readFileSync(MAILOPS_ENV, 'utf8').split('\n')) {
      const i = zeile.indexOf('=');
      if (i < 1 || zeile.trim().startsWith('#')) continue;
      o[zeile.slice(0, i).trim()] = zeile.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* .env недоступен — работаем на снимках */ }
  return o;
}

const HEUTE = () => new Date().toISOString().slice(0, 10);
const tage = (von, bis) => Math.round((new Date(bis) - new Date(von)) / 864e5);
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const eur = c => Math.round((Number(c || 0) / 100) * 100) / 100;
// Postgres отдаёт даты объектами Date — приводим к ГГГГ-ММ-ДД без сдвига часового пояса.
const datum = v => { if (!v) return '';
  if (v instanceof Date) { const t = new Date(v.getTime() - v.getTimezoneOffset()*60000); return t.toISOString().slice(0,10); }
  const s = String(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : ''; };

/* ---------- правила: тот же каталог, что в прогоне на снимке ---------- */
const ZUSATZ = {
  'R-BEL-08': { phase: 2, schwere: 'pruefen', titel: 'Firma nicht bestimmt',        quelle: 'intern Erstlauf' },
  'R-BEL-09': { phase: 1, schwere: 'pruefen', titel: 'Beleg ohne Dokument',         quelle: 'intern Erstlauf' },
  'R-ZAH-05': { phase: 5, schwere: 'hinweis', titel: 'Mahnkosten aufgelaufen',      quelle: 'intern Erstlauf' },
  'R-ZAH-06': { phase: 5, schwere: 'hinweis', titel: 'Zahlungsziel ueberschritten', quelle: 'intern Erstlauf' },
};
const BEKANNT = ['gihl', 'wolf system', 'planerer', 'ferarro', 'schweiger', 'mailhammer', 'pem'];

function pruefungen(heute) {
  return {
    'R-BEL-01': b => {
      const fehlt = [['nummer', 'номер счёта'], ['datum', 'дата'], ['partner', 'контрагент'], ['betrag', 'сумма']]
        .filter(([f]) => !b[f]).map(([, n]) => n);
      return fehlt.length ? 'не хватает: ' + fehlt.join(', ') : null;
    },
    'R-BEL-02': (b, k) => {
      const treffer = (k.dubletten[b._dub] || []).filter(x => x.mail_id !== b.mail_id);
      if (!treffer.length) return null;
      const ids = treffer.map(x => x.mail_id).join(', ');
      const firmen = [...new Set([...treffer.map(x => x.firma), b.firma].filter(Boolean))];
      const extra = firmen.length > 1 ? ' — и отнесены к разным фирмам: ' + firmen.sort().join(', ') : '';
      return `тот же контрагент, сумма и дата, что у ID ${ids}${extra}`;
    },
    // Только настоящее противоречие. «Сверять не с чем» тревогой не считается —
    // именно на этом раньше рождались ложные тревоги.
    'R-BEL-03': b => b.pruefung || null,
    'R-BEL-05': b => {
      if (!b.datum) return null;
      if (b.datum > heute) return `дата счёта ${b.datum} в будущем`;
      const alter = tage(b.datum, heute);
      return alter > 730 ? `дата счёта ${b.datum} — старше ${Math.floor(alter / 365)} лет, но документ в текущей кредиторке` : null;
    },
    'R-BEL-06': b => (!b.partner ? 'контрагент не заполнен' : null),
    'R-BEL-08': b => {
      if (!b.firma || b.firma === 'UNKLAR') return 'фирма не определена';
      return ['VAVK', 'VAVT'].includes(b.firma) ? null : `фирма «${b.firma}» вне контура автоматизации`;
    },
    'R-BEL-09': b => (!b.pdf ? 'документ отсутствует, есть только запись' : null),
    'R-OBJ-01': b => (!b.objekt || b.objekt === 'не распределён'
      ? 'объект не определён — расход не попадёт в себестоимость' : null),
    'R-OBJ-04': b => (b.objekt_quelle === 'почтовый индекс'
      ? `объект «${b.objekt}» проставлен только по почтовому индексу — основание отклонено, привязка снята` : null),
    'R-OBJ-06': b => {
      const o = norm(b.objekt);
      if (!o || ['не распределён', 'офис / общие расходы'].includes(o)) return null;
      return BEKANNT.some(w => o.includes(w)) ? null
        : `объект «${b.objekt}» в справочнике отсутствует — завести и присвоить номер`;
    },
    'R-KLB-01': b => (b.betrag <= 250 && !b.nummer
      ? 'чек до 250 евро без номера — допустимо по § 33 UStDV, но продавец и ставка обязательны' : null),
    'R-KLB-02': b => (b.betrag > 250 && !b.nummer
      ? `${b.betrag.toFixed(2)} евро выше порога 250 — упрощение § 33 UStDV не действует, нужны все реквизиты § 14 UStG` : null),
    'R-ZAH-05': b => {
      if (!(b.mahngebuehr > 0)) return null;
      const anteil = b.betrag ? (b.mahngebuehr / b.betrag * 100) : 0;
      return `начислено ${b.mahngebuehr.toFixed(2)} евро пени — ${Math.round(anteil)} % от суммы счёта`;
    },
    'R-ZAH-06': b => {
      if (!b.faellig || b.status === 'оплачено') return null;
      const t = tage(b.faellig, heute);
      return t > 0 ? `просрочен на ${t} дней` : null;
    },
  };
}

function pruefe(belege, katalog, heute) {
  const P = pruefungen(heute);
  const dubletten = {};
  for (const b of belege) {
    b._dub = `${norm(b.partner)}|${b.betrag}|${b.datum}`;
    (dubletten[b._dub] = dubletten[b._dub] || []).push(b);
  }
  const regeln = {};
  for (const r of katalog) if (P[r.id]) regeln[r.id] = r;
  for (const [id, z] of Object.entries(ZUSATZ)) regeln[id] = { id, ...z, schweregrad: z.schwere };

  const rang = { sperre: 30, pruefen: 20, hinweis: 10 };
  const liste = Object.values(regeln).sort((a, b) =>
    (a.phase - b.phase) || (rang[b.schweregrad] - rang[a.schweregrad]));

  for (const b of belege) {
    b.befunde = [];
    for (const r of liste) {
      let text = null;
      try { text = P[r.id](b, { dubletten }); } catch (e) { text = null; }
      if (!text) continue;
      const q = r.quelle && typeof r.quelle === 'object'
        ? `${r.quelle.gesetz || ''} ${r.quelle.fundstelle || ''}`.trim() : (r.quelle || '');
      b.befunde.push({ regel: r.id, titel: r.titel, schwere: r.schweregrad, text, quelle: q });
    }
    b.entscheidung = b.befunde.some(f => f.schwere === 'sperre') ? 'sperre'
      : b.befunde.some(f => f.schwere === 'pruefen') ? 'pruefen'
        : b.befunde.length ? 'hinweis' : 'frei';
    delete b._dub;
  }
  return belege;
}

/* ---------- нумерация: номер даётся только при уверенном совпадении ---------- */
function nummerierer(nummern) {
  const kred = new Map();
  for (const k of (nummern.kreditoren || [])) kred.set(norm(k.name), k.anzeige);
  const objs = (nummern.objekte || []).map(o => ({ ...o, _k: norm(o.kunde) }));
  return {
    kreditor: name => kred.get(norm(name)) || '',
    objekt: bez => {
      const b = norm(bez);
      if (!b) return '';
      const treffer = objs.filter(o => o._k && b.includes(o._k));
      return treffer.length === 1 ? treffer[0].anzeige : '';   // неоднозначность = пусто
    },
  };
}

/* ---------- запрос к базе ---------- */
const SQL_BELEGE = `
  SELECT i.id, i.kontrahent, i.betrag_cent, i.rechnungsdatum, i.doc_nr, i.objekt,
         i.firma, i.status, i.doc_type, i.zahlungsziel,
         COALESCE(i.mahngebuehr_cent,0)+COALESCE(i.verzugszinsen_cent,0)+COALESCE(i.inkassokosten_cent,0) AS extra_cent,
         i.betrag_geprueft, i.betrag_regex_cent, i.pruef_hinweis,
         i.objekt_grund, i.objekt_sicher, i.subject,
         (i.drive_file_ids)[1] AS datei,
         COALESCE(array_length(i.drive_file_ids,1),0) AS dateien,
         i.created_at
    FROM {S}.mail_items i
   WHERE COALESCE(i.richtung,'eingang') <> 'ausgang'
     AND i.doc_type IN ('RECHNUNG','MAHNUNG','INKASSO','GUTSCHRIFT')
     AND i.duplicate_of IS NULL
     AND i.created_at >= $1
   ORDER BY i.created_at DESC
   LIMIT 800`;

const SQL_POST = `
  SELECT
    (SELECT count(*) FROM {S}.mail_items)                                          AS ges,
    (SELECT count(*) FROM {S}.mail_items WHERE COALESCE(richtung,'eingang')<>'ausgang') AS eingang,
    (SELECT count(*) FROM {S}.mail_items WHERE richtung='ausgang')                  AS ausgang,
    (SELECT min(created_at)::date::text FROM {S}.mail_items)                        AS von,
    (SELECT max(created_at)::date::text FROM {S}.mail_items)                        AS bis,
    (SELECT count(*) FROM {S}.mail_items WHERE doc_type='MAHNUNG')                  AS mahnungen,
    (SELECT count(*) FROM {S}.mail_items WHERE doc_type='INKASSO')                  AS inkasso,
    (SELECT count(*) FROM {S}.mail_items WHERE richtung='ausgang'
        AND (subject ILIKE '%mahn%' OR subject ILIKE '%erinnerung%'))               AS mahn_raus,
    (SELECT count(*) FROM {S}.mail_drafts WHERE status='draft')                     AS entwuerfe,
    (SELECT count(*) FROM {S}.mail_drafts)                                          AS entwuerfe_ges,
    (SELECT count(*) FROM {S}.objekt_queue WHERE status='wartet')                   AS objektfragen,
    (SELECT count(*) FROM {S}.delivery_queue WHERE delivered=false)                 AS unzugestellt,
    (SELECT count(*) FROM {S}.mail_items WHERE status='new')                        AS neu,
    (SELECT count(*) FROM {S}.mail_items WHERE status='review')                     AS review,
    (SELECT max(created_at)::date::text FROM {S}.archiv_belege)                      AS archiv_bis`;

async function frage(c, sql, args) { return (await c.query(sql, args || [])).rows; }

async function ausBase(schema, seit) {
  const S = schema;
  const env = umgebung();
  const c = new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    const belege = await frage(c, SQL_BELEGE.replace(/\{S\}/g, S), [seit]);
    const [post] = await frage(c, SQL_POST.replace(/\{S\}/g, S));
    const faecher = await frage(c, `
      SELECT m.address, m.kind, count(i.id) AS n, max(i.created_at)::date::text AS letzte
        FROM ${S}.mailboxes m LEFT JOIN ${S}.mail_items i ON i.mailbox_id = m.id
       GROUP BY m.id, m.address, m.kind ORDER BY n DESC`);
    const arten = await frage(c, `SELECT COALESCE(doc_type,'-') k, count(*) n FROM ${S}.mail_items GROUP BY 1 ORDER BY 2 DESC`);
    const firmen = await frage(c, `SELECT COALESCE(firma,'-') k, count(*) n FROM ${S}.mail_items GROUP BY 1 ORDER BY 2 DESC`);
    const quote = await frage(c, `
      SELECT count(*) ges,
             count(*) FILTER (WHERE kontrahent IS NOT NULL AND kontrahent <> 'unbekannt') kontrahent,
             count(*) FILTER (WHERE doc_nr IS NOT NULL) docnr,
             count(*) FILTER (WHERE betrag_cent > 0) betrag,
             count(*) FILTER (WHERE objekt IS NOT NULL) objekt,
             count(*) FILTER (WHERE confidence >= 0.8) conf
        FROM ${S}.mail_items`);
    const monate = await frage(c, `
      SELECT to_char(created_at,'YYYY-MM') m, count(*) n,
             round(100.0*count(*) FILTER (WHERE betrag_cent>0)/count(*)) betrag,
             round(100.0*count(*) FILTER (WHERE kontrahent IS NOT NULL AND kontrahent<>'unbekannt')/count(*)) kontrahent
        FROM ${S}.mail_items GROUP BY 1 ORDER BY 1`);
    const mahner = await frage(c, `
      SELECT COALESCE(kontrahent,'?') kontrahent, count(*) briefe, sum(betrag_cent)/100.0 summe
        FROM ${S}.mail_items WHERE doc_type IN ('MAHNUNG','INKASSO')
       GROUP BY 1 ORDER BY 2 DESC, 3 DESC NULLS LAST LIMIT 12`);
    return { belege, post, faecher, arten, firmen, quote: quote[0], monate, mahner };
  } finally { await c.end().catch(() => {}); }
}

/* ---------- сборка документов в том виде, в каком их ждёт приложение ---------- */
function baueBelege(roh, katalog, nummern, heute) {
  const N = nummerierer(nummern);
  const items = roh.map(r => {
    const betrag = eur(r.betrag_cent);
    let pruefung = null;
    if (r.betrag_geprueft === false && r.betrag_regex_cent) {
      pruefung = `расходится: модель ${betrag.toFixed(2)}, документ ${eur(r.betrag_regex_cent).toFixed(2)}`;
    }
    const objekt = r.objekt || '';
    const nurPlz = !r.objekt_sicher && /plz|postleit|индекс/i.test(String(r.objekt_grund || ''));
    return {
      mail_id: String(r.id),
      partner: r.kontrahent || '',
      betrag,
      datum: datum(r.rechnungsdatum),
      nummer: r.doc_nr || '',
      objekt: '',                                   // разнесение начинается заново
      objekt_vorschlag: objekt,                      // что проставил телеграм-этап
      objekt_grund: r.objekt_grund || '',
      objekt_sicher: r.objekt_sicher === true,
      objekt_quelle: nurPlz ? 'почтовый индекс' : '',
      betreff: r.subject || '',
      drive: r.datei || '',
      firma: r.firma || '',
      status: r.status === 'paid' ? 'оплачено' : 'неоплачено',
      typ: r.doc_type || '',
      faellig: datum(r.zahlungsziel),
      mahngebuehr: eur(r.extra_cent),
      pdf: Number(r.dateien) > 0,
      pruefung,
      kreditor: N.kreditor(r.kontrahent),
      objekt_nr: '',
    };
  });
  return pruefe(items, katalog, heute);
}

function bauePartner(belege) {
  const BAU = ['westera', 'metallbau', 'gerüst', 'geruest', 'montage', 'bau', 'elkom', 'eko okna', 'hoffmann'];
  const agg = new Map();
  for (const b of belege) {
    const name = (b.partner || '').trim();
    if (!name) continue;
    const a = agg.get(name) || { belege: 0, summe: 0, offen: 0, typen: new Set(), firmen: new Set() };
    a.belege++; a.summe += b.betrag || 0;
    if (b.status === 'неоплачено') a.offen += b.betrag || 0;
    if (b.typ) a.typen.add(b.typ);
    if (b.firma) a.firmen.add(b.firma);
    agg.set(name, a);
  }
  return [...agg.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([name, a], i) => ({
    id: `KRD-${70001 + i}`, name,
    belege: a.belege, summe: Math.round(a.summe * 100) / 100, offen: Math.round(a.offen * 100) / 100,
    typen: [...a.typen].sort(), firmen: [...a.firmen].sort(),
    subunternehmer: BAU.some(w => norm(name).includes(w)),
    iban: '', ust_idnr: '', ust_idnr_geprueft: '',
    fb_48b_bis: '', fb_48b_nummer: '', ust1tg_bis: '', mindestlohn_bis: '',
  }));
}

function bauePost(d, schnappschuss) {
  const p = d.post, q = d.quote;
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);
  const RU = {
    SONSTIGES: 'прочее', ANFRAGE: 'запросы', RECHNUNG: 'счета', BEHOERDE: 'ведомства', BEHORDE: 'ведомства',
    MAHNUNG: 'напоминания нам', VERTRAG: 'договоры', WERBUNG: 'реклама', SYSTEM: 'системное',
    PERSONAL: 'кадры', BANK: 'банк', ANGEBOT: 'предложения', INKASSO: 'инкассо',
    GUTSCHRIFT: 'кредит-ноты', LIEFERSCHEIN: 'накладные',
  };
  return {
    ...schnappschuss,                                  // тексты разборов и правил берём из снимка
    stand: HEUTE(),
    quelle: 'MailOps · mailops_prod (живые данные)',
    zeitraum: `${p.von} — ${p.bis}`,
    gesamt: { briefe: Number(p.ges), eingang: Number(p.eingang), ausgang: Number(p.ausgang) },
    postfaecher: d.faecher.map(f => ({
      adresse: f.address, typ: f.kind || '?', briefe: Number(f.n), letzte: f.letzte || '—',
      status: Number(f.n) > 0 ? 'ok' : 'fehler',
      fehler: Number(f.n) > 0 ? '' : 'писем в базе нет',
    })),
    arten: d.arten.filter(a => a.k !== '-').map(a => ({ k: a.k, n: Number(a.n), ru: RU[a.k] || '' })),
    firmen: d.firmen.filter(f => f.k !== '-').map(f => ({
      k: f.k, n: Number(f.n), gueltig: ['VAVK', 'VAVT', 'UNKLAR'].includes(f.k),
    })),
    extraktion: {
      ges: Number(q.ges),
      felder: [
        { feld: 'Kontrahent', n: Number(q.kontrahent), pct: pct(q.kontrahent, q.ges) },
        { feld: 'Confidence ≥ 0,8', n: Number(q.conf), pct: pct(q.conf, q.ges) },
        { feld: 'Objekt', n: Number(q.objekt), pct: pct(q.objekt, q.ges) },
        { feld: 'Belegnummer', n: Number(q.docnr), pct: pct(q.docnr, q.ges) },
        { feld: 'Betrag > 0', n: Number(q.betrag), pct: pct(q.betrag, q.ges) },
      ],
      monate: d.monate.map(m => ({ m: m.m, n: Number(m.n), betrag: Number(m.betrag), kontrahent: Number(m.kontrahent) })),
    },
    eingehende_mahnungen: {
      briefe: Number(p.mahnungen), inkasso: Number(p.inkasso),
      top: d.mahner.map(m => ({ kontrahent: m.kontrahent, briefe: Number(m.briefe), summe: Number(m.summe || 0) })),
    },
    ausgehende_mahnungen: Number(p.mahn_raus),
    haengt: [
      { was: 'Черновики ответов', n: Number(p.entwuerfe), detail: `из ${p.entwuerfe_ges} созданных отправлено ${Number(p.entwuerfe_ges) - Number(p.entwuerfe)}` },
      { was: 'Очередь доставки', n: Number(p.unzugestellt), detail: 'не доставлено в Telegram' },
      { was: 'Вопросы по объекту', n: Number(p.objektfragen), detail: 'карточка ждёт ответа человека' },
      { was: 'Письма в статусе new', n: Number(p.neu), detail: 'никто не открывал' },
      { was: 'Письма в статусе review', n: Number(p.review), detail: 'открыты, решение не принято' },
    ],
    archiv_bis: p.archiv_bis,
  };
}

/* ---------- то, что вызывает сервер ---------- */
let cache = { zeit: 0, daten: null, fehler: null };
const FRISCH_MS = 60_000;


/* Дата старта учёта. Лежит в одном файле, чтобы приложение и правила
   считали от одного числа. Нет файла — берём настройку MailOps. */
const START_DATEI = '/opt/buchhalter/data/start';
function startDatum(env) {
  try {
    const d = fs.readFileSync(START_DATEI, 'utf8').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  } catch (e) { /* файла нет */ }
  return env.KREDITORKA_SINCE || '2026-08-01';
}

async function lade(schnappschuesse) {
  if (!Client) return { fehler: 'модуль pg не установлен — работаем на снимках' };
  if (cache.daten && Date.now() - cache.zeit < FRISCH_MS) return { daten: cache.daten, zeit: cache.zeit };
  const env = umgebung();
  if (!env.DATABASE_URL) return { fehler: 'строка подключения не найдена в /opt/mailops/.env' };
  const schema = env.DB_SCHEMA || 'mailops_prod';
  const seit = startDatum(env);
  const heute = HEUTE();
  try {
    const roh = await ausBase(schema, seit);
    const katalog = (schnappschuesse.regeln && schnappschuesse.regeln.items) || [];
    const belege = baueBelege(roh.belege, katalog, schnappschuesse.nummern || {}, heute);
    const daten = {
      belege: { stand: heute, quelle: `MailOps · ${schema}.mail_items (живые данные, с ${seit})`, items: belege },
      partner: { stand: heute, quelle: 'выведено из живой кредиторки', items: bauePartner(belege) },
      post: bauePost(roh, schnappschuesse.post || {}),
    };
    cache = { zeit: Date.now(), daten, fehler: null };
    return { daten, zeit: cache.zeit };
  } catch (e) {
    cache.fehler = e.message;
    return { fehler: e.message };
  }
}

module.exports = { lade };
