/* ---------------------------------------------------------------
   Экономика объекта + привязка к единому реестру ядра (Дополнение №3).
   ЕДИНАЯ БАЗА — ядро vav_kern (объекты VK-26-NNN, один нумератор,
   алиасы для дублей). Бухгалтер её ЧИТАЕТ и привязывает по номеру,
   новую базу не заводит («копия справочника — не связь»,
   «у каждой вещи один хозяин»). В пилоте реестр ядра лежит зеркалом
   в таблице kern_objekt (снимок vav_kern.objekt + клиент + пометка
   дублей); в бою тот же код читает vav_kern/vavapp живьём.
   Показатели экономики — objekt_oekonomik (боевую базу не трогаем).
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }

// §8-A: единый реестр объектов через адаптер. По умолчанию — зеркало kern_objekt;
// BUCH_KERN_LIVE=1 переключает на живой vav_kern (тот же Postgres, межсхемные JOIN).
const kern = require('./kern.js');
const KERN = kern.quelle();   // 'kern_objekt' | 'vav_kern.objekt_kompat'

// Каталог показателей (§1).
// kennzahl-таблица: простые одиночные суммы. Nachträge и ETC — отдельные сущности (Фаза 2).
const KENNZAHLEN = [
  { k: 'budget',        titel: 'Утверждённый бюджет',              art: 'plan',         gruppe: 'plan' },
  { k: 'auftragswert',  titel: 'Подтверждённая стоимость заказа',  art: 'bestaetigt',   gruppe: 'auftrag' },
  { k: 'ist_kosten',    titel: 'Фактические затраты (вне заказов)', art: 'ist',          gruppe: 'kosten' },
  { k: 'zahlung_ein',   titel: 'Поступления денег',                art: 'zahlung',      gruppe: 'geld' },
  { k: 'forderung',     titel: 'Задолженность заказчика',          art: 'ist',          gruppe: 'geld' },
];
const KAT = Object.fromEntries(KENNZAHLEN.map(x => [x.k, x]));
const PFLICHT = ['budget', 'auftragswert', 'ist_kosten'];
const WOCHE_MS = 7 * 24 * 3600 * 1000;
const SCHWELLE_CENT = 300000; // 3000 € brutto — граница полномочий Олега (решение №1)

// Нужно ли решение Андрея по закупке: сумма >3000, сверх бюджета, бюджет не задан,
// или дробление связанных закупок (тот же объект+поставщик за 30 дней) через порог.
async function budgetPruef(cl, nr, summe, excludeId) {
  const budget = (await cl.query("SELECT wert_cent FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl='budget'", [nr])).rows[0];
  const istRow = (await cl.query("SELECT coalesce(wert_cent,0) w FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl='ist_kosten'", [nr])).rows[0];
  const ist = Number(istRow ? istRow.w : 0);
  const best = (await cl.query("SELECT b.id,b.summe_cent,b.status, coalesce((SELECT sum(betrag_cent) FROM bestellung_rechnung r WHERE r.bestellung_id=b.id),0) fakt FROM bestellung b WHERE b.objekt_nr=$1", [nr])).rows;
  let belegt = ist;
  for (const b of best) { if (String(b.id) === String(excludeId)) continue; if (b.status !== 'storniert') belegt += Math.max(0, Number(b.summe_cent || 0) - Number(b.fakt || 0)); }
  if (!budget || budget.wert_cent == null) return { braucht: true, grund: 'kein_budget' };
  if (belegt + summe > Number(budget.wert_cent)) return { braucht: true, grund: 'budget' };
  return { braucht: false };
}
async function pruefGenehmigung(cl, nr, summe, lieferant, excludeId) {
  if (summe > SCHWELLE_CENT) return { braucht: true, grund: 'summe' };
  const bp = await budgetPruef(cl, nr, summe, excludeId); if (bp.braucht) return bp;
  const s = Number((await cl.query(
    "SELECT coalesce(sum(summe_cent),0) s FROM bestellung WHERE objekt_nr=$1 AND lower(lieferant)=lower($2) AND status<>'storniert' AND id<>$3 AND angelegt > now()-interval '30 days'",
    [nr, lieferant, excludeId || 0])).rows[0].s);
  if (s + summe > SCHWELLE_CENT) return { braucht: true, grund: 'split' };
  return { braucht: false, grund: null };
}
// Производный статус утверждения закупки.
function genehmStatus(bo) {
  if (bo.ablehn_grund) return 'abgelehnt';
  const olegOk = !!bo.oleg_am, gfOk = !!bo.gf_am;
  if (bo.braucht_andrej) return (olegOk && gfOk) ? 'genehmigt' : (olegOk ? 'wartet_andrej' : 'offen');
  return (olegOk || gfOk) ? 'genehmigt' : 'offen';
}

async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}

// клиент объекта: сначала номер клиента (kunden_nr/debitor_nr), иначе сырое имя
function kundeAnzeige(o) {
  const name = o.kunde_name || o.kunde || '';
  const nr = o.kunden_nr || null;
  const deb = o.debitor_nr || null;
  return { name: name || null, kunden_nr: nr, debitor_nr: deb, hat_nummer: !!(nr || deb) };
}

async function objektListe() {
  return mit(async (cl) => {
    // сведённые дубли (merged_into) в списке не показываем — только канонические
    const rows = (await cl.query(
      `SELECT k.nummer, k.bez, k.kunde, k.kunde_name, k.kunden_nr, k.debitor_nr, k.firma, k.status, k.dup_gruppe,
              (SELECT count(*) FROM ${KERN} m WHERE m.merged_into=k.nummer) AS merged_count,
              (SELECT count(*) FROM ${KERN} s WHERE s.dup_gruppe=k.dup_gruppe AND s.merged_into IS NULL) AS grp_sichtbar,
              EXISTS(SELECT 1 FROM objekt_oekonomik o WHERE o.objekt_nr=k.nummer) AS hat_oekonomik
       FROM ${KERN} k WHERE k.merged_into IS NULL ORDER BY (k.status='fertig'), k.nummer`)).rows;
    return rows.map(o => ({
      nr: o.nummer, bez: o.bez, kunde: kundeAnzeige(o), firma: o.firma || '', status: o.status || '',
      dup: !!(o.dup_gruppe && Number(o.grp_sichtbar) > 1),   // ещё не разобранный дубль
      merged_count: Number(o.merged_count) || 0,             // сколько номеров сведено сюда
      hat_oekonomik: o.hat_oekonomik,
    }));
  });
}

async function objektEins(nr) {
  return mit(async (cl) => {
    // разрешаем номер/алиас/сведённый дубль к каноническому через адаптер реестра
    const kanNr = await kern.kanon(cl, nr);
    if (!kanNr) throw new Error('нет такого объекта: ' + nr);
    const umgeleitet = (kanNr !== nr) ? nr : null;
    let o = (await cl.query(`SELECT * FROM ${KERN} WHERE nummer=$1`, [kanNr])).rows[0];
    if (!o) throw new Error('нет такого объекта: ' + nr);
    // сведённые сюда номера (уже разобранные дубли; в живом режиме — через алиасы, пусто)
    const zusammengefuehrt = (await cl.query(
      `SELECT nummer, bez, status FROM ${KERN} WHERE merged_into=$1 ORDER BY nummer`, [o.nummer])).rows;
    // ещё не разобранные дубли той же группы (видимые, не сведённые)
    let dubletten = [];
    if (o.dup_gruppe) {
      dubletten = (await cl.query(
        `SELECT nummer, bez, status FROM ${KERN} WHERE dup_gruppe=$1 AND nummer<>$2 AND merged_into IS NULL ORDER BY nummer`, [o.dup_gruppe, o.nummer])).rows;
    }
    const rows = (await cl.query('SELECT kennzahl, wert_cent, art, quelle, periode, unverteilt_cent, pruefstatus, notiz, beleg_ref, von, stand FROM objekt_oekonomik WHERE objekt_nr=$1', [o.nummer])).rows;
    const by = {}; rows.forEach(r => { by[r.kennzahl] = r; });
    const wert = k => (by[k] && by[k].wert_cent != null ? Number(by[k].wert_cent) : null);
    const v = k => wert(k) || 0;
    // Nachträge (§2) — позициями
    const nachtraege = (await cl.query('SELECT id, bezeichnung, betrag_cent, status, basis, datum, beleg_ref, notiz, bestaetigt_am, bestaetigt_von, angelegt FROM nachtrag WHERE objekt_nr=$1 ORDER BY (status<>$2), angelegt', [o.nummer, 'bestaetigt'])).rows;
    const nachtrag_best = nachtraege.filter(x => x.status === 'bestaetigt').reduce((s, x) => s + Number(x.betrag_cent || 0), 0);
    const nachtrag_offen = nachtraege.filter(x => x.status !== 'bestaetigt').reduce((s, x) => s + Number(x.betrag_cent || 0), 0);
    // ETC (§3) — версии
    const etcs = (await cl.query('SELECT id, betrag_cent, grund, von, stand FROM etc_version WHERE objekt_nr=$1 ORDER BY stand DESC LIMIT 5', [o.nummer])).rows;
    const etcAkt = etcs[0] || null;
    const etcVor = etcs[1] || null;
    const etc = etcAkt ? Number(etcAkt.betrag_cent) : 0;
    const etc_vorhanden = !!etcAkt;
    const etc_stand = etcAkt ? etcAkt.stand : null;
    const etc_veraltet = etcAkt ? (Date.now() - new Date(etcAkt.stand).getTime() > WOCHE_MS) : false;
    const etc_delta = (etcAkt && etcVor) ? (Number(etcAkt.betrag_cent) - Number(etcVor.betrag_cent)) : null;
    // риски (§3)
    const risiken = (await cl.query('SELECT id, art, titel, text, delta_cent, angelegt FROM objekt_risiko WHERE objekt_nr=$1 AND NOT erledigt ORDER BY angelegt DESC', [o.nummer])).rows;
    // заказы-обязательства (§4)
    const best = (await cl.query('SELECT id, lieferant, summe_cent, umfang, soll_datum, basis, beleg_ref, notiz, status, angelegt, braucht_andrej, braucht_grund, oleg_von, oleg_am, gf_von, gf_am, ablehn_grund, ablehn_von FROM bestellung WHERE objekt_nr=$1 ORDER BY (status=$2), angelegt', [o.nummer, 'geschlossen'])).rows;
    const brech = (await cl.query('SELECT id, bestellung_id, betrag_cent, art, datum, rechnung_ref, notiz FROM bestellung_rechnung WHERE bestellung_id = ANY($1) ORDER BY datum NULLS LAST, id', [best.map(x => x.id)])).rows;
    const bestellungen = best.map(bo => {
      const rechs = brech.filter(r => r.bestellung_id === bo.id);
      const fakturiert = rechs.reduce((s, r) => s + Number(r.betrag_cent || 0), 0);
      const summe = Number(bo.summe_cent || 0);
      const offen_rest = bo.status === 'storniert' ? 0 : Math.max(0, summe - fakturiert);
      return { ...bo, summe_cent: summe, fakturiert, offen_rest, rechnungen: rechs, genehmigung: genehmStatus(bo) };
    });
    const ist_aus_bestellung = bestellungen.reduce((s, b) => s + b.fakturiert, 0);
    const verpflichtung = bestellungen.reduce((s, b) => s + b.offen_rest, 0);
    const ist_manuell = v('ist_kosten');
    // распределённые затраты на этот объект (§14–17): часы/жильё/техника/топливо
    const vrows = (await cl.query('SELECT p.art, coalesce(sum(x.betrag_cent),0) s FROM verteilung x JOIN verteilposten p ON p.id=x.posten_id WHERE x.objekt_nr=$1 GROUP BY p.art', [o.nummer])).rows;
    const verteilte_kosten = {}; let ist_verteilt = 0;
    vrows.forEach(r => { verteilte_kosten[r.art] = Number(r.s); ist_verteilt += Number(r.s); });
    // недостатки и требования к подрядчику (§9–10)
    const maengel = (await cl.query('SELECT id, subunternehmer, beschreibung, status, rechtsgrundlage, chk_vertrag, chk_mangel, chk_nachweise, chk_aufforderung, chk_empfang, chk_frist, chk_antwort, chk_kosten, chk_bezug, mangelkosten_cent, regress_cent, regress_status, notiz FROM mangel WHERE objekt_nr=$1 ORDER BY (status=$2), angelegt', [o.nummer, 'geklaert'])).rows;
    const ist_mangel = maengel.reduce((s, m) => s + Number(m.mangelkosten_cent || 0), 0);
    const regress_offen = maengel.filter(m => m.regress_status !== 'erhalten').reduce((s, m) => s + Number(m.regress_cent || 0), 0);
    const fotos = (await cl.query('SELECT id, datei_ref, autor, aufnahme_datum, aufnahme_quelle, upload_datum, zuordnung_art, verknuepfung, notiz FROM objekt_foto WHERE objekt_nr=$1 ORDER BY aufnahme_datum DESC NULLS LAST, id DESC', [o.nummer])).rows;
    const ist_gesamt = ist_manuell + ist_aus_bestellung + ist_verteilt + ist_mangel;
    // завершение (§6), удержания (§7), спор (§8)
    const abschluss = (await cl.query('SELECT arbeiten_fertig, arbeiten_am, dok_geprueft, dok_am, zu, zu_am, zu_von FROM objekt_abschluss WHERE objekt_nr=$1', [o.nummer])).rows[0]
      || { arbeiten_fertig: false, dok_geprueft: false, zu: false };
    const einbehalte = (await cl.query('SELECT id, art, betrag_cent, grund, freigabe_bedingung, erwartete_rueckgabe, verantwortlich, gebuehr_cent, ablauf, status, notiz FROM einbehalt WHERE objekt_nr=$1 ORDER BY (status<>$2), angelegt', [o.nummer, 'offen'])).rows;
    const streit = (await cl.query('SELECT id, betrag_cent, grund, status, entscheidung, entschieden_von, entschieden_am FROM forderung_streit WHERE objekt_nr=$1 ORDER BY (status<>$2), angelegt', [o.nummer, 'offen'])).rows;
    const ergebnis_historie = (await cl.query('SELECT ergebnis_cent, anlass, von, stand FROM ergebnis_version WHERE objekt_nr=$1 ORDER BY stand DESC LIMIT 8', [o.nummer])).rows;
    const einbehalt_offen = einbehalte.filter(x => x.status === 'offen').reduce((s, x) => s + Number(x.betrag_cent || 0), 0);
    const streit_offen = streit.filter(x => x.status === 'offen').reduce((s, x) => s + Number(x.betrag_cent || 0), 0);
    const forderung_ges = v('forderung');
    const forderung_strittig = Math.min(forderung_ges, streit_offen);
    const forderung_unstrittig = Math.max(0, forderung_ges - forderung_strittig);
    const finanzen_offen = (forderung_ges > 0) || (einbehalt_offen > 0);
    // исходящие счета (§11) + напоминания (§12) + обещанная дата
    const ausgang_rechnungen = (await cl.query('SELECT id, art, nummer, betrag_cent, datum, empfaenger, status, sv_basis_cent, sv_frueher_cent, sv_erhalten_cent, sv_rest_cent, sv_ok, gesendet_am, ergebnis FROM ausgang_rechnung WHERE objekt_nr=$1 ORDER BY angelegt DESC', [o.nummer])).rows;
    const rg_gesendet = ausgang_rechnungen.filter(x => x.status === 'gesendet').reduce((s, x) => s + Number(x.betrag_cent || 0), 0);
    const sverka = { basis: (v('auftragswert') + nachtrag_best), frueher: rg_gesendet, erhalten: v('zahlung_ein') };
    sverka.rest = sverka.basis - sverka.frueher;
    const mahnungen = (await cl.query('SELECT id, stufe, betrag_cent, status, vorbereitet_am, bestaetigt_von, bestaetigt_am, gesendet_am, ergebnis, notiz FROM mahnung WHERE objekt_nr=$1 ORDER BY id DESC', [o.nummer])).rows;
    const zusage = (await cl.query('SELECT id, datum, notiz FROM zahlungszusage WHERE objekt_nr=$1 AND aktiv ORDER BY datum DESC LIMIT 1', [o.nummer])).rows[0] || null;
    const heute = process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date();
    const mahn_pause = !!(zusage && new Date(zusage.datum) >= heute);
    // расчёт (§4: три непересекающиеся категории — факт / остаток обязательства / оценка)
    const erwartete_kosten = ist_gesamt + verpflichtung + etc;
    const ertragsbasis = v('auftragswert') + nachtrag_best;
    const prognose_ergebnis = ertragsbasis - erwartete_kosten;
    const prognose_mit_offen = prognose_ergebnis + nachtrag_offen;
    const budget_abw = (wert('budget') != null) ? (v('budget') - erwartete_kosten) : null;
    // полнота: обязательные kennzahl + наличие ETC
    const gefuellt = PFLICHT.filter(k => wert(k) != null);
    const fehlt = PFLICHT.filter(k => wert(k) == null); if (!etc_vorhanden) fehlt.push('etc');
    const vollstaendigkeit = { von: PFLICHT.length + 1, gefuellt: gefuellt.length + (etc_vorhanden ? 1 : 0), fehlt };
    const unverteilt = rows.filter(r => r.unverteilt_cent).map(r => ({ kennzahl: r.kennzahl, cent: Number(r.unverteilt_cent) }));
    return {
      objekt: {
        nr: o.nummer, bez: o.bez, adresse: o.adresse || '', firma: o.firma || '', status: o.status || '',
        kunde: kundeAnzeige(o), vavapp_id: o.vavapp_id || null,
        dup: dubletten.length > 0, dubletten,
        zusammengefuehrt, umgeleitet,
      },
      katalog: KENNZAHLEN, kennzahlen: by,
      nachtraege, bestellungen,
      etc: { vorhanden: etc_vorhanden, betrag_cent: etc, stand: etc_stand, veraltet: etc_veraltet,
             vorher_cent: etcVor ? Number(etcVor.betrag_cent) : null, delta_cent: etc_delta,
             grund: etcAkt ? etcAkt.grund : null, historie: etcs },
      risiken,
      abschluss: { ...abschluss, finanzen_offen }, einbehalte, streit, ergebnis_historie,
      ausgang_rechnungen, sverka, mahnungen, zusage, mahn_pause, maengel, fotos,
      berechnet: {
        ertragsbasis, erwartete_kosten, prognose_ergebnis, prognose_mit_offen,
        nachtrag_best, nachtrag_offen, budget_abw,
        ist_manuell, ist_aus_bestellung, ist_verteilt, verteilte_kosten, ist_mangel, regress_offen, ist_gesamt, verpflichtung, etc_cent: etc,
        zahlung_ein: wert('zahlung_ein'), forderung: wert('forderung'),
        forderung_strittig, forderung_unstrittig, einbehalt_offen, finanzen_offen,
        hinweis: 'Прогноз — «до общих расходов фирмы» (§18). Затраты не пересекаются (§4): факт (счета по заказам + вне заказов) · остаток обязательства · оценка ETC. Оплата не определяет признание затрат.',
      },
      vollstaendigkeit, unverteilt,
    };
  });
}

async function kennzahlSetzen(b, login) {
  const nr = String(b.objekt_nr || '');
  const k = String(b.kennzahl || '');
  if (!KAT[k]) throw new Error('неизвестный показатель');
  return mit(async (cl) => {
    // объект должен существовать в реестре ядра (не выдумываем номер, §19)
    // сведённый дубль/алиас → пишем в канонический (через адаптер реестра)
    const nrK = await kern.kanon(cl, nr);
    if (!nrK) throw new Error('нет такого объекта в реестре');
    if (b.loeschen) {
      await cl.query('DELETE FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl=$2', [nrK, k]);
      return { ok: true, geloescht: true };
    }
    let wert_cent = null;
    if (b.wert !== '' && b.wert != null && Number.isFinite(Number(String(b.wert).replace(',', '.')))) {
      wert_cent = Math.round(parseFloat(String(b.wert).replace(',', '.')) * 100);
    }
    let unverteilt_cent = null;
    if (b.unverteilt !== '' && b.unverteilt != null && Number.isFinite(Number(String(b.unverteilt).replace(',', '.')))) {
      unverteilt_cent = Math.round(parseFloat(String(b.unverteilt).replace(',', '.')) * 100);
    }
    const art = b.art ? String(b.art).slice(0, 20) : KAT[k].art;
    const quelle = b.quelle ? String(b.quelle).slice(0, 20) : 'manuell';
    const periode = /^\d{4}(-\d{2})?$/.test(String(b.periode || '')) ? b.periode : null;
    const notiz = b.notiz != null ? String(b.notiz).slice(0, 400) : null;
    const beleg_ref = b.beleg_ref != null ? String(b.beleg_ref).slice(0, 200) : null;
    const pruefstatus = b.pruefstatus === 'bestaetigt' ? 'bestaetigt' : 'neu';
    await cl.query(
      `INSERT INTO objekt_oekonomik (objekt_nr, kennzahl, wert_cent, art, quelle, periode, unverteilt_cent, pruefstatus, notiz, beleg_ref, von, stand)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (objekt_nr, kennzahl) DO UPDATE SET
         wert_cent=$3, art=$4, quelle=$5, periode=$6, unverteilt_cent=$7, pruefstatus=$8, notiz=$9, beleg_ref=$10, von=$11, stand=now()`,
      [nrK, k, wert_cent, art, quelle, periode, unverteilt_cent, pruefstatus, notiz, beleg_ref, login]);
    return { ok: true };
  });
}

// разрешить сведённый номер в канонический + проверить существование
async function kanonNr(cl, nr) {
  const k = await kern.kanon(cl, nr);
  if (!k) throw new Error('нет такого объекта в реестре');
  return k;
}

/* ---------- Nachträge (§2) ---------- */
async function nachtragAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const bez = String(b.bezeichnung || '').trim();
    if (!bez) throw new Error('нужно название доп. работы');
    let cent = 0;
    if (b.betrag != null && Number.isFinite(Number(String(b.betrag).replace(',', '.')))) cent = Math.round(parseFloat(String(b.betrag).replace(',', '.')) * 100);
    const status = b.status === 'bestaetigt' ? 'bestaetigt' : 'offen';
    const basis = ['vertrag', 'auftrag', 'angebot', 'sonstiges'].includes(b.basis) ? b.basis : null;
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || '')) ? b.datum : null;
    const r = await cl.query(
      `INSERT INTO nachtrag (objekt_nr, bezeichnung, betrag_cent, status, basis, datum, beleg_ref, notiz, von,
         bestaetigt_am, bestaetigt_von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $4='bestaetigt' THEN now() END, CASE WHEN $4='bestaetigt' THEN $9 END)
       RETURNING id`,
      [nr, bez, cent, status, basis, datum, b.beleg_ref ? String(b.beleg_ref).slice(0, 200) : null, b.notiz ? String(b.notiz).slice(0, 400) : null, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function nachtragStatus(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM nachtrag WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    const status = b.status === 'bestaetigt' ? 'bestaetigt' : 'offen';
    await cl.query(
      `UPDATE nachtrag SET status=$2, geaendert=now(),
         bestaetigt_am = CASE WHEN $2='bestaetigt' THEN now() ELSE NULL END,
         bestaetigt_von = CASE WHEN $2='bestaetigt' THEN $3 ELSE NULL END
       WHERE id=$1`, [id, status, login]);
    return { ok: true, status };
  });
}

/* ---------- ETC-прогноз оставшихся затрат (§3) ---------- */
// прогноз итога при заданном etc (для снимка и сравнения)
async function prognoseMit(cl, nr, etcCent) {
  const rr = (await cl.query("SELECT kennzahl, wert_cent FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl IN ('auftragswert','ist_kosten')", [nr])).rows;
  const m = {}; rr.forEach(r => { m[r.kennzahl] = Number(r.wert_cent || 0); });
  const nb = Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM nachtrag WHERE objekt_nr=$1 AND status='bestaetigt'", [nr])).rows[0].s);
  // из заказов: факт (Σ счетов) и остаток обязательства (Σ max(0, сумма−факт), кроме сторно)
  const bo = (await cl.query(
    `SELECT b.summe_cent, b.status, coalesce((SELECT sum(betrag_cent) FROM bestellung_rechnung r WHERE r.bestellung_id=b.id),0) fakt
     FROM bestellung b WHERE b.objekt_nr=$1`, [nr])).rows;
  let fakturiert = 0, verpflichtung = 0;
  for (const b of bo) {
    const f = Number(b.fakt || 0); fakturiert += f;
    if (b.status !== 'storniert') verpflichtung += Math.max(0, Number(b.summe_cent || 0) - f);
  }
  const vert = Number((await cl.query('SELECT coalesce(sum(betrag_cent),0) s FROM verteilung WHERE objekt_nr=$1', [nr])).rows[0].s);
  const mang = Number((await cl.query('SELECT coalesce(sum(mangelkosten_cent),0) s FROM mangel WHERE objekt_nr=$1', [nr])).rows[0].s);
  // возмещение (regress) не сворачивается с расходом — в прогноз не идёт до получения (§10)
  return (m.auftragswert || 0) + nb - ((m.ist_kosten || 0) + fakturiert + vert + mang + verpflichtung + etcCent);
}
async function etcNeu(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    if (b.betrag == null || !Number.isFinite(Number(String(b.betrag).replace(',', '.')))) throw new Error('нужна сумма оценки (ETC)');
    const cent = Math.round(parseFloat(String(b.betrag).replace(',', '.')) * 100);
    const grund = b.grund ? String(b.grund).slice(0, 400) : null;
    const vor = (await cl.query('SELECT betrag_cent, prognose_snapshot_cent FROM etc_version WHERE objekt_nr=$1 ORDER BY stand DESC LIMIT 1', [nr])).rows[0] || null;
    const prognoseNeu = await prognoseMit(cl, nr, cent);
    const prognoseVor = vor ? (vor.prognose_snapshot_cent != null ? Number(vor.prognose_snapshot_cent) : await prognoseMit(cl, nr, Number(vor.betrag_cent))) : null;
    await cl.query('INSERT INTO etc_version (objekt_nr, betrag_cent, grund, von, prognose_snapshot_cent) VALUES ($1,$2,$3,$4,$5)', [nr, cent, grund, login, prognoseNeu]);
    // риск: прогнозная прибыль снизилась — сразу Андрею (дедуп: без повтора при том же delta)
    let risiko = false;
    if (prognoseVor != null && prognoseNeu < prognoseVor) {
      const delta = prognoseNeu - prognoseVor; // отрицательный
      const off = (await cl.query("SELECT delta_cent FROM objekt_risiko WHERE objekt_nr=$1 AND art='prognose' AND NOT erledigt ORDER BY angelegt DESC LIMIT 1", [nr])).rows[0];
      if (!off || Number(off.delta_cent) !== delta) {
        await cl.query('INSERT INTO objekt_risiko (objekt_nr, art, titel, text, delta_cent, von) VALUES ($1,$2,$3,$4,$5,$6)',
          [nr, 'prognose', 'Прогноз прибыли снизился', 'Новая оценка ETC ' + (cent / 100).toLocaleString('de-DE') + ' € снизила прогноз итога на ' + (Math.abs(delta) / 100).toLocaleString('de-DE') + ' €.' + (grund ? ' Причина: ' + grund : ' Причина не указана — запросить у Олега.'), delta, login]);
        risiko = true;
      }
    }
    return { ok: true, prognose: prognoseNeu, risiko };
  });
}
async function risikoErledigt(b) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    await cl.query('UPDATE objekt_risiko SET erledigt=true WHERE id=$1', [id]);
    return { ok: true };
  });
}
// устаревшие ETC (для постановки задач Олегу) — объекты с ETC старше недели ИЛИ активные без ETC
async function etcVeraltet() {
  return mit(async (cl) => {
    const rows = (await cl.query(
      `SELECT k.nummer, k.bez, e.stand
       FROM ${KERN} k
       LEFT JOIN LATERAL (SELECT stand FROM etc_version v WHERE v.objekt_nr=k.nummer ORDER BY stand DESC LIMIT 1) e ON true
       WHERE k.merged_into IS NULL AND k.status <> 'fertig'
         AND EXISTS (SELECT 1 FROM objekt_oekonomik o WHERE o.objekt_nr=k.nummer)
         AND (e.stand IS NULL OR e.stand < now() - interval '7 days')
       ORDER BY k.nummer`)).rows;
    return rows.map(r => ({ nr: r.nummer, bez: r.bez, stand: r.stand, nie: !r.stand }));
  });
}

/* ---------- Заказы-обязательства (§4) ---------- */
function eur(b) { return (b.betrag != null && Number.isFinite(Number(String(b.betrag).replace(',', '.')))) ? Math.round(parseFloat(String(b.betrag).replace(',', '.')) * 100) : null; }
async function bestellStatusNeu(cl, id) {
  const bo = (await cl.query('SELECT summe_cent, status FROM bestellung WHERE id=$1', [id])).rows[0];
  if (!bo || bo.status === 'storniert') return;
  const f = Number((await cl.query('SELECT coalesce(sum(betrag_cent),0) s FROM bestellung_rechnung WHERE bestellung_id=$1', [id])).rows[0].s);
  const summe = Number(bo.summe_cent || 0);
  const st = f <= 0 ? 'offen' : (f >= summe ? 'geschlossen' : 'teilweise');
  await cl.query('UPDATE bestellung SET status=$2, geaendert=now() WHERE id=$1', [id, st]);
}
async function bestellungAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const lief = String(b.lieferant || '').trim();
    if (!lief) throw new Error('нужен поставщик/подрядчик');
    const summe = eur(b) || 0;
    const basis = ['vertrag', 'auftrag', 'angebot', 'sonstiges'].includes(b.basis) ? b.basis : null;
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.soll_datum || '')) ? b.soll_datum : null;
    const g = await pruefGenehmigung(cl, nr, summe, lief, 0);   // нужен ли Андрей (решение №1)
    const r = await cl.query(
      'INSERT INTO bestellung (objekt_nr, lieferant, summe_cent, umfang, soll_datum, basis, beleg_ref, notiz, von, braucht_andrej, braucht_grund) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [nr, lief, summe, b.umfang ? String(b.umfang).slice(0, 300) : null, datum, basis, b.beleg_ref ? String(b.beleg_ref).slice(0, 200) : null, b.notiz ? String(b.notiz).slice(0, 400) : null, login, g.braucht, g.grund || null]);
    return { ok: true, id: r.rows[0].id, braucht_andrej: g.braucht, braucht_grund: g.grund || null };
  });
}

// Утверждение закупки (решение №1). Олег утверждает ≤3000 € в бюджете; >3000 €/сверх бюджета/
// дробление — требует Андрея вместе с Олегом. Отсутствие Андрея = закупка ждёт (без авто-делегирования).
async function bestellungGenehmigen(b, user) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    const bo = (await cl.query('SELECT * FROM bestellung WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!bo) throw new Error('заказ не найден');
    if (bo.status === 'storniert') throw new Error('заказ сторнирован');
    // пересчёт необходимости Андрея на момент решения (бюджет мог измениться)
    const g = await pruefGenehmigung(cl, bo.objekt_nr, Number(bo.summe_cent || 0), bo.lieferant, id);
    await cl.query('UPDATE bestellung SET braucht_andrej=$2, braucht_grund=$3 WHERE id=$1', [id, g.braucht, g.grund || null]);
    const rolle = user.rolle;
    const istOleg = rolle === 'disponent';
    const istGf = rolle === 'gf';
    if (!istOleg && !istGf) throw new Error('закупку утверждает Олег или Андрей');

    if (b.entscheidung === 'ablehnen') {
      await cl.query('UPDATE bestellung SET ablehn_grund=$2, ablehn_von=$3, geaendert=now() WHERE id=$1', [id, String(b.grund || 'отклонено').slice(0, 400), user.login]);
      await cl.query('INSERT INTO bestellung_genehmigung_log (bestellung_id,ereignis,rolle,autor,notiz) VALUES ($1,$2,$3,$4,$5)', [id, 'abgelehnt', rolle, user.login, String(b.grund || '').slice(0, 400)]);
      return { ok: true, genehmigung: 'abgelehnt' };
    }
    // снятие отклонения при повторном заходе
    if (bo.ablehn_grund) await cl.query('UPDATE bestellung SET ablehn_grund=NULL, ablehn_von=NULL WHERE id=$1', [id]);
    if (istOleg) {
      await cl.query('UPDATE bestellung SET oleg_von=$2, oleg_am=now(), geaendert=now() WHERE id=$1', [id, user.login]);
      await cl.query('INSERT INTO bestellung_genehmigung_log (bestellung_id,ereignis,rolle,autor) VALUES ($1,$2,$3,$4)', [id, 'oleg_ok', rolle, user.login]);
    } else {   // gf
      await cl.query('UPDATE bestellung SET gf_von=$2, gf_am=now(), geaendert=now() WHERE id=$1', [id, user.login]);
      await cl.query('INSERT INTO bestellung_genehmigung_log (bestellung_id,ereignis,rolle,autor) VALUES ($1,$2,$3,$4)', [id, 'andrej_ok', rolle, user.login]);
    }
    const upd = (await cl.query('SELECT * FROM bestellung WHERE id=$1', [id])).rows[0];
    const st = genehmStatus(upd);
    return { ok: true, genehmigung: st, braucht_andrej: upd.braucht_andrej, braucht_grund: upd.braucht_grund,
      wartet_andrej: st === 'wartet_andrej' };
  });
}
async function bestellungStatus(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM bestellung_genehmigung_log WHERE bestellung_id=$1', [id]); await cl.query('DELETE FROM bestellung WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    if (b.status === 'storniert') { await cl.query('UPDATE bestellung SET status=$2, geaendert=now() WHERE id=$1', [id, 'storniert']); return { ok: true, status: 'storniert' }; }
    if (b.status === 'reaktivieren') { await bestellStatusNeu(cl, id); const s = (await cl.query('SELECT status FROM bestellung WHERE id=$1', [id])).rows[0]; return { ok: true, status: s && s.status }; }
    throw new Error('неизвестное действие');
  });
}
async function bestellungRechnung(b, login) {
  return mit(async (cl) => {
    if (b.loeschen) {
      const id = Number(b.id); if (!id) throw new Error('нет id');
      const bid = (await cl.query('SELECT bestellung_id FROM bestellung_rechnung WHERE id=$1', [id])).rows[0];
      await cl.query('DELETE FROM bestellung_rechnung WHERE id=$1', [id]);
      if (bid) await bestellStatusNeu(cl, bid.bestellung_id);
      return { ok: true, geloescht: true };
    }
    const bid = Number(b.bestellung_id); if (!bid) throw new Error('нет заказа');
    const betrag = eur(b); if (betrag == null) throw new Error('нужна сумма счёта');
    const art = ['teilrechnung', 'schlussrechnung', 'korrektur'].includes(b.art) ? b.art : 'teilrechnung';
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || '')) ? b.datum : null;
    await cl.query('INSERT INTO bestellung_rechnung (bestellung_id, betrag_cent, art, datum, rechnung_ref, notiz, von) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [bid, betrag, art, datum, b.rechnung_ref ? String(b.rechnung_ref).slice(0, 200) : null, b.notiz ? String(b.notiz).slice(0, 400) : null, login]);
    await bestellStatusNeu(cl, bid);
    return { ok: true };
  });
}

/* ---------- Завершение объекта (§6) ---------- */
async function abschlussSetzen(b, login, rolle) {
  const feld = String(b.feld || '');
  if (!['arbeiten_fertig', 'dok_geprueft', 'zu'].includes(feld)) throw new Error('неизвестное состояние');
  const wertB = !!b.wert;
  if (feld === 'zu' && rolle !== 'gf') throw new Error('окончательное закрытие утверждает только владелец');
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const cur = (await cl.query('SELECT arbeiten_fertig, dok_geprueft FROM objekt_abschluss WHERE objekt_nr=$1', [nr])).rows[0] || {};
    if (feld === 'zu' && wertB && !(cur.arbeiten_fertig && cur.dok_geprueft))
      throw new Error('сначала: работы завершены (Олег) и документы проверены (бухгалтер)');
    const spalten = { arbeiten_fertig: ['arbeiten_fertig', 'arbeiten_am', 'arbeiten_von'],
      dok_geprueft: ['dok_geprueft', 'dok_am', 'dok_von'], zu: ['zu', 'zu_am', 'zu_von'] }[feld];
    await cl.query(
      `INSERT INTO objekt_abschluss (objekt_nr, ${spalten[0]}, ${spalten[1]}, ${spalten[2]}, geaendert)
       VALUES ($1,$2, CASE WHEN $2 THEN now() END, CASE WHEN $2 THEN $3 END, now())
       ON CONFLICT (objekt_nr) DO UPDATE SET ${spalten[0]}=$2, ${spalten[1]}=CASE WHEN $2 THEN now() END, ${spalten[2]}=CASE WHEN $2 THEN $3 END, geaendert=now()`,
      [nr, wertB, login]);
    // снимок итога при окончательном закрытии (§6: прежняя версия сохраняется)
    if (feld === 'zu' && wertB) {
      const etcCent = Number((await cl.query('SELECT betrag_cent FROM etc_version WHERE objekt_nr=$1 ORDER BY stand DESC LIMIT 1', [nr])).rows[0]?.betrag_cent || 0);
      const erg = await prognoseMit(cl, nr, etcCent);
      await cl.query('INSERT INTO ergebnis_version (objekt_nr, ergebnis_cent, anlass, von) VALUES ($1,$2,$3,$4)', [nr, erg, 'окончательное закрытие', login]);
    }
    return { ok: true };
  });
}
// поздний счёт после закрытия: сохранить прежнюю версию итога и пометить пересмотр (§6)
async function ergebnisNeu(b, login, rolle) {
  if (rolle !== 'gf') throw new Error('изменение итога закрытого объекта утверждает только владелец');
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const etcCent = Number((await cl.query('SELECT betrag_cent FROM etc_version WHERE objekt_nr=$1 ORDER BY stand DESC LIMIT 1', [nr])).rows[0]?.betrag_cent || 0);
    const erg = await prognoseMit(cl, nr, etcCent);
    await cl.query('INSERT INTO ergebnis_version (objekt_nr, ergebnis_cent, anlass, von) VALUES ($1,$2,$3,$4)', [nr, erg, b.anlass ? String(b.anlass).slice(0, 200) : 'пересмотр итога (поздний счёт)', login]);
    return { ok: true, ergebnis: erg };
  });
}

/* ---------- Удержания и Bürgschaft (§7) ---------- */
async function einbehaltAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const art = b.art === 'buergschaft' ? 'buergschaft' : 'einbehalt';
    const betrag = eur(b) || 0;
    const dat = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : null;
    let geb = null;
    if (b.gebuehr != null && b.gebuehr !== '' && Number.isFinite(Number(String(b.gebuehr).replace(',', '.')))) geb = Math.round(parseFloat(String(b.gebuehr).replace(',', '.')) * 100);
    const r = await cl.query(
      'INSERT INTO einbehalt (objekt_nr, art, betrag_cent, grund, freigabe_bedingung, erwartete_rueckgabe, verantwortlich, gebuehr_cent, ablauf, notiz, von) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [nr, art, betrag, b.grund ? String(b.grund).slice(0, 300) : null, b.freigabe_bedingung ? String(b.freigabe_bedingung).slice(0, 300) : null, dat(b.erwartete_rueckgabe), b.verantwortlich ? String(b.verantwortlich).slice(0, 120) : null, geb, dat(b.ablauf), b.notiz ? String(b.notiz).slice(0, 400) : null, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function einbehaltStatus(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM einbehalt WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    const st = ['offen', 'abgeloest', 'zurueck', 'beendet'].includes(b.status) ? b.status : 'offen';
    await cl.query('UPDATE einbehalt SET status=$2, geaendert=now() WHERE id=$1', [id, st]);
    return { ok: true, status: st };
  });
}

/* ---------- Спорные части долга / претензии (§8) ---------- */
async function streitAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const betrag = eur(b) || 0;
    const r = await cl.query('INSERT INTO forderung_streit (objekt_nr, betrag_cent, grund, von) VALUES ($1,$2,$3,$4) RETURNING id',
      [nr, betrag, b.grund ? String(b.grund).slice(0, 400) : null, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function streitEntscheiden(b, login, rolle) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM forderung_streit WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    const st = ['offen', 'geklaert', 'reduziert'].includes(b.status) ? b.status : 'offen';
    if (st === 'reduziert' && rolle !== 'gf') throw new Error('уменьшение долга по претензии утверждает только владелец');
    await cl.query('UPDATE forderung_streit SET status=$2, entscheidung=$3, entschieden_von=CASE WHEN $2<>$4 THEN $5 END, entschieden_am=CASE WHEN $2<>$4 THEN now() END WHERE id=$1',
      [id, st, b.entscheidung ? String(b.entscheidung).slice(0, 400) : null, 'offen', login]);
    return { ok: true, status: st };
  });
}

/* ---------- Исходящие счета (§11) ---------- */
async function sverkaRechnen(cl, nr) {
  const rr = (await cl.query("SELECT kennzahl, wert_cent FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl IN ('auftragswert','zahlung_ein')", [nr])).rows;
  const m = {}; rr.forEach(r => { m[r.kennzahl] = Number(r.wert_cent || 0); });
  const nb = Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM nachtrag WHERE objekt_nr=$1 AND status='bestaetigt'", [nr])).rows[0].s);
  const frueher = Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM ausgang_rechnung WHERE objekt_nr=$1 AND status='gesendet'", [nr])).rows[0].s);
  const basis = (m.auftragswert || 0) + nb;
  return { basis, frueher, erhalten: (m.zahlung_ein || 0), rest: basis - frueher };
}
async function ausgangAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const art = b.art === 'schluss' ? 'schluss' : 'abschlag';
    const betrag = eur(b); if (betrag == null || betrag <= 0) throw new Error('нужна сумма счёта');
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || '')) ? b.datum : null;
    const sv = await sverkaRechnen(cl, nr);
    const sv_ok = betrag <= sv.rest + 1; // не уменьшать остаток дважды (§11): счёт не больше остатка
    const r = await cl.query(
      `INSERT INTO ausgang_rechnung (objekt_nr, art, nummer, betrag_cent, datum, empfaenger, status, sv_basis_cent, sv_frueher_cent, sv_erhalten_cent, sv_rest_cent, sv_ok, notiz, von)
       VALUES ($1,$2,$3,$4,$5,$6,'entwurf',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [nr, art, b.nummer ? String(b.nummer).slice(0, 60) : null, betrag, datum, b.empfaenger ? String(b.empfaenger).slice(0, 200) : null,
       sv.basis, sv.frueher, sv.erhalten, sv.rest, sv_ok, b.notiz ? String(b.notiz).slice(0, 400) : null, login]);
    return { ok: true, id: r.rows[0].id, sv_ok, sverka: sv };
  });
}
async function ausgangSenden(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    const r = (await cl.query('SELECT * FROM ausgang_rechnung WHERE id=$1', [id])).rows[0];
    if (!r) throw new Error('счёт не найден');
    if (r.status === 'gesendet') throw new Error('уже отправлен');
    if (!r.sv_ok) throw new Error('расхождение сверки блокирует отправку — разберите с Олегом (сумма больше остатка)');
    if (!r.empfaenger) throw new Error('нет получателя');
    // ЗАГЛУШКА: реальная почта не подключена. Только журнал.
    const journal = 'ТЕСТ-режим: письмо НЕ отправлено (боевой канал не подключён). Журнал: получатель ' + r.empfaenger + ', сумма ' + (Number(r.betrag_cent) / 100).toLocaleString('de-DE') + ' €, ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ', отправил ' + login;
    await cl.query("UPDATE ausgang_rechnung SET status='gesendet', gesendet_am=now(), ergebnis=$2, geaendert=now() WHERE id=$1", [id, journal]);
    return { ok: true, journal };
  });
}
async function ausgangStatus(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM ausgang_rechnung WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    if (b.fehler) { await cl.query("UPDATE ausgang_rechnung SET status='fehler', ergebnis=$2, geaendert=now() WHERE id=$1", [id, 'Ошибка отправки (тест) — создана задача бухгалтеру']); return { ok: true, fehler: true }; }
    throw new Error('неизвестное действие');
  });
}

/* ---------- Напоминания заказчику (§12) ---------- */
async function unstrittigRest(cl, nr) {
  const f = Number((await cl.query("SELECT coalesce(wert_cent,0) w FROM objekt_oekonomik WHERE objekt_nr=$1 AND kennzahl='forderung'", [nr])).rows[0]?.w || 0);
  const s = Number((await cl.query("SELECT coalesce(sum(betrag_cent),0) s FROM forderung_streit WHERE objekt_nr=$1 AND status='offen'", [nr])).rows[0].s);
  return Math.max(0, f - Math.min(f, s));
}
async function mahnPause(cl, nr) {
  const z = (await cl.query('SELECT datum FROM zahlungszusage WHERE objekt_nr=$1 AND aktiv ORDER BY datum DESC LIMIT 1', [nr])).rows[0];
  if (!z) return null;
  const heute = process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date();
  return new Date(z.datum) >= heute ? z.datum : null;
}
async function mahnungVorbereiten(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const pause = await mahnPause(cl, nr);
    if (pause) throw new Error('есть подтверждённая дата оплаты (' + String(pause).slice(0, 10) + ') — напоминания на паузе');
    const rest = await unstrittigRest(cl, nr);
    if (rest <= 0) throw new Error('нет бесспорного остатка для напоминания');
    const off = (await cl.query("SELECT id FROM mahnung WHERE objekt_nr=$1 AND status IN ('vorbereitet','bestaetigt')", [nr])).rows;
    if (off.length) throw new Error('уже есть неотправленное напоминание — закройте его сначала');
    const letzte = (await cl.query("SELECT max(stufe) m FROM mahnung WHERE objekt_nr=$1 AND status='gesendet'", [nr])).rows[0];
    const stufe = (Number(letzte?.m) || 0) + 1;
    const r = await cl.query('INSERT INTO mahnung (objekt_nr, stufe, betrag_cent, status, von) VALUES ($1,$2,$3,$4,$5) RETURNING id', [nr, stufe, rest, 'vorbereitet', login]);
    return { ok: true, id: r.rows[0].id, stufe, betrag: rest };
  });
}
async function mahnungBestaetigen(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    await cl.query("UPDATE mahnung SET status='bestaetigt', bestaetigt_von=$2, bestaetigt_am=now() WHERE id=$1 AND status='vorbereitet'", [id, login]);
    return { ok: true };
  });
}
async function mahnungSenden(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    const m = (await cl.query('SELECT * FROM mahnung WHERE id=$1', [id])).rows[0];
    if (!m) throw new Error('напоминание не найдено');
    if (m.status === 'gesendet') throw new Error('уже отправлено');
    // 1-е напоминание — только после подтверждения ответственного (§12)
    if (Number(m.stufe) === 1 && m.status !== 'bestaetigt') throw new Error('первое напоминание отправляется после подтверждения ответственного');
    const journal = 'ТЕСТ-режим: напоминание НЕ отправлено (боевой канал не подключён). Ступень ' + m.stufe + ', сумма ' + (Number(m.betrag_cent) / 100).toLocaleString('de-DE') + ' €, ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ', ' + login;
    await cl.query("UPDATE mahnung SET status='gesendet', gesendet_am=now(), ergebnis=$2 WHERE id=$1", [id, journal]);
    return { ok: true, journal };
  });
}
async function mahnungLoeschen(b) {
  return mit(async (cl) => { const id = Number(b.id); if (!id) throw new Error('нет id'); await cl.query('DELETE FROM mahnung WHERE id=$1', [id]); return { ok: true }; });
}
async function zusageSetzen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    if (b.loeschen) { await cl.query('UPDATE zahlungszusage SET aktiv=false WHERE objekt_nr=$1 AND aktiv', [nr]); return { ok: true, geloescht: true }; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || ''))) throw new Error('нужна дата (ГГГГ-ММ-ДД)');
    await cl.query('UPDATE zahlungszusage SET aktiv=false WHERE objekt_nr=$1 AND aktiv', [nr]);
    await cl.query('INSERT INTO zahlungszusage (objekt_nr, datum, notiz, von) VALUES ($1,$2,$3,$4)', [nr, b.datum, b.notiz ? String(b.notiz).slice(0, 300) : null, login]);
    return { ok: true };
  });
}

/* ---------- Распределяемые затраты: часы/жильё/техника/топливо (§14–§17) ---------- */
async function postenListe(art) {
  return mit(async (cl) => {
    const w = art ? ' WHERE p.art=$1' : '';
    const rows = (await cl.query(
      `SELECT p.id, p.art, p.bezeichnung, p.betrag_cent, p.quelle, p.periode, p.datum, p.beleg_ref, p.notiz,
              coalesce((SELECT sum(betrag_cent) FROM verteilung v WHERE v.posten_id=p.id),0) verteilt
       FROM verteilposten p${w} ORDER BY p.angelegt DESC`, art ? [art] : [])).rows;
    return rows.map(r => ({ ...r, betrag_cent: Number(r.betrag_cent), verteilt: Number(r.verteilt), rest: Number(r.betrag_cent) - Number(r.verteilt) }));
  });
}
async function postenEins(id) {
  return mit(async (cl) => {
    const p = (await cl.query('SELECT * FROM verteilposten WHERE id=$1', [Number(id)])).rows[0];
    if (!p) throw new Error('позиция не найдена');
    const v = (await cl.query(
      `SELECT x.id, x.objekt_nr, x.betrag_cent, x.basis, x.notiz, k.bez
       FROM verteilung x LEFT JOIN ${KERN} k ON k.nummer=x.objekt_nr WHERE x.posten_id=$1 ORDER BY x.id`, [Number(id)])).rows;
    const verteilt = v.reduce((s, r) => s + Number(r.betrag_cent || 0), 0);
    return { posten: { ...p, betrag_cent: Number(p.betrag_cent) }, verteilung: v, verteilt, rest: Number(p.betrag_cent) - verteilt };
  });
}
async function postenAnlegen(b, login) {
  const ART = ['stunden', 'unterkunft', 'technik', 'kraftstoff', 'sonstiges'];
  if (!ART.includes(b.art)) throw new Error('неизвестный вид затрат');
  const bez = String(b.bezeichnung || '').trim(); if (!bez) throw new Error('нужно название');
  const betrag = eur(b); if (betrag == null || betrag <= 0) throw new Error('нужна сумма');
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || '')) ? b.datum : null;
  const periode = /^\d{4}(-\d{2})?$/.test(String(b.periode || '')) ? b.periode : null;
  return mit(async (cl) => {
    const r = await cl.query('INSERT INTO verteilposten (art, bezeichnung, betrag_cent, quelle, periode, datum, beleg_ref, notiz, von) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [b.art, bez, betrag, b.quelle ? String(b.quelle).slice(0, 60) : null, periode, datum, b.beleg_ref ? String(b.beleg_ref).slice(0, 200) : null, b.notiz ? String(b.notiz).slice(0, 400) : null, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function verteilungSetzen(b, login) {
  return mit(async (cl) => {
    if (b.loeschen) { await cl.query('DELETE FROM verteilung WHERE id=$1', [Number(b.id)]); return { ok: true, geloescht: true }; }
    const pid = Number(b.posten_id); if (!pid) throw new Error('нет позиции');
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const betrag = eur(b); if (betrag == null || betrag === 0) throw new Error('нужна сумма распределения');
    const p = (await cl.query('SELECT betrag_cent FROM verteilposten WHERE id=$1', [pid])).rows[0];
    if (!p) throw new Error('позиция не найдена');
    const schon = Number((await cl.query('SELECT coalesce(sum(betrag_cent),0) s FROM verteilung WHERE posten_id=$1', [pid])).rows[0].s);
    // §17/§16/§15: сумма частей не превышает распределяемую
    if (schon + betrag > Number(p.betrag_cent) + 1) throw new Error('сумма распределения превысит остаток позиции (Σ частей ≤ сумме)');
    await cl.query('INSERT INTO verteilung (posten_id, objekt_nr, betrag_cent, basis, notiz, von) VALUES ($1,$2,$3,$4,$5,$6)',
      [pid, nr, betrag, b.basis ? String(b.basis).slice(0, 120) : null, b.notiz ? String(b.notiz).slice(0, 300) : null, login]);
    return { ok: true };
  });
}
async function postenLoeschen(b) {
  return mit(async (cl) => { await cl.query('DELETE FROM verteilposten WHERE id=$1', [Number(b.id)]); return { ok: true }; });
}

/* ---------- Недостатки и требования к подрядчику (§9–10) ---------- */
const MANGEL_CHK = ['chk_vertrag', 'chk_mangel', 'chk_nachweise', 'chk_aufforderung', 'chk_empfang', 'chk_frist', 'chk_antwort', 'chk_kosten', 'chk_bezug'];
async function mangelAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const bes = String(b.beschreibung || '').trim(); if (!bes) throw new Error('нужно описание недостатка');
    const r = await cl.query('INSERT INTO mangel (objekt_nr, subunternehmer, beschreibung, von) VALUES ($1,$2,$3,$4) RETURNING id',
      [nr, b.subunternehmer ? String(b.subunternehmer).slice(0, 150) : null, bes, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function mangelUpdate(b, login) {
  return mit(async (cl) => {
    const id = Number(b.id); if (!id) throw new Error('нет id');
    if (b.loeschen) { await cl.query('DELETE FROM mangel WHERE id=$1', [id]); return { ok: true, geloescht: true }; }
    const sets = ['geaendert=now()']; const vals = [id]; let i = 2;
    const eurF = x => (x != null && x !== '' && Number.isFinite(Number(String(x).replace(',', '.')))) ? Math.round(parseFloat(String(x).replace(',', '.')) * 100) : null;
    if (b.beschreibung != null) { sets.push('beschreibung=$' + i++); vals.push(String(b.beschreibung).slice(0, 1000)); }
    if (b.subunternehmer != null) { sets.push('subunternehmer=$' + i++); vals.push(String(b.subunternehmer).slice(0, 150) || null); }
    if (b.rechtsgrundlage != null) { sets.push('rechtsgrundlage=$' + i++); vals.push(String(b.rechtsgrundlage).slice(0, 300) || null); }
    if (b.notiz != null) { sets.push('notiz=$' + i++); vals.push(String(b.notiz).slice(0, 600) || null); }
    if (['offen', 'juristisch_pruefen', 'geklaert', 'abgelehnt'].includes(b.status)) { sets.push('status=$' + i++); vals.push(b.status); }
    const mk = eurF(b.mangelkosten); if (mk != null) { sets.push('mangelkosten_cent=$' + i++); vals.push(mk); }
    const rg = eurF(b.regress); if (rg != null) { sets.push('regress_cent=$' + i++); vals.push(rg); }
    if (['moeglich', 'bestaetigt', 'anerkannt', 'erhalten'].includes(b.regress_status)) { sets.push('regress_status=$' + i++); vals.push(b.regress_status); }
    for (const c of MANGEL_CHK) if (typeof b[c] === 'boolean') { sets.push(c + '=$' + i++); vals.push(b[c]); }
    if (sets.length === 1) throw new Error('нечего менять');
    await cl.query('UPDATE mangel SET ' + sets.join(', ') + ' WHERE id=$1', vals);
    // §9: «нужна юр. проверка» → показать владельцу как риск (дедуп)
    if (b.status === 'juristisch_pruefen') {
      const m = (await cl.query('SELECT objekt_nr, subunternehmer, beschreibung FROM mangel WHERE id=$1', [id])).rows[0];
      const off = (await cl.query("SELECT 1 FROM objekt_risiko WHERE objekt_nr=$1 AND art='recht' AND NOT erledigt AND text LIKE $2", [m.objekt_nr, '%#' + id + '%'])).rowCount;
      if (!off) await cl.query('INSERT INTO objekt_risiko (objekt_nr, art, titel, text, von) VALUES ($1,$2,$3,$4,$5)',
        [m.objekt_nr, 'recht', 'Нужна юридическая проверка', 'Недостаток #' + id + (m.subunternehmer ? ' (' + m.subunternehmer + ')' : '') + ': ' + String(m.beschreibung).slice(0, 150) + '. Юриста нет — решает владелец; спорные суммы из оплаты подрядчику авто не удерживать.', login]);
    }
    return { ok: true };
  });
}

/* ---------- Фото объектов (§13) ---------- */
async function fotoAnlegen(b, login) {
  return mit(async (cl) => {
    const nr = await kanonNr(cl, String(b.objekt_nr || ''));
    const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.aufnahme_datum || '')) ? b.aufnahme_datum : null;
    const quelle = ['exif', 'manuell', 'ingenieur', 'stunden'].includes(b.aufnahme_quelle) ? b.aufnahme_quelle : 'manuell';
    const r = await cl.query('INSERT INTO objekt_foto (objekt_nr, datei_ref, autor, aufnahme_datum, aufnahme_quelle, zuordnung_art, verknuepfung, notiz, von) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [nr, b.datei_ref ? String(b.datei_ref).slice(0, 300) : null, b.autor ? String(b.autor).slice(0, 120) : null, datum, quelle, 'manuell',
       b.verknuepfung ? String(b.verknuepfung).slice(0, 200) : null, b.notiz ? String(b.notiz).slice(0, 300) : null, login]);
    return { ok: true, id: r.rows[0].id };
  });
}
async function fotoLoeschen(b) {
  return mit(async (cl) => { await cl.query('DELETE FROM objekt_foto WHERE id=$1', [Number(b.id)]); return { ok: true }; });
}

/* ---------- Журнал интеграций (§5,§19): idempotency + версии ---------- */
// Контракт приёма события от «Инженер»/«Учёт часов» и др. Реальные источники пока не подключены.
async function integrationEreignis(b, login) {
  return mit(async (cl) => {
    const quelle = String(b.quelle || '').slice(0, 40); if (!quelle) throw new Error('нет источника');
    const ereignis = String(b.ereignis || '').slice(0, 80); if (!ereignis) throw new Error('нет типа события');
    const key = b.idempotenz_key ? String(b.idempotenz_key).slice(0, 200) : null;
    const version = Number.isFinite(Number(b.version)) ? Number(b.version) : 0;
    const nr = b.objekt_nr ? String(b.objekt_nr).slice(0, 20) : null;
    // повторная доставка не плодит дубли
    if (key) {
      const dup = (await cl.query('SELECT id FROM integration_journal WHERE idempotenz_key=$1', [key])).rows[0];
      if (dup) return { ok: true, duplikat: true, id: dup.id };
    }
    // устаревшее событие не перезаписывает более новое состояние
    let status = 'empfangen';
    if (nr) {
      const neuer = (await cl.query('SELECT max(version) m FROM integration_journal WHERE quelle=$1 AND ereignis=$2 AND objekt_nr=$3 AND status<>$4', [quelle, ereignis, nr, 'fehler'])).rows[0];
      if (neuer && neuer.m != null && Number(neuer.m) > version) status = 'veraltet_ignoriert';
    }
    const r = await cl.query('INSERT INTO integration_journal (quelle, ereignis, objekt_nr, idempotenz_key, version, status, payload_ref) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [quelle, ereignis, nr, key, version, status, b.payload_ref ? String(b.payload_ref).slice(0, 300) : null]);
    return { ok: true, id: r.rows[0].id, status };
  });
}
async function journalListe(limit) {
  return mit(async (cl) => {
    const rows = (await cl.query('SELECT id, quelle, ereignis, objekt_nr, version, status, payload_ref, fehler_text, empfangen FROM integration_journal ORDER BY empfangen DESC, id DESC LIMIT $1', [Math.min(200, Number(limit) || 50)])).rows;
    const stat = (await cl.query('SELECT quelle, count(*) n, max(empfangen) letzte FROM integration_journal GROUP BY quelle ORDER BY quelle')).rows;
    // фиксированные ожидаемые источники (пока не подключены)
    const quellen = [
      { key: 'ingenieur', titel: '«Инженер» — объёмы, готовность, документы, фото', status: 'ожидает подключения' },
      { key: 'stunden', titel: '«Учёт часов» — подтверждённые часы, фото', status: 'ожидает подключения' },
    ].map(q => { const s = stat.find(x => x.quelle === q.key); return { ...q, ereignisse: s ? Number(s.n) : 0, letzte: s ? s.letzte : null, verbunden: !!s }; });
    return { journal: rows, quellen };
  });
}

// Список дублей для свода «по одному» (§19)
async function dubletten() {
  return mit(async (cl) => {
    // только неразобранные группы (видимых членов > 1); сведённые не считаем
    const rows = (await cl.query(
      `SELECT dup_gruppe, count(*) c, string_agg(nummer, ', ' ORDER BY nummer) nummern,
              max(kunde) kunde, max(adresse) adresse
       FROM ${KERN} WHERE dup_gruppe IS NOT NULL AND merged_into IS NULL
       GROUP BY dup_gruppe HAVING count(*)>1 ORDER BY c DESC`)).rows;
    return rows.map(r => ({ gruppe: r.dup_gruppe, anzahl: Number(r.c), nummern: r.nummern, kunde: r.kunde, adresse: r.adresse }));
  });
}

module.exports = { objektListe, objektEins, kennzahlSetzen, dubletten, KENNZAHLEN,
  nachtragAnlegen, nachtragStatus, etcNeu, risikoErledigt, etcVeraltet,
  bestellungAnlegen, bestellungGenehmigen, bestellungStatus, bestellungRechnung,
  abschlussSetzen, ergebnisNeu, einbehaltAnlegen, einbehaltStatus, streitAnlegen, streitEntscheiden,
  ausgangAnlegen, ausgangSenden, ausgangStatus, mahnungVorbereiten, mahnungBestaetigen, mahnungSenden, mahnungLoeschen, zusageSetzen,
  postenListe, postenEins, postenAnlegen, verteilungSetzen, postenLoeschen,
  mangelAnlegen, mangelUpdate,
  fotoAnlegen, fotoLoeschen, integrationEreignis, journalListe };
