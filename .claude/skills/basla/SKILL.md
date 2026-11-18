---
name: basla
description: ÇevikPano sürekli geliştirme modu. Kullanıcı sohbete "başla" yazınca kullan - Claude en az 8 saat boyunca kendi kendine fikir üretir, rollerle (PO, analist, tasarımcı, yazılımcı, testçi, güvenlik) geliştirir, test sitesine çıkarır, not bırakır ve sıradaki işe geçer. Kullanıcı "dur" yazınca, 8 saat dolunca ya da kullanım sınırına yaklaşınca durur.
---

# "Başla" modu

## Başlatma (kullanıcı "başla" yazdığında, bir kez)
1. **Durum dosyası:** `~/.pano-basla/durum.json` → `{ "baslangic": <ISO zaman>, "bitis_en_erken": <+8 saat>, "tamamlanan": [], "siradaki": [] }`.
   Konteyner yeniden başlarsa bu dosya kaybolabilir; o durumda geliştirme günlüğündeki son "▶ Başladı" yorumundan geri kur.
2. **Geliştirme günlüğü:** GitHub'da başlığı **"🤖 Geliştirme günlüğü"** olan issue'yu bul (yoksa aç, `oneri` etiketi olmadan).
   Yorum: "▶ Başladı <saat> · en erken bitiş <saat>".
3. **Dal:** `claude/gelistirme` hazırla (bkz. `gelistirme-sureci` → Dal ve PR düzeni).
4. **İlk fikir listesi:** Product Owner ajanı ürünü ve backlog'u inceler, **en fazla 4** iş önerir (önce `durum:hazir`
   backlog maddeleri, sonra kendi fikirleri; her biri tek cümle fayda + boyut S/M/L).
   Kullanıcı şu an buradadır: **AskUserQuestion** ile çoklu seçim (multiSelect) olarak sor: "Bunları yapayım mı?".
   Seçilmeyenleri atla; "hiçbiri" gibi bir yanıtta yeni liste üret.
5. **Döngüyü başlat:** `loop` becerisini aralıksız (kendi hızında) çalıştır, istem: `basla-dongu` —
   her yinelemede aşağıdaki **Döngü adımı** uygulanır.

## Döngü adımı (her yinelemede)
1. **Durma kontrolü — sırayla:**
   - Kullanıcı "dur" dediyse → **Kapanış**.
   - Kullanım sınırı uyarısı / hız sınırı hatası alındıysa → **Kapanış** (not: Claude kalan kullanım yüzdesini göremez;
     sistemin verdiği sınır uyarısı ya da hata durma sinyalidir).
   - Bu oturumda tamamlanan iş sayısı **12**'ye ulaştıysa (kullanım koruması; kullanıcı farklı bir sayı söylediyse o) → **Kapanış**.
   - 8 saat dolduysa → yarım iş varsa onu bitir, sonra **Kapanış**.
2. **Sıradaki iş:** `siradaki` boşsa yeni fikir listesi üret (PO, en fazla 4). Kullanıcı son mesajından bu yana yanıt
   vermediyse listeyi sohbete **işaretlenebilir liste** olarak yaz (`- [ ] 1. …`), "10 dakika içinde seçim yapmazsan
   1 ve 2 ile devam ediyorum" de, ve 10 dakika sonrasına uyanma kur. Kullanıcı bu arada yanıt verirse onun seçimi geçerlidir.
3. **Geliştir:** Seçilen işi `gelistirme-sureci`'ndeki 12 adımlık akışla yürüt (PO → analist → tasarımcı → yazılımcı →
   testçi + güvenlik → test sitesi → duman testi → PO kabulü → "✅ Claude onayı"). Her rol ayrı alt ajan.
   Bir iş bir yinelemeye sığmazsa durum dosyasına nerede kaldığını yaz, sonraki yinelemede devam et.
4. **Not bırak:**
   - Geliştirme günlüğü issue'suna yorum: ✅ iş adı · ne değişti (sade) · test sitesinde nereye bakılır · test ve güvenlik sonucu · commit.
   - "Geliştirmeler (devam ediyor)" PR açıklamasına madde ekle.
   - İlgili backlog issue'suna yorum + `durum:test-sitesinde`.
   - Sohbete 2-3 cümlelik kısa not.
5. **Uyanma:** CI ya da test sitesi bekleniyorsa ~4-5 dakika, yeni işe geçilecekse ~1-2 dakika sonrasına uyanma kur.

## Kapanış
- Döngüyü durdur (ScheduleWakeup `stop: true`), bekleyen hatırlatmaları iptal et.
- Geliştirme günlüğüne ve sohbete özet: süre, tamamlanan işler (madde madde), test sitesi adresi, PR bağlantısı,
  yarım kalan iş ve nerede kaldığı, kullanıcıdan beklenen (PR'ı incele/birleştir, uygun bulursa canlıya yayınla).

## Sınırlar (her zaman)
`gelistirme-sureci` → Sınırlar ve Claude onayı bölümleri geçerlidir: birleştirme ve canlıya yayın kullanıcının kararıdır,
testler ve güvenlik kontrolü atlanmaz, marka kararları öneri olarak sunulur, veri silen migration yazılmaz.
