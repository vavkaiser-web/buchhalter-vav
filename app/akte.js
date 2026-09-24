/**
 * Досье объекта: всё, что к нему привязано.
 *
 * Номер объекта рождается в плане Олега — VK-26-NNN — и живёт с объектом
 * до конца. Постцентраль вешает на этот номер письма и документы, план
 * даёт часы бригад, банк — оплаты. Раньше каждый кусок лежал в своём
 * приложении, и в карточке объекта Бухгалтера не было видно ничего.
 * Здесь всё сходится в одном месте, по одному номеру.
 */
const { mitBase, SCHEMA } = require('./razn.js');

async function akte(nr) {
  const nummer = String(nr || '').trim();
  if (!nummer) throw new Error('нужен номер объекта');

  return mitBase(async (q) => {
    const objekt = await q(
      'SELECT nr, bez, kunde, adresse, firma, status, beginn, ende'
      + ' FROM ' + SCHEMA + 'buch_objekt WHERE nr = $1', [nummer]);
    if (!objekt.length) throw new Error('объекта ' + nummer + ' нет в справочнике');

    // Почта и документы — из Постцентрали, по её же виду.
    const post = await q(
      'SELECT brief_id, beleg_id, received_at, doc_type, absender, subject,'
      + ' doc_nr, betrag_cent, antwort_frist, drive_file_ids, drive_folder_id'
      + ' FROM postzentrale.v_objekt_post WHERE objektnummer = $1'
      + ' ORDER BY received_at DESC NULLS LAST LIMIT 300', [nummer]);

    // Часы бригад — из плана Олега, тот же номер объекта.
    const stunden = await q(
      'SELECT count(DISTINCT d.date)::int AS tage,'
      + ' count(DISTINCT d.employee_id)::int AS leute,'
      + ' min(d.date) AS von, max(d.date) AS bis,'
      + ' coalesce(sum(d.confirmed_work_hours),0)::numeric AS stunden'
      + ' FROM baubot_dev.day_status d JOIN baubot_dev.objects o ON o.id = d.object_id'
      + ' WHERE o.objektnummer = $1', [nummer]);

    // Банковские операции, которые человек уже отнёс к этому объекту.
    const geld = await q(
      'SELECT quelle_id, kategorie, wer, wann FROM ' + SCHEMA
      + 'buch_zuordnung WHERE objekt = $1 ORDER BY wann DESC LIMIT 100', [nummer]);

    const summe = post.reduce((s, p) => s + Number(p.betrag_cent || 0), 0);
    const dateien = post.reduce((s, p) => s + (p.drive_file_ids || []).length, 0);

    return {
      objekt: objekt[0],
      post,
      stunden: stunden[0] || null,
      geld,
      zahlen: {
        briefe: post.filter(p => !p.beleg_id).length,
        belege: post.filter(p => p.beleg_id).length,
        summe_cent: summe,
        dateien
      }
    };
  });
}

module.exports = { akte };
