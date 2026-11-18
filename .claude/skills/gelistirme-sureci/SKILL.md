---
name: gelistirme-sureci
description: ÇevikPano'da bir isteği ya da GitHub issue'sunu baştan sona geliştirme süreci - Product Owner → İş analisti → Web tasarımcısı → Yazılımcı → Testçi → kullanıcı onayı → test sitesi → PO kabulü. Yeni bir özellik, değişiklik ya da hata düzeltmesi istendiğinde kullan.
---

# Geliştirme süreci

Her iş bu adımlardan geçer. Roller `.claude/agents/` altındadır; her adımda ilgili rolü **ayrı bir alt ajan** olarak çalıştır
(Agent aracı, `subagent_type` = rol adı) ve çıktısını bir sonraki role ver. Küçük bir hata düzeltmesinde (tek dosya, ekran
değişmiyor) tasarım adımı atlanabilir; diğerleri atlanmaz.

| # | Rol | Girdi | Çıktı |
|---|---|---|---|
| 1 | `product-owner` | İstek / issue | Hedef, hikâyeler, kabul kriterleri, kapsam dışı, öncelik |
| 2 | `is-analisti` | PO çıktısı + kod | Veri modeli, kurallar, yetkiler, akış, uç durumlar, test senaryoları |
| 3 | `web-tasarimci` | Analiz | `docs/tasarim/<konu>/` taslak + açık/koyu/mobil PNG → **kullanıcı onayı** |
| 4 | `yazilimci` | Analiz + onaylı taslak | Kod, migration, testler, PR (`claude/<konu>`) |
| 5 | `testci` | PR + kabul kriterleri | Bulgular + GEÇTİ/GEÇMEDİ (PR yorumu) |
| 6 | (döngü) | GEÇMEDİ | Yazılımcı düzeltir → testçi tekrar |
| 7 | **Kullanıcı** | Yeşil CI + GEÇTİ + sade özet | PR'ı onaylar (Squash and merge) → 2-5 dk sonra test sitesi |
| 8 | `testci` | Test sitesi | Duman testi (sürüm, giriş, değişen ekran) |
| 9 | `product-owner` | Test sitesi + raporlar | Kabul + sürüm notu |
| 10 | **Kullanıcı** | Sürüm notu | GitHub → Actions → **Canlıya yayınla** |

## Sınırlar
- PR birleştirme ve canlıya yayın kullanıcının kararıdır; Claude bunları kendisi yapmaz.
- Yeni renk, yerleşim, menü yapısı ya da yeni ekran **önce kullanıcıya** taslak olarak gösterilir; onay gelmeden yazılımcıya geçilmez.
- Veri silen ya da dönüştüren migration içeren işler kullanıcıya ayrıca açıkça belirtilir.

## Backlog (GitHub Issues)
- Etiketler: `tip:ozellik`, `tip:hata`, `tip:iyilestirme`; `oncelik:kritik|yuksek|orta|dusuk`;
  `durum:tasarim-onayi`, `durum:devam`, `durum:onay-bekliyor`, `durum:test-sitesinde`.
- Kullanıcıya her adımın sonunda **sade Türkçe** kısa bilgi verilir: ne yapıldı, nerede görülür, ondan ne bekleniyor.

## Bitti tanımı
CI yeşil · testçi GEÇTİ · kullanıcı onayladı · test sitesinde duman testi geçti · PO kabul etti · sürüm notu yazıldı · belgeler güncel.
