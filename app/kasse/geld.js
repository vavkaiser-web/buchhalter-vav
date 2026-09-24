/* Деньги — только целые центы. Ввод «83,47», «83.47», «1.455,38». */
'use strict';

function centAus(eingabe) {
  if (typeof eingabe === 'number') {
    if (!Number.isInteger(eingabe) || eingabe <= 0) return null;
    return eingabe;                              // уже центы
  }
  let s = String(eingabe == null ? '' : eingabe).trim().replace(/\s|€/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '');   // 1.455,38
  s = s.replace(',', '.');
  const m = s.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cent = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return cent > 0 ? cent : null;
}

const fmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const euro = cent => fmt.format(Number(cent) / 100);

module.exports = { centAus, euro };
