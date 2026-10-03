#!/usr/bin/env node
/* Тест автономного сервера Касса VAV (kasse-server.js).
   Запускает сервер на тестовом порту, проверяет базовые маршруты.
   Не использует реальную базу — только HTTP-маршруты сервера.
*/
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log('✓', label); pass++; } else { console.error('✗', label); fail++; } }

// Временная директория данных.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-test-'));
process.env.KASSE_DATA = tmpDir;
process.env.KASSE_PORT = '13129';
process.env.KASSE_LOKAL_HTTP = '1';
// Без реальной DB — интеграция отключена.
process.env.KASSE_INTEGRATION_TOKEN = '';

// Создаём тестового пользователя.
const salz = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('1234', Buffer.from(salz, 'hex'), 32).toString('hex');
fs.writeFileSync(path.join(tmpDir, 'benutzer.json'), JSON.stringify([
  { login: 'testbuch', name: 'Тест Бухгалтер', rolle: 'buchhaltung', salz, hash },
  { login: 'testma', name: 'Тест МА', rolle: 'mitarbeiter', salz, hash },
  { login: 'testgast', name: 'Тест Гость', rolle: 'buero', salz, hash },
]));

function req(methode, pfad, body, cookie) {
  return new Promise((ok, err) => {
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port: 13129, method: methode, path: pfad,
      headers: { 'Content-Type': 'application/json', ...(b ? {'Content-Length': b.length} : {}), ...(cookie ? { Cookie: cookie } : {}) } },
      res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          let j; try { j = JSON.parse(d); } catch (e) { j = d; }
          ok({ status: res.statusCode, headers: res.headers, body: j });
        });
      });
    r.on('error', err);
    if (b) r.write(b);
    r.end();
  });
}

// Ждём запуска сервера.
function warten(ms) { return new Promise(ok => setTimeout(ok, ms)); }

async function run() {
  // Загружаем сервер.
  require(path.join(__dirname, '../../app/kasse-server.js'));
  await warten(300);

  // 1. Главный редирект.
  const red = await req('GET', '/');
  ok('GET / → редирект на /kasse/', red.status === 302 && red.headers.location === '/kasse/');

  // 2. Вход с верными данными.
  const loginOk = await req('POST', '/api/login', { login: 'testbuch', pin: '1234' });
  ok('POST /api/login → 200 для buchhaltung', loginOk.status === 200 && loginOk.body.ok === true);
  const cookie = loginOk.headers['set-cookie']?.[0]?.split(';')?.[0];
  ok('Cookie kassesess установлен', cookie?.startsWith('kassesess='));

  // 3. Вход с неверным ПИН.
  const loginErr = await req('POST', '/api/login', { login: 'testbuch', pin: '0000' });
  ok('POST /api/login → 401 при неверном ПИН', loginErr.status === 401);

  // 4. Роль buero не получает доступ к кассе.
  const loginGast = await req('POST', '/api/login', { login: 'testgast', pin: '1234' });
  ok('POST /api/login → 403 для роли buero', loginGast.status === 403);

  // 5. /api/ich без сессии → 401.
  const ich401 = await req('GET', '/api/ich');
  ok('GET /api/ich без сессии → 401', ich401.status === 401);

  // 6. /api/ich с сессией → 200.
  const ich200 = await req('GET', '/api/ich', null, cookie);
  ok('GET /api/ich с сессией → 200', ich200.status === 200 && ich200.body.login === 'testbuch');
  ok('Роль в ответе /api/ich', ich200.body.rolle === 'buchhaltung');

  // 7. /api/k/lage без сессии → 401.
  const lage401 = await req('GET', '/api/k/lage');
  ok('GET /api/k/lage без сессии → 401', lage401.status === 401);

  // 8. Неизвестный маршрут → 404.
  const n404 = await req('GET', '/nichtvorhanden');
  ok('GET /nichtvorhanden → 404', n404.status === 404);

  // 9. Интеграционный маршрут без токена → 401.
  const int401 = await req('POST', '/api/integration/vorschuss', {});
  ok('POST /api/integration/vorschuss без токена → 401', int401.status === 401);

  // 10. /api/benutzer без прав → 403.
  const benutz403 = await req('GET', '/api/benutzer');
  ok('GET /api/benutzer без сессии → 403', benutz403.status === 403);

  // 11. /api/benutzer с правами buchhaltung.
  const benutzOk = await req('GET', '/api/benutzer', null, cookie);
  ok('GET /api/benutzer с правами → 200', benutzOk.status === 200 && Array.isArray(benutzOk.body.liste));

  // 12. Роль mitarbeiter имеет доступ.
  const loginMa = await req('POST', '/api/login', { login: 'testma', pin: '1234' });
  ok('Роль mitarbeiter может войти', loginMa.status === 200);

  // 13. Защита от path traversal.
  const pt = await req('GET', '/kasse/../../app/kasse-server.js');
  ok('Path traversal → не 200', pt.status !== 200);

  // 14. /api/logout → редирект.
  const logout = await req('GET', '/api/logout', null, cookie);
  ok('/api/logout → редирект', logout.status === 302);

  console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);

  // Очистка.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (fail > 0) process.exit(1);
  process.exit(0);
}

run().catch(e => { console.error('Ошибка теста:', e.message); process.exit(1); });
