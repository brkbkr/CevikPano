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
- Tarayıcı regresyonu: temiz DB + `node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json` + `node test/e2e/regresyon.cjs`
  (sunucu `ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100` ile).

## Canlı ortam
Render.com Blueprint (`render.yaml`): `cevikpano` web servisi (Docker) + `cevikpano-db` PostgreSQL.
`main`'e push → otomatik deploy. Gizli değerler (`ADMIN_PASSWORD`) depoya yazılmaz; depo herkese açık.
