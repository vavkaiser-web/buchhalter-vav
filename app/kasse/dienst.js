/* ---------------------------------------------------------------
   Buchhalter VAV · касса, квитанции, чеки, возмещения, запросы,
   отдельные комплекты к оплате.

   Главные правила (IMPLEMENTATION.md, 24.09.2026):
   - подготовленная квитанция ≠ выдача: движение денег — только при выдаче;
   - деньги у Олега — отдельный счёт, не касса;
   - расчётный остаток = получил − выдал/потратил − вернул; это не пересчёт;
   - чек и аванс — не два расхода; проверенный чек ≠ выплаченное возмещение;
   - запрос: сотрудник 2 рабочих дня → Олег 1 → Андрей; потеря — сразу
     бухгалтеру и Андрею; ответ вопрос не закрывает;
   - зачёт квитанций уменьшает остаток к оплате, не сумму работ;
     одна квитанция не зачитывается дважды сверх своей суммы;
   - каждый счёт — отдельный комплект; банк оплачивает Андрей,
     приложение ничего не переводит;
   - ничего никому не отправляется: каналы уведомлений не согласованы.
   ---------------------------------------------------------------- */
'use strict';
const { tx, lesen, Fehler } = require('./db.js');
const { centAus, euro } = require('./geld.js');
const wt = require('./werktage.js');

const S = 'mailops_prod.';
const FIRMA = 'VAVK';
const ROLLEN_KASSE = ['gf', 'buchhaltung', 'disponent', 'mitarbeiter'];

/* ---------------- роли ---------------- */
const istGf = n => n.rolle === 'gf';
const istBuch = n => n.rolle === 'buchhaltung';
const istDisp = n => n.rolle === 'disponent';
const istMa = n => n.rolle === 'mitarbeiter';
const buero = n => istGf(n) || istBuch(n);
function darf(bed, text) { if (!bed) throw new Fehler(403, text || 'Нет прав на это действие'); }
function pruefe(bed, text, status) { if (!bed) throw new Fehler(status || 400, text); }

const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max || 500) : null; };
const halterKonto = login => 'halter:' + login;
const vorschussKonto = ref => 'vorschuss:' + ref;
const idOf = v => { const x = Number(v); if (!Number.isInteger(x) || x <= 0) throw new Fehler(400, 'Неверный номер записи'); return x; };

async function log(q, n, art, ziel, daten) {
  await q(`INSERT INTO ${S}buch_ereignis (wer, rolle, art, ziel, daten) VALUES ($1,$2,$3,$4,$5)`,
    [n.login, n.rolle, art, ziel, JSON.stringify(daten || {})]);
}
async function nummer(q, praefix) {
  const r = await q(`INSERT INTO ${S}buch_nummer (praefix, letzte) VALUES ($1, 1)
    ON CONFLICT (praefix) DO UPDATE SET letzte = ${S}buch_nummer.letzte + 1 RETURNING letzte`, [praefix]);
  return praefix + '-' + String(r[0].letzte).padStart(4, '0');
}
async function sperreKonto(q, konto) { await q('SELECT pg_advisory_xact_lock(hashtext($1))', ['buch_konto:' + konto]); }

/* ---------------- счета наличных ---------------- */
async function kontoSicher(q, id, art, name, bei, login, personRef, n) {
  await q(`INSERT INTO ${S}buch_konto (id, art, name, bei_text, login, person_ref, von)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
    [id, art, name, bei, login, personRef, n.login]);
}
/** Счета «деньги у ответственного» для всех входов с ролью disponent. */
async function halterAlle(q, benutzer) {
  for (const b of (benutzer || []).filter(x => x.rolle === 'disponent')) await halterFuer(q, b);
}
async function halterFuer(q, n) {
  const kurz = n.kurzname || String(n.name || n.login).split(/\s+/)[0];
  await kontoSicher(q, halterKonto(n.login), 'halter', kurz, n.bei || ('У ' + kurz), n.login, n.person || null, n);
  return halterKonto(n.login);
}

/** Расчётный остаток счёта. Уход считается сразу (gemeldet или bestaetigt),
    приход — только после подтверждения получателем. */
async function saldo(q, konto) {
  const r = await q(`SELECT
      COALESCE(SUM(betrag_cent) FILTER (WHERE an_konto = $1 AND status = 'bestaetigt'), 0)::bigint AS erhalten,
      COALESCE(SUM(betrag_cent) FILTER (WHERE von_konto = $1 AND art IN ('ausgabe','verbrauch','uebergabe') AND status IN ('gemeldet','bestaetigt')), 0)::bigint AS ausgaben,
      COALESCE(SUM(betrag_cent) FILTER (WHERE von_konto = $1 AND art = 'rueckgabe' AND status IN ('gemeldet','bestaetigt')), 0)::bigint AS zurueck,
      COALESCE(SUM(betrag_cent) FILTER (WHERE von_konto = $1 AND status = 'gemeldet'), 0)::bigint AS unterwegs,
      COALESCE(SUM(betrag_cent) FILTER (WHERE an_konto = $1 AND status = 'gemeldet'), 0)::bigint AS eingehend
    FROM ${S}buch_bewegung WHERE von_konto = $1 OR an_konto = $1`, [konto]);
  const x = r[0];
  const o = { erhalten: Number(x.erhalten), ausgaben: Number(x.ausgaben), zurueck: Number(x.zurueck),
    unterwegs: Number(x.unterwegs), eingehend: Number(x.eingehend) };
  o.saldo = o.erhalten - o.ausgaben - o.zurueck;
  return o;
}

/* ---------------- снятие и передачи ---------------- */
async function abhebung(n, b) {
  darf(istGf(n), 'Снятие в банке отмечает только Андрей');
  const betrag = centAus(b.betrag); pruefe(betrag, 'Введите сумму больше нуля');
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.datum || '')) ? b.datum : wt.berlinTag(Date.now());
  return tx(async q => {
    const r = await q(`INSERT INTO ${S}buch_bewegung (art, betrag_cent, status, datum, finmap_op, notiz, von, bestaetigt_am, bestaetigt_von, idem)
      VALUES ('abhebung',$1,'bestaetigt',$2,$3,$4,$5,now(),$5,$6)
      ON CONFLICT (idem) DO NOTHING RETURNING id`, [betrag, datum, txt(b.finmap_op, 80), txt(b.notiz), n.login, b.idem || null]);
    if (!r.length) return { ok: true, wiederholt: true };
    await log(q, n, 'abhebung', 'bewegung:' + r[0].id, { betrag });
    return { ok: true, id: r[0].id };
  });
}

/** Передача наличных. Отдающий отмечает, получатель подтверждает отдельно. */
async function uebergabe(n, b, benutzer) {
  const betrag = centAus(b.betrag); pruefe(betrag, 'Введите сумму больше нуля');
  const an = String(b.an_konto || '');
  return tx(async q => {
    await halterAlle(q, benutzer);
    const ziel = (await q(`SELECT * FROM ${S}buch_konto WHERE id = $1`, [an]))[0];
    pruefe(ziel && ziel.art !== 'vorschuss', 'Получатель должен быть основной кассой или ответственным за наличные');
    let vonKonto = null, quelle = null;
    if (b.quelle_id) {
      darf(istGf(n), 'Деньги из банковского снятия передаёт Андрей');
      quelle = (await q(`SELECT * FROM ${S}buch_bewegung WHERE id = $1 AND art = 'abhebung' FOR UPDATE`, [idOf(b.quelle_id)]))[0];
      pruefe(quelle, 'Снятие не найдено', 404);
      const verteilt = Number((await q(`SELECT COALESCE(SUM(betrag_cent),0) s FROM ${S}buch_bewegung
        WHERE quelle_id = $1 AND status IN ('gemeldet','bestaetigt')`, [quelle.id]))[0].s);
      pruefe(verteilt + betrag <= Number(quelle.betrag_cent),
        `Из снятия осталось распределить ${euro(Number(quelle.betrag_cent) - verteilt)}`, 409);
    } else {
      vonKonto = String(b.von_konto || '');
      const k = (await q(`SELECT * FROM ${S}buch_konto WHERE id = $1`, [vonKonto]))[0];
      pruefe(k, 'Счёт-источник не найден', 404);
      darf((k.art === 'hauptkasse' && istBuch(n)) || (k.art === 'halter' && k.login === n.login),
        'Передать можно только деньги, за которые отвечаете вы');
      pruefe(vonKonto !== an, 'Источник и получатель совпадают');
      await sperreKonto(q, vonKonto);
      const s = await saldo(q, vonKonto);
      pruefe(betrag <= s.saldo, `Сумма превышает расчётный остаток (${euro(s.saldo)})`, 409);
    }
    const r = await q(`INSERT INTO ${S}buch_bewegung (art, von_konto, an_konto, quelle_id, betrag_cent, status, notiz, von, idem)
      VALUES ($1,$2,$3,$4,$5,'gemeldet',$6,$7,$8) ON CONFLICT (idem) DO NOTHING RETURNING id`,
      [b.art === 'rueckgabe' ? 'rueckgabe' : 'uebergabe', vonKonto, an, quelle ? quelle.id : null, betrag, txt(b.notiz), n.login, b.idem || null]);
    if (!r.length) return { ok: true, wiederholt: true };
    await log(q, n, 'uebergabe_gemeldet', 'bewegung:' + r[0].id, { betrag, an, von: vonKonto, quelle: quelle && quelle.id });
    return { ok: true, id: r[0].id };
  });
}

/** Возврат невыданных денег в основную кассу. Подтверждает бухгалтер. */
async function rueckgabe(n, b) {
  darf(istDisp(n), 'Возврат в кассу оформляет ответственный за наличные');
  const konto = await tx(q => halterFuer(q, n));
  return uebergabe(n, { ...b, art: 'rueckgabe', von_konto: konto, an_konto: 'hauptkasse' });
}

async function bestaetigen(n, id, b) {
  return tx(async q => {
    const m = (await q(`SELECT m.*, k.art AS ziel_art, k.login AS ziel_login FROM ${S}buch_bewegung m
      JOIN ${S}buch_konto k ON k.id = m.an_konto WHERE m.id = $1 FOR UPDATE OF m`, [idOf(id)]))[0];
    pruefe(m, 'Передача не найдена', 404);
    const empfaenger = (m.ziel_art === 'hauptkasse' && istBuch(n)) || (m.ziel_art === 'halter' && m.ziel_login === n.login);
    darf(empfaenger, 'Получение подтверждает только получатель');
    darf(m.von !== n.login, 'Нельзя подтвердить собственную передачу');
    if (m.status !== 'gemeldet') return { ok: true, wiederholt: true, status: m.status };
    const neu = b && b.ok === false ? 'abgelehnt' : 'bestaetigt';
    await q(`UPDATE ${S}buch_bewegung SET status = $2, bestaetigt_am = now(), bestaetigt_von = $3 WHERE id = $1`, [m.id, neu, n.login]);
    await log(q, n, neu === 'bestaetigt' ? 'empfang_bestaetigt' : 'empfang_abgelehnt', 'bewegung:' + m.id, { betrag: Number(m.betrag_cent), notiz: txt(b && b.notiz) });
    return { ok: true, status: neu };
  });
}

/* ---------------- заявка на наличные и квитанции ---------------- */
const ZWECKE = ['vorschuss', 'lohn', 'erstattung', 'nu'];

async function personLesen(q, ref) {
  if (!ref) return null;
  const r = await q(`SELECT p.id::text AS id, p.full_name AS name, o.name AS org, o.type::text AS org_typ, p.org_id::text AS org_id
    FROM vavapp_prod.persons p LEFT JOIN vavapp_prod.orgs o ON o.id = p.org_id WHERE p.id::text = $1`, [String(ref)]);
  return r[0] || null;
}

async function quittungZeile(q, n, planId, z, dringend, kontoId) {
  const betrag = centAus(z.betrag); pruefe(betrag, 'В каждой строке нужна сумма больше нуля');
  pruefe(ZWECKE.includes(z.zweck), 'Неизвестное назначение выдачи');
  const p = await personLesen(q, z.empfaenger_ref);
  const name = p ? p.name : txt(z.empfaenger_name, 120);
  pruefe(name, 'Укажите получателя из списка людей');
  let nuName = null, nuRef = null;
  if (z.zweck === 'nu') {
    nuName = txt(z.nu_name, 160) || (p && p.org) || null;
    nuRef = txt(z.nu_ref, 60) || (p && p.org_id) || null;
    pruefe(nuName, 'Для выплаты рабочему подрядчика нужен подрядчик');
  }
  const nr = await nummer(q, 'Q');
  const r = await q(`INSERT INTO ${S}buch_quittung (nr, plan_id, empfaenger_name, empfaenger_ref, nu_name, nu_ref, zweck, betrag_cent, notiz, dringend, von_konto, von, idem)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, nr`,
    [nr, planId, name, p ? p.id : null, nuName, nuRef, z.zweck, betrag, txt(z.notiz), !!dringend, kontoId || null, n.login, z.idem || null]);
  return r[0];
}

async function planAnlegen(n, b) {
  darf(buero(n) || istDisp(n), 'Заявку на наличные составляет бухгалтерия, Олег или Андрей');
  const zeilen = Array.isArray(b.zeilen) ? b.zeilen : [];
  pruefe(zeilen.length > 0 && zeilen.length <= 80, 'В заявке нужна хотя бы одна строка');
  return tx(async q => {
    if (b.idem) {
      const alt = (await q(`SELECT id, nr FROM ${S}buch_geldplan WHERE idem = $1`, [b.idem]))[0];
      if (alt) return { ok: true, wiederholt: true, id: alt.id, nr: alt.nr };
    }
    const nr = await nummer(q, 'P');
    const p = (await q(`INSERT INTO ${S}buch_geldplan (nr, titel, initiator, notiz, von, idem)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [nr, txt(b.titel, 160) || 'Заявка на наличные', txt(b.initiator, 80) || n.login, txt(b.notiz), n.login, b.idem || null]))[0];
    const qs = [];
    for (const z of zeilen) qs.push(await quittungZeile(q, n, p.id, { ...z, idem: null }, false, null));
    await log(q, n, 'plan_angelegt', 'plan:' + p.id, { nr, quittungen: qs.map(x => x.nr) });
    return { ok: true, id: p.id, nr, quittungen: qs };
  });
}

async function planEinreichen(n, id) {
  darf(buero(n) || istDisp(n), 'Нет прав');
  return tx(async q => {
    const p = (await q(`SELECT * FROM ${S}buch_geldplan WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(p, 'Заявка не найдена', 404);
    if (p.status === 'eingereicht') return { ok: true, wiederholt: true };
    pruefe(p.status === 'entwurf', 'Заявка уже рассмотрена', 409);
    await q(`UPDATE ${S}buch_geldplan SET status = 'eingereicht', eingereicht_am = now(), eingereicht_von = $2 WHERE id = $1`, [p.id, n.login]);
    await log(q, n, 'plan_eingereicht', 'plan:' + p.id, {});
    return { ok: true };
  });
}

async function planEntscheiden(n, id, b) {
  darf(istGf(n), 'Плановый список утверждает Андрей');
  return tx(async q => {
    const p = (await q(`SELECT * FROM ${S}buch_geldplan WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(p, 'Заявка не найдена', 404);
    const neu = b && b.genehmigt === false ? 'abgelehnt' : 'genehmigt';
    if (p.status === neu) return { ok: true, wiederholt: true };
    pruefe(p.status === 'eingereicht', 'Утверждается только поданная заявка', 409);
    await q(`UPDATE ${S}buch_geldplan SET status = $2, entschieden_am = now(), entschieden_von = $3 WHERE id = $1`, [p.id, neu, n.login]);
    await log(q, n, 'plan_' + neu, 'plan:' + p.id, { notiz: txt(b && b.notiz) });
    return { ok: true, status: neu };
  });
}

/** Выдача по квитанции: только здесь уходят деньги. */
async function ausgeben(q, n, qt) {
  let konto;
  if (istDisp(n)) konto = await halterFuer(q, n);
  else if (istBuch(n)) konto = 'hauptkasse';
  else darf(false, 'Выдаёт ответственный за наличные или бухгалтерия');
  await sperreKonto(q, konto);
  const s = await saldo(q, konto);
  pruefe(Number(qt.betrag_cent) <= s.saldo,
    `Сумма превышает доступный остаток (${euro(s.saldo)})`, 409);
  let an = null;
  if (qt.zweck === 'vorschuss' && qt.empfaenger_ref) {
    an = vorschussKonto(qt.empfaenger_ref);
    await kontoSicher(q, an, 'vorschuss', qt.empfaenger_name, 'Аванс · ' + qt.empfaenger_name, null, qt.empfaenger_ref, n);
  }
  const m = (await q(`INSERT INTO ${S}buch_bewegung (art, von_konto, an_konto, betrag_cent, status, quittung_id, von, bestaetigt_am, bestaetigt_von)
    VALUES ('ausgabe',$1,$2,$3,'bestaetigt',$4,$5,now(),$5) RETURNING id`, [konto, an, qt.betrag_cent, qt.id, n.login]))[0];
  await q(`UPDATE ${S}buch_quittung SET status = 'ausgegeben', von_konto = $2, bewegung_id = $3, ausgegeben_am = now(), ausgegeben_von = $4 WHERE id = $1`,
    [qt.id, konto, m.id, n.login]);
  if (qt.erstattung_id) {
    await q(`UPDATE ${S}buch_erstattung SET status = 'ausgezahlt', weg = 'bar', quittung_id = $2 WHERE id = $1`, [qt.erstattung_id, qt.id]);
  }
  await log(q, n, 'ausgabe', 'quittung:' + qt.id, { nr: qt.nr, betrag: Number(qt.betrag_cent), konto });
  return { ok: true, nr: qt.nr, bewegung: m.id };
}

async function quittungAusgeben(n, id) {
  return tx(async q => {
    const qt = (await q(`SELECT qt.*, p.status AS plan_status FROM ${S}buch_quittung qt
      LEFT JOIN ${S}buch_geldplan p ON p.id = qt.plan_id WHERE qt.id = $1 FOR UPDATE OF qt`, [idOf(id)]))[0];
    pruefe(qt, 'Квитанция не найдена', 404);
    if (qt.status === 'ausgegeben') return { ok: true, wiederholt: true, nr: qt.nr };
    pruefe(qt.status === 'vorbereitet', 'Квитанция аннулирована', 409);
    pruefe(!qt.plan_id || qt.plan_status === 'genehmigt', 'Список ещё не утверждён Андреем', 409);
    return ausgeben(q, n, qt);
  });
}

/** Срочная выдача Олегом без предварительного согласования: только авансы
    и зарплата, в пределах фактического остатка, квитанция — сразу.
    Для подрядчиков такое право не согласовано — не разрешаем. */
async function dringendAusgeben(n, b) {
  darf(istDisp(n), 'Срочную выдачу оформляет ответственный за наличные');
  pruefe(['vorschuss', 'lohn'].includes(b.zweck), 'Срочно без согласования — только аванс или зарплата. Выплата подрядчику — через список, утверждённый Андреем.');
  return tx(async q => {
    if (b.idem) {
      const alt = (await q(`SELECT id, nr FROM ${S}buch_quittung WHERE idem = $1`, [b.idem]))[0];
      if (alt) return { ok: true, wiederholt: true, nr: alt.nr };
    }
    const z = await quittungZeile(q, n, null, b, true, null);
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1`, [z.id]))[0];
    return ausgeben(q, n, qt);
  });
}

async function quittungFoto(n, id, b) {
  darf(buero(n) || istDisp(n), 'Фото квитанции загружает Олег или бухгалтерия');
  return tx(async q => {
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(qt, 'Квитанция не найдена', 404);
    pruefe(qt.status === 'ausgegeben', 'Фото подписи прикладывается после выдачи', 409);
    darf(!istDisp(n) || qt.ausgegeben_von === n.login, 'Это выдача другого ответственного');
    await dateiPruefen(q, b.sha);
    if (qt.foto_sha === b.sha) return { ok: true, wiederholt: true };
    await q(`UPDATE ${S}buch_quittung SET foto_sha = $2, foto_am = now(), foto_von = $3 WHERE id = $1`, [qt.id, b.sha, n.login]);
    await log(q, n, 'quittung_foto', 'quittung:' + qt.id, { sha: b.sha, ersetzt: qt.foto_sha });
    return { ok: true };
  });
}

async function quittungOriginal(n, id) {
  darf(istBuch(n), 'Приём оригинала отмечает бухгалтерия');
  return tx(async q => {
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(qt, 'Квитанция не найдена', 404);
    if (qt.original_am) return { ok: true, wiederholt: true };
    pruefe(qt.status === 'ausgegeben', 'Оригинал бывает только у выданной квитанции', 409);
    await q(`UPDATE ${S}buch_quittung SET original_am = now(), original_von = $2 WHERE id = $1`, [qt.id, n.login]);
    await log(q, n, 'original_erhalten', 'quittung:' + qt.id, {});
    return { ok: true };
  });
}

async function quittungNuBestaetigt(n, id, b) {
  darf(istBuch(n) || istDisp(n), 'Подтверждение подрядчика фиксирует бухгалтерия или Олег');
  const notiz = txt(b.notiz, 300);
  pruefe(notiz, 'Опишите, как подрядчик подтвердил квитанцию (письмо, подпись, дата)');
  return tx(async q => {
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(qt && qt.zweck === 'nu', 'Квитанция рабочего подрядчика не найдена', 404);
    pruefe(qt.status === 'ausgegeben', 'Подрядчик подтверждает выданную квитанцию', 409);
    if (qt.nu_bestaetigt_am) return { ok: true, wiederholt: true };
    await q(`UPDATE ${S}buch_quittung SET nu_bestaetigt_am = now(), nu_bestaetigt_von = $2, nu_bestaetigt_notiz = $3 WHERE id = $1`, [qt.id, n.login, notiz]);
    await log(q, n, 'nu_bestaetigt', 'quittung:' + qt.id, { notiz });
    return { ok: true };
  });
}

async function quittungStorno(n, id, b) {
  darf(istBuch(n), 'Аннулирует бухгалтерия');
  return tx(async q => {
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(qt, 'Квитанция не найдена', 404);
    if (qt.status === 'storniert') return { ok: true, wiederholt: true };
    pruefe(qt.status === 'vorbereitet', 'Выданную квитанцию нельзя аннулировать: оформите возврат', 409);
    await q(`UPDATE ${S}buch_quittung SET status = 'storniert' WHERE id = $1`, [qt.id]);
    await log(q, n, 'quittung_storno', 'quittung:' + qt.id, { grund: txt(b && b.grund) });
    return { ok: true };
  });
}

/* ---------------- файлы ---------------- */
async function dateiPruefen(q, sha) {
  pruefe(/^[0-9a-f]{64}$/.test(String(sha || '')), 'Сначала загрузите файл');
  const d = (await q(`SELECT sha FROM ${S}buch_datei WHERE sha = $1`, [sha]))[0];
  pruefe(d, 'Файл не найден на сервере — загрузите ещё раз', 404);
}
async function dateiRegistrieren(n, info, name) {
  return tx(async q => {
    await q(`INSERT INTO ${S}buch_datei (sha, mime, groesse, name, von) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (sha) DO NOTHING`,
      [info.sha, info.mime, info.groesse, txt(name, 160), n.login]);
    const d = (await q(`SELECT sha, mime, groesse FROM ${S}buch_datei WHERE sha = $1`, [info.sha]))[0];
    const beleg = (await q(`SELECT nr FROM ${S}buch_beleg WHERE datei_sha = $1 AND status <> 'storniert' LIMIT 1`, [info.sha]))[0];
    return { ok: true, sha: d.sha, mime: d.mime, groesse: Number(d.groesse), schon_beleg: beleg ? beleg.nr : null };
  });
}
/** Кто может открыть файл: бухгалтерия и Андрей — все; остальные — только свои. */
async function dateiDarf(n, sha) {
  if (!/^[0-9a-f]{64}$/.test(String(sha || ''))) return null;
  return lesen(async q => {
    const d = (await q(`SELECT * FROM ${S}buch_datei WHERE sha = $1`, [sha]))[0];
    if (!d) return null;
    if (buero(n) || d.von === n.login) return d;
    const r = await q(`SELECT 1 FROM ${S}buch_beleg WHERE datei_sha = $1 AND (eingereicht_von = $2 OR person_ref = $3)
      UNION ALL SELECT 1 FROM ${S}buch_quittung WHERE foto_sha = $1 AND (ausgegeben_von = $2 OR empfaenger_ref = $3)
      UNION ALL SELECT 1 FROM ${S}buch_zahlpaket WHERE $4 AND (datei_sha = $1 OR oleg_datei_sha = $1)
      LIMIT 1`, [sha, n.login, n.person || '-', istDisp(n)]);
    return r.length ? d : null;
  });
}

/* ---------------- чеки ---------------- */
const ARTEN = ['kraftstoff', 'material', 'sonstiges'];
const ZAHLARTEN = ['privat', 'vorschuss', 'firmenkarte', 'kasse'];

async function belegAnlegen(n, b) {
  darf(istMa(n) || istDisp(n) || buero(n), 'Нет прав загружать чеки');
  pruefe(b.idem && String(b.idem).length >= 8, 'Нет ключа повторной отправки');
  const betrag = centAus(b.betrag); pruefe(betrag, 'Введите сумму больше нуля с точностью до цента');
  pruefe(ARTEN.includes(b.art), 'Выберите, что куплено');
  pruefe(ZAHLARTEN.includes(b.zahlart), 'Укажите, чем оплачено');
  const verwendung = String(b.verwendung || '');
  if (b.art === 'kraftstoff') pruefe(['fahrzeug', 'kanister'].includes(verwendung), 'Для топлива укажите машину или канистру/технику');
  else pruefe(['objekt', 'mehrere'].includes(verwendung), 'Укажите объект');
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(String(b.belegdatum || '')) ? b.belegdatum : wt.berlinTag(Date.now());

  return tx(async q => {
    // Повторное нажатие и параллельная отправка: сначала блокировка по ключу
    // отправки, затем по файлу — второй запрос ждёт и видит первый.
    await q('SELECT pg_advisory_xact_lock(hashtext($1))', ['buch_beleg_idem:' + b.idem]);
    const alt = (await q(`SELECT id, nr FROM ${S}buch_beleg WHERE idem = $1`, [b.idem]))[0];
    if (alt) return { ok: true, wiederholt: true, id: alt.id, nr: alt.nr };
    await dateiPruefen(q, b.datei_sha);
    await q('SELECT pg_advisory_xact_lock(hashtext($1))', ['buch_beleg_sha:' + b.datei_sha]);
    const dopp = (await q(`SELECT nr FROM ${S}buch_beleg WHERE datei_sha = $1 AND status <> 'storniert'`, [b.datei_sha]))[0];
    pruefe(!dopp, `Этот снимок уже загружен как ${dopp && dopp.nr}`, 409);

    // Чей чек: сотрудник и Олег — только свой; бухгалтерия — за любого.
    let personRef = n.person || null, personName = n.name || n.login;
    if (buero(n) && b.person_ref) {
      const p = await personLesen(q, b.person_ref);
      pruefe(p, 'Человек не найден в Учёте часов', 404);
      personRef = p.id; personName = p.name;
    }
    let fahrzeugText = null, objektText = null, objektNr = null, fahrzeugRef = null;
    if (verwendung === 'fahrzeug') {
      const f = (await q(`SELECT id::text, COALESCE(NULLIF(concat_ws(' · ', plate, model), ''), nummer) AS text
        FROM vavapp_prod.vehicles WHERE id::text = $1 AND active`, [String(b.fahrzeug_ref || '')]))[0];
      pruefe(f, 'Выберите машину из списка');
      fahrzeugRef = f.id; fahrzeugText = f.text;
    }
    if (verwendung === 'objekt' || (verwendung === 'fahrzeug' && b.objekt_nr)) {
      const o = (await q(`SELECT nummer, bez FROM vav_kern.objekt WHERE nummer = $1`, [String(b.objekt_nr || '')]))[0];
      pruefe(o, 'Выберите объект из списка');
      objektNr = o.nummer; objektText = o.bez || o.nummer;
    }
    if (verwendung === 'mehrere') objektText = 'Несколько объектов';
    if (verwendung === 'kanister') fahrzeugText = 'В канистру / техника';

    let konto = null;
    if (b.zahlart === 'vorschuss') {
      if (istDisp(n) && !b.person_ref) konto = await halterFuer(q, n);
      else {
        pruefe(personRef, 'Для оплаты из аванса нужен сотрудник из Учёта часов');
        konto = vorschussKonto(personRef);
        await kontoSicher(q, konto, 'vorschuss', personName, 'Аванс · ' + personName, null, personRef, n);
      }
    }
    if (b.zahlart === 'kasse') { darf(istBuch(n), 'Оплату из основной кассы отмечает бухгалтерия'); konto = 'hauptkasse'; }
    if (konto) {
      // Наличные в кассе и у ответственного не уходят в минус: блокировка
      // счёта и проверка остатка в той же транзакции. Аванс сотрудника
      // только блокируется: неучтённый аванс не должен мешать сдать чек,
      // расхождение видит бухгалтер.
      await sperreKonto(q, konto);
      if (!konto.startsWith('vorschuss:')) {
        const s = await saldo(q, konto);
        pruefe(betrag <= s.saldo, `Сумма превышает расчётный остаток (${euro(s.saldo)})`, 409);
      }
    }

    const nr = await nummer(q, 'B');
    const r = (await q(`INSERT INTO ${S}buch_beleg (nr, art, kurztext, person_ref, person_name, eingereicht_von, betrag_cent, belegdatum,
        verwendung, objekt_nr, objekt_text, fahrzeug_ref, fahrzeug_text, zahlart, konto_id, datei_sha, dokument_name, notiz, idem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [nr, b.art, txt(b.kurztext, 80), personRef, personName, n.login, betrag, datum, verwendung, objektNr, objektText,
        fahrzeugRef, fahrzeugText, b.zahlart, konto, b.datei_sha, txt(b.dokument_name, 120), txt(b.notiz, 600), b.idem]))[0];
    // Расход из аванса/кассы уменьшает расчётный остаток сразу. Это не второй
    // расход: выдача аванса была перемещением денег, расход — этот чек.
    if (konto) {
      await q(`INSERT INTO ${S}buch_bewegung (art, von_konto, betrag_cent, status, beleg_id, von, bestaetigt_am, bestaetigt_von)
        VALUES ('verbrauch',$1,$2,'bestaetigt',$3,$4,now(),$4)`, [konto, betrag, r.id, n.login]);
    }
    if (b.rueckfrage_id) await antwortIntern(q, n, idOf(b.rueckfrage_id), { text: 'Чек загружен: ' + nr, beleg_id: r.id, datei_sha: b.datei_sha });
    await log(q, n, 'beleg_eingereicht', 'beleg:' + r.id, { nr, betrag, zahlart: b.zahlart });
    return { ok: true, id: r.id, nr };
  });
}

async function belegPruefen(n, id, b) {
  darf(buero(n), 'Чеки проверяет бухгалтерия');
  return tx(async q => {
    const x = (await q(`SELECT * FROM ${S}buch_beleg WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(x, 'Чек не найден', 404);
    // Решает владелец расхода, а не автор записи: бухгалтер проверяет чек,
    // который сам внёс за рабочего, но не свой собственный расход.
    darf(!eigenerAufwand(n, x), 'Собственный расход проверяет другой человек');
    const ok = !(b && b.ergebnis === 'abgelehnt');
    const neu = ok ? 'geprueft' : 'abgelehnt';
    if (x.status === neu) return { ok: true, wiederholt: true };
    pruefe(x.status === 'eingereicht', 'Чек уже рассмотрен', 409);
    if (!ok) pruefe(txt(b.notiz), 'Укажите причину отклонения');
    await q(`UPDATE ${S}buch_beleg SET status = $2, geprueft_am = now(), geprueft_von = $3, pruef_notiz = $4 WHERE id = $1`,
      [x.id, neu, n.login, txt(b && b.notiz)]);
    // Отклонение чека не возвращает деньги: наличные потрачены физически.
    // Расход со счёта остаётся, сумма становится вопросом к ответственному
    // (виден в карточке как «отклонён, деньги потрачены»); касса не растёт.
    if (ok && x.zahlart === 'privat') {
      await q(`INSERT INTO ${S}buch_erstattung (beleg_id, betrag_cent, empfaenger_ref, empfaenger_name, von)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (beleg_id) DO NOTHING`, [x.id, x.betrag_cent, x.person_ref, x.person_name, n.login]);
    }
    await log(q, n, 'beleg_' + neu, 'beleg:' + x.id, { notiz: txt(b && b.notiz) });
    return { ok: true, status: neu };
  });
}

function eigenerAufwand(n, x) {
  if (x.person_ref) return !!n.person && x.person_ref === n.person;
  return x.eingereicht_von === n.login && x.person_name === (n.name || n.login);
}

/* ---------------- возмещения ---------------- */
async function erstattungWeg(n, id, b) {
  darf(istBuch(n), 'Способ возмещения выбирает бухгалтерия');
  pruefe(['bar', 'ueberweisung'].includes(b.weg), 'Наличными или переводом');
  return tx(async q => {
    const e = (await q(`SELECT * FROM ${S}buch_erstattung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(e, 'Возмещение не найдено', 404);
    pruefe(e.status === 'offen', 'Возмещение уже в работе', 409);
    await q(`UPDATE ${S}buch_erstattung SET weg = $2 WHERE id = $1`, [e.id, b.weg]);
    await log(q, n, 'erstattung_weg', 'erstattung:' + e.id, { weg: b.weg });
    return { ok: true };
  });
}
/** Наличными через Олега: без дополнительного утверждения Андрея. */
async function erstattungBar(n, id) {
  darf(istDisp(n) || istBuch(n), 'Наличными возмещает Олег или бухгалтерия');
  return tx(async q => {
    const e = (await q(`SELECT e.*, b.status AS beleg_status FROM ${S}buch_erstattung e JOIN ${S}buch_beleg b ON b.id = e.beleg_id
      WHERE e.id = $1 FOR UPDATE OF e`, [idOf(id)]))[0];
    pruefe(e, 'Возмещение не найдено', 404);
    if (e.status === 'ausgezahlt') return { ok: true, wiederholt: true };
    pruefe(e.beleg_status === 'geprueft', 'Сначала бухгалтерия проверяет чек', 409);
    pruefe(e.status === 'offen' && e.weg !== 'ueberweisung', 'Это возмещение идёт переводом', 409);
    const z = await quittungZeile(q, n, null, { empfaenger_ref: e.empfaenger_ref, empfaenger_name: e.empfaenger_name,
      zweck: 'erstattung', betrag: Number(e.betrag_cent), notiz: 'Возмещение по чеку' }, false, null);
    await q(`UPDATE ${S}buch_quittung SET erstattung_id = $2 WHERE id = $1`, [z.id, e.id]);
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1`, [z.id]))[0];
    return ausgeben(q, n, qt);
  });
}
async function erstattungSchritt(n, id, schritt) {
  return tx(async q => {
    const e = (await q(`SELECT * FROM ${S}buch_erstattung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(e, 'Возмещение не найдено', 404);
    pruefe(e.weg === 'ueberweisung', 'Этот шаг только для перевода', 409);
    if (schritt === 'oleg') {
      darf(istDisp(n), 'Согласует Олег');
      if (e.status === 'oleg_ok') return { ok: true, wiederholt: true };
      pruefe(e.status === 'offen', 'Шаг уже пройден', 409);
      await q(`UPDATE ${S}buch_erstattung SET status = 'oleg_ok', oleg_ok_am = now(), oleg_ok_von = $2 WHERE id = $1`, [e.id, n.login]);
    } else if (schritt === 'an_gf') {
      darf(istBuch(n), 'Передаёт Андрею бухгалтерия');
      if (e.status === 'an_gf') return { ok: true, wiederholt: true };
      pruefe(e.status === 'oleg_ok', 'Сначала согласование Олега', 409);
      await q(`UPDATE ${S}buch_erstattung SET status = 'an_gf' WHERE id = $1`, [e.id]);
    } else if (schritt === 'ueberwiesen') {
      darf(istGf(n), 'Перевод выполняет Андрей');
      if (e.status === 'ueberwiesen_gemeldet') return { ok: true, wiederholt: true };
      pruefe(e.status === 'an_gf', 'Возмещение ещё не передано Андрею', 409);
      await q(`UPDATE ${S}buch_erstattung SET status = 'ueberwiesen_gemeldet', gemeldet_am = now(), gemeldet_von = $2 WHERE id = $1`, [e.id, n.login]);
    } else throw new Fehler(400, 'Неизвестный шаг');
    await log(q, n, 'erstattung_' + schritt, 'erstattung:' + e.id, {});
    return { ok: true };
  });
}

/* ---------------- запросы ---------------- */
async function benutzerFuerPerson(personRef, alle) {
  return (alle || []).find(x => x.person && x.person === personRef && x.rolle === 'mitarbeiter') || null;
}

async function rueckfrageAnlegen(n, b, benutzerListe) {
  darf(buero(n), 'Запрос создаёт бухгалтерия');
  const text = txt(b.text, 1000); pruefe(text, 'Напишите, что нужно');
  const art = ['beleg', 'bank', 'quittung', 'paket', 'frei'].includes(b.bezug_art) ? b.bezug_art : 'frei';
  return tx(async q => {
    if (b.idem) {
      const alt = (await q(`SELECT id, nr FROM ${S}buch_rueckfrage WHERE idem = $1`, [b.idem]))[0];
      if (alt) return { ok: true, wiederholt: true, id: alt.id, nr: alt.nr };
    }
    let belegArt = ['kraftstoff', 'material', 'sonstiges'].includes(b.beleg_art) ? b.beleg_art : null;
    let titel = txt(b.titel, 120), betrag = b.betrag ? centAus(b.betrag) : null, datum = null, zahl = txt(b.zahlart_text, 60), objekt = txt(b.objekt_text, 120);
    let personRef = txt(b.person_ref, 60), personName = null;
    if (art === 'beleg') {
      const x = (await q(`SELECT * FROM ${S}buch_beleg WHERE id = $1`, [idOf(b.bezug_id)]))[0];
      pruefe(x, 'Чек не найден', 404);
      titel = titel || belegTitel(x); betrag = Number(x.betrag_cent); datum = x.belegdatum;
      personRef = x.person_ref; personName = x.person_name; objekt = x.fahrzeug_text || x.objekt_text; belegArt = x.art;
    }
    if (personRef) { const p = await personLesen(q, personRef); if (p) personName = p.name; }
    personName = personName || txt(b.person_name, 120);
    pruefe(personName, 'Кому адресован запрос?');
    pruefe(titel, 'Нужна короткая тема запроса');
    const login = (await benutzerFuerPerson(personRef, benutzerListe) || {}).login || null;
    const nr = await nummer(q, 'R');
    const r = (await q(`INSERT INTO ${S}buch_rueckfrage (nr, beleg_art, bezug_art, bezug_id, titel, betrag_cent, bezugsdatum, zahlart_text, objekt_text,
        person_ref, person_name, person_login, text, von, idem)
      VALUES ($1,$15,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [nr, art, b.bezug_id != null ? String(b.bezug_id) : null, titel, betrag, datum || (/^\d{4}-\d{2}-\d{2}$/.test(String(b.bezugsdatum || '')) ? b.bezugsdatum : null),
        zahl, objekt, personRef, personName, login, text, n.login, b.idem || null, belegArt]))[0];
    await log(q, n, 'rueckfrage_angelegt', 'rueckfrage:' + r.id, { nr, an: personName, benachrichtigt: false });
    return { ok: true, id: r.id, nr, benachrichtigung: 'Уведомления не отправлялись: канал не согласован' };
  });
}

function sichtbar(n, r, jetzt) {
  if (buero(n)) return true;
  const st = wt.stufe(r.frist_basis, jetzt, r.verlust).stufe;
  if (istMa(n)) return r.person_login === n.login || (n.person && r.person_ref === n.person);
  if (istDisp(n)) return !r.verlust && (st === 'oleg' || st === 'gf') || r.person_login === n.login;
  return false;
}

async function antwortIntern(q, n, id, b) {
  const r = (await q(`SELECT * FROM ${S}buch_rueckfrage WHERE id = $1 FOR UPDATE`, [id]))[0];
  pruefe(r, 'Запрос не найден', 404);
  darf(sichtbar(n, r, Date.now()), 'Этот запрос адресован не вам');
  pruefe(r.status !== 'geschlossen', 'Запрос уже закрыт', 409);
  if (b.datei_sha) await dateiPruefen(q, b.datei_sha);
  const text = txt(b.text, 1000);
  pruefe(text || b.datei_sha, 'Добавьте пояснение или фото');
  const e = await q(`INSERT INTO ${S}buch_rueckfrage_eintrag (rueckfrage_id, art, text, datei_sha, beleg_id, von, idem)
    VALUES ($1,'antwort',$2,$3,$4,$5,$6) ON CONFLICT (idem) DO NOTHING RETURNING id`,
    [r.id, text, b.datei_sha || null, b.beleg_id || null, n.login, b.idem || null]);
  if (!e.length) return { ok: true, wiederholt: true };
  // Ответ не закрывает вопрос: закрывает бухгалтер после проверки документа.
  if (!buero(n)) await q(`UPDATE ${S}buch_rueckfrage SET status = 'beantwortet' WHERE id = $1`, [r.id]);
  await log(q, n, 'rueckfrage_antwort', 'rueckfrage:' + r.id, { beleg: b.beleg_id || null });
  return { ok: true };
}
const rueckfrageAntwort = (n, id, b) => tx(q => antwortIntern(q, n, idOf(id), b));

async function rueckfrageVerlust(n, id, b) {
  const text = txt(b.text, 1000); pruefe(text, 'Коротко опишите, что произошло');
  return tx(async q => {
    const r = (await q(`SELECT * FROM ${S}buch_rueckfrage WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(r, 'Запрос не найден', 404);
    darf(sichtbar(n, r, Date.now()) && !buero(n), 'Сообщить о потере может адресат запроса');
    pruefe(r.status !== 'geschlossen', 'Запрос уже закрыт', 409);
    if (r.verlust) return { ok: true, wiederholt: true };
    await q(`INSERT INTO ${S}buch_rueckfrage_eintrag (rueckfrage_id, art, text, von) VALUES ($1,'verlust',$2,$3)`, [r.id, text, n.login]);
    await q(`UPDATE ${S}buch_rueckfrage SET verlust = true, status = 'beantwortet' WHERE id = $1`, [r.id]);
    await log(q, n, 'rueckfrage_verlust', 'rueckfrage:' + r.id, { an: ['buchhaltung', 'gf'], benachrichtigt: false });
    return { ok: true, an: 'бухгалтерия и Андрей' };
  });
}

async function rueckfrageSchliessen(n, id, b) {
  darf(buero(n), 'Закрывает бухгалтерия после проверки');
  const notiz = txt(b.notiz, 600);
  pruefe(notiz, 'Запишите, что проверено перед закрытием');
  return tx(async q => {
    const r = (await q(`SELECT * FROM ${S}buch_rueckfrage WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(r, 'Запрос не найден', 404);
    if (r.status === 'geschlossen') return { ok: true, wiederholt: true };
    await q(`UPDATE ${S}buch_rueckfrage SET status = 'geschlossen', geschlossen_am = now(), geschlossen_von = $2, schluss_notiz = $3 WHERE id = $1`, [r.id, n.login, notiz]);
    await log(q, n, 'rueckfrage_geschlossen', 'rueckfrage:' + r.id, { notiz });
    return { ok: true };
  });
}
async function rueckfrageWieder(n, id, b) {
  darf(buero(n), 'Нет прав');
  return tx(async q => {
    const r = (await q(`SELECT * FROM ${S}buch_rueckfrage WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    pruefe(r, 'Запрос не найден', 404);
    if (r.status === 'offen') return { ok: true, wiederholt: true };
    await q(`UPDATE ${S}buch_rueckfrage SET status = 'offen', frist_basis = now(), geschlossen_am = NULL, geschlossen_von = NULL WHERE id = $1`, [r.id]);
    await q(`INSERT INTO ${S}buch_rueckfrage_eintrag (rueckfrage_id, art, text, von) VALUES ($1,'wiedereroeffnet',$2,$3)`, [r.id, txt(b && b.text), n.login]);
    await log(q, n, 'rueckfrage_wieder', 'rueckfrage:' + r.id, {});
    return { ok: true };
  });
}

/* ---------------- отдельные комплекты к оплате ---------------- */
function ibanGueltig(iban) {
  const s = String(iban || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return null;
  const r = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let rest = 0; for (const ch of r) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1 ? s : null;
}

async function paketAnlegen(n, b) {
  darf(istBuch(n), 'Комплект к оплате готовит бухгалтерия');
  const brutto = centAus(b.brutto); pruefe(brutto, 'Полная сумма счёта больше нуля');
  const lieferant = txt(b.lieferant_name, 160); pruefe(lieferant, 'Укажите подрядчика');
  const rnr = txt(b.rechnung_nr, 60); pruefe(rnr, 'Укажите номер счёта');
  return tx(async q => {
    if (b.idem) {
      const alt = (await q(`SELECT id, nr FROM ${S}buch_zahlpaket WHERE idem = $1`, [b.idem]))[0];
      if (alt) return { ok: true, wiederholt: true, id: alt.id, nr: alt.nr };
    }
    await dateiPruefen(q, b.datei_sha);
    let objektNr = null, objektText = null;
    if (b.objekt_nr) {
      const o = (await q(`SELECT nummer, bez FROM vav_kern.objekt WHERE nummer = $1`, [String(b.objekt_nr)]))[0];
      pruefe(o, 'Объект не найден'); objektNr = o.nummer; objektText = o.bez || o.nummer;
    }
    const nr = await nummer(q, 'Z');
    const r = (await q(`INSERT INTO ${S}buch_zahlpaket (nr, lieferant_name, lieferant_ref, rechnung_nr, rechnungsdatum, brutto_cent, objekt_nr, objekt_text, mail_item_id, datei_sha, von, idem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [nr, lieferant, txt(b.lieferant_ref, 60), rnr, /^\d{4}-\d{2}-\d{2}$/.test(String(b.rechnungsdatum || '')) ? b.rechnungsdatum : null,
        brutto, objektNr, objektText, txt(b.mail_item_id, 40), b.datei_sha, n.login, b.idem || null]))[0];
    await log(q, n, 'paket_angelegt', 'paket:' + r.id, { nr, rechnung: rnr, brutto });
    return { ok: true, id: r.id, nr };
  });
}

async function paketLaden(q, id) {
  const p = (await q(`SELECT * FROM ${S}buch_zahlpaket WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
  pruefe(p, 'Комплект не найден', 404);
  return p;
}

async function paketOleg(n, id, b) {
  const status = b.status === 'abweichung' ? 'abweichung' : 'bestaetigt';
  return tx(async q => {
    const p = await paketLaden(q, id);
    pruefe(p.status === 'entwurf', 'Комплект уже передан Андрею', 409);
    if (istDisp(n)) {
      // Олег подтверждает сам — это и есть письменное подтверждение.
    } else {
      darf(istBuch(n), 'Объём и стоимость подтверждает Олег');
      // Бухгалтер только фиксирует письменное подтверждение Олега — с документом.
      await dateiPruefen(q, b.datei_sha);
    }
    const text = txt(b.text, 600);
    if (status === 'abweichung') pruefe(text, 'Опишите расхождение');
    await q(`UPDATE ${S}buch_zahlpaket SET oleg_status = $2, oleg_am = now(), oleg_von = $3, oleg_text = $4, oleg_datei_sha = COALESCE($5, oleg_datei_sha) WHERE id = $1`,
      [p.id, status, n.login, text, b.datei_sha || null]);
    await log(q, n, 'paket_oleg_' + status, 'paket:' + p.id, { erfasst_von_buchhaltung: istBuch(n) });
    return { ok: true, status };
  });
}

async function paketIban(n, id, b) {
  darf(istBuch(n), 'Реквизиты вносит бухгалтерия');
  const iban = ibanGueltig(b.iban); pruefe(iban, 'IBAN не прошёл проверку контрольной суммы');
  const quelle = txt(b.quelle, 200); pruefe(quelle, 'Укажите проверенный источник реквизитов');
  return tx(async q => {
    const p = await paketLaden(q, id);
    pruefe(['entwurf', 'an_gf'].includes(p.status), 'Комплект уже просмотрен Андреем', 409);
    await q(`UPDATE ${S}buch_zahlpaket SET iban = $2, iban_quelle = $3 WHERE id = $1`, [p.id, iban, quelle]);
    await log(q, n, 'paket_iban', 'paket:' + p.id, { quelle, vorher: p.iban ? 'был' : 'нет' });
    return { ok: true };
  });
}

async function verrechnen(n, id, b) {
  darf(istBuch(n), 'Зачёт квитанций делает бухгалтерия');
  return tx(async q => {
    const p = await paketLaden(q, id);
    pruefe(p.status === 'entwurf', 'Комплект уже передан Андрею — зачёт не меняется', 409);
    const qt = (await q(`SELECT * FROM ${S}buch_quittung WHERE id = $1 FOR UPDATE`, [idOf(b.quittung_id)]))[0];
    pruefe(qt && qt.zweck === 'nu', 'Зачесть можно только выплату рабочему подрядчика', 400);
    pruefe(qt.status === 'ausgegeben', 'Квитанция ещё не выдана — зачитывать нечего', 409);
    const gleich = (qt.nu_ref && p.lieferant_ref && qt.nu_ref === p.lieferant_ref)
      || String(qt.nu_name || '').trim().toLowerCase() === String(p.lieferant_name).trim().toLowerCase();
    pruefe(gleich, 'Квитанция выдана рабочему другого подрядчика', 409);
    const schon = Number((await q(`SELECT COALESCE(SUM(betrag_cent),0) s FROM ${S}buch_verrechnung WHERE quittung_id = $1 AND storniert_am IS NULL`, [qt.id]))[0].s);
    const rest = Number(qt.betrag_cent) - schon;
    const betrag = b.betrag != null && b.betrag !== '' ? centAus(b.betrag) : rest;
    pruefe(betrag && betrag > 0, rest > 0 ? 'Сумма зачёта больше нуля' : `Квитанция ${qt.nr} уже зачтена полностью`, rest > 0 ? 400 : 409);
    pruefe(betrag <= rest, `По квитанции ${qt.nr} осталось зачесть ${euro(rest)}`, 409);
    const imPaket = Number((await q(`SELECT COALESCE(SUM(betrag_cent),0) s FROM ${S}buch_verrechnung WHERE paket_id = $1 AND storniert_am IS NULL`, [p.id]))[0].s);
    pruefe(imPaket + betrag <= Number(p.brutto_cent), 'Зачёт больше полной суммы счёта', 409);
    await q(`INSERT INTO ${S}buch_verrechnung (paket_id, quittung_id, betrag_cent, von) VALUES ($1,$2,$3,$4)`, [p.id, qt.id, betrag, n.login]);
    await log(q, n, 'verrechnung', 'paket:' + p.id, { quittung: qt.nr, betrag, rest_quittung: rest - betrag });
    return { ok: true, rest_quittung: rest - betrag, zu_zahlen: Number(p.brutto_cent) - imPaket - betrag };
  });
}
async function verrechnungStorno(n, id) {
  darf(istBuch(n), 'Нет прав');
  return tx(async q => {
    // Порядок блокировок как в paketAnGf/verrechnen: сначала комплект, потом зачёт.
    // Иначе отмена зачёта могла бы пройти одновременно с передачей Андрею.
    const kopf = (await q(`SELECT paket_id FROM ${S}buch_verrechnung WHERE id = $1`, [idOf(id)]))[0];
    pruefe(kopf, 'Зачёт не найден', 404);
    const p = await paketLaden(q, kopf.paket_id);
    const v = (await q(`SELECT * FROM ${S}buch_verrechnung WHERE id = $1 FOR UPDATE`, [idOf(id)]))[0];
    if (v.storniert_am) return { ok: true, wiederholt: true };
    pruefe(p.status === 'entwurf', 'Комплект уже передан Андрею', 409);
    await q(`UPDATE ${S}buch_verrechnung SET storniert_am = now(), storniert_von = $2 WHERE id = $1`, [v.id, n.login]);
    await log(q, n, 'verrechnung_storno', 'paket:' + v.paket_id, { verrechnung: v.id });
    return { ok: true };
  });
}

async function paketPruefen(n, id) {
  darf(istBuch(n), 'Документы проверяет бухгалтерия');
  return tx(async q => {
    const p = await paketLaden(q, id);
    if (p.geprueft_am) return { ok: true, wiederholt: true };
    pruefe(p.status === 'entwurf', 'Комплект уже передан', 409);
    pruefe(p.datei_sha, 'Нет документа счёта', 409);
    await q(`UPDATE ${S}buch_zahlpaket SET geprueft_am = now(), geprueft_von = $2 WHERE id = $1`, [p.id, n.login]);
    await log(q, n, 'paket_geprueft', 'paket:' + p.id, {});
    return { ok: true };
  });
}

async function paketAnGf(n, id) {
  darf(istBuch(n), 'Передаёт Андрею бухгалтерия');
  return tx(async q => {
    const p = await paketLaden(q, id);
    if (p.status === 'an_gf') return { ok: true, wiederholt: true };
    pruefe(p.status === 'entwurf', 'Комплект уже передан', 409);
    pruefe(p.oleg_status === 'bestaetigt', 'Нет подтверждения Олега по объёму и стоимости', 409);
    pruefe(p.geprueft_am, 'Бухгалтер ещё не проверил документы', 409);
    const offen = await q(`SELECT qt.nr FROM ${S}buch_verrechnung v JOIN ${S}buch_quittung qt ON qt.id = v.quittung_id
      WHERE v.paket_id = $1 AND v.storniert_am IS NULL AND (qt.foto_sha IS NULL OR qt.nu_bestaetigt_am IS NULL)`, [p.id]);
    pruefe(!offen.length, `Квитанции без подписи или подтверждения подрядчика: ${offen.map(x => x.nr).join(', ')}`, 409);
    await q(`UPDATE ${S}buch_zahlpaket SET status = 'an_gf', an_gf_am = now(), an_gf_von = $2 WHERE id = $1`, [p.id, n.login]);
    await log(q, n, 'paket_an_gf', 'paket:' + p.id, { benachrichtigt: false });
    return { ok: true };
  });
}
async function paketGesehen(n, id) {
  darf(istGf(n), 'Комплект просматривает Андрей');
  return tx(async q => {
    const p = await paketLaden(q, id);
    if (p.status !== 'an_gf') return { ok: true, wiederholt: true, status: p.status };
    await q(`UPDATE ${S}buch_zahlpaket SET status = 'gf_gesehen', gf_gesehen_am = now() WHERE id = $1`, [p.id]);
    await log(q, n, 'paket_gesehen', 'paket:' + p.id, {});
    return { ok: true, status: 'gf_gesehen' };
  });
}
/** Андрей отмечает, что внёс перевод в банке. Это не подтверждение банка:
    его даёт связанная операция FinMap. Приложение деньги не переводит. */
async function paketBezahlt(n, id) {
  darf(istGf(n), 'Перевод выполняет Андрей в банке');
  return tx(async q => {
    const p = await paketLaden(q, id);
    if (p.status === 'bezahlt_gemeldet') return { ok: true, wiederholt: true };
    pruefe(['an_gf', 'gf_gesehen'].includes(p.status), 'Комплект ещё не передан Андрею', 409);
    await q(`UPDATE ${S}buch_zahlpaket SET status = 'bezahlt_gemeldet', bezahlt_gemeldet_am = now(), bezahlt_gemeldet_von = $2 WHERE id = $1`, [p.id, n.login]);
    await log(q, n, 'paket_bezahlt_gemeldet', 'paket:' + p.id, {});
    return { ok: true };
  });
}

/* ---------------- банк: только связи с операциями FinMap ---------------- */
/** Связь операции банка с документом. Операция ищется в источнике (FinMap,
    только чтение), сумма сравнивается с документом. Совпало — «сверено».
    Не совпало — связь только по явному решению бухгалтера с пояснением и
    с пометкой «расхождение»; подтверждением банка она не считается.
    finde(op) → { id, datum, betrag } | null — передаёт слой API. */
async function bankLink(n, b, finde) {
  darf(istBuch(n), 'Связи с банком ведёт бухгалтерия');
  const opId = txt(b.finmap_op, 80); pruefe(opId, 'Нет операции банка');
  pruefe(['abhebung', 'paket', 'beleg', 'erstattung', 'rueckfrage'].includes(b.ziel_art), 'Неизвестная цель связи');
  const quelle = await finde(opId);
  pruefe(quelle && quelle.ok, (quelle && quelle.grund) || 'Банк недоступен — связь не ставится', 503);
  const op = quelle.op;
  pruefe(op, 'Операция не найдена в банке', 404);
  return tx(async q => {
    const zid = idOf(b.ziel_id);
    const ziel = {
      abhebung: `SELECT betrag_cent AS b FROM ${S}buch_bewegung WHERE id = $1 AND art = 'abhebung'`,
      paket: `SELECT brutto_cent - COALESCE((SELECT SUM(betrag_cent) FROM ${S}buch_verrechnung v WHERE v.paket_id = p.id AND v.storniert_am IS NULL), 0) AS b
              FROM ${S}buch_zahlpaket p WHERE id = $1`,
      beleg: `SELECT betrag_cent AS b FROM ${S}buch_beleg WHERE id = $1`,
      erstattung: `SELECT betrag_cent AS b FROM ${S}buch_erstattung WHERE id = $1`,
      rueckfrage: `SELECT betrag_cent AS b FROM ${S}buch_rueckfrage WHERE id = $1`,
    }[b.ziel_art];
    const z = (await q(ziel, [zid]))[0];
    pruefe(z && z.b != null, 'Документ для связи не найден', 404);
    const zielBetrag = Number(z.b), opBetrag = Number(op.betrag);
    const gleich = zielBetrag === opBetrag;
    if (!gleich) {
      pruefe(b.trotz_abweichung === true && txt(b.notiz),
        `Сумма в банке ${euro(opBetrag)} не совпадает с документом ${euro(zielBetrag)}. Связь при расхождении — только с пояснением.`, 409);
    }
    const r = await q(`INSERT INTO ${S}buch_bank_link (finmap_op, ziel_art, ziel_id, status, op_betrag_cent, ziel_betrag_cent, op_datum, op_quelle, notiz, von)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,
      [opId, b.ziel_art, String(zid), gleich ? 'abgeglichen' : 'abweichung', opBetrag, zielBetrag,
        /^\d{4}-\d{2}-\d{2}$/.test(String(op.datum || '')) ? op.datum : null, quelle.quelle, txt(b.notiz), n.login]);
    if (!r.length) return { ok: true, wiederholt: true };
    await log(q, n, 'bank_link', b.ziel_art + ':' + zid, { op: opId, status: gleich ? 'abgeglichen' : 'abweichung', opBetrag, zielBetrag });
    return { ok: true, id: r[0].id, status: gleich ? 'abgeglichen' : 'abweichung' };
  });
}

/* ---------------- чтение: картина для экрана ---------------- */
function belegTitel(x) {
  const k = { kraftstoff: 'Заправка', material: 'Материалы', sonstiges: 'Расход' }[x.art] || 'Расход';
  return x.kurztext ? `${k} · ${x.kurztext}` : k;
}
const ZAHL_TEXT = { privat: 'Личные деньги', vorschuss: 'Из аванса', firmenkarte: 'Карта фирмы', kasse: 'Основная касса' };

async function lage(n, benutzerListe, jetzt) {
  jetzt = jetzt || Date.now();
  darf(ROLLEN_KASSE.includes(n.rolle), 'У этой роли нет доступа к кассе');
  return lesen(async q => {
    const demo = ((await q(`SELECT wert FROM vav_kern.einstellung WHERE schluessel = 'buch_demo'`).catch(() => []))[0] || {}).wert === 'ja';
    if (buero(n)) await halterAlle(q, benutzerListe);
    else if (istDisp(n)) await halterFuer(q, n);
    const ich = { login: n.login, name: n.name || n.login, rolle: n.rolle, kurz: n.kurz || initialen(n.name || n.login),
      person: n.person || null, rollenname: n.rollenname || null };

    const konten = await q(`SELECT * FROM ${S}buch_konto ORDER BY art, id`);
    const kontenMit = [];
    for (const k of konten) {
      const sichtbarK = buero(n) || (istDisp(n) && k.login === n.login) || (istMa(n) && k.art === 'vorschuss' && k.person_ref === n.person);
      if (sichtbarK) kontenMit.push({ id: k.id, art: k.art, name: k.name, bei_text: k.bei_text, login: k.login, ...(await saldo(q, k.id)) });
    }
    if (istDisp(n) && !kontenMit.some(k => k.id === halterKonto(n.login))) {
      const kurz = n.kurzname || String(n.name || n.login).split(/\s+/)[0];
      kontenMit.push({ id: halterKonto(n.login), art: 'halter', name: kurz, bei_text: n.bei || ('У ' + kurz), login: n.login,
        erhalten: 0, ausgaben: 0, zurueck: 0, unterwegs: 0, eingehend: 0, saldo: 0 });
    }
    const kontoIds = kontenMit.map(k => k.id);

    // Движения: бухгалтерия и Андрей — все; Олег — свои счета.
    const bew = (await q(`SELECT m.*, k1.name AS von_name, k2.name AS an_name, k2.art AS an_art, k2.login AS an_login
      FROM ${S}buch_bewegung m LEFT JOIN ${S}buch_konto k1 ON k1.id = m.von_konto LEFT JOIN ${S}buch_konto k2 ON k2.id = m.an_konto
      ORDER BY m.id DESC LIMIT 400`)).filter(m => buero(n) || kontoIds.includes(m.von_konto) || kontoIds.includes(m.an_konto));
    const bewegungen = bew.map(m => ({ id: Number(m.id), art: m.art, von_konto: m.von_konto, an_konto: m.an_konto, von_name: m.von_name,
      an_name: m.an_name, betrag: Number(m.betrag_cent), status: m.status, quelle_id: m.quelle_id && Number(m.quelle_id),
      quittung_id: m.quittung_id && Number(m.quittung_id), beleg_id: m.beleg_id && Number(m.beleg_id), datum: iso(m.datum),
      angelegt: m.angelegt, von: m.von, bestaetigt_von: m.bestaetigt_von, finmap_op: m.finmap_op,
      bestaetigen_darf: m.status === 'gemeldet' && m.von !== n.login &&
        ((m.an_art === 'hauptkasse' && istBuch(n)) || (m.an_art === 'halter' && m.an_login === n.login)) }));

    const belegeRoh = await q(`SELECT b.*, e.id AS e_id, e.status AS e_status, e.weg AS e_weg,
        (SELECT nr FROM ${S}buch_beleg d WHERE d.id <> b.id AND d.status <> 'storniert' AND d.person_ref IS NOT DISTINCT FROM b.person_ref
           AND d.betrag_cent = b.betrag_cent AND d.belegdatum = b.belegdatum LIMIT 1) AS dublette
      FROM ${S}buch_beleg b LEFT JOIN ${S}buch_erstattung e ON e.beleg_id = b.id
      WHERE ($1 OR b.eingereicht_von = $2 OR b.person_ref = $3) ORDER BY b.id DESC LIMIT 300`,
      [buero(n), n.login, n.person || '-']);
    const belege = belegeRoh.map(b => ({ id: Number(b.id), nr: b.nr, art: b.art, titel: belegTitel(b), person: b.person_name, person_ref: b.person_ref,
      betrag: Number(b.betrag_cent), datum: iso(b.belegdatum), verwendung: b.verwendung, objekt: b.objekt_text, fahrzeug: b.fahrzeug_text,
      zahlart: b.zahlart, zahlart_text: ZAHL_TEXT[b.zahlart], konto_id: b.konto_id, datei: b.datei_sha, dokument: b.dokument_name,
      status: b.status, geprueft_von: b.geprueft_von, geprueft_am: b.geprueft_am, pruef_notiz: b.pruef_notiz, angelegt: b.angelegt,
      eigen: eigenerAufwand(n, b), dublette: b.dublette,
      geld_ohne_beleg: b.status === 'abgelehnt' && !!b.konto_id,
      erstattung: b.e_id ? { id: Number(b.e_id), status: b.e_status, weg: b.e_weg } : null }));

    const erst = await q(`SELECT e.*, b.nr AS beleg_nr, b.belegdatum, b.art FROM ${S}buch_erstattung e JOIN ${S}buch_beleg b ON b.id = e.beleg_id
      WHERE ($1 OR e.empfaenger_ref = $2 OR ($3 AND e.status IN ('offen','oleg_ok'))) ORDER BY e.id DESC LIMIT 200`,
      [buero(n), n.person || '-', istDisp(n)]);
    const erstattungen = erst.map(e => ({ id: Number(e.id), beleg_id: Number(e.beleg_id), beleg_nr: e.beleg_nr, betrag: Number(e.betrag_cent),
      empfaenger: e.empfaenger_name, weg: e.weg, status: e.status, datum: iso(e.belegdatum), art: e.art }));

    const rfRoh = await q(`SELECT * FROM ${S}buch_rueckfrage ORDER BY (status = 'geschlossen'), id DESC LIMIT 300`);
    const eintr = await q(`SELECT * FROM ${S}buch_rueckfrage_eintrag ORDER BY id`);
    const rueckfragen = rfRoh.filter(r => sichtbar(n, r, jetzt)).map(r => {
      const st = wt.stufe(r.frist_basis, jetzt, r.verlust);
      return { id: Number(r.id), nr: r.nr, beleg_art: r.beleg_art, bezug_art: r.bezug_art, bezug_id: r.bezug_id, titel: r.titel, betrag: r.betrag_cent && Number(r.betrag_cent),
        datum: iso(r.bezugsdatum), zahlart_text: r.zahlart_text, objekt: r.objekt_text, person: r.person_name, person_ref: r.person_ref,
        text: r.text, verlust: r.verlust, status: r.status, stufe: r.status === 'offen' || r.verlust ? st.stufe : null, frist: st.frist,
        angelegt: r.angelegt, schluss_notiz: r.schluss_notiz,
        eintraege: eintr.filter(e => Number(e.rueckfrage_id) === Number(r.id)).map(e => ({ art: e.art, text: e.text, datei: e.datei_sha,
          beleg_id: e.beleg_id && Number(e.beleg_id), von: e.von, am: e.angelegt })) };
    });

    const qtRoh = await q(`SELECT qt.*, p.status AS plan_status, p.nr AS plan_nr,
        (SELECT COALESCE(SUM(betrag_cent),0) FROM ${S}buch_verrechnung v WHERE v.quittung_id = qt.id AND v.storniert_am IS NULL)::bigint AS verrechnet
      FROM ${S}buch_quittung qt LEFT JOIN ${S}buch_geldplan p ON p.id = qt.plan_id ORDER BY qt.id DESC LIMIT 400`);
    const quittungen = qtRoh.filter(x => buero(n)
      || (istDisp(n) && (x.ausgegeben_von === n.login || (x.status === 'vorbereitet' && x.plan_status === 'genehmigt')))
      || (istMa(n) && x.empfaenger_ref === n.person && x.status === 'ausgegeben'))
      .map(x => ({ id: Number(x.id), nr: x.nr, plan_id: x.plan_id && Number(x.plan_id), plan_nr: x.plan_nr, plan_status: x.plan_status,
        empfaenger: x.empfaenger_name, empfaenger_ref: x.empfaenger_ref, nu_name: x.nu_name, zweck: x.zweck, betrag: Number(x.betrag_cent),
        verrechnet: Number(x.verrechnet), status: x.status, dringend: x.dringend, ausgegeben_am: x.ausgegeben_am, ausgegeben_von: x.ausgegeben_von,
        foto: x.foto_sha, original_am: x.original_am, nu_bestaetigt_am: x.nu_bestaetigt_am, nu_bestaetigt_notiz: x.nu_bestaetigt_notiz }));

    const plaene = buero(n) || istDisp(n) ? (await q(`SELECT * FROM ${S}buch_geldplan ORDER BY id DESC LIMIT 60`)).map(p => ({
      id: Number(p.id), nr: p.nr, titel: p.titel, status: p.status, initiator: p.initiator, angelegt: p.angelegt,
      entschieden_von: p.entschieden_von, summe: qtRoh.filter(x => Number(x.plan_id) === Number(p.id) && x.status !== 'storniert')
        .reduce((s, x) => s + Number(x.betrag_cent), 0) })) : [];

    let pakete = [];
    if (buero(n) || istDisp(n)) {
      const pk = await q(`SELECT * FROM ${S}buch_zahlpaket WHERE status <> 'storniert' ORDER BY id DESC LIMIT 100`);
      const vr = await q(`SELECT v.*, qt.nr, qt.empfaenger_name, qt.betrag_cent AS q_betrag, qt.foto_sha, qt.nu_bestaetigt_am, qt.original_am
        FROM ${S}buch_verrechnung v JOIN ${S}buch_quittung qt ON qt.id = v.quittung_id WHERE v.storniert_am IS NULL`);
      const links = await q(`SELECT * FROM ${S}buch_bank_link WHERE geloest_am IS NULL`);
      pakete = pk.filter(p => buero(n) || p.status === 'entwurf').map(p => {
        const v = vr.filter(x => Number(x.paket_id) === Number(p.id));
        const verrechnet = v.reduce((s, x) => s + Number(x.betrag_cent), 0);
        return { id: Number(p.id), nr: p.nr, lieferant: p.lieferant_name, rechnung_nr: p.rechnung_nr, datum: iso(p.rechnungsdatum),
          angelegt: p.angelegt, brutto: Number(p.brutto_cent), verrechnet, zu_zahlen: Number(p.brutto_cent) - verrechnet,
          objekt: p.objekt_text, datei: p.datei_sha, mail_item_id: p.mail_item_id, oleg_status: p.oleg_status, oleg_text: p.oleg_text,
          oleg_datei: p.oleg_datei_sha, oleg_von: p.oleg_von, geprueft_am: p.geprueft_am, status: p.status, iban: istGf(n) || istBuch(n) ? p.iban : null,
          iban_quelle: p.iban_quelle, bezahlt_gemeldet_am: p.bezahlt_gemeldet_am,
          bank_op: (links.find(l => l.ziel_art === 'paket' && l.ziel_id === String(p.id) && l.status === 'abgeglichen') || {}).finmap_op || null,
          bank_abweichung: links.some(l => l.ziel_art === 'paket' && l.ziel_id === String(p.id) && l.status === 'abweichung'),
          verrechnungen: v.map(x => ({ id: Number(x.id), quittung_id: Number(x.quittung_id), nr: x.nr, empfaenger: x.empfaenger_name,
            betrag: Number(x.betrag_cent), quittung_betrag: Number(x.q_betrag), foto: !!x.foto_sha, nu_bestaetigt: !!x.nu_bestaetigt_am,
            original: !!x.original_am })) };
      });
    }

    const personen = (buero(n) || istDisp(n)) ? await q(`SELECT p.id::text AS id, p.full_name AS name, o.name AS org, o.type::text AS org_typ
      FROM vavapp_prod.persons p LEFT JOIN vavapp_prod.orgs o ON o.id = p.org_id
      WHERE p.active AND NOT COALESCE(p.is_test, false) ORDER BY p.full_name LIMIT 500`) : [];
    const objekte = await q(`SELECT nummer, bez FROM vav_kern.objekt WHERE firma = 'VAVK' AND COALESCE(status,'') <> 'zu' ORDER BY nummer DESC LIMIT 300`);
    const fahrzeuge = await q(`SELECT id::text AS id, COALESCE(NULLIF(concat_ws(' · ', plate, model), ''), nummer) AS text
      FROM vavapp_prod.vehicles WHERE active ORDER BY plate LIMIT 200`);

    return { ich, jetzt: new Date(jetzt).toISOString(), heute: wt.berlinTag(jetzt), demo,
      quelle: { stand: new Date(jetzt).toISOString(), text: 'База Бухгалтера' },
      konten: kontenMit, bewegungen, belege, erstattungen, rueckfragen, quittungen, plaene, pakete,
      personen, objekte, fahrzeuge,
      offen: { benachrichtigungen: 'Каналы уведомлений не согласованы — сообщения никому не отправляются' } };
  });
}

function iso(d) { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), t = String(d.getDate()).padStart(2, '0'); return `${y}-${m}-${t}`; }
function initialen(s) { const w = String(s).trim().split(/\s+/); return ((w[0] || '')[0] + ((w[1] || '')[0] || (w[0] || '')[1] || '')).toUpperCase(); }

/** Журнал событий по записи — для истории в карточке. */
async function verlauf(n, ziel) {
  darf(buero(n), 'История доступна бухгалтерии и Андрею');
  pruefe(/^[a-z_]+:\d+$/.test(String(ziel || '')), 'Неверная ссылка');
  return lesen(q => q(`SELECT wann, wer, rolle, art, daten FROM ${S}buch_ereignis WHERE ziel = $1 ORDER BY id`, [ziel]));
}

module.exports = {
  ROLLEN_KASSE, lage, verlauf,
  abhebung, uebergabe, rueckgabe, bestaetigen,
  planAnlegen, planEinreichen, planEntscheiden,
  quittungAusgeben, dringendAusgeben, quittungFoto, quittungOriginal, quittungNuBestaetigt, quittungStorno,
  dateiRegistrieren, dateiDarf,
  belegAnlegen, belegPruefen,
  erstattungWeg, erstattungBar, erstattungSchritt,
  rueckfrageAnlegen, rueckfrageAntwort, rueckfrageVerlust, rueckfrageSchliessen, rueckfrageWieder,
  paketAnlegen, paketOleg, paketIban, verrechnen, verrechnungStorno, paketPruefen, paketAnGf, paketGesehen, paketBezahlt,
  bankLink, ibanGueltig, Fehler,
};
