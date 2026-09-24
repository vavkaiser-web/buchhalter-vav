/* Тестовый стенд: изолированная локальная база (порт 55481), свежая
   миграция, вымышленные источники, сервер Бухгалтера на случайном порту
   с временной папкой данных. Ничего никуда не отправляется. */
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const DB_URL = process.env.BUCH_TEST_DB || 'postgres://buch@127.0.0.1:55481/buchlokal';

function psql(datei) {
  execFileSync(PSQL, [DB_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', datei], { stdio: ['ignore', 'ignore', 'inherit'] });
}
function sql(text) {
  return execFileSync(PSQL, [DB_URL, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', text], { encoding: 'utf8' }).trim();
}
function datenbankNeu() {
  psql(path.join(ROOT, 'dev', 'quellen-lokal.sql'));
  psql(path.join(APP, 'migrations', '001_kasse.down.sql'));
  psql(path.join(APP, 'migrations', '001_kasse.up.sql'));
  psql(path.join(__dirname, 'quellen-test.sql'));
}

const P = {
  A: '00000000-0000-4000-8000-000000000001', B: '00000000-0000-4000-8000-000000000002',
  OLEG: '00000000-0000-4000-8000-000000000003', BUCH: '00000000-0000-4000-8000-000000000004',
  NU1: '00000000-0000-4000-8000-000000000011', NU2: '00000000-0000-4000-8000-000000000012',
  NUB: '00000000-0000-4000-8000-000000000021', AUTO_A: '00000000-0000-4000-8000-0000000000c1',
};
const PIN = 'test-' + crypto.randomBytes(4).toString('hex');
const NUTZER = [
  { login: 'andrej', name: 'Андрей Кайзер', rolle: 'gf', kurz: 'АК' },
  { login: 'buch', name: 'Бухгалтер Тест', rolle: 'buchhaltung', person: P.BUCH, kurz: 'БХ' },
  { login: 'oleg', name: 'Олег', rolle: 'disponent', person: P.OLEG, kurz: 'ОХ', bei: 'У Олега' },
  { login: 'ma_a', name: 'Сотрудник А', rolle: 'mitarbeiter', person: P.A, kurz: 'СА' },
  { login: 'ma_b', name: 'Сотрудник Б', rolle: 'mitarbeiter', person: P.B, kurz: 'СБ' },
  { login: 'office', name: 'Офис', rolle: 'buero' },
];

async function starten(opt) {
  opt = opt || {};
  datenbankNeu();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buch-test-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.mkdirSync(path.join(dir, 'daten'));
  const liste = NUTZER.map(n => {
    const salz = crypto.randomBytes(16);
    return { ...n, salz: salz.toString('hex'), hash: crypto.scryptSync(PIN, salz, 32).toString('hex') };
  });
  fs.writeFileSync(path.join(dir, 'data', 'benutzer.json'), JSON.stringify(liste));
  fs.writeFileSync(path.join(dir, 'data', 'start'), '2026-09-06');
  fs.writeFileSync(path.join(dir, 'mailops.env'), 'DATABASE_URL=' + DB_URL + '\n');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), BUCH_DATA: path.join(dir, 'data'), BUCH_DATEN: path.join(dir, 'daten'),
    BUCH_DATEIEN: path.join(dir, 'dateien'), BUCH_MAILOPS_ENV: path.join(dir, 'mailops.env'), BUCH_LOKAL_HTTP: '1', ...(opt.env || {}) };
  const proc = spawn(process.execPath, [path.join(APP, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', c => { log += c; });
  proc.stderr.on('data', c => { log += c; });
  const basis = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(basis + '/login'); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  const kekse = {};
  async function login(l) {
    if (kekse[l]) return kekse[l];
    const r = await fetch(basis + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: l, pin: PIN }) });
    if (r.status !== 200) throw new Error('вход ' + l + ': ' + r.status);
    kekse[l] = r.headers.get('set-cookie').split(';')[0];
    return kekse[l];
  }
  async function api(l, methode, pfad, body, extra) {
    const k = await login(l);
    const r = await fetch(basis + pfad, { method: methode, headers: { Cookie: k, 'Content-Type': 'application/json', ...(extra || {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  }
  const post = (l, pfad, body) => api(l, 'POST', '/api/k/' + pfad, body || {});
  const lage = async l => (await api(l, 'GET', '/api/k/lage')).body;
  async function datei(l, inhalt, mime) {
    const k = await login(l);
    const r = await fetch(basis + '/api/k/datei', { method: 'POST', headers: { Cookie: k, 'Content-Type': mime || 'image/jpeg' }, body: inhalt || jpeg() });
    return { status: r.status, body: await r.json() };
  }
  function stop() { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  return { basis, login, api, post, lage, datei, stop, log: () => log, dir };
}

/** Минимальный «JPEG»: правильная сигнатура + случайное содержимое → уникальный sha. */
function jpeg() { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(64), Buffer.from([0xff, 0xd9])]); }
const idem = () => crypto.randomUUID();

module.exports = { starten, sql, P, jpeg, idem, datenbankNeu };
