/* Браузерные сценарии в настоящем Chrome против локального сервера и
   изолированной тестовой базы. Ничего никому не отправляется.
   Запуск: node --test --test-concurrency=1 tests/browser.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { starten, sql, P, jpeg, idem, PIN } = require('./helfer.js');
const { chromium } = require(path.join(__dirname, '..', 'tools', 'node', 'node_modules', 'playwright-core'));

let s, browser;
test.before(async () => { s = await starten(); browser = await chromium.launch({ channel: 'chrome' }); });
test.after(async () => { if (browser) await browser.close(); if (s) s.stop(); });

async function anmelden(login, opt) {
  const ctx = await browser.newContext({ viewport: opt && opt.viewport || { width: 400, height: 900 }, serviceWorkers: 'allow' });
  await ctx.request.post(s.basis + '/api/login', { data: { login, pin: PIN } });
  const page = await ctx.newPage();
  const fehler = [];
  page.on('pageerror', e => fehler.push(e.message));
  await page.goto(s.basis + '/arbeit');
  await page.waitForSelector('.v-phone, .v-app');
  return { ctx, page, fehler };
}
async function foto(page, knopf) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(knopf)]);
  await chooser.setFiles({ name: 'chek.jpg', mimeType: 'image/jpeg', buffer: jpeg() });
}
const anzahl = where => Number(sql(`SELECT count(*) FROM mailops_prod.buch_beleg WHERE ${where}`));

test('Офлайн: фото и чек сохраняются на телефоне → перезагрузка без сети → сеть → ровно один чек', async () => {
  const { ctx, page, fehler } = await anmelden('ma_a');
  // Дождаться service worker, чтобы /arbeit открывался без сети.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); await page.waitForSelector('.v-phone');
  await page.waitForFunction(() => navigator.serviceWorker.controller);

  await page.click('[data-action="addexpense"]');
  await ctx.setOffline(true);
  await foto(page, '[data-action="foto:beleg"]');
  await page.waitForSelector('text=Фото сохранено на телефоне');
  await page.fill('input[name="amount"]', '41,23');
  await page.click('[data-submit="yes"]');
  await page.waitForSelector('text=Чек сохранён на телефоне');
  assert.equal(anzahl(`betrag_cent = 4123`), 0, 'без сети на сервер ничего не ушло');

  await page.reload();                                   // без сети: страница из кэша service worker
  await page.waitForSelector('text=Нет связи');
  assert.match(await page.textContent('body'), /1 чек сохранён/);

  await ctx.setOffline(false);                           // сеть вернулась → очередь уходит сама
  await page.waitForFunction(() => document.body.innerText.includes('Отправлено из очереди') || document.body.innerText.includes('передан на проверку'), null, { timeout: 20000 });
  assert.equal(anzahl(`betrag_cent = 4123`), 1, 'ровно один чек');
  await page.reload(); await page.waitForSelector('.v-phone');
  await page.waitForTimeout(500);
  assert.equal(anzahl(`betrag_cent = 4123`), 1, 'повторная загрузка страницы не создаёт дубль');
  assert.deepEqual(fehler, []);
  await ctx.close();
});

test('Фоновая отправка очереди и 30 секунд ожидания не стирают введённое в форме', async () => {
  const { ctx, page } = await anmelden('ma_a');
  await page.click('[data-action="addexpense"]');
  await ctx.setOffline(true);
  await foto(page, '[data-action="foto:beleg"]');
  await page.fill('input[name="amount"]', '12,00');
  await page.click('[data-submit="yes"]');
  await page.waitForSelector('text=Чек сохранён на телефоне');

  // Новый чек начинают заполнять, пока старый ждёт сети.
  await page.click('[data-action="addexpense"]');
  await page.fill('input[name="amount"]', '77,77');
  await ctx.setOffline(false);                           // первая запись уходит в фоне → перерисовка
  await page.waitForFunction(() => document.body.innerText.includes('Отправлено из очереди'), null, { timeout: 20000 });
  assert.equal(await page.inputValue('input[name="amount"]'), '77,77', 'ввод пережил фоновую отправку');
  await page.waitForTimeout(31000);                      // таймер очереди (30 с) при пустой очереди экран не трогает
  assert.equal(await page.inputValue('input[name="amount"]'), '77,77', 'ввод пережил 30 секунд');
  assert.equal(anzahl(`betrag_cent = 1200`), 1);
  await ctx.close();
});

test('Черновик на общем телефоне не виден другому входу', async () => {
  const a = await anmelden('ma_a');
  await a.page.click('[data-action="addexpense"]');
  await a.page.fill('input[name="amount"]', '55,55');
  await a.page.waitForTimeout(200);
  // Тот же браузер (общий телефон): выход и вход другим сотрудником.
  await a.page.goto(s.basis + '/api/logout');
  await a.ctx.request.post(s.basis + '/api/login', { data: { login: 'ma_b', pin: PIN } });
  await a.page.goto(s.basis + '/arbeit'); await a.page.waitForSelector('.v-phone');
  await a.page.click('[data-action="addexpense"]');
  assert.equal(await a.page.inputValue('input[name="amount"]'), '', 'чужой черновик не показан');
  await a.page.goto(s.basis + '/api/logout');
  await a.ctx.request.post(s.basis + '/api/login', { data: { login: 'ma_a', pin: PIN } });
  await a.page.goto(s.basis + '/arbeit'); await a.page.waitForSelector('.v-phone');
  await a.page.click('[data-action="addexpense"]');
  assert.equal(await a.page.inputValue('input[name="amount"]'), '55,55', 'свой черновик сохранился');
  await a.ctx.close();
});

test('Бухгалтер принимает чек в интерфейсе; двойное нажатие — одно событие; кнопки после действия в правильном состоянии', async () => {
  const f = await s.datei('ma_b');
  const b = await s.post('ma_b', 'beleg', { idem: idem(), art: 'material', betrag: '19,90', verwendung: 'objekt', objekt_nr: 'VK-26-901', zahlart: 'privat', datei_sha: f.body.sha });
  const { ctx, page, fehler } = await anmelden('buch', { viewport: { width: 1100, height: 1000 } });
  await page.click(`[data-record="b${b.body.id}"]`);
  const knopf = page.locator(`[data-action="approve:${b.body.id}"]`);
  await knopf.dblclick();                                   // двойное нажатие
  await page.waitForSelector('text=Чек проверен');
  assert.equal(Number(sql(`SELECT count(*) FROM mailops_prod.buch_ereignis WHERE art = 'beleg_geprueft' AND ziel = 'beleg:${b.body.id}'`)), 1);
  assert.equal(await page.locator(`[data-action="approve:${b.body.id}"]`).count(), 0, 'после проверки — выбор способа возмещения');
  assert.ok(await page.locator('[data-action^="erstattungweg"]').first().isEnabled());
  await page.click(`[data-record="b${b.body.id}"]`);
  assert.deepEqual(fehler, []);
  await ctx.close();
});

test('Печатный бланк: подготовленная квитанция до выдачи и срочная выдача Олегом сразу с бланком', async () => {
  // Деньги Олегу.
  const a = await s.post('andrej', 'abhebung', { betrag: '300,00', idem: idem() });
  const u = await s.post('andrej', 'uebergabe', { quelle_id: a.body.id, an_konto: 'halter:oleg', betrag: '300,00', idem: idem() });
  await s.post('oleg', `bewegung/${u.body.id}/bestaetigen`);
  const plan = await s.post('buch', 'plan', { idem: idem(), zeilen: [{ empfaenger_ref: P.A, zweck: 'vorschuss', betrag: '40,00' }, { empfaenger_ref: P.NU1, zweck: 'nu', betrag: '60,00' }] });
  const druck = await s.api('buch', 'GET', `/api/k/plan/${plan.body.id}/druck`);
  assert.equal(druck.status, 200);
  const html = String(druck.body);
  assert.equal((html.match(/class="blatt"/g) || []).length, 2, 'по бланку на каждого получателя');
  assert.match(html, /ПОДГОТОВЛЕНА · список НЕ утверждён · деньги НЕ выдавать/);
  for (const t of ['Сотрудник А', '40,00', '60,00', 'Рабочий подрядчика 1', 'Подпись получателя', 'Дата выдачи', plan.body.quittungen[0].nr]) assert.ok(html.includes(t), t);
  assert.equal((await s.api('ma_b', 'GET', `/api/k/plan/${plan.body.id}/druck`)).status, 403, 'чужие квитанции не печатаются');

  const { ctx, page } = await anmelden('oleg');
  await page.click('[data-action="issue"]');
  await page.selectOption('select[name="person"]', P.B);
  await page.fill('input[name="amount"]', '25,00');
  await page.selectOption('select[name="zweck"]', 'lohn');
  await page.click('[data-submit="yes"]');
  await page.waitForSelector('text=Бланк для подписи');
  const [blatt] = await Promise.all([ctx.waitForEvent('page'), page.click('text=Бланк для подписи')]);
  await blatt.waitForLoadState();
  const text = await blatt.textContent('body');
  assert.match(text, /ВЫДАНА · AUSGEZAHLT/); assert.match(text, /срочная выдача/);
  assert.match(text, /25,00/); assert.match(text, /Сотрудник Б/); assert.match(text, /Зарплата/);
  await ctx.close();
});

test('Вход: /arbeit → /login?next=/arbeit → /arbeit; чужой next не принимается; выход возвращает на /arbeit-вход', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(s.basis + '/arbeit');
  assert.match(page.url(), /\/login\?next=\/arbeit$/);
  await page.fill('input[type="text"], input[name="login"], #login', 'buch').catch(() => {});
  const r = await page.evaluate(async pin => (await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'buch', pin }) })).status, PIN);
  assert.equal(r, 200);
  const ziel = await page.evaluate(() => new URLSearchParams('?next=/arbeit').get('next') === '/arbeit' ? '/arbeit' : '/');
  assert.equal(ziel, '/arbeit');
  // Логику страницы входа проверяем по её коду: разрешён только /arbeit.
  const quelle = await (await fetch(s.basis + '/login')).text();
  assert.match(quelle, /get\('next'\)==='\/arbeit'\?'\/arbeit':'\/'/);
  const aus = await fetch(s.basis + '/api/logout?next=https://evil.example', { redirect: 'manual' });
  assert.equal(aus.headers.get('location'), '/login');
  const aus2 = await fetch(s.basis + '/api/logout?next=/arbeit', { redirect: 'manual' });
  assert.equal(aus2.headers.get('location'), '/login?next=/arbeit');
  await page.goto(s.basis + '/arbeit'); await page.waitForSelector('.v-app');
  assert.equal(await page.locator('a[href="/api/logout?next=/arbeit"]').count(), 1, 'на компьютере есть выход');
  await ctx.close();
});

test('Общий телефон: вход другого сотрудника в другой вкладке — очередь старого не уходит от нового', async () => {
  const { ctx, page } = await anmelden('ma_a');
  await page.click('[data-action="addexpense"]');
  await ctx.setOffline(true);
  await foto(page, '[data-action="foto:beleg"]');
  await page.fill('input[name="amount"]', '33,33');
  await page.click('[data-submit="yes"]');
  await page.waitForSelector('text=Чек сохранён на телефоне');
  // Пока страница без сети: в «другой вкладке» (общий cookie) выход и вход сотрудником Б.
  // APIRequestContext работает независимо от эмуляции офлайна страницы.
  await ctx.request.get(s.basis + '/api/logout');
  await ctx.request.post(s.basis + '/api/login', { data: { login: 'ma_b', pin: PIN } });
  // Теперь сеть возвращается: устаревший экран сотрудника А с новым cookie сотрудника Б.
  await ctx.setOffline(false);
  await page.waitForSelector('text=вошёл другой пользователь', { timeout: 10000 });
  assert.equal(anzahl(`betrag_cent = 3333`), 0, 'чек сотрудника А не записан на сотрудника Б');
  // Сервер тоже не примет чек с чужим автором очереди.
  const f = await s.datei('ma_b');
  const r = await s.post('ma_b', 'beleg', { idem: idem(), art: 'kraftstoff', betrag: '1,00', verwendung: 'kanister', zahlart: 'privat', datei_sha: f.body.sha, fuer_login: 'ma_a' });
  assert.equal(r.status, 409);
  // Сотрудник А вернулся — его чек уходит один раз и на него.
  await ctx.request.get(s.basis + '/api/logout');
  await ctx.request.post(s.basis + '/api/login', { data: { login: 'ma_a', pin: PIN } });
  await page.goto(s.basis + '/arbeit'); await page.waitForSelector('.v-phone');
  await page.waitForFunction(() => document.body.innerText.includes('Отправлено из очереди'), null, { timeout: 15000 });
  assert.equal(anzahl(`betrag_cent = 3333 AND person_ref = '${P.A}'`), 1);
  await ctx.close();
});
