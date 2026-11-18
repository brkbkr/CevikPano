# Çalışma düzeni: Geliştir → Test → Yayınla

| Ortam | Adres | Veritabanı | Neyi gösterir |
|---|---|---|---|
| 🧪 **Test** | `https://test.<alan>` (ör. test.150-230-155-149.sslip.io) | Ayrı, demo veri | GitHub'da onaylanan **son** sürüm |
| 🚀 **Canlı** | `https://<alan>` (ör. 150-230-155-149.sslip.io) | Gerçek veri | **Yayınlanan** sürüm |

Test sitesinin üstünde turuncu **TEST ORTAMI** şeridi vardır; canlıyla karışmaz.

## Akış

1. **İstek** — Ne istediğini Claude'a yaz (ekran görüntüsü, örnek, kabul kriteri).
2. **Geliştirme** — Claude kodu yazar, kendi ortamında dener ve GitHub'da bir **PR** (onay talebi) açar.
   PR'da otomatik testler çalışır: **API testleri** ve **Tarayıcı testleri**. İkisi de ✔ olmalı.
3. **Onay** — PR sayfasında **Squash and merge** → **Confirm**.
4. **Test sitesi** — 2-5 dakika içinde kendiliğinden güncellenir. Dene; sorun varsa Claude'a yaz (1'e dön).
5. **Yayınla** — GitHub → **Actions** → soldan **Canlıya yayınla** → **Run workflow** → yeşil **Run workflow**.
   Testleri geçmemiş bir sürüm yayınlanamaz. 2-5 dakika içinde canlı site güncellenir.

Uygulamada **Sistem → Sürümler** ekranı test ve canlıdaki sürümleri yan yana gösterir; yayınla düğmesine giden bağlantı da oradadır.

## Bir şey ters giderse

- **Yeni sürüm sunucuda açılmazsa** sunucu kendiliğinden önceki sürüme döner ve o sürümü tekrar denemez.
- **Canlıdaki sürümü geri almak:** *Canlıya yayınla* → *Run workflow* → **Sürüm** kutusuna önceki sürümün kodunu yaz
  (Sistem → Sürümler'de ya da GitHub'daki `yayin-...` etiketlerinde görünür) → Run workflow.
- **Veri geri almak:** Uygulamada Sistem → Yedekler (günlük otomatik yedek) ya da Sistem → Çöp kutusu.

## Sunucu tarafı (bilgi için)

- `/opt/cevikpano` canlı, `/opt/cevikpano-test` test; ikisi de GitHub'ın kopyası, sunucuda elle kod değiştirilmez.
- `pano-deploy` her 2 dakikada GitHub'a bakar: `main` → test, `production` → canlı.
  Günlük: `sudo tail -f /var/log/pano-deploy.log`
- Ortak kapı (Caddy) iki adresi ilgili ortama yönlendirir ve HTTPS sertifikalarını yeniler.
- Her gece 03:15 canlı veritabanının yedeği `/opt/cevikpano/yedekler` klasörüne alınır.
