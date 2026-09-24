/* Оболочка кэшируется, данные — никогда: цифры всегда свежие с сервера. */
const CACHE='buchhalter-v20';
const SCHALE=['/manifest.webmanifest','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SCHALE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET' || u.origin!==location.origin) return;
  if(u.pathname.startsWith('/api/') || u.pathname==='/' || u.pathname==='/login') return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
