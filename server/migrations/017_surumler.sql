-- 017: sürümler / teslim paketleri (Jira Releases). Yalnız ek tablo, VERİ SİLMEZ, tekrar çalıştırılabilir.
-- Eski sürüm bu tabloyu okumaz (versions dizisini tanımaz); başarısız dağıtımda eski sürüm bu şemayla açılır.
-- İşin sürümleri işin kendi kaydında: issues.data.versionIds (kimlik dizisi; eski sürüm alanı bilmez, korur).
-- Kaydın tamamı data'da: { id, projectId, name, desc, start, due, state: 'planned'|'released'|'archived', releasedAt,
-- createdAt, updatedAt }. Kurallar: store.js (proje bazlı yetki: project.settings), validate.js.
CREATE TABLE IF NOT EXISTS versions (
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
CREATE INDEX IF NOT EXISTS versions_project_idx ON versions (project_id);
