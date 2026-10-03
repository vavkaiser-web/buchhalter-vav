'use strict';
// Заглушка kasse/api.js для buchhalter-vav сессии.
// GET-запросы — 200 с пустыми данными (чтобы zentrum/rolle.js грузились без ошибок).
// POST/PUT/PATCH — 503 (мутации кассы в этой сессии не работают).
function handle(req, res, u, nutzer) {
  const p = u ? u.pathname : (req.url || '').split('?')[0];
  const ct = 'application/json; charset=utf-8';
  function json(code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': ct, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
  }
  if (req.method === 'GET') {
    if (p === '/api/k/ich') {
      if (!nutzer) return json(200, { login: null });
      return json(200, {
        login: nutzer.login, name: nutzer.name, kurz: (nutzer.name || nutzer.login).slice(0, 2).toUpperCase(),
        rolle: nutzer.rolle, rollenname: nutzer.rollenname || nutzer.rolle,
        heute: new Date().toISOString().slice(0, 10),
      });
    }
    if (p === '/api/k/lage') {
      const heute = new Date().toISOString().slice(0, 10);
      return json(200, {
        demo: true, quelle: null,
        heute, jetzt: new Date().toISOString(),
        ich: nutzer ? { ...nutzer, person: nutzer.login } : null,
        konten: [], belege: [], bewegungen: [], pakete: [], quittungen: [],
        rueckfragen: [], plaene: [], erstattungen: [], fahrzeuge: [],
        objekte: [], namen: [], bank_links: [],
        entscheidungen: [], zahlungen: [], risiken: [], analytik: {},
      });
    }
    return json(200, {});
  }
  return json(503, { fehler: 'Касса недоступна в этой сессии (buchhalter-vav).' });
}
module.exports = { handle };
