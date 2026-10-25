# Bidon Takip

Yakamoz bidon giriş / çıkış / iade / bölge / stok takibi. Telefonda çalışır, veri Google Sheet'te durur.

## Dosyalar
- `index.html`: uygulamanın kendisi (tek dosya)
- `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`: "Ana ekrana ekle" ve internetsiz açılış için
- `Kod.gs`: Google Sheet'e yapıştırılacak sunucu kodu (GitHub Pages bunu kullanmaz, yedek olarak durur)

Bu repoda şifre ya da API anahtarı yoktur. Şifre ve adres sadece Apps Script'te ve telefonun Ayarlar ekranındadır.

## Kurulum (1): GitHub Pages (5 dk)
1. GitHub → New repository → ad: `bidon-takip` → **Public** (ücretsiz Pages için gerekir) → Create.
2. "uploading an existing file" bağlantısına tıkla → bu klasörün içindeki **tüm dosyaları** sürükle → Commit changes.
3. Settings → Pages → Source: **Deploy from a branch** → Branch: `main` / `(root)` → Save.
4. 1-2 dakika sonra adres hazır: `https://KULLANICI-ADIN.github.io/bidon-takip/`

## Kurulum (2): Google Sheet + Apps Script (10 dk)
1. Yeni bir Google Sheet aç → Uzantılar → **Apps Script**.
2. Açılan editördeki kodu sil, `Kod.gs` içeriğini yapıştır → kaydet.
3. Soldan Proje Ayarları (dişli) → **Script özellikleri** → şunu ekle: `SIFRE` = uzun, tahmin edilmesi zor bir şifre.
   (`ANTHROPIC_KEY` gerekmez; etiket okuma ücretsiz ve telefonda yapılır.)
4. Sağ üst **Dağıt → Yeni dağıtım** → tür: **Web uygulaması** → Çalıştıran: **Ben** → Erişim: **Herkes** → Dağıt → izinleri ver.
5. Çıkan **/exec ile biten adresi** kopyala.

## Kurulum (3): Telefon
1. Telefonda **Chrome** ile GitHub Pages adresini aç (WhatsApp/Drive içinden açma, kamera çalışmaz).
2. Ayarlar → Apps Script adresini yapıştır, Şifreyi yaz, **Adını** yaz → Ayarı kaydet.
3. Chrome menüsü → **Ana ekrana ekle**.

## İlk deneme
- Ayarlar'daki adresi boş bırakırsan **Deneme modu** açılır: veri sadece o telefonda kalır, Sheet'e gitmez. Önce böyle dene.
- Gerçek kurulumdan önce 20 bidonluk pilot yap (kılavuzda bölüm 7).

## Güncelleme
- Yeni `index.html` yüklemek yeterli. `Kod.gs` değişirse Apps Script'te Dağıt → Dağıtımları yönet → düzenle → **Yeni sürüm**.
