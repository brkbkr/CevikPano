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
  Yeni bir dizi eklenirse önce `misc_records`'a düşer; kalıcıysa `schema.sql`'e tablo ve `TABLES`'a kayıt ekle.
- Kullanıcı parolaları yalnızca sunucuda (bcrypt). İstemciye `pw`/`salt`/`password_hash` gönderilmez,
  istemciden gelirse silinir. Yetki kontrolleri `server/store.js` → `applyUser` / `applyChanges` içinde.
- Şema `server/schema.sql` her açılışta çalışır: yalnızca `CREATE ... IF NOT EXISTS` / geriye dönük
  uyumlu değişiklikler yaz. Sütun eklerken `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` kullan.
- `legacy/` SharePoint sürümüdür; değiştirme.

## Komutlar
- Geliştirme: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_dev ADMIN_PASSWORD=admin12345 npm run dev`
- Test: `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test` (test DB'yi sıfırlar)
- Yerel PostgreSQL: `service postgresql start`
- Ön yüz değişikliğinden sonra Playwright ile tarayıcıda dene (giriş, pano, iş oluşturma, ikinci kullanıcıyla canlı güncelleme).

## Canlı ortam
Render.com Blueprint (`render.yaml`): `cevikpano` web servisi (Docker) + `cevikpano-db` PostgreSQL.
`main`'e push → otomatik deploy. Gizli değerler (`ADMIN_PASSWORD`) depoya yazılmaz; depo herkese açık.
