-- 002: veri güvenliği — çöp kutusu, yedekler, bildirimler, toplu değişiklik kimliği.

-- Her senkron isteği bir "batch"; geri alma ve denetim için.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS batch_id text;
CREATE INDEX IF NOT EXISTS changes_at_idx ON changes (at DESC);

-- Silinen kayıtlar kalıcı olarak kaybolmaz; buradan geri yüklenebilir.
CREATE TABLE IF NOT EXISTS deleted_records (
  id          bigserial PRIMARY KEY,
  collection  text NOT NULL,
  record_id   text NOT NULL,
  data        jsonb NOT NULL,
  batch_id    text,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  deleted_by  text
);
CREATE INDEX IF NOT EXISTS deleted_records_at_idx ON deleted_records (deleted_at DESC);
CREATE INDEX IF NOT EXISTS deleted_records_batch_idx ON deleted_records (batch_id);

-- Tam veri yedekleri (otomatik günlük + elle + içe aktarma/geri yükleme öncesi).
CREATE TABLE IF NOT EXISTS snapshots (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('auto','manual','pre-import','pre-restore')),
  label       text,
  data        jsonb NOT NULL,
  size_bytes  integer NOT NULL DEFAULT 0,
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS snapshots_created_idx ON snapshots (created_at DESC);

-- Uygulama içi bildirimler.
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- assigned | comment | mention | status
  issue_id    text,
  actor_id    text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Bir projede aynı iş anahtarı (PANO-12) iki kez olamaz.
-- Eski veride çakışma varsa önce düzeltilir: sonradan gelenlere yeni numara verilir.
DO $$
DECLARE r record; n integer; pfx text;
BEGIN
  FOR r IN
    SELECT id, project_id, issue_key FROM (
      SELECT id, project_id, issue_key,
             row_number() OVER (PARTITION BY project_id, issue_key ORDER BY ord) AS rn
      FROM issues WHERE issue_key IS NOT NULL) x
    WHERE rn > 1
  LOOP
    SELECT coalesce(max((substring(issue_key from '-(\d+)$'))::int), 0) + 1 INTO n
      FROM issues WHERE project_id = r.project_id;
    pfx := coalesce(substring(r.issue_key from '^(.*)-\d+$'), 'IS');
    UPDATE issues SET data = jsonb_set(data, '{key}', to_jsonb(pfx || '-' || n)) WHERE id = r.id;
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS issues_project_key_uq ON issues (project_id, issue_key)
  WHERE issue_key IS NOT NULL AND project_id IS NOT NULL;

-- Sorgu süresi sınırı (kaçak sorgular bağlantıları kilitlemesin).
-- Not: veritabanı düzeyinde değil, bağlantı havuzunda ayarlanır (db.js).
