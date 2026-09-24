/* Оригиналы документов: фото чеков, подписанные квитанции, счета.
   Файл лежит на диске под своим SHA-256, в базе — только ссылка.
   Один и тот же файл повторно не сохраняется. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORDNER = process.env.BUCH_DATEIEN || path.join(__dirname, '..', 'data', 'dateien');
const GRENZE = 15 * 1024 * 1024;

const TYPEN = {
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': b => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'image/heic': b => b.slice(4, 8).toString('latin1') === 'ftyp',
  'application/pdf': b => b.slice(0, 5).toString('latin1') === '%PDF-',
};

function pfad(sha) { return path.join(ORDNER, sha.slice(0, 2), sha); }

function lesenKoerper(req) {
  return new Promise((ok, fehler) => {
    const teile = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > GRENZE) { req.destroy(); fehler(new Error('zu gross')); } else teile.push(c); });
    req.on('end', () => ok(Buffer.concat(teile)));
    req.on('error', fehler);
  });
}

/** Сохраняет файл; возвращает { sha, mime, groesse } или бросает понятную ошибку. */
function speichern(buf, mime) {
  if (!buf.length) throw Object.assign(new Error('Файл пустой'), { status: 400 });
  const pruef = TYPEN[mime];
  if (!pruef) throw Object.assign(new Error('Поддерживаются фото (JPEG, PNG, WebP, HEIC) и PDF'), { status: 415 });
  if (!pruef(buf)) throw Object.assign(new Error('Содержимое файла не совпадает с его типом'), { status: 415 });
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const ziel = pfad(sha);
  if (!fs.existsSync(ziel)) {
    fs.mkdirSync(path.dirname(ziel), { recursive: true });
    const tmp = ziel + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf, { mode: 0o640 });
    fs.renameSync(tmp, ziel);
  }
  return { sha, mime, groesse: buf.length };
}

module.exports = { lesenKoerper, speichern, pfad, GRENZE };
