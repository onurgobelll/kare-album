/* Bidon Takip: çevrimdışı açılış için hizmet çalışanı.
   - Sayfa: önce ağ (güncelleme gelsin), ağ yoksa/yavaşsa önbellekten.
   - Kütüphane dosyaları (CDN, sürümü sabit): önce önbellek.
   - Google Apps Script (POST, kayıtlar) ASLA önbelleğe alınmaz. */
const SURUM = 'bidon-v2.7';
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const ONCEDEN = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SURUM).then(c => Promise.all(ONCEDEN.map(u => c.add(u).catch(() => {})))));   // biri eksikse kurulum bozulmasın
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SURUM).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if(r.method !== 'GET') return;                                  // POST (Apps Script) hiç karışmaz
  const u = new URL(r.url);
  if(CDN.includes(u.hostname)){                                   // kütüphaneler: önce önbellek
    e.respondWith(caches.open(SURUM).then(async c => {
      const var_ = await c.match(r); if(var_) return var_;
      const y = await fetch(r); if(y && (y.ok || y.type === 'opaque')) c.put(r, y.clone()); return y;
    }));
    return;
  }
  if(u.origin === self.location.origin){                          // kendi dosyalarımız: önce ağ, 5 sn'de cevap yoksa önbellek
    e.respondWith((async () => {
      const c = await caches.open(SURUM);
      try{
        const y = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('yavas')), 5000))]);
        if(y && y.ok) c.put(r, y.clone());
        return y;
      }catch(err){
        return (await c.match(r)) || (r.mode === 'navigate' ? (await c.match('./index.html')) || (await c.match('./')) : undefined) || Response.error();
      }
    })());
  }
});
