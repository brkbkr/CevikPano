-- 011: kayıtlı raporlar (genel raporların adıyla saklanan ayarları). Yalnız ek tablo, VERİ SİLMEZ, tekrar çalıştırılabilir.
-- Eski sürüm bu tabloyu okumaz (reports dizisini tanımaz); başarısız dağıtımda eski sürüm bu şemayla açılır.
-- Kaydın tamamı data'da: { id, name, desc, ownerId, vis: 'private'|'shared', scope: { kind: 'all'|'ws'|'project', id },
-- cfg: { tab, row, col, ms, ch, per, month, from, to, f }, tpl, createdAt, updatedAt }. Kurallar: store.js, validate.js.
CREATE TABLE IF NOT EXISTS reports (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  owner_id    text GENERATED ALWAYS AS (data->>'ownerId') STORED,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
CREATE INDEX IF NOT EXISTS reports_owner_idx ON reports (owner_id);
