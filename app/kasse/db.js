/* Подключение модуля кассы к базе. Строка подключения — как у всего
   Бухгалтера: из файла окружения MailOps (путь можно переопределить
   BUCH_MAILOPS_ENV для локальной копии). Значения не логируются. */
'use strict';
const fs = require('fs');

let Pool = null, pgTypes = null;
for (const p of ['pg', '/opt/mailops/node_modules/pg']) {
  try { const pg = require(p); Pool = pg.Pool; pgTypes = pg.types; break; } catch (e) { /* ищем дальше */ }
}
// bigint (идентификаторы, центы) — числом, но ТОЛЬКО в пуле кассы: глобальный
// парсер pg не трогаем, остальные модули Бухгалтера получают строки как раньше.
const BIGINT = 20;
const kassenTypen = {
  getTypeParser(oid, format) {
    if (oid === BIGINT && format !== 'binary') {
      return v => { const x = Number(v); if (!Number.isSafeInteger(x)) throw new Error('bigint вне диапазона'); return x; };
    }
    return pgTypes.getTypeParser(oid, format);
  },
};

function umgebung() {
  const o = {};
  try {
    const datei = process.env.BUCH_MAILOPS_ENV || '/opt/mailops/.env';
    for (const zeile of fs.readFileSync(datei, 'utf8').split('\n')) {
      const i = zeile.indexOf('=');
      if (i < 1 || zeile.trim().startsWith('#')) continue;
      o[zeile.slice(0, i).trim()] = zeile.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* нет файла */ }
  return o;
}

let pool = null;
function holePool() {
  if (pool) return pool;
  const url = umgebung().DATABASE_URL;
  if (!Pool || !url) throw new Fehler(503, 'База недоступна');
  pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 20000, types: kassenTypen });
  pool.on('error', e => console.error('касса: соединение с базой:', e.message));
  return pool;
}

class Fehler extends Error {
  constructor(status, text, extra) { super(text); this.status = status; this.extra = extra; }
}

/** Одна транзакция. q(sql, args) → rows. */
async function tx(fn) {
  const c = await holePool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn((sql, args) => c.query(sql, args || []).then(x => x.rows));
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') throw new Fehler(409, 'Такая запись уже есть', { code: e.code });
    if (e.code === '23514') throw new Fehler(400, 'Данные не прошли проверку базы', { code: e.code });
    throw e;
  } finally { c.release(); }
}
const lesen = fn => tx(fn);

async function ende() { if (pool) { const p = pool; pool = null; await p.end(); } }

/** Читающий запрос к vavapp DB (VAVAPP_ENV_FILE → DATABASE_URL). Без транзакции. */
let vavPool = null;
async function vavLesen(fn) {
  if (!vavPool) {
    const envFile = process.env.VAVAPP_ENV_FILE;
    if (!Pool || !envFile) return null;
    try {
      const o = {};
      for (const z of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const i = z.indexOf('='); if (i < 1 || z.trim().startsWith('#')) continue;
        o[z.slice(0, i).trim()] = z.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
      if (!o.DATABASE_URL) return null;
      vavPool = new Pool({ connectionString: o.DATABASE_URL, max: 2, idleTimeoutMillis: 30000 });
      vavPool.on('error', e => console.error('касса vavapp pool:', e.message));
    } catch (e) { return null; }
  }
  const c = await vavPool.connect();
  try { return await fn((sql, a) => c.query(sql, a || []).then(x => x.rows)); }
  finally { c.release(); }
}

module.exports = { tx, lesen, vavLesen, Fehler, ende };
