/* Живая проверка демо-сервера :3126: вход сотрудника, чек без сети,
   перезагрузка без сети, сеть → ровно один чек. Меняет только демо-базу. */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require(path.join(__dirname, 'node/node_modules/playwright-core'));
const B = 'http://127.0.0.1:3126';
const sql = t => execFileSync('/opt/homebrew/opt/libpq/bin/psql', ['postgres://buch@127.0.0.1:55481/buchdemo', '-qtA', '-c', t], { encoding: 'utf8' }).trim();
(async () => {
  const br = await chromium.launch({ channel: 'chrome' });
  const ctx = await br.newContext({ viewport: { width: 400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(B + '/arbeit');
  console.log('1. без входа →', new URL(page.url()).pathname + new URL(page.url()).search);
  await ctx.request.post(B + '/api/login', { data: { login: 'ma_a', pin: 'demo-2409' } });
  await page.goto(B + '/arbeit'); await page.waitForSelector('.v-phone');
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.waitForSelector('.v-phone');
  await page.click('[data-action="addexpense"]');
  await ctx.setOffline(true);
  const [ch] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="foto:beleg"]')]);
  await ch.setFiles({ name: 'check.jpg', mimeType: 'image/jpeg', buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), require('crypto').randomBytes(64)]) });
  await page.fill('input[name="amount"]', '9,99'); await page.click('[data-submit="yes"]');
  await page.waitForSelector('text=Чек сохранён на телефоне');
  console.log('2. без сети: чек в очереди телефона; в базе:', sql(`SELECT count(*) FROM mailops_prod.buch_beleg WHERE betrag_cent = 999`));
  await page.reload(); await page.waitForSelector('text=Нет связи');
  console.log('3. перезагрузка без сети:', (await page.textContent('.v-phonebody')).trim());
  await ctx.setOffline(false);
  await page.waitForFunction(() => document.body.innerText.includes('Отправлено из очереди'), null, { timeout: 20000 });
  console.log('4. сеть есть: в базе чеков 9,99 € =', sql(`SELECT count(*) FROM mailops_prod.buch_beleg WHERE betrag_cent = 999`));
  await br.close();
})().catch(e => { console.error('ОШИБКА', e.message); process.exit(1); });
