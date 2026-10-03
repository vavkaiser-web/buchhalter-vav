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
