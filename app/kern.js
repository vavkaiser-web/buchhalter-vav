/* ----------------------------------------------------------------
   §8-A: адаптер единого реестра объектов (ядро vav_kern).

   Один шов чтения объектов. Два режима на ОДНОМ соединении пилота:
   - 'mirror' (по умолчанию): зеркало kern_objekt — прежнее поведение,
     все существующие тесты не меняются.
   - 'live' (BUCH_KERN_LIVE=1): живой реестр vav_kern (представление
     vav_kern.objekt_kompat + сведение дублей через vav_kern.objekt_alias).

   Принцип проекта: номер не выдумываем. Не нашли объект/дубль — возвращаем
   null, а не догадку. Сведение имён — только через objekt_alias и ключ
   контрагента (razn.schluessel), неоднозначность даёт null, а не выбор наугад.
   ---------------------------------------------------------------- */
'use strict';
const razn = require('./razn.js');

function live(flag) {
  return flag === undefined ? (process.env.BUCH_KERN_LIVE === '1') : !!flag;
}

// Имя источника объектов в форме kern_objekt (для FROM в запросах пилота).
function quelle(flag) {
  return live(flag) ? 'vav_kern.objekt_kompat' : 'kern_objekt';
}

/* Канонический номер по идентификатору (номеру или сведённому/чужому номеру).
   Возвращает строку-номер или null (никогда не выдумывает). */
async function kanon(cl, nr, flag) {
  const id = String(nr || '').trim();
  if (!id) return null;
  if (live(flag)) {
    const o = (await cl.query('SELECT nummer FROM vav_kern.objekt WHERE nummer=$1', [id])).rows[0];
    if (o) return o.nummer;
    const a = (await cl.query('SELECT nummer FROM vav_kern.objekt_alias WHERE alias=$1', [id])).rows[0];
    return a ? a.nummer : null;
  }
  const row = (await cl.query('SELECT merged_into FROM kern_objekt WHERE nummer=$1', [id])).rows[0];
  if (!row) return null;
  return row.merged_into || id;
}

// Существует ли объект в реестре.
async function existiert(cl, nr, flag) {
  return (await kanon(cl, nr, flag)) !== null;
}

/* Свести сырое ИМЯ к каноническому номеру.
   Порядок: точный алиас → совпадение по ключу контрагента (bez/kunde).
   {nummer, wie:'alias'|'schluessel'} при однозначном совпадении;
   {nummer:null, mehrdeutig:true} если под ключ подходит >1 объекта;
   {nummer:null} если совпадений нет. Номер не выдумывается. */
async function aufloesenName(cl, name, flag) {
  const roh = String(name || '').trim();
  if (!roh) return { nummer: null };
  if (live(flag)) {
    const a = (await cl.query('SELECT nummer FROM vav_kern.objekt_alias WHERE lower(alias)=lower($1)', [roh])).rows[0];
    if (a) return { nummer: a.nummer, wie: 'alias' };
    const key = razn.schluessel(roh);
    if (!key) return { nummer: null };
    // кандидаты: по имени объекта, по клиенту и по алиасам
    const kand = (await cl.query(
      `SELECT nummer, bez AS text FROM vav_kern.objekt
       UNION ALL SELECT nummer, kunde AS text FROM vav_kern.objekt
       UNION ALL SELECT nummer, alias AS text FROM vav_kern.objekt_alias`)).rows;
    const treffer = new Set(kand.filter(r => razn.schluessel(r.text) === key).map(r => r.nummer));
    if (treffer.size === 1) return { nummer: [...treffer][0], wie: 'schluessel' };
    if (treffer.size > 1) return { nummer: null, mehrdeutig: true };
    return { nummer: null };
  }
  // зеркало: алиасов нет, сводим по ключу над bez/kunde
  const key = razn.schluessel(roh);
  if (!key) return { nummer: null };
  const kand = (await cl.query(
    'SELECT nummer, bez, kunde FROM kern_objekt WHERE merged_into IS NULL')).rows;
  const treffer = new Set(kand.filter(r =>
    razn.schluessel(r.bez) === key || razn.schluessel(r.kunde) === key).map(r => r.nummer));
  if (treffer.size === 1) return { nummer: [...treffer][0], wie: 'schluessel' };
  if (treffer.size > 1) return { nummer: null, mehrdeutig: true };
  return { nummer: null };
}

module.exports = { live, quelle, kanon, existiert, aufloesenName };
