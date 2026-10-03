/* Навигация — единый сгруппированный nav для всех страниц. */
(function () {
  'use strict';
  var p = window.location.pathname;
  var nav = document.querySelector('nav.nav');
  if (nav) {
    var BANK  = ['/bank','/debitor','/zahlungen','/arbeit','/kassepruefung','/pflichten'];
    var DOCS  = ['/dokument','/rechnung','/dubletten','/kostenverteilung','/dokumente','/objekt','/verteilen'];
    var PERD  = ['/monat','/paket','/fragen','/anfang'];
    var SYS   = ['/aufgaben','/korrektur','/benachrichtigung','/integrationen','/zugang'];
    function grp(list){ return list.some(function(x){ return p===x||p.startsWith(x+'/'); }); }
    function a(href,label,akt){ return '<a href="'+href+'"'+(akt?' class="akt"':'')+'>'+label+'</a>'; }
    function dd(items){ return '<div class="nav-dd">'+items.map(function(x){ return a(x[0],x[1],p===x[0]); }).join('')+'</div>'; }
    function grpEl(href,label,akt,items){ return '<div class="nav-g">'+a(href,label,akt)+dd(items)+'</div>'; }

    var s = document.createElement('style'); s.id = 'navg';
    s.textContent = '.nav{flex-wrap:nowrap!important;border-bottom:1px solid var(--line,#e6e1d7);margin-bottom:4px}'
     +'.nav-g{position:relative}.nav-g>a{display:flex;align-items:center;gap:3px}'
     +'.nav-g>a::after{content:"▾";font-size:10px;opacity:.6}'
     +'.nav-g:hover>a,.nav-g:focus-within>a{background:var(--surface2,#faf8f4)}'
     +'.nav-dd{display:none;position:absolute;top:calc(100% + 4px);left:0;min-width:190px;background:var(--surface,#fff);border:1px solid var(--line,#e6e1d7);border-radius:11px;box-shadow:0 6px 24px rgba(20,30,40,.13);z-index:200;padding:5px}'
     +'.nav-g:hover .nav-dd,.nav-g:focus-within .nav-dd{display:block}'
     +'.nav-dd a{display:block;padding:8px 12px;border-radius:8px;font-size:13px;font-weight:500;border:none!important;color:var(--muted,#5c6773);white-space:nowrap}'
     +'.nav-dd a.akt,.nav-dd a:hover{background:var(--surface2,#faf8f4);color:var(--ink,#1b2530)}';
    if (!document.getElementById('navg')) document.head.appendChild(s);

    nav.innerHTML =
      a('/zentrum','Центр', p==='/'||p==='/zentrum')
      + grpEl('/bank','Банк · Деньги',grp(BANK),[
          ['/bank','Сверка банка'],['/debitor','Дебиторка'],
          ['/zahlungen','Платежи'],['/arbeit','Касса'],
          ['/kassepruefung','Проверка кассы'],['/pflichten','Неотправленные чеки']])
      + grpEl('/dokument','Счета · Документы',grp(DOCS),[
          ['/rechnung','Счета vs заказы'],['/dokument','Полнота документов'],
          ['/dubletten','Проверка дублей'],['/kostenverteilung','Распределение'],
          ['/dokumente','Архив документов'],['/objekt','Объекты']])
      + grpEl('/monat','Периоды · SB',grp(PERD),[
          ['/monat','Проверка месяцев'],['/paket','Комплекты SB'],
          ['/fragen','Вопросы SB'],['/anfang','Начальные остатки']])
      + grpEl('/aufgaben','Система',grp(SYS),[
          ['/aufgaben','Задачи'],['/korrektur','Исправления'],
          ['/benachrichtigung','Уведомления'],['/integrationen','Интеграции'],
          ['/zugang','Доступ и журнал']])
      + '<span class="sp"></span>'
      + '<a href="/api/logout" class="aus">Выйти</a>';
  }
})();

/* Тест-переключатель ролей внутри приложения (только локальное демо).
   Плавающая панель: меняет роль реальным входом и перезагружает экран,
   чтобы прогонять задачу от лица разных людей, не выходя из приложения. */
(function () {
  'use strict';
  var ROLLEN = [
    ['andrej', 'Владелец'], ['buch', 'Бухгалтер'],
    ['oleg', 'Ответственный 1'], ['oleg2', 'Ответственный 2'],
    ['ma_a', 'Сотрудник А'], ['ma_b', 'Сотрудник Б'],
  ];
  var label = {}; ROLLEN.forEach(function (r) { label[r[0]] = r[1]; });

  var css = '#rw{position:fixed;right:14px;bottom:14px;z-index:99999;font:600 13px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
    + '#rw *{box-sizing:border-box}'
    + '#rw .rwbtn{display:flex;align-items:center;gap:8px;background:#14586e;color:#fff;border:0;border-radius:999px;'
    + 'padding:9px 14px;cursor:pointer;box-shadow:0 4px 16px rgba(20,40,50,.28)}'
    + '#rw .rwbtn small{opacity:.8;font-weight:500}'
    + '#rw .rwm{position:absolute;right:0;bottom:46px;background:#fff;color:#1b2530;border:1px solid #e0dccf;'
    + 'border-radius:12px;box-shadow:0 12px 34px rgba(20,30,40,.22);padding:6px;min-width:190px;display:none}'
    + '#rw.auf .rwm{display:block}'
    + '#rw .rwm .rwt{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#8a8577;padding:6px 9px 4px}'
    + '#rw .rwm button{display:block;width:100%;text-align:left;background:none;border:0;border-radius:8px;'
    + 'padding:9px 10px;cursor:pointer;color:#1b2530;font:inherit}'
    + '#rw .rwm button:hover{background:#f2efe9}'
    + '#rw .rwm button.akt{background:#14586e;color:#fff}'
    + '@media(prefers-color-scheme:dark){#rw .rwm{background:#1a2129;color:#e9edf1;border-color:#2a333d}'
    + '#rw .rwm button{color:#e9edf1}#rw .rwm button:hover{background:#222b34}}';

  function bauen(aktiv) {
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    var box = document.createElement('div'); box.id = 'rw';
    var b = document.createElement('button'); b.className = 'rwbtn';
    b.innerHTML = '<small>роль · тест</small> <span id="rwname">' + (label[aktiv] || '—') + '</span> ▾';
    var m = document.createElement('div'); m.className = 'rwm';
    m.innerHTML = '<div class="rwt">Войти как</div>' + ROLLEN.map(function (r) {
      return '<button data-l="' + r[0] + '"' + (r[0] === aktiv ? ' class="akt"' : '') + '>' + r[1] + '</button>';
    }).join('');
    box.appendChild(b); box.appendChild(m); document.body.appendChild(box);
    b.addEventListener('click', function (e) { e.stopPropagation(); box.classList.toggle('auf'); });
    document.addEventListener('click', function () { box.classList.remove('auf'); });
    m.addEventListener('click', function (e) {
      var t = e.target.closest('button[data-l]'); if (!t) return;
      t.textContent = '…';
      fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: t.dataset.l, pin: 'demo-2409' }) })
        .then(function (r) { if (r.ok) location.reload(); else t.textContent = 'ошибка'; })
        .catch(function () { t.textContent = 'ошибка'; });
    });
  }

  fetch('/api/k/ich', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (j) { bauen(j.login || ''); })
    .catch(function () { bauen(''); });
})();
