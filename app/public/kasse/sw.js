/* Касса VAV — Service Worker.
   Офлайн: черновики и фото хранятся в IndexedDB, отправляются при восстановлении сети.
   Окончательная выдача денег и проверка остатков — только при соединении с сервером.
   При выходе из аккаунта — очередь передаётся для ручного решения, не удаляется молча.
*/
const CACHE = 'kasse-vav-v28';
const OFFLINE_ASSETS = ['/kasse/', '/kasse/index.html', '/icon-192.png', '/vendor/lucide.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-запросы: только сеть, никакого кэша.
  if (url.pathname.startsWith('/api/')) return;
  // Invite-ссылки и API не кэшируем — всегда сеть.
  if (url.pathname.startsWith('/kasse/invite/') || url.pathname.startsWith('/api/invite/')) return;
  if (url.pathname.startsWith('/kasse/') || url.pathname === '/') {
    e.respondWith(
      caches.match(e.request).then(hit => {
        const networkFetch = fetch(e.request).then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        }).catch(() => null);
        return hit || networkFetch || new Response('Нет соединения', {status: 503, headers:{'Content-Type':'text/plain;charset=utf-8'}});
      })
    );
  }
});
