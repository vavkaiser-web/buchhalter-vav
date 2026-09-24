/* ---------------------------------------------------------------
   Buchhalter VAV · рабочий экран /arbeit по утверждённому макету
   (design/buchhalter-vav/approved-design.html). Разметка и классы —
   как в макете; данные и действия — только с сервера (/api/k/*).
   Адаптивность — по ширине экрана, роль — по входу. Переключателей
   «Компьютер/Телефон» и «Рабочий/Олег/Андрей» в продукте нет.
   ---------------------------------------------------------------- */
(() => {
'use strict';
const root = document.getElementById('vav-design'), screen = root.querySelector('#vav-screen'), message = root.querySelector('#vav-message');
const datei = document.getElementById('vav-datei');

const money = n => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(n / 100);
const icon = n => `<i data-lucide="${n}" aria-hidden="true"></i>`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const button = (text, action, primary = false, extra = '') => `<button type="button" class="v-button cursor-interaction ${primary ? 'primary' : ''}" data-action="${action}" ${extra}>${text}</button>`;
const keys = rows => rows.map(([k, v]) => `<div class="v-keyvalue"><span>${k}</span><span>${v}</span></div>`).join('');
const TZ = 'Europe/Berlin';
const tagMonat = iso => iso ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(iso.slice(0, 10) + 'T12:00:00Z')) : 'дата не указана';
const monatJahr = iso => { const s = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z')).replace(' г.', ''); return s[0].toUpperCase() + s.slice(1); };
const wochentag = iso => { const s = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z')); return s[0].toUpperCase() + s.slice(1); };
const uhr = iso => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(iso));
const berlinTag = iso => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
function plural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many; }
const zahl = n => ['Ноль', 'Один', 'Два', 'Три', 'Четыре', 'Пять'][n] || String(n);
const neuIdem = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------------- состояние ---------------- */
const merk = (() => { try { return JSON.parse(localStorage.getItem('buch-arbeit') || '{}'); } catch (e) { return {}; } })();
const state = { page: merk.page || 'inbox', selected: null, filter: merk.filter || 'all', mobile: 'home', modal: null, arg: null,
  busy: false, D: null, bank: null, kind: 'fuel', upload: {}, idem: {}, entwurf: null, warte: [] };
function merken() { try { localStorage.setItem('buch-arbeit', JSON.stringify({ page: state.page, filter: state.filter })); } catch (e) { /* без памяти */ } }
/* Черновик чека — отдельно для каждого входа: на общем телефоне чужой черновик не виден. */
const entwurfKey = () => 'buch-entwurf:' + (state.D ? state.D.ich.login : '-');
function ladeEntwurf() { try { return JSON.parse(localStorage.getItem(entwurfKey()) || 'null'); } catch (e) { return null; } }
function sichereEntwurf() { try { if (state.entwurf) localStorage.setItem(entwurfKey(), JSON.stringify(state.entwurf)); else localStorage.removeItem(entwurfKey()); } catch (e) { /* без памяти */ } }
try { localStorage.removeItem('buch-entwurf'); } catch (e) { /* старый общий черновик */ }

/* Локальная очередь чеков (IndexedDB): фото (Blob) + данные + ключ повтора.
   Переживает обрыв связи и перезагрузку; отправляется, когда сеть есть.
   Сервер по ключу повтора и по файлу не создаёт второй чек. */
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((ok, no) => {
    const r = indexedDB.open('buchhalter-vav', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('warteschlange', { keyPath: 'idem' }); r.result.createObjectStore('fotos', { keyPath: 'key' }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((ok, no) => {
    const t = db.transaction(store, mode), r = fn(t.objectStore(store));
    t.oncomplete = () => ok(r && r.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error); }); };
  return { put: (st, v) => tx(st, 'readwrite', s => s.put(v)), del: (st, k) => tx(st, 'readwrite', s => s.delete(k)),
    get: (st, k) => tx(st, 'readonly', s => s.get(k)), all: st => tx(st, 'readonly', s => s.getAll()) };
})();
const fotoKey = () => 'entwurf:' + state.D.ich.login;
async function warteLaden() { try { state.warte = (await idb.all('warteschlange')).filter(w => state.D && w.login === state.D.ich.login); } catch (e) { state.warte = []; } }
let abarbeitenLaeuft = false;
async function abarbeiten() {
  if (abarbeitenLaeuft || !state.D) return;
  abarbeitenLaeuft = true;
  let gesendet = 0, fehler = null;
  const sig = () => JSON.stringify(state.warte.map(w => [w.idem, w.fehler || '', !!w.sha]));
  await warteLaden();
  const vorher = sig();
  if (!state.warte.length) { abarbeitenLaeuft = false; return; }     // пустая очередь — экран не трогаем
  // Общий телефон: в другой вкладке мог войти другой человек (cookie общий).
  // Перед отправкой — кто вошёл сейчас; чужие записи не отправляются.
  let jetzt;
  try { jetzt = await holen('/api/k/ich'); } catch (e) { abarbeitenLaeuft = false; return; }
  if (jetzt.login !== state.D.ich.login) {
    abarbeitenLaeuft = false;
    toast('На телефоне вошёл другой пользователь. Чеки из очереди не отправлены — обновите страницу.', true);
    return;
  }
  try {
    for (const w of state.warte) {
      if (w.fehler || w.login !== jetzt.login) continue;
      try {
        if (!w.sha) { const r = await hochladen(new File([w.blob], w.name || 'beleg.jpg', { type: w.mime })); w.sha = r.sha; await idb.put('warteschlange', w); }
        const r = await senden('beleg', { ...w.body, datei_sha: w.sha, fuer_login: w.login }, w.idem);
        await idb.del('warteschlange', w.idem); gesendet++; state.gesendet = r.nr;
      } catch (e) {
        if (e.netz) break;                                // нет связи — ждём следующей попытки
        if (/другого сотрудника/.test(e.message)) break;  // сменился вход — запись ждёт своего автора
        w.fehler = e.message; await idb.put('warteschlange', w); fehler = e.message;   // сервер отклонил — показать человеку
      }
    }
  } finally { abarbeitenLaeuft = false; }
  await warteLaden();
  if (gesendet) { try { await laden(); } catch (e) { /* покажем позже */ } render(); toast(`Отправлено из очереди: ${gesendet} ${plural(gesendet, 'чек', 'чека', 'чеков')}. Возмещение ещё не выполнено.`); }
  else if (fehler) { render(); toast('Чек не принят сервером: ' + fehler, true); }
  else if (sig() !== vorher) render();                                 // изменилась только очередь
}
addEventListener('online', () => abarbeiten());
setInterval(() => { if (navigator.onLine) abarbeiten(); }, 30000);

/* ---------------- сервер ---------------- */
async function holen(pfad) {
  const r = await fetch(pfad, { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) { location.href = '/login?next=/arbeit'; throw new Error('нет сессии'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.fehler || 'Сервер ответил ' + r.status);
  return j;
}
async function senden(pfad, body, idem) {
  let r;
  try {
    r = await fetch('/api/k/' + pfad, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(idem ? { 'X-Idem': idem } : {}) }, body: JSON.stringify(body || {}) });
  } catch (e) { throw Object.assign(new Error('Нет связи с сервером. Действие не выполнено — повторите, когда появится связь; дубля не будет.'), { netz: true }); }
  if (r.status === 401) { location.href = '/login?next=/arbeit'; throw new Error('нет сессии'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.fehler || 'Сервер ответил ' + r.status);
  return j;
}
async function hochladen(file) {
  let r;
  try {
    r = await fetch('/api/k/datei', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Dateiname': encodeURIComponent(file.name || '') }, body: file });
  } catch (e) { throw Object.assign(new Error('Нет связи: файл не отправлен.'), { netz: true }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.fehler || 'Файл не принят');
  return j;
}
async function laden() {
  let d;
  try { d = await holen('/api/k/lage'); }
  catch (e) { if (e instanceof TypeError) e.netz = true; throw e; }
  const erster = !state.D;
  state.D = d;
  try { localStorage.setItem('buch-ich', JSON.stringify({ login: d.ich.login, kurz: d.ich.kurz, rolle: d.ich.rolle })); } catch (e) { /* без памяти */ }
  if (erster) { state.entwurf = ladeEntwurf(); await warteLaden(); }
  if (['gf', 'buchhaltung'].includes(state.D.ich.rolle) && state.page === 'bank' && !state.bank) ladeBank();
}
async function ladeBank() {
  try { state.bank = await holen('/api/k/bank?monat=' + state.D.heute.slice(0, 7)); } catch (e) { state.bank = { ok: false, grund: e.message, liste: [] }; }
  render();
}

function toast(s, fehler) { message.innerHTML = `<div class="v-toast"${fehler ? ' style="background:var(--v-redbg);color:var(--v-red)"' : ''}>${esc(s)}</div>`; }

/** Действие: блокирует кнопки (двойное нажатие), ждёт сервер, обновляет картину. */
async function tun(fn, erfolg) {
  if (state.busy) return;
  state.busy = true; root.querySelectorAll('button').forEach(b => { b.dataset.warteVorher = b.disabled ? '1' : ''; b.disabled = true; });
  try {
    const r = await fn();
    await laden();
    state.frisch = true;
    render();
    toast(typeof erfolg === 'function' ? erfolg(r) : (r && r.wiederholt ? 'Уже было выполнено — повтор не создан.' : erfolg));
    return r;
  } catch (e) {
    render(); toast(e.message, true);
  } finally {
    // Включаем обратно только кнопки, которые выключили сами (у них есть отметка
    // и они были активны). Новые кнопки после перерисовки сохраняют свой disabled.
    state.busy = false;
    root.querySelectorAll('button').forEach(b => { if (b.dataset.warteVorher === '') b.disabled = false; delete b.dataset.warteVorher; });
  }
}

/* ---------------- данные для экранов ---------------- */
const D = () => state.D;
const rolle = () => D().ich.rolle;
const istBuch = () => rolle() === 'buchhaltung', istGf = () => rolle() === 'gf', istDisp = () => rolle() === 'disponent', istMa = () => rolle() === 'mitarbeiter';
const demoTxt = s => D().demo ? s + ' · пример' : s;
const vorname = login => (D().namen[login] || {}).vorname || login;
const halter = () => D().konten.filter(k => k.art === 'halter');
const kasse = () => D().konten.find(k => k.id === 'hauptkasse');
const beiKlein = k => { const t = k.bei_text || ('У ' + k.name); return t[0].toLowerCase() + t.slice(1); };
const genitiv = k => (k.bei_text || '').replace(/^У\s+/, '') || k.name;
const offeneRF = () => D().rueckfragen.filter(r => r.status !== 'geschlossen');
const rfFuerBeleg = b => D().rueckfragen.find(r => r.bezug_art === 'beleg' && String(r.bezug_id) === String(b.id) && r.status !== 'geschlossen');

function records() {
  const d = D(), heute = d.heute, out = [];
  for (const b of d.belege) {
    const heuteGeprueft = b.geprueft_am && berlinTag(b.geprueft_am) === heute;
    if (b.status !== 'eingereicht' && !heuteGeprueft) continue;
    const rf = rfFuerBeleg(b);
    out.push({ id: 'b' + b.id, kind: 'beleg', type: b.art === 'kraftstoff' ? 'fuel' : 'material', title: b.titel, person: b.person, sum: b.betrag,
      date: b.datum, status: rf ? 'Запрошен документ' : b.status === 'geprueft' ? 'Проверено' : b.status === 'abgelehnt' ? 'Отклонён' : 'На проверке',
      cls: b.status === 'geprueft' ? 'good' : b.status === 'abgelehnt' ? 'bad' : 'warn', offen: b.status === 'eingereicht' && !rf, wartet: !!rf, b, sort: 0 });
  }
  for (const p of d.pakete) {
    if (!['entwurf', 'an_gf', 'gf_gesehen'].includes(p.status)) continue;
    out.push({ id: 'p' + p.id, kind: 'paket', type: 'invoice', title: 'Счёт подрядчика', person: p.lieferant, sum: p.brutto, date: p.datum || berlinTag(p.angelegt),
      status: p.status === 'entwurf' ? 'Готовится' : 'Готов к оплате', cls: p.status === 'entwurf' ? 'warn' : 'good', offen: p.status === 'entwurf', p, sort: 1 });
  }
  for (const r of offeneRF()) {
    if (r.bezug_art === 'beleg') continue;
    out.push({ id: 'r' + r.id, kind: 'rueckfrage', type: r.beleg_art === 'material' ? 'material' : r.beleg_art === 'kraftstoff' ? 'fuel' : 'doc', title: r.titel,
      person: r.person, sum: r.betrag || 0, date: r.datum || berlinTag(r.angelegt), status: rfStatus(r), cls: r.verlust ? 'bad' : 'warn', wartet: true, r, sort: 2 });
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.sort - b.sort || Number(a.id.slice(1)) - Number(b.id.slice(1)));
}
function rfStatus(r) {
  if (r.verlust) return 'Чек потерян';
  if (r.status === 'beantwortet') return 'Ответ получен';
  return { mitarbeiter: 'Ждём сотрудника', oleg: 'У Олега', gf: 'У Андрея' }[r.stufe] || 'Ждём ответа';
}
const fileIcon = t => icon(t === 'invoice' ? 'file-text' : t === 'fuel' ? 'fuel' : t === 'doc' ? 'file-question' : 'package');

function item(r) {
  return `<button type="button" class="v-row cursor-interaction ${state.selected === r.id || r.aktuell ? 'selected' : ''}" data-record="${r.id}"><span class="v-file">${fileIcon(r.type)}</span><span class="v-rowmain"><span class="v-rowline"><span class="v-rowtitle">${esc(r.title)}</span><span class="v-num">${money(r.sum)}</span></span><span class="v-small" style="display:block">${esc(r.person)} · ${tagMonat(r.date)}</span><span class="v-tag ${r.cls}">${esc(r.status)}</span></span></button>`;
}

/* ---------------- карточки ---------------- */
function detail(r) {
  if (!r) return `<div class="v-panel"><div class="v-panelhead"><span class="v-label">Проверка расхода</span></div><div class="v-detail"><p class="v-small">Выберите документ в очереди.</p></div></div>`;
  if (r.kind === 'paket') return paketDetail(r.p);
  if (r.kind === 'rueckfrage') return rfDetail(r.r);
  const b = r.b, done = b.status !== 'eingereicht', rf = rfFuerBeleg(b);
  const doc = b.datei ? `<button class="v-receipt cursor-interaction" data-action="document:${b.id}">${icon('file-text')}<span><strong>${esc(b.dokument || 'Фото чека')}</strong><span class="v-small">${demoTxt('Открыть документ')}</span></span>${icon('arrow-up-right')}</button>`
    : '<div class="v-note">Документ не загружен.</div>';
  const eigen = b.eigen && istBuch();
  let aktionen;
  if (b.status === 'geprueft' && b.erstattung && b.erstattung.status === 'offen' && b.erstattung.weg === 'offen' && istBuch()) {
    aktionen = button('Наличными через Олега', `erstattungweg:${b.erstattung.id}:bar`, true) + button('Переводом', `erstattungweg:${b.erstattung.id}:ueberweisung`);
  } else {
    aktionen = button(b.status === 'geprueft' ? 'Проверено' : b.status === 'abgelehnt' ? 'Отклонён' : 'Принять чек', `approve:${b.id}`, true,
      done || eigen ? `disabled${eigen ? ' title="Собственный расход проверяет Андрей"' : ''}` : '') + button(rf ? 'Открыть запрос' : 'Запросить', rf ? `rfopen:${rf.id}` : `request:${b.id}`);
  }
  return `<div class="v-panel"><div class="v-panelhead"><span class="v-label">Проверка расхода</span><span class="v-tag">${esc(b.nr)}</span></div><div class="v-detail"><span class="v-label">${esc(b.titel)}</span><div class="v-amount v-num">${money(b.betrag)}</div><div class="v-small">${tagMonat(b.datum)} · ${esc(b.person)}</div>${keys([['Источник денег', esc(b.zahlart_text)], ['Объект', esc(b.objekt || (b.art === 'kraftstoff' ? 'Не указан' : 'Не указан'))], ...(b.art === 'kraftstoff' ? [['Автомобиль', esc(b.fahrzeug || 'Не указан')]] : [])])}${doc}<hr><div class="v-check">${icon(b.status === 'geprueft' ? 'check-circle-2' : 'circle')}Документ читается, сумма совпадает</div><div class="v-check">${b.dublette ? icon('alert-triangle') + 'Возможный повтор: ' + esc(b.dublette) : icon('check-circle-2') + 'Повторного чека не найдено'}</div>${b.geld_ohne_beleg ? '<div class="v-note">Чек отклонён, деньги со счёта потрачены. Нужен ответ ответственного.</div>' : ''}${b.zahlart === 'privat' ? `<div class="v-note">${erstattungNotiz(b)}</div>` : ''}<div class="v-actions">${aktionen}</div></div></div>`;
}
function erstattungNotiz(b) {
  const e = b.erstattung;
  if (!e) return 'После проверки: возместить сотруднику. Наличными — через Олега; переводом — через Андрея.';
  if (e.status === 'ausgezahlt') return 'Возмещено наличными по квитанции.';
  if (e.status === 'ueberwiesen_gemeldet') return 'Андрей отметил перевод. Банком ещё не подтверждено.';
  if (e.weg === 'bar') return 'Возместить наличными: выдаёт Олег по квитанции.';
  if (e.weg === 'ueberweisung') return e.status === 'offen' ? 'Перевод: ждёт согласования Олега.' : e.status === 'oleg_ok' ? 'Перевод: Олег согласовал, передать Андрею.' : 'Перевод: у Андрея.';
  return 'Чек проверен. Выберите способ возмещения. Возмещение ещё не выплачено.';
}
function rfDetail(r) {
  return `<div class="v-panel"><div class="v-panelhead"><span class="v-label">Проверка расхода</span><span class="v-tag">${esc(r.nr)}</span></div><div class="v-detail"><span class="v-label">${esc(r.titel)}</span><div class="v-amount v-num">${money(r.betrag || 0)}</div><div class="v-small">${tagMonat(r.datum || berlinTag(r.angelegt))} · ${esc(r.person)}</div>${keys([['Источник денег', esc(r.zahlart_text || 'Не указан')], ['Объект', esc(r.objekt || 'Не указан')]])}<div class="v-note">${r.bezug_art === 'bank' ? 'Операция по карте есть. Подтверждающий документ пока не получен.' : esc(r.text)}</div><hr><div class="v-check">${icon('circle')}Документ отсутствует</div><div class="v-actions">${button('Открыть запрос', `rfopen:${r.id}`)}</div></div></div>`;
}
function quittungenZeile(p) {
  const v = p.verrechnungen;
  if (!v.length) return `<button class="v-receipt cursor-interaction" data-action="receipts:${p.id}">${icon('files')}<span><strong>Квитанций нет</strong><span class="v-small">Выдач рабочим по счёту не зачтено</span></span>${icon('chevron-right')}</button>`;
  const alle = v.every(x => x.foto && x.nu_bestaetigt);
  return `<button class="v-receipt cursor-interaction" data-action="receipts:${p.id}">${icon('files')}<span><strong>${zahl(v.length === 2 ? 2 : v.length) === 'Два' ? 'Две' : zahl(v.length)} ${plural(v.length, 'квитанция', 'квитанции', 'квитанций')} на ${money(p.verrechnet)}</strong><span class="v-small">${alle ? 'Подписаны · подтверждены подрядчиком' : 'Нужны подписи или подтверждение подрядчика'}</span></span>${icon('chevron-right')}</button>`;
}
function paketDetail(p) {
  const oleg = p.oleg_status === 'bestaetigt' ? icon('check-circle-2') + 'Работы подтверждены Олегом' : p.oleg_status === 'abweichung' ? icon('alert-triangle') + 'Олег указал расхождение' : icon('circle') + 'Работы ещё не подтверждены Олегом';
  return `<div class="v-panel"><div class="v-panelhead"><span class="v-label">Комплект к оплате</span><span class="v-tag">${esc(p.rechnung_nr)}</span></div><div class="v-detail"><span class="v-label">Счёт подрядчика</span><div class="v-amount v-num">${money(p.brutto)}</div><div class="v-small">${tagMonat(p.datum || berlinTag(p.angelegt))} · ${esc(p.lieferant)}</div>${keys([['Источник денег', 'Банковский перевод'], ['Объект', esc(p.objekt || 'Не указан')]])}${p.datei ? `<button class="v-receipt cursor-interaction" data-action="pdf:${p.datei}">${icon('file-text')}<span><strong>Счёт № ${esc(p.rechnung_nr)}</strong><span class="v-small">${demoTxt('Открыть документ')}</span></span>${icon('arrow-up-right')}</button>` : '<div class="v-note">Документ счёта не загружен.</div>'}<hr>${keys([['Полная сумма', money(p.brutto)], ['Выдано рабочим', `− ${money(p.verrechnet)}`], ['Остаток к оплате', `<strong>${money(p.zu_zahlen)}</strong>`]])}${quittungenZeile(p)}<div class="v-check">${oleg}</div><div class="v-check">${icon(p.geprueft_am ? 'check-circle-2' : 'circle')}${p.geprueft_am ? 'Бухгалтер проверил документы' : 'Бухгалтер ещё не проверил документы'}</div><div class="v-actions">${button('Открыть платёжный комплект', `payment:${p.id}`, true)}</div></div></div>`;
}

/* ---------------- разделы компьютера ---------------- */
function inbox() {
  const recs = records();
  if (!state.selected || !recs.some(r => r.id === state.selected)) state.selected = recs[0] && recs[0].id;
  const filtered = recs.filter(r => state.filter === 'all' || (state.filter === 'check' && r.offen) || (state.filter === 'waiting' && r.wartet));
  const hk = kasse(), hs = halter();
  const bar = (hk ? hk.saldo : 0) + hs.reduce((s, k) => s + k.saldo, 0);
  const priv = D().belege.filter(b => b.zahlart === 'privat' && (b.status === 'eingereicht' || (b.status === 'geprueft' && b.erstattung && !['ausgezahlt', 'ueberwiesen_gemeldet'].includes(b.erstattung.status))));
  const privSum = priv.reduce((s, b) => s + b.betrag, 0);
  const rf = offeneRF(), rfSum = rf.reduce((s, r) => s + (r.betrag || 0), 0);
  const empty = state.filter === 'check' ? 'Все чеки в этой очереди проверены' : state.filter === 'waiting' ? 'Ответов никто не ждёт' : 'Очередь пуста';
  return `<div class="v-head"><div><div class="v-label">${wochentag(D().heute)} · ${tagMonat(D().heute)}</div><h1>Рабочий стол</h1><p>Проверить документы. Закрыть вопросы. Подготовить оплату.</p></div>${istBuch() ? button(icon('plus') + ' Документ', 'newdoc', true) : ''}</div><div class="v-metrics"><button class="v-metric cursor-interaction" data-nav="cash"><span>Наличные фирмы</span><strong class="v-num">${money(bar)}</strong><span>${hs.length === 1 ? 'Касса + остаток ' + esc(beiKlein(hs[0])) : 'Касса + деньги у ответственных'} ↗</span></button><button class="v-metric cursor-interaction" data-action="personal"><span>Вернуть сотруднику</span><strong class="v-num">${money(privSum)}</strong><span>${!priv.length ? 'Возмещать нечего' : priv.some(b => b.status === 'eingereicht') ? 'После проверки чека' : 'Чек проверен'} ↗</span></button><button class="v-metric cursor-interaction" data-nav="requests"><span>Не хватает документа</span><strong class="v-num">${money(rfSum)}</strong><span>${rf.length ? (rf.length === 1 ? 'Один открытый запрос' : `${rf.length} ${plural(rf.length, 'открытый запрос', 'открытых запроса', 'открытых запросов')}`) : 'Открытых запросов нет'} ↗</span></button></div><div class="v-work"><div class="v-panel"><div class="v-panelhead"><h2>Очередь документов</h2><span class="v-small">${recs.length} ${plural(recs.length, 'документ', 'документа', 'документов')}</span></div><div class="v-tabs" aria-label="Фильтр документов">${[['all', 'Все'], ['check', 'Проверить'], ['waiting', 'Ждём ответа']].map(([id, n]) => `<button class="cursor-interaction ${state.filter === id ? 'active' : ''}" data-filter="${id}">${n}</button>`).join('')}</div>${filtered.length ? filtered.map(item).join('') : `<div class="v-stateempty">${empty}</div>`}</div>${detail(recs.find(r => r.id === state.selected) || recs[0])}</div>`;
}

function abhebungen() {
  const bw = D().bewegungen;
  return bw.filter(m => m.art === 'abhebung').map(a => ({ a, teile: bw.filter(m => m.quelle_id === a.id && ['gemeldet', 'bestaetigt', 'abgelehnt'].includes(m.status)).sort((x, y) => x.id - y.id) }))
    .sort((x, y) => (y.a.datum || '').localeCompare(x.a.datum || '') || y.a.id - x.a.id);
}
function cash() {
  const hk = kasse() || { saldo: 0 }, hs = halter(), h = hs[0];
  const liste = abhebungen();
  const fertig = liste.find(x => x.teile.length && x.teile.every(t => t.status !== 'gemeldet'));
  const bankOk = a => D().bank_links.some(l => l.ziel_art === 'abhebung' && l.ziel_id === String(a.id) && l.status === 'abgeglichen');
  let panel = '<div class="v-panel"><div class="v-panelhead"><h2>Снятий пока нет</h2></div><div class="v-detail"><p class="v-small">Снятие наличных отмечает Андрей. Банковская операция связывается отдельно.</p></div></div>';
  if (fertig) {
    const a = fertig.a, zeilen = [['landmark', `${esc(vorname(a.von))} снял наличные`, bankOk(a) ? 'Банковская операция связана' : 'Банковская операция ещё не связана', money(a.betrag), 'bank']];
    for (const t of fertig.teile) {
      const ziel = D().konten.find(k => k.id === t.an_konto) || { art: '', name: t.an_name };
      const st = t.status === 'bestaetigt' ? (ziel.art === 'hauptkasse' ? 'Бухгалтер подтвердил' : 'Получение подтверждено') : 'Получение отклонено';
      zeilen.push(ziel.art === 'hauptkasse' ? ['wallet', 'Принято в основную кассу', st, money(t.betrag), 'officecash'] : ['user-round', `Передано ${esc(dativVon(ziel))}`, st, money(t.betrag), 'olegledger:' + ziel.id]);
    }
    for (const k of hs.filter(k => fertig.teile.some(t => t.an_konto === k.id))) {
      zeilen.push(['receipt', `Расходы из денег ${esc(genitiv(k))}`, belegeGeprueft(k) ? 'Проверенные документы' : 'Есть документы на проверке', `− ${money(k.ausgaben)}`, 'cashdocs:' + k.id]);
      zeilen.push(['coins', `Расчётный остаток ${esc(beiKlein(k))}`, 'Получил − потратил − вернул', money(k.saldo), 'olegledger:' + k.id]);
    }
    panel = `<div class="v-panel"><div class="v-panelhead"><h2>Снятие ${money(a.betrag)}</h2><span class="v-small">${demoTxt(tagMonat(a.datum))}</span></div><div class="v-ledger">${zeilen.map(([i, t, s, b, act]) => `<button class="v-row cursor-interaction" data-action="${act}">${icon(i)}<span class="v-rowmain"><span class="v-rowtitle">${t}</span><span class="v-small" style="display:block">${s}</span></span><span class="v-num">${b}</span></button>`).join('')}</div></div>`;
  }
  return `<div class="v-head"><div><div class="v-label">Наличные · VAV Kaiser GmbH</div><h1>Касса и деньги у людей</h1><p>Расчётные остатки по подтверждённым движениям.</p></div>${istGf() || istBuch() ? button(icon('plus') + ' Передача денег', 'transfer', true) : ''}</div><div class="v-metrics"><button class="v-metric cursor-interaction" data-action="officecash"><span>Основная касса</span><strong>${money(hk.saldo)}</strong><span>Ответственный: бухгалтер ↗</span></button><button class="v-metric cursor-interaction" data-action="olegledger:${h ? h.id : ''}"><span>${esc(h ? h.bei_text : 'У ответственного')}</span><strong>${money(h ? h.saldo : 0)}</strong><span>Получено ${money(h ? h.erhalten : 0)} ↗</span></button><button class="v-metric cursor-interaction" data-action="cashcheck"><span>Физический пересчёт</span><strong style="font-size:19px">Не подтверждён</strong><span>Порядок пока обсуждается ↗</span></button></div>${panel}${cashZusatz(liste, fertig)}`;
}
function dativVon(k) { const n = Object.entries(D().namen).find(([l]) => 'halter:' + l === k.id); return n ? n[1].dativ : k.name; }
function belegeGeprueft(k) {
  const bw = D().bewegungen.filter(m => m.von_konto === k.id && ['ausgabe', 'verbrauch'].includes(m.art) && m.status !== 'storniert');
  return bw.every(m => m.art === 'ausgabe' ? (D().quittungen.find(q => q.id === m.quittung_id) || {}).foto : (D().belege.find(b => b.id === m.beleg_id) || {}).status === 'geprueft');
}
/* Дополнения к макету (нужны для реального процесса, в том же оформлении). */
function cashZusatz(liste, fertig) {
  const teile = [];
  const offen = D().bewegungen.filter(m => m.status === 'gemeldet');
  if (offen.length) teile.push(panelListe('Ждут подтверждения получения', offen.map(m => [m.art === 'rueckgabe' ? 'undo-2' : 'arrow-right-left',
    `${m.art === 'rueckgabe' ? 'Возврат' : 'Передача'} ${m.von_name ? 'от ' + esc(m.von_name) : 'из снятия'} → ${esc(m.an_name || '')}`,
    `${tagMonat(m.datum)} · ${m.bestaetigen_darf ? 'подтвердите получение' : 'ждёт получателя'}`, money(m.betrag), m.bestaetigen_darf ? 'receive:' + m.id : 'bewegung:' + m.id])));
  const plaene = D().plaene.filter(p => p.status !== 'abgelehnt').slice(0, 8);
  teile.push(panelListe('Заявки на наличные', plaene.map(p => ['list-checks', `${esc(p.nr)} · ${esc(p.titel)}`,
    { entwurf: 'Черновик · подать Андрею', eingereicht: 'Ждёт утверждения Андрея', genehmigt: 'Утверждена · выдача по квитанциям' }[p.status] || p.status, money(p.summe), 'plan:' + p.id]),
    istBuch() || istGf() ? button(icon('plus') + ' Заявка', 'newplan') : '', 'Заявок пока нет'));
  const qs = D().quittungen.filter(q => q.status !== 'storniert').slice(0, 12);
  teile.push(panelListe('Квитанции', qs.map(q => ['hand-coins', `${esc(q.nr)} · ${esc(q.empfaenger)}`, quittungStand(q), money(q.betrag), 'quittung:' + q.id]), '', 'Квитанций пока нет'));
  return teile.join('');
}
function quittungStand(q) {
  if (q.status === 'vorbereitet') return q.plan_status === 'genehmigt' ? 'Подготовлена · деньги ещё не выданы' : 'Подготовлена · список не утверждён';
  return ['Выдана', q.foto ? 'подпись на фото' : 'нет фото подписи', q.original_am ? 'оригинал в офисе' : 'оригинал не сдан'].join(' · ');
}
function panelListe(titel, zeilen, knopf, leer) {
  return `<div class="v-panel" style="margin-top:16px"><div class="v-panelhead"><h2>${titel}</h2>${knopf || ''}</div>${zeilen.length ? `<div class="v-ledger">${zeilen.map(([i, t, s, b, act]) => `<button class="v-row cursor-interaction" data-action="${act}">${icon(i)}<span class="v-rowmain"><span class="v-rowtitle">${t}</span><span class="v-small" style="display:block">${s}</span></span><span class="v-num">${b}</span></button>`).join('')}</div>` : `<div class="v-detail"><p class="v-small">${leer || 'Пусто'}</p></div>`}</div>`;
}

function requests() {
  const rf = offeneRF();
  const sel = rf.find(r => 'r' + r.id === state.selected) || rf[0];
  if (sel) state.selected = 'r' + sel.id;
  const zeilen = rf.map(r => item({ id: 'r' + r.id, type: r.beleg_art === 'material' ? 'material' : r.beleg_art === 'kraftstoff' ? 'fuel' : 'doc', title: r.titel, person: r.person,
    sum: r.betrag || 0, date: r.datum || berlinTag(r.angelegt), status: rfStatus(r), cls: r.verlust ? 'bad' : 'warn' })).join('');
  return `<div class="v-head"><div><div class="v-label">Контроль ответов</div><h1>Запросы</h1><p>Рабочий → Олег → Андрей. Ответ проверяет бухгалтер.</p></div></div><div class="v-panel"><div class="v-panelhead"><h2>Ожидаем документ</h2><span class="v-tag ${rf.length ? 'warn' : 'good'}">${rf.length ? `${rf.length} ${plural(rf.length, 'вопрос', 'вопроса', 'вопросов')}` : 'Вопросов нет'}</span></div>${zeilen || '<div class="v-stateempty">Все вопросы закрыты</div>'}<div class="v-detail"><div class="v-three"><div><div class="v-label">01 · Сотрудник</div><h3>Два рабочих дня</h3><p class="v-small">Загрузить чек или объяснить</p></div><div><div class="v-label">02 · Олег</div><h3>Один рабочий день</h3><p class="v-small">Помочь получить документ</p></div><div><div class="v-label">03 · Андрей</div><h3>Решение владельца</h3><p class="v-small">Если вопрос не закрыт</p></div></div><div class="v-note">Потерянный чек — сразу бухгалтеру и Андрею.</div>${sel ? button('Открыть запрос', 'rfopen:' + sel.id, true) : ''}</div></div>`;
}

function invoices() {
  const pk = D().pakete.filter(p => ['entwurf', 'an_gf', 'gf_gesehen', 'bezahlt_gemeldet'].includes(p.status));
  const sel = pk.find(p => 'p' + p.id === state.selected) || pk[0];
  if (sel) state.selected = 'p' + sel.id;
  const n = pk.length;
  const titel = n === 0 ? 'Подготовленных счетов нет' : n === 1 ? 'Один подготовленный счёт' : `${n} ${plural(n, 'подготовленный счёт', 'подготовленных счёта', 'подготовленных счетов')}`;
  const zeilen = pk.map(p => item({ id: 'p' + p.id, type: 'invoice', title: 'Счёт подрядчика', person: p.lieferant, sum: p.brutto, date: p.datum || berlinTag(p.angelegt),
    status: p.status === 'entwurf' ? 'Готовится' : p.status === 'bezahlt_gemeldet' ? 'Перевод отмечен' : 'Готов к оплате', cls: p.status === 'entwurf' ? 'warn' : 'good' })).join('');
  return `<div class="v-head"><div><div class="v-label">Каждый счёт — отдельный комплект</div><h1>К оплате</h1><p>Счёт, квитанции, подтверждение Олега и остаток.</p></div></div><div class="v-work"><div class="v-panel"><div class="v-panelhead"><h2>${titel}</h2></div>${zeilen}<div class="v-detail"><p class="v-small">Перевод выполняет Андрей в банке. Подготовленный комплект ещё не означает оплату.</p></div></div>${sel ? paketDetail(sel) : detail(null)}</div>`;
}

function bank() {
  const b = state.bank;
  const monat = monatJahr(D().heute.slice(0, 7) + '-15');
  let tag = '<span class="v-tag">Загрузка…</span>', zeilen = '';
  if (b && !b.ok) { tag = '<span class="v-tag warn">Банк недоступен</span>'; zeilen = `<div class="v-detail"><div class="v-note">${esc(b.grund)}. Операции не показаны и не подставлены.</div></div>`; }
  if (b && b.ok) {
    tag = D().demo ? '<span class="v-tag warn">Учебные данные</span>' : `<span class="v-tag good">${esc(b.quelle)} · ${uhr(b.stand)}</span>`;
    zeilen = b.liste.length ? b.liste.map(op => {
      const l = D().bank_links.filter(x => x.op === String(op.id));
      const ziel = l[0];
      const nav = ziel ? ({ abhebung: 'cash', paket: 'invoices', rueckfrage: 'requests', beleg: 'inbox', erstattung: 'inbox' }[ziel.ziel_art]) : null;
      const sub = `${tagMonat(op.datum)} · ${ziel ? (ziel.status === 'abgeglichen' ? bankZielText(ziel) : 'связано с расхождением суммы') : 'не связано с документом'}`;
      return `<button class="v-row cursor-interaction" ${nav ? `data-nav="${nav}"` : `data-action="bankop:${esc(op.id)}"`}>${icon('arrow-up-right')}<span class="v-rowmain"><strong>${esc(op.partner || op.kommentar || 'Операция')}</strong><span class="v-small" style="display:block">${esc(sub)}</span></span><span class="v-num">${money(op.betrag)}</span></button>`;
    }).join('') : '<div class="v-detail"><p class="v-small">Операций за месяц нет.</p></div>';
  }
  return `<div class="v-head"><div><div class="v-label">FinMap · только чтение</div><h1>Банк и документы</h1><p>Документ и движение денег проверяются отдельно.</p></div></div><div class="v-panel"><div class="v-panelhead"><h2>Операции за ${monat.split(' ')[0].toLowerCase().replace(/ь$/, 'ь')}</h2>${tag}</div>${zeilen}</div>`;
}
function bankZielText(l) {
  return { abhebung: 'раскрыть движение денег', paket: 'перевод по комплекту подтверждён банком', rueckfrage: 'не хватает чека', beleg: 'чек связан', erstattung: 'возмещение переводом' }[l.ziel_art] || 'связано';
}

function archive() {
  const d = D(), monat = d.heute.slice(0, 7);
  const inMonat = iso => iso && iso.slice(0, 7) === monat;
  const rf = offeneRF();
  const rows = [['file-text', 'Счета подрядчиков', 'Счёт, квитанции, согласование', 'nav:invoices', d.pakete.filter(p => inMonat(p.datum || berlinTag(p.angelegt))).length],
    ['receipt', 'Чеки и расходы', 'Фото, источник денег, объект', 'nav:inbox', d.belege.filter(b => inMonat(b.datum)).length],
    ['hand-coins', 'Квитанции выдач', 'Подпись получателя и оригинал', 'nav:cash', d.quittungen.length],
    ['landmark', 'Банк и сверка', 'Операция, основание, расхождение', 'nav:bank', null],
    ['list-checks', 'Незакрытые вопросы', rf.length ? `${rf.length === 1 ? 'Один' : rf.length} ${plural(rf.length, 'открытый вопрос', 'открытых вопроса', 'открытых вопросов')}` : 'Открытых вопросов нет', 'nav:requests', null]];
  if (rf.length === 1 && rf[0].bezug_art === 'bank') rows[4][2] = 'Один недостающий чек';
  return `<div class="v-head"><div><div class="v-label">Документы и оригиналы</div><h1>${monatJahr(monat + '-15')}</h1><p>VAV Kaiser GmbH · ${D().demo ? 'пример месячного комплекта' : 'месячный комплект'}</p></div></div><div class="v-panel">${rows.map(([i, t, s, a]) => `<button class="v-row cursor-interaction" data-action="${a}">${icon(i)}<span class="v-rowmain"><strong>${t}</strong><span class="v-small" style="display:block">${s}</span></span>${icon('chevron-right')}</button>`).join('')}</div>`;
}

function desktop() {
  const nav = [['inbox', 'layout-dashboard', 'Рабочий стол'], ['cash', 'wallet', 'Касса и авансы'], ['requests', 'message-square', 'Запросы'], ['invoices', 'credit-card', 'К оплате'], ['bank', 'landmark', 'Банк'], ['archive', 'folder-closed', 'Архив']];
  const n = offeneRF().length;
  const rollenText = istGf() ? 'Руководитель' : 'Бухгалтерия';
  const fuss = D().demo ? ['Все суммы, люди и документы — примеры', 'Локальная демо-база · не рабочий учёт'] : [`Данные: база Бухгалтера · ${uhr(D().jetzt)}`, 'Уведомления не отправляются'];
  return `<div class="v-app"><div class="v-top"><div class="v-logo"><span class="v-mark">V</span>BUCHHALTER VAV</div><span class="v-tag">VAV Kaiser GmbH</span><div class="v-topright"><span class="v-small">${rollenText}</span><a class="v-small" href="/api/logout?next=/arbeit">Выйти</a><span class="v-avatar">${esc(D().ich.kurz)}</span></div></div><div class="v-layout"><nav class="v-sidebar" aria-label="Разделы Бухгалтера">${nav.map(([id, i, t]) => `<button class="cursor-interaction ${state.page === id ? 'active' : ''}" data-nav="${id}">${icon(i)}${t}${id === 'requests' && n ? `<span class="v-count">${n}</span>` : ''}</button>`).join('')}<div class="v-sidebarfoot">${monatJahr(D().heute)}<br><a href="/" class="v-alle">Все разделы ↗</a></div></nav><main class="v-content">${({ inbox, cash, requests, invoices, bank, archive }[state.page] || inbox)()}${modal()}<div class="v-footer"><span>${fuss[0]}</span><span>${fuss[1]}</span></div></main></div></div>`;
}

/* ---------------- телефон ---------------- */
function meinePrivat() { return D().belege.filter(b => b.person_ref === D().ich.person && b.zahlart === 'privat' && b.status !== 'abgelehnt'); }
function worker() {
  if (state.mobile === 'add') return expense();
  const offen = offeneRF();
  if (state.mobile === 'requests') {
    return `<h1>Мои запросы</h1><p class="v-small">Ответьте до конца второго рабочего дня</p>${offen.length ? offen.map(r => `<div class="v-panel"><div class="v-detail"><span class="v-tag ${r.verlust ? 'bad' : 'warn'}">${r.verlust ? 'Сообщено о потере' : r.status === 'beantwortet' ? 'Ответ отправлен' : 'Нужен чек'}</span><h2 style="margin-top:12px">${esc(rfKurz(r))}${r.betrag ? ' · ' + money(r.betrag) : ''}</h2><p class="v-small">${tagMonat(r.datum || berlinTag(r.angelegt))}${r.objekt ? ' · ' + esc(r.objekt) : ''}</p><div class="v-actions">${button('Добавить чек', 'uploadForRequest:' + r.id, true, r.verlust ? 'disabled' : '')}</div>${button('Чек потерян', 'lost:' + r.id, false, `style="margin-top:10px;width:100%"${r.verlust ? ' disabled' : ''}`)}</div></div>`).join('') : '<div class="v-panel"><div class="v-stateempty">Открытых запросов нет</div></div>'}`;
  }
  const priv = meinePrivat();
  const offenPriv = priv.filter(b => !b.erstattung || !['ausgezahlt', 'ueberwiesen_gemeldet'].includes(b.erstattung.status));
  const soll = offenPriv.reduce((s, b) => s + b.betrag, 0);
  const geprueft = offenPriv.length && offenPriv.every(b => b.status === 'geprueft');
  if (state.mobile === 'money') {
    const erst = D().erstattungen.filter(e => ['ausgezahlt', 'ueberwiesen_gemeldet'].includes(e.status)).reduce((s, e) => s + e.betrag, 0);
    const letzter = offenPriv[0] || priv[0];
    const arten = new Set(offenPriv.map(b => b.art));
    return `<h1>Мои деньги</h1><div class="v-panel"><div class="v-detail"><span class="v-label">Мне должны</span><div class="v-amount">${money(soll)}</div><p class="v-small">${!offenPriv.length ? 'Открытых возмещений нет' : geprueft ? 'Чек проверен · ожидает возмещения' : 'Чек на проверке у бухгалтерии'}</p><hr>${keys([['Покупка', arten.size > 1 ? 'Разное' : ({ kraftstoff: 'Топливо', material: 'Материалы', sonstiges: 'Другое' }[[...arten][0]] || '—')], ['Оплачено', 'Своими деньгами'], ['Возмещено', money(erst)]])}${letzter && letzter.datei ? button('Открыть чек', 'document:' + letzter.id) : ''}</div></div>${vorschussPanel()}`;
  }
  const letzter = D().belege.filter(b => b.person_ref === D().ich.person)[0];
  const neu = state.gesendet;
  return `<div class="v-label">Личный кабинет · ${esc(D().ich.name)}</div><h1 style="margin-top:5px">Добрый день</h1><p class="v-small" style="margin-top:5px">Чеки за сегодня — до конца рабочего дня</p><button class="v-upload cursor-interaction" data-action="addexpense">${icon('camera')}<strong>Добавить чек</strong><span class="v-small">Бензин или материалы</span></button><div class="v-metrics"><button class="v-metric cursor-interaction" data-mobile="money"><span>Мне должны</span><strong>${money(soll)}</strong><span>${!offenPriv.length ? 'Ничего не должны' : geprueft ? 'Чек проверен' : 'Ожидает проверки'} ↗</span></button><button class="v-metric cursor-interaction" data-mobile="requests"><span>Нужен ответ</span><strong>${offen.length} ${plural(offen.length, 'запрос', 'запроса', 'запросов')}</strong><span>${offen.length ? 'Открыть вопрос' : 'Вопросов нет'} ↗</span></button></div><div class="v-panel"><div class="v-panelhead"><h3>Последний чек</h3></div>${letzter ? item({ ...belegRec(letzter), aktuell: true }) : '<div class="v-detail"><p class="v-small">Чеков пока нет</p></div>'}${neu ? `<div class="v-detail"><span class="v-tag good">Новый чек ${esc(neu)} передан на проверку</span></div>` : ''}${state.warte.length ? `<div class="v-detail">${state.warte.map(w => w.fehler ? `<span class="v-tag bad">Чек на ${esc(w.body.betrag)} € не принят: ${esc(w.fehler)}</span> ${button('Убрать из очереди', 'wegwarte:' + w.idem)}` : `<span class="v-tag warn">Чек на ${esc(w.body.betrag)} € ждёт связи · сохранён на телефоне</span>`).join('<br>')}</div>` : ''}</div>`;
}
function rfKurz(r) { return r.beleg_art === 'kraftstoff' ? 'Заправка' : r.beleg_art === 'material' ? 'Материалы' : r.titel; }
function belegRec(b) {
  return { id: 'b' + b.id, type: b.art === 'kraftstoff' ? 'fuel' : 'material', title: b.titel, person: b.person, sum: b.betrag, date: b.datum,
    status: b.status === 'geprueft' ? 'Проверено' : b.status === 'abgelehnt' ? 'Отклонён' : 'На проверке', cls: b.status === 'geprueft' ? 'good' : b.status === 'abgelehnt' ? 'bad' : 'warn' };
}
function vorschussPanel() {
  const k = D().konten.find(x => x.art === 'vorschuss');
  if (!k) return '';
  return `<div class="v-panel"><div class="v-detail"><span class="v-label">Аванс на расходы</span><div class="v-amount">${money(k.saldo)}</div><p class="v-small">Расчётный остаток: получено − чеки из аванса − возвращено</p><hr>${keys([['Получено', money(k.erhalten)], ['Чеками', money(k.ausgaben)], ['Вернул', money(k.zurueck)]])}</div></div>`;
}
function expense() {
  const e = state.entwurf || (state.entwurf = { kind: 'fuel', idem: neuIdem() });
  const hat = !!(e.sha || e.foto);
  const fz = D().fahrzeuge, ob = D().objekte;
  const ziel = e.kind === 'fuel'
    ? fz.map(f => `<option value="f:${esc(f.id)}" ${e.ziel === 'f:' + f.id ? 'selected' : ''}>${esc(f.text)}</option>`).join('') + `<option value="kanister" ${e.ziel === 'kanister' ? 'selected' : ''}>В канистру / техника</option>`
    : ob.map(o => `<option value="o:${esc(o.nummer)}" ${e.ziel === 'o:' + o.nummer ? 'selected' : ''}>${esc(o.bez || o.nummer)}</option>`).join('') + `<option value="mehrere" ${e.ziel === 'mehrere' ? 'selected' : ''}>Несколько объектов</option>`;
  return `<div class="v-label">${e.rueckfrage_id ? 'Ответ на запрос' : 'Новый расход'}</div><h1>Добавить чек</h1><div class="v-seg" style="margin-top:15px">${[['fuel', 'Бензин'], ['material', 'Материалы']].map(([id, t]) => `<button class="cursor-interaction" data-kind="${id}" aria-pressed="${e.kind === id}">${t}</button>`).join('')}</div><button class="v-upload cursor-interaction" data-action="foto:beleg">${icon(hat ? 'check-circle-2' : 'camera')}<strong>${hat ? 'Чек добавлен' : 'Сфотографировать чек'}</strong><span class="v-small">${hat ? 'Проверьте сумму и способ оплаты' : 'Откроется камера телефона'}</span></button><form id="vav-expense" class="v-form"><label>Сумма, €<input name="amount" inputmode="decimal" value="${esc(e.amount || '')}" placeholder="0,00" required></label><label>${e.kind === 'fuel' ? 'Машина / назначение' : 'Объект'}<select name="object">${ziel}</select></label><label>Чем оплатили<select name="payment">${[['privat', 'Своими деньгами'], ['vorschuss', 'Из аванса'], ['firmenkarte', 'Картой фирмы']].map(([v, t]) => `<option value="${v}" ${(e.payment || (e.rueckfrage_id ? 'firmenkarte' : 'privat')) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label><button type="button" data-submit="yes" class="v-button primary full cursor-interaction">Отправить на проверку</button><p class="v-small">Чек увидит бухгалтерия. Возмещение — только после проверки.</p></form>`;
}

function oleg() {
  const k = D().konten.find(x => x.art === 'halter' && x.login === D().ich.login) || { saldo: 0, erhalten: 0, ausgaben: 0, zurueck: 0, id: '' };
  const ein = D().bewegungen.filter(m => m.status === 'gemeldet' && m.an_konto === k.id);
  const aus = D().bewegungen.filter(m => m.status === 'gemeldet' && m.von_konto === k.id);
  const empf = ein.length ? ein.map(m => `<p>${esc(vorname(m.von))} передаёт ${money(m.betrag)}</p><p class="v-small">${D().demo ? 'Пример новой передачи' : 'Передача ' + tagMonat(m.datum)} · в остатке ещё не учтена</p><div class="v-actions">${button('Подтвердить получение', 'receive:' + m.id, true)}</div>`).join('<hr>')
    : '<p class="v-small">Новых передач нет</p>';
  return `<div class="v-label">Деньги у ответственного</div><h1>${esc(D().ich.vorname)}</h1><div class="v-panel"><div class="v-detail"><span class="v-label">Расчётный остаток</span><div class="v-amount">${money(k.saldo)}</div>${keys([['Получил', money(k.erhalten)], ['Расходы', money(k.ausgaben)], ['Вернул', money(k.zurueck)]])}<div class="v-actions">${button('Выдать', 'issue', true)}${button('Вернуть в кассу', 'return')}</div>${aus.length ? `<p class="v-small" style="margin-top:12px">В пути: ${aus.map(m => money(m.betrag)).join(', ')} — ждёт подтверждения получателя</p>` : ''}</div></div><div class="v-panel"><div class="v-panelhead"><h3>Подтверждение получения</h3></div><div class="v-detail">${empf}</div></div>${olegZusatz()}`;
}
function olegZusatz() {
  const d = D(), out = [];
  const zuGeben = d.quittungen.filter(q => q.status === 'vorbereitet' && q.plan_status === 'genehmigt');
  if (zuGeben.length) out.push(mobilListe('Выдать по утверждённому списку', zuGeben.map(q => [`${q.nr} · ${q.empfaenger}`, money(q.betrag), button('Бланк', 'druck:quittung:' + q.id) + button('Выдал', 'ausgeben:' + q.id, true)])));
  const ohneFoto = d.quittungen.filter(q => q.status === 'ausgegeben' && !q.foto && q.ausgegeben_von === d.ich.login);
  if (ohneFoto.length) out.push(mobilListe('Фото подписанной квитанции', ohneFoto.map(q => [`${q.nr} · ${q.empfaenger}`, money(q.betrag), button('Бланк', 'druck:quittung:' + q.id) + button('Сфотографировать', 'foto:quittung:' + q.id, true)])));
  const erst = d.erstattungen.filter(e => e.status === 'offen' && e.weg !== 'ueberweisung');
  if (erst.length) out.push(mobilListe('Возместить наличными', erst.map(e => [`${e.empfaenger} · чек ${e.beleg_nr}`, money(e.betrag), button('Выдать с квитанцией', 'erstattungbar:' + e.id, true)])));
  const ueb = d.erstattungen.filter(e => e.status === 'offen' && e.weg === 'ueberweisung');
  if (ueb.length) out.push(mobilListe('Согласовать перевод возмещения', ueb.map(e => [`${e.empfaenger} · чек ${e.beleg_nr}`, money(e.betrag), button('Согласовать', 'erstattungoleg:' + e.id, true)])));
  const pk = d.pakete.filter(p => p.status === 'entwurf' && p.oleg_status !== 'bestaetigt');
  if (pk.length) out.push(mobilListe('Подтвердить объём и стоимость работ', pk.map(p => [`${p.lieferant} · ${p.rechnung_nr}`, money(p.brutto), button('Открыть', 'olegpaket:' + p.id, true)])));
  const rf = offeneRF().filter(r => r.stufe === 'oleg' || r.stufe === 'gf');
  if (rf.length) out.push(mobilListe('Помочь получить документ', rf.map(r => [`${r.titel} · ${r.person}`, money(r.betrag || 0), button('Открыть', 'rfopen:' + r.id)])));
  return out.join('');
}
function mobilListe(titel, zeilen) {
  return `<div class="v-panel"><div class="v-panelhead"><h3>${titel}</h3></div><div class="v-detail">${zeilen.map(([t, b, k]) => `<div class="v-keyvalue"><span>${esc(t)}</span><span>${b}</span></div><div class="v-actions" style="margin:6px 0 12px">${k}</div>`).join('')}</div></div>`;
}

function owner() {
  const d = D();
  const pk = d.pakete.filter(p => ['an_gf', 'gf_gesehen'].includes(p.status));
  const plaene = d.plaene.filter(p => p.status === 'eingereicht');
  const erst = d.erstattungen.filter(e => e.status === 'an_gf');
  const karten = pk.map(p => `<div class="v-panel"><div class="v-detail"><span class="v-tag good">Бухгалтерия и Олег согласовали</span><h2 style="margin-top:14px">${esc(p.lieferant.split(' · ')[0])}</h2><div class="v-amount">${money(p.zu_zahlen)}</div><p class="v-small">К переводу по счёту ${esc(p.rechnung_nr)}</p><hr>${keys([['Полная сумма', money(p.brutto)], ['Выдано рабочим', `− ${money(p.verrechnet)}`]])}<div class="v-actions">${button('Открыть комплект', 'payment:' + p.id, true)}</div><p class="v-small" style="margin-top:12px">Перевод выполняется отдельно в банке.</p></div></div>`).join('');
  const planKarten = plaene.map(p => `<div class="v-panel"><div class="v-detail"><span class="v-tag warn">Заявка на наличные</span><h2 style="margin-top:14px">${esc(p.titel)}</h2><div class="v-amount">${money(p.summe)}</div><p class="v-small">${esc(p.nr)} · квитанции подготовлены, деньги не выданы</p><div class="v-actions">${button('Утвердить', 'planok:' + p.id, true)}${button('Открыть', 'plan:' + p.id)}</div></div></div>`).join('');
  const erstKarten = erst.length ? mobilListe('Возмещение переводом', erst.map(e => [`${e.empfaenger} · чек ${e.beleg_nr}`, money(e.betrag), button('Перевод внесён в банке', 'erstattunggf:' + e.id, true)])) : '';
  const leer = !karten && !planKarten && !erstKarten ? '<div class="v-panel"><div class="v-stateempty">Всё согласовано</div></div>' : '';
  return `<div class="v-label">Руководитель · ${esc(d.ich.vorname)}</div><h1>На согласование</h1>${karten}${planKarten}${erstKarten}${leer}<div class="v-actions" style="margin-top:17px">${button('Снятие и передача денег', 'transfer')}${button('Все разделы', 'desktop')}</div>`;
}

function mobile() {
  const r = rolle();
  const body = r === 'mitarbeiter' ? worker() : r === 'disponent' ? oleg() : owner();
  const fuss = D().demo ? 'Все суммы и документы — примеры' : `Данные сервера · ${uhr(D().jetzt)} · уведомления не отправляются`;
  return `<div class="v-mobilewrap"><div class="v-phone"><div class="v-phonehead"><div class="v-logo"><span class="v-mark">V</span>VAV · БУХГАЛТЕР</div><a class="v-avatar" href="/api/logout?next=/arbeit" title="Выйти" style="color:inherit;text-decoration:none">${esc(D().ich.kurz)}</a></div><div class="v-phonebody">${body}${modal()}</div>${r === 'mitarbeiter' ? `<nav class="v-bottom" aria-label="Меню сотрудника">${[['home', 'house', 'Главная'], ['add', 'scan-line', 'Чек'], ['money', 'wallet', 'Деньги'], ['requests', 'message-circle', 'Запросы']].map(([id, i, t]) => `<button class="cursor-interaction ${state.mobile === id ? 'active' : ''}" data-mobile="${id}">${icon(i)}${t}</button>`).join('')}</nav>` : ''}</div><p class="v-small" style="margin-top:12px;text-align:center">${fuss}</p></div>`;
}

/* ---------------- окна ---------------- */
const opt = (v, t, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(t)}</option>`;
function modal() {
  if (!state.modal) return '';
  const d = D(), [art, a1, a2] = state.modal.split(':');
  let title = '', body = '';
  const idem = art + ':' + (a1 || '');
  if (!state.idem[idem]) state.idem[idem] = neuIdem();
  if (art === 'document') {
    const b = d.belege.find(x => String(x.id) === a1);
    title = 'Документ';
    body = b ? `${b.datei ? `<a href="/api/k/datei/${b.datei}" target="_blank" rel="noopener"><img class="v-bild" src="/api/k/datei/${b.datei}" alt="Фото чека ${esc(b.nr)}"></a>` : '<div class="v-note">Фото нет</div>'}${keys([['Номер', esc(b.nr)], ['Состояние', b.status === 'geprueft' ? 'Проверен бухгалтерией' : b.status === 'abgelehnt' ? 'Отклонён: ' + esc(b.pruef_notiz || '') : 'Фото загружено · ждёт проверки'], ['Загружено', new Date(b.angelegt).toLocaleString('ru-RU', { timeZone: TZ })]])}${istBuch() && b.status === 'eingereicht' && !b.eigen ? `<form id="vav-ablehnen" class="v-form" style="margin-top:12px"><label>Причина отклонения<textarea name="notiz" rows="2" required placeholder="Например: чек нечитаем"></textarea></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Отклонить чек</button><p class="v-small">Отклонение не возвращает деньги в остаток.</p></form>` : ''}` : '<p>Документ не найден.</p>';
  } else if (art === 'request') {
    const b = d.belege.find(x => String(x.id) === a1);
    title = 'Запросить документ';
    body = `<form id="vav-request" class="v-form"><label>Кому<select name="an">${opt('person', b ? b.person : 'Сотрудник', true)}</select></label><label>Запрос<textarea name="text" rows="3">Пришлите чек или пояснение по выбранной операции.</textarea></label><p class="v-small">Сотруднику — 2 рабочих дня, затем Олегу — 1. Бухгалтер сохраняет контроль. Уведомления пока не отправляются.</p><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Создать запрос</button></form>`;
  } else if (art === 'rfopen') {
    const r = d.rueckfragen.find(x => String(x.id) === a1);
    title = r ? `Запрос ${r.nr}` : 'Запрос';
    if (r) {
      const verlauf = r.eintraege.map(e => `<div class="v-event">${icon(e.art === 'verlust' ? 'alert-triangle' : e.datei ? 'image' : 'message-circle')}<span><strong>${esc(vorname(e.von))}</strong> · ${new Date(e.am).toLocaleString('ru-RU', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<span class="v-small" style="display:block">${esc(e.text || '')}${e.datei ? ` · <a href="/api/k/datei/${e.datei}" target="_blank" rel="noopener">фото</a>` : ''}</span></span></div>`).join('');
      body = `${keys([['Кому', esc(r.person)], ['Сейчас', esc(rfStatus(r))], ['Срок ступени', r.frist ? tagMonat(r.frist) : '—']])}<p style="margin:12px 0">${esc(r.text)}</p>${verlauf ? `<div class="v-ledger" style="padding:0">${verlauf}</div>` : '<p class="v-small">Ответа пока нет.</p>'}${istBuch() || istGf() ? `<form id="vav-rfclose" class="v-form" style="margin-top:12px"><label>Что проверено перед закрытием<textarea name="notiz" rows="2" required></textarea></label><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Закрыть запрос</button></form>` : `<form id="vav-rfantwort" class="v-form" style="margin-top:12px"><label>Пояснение<textarea name="text" rows="2" required></textarea></label><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Ответить</button></form>`}`;
    }
  } else if (art === 'receipts') {
    const p = d.pakete.find(x => String(x.id) === a1);
    title = 'Квитанции к счёту';
    if (p) {
      const alle = p.verrechnungen.length && p.verrechnungen.every(x => x.foto), nu = p.verrechnungen.length && p.verrechnungen.every(x => x.nu_bestaetigt);
      const orig = p.verrechnungen.length && p.verrechnungen.every(x => x.original);
      const frei = d.quittungen.filter(q => q.zweck === 'nu' && q.status === 'ausgegeben' && q.verrechnet < q.betrag);
      body = `${keys(p.verrechnungen.map(x => [`${esc(x.nr)} · ${esc(x.empfaenger)}`, money(x.betrag)]))}<div class="v-check">${icon(alle ? 'check-circle-2' : 'circle')}${alle ? 'Получатели подписали' : 'Нет фото подписи у части квитанций'}</div><div class="v-check">${icon(nu ? 'check-circle-2' : 'circle')}${nu ? 'Подрядчик подтвердил' : 'Подрядчик ещё не подтвердил'}</div>${istBuch() ? button(orig ? 'Оригиналы приняты' : 'Отметить приём оригиналов', 'originale:' + p.id, true, orig || !p.verrechnungen.length ? 'disabled' : '') : ''}${istBuch() && p.status === 'entwurf' ? `<form id="vav-verrechnen" class="v-form" style="margin-top:14px"><label>Зачесть квитанцию<select name="quittung">${frei.map(q => opt(q.id, `${q.nr} · ${q.empfaenger} · ${q.nu_name || ''} · осталось ${money(q.betrag - q.verrechnet)}`)).join('') || opt('', 'Нет выданных квитанций этого подрядчика')}</select></label><label>Сумма зачёта, € (пусто — весь остаток)<input name="betrag" inputmode="decimal" placeholder="0,00"></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Зачесть</button><p class="v-small">Полная сумма счёта не меняется: зачёт уменьшает только остаток к оплате.</p></form>` : ''}`;
    }
  } else if (art === 'payment') {
    const p = d.pakete.find(x => String(x.id) === a1);
    title = 'Комплект для Андрея';
    if (p) {
      const iban = p.iban ? `${esc(p.iban)}` : '<span style="color:var(--v-red)">Не указаны</span>';
      body = `${keys([['Счёт', `${esc(p.rechnung_nr)} · ${esc(p.lieferant)}`], ['К оплате', money(p.zu_zahlen)], ['Олег', p.oleg_status === 'bestaetigt' ? 'Работы подтверждены' : p.oleg_status === 'abweichung' ? 'Расхождение' : 'Не подтверждено'], ['Бухгалтер', p.geprueft_am ? 'Документы проверены' : 'Не проверено'], ['Реквизиты', iban], ...(p.iban_quelle ? [['Источник реквизитов', esc(p.iban_quelle)]] : [])])}${button('Счёт и квитанции', 'receipts:' + p.id)}<div class="v-note">${p.bank_op ? 'Перевод подтверждён банковской операцией.' : p.status === 'bezahlt_gemeldet' ? 'Андрей отметил перевод. Банком ещё не подтверждено.' : 'Перевод ещё не подтверждён. Приложение деньги не переводит.'}</div>${paketAktionen(p)}`;
    }
  } else if (art === 'olegpaket') {
    const p = d.pakete.find(x => String(x.id) === a1);
    title = 'Объём и стоимость работ';
    body = p ? `${keys([['Счёт', `${esc(p.rechnung_nr)} · ${esc(p.lieferant)}`], ['Полная сумма', money(p.brutto)], ['Объект', esc(p.objekt || 'Не указан')]])}${p.datei ? button('Открыть счёт', 'pdf:' + p.datei) : ''}<form id="vav-oleg" class="v-form" style="margin-top:12px"><label>Комментарий<textarea name="text" rows="2" placeholder="Что сверено; при расхождении — что не так"></textarea></label><div class="v-actions">${button('Подтверждаю', 'olegok:' + p.id, true)}${button('Расхождение', 'olegab:' + p.id)}</div></form>` : '';
  } else if (['transfer', 'issue', 'return'].includes(art)) {
    title = art === 'issue' ? 'Выдача с квитанцией' : art === 'return' ? 'Возврат в кассу' : 'Передача наличных';
    body = transferForm(art);
  } else if (art === 'newdoc') {
    title = 'Добавить документ';
    body = `<p class="v-small">Принесённый чек или счёт подрядчика из письма</p><div class="v-actions">${button('Чек', 'newbeleg')}${button('Счёт', 'newinvoice')}</div>`;
  } else if (art === 'newbeleg') {
    title = 'Чек за сотрудника';
    body = `<form id="vav-buchbeleg" class="v-form"><button class="v-upload cursor-interaction" type="button" data-action="foto:buchbeleg">${icon(state.upload.buchbeleg ? 'check-circle-2' : 'upload')}<strong>${state.upload.buchbeleg ? 'Документ загружен' : 'Загрузить фото или PDF'}</strong></button><label>Сотрудник<select name="person">${d.personen.map(p => opt(p.id, p.name + (p.org ? ' · ' + p.org : ''))).join('')}</select></label><div class="v-formpair"><label>Что куплено<select name="art">${opt('kraftstoff', 'Топливо')}${opt('material', 'Материалы')}${opt('sonstiges', 'Другое')}</select></label><label>Сумма, €<input name="betrag" inputmode="decimal" required placeholder="0,00"></label></div><label>Машина или объект<select name="ziel">${d.fahrzeuge.map(f => opt('f:' + f.id, f.text)).join('')}${opt('kanister', 'В канистру / техника')}${d.objekte.map(o => opt('o:' + o.nummer, o.bez || o.nummer)).join('')}${opt('mehrere', 'Несколько объектов')}</select></label><div class="v-formpair"><label>Чем оплачено<select name="zahlart">${opt('privat', 'Личные деньги')}${opt('vorschuss', 'Из аванса')}${opt('firmenkarte', 'Карта фирмы')}${opt('kasse', 'Основная касса')}</select></label><label>Дата чека<input name="datum" type="date" value="${d.heute}"></label></div><label>Название документа<input name="dokument" placeholder="Например: Чек АЗС № 0418"></label><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Передать на проверку</button><p class="v-small">Собственный расход бухгалтера проверяет Андрей.</p></form>`;
  } else if (art === 'newinvoice') {
    title = 'Счёт подрядчика';
    const nu = [...new Set(d.personen.filter(p => p.org_typ === 'sub').map(p => p.org))];
    body = `<form id="vav-paket" class="v-form"><button class="v-upload cursor-interaction" type="button" data-action="foto:paket">${icon(state.upload.paket ? 'check-circle-2' : 'upload')}<strong>${state.upload.paket ? 'Счёт загружен' : 'Загрузить счёт (PDF)'}</strong><span class="v-small">Исходное письмо — ссылкой из Почты</span></button><label>Подрядчик<select name="lieferant">${nu.map(n => opt(n, n)).join('')}</select></label><div class="v-formpair"><label>Номер счёта<input name="nr" required></label><label>Дата счёта<input name="datum" type="date"></label></div><div class="v-formpair"><label>Полная сумма работ, €<input name="brutto" inputmode="decimal" required placeholder="0,00"></label><label>Объект<select name="objekt">${opt('', 'Не указан')}${d.objekte.map(o => opt(o.nummer, o.bez || o.nummer)).join('')}</select></label></div><label>Письмо в Почте (номер, если есть)<input name="mail" inputmode="numeric"></label><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Создать комплект</button><p class="v-small">Один счёт — один комплект. Выданные рабочим деньги зачитываются отдельно.</p></form>`;
  } else if (art === 'lost') {
    title = 'Чек потерян';
    body = `<p>Вопрос сразу направляется бухгалтеру и Андрею.</p><form id="vav-lost" class="v-form" style="margin-top:14px"><label>Что произошло<textarea name="text" required rows="3" placeholder="Коротко опишите ситуацию"></textarea></label><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Сообщить</button></form>`;
  } else if (art === 'plan') {
    const p = d.plaene.find(x => String(x.id) === a1);
    title = p ? `Заявка ${p.nr}` : 'Заявка';
    const qs = d.quittungen.filter(q => String(q.plan_id) === a1);
    body = p ? `${keys([['Статус', { entwurf: 'Черновик', eingereicht: 'Ждёт утверждения', genehmigt: 'Утверждена', abgelehnt: 'Отклонена' }[p.status]], ['Сумма', money(p.summe)]])}<hr>${keys(qs.map(q => [`${esc(q.nr)} · ${esc(q.empfaenger)} · ${{ vorschuss: 'аванс', lohn: 'зарплата', erstattung: 'возмещение', nu: 'рабочему подрядчика' }[q.zweck]}`, `${money(q.betrag)} · ${q.status === 'ausgegeben' ? 'выдано' : q.status === 'storniert' ? 'аннулирована' : 'не выдано'}`]))}<div class="v-actions">${button('Печать квитанций', 'druck:plan:' + p.id)}${p.status === 'entwurf' && (istBuch() || istGf()) ? button('Подать Андрею', 'planeinreichen:' + p.id, true) : ''}${p.status === 'eingereicht' && istGf() ? button('Утвердить', 'planok:' + p.id, true) + button('Отклонить', 'planno:' + p.id) : ''}${p.status === 'genehmigt' && istBuch() ? qs.filter(q => q.status === 'vorbereitet').map(q => button('Выдать ' + q.nr + ' из кассы', 'ausgeben:' + q.id)).join('') : ''}</div><p class="v-small" style="margin-top:12px">Подготовленная квитанция не подтверждает выдачу денег.</p>` : '';
  } else if (art === 'newplan') {
    title = 'Заявка на наличные';
    const zeilen = (state.planZeilen = state.planZeilen || [{}]);
    body = `<form id="vav-plan" class="v-form"><label>Название<input name="titel" value="Заявка на наличные"></label>${zeilen.map((z, i) => `<div class="v-formpair"><label>Получатель ${i + 1}<select name="p${i}">${d.personen.map(p => opt(p.id, p.name + (p.org ? ' · ' + p.org : ''))).join('')}</select></label><label>Сумма, €<input name="b${i}" inputmode="decimal" placeholder="0,00" required></label></div><label>Назначение<select name="z${i}">${opt('vorschuss', 'Аванс на расходы')}${opt('lohn', 'Зарплата / аванс по зарплате')}${opt('nu', 'Рабочему подрядчика')}</select></label>`).join('')}<div class="v-actions">${button('+ Строка', 'planzeile')}<button class="v-button primary cursor-interaction" type="button" data-submit="yes">Составить квитанции</button></div><p class="v-small">На каждого получателя — отдельная квитанция. Выдача — только после утверждения Андреем.</p></form>`;
  } else if (art === 'quittung') {
    const q = d.quittungen.find(x => String(x.id) === a1);
    title = q ? `Квитанция ${q.nr}` : 'Квитанция';
    body = q ? `${keys([['Получатель', esc(q.empfaenger)], ...(q.nu_name ? [['Подрядчик', esc(q.nu_name)]] : []), ['Сумма', money(q.betrag)], ['Состояние', esc(quittungStand(q))], ...(q.nu_bestaetigt_notiz ? [['Подтверждение подрядчика', esc(q.nu_bestaetigt_notiz)]] : [])])}${q.foto ? `<a href="/api/k/datei/${q.foto}" target="_blank" rel="noopener"><img class="v-bild" src="/api/k/datei/${q.foto}" alt="Подписанная квитанция"></a>` : ''}<div class="v-actions">${q.status !== 'storniert' ? button('Бланк для подписи', 'druck:quittung:' + q.id, !q.foto) : ''}${q.status === 'ausgegeben' && !q.foto ? button('Фото подписи', 'foto:quittung:' + q.id) : ''}${istBuch() && q.status === 'ausgegeben' && !q.original_am ? button('Оригинал принят', 'original:' + q.id, true) : ''}${istBuch() && q.status === 'vorbereitet' ? button('Аннулировать', 'storno:' + q.id) : ''}</div>${istBuch() && q.zweck === 'nu' && q.status === 'ausgegeben' && !q.nu_bestaetigt_am ? `<form id="vav-nu" class="v-form" style="margin-top:12px"><label>Как подрядчик подтвердил квитанцию<input name="notiz" required placeholder="Письмо 23.09 / подпись на копии"></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Отметить подтверждение подрядчика</button></form>` : ''}` : '';
  } else if (art === 'bankop') {
    const op = (state.bank && state.bank.liste || []).find(o => String(o.id) === a1);
    title = 'Операция банка';
    body = op ? `${keys([['Дата', tagMonat(op.datum)], ['Контрагент', esc(op.partner || '—')], ['Сумма', money(op.betrag)], ['Комментарий', esc(op.kommentar || '—')]])}${istBuch() ? `<form id="vav-banklink" class="v-form" style="margin-top:12px"><label>Связать с документом<select name="ziel">${d.pakete.map(p => opt('paket:' + p.id, `Комплект ${p.rechnung_nr} · к оплате ${money(p.zu_zahlen)}`)).join('')}${abhebungen().map(x => opt('abhebung:' + x.a.id, `Снятие ${tagMonat(x.a.datum)} · ${money(x.a.betrag)}`)).join('')}</select></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Связать (сумма проверяется)</button></form><form id="vav-bankrf" class="v-form" style="margin-top:12px"><label>Нет документа — запросить у<select name="person">${d.personen.map(p => opt(p.id, p.name)).join('')}</select></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Создать запрос на чек</button></form>` : ''}` : '<p>Операция не найдена.</p>';
  } else {
    const k = d.konten.find(x => x.id === a1) || halter()[0] || {};
    const map = {
      officecash: ['Основная касса', `Расчётный остаток ${money((kasse() || {}).saldo || 0)}: получено ${money((kasse() || {}).erhalten || 0)}, выдано и потрачено ${money((kasse() || {}).ausgaben || 0)}. Это расчётный остаток, не пересчёт.`],
      olegledger: [`Движение денег · ${k.name || ''}`, `Получено ${money(k.erhalten || 0)}; расходы ${money(k.ausgaben || 0)}; возвраты ${money(k.zurueck || 0)}; остаток ${money(k.saldo || 0)}. Это расчётный остаток.`],
      cashcheck: ['Пересчёт наличных', 'Порядок физического пересчёта пока открыт для обсуждения. Расчётный остаток не считается подтверждением наличия денег.'],
      cashdocs: ['Документы расходов', cashdocsText(k)],
      bewegung: ['Передача', 'Ждёт подтверждения получателя. До подтверждения деньги не зачислены получателю.'],
    };
    [title, body] = map[art] || ['Раздел', 'Нет данных.'];
    body = `<p>${body}</p>`;
  }
  return `<section class="v-modal" aria-label="${esc(title)}"><div class="v-modalheader"><h3>${esc(title)}</h3><button class="v-button cursor-interaction" data-action="close" aria-label="Закрыть">${icon('x')}</button></div>${body}</section>`;
}
function cashdocsText(k) {
  const bw = D().bewegungen.filter(m => m.von_konto === k.id && ['ausgabe', 'verbrauch'].includes(m.art) && m.status !== 'storniert');
  const aus = bw.filter(m => m.art === 'ausgabe').reduce((s, m) => s + m.betrag, 0), ver = bw.filter(m => m.art === 'verbrauch').reduce((s, m) => s + m.betrag, 0);
  return `Выдано по квитанциям: ${money(aus)}. Потрачено по чекам: ${money(ver)}. Итого из денег ${genitiv(k)}: ${money(aus + ver)}.`;
}
function paketAktionen(p) {
  if (istGf()) return `<div class="v-actions">${p.status === 'an_gf' ? button('Комплект просмотрен', 'gesehen:' + p.id, true) : ''}${['an_gf', 'gf_gesehen'].includes(p.status) ? button('Перевод внесён в банке', 'bezahlt:' + p.id, p.status === 'gf_gesehen') : ''}</div>`;
  if (istBuch() && p.status === 'entwurf') return `<div class="v-actions">${!p.geprueft_am ? button('Документы проверены', 'geprueft:' + p.id) : ''}${button('Передать Андрею', 'angf:' + p.id, true)}</div>${!p.iban ? `<form id="vav-iban" class="v-form" style="margin-top:12px"><div class="v-formpair"><label>IBAN<input name="iban" required></label><label>Проверенный источник<input name="quelle" required placeholder="Stammdaten / счёт, стр. 1"></label></div><button class="v-button cursor-interaction" type="button" data-submit="yes">Сохранить реквизиты</button></form>` : ''}${p.oleg_status !== 'bestaetigt' ? `<form id="vav-olegdoc" class="v-form" style="margin-top:12px"><button class="v-upload cursor-interaction" type="button" data-action="foto:olegdoc">${icon(state.upload.olegdoc ? 'check-circle-2' : 'upload')}<strong>${state.upload.olegdoc ? 'Подтверждение Олега загружено' : 'Письменное подтверждение Олега'}</strong></button><label>Что подтвердил Олег<input name="text" required></label><button class="v-button cursor-interaction" type="button" data-submit="yes">Зафиксировать подтверждение Олега</button></form>` : ''}`;
  return '';
}
function transferForm(art) {
  const d = D();
  if (art === 'issue') {
    return `<form id="vav-transfer" class="v-form"><label>Получатель<select name="person">${d.personen.filter(p => p.org_typ !== 'sub').map(p => opt(p.id, p.name)).join('')}</select></label><label>Сумма, €<input name="amount" inputmode="decimal" placeholder="0,00" required></label><label>Назначение<select name="zweck">${opt('vorschuss:m', 'На материалы')}${opt('vorschuss:k', 'На топливо')}${opt('lohn', 'Аванс по зарплате')}${opt('nu', 'Рабочему подрядчика')}</select></label><p class="v-small">Квитанция оформляется сразу. Подпись получателя — при выдаче. Рабочему подрядчика — только по утверждённому списку.</p><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Выдать и оформить квитанцию</button></form>`;
  }
  if (art === 'return') return `<form id="vav-transfer" class="v-form"><label>Получатель<select name="an">${opt('hauptkasse', 'Бухгалтер · основная касса')}</select></label><label>Сумма, €<input name="amount" inputmode="decimal" placeholder="0,00" required></label><p class="v-small">Получатель отдельно подтверждает фактическое получение.</p><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Создать передачу</button></form>`;
  const ziele = halter().map(k => opt(k.id, k.name)).join('') + (istGf() ? opt('hauptkasse', 'Бухгалтер · основная касса') : '');
  const quellen = istGf() ? abhebungen().map(x => ({ x, rest: x.a.betrag - x.teile.filter(t => t.status !== 'abgelehnt').reduce((s, t) => s + t.betrag, 0) })).filter(y => y.rest > 0) : [];
  return `<form id="vav-transfer" class="v-form">${istGf() ? `<label>Откуда<select name="quelle">${opt('neu', 'Новое снятие в банке')}${quellen.map(y => opt(y.x.a.id, `Снятие ${tagMonat(y.x.a.datum)} · осталось ${money(y.rest)}`)).join('')}</select></label>` : ''}<label>Получатель<select name="an">${ziele}</select></label><label>Сумма, €<input name="amount" inputmode="decimal" placeholder="0,00" required></label><p class="v-small">${istGf() ? 'Снятие само по себе не подтверждает получателя. ' : 'Из основной кассы. '}Получатель отдельно подтверждает фактическое получение.</p><button class="v-button primary cursor-interaction" type="button" data-submit="yes">Создать передачу</button></form>`;
}

/* ---------------- отрисовка ---------------- */
function modus() { const r = rolle(); return r === 'mitarbeiter' || r === 'disponent' || (r === 'gf' && innerWidth < 620 && !state.desktopErzwungen) ? 'mobile' : 'desktop'; }
function render() {
  if (!state.D) return;
  const aktiv = document.activeElement && document.activeElement.name;
  // Введённое в открытых формах переживает любую перерисовку (фоновая
  // очередь, обновление данных). Сбрасывается только после успешной отправки.
  const eingabe = {};
  if (!state.frisch) root.querySelectorAll('form[id] [name]').forEach(el => { if (el.type !== 'file') eingabe[el.form.id + '|' + el.name] = el.value; });
  state.frisch = false;
  screen.innerHTML = modus() === 'desktop' ? desktop() : mobile();
  root.querySelectorAll('form[id] [name]').forEach(el => { const k = el.form.id + '|' + el.name; if (k in eingabe && el.type !== 'file') el.value = eingabe[k]; });
  root.querySelectorAll('button').forEach(b => b.classList.add('cursor-interaction'));
  if (globalThis.lucide) lucide.createIcons({ attrs: { width: 16, height: 16 } });
  if (aktiv) { const el = root.querySelector(`[name="${aktiv}"]`); if (el) el.focus(); }
}
let breite = modus && innerWidth;
addEventListener('resize', () => { if (!state.D) return; const m = modus(); if (m !== breite) { breite = m; render(); } });

/* ---------------- нажатия ---------------- */
let dateiZweck = null;
function fotoWaehlen(zweck) {
  dateiZweck = zweck;
  datei.accept = zweck === 'paket' ? 'application/pdf,image/*' : 'image/*,application/pdf';
  if (zweck === 'beleg' || zweck.startsWith('quittung')) datei.setAttribute('capture', 'environment'); else datei.removeAttribute('capture');
  datei.value = ''; datei.click();
}
datei.addEventListener('change', async () => {
  const f = datei.files[0]; if (!f) return;
  const zweck = dateiZweck;
  toast('Загрузка файла…');
  if (zweck === 'beleg') {
    // Сначала фото ложится на телефон (IndexedDB), потом уходит на сервер.
    try { await idb.put('fotos', { key: fotoKey(), blob: f, mime: f.type || 'image/jpeg', name: f.name }); state.entwurf.foto = true; state.entwurf.sha = null; sichereEntwurf(); }
    catch (e) { toast('Фото не удалось сохранить на телефоне: ' + e.message, true); return; }
  }
  try {
    const r = await hochladen(f);
    if (zweck === 'beleg') {
      if (r.schon_beleg) { toast(`Этот снимок уже загружен как ${r.schon_beleg}.`, true); return; }
      state.entwurf.sha = r.sha; sichereEntwurf();
    } else if (zweck.startsWith('quittung:')) {
      await tun(() => senden(`quittung/${zweck.split(':')[1]}/foto`, { sha: r.sha }), 'Фото подписи сохранено. Оригинал сдайте в офис.');
      return;
    } else state.upload[zweck] = r.sha;
    render(); toast('Файл загружен и сохранён на сервере.');
  } catch (e) {
    if (zweck === 'beleg' && e.netz) { render(); toast('Нет связи. Фото сохранено на телефоне и уйдёт вместе с чеком.'); }
    else { render(); toast(e.message, true); }
  }
});

root.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled || state.busy) return;
  if (b.dataset.submit) { const f = b.closest('form'); if (f.reportValidity()) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return; }
  message.innerHTML = '';
  if (b.dataset.nav) { state.page = b.dataset.nav; state.selected = null; state.modal = null; merken(); if (state.page === 'bank') { state.bank = null; ladeBank(); } }
  else if (b.dataset.record) { state.selected = b.dataset.record; if (modus() === 'mobile') { const id = b.dataset.record.slice(1); if (b.dataset.record[0] === 'b') state.modal = 'document:' + id; } else if (b.dataset.record[0] === 'r' && state.page === 'requests') state.modal = null; }
  else if (b.dataset.filter) { state.filter = b.dataset.filter; merken(); }
  else if (b.dataset.mobile) { state.mobile = b.dataset.mobile; state.modal = null; if (b.dataset.mobile === 'add' && !(state.entwurf && state.entwurf.rueckfrage_id)) state.entwurf = state.entwurf || { kind: 'fuel', idem: neuIdem() }; }
  else if (b.dataset.kind) { state.entwurf.kind = b.dataset.kind; state.entwurf.ziel = null; sichereEntwurf(); }
  else {
    const [act, x, y] = String(b.dataset.action || '').split(':');
    const nachher = () => { state.modal = null; };
    switch (act) {
      case 'close': state.modal = null; break;
      case 'nav': state.page = x; state.selected = null; state.modal = null; merken(); if (x === 'bank') { state.bank = null; ladeBank(); } break;
      case 'approve': return void tun(() => senden(`beleg/${x}/pruefen`, { ergebnis: 'ok' }), r => r.wiederholt ? 'Уже проверено.' : 'Чек проверен. Возмещение (если нужно) ещё не выплачено.');
      case 'personal': { const p = records().find(r => r.b && r.b.zahlart === 'privat'); state.page = 'inbox'; if (p) state.selected = p.id; break; }
      case 'addexpense': state.mobile = 'add'; state.modal = null; state.entwurf = state.entwurf && !state.entwurf.rueckfrage_id ? state.entwurf : { kind: 'fuel', idem: neuIdem() }; break;
      case 'uploadForRequest': { const r = D().rueckfragen.find(z => String(z.id) === x); state.entwurf = { kind: r && r.beleg_art === 'material' ? 'material' : 'fuel', idem: neuIdem(), rueckfrage_id: Number(x), payment: 'firmenkarte' }; state.mobile = 'add'; state.modal = null; sichereEntwurf(); break; }
      case 'foto': return void fotoWaehlen(y ? x + ':' + y : x);
      case 'receive': return void tun(() => senden(`bewegung/${x}/bestaetigen`, {}), 'Получение подтверждено. Остаток обновлён.');
      case 'ausgeben': return void tun(() => senden(`quittung/${x}/ausgeben`, {}).then(r => { state.modal = 'quittung:' + x; return r; }), r => `Выдано по квитанции ${r.nr}. Подпись получателя — на бумаге, затем фото.`);
      case 'original': return void tun(() => senden(`quittung/${x}/original`, {}), 'Оригинал отмечен как принятый.');
      case 'originale': { const p = D().pakete.find(z => String(z.id) === x); return void tun(async () => { for (const v of p.verrechnungen) if (!v.original) await senden(`quittung/${v.quittung_id}/original`, {}); return {}; }, 'Оригиналы приняты.'); }
      case 'storno': return void tun(() => senden(`quittung/${x}/storno`, { grund: 'Аннулирована бухгалтерией' }), 'Квитанция аннулирована.').then(nachher);
      case 'erstattungweg': return void tun(() => senden(`erstattung/${x}/weg`, { weg: y }), y === 'bar' ? 'Возмещение наличными: Олег выдаст по квитанции.' : 'Возмещение переводом: ждёт согласования Олега.');
      case 'erstattungbar': return void tun(() => senden(`erstattung/${x}/bar`, {}).then(r => { state.modal = 'quittung:' + r.id; return r; }), r => `Возмещено наличными, квитанция ${r.nr}. Бланк — для подписи.`);
      case 'druck': window.open(`/api/k/${x}/${y}/druck`, '_blank', 'noopener'); return;
      case 'wegwarte': return void idb.del('warteschlange', x).then(warteLaden).then(render);
      case 'erstattungoleg': return void tun(() => senden(`erstattung/${x}/oleg-ok`, {}), 'Перевод возмещения согласован.');
      case 'erstattunggf': return void tun(() => senden(`erstattung/${x}/ueberwiesen`, {}), 'Отмечено: перевод внесён в банке. Подтверждение банка — отдельно.');
      case 'planeinreichen': return void tun(() => senden(`plan/${x}/einreichen`, {}), 'Заявка подана Андрею.');
      case 'planok': return void tun(() => senden(`plan/${x}/entscheiden`, { genehmigt: true }), 'Список утверждён. Деньги ещё не выданы.').then(nachher);
      case 'planno': return void tun(() => senden(`plan/${x}/entscheiden`, { genehmigt: false }), 'Заявка отклонена.').then(nachher);
      case 'planzeile': state.planZeilen.push({}); break;
      case 'geprueft': return void tun(() => senden(`paket/${x}/geprueft`, {}), 'Документы комплекта проверены.');
      case 'angf': return void tun(() => senden(`paket/${x}/an-gf`, {}), 'Комплект передан Андрею. Уведомления не отправлялись.');
      case 'gesehen': return void tun(() => senden(`paket/${x}/gesehen`, {}), 'Комплект просмотрен. Статус оплаты не изменён.');
      case 'bezahlt': return void tun(() => senden(`paket/${x}/bezahlt`, {}), 'Отмечено: перевод внесён в банке. Подтверждение банка — по операции FinMap.').then(nachher);
      case 'olegok': case 'olegab': { const f = b.closest('form'); const text = f ? f.text.value : ''; return void tun(() => senden(`paket/${x}/oleg`, { status: act === 'olegok' ? 'bestaetigt' : 'abweichung', text }), act === 'olegok' ? 'Объём и стоимость подтверждены.' : 'Расхождение записано. Бухгалтер увидит его в комплекте.').then(nachher); }
      case 'pdf': window.open('/api/k/datei/' + x, '_blank', 'noopener'); return;
      case 'desktop': state.desktopErzwungen = true; break;
      default: state.modal = b.dataset.action;
    }
  }
  render();
  if (state.modal) root.querySelector('.v-modal')?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
});

root.addEventListener('input', e => {
  const f = e.target.closest('form');
  if (f && f.id === 'vav-expense' && state.entwurf) { state.entwurf.amount = f.amount.value; state.entwurf.ziel = f.object.value; state.entwurf.payment = f.payment.value; sichereEntwurf(); }
});
root.addEventListener('change', e => { const f = e.target.closest('form'); if (f && f.id === 'vav-expense' && state.entwurf) { state.entwurf.ziel = f.object.value; state.entwurf.payment = f.payment.value; sichereEntwurf(); } });

const betragOk = s => /^\d{1,9}([.,]\d{1,2})?$/.test(String(s).trim().replace(/\s/g, '')) && Number(String(s).replace(',', '.')) > 0;
root.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, id = f.id, [art, a1] = String(state.modal || '').split(':');
  const idem = state.idem[art + ':' + (a1 || '')];
  const fertig = r => { state.idem[art + ':' + (a1 || '')] = null; state.modal = null; return r; };
  if (id === 'vav-expense') {
    const en = state.entwurf;
    if (!en.sha && !en.foto) return toast('Сначала сфотографируйте чек.', true);
    if (!betragOk(f.amount.value)) return toast('Введите положительную сумму с точностью до цента.', true);
    const ziel = f.object.value;
    const body = { idem: en.idem, art: en.kind === 'fuel' ? 'kraftstoff' : 'material', betrag: f.amount.value, zahlart: f.payment.value, datei_sha: en.sha,
      verwendung: ziel.startsWith('f:') ? 'fahrzeug' : ziel.startsWith('o:') ? 'objekt' : ziel, fahrzeug_ref: ziel.startsWith('f:') ? ziel.slice(2) : null,
      objekt_nr: ziel.startsWith('o:') ? ziel.slice(2) : null, rueckfrage_id: en.rueckfrage_id || undefined };
    delete body.datei_sha;
    return void (async () => {
      const foto = await idb.get('fotos', fotoKey()).catch(() => null);
      if (!foto && !en.sha) return toast('Фото чека не найдено на телефоне — сфотографируйте ещё раз.', true);
      // В очередь: фото + данные + ключ. Отправка — сразу, а без связи — позже.
      await idb.put('warteschlange', { idem: en.idem, login: D().ich.login, body, sha: en.sha || null, blob: foto && foto.blob, mime: foto && foto.mime, name: foto && foto.name, angelegt: new Date().toISOString() });
      await idb.del('fotos', fotoKey()).catch(() => {});
      state.entwurf = null; sichereEntwurf(); state.mobile = 'home';
      await warteLaden(); render();
      toast(navigator.onLine ? 'Отправка чека…' : 'Нет связи. Чек сохранён на телефоне и уйдёт, когда появится связь.');
      await abarbeiten();
      if (state.warte.some(w => w.idem === body.idem && !w.fehler)) toast('Нет связи. Чек сохранён на телефоне и уйдёт, когда появится связь.');
    })();
  }
  if (id === 'vav-request') {
    const b = D().belege.find(x => String(x.id) === a1);
    return void tun(() => senden('rueckfrage', { idem, bezug_art: 'beleg', bezug_id: a1, text: f.text.value }).then(fertig), r => `Запрос ${r.nr} создан. ${r.benachrichtigung || ''}`);
  }
  if (id === 'vav-lost') return void tun(() => senden(`rueckfrage/${a1}/verlust`, { text: f.text.value }).then(fertig), 'Сообщение о потере направлено бухгалтеру и Андрею.');
  if (id === 'vav-rfclose') return void tun(() => senden(`rueckfrage/${a1}/schliessen`, { notiz: f.notiz.value }).then(fertig), 'Запрос закрыт после проверки.');
  if (id === 'vav-rfantwort') return void tun(() => senden(`rueckfrage/${a1}/antwort`, { text: f.text.value, idem }).then(fertig), 'Ответ отправлен. Закроет бухгалтер после проверки.');
  if (id === 'vav-ablehnen') return void tun(() => senden(`beleg/${a1}/pruefen`, { ergebnis: 'abgelehnt', notiz: f.notiz.value }).then(fertig), 'Чек отклонён. Деньги в остаток не возвращены.');
  if (id === 'vav-transfer') {
    if (!betragOk(f.amount.value)) return toast('Введите сумму больше нуля.', true);
    if (art === 'issue') {
      const [zweck] = f.zweck.value.split(':');
      if (zweck === 'nu') return toast('Рабочему подрядчика — только по списку, утверждённому Андреем.', true);
      return void tun(() => senden('quittung/dringend', { idem, empfaenger_ref: f.person.value, zweck, betrag: f.amount.value,
        notiz: f.zweck.value === 'vorschuss:m' ? 'На материалы' : f.zweck.value === 'vorschuss:k' ? 'На топливо' : null }).then(r => { fertig(r); state.modal = 'quittung:' + r.id; return r; }),
        r => `Выдано, квитанция ${r.nr}. Откройте бланк, дайте подписать и сфотографируйте.`);
    }
    if (art === 'return') return void tun(() => senden('rueckgabe', { idem, betrag: f.amount.value }).then(fertig), 'Возврат создан. Касса увеличится после подтверждения бухгалтером.');
    if (istGf()) {
      return void tun(async () => {
        let quelle = f.quelle.value;
        if (quelle === 'neu') quelle = (await senden('abhebung', { idem: idem + ':a', betrag: f.amount.value })).id;
        return fertig(await senden('uebergabe', { idem, quelle_id: quelle, an_konto: f.an.value, betrag: f.amount.value }));
      }, 'Передача создана. Получатель подтвердит получение отдельно.');
    }
    return void tun(() => senden('uebergabe', { idem, von_konto: 'hauptkasse', an_konto: f.an.value, betrag: f.amount.value }).then(fertig), 'Передача создана. Получатель подтвердит получение отдельно.');
  }
  if (id === 'vav-buchbeleg') {
    if (!state.upload.buchbeleg) return toast('Сначала загрузите документ.', true);
    if (!betragOk(f.betrag.value)) return toast('Введите сумму больше нуля.', true);
    const ziel = f.ziel.value;
    return void tun(() => senden('beleg', { idem, person_ref: f.person.value, art: f.art.value, betrag: f.betrag.value, zahlart: f.zahlart.value, belegdatum: f.datum.value,
      datei_sha: state.upload.buchbeleg, dokument_name: f.dokument.value, verwendung: ziel.startsWith('f:') ? 'fahrzeug' : ziel.startsWith('o:') ? 'objekt' : ziel,
      fahrzeug_ref: ziel.startsWith('f:') ? ziel.slice(2) : null, objekt_nr: ziel.startsWith('o:') ? ziel.slice(2) : null }).then(r => { state.upload.buchbeleg = null; return fertig(r); }), r => `Чек ${r.nr} в очереди на проверку.`);
  }
  if (id === 'vav-paket') {
    if (!state.upload.paket) return toast('Сначала загрузите счёт.', true);
    if (!betragOk(f.brutto.value)) return toast('Введите полную сумму счёта.', true);
    return void tun(() => senden('paket', { idem, lieferant_name: f.lieferant.value, rechnung_nr: f.nr.value, rechnungsdatum: f.datum.value, brutto: f.brutto.value,
      objekt_nr: f.objekt.value || null, mail_item_id: f.mail.value || null, datei_sha: state.upload.paket }).then(r => { state.upload.paket = null; state.page = 'invoices'; state.selected = 'p' + r.id; return fertig(r); }), r => `Комплект ${r.nr} создан. Дальше: подтверждение Олега и зачёт квитанций.`);
  }
  if (id === 'vav-verrechnen') return void tun(() => senden(`paket/${a1}/verrechnen`, { quittung_id: f.quittung.value, betrag: f.betrag.value || null }), r => `Зачтено. Остаток к оплате ${money(r.zu_zahlen)}.`);
  if (id === 'vav-iban') return void tun(() => senden(`paket/${a1}/iban`, { iban: f.iban.value, quelle: f.quelle.value }), 'Реквизиты сохранены с источником.');
  if (id === 'vav-olegdoc') {
    if (!state.upload.olegdoc) return toast('Загрузите письменное подтверждение Олега.', true);
    return void tun(() => senden(`paket/${a1}/oleg`, { status: 'bestaetigt', text: f.text.value, datei_sha: state.upload.olegdoc }).then(r => { state.upload.olegdoc = null; return r; }), 'Подтверждение Олега зафиксировано.');
  }
  if (id === 'vav-nu') return void tun(() => senden(`quittung/${a1}/nu-bestaetigt`, { notiz: f.notiz.value }), 'Подтверждение подрядчика записано.');
  if (id === 'vav-plan') {
    const zeilen = (state.planZeilen || [{}]).map((z, i) => ({ empfaenger_ref: f['p' + i].value, betrag: f['b' + i].value, zweck: f['z' + i].value }));
    if (zeilen.some(z => !betragOk(z.betrag))) return toast('В каждой строке нужна сумма больше нуля.', true);
    return void tun(() => senden('plan', { idem, titel: f.titel.value, zeilen }).then(r => { state.planZeilen = null; return fertig(r); }), r => `Заявка ${r.nr}: ${r.quittungen.length} ${plural(r.quittungen.length, 'квитанция', 'квитанции', 'квитанций')} подготовлено. Деньги не выданы.`);
  }
  if (id === 'vav-banklink') {
    const [zielArt, zielId] = f.ziel.value.split(':');
    return void tun(async () => {
      try { return await senden('bank/link', { finmap_op: a1, ziel_art: zielArt, ziel_id: zielId }); }
      catch (err) {
        if (!/не совпадает/.test(err.message)) throw err;
        const notiz = prompt(err.message + '\n\nЕсли связь всё равно верна, опишите причину:');
        if (!notiz) throw err;
        return senden('bank/link', { finmap_op: a1, ziel_art: zielArt, ziel_id: zielId, trotz_abweichung: true, notiz });
      }
    }, r => r.status === 'abgeglichen' ? 'Связано: суммы совпали.' : 'Связано с пометкой «расхождение». Это не подтверждение банка.').then(nachher2);
  }
  if (id === 'vav-bankrf') {
    const op = (state.bank.liste || []).find(o => String(o.id) === a1);
    return void tun(() => senden('rueckfrage', { idem, bezug_art: 'bank', bezug_id: a1, titel: 'Не хватает чека', betrag: op.betrag, bezugsdatum: op.datum,
      person_ref: f.person.value, zahlart_text: 'Карта фирмы', text: 'Пришлите чек по операции банка ' + tagMonat(op.datum) + ' на ' + money(op.betrag) + '.' }).then(fertig), r => `Запрос ${r.nr} создан.`);
  }
});
function nachher2() { state.modal = null; render(); }

/* ---------------- старт ---------------- */
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { await laden(); breite = modus(); render(); abarbeiten(); }
  catch (e) {
    if (!e.netz) { screen.innerHTML = `<div class="v-note">${esc(e.message)}</div>`; return; }
    // Без связи: показываем, что ждёт отправки у этого входа, и ждём сеть.
    let ich = null; try { ich = JSON.parse(localStorage.getItem('buch-ich') || 'null'); } catch (x) { /* нет */ }
    let n = 0; try { n = ich ? (await idb.all('warteschlange')).filter(w => w.login === ich.login).length : 0; } catch (x) { /* нет */ }
    screen.innerHTML = `<div class="v-mobilewrap"><div class="v-phone"><div class="v-phonehead"><div class="v-logo"><span class="v-mark">V</span>VAV · БУХГАЛТЕР</div><span class="v-avatar">${esc(ich ? ich.kurz : '')}</span></div><div class="v-phonebody"><h1>Нет связи</h1><p class="v-small" style="margin-top:8px">${n ? `${n} ${plural(n, 'чек сохранён', 'чека сохранены', 'чеков сохранено')} на телефоне и ${n === 1 ? 'уйдёт' : 'уйдут'}, когда появится связь.` : 'Данные появятся, когда восстановится связь.'}</p></div></div></div>`;
    addEventListener('online', async () => { try { await laden(); breite = modus(); render(); abarbeiten(); } catch (x) { /* ещё нет связи */ } }, { once: true });
  }
})();
})();
