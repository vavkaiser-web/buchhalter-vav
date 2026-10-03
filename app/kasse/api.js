'use strict';
// Заглушка kasse/api.js для buchhalter-vav сессии.
// Настоящая реализация — в kasse-vav (feature/kasse-vav).
function handle(req, res) {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ fehler: 'Касса недоступна в этой сессии (buchhalter-vav).' }));
}
module.exports = { handle };
