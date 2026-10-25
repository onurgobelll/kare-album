const C='kare-v2';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['./','./index.html','./icon.svg'])));self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET'||new URL(r.url).origin!==location.origin) return;
  // sayfa/kod: tarayıcının 10 dk önbelleğini atlayıp sunucuya sor (güncellemeler hemen gelsin); çevrimdışıysa son kopya
  const fresh=r.mode==='navigate'||/\/(index\.html)?$|\.(js|json)$/.test(new URL(r.url).pathname);
  e.respondWith(fetch(fresh?new Request(r,{cache:'no-cache'}):r).then(res=>{const cp=res.clone();caches.open(C).then(c=>c.put(r,cp));return res}).catch(()=>caches.match(r)));
});
