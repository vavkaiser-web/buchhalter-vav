'use strict';
// Заглушка kasse/api.js для buchhalter-vav сессии.
// GET-запросы — 200 с пустыми данными (чтобы zentrum/rolle.js грузились без ошибок).
// POST/PUT/PATCH — 503 (мутации кассы в этой сессии не работают).
const EMPTY = {
  '/api/k/lage':    { demo: true, quelle: null, jetzt: null, ich: null,
                      entscheidungen: [], zahlungen: [], risiken: [], analytik: {} },
  '/api/k/ich':     { login: null },
};
function handle(req, res, u) {
  const p = u ? u.pathname : (req.url || '').split('?')[0];
  const ct = 'application/json; charset=utf-8';
  if (req.method === 'GET' && EMPTY[p] !== undefined) {
    const b = Buffer.from(JSON.stringify(EMPTY[p]));
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }
  if (req.method === 'GET') {
    const b = Buffer.from(JSON.stringify({}));
    res.writeHead(200, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    return res.end(b);
  }
  const b = Buffer.from(JSON.stringify({ fehler: 'Касса недоступна в этой сессии (buchhalter-vav).' }));
  res.writeHead(503, { 'Content-Type': ct, 'Content-Length': b.length });
  res.end(b);
}
module.exports = { handle };
