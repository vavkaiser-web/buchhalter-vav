/* ----------------------------------------------------------------
   §8-A: детектор дублей объектов -> черновик vav_kern.objekt_alias.

   На вход — записи объектов из разных источников: {nummer, name, quelle}.
   Группируем по ключу контрагента (razn.schluessel: регистр/форма/порядок слов
   не различаются). В группе канонический номер — единственный VK-YY-NNN.

   Правила (принцип проекта — не выдумывать):
   - один VK в группе -> он канон; прочие написания и чужие номера/коды -> алиасы.
   - несколько VK в группе -> НЕ сводим (возможно, разные объекты), в «на проверку».
   - ни одного VK -> канона нет, в «на проверку» (номер не выдумываем).
   Это ЧЕРНОВИК: в бой алиасы вносит человек после сверки (бухгалтер/Андрей).
   ---------------------------------------------------------------- */
'use strict';
const razn = require('./razn.js');

const istVK = s => /^VK-\d{2}-\d{3}$/.test(String(s || '').trim());

function aliasVorschlag(rows) {
  const g = new Map();
  for (const r of rows || []) {
    const k = razn.schluessel(r.name);
    if (!k) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  const vorschlag = [], zurPruefung = [], gruppen = [];
  for (const [k, list] of g) {
    const vks = [...new Set(list.filter(r => istVK(r.nummer)).map(r => String(r.nummer).trim()))];
    const namen = [...new Set(list.map(r => r.name).filter(Boolean))];
    const gr = { schluessel: k, mitglieder: list, namen };
    if (vks.length !== 1) {
      gr.status = vks.length === 0 ? 'kein_kanon' : 'mehrdeutig';
      if (vks.length > 1) gr.kandidaten = vks;
      // сводить нечего/спорно только если написаний реально несколько
      if (namen.length > 1 || vks.length > 1) zurPruefung.push(gr);
      gruppen.push(gr);
      continue;
    }
    const kanon = vks[0];
    gr.status = 'ok'; gr.kanon = kanon;
    const seen = new Set();
    for (const r of list) {
      const kands = [];
      if (r.name) kands.push({ text: r.name, grund: 'написание' });
      if (r.nummer && !istVK(r.nummer)) kands.push({ text: String(r.nummer).trim(), grund: 'номер/код' });
      for (const c of kands) {
        const key = c.text.toLowerCase();
        if (c.text && c.text !== kanon && !seen.has(key)) {
          seen.add(key);
          vorschlag.push({ alias: c.text, nummer: kanon, grund: c.grund, quelle: r.quelle || '' });
        }
      }
    }
    gruppen.push(gr);
  }
  return { vorschlag, zurPruefung, gruppen };
}

/* Дубли контрагентов (не объекты): группировка написаний по ключу.
   Для справочника/разноса; в objekt_alias не идёт. Спорное — бухгалтеру. */
function kontrahentGruppen(namen) {
  const g = new Map();
  for (const n of namen || []) {
    const k = razn.schluessel(n);
    if (!k) continue;
    if (!g.has(k)) g.set(k, new Set());
    g.get(k).add(n);
  }
  return [...g.entries()]
    .map(([k, s]) => ({ schluessel: k, schreibweisen: [...s] }))
    .filter(x => x.schreibweisen.length > 1)
    .sort((a, b) => b.schreibweisen.length - a.schreibweisen.length);
}

module.exports = { aliasVorschlag, kontrahentGruppen, istVK };
