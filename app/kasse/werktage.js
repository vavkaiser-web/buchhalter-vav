/* ---------------------------------------------------------------
   Рабочие дни для сроков запросов: Пн–Пт без праздников Баварии.
   Нюрнберг — преимущественно евангелический, поэтому 15.08
   (Mariä Himmelfahrt) здесь не праздник; Augsburger Friedensfest
   тоже нет. Список — данные, при сомнении правится в одном месте.
   Считаем в часовом поясе Europe/Berlin.
   ---------------------------------------------------------------- */
'use strict';

const ZONE = 'Europe/Berlin';

function ostersonntag(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monat = Math.floor((h + l - 7 * m + 114) / 31), tag = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(j, monat - 1, tag));
}
const iso = d => d.toISOString().slice(0, 10);
const plus = (d, n) => new Date(d.getTime() + n * 864e5);

const cache = new Map();
function feiertage(j) {
  if (cache.has(j)) return cache.get(j);
  const o = ostersonntag(j);
  const s = new Set([
    `${j}-01-01`, `${j}-01-06`, iso(plus(o, -2)), iso(plus(o, 1)), `${j}-05-01`,
    iso(plus(o, 39)), iso(plus(o, 50)), iso(plus(o, 60)), `${j}-10-03`, `${j}-11-01`,
    `${j}-12-25`, `${j}-12-26`,
  ]);
  cache.set(j, s);
  return s;
}

/** Календарная дата (YYYY-MM-DD) момента в Берлине. */
function berlinTag(zeit) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(zeit));
}
function istWerktag(tagIso) {
  const d = new Date(tagIso + 'T12:00:00Z');
  const w = d.getUTCDay();
  return w !== 0 && w !== 6 && !feiertage(d.getUTCFullYear()).has(tagIso);
}
function naechsterTag(tagIso) { return iso(plus(new Date(tagIso + 'T12:00:00Z'), 1)); }

/** Последний рабочий день срока: n рабочих дней, считая со следующего
    рабочего дня после момента создания (запрос в среду → срок до конца пятницы при n=2). */
function fristEnde(basis, n) {
  let t = berlinTag(basis), gezaehlt = 0;
  while (gezaehlt < n) { t = naechsterTag(t); if (istWerktag(t)) gezaehlt++; }
  return t;
}

/** Ступень запроса на момент jetzt. Потерянный чек — сразу бухгалтеру и Андрею. */
function stufe(basis, jetzt, verlust) {
  if (verlust) return { stufe: 'gf', seit: berlinTag(basis), frist: null };
  const fMitarbeiter = fristEnde(basis, 2);
  const fOleg = fristEnde(basis, 3);
  const heute = berlinTag(jetzt);
  if (heute <= fMitarbeiter) return { stufe: 'mitarbeiter', frist: fMitarbeiter };
  if (heute <= fOleg) return { stufe: 'oleg', frist: fOleg };
  return { stufe: 'gf', frist: null, seit: naechsterTag(fOleg) };
}

module.exports = { istWerktag, fristEnde, stufe, berlinTag, feiertage };
