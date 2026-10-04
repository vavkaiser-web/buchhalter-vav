#!/usr/bin/env node
/* Генерирует invite-ссылку для пользователя без PIN.
   Использование: node scripts/invite-erzeugen.js <login> [base_url]
   Пример:        node scripts/invite-erzeugen.js oleg https://kasse-178-105-169-97.sslip.io
*/
'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA  = process.env.KASSE_DATA || process.env.BUCH_DATA || path.join(__dirname, '..', 'kasse-data');
const NUTZER = path.join(DATA, 'benutzer.json');

const login   = process.argv[2];
const baseUrl = (process.argv[3] || 'https://kasse-178-105-169-97.sslip.io').replace(/\/$/, '');

if (!login) { console.error('Укажите логин: node invite-erzeugen.js <login>'); process.exit(1); }

const liste = JSON.parse(fs.readFileSync(NUTZER, 'utf8'));
const idx   = liste.findIndex(x => x.login === login);
if (idx === -1) { console.error(`Пользователь "${login}" не найден.`); process.exit(1); }

const n = liste[idx];
if (n.hash) {
  console.log(`Пользователь "${login}" уже имеет PIN.`);
  console.log('Чтобы сбросить PIN, удалите поля salz и hash из benutzer.json вручную.');
  process.exit(0);
}

const token    = crypto.randomBytes(24).toString('hex');
const inviteBis = Date.now() + 7 * 24 * 3600 * 1000; // 7 дней

liste[idx].invite_token = token;
liste[idx].invite_bis   = inviteBis;
delete liste[idx].salz;
delete liste[idx].hash;

fs.writeFileSync(NUTZER, JSON.stringify(liste, null, 2));

const url = `${baseUrl}/kasse/invite/${token}`;
console.log('\nInvite-ссылка для ' + (n.name || login) + ':');
console.log(url);
console.log('\nДействует 7 дней. После установки PIN ссылка сгорает.');
