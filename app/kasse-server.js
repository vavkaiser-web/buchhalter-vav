/* ---------------------------------------------------------------
   Касса VAV — самостоятельный сервер.
   Работает независимо от Buchhalter VAV на отдельном порту.
   Разделяет базу данных и, опционально, файл пользователей с Buchhalter.
   Не импортирует live.js, razn.js, akte.js — только кассовый модуль.
   ---------------------------------------------------------------- */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const kasse = require('./kasse/api.js');
const integration = require('./kasse/integratsiya.js');

const PORT  = Number(process.env.KASSE_PORT || 3127);
const WURZEL = path.dirname(__filename);
const OEFF  = path.join(WURZEL, 'public');

/* DATA — либо своя папка, либо общая с Buchhalter через переменную среды */
const DATA = process.env.KASSE_DATA || process.env.BUCH_DATA || path.join(WURZEL, 'kasse-data');
const NUTZER = path.join(DATA, 'benutzer.json');
const SECRET = path.join(DATA, 'kasse-secret');
const ZUGANG = path.join(DATA, 'kasse-zugang.log');

fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(SECRET)) fs.writeFileSync(SECRET, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const geheim = fs.readFileSync(SECRET, 'utf8').trim();

/* ---------- пользователи ---------- */
function nutzerLesen() {
  try { return JSON.parse(fs.readFileSync(NUTZER, 'utf8')); } catch (e) { return []; }
}

/* ---------- сессии (30 дней) ---------- */
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
const keks = req => Object.fromEntries(
  (req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; })
);
function wer(req) {
  const login = tokenLesen(keks(req).kassesess || keks(req).vavsess);
  if (!login) return null;
  const n = nutzerLesen().find(x => x.login === login);
  return n || null;
}

/* ---------- защита от подбора ---------- */
const versuche = new Map();
const gesperrt = k => { const v = versuche.get(k); return v && v.bis > Date.now(); };
function fehlversuch(k) {
  const v = versuche.get(k) || { n: 0, bis: 0 };
  v.n++; if (v.n >= 5) { v.bis = Date.now() + 15 * 60000; v.n = 0; }
  versuche.set(k, v);
}

/* ---------- вспомогательное ---------- */
const TYPEN = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function lokal() { return process.env.KASSE_LOKAL_HTTP === '1'; }

function jsonAntwort(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function dateiAntwort(res, datei, cache) {
  fs.readFile(datei, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('не найдено'); }
    res.writeHead(200, {
      'Content-Type': TYPEN[path.extname(datei)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': cache || 'no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    res.end(buf);
  });
}
function koerper(req) {
  return new Promise((ok, fehler) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 1e6) { req.destroy(); fehler(new Error('слишком много')); } s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fehler(e); } });
  });
}

/* ---------- журнал входов ---------- */
function zugangNotiz(ip, eingabe, ergebnis) {
  const z = [new Date().toISOString(), ip, JSON.stringify(String(eingabe || '')), ergebnis].join('\t') + '\n';
  fs.appendFile(ZUGANG, z, e => e && console.error('журнал входа:', e.message));
}

/* ---------- страница invite ---------- */
function inviteHtml(fehler, token, name) {
  const titel = fehler ? 'Ссылка недействительна' : `Добро пожаловать, ${name || ''}`;
  const form = fehler ? `<p class="err">${fehler}</p>` : `
    <p>Придумайте ПИН для входа в Кассу VAV.</p>
    <form id="f">
      <label>ПИН<input type="password" name="pin" inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" autofocus required placeholder="минимум 4 цифры"></label>
      <label>Повторите ПИН<input type="password" name="pin2" inputmode="numeric" pattern="\\d{4,8}" minlength="4" maxlength="8" required placeholder="ещё раз"></label>
      <button type="submit">Установить ПИН и войти</button>
      <p id="err" style="color:#c00;display:none"></p>
    </form>
    <script>
    document.getElementById('f').onsubmit = async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button');
      const errEl = document.getElementById('err');
      errEl.style.display='none';
      if (d.pin !== d.pin2) { errEl.textContent='ПИН не совпадает'; errEl.style.display='block'; return; }
      btn.disabled = true; btn.textContent = 'Сохраняем…';
      try {
        const r = await fetch('/api/invite/${token}/aktivieren', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
        const j = await r.json();
        if (!r.ok) { errEl.textContent=j.fehler||'Ошибка'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Установить ПИН и войти'; return; }
        window.location.href='/kasse/';
      } catch(err) { errEl.textContent='Нет соединения'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Установить ПИН и войти'; }
    };
    </script>`;
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Касса VAV — Приглашение</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:#fff;border-radius:12px;padding:32px;width:100%;max-width:360px;box-shadow:0 2px 12px #0002}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}
    .logo-icon{width:36px;height:36px;background:#2c4a6b;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px}
    h1{font-size:1.1rem;font-weight:600;color:#1a2e44;margin-bottom:16px}
    p{color:#555;font-size:.95rem;margin-bottom:16px}
    label{display:block;margin-bottom:14px;font-size:.9rem;color:#333;font-weight:500}
    input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #ccc;border-radius:8px;font-size:1rem;outline:none}
    input:focus{border-color:#2c4a6b}
    button{width:100%;padding:12px;background:#2c4a6b;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;margin-top:8px}
    button:disabled{opacity:.6}
    .err{color:#c00;font-size:.9rem;margin-top:8px}
  </style>
</head><body>
  <div class="card">
    <div class="logo"><div class="logo-icon">₽</div><strong>КАССА VAV</strong></div>
    <h1>${titel}</h1>
    ${form}
  </div>
</body></html>`;
}

/* ---------- роли, допущенные в Кассу VAV ---------- */
const ROLLEN_KASSE = ['gf', 'buchhaltung', 'disponent', 'mitarbeiter'];

/* ---------- сервер ---------- */
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress || '?');

  try {
    // Интеграционный API — Bearer-токен, без сессии пользователя.
    if (p.startsWith('/api/integration/')) {
      return void await integration.handle(req, res, u);
    }

    // Кассовый API — сессионная аутентификация.
    if (p.startsWith('/api/k/')) {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      if (!ROLLEN_KASSE.includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет доступа к кассе' });
      return void await kasse.handle(req, res, u, n, { benutzer: nutzerLesen() });
    }

    // Текущий пользователь.
    if (p === '/api/ich') {
      const n = wer(req);
      if (!n) return jsonAntwort(res, 401, { fehler: 'нет сессии' });
      return jsonAntwort(res, 200, { login: n.login, rolle: n.rolle, name: n.name });
    }

    // Список сотрудников — только для бухгалтерии и владельца.
    if (p === '/api/benutzer' && req.method === 'GET') {
      const n = wer(req);
      if (!n || !['gf', 'buchhaltung'].includes(n.rolle)) return jsonAntwort(res, 403, { fehler: 'нет прав' });
      const liste = nutzerLesen().filter(x => ROLLEN_KASSE.includes(x.rolle))
        .map(({ login, name, rolle, kurzname, person }) => ({ login, name, rolle, kurzname, person }));
      return jsonAntwort(res, 200, { liste });
    }

    // Вход.
    if (p === '/api/login' && req.method === 'POST') {
      const liste = nutzerLesen();
      if (!liste.length) return jsonAntwort(res, 503, { fehler: 'Нет пользователей.' });
      const { login, pin } = await koerper(req);
      const eingabe = String(login || '').trim().toLowerCase();
      const n = liste.find(x => x.login === eingabe);
      let passt = false;
      const schluessel = ip + '|' + eingabe;
      if (gesperrt(schluessel)) {
        zugangNotiz(ip, eingabe, 'заперт');
        return jsonAntwort(res, 429, { fehler: 'Слишком много попыток. Подождите 15 минут.' });
      }
      if (n) {
        const kandidat = crypto.scryptSync(String(pin || ''), Buffer.from(n.salz, 'hex'), 32);
        passt = crypto.timingSafeEqual(kandidat, Buffer.from(n.hash, 'hex'));
      } else {
        crypto.scryptSync(String(pin || ''), crypto.randomBytes(16), 32);
      }
      if (!passt) {
        fehlversuch(schluessel);
        zugangNotiz(ip, eingabe, n ? 'неверный ПИН' : 'нет логина');
        return jsonAntwort(res, 401, { fehler: n ? 'ПИН не подошёл' : 'Такого логина нет' });
      }
      versuche.delete(schluessel);
      if (!ROLLEN_KASSE.includes(n.rolle)) {
        zugangNotiz(ip, eingabe, 'нет роли кассы');
        return jsonAntwort(res, 403, { fehler: 'Этот логин не имеет доступа к Кассе VAV.' });
      }
      zugangNotiz(ip, eingabe, 'вошёл');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `kassesess=${tokenBauen(n.login)}; Path=/; HttpOnly; SameSite=Lax${lokal() ? '' : '; Secure'}; Max-Age=${TAGE * 86400}`,
      });
      return res.end('{"ok":true}');
    }

    // Выход.
    if (p === '/api/logout') {
      res.writeHead(302, { Location: '/kasse/login', 'Set-Cookie': 'kassesess=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax' });
      return res.end();
    }

    // Invite: установка PIN по одноразовой ссылке.
    if (p.startsWith('/kasse/invite/') && req.method === 'GET') {
      const token = p.slice('/kasse/invite/'.length).split('/')[0];
      const liste = nutzerLesen();
      const n = liste.find(x => x.invite_token === token);
      if (!token || !n || (n.invite_bis && n.invite_bis < Date.now())) {
        const html = inviteHtml('Ссылка недействительна или истекла.', null, null);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      const html = inviteHtml(null, token, n.name || n.kurzname || n.login);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (p.startsWith('/api/invite/') && p.endsWith('/aktivieren') && req.method === 'POST') {
      const token = p.slice('/api/invite/'.length).replace('/aktivieren', '');
      const { pin, pin2 } = await koerper(req);
      if (!pin || String(pin) !== String(pin2))
        return jsonAntwort(res, 400, { fehler: 'ПИН не совпадает' });
      if (String(pin).length < 4)
        return jsonAntwort(res, 400, { fehler: 'ПИН должен быть не менее 4 цифр' });
      if (!/^\d+$/.test(String(pin)))
        return jsonAntwort(res, 400, { fehler: 'ПИН должен состоять только из цифр' });
      const liste = nutzerLesen();
      const idx = liste.findIndex(x => x.invite_token === token);
      if (idx === -1 || (liste[idx].invite_bis && liste[idx].invite_bis < Date.now()))
        return jsonAntwort(res, 410, { fehler: 'Ссылка недействительна или истекла' });
      const n = liste[idx];
      const salz = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(String(pin), Buffer.from(salz, 'hex'), 32).toString('hex');
      delete liste[idx].invite_token;
      delete liste[idx].invite_bis;
      liste[idx].salz = salz;
      liste[idx].hash = hash;
      fs.writeFileSync(NUTZER, JSON.stringify(liste, null, 2));
      zugangNotiz(ip, n.login, 'пин установлен через invite');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `kassesess=${tokenBauen(n.login)}; Path=/; HttpOnly; SameSite=Lax${lokal() ? '' : '; Secure'}; Max-Age=${TAGE * 86400}`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // PWA Касса VAV: корень → редирект.
    if (p === '/' || p === '') {
      res.writeHead(302, { Location: '/kasse/' });
      return res.end();
    }

    // Корневые ресурсы: иконки, vendor, корневой manifest.
    if (/^\/(icon-[^/]+\.(png|ico)|vendor\/[^/]+|manifest\.webmanifest)$/.test(p)) {
      const teil = p.slice(1);
      const datei = path.resolve(OEFF, teil);
      if (!datei.startsWith(OEFF + path.sep) && datei !== OEFF) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(datei)) { res.writeHead(404); return res.end('не найдено'); }
      return dateiAntwort(res, datei, teil.match(/\.(png|ico|woff2)$/) ? 'public, max-age=604800' : undefined);
    }

    // Статические файлы /kasse/*.
    if (p.startsWith('/kasse/')) {
      const teil = p.slice('/kasse/'.length) || 'index.html';
      // Защита от path traversal.
      const sicher = path.normalize(teil).replace(/^(\.\.\/|\.\.\\)+/, '');
      const datei = path.join(OEFF, 'kasse', sicher);
      if (!datei.startsWith(path.join(OEFF, 'kasse'))) {
        res.writeHead(403); return res.end();
      }
      // Для SPA — все неизвестные пути отдают index.html.
      const existiert = fs.existsSync(datei) && fs.statSync(datei).isFile();
      if (!existiert) return dateiAntwort(res, path.join(OEFF, 'kasse', 'index.html'));
      return dateiAntwort(res, datei, teil.match(/\.(png|ico|woff2)$/) ? 'public, max-age=604800' : undefined);
    }

    // Файлы загруженных документов (фото чеков).
    if (p.startsWith('/api/k/datei/')) {
      const n = wer(req);
      const kasse_mod = require('./kasse/api.js');
      return void await kasse_mod.handle(req, res, u, n, { benutzer: nutzerLesen() });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('не найдено');

  } catch (e) {
    console.error(req.method, p, e.message);
    if (!res.headersSent) jsonAntwort(res, e.status || 500, { fehler: e.message || 'ошибка' });
  }

}).listen(PORT, '127.0.0.1', () => {
  console.log('Касса VAV слушает 127.0.0.1:' + PORT);
  require('./kasse/auto-import.js').starten();
});
