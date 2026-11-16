-- CevikPano veritabanı şeması (PostgreSQL 13+)
-- Her uygulama açılışında çalışır; tekrar çalıştırılması güvenlidir.
--
-- Tasarım:
--   * Her kayıt türü kendi tablosunda durur. Kaydın tamamı `data` (jsonb)
--     sütunundadır; sorgu ve ilişki için gereken alanlar `data` içinden
--     GENERATED sütun olarak çıkarılır ve indekslenir. Böylece ön yüz yeni
--     bir alan eklediğinde şema değişikliği gerekmez, ama veritabanı yine
--     de ilişkisel olarak sorgulanabilir.
--   * Kullanıcılar ayrıdır: parola özeti (bcrypt) yalnızca `users` tablosunda,
--     istemciye hiç gönderilmez.
--   * `changes` tablosu her yazmayı sıra numarasıyla kaydeder. İstemciler
--     "şu numaradan sonra ne değişti" diye sorarak canlı güncellenir.

CREATE TABLE IF NOT EXISTS users (
  id             text PRIMARY KEY,
  username       text NOT NULL,
  name           text NOT NULL DEFAULT '',
  role           text NOT NULL DEFAULT 'member'
                 CHECK (role IN ('super','admin','member','viewer')),
  active         boolean NOT NULL DEFAULT true,
  password_hash  text,
  must_change    boolean NOT NULL DEFAULT true,
  system         boolean NOT NULL DEFAULT false,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- ini, color, capacity, ...
  ord            bigserial,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- Ortak kayıt tablosu kalıbı ------------------------------------------------
-- Not: Tablolar arası FOREIGN KEY bilerek konmadı. Ön yüz kayıtları tek tek ve
-- sırasız gönderir (ör. iş, durumundan önce gelebilir); bütünlük uygulama
-- katmanında korunur.

CREATE TABLE IF NOT EXISTS projects (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  key         text GENERATED ALWAYS AS (data->>'key') STORED,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  lead_id     text GENERATED ALWAYS AS (data->>'lead') STORED,
  archived    boolean GENERATED ALWAYS AS (coalesce((data->>'archived')::boolean, false)) STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS statuses (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  project_id  text GENERATED ALWAYS AS (data->>'projectId') STORED,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  category    text GENERATED ALWAYS AS (data->>'cat') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS statuses_project_idx ON statuses (project_id);

CREATE TABLE IF NOT EXISTS sprints (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  project_id  text GENERATED ALWAYS AS (data->>'projectId') STORED,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  state       text GENERATED ALWAYS AS (data->>'state') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS sprints_project_idx ON sprints (project_id);

CREATE TABLE IF NOT EXISTS issues (
  id           text PRIMARY KEY,
  data         jsonb NOT NULL,
  project_id   text GENERATED ALWAYS AS (data->>'projectId') STORED,
  issue_key    text GENERATED ALWAYS AS (data->>'key') STORED,
  type         text GENERATED ALWAYS AS (data->>'type') STORED,
  summary      text GENERATED ALWAYS AS (data->>'summary') STORED,
  status_id    text GENERATED ALWAYS AS (data->>'statusId') STORED,
  assignee_id  text GENERATED ALWAYS AS (data->>'assignee') STORED,
  reporter_id  text GENERATED ALWAYS AS (data->>'reporter') STORED,
  sprint_id    text GENERATED ALWAYS AS (data->>'sprintId') STORED,
  epic_id      text GENERATED ALWAYS AS (data->>'epicId') STORED,
  parent_id    text GENERATED ALWAYS AS (data->>'parentId') STORED,
  due          text GENERATED ALWAYS AS (data->>'due') STORED,
  version      integer NOT NULL DEFAULT 1,
  ord          bigserial,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS issues_project_idx  ON issues (project_id);
CREATE INDEX IF NOT EXISTS issues_status_idx   ON issues (status_id);
CREATE INDEX IF NOT EXISTS issues_assignee_idx ON issues (assignee_id);
CREATE INDEX IF NOT EXISTS issues_sprint_idx   ON issues (sprint_id);
CREATE INDEX IF NOT EXISTS issues_key_idx      ON issues (issue_key);

CREATE TABLE IF NOT EXISTS worklogs (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  issue_id    text GENERATED ALWAYS AS (data->>'issueId') STORED,
  user_id     text GENERATED ALWAYS AS (data->>'userId') STORED,
  work_date   text GENERATED ALWAYS AS (data->>'date') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS worklogs_issue_idx ON worklogs (issue_id);
CREATE INDEX IF NOT EXISTS worklogs_user_date_idx ON worklogs (user_id, work_date);

CREATE TABLE IF NOT EXISTS comments (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  issue_id    text GENERATED ALWAYS AS (data->>'issueId') STORED,
  user_id     text GENERATED ALWAYS AS (data->>'userId') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments (issue_id);

CREATE TABLE IF NOT EXISTS history (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  issue_id    text GENERATED ALWAYS AS (data->>'issueId') STORED,
  user_id     text GENERATED ALWAYS AS (data->>'userId') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS history_issue_idx ON history (issue_id);

CREATE TABLE IF NOT EXISTS transitions (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  issue_id    text GENERATED ALWAYS AS (data->>'issueId') STORED,
  from_status text GENERATED ALWAYS AS (data->>'from') STORED,
  to_status   text GENERATED ALWAYS AS (data->>'to') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS transitions_issue_idx ON transitions (issue_id);

CREATE TABLE IF NOT EXISTS links (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  from_issue  text GENERATED ALWAYS AS (data->>'from') STORED,
  to_issue    text GENERATED ALWAYS AS (data->>'to') STORED,
  link_type   text GENERATED ALWAYS AS (data->>'type') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS fields (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  project_id  text GENERATED ALWAYS AS (data->>'projectId') STORED,
  field_key   text GENERATED ALWAYS AS (data->>'key') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS rules (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  project_id  text GENERATED ALWAYS AS (data->>'projectId') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

CREATE TABLE IF NOT EXISTS filters (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Ön yüzün ileride ekleyebileceği, yukarıda tablosu olmayan diziler.
CREATE TABLE IF NOT EXISTS misc_records (
  collection  text NOT NULL,
  id          text NOT NULL,
  data        jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (collection, id)
);

-- Genel ayarlar (cfg: modüller, iş tipleri, çalışma saatleri ...).
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Kişiye özel ekran tercihleri (seçili proje, görünüm, pano filtreleri).
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Değişiklik günlüğü: canlı güncelleme ve denetim için.
CREATE TABLE IF NOT EXISTS changes (
  seq         bigserial PRIMARY KEY,
  collection  text NOT NULL,
  record_id   text NOT NULL,
  op          text NOT NULL CHECK (op IN ('put','del')),
  user_id     text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS changes_record_idx ON changes (collection, record_id);
