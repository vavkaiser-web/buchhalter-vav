/* Печатный бланк квитанции: одна квитанция — одна страница. Бумага нужна
   для подписи получателя; приложение фиксирует только выдачу и фото подписи.
   Текст о зачёте для подрядчика — проект формулировки, не правовое заключение. */
'use strict';
const { euro } = require('./geld.js');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ZWECK = { vorschuss: 'Аванс на расходы · Vorschuss für Auslagen', lohn: 'Зарплата / аванс по зарплате · Lohn / Lohnvorschuss',
  erstattung: 'Возмещение личных расходов · Erstattung von Auslagen', nu: 'Выплата рабочему подрядчика · Barzahlung an Arbeiter des Nachunternehmers' };
const datum = d => d ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '';

function status(q) {
  if (q.status === 'storniert') return ['АННУЛИРОВАНА · STORNIERT — не выдавать', 'bad'];
  if (q.status === 'ausgegeben') return [`ВЫДАНА · AUSGEZAHLT ${datum(q.ausgegeben_am)}${q.dringend ? ' · срочная выдача' : ''}`, 'good'];
  if (q.plan_status === 'genehmigt') return ['ПОДГОТОВЛЕНА · список утверждён · деньги ещё НЕ выданы', 'warn'];
  return ['ПОДГОТОВЛЕНА · список НЕ утверждён · деньги НЕ выдавать', 'bad'];
}

function seite(q) {
  const [st, kl] = status(q);
  return `<section class="blatt">
<header><div><strong>VAV Kaiser GmbH</strong><br><span>Nürnberg</span></div><div class="nr">Квитанция · Quittung<br><b>${esc(q.nr)}</b></div></header>
<p class="status ${kl}">${esc(st)}</p>
<table>
<tr><th>Получатель · Empfänger</th><td>${esc(q.empfaenger)}</td></tr>
${q.nu_name ? `<tr><th>Подрядчик · Nachunternehmer</th><td>${esc(q.nu_name)}</td></tr>` : ''}
<tr><th>Сумма · Betrag</th><td class="betrag">${euro(q.betrag)}</td></tr>
<tr><th>Назначение · Zweck</th><td>${esc(ZWECK[q.zweck] || q.zweck)}${q.notiz ? ' — ' + esc(q.notiz) : ''}</td></tr>
<tr><th>Подготовлена · erstellt</th><td>${datum(q.angelegt)}${q.plan_nr ? ' · заявка ' + esc(q.plan_nr) : ''}</td></tr>
<tr><th>Дата выдачи · Datum der Auszahlung</th><td>${q.ausgegeben_am ? datum(q.ausgegeben_am) : '____ . ____ . ________'}</td></tr>
</table>
${q.zweck === 'nu' ? '<p class="hinweis">Проект формулировки: сумма будет зачтена в счёт подрядчика за работы по предварительной письменной договорённости; полная стоимость работ в счёте не уменьшается. Entwurf, rechtlich nicht geprüft.</p>' : ''}
<p class="text">Сумму ${euro(q.betrag)} наличными получил(а). · Den Betrag von ${euro(q.betrag)} in bar erhalten.</p>
<div class="unterschriften"><div>${q.unterschrift ? `<img src="${q.unterschrift}" class="sig-img">` : '<span></span>'}Подпись получателя · Unterschrift Empfänger</div><div><span></span>Выдал(а) · Ausgezahlt von</div></div>
<footer>Оригинал сдать в офис. Фото подписанной квитанции загрузить в приложение. · Original ins Büro.</footer>
</section>`;
}

function html(liste) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Квитанции ${esc(liste.map(q => q.nr).join(', '))}</title>
<style>
:root{color-scheme:light}body{margin:0;background:#ebe7df;font:14px/1.45 -apple-system,system-ui,'Segoe UI',sans-serif;color:#201f1b}
.leiste{position:sticky;top:0;display:flex;gap:10px;justify-content:center;padding:12px;background:#fcfaf6;border-bottom:1px solid #ded9cf}
.leiste button{padding:10px 16px;border-radius:8px;border:1px solid #14455e;background:#14455e;color:#fffdf9;font:inherit;cursor:pointer}
.leiste button.sek{background:#fff;color:#14455e}
.blatt{box-sizing:border-box;width:min(190mm,100% - 24px);min-height:130mm;margin:16px auto;padding:14mm;background:#fff;border:1px solid #ded9cf}
header{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid #201f1b;padding-bottom:8px}.nr{text-align:right}.nr b{font-size:20px}
.status{font-weight:700;padding:6px 10px;border-radius:6px;margin:12px 0}.good{background:#e7efe8;color:#35674e}.warn{background:#f4ead8;color:#896021}.bad{background:#f6e5e0;color:#9a4035}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{text-align:left;padding:7px 4px;border-bottom:1px solid #ded9cf;vertical-align:top}th{width:42%;font-weight:500;color:#69675f}.betrag{font-size:20px;font-weight:700}
.hinweis{font-size:12px;color:#69675f}.text{margin:14px 0}
.unterschriften{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:34px}.unterschriften span{display:block;border-bottom:1px solid #201f1b;height:38px;margin-bottom:4px}.sig-img{display:block;max-height:50px;max-width:100%;border-bottom:1px solid #201f1b;margin-bottom:4px;object-fit:contain}.unterschriften div{font-size:12px;color:#69675f}
footer{margin-top:20px;font-size:11px;color:#69675f}
@media print{body{background:#fff}.leiste{display:none}.blatt{margin:0;border:0;width:auto;page-break-after:always;break-after:page}}
</style></head><body><div class="leiste"><button id="btn-izm" class="sek" onclick="aendern()">← Изменить</button><button onclick="drucken()">Печать · Drucken</button></div>${liste.map(seite).join('')}<script>function drucken(){document.getElementById('btn-izm')?.remove();print();}function aendern(){window.close();}</script></body></html>`;
}

module.exports = { html };
