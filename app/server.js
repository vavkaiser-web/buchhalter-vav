/* ---------------------------------------------------------------
   Buchhalter VAV — сервер приложения.
   Без внешних зависимостей: только стандартная библиотека Node.
   Данные: живые из MailOps (live.js) плюс снимки в ./daten.
   Решения пользователей в ./data/state.json, вход по логину и ПИН.
   ---------------------------------------------------------------- */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const live = require('./live.js');
const razn = require('./razn.js');
const akteModul = require('./akte.js');
const recht = require('./recht.js');
const hinweis = require('./hinweis.js');
const drive = require('./drive.js');
const kasse = require('./kasse/api.js');
const aufgaben = require('./aufgaben.js');
const objekt = require('./objekt.js');
const monat = require('./monat.js');
const korrektur = require('./korrektur.js');
const steuerberater = require('./steuerberater.js');
const benachrichtigung = require('./benachrichtigung.js');
const integration = require('./integration.js');
const offline = require('./offline.js');
const erinnerung = require('./erinnerung.js');
const audit = require('./audit.js');
const anfang = require('./anfang.js');
const dublette = require('./dublette.js');
const bankabgleich = require('./bankabgleich.js');
const debitor = require('./debitor.js');
const dokument = require('./dokument.js');
const rk = require('./rechnung_kontrolle.js');
const bg = require('./bestellung_gate.js');

const PORT   = Number(process.env.PORT || 3026);
const WURZEL = __dirname;
const OEFF   = path.join(WURZEL, 'public');
const DATEN  = process.env.BUCH_DATEN || path.join(WURZEL, 'daten');
const DATA   = process.env.BUCH_DATA || path.join(WURZEL, 'data');   // локальные копии задают свою папку
const NUTZER = path.join(DATA, 'benutzer.json');
const ALT_PIN = path.join(DATA, 'pin.json');
const STATE  = path.join(DATA, 'state.json');
const SECRET = path.join(DATA, 'secret');

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(SECRET)) fs.writeFileSync(SECRET, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const geheim = fs.readFileSync(SECRET, 'utf8').trim();

/* ---------- роли ---------- */
const ALLE_TABS = ['cockpit','steuern','modell','liqui','debit','mahn','unbez','post',
                   'nummern','belege','objekte','partner','geld','regeln','razn','recht'];
const ROLLEN = {
  gf: {
    name: 'владелец',
    tabs: ALLE_TABS,
    docs: null,                       // null = все документы
  },
  buchhaltung: {
    name: 'бухгалтерия',
    tabs: ['cockpit','steuern','liqui','debit','mahn','unbez','post','nummern','belege','objekte','partner','geld','regeln','razn','recht'],
    docs: null,
  },
  // Касса и чеки (экран /arbeit). Классические разделы этим ролям закрыты.
  disponent: {
    name: 'ответственный за наличные',
    tabs: [],
    docs: [],
  },
  mitarbeiter: {
    name: 'сотрудник',
    tabs: [],
    docs: [],
  },
  buero: {
    name: 'офис',
    tabs: ['post','nummern','belege','objekte','partner','regeln','razn','recht'],
    docs: ['belege','objekte','partner','nummern','zuordnung','regeln','post'],
  },
};

const NUR_KASSE = ['disponent', 'mitarbeiter'];
// §3: Олег (Geschäftsführer по всем объектам) видит объекты по разрешению objektzugang,
// которое выдаёт Андрей. Финансовые ограничения (прибыль/банк/ведомости) — в карточке объекта их нет.
const darfObjekte = n => ['gf', 'buchhaltung'].includes(n.rolle) || n.objektzugang === true;

/* ---------- пользователи ---------- */
function nutzerLesen() {
  try { return JSON.parse(fs.readFileSync(NUTZER, 'utf8')); } catch (e) { return []; }
}
function nutzerSchreiben(liste) {
  fs.writeFileSync(NUTZER, JSON.stringify(liste, null, 1), { mode: 0o600 });
}
// Первый запуск после старой однопользовательской версии: ПИН владельца сохраняем.
(function migriere() {
  if (fs.existsSync(NUTZER) || !fs.existsSync(ALT_PIN)) return;
  try {
    const alt = JSON.parse(fs.readFileSync(ALT_PIN, 'utf8'));
    nutzerSchreiben([{ login: 'andrej', name: 'Андрей Кайзер', rolle: 'gf',
                       salz: alt.salz, hash: alt.hash, wann: alt.wann || new Date().toISOString() }]);
    fs.renameSync(ALT_PIN, ALT_PIN + '.uebernommen');
    console.log('ПИН владельца перенесён в benutzer.json, логин andrej');
  } catch (e) { console.error('перенос ПИНа не удался:', e.message); }
})();

/* ---------- снимки ---------- */
let schnappschuesse = {};
function datenLaden() {
  const neu = {};
  for (const f of fs.readdirSync(DATEN)) {
    if (!f.endsWith('.json')) continue;
    try { neu[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(DATEN, f), 'utf8')); }
    catch (e) { console.error('снимок не прочитан:', f, e.message); }
  }
  schnappschuesse = neu;
  console.log('снимков загружено:', Object.keys(neu).length);
}
datenLaden();
fs.watch(DATEN, { persistent: false }, () => { clearTimeout(datenLaden._t); datenLaden._t = setTimeout(datenLaden, 500); });

/* ---------- состояние ---------- */
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { state = {}; }
let geplant = null;
function sichern() {
  clearTimeout(geplant);
  geplant = setTimeout(() => {
    const tmp = STATE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state, null, 1), err => {
      if (err) return console.error('state не сохранён:', err.message);
      fs.rename(tmp, STATE, e2 => e2 && console.error('state не переименован:', e2.message));
    });
  }, 250);
}

/* ---------- сессии ---------- */
const TAGE = 30;
// Токен несёт версию сессии пользователя (epoch). Завершение всех сеансов —
// это увеличение epoch у пользователя: старые токены перестают подходить (§9).
function tokenBauen(login, epoch) {
  const bis = Date.now() + TAGE * 864e5;
  const nutz = Buffer.from(login).toString('base64url');
  const ep = String(Number(epoch) || 0);
  const sig = crypto.createHmac('sha256', geheim).update(bis + '.' + nutz + '.' + ep).digest('hex').slice(0, 32);
  return `${bis}.${nutz}.${ep}.${sig}`;
}
function tokenLesen(t) {
  if (!t) return null;
  const teile = String(t).split('.');
  if (teile.length !== 4) return null;                       // старый 3-частный формат больше не действует
  const [bis, nutz, ep, sig] = teile;
  if (!/^\d+$/.test(bis) || Number(bis) < Date.now()) return null;
  if (!/^\d+$/.test(ep)) return null;
  const soll = crypto.createHmac('sha256', geheim).update(bis + '.' + nutz + '.' + ep).digest('hex').slice(0, 32);
  const a = Buffer.from(String(sig).padEnd(32, '0').slice(0, 32));
  if (!crypto.timingSafeEqual(a, Buffer.from(soll))) return null;
  try { return { login: Buffer.from(nutz, 'base64url').toString('utf8'), epoch: Number(ep) }; } catch (e) { return null; }
}
const keks = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
  .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));
function wer(req) {
  const tok = tokenLesen(keks(req).vavsess);
  if (!tok) return null;
  const n = nutzerLesen().find(x => x.login === tok.login);
  if (!n) return null;
  if (n.gesperrt === true) return null;                      // §8 блокировка входа (учётка сохраняется)
  if ((Number(n.sess_epoch) || 0) !== tok.epoch) return null; // §9 сеансы завершены — токен устарел
  return { ...n, rechte: ROLLEN[n.rolle] || ROLLEN.buero };
}

/* ---------- защита от подбора ---------- */
const versuche = new Map();
const gesperrt = k => { const v = versuche.get(k); return v && v.bis > Date.now(); };
function fehlversuch(k) {
  const v = versuche.get(k) || { n: 0, bis: 0 };
  v.n++; if (v.n >= 5) { v.bis = Date.now() + 15 * 60000; v.n = 0; }
  versuche.set(k, v);
}

/* ---------- журнал входов ---------- */
const ZUGANG = path.join(DATA, 'zugang.log');
function zugangNotiz(ip, eingabe, ergebnis, brauser) {
  const z = [new Date().toISOString(), ip, JSON.stringify(String(eingabe || '')),
             ergebnis, String(brauser || '').slice(0, 120)].join('\t') + '\n';
  fs.appendFile(ZUGANG, z, e => e && console.error('журнал входа:', e.message));
}

/* ---------- вспомогательное ---------- */
const TYPEN = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml',
  '.webmanifest':'application/manifest+json; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.ico':'image/x-icon' };
function jsonAntwort(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function dateiAntwort(res, datei, cache) {
  fs.readFile(datei, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('нет такой страницы'); }
    res.writeHead(200, { 'Content-Type': TYPEN[path.extname(datei)] || 'application/octet-stream',
      'Content-Length': buf.length, 'Cache-Control': cache || 'no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    res.end(buf);
  });
}
function koerperGross(req, grenze) {
  return new Promise((ok, fehler) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > (grenze || 6e6)) { req.destroy(); fehler(new Error('слишком много')); } s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fehler(e); } });
  });
}
function koerper(req) {
  return new Promise((ok, fehler) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 1e6) { req.destroy(); fehler(new Error('слишком много')); } s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fehler(e); } });
  });
}

/* ---------- разнос партиями по 10 (январь, из FinMap) ---------- */
const CHARGE_GROESSE = 10;
const CHARGE_MONAT = process.env.CHARGE_MONAT || '2026-01';
async function janUndone() {
  const ops = (await razn.operationen(400)).filter(o => String(o.datum || '').startsWith(CHARGE_MONAT));
  ops.sort((a, b) => String(a.datum).localeCompare(String(b.datum))
    || (Math.abs(Number(b.betrag)) - Math.abs(Number(a.betrag))));
  let done = new Set();
  try {
    const rows = await razn.mitBase(q => q('SELECT DISTINCT quelle_id FROM ' + razn.SCHEMA
      + 'buch_zuordnung WHERE quelle = $1', ['finmap']));
    done = new Set(rows.map(r => String(r.quelle_id)));
  } catch (e) { /* нет таблицы — считаем, что не разнесено */ }
  return ops.filter(o => !done.has(String(o.id)));
}
function eurC(n) { return (Math.abs(Number(n) || 0)).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function chargeText(batch, rest) {
  const zeilen = batch.map((o, i) => {
    const vz = o.typ === 'income' ? '+' : '−';
    const kat = o.fm_kategorie ? ' · FinMap: ' + o.fm_kategorie : '';
    const prj = o.fm_projekt ? ' / ' + o.fm_projekt : '';
    return (i + 1) + ') ' + (o.datum || '') + ' · ' + vz + eurC(o.betrag) + ' · ' + (o.partner || '—') + kat + prj + '  → объект: __, назначение: __';
  });
  return 'Разнести в разделе «Разнос» (месяц январь) — по каждой операции указать объект и предназначение:\n\n'
    + zeilen.join('\n')
    + '\n\nКогда все разнесены — сдай задачу, я сразу пришлю следующие 10. Осталось после этой партии: ' + rest;
}
async function naechsteRaznCharge(n, benutzer) {
  if (aufgaben.offeneNachArt('razn_charge').length) return { schon: true };
  const undone = await janUndone();
  if (!undone.length) return { fertig: true };
  const batch = undone.slice(0, CHARGE_GROESSE);
  const rest = undone.length - batch.length;
  const nr = aufgaben.zaehleNachArt('razn_charge') + 1;
  const titel = 'Разнос · январь · партия ' + nr + ' (' + batch.length + ' операций)';
  aufgaben.anlegen({ titel, text: chargeText(batch, rest), ziel_person: 'buch',
    art: 'razn_charge', bezug: 'Январь · FinMap', posten: batch.map(o => String(o.id)) }, n, benutzer);
  return { created: true, nr, anzahl: batch.length, rest };
}

/* ---------- автоподбор документа к операции ---------- */
async function janDocs() {
  const url = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
  const cl = new (require('pg').Client)({ connectionString: url });
  try {
    await cl.connect();
    // Только подтверждённые бухгалтером документы участвуют в автоподборе к разносу
    // (правило: распознанные суммы/даты/реквизиты подтверждает бухгалтер до использования).
    return (await cl.query('SELECT drive_id, dateiname, quelle, typ, doc_nr, betrag_cent, belegdatum, '
      + 'kontrahent, netto_cent, ust_cent, pruef_grund, periode_ok, ext, mime, groesse '
      + "FROM import_dokument WHERE monat = $1 AND status = 'bestaetigt'", [CHARGE_MONAT])).rows;
  } finally { try { await cl.end(); } catch (e) {} }
}
function normName(s) { return String(s || '').toLowerCase().replace(/[^a-zа-я0-9]/gi, '').slice(0, 24); }
function belegeFuerOp(op, docs) {
  const cent = Math.round(Math.abs(Number(op.betrag) || 0) * 100);
  const part = normName(op.partner);
  const out = [];
  for (const d of docs) {
    let treffer = null;
    const dc = Number(d.betrag_cent) || 0;
    if (cent > 0 && dc === cent) treffer = 'genau';
    else if (cent > 0 && dc > 0 && Math.abs(dc - cent) <= cent * 0.03) treffer = 'nah';
    else if (part.length >= 4 && normName(d.kontrahent).includes(part.slice(0, 6))) treffer = 'name';
    if (treffer) out.push(Object.assign({ treffer }, d));
  }
  const rang = { genau: 0, nah: 1, name: 2 };
  out.sort((a, b) => rang[a.treffer] - rang[b.treffer] || (Number(b.betrag_cent) - Number(a.betrag_cent)));
  return out.slice(0, 6);
}

/* ---------- проверка документов партиями по 10 (январь) ---------- */
const BELEG_GROESSE = 10;
async function belegAlle() {
  const url = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
  const cl = new (require('pg').Client)({ connectionString: url });
  try {
    await cl.connect();
    return (await cl.query('SELECT drive_id, quelle, typ, doc_nr, betrag_cent, belegdatum, kontrahent, '
      + 'netto_cent, ust_cent, dateiname, ext, mime, groesse, status, pruef_grund, pruef_notiz, geprueft_von, geprueft_am '
      + 'FROM import_dokument WHERE monat = $1 ORDER BY quelle, belegdatum NULLS LAST, doc_nr NULLS LAST, dateiname',
      [CHARGE_MONAT])).rows;
  } finally { try { await cl.end(); } catch (e) {} }
}
function belegText(batch, rest) {
  const zeilen = batch.map((d, i) => {
    const q = d.quelle === 'ausgang' ? 'исх.' : d.quelle === 'eingang' ? 'вх.' : '';
    return (i + 1) + ') ' + q + ' ' + (d.typ || 'документ') + ' №' + (d.doc_nr || '?')
      + ' · ' + eurC((Number(d.betrag_cent) || 0) / 100) + ' · ' + (d.belegdatum ? String(d.belegdatum).slice(0, 10) : 'без даты')
      + (d.kontrahent ? ' · ' + String(d.kontrahent).slice(0, 30) : '');
  });
  return 'Проверить в разделе «Проверка» (месяц январь) — по каждому документу открыть оригинал и подтвердить тип, сумму, дату, номер и контрагента (или исправить):\n\n'
    + zeilen.join('\n')
    + '\n\nКогда все проверены — сдай задачу, я сразу пришлю следующие 10. Осталось после этой партии: ' + rest;
}
async function naechsteBelegCharge(n, benutzer) {
  if (aufgaben.offeneNachArt('beleg_pruef').length) return { schon: true };
  const undone = (await belegAlle()).filter(d => d.status === 'neu');
  if (!undone.length) return { fertig: true };
  const batch = undone.slice(0, BELEG_GROESSE);
  const rest = undone.length - batch.length;
  const nr = aufgaben.zaehleNachArt('beleg_pruef') + 1;
  const titel = 'Проверка документов · январь · партия ' + nr + ' (' + batch.length + ' шт.)';
  aufgaben.anlegen({ titel, text: belegText(batch, rest), ziel_person: 'buch',
    art: 'beleg_pruef', bezug: 'Январь · документы', posten: batch.map(d => String(d.drive_id)) }, n, benutzer);
  return { created: true, nr, anzahl: batch.length, rest };
}

/* ---------- сервер ---------- */
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '?');

  try {
    // Касса: свои маршруты и проверки прав (kasse/api.js).
    if (p.startsWith('/api/k/')) {
      const n = wer(req);
      return void await kasse.handle(req, res, u, n ? { ...n, rollenname: n.rechte.name } : null, { benutzer: nutzerLesen() });
    }
    // Задачи (этап 2) — доступны всем ролям, права проверяются внутри модуля.
    if (p === '/api/ich' && req.method === 'GET') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      return jsonAntwort(res, 200, { login: n.login, name: n.name, rolle: n.rolle });
    }
    if (p === '/api/aufgaben' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const benutzer = nutzerLesen();
      const filter = { rolle: u.searchParams.get('rolle') || '', person: u.searchParams.get('person') || '' };
      const me = { ...n, rollenname: n.rechte.name };
      return jsonAntwort(res, 200, {
        ich: { login: n.login, name: n.name, rolle: n.rolle, rollenname: n.rechte.name },
        leitung: ['gf', 'buchhaltung'].includes(n.rolle),
        aufgaben: aufgaben.liste(me, benutzer, filter),
        uebersicht: aufgaben.uebersicht(me, benutzer),
      });
    }
    if (p === '/api/aufgaben' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, aufgaben.anlegen(await koerper(req), n, nutzerLesen())); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/aufgaben/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const r = aufgaben.status(await koerper(req), n, nutzerLesen());
        // Приняли партию разноса — сразу готовим следующие 10.
        if (r.art === 'razn_charge' && r.status === 'angenommen') {
          try { r.naechste = await naechsteRaznCharge(n, nutzerLesen()); }
          catch (e) { r.naechste = { fehler: e.message }; }
        }
        // Приняли партию проверки документов — сразу готовим следующие 10.
        if (r.art === 'beleg_pruef' && r.status === 'angenommen') {
          try { r.naechste = await naechsteBelegCharge(n, nutzerLesen()); }
          catch (e) { r.naechste = { fehler: e.message }; }
        }
        return jsonAntwort(res, 200, r);
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/razn/charge' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'только владелец или бухгалтерия' });
      try { return jsonAntwort(res, 200, await naechsteRaznCharge(n, nutzerLesen())); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/beleg/charge' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'только владелец или бухгалтерия' });
      try { return jsonAntwort(res, 200, await naechsteBelegCharge(n, nutzerLesen())); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/bestaetigen') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/bestaetigen' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'bestaetigen.html'));
    }

    if (p === '/objekt') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/objekt' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'objekt.html'));
    }
    if (p === '/dubletten') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/dubletten' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'dubletten-pruefung.html'));
    }
    if (p === '/bank') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/bank' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'bank-abgleich.html'));
    }
    if (p === '/rechnung') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/rechnung' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'rechnung-kontrolle.html'));
    }
    if (p === '/debitor') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/debitor' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'debitor.html'));
    }
    if (p === '/dokument') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/dokument' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'dokument.html'));
    }

    /* ===== Дополнение №5 — проверка периодов (Месяц проверен Натальей) ===== */
    if (p === '/monat') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/monat' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'monat.html'));
    }
    if (p === '/api/monat') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const jahr = u.searchParams.get('jahr') || new Date().getFullYear();
        const r = await monat.uebersicht(jahr);
        return jsonAntwort(res, 200, { ...r, ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: monat.istVerantwortlich(n) } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/monat/eins') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const firma = u.searchParams.get('firma'), jahr = u.searchParams.get('jahr'), mon = u.searchParams.get('monat');
        const r = await monat.eins(firma, jahr, mon);
        // Ф3: какие исправления затронули этот месяц (для точечной повторной проверки)
        try {
          const kk = await korrektur.liste({ firma, jahr, monat: mon });
          r.korrekturen = kk.filter(x => ['bestaetigt', 'angewandt'].includes(x.status))
            .map(x => ({ id: x.id, art_text: x.art_text, bezug: x.bezug, status: x.status, status_text: x.status_text,
              objekt_nr: x.objekt_nr, auswirkung: x.auswirkung, angewandt_am: x.angewandt_am }));
        } catch (e) { r.korrekturen = []; }
        return jsonAntwort(res, 200, r);
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/monat/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await monat.statusSetzen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/monat/wiedervorlage' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await monat.wiedervorlageSetzen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    // Ответственный бухгалтер (Наталья). Назначает только владелец. Аккаунт не создаётся.
    if (p === '/api/monat/verantwortliche') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'только владелец' });
      const liste = nutzerLesen().filter(x => x.rolle === 'buchhaltung')
        .map(x => ({ login: x.login, name: x.name || x.login, verantwortlich: x.verantwortlich === true }));
      return jsonAntwort(res, 200, { buchhalter: liste });
    }
    if (p === '/api/monat/verantwortlich' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'только владелец назначает ответственного' });
      try {
        const b = await koerper(req);
        const login = String(b.login || '').trim().toLowerCase();
        const an = b.verantwortlich !== false;
        const liste = nutzerLesen();
        const ziel = liste.find(x => x.login === login);
        if (!ziel) return jsonAntwort(res, 400, { fehler: 'нет такого логина' });
        if (ziel.rolle !== 'buchhaltung') return jsonAntwort(res, 400, { fehler: 'ответственным может быть только бухгалтер' });
        const war = ziel.verantwortlich === true;
        ziel.verantwortlich = an;
        nutzerSchreiben(liste);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'rechte', ziel: 'user:' + login,
          alt: war ? 'ответственный' : 'нет', neu: an ? 'ответственный бухгалтер' : 'нет', grund: 'назначение ответственного' });
        return jsonAntwort(res, 200, { ok: true, login, verantwortlich: an });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    // §1/§3/§4 — выдать/снять разрешение по категории (только владелец). Пока: objektzugang.
    if (p === '/api/zugang/recht' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'права назначает только владелец' });
      try {
        const b = await koerper(req); const login = String(b.login || '').trim().toLowerCase();
        const recht = String(b.recht || ''); const an = b.an !== false;
        if (!['objektzugang'].includes(recht)) return jsonAntwort(res, 400, { fehler: 'неизвестное разрешение' });
        const liste = nutzerLesen(); const ziel = liste.find(x => x.login === login);
        if (!ziel) return jsonAntwort(res, 400, { fehler: 'нет такого логина' });
        const war = ziel[recht] === true;
        ziel[recht] = an;
        nutzerSchreiben(liste);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'rechte', ziel: 'user:' + login,
          alt: (war ? '' : 'нет ') + recht, neu: (an ? '' : 'снято ') + recht, grund: 'разрешение по категории' });
        return jsonAntwort(res, 200, { ok: true, login, recht, an });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №5 Ф2 — запросы на исправление ===== */
    if (p === '/korrektur') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/korrektur' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'korrektur.html'));
    }
    if (p === '/api/korrektur' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const f = { status: u.searchParams.get('status') || '', firma: u.searchParams.get('firma') || '',
          jahr: u.searchParams.get('jahr') || '', monat: u.searchParams.get('monat') || '', objekt_nr: u.searchParams.get('objekt_nr') || '' };
        // Сотрудник видит только свои запросы; бухгалтерия/владелец — все.
        let items = await korrektur.liste(f);
        if (!['gf', 'buchhaltung'].includes(n.rolle)) items = items.filter(x => x.autor === n.login);
        return jsonAntwort(res, 200, { korrekturen: items,
          ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: monat.istVerantwortlich(n) },
          arten: korrektur.ARTEN, firmen: monat.FIRMEN });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/korrektur/eins') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const r = await korrektur.eins(u.searchParams.get('id'));
        if (!['gf', 'buchhaltung'].includes(n.rolle) && r.autor !== n.login) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        return jsonAntwort(res, 200, r);
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/korrektur' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await korrektur.anlegen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/korrektur/bestaetigen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await korrektur.bestaetigen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/korrektur/zurueck' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await korrektur.zurueck(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/korrektur/anwenden' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await korrektur.anwenden(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    // Ф4: пометить исправление затрагивающим Steuerberater
    if (p === '/api/korrektur/steuerberater' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await korrektur.steuerberaterPflicht(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    // Ф4: подтверждение согласования со Steuerberater (письменное или телефонная запись)
    if (p === '/api/steuerberater/bestaetigung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'только ответственный бухгалтер или владелец' });
      try {
        const b = await koerper(req); b.autor = n.login;
        return jsonAntwort(res, 200, await steuerberater.bestaetigungAnlegen(b));
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №5 Ф5 — уведомления владельцу ===== */
    if (p === '/benachrichtigung') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/benachrichtigung' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'benachrichtigung.html'));
    }
    if (p === '/api/benachrichtigung' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'уведомления только владельцу' });
      try { return jsonAntwort(res, 200, { benachrichtigungen: await benachrichtigung.liste({ ziel: 'gf', status: u.searchParams.get('status') || '' }) }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/benachrichtigung/gesehen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'уведомления только владельцу' });
      try { return jsonAntwort(res, 200, await benachrichtigung.gesehen((await koerper(req)).id)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №5 Ф6 — комплекты для Steuerberater ===== */
    if (p === '/paket') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/paket' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'paket.html'));
    }
    if (p === '/api/paket' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const r = await steuerberater.paketListe({ firma: u.searchParams.get('firma') || '', jahr: u.searchParams.get('jahr') || '', status: u.searchParams.get('status') || '' });
        return jsonAntwort(res, 200, { pakete: r, firmen: monat.FIRMEN, ueb_arten: steuerberater.UEB_ART_T,
          ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: monat.istVerantwortlich(n) } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/paket/eins') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { ...(await steuerberater.paketEins(u.searchParams.get('id'))), ueb_arten: steuerberater.UEB_ART_T,
        ich: { login: n.login, verantwortlich: monat.istVerantwortlich(n) } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/paket' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'только ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.paketAnlegen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/paket/position' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'только ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.positionAdd(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/paket/position/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'только ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.positionStatus(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/paket/uebergeben' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'только ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.paketUebergeben(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №5 Ф7 — вопросы Steuerberater ===== */
    if (p === '/fragen') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/fragen' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'fragen.html'));
    }
    if (p === '/api/frage' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) {
        // исполнитель видит только порученные ему вопросы
        try { const eig = await steuerberater.frageListe({ bearbeiter: n.login }); return jsonAntwort(res, 200, { fragen: eig, nur_eigene: true, ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: false } }); }
        catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
      }
      try {
        const r = await steuerberater.frageListe({ status: u.searchParams.get('status') || '', bearbeiter: u.searchParams.get('bearbeiter') || '' });
        const leute = nutzerLesen().map(x => ({ login: x.login, name: x.name || x.login, rolle: x.rolle }));
        return jsonAntwort(res, 200, { fragen: r, benutzer: leute, firmen: monat.FIRMEN,
          ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: monat.istVerantwortlich(n) } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage/eins') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const f = await steuerberater.frageEins(u.searchParams.get('id'));
        if (!['gf', 'buchhaltung'].includes(n.rolle) && f.bearbeiter !== n.login) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        f.ich = { login: n.login, verantwortlich: monat.istVerantwortlich(n) };
        return jsonAntwort(res, 200, f);
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'вопросы регистрирует ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.frageAnlegen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage/zuweisen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'распределяет ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.frageZuweisen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage/antwort' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const b = await koerper(req);
        const f = await steuerberater.frageEins(b.frage_id);
        if (!monat.istVerantwortlich(n) && f.bearbeiter !== n.login) return jsonAntwort(res, 403, { fehler: 'ответ готовит назначенный исполнитель' });
        return jsonAntwort(res, 200, await steuerberater.antwortAnlegen(b, n));
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage/antwort/pruefen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'ответы проверяет ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.antwortPruefen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/frage/paket' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!monat.istVerantwortlich(n)) return jsonAntwort(res, 403, { fehler: 'в комплект включает ответственный бухгалтер или владелец' });
      try { return jsonAntwort(res, 200, await steuerberater.frageInPaket(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekte') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!darfObjekte(n)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { objekte: await objekt.objektListe() }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/objekt') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!darfObjekte(n)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const r = await objekt.objektEins(u.searchParams.get('nr')); return jsonAntwort(res, 200, { ...r, ich: { login: n.login, name: n.name, rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/kennzahl' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'вносит владелец или бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.kennzahlSetzen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/dubletten') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { dubletten: await objekt.dubletten() }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/objekt/nachtrag' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'вносит владелец или бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.nachtragAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/nachtrag/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.nachtragStatus(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/etc' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'оценку вносит Олег, владелец или бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.etcNeu(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/risiko-erledigt' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.risikoErledigt(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/etc-check' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const veraltet = await objekt.etcVeraltet();
        // ставим Олегу задачу на обновление (идемпотентно по объекту)
        const offen = aufgaben.offeneNachArt('etc_update');
        const schon = new Set(offen.map(a => a.bezug));
        let erstellt = 0;
        for (const o of veraltet) {
          const bezug = 'ETC ' + o.nr;
          if (schon.has(bezug)) continue;
          aufgaben.anlegen({ titel: 'Обновить оценку затрат до завершения — ' + o.nr + (o.bez ? ' (' + o.bez + ')' : ''),
            text: (o.nie ? 'По объекту ещё нет оценки оставшихся затрат (ETC).' : 'Оценка ETC устарела (старше недели).') + ' Олег: обновить оценку и указать причину изменения.',
            ziel_person: 'oleg', art: 'etc_update', bezug }, n, nutzerLesen());
          erstellt++;
        }
        return jsonAntwort(res, 200, { veraltet: veraltet.length, aufgaben_erstellt: erstellt, liste: veraltet });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/objekt/bestellung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'заказы ведёт бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.bestellungAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/bestellung/genehmigen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'закупку утверждает Олег или Андрей' });
      try { return jsonAntwort(res, 200, await objekt.bestellungGenehmigen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/bestellung/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.bestellungStatus(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // --- Защита от дублей и повторных писем ---
    if (p === '/api/dublette' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'очередь дублей ведёт бухгалтерия' });
      try { return jsonAntwort(res, 200, { ...(await dublette.liste()), ich: { login: n.login, rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/dublette/eins' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await dublette.eins(u.searchParams.get('id'))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    {
      const marsch = {
        '/api/dublette/empfang': 'belegEmpfang', '/api/dublette/entscheiden': 'entscheiden',
        '/api/dublette/verknuepfen': 'verknuepfen', '/api/dublette/iban-freigeben': 'ibanFreigeben',
        '/api/dublette/frist-anwenden': 'fristAnwenden', '/api/dublette/signal-erledigt': 'signalErledigt',
        '/api/dublette/extra-pruefen': 'extraPruefen', '/api/dublette/extra-andrej': 'extraAnAndrej',
        '/api/dublette/extra-entscheiden': 'extraEntscheiden', '/api/dublette/markieren': 'markieren',
      };
      if (marsch[p] && req.method === 'POST') {
        const n = wer(req);
        if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
        if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        try {
          const b = await koerper(req);
          const ergebnis = await dublette[marsch[p]](b, n);
          // Хук: после markieren с bezahlt=true → задача по документам
          if (marsch[p] === 'markieren' && b.bezahlt === true && b.id) {
            rk.nachZahlungPruefen(Number(b.id)).catch(e => console.error('nachZahlungPruefen:', e.message));
          }
          return jsonAntwort(res, 200, ergebnis);
        }
        catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
      }
    }

    if (p === '/api/objekt/bestellung/rechnung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.bestellungRechnung(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // --- Сверка банковских платежей со счетами ---
    if (p === '/api/bank' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'сверку ведёт бухгалтерия' });
      try { return jsonAntwort(res, 200, { ...(await bankabgleich.liste()), ich: { login: n.login, rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/bank/eins' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await bankabgleich.eins(u.searchParams.get('id'))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    {
      const bm = {
        '/api/bank/import': 'zahlungImport', '/api/bank/zuordnen': 'zuordnen', '/api/bank/storno': 'zuordnungStorno',
        '/api/bank/ueberzahlung': 'ueberzahlung', '/api/bank/rueckbuchung': 'rueckbuchung',
        '/api/bank/rueckbuchung-bestaetigen': 'rueckbuchungBestaetigen', '/api/bank/auto': 'autoSetzen',
        '/api/bank/auto-pruefung': 'autoPruefung', '/api/bank/differenz': 'differenzErklaeren', '/api/bank/skonto': 'skontoAbschluss',
      };
      if (bm[p] && req.method === 'POST') {
        const n = wer(req);
        if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
        if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        try { return jsonAntwort(res, 200, await bankabgleich[bm[p]](await koerper(req), n)); }
        catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
      }
    }

    // --- Контроль полноты документов ---
    if (p === '/api/dok' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'контроль документов ведёт бухгалтерия' });
      try { return jsonAntwort(res, 200, { ...(await dokument.liste()), ich: { login: n.login, rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/dok/eins' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await dokument.eins(u.searchParams.get('id'))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    {
      const km = {
        '/api/dok/pruefung': 'dokPruefung', '/api/dok/verknuepfen': 'verknuepfen', '/api/dok/spaeter': 'spaeterDokument',
        '/api/dok/mangel': 'mangelErfassen', '/api/dok/mangel-erledigt': 'mangelErledigt', '/api/dok/abschluss': 'abschluss',
      };
      if (km[p] && req.method === 'POST') {
        const n = wer(req);
        if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
        if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        try { return jsonAntwort(res, 200, await dokument[km[p]](await koerper(req), n)); }
        catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
      }
    }

    // --- Контроль счёта vs заказ/договор ---
    if (p === '/api/rechnung/pruefung' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await rk.pruefung(Number(b.beleg_id), b.bestellung_id != null ? Number(b.bestellung_id) : null, n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/pruefung' && req.method === 'GET') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await rk.pruefungsliste({ beleg_id: u.searchParams.get('beleg_id'), bestellung_id: u.searchParams.get('bestellung_id'), ergebnis: u.searchParams.get('ergebnis') })); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/pruefung/eins' && req.method === 'GET') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await rk.pruefungEins(Number(u.searchParams.get('id')))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/ausnahme-beantragen' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await rk.ausnahmeBeantragen(Number(b.prueflauf_id), { grund: b.grund, notiz: b.notiz }, n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/ausnahme-andrej' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'disponent') return jsonAntwort(res, 403, { fehler: 'передаёт Олег (disponent)' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await rk.anfragAnAndrej(Number(b.anfrage_id), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/ausnahme-genehmigen' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'исключение утверждает Андрей (gf)' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await rk.ausnahmeGenehmigen(Number(b.prueflauf_id), { basis: b.basis, grund: b.grund }, n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/faellig' && req.method === 'GET') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await rk.faelligkeitsUebersicht()); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/rechnung/nach-zahlung' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await rk.nachZahlungPruefen(Number(b.beleg_id))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // --- Гейт утверждения заказов (bestellung_gate) ---
    if (p === '/api/bestellung/gate/beurteilen' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await bg.beurteilen(b.bestellung_id, n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/bestellung/gate/oleg' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['disponent', 'gf'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'только Олег (disponent)' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await bg.oleGenehmigen(b, n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/bestellung/gate/gf' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'только Андрей (gf)' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await bg.gfGenehmigen(b, n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/bestellung/gate/ablehnen' && req.method === 'POST') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['disponent', 'gf'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { const b = await koerper(req); return jsonAntwort(res, 200, await bg.ablehnen(b, n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/bestellung/gate/status' && req.method === 'GET') {
      const n = wer(req); if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const id = u.searchParams.get('id');
      if (!id) return jsonAntwort(res, 400, { fehler: 'нет id' });
      try { return jsonAntwort(res, 200, await bg.gateStatus(id)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // --- Поступления от заказчиков и контроль дебиторки ---
    if (p === '/api/debitor' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'дебиторку ведёт бухгалтерия' });
      try { return jsonAntwort(res, 200, { ...(await debitor.liste()), ich: { login: n.login, rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/debitor/mahnwarnung' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await debitor.mahnWarnung({ ausgang_id: u.searchParams.get('ausgang_id') })); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    {
      const dm = {
        '/api/debitor/import': 'eingangImport', '/api/debitor/zuordnen': 'zuordnen', '/api/debitor/storno': 'zuordnungStorno',
        '/api/debitor/ueberzahlung': 'ueberzahlungKunde', '/api/debitor/unterzahlung': 'unterzahlung',
        '/api/debitor/einbehalt': 'einbehaltErfassen', '/api/debitor/einbehalt-bestaetigen': 'einbehaltBestaetigen',
        '/api/debitor/einbehalt-pruefung': 'einbehaltPruefung',
      };
      if (dm[p] && req.method === 'POST') {
        const n = wer(req);
        if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
        if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
        try { return jsonAntwort(res, 200, await debitor[dm[p]](await koerper(req), n)); }
        catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
      }
    }

    if (p === '/api/objekt/abschluss' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.abschlussSetzen(await koerper(req), n.login, n.rolle)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/ergebnis' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.ergebnisNeu(await koerper(req), n.login, n.rolle)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/einbehalt' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.einbehaltAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/einbehalt/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.einbehaltStatus(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/streit' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.streitAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/objekt/streit/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.streitEntscheiden(await koerper(req), n.login, n.rolle)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Исходящие счета (§11)
    if (p === '/api/objekt/ausgang' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'счета готовит бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.ausgangAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/ausgang/senden' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'отправляет бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.ausgangSenden(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/ausgang/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const b = await koerper(req);
        const r = await objekt.ausgangStatus(b, n.login);
        if (r.fehler) { try { aufgaben.anlegen({ titel: 'Ошибка отправки исходящего счёта', text: 'Счёт не отправился (тест) — проверить и повторить.', ziel_person: 'buch', art: 'rechnung_fehler', bezug: 'Счёт ' + b.id }, n, nutzerLesen()); } catch (e) {} }
        return jsonAntwort(res, 200, r);
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Напоминания (§12)
    if (p === '/api/objekt/mahnung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.mahnungVorbereiten(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/mahnung/bestaetigen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'подтверждает ответственный за клиента' });
      try { return jsonAntwort(res, 200, await objekt.mahnungBestaetigen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/mahnung/senden' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'отправляет бухгалтерия' });
      try { return jsonAntwort(res, 200, await objekt.mahnungSenden(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/mahnung/loeschen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.mahnungLoeschen(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/zusage' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.zusageSetzen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Распределяемые затраты (§14–§17)
    if (p === '/kostenverteilung') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/kostenverteilung' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'kostenverteilung.html'));
    }
    if (p === '/api/kv/liste') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { posten: await objekt.postenListe(u.searchParams.get('art') || '') }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }
    if (p === '/api/kv/posten') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.postenEins(u.searchParams.get('id'))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/kv/posten-neu' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.postenAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/kv/zuteilen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.verteilungSetzen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/kv/posten-weg' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.postenLoeschen(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Недостатки и требования к подрядчику (§9–10)
    if (p === '/api/objekt/mangel' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.mangelAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/mangel/update' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.mangelUpdate(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Фото (§13)
    if (p === '/api/objekt/foto' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.fotoAnlegen(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/objekt/foto/loeschen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung', 'disponent'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.fotoLoeschen(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Интеграции (§5,§19)
    if (p === '/integrationen') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/integrationen' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'integrationen.html'));
    }
    // Дополнение №6 §4/§5 — проверка кассы (блокировка/сверка/расхождения)
    if (p === '/kassepruefung') {
      const n = wer(req);
      if (!n) { res.writeHead(302, { Location: '/login?next=/kassepruefung' }); return res.end(); }
      if (!['gf', 'buchhaltung'].includes(n.rolle)) { res.writeHead(302, { Location: '/arbeit' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'kassepruefung.html'));
    }
    if (p === '/api/integrationen') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.journalListe(u.searchParams.get('limit'))); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }
    if (p === '/api/integration/ereignis' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await objekt.integrationEreignis(await koerper(req), n.login)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    // Дополнение №6 Ф1–Ф3: состояние источников, устаревание, восстановление
    if (p === '/api/integration/status') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { ...(await integration.statusListe()), ich: { rolle: n.rolle } }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }
    if (p === '/api/integration/meldung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await integration.meldung(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/integration/schwelle' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'порог задаёт владелец' });
      try { return jsonAntwort(res, 200, await integration.schwelleSetzen(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/integration/fehlerlog') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { log: await integration.fehlerlog(u.searchParams.get('quelle') || '', u.searchParams.get('limit')) }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    /* ===== Дополнение №6 Ф6 — офлайн-чеки ===== */
    if (p === '/offline') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/offline' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'offline.html'));
    }
    if (p === '/api/offline/beleg' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await offline.belegEmpfang(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/offline/meine') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const alle = u.searchParams.get('alle') === '1' && ['gf', 'buchhaltung'].includes(n.rolle);
        return jsonAntwort(res, 200, { belege: await offline.meine(n, alle), ich: { login: n.login, name: n.name, rolle: n.rolle } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №6 Ф8 — обязанности сдать чек, напоминания, эскалация ===== */
    if (p === '/pflichten') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/pflichten' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'pflichten.html'));
    }
    if (p === '/api/pflicht' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const nurEigene = !['gf', 'buchhaltung'].includes(n.rolle);
        return jsonAntwort(res, 200, { pflichten: await erinnerung.pflichtListe(n, nurEigene), ich: { login: n.login, name: n.name, rolle: n.rolle } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/pflicht' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'обязанность заводит бухгалтерия или владелец' });
      try { return jsonAntwort(res, 200, await erinnerung.pflichtAnlegen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/pflicht/erledigt' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await erinnerung.pflichtErledigt(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/erinnerung/lauf' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await erinnerung.lauf(await koerper(req))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    /* ===== Дополнение №7 — доступ (только Андрей) и журнал ===== */
    if (p === '/zugang') {
      const n = wer(req);
      if (!n) { res.writeHead(302, { Location: '/login?next=/zugang' }); return res.end(); }
      if (n.rolle !== 'gf') { res.writeHead(302, { Location: '/zentrum' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'zugang.html'));
    }
    if (p === '/api/zugang' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'управление доступом — только у владельца' });
      const liste = nutzerLesen().map(x => ({ login: x.login, name: x.name || x.login, rolle: x.rolle,
        verantwortlich: x.verantwortlich === true, gesperrt: x.gesperrt === true, sess_epoch: Number(x.sess_epoch) || 0,
        objektzugang: x.objektzugang === true }));
      return jsonAntwort(res, 200, { benutzer: liste });
    }
    if (p === '/api/zugang/sperren' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'только владелец' });
      try {
        const b = await koerper(req); const login = String(b.login || '').trim().toLowerCase(); const an = b.an !== false;
        const liste = nutzerLesen(); const ziel = liste.find(x => x.login === login);
        if (!ziel) return jsonAntwort(res, 400, { fehler: 'нет такого логина' });
        if (ziel.login === n.login) return jsonAntwort(res, 400, { fehler: 'нельзя заблокировать себя' });
        const war = ziel.gesperrt === true;
        ziel.gesperrt = an;
        if (an) ziel.sess_epoch = (Number(ziel.sess_epoch) || 0) + 1;   // блокировка также рвёт сеансы
        nutzerSchreiben(liste);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: an ? 'sperre' : 'entsperrt', ziel: 'user:' + login,
          alt: war ? 'заблокирован' : 'активен', neu: an ? 'заблокирован' : 'активен', grund: b.grund });
        return jsonAntwort(res, 200, { ok: true, login, gesperrt: an });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/zugang/sessions' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'только владелец' });
      try {
        const b = await koerper(req); const login = String(b.login || '').trim().toLowerCase();
        const liste = nutzerLesen(); const ziel = liste.find(x => x.login === login);
        if (!ziel) return jsonAntwort(res, 400, { fehler: 'нет такого логина' });
        ziel.sess_epoch = (Number(ziel.sess_epoch) || 0) + 1;   // все прежние токены недействительны
        nutzerSchreiben(liste);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'sessions', ziel: 'user:' + login,
          neu: 'сеансы завершены (epoch ' + ziel.sess_epoch + ')', grund: b.grund });
        return jsonAntwort(res, 200, { ok: true, login, sess_epoch: ziel.sess_epoch });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/audit' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'журнал значимых действий — только у владельца' });
      try { return jsonAntwort(res, 200, { eintraege: await audit.liste({ art: u.searchParams.get('art') || '', q: u.searchParams.get('q') || '' }), arten: audit.ART_T }); }
      catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    /* ===== Дополнение №8 — начальные остатки и правила учёта ===== */
    if (p === '/anfang') {
      const n = wer(req);
      if (!n) { res.writeHead(302, { Location: '/login?next=/anfang' }); return res.end(); }
      if (!['gf', 'buchhaltung'].includes(n.rolle)) { res.writeHead(302, { Location: '/zentrum' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'anfang.html'));
    }
    if (p === '/api/anfang' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        return jsonAntwort(res, 200, { uebersicht: await anfang.uebersicht(), liste: await anfang.liste({ kategorie: u.searchParams.get('kategorie') || '', status: u.searchParams.get('status') || '' }),
          kategorien: anfang.KATEGORIEN, ich: { login: n.login, name: n.name, rolle: n.rolle, verantwortlich: monat.istVerantwortlich(n) } });
      } catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang/eins') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, await anfang.eins(u.searchParams.get('id'))); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { const r = await anfang.anlegen(await koerper(req), n);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'status', ziel: 'anfang:' + r.id, neu: 'начальный остаток заведён', grund: r.kategorie_text });
        return jsonAntwort(res, 200, r); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang/aktualisieren' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { const r = await anfang.aktualisieren(await koerper(req), n);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'betrag', ziel: 'anfang:' + r.id,
          alt: r.alt_cent != null ? (r.alt_cent / 100).toFixed(2) : '—', neu: r.neu_cent != null ? (r.neu_cent / 100).toFixed(2) : '—', grund: 'уточнение начального остатка' });
        return jsonAntwort(res, 200, r); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang/klaerung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await anfang.klaerung(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang/bestaetigen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { const r = await anfang.bestaetigen(await koerper(req), n);
        if (!r.unchanged) await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'status', ziel: 'anfang:' + r.id, neu: 'подтверждён начальный остаток', grund: r.bezeichnung });
        return jsonAntwort(res, 200, r); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/anfang/tilgung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await anfang.tilgung(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/einstellung' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try { return jsonAntwort(res, 200, { einstellungen: await anfang.einstellungListe() }); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/einstellung' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { const r = await anfang.einstellungSetzen(await koerper(req), n);
        await audit.schreiben({ wer: n.login, rolle: n.rolle, art: 'status', ziel: 'einstellung:' + r.schluessel, neu: 'настройка v' + r.version + ' (' + r.status + ')' });
        return jsonAntwort(res, 200, r); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }
    if (p === '/api/einstellung/bestaetigen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, await anfang.einstellungBestaetigen(await koerper(req), n)); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    if (p === '/api/bestaetigen') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const offen = aufgaben.offeneNachArt('beleg_pruef');
        if (!offen.length) return jsonAntwort(res, 200, { leer: true });
        const task = offen[0];
        const ids = new Set((task.posten || []).map(String));
        const alle = (await belegAlle()).filter(d => ids.has(String(d.drive_id)));
        const byId = {}; alle.forEach(d => { byId[String(d.drive_id)] = d; });
        const docs = (task.posten || []).map(id => byId[String(id)]).filter(Boolean);
        return jsonAntwort(res, 200, { task: { id: task.id, titel: task.titel }, docs });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/beleg/pruef' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      const b = await koerper(req);
      const drive_id = String(b.drive_id || '');
      if (!/^[A-Za-z0-9_-]{10,}$/.test(drive_id)) return jsonAntwort(res, 400, { fehler: 'плохой drive_id' });
      // документ должен входить в открытую партию проверки
      const offen = aufgaben.offeneNachArt('beleg_pruef');
      const inTask = offen.some(t => (t.posten || []).map(String).includes(drive_id));
      if (!inTask) return jsonAntwort(res, 400, { fehler: 'документ вне открытой партии' });
      const neuStatus = b.aktion === 'ablehnen' ? 'abgelehnt' : 'bestaetigt';
      const k = b.korrektur || {};
      const TYPEN = ['rechnung', 'mahnung', 'storno', 'gutschrift', 'lieferschein', 'angebot', 'sonstiges'];
      const QUELLEN = ['ausgang', 'eingang'];
      const sets = ['status = $2', 'geprueft_von = $3', 'geprueft_am = now()', 'geaendert_am = now()'];
      const vals = [drive_id, neuStatus, n.login];
      let idx = 4;
      if (typeof k.typ === 'string' && TYPEN.includes(k.typ)) { sets.push('typ = $' + idx++); vals.push(k.typ); }
      if (typeof k.quelle === 'string' && QUELLEN.includes(k.quelle)) { sets.push('quelle = $' + idx++); vals.push(k.quelle); }
      if (k.betrag_cent !== undefined && k.betrag_cent !== null && k.betrag_cent !== '' && Number.isFinite(Number(k.betrag_cent))) {
        sets.push('betrag_cent = $' + idx++); vals.push(Math.round(Number(k.betrag_cent)));
      }
      if (typeof k.belegdatum === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k.belegdatum)) { sets.push('belegdatum = $' + idx++); vals.push(k.belegdatum); }
      if (k.doc_nr !== undefined) { sets.push('doc_nr = $' + idx++); vals.push(String(k.doc_nr || '').slice(0, 60) || null); }
      if (k.kontrahent !== undefined) { sets.push('kontrahent = $' + idx++); vals.push(String(k.kontrahent || '').slice(0, 200) || null); }
      if (b.notiz !== undefined) { sets.push('pruef_notiz = $' + idx++); vals.push(String(b.notiz || '').slice(0, 400) || null); }
      const url = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
      const cl = new (require('pg').Client)({ connectionString: url });
      try {
        await cl.connect();
        const r = await cl.query('UPDATE import_dokument SET ' + sets.join(', ') + ' WHERE drive_id = $1 RETURNING status', vals);
        if (!r.rowCount) return jsonAntwort(res, 404, { fehler: 'документ не найден' });
        return jsonAntwort(res, 200, { ok: true, status: r.rows[0].status });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
      finally { try { await cl.end(); } catch (e) {} }
    }

    if (p === '/verteilen') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/verteilen' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'verteilen.html'));
    }

    if (p === '/api/verteilen') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        const offen = aufgaben.offeneNachArt('razn_charge');
        if (!offen.length) return jsonAntwort(res, 200, { leer: true });
        const task = offen[0];
        const ids = new Set((task.posten || []).map(String));
        const alle = (await razn.operationen(400)).filter(o => String(o.datum || '').startsWith(CHARGE_MONAT) && ids.has(String(o.id)));
        const byId = {}; alle.forEach(o => { byId[String(o.id)] = o; });
        const ops = (task.posten || []).map(id => byId[String(id)]).filter(Boolean);
        const docs = await janDocs();
        let zu = new Map();
        try {
          const rows = await razn.mitBase(q => q('SELECT quelle_id, objekt, kategorie, grund FROM ' + razn.SCHEMA
            + 'buch_zuordnung WHERE quelle = $1', ['finmap']));
          zu = new Map(rows.map(r => [String(r.quelle_id), r]));
        } catch (e) { zu = new Map(); }
        const objekte = await razn.objekte();
        const kategorien = await razn.kategorien();
        return jsonAntwort(res, 200, {
          task: { id: task.id, titel: task.titel },
          objekte, kategorien,
          ops: ops.map(o => ({
            id: String(o.id), datum: o.datum, betrag: o.betrag, typ: o.typ, partner: o.partner,
            fm_kategorie: o.fm_kategorie, fm_projekt: o.fm_projekt, fm_tag: o.fm_tag, konto: o.konto, kommentar: o.kommentar,
            belege: belegeFuerOp(o, docs), zuordnung: zu.get(String(o.id)) || null,
          })),
        });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }
    if (p === '/api/aufgaben/bearbeiten' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try { return jsonAntwort(res, 200, aufgaben.bearbeiten(await koerper(req), n, nutzerLesen())); }
      catch (e) { return jsonAntwort(res, 400, { fehler: e.message }); }
    }

    // Новым ролям классические API не открываются никогда.
    if (p.startsWith('/api/') && p !== '/api/login' && p !== '/api/logout') {
      const n = wer(req);
      if (n && NUR_KASSE.includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'этой роли доступна только касса' });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const brauser = String(req.headers['user-agent'] || '');
      const liste = nutzerLesen();
      if (!liste.length) return jsonAntwort(res, 503, { fehler: 'На сервере нет ни одного пользователя.' });
      const { login, pin } = await koerper(req);
      const eingabe = String(login || '').trim().toLowerCase();
      const glatt = w => String(w || '').toLowerCase().replace(/[\s.\-_]/g, '');
      const e2 = glatt(eingabe);
      const n = liste.find(x => glatt(x.login) === e2
        || (x.aliase || []).some(a => glatt(a) === e2));
      let passt = false;
      if (n) {
        const kandidat = crypto.scryptSync(String(pin || ''), Buffer.from(n.salz, 'hex'), 32);
        passt = crypto.timingSafeEqual(kandidat, Buffer.from(n.hash, 'hex'));
      } else {
        crypto.scryptSync(String(pin || ''), crypto.randomBytes(16), 32);   // ровное время ответа
      }
      const schluessel = ip + '|' + eingabe;
      if (gesperrt(schluessel)) {
        zugangNotiz(ip, eingabe, 'заперт', brauser);
        return jsonAntwort(res, 429, { fehler: 'Слишком много попыток. Подождите 15 минут.' });
      }
      if (!passt) {
        fehlversuch(schluessel);
        zugangNotiz(ip, eingabe, n ? 'неверный ПИН' : 'нет такого логина', brauser);
        return jsonAntwort(res, 401, { fehler: n ? 'ПИН не подошёл' : 'Такого логина нет' });
      }
      versuche.delete(schluessel);
      if (n.gesperrt === true) {   // §8 блокировка: вход запрещён, пока не снята
        zugangNotiz(ip, eingabe, 'заблокирован: ' + n.login, brauser);
        return jsonAntwort(res, 403, { fehler: 'Доступ заблокирован. Обратитесь к владельцу.' });
      }
      zugangNotiz(ip, eingabe, 'вошёл: ' + n.login, brauser);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `vavsess=${tokenBauen(n.login, n.sess_epoch)}; Path=/; HttpOnly; SameSite=Lax${process.env.BUCH_LOKAL_HTTP === '1' ? '' : '; Secure'}; Max-Age=${TAGE * 86400}` });
      return res.end('{"ok":true}');
    }

    if (p === '/api/logout') {
      // Только известная цель возврата — без открытого перенаправления.
      const ziel = u.searchParams.get('next') === '/arbeit' ? '/login?next=/arbeit' : '/login';
      res.writeHead(302, { Location: ziel, 'Set-Cookie': 'vavsess=; Path=/; HttpOnly; Max-Age=0' });
      return res.end();
    }

    if (p === '/login') return dateiAntwort(res, path.join(OEFF, 'login.html'));

    if (p === '/api/daten') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const lv = await live.lade(schnappschuesse);
      const daten = { ...schnappschuesse, ...(lv.daten || {}) };
      const erlaubt = n.rechte.docs;
      const gefiltert = erlaubt ? Object.fromEntries(Object.entries(daten).filter(([k]) => erlaubt.includes(k))) : daten;
      let aktiv = null;
      try { aktiv = JSON.parse(fs.readFileSync(path.join(DATA, 'module.json'), 'utf8')).aktiv; } catch (e) { /* все разделы */ }
      let start = '';
      try { start = fs.readFileSync(path.join(DATA, 'start'), 'utf8').trim(); } catch (e) { /* не задана */ }
      return jsonAntwort(res, 200, {
        start,
        daten: gefiltert,
        state,
        benutzer: { login: n.login, name: n.name, rolle: n.rolle, rollenname: n.rechte.name,
          tabs: Array.isArray(aktiv) ? n.rechte.tabs.filter(t => aktiv.includes(t)) : n.rechte.tabs },
        live: lv.daten ? { ok: true, stand: new Date(lv.zeit).toISOString() } : { ok: false, grund: lv.fehler },
      });
    }

    if (p === '/api/state' && req.method === 'PUT') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const { collection, id, wert } = await koerper(req);
      if (!/^[a-z_]{1,40}$/.test(String(collection || '')) || !String(id || '').length)
        return jsonAntwort(res, 400, { fehler: 'плохой адрес записи' });
      const nurOffice = ['zuordnung', 'entscheidungen', 'partner_daten'];
      if (n.rolle === 'buero' && !nurOffice.includes(collection))
        return jsonAntwort(res, 403, { fehler: 'этой роли сюда писать нельзя' });
      state[collection] = state[collection] || {};
      if (wert === null || wert === undefined) delete state[collection][id];
      else state[collection][id] = { ...wert, von: n.login };
      sichern();
      return jsonAntwort(res, 200, { ok: true });
    }


    if (p === '/api/razn') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        let tage = Math.min(400, Math.max(7, Number(u.searchParams.get('tage')) || 400));
        const modus = u.searchParams.get('modus') === 'audit' ? 'audit' : 'neu';
        const monat = /^\d{4}-\d{2}$/.test(String(u.searchParams.get('monat') || ''))
          ? u.searchParams.get('monat') : '';
        if (monat) {
          // при выборе месяца автоматически углубляем выборку FinMap, чтобы дотянуться до него
          const bisMonat = Math.ceil((Date.now() - new Date(monat + '-01T00:00:00Z').getTime()) / 86400000) + 40;
          tage = Math.min(400, Math.max(tage, bisMonat));
        }
        const w = await razn.warteschlange(tage, modus, monat);
        const objekte = await razn.objekte();
        const kategorien = await razn.kategorien();
        return jsonAntwort(res, 200, Object.assign({ objekte, kategorien }, w));
      } catch (e) {
        return jsonAntwort(res, 502, { fehler: e.message });
      }
    }

    if (p === '/api/razn/setzen' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const b = await koerper(req);
      try {
        const r = b.loeschen ? await razn.loeschen(b.id)
          : await razn.setze(b.id, { objekt: b.objekt, kategorie: b.kategorie,
              grund: b.grund, schluessel: b.schluessel }, n.login);
        return jsonAntwort(res, 200, r);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }

    if (p === '/api/razn/teil' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const b = await koerper(req);
      try {
        const r = b.loeschen
          ? await razn.teilLoeschen(b.teil_id)
          : await razn.teilSetzen(b.id, { objekt: b.objekt, kategorie: b.kategorie,
              betrag: b.betrag, grund: b.grund, schluessel: b.schluessel }, n.login);
        return jsonAntwort(res, 200, r);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }

    if (p === '/api/razn/objekt-neu' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const b = await koerper(req);
      try {
        const r = await razn.objektAnlegen(b, n.login);
        return jsonAntwort(res, 200, r);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }

    if (p === '/api/razn/stichtag' && req.method === 'POST') {
      const n = wer(req);
      if (!n || n.rolle !== 'gf') return jsonAntwort(res, 403, { fehler: 'дату отсечки меняет только владелец' });
      const b = await koerper(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.stichtag || ''))) return jsonAntwort(res, 400, { fehler: 'дата в формате ГГГГ-ММ-ДД' });
      const v = await razn.einstellung('stichtag', b.stichtag);
      return jsonAntwort(res, 200, { ok: true, stichtag: v });
    }


    if (p === '/api/razn/original') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const mail = String(u.searchParams.get('mail') || '');
      const dId = String(u.searchParams.get('drive') || '');
      if (!/^[0-9]+$/.test(mail) || !/^[A-Za-z0-9_-]{10,}$/.test(dId))
        return jsonAntwort(res, 400, { fehler: 'плохие параметры' });
      try {
        const rows = await razn.mitBase(q => q('SELECT drive_file_ids FROM '
          + razn.SCHEMA + 'mail_items WHERE id = $1', [mail]));
        const erlaubt = rows.length && (rows[0].drive_file_ids || []).includes(dId);
        if (!erlaubt) return jsonAntwort(res, 404, { fehler: 'документ не найден' });
        const meta = await drive.beschreibung(dId);
        const ant = await drive.inhalt(dId);
        if (!ant.ok) return jsonAntwort(res, 502, { fehler: 'Drive ' + ant.status });
        const buf = Buffer.from(await ant.arrayBuffer());
        const name = (meta && meta.name) || 'beleg';
        res.writeHead(200, {
          'Content-Type': (meta && meta.mimeType) || 'application/octet-stream',
          'Content-Length': buf.length,
          'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(name),
          'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff'
        });
        return res.end(buf);
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/objekt-akte') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const d = await akteModul.akte(u.searchParams.get('nr'));
        return jsonAntwort(res, 200, d);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }

    if (p === '/api/recht') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const tage = Math.min(400, Math.max(30, Number(u.searchParams.get('tage')) || 180));
        const f = await recht.fristen(tage);
        const anwalt = await recht.anwaltsliste(tage);
        return jsonAntwort(res, 200, Object.assign({ anwalt }, f));
      } catch (e) {
        return jsonAntwort(res, 502, { fehler: e.message });
      }
    }

    if (p === '/api/recht/status' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const b = await koerper(req);
      try {
        const r = await recht.setzeStatus(b.schluessel, b.status, b.notiz, n.login);
        return jsonAntwort(res, 200, r);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }


    if (p === '/api/hinweis' && req.method === 'POST') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        const b = await koerperGross(req, 6e6);
        const r = await hinweis.anlegen(b, n);
        return jsonAntwort(res, 200, r);
      } catch (e) {
        return jsonAntwort(res, 400, { fehler: e.message });
      }
    }

    if (p === '/api/hinweis' && req.method === 'GET') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      try {
        return jsonAntwort(res, 200, { liste: await hinweis.liste(n) });
      } catch (e) {
        return jsonAntwort(res, 502, { fehler: e.message });
      }
    }

    if (p.startsWith('/api/hinweis/bild/')) {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      const b = hinweis.bildLesen(p.slice('/api/hinweis/bild/'.length));
      if (!b) { res.writeHead(404); return res.end(); }
      const buf = fs.readFileSync(b.pfad);
      res.writeHead(200, { 'Content-Type': b.typ, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' });
      return res.end(buf);
    }

    if (p === '/arbeit') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/arbeit' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'arbeit.html'));
    }

    if (p === '/zentrum') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/zentrum' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'zentrum.html'));
    }

    if (p === '/dokumente') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/dokumente' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'dokumente.html'));
    }

    if (p === '/aufgaben') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/aufgaben' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'aufgaben.html'));
    }

    if (p === '/zahlungen') {
      if (!wer(req)) { res.writeHead(302, { Location: '/login?next=/zahlungen' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'zahlungen.html'));
    }

    if (p === '/api/zahlungen') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      try {
        let tage = Math.min(400, Math.max(3, Number(u.searchParams.get('tage')) || 30));
        const monat = /^\d{4}-\d{2}$/.test(String(u.searchParams.get('monat') || '')) ? u.searchParams.get('monat') : '';
        if (monat) {
          const bisMonat = Math.ceil((Date.now() - new Date(monat + '-01T00:00:00Z').getTime()) / 86400000) + 40;
          tage = Math.min(400, Math.max(tage, bisMonat));
        }
        let ops = await razn.operationen(tage);
        if (monat) {
          ops = ops.filter(o => String(o.datum || '').startsWith(monat));
        } else {
          const grenze = new Date(Date.now() - tage * 86400000).toISOString().slice(0, 10);
          ops = ops.filter(o => String(o.datum || '') >= grenze);
        }
        return jsonAntwort(res, 200, { stand: new Date().toISOString(), tage, monat, quelle: 'FinMap', ops });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
    }

    if (p === '/api/dokumente') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа' });
      const url = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
      const cl = new (require('pg').Client)({ connectionString: url });
      try {
        await cl.connect();
        const monat = /^\d{4}-\d{2}$/.test(u.searchParams.get('monat') || '') ? u.searchParams.get('monat') : '2026-01';
        const rows = (await cl.query(
          `SELECT drive_id, einheit, quelle, dateiname, ext, typ, doc_nr, betrag_cent, belegdatum,
                  kontrahent, netto_cent, ust_cent, erkannt, periode_ok, pruef_grund, status, dubl_von, groesse
           FROM import_dokument WHERE monat=$1
           ORDER BY quelle, doc_nr NULLS LAST, dateiname`, [monat])).rows;
        return jsonAntwort(res, 200, { monat, dateien: rows });
      } catch (e) { return jsonAntwort(res, 502, { fehler: e.message }); }
      finally { try { await cl.end(); } catch (e) {} }
    }

    if (p === '/') {
      const n = wer(req);
      if (!n) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      if (NUR_KASSE.includes(n.rolle)) { res.writeHead(302, { Location: '/arbeit' }); return res.end(); }
      res.writeHead(302, { Location: '/zentrum' }); return res.end();
    }

    if (p === '/index.html') {
      const n = wer(req);
      if (!n) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      if (NUR_KASSE.includes(n.rolle)) { res.writeHead(302, { Location: '/arbeit' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'index.html'));
    }

    const sicher = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const datei = path.join(OEFF, sicher);
    if (datei.startsWith(OEFF) && fs.existsSync(datei) && fs.statSync(datei).isFile()) {
      return dateiAntwort(res, datei, /\.(png|ico|svg)$/.test(datei) ? 'public, max-age=604800' : null);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('нет такой страницы');
  } catch (e) {
    console.error('запрос упал:', p, e.message);
    jsonAntwort(res, 500, { fehler: 'сервер не справился с запросом' });
  }
}).listen(PORT, '127.0.0.1', () => console.log('Buchhalter слушает 127.0.0.1:' + PORT));
