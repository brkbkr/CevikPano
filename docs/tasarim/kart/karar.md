# #8 ilk dilim — Modern kart + öncelik: analiz özeti ve PO kararları

Kapsam: issue #8 kabul kriterleri 1, 2, 3 ve 6. Kapsam dışı: yeni iş formu (4), animasyon ve "Geri al" (5).
Taslak: `taslak.html`, `acik.png`, `koyu.png`, `mobil.png`.

## Öncelik modeli (migration YOK)
- Veri olduğu gibi kalır (`issues.data.priority`, 1–5). Gösterim: `lvl(p)` → 1 Acil, 2 Yüksek, 3 Orta, 4 ve 5 Düşük;
  boş/geçersiz → Orta. Yeni yazımlar yalnız 1–4.
- Tüm seçiciler (iş detayı, yeni iş, hızlı ekleme, alt iş, toplu düzenleme, kural formu, hızlı menü) yalnız 4 seçenek;
  seçili değer `lvl(i.priority)`. Seçilen seviye `lvl(eski)` ile aynıysa hiçbir şey yazılmaz (5 olan iş 5 kalır).
- PQL `oncelik`: `lvl` ile; yeni adlar Acil/Yüksek/Orta/Düşük + eski adlar takma ad (Kritik→1, Önemsiz→4).
  `oncelik = 5` boş döner (kabul).
- Kulvar "Önceliğe göre": 4 grup. Ana sayfa sıralaması `lvl` ile.
- `pIcon` tanımsız değerde çökmesin (bugün çöküyor).
- İkonlar satır içi SVG (taslaktaki çizgi ikonlar), unicode simgeler kalkar.

## PO kararları
1. Kartta öncelik ikon + metin; dar alanlarda (backlog satırı, liste tablosu, ana sayfa) yalnız ikon + `title`/`aria-label`.
2. `oncelik = 5` aramada artık sonuç vermez — kabul.
3. Karttan kalkanlar: başlangıç tarihi, iş günü sayısı, faturalama rozeti (F✗). Puan çipi yalnız "puan" modülü açıkken.
   Bunlar iş detayında kalır.
4. Hiç çalışmayan "Atanan değişince" otomasyon tetiği düzeltilir: hızlı atama, iş detayı ve toplu düzenleme
   `runRules(i,'assigned')` çağırır.
5. Değişiklik geçmişine öncelik ve atanan adla yazılır ("Orta → Acil", "Adem → Burak"); eski kayıtlara dokunulmaz.
6. Sunucu: geçersiz öncelik reddedilmez; `applyRecord` içinde sayısal metin sayıya çevrilir, geçersiz değer 3 yapılır
   (`adjusted` döner). `validate.js`'e 1–5 tamsayı kuralı (düzeltmeden sonra çalışır).
7. Renk: **Orta nötr gri-mavi** (en sık görülen seviye dikkat çekmesin), Düşük açık gri; Acil kırmızı, Yüksek turuncu.
   Kırmızı yalnız Acil ve gecikmede.

## Uygulama notları
- Rozet ve avatar `<button data-qpri>` / `<button data-qas>` (`.btn` sınıfı YOK); global click işleyicisinde
  `.card`/`[data-open]`'dan önce yakalanır. İzleyicide düz `<span>`.
- Hızlı menü `body`'ye `position:fixed`; Esc ve dışarı tıklama kapatır (kartı açmaz). Menü açıkken `tryRerender`
  ertelenir. Mobilde (≤900px) alt sayfa, satırlar ≥ 44px.
- Atama listesi `projUsers()` + "Atanmamış" + üstte "Bana ata"; 8'den fazla kişide arama kutusu.
- Yeni "Kart v5" CSS katmanı, açık/koyu token'lar (taslaktaki `--p-*`, `--meta` vb.). Kart meta metni `--meta` (#64748B).
- "Tamamla" düğmesi masaüstünde üzerine gelince, mobilde her zaman görünür.
- Etiketler en fazla 2 + "+n", `esc()` ile.
