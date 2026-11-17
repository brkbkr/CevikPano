# ÇevikPano

Jira benzeri çevik proje yönetimi: pano (Kanban), backlog, sprint, zaman planı, zaman çizelgesi,
efor raporu, raporlar, arama ve kullanıcı/rol yönetimi.

İlk sürüm SharePoint'te tek bir HTML sayfası olarak çalışıyordu ve tüm veriyi
`KANBAN_DATA` listesindeki tek bir JSON metnine yazıyordu (check-in/check-out ile kilitleyerek).
Bu sürümde:

- **Arka uç** Node.js (Express) ile yazıldı, veri **PostgreSQL** veritabanında duruyor.
- **Gerçek giriş sistemi** var: parolalar sunucuda bcrypt ile saklanıyor, oturum çerezi httpOnly.
- **Aynı anda çalışma** destekleniyor: her kayıtta yalnızca değişen kayıtlar gönderiliyor,
  başka kullanıcıların değişiklikleri birkaç saniyede bir ekrana geliyor. Check-in/check-out yok.
- **Veri güvenliği:** aynı kayıtta alan düzeyinde birleştirme, çöp kutusu, günlük otomatik yedek,
  içe aktarma ve geri yükleme öncesi otomatik yedek, kayıt doğrulama, değişiklik günlüğü.
- **Bildirimler:** iş atandığında, işine yorum yapıldığında, `@kullanıcıadı` ile bahsedildiğinde.
  Kimin çevrim içi olduğu ve aynı işe kimin baktığı görünür.
- **Yeni arayüz:** modern tasarım, koyu tema, mobil uyum.

Ürün analizi ve yol haritası: [docs/URUN.md](docs/URUN.md)

## Klasörler

| Yol | İçerik |
|---|---|
| `server/` | Arka uç: `app.js` (API yolları), `auth.js` (giriş/oturum/parola), `store.js` (veri okuma-yazma, yetki, birleştirme), `backup.js` (yedek, içe aktarma, çöp kutusu, etkinlik), `notify.js` (bildirimler), `validate.js` (kayıt doğrulama) |
| `server/migrations/` | Sürümlü veritabanı şeması (`001_init.sql`, `002_robust.sql` ...), açılışta sırayla uygulanır |
| `public/index.html` | Ön yüz (tek dosya) |
| `legacy/` | SharePoint'te çalışan orijinal sürüm (referans için) |
| `test/` | API testleri (`api.test.js`), tarayıcı regresyon testi (`e2e/regresyon.cjs`), demo veri (`fixtures/demo.json`) |
| `scripts/seed-demo.mjs` | Demo ya da eski JSON veriyi API üzerinden yükler |
| `render.yaml` | Render.com'a tek tıkla kurulum tanımı |
| `Dockerfile` | Herhangi bir sunucuda çalıştırmak için imaj |

## Canlıya alma: Render.com (hızlı deneme)

1. https://render.com adresinde hesap açın (GitHub ile giriş yapmak en kolayı).
2. **New → Blueprint** seçin, `brkbkr/CevikPano` deposunu bağlayın.
   Dal olarak `main` (ya da bu sürümün bulunduğu dal) seçin.
3. Render `render.yaml` dosyasını okuyup bir **PostgreSQL** veritabanı ve bir **web servisi** gösterir.
   `ADMIN_PASSWORD` alanına yönetici parolasını yazın → **Apply**.
4. Birkaç dakika sonra servis `https://cevikpano.onrender.com` (ya da benzeri) adresinde açılır.
5. Kullanıcı adı **`admin`** ve belirlediğiniz parola ile giriş yapın.

> Ücretsiz planda servis 15 dakika kullanılmayınca uyur; ilk açılış ~30 sn sürebilir.
> Ücretsiz PostgreSQL 30 gün sonra silinir — kalıcı kullanım için veritabanını **Basic** plana
> yükseltin (ayda birkaç dolar). Web servisi için de **Starter** planı uyku sorununu kaldırır.

### SharePoint'teki verileri aktarma

1. SharePoint'teki eski panoda sol alttaki **↧ Dışa aktar** ile JSON dosyasını indirin.
2. Yeni uygulamaya `admin` ile girin, sol alttaki **↥ İçe aktar** ile dosyayı seçin.
3. Tüm projeler, işler, süre kayıtları, yorumlar ve kullanıcılar aktarılır.
   Aktarılan kullanıcıların parolası **başlangıç parolası** olur (Render'ın ürettiği
   `DEFAULT_USER_PASSWORD`; yönetici olarak *Proje ayarları → Kullanıcılar* ekranında görünür).
   Her kullanıcı ilk girişte kendi parolasını belirler.
4. Eski veride sistem kullanıcısı `root` da gelir. Kullanmayacaksanız Kullanıcılar ekranında pasifleştirin.

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | PostgreSQL bağlantı adresi (zorunlu) |
| `ADMIN_USERNAME` | İlk kurulumda oluşturulan yönetici (varsayılan `admin`) |
| `ADMIN_PASSWORD` | Yönetici parolası. Boşsa rastgele üretilir ve sunucu günlüğüne yazılır |
| `ADMIN_RESET_PASSWORD` | `true` yapılırsa açılışta yöneticinin parolası `ADMIN_PASSWORD` olur (parolayı unutursanız). Sonra kaldırın |
| `DEFAULT_USER_PASSWORD` | Yeni/içe aktarılan/sıfırlanan kullanıcıların başlangıç parolası |
| `SESSION_DAYS` | Oturum süresi (gün, varsayılan 30) |
| `PORT` | Dinlenen port (varsayılan 3000) |

## Kendi sunucunuzda çalıştırma (Oracle Cloud Always Free — önerilen)

Oracle'ın süresiz ücretsiz ARM sunucusu (4 çekirdek / 24 GB RAM'e kadar) bu uygulama için fazlasıyla yeterli.

1. https://www.oracle.com/cloud/free/ → hesap açın (kart yalnızca doğrulama içindir, ücret alınmaz).
   **Ana bölge (home region) sonradan değiştirilemez**; Frankfurt ya da Amsterdam iyi seçim.
2. *Compute → Instances → Create instance*:
   - Image: **Ubuntu 24.04** (ya da 22.04)
   - Shape: **Ampere → VM.Standard.A1.Flex**, 2 OCPU / 12 GB (Always Free sınırı içinde)
   - *Add SSH keys → Generate a key pair* → **iki anahtarı da indirin**
   - "Out of capacity" hatası alırsanız başka *Availability Domain* seçin ya da birkaç saat sonra tekrar deneyin.
3. Sunucunun sayfasında *Subnet → Default Security List → Add Ingress Rules*:
   Source CIDR `0.0.0.0/0`, TCP, Destination port **80**; aynısını **443** için ekleyin.
4. Sunucuya bağlanın (Windows'ta PowerShell):
   ```
   ssh -i indirilen-anahtar.key ubuntu@SUNUCU_IP
   ```
5. Tek komutla kurun:
   ```
   curl -fsSL https://raw.githubusercontent.com/brkbkr/CevikPano/main/scripts/oracle-kurulum.sh | sudo bash
   ```
   Betik yönetici parolasını sorar; sonunda site adresini (`https://<ip>.sslip.io`) yazar.
   Kendi alan adınız varsa DNS'te A kaydını sunucu IP'sine yönlendirip `sudo DOMAIN=pano.firmaniz.com bash` ile çalıştırın.

Betik Docker'ı kurar, PostgreSQL + uygulama + HTTPS'i (Caddy, Let's Encrypt) `docker-compose.yml` ile başlatır,
80/443 portlarını açar ve her gece veritabanı yedeği alır (`/opt/cevikpano/yedekler`, son 14 gün).
Güncellemek için aynı komutu tekrar çalıştırın; veriler ve parolalar korunur.

> Oracle, Always Free hesaplarda uzun süre neredeyse hiç kullanılmayan sunucuları geri alabiliyor.
> Hesabı "Pay As You Go"ya yükseltmek (Always Free kaynaklar yine ücretsiz kalır) bu riski kaldırır.

Başka bir Ubuntu sunucuda (Hetzner, DigitalOcean ...) da aynı betik çalışır. Elle kurmak için:
`cp .env.example .env` → düzenleyin → `docker compose up -d --build`.

## Geliştirme

```bash
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_dev ADMIN_PASSWORD=admin12345 npm run dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test   # test veritabanını sıfırlar
node scripts/seed-demo.mjs http://localhost:3000 test/fixtures/demo.json admin admin12345   # demo veri
node test/e2e/regresyon.cjs   # tarayıcı testi (temiz veritabanı + demo veri ister, bkz. dosya başı)
```

## Veritabanı yapısı

Her kayıt türünün kendi tablosu var: `users`, `projects`, `statuses`, `sprints`, `issues`,
`worklogs`, `comments`, `history`, `transitions`, `links`, `fields`, `rules`, `filters`,
ayrıca `settings` (genel ayarlar), `user_prefs` (kişisel ekran tercihleri), `sessions` (oturumlar),
`changes` (değişiklik günlüğü — canlı güncelleme ve denetim için), `deleted_records` (çöp kutusu),
`snapshots` (yedekler), `notifications` (bildirimler), `schema_migrations` (uygulanan şema sürümleri).

Bütünlük kuralları:
- Bir projede aynı iş anahtarı (PANO-12) iki kez olamaz (benzersiz indeks); çakışmada sunucu yeni numara verir.
- İşin harcanan süresi sunucuda süre kayıtlarının toplamından hesaplanır.
- İş silinince yorumları, süre kayıtları, geçmişi ve bağlantıları aynı işlemde çöp kutusuna taşınır;
  geri yüklenince hepsi birlikte döner.
- İki kişi aynı işin farklı alanlarını aynı anda değiştirirse ikisinin değişikliği de korunur
  (istemci değişiklikten önceki hâli `base` olarak gönderir, sunucu üç yönlü birleştirir).

Kaydın tamamı `data` (jsonb) sütununda; ilişki ve sorgu için gereken alanlar
(`project_id`, `status_id`, `assignee_id`, `sprint_id`, `issue_id`, `user_id`, `work_date` ...)
`data` içinden **generated column** olarak türetilip indeksleniyor. Böylece ön yüze yeni bir alan
eklemek şema değişikliği gerektirmiyor, ama veriler SQL ile raporlanabiliyor. Örnek:

```sql
-- Kişi başı bu ayki harcanan saat
SELECT u.name, sum((w.data->>'hours')::numeric) AS saat
FROM worklogs w JOIN users u ON u.id = w.user_id
WHERE w.work_date >= to_char(date_trunc('month', now()), 'YYYY-MM-DD')
GROUP BY u.name ORDER BY saat DESC;
```

## API

| Yol | Açıklama |
|---|---|
| `POST /api/auth/login` | `{username, password}` → oturum çerezi |
| `POST /api/auth/logout` | Oturumu kapat |
| `GET /api/auth/me` | Oturumdaki kullanıcı |
| `POST /api/auth/password` | `{oldPassword, newPassword}` kendi parolasını değiştir |
| `POST /api/users/:id/password` | (yönetici) parola belirle / sıfırla |
| `GET /api/state` | Tüm veri + değişiklik numarası |
| `GET /api/changes?since=N` | N'den sonra değişen kayıtlar |
| `POST /api/sync` | `{changes:[{c, id, op:'put'|'del', data}]}` değişiklikleri yaz |
| `GET /api/export` | (yönetici) tam JSON yedeği |
| `POST /api/import` | (yönetici) `{data}` tüm veriyi değiştirir; önce otomatik yedek alır, hesapları silmez |
| `GET/POST /api/backups`, `GET /api/backups/:id`, `POST /api/backups/:id/restore` | (yönetici) yedekler |
| `GET /api/trash`, `POST /api/trash/:id/restore` | (yönetici) çöp kutusu |
| `GET /api/activity` | (yönetici) son değişiklikler |
| `GET /api/notifications`, `POST /api/notifications/read` | bildirimler |
| `GET /healthz` | Sağlık kontrolü |

Değişiklik yapan tüm isteklerde `x-pano: 1` başlığı zorunlu (CSRF koruması).

## Roller

| Rol | Yetki |
|---|---|
| Süper yönetici | Her şey (ilk `admin` kullanıcısı bu roldedir) |
| Yönetici | Kullanıcı ekler/siler, parola sıfırlar, rol verir, içe aktarır |
| Üye | İş ve proje oluşturur/düzenler, kendi süresini kaydeder; durum, alan, otomasyon ve genel ayarları değiştiremez, proje silemez, başkasının süre kaydına dokunamaz |
| İzleyici | Yalnızca görüntüler |
