#!/usr/bin/env node
/* Тест интеграционного модуля kasse/integratsiya.js
   Проверяет HTTP-маршруты с токеном и без него.
*/
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { console.log('✓', label); pass++; } else { console.error('✗', label); fail++; } }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kasse-int-test-'));
const TOKEN = crypto.randomBytes(32).toString('hex');
process.env.KASSE_DATA = tmpDir;
process.env.KASSE_PORT = '13130';
process.env.KASSE_LOKAL_HTTP = '1';
process.env.KASSE_INTEGRATION_TOKEN = TOKEN;

const salz = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('9999', Buffer.from(salz, 'hex'), 32).toString('hex');
fs.writeFileSync(path.join(tmpDir, 'benutzer.json'), JSON.stringify([
  { login: 'intbuch', name: 'Интеграция', rolle: 'buchhaltung', salz, hash },
]));

function req(methode, pfad, body, token) {
  return new Promise((resolve, err) => {
    const b = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (b) headers['Content-Length'] = b.length;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: 13130, method: methode, path: pfad, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let j; try { j = JSON.parse(d); } catch (e) { j = d; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', err);
    if (b) r.write(b);
    r.end();
  });
}

function warten(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  require(path.join(__dirname, '../../app/kasse-server.js'));
  await warten(350);

  // 1. Без токена → 401.
  const nt = await req('POST', '/api/integration/vorschuss', {});
  ok('POST /api/integration/vorschuss без токена → 401', nt.status === 401);

  // 2. С неверным токеном → 401.
  const wt = await req('POST', '/api/integration/vorschuss', {}, 'wrong-token');
  ok('POST /api/integration/vorschuss с неверным токеном → 401', wt.status === 401);

  // 3. Заявка без person_id → 400.
  const bp = await req('POST', '/api/integration/vorschuss', { ereignis_id: crypto.randomUUID(), betrag_cent: 10000 }, TOKEN);
  ok('Заявка без person_id → 400', bp.status === 400);

  // 4. Заявка без ereignis_id → 400.
  const be = await req('POST', '/api/integration/vorschuss', { person_id: 'p1', betrag_cent: 10000 }, TOKEN);
  ok('Заявка без ereignis_id → 400', be.status === 400);

  // 5. Заявка с неверным UUID → 400.
  const bu = await req('POST', '/api/integration/vorschuss', { ereignis_id: 'not-uuid', person_id: 'p1', betrag_cent: 10000 }, TOKEN);
  ok('Заявка с неверным UUID → 400', bu.status === 400);

  // 6. Чек без person_id → 400.
  const cb = await req('POST', '/api/integration/beleg', { ereignis_id: crypto.randomUUID(), betrag_cent: 5000 }, TOKEN);
  ok('Чек без person_id → 400', cb.status === 400);

  // 7. Статус без базы → 404 или 503 (без DB оба корректны).
  const s404 = await req('GET', '/api/integration/status/NICHT-VORHANDEN', null, TOKEN);
  ok('Статус несуществующего ref → 404 или 503', [404, 503].includes(s404.status));

  // 8. Неизвестный маршрут интеграции → 404.
  const nr = await req('GET', '/api/integration/unknown', null, TOKEN);
  ok('Неизвестный маршрут интеграции → 404', nr.status === 404);

  console.log(`\nИтого: ${pass} пройдено, ${fail} провалено`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (fail > 0) process.exit(1);
  process.exit(0);
}

run().catch(e => { console.error('Ошибка теста:', e.message); process.exit(1); });
