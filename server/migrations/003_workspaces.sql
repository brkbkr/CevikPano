-- 003: çalışma alanları (#22). Yalnızca ek tablo ve ek (üretilen) sütun:
-- eski sürüm bu şemayla da açılır (yeni tabloyu okumaz, projelerdeki
-- workspaceId alanını birleştirmede korur). Tekrar çalıştırılabilir.

CREATE TABLE IF NOT EXISTS workspaces (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  archived    boolean GENERATED ALWAYS AS (coalesce((data->>'archived')::boolean, false)) STORED,
  created_by  text GENERATED ALWAYS AS (data->>'createdBy') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Projenin bağlı olduğu alan. Alanı olmayan proje "Genel" (ws1) sayılır.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id text
  GENERATED ALWAYS AS (data->>'workspaceId') STORED;
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects (workspace_id);

-- Varsayılan alan. Açık sekmeler değişikliği /api/changes ile alır.
WITH w AS (
  INSERT INTO workspaces (id, data)
  VALUES ('ws1', '{"id":"ws1","name":"Genel","color":"#64748B","description":"","archived":false,"createdBy":null}'::jsonb)
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO changes (collection, record_id, op) SELECT 'workspaces', id, 'put' FROM w;

-- Alanı olmayan tüm projeler (arşivliler dahil) "Genel"e bağlanır.
WITH u AS (
  UPDATE projects SET data = data || '{"workspaceId":"ws1"}'::jsonb, version = version + 1, updated_at = now()
   WHERE coalesce(data->>'workspaceId', '') = ''
  RETURNING id
)
INSERT INTO changes (collection, record_id, op) SELECT 'projects', id, 'put' FROM u;
