const CACHE = 'plan-sophie-rome-2027-v8k2q-d3d2131d97';
const PRECACHE = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE).catch(()=>{})).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if(url.hostname.includes('firestore.googleapis.com')||url.hostname.includes('firebase')||url.hostname.includes('strava.com')||event.request.method!=='GET') return;
  event.respondWith(caches.match(event.request).then(cached=>{
    if(cached){fetch(event.request).then(r=>{if(r.ok){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(event.request,c))}}).catch(()=>{});return cached;}
    return fetch(event.request).then(r=>{if(r.ok&&url.origin===self.location.origin){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(event.request,c))}return r;}).catch(()=>{if(event.request.mode==='navigate')return caches.match('/')});
  }));
});
self.addEventListener('push',event=>{const d=event.data?event.data.json():{};event.waitUntil(self.registration.showNotification(d.title||'Training Today',{body:d.body||"Check today's session.",icon:'/icon-192.png',data:{url:d.url||'/'}}));});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil(clients.openWindow(event.notification.data.url||'/'));});
