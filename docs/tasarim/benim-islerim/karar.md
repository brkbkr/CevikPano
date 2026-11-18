# #9 ilk dilim — Benim işlerim: PO kabul kriterleri, analiz özeti ve kararlar

Boyut M · migration YOK · sunucu değişikliği YOK (yalnız `public/index.html` + testler).

## Kabul kriterleri (PO)
1. Girişte açılan ekranın başlığı "Benim işlerim"; sol menü ve mobil sekmede "Ana menü" → "Benim işlerim". Adres `#home`, `g h` çalışır.
2. Kişiye atanmış, tamamlanmamış, epik olmayan, görebildiği ve arşivli olmayan projelerdeki işler gruplanır (ilk uyan kazanır):
   **Beklemede** (açık bir işin engellediği: `links {from,to,type:'blocks'}`, engellenen `to`, engelleyen açık) →
   **Gecikmiş** (`due<bugün`) → **Bugün** (`due=bugün` ya da `start<=bugün` ve (`due` yok ya da `due>=bugün`)) →
   **Bu hafta** (`bugün<due<=Pazar`) → **Daha sonra** (`due>Pazar` ya da `due` yok ve `start>bugün`) → **Tarihsiz**.
   Gösterim sırası: Gecikmiş, Bugün, Bu hafta, Daha sonra, Tarihsiz, Beklemede. Boş grup gizli, başlıkta sayı.
3. Grup içi: `lvl(priority)`, sonra `due` (yoksa sona), sonra `rank`. Grup başına 50 satır + "Tümünü göster".
4. Satır: proje, anahtar, özet (tıklayınca iş penceresi), öncelik rozeti, bitiş ya da "N gün gecikme" (iş günü), kalan süre (`remaining`, 0 ise yok), durum.
5. Üye/yönetici: **İlerlet** (işin projesinin durum sırasında sonraki; son durumda yok), **Süre gir**, hızlı öncelik/atama, mevcut "Tamamla" kutusu.
   Durum `setStatus` ile (geçmiş, otomasyon; bildirim sunucuda). Bitti'ye geçen ya da başkasına atanan iş listeden düşer ve
   **"Geri al"** düğmeli bildirim (~6 sn) çıkar; iş bu arada değiştiyse "geri alınamadı".
6. İzleyici: düğmeler yok (sunucu zaten reddeder).
7. Üst özet: açık iş, gecikmiş (>0 kırmızı), **bu takvim haftası** (Pzt–Pz) girilen süre / kapasite (%) — çizelgede seçili haftadan bağımsız.
8. Proje süzgeci (Tümü / tek proje) `DB.ui.homeProj`'da; özet süzgece uyar; görünmeyen kayıtlı proje → Tümü.
9. Boş durumlar: "Sana atanmış açık iş yok" (+ İş oluştur, Projelere git; izleyicide yalnız Projelere git);
   süzgeçle boşsa "Bu projede sana atanmış açık iş yok · Tüm projeleri göster".
10. Proje kartları bu ekrandan kalkar; üst çubuk düğmeleri kalır.
11. Mobil ≤640px: yatay kaydırma yok, proje + kalan süre ikinci satır, düğmeler ≥40px. Poll ile ≤4 sn güncelleme.
12. `esc()`/`safeColor()`; regresyon yeşil; yeni e2e.

## Analizde bulunan hatalar (bu işte düzeltilir)
- H1: `completeIssue`/`reopenIssue` seçili projenin durumlarını kullanıyor → işin kendi projesinin durumları.
- H2: hızlı atama listesi seçili projenin üyelerini veriyor → işin projesinin üyeleri.
- H3: `TODAY` sayfa açılışında sabit → ana ekran her çizimde bugünü yeniden hesaplar.
- `weekDays()` `DB.ui.week`'e bakıyor → ana ekran için ayrı hafta yardımcı fonksiyonu (çizelgeye dokunulmaz).

## Kapsam dışı (ayrı issue)
9b Benim açtıklarım (reporter) · 9c İzlediklerim (migration) · 9d Ekibin iş yükü (yönetici) · sürükle-bırak, bugüne çek.
