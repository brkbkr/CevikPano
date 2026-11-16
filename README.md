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
- Ön yüz, mevcut uygulamanın arayüzünün aynısı (`public/index.html`).

## Klasörler

| Yol | İçerik |
|---|---|
| `server/` | Arka uç: `app.js` (API yolları), `auth.js` (giriş/oturum/parola), `store.js` (veri okuma-yazma, yetki), `schema.sql` (veritabanı şeması) |
| `public/index.html` | Ön yüz (tek dosya) |
| `legacy/` | SharePoint'te çalışan orijinal sürüm (referans için) |
| `test/` | API testleri |
| `render.yaml` | Render.com'a tek tıkla kurulum tanımı |
| `Dockerfile` | Herhangi bir sunucuda çalıştırmak için imaj |

## Canlıya alma (Render.com — önerilen)

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

## Kendi sunucunuzda (VPS) çalıştırma

```bash
docker run -d --name pano-db -e POSTGRES_PASSWORD=gizli -v pano-db:/var/lib/postgresql/data postgres:16
docker build -t cevikpano .
docker run -d --name pano --link pano-db -p 80:3000 \
  -e DATABASE_URL=postgres://postgres:gizli@pano-db:5432/postgres \
  -e ADMIN_PASSWORD='GüçlüBirParola' cevikpano
```

HTTPS için önüne Caddy ya da Nginx koyun.

## Geliştirme

```bash
npm install
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_dev ADMIN_PASSWORD=admin12345 npm run dev
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test   # test veritabanını sıfırlar
```

## Veritabanı yapısı

Her kayıt türünün kendi tablosu var: `users`, `projects`, `statuses`, `sprints`, `issues`,
`worklogs`, `comments`, `history`, `transitions`, `links`, `fields`, `rules`, `filters`,
ayrıca `settings` (genel ayarlar), `user_prefs` (kişisel ekran tercihleri), `sessions` (oturumlar),
`changes` (değişiklik günlüğü — canlı güncelleme ve denetim için).

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
| `GET /healthz` | Sağlık kontrolü |

Değişiklik yapan tüm isteklerde `x-pano: 1` başlığı zorunlu (CSRF koruması).

## Roller

| Rol | Yetki |
|---|---|
| Süper yönetici | Her şey (ilk `admin` kullanıcısı bu roldedir) |
| Yönetici | Kullanıcı ekler/siler, parola sıfırlar, rol verir, içe aktarır |
| Üye | İş oluşturur, düzenler, süre kaydeder; yalnızca kendi profilini değiştirir |
| İzleyici | Yalnızca görüntüler |
