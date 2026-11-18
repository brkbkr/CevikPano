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
| 7 | Test sitesi | `claude/<konu>` push'u + yeşil CI | "Teste gönder" `test` dalını günceller → 2-5 dk sonra test sitesi |
| 8 | `testci` | Test sitesi | Duman testi (sürüm, giriş, değişen ekran) |
| 9 | `product-owner` | Test sitesi + raporlar | Kabul + sürüm notu; kullanıcıya sade özet |
| 10 | **Kullanıcı** | Test sitesi + özet | PR'ı onaylar (Squash and merge → `main`) |
| 11 | **Kullanıcı** | Sürüm notu | GitHub → Actions → **Canlıya yayınla** |

## Sınırlar
- PR birleştirme ve canlıya yayın kullanıcının kararıdır; Claude bunları kendisi yapmaz.
- Ekran değişikliklerinde tasarım taslağı (`docs/tasarim/<konu>/`) hazırlanır ve kullanıcıya gösterilir. Kullanıcı oturumdaysa
  onayı beklenir; **otomatik çalışmada** taslak PR'a eklenir, iş test sitesine çıkar ve onay birleştirme sırasında verilir
  (test sitesi kullanıcıya açık değildir, canlıya hiçbir şey onaysız gitmez).
- Markayı değiştiren kararlar (yeni renk paleti, logo, ana menü yapısının baştan değişmesi) otomatik çalışmada uygulanmaz;
  `oneri` etiketli issue olarak sunulur.
- Veri silen ya da dönüştüren migration içeren işler kullanıcıya ayrıca açıkça belirtilir ve geri dönüş planı yazılır.

## Backlog (GitHub Issues)
- Etiketler: `tip:ozellik`, `tip:hata`, `tip:iyilestirme`; `oncelik:kritik|yuksek|orta|dusuk`;
  `durum:hazir` (otomatik çalışma alabilir), `durum:devam`, `durum:test-sitesinde`; `oneri` (Claude'un ürün önerisi).
- Kullanıcıya her adımın sonunda **sade Türkçe** kısa bilgi verilir: ne yapıldı, nerede görülür, ondan ne bekleniyor.

## Otomatik çalışma (zamanlanmış görev)
Kullanıcı yazmadan, zamanlanmış oturumlarda çalışılır. Her çalışmada:

1. **Durum:** `git fetch`; açık PR'lar, `durum:devam` ve `durum:test-sitesinde` issue'lar, test sitesinin `/api/version`'ı.
   Önceki çalışmada yarım kalan iş varsa ona devam et.
2. **Tek sürekli dal:** Otomatik işler `claude/gelistirme` dalında birikir (yoksa `main`'den aç; `main` ilerlediyse
   `main`'i bu dala birleştir). Tek bir açık PR vardır: **"Geliştirmeler (devam ediyor)"**. Her paket ayrı commit(ler) ve
   PR açıklamasında ayrı bir madde (sade anlatım + kabul kriterleri ✔ + test sonuçları). Böylece test sitesi birikmiş
   bütün işleri gösterir ve kullanıcı tek PR'ı onaylayarak hepsini alır. Kullanıcı birleştirince bir sonraki çalışmada dal `main`'den yeniden açılır.
3. **İş seçimi (PO):** En yüksek öncelikli `durum:hazir` issue'yu al, `durum:devam` yap. Bir çalışmada en fazla 1 paket
   (büyükse bir alt parçası) bitir; yarım bırakma, bitmeyecekse küçült.
4. **Süreç:** PO → analist → tasarımcı → yazılımcı → testçi adımları (yukarıdaki tablo); her rol ayrı alt ajan.
5. **Yayın:** Push → CI yeşil → "Teste gönder" → 2-5 dk sonra testçi test sitesinde duman testi.
   CI kırmızıysa kök nedeni bul ve düzelt; test atlamak, kapatmak yok.
6. **Kapanış:** Issue'ya yorum (ne yapıldı, test sitesinde nerede görülür) ve `durum:test-sitesinde` etiketi.
   PR açıklamasını güncelle. Kullanıcıya bildirim (PushNotification, 2-3 cümle, sade).
7. **Fikir üretme (PO, haftada bir — pazartesi çalışmasında):** Ürünü kullanıcı gözüyle gez (test sitesi), backlog'u gözden
   geçir; en fazla 2 yeni `oneri` issue'su aç (sorun, öneri, beklenen fayda, boyut). `oneri` issue'ları, kullanıcı
   `durum:hazir` etiketi koymadan geliştirilmez.
8. **Durma koşulları:** Belirsizlik kullanıcı kararı gerektiriyorsa issue'ya soruyu yaz, `durum:hazir`'ı kaldır ve bir
   sonraki işe geç. Hiç `durum:hazir` iş yoksa yalnızca 1. ve 7. adımları yap.

## Bitti tanımı
CI yeşil · testçi GEÇTİ · test sitesinde duman testi geçti · PO kabul etti · sürüm notu yazıldı · belgeler güncel · kullanıcı onaya çağrıldı.

Not: Test sitesi aynı anda tek bir dalı gösterir (testleri geçen son push). Bu yüzden otomatik işler tek sürekli dalda
(`claude/gelistirme`) birikir; kullanıcının istediği acil bir iş ayrı dalda yapılırsa, iş bitince test sitesi
"Teste gönder" ile yeniden `claude/gelistirme`'ye döndürülür.
