/* ----------------------------------------------------------------
   Защита от дублей и обработка повторных писем.

   Принципы (согласованные правила):
   - возможный дубль виден бухгалтеру с объяснением; новый документ в статусе
     «Возможный дубль» блокирует расход и подготовку оплаты до решения;
   - уже учтённый документ (verbucht) не изменяем;
   - точная копия файла авто-связывается с существующим (нового счёта/задачи нет);
   - содержание письма проверяем независимо от вложения; срок из письма не применяем авто;
   - Mahngebühren/проценты — отдельно, после проверки → Андрею, не в оплату авто;
   - смена реквизитов → стоп оплаты до проверки через известный контакт;
   - не удаляем документы и не объединяем операции только по совпадению суммы.
   ---------------------------------------------------------------- */
'use strict';
const crypto = require('crypto');
const razn = require('./razn.js');
const wt = require('./kasse/werktage.js');
const aufgaben = require('./aufgaben.js');
let audit = null; try { audit = require('./audit.js'); } catch (e) { /* журнал необязателен */ }

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) { const cl = pg(); try { await cl.connect(); return await fn(cl); } finally { try { await cl.end(); } catch (e) {} } }

function jetzt() { return process.env.BUCH_JETZT ? new Date(process.env.BUCH_JETZT) : new Date(); }
function heute() { return wt.berlinTag(jetzt().getTime()); }
function tag(d) { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10); const z = new Date(d); return new Date(z.getTime() - z.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function hashOf(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex'); }
function cent(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
async function jlog(e) { if (audit) { try { await audit.schreiben(e); } catch (x) {} } }
function task(b) { try { return aufgaben.systemAufgabe(b); } catch (e) { return null; } }

// признаки содержания письма (независимо от вложения)
const MUSTER = {
  zahlungserinnerung: /(zahlungserinnerung|erinner|напомин|reminder|zahlung ausstehend)/i,
  mahnung: /(mahnung|mahnstufe|letzte mahnung)/i,
  fristaenderung: /(neue frist|neuer termin|zahlungsziel|frist bis|verschoben|срок опла|новый срок)/i,
  anspruch: /(anspruch|reklamation|widerspruch|претензи|forderung best)/i,
  iban_wechsel: /(neue bankverbindung|geänderte iban|neue iban|iban geändert|bankverbindung geändert|смена реквизит|новые реквизит|изменил.* iban)/i,
  mahngebuehr: /(mahngeb|mahnkosten)/i,
  zins: /(verzugszins|zinsen|проценты за просроч)/i,
};

// поиск возможных совпадений (с объяснением). НЕ по одной сумме между разными поставщиками.
async function kandidaten(cl, nr, b) {
  const treffer = [];
  const add = (r, grund, staerke) => { if (!treffer.find(t => t.id === r.id)) treffer.push({ id: r.id, rechnung_nr: r.rechnung_nr, betrag_cent: Number(r.betrag_cent), datum: r.datum, status: r.status, verbucht: r.verbucht, bezahlt: r.bezahlt, grund, staerke }); };
  // сильное: тот же поставщик и тот же номер счёта
  if (b.lkey && b.rechnung_nr) {
    const rows = (await cl.query("SELECT * FROM beleg WHERE id<>$1 AND lieferant_key=$2 AND rechnung_nr=$3 AND rechnung_nr<>''", [nr, b.lkey, b.rechnung_nr])).rows;
    rows.forEach(r => add(r, 'тот же поставщик и номер счёта', 'stark'));
  }
  // среднее: тот же поставщик и та же сумма (в т.ч. разные номера — «разные счета на одну сумму»)
  if (b.lkey && b.betrag_cent != null) {
    const rows = (await cl.query("SELECT * FROM beleg WHERE id<>$1 AND lieferant_key=$2 AND betrag_cent=$3", [nr, b.lkey, b.betrag_cent])).rows;
    rows.forEach(r => add(r, r.rechnung_nr && b.rechnung_nr && r.rechnung_nr !== b.rechnung_nr ? 'тот же поставщик и сумма, разные номера' : 'тот же поставщик и сумма', 'mittel'));
  }
  // UTA ↔ чек: та же дата + та же сумма, один источник 'uta', другой нет → двойной расход
  if (b.datum && b.betrag_cent != null && b.quelle) {
    if (b.quelle === 'uta') {
      const rows = (await cl.query(
        "SELECT * FROM beleg WHERE id<>$1 AND quelle<>'uta' AND betrag_cent=$2 AND datum=$3::date",
        [nr, b.betrag_cent, b.datum]
      )).rows;
      rows.forEach(r => add(r, 'UTA-транзакция: та же дата и сумма, что и ручной чек — возможен двойной расход', 'mittel'));
    } else {
      const rows = (await cl.query(
        "SELECT * FROM beleg WHERE id<>$1 AND quelle='uta' AND betrag_cent=$2 AND datum=$3::date",
        [nr, b.betrag_cent, b.datum]
      )).rows;
      rows.forEach(r => add(r, 'чек: та же дата и сумма, что и UTA-транзакция — возможен двойной расход', 'mittel'));
    }
  }
  return treffer;
}

// Приём документа. Возвращает {ok,id,status,...}. Уже учтённые документы не изменяет.
async function belegEmpfang(d, user) {
  return mit(async (cl) => {
    const hash = d.datei_hash || (d.inhalt != null ? hashOf(d.inhalt) : null);
    const opId = d.operation_id ? String(d.operation_id) : null;
    // идемпотентность повторного импорта: то же operation_id — второй раз не заводим
    if (opId) {
      const da = (await cl.query('SELECT id, status FROM beleg WHERE operation_id=$1', [opId])).rows[0];
      if (da) return { ok: true, wiederholung: true, id: da.id, status: da.status, grund: 'повторный импорт (operation_id уже есть)' };
    }
    const lief = String(d.lieferant || '').trim();
    const b = {
      quelle: String(d.quelle || 'email'),
      lkey: razn.schluessel(lief), rechnung_nr: String(d.rechnung_nr || '').trim(),
      betrag_cent: cent(d.betrag != null ? d.betrag : d.betrag_cent),
      datum: /^\d{4}-\d{2}-\d{2}$/.test(String(d.datum || '')) ? d.datum : null,
      faellig: /^\d{4}-\d{2}-\d{2}$/.test(String(d.faellig || '')) ? d.faellig : null,
      iban: String(d.iban || '').replace(/\s/g, '').toUpperCase() || null,
    };
    const von = (user && user.login) || 'system';

    // 3) точная копия файла -> связать с существующим, новый счёт/задачу не создавать
    let kopieVon = null;
    if (hash) {
      const orig = (await cl.query("SELECT id FROM beleg WHERE datei_hash=$1 ORDER BY id LIMIT 1", [hash])).rows[0];
      if (orig) kopieVon = orig.id;
    }

    const ins = await cl.query(
      `INSERT INTO beleg (quelle, mail_id, datei_name, datei_hash, lieferant, lieferant_key, rechnung_nr, betrag_cent, datum, faellig, iban, operation_id, status, von)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'neu',$13) RETURNING id`,
      [d.quelle || 'email', d.mail_id || null, d.datei_name || null, hash, lief || null, b.lkey || null,
       b.rechnung_nr || null, b.betrag_cent, b.datum, b.faellig, b.iban, opId, von]);
    const id = ins.rows[0].id;

    let status = 'neu', sperre = null, primaer = null;
    const erklaerung = [];

    if (kopieVon) {
      status = 'kopie'; sperre = 'kopie'; primaer = kopieVon;
      await cl.query('INSERT INTO beleg_verknuepfung (beleg_id, ziel_id, art, grund, von) VALUES ($1,$2,$3,$4,$5)', [id, kopieVon, 'kopie', 'точная копия файла (тот же sha256)', von]);
      erklaerung.push({ ziel_id: kopieVon, grund: 'точная копия файла (sha256 совпал)', staerke: 'kopie' });
    } else {
      const kand = await kandidaten(cl, id, b);
      if (kand.length) {
        status = 'moeglicher_dubup'; sperre = 'moeglicher_dubup';
        kand.forEach(k => erklaerung.push({ ziel_id: k.id, grund: k.grund, staerke: k.staerke, betrag_cent: k.betrag_cent, rechnung_nr: k.rechnung_nr }));
      }
    }

    // срок проверки — 1 рабочий день; риск Андрею, если сегодня крайний срок оплаты
    let pruefFrist = null, risikoAndrej = false;
    if (status === 'moeglicher_dubup') {
      pruefFrist = wt.fristEnde(heute(), 1);
      if (b.faellig && b.faellig <= heute()) {
        risikoAndrej = true;
        task({ titel: 'Возможный дубль — сегодня срок оплаты', ziel_rolle: 'gf', art: 'dubup_risiko',
          text: 'Документ #' + id + ' (' + (lief || 'поставщик?') + ', ' + ((b.betrag_cent || 0) / 100).toFixed(2) + ' €) — возможный дубль, а срок оплаты сегодня. Нужно решение о задержке/оплате.', bezug: 'beleg:' + id });
      }
    }
    await cl.query('UPDATE beleg SET status=$2, gesperrt_grund=$3, primaer_id=$4, pruef_frist=$5 WHERE id=$1', [id, status, sperre, primaer, pruefFrist]);

    // 4) содержание письма — независимо от вложения
    const signale = await signaleErfassen(cl, id, d, von);
    // 7) смена реквизитов -> стоп оплаты до проверки через известный контакт
    const ibanStop = await ibanPruefen(cl, id, b, d, von);
    // 6) Mahngebühren/проценты — отдельно
    await extraErfassen(cl, id, d, von);

    await jlog({ wer: von, rolle: user && user.rolle, art: 'beleg_eingang', ziel: 'beleg:' + id, grund: status });
    return { ok: true, id, status, gesperrt: !!(sperre || ibanStop), gesperrt_grund: ibanStop ? 'iban_stop' : sperre,
      primaer_id: primaer, erklaerung, signale, iban_stop: ibanStop, pruef_frist: pruefFrist, risiko_andrej: risikoAndrej };
  });
}

async function belRow(cl, id) { return (await cl.query('SELECT * FROM beleg WHERE id=$1', [id])).rows[0]; }

// 4) сигналы содержания письма — независимо от вложения. Срок НЕ применяется авто.
async function signaleErfassen(cl, id, d, von) {
  const txt = String(d.mailtext || '');
  const row = await belRow(cl, id);
  const out = [];
  const add = async (art, text, neuer_wert, aufgabe_id) => {
    const r = await cl.query('INSERT INTO beleg_signal (beleg_id,mail_id,art,text,neuer_wert,aufgabe_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [id, d.mail_id || null, art, text || null, neuer_wert || null, aufgabe_id || null]);
    out.push({ id: r.rows[0].id, art, neuer_wert: neuer_wert || null }); return r.rows[0].id;
  };
  const reminder = MUSTER.zahlungserinnerung.test(txt) || MUSTER.mahnung.test(txt) || d.art_signal === 'zahlungserinnerung';
  if (reminder) {
    // 5) напоминание по уже оплаченному счёту -> задача сверки, без повторного платежа
    const bez = (await cl.query(
      "SELECT id FROM beleg WHERE bezahlt=true AND ((rechnung_nr<>'' AND rechnung_nr=$1) OR (lieferant_key=$2 AND betrag_cent=$3)) ORDER BY id LIMIT 1",
      [row.rechnung_nr || '', row.lieferant_key, row.betrag_cent])).rows[0];
    if (bez) {
      const t = task({ titel: 'Напоминание по оплаченному счёту — сверить', ziel_rolle: 'buchhaltung', art: 'zahlung_sverka',
        text: 'Напоминание по счёту, отмеченному оплаченным (beleg #' + bez.id + '). Сверить банковское подтверждение, сумму и реквизиты. Повторный платёж не создавать.', bezug: 'beleg:' + bez.id });
      await add('zahlungserinnerung_bezahlt', 'напоминание по уже оплаченному счёту — создана задача сверки', null, t && t.id);
    } else {
      await add(MUSTER.mahnung.test(txt) ? 'mahnung' : 'zahlungserinnerung', 'напоминание об оплате из письма');
    }
  }
  if (MUSTER.fristaenderung.test(txt) || d.neue_frist)
    await add('fristaenderung', 'изменение срока из письма — применять только после проверки', d.neue_frist || null);
  if (MUSTER.anspruch.test(txt)) await add('anspruch', 'претензия/возражение в письме');
  return out;
}

// 7) смена реквизитов -> стоп оплаты; новые данные из подозрительного письма не считать подтверждением.
async function ibanPruefen(cl, id, b, d, von) {
  const textHint = MUSTER.iban_wechsel.test(String(d.mailtext || ''));
  let vor = null;
  if (b.iban && b.lkey) {
    vor = (await cl.query("SELECT iban FROM beleg WHERE lieferant_key=$1 AND iban IS NOT NULL AND iban<>'' AND iban<>$2 AND id<>$3 ORDER BY id DESC LIMIT 1",
      [b.lkey, b.iban, id])).rows[0];
  }
  if (!vor && !textHint) return false;
  await cl.query("UPDATE beleg SET gesperrt_grund='iban_stop' WHERE id=$1", [id]);
  const txt = vor ? ('реквизиты отличаются от ранее известных (' + vor.iban + ' → ' + (b.iban || '?') + ') — оплата приостановлена; проверить через ИЗВЕСТНЫЙ контакт поставщика')
                  : ('в письме заявлена смена реквизитов — оплата приостановлена; проверить через ИЗВЕСТНЫЙ контакт (данные из письма подтверждением не считать)');
  await cl.query('INSERT INTO beleg_signal (beleg_id,mail_id,art,text,neuer_wert) VALUES ($1,$2,$3,$4,$5)', [id, d.mail_id || null, 'iban_wechsel', txt, b.iban || null]);
  task({ titel: 'Смена реквизитов — проверить контакт', ziel_rolle: 'buchhaltung', art: 'iban_pruef',
    text: 'Документ #' + id + ': ' + txt, bezug: 'beleg:' + id });
  return true;
}

// 6) Mahngebühren/проценты — отдельно от долга, не в оплату авто. Неизвестная сумма = null (не 0).
async function extraErfassen(cl, id, d, von) {
  const txt = String(d.mailtext || '');
  const mg = cent(d.mahngebuehr_betrag);
  const zi = cent(d.zins_betrag);
  if (mg != null || MUSTER.mahngebuehr.test(txt))
    await cl.query('INSERT INTO beleg_extra (beleg_id,art,betrag_cent,von) VALUES ($1,$2,$3,$4)', [id, 'mahngebuehr', mg, von]);
  if (zi != null || MUSTER.zins.test(txt))
    await cl.query('INSERT INTO beleg_extra (beleg_id,art,betrag_cent,von) VALUES ($1,$2,$3,$4)', [id, 'zins', zi, von]);
}

// 1,2,9) решение бухгалтера: Дубль / Отдельная операция / Исправленный документ.
async function entscheiden(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id); if (!id) throw new Error('нет id');
    const ent = String(d.entscheidung || '');
    if (!['dubup', 'separate', 'korrektur'].includes(ent)) throw new Error('неизвестное решение');
    const bo = (await cl.query('SELECT * FROM beleg WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!bo) throw new Error('документ не найден');
    if (bo.verbucht) throw new Error('учтённый документ не изменяем');
    const zielId = d.ziel_id ? Number(d.ziel_id) : null;
    if ((ent === 'dubup' || ent === 'korrektur') && !zielId) throw new Error('для дубля/исправления нужен исходный документ (ziel_id)');
    const iban = bo.gesperrt_grund === 'iban_stop';   // iban-стоп решением по дублю не снимается
    let nachher = ent, sperre = bo.gesperrt_grund;
    if (ent === 'dubup') { nachher = 'dubup'; sperre = iban ? 'iban_stop' : 'moeglicher_dubup'; }   // остаётся заблокирован и виден
    if (ent === 'separate') { nachher = 'separate'; sperre = iban ? 'iban_stop' : null; }
    if (ent === 'korrektur') { nachher = 'korrektur'; sperre = iban ? 'iban_stop' : null; }
    await cl.query('UPDATE beleg SET status=$2, gesperrt_grund=$3, primaer_id=$4 WHERE id=$1',
      [id, nachher, sperre, (ent === 'dubup' || ent === 'korrektur') ? zielId : bo.primaer_id]);
    if (ent === 'dubup' || ent === 'korrektur')
      await cl.query('INSERT INTO beleg_verknuepfung (beleg_id, ziel_id, art, grund, von) VALUES ($1,$2,$3,$4,$5)', [id, zielId, ent, String(d.grund || '').slice(0, 400), (user && user.login) || 'system']);
    await cl.query('INSERT INTO beleg_entscheidung (beleg_id, entscheidung, vorher_status, nachher_status, ziel_id, grund, von) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, ent, bo.status, nachher, zielId, String(d.grund || '').slice(0, 400), (user && user.login) || 'system']);
    await jlog({ wer: user && user.login, rolle: user && user.rolle, art: 'beleg_entscheidung', ziel: 'beleg:' + id, neu: ent });
    return { ok: true, id, status: nachher, gesperrt: !!sperre, gesperrt_grund: sperre };
  });
}

// 2) связать документы одной операции (чек работника + детализация UTA).
async function verknuepfen(d, user) {
  return mit(async (cl) => {
    const a = Number(d.beleg_id), z = Number(d.ziel_id);
    if (!a || !z || a === z) throw new Error('нужны два разных документа');
    for (const x of [a, z]) if (!(await cl.query('SELECT 1 FROM beleg WHERE id=$1', [x])).rows[0]) throw new Error('нет документа #' + x);
    const art = ['operation', 'kopie'].includes(d.art) ? d.art : 'operation';
    await cl.query('INSERT INTO beleg_verknuepfung (beleg_id, ziel_id, art, grund, von) VALUES ($1,$2,$3,$4,$5)', [a, z, art, String(d.grund || '').slice(0, 400), (user && user.login) || 'system']);
    await cl.query('INSERT INTO beleg_entscheidung (beleg_id, entscheidung, vorher_status, nachher_status, ziel_id, grund, von) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [a, 'verknuepfung', null, null, z, String(d.grund || 'одна операция').slice(0, 400), (user && user.login) || 'system']);
    return { ok: true };
  });
}

// 7) снять iban-стоп ТОЛЬКО после проверки через известный контакт.
async function ibanFreigeben(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id); if (!id) throw new Error('нет id');
    if (d.kontakt_geprueft !== true) throw new Error('нужна проверка через ИЗВЕСТНЫЙ контакт поставщика (данные из письма подтверждением не считаются)');
    const bo = (await cl.query('SELECT * FROM beleg WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!bo) throw new Error('документ не найден');
    const sperre = bo.status === 'moeglicher_dubup' ? 'moeglicher_dubup' : null;
    await cl.query('UPDATE beleg SET gesperrt_grund=$2 WHERE id=$1', [id, sperre]);
    await cl.query("UPDATE beleg_signal SET erledigt=true WHERE beleg_id=$1 AND art='iban_wechsel'", [id]);
    await cl.query('INSERT INTO beleg_entscheidung (beleg_id, entscheidung, vorher_status, nachher_status, grund, von) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, 'iban_freigabe', bo.status, bo.status, String(d.grund || 'проверено через известный контакт').slice(0, 400), (user && user.login) || 'system']);
    return { ok: true, gesperrt_grund: sperre };
  });
}

// 4) применить изменение срока — только после проверки (явное действие).
async function fristAnwenden(d, user) {
  return mit(async (cl) => {
    const sid = Number(d.signal_id); if (!sid) throw new Error('нет сигнала');
    const s = (await cl.query('SELECT * FROM beleg_signal WHERE id=$1', [sid])).rows[0];
    if (!s || s.art !== 'fristaenderung') throw new Error('это не сигнал изменения срока');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.neuer_wert || ''))) throw new Error('в сигнале нет проверенного нового срока');
    await cl.query('UPDATE beleg SET faellig=$2 WHERE id=$1', [s.beleg_id, s.neuer_wert]);
    await cl.query('UPDATE beleg_signal SET angewandt=true, erledigt=true WHERE id=$1', [sid]);
    await cl.query('INSERT INTO beleg_entscheidung (beleg_id, entscheidung, grund, von) VALUES ($1,$2,$3,$4)',
      [s.beleg_id, 'frist_angewandt', 'новый срок ' + s.neuer_wert + ' применён после проверки', (user && user.login) || 'system']);
    return { ok: true, faellig: s.neuer_wert };
  });
}

async function signalErledigt(d, user) {
  return mit(async (cl) => { await cl.query('UPDATE beleg_signal SET erledigt=true WHERE id=$1', [Number(d.signal_id)]); return { ok: true }; });
}

// 6) Mahngebühren/проценты: проверка -> Андрею -> решение. В оплату авто не добавляются.
async function extraPruefen(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id);
    await cl.query("UPDATE beleg_extra SET status='geprueft', geprueft_von=$2 WHERE id=$1 AND status='neu'", [id, (user && user.login) || null]);
    return { ok: true };
  });
}
async function extraAnAndrej(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id);
    const e = (await cl.query('SELECT * FROM beleg_extra WHERE id=$1', [id])).rows[0];
    if (!e) throw new Error('нет начисления');
    if (e.status !== 'geprueft') throw new Error('сначала проверка бухгалтером');
    await cl.query("UPDATE beleg_extra SET status='an_andrej' WHERE id=$1", [id]);
    task({ titel: 'Mahngebühr/проценты — решение Андрея', ziel_rolle: 'gf', art: 'extra_andrej',
      text: (e.art === 'zins' ? 'Проценты' : 'Mahngebühr') + ' по документу #' + e.beleg_id + ': ' + (e.betrag_cent != null ? (e.betrag_cent / 100).toFixed(2) + ' €' : 'сумма не указана') + '. Отдельно от долга; в оплату не добавлено. Нужно решение.', bezug: 'beleg:' + e.beleg_id });
    return { ok: true };
  });
}
async function extraEntscheiden(d, user) {
  return mit(async (cl) => {
    if (!user || user.rolle !== 'gf') throw new Error('решение по Mahngebühr/процентам принимает владелец');
    const id = Number(d.id);
    const ent = d.entscheidung === 'zahlen' ? 'zahlen' : 'ablehnen';
    const st = ent === 'zahlen' ? 'entschieden' : 'abgelehnt';
    await cl.query("UPDATE beleg_extra SET status=$2, entscheidung=$3, andrej_von=$4 WHERE id=$1 AND status='an_andrej'", [id, st, ent, user.login]);
    return { ok: true, status: st, hinweis: 'решение записано; в оплату автоматически не добавляется' };
  });
}

// пометки состояния (учтён/оплачен) — нормальный путь из разноса/кассы; для теста тоже.
async function markieren(d, user) {
  return mit(async (cl) => {
    const id = Number(d.id); if (!id) throw new Error('нет id');
    const sets = [], val = [id]; let i = 2;
    if (d.verbucht != null) { sets.push('verbucht=$' + i++); val.push(!!d.verbucht); }
    if (d.bezahlt != null) { sets.push('bezahlt=$' + i++); val.push(!!d.bezahlt); }
    if (!sets.length) return { ok: true };
    await cl.query('UPDATE beleg SET ' + sets.join(', ') + ' WHERE id=$1', val);
    return { ok: true };
  });
}

function gesperrtText(g) { return g === 'iban_stop' ? 'оплата приостановлена (смена реквизитов)' : g === 'moeglicher_dubup' ? 'возможный дубль' : g === 'kopie' ? 'копия файла' : ''; }

// очередь проверки: возможные дубли, копии, iban-стоп, открытые сигналы/начисления.
async function liste() {
  return mit(async (cl) => {
    const rows = (await cl.query(
      `SELECT * FROM beleg WHERE status IN ('moeglicher_dubup','kopie','dubup')
         OR gesperrt_grund IS NOT NULL
         OR id IN (SELECT beleg_id FROM beleg_signal WHERE NOT erledigt)
         OR id IN (SELECT beleg_id FROM beleg_extra WHERE status IN ('neu','geprueft','an_andrej'))
       ORDER BY (gesperrt_grund IS NULL), eingang_am DESC`)).rows;
    const h = heute();
    const out = [];
    for (const r of rows) {
      let erklaerung = [];
      if (r.status === 'moeglicher_dubup' || r.status === 'dubup')
        erklaerung = (await kandidaten(cl, r.id, { lkey: r.lieferant_key, rechnung_nr: r.rechnung_nr, betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, quelle: r.quelle, datum: tag(r.datum) }))
          .map(k => ({ ziel_id: k.id, grund: k.grund, staerke: k.staerke, betrag_cent: k.betrag_cent, rechnung_nr: k.rechnung_nr }));
      const signale = (await cl.query('SELECT id, art, text, neuer_wert, angewandt, erledigt FROM beleg_signal WHERE beleg_id=$1 ORDER BY id', [r.id])).rows;
      const extra = (await cl.query('SELECT id, art, betrag_cent, status, entscheidung FROM beleg_extra WHERE beleg_id=$1 ORDER BY id', [r.id])).rows;
      out.push({
        id: r.id, eingang_am: r.eingang_am, quelle: r.quelle, datei_name: r.datei_name,
        lieferant: r.lieferant, rechnung_nr: r.rechnung_nr, betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null,
        datum: tag(r.datum), faellig: tag(r.faellig), iban: r.iban, status: r.status,
        gesperrt: !!r.gesperrt_grund, gesperrt_grund: r.gesperrt_grund, gesperrt_text: gesperrtText(r.gesperrt_grund),
        verbucht: r.verbucht, bezahlt: r.bezahlt, primaer_id: r.primaer_id,
        pruef_frist: tag(r.pruef_frist), ueberfaellig: !!(r.pruef_frist && tag(r.pruef_frist) < h),
        faellig_heute: !!(r.faellig && tag(r.faellig) === h),
        erklaerung, signale, extra: extra.map(e => ({ ...e, betrag_cent: e.betrag_cent != null ? Number(e.betrag_cent) : null })),
      });
    }
    return { queue: out, stand: h };
  });
}

async function eins(id) {
  return mit(async (cl) => {
    const r = await belRow(cl, Number(id)); if (!r) throw new Error('нет документа');
    const verkn = (await cl.query('SELECT * FROM beleg_verknuepfung WHERE beleg_id=$1 OR ziel_id=$1 ORDER BY id', [Number(id)])).rows;
    const hist = (await cl.query('SELECT * FROM beleg_entscheidung WHERE beleg_id=$1 ORDER BY id', [Number(id)])).rows;
    const signale = (await cl.query('SELECT * FROM beleg_signal WHERE beleg_id=$1 ORDER BY id', [Number(id)])).rows;
    const extra = (await cl.query('SELECT * FROM beleg_extra WHERE beleg_id=$1 ORDER BY id', [Number(id)])).rows;
    const kand = (r.status === 'moeglicher_dubup' || r.status === 'dubup')
      ? await kandidaten(cl, r.id, { lkey: r.lieferant_key, rechnung_nr: r.rechnung_nr, betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, quelle: r.quelle, datum: tag(r.datum) }) : [];
    return { beleg: { ...r, betrag_cent: r.betrag_cent != null ? Number(r.betrag_cent) : null, datum: tag(r.datum), faellig: tag(r.faellig), pruef_frist: tag(r.pruef_frist) }, verknuepfungen: verkn, historie: hist, signale, extra, kandidaten: kand };
  });
}

module.exports = { belegEmpfang, entscheiden, verknuepfen, ibanFreigeben, fristAnwenden, signalErledigt,
  extraPruefen, extraAnAndrej, extraEntscheiden, markieren, liste, eins };
