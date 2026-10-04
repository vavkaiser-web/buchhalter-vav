/* Автоматический импорт снятий наличных из FinMap в кассу.
   Запускается каждые 30 минут. Добавляет только новые abhebung.
   Разные банки: Raiffeisen, Sparkasse, DKB, Volksbank и т.д. */
'use strict';
const razn = require('../razn.js');
const { tx } = require('./db.js');

const S = 'mailops_prod.';

// Паттерны для распознавания снятий наличных в любом банке.
// Проверяются по partner + kommentar из FinMap.
const MUSTER = [
  /raiffeisen/i, /sparkasse/i, /volksbank/i, /postbank/i,
  /dkb/i, /commerzbank/i, /deutsche.?bank/i, /hypovereinsbank/i, /\bhvb\b/i,
  /\binг\b/i, /comdirect/i, /diba/i, /unicredit/i, /bayerische/i,
  /geldautomat/i, /bargeld/i, /\batm\b/i, /karte\s+\d{4}/i,
  /cash.?withdrawal/i, /cash.?advance/i,
];

function istBarabhebung(op) {
  if (String(op.typ || '').toLowerCase() !== 'expense') return false;
  const text = [op.partner || '', op.kommentar || ''].join(' ');
  return MUSTER.some(m => m.test(text));
}

async function ausfuehren() {
  let ops;
  try { ops = await razn.operationen(90); }
  catch (e) { console.error('[auto-import] FinMap не отвечает:', e.message); return; }

  const bar = ops.filter(istBarabhebung);
  if (!bar.length) return;

  let neu = 0, fehler = 0;
  for (const op of bar) {
    const opId = String(op.id);
    const betrag = Math.round(Math.abs(Number(op.betrag || 0)) * 100);
    if (!betrag || !op.datum) continue;
    const notiz = [op.partner, op.kommentar].filter(Boolean).join(' · ').slice(0, 200);
    const idem = 'finmap-auto-' + opId;
    try {
      await tx(async q => {
        // Идемпотентность: пропускаем если уже есть в bank_link
        const da = await q(`SELECT id FROM ${S}buch_bank_link WHERE finmap_op = $1`, [opId]);
        if (da.length) return;

        const r = await q(
          `INSERT INTO ${S}buch_bewegung
           (art, betrag_cent, status, datum, finmap_op, notiz, von, bestaetigt_am, bestaetigt_von, idem)
           VALUES ('abhebung',$1,'bestaetigt',$2,$3,$4,'auto-import',now(),'auto-import',$5)
           ON CONFLICT (idem) DO NOTHING RETURNING id`,
          [betrag, op.datum, opId, notiz, idem]
        );
        if (!r.length) return;

        await q(
          `INSERT INTO ${S}buch_bank_link
           (finmap_op, ziel_art, ziel_id, status, op_betrag_cent, ziel_betrag_cent, op_datum, op_quelle, notiz, von)
           VALUES ($1,'abhebung',$2,'abgeglichen',$3,$3,$4,'FinMap',$5,'auto-import')
           ON CONFLICT DO NOTHING`,
          [opId, String(r[0].id), betrag, op.datum, notiz]
        );
        neu++;
        console.log('[auto-import] abhebung', betrag / 100 + '€', op.datum, op.partner || '');
      });
    } catch (e) {
      console.error('[auto-import] Fehler bei', opId, e.message);
      fehler++;
    }
  }
  if (neu) console.log(`[auto-import] ${neu} новых снятий импортировано`);
  if (fehler) console.error(`[auto-import] ${fehler} ошибок`);
}

const INTERVALL = 30 * 60 * 1000;

function starten() {
  // Первый запуск через минуту после старта сервера
  setTimeout(() => {
    ausfuehren().catch(e => console.error('[auto-import]', e.message));
    setInterval(() => ausfuehren().catch(e => console.error('[auto-import]', e.message)), INTERVALL);
  }, 60 * 1000);
  console.log('[auto-import] запущен, интервал 30 мин');
}

module.exports = { starten, ausfuehren };
