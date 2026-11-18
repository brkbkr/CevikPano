# Çalışma düzeni: Geliştir → Test → Yayınla

| Ortam | Adres | Veritabanı | Neyi gösterir |
|---|---|---|---|
| 🧪 **Test** | `https://test.<alan>` (ör. test.150-230-155-149.sslip.io) | Ayrı, demo veri | Testleri geçen **son geliştirme** (henüz onaylanmamış olabilir) |
| 🚀 **Canlı** | `https://<alan>` (ör. 150-230-155-149.sslip.io) | Gerçek veri | **Yayınlanan** sürüm |

Test sitesinin üstünde turuncu **TEST ORTAMI** şeridi vardır; canlıyla karışmaz.

## Akış

1. **İstek** — Ne istediğini Claude'a yaz (ekran görüntüsü, örnek, kabul kriteri).
2. **Analiz ve tasarım** — Claude'un Product Owner, iş analisti ve tasarımcı rolleri kabul kriterlerini ve
   ekran değişiyorsa görsel taslağı hazırlar; taslak sana onaya gelir.
3. **Geliştirme ve test** — Yazılımcı kodu yazar, testçi test eder; GitHub'da bir **PR** (onay talebi) açılır.
   Otomatik testler (**API** ve **Tarayıcı**) geçince değişiklik 2-5 dakikada **test sitesine kendiliğinden** gelir.
   Claude test sitesinde de dener ve sana sade bir özet yazar.
4. **Onay** — Test sitesinde beğendiysen PR sayfasında **Squash and merge** → **Confirm**. Beğenmediysen Claude'a yaz.
5. **Yayınla** — GitHub → **Actions** → soldan **Canlıya yayınla** → **Run workflow** → yeşil **Run workflow**.
   Yalnızca onaylanmış ve testleri geçmiş sürümler yayınlanabilir. 2-5 dakika içinde canlı site güncellenir.

Uygulamada **Sistem → Sürümler** ekranı test ve canlıdaki sürümleri yan yana gösterir; yayınla düğmesine giden bağlantı da oradadır.

## Bir şey ters giderse

- **Yeni sürüm sunucuda açılmazsa** sunucu kendiliğinden önceki sürüme döner ve o sürümü tekrar denemez.
- **Canlıdaki sürümü geri almak:** *Canlıya yayınla* → *Run workflow* → **Sürüm** kutusuna önceki sürümün kodunu yaz
  (Sistem → Sürümler'de ya da GitHub'daki `yayin-...` etiketlerinde görünür) → Run workflow.
- **Veri geri almak:** Uygulamada Sistem → Yedekler (günlük otomatik yedek) ya da Sistem → Çöp kutusu.

## Sunucu tarafı (bilgi için)

- `/opt/cevikpano` canlı, `/opt/cevikpano-test` test; ikisi de GitHub'ın kopyası, sunucuda elle kod değiştirilmez.
- `pano-deploy` her 2 dakikada GitHub'a bakar: `test` → test sitesi, `production` → canlı.
- `test` dalını GitHub Actions'taki **Teste gönder** günceller: testleri geçen son `claude/...` geliştirmesi ya da `main`.
  Günlük: `sudo tail -f /var/log/pano-deploy.log`
- Ortak kapı (Caddy) iki adresi ilgili ortama yönlendirir ve HTTPS sertifikalarını yeniler.
- Her gece 03:15 canlı veritabanının yedeği `/opt/cevikpano/yedekler` klasörüne alınır.
