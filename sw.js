const CACHE='boersen-dashboard-v10';
const SHELL=['./','./index.html','./manifest.json','./icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('boersen-dashboard-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==location.origin)return;
 const isPage=e.request.mode==='navigate'||new URL(e.request.url).pathname.endsWith('/index.html')||new URL(e.request.url).pathname.endsWith('/');
 if(isPage){
  e.respondWith(fetch(new Request(e.request,{cache:'no-store'})).then(response=>{
   if(response&&response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
   return response;
  }).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
 }else{
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
 }
});