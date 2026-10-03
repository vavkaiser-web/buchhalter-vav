/* ---------------------------------------------------------------
   Интеграция Касса VAV ↔ VAV Kaiser (Учёт часов).

   Принимает заявки на аванс и чеки от vavapp.
   Возвращает статусы заявок.
   Отправляет обновления статусов обратно в vavapp через очередь.

   KASSE_INTEGRATION_TOKEN — Bearer-токен для приёма запросов от vavapp.
   VAVAPP_INTEGRATION_URL  — адрес vavapp для отправки обновлений статусов.
   VAVAPP_INTEGRATION_TOKEN — Bearer-токен для исходящих запросов в vavapp.
   ---------------------------------------------------------------- */
'use strict';
const crypto = require('crypto');
const { tx, lesen, Fehler } = require('./db.js');
const dienst = require('./dienst.js');
const https = require('https');
const http = require('http');

const S = 'mailops_prod.';

function antwort(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function koerper(req) {
  return new Promise((ok, fehler) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 5e5) { req.destroy(); fehler(new Fehler(413, 'слишком большой запрос')); } s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fehler(new Fehler(400, 'неверный формат')); } });
  });
}

/* ---------- Bearer-токен ---------- */
function pruefToken(req) {
  const token = process.env.KASSE_INTEGRATION_TOKEN;
  if (!token) return false; // без токена интеграция отключена
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ')) return false;
  const a = Buffer.from(String(h.slice(7)).padEnd(64, ' ').slice(0, 64));
  const b = Buffer.from(String(token).padEnd(64, ' ').slice(0, 64));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Обеспечение таблицы очереди ---------- */
async function queueSichern() {
  await tx(async q => {
    await q(`CREATE TABLE IF NOT EXISTS ${S}kasse_ereignis_queue (
      id BIGSERIAL PRIMARY KEY,
      kasse_ref TEXT NOT NULL,
      ereignis_id UUID NOT NULL UNIQUE,
      zustand TEXT NOT NULL,
      nachricht TEXT,
      zeitpunkt TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      versuche SMALLINT NOT NULL DEFAULT 0,
      naechster_versuch TIMESTAMPTZ,
      verarbeitet_am TIMESTAMPTZ,
      fehler TEXT
    )`);
    await q(`CREATE TABLE IF NOT EXISTS ${S}kasse_extern_anfrage (
      id BIGSERIAL PRIMARY KEY,
      ereignis_id UUID NOT NULL UNIQUE,
      quelle TEXT NOT NULL,
      art TEXT NOT NULL,
      person_id TEXT,
      person_name TEXT,
      objekt_id TEXT,
      fahrzeug_id TEXT,
      betrag_cent BIGINT,
      zweck TEXT,
      foto_url TEXT,
      rohdaten JSONB NOT NULL,
      kasse_ref TEXT,
      erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verarbeitet_am TIMESTAMPTZ
    )`);
  });
}
// Инициализация при запуске (без сбоя, если таблицы уже есть).
queueSichern().catch(e => console.error('kasse integration init:', e.message));

/* ---------- Приём заявки на аванс ---------- */
async function empfangeVorschuss(body) {
  const { ereignis_id, person_id, person_name, objekt_id, betrag_cent, zweck } = body;
  if (!ereignis_id || !/^[0-9a-f-]{36}$/.test(String(ereignis_id))) throw new Fehler(400, 'ereignis_id обязателен (UUID)');
  if (!person_id) throw new Fehler(400, 'person_id обязателен');
  if (!betrag_cent || betrag_cent <= 0 || betrag_cent > 1e9) throw new Fehler(400, 'betrag_cent: 1–10 000 000');

  return await tx(async q => {
    // Идемпотентность: повторная отправка с тем же ereignis_id.
    const existiert = await q(`SELECT kasse_ref FROM ${S}kasse_extern_anfrage WHERE ereignis_id = $1`, [ereignis_id]);
    if (existiert.length) return { ok: true, kasse_ref: existiert[0].kasse_ref, bereits_vorhanden: true };

    // Создать запрос на аванс через обычную бизнес-логику.
    // Для интеграции используем системного пользователя с ролью 'mitarbeiter'.
    const systemBenutzer = { login: person_id, rolle: 'mitarbeiter', name: person_name || person_id };
    const plan = await dienst.planAnlegen(systemBenutzer, {
      betrag: betrag_cent,
      zweck: String(zweck || 'Аванс').slice(0, 200),
      objekt: objekt_id || null,
    });

    await q(`INSERT INTO ${S}kasse_extern_anfrage
      (ereignis_id, quelle, art, person_id, person_name, objekt_id, betrag_cent, zweck, kasse_ref, verarbeitet_am)
      VALUES ($1,'vavapp','vorschuss',$2,$3,$4,$5,$6,$7,NOW())`,
      [ereignis_id, person_id, person_name || null, objekt_id || null, betrag_cent, zweck || null, String(plan.ref)]);

    // Поставить в очередь начальный статус EMPFANGEN.
    await einreihen(q, String(plan.ref), crypto.randomUUID(), 'EMPFANGEN', null);

    return { ok: true, kasse_ref: String(plan.ref) };
  });
}

/* ---------- Приём чека ---------- */
async function empfangeBeleg(body) {
  const { ereignis_id, person_id, betrag_cent, art, objekt_id, fahrzeug_id, foto_url } = body;
  if (!ereignis_id || !/^[0-9a-f-]{36}$/.test(String(ereignis_id))) throw new Fehler(400, 'ereignis_id обязателен (UUID)');
  if (!person_id) throw new Fehler(400, 'person_id обязателен');
  if (!betrag_cent || betrag_cent <= 0) throw new Fehler(400, 'betrag_cent > 0');

  return await tx(async q => {
    const existiert = await q(`SELECT kasse_ref FROM ${S}kasse_extern_anfrage WHERE ereignis_id = $1`, [ereignis_id]);
    if (existiert.length) return { ok: true, kasse_ref: existiert[0].kasse_ref, bereits_vorhanden: true };

    const systemBenutzer = { login: person_id, rolle: 'mitarbeiter', name: person_id };
    const beleg = await dienst.belegAnlegen(systemBenutzer, {
      betrag: betrag_cent,
      art: art || 'sonstig',
      objekt: objekt_id || null,
      fahrzeug: fahrzeug_id || null,
      foto_url: foto_url || null,
      quelle: 'vavapp',
      ereignis_id,
    });

    await q(`INSERT INTO ${S}kasse_extern_anfrage
      (ereignis_id, quelle, art, person_id, objekt_id, fahrzeug_id, betrag_cent, foto_url, rohdaten, kasse_ref, verarbeitet_am)
      VALUES ($1,'vavapp','beleg',$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())`,
      [ereignis_id, person_id, objekt_id || null, fahrzeug_id || null,
       betrag_cent, foto_url || null, JSON.stringify(body), String(beleg.ref)]);

    await einreihen(q, String(beleg.ref), crypto.randomUUID(), 'EMPFANGEN', null);

    return { ok: true, kasse_ref: String(beleg.ref) };
  });
}

/* ---------- Статус по kasse_ref ---------- */
async function statusHolen(kasseRef) {
  return await lesen(async q => {
    // Сначала проверяем план (заявка на аванс).
    const plan = await q(`SELECT ref, status, zweck, betrag_cent, erstellt_am FROM ${S}buch_plan WHERE ref = $1`, [kasseRef]);
    if (plan.length) {
      const p = plan[0];
      const zustand = mapPlanZustand(p.status);
      return { ok: true, kasse_ref: kasseRef, typ: 'vorschuss', zustand, aktualisiert_am: p.erstellt_am };
    }
    // Затем проверяем чек.
    const beleg = await q(`SELECT id, status, erstellt_am FROM ${S}buch_beleg WHERE id::text = $1`, [kasseRef]);
    if (beleg.length) {
      const b = beleg[0];
      return { ok: true, kasse_ref: kasseRef, typ: 'beleg', zustand: mapBelegZustand(b.status), aktualisiert_am: b.erstellt_am };
    }
    throw new Fehler(404, 'Такой kasse_ref не найден');
  });
}

function mapPlanZustand(status) {
  return { entwurf: 'ENTWURF', eingereicht: 'PRUEFEN', bewilligt: 'BEWILLIGT',
           abgelehnt: 'ABGELEHNT', ausgegeben: 'AUSGEGEBEN' }[status] || 'PRUEFEN';
}
function mapBelegZustand(status) {
  return { ausstehend: 'PRUEFEN', rueckfrage: 'KLAEREN', abgelehnt: 'ABGELEHNT',
           geprueft: 'BEWILLIGT', erstattet: 'AUSGEGEBEN' }[status] || 'PRUEFEN';
}

/* ---------- Очередь исходящих событий ---------- */
async function einreihen(q, kasseRef, ereignisId, zustand, nachricht) {
  await q(`INSERT INTO ${S}kasse_ereignis_queue
    (kasse_ref, ereignis_id, zustand, nachricht, naechster_versuch)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (ereignis_id) DO NOTHING`,
    [kasseRef, ereignisId, zustand, nachricht || null]);
}

/* ---------- Отправка событий в vavapp (вызывается из dienst.js или cron) ---------- */
async function ereignisAussenden(kasseRef, zustand, nachricht) {
  return await tx(async q => {
    const id = crypto.randomUUID();
    await einreihen(q, kasseRef, id, zustand, nachricht);
  });
}

async function warteschlangeSenden() {
  const url = process.env.VAVAPP_INTEGRATION_URL;
  const token = process.env.VAVAPP_INTEGRATION_TOKEN;
  if (!url || !token) return;

  let eintraege;
  try {
    eintraege = await lesen(async q =>
      q(`SELECT id, kasse_ref, ereignis_id, zustand, nachricht, zeitpunkt, versuche
         FROM ${S}kasse_ereignis_queue
         WHERE verarbeitet_am IS NULL
           AND (naechster_versuch IS NULL OR naechster_versuch <= NOW())
         ORDER BY id LIMIT 20`)
    );
  } catch (e) {
    console.error('очередь: чтение:', e.message);
    return;
  }

  for (const e of eintraege) {
    const payload = JSON.stringify({
      kasse_ref: e.kasse_ref, ereignis_id: e.ereignis_id,
      zustand: e.zustand, nachricht: e.nachricht, zeitpunkt: e.zeitpunkt,
    });
    try {
      await httpPost(url + '/integration/kasse-ereignis', payload, token);
      await tx(async q => q(`UPDATE ${S}kasse_ereignis_queue SET verarbeitet_am = NOW() WHERE id = $1`, [e.id]));
    } catch (err) {
      const naechster = new Date(Date.now() + Math.min(300, 5 * Math.pow(2, e.versuche)) * 1000);
      await tx(async q => q(`UPDATE ${S}kasse_ereignis_queue SET versuche = $2, naechster_versuch = $3, fehler = $4 WHERE id = $1`,
        [e.id, e.versuche + 1, naechster.toISOString(), String(err.message).slice(0, 200)]));
      console.error('очередь: отправка:', e.kasse_ref, err.message);
    }
  }
}

function httpPost(url, body, token) {
  return new Promise((ok, fehler) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + token },
    };
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) ok(d);
        else fehler(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 100)));
      });
    });
    r.on('error', fehler);
    r.setTimeout(10000, () => { r.destroy(new Error('timeout')); });
    r.write(body);
    r.end();
  });
}

// Запускаем отправку очереди раз в 30 секунд.
if (process.env.VAVAPP_INTEGRATION_URL) setInterval(warteschlangeSenden, 30000);

/* ---------- HTTP-обработчик ---------- */
async function handle(req, res, u) {
  if (!pruefToken(req)) return void antwort(res, 401, { fehler: 'Unauthorized' });

  const p = u.pathname;
  try {
    if (req.method === 'POST' && p === '/api/integration/vorschuss') {
      const b = await koerper(req);
      return void antwort(res, 200, await empfangeVorschuss(b));
    }
    if (req.method === 'POST' && p === '/api/integration/beleg') {
      const b = await koerper(req);
      return void antwort(res, 200, await empfangeBeleg(b));
    }
    if (req.method === 'GET' && p.startsWith('/api/integration/status/')) {
      const ref = decodeURIComponent(p.slice('/api/integration/status/'.length));
      return void antwort(res, 200, await statusHolen(ref));
    }
    antwort(res, 404, { fehler: 'неизвестный маршрут интеграции' });
  } catch (e) {
    console.error('integratsiya:', e.message);
    antwort(res, e.status || 500, { fehler: e.message || 'ошибка' });
  }
}

module.exports = { handle, ereignisAussenden, warteschlangeSenden };
