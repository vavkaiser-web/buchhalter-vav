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
function tokenBauen(login) {
  const bis = Date.now() + TAGE * 864e5;
  const nutz = Buffer.from(login).toString('base64url');
  const sig = crypto.createHmac('sha256', geheim).update(bis + '.' + nutz).digest('hex').slice(0, 32);
  return `${bis}.${nutz}.${sig}`;
}
function tokenLesen(t) {
  if (!t) return null;
  const teile = String(t).split('.');
  if (teile.length !== 3) return null;
  const [bis, nutz, sig] = teile;
  if (!/^\d+$/.test(bis) || Number(bis) < Date.now()) return null;
  const soll = crypto.createHmac('sha256', geheim).update(bis + '.' + nutz).digest('hex').slice(0, 32);
  const a = Buffer.from(String(sig).padEnd(32, '0').slice(0, 32));
  if (!crypto.timingSafeEqual(a, Buffer.from(soll))) return null;
  try { return Buffer.from(nutz, 'base64url').toString('utf8'); } catch (e) { return null; }
}
const keks = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
  .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));
function wer(req) {
  const login = tokenLesen(keks(req).vavsess);
  if (!login) return null;
  const n = nutzerLesen().find(x => x.login === login);
  if (!n) return null;
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
      zugangNotiz(ip, eingabe, 'вошёл: ' + n.login, brauser);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `vavsess=${tokenBauen(n.login)}; Path=/; HttpOnly; SameSite=Lax${process.env.BUCH_LOKAL_HTTP === '1' ? '' : '; Secure'}; Max-Age=${TAGE * 86400}` });
      return res.end('{"ok":true}');
    }

    if (p === '/api/logout') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'vavsess=; Path=/; HttpOnly; Max-Age=0' });
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
        const tage = Math.min(400, Math.max(7, Number(u.searchParams.get('tage')) || 120));
        const modus = u.searchParams.get('modus') === 'audit' ? 'audit' : 'neu';
        const monat = /^\d{4}-\d{2}$/.test(String(u.searchParams.get('monat') || ''))
          ? u.searchParams.get('monat') : '';
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
      if (!wer(req)) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return dateiAntwort(res, path.join(OEFF, 'arbeit.html'));
    }

    if (p === '/' || p === '/index.html') {
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
