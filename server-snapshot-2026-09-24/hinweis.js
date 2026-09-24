/* ---------------------------------------------------------------
   Обращения из приложения: поправить, добавить, не работает, вопрос.

   Смысл в том, чтобы человек писал там, где споткнулся, а система
   сама прикладывала обстановку: раздел, месяц, фильтр, поиск, версию.
   Половина расследования делается до того, как он начал печатать.
   ---------------------------------------------------------------- */
'use strict';
const fs = require('fs');
const path = require('path');
const razn = require('./razn.js');

const BILDER = '/opt/buchhalter/data/hinweis';
fs.mkdirSync(BILDER, { recursive: true });

const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 4000);
const ARTEN = ['aenderung', 'fehler', 'frage', 'idee'];

/** Картинка приходит как data:image/...;base64 — кладём файлом, в базе только имя. */
function bildSpeichern(daten) {
  const m = String(daten || '').match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4e6) throw new Error('картинка больше 4 МБ');
  const name = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(BILDER, name), buf);
  return name;
}

async function anlegen(d, benutzer) {
  const titel = txt(d.titel, 160);
  if (titel.length < 3) throw new Error('нужно короткое название');
  const art = ARTEN.includes(d.art) ? d.art : 'aenderung';
  let bild = null;
  if (d.bild) bild = bildSpeichern(d.bild);
  return razn.mitBase(async q => {
    const r = await q(
      `INSERT INTO vav_kern.hinweis (app, art, titel, text, kontext, bild, von, von_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, angelegt`,
      ['buch', art, titel, txt(d.text, 6000), JSON.stringify(d.kontext || {}), bild,
       benutzer.login, benutzer.name || benutzer.login]);
    await q(`INSERT INTO vav_kern.journal (art, bezug, text, von)
             VALUES ('hinweis', $1, $2, $3)`,
      ['O' + r[0].id, 'обращение: ' + titel, benutzer.name || benutzer.login]);
    return { ok: true, id: r[0].id };
  });
}

/** Свои обращения видит автор; владелец видит все. */
async function liste(benutzer) {
  const alle = benutzer.rolle === 'gf';
  return razn.mitBase(q => q(
    `SELECT id, art, titel, text, bild, status, antwort, von_name, angelegt, geaendert
       FROM vav_kern.hinweis
      WHERE ($1 OR von = $2)
      ORDER BY (status IN ('erledigt','abgelehnt')), id DESC LIMIT 60`,
    [alle, benutzer.login]));
}

function bildLesen(name) {
  const sicher = String(name || '').replace(/[^a-z0-9.\-]/gi, '');
  if (!sicher || sicher.includes('..')) return null;
  const p = path.join(BILDER, sicher);
  if (!p.startsWith(BILDER) || !fs.existsSync(p)) return null;
  return { pfad: p, typ: /\.png$/i.test(p) ? 'image/png' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg' };
}

module.exports = { anlegen, liste, bildLesen };
