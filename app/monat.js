/* ---------------------------------------------------------------
   Дополнение №5 — проверка периодов.
   Блок 1: «Месяц проверен Натальей» — ВНУТРЕННИЙ статус приложения.
   Заменяет прежнее обязательное ежемесячное закрытие через
   Steuerberater. Отметку «месяц проверен» ставит ответственный
   бухгалтер (в пилоте — роль buchhaltung с флагом verantwortlich,
   назначает gf). Это НЕ подача отчётности и НЕ годовое закрытие —
   6 состояний различаются явно.
   Боевые данные и поданную отчётность не трогаем (пилот, buchpilot).
   ---------------------------------------------------------------- */
'use strict';

const DB = process.env.PILOT_IMPORT_DB || 'postgres://buch@127.0.0.1:55481/buchpilot';
function pg() { return new (require('pg').Client)({ connectionString: DB }); }
async function mit(fn) {
  const cl = pg();
  try { await cl.connect(); return await fn(cl); }
  finally { try { await cl.end(); } catch (e) {} }
}

// Две фирмы владельца — единый справочник, без дублей.
const FIRMEN = {
  kaiser:     'VAV Kaiser GmbH',
  trockenbau: 'VAV Kaiser Trockenbau GmbH',
};

// Порядок состояний месяца. Каждое — отдельный смысл, не смешивать.
const STATUS = [
  { k: 'gesammelt',            t: 'Документы собраны' },
  { k: 'geprueft',             t: 'Документы проверены' },
  { k: 'natalia_geprueft',     t: 'Месяц проверен Натальей' },
  { k: 'paket_uebergeben',     t: 'Комплект копий передан Steuerberater' },
  { k: 'erklaerung_eingereicht', t: 'Налоговая отчётность подана' },
  { k: 'jahr_zu',              t: 'Год закрыт' },
];
const STATUS_K = STATUS.map(s => s.k);
const STATUS_T = Object.fromEntries(STATUS.map(s => [s.k, s.t]));
const RANG = Object.fromEntries(STATUS_K.map((k, i) => [k, i]));

// Ответственный бухгалтер (Наталья). Учётной записи Натальи нет — это
// возможность на роли buchhaltung, назначает владелец. gf может всё.
function istVerantwortlich(u) {
  return !!u && (u.rolle === 'gf' || (u.rolle === 'buchhaltung' && u.verantwortlich === true));
}

function firmaPruef(f) {
  const k = String(f || '').trim();
  if (!FIRMEN[k]) throw new Error('неизвестная фирма: ' + k);
  return k;
}
function periodePruef(jahr, monat) {
  const j = Number(jahr), m = Number(monat);
  if (!Number.isInteger(j) || j < 2020 || j > 2100) throw new Error('год вне диапазона');
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('месяц 1..12');
  return { j, m };
}

async function zeile(cl, firma, j, m) {
  let r = (await cl.query('SELECT * FROM monatsstatus WHERE firma=$1 AND jahr=$2 AND monat=$3', [firma, j, m])).rows[0];
  if (!r) {
    r = (await cl.query(
      'INSERT INTO monatsstatus (firma,jahr,monat,status) VALUES ($1,$2,$3,$4) RETURNING *',
      [firma, j, m, 'gesammelt'])).rows[0];
  }
  return r;
}

function ausgabe(r) {
  return {
    firma: r.firma, firma_name: FIRMEN[r.firma] || r.firma,
    jahr: r.jahr, monat: r.monat,
    status: r.status, status_text: STATUS_T[r.status] || r.status,
    wiedervorlage: r.wiedervorlage === true,
    natalia_von: r.natalia_von || null, natalia_am: r.natalia_am || null,
    notiz: r.notiz || '', stand: r.stand,
  };
}

// Обзор года: 12 месяцев по каждой фирме.
async function uebersicht(jahr) {
  const j = periodePruef(jahr, 1).j;
  return mit(async cl => {
    const rows = (await cl.query('SELECT * FROM monatsstatus WHERE jahr=$1', [j])).rows;
    const map = new Map(rows.map(r => [r.firma + '|' + r.monat, r]));
    const firmen = Object.keys(FIRMEN).map(f => ({
      firma: f, name: FIRMEN[f],
      monate: Array.from({ length: 12 }, (_, i) => {
        const r = map.get(f + '|' + (i + 1));
        return r ? ausgabe(r) : {
          firma: f, firma_name: FIRMEN[f], jahr: j, monat: i + 1,
          status: 'gesammelt', status_text: STATUS_T.gesammelt, wiedervorlage: false,
          natalia_von: null, natalia_am: null, notiz: '', stand: null,
        };
      }),
    }));
    return { jahr: j, status_katalog: STATUS, firmen };
  });
}

async function eins(firma, jahr, monat) {
  const f = firmaPruef(firma); const { j, m } = periodePruef(jahr, monat);
  return mit(async cl => {
    const r = await zeile(cl, f, j, m);
    const log = (await cl.query(
      'SELECT von,nach,ereignis,autor,notiz,wann FROM monatsstatus_log WHERE firma=$1 AND jahr=$2 AND monat=$3 ORDER BY wann DESC LIMIT 50',
      [f, j, m])).rows;
    return { ...ausgabe(r), verlauf: log };
  });
}

// Установить статус месяца. Возвращает {ok, unchanged?} — идемпотентно.
async function statusSetzen(body, user) {
  const f = firmaPruef(body.firma); const { j, m } = periodePruef(body.jahr, body.monat);
  const neu = String(body.status || '').trim();
  if (!STATUS_K.includes(neu)) throw new Error('неизвестный статус: ' + neu);

  // Право: «месяц проверен Натальей» и всё выше — только ответственный/владелец.
  // Ниже (собраны/проверены) — бухгалтерия/владелец.
  const nurVerantwortlich = RANG[neu] >= RANG.natalia_geprueft;
  if (nurVerantwortlich) {
    if (!istVerantwortlich(user)) throw new Error('только ответственный бухгалтер или владелец');
  } else {
    if (!['gf', 'buchhaltung'].includes(user.rolle)) throw new Error('вносит бухгалтерия или владелец');
  }

  return mit(async cl => {
    const r = await zeile(cl, f, j, m);
    // Ф3: повторное подтверждение «месяц проверен Натальей», когда стоит метка
    // повторной проверки, — это не «без изменений», а приёмка обновлённых итогов.
    const rebestaetigung = (neu === 'natalia_geprueft' && r.status === 'natalia_geprueft' && r.wiedervorlage === true);
    if (r.status === neu && !rebestaetigung) return { ok: true, unchanged: true, ...ausgabe(r) };

    const setzt = ['status=$4', 'stand=now()'];
    const args = [f, j, m, neu];
    if (neu === 'natalia_geprueft') {
      // отметка Натальи: фиксируем автора и снимаем «требует повторной проверки»
      setzt.push('natalia_von=$5', 'natalia_am=now()', 'wiedervorlage=false');
      args.push(user.login);
    }
    const upd = (await cl.query(
      `UPDATE monatsstatus SET ${setzt.join(', ')} WHERE firma=$1 AND jahr=$2 AND monat=$3 RETURNING *`, args)).rows[0];
    await cl.query(
      'INSERT INTO monatsstatus_log (firma,jahr,monat,von,nach,ereignis,autor,notiz) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [f, j, m, r.status, neu, rebestaetigung ? 'rebestaetigung' : 'statuswechsel', user.login, String(body.notiz || '').slice(0, 400)]);
    return { ok: true, rebestaetigung, ...ausgabe(upd) };
  });
}

// Ф3: пометить месяц «есть изменения, требующие повторной проверки» / снять.
// Прежняя отметка «месяц проверен Натальей» сохраняется как исторический факт.
async function wiedervorlageSetzen(body, user) {
  const f = firmaPruef(body.firma); const { j, m } = periodePruef(body.jahr, body.monat);
  const an = body.an !== false; // по умолчанию ставим
  return mit(async cl => {
    const r = await zeile(cl, f, j, m);
    if (r.wiedervorlage === an) return { ok: true, unchanged: true, ...ausgabe(r) };
    const upd = (await cl.query(
      'UPDATE monatsstatus SET wiedervorlage=$4, stand=now() WHERE firma=$1 AND jahr=$2 AND monat=$3 RETURNING *',
      [f, j, m, an])).rows[0];
    await cl.query(
      'INSERT INTO monatsstatus_log (firma,jahr,monat,von,nach,ereignis,autor,notiz) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [f, j, m, r.status, r.status, an ? 'wiedervorlage_an' : 'wiedervorlage_ab', (user && user.login) || 'system', String(body.notiz || '').slice(0, 400)]);
    return { ok: true, ...ausgabe(upd) };
  });
}

module.exports = {
  FIRMEN, STATUS, STATUS_K, STATUS_T, istVerantwortlich,
  uebersicht, eins, statusSetzen, wiedervorlageSetzen, mit,
};
