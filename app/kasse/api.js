/* Маршруты /api/k/* модуля кассы. Каждая операция проверяет роль
   и право на конкретную запись на сервере (dienst.js). */
'use strict';
const fs = require('fs');
const d = require('./dienst.js');
const dateien = require('./dateien.js');
const { Fehler } = require('./db.js');

function antwort(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
function koerper(req) {
  return new Promise((ok, fehler) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 2e5) { req.destroy(); fehler(new Fehler(413, 'Слишком большой запрос')); } s += c; });
    req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch (e) { fehler(new Fehler(400, 'Неверный формат')); } });
  });
}

/* Банк: операции FinMap только читаются. Локальная демо-база берёт
   вымышленные операции из файла BUCH_DEMO_BANK — на сервере его нет. */
async function bankOps(monat) {
  if (process.env.BUCH_DEMO_BANK) {
    const liste = JSON.parse(fs.readFileSync(process.env.BUCH_DEMO_BANK, 'utf8'));
    return { ok: true, quelle: 'Демо-файл (локально)', stand: new Date().toISOString(), liste };
  }
  try {
    const razn = require('../razn.js');
    const ops = await razn.operationen(62);
    return { ok: true, quelle: 'FinMap', stand: new Date().toISOString(),
      liste: ops.filter(o => !monat || String(o.datum).startsWith(monat))
        .map(o => ({ id: String(o.id), datum: o.datum, typ: o.typ, betrag: Math.round(Math.abs(Number(o.betrag)) * 100),
          konto: o.konto, partner: o.partner, kommentar: o.kommentar })) };
  } catch (e) {
    return { ok: false, grund: 'FinMap недоступен: ' + e.message, liste: [] };
  }
}

const POST = {
  'abhebung': (n, b) => d.abhebung(n, b),
  'uebergabe': (n, b, id, ctx) => d.uebergabe(n, b, ctx.benutzer),
  'rueckgabe': (n, b) => d.rueckgabe(n, b),
  'bewegung/:id/bestaetigen': (n, b, id) => d.bestaetigen(n, id, b),
  'bewegung/:id/stornieren': (n, b, id) => d.bewegungStornieren(n, id),
  'bewegung/:id/gf-stornieren': (n, b, id) => d.bewegungGfStornieren(n, id),
  'abhebung-korrektur': (n, b) => d.abhebungKorrektur(n, b),
  'abhebung/:id/bestaetigen': (n, b, id) => d.abhebungBestaetigen(n, id),
  'abhebung/:id/ablehnen': (n, b, id) => d.abhebungAblehnen(n, id),
  'plan': (n, b) => d.planAnlegen(n, b),
  'plan/einfach': (n, b) => d.planEinfach(n, b),
  'plan/:id/einreichen': (n, b, id) => d.planEinreichen(n, id),
  'plan/:id/entscheiden': (n, b, id) => d.planEntscheiden(n, id, b),
  'eingang/:id/bewilligen': (n, b, id) => d.eingangBewilligen(n, id),
  'eingang/:id/ablehnen': (n, b, id) => d.eingangAblehnen(n, id, b),
  'eingang/:id/klaeren': (n, b, id) => d.eingangKlaeren(n, id, b),
  'eingang/:id/loeschen': (n, b, id) => d.eingangLoeschen(n, id),
  'quittung/dringend': (n, b) => d.dringendAusgeben(n, b),
  'quittung/:id/ausgeben': (n, b, id) => d.quittungAusgeben(n, id),
  'quittung/:id/foto': (n, b, id) => d.quittungFoto(n, id, b),
  'quittung/:id/original': (n, b, id) => d.quittungOriginal(n, id),
  'quittung/:id/nu-bestaetigt': (n, b, id) => d.quittungNuBestaetigt(n, id, b),
  'quittung/:id/storno': (n, b, id) => d.quittungStorno(n, id, b),
  'quittung/:id/abbrechen': (n, b, id) => d.quittungAbbrechen(n, id),
  'quittung/:id/unterschrift': (n, b, id) => d.quittungUnterschrift(n, id, b),
  'beleg': (n, b) => d.belegAnlegen(n, b),
  'beleg/:id/pruefen': (n, b, id) => d.belegPruefen(n, id, b),
  'erstattung/:id/weg': (n, b, id) => d.erstattungWeg(n, id, b),
  'erstattung/:id/bar': (n, b, id) => d.erstattungBar(n, id),
  'erstattung/:id/oleg-ok': (n, b, id) => d.erstattungSchritt(n, id, 'oleg'),
  'erstattung/:id/an-gf': (n, b, id) => d.erstattungSchritt(n, id, 'an_gf'),
  'erstattung/:id/ueberwiesen': (n, b, id) => d.erstattungSchritt(n, id, 'ueberwiesen'),
  'rueckfrage': (n, b, id, ctx) => d.rueckfrageAnlegen(n, b, ctx.benutzer),
  'rueckfrage/:id/antwort': (n, b, id) => d.rueckfrageAntwort(n, id, b),
  'rueckfrage/:id/verlust': (n, b, id) => d.rueckfrageVerlust(n, id, b),
  'rueckfrage/:id/schliessen': (n, b, id) => d.rueckfrageSchliessen(n, id, b),
  'rueckfrage/:id/wieder': (n, b, id) => d.rueckfrageWieder(n, id, b),
  'paket': (n, b) => d.paketAnlegen(n, b),
  'paket/:id/oleg': (n, b, id) => d.paketOleg(n, id, b),
  'paket/:id/iban': (n, b, id) => d.paketIban(n, id, b),
  'paket/:id/verrechnen': (n, b, id) => d.verrechnen(n, id, b),
  'paket/:id/geprueft': (n, b, id) => d.paketPruefen(n, id),
  'paket/:id/an-gf': (n, b, id) => d.paketAnGf(n, id),
  'paket/:id/gesehen': (n, b, id) => d.paketGesehen(n, id),
  'paket/:id/bezahlt': (n, b, id) => d.paketBezahlt(n, id),
  'verrechnung/:id/storno': (n, b, id) => d.verrechnungStorno(n, id),
  'bank/link': (n, b) => d.bankLink(n, b, async opId => {
    const r = await bankOps('');
    if (!r.ok) return { ok: false, grund: r.grund };
    return { ok: true, quelle: r.quelle, op: r.liste.find(o => String(o.id) === opId) || null };
  }),
  'bank/link-manuell': (n, b) => d.bankLinkManuell(n, b),
  'uebergabe/beleg-manuell': (n, b) => d.belegManuellFuerUebergabe(n, b),
  'auftragnehmer': (n, b) => d.auftragnehmerhHinzufuegen(n, b),
};

function finde(rest) {
  const teile = rest.split('/');
  for (const [muster, fn] of Object.entries(POST)) {
    const m = muster.split('/');
    if (m.length !== teile.length) continue;
    let id = null, passt = true;
    for (let i = 0; i < m.length; i++) {
      if (m[i] === ':id') { if (!/^\d{1,12}$/.test(teile[i])) { passt = false; break; } id = teile[i]; }
      else if (m[i] !== teile[i]) { passt = false; break; }
    }
    if (passt) return { fn, id };
  }
  return null;
}

/** Webhook: auto-import abhebung from Make.com (no session, API key auth). */
async function webhookAbhebung(req, res) {
  try {
    const whKey = process.env.KASSE_WEBHOOK_KEY;
    if (!whKey || req.headers['x-webhook-key'] !== whKey) {
      antwort(res, 401, { fehler: 'Ungültiger Schlüssel' }); return;
    }
    const b = await koerper(req);
    const sysUser = { login: 'email-auto-import', rolle: 'gf' };
    const result = await d.abhebung(sysUser, b);
    // Telegram-уведомление
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgToken && tgChat) {
      const betrag = (Number(b.betrag || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
      const msg = result.wiederholt
        ? `♻️ Касса: снятие ${betrag} уже записано (${b.datum || ''})`
        : `✅ Касса: снятие ${betrag} ${b.datum || ''} авто-импорт (ID ${result.id})`;
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: msg })
      }).catch(() => {});
    }
    antwort(res, 200, result);
  } catch (e) {
    const { Fehler: F } = require('./db.js');
    if (e instanceof F) antwort(res, e.status, { fehler: e.message });
    else antwort(res, 500, { fehler: e.message });
  }
}

/** true — запрос обработан. n — вошедший пользователь (oder null). */
async function handle(req, res, u, n, ctx) {
  const p = u.pathname;
  if (!p.startsWith('/api/k/')) return false;
  // Webhook: без сессии, только API-ключ
  if (req.method === 'POST' && p === '/api/k/webhook/abhebung') {
    await webhookAbhebung(req, res); return true;
  }
  if (!n) { antwort(res, 401, { fehler: 'нет сессии' }); return true; }
  if (!d.ROLLEN_KASSE.includes(n.rolle)) { antwort(res, 403, { fehler: 'У этой роли нет доступа к кассе' }); return true; }
  const rest = p.slice('/api/k/'.length);
  try {
    if (req.method === 'GET' && rest === 'ich') { antwort(res, 200, { login: n.login, rolle: n.rolle }); return true; }
    if (req.method === 'GET' && rest === 'lage') { // BUCH_JETZT — только локальная демо-база (сравнение с эталоном на фиксированную дату).
      antwort(res, 200, await d.lage(n, ctx.benutzer, process.env.BUCH_JETZT ? Date.parse(process.env.BUCH_JETZT) : undefined)); return true; }
    if (req.method === 'GET' && rest === 'auftragnehmer') { antwort(res, 200, await d.auftragnehmerliste()); return true; }
    if (req.method === 'GET' && rest.startsWith('bank')) {
      if (!['gf', 'buchhaltung'].includes(n.rolle)) throw new Fehler(403, 'Банк видят бухгалтерия и Андрей');
      const monat = /^\d{4}-\d{2}$/.test(u.searchParams.get('monat') || '') ? u.searchParams.get('monat') : '';
      antwort(res, 200, await bankOps(monat)); return true;
    }
    const druck = rest.match(/^(quittung|plan)\/(\d{1,12})\/druck$/);
    if (req.method === 'GET' && druck) {
      const liste = await d.quittungenDruck(n, druck[1] === 'plan' ? { plan: druck[2] } : { id: druck[2] });
      const buf = Buffer.from(require('./druck.js').html(liste));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
      res.end(buf); return true;
    }
    if (req.method === 'GET' && rest.startsWith('verlauf/')) {
      antwort(res, 200, { liste: await d.verlauf(n, decodeURIComponent(rest.slice(8))) }); return true;
    }
    if (req.method === 'GET' && rest.startsWith('datei/')) {
      const info = await d.dateiDarf(n, rest.slice(6));
      if (!info) throw new Fehler(404, 'Документ не найден или недоступен');
      const buf = fs.readFileSync(dateien.pfad(info.sha));
      res.writeHead(200, { 'Content-Type': info.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
      res.end(buf); return true;
    }
    if (req.method === 'POST' && rest === 'beleg-scan') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) throw new Fehler(400, 'Ожидается изображение (JPEG/PNG/WebP)');
      let buf;
      try { buf = await dateien.lesenKoerper(req); } catch (e) { throw new Fehler(413, 'Файл больше 15 МБ'); }
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Fehler(503, 'OCR не настроен (ANTHROPIC_API_KEY отсутствует)');
      const b64 = buf.toString('base64');
      const mediaType = mime === 'image/jpg' ? 'image/jpeg' : mime;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
            { type: 'text', text: 'Это квитанция или чек. Извлеки: итоговая сумма в евро (число), название получателя/продавца, дата (YYYY-MM-DD). Ответь ТОЛЬКО JSON: {"betrag": 12.50, "empfaenger": "Firma GmbH", "datum": "2026-10-05"}. Если данных нет — null для поля.' }
          ]}]
        })
      });
      if (!resp.ok) throw new Fehler(502, 'OCR-сервис недоступен');
      const data = await resp.json();
      let result = {};
      try {
        const text = data.content[0].text.trim();
        const match = text.match(/\{[\s\S]*\}/);
        result = match ? JSON.parse(match[0]) : {};
      } catch (e) { result = {}; }
      antwort(res, 200, { ok: true, betrag: result.betrag || null, empfaenger: result.empfaenger || null, datum: result.datum || null }); return true;
    }
    if (req.method === 'POST' && rest === 'datei') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let buf;
      try { buf = await dateien.lesenKoerper(req); } catch (e) { throw new Fehler(413, 'Файл больше 15 МБ'); }
      let info;
      try { info = dateien.speichern(buf, mime); } catch (e) { throw new Fehler(e.status || 400, e.message); }
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-dateiname'] || '')); } catch (e) { /* без имени */ }
      antwort(res, 200, await d.dateiRegistrieren(n, info, name)); return true;
    }
    if (req.method === 'POST') {
      const f = finde(rest);
      if (!f) throw new Fehler(404, 'Нет такой операции');
      const b = await koerper(req);
      if (!b.idem && req.headers['x-idem']) b.idem = String(req.headers['x-idem']).slice(0, 80);
      antwort(res, 200, await f.fn(n, b, f.id, ctx)); return true;
    }
    throw new Fehler(405, 'Метод не поддерживается');
  } catch (e) {
    if (e instanceof Fehler) antwort(res, e.status, { fehler: e.message });
    else { console.error('касса:', p, e.message); antwort(res, 500, { fehler: 'Сервер не справился с запросом' }); }
    return true;
  }
}

module.exports = { handle };
