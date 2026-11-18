# Posta kutusu bağlantısı: kurulum rehberi

Bu rehber, ÇevikPano'ya **Gmail** ve **Outlook** posta kutularını bağlamak için gereken ayarları adım adım anlatır.
Ayarlar bir kez yapılır. Sonra yönetici, ÇevikPano'da **Sistem → Posta kutuları** ekranından **Gmail bağla** ya da
**Outlook bağla** düğmesine basar. Bağlanan kutunun gelen kutusuna düşen e-postalar talep olarak açılır.

Üç bölüm var:

1. Google (Gmail) ayarları
2. Microsoft (Outlook) ayarları
3. Bilgileri sunucuya eklemek

Yalnızca Gmail ya da yalnızca Outlook kullanacaksanız, ilgili bölümü atlayabilirsiniz.

Kullandığımız adresler:

| Ortam | Site adresi |
|---|---|
| Canlı | `https://150-230-155-149.sslip.io` |
| Test  | `https://test.150-230-155-149.sslip.io` |

---

## 1. Google (Gmail)

### 1.1 Proje oluşturun
1. <https://console.cloud.google.com> adresine, şirketin Google hesabıyla girin.
2. Üst çubuktaki proje seçiciye tıklayın → **Yeni proje**.
3. Ad olarak `CevikPano` yazın → **Oluştur**. Proje açılınca üstte seçili olduğundan emin olun.

### 1.2 Gmail API'yi açın
1. Sol menü → **API'ler ve Hizmetler → Kitaplık**.
2. Arama kutusuna `Gmail API` yazın → **Gmail API** → **Etkinleştir**.

### 1.3 OAuth izin ekranı
1. Sol menü → **API'ler ve Hizmetler → OAuth izin ekranı** (yeni arayüzde: **Google Auth Platform → Marka**).
2. **Kullanıcı türü**:
   - Kişisel Gmail hesapları da bağlanacaksa **Harici (External)** seçin. (Bizim kararımız bu.)
   - Yalnızca şirketin Google Workspace hesapları bağlanacaksa **Dahili (Internal)** seçebilirsiniz.
     Dahili seçenekte aşağıdaki "7 gün" sınırı ve doğrulama gerekmez; ama kişisel Gmail bağlanamaz.
3. **Uygulama adı**: `ÇevikPano`. **Kullanıcı destek e-postası** ve **geliştirici iletişim adresi**: kendi adresiniz.
4. **Kapsamlar (Scopes)** adımında **Kapsam ekle**'ye basın ve şunları seçin (arama kutusuna yazarak bulabilirsiniz):
   - `openid`
   - `.../auth/userinfo.email` (e-posta adresinizi görme)
   - `https://www.googleapis.com/auth/gmail.readonly` (e-postaları okuma)
   - `https://www.googleapis.com/auth/gmail.send` (e-posta gönderme; ileride karttan yanıt için)
5. **Test kullanıcıları** adımında, bağlanacak her posta adresini ekleyin (en fazla 100 adres).
6. Kaydedin.

> **Önemli: 7 gün sınırı.** Harici uygulama "Test" durumundayken Google, bağlantıyı **7 günde bir** sona erdirir.
> O zaman ÇevikPano'da kutunun yanında **Yeniden bağlanın** yazar ve yöneticilere bildirim gelir; kutunun yanındaki
> **Yeniden bağlan** düğmesine basmak yeterlidir. Bu sınırı kaldırmak için izin ekranında **Uygulamayı yayınla**
> (Yayında / In production) seçilmelidir. Gmail okuma "kısıtlı kapsam" olduğu için Google, yayına almadan önce
> **uygulama doğrulaması** (ve bazen bir güvenlik incelemesi) ister; bu birkaç hafta sürebilir. Doğrulama bitene kadar
> Google, giriş sırasında "Google bu uygulamayı doğrulamadı" uyarısı gösterir: **Gelişmiş → ÇevikPano'ya git (güvenli değil)**
> ile devam edilebilir. Workspace kullanıyorsanız **Dahili** seçmek bu sorunların hepsini çözer.

### 1.4 İstemci kimliği (Client ID) oluşturun
1. Sol menü → **API'ler ve Hizmetler → Kimlik bilgileri** → **Kimlik bilgisi oluştur → OAuth istemci kimliği**.
2. **Uygulama türü**: **Web uygulaması**. Ad: `ÇevikPano`.
3. **Yetkilendirilmiş yönlendirme URI'leri** bölümüne iki satır ekleyin (birebir aynı yazın):
   - `https://150-230-155-149.sslip.io/api/mail/oauth/google/callback`
   - `https://test.150-230-155-149.sslip.io/api/mail/oauth/google/callback`
4. **Oluştur**. Açılan pencerede **İstemci kimliği** ve **İstemci gizli anahtarı** görünür. İkisini güvenli bir yere
   not edin (bunlar sunucuya eklenecek; e-postayla ya da sohbette paylaşmayın).

---

## 2. Microsoft (Outlook / Microsoft 365)

### 2.1 Uygulama kaydı
1. <https://entra.microsoft.com> adresine girin (ya da <https://portal.azure.com> → **Microsoft Entra ID**).
2. **Uygulamalar → Uygulama kayıtları → Yeni kayıt**.
3. **Ad**: `ÇevikPano`.
4. **Desteklenen hesap türleri**: **Herhangi bir kuruluş dizinindeki hesaplar ve kişisel Microsoft hesapları**
   (ör. Skype, Xbox, Outlook.com) seçin. Böylece hem şirket hem kişisel Outlook hesapları bağlanabilir.
5. **Yeniden yönlendirme URI'si**: platform olarak **Web** seçin ve şunu yazın:
   `https://150-230-155-149.sslip.io/api/mail/oauth/microsoft/callback`
6. **Kaydet**. Açılan **Genel bakış** sayfasındaki **Uygulama (istemci) kimliği** değerini not edin.
7. Sol menü → **Kimlik doğrulama** → **Web** altında **URI ekle** → test adresini de ekleyin:
   `https://test.150-230-155-149.sslip.io/api/mail/oauth/microsoft/callback` → **Kaydet**.

### 2.2 İstemci sırrı
1. Sol menü → **Sertifikalar ve gizli diziler → Gizli istemci dizileri → Yeni gizli istemci dizisi**.
2. Açıklama: `ÇevikPano`. **Süre sonu**: en uzun seçeneği (ör. 24 ay) seçin.
3. **Ekle**. Listede görünen **Değer** sütununu hemen not edin (sayfadan çıkınca bir daha görünmez).
   "Gizli dizi kimliği" değil, **Değer** gereklidir.
4. **Bitiş tarihini takviminize yazın.** Süre dolunca kutular "Yeniden bağlanın" durumuna düşer; yeni bir sır oluşturup
   sunucudaki değeri değiştirmeniz gerekir.

### 2.3 İzinler (Microsoft Graph)
1. Sol menü → **API izinleri → İzin ekle → Microsoft Graph → Temsilci izinleri**.
2. Şunları işaretleyin: `Mail.Read`, `Mail.Send`, `offline_access`, `User.Read`, `openid`, `email` → **İzin ekle**.
3. Şirket hesabı (Microsoft 365) bağlanacaksa ve şirketiniz kullanıcı onayını kısıtlıyorsa, şirketin yöneticisi bu sayfada
   **[Şirket adı] için yönetici onayı ver** düğmesine basmalıdır. Kişisel hesaplarda buna gerek yoktur; izin bağlanırken sorulur.

---

## 3. Bilgileri sunucuya eklemek

Değerler GitHub'a **hiç** girmez; yalnızca sunucudaki `.env` dosyalarında durur. Canlı ve test ayrı dosyalardır:

- Canlı: `/opt/cevikpano/.env`
- Test: `/opt/cevikpano-test/.env`

### 3.1 Şifreleme anahtarı üretin
Sunucuya bağlanın ve şu komutu çalıştırın; çıkan satırı not edin:

```bash
openssl rand -base64 32
```

Bu anahtar, posta kutusu erişim bilgilerini veritabanında şifreler. Canlı ve test için **ayrı ayrı** üretin.
Anahtarı kaybederseniz ya da değiştirirseniz veri kaybolmaz, yalnızca kutuların yeniden bağlanması gerekir.

### 3.2 Canlı ortam
```bash
sudo nano /opt/cevikpano/.env
```
Dosyanın sonuna şu satırları ekleyin (eşittir işaretinden sonra kendi değerlerinizi yazın, boşluk bırakmayın):

```
MAIL_TOKEN_KEY=<3.1'de üretilen anahtar>
GOOGLE_CLIENT_ID=<Google istemci kimliği>
GOOGLE_CLIENT_SECRET=<Google istemci gizli anahtarı>
MS_CLIENT_ID=<Microsoft uygulama (istemci) kimliği>
MS_CLIENT_SECRET=<Microsoft gizli dizi Değeri>
MS_TENANT=common
MAIL_ENABLED=true
MAIL_POLL_SEC=120
```
Kaydetmek için `Ctrl+O`, `Enter`; çıkmak için `Ctrl+X`. Sonra uygulamayı yeni ayarlarla yeniden başlatın:

```bash
cd /opt/cevikpano && sudo docker compose -p cevikpano up -d
```

### 3.3 Test ortamı
```bash
sudo nano /opt/cevikpano-test/.env
```
Aynı satırları ekleyin, ama:
- `MAIL_TOKEN_KEY` için **ayrı** bir anahtar üretin.
- Test sitesinde gerçek müşteri e-postaları açılmasın diye `MAIL_ENABLED=false` bırakın. Testte e-posta çekmeyi denemek
  isterseniz, **ayrı bir deneme posta kutusu** bağlayıp yalnızca o sırada `MAIL_ENABLED=true` yapın.
  (Canlı ve test aynı kutuya bağlanıp ikisi birden çekerse aynı e-posta iki yerde de iş olur.)

```bash
cd /opt/cevikpano-test && sudo docker compose -p cevikpano-test up -d
```

### 3.4 Denetleyin
1. ÇevikPano'ya yönetici olarak girin → **Sistem → Posta kutuları**.
2. "Sunucu yapılandırılmamış" yazısı kaybolmuş ve **Gmail bağla / Outlook bağla** düğmeleri açılmış olmalı.
3. Düğmeye basın, posta hesabını seçin, izinleri onaylayın. Ekrana dönünce kutu listede **Bağlı** görünür.
4. Kutunun **Varsayılan proje** seçimini yapın (yalnız *Talep* şablonlu projeler listelenir). Kural eşleşmeyen e-postalar
   bu projeye düşer. İsterseniz **Yönlendirme kuralları** ile konu, alıcı ya da gönderen alan adına göre başka projeye
   ve kişiye yönlendirin.
5. Bağlantıdan **sonra** gelen e-postalar birkaç dakika içinde iş olarak görünür (önceki e-postalar alınmaz).

## Sık karşılaşılan durumlar

| Ekranda görünen | Ne yapmalı |
|---|---|
| Sunucu yapılandırılmamış | 3. bölümdeki satırlar eksik ya da `MAIL_TOKEN_KEY` hatalı (32 bayt olmalı). Ekledikten sonra `docker compose ... up -d` çalıştırın. |
| Yeniden bağlanın | Google test modunda 7 gün doldu, izin geri alındı ya da Microsoft sırrının süresi bitti. **Yeniden bağlan** düğmesine basın; Microsoft'ta sır bittiyse önce yeni sır oluşturup sunucuya ekleyin. |
| redirect_uri_mismatch / yönlendirme URI'si uyuşmuyor | 1.4 ve 2.1'deki adresler birebir aynı değil (https, sonda `/callback`, `test.` öneki). |
| Çekme kapalı (MAIL_ENABLED) | O ortamın `.env` dosyasında `MAIL_ENABLED=true` değil. |
| Sağlayıcı istek sınırı (429) | Sağlayıcı geçici olarak yavaşlattı; ÇevikPano bekleyip kendisi yeniden dener. |

## Gizlilik (KVKK)
- Yalnızca bağlantıdan sonra **gelen kutusuna** düşen e-postalar okunur; istenmeyen (spam) klasörü okunmaz.
- E-postanın kendisi ve ekleri saklanmaz; yalnızca konu, gönderen ve düz metin gövde işe yazılır.
- Otomatik yanıtlar, toplu e-postalar ve kutunun kendi gönderdikleri yok sayılır.
- **Bağlantıyı kes** ile erişim bilgileri silinir (Google'da izin de geri alınır). Microsoft hesabında uygulama iznini
  ayrıca <https://account.microsoft.com/privacy/app-access> adresinden kaldırabilirsiniz.
