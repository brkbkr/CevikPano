---
name: gelistirme-sureci
description: ÇevikPano'da bir isteği ya da GitHub issue'sunu baştan sona geliştirme süreci - Product Owner → İş analisti → Web tasarımcısı → Yazılımcı → Testçi + Güvenlik uzmanı → test sitesi → PO kabulü → kullanıcı onayı. Yeni bir özellik, değişiklik ya da hata düzeltmesi istendiğinde ve "başla" modunda her iş için kullan.
---

# Geliştirme süreci

Her iş bu adımlardan geçer. Roller `.claude/agents/` altındadır; her adımda ilgili rolü **ayrı bir alt ajan** olarak çalıştır
(Agent aracı, `subagent_type` = rol adı) ve çıktısını bir sonraki role ver. Küçük bir hata düzeltmesinde (tek dosya, ekran
değişmiyor) tasarım adımı atlanabilir; **testçi ve güvenlik uzmanı hiçbir zaman atlanmaz.**

| # | Rol | Girdi | Çıktı |
|---|---|---|---|
| 1 | `product-owner` | İstek / issue / fikir | Hedef, hikâyeler, kabul kriterleri, kapsam dışı, öncelik |
| 2 | `is-analisti` | PO çıktısı + kod | Veri modeli, kurallar, yetkiler, akış, uç durumlar, test senaryoları |
| 3 | `web-tasarimci` | Analiz | `docs/tasarim/<konu>/` taslak + açık/koyu/mobil PNG |
| 4 | `yazilimci` | Analiz + taslak | Kod, migration, testler |
| 5 | `testci` | Değişiklik + kabul kriterleri | Bulgular + GEÇTİ/GEÇMEDİ |
| 6 | `guvenlik-uzmani` | `git diff main...HEAD` | Güvenlik bulguları + GEÇTİ/GEÇMEDİ |
| 7 | (döngü) | 5 ya da 6 GEÇMEDİ | Yazılımcı düzeltir → 5 ve 6 tekrar |
| 8 | Test sitesi | Push + yeşil CI | "Teste gönder" `test` dalını günceller → 2-5 dk sonra test sitesi |
| 9 | `testci` | Test sitesi | Duman testi (`/api/version` yeni sürüm, giriş, değişen ekran) |
| 10 | `product-owner` | Raporlar + test sitesi | Kabul + sürüm notu + "Claude onayı" (aşağıda) |
| 11 | **Kullanıcı** | PR + test sitesi | PR'ı birleştirir (`main`) |
| 12 | **Kullanıcı** | Sürüm notu | GitHub → Actions → **Canlıya yayınla** |

## Claude onayı
PO kabul ettikten sonra PR'a **"✅ Claude onayı"** yorumu yazılır: kabul kriterleri ✔, test sonuçları (sayılarla),
güvenlik kararı, test sitesindeki sürüm. Bu, kullanıcının test sitesinde bakıp tek tıkla birleştirebilmesi içindir.
Birleştirme (`main`) ve canlıya yayın **kullanıcının** kararıdır; Claude bunları yapmaz.

## Sınırlar
- Testleri atlama, kapatma ya da "geçici" devre dışı bırakma yok. CI kırmızıysa kök nedeni bulunur.
- `production` ve `test` dallarına elle push yok; "Canlıya yayınla"yı Claude çalıştırmaz.
- Ekran değişikliklerinde tasarım taslağı hazırlanır. Kullanıcı oturumdaysa onayı alınır; değilse taslak PR'a eklenir,
  iş test sitesine çıkar, onay birleştirme sırasında verilir.
- Markayı değiştiren kararlar (renk paleti, logo, ana menü yapısının baştan değişmesi) kullanıcı onayı olmadan uygulanmaz;
  `oneri` issue'su olarak sunulur.
- Veri silen ya da dönüştüren migration yazılmaz; gerekiyorsa issue'da kullanıcıya sorulur.

## Backlog (GitHub Issues)
- Etiketler: `tip:ozellik`, `tip:hata`, `tip:iyilestirme`; `oncelik:kritik|yuksek|orta|dusuk`;
  `durum:hazir`, `durum:devam`, `durum:test-sitesinde`; `oneri` (Claude'un ürün fikri).
- Kullanıcıya her işin sonunda **sade Türkçe** kısa not: ne yapıldı, test sitesinde nerede görülür, ondan ne bekleniyor.

## Dal ve PR düzeni
- Otomatik/sürekli işler tek dalda birikir: `claude/gelistirme` (yoksa `main`'den aç; `main` ilerlediyse onu bu dala birleştir).
- Tek açık PR: **"Geliştirmeler (devam ediyor)"**. Her iş ayrı commit(ler) ve PR açıklamasında ayrı madde.
  Böylece test sitesi birikmiş bütün işleri gösterir ve kullanıcı tek PR'ı birleştirerek hepsini alır.
- Kullanıcının oturumda istediği acil bir iş ayrı dalda yapılabilir; bitince test sitesi "Teste gönder" ile
  `claude/gelistirme`'ye geri döndürülür.

## Bitti tanımı
CI yeşil · testçi GEÇTİ · güvenlik GEÇTİ · test sitesinde duman testi geçti · PO kabul etti · sürüm notu ve
"Claude onayı" yazıldı · issue `durum:test-sitesinde` · geliştirme günlüğüne not düşüldü.
