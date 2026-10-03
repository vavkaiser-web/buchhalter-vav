/* ----------------------------------------------------------------
   Поступления от заказчиков и контроль дебиторской задолженности.

   Расширение существующей сверки: те же bank_bewegung и zahlung_zuordnung
   (распределение теперь может ссылаться на наш счёт клиенту — ausgang_id).
   Второй параллельный учёт не заводим. Счета клиентам — ausgang_rechnung.

   Правила: поступление ↔ наши счета, подтверждает бухгалтер (обещание ≠ оплата);
   частичная оплата уменьшает долг, срок остатка сохраняется; спорную недоплату
   не списываем — фиксируем причину; гарантийное удержание отдельно и не теряется
   из контроля; за месяц до возврата — задача; событийный срок — «Срок не определён»;
   переплата — за клиентом (аванс/ошибка), без авто-дохода/счёта/возврата; составной
   платёж по подтверждению (без авто-закрытия старых); третье лицо — после проверки;
   поступление в остатке банка независимо от распределения, деньги не растут повторно,
   повторный импорт идемпотентен; контроль сумм; предупреждение перед напоминанием.
   Реальные переводы и сообщения клиентам не выполняются.
   ---------------------------------------------------------------- */
'use strict';
const razn = require('./razn.js');
const wt = require('./kasse/werktage.js');
const aufgaben = require('./aufgaben.js');
let audit = null; try { audit = require('./audit.js'); } catch (e) {}

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) { const cl = pg(); try { await cl.connect(); return await fn(cl); } finally { try { await cl.end(); } catch (e) {} } }
function jetzt() { return process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date(); }
function heute() { return wt.berlinTag(jetzt().getTime()); }
function tag(d) { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const z = new Date(d); return new Date(z.getTime() - z.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function cent(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : null; }
function task(b) { try { return aufgaben.systemAufgabe(b); } catch (e) { return null; } }
async function jlog(e) { if (audit) { try { await audit.schreiben(e); } catch (x) {} } }
function monatVoraus(datum, monate) { const d = new Date(datum + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - (monate || 1)); return d.toISOString().slice(0, 10); }

async function verteilt(cl, bewId) {
  return Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM zahlung_zuordnung WHERE bewegung_id=$1 AND NOT storniert", [bewId])).rows[0].s);
}
function kundeVon(a) { return a.kunde || a.empfaenger || ''; }
async function ausgangStand(cl, ausgangId) {
  const a = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [ausgangId])).rows[0];
  if (!a) return null;
  const r = (await cl.query("SELECT coalesce(sum(betrag_cent),0) geld, coalesce(sum(skonto_cent),0) sk FROM zahlung_zuordnung WHERE ausgang_id=$1 AND NOT storniert", [ausgangId])).rows[0];
  const summe = Number(a.betrag_cent || 0), bezahlt = Number(r.geld) + Number(r.sk), rest = summe - bezahlt;
  const eh = Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM debitor_einbehalt WHERE ausgang_id=$1 AND status<>'zurueck'", [ausgangId])).rows[0].s);
  return { summe, geld: Number(r.geld), rest, einbehalt: eh, status: bezahlt <= 0 ? 'offen' : (rest > 0 ? 'teilweise' : 'bezahlt') };
}

// предложения: наши счета по клиенту, номеру в назначении, валюте и сумме. Не закрываем сами.
async function vorschlag(cl, bew) {
  const zweck = String(bew.verwendungszweck || '').toLowerCase();
  const rows = (await cl.query(
    "SELECT id, nummer, betrag_cent, empfaenger, kunde, kunde_key, faellig FROM ausgang_rechnung WHERE coalesce(kunde_key, '')=$1 OR lower(coalesce(kunde,empfaenger,''))=lower($2)",
    [bew.gegenpartei_key || '\u0000', bew.gegenpartei || '\u0000'])).rows;
  const out = [];
  for (const r of rows) {
    const st = await ausgangStand(cl, r.id); if (!st || st.rest <= 0) continue;
    const gruende = []; let staerke = 'schwach';
    if (r.nummer && zweck.includes(String(r.nummer).toLowerCase())) { gruende.push('номер счёта в назначении'); staerke = 'stark'; }
    if (st.rest === Number(bew.betrag_cent)) { gruende.push('сумма совпадает с остатком'); if (staerke !== 'stark') staerke = 'mittel'; }
    if (bew.waehrung && bew.waehrung !== 'EUR') gruende.push('валюта ' + bew.waehrung);
    gruende.push('тот же клиент');
    out.push({ ausgang_id: r.id, nummer: r.nummer, kunde: kundeVon(r), betrag_cent: Number(r.betrag_cent), rest_cent: st.rest, faellig: tag(r.faellig), gruende, staerke });
  }
  out.sort((a, b) => (a.staerke === 'stark' ? -1 : 1) - (b.staerke === 'stark' ? -1 : 1));
  return out;
}

// Импорт поступления (eingang). Идемпотентно по extern_id. Доход/счёт из факта не создаём.
async function eingangImport(d, user) {
  return mit(async (cl) => {
    const ext = d.extern_id ? String(d.extern_id) : null;
    if (ext) { const da = (await cl.query('SELECT id, status FROM bank_bewegung WHERE extern_id=$1', [ext])).rows[0];
      if (da) return { ok: true, wiederholung: true, id: da.id, status: da.status, grund: 'повторный импорт — поступление уже есть' }; }
    const betrag = cent(d.betrag != null ? d.betrag : d.betrag_cent);
    if (!(betrag > 0)) throw new Error('нужна сумма поступления');
    const gp = String(d.gegenpartei || '').trim();
    const von = (user && user.login) || 'system';
    const ins = await cl.query(
      `INSERT INTO bank_bewegung (extern_id, richtung, betrag_cent, waehrung, datum, gegenpartei, gegenpartei_key, verwendungszweck, iban, konto, art, von)
       VALUES ($1,'eingang',$2,$3,$4,$5,$6,$7,$8,$9,'ueberweisung',$10) RETURNING *`,
      [ext, betrag, (d.waehrung || 'EUR').toUpperCase(), /^\d{4}-\d{2}-\d{2}$/.test(String(d.datum || '')) ? d.datum : heute(),
       gp || null, razn.schluessel(gp) || null, String(d.verwendungszweck || '').slice(0, 400) || null,
       String(d.iban || '').replace(/\s/g, '').toUpperCase() || null, String(d.konto || '').slice(0, 80) || null, von]);
    const bew = ins.rows[0];
    const vor = await vorschlag(cl, bew);
    let frist = null;
    if (!vor.length) {
      frist = wt.fristEnde(heute(), 1);
      await cl.query('UPDATE bank_bewegung SET pruef_frist=$2 WHERE id=$1', [bew.id, frist]);
      const t = task({ titel: 'Нераспределённое поступление — найти основание', ziel_rolle: 'buchhaltung', art: 'eingang_offen',
        text: 'Поступление #' + bew.id + ' (' + (gp || 'плательщик?') + ', ' + (betrag / 100).toFixed(2) + ' €) без нашего счёта. Разобрать за 1 р.д. Доход/счёт из факта не создавать.', bezug: 'bank:' + bew.id });
      await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, art, text, betrag_cent, aufgabe_id, von) VALUES ($1,'eingang_offen',$2,$3,$4,$5)", [bew.id, 'основание не найдено', betrag, t && t.id, von]);
    }
    await jlog({ wer: von, rolle: user && user.rolle, art: 'eingang_import', ziel: 'bank:' + bew.id });
    return { ok: true, id: bew.id, betrag_cent: betrag, status: bew.status, vorschlag: vor, pruef_frist: frist, ohne_grund: !vor.length };
  });
}

module.exports = {};

async function bewLaden(cl, id) { return (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1 FOR UPDATE', [Number(id)])).rows[0]; }
async function statusNeu(cl, bew) {
  const v = await verteilt(cl, bew.id);
  let st = v <= 0 ? 'nicht_zugeordnet' : (v >= Number(bew.betrag_cent) ? 'zugeordnet' : 'teilweise');
  if (bew.status === 'ueberzahlt') st = 'ueberzahlt';
  await cl.query('UPDATE bank_bewegung SET status=$2 WHERE id=$1', [bew.id, st]);
  return st;
}

// 1,2,8,9,12) распределение поступления на наши счета. Третье лицо — после проверки. Не сверх суммы/остатка.
async function zuordnen(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id);
    if (!bew) throw new Error('поступление не найдено');
    if (bew.richtung !== 'eingang') throw new Error('это не поступление от клиента');
    if (bew.storniert) throw new Error('поступление сторнировано');
    const teile = Array.isArray(d.teile) ? d.teile : [];
    if (!teile.length) throw new Error('нет распределения');
    const von = (user && user.login) || 'system';
    const vorHer = await verteilt(cl, bew.id);
    let neu = 0; for (const t of teile) neu += Math.max(0, cent(t.betrag) || 0);
    if (vorHer + neu > Number(bew.betrag_cent)) throw new Error('распределение превышает поступление (нельзя распределить одну сумму дважды)');
    const ergeb = [];
    for (const t of teile) {
      const aid = Number(t.ausgang_id); if (!aid) throw new Error('нет счёта');
      const a = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [aid])).rows[0];
      if (!a) throw new Error('счёт #' + aid + ' не найден');
      // 9) третье лицо: плательщик ≠ клиент по счёту — только после проверки бухгалтера
      const kkey = a.kunde_key || razn.schluessel(kundeVon(a));
      if (kkey && bew.gegenpartei_key && kkey !== bew.gegenpartei_key && d.dritter_geprueft !== true)
        throw new Error('поступление от третьего лица (' + (bew.gegenpartei || '') + ' ≠ клиент счёта) — подтвердите проверку: кто, за кого, основание');
      const geld = Math.max(0, cent(t.betrag) || 0); if (geld <= 0) continue;
      const st = await ausgangStand(cl, aid); if (geld > st.rest) throw new Error('по счёту #' + aid + ' сумма больше остатка (' + (st.rest / 100).toFixed(2) + ' €) — долг сверх счёта не закрываем');
      await cl.query('INSERT INTO zahlung_zuordnung (bewegung_id, ausgang_id, betrag_cent, art, grund, von) VALUES ($1,$2,$3,$4,$5,$6)', [bew.id, aid, geld, 'eingang', String(t.grund || d.grund || '').slice(0, 300), von]);
      await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, ausgang_id, kunde, art, text, betrag_cent, von) VALUES ($1,$2,$3,'zuordnung',$4,$5,$6)", [bew.id, aid, kundeVon(a), 'оплата ' + (geld / 100).toFixed(2) + ' € на счёт ' + (a.nummer || aid), geld, von]);
      if (kkey && bew.gegenpartei_key && kkey !== bew.gegenpartei_key)
        await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, ausgang_id, kunde, art, text, von) VALUES ($1,$2,$3,'dritter',$4,$5)", [bew.id, aid, kundeVon(a), 'платёж третьего лица (' + (bew.gegenpartei || '') + '), проверено: ' + String(d.dritter_grund || '').slice(0, 200), von]);
      const st2 = await ausgangStand(cl, aid);
      ergeb.push({ ausgang_id: aid, geld, rest: st2.rest, status: st2.status });
    }
    const status = await statusNeu(cl, bew);
    const v = await verteilt(cl, bew.id);
    await jlog({ wer: von, rolle: user && user.rolle, art: 'debitor_zuordnung', ziel: 'bank:' + bew.id });
    return { ok: true, status, verteilt: v, rest_zahlung: Number(bew.betrag_cent) - v, teile: ergeb, invariante_ok: v <= Number(bew.betrag_cent) };
  });
}

async function zuordnungStorno(d, user) {
  return mit(async (cl) => {
    const z = (await cl.query('SELECT * FROM zahlung_zuordnung WHERE id=$1', [Number(d.id)])).rows[0];
    if (!z) throw new Error('распределение не найдено');
    if (z.storniert) return { ok: true, wiederholt: true };
    await cl.query('UPDATE zahlung_zuordnung SET storniert=true WHERE id=$1', [z.id]);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, ausgang_id, art, text, betrag_cent, von) VALUES ($1,$2,'storno',$3,$4,$5)", [z.bewegung_id, z.ausgang_id, 'снято распределение', z.betrag_cent, (user && user.login) || 'system']);
    const bew = (await cl.query('SELECT * FROM bank_bewegung WHERE id=$1', [z.bewegung_id])).rows[0];
    await statusNeu(cl, bew);
    return { ok: true };
  });
}

// 7) переплата: остаток поступления — за клиентом (аванс/ошибка). Доход/счёт/возврат не создаём.
async function ueberzahlungKunde(d, user) {
  return mit(async (cl) => {
    const bew = await bewLaden(cl, d.bewegung_id); if (!bew) throw new Error('поступление не найдено');
    const v = await verteilt(cl, bew.id); const rest = Number(bew.betrag_cent) - v;
    if (rest <= 0) throw new Error('нераспределённого остатка нет');
    const art = ['anzahlung', 'fehler'].includes(d.art) ? d.art : 'klaerung';
    await cl.query('INSERT INTO debitor_kredit (bewegung_id, kunde, betrag_cent, art, grund, von) VALUES ($1,$2,$3,$4,$5,$6)', [bew.id, bew.gegenpartei, rest, art, String(d.grund || '').slice(0, 200), (user && user.login) || 'system']);
    await cl.query("UPDATE bank_bewegung SET status='ueberzahlt' WHERE id=$1", [bew.id]);
    await cl.query("INSERT INTO zahlung_ereignis (bewegung_id, kunde, art, text, betrag_cent, von) VALUES ($1,$2,'kredit',$3,$4,$5)", [bew.id, bew.gegenpartei, 'нераспределённое за клиентом: ' + art, rest, (user && user.login) || 'system']);
    return { ok: true, rest_cent: rest, art };
  });
}

// 3) спорная недоплата: фиксируем причину, задача ответственному. Разницу не списываем (остаток остаётся открытым).
async function unterzahlung(d, user) {
  return mit(async (cl) => {
    const aid = Number(d.ausgang_id); if (!aid) throw new Error('нет счёта');
    const a = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [aid])).rows[0]; if (!a) throw new Error('счёт не найден');
    const art = ['skonto', 'anspruch', 'sonstiges'].includes(d.art) ? d.art : 'sonstiges';
    const t = task({ titel: 'Спорная недоплата — выяснить основание', ziel_rolle: 'buchhaltung', art: 'unterzahlung',
      text: 'По счёту ' + (a.nummer || aid) + ' (' + kundeVon(a) + ') недоплата, причина: ' + art + '. ' + String(d.grund || '').slice(0, 200) + '. Разницу не списывать; ответственный по клиенту выясняет основание.', bezug: 'ausgang:' + aid });
    await cl.query("INSERT INTO zahlung_ereignis (ausgang_id, kunde, art, text, betrag_cent, aufgabe_id, von) VALUES ($1,$2,'unterzahlung_grund',$3,$4,$5,$6)", [aid, kundeVon(a), art + ': ' + String(d.grund || '').slice(0, 200), cent(d.betrag), t && t.id, (user && user.login) || 'system']);
    return { ok: true, hinweis: 'причина зафиксирована; остаток остаётся под контролем, не списан' };
  });
}

// 4,6) гарантийное удержание отдельно; до проверки — неподтверждённая недоплата; событийный срок = «Срок не определён».
async function einbehaltErfassen(d, user) {
  return mit(async (cl) => {
    const aid = Number(d.ausgang_id); if (!aid) throw new Error('нет счёта');
    const a = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [aid])).rows[0]; if (!a) throw new Error('счёт не найден');
    const betrag = cent(d.betrag); if (!(betrag > 0)) throw new Error('нужна сумма удержания');
    const ereignis = d.ereignis_abhaengig === true;
    const rueckgabe = (!ereignis && /^\d{4}-\d{2}-\d{2}$/.test(String(d.rueckgabe || ''))) ? d.rueckgabe : null;
    const r = await cl.query('INSERT INTO debitor_einbehalt (ausgang_id, kunde, objekt_nr, betrag_cent, grundlage, bedingungen, rueckgabe, ereignis_abhaengig, von) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [aid, kundeVon(a), a.objekt_nr, betrag, String(d.grundlage || '').slice(0, 300), String(d.bedingungen || '').slice(0, 300), rueckgabe, ereignis, (user && user.login) || 'system']);
    await cl.query("INSERT INTO zahlung_ereignis (ausgang_id, kunde, art, text, betrag_cent, von) VALUES ($1,$2,'einbehalt',$3,$4,$5)", [aid, kundeVon(a), 'гарантийное удержание' + (ereignis ? ' (срок не определён)' : (rueckgabe ? ' до ' + rueckgabe : '')), betrag, (user && user.login) || 'system']);
    if (ereignis) task({ titel: 'Удержание: срок возврата не определён — уточнить', ziel_rolle: 'buchhaltung', art: 'einbehalt_klaerung',
      text: 'Удержание по счёту ' + (a.nummer || aid) + ' (' + kundeVon(a) + '): срок зависит от события. Уточнить через ответственного по клиенту. Выдуманную дату в прогноз не ставить.', bezug: 'ausgang:' + aid });
    return { ok: true, id: r.rows[0].id, srok: ereignis ? 'не определён' : rueckgabe, status: 'unbestaetigt' };
  });
}
async function einbehaltBestaetigen(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id);
    await cl.query("UPDATE debitor_einbehalt SET status='bestaetigt', geprueft_von=$2 WHERE id=$1 AND status='unbestaetigt'", [id, (user && user.login) || null]);
    return { ok: true };
  });
}
// 5) за месяц до возврата — задача бухгалтеру (запрос через ответственного). Клиентам сообщения не шлём.
async function einbehaltPruefung(d, user) {
  return mit(async (cl) => {
    const h = heute();
    const rows = (await cl.query("SELECT * FROM debitor_einbehalt WHERE status<>'zurueck' AND rueckgabe IS NOT NULL ORDER BY rueckgabe")).rows;
    const faellig = [];
    for (const e of rows) {
      const start = monatVoraus(tag(e.rueckgabe), 1);
      if (start <= h) {   // до возврата <= 1 месяц
        const schon = (await cl.query("SELECT 1 FROM zahlung_ereignis WHERE ausgang_id=$1 AND art='einbehalt_faellig' AND am > now()-interval '20 days'", [e.ausgang_id])).rows[0];
        if (!schon) {
          const t = task({ titel: 'Возврат удержания через месяц — проверить условия', ziel_rolle: 'buchhaltung', art: 'einbehalt_faellig',
            text: 'Удержание ' + (e.betrag_cent / 100).toFixed(2) + ' € (' + (e.kunde || '') + ') к возврату ' + tag(e.rueckgabe) + '. Проверить условия и через ответственного по клиенту подготовить запрос. Клиенту автоматически не писать.', bezug: 'ausgang:' + e.ausgang_id });
          await cl.query("INSERT INTO zahlung_ereignis (ausgang_id, kunde, art, text, aufgabe_id, von) VALUES ($1,$2,'einbehalt_faellig',$3,$4,$5)", [e.ausgang_id, e.kunde, 'напоминание о возврате удержания', t && t.id, (user && user.login) || 'system']);
        }
        faellig.push({ id: e.id, kunde: e.kunde, betrag_cent: Number(e.betrag_cent), rueckgabe: tag(e.rueckgabe) });
      }
    }
    const ohneDatum = (await cl.query("SELECT id, kunde, betrag_cent FROM debitor_einbehalt WHERE status<>'zurueck' AND ereignis_abhaengig")).rows.map(e => ({ id: e.id, kunde: e.kunde, betrag_cent: Number(e.betrag_cent) }));
    return { ok: true, faellig, ohne_datum: ohneDatum };
  });
}

// 10) перед напоминанием клиенту — показать потенциально связанные, ещё проверяемые поступления.
async function mahnWarnung(d) {
  return mit(async (cl) => {
    const aid = Number(d.ausgang_id); if (!aid) throw new Error('нет счёта');
    const a = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [aid])).rows[0]; if (!a) throw new Error('счёт не найден');
    const kkey = a.kunde_key || razn.schluessel(kundeVon(a));
    const st = await ausgangStand(cl, aid);
    const verwandte = (await cl.query(
      "SELECT id, datum, betrag_cent, verwendungszweck, status FROM bank_bewegung WHERE richtung='eingang' AND NOT storniert AND status IN ('nicht_zugeordnet','teilweise') AND gegenpartei_key=$1 ORDER BY datum DESC", [kkey || '\u0000'])).rows
      .map(b => ({ id: b.id, datum: tag(b.datum), betrag_cent: Number(b.betrag_cent), verwendungszweck: b.verwendungszweck, status: b.status }));
    return { ok: true, ausgang: { id: aid, nummer: a.nummer, kunde: kundeVon(a), rest_cent: st ? st.rest : null, faellig: tag(a.faellig) },
      verwandte, warnung: verwandte.length ? 'есть непроверенные поступления этого клиента — сверьте перед напоминанием; долг без подтверждения не закрывать' : null };
  });
}

let integration = null; try { integration = require('./integration.js'); } catch (e) {}
async function bankFrisch() {
  if (!integration) return { vorlaeufig: false, stand: null, bekannt: false };
  try { const s = await integration.statusListe(); return { vorlaeufig: !!s.bank_vorlaeufig, stand: s.bank_stand || null, bekannt: true }; } catch (e) { return { vorlaeufig: false, stand: null, bekannt: false }; }
}

// Экран дебиторки: поступления на разбор, задолженность по счетам, удержания, кредиты за клиентами.
async function liste() {
  return mit(async (cl) => {
    const h = heute();
    const frisch = await bankFrisch();
    const saldo = Number((await cl.query("SELECT coalesce(sum(CASE WHEN richtung='eingang' THEN betrag_cent ELSE -betrag_cent END),0) s FROM bank_bewegung WHERE NOT storniert")).rows[0].s);
    const brows = (await cl.query("SELECT * FROM bank_bewegung WHERE richtung='eingang' AND NOT storniert AND status IN ('nicht_zugeordnet','teilweise','ueberzahlt') ORDER BY (pruef_frist IS NULL), datum DESC")).rows;
    const eingaenge = [];
    for (const b of brows) {
      const v = await verteilt(cl, b.id);
      const zu = (await cl.query("SELECT z.id, z.ausgang_id, z.betrag_cent, a.nummer, a.empfaenger, a.kunde FROM zahlung_zuordnung z LEFT JOIN ausgang_rechnung a ON a.id=z.ausgang_id WHERE z.bewegung_id=$1 AND NOT z.storniert ORDER BY z.id", [b.id])).rows
        .map(z => ({ id: z.id, ausgang_id: z.ausgang_id, nummer: z.nummer, kunde: z.kunde || z.empfaenger, betrag_cent: Number(z.betrag_cent) }));
      const vor = await vorschlag(cl, b);
      const kredit = (await cl.query("SELECT id, betrag_cent, art, status FROM debitor_kredit WHERE bewegung_id=$1", [b.id])).rows.map(k => ({ ...k, betrag_cent: Number(k.betrag_cent) }));
      eingaenge.push({ id: b.id, datum: tag(b.datum), gegenpartei: b.gegenpartei, verwendungszweck: b.verwendungszweck,
        betrag_cent: Number(b.betrag_cent), waehrung: b.waehrung, status: b.status, verteilt: v, rest_zahlung: Number(b.betrag_cent) - v,
        pruef_frist: tag(b.pruef_frist), ueberfaellig: !!(b.pruef_frist && tag(b.pruef_frist) < h),
        zuordnungen: zu, vorschlag: vor, kredit });
    }
    // задолженность по нашим счетам (контроль дебиторки)
    const arows = (await cl.query("SELECT id, nummer, betrag_cent, empfaenger, kunde, faellig, objekt_nr FROM ausgang_rechnung WHERE betrag_cent IS NOT NULL ORDER BY faellig NULLS LAST, id")).rows;
    const forderungen = [];
    for (const a of arows) {
      const st = await ausgangStand(cl, a.id); if (!st || st.rest <= 0) continue;
      forderungen.push({ ausgang_id: a.id, nummer: a.nummer, kunde: a.kunde || a.empfaenger, objekt_nr: a.objekt_nr,
        betrag_cent: st.summe, bezahlt_cent: st.geld, rest_cent: st.rest, einbehalt_cent: st.einbehalt,
        faellig: tag(a.faellig), ueberfaellig: !!(a.faellig && tag(a.faellig) < h), status: st.status });
    }
    const eh = (await cl.query("SELECT * FROM debitor_einbehalt WHERE status<>'zurueck' ORDER BY (rueckgabe IS NULL), rueckgabe")).rows.map(e => ({
      id: e.id, ausgang_id: e.ausgang_id, kunde: e.kunde, objekt_nr: e.objekt_nr, betrag_cent: Number(e.betrag_cent),
      grundlage: e.grundlage, bedingungen: e.bedingungen, rueckgabe: tag(e.rueckgabe), ereignis_abhaengig: e.ereignis_abhaengig,
      srok_offen: !e.rueckgabe, bald: !!(e.rueckgabe && monatVoraus(tag(e.rueckgabe), 1) <= h), status: e.status }));
    const kredite = (await cl.query("SELECT id, kunde, betrag_cent, art, status FROM debitor_kredit WHERE status='offen' ORDER BY id DESC")).rows.map(k => ({ ...k, betrag_cent: Number(k.betrag_cent) }));
    const forderung_summe = forderungen.reduce((s, x) => s + x.rest_cent, 0);
    return { stand: h, frisch, saldo_cent: saldo, eingaenge, forderungen, forderung_summe_cent: forderung_summe, einbehalte: eh, kredite };
  });
}

async function eins(id) {
  return mit(async (cl) => {
    const b = (await cl.query("SELECT * FROM bank_bewegung WHERE id=$1", [Number(id)])).rows[0];
    if (!b) throw new Error('поступление не найдено');
    const zu = (await cl.query("SELECT z.*, a.nummer, a.kunde, a.empfaenger FROM zahlung_zuordnung z LEFT JOIN ausgang_rechnung a ON a.id=z.ausgang_id WHERE z.bewegung_id=$1 ORDER BY z.id", [b.id])).rows;
    const hist = (await cl.query("SELECT * FROM zahlung_ereignis WHERE bewegung_id=$1 ORDER BY id", [b.id])).rows;
    const v = await verteilt(cl, b.id);
    return { bewegung: { ...b, betrag_cent: Number(b.betrag_cent), datum: tag(b.datum), pruef_frist: tag(b.pruef_frist) }, verteilt: v, rest_zahlung: Number(b.betrag_cent) - v, zuordnungen: zu, historie: hist, vorschlag: await vorschlag(cl, b) };
  });
}

module.exports = { eingangImport, vorschlag, zuordnen, zuordnungStorno, ueberzahlungKunde, unterzahlung,
  einbehaltErfassen, einbehaltBestaetigen, einbehaltPruefung, mahnWarnung, ausgangStand, liste, eins };
