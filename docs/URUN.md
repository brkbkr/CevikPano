# ÇevikPano — Ürün analizi ve yol haritası

## Ürün ne yapıyor?

ÇevikPano küçük ve orta ölçekli ekiplerin **iş takibi + zaman takibi + faturalama** ihtiyacını tek yerde çözen,
Jira'nın sadeleştirilmiş bir karşılığı. Tipik kullanım (SharePoint'teki gerçek veriden):

- Danışmanlık / hizmet ekibi; işler çoğunlukla **müşteri takibi** ("X Bey aranacak", "sözleşme imzalanması").
- Her işin bir **sorumlusu**, **başlangıç–bitiş tarihi**, **tahmini süresi** ve **harcanan süresi** var.
- Gecikmeler kartın üzerinde kırmızı görünüyor ("3 iş günü gecikme"); ekip panoyu günlük takip ediyor.
- Süreler kişi bazında girilip **efor raporu** ve **faturalama** (kişi/saat, sabit) için kullanılıyor.

Yani ürünün asıl değeri: **"Kim, hangi müşteri için, ne kadar zaman harcadı ve neler gecikiyor?"**
sorusuna anında cevap vermesi.

## İlk sürümün (SharePoint) temel sorunları

| Sorun | Etki | Bu sürümde |
|---|---|---|
| Tüm veri tek bir JSON metninde | Bir kişi kaydederken diğerinin değişikliği eziliyor; veri büyüdükçe yavaşlıyor | Kayıt başına tablo, yalnızca değişen kayıt gönderiliyor ✅ |
| Check-in / check-out kilidi | Aynı anda tek kişi çalışabiliyor | Kilit yok; alan düzeyinde birleştirme ✅ |
| Parolalar tarayıcıda, "güvenlik sağlamaz" | Herkes herkesin verisini değiştirebilir | bcrypt, sunucu oturumu, rol yetkileri sunucuda ✅ |
| Silinen veri geri gelmiyor | Yanlışlıkla silinen iş ve süre kaydı kayboluyor | Çöp kutusu + bağlı kayıtlarla geri yükleme ✅ |
| Yedek yok | Liste bozulursa her şey gider | Günlük otomatik + elle yedek, tek tıkla geri yükleme ✅ |
| Aynı anda iş açınca aynı numara | PANO-23 iki kez | Sunucu benzersiz numara veriyor ✅ |
| Kimseye haber gitmiyor | İş atandığını, yorum yapıldığını fark etmiyorsun | Bildirim zili, @bahsetme ✅ |
| Mobilde kullanılamıyor | Sahada kullanılamıyor | Mobil düzen ✅ |

## Bu sürümde eklenenler

**Veri ve güvenlik**
- PostgreSQL; sürümlü şema geçişleri; kayıt doğrulama; değişiklik günlüğü.
- Eşzamanlı düzenlemede alan düzeyinde birleştirme (A özeti, B önceliği değiştirirse ikisi de kalır).
- Çöp kutusu, otomatik/elle yedek, içe aktarma ve geri yükleme öncesi otomatik yedek.
- Kaba kuvvet koruması, CSRF koruması, httpOnly çerez, rol tabanlı yetki.

**Ürün**
- Bildirimler: iş atandığında, işine yorum yapıldığında, `@kullanıcıadı` ile bahsedildiğinde, durum değiştiğinde.
- Çevrim içi göstergesi: kimin uygulamada olduğu ve aynı işe kimin baktığı.
- Sistem ekranı (yönetici): yedekler, çöp kutusu, kim neyi ne zaman değiştirdi.
- Canlı güncelleme: başkasının değişikliği 4 saniye içinde ekranda.

**Arayüz**
- Yeni tasarım dili (Inter, sade renkler, yumuşak gölgeler), **koyu tema**, mobil uyum.

## Yol haritası (öncelik sırasıyla)

### Sonraki adım (1–2 hafta)
1. **E-posta bildirimi** — atama ve @bahsetme için e-posta (SMTP ayarı ile). Kullanıcılar uygulamayı açmasa da haberdar olur.
2. **Dosya eki** — işe teklif, sözleşme, ekran görüntüsü ekleme (S3 uyumlu depolama).
3. **Müşteri kartı** — "Müşteri" şu an bir özel alan; ayrı bir varlık olmalı (iletişim bilgisi, müşteri bazlı efor ve fatura raporu).
4. **Tekrarlayan işler** — "Her ay yılbaşı hatırlatması" gibi periyodik işler otomatik oluşsun.
5. **Hatırlatma** — bitiş tarihi yaklaşan / geçen işler için sabah özeti.

### Orta vade (1–2 ay)
6. **Fatura dışa aktarma** — ay sonu müşteri bazlı kişi/saat dökümü (PDF/Excel), muhasebe programına aktarım.
7. **Gelişmiş yetki** — proje bazlı rol (bir projede yönetici, diğerinde izleyici).
8. **Microsoft 365 / SSO girişi** — ekip zaten Microsoft kullanıyor; Entra ID ile tek tıkla giriş.
9. **Takvim entegrasyonu** — bitiş tarihleri Outlook takvimine.
10. **Genel API anahtarı ve webhook** — başka sistemlerden iş açma.

### Teknik borç
- Ön yüz 5.600 satırlık tek dosya. Bir sonraki büyük özellikten önce modüllere ayrılmalı (Vite + ES modülleri).
- Tüm veri açılışta tek seferde yükleniyor; 10.000+ işte sayfalama/sanal liste gerekir.
- Canlı güncelleme 4 sn'lik sorgulama ile; çok kullanıcıda WebSocket/SSE'ye geçilmeli.
- Çevrim içi bilgisi sunucu belleğinde; birden çok sunucu örneğinde Redis'e taşınmalı.

## Başarı ölçütleri
- Günlük aktif kullanıcı / toplam kullanıcı ≥ %70
- Süre kaydı girilen iş günü oranı ≥ %90 (faturalamanın temeli)
- Gecikmiş iş oranı (açık işlerde) aylık düşüş
- Veri kaybı olayı: 0
