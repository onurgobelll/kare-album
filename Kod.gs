/**
 * YAKAMOZ BİDON TAKİP - Google Apps Script arka yüz (v2.6)
 *
 * Script özellikleri (Proje Ayarları > Script özellikleri):
 *   SIFRE          -> sahada kullanılan ortak şifre
 *   ANTHROPIC_KEY  -> OPSİYONEL. Sadece uygulamada "Etiket okuma: AI (ücretli)" seçilirse gerekir.
 *                    Varsayılan etiket okuma ücretsizdir ve telefonda yapılır, anahtar gerekmez.
 *
 * Sayfalar (ilk çalışmada kendiliğinden açılır):
 *   BIDONLAR  -> her bidon için tek satır (güncel durum)
 *   HAREKET   -> her giriş / çıkış / iade için bir satır (geçmiş)
 *   QR_BASIM  -> hangi numaralar basıldı (aynı numara iki kez basılmasın)
 *   URUNLER   -> ürün listesi (Sheet'ten düzenle, kod değiştirme)
 *
 * Haftalık yedek için: Tetikleyiciler (saat simgesi) > Tetikleyici ekle > haftalikYedek > Zamana dayalı > Haftalık.
 */

const MODEL = 'claude-sonnet-5-5';
const URUN_VARSAYILAN = ['ACI BİBER', 'BİBERİYE', 'SARI YAKAN'];
const TZ = 'Europe/Istanbul';

/* ---------- yardımcılar ---------- */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function sayfa_(ad, basliklar) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ad);
  if (!sh) {
    sh = ss.insertSheet(ad);
    sh.getRange(1, 1, sh.getMaxRows(), basliklar.length).setNumberFormat('@'); // metin kalsın
    sh.appendRow(basliklar);
    sh.setFrozenRows(1);
  }
  return sh;
}
const bidonSayfa_ = () => sayfa_('BIDONLAR', ['BidonID', 'Urun', 'EtiketTarihi', 'Kisi', 'Mense', 'Durum', 'GirisZamani', 'SonHareket', 'Bolge']);
const hareketSayfa_ = () => sayfa_('HAREKET', ['Zaman', 'Gun', 'BidonID', 'Islem', 'Urun', 'EtiketTarihi', 'Kisi', 'Parti', 'Neden', 'Operator', 'Kaynak', 'IstekId', 'Bolge']);
const qrSayfa_ = () => sayfa_('QR_BASIM', ['Zaman', 'Onek', 'Bas', 'Bit', 'Adet']);

function urunler_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('URUNLER');
  if (!sh) {
    sh = ss.insertSheet('URUNLER');
    sh.appendRow(['Urun']);
    URUN_VARSAYILAN.forEach(u => sh.appendRow([u]));
    sh.setFrozenRows(1);
  }
  const n = sh.getLastRow();
  return n > 1 ? sh.getRange(2, 1, n - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean) : URUN_VARSAYILAN;
}

function promptMetni_() {
  return `Bu fotoğrafta bir plastik bidon üzerinde etiketler var. Türkçe yazılı etiketleri oku.

İki tür etiket olabilir:
1) KÜÇÜK etiket: 3 satır -> ÜRÜN, TARİH (GG.AA.YYYY), KİŞİ ADI.
2) BÜYÜK etiket: ÜRÜN, MENŞE (örn. ÇANAKKALE), TARİH. Kişi adı yok.
QR kodlu beyaz kağıt etiketi YOK SAY.

Bilinen ürünler: ${urunler_().join(', ')}. Okuduğun ürün bunlardan birine çok benziyorsa onu yaz, yoksa okuduğunu aynen yaz.
Küçük etiket varsa onu esas al. Sadece büyük etiket varsa onu kullan. Hiçbiri okunmuyorsa boş bırak.
Hem küçük hem büyük etiket varsa menşeyi büyük etiketten al.

SADECE şu JSON'u döndür, başka hiçbir şey yazma:
{"urun":"","tarih":"GG.AA.YYYY","kisi":"","mense":"","etiket":"kucuk|buyuk|yok","guven":"yuksek|dusuk"}`;
}

// Yanlış şifre koruması: 10 yanlış denemeden sonra 10 dakika kilit.
// NOT: kilit GENEL (herkes için). Apps Script istemci IP'sini göremez, bu yüzden IP bazlı yapılamaz.
// Şifreyi bilmeyen biri 10 dakikalığına sahayı kilitleyebilir; uzun bir SIFRE bu riski azaltmaz ama tahmini imkansız kılar.
function sifreHata_(s) {
  const c = CacheService.getScriptCache();
  const yanlis = Number(c.get('yanlis') || 0);
  if (yanlis >= 10) return 'Çok fazla yanlış deneme. 10 dakika bekle.';
  if (!prop_('SIFRE') || s !== prop_('SIFRE')) { c.put('yanlis', String(yanlis + 1), 600); return 'Şifre yanlış'; }
  return '';
}

function oku2_(sh, kolon) {
  const n = sh.getLastRow();
  return n > 1 ? sh.getRange(2, 1, n - 1, kolon).getValues() : [];
}

/* ---------- web uygulaması ---------- */
// Şifre URL'de görünmesin diye liste de POST ile istenir (islem: 'liste'). GET kapalıdır.
function doGet() {
  return json_({ ok: false, hata: 'Bu adres sadece uygulama içindir. Uygulamayı GitHub Pages adresinden aç.' });
}

function liste_() {
  const bidonlar = oku2_(bidonSayfa_(), 9).map(r => ({
    id: r[0], urun: r[1], tarih: r[2], kisi: r[3], mense: r[4], durum: r[5], giris: r[6], son: r[7], bolge: r[8]
  }));
  const hareketler = oku2_(hareketSayfa_(), 13).map(r => ({
    zaman: r[0], gun: r[1], id: r[2], islem: r[3], urun: r[4], tarih: r[5], kisi: r[6], parti: r[7], neden: r[8], operator: r[9], kaynak: r[10], bolge: r[12]
  }));
  const sonNo = {}, araliklar = [];
  oku2_(qrSayfa_(), 5).forEach(r => {
    sonNo[r[1]] = Math.max(sonNo[r[1]] || 0, Number(r[3]) || 0);
    araliklar.push({ onek: r[1], bas: Number(r[2]) || 0, bit: Number(r[3]) || 0 });
  });
  return { ok: true, bidonlar: bidonlar, hareketler: hareketler, sonNo: sonNo, araliklar: araliklar, urunler: urunler_() };
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const hata = sifreHata_(d.sifre);
    if (hata) return json_({ ok: false, hata: hata });
    if (d.islem === 'liste') return json_(liste_());
    if (d.islem === 'oku') return json_(oku_(d));
    if (d.islem === 'islem') return json_(islem_(d));
    if (d.islem === 'qrbasim') return json_(qrBasim_(d));
    return json_({ ok: false, hata: 'Bilinmeyen işlem' });
  } catch (err) {
    return json_({ ok: false, hata: String(err) });
  }
}

/* ---------- etiketi AI ile oku ---------- */
function oku_(d) {
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': prop_('ANTHROPIC_KEY'), 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d.foto } },
          { type: 'text', text: promptMetni_() }
        ]
      }]
    })
  });
  const gov = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) return { ok: false, hata: (gov.error && gov.error.message) || 'API hatası' };
  const metin = gov.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim();
  return { ok: true, veri: JSON.parse(metin) };
}

/* ---------- giriş / çıkış / iade (toplu) ---------- */
// d.tip: GIRIS | CIKIS | IADE | TASI (bölgeye yerleştir)   d.kayitlar: [{id, urun, tarih, kisi, mense, bolge, kaynak}]
// d.parti: parti/hat (çıkış)   d.neden: iade nedeni   d.operator: işlemi yapan   d.istekId: aynı istek tekrar gelirse ikinci kez yazılmaz
// Kurallar (sunucuda zorunlu):
//   GIRIS : bidon üretimdeyse reddedilir (önce iade). Kayıtlı sahadaki bidon için bilgi güncellenir. Bölge yazılıysa bölge de kaydedilir.
//   TASI  : sadece kayıtlı ve SAHADA olan bidon, bölge zorunlu; zaten o bölgedeyse atlanır.
//   CIKIS : sadece SAHADA olan bidon.   IADE : sadece URETIMDE olan bidon.   Kayıtsız bidonda CIKIS/IADE yok.
function islem_(d) {
  const tip = d.tip;
  if (['GIRIS', 'CIKIS', 'IADE', 'TASI'].indexOf(tip) < 0) return { ok: false, hata: 'Geçersiz işlem' };
  const liste = d.kayitlar || [];
  if (!liste.length) return { ok: false, hata: 'Liste boş' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cache = CacheService.getScriptCache();
    const anahtar = d.istekId ? 'i_' + d.istekId : '';
    if (anahtar) {
      const eski = cache.get(anahtar);
      if (eski) return Object.assign(JSON.parse(eski), { tekrar: true });
    }

    const sh = bidonSayfa_(), hs = hareketSayfa_();
    if (d.istekId) {                                   // önbellek 6 saatte silinir; kalıcı kontrol: son 3000 hareketin IstekId'si
      const son = hs.getLastRow();
      if (son >= 2) {
        const bas = Math.max(2, son - 2999);
        const idler = hs.getRange(bas, 12, son - bas + 1, 1).getValues();
        const n = idler.filter(x => String(x[0]) === String(d.istekId)).length;
        if (n) return { ok: true, islenen: n, yeni: 0, atlanan: [], tekrar: true };
      }
    }
    const veri = oku2_(sh, 9);
    const idx = {};
    veri.forEach((r, i) => { idx[String(r[0])] = i; });

    const simdi = new Date();
    const z = fmt_(simdi, 'yyyy-MM-dd HH:mm:ss'), g = fmt_(simdi, 'yyyy-MM-dd');
    const hareket = [], gorulen = {}, atlanan = [];
    let yeni = 0;

    liste.forEach(k => {
      const id = String(k.id || '').trim();
      if (!id || gorulen[id]) return;
      gorulen[id] = true;
      let i = idx[id];
      const var_ = i !== undefined;
      const bolge = String(k.bolge || d.bolge || '').trim();
      if (tip === 'GIRIS') {
        if (var_ && veri[i][5] === 'URETIMDE') { atlanan.push({ id: id, neden: 'Üretimde, önce iade yap' }); return; }
      } else if (!var_) { atlanan.push({ id: id, neden: 'Kayıtsız bidon, önce giriş yap' }); return; }
      else if (tip === 'CIKIS' && veri[i][5] !== 'SAHADA') { atlanan.push({ id: id, neden: 'Zaten üretimde' }); return; }
      else if (tip === 'IADE' && veri[i][5] !== 'URETIMDE') { atlanan.push({ id: id, neden: 'Üretimde değil' }); return; }
      else if (tip === 'TASI' && !bolge) { atlanan.push({ id: id, neden: 'Bölge boş' }); return; }
      else if (tip === 'TASI' && veri[i][5] !== 'SAHADA') { atlanan.push({ id: id, neden: 'Üretimde, önce iade yap' }); return; }
      else if (tip === 'TASI' && String(veri[i][8]) === bolge) { atlanan.push({ id: id, neden: 'Zaten bu bölgede' }); return; }

      if (!var_) {
        veri.push([id, k.urun || '', k.tarih || '', k.kisi || '', k.mense || '', '', z, z, '']);
        i = veri.length - 1; idx[id] = i; yeni++;
      } else if (tip === 'GIRIS') {
        const r0 = veri[i];
        if (k.urun) r0[1] = k.urun;
        if (k.tarih) r0[2] = k.tarih;
        if (k.kisi) r0[3] = k.kisi;
        if (k.mense) r0[4] = k.mense;
      }
      const r = veri[i];
      r[5] = (tip === 'CIKIS') ? 'URETIMDE' : 'SAHADA';
      r[7] = z;
      if (bolge && tip !== 'CIKIS') r[8] = bolge;        // çıkışta son bölge kalır, yeni bölge yazılmaz
      hareket.push([z, g, id, tip, r[1], r[2], r[3], d.parti || '', d.neden || '', d.operator || '', k.kaynak || '', d.istekId || '', r[8] || '']);
    });

    if (veri.length) sh.getRange(2, 1, veri.length, 9).setValues(veri);
    if (hareket.length) hs.getRange(hs.getLastRow() + 1, 1, hareket.length, 13).setValues(hareket);
    const sonuc = { ok: true, islenen: hareket.length, yeni: yeni, atlanan: atlanan };
    if (anahtar) cache.put(anahtar, JSON.stringify(sonuc), 21600);
    return sonuc;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- basılan QR numaraları ---------- */
function qrBasim_(d) {
  const sh = qrSayfa_();
  sh.appendRow([fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'), d.onek || '', Number(d.bas) || 0, Number(d.bit) || 0, Number(d.adet) || 0]);
  return { ok: true };
}

/* ---------- haftalık yedek (tetikleyici ile çalıştır) ---------- */
function haftalikYedek() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dosya = DriveApp.getFileById(ss.getId());
  const k = DriveApp.getFoldersByName('Bidon Yedek');
  const klasor = k.hasNext() ? k.next() : DriveApp.createFolder('Bidon Yedek');
  dosya.makeCopy('Bidon Takip yedek ' + fmt_(new Date(), 'yyyy-MM-dd'), klasor);
}
