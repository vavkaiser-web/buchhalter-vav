/* Визуальное сравнение реализации /arbeit с утверждённым эталоном.
   Эталон: design/buchhalter-vav/preview.html (не меняется), тот же Chrome,
   та же ширина. Сравниваются одинаковые области: .v-app (компьютер) и
   телефонная карточка от шапки .v-phonehead (строка «09:41 Демо» — часть
   макета-рамки, в продукте её нет). Результат: visual/out/*.png + report.json.
   Запуск: node tools/visual.js  (демо-сервер на :3126 уже запущен) */
'use strict';
const fs = require('fs');
const path = require('path');
const NM = path.join(__dirname, 'node', 'node_modules');
const { chromium } = require(path.join(NM, 'playwright-core'));
const { PNG } = require(path.join(NM, 'pngjs'));
const pixelmatch = require(path.join(NM, 'pixelmatch'));

const BASE = process.env.BASE || 'http://127.0.0.1:3126';
const PIN = 'demo-2409';
const PREVIEW = 'file:///Users/akais/Documents/agents/design/buchhalter-vav/preview.html';
const PROVIDED = '/Users/akais/Documents/agents/buchhalter-implementation/review-reference';
const OUT = path.join(__dirname, '..', 'visual', 'out');
fs.mkdirSync(OUT, { recursive: true });

const DESKTOP = ['inbox', 'cash', 'requests', 'invoices', 'bank', 'archive'];
const ROLLEN = { worker: 'ma_a', oleg: 'oleg', owner: 'andrej' };
const DESK_NAV = { inbox: 'Рабочий стол', cash: 'Касса и авансы', requests: 'Запросы', invoices: 'К оплате', bank: 'Банк', archive: 'Архив' };

async function referenz(browser, scheme, fall, breite) {
  const ctx = await browser.newContext({ viewport: { width: breite, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(PREVIEW);
  const frame = await (await page.waitForSelector('iframe')).contentFrame();
  await frame.waitForSelector('.v-app, .v-phone');
  await frame.waitForFunction(() => document.querySelector('svg.lucide'));
  if (fall.startsWith('mobile-')) {
    await frame.click('[data-device="mobile"]');
    const rolle = { worker: 'Рабочий', oleg: 'Олег', owner: 'Андрей' }[fall.slice(7)];
    await frame.click(`[data-role] >> text=${rolle}`);
    await frame.waitForFunction(r => [...document.querySelectorAll('[data-role]')].some(b => b.textContent === r && b.getAttribute('aria-pressed') === 'true'), rolle);
  } else if (fall !== 'desktop-inbox') {
    await frame.click(`.v-sidebar button >> text=${DESK_NAV[fall.slice(8)]}`);
  }
  await frame.waitForFunction(() => !document.querySelector('i[data-lucide]'));
  await page.waitForTimeout(150);
  const sel = fall.startsWith('mobile-') ? '.v-phone' : '.v-app';
  const box = await (await frame.$(sel)).boundingBox();
  let clip = { x: box.x, y: box.y, width: box.width, height: box.height };   // boundingBox в iframe уже в координатах страницы
  if (fall.startsWith('mobile-')) {
    const head = await (await frame.$('.v-phonehead')).boundingBox();
    const dy = head.y - box.y; clip = { ...clip, y: clip.y + dy, height: clip.height - dy };
  }
  await page.setViewportSize({ width: breite, height: Math.ceil(clip.y + clip.height + 40) });
  await frame.evaluate(() => document.fonts && document.fonts.ready);
  const full = await page.screenshot({ fullPage: true });
  const bild = await page.screenshot({ clip });
  await ctx.close();
  return { bild, full, clip };
}

async function umsetzung(browser, scheme, fall, breite) {
  const ctx = await browser.newContext({ viewport: { width: breite, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const login = fall.startsWith('mobile-') ? ROLLEN[fall.slice(7)] : 'buch';
  const r = await ctx.request.post(BASE + '/api/login', { data: { login, pin: PIN } });
  if (r.status() !== 200) throw new Error('вход ' + login + ' ' + r.status());
  const page = await ctx.newPage();
  const fehler = [];
  page.on('pageerror', e => fehler.push(e.message));
  page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.goto(BASE + '/arbeit');
  await page.waitForSelector('.v-app, .v-phone');
  if (fall.startsWith('desktop-') && fall !== 'desktop-inbox') await page.click(`.v-sidebar button[data-nav="${fall.slice(8)}"]`);
  if (fall === 'desktop-inbox') await page.click('.v-sidebar button[data-nav="inbox"]');
  if (fall === 'desktop-bank') await page.waitForFunction(() => !document.body.innerText.includes('Загрузка…'));
  await page.waitForFunction(() => !document.querySelector('i[data-lucide]'));
  await page.waitForTimeout(150);
  const el = await page.$(fall.startsWith('mobile-') ? '.v-phone' : '.v-app') || await page.$('.v-app, .v-phone');
  let box = await el.boundingBox();
  await page.setViewportSize({ width: breite, height: Math.ceil(box.y + box.height + 40) });
  const kopf = fall.startsWith('mobile-') && await page.$('.v-phone .v-phonehead');
  if (kopf) { const h = await kopf.boundingBox(); box = { ...box, y: h.y, height: box.height - (h.y - box.y) }; }   // как у эталона: от шапки
  const full = await page.screenshot({ fullPage: true });
  const bild = await page.screenshot({ clip: box });
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await ctx.close();
  return { bild, full, box, fehler, ueberlauf };
}

function vergleich(aBuf, bBuf, name) {
  const a = PNG.sync.read(aBuf), b = PNG.sync.read(bBuf);
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const crop = (img) => { const o = new PNG({ width: w, height: h }); PNG.bitblt(img, o, 0, 0, w, h, 0, 0); return o; };
  const ca = crop(a), cb = crop(b), diff = new PNG({ width: w, height: h });
  const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.1 });
  // Бок о бок: эталон | реализация | различия.
  const H = Math.max(a.height, b.height), side = new PNG({ width: a.width + b.width + w + 40, height: H });
  side.data.fill(255);
  PNG.bitblt(a, side, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, side, 0, 0, b.width, b.height, a.width + 20, 0);
  PNG.bitblt(diff, side, 0, 0, w, h, a.width + b.width + 40, 0);
  fs.writeFileSync(path.join(OUT, name + '-vergleich.png'), PNG.sync.write(side));
  return { abweichung_prozent: +(100 * n / (w * h)).toFixed(2), groesse_referenz: [a.width, a.height], groesse_umsetzung: [b.width, b.height] };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const bericht = { erstellt: new Date().toISOString(), faelle: {}, referenz_check: {}, breiten: {} };
  const faelle = [...DESKTOP.map(d => ['desktop-' + d, 1100]), ...Object.keys(ROLLEN).map(r => ['mobile-' + r, 400])];
  for (const scheme of ['light', 'dark']) {
    for (const [fall, breite] of faelle) {
      const ref = await referenz(browser, scheme, fall, breite);
      const neu = await umsetzung(browser, scheme, fall, breite);
      const name = `${fall}-${scheme}`;
      fs.writeFileSync(path.join(OUT, name + '-referenz.png'), ref.bild);
      fs.writeFileSync(path.join(OUT, name + '-umsetzung.png'), neu.bild);
      fs.writeFileSync(path.join(OUT, name + '-umsetzung-seite.png'), neu.full);
      bericht.faelle[name] = { ...vergleich(ref.bild, neu.bild, name), js_fehler: neu.fehler, horizontaler_ueberlauf: neu.ueberlauf };
      // Эталон в этом Chrome совпадает с присланными снимками?
      const given = path.join(PROVIDED, fall + '.png');
      if (scheme === 'light' && fs.existsSync(given)) {
        const g = PNG.sync.read(fs.readFileSync(given)), f = PNG.sync.read(ref.full);
        const w = Math.min(g.width, f.width), h = Math.min(g.height, f.height);
        const c = img => { const o = new PNG({ width: w, height: h }); PNG.bitblt(img, o, 0, 0, w, h, 0, 0); return o; };
        bericht.referenz_check[fall] = +(100 * pixelmatch(c(g).data, c(f).data, null, w, h, { threshold: 0.1 }) / (w * h)).toFixed(2);
      }
      console.log(name, JSON.stringify(bericht.faelle[name]));
    }
  }
  // Обязательные ширины: нет горизонтальной прокрутки, нет ошибок.
  for (const breite of [320, 340, 390, 768, 1024, 1440]) {
    for (const fall of ['desktop-inbox', 'desktop-cash', 'desktop-invoices', 'mobile-worker', 'mobile-oleg', 'mobile-owner']) {
      const neu = await umsetzung(browser, 'light', fall, breite);
      fs.writeFileSync(path.join(OUT, `breite-${breite}-${fall}.png`), neu.full);
      bericht.breiten[`${breite}-${fall}`] = { ueberlauf: neu.ueberlauf, js_fehler: neu.fehler };
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(bericht, null, 1));
  console.log('referenz_check', JSON.stringify(bericht.referenz_check));
  console.log('breiten mit ueberlauf:', Object.entries(bericht.breiten).filter(([, v]) => v.ueberlauf || v.js_fehler.length).map(([k]) => k));
})().catch(e => { console.error(e); process.exit(1); });
