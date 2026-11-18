# ÇevikPano — proje kuralları

Jira benzeri çevik proje yönetimi. Arayüz ve tüm metinler **Türkçe**; kullanıcıyla Türkçe konuş.

## Mimari
- `server/` Node.js 20+ (ESM) + Express 4 + PostgreSQL (`pg`). Bağımlılık eklemeden önce iki kez düşün.
- `public/index.html` tek dosyalık ön yüz (bağımlılıksız, derleme adımı yok). Tüm veri bellekteki
  global `DB` nesnesinde durur; değişiklikten sonra `save()` çağrılır. `save()` → `flushSync()`
  önceki anlık görüntüyle (`SNAP`) farkı bulur ve yalnızca değişen kayıtları `/api/sync`'e gönderir.
  `poll()` her 4 sn'de `/api/changes` ile başkalarının değişikliklerini çeker.
- `DB` içindeki her **dizi** bir tabloya (`server/db.js` → `TABLES`), dizi olmayan üst düzey
  anahtarlar `settings` tablosuna, `ui`/`board`/`open` kişisel `user_prefs`'e gider.
  Yeni bir dizi eklenirse önce `misc_records`'a düşer; kalıcıysa yeni bir geçiş dosyasıyla tablo ve `TABLES`'a kayıt ekle.
- Kullanıcı parolaları yalnızca sunucuda (bcrypt). İstemciye `pw`/`salt`/`password_hash` gönderilmez,
  istemciden gelirse silinir. Yetki kontrolleri `server/store.js` → `applyUser` / `applyChanges` içinde.
- Şema `server/migrations/NNN_ad.sql` dosyalarında; her biri bir kez, sırayla, kendi işleminde uygulanır
  (`schema_migrations`). Var olan bir geçiş dosyasını DEĞİŞTİRME — yeni numaralı dosya ekle.
- Yetki ve bütünlük kuralları sunucuda (`store.js`: `ADMIN_ONLY`, süre kaydı sahipliği, iş anahtarı,
  harcanan süre, silmede bağlı kayıtlar). İstemcideki kontroller yalnızca kullanıcı deneyimi içindir.
- Ön yüzde kullanıcıdan gelen her metni `esc()` ile bas; renkleri `safeColor()` ile.
- `legacy/` SharePoint sürümüdür; değiştirme.

## Komutlar
- Geliştirme: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_dev ADMIN_PASSWORD=admin12345 npm run dev`
- Test: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test` (test DB'yi sıfırlar)
- Yerel PostgreSQL: `service postgresql start`
- Tarayıcı regresyonu: temiz DB + `node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json` + `DATABASE_URL=… node scripts/apply-sql.mjs server/migrations/005_musteri_cari.sql` (demo Müşteri alanını cariye çevirir) + `node test/e2e/regresyon.cjs` (tüm takımlar: `.github/workflows/test.yml`)
  (sunucu `ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100` ile).

## Çalışma süreci ve roller
- Her istek `.claude/skills/gelistirme-sureci/SKILL.md` sürecinden geçer: Product Owner → İş analisti → Web tasarımcısı →
  Yazılımcı → Testçi + Güvenlik uzmanı → test sitesi → PO kabulü → kullanıcı onayı. Roller `.claude/agents/` altında;
  her adımda ilgili rolü ayrı alt ajan olarak çalıştır. Testçi ve güvenlik uzmanı hiçbir işte atlanmaz.
- **"başla"**: kullanıcı bunu yazınca `.claude/skills/basla/SKILL.md` (en az 8 saat sürekli geliştirme döngüsü).
  **"dur"**: döngüyü hemen kapat, özet yaz. Notlar GitHub'daki "🤖 Geliştirme günlüğü" issue'sunda.
- Yeni görsel dil/yerleşim/ekran için taslak hazırlanır (`docs/tasarim/`).
- PR'ları birleştirmek ve canlıya yayınlamak kullanıcının kararıdır.

## Ortamlar ve yayın
- Sunucu (Oracle, Ubuntu ARM): canlı `/opt/cevikpano` ← GitHub `production`; test `/opt/cevikpano-test` ← `test`.
  `test` dalını `.github/workflows/teste-gonder.yml` günceller (testleri geçen son `claude/*` push'u ya da `main`);
  `test` dalına elle push yapma.
  `deploy/pano-deploy.sh` (systemd zamanlayıcı, 2 dk) dalı izler, kurar, sağlık kontrolü yapar, başarısızsa geri döner.
- Akış: `claude/<konu>` dalına push → CI yeşil → test sitesi → kullanıcı PR'ı onaylar (`main`) →
  kullanıcı "Canlıya yayınla" (yalnızca `main`'deki, testleri geçmiş sürümler yayınlanabilir).
  `production` dalına elle push yapma.
- Ortak kapı: `deploy/edge.yml` + `deploy/Caddyfile`. Uygulama `docker-compose.yml` (app + db), `pano-edge` ağına bağlanır.
- Geçişler geri alınamaz: yeni migration'lar her zaman eski kodla da çalışacak şekilde (ek tablo/kolon) yazılmalı,
  çünkü başarısız dağıtımda eski sürüm yeni şemayla açılır.
- Gizli değerler sunucudaki `.env` dosyalarında; depo herkese açık.
