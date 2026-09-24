/* Оболочка кэшируется, данные — никогда: цифры всегда свежие с сервера.
   Экран /arbeit и его скрипты берутся из сети, а без сети — из кэша,
   чтобы сотрудник мог открыть приложение и чек из очереди ушёл позже. */
const CACHE='buchhalter-v21';
const SCHALE=['/manifest.webmanifest','/icon-192.png','/icon-512.png','/arbeit.js','/vendor/lucide-1.17.0.min.js'];
const ARBEIT=['/arbeit','/arbeit.js','/vendor/lucide-1.17.0.min.js'];
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
  if(ARBEIT.includes(u.pathname)){
    e.respondWith(fetch(e.request).then(r=>{
      if(r.ok && !r.redirected){ const k=r.clone(); caches.open(CACHE).then(c=>c.put(u.pathname,k)); }
      return r;
    }).catch(()=>caches.match(u.pathname).then(r=>r||Response.error())));
    return;
  }
  if(u.pathname.startsWith('/api/') || u.pathname==='/' || u.pathname==='/login') return;
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
