// Kare — bulut fonksiyonları. Deploy: cd functions && npm i && cd .. && firebase deploy --only functions
// NOT: Gerçek hesaplarla test edilmedi. Önce iyzico SANDBOX ile deneyin.
const admin = require('firebase-admin');
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const {execFile} = require('child_process');
const {onDocumentCreated, onDocumentDeleted} = require('firebase-functions/v2/firestore');
const {setGlobalOptions} = require('firebase-functions/v2');
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const vision = require('@google-cloud/vision');
const Iyzipay = require('iyzipay');
const ffmpeg = require('ffmpeg-static');

setGlobalOptions({region: 'europe-west3'}); // Firestore ile aynı bölge (Frankfurt)
admin.initializeApp();
const db = admin.firestore(), bucket = admin.storage().bucket(), FV = admin.firestore.FieldValue, TSt = admin.firestore.Timestamp;
const vis = new vision.ImageAnnotatorClient();
const LIK = {VERY_UNLIKELY: 0, UNLIKELY: .15, POSSIBLE: .5, LIKELY: .8, VERY_LIKELY: 1};
const PK = { // index.html içindeki PK ile aynı olmalı
  basic: {quota: 300, months: 6, price: '1490.00'},
  plus: {quota: 1500, months: 12, price: '2990.00'},
  premium: {quota: 5000, months: 24, price: '4990.00'}
};
const rid = n => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return [...crypto.randomBytes(n)].map(x => a[x % a.length]).join(''); };
const iyz = () => new Iyzipay({apiKey: process.env.IYZICO_API_KEY, secretKey: process.env.IYZICO_SECRET_KEY, uri: process.env.IYZICO_URI || 'https://sandbox-api.iyzipay.com'});
const site = () => process.env.SITE_URL;
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, {maxBuffer: 1 << 24}, e => e ? rej(e) : res()));

// Büyük videoyu 1080p H.264'e sıkıştır, küçüldüyse orijinalin yerine koy
async function compressVideo(wid, ref, p) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v-')), inp = path.join(tmp, 'in'), out = path.join(tmp, 'out.mp4');
  try {
    await bucket.file(p.path).download({destination: inp});
    await run(ffmpeg, ['-y', '-i', inp, '-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
    const size = fs.statSync(out).size;
    if (size >= p.size * .9) return; // kazanç yoksa dokunma
    const np = `weddings/${wid}/${ref.id}_c.mp4`;
    await bucket.upload(out, {destination: np, contentType: 'video/mp4'});
    await ref.update({path: np, size});
    await bucket.file(p.path).delete().catch(() => {});
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
}

// 1) Yeni dosya: kota sayacı, video sıkıştırma, (Premium) etiket / bulanıklık / yüz skoru
exports.onPhoto = onDocumentCreated({document: 'weddings/{wid}/photos/{pid}', memory: '4GiB', timeoutSeconds: 540}, async ev => {
  const {wid} = ev.params, p = ev.data.data(), wref = db.doc(`weddings/${wid}`);
  await wref.update({photoCount: FV.increment(1)});
  if (p.type === 'video' && process.env.COMPRESS_VIDEO === 'true' && p.size > 60 * 1048576) {
    await compressVideo(wid, ev.data.ref, p).catch(e => console.error('sıkıştırma', e));
    return;
  }
  const w = (await wref.get()).data();
  if (!w || w.pkg !== 'premium' || p.type !== 'image') return;
  let r;
  try { [r] = await vis.annotateImage({
    image: {source: {gcsImageUri: `gs://${bucket.name}/${p.thumbPath || p.path}`}},
    features: [{type: 'LABEL_DETECTION', maxResults: 12}, {type: 'FACE_DETECTION', maxResults: 20}]
  }); } catch (e) { console.error('Vision hatası', e.message); return; }
  const labels = (r.labelAnnotations || []).filter(l => l.score > .7).map(l => l.description.toLowerCase());
  const faces = r.faceAnnotations || [];
  const blur = faces.length > 0 && faces.filter(f => LIK[f.blurredLikelihood] >= .8).length / faces.length > .5;
  let score = 0;
  faces.forEach(f => { score += f.detectionConfidence * 2 + LIK[f.joyLikelihood] - LIK[f.blurredLikelihood] * 3 - LIK[f.underExposedLikelihood]; });
  score = Math.min(score, 12) + labels.length * .1;
  await ev.data.ref.update({tags: labels, faces: faces.length, blur, score});
});

// 1b) Silinen dosya kotadan düşsün
exports.onPhotoDeleted = onDocumentDeleted('weddings/{wid}/photos/{pid}', async ev => {
  await db.doc(`weddings/${ev.params.wid}`).update({photoCount: FV.increment(-1)}).catch(() => {});
});

// 2) iyzico ile ödeme başlat (index.html #/buy sayfası çağırır)
exports.createCheckout = onRequest({cors: true}, async (req, res) => {
  const b = req.body || {}, pk = PK[b.pkg];
  if (!pk || !b.title || !b.email) return res.status(400).json({error: 'Eksik bilgi'});
  let ref = null;
  if (b.ref && /^[A-Za-z0-9]{10,40}$/.test(b.ref) && (await db.doc('partners/' + b.ref).get()).exists) ref = b.ref;
  const conv = rid(16), nm = b.name || 'Ad', sn = b.surname || 'Soyad';
  const addr = {contactName: `${nm} ${sn}`, city: 'Istanbul', country: 'Turkey', address: 'Dijital ürün'};
  const request = {
    locale: 'tr', conversationId: conv, price: pk.price, paidPrice: pk.price, currency: 'TRY', basketId: conv,
    paymentGroup: 'PRODUCT', callbackUrl: `${site()}api/iyzicoCallback`, enabledInstallments: [1, 2, 3, 6],
    buyer: {id: conv, name: nm, surname: sn, gsmNumber: b.phone || '+905000000000', email: b.email, identityNumber: '11111111111',
      registrationAddress: 'Türkiye', ip: req.ip || '85.34.78.112', city: 'Istanbul', country: 'Turkey'},
    shippingAddress: addr, billingAddress: addr,
    basketItems: [{id: b.pkg, name: 'Anı albümü ' + b.pkg, category1: 'Dijital', itemType: 'VIRTUAL', price: pk.price}]
  };
  iyz().checkoutFormInitialize.create(request, async (err, r) => {
    if (err || !r || r.status !== 'success') return res.status(502).json({error: (r && r.errorMessage) || 'Ödeme başlatılamadı'});
    await db.doc('checkouts/' + r.token).set({title: String(b.title).slice(0, 80), pkg: b.pkg, email: b.email, conv, ref,
      date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null, done: false, createdAt: FV.serverTimestamp()});
    res.json({url: r.paymentPageUrl});
  });
});

// 3) iyzico geri çağrısı: ödemeyi doğrula, düğünü oluştur, satışı/komisyonu kaydet, bağlantıları e-postala
exports.iyzicoCallback = onRequest(async (req, res) => {
  const token = req.body && req.body.token;
  if (!token) return res.status(400).send('token yok');
  const ref = db.doc('checkouts/' + token), snap = await ref.get();
  if (!snap.exists) return res.status(404).send('kayıt yok');
  const d = snap.data();
  if (d.done) return res.redirect(303, `${site()}#/done/${d.wid}/${d.key}`);
  iyz().checkoutForm.retrieve({locale: 'tr', conversationId: d.conv, token}, async (err, r) => {
    const pk = PK[d.pkg];
    if (err || !r || r.status !== 'success' || r.paymentStatus !== 'SUCCESS' || Number(r.paidPrice) < Number(pk.price)) return res.redirect(303, `${site()}#/buy`);
    const wid = rid(22), key = rid(12);
    const won = await db.runTransaction(async tx => { const c = await tx.get(ref); if (c.data().done) return false; tx.update(ref, {done: true, wid, key}); return true; });
    if (!won) { const c = (await ref.get()).data(); return res.redirect(303, `${site()}#/done/${c.wid}/${c.key}`); }
    const partner = d.ref ? (await db.doc('partners/' + d.ref).get()).data() : null;
    const ev = d.date ? new Date(d.date) : new Date(), exp = new Date(Math.max(ev, Date.now())); exp.setMonth(exp.getMonth() + pk.months);
    await db.doc(`weddings/${wid}`).set({
      title: d.title, pkg: d.pkg, quota: pk.quota, photoCount: 0, ownerUid: partner ? d.ref : process.env.SELLER_UID,
      uploadOpen: true, moderation: false, guestGallery: false, theme: {color: '#9a2e2a'}, welcome: '',
      brand: partner && partner.brand ? {name: partner.brand} : null, slug: null, invite: null,
      createdAt: FV.serverTimestamp(), eventDate: TSt.fromDate(ev), expiresAt: TSt.fromDate(exp)});
    await db.doc(`weddings/${wid}/secret/k`).set({key, coupleEmail: d.email});
    const amount = Number(r.paidPrice), pct = partner ? partner.pct : 0;
    await db.collection('sales').add({wid, title: d.title, pkg: d.pkg, amount, partnerUid: partner ? d.ref : null, pct,
      commission: Math.round(amount * pct) / 100, paid: false, at: FV.serverTimestamp()});
    await db.collection('mail').add({to: d.email, message: {subject: 'Albümünüz hazır', html:
      `Albümünüz: <a href="${site()}#/a/${wid}/${key}">${site()}#/a/${wid}/${key}</a><br>Misafir yükleme bağlantısı: ${site()}#/u/${wid}`}});
    res.redirect(303, `${site()}#/done/${wid}/${key}`);
  });
});

// 4) Günlük: süre bitimi uyarısı + süresi 30 gün geçen düğünleri silme
exports.expiry = onSchedule('every day 04:00', async () => {
  const now = Date.now();
  const soon = await db.collection('weddings').where('expiresAt', '<', TSt.fromMillis(now + 14 * 864e5)).get();
  for (const d of soon.docs) {
    const w = d.data(); if (w.warned || w.expiresAt.toMillis() < now) continue;
    const mail = ((await d.ref.collection('secret').doc('k').get()).data() || {}).coupleEmail; if (!mail) continue;
    await db.collection('mail').add({to: mail, message: {subject: 'Albüm süreniz bitiyor', text: 'Albümünüzün süresi 14 gün içinde dolacak. Dosyalarınızı indirin veya süreyi uzatmak için bize yazın.'}});
    await d.ref.update({warned: true});
  }
  const old = await db.collection('weddings').where('expiresAt', '<', TSt.fromMillis(now - 30 * 864e5)).get();
  for (const d of old.docs) {
    const w = d.data(); await bucket.deleteFiles({prefix: `weddings/${d.id}/`});
    if (w.slug) await db.doc('slugs/' + w.slug).delete().catch(() => {});
    await db.recursiveDelete(d.ref);
  }
});

// 5) Düğünden 7 gün sonra: e-posta bırakan misafirlere "son fotoğraflarını yükle" hatırlatması
exports.reminders = onSchedule('every day 10:00', async () => {
  const now = Date.now();
  const s = await db.collection('weddings').where('eventDate', '>', TSt.fromMillis(now - 8 * 864e5)).where('eventDate', '<', TSt.fromMillis(now - 6 * 864e5)).get();
  for (const d of s.docs) {
    const w = d.data(); if (w.reminded || !w.uploadOpen) continue;
    const mails = [...new Set((await d.ref.collection('guests').get()).docs.map(g => g.data().email).filter(Boolean))];
    const url = `${site()}#/u/${d.id}`;
    for (const to of mails) await db.collection('mail').add({to, message: {subject: `${w.title}: telefonunuzda kalan kareler var mı?`,
      html: `Düğünün üzerinden bir hafta geçti. Telefonunuzda henüz paylaşmadığınız fotoğraf veya video varsa buradan yükleyebilirsiniz: <a href="${url}">${url}</a>`}});
    await d.ref.update({reminded: true});
  }
});

// 6) Günlük Firestore yedeği (BACKUP_BUCKET tanımlıysa)
exports.backup = onSchedule('every day 03:00', async () => {
  if (!process.env.BACKUP_BUCKET) return;
  const client = new admin.firestore.v1.FirestoreAdminClient();
  const pid = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG).projectId;
  await client.exportDocuments({name: client.databasePath(pid, '(default)'), outputUriPrefix: `gs://${process.env.BACKUP_BUCKET}/${new Date().toISOString().slice(0, 10)}`, collectionIds: []});
});
