/* Quittungsdruck: eine Quittung pro Seite. Papier für Unterschrift des Empfängers.
   Hinweis zur Aufrechnung beim Nachunternehmer – Projektentwurf, kein Rechtsgutachten. */
'use strict';
const { euro } = require('./geld.js');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ZWECK = {
  vorschuss:  'Vorschuss für Auslagen',
  lohn:       'Lohn / Lohnvorschuss',
  erstattung: 'Erstattung von Auslagen',
  nu:         'Barzahlung an Arbeiter des Nachunternehmers',
};
const datum = d => d ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '';

function status(q) {
  if (q.status === 'storniert') return ['STORNIERT — nicht auszahlen', 'bad'];
  if (q.status === 'ausgegeben') return [`AUSGEZAHLT ${datum(q.ausgegeben_am)}${q.dringend ? ' · Sofortzahlung' : ''}`, 'good'];
  if (q.plan_status === 'genehmigt') return ['VORBEREITET · Liste genehmigt · Geld noch NICHT ausgezahlt', 'warn'];
  return ['VORBEREITET · Liste noch NICHT genehmigt · NICHT auszahlen', 'bad'];
}

function seite(q) {
  const [st, kl] = status(q);
  return `<section class="blatt">
<header><div><strong>VAV Kaiser GmbH</strong><br><span>Nürnberg</span></div><div class="nr">Quittung<br><b>${esc(q.nr)}</b></div></header>
<p class="status ${kl}">${esc(st)}</p>
<table>
<tr><th>Empfänger</th><td>${esc(q.empfaenger)}</td></tr>
${q.nu_name ? `<tr><th>Nachunternehmer</th><td>${esc(q.nu_name)}</td></tr>` : ''}
<tr><th>Betrag</th><td class="betrag">${euro(q.betrag)}</td></tr>
<tr><th>Zweck</th><td>${esc(ZWECK[q.zweck] || q.zweck)}${q.notiz ? ' — ' + esc(q.notiz) : ''}</td></tr>
<tr><th>Erstellt am</th><td>${datum(q.angelegt)}${q.plan_nr ? ' · Antrag ' + esc(q.plan_nr) : ''}</td></tr>
<tr><th>Datum der Auszahlung</th><td>${q.ausgegeben_am ? datum(q.ausgegeben_am) : '____ . ____ . ________'}</td></tr>
</table>
${q.zweck === 'nu' ? '<p class="hinweis">Entwurf: Der Betrag wird gegen die Forderung des Nachunternehmers für Arbeiten lt. schriftlicher Vereinbarung aufgerechnet; der Rechnungsbetrag wird nicht gemindert. Rechtlich nicht geprüft.</p>' : ''}
<p class="text">Den Betrag von ${euro(q.betrag)} in bar erhalten.</p>
<div class="unterschriften"><div>${q.unterschrift ? `<img src="${q.unterschrift}" class="sig-img">` : '<span></span>'}Unterschrift Empfänger</div><div><span></span>Ausgezahlt von</div></div>
<footer>Original ins Büro. Foto der unterschriebenen Quittung in die App hochladen.</footer>
</section>`;
}

function html(liste) {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quittungen ${esc(liste.map(q => q.nr).join(', '))}</title>
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
</style></head><body><div class="leiste"><button id="btn-izm" class="sek" onclick="aendern()">← Zurück</button><button onclick="drucken()">Drucken</button></div>${liste.map(seite).join('')}<script>function drucken(){document.getElementById('btn-izm')?.remove();print();}function aendern(){window.close();}</script></body></html>`;
}

module.exports = { html };
