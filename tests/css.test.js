/* CSS утверждённого макета вставлен в /arbeit дословно. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
test('CSS эталона в arbeit.html — байт в байт', () => {
  const src = fs.readFileSync('/Users/akais/Documents/agents/design/buchhalter-vav/approved-design.html', 'utf8');
  const css = src.match(/<style>\n([\s\S]*?)\n<\/style>/)[1];
  const seite = fs.readFileSync(require('path').join(__dirname, '../app/public/arbeit.html'), 'utf8');
  assert.ok(seite.includes(css), 'CSS эталона не найден дословно');
  assert.ok(seite.includes(crypto.createHash('sha256').update(css).digest('hex')));
  // Эталон не изменён относительно пакета (SHA256SUMS.txt).
  const sums = fs.readFileSync('/Users/akais/Documents/agents/design/buchhalter-vav/SHA256SUMS.txt', 'utf8');
  const soll = sums.split('\n').find(l => l.endsWith('approved-design.html')).split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(src).digest('hex'), soll);
});
