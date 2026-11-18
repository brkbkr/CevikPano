-- 005: müşteri atamaları cariden (görev 11b). Yalnızca ekler, VERİ SİLMEZ, tekrar çalıştırılabilir;
-- eski sürüm bu şemayla da açılır (işlerdeki customerId alanını birleştirmede korur, gizli alanı
-- yine görür; değerler issues.data->'cf' içinde durur).
--  1) Eski "Müşteri" seçim alanındaki her farklı değer (boşluk kırpılır, ardışık boşluklar tekleşir,
--     büyük/küçük harf ayrımı yok) için bir cari: aynı adlı (aynı normalleştirmeyle) cari varsa o
--     kullanılır; yoksa 'cu_m_' || md5(normal ad) kimlikli yeni cari açılır (ad = en sık yazım).
--  2) customerId'si boş her işe bu cari yazılır.
--  3) Alan tanımı silinmez: archived/hidden işaretlenir (istemci göstermez).
-- Her değişen kayıt için changes satırı (açık sekmeler /api/changes ile alır).

-- İşin bağlı olduğu cari (en çok bir). Silme/birleştirmede bağlı iş sayımı bu indeksi kullanır.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS customer_id text
  GENERATED ALWAYS AS (data->>'customerId') STORED;
CREATE INDEX IF NOT EXISTS issues_customer_idx ON issues (customer_id);

-- Eski müşteri alanı(ları): 'Müşteri' adlı ya da 'musteri' anahtarlı seçim alanları.
CREATE TEMP TABLE _mc_f ON COMMIT DROP AS
  SELECT id, ord FROM fields
   WHERE data->>'type' = 'select'
     AND (data->>'key' = 'musteri'
          OR lower(btrim(regexp_replace(coalesce(data->>'name', ''), '\s+', ' ', 'g'))) IN ('müşteri', 'musteri'));

-- Carisi boş işlerin müşteri değeri (birden çok alan doluysa ilk alan).
CREATE TEMP TABLE _mc_v ON COMMIT DROP AS
  SELECT DISTINCT ON (i.id) i.id AS issue_id,
         left(btrim(regexp_replace(i.data->'cf'->>f.id, '\s+', ' ', 'g')), 200) AS v
    FROM issues i JOIN _mc_f f ON jsonb_typeof(i.data->'cf') = 'object'
                                AND jsonb_typeof(i.data->'cf'->f.id) = 'string'
   WHERE btrim(i.data->'cf'->>f.id) <> ''
     AND coalesce(i.data->>'customerId', '') = ''
   ORDER BY i.id, f.ord;
ALTER TABLE _mc_v ADD COLUMN k text;
UPDATE _mc_v SET k = lower(v);

-- Normal ad → cari (var olan aynı adlı cari önce).
CREATE TEMP TABLE _mc_k ON COMMIT DROP AS
  SELECT m.k, mode() WITHIN GROUP (ORDER BY m.v) AS name,
         (SELECT c.id FROM customers c
           WHERE lower(btrim(regexp_replace(coalesce(c.data->>'name', ''), '\s+', ' ', 'g'))) = m.k
           ORDER BY c.ord LIMIT 1) AS cid
    FROM _mc_v m GROUP BY m.k;

WITH ins AS (
  INSERT INTO customers (id, data)
  SELECT 'cu_m_' || md5(k),
         jsonb_build_object('id', 'cu_m_' || md5(k), 'name', name, 'kind', 'customer', 'active', true, 'contacts', '[]'::jsonb)
    FROM _mc_k WHERE cid IS NULL
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO changes (collection, record_id, op) SELECT 'customers', id, 'put' FROM ins;
UPDATE _mc_k SET cid = 'cu_m_' || md5(k) WHERE cid IS NULL;

WITH u AS (
  UPDATE issues i SET data = i.data || jsonb_build_object('customerId', k.cid), version = i.version + 1, updated_at = now()
    FROM _mc_v m JOIN _mc_k k ON k.k = m.k
   WHERE i.id = m.issue_id AND coalesce(i.data->>'customerId', '') = ''
  RETURNING i.id
)
INSERT INTO changes (collection, record_id, op) SELECT 'issues', id, 'put' FROM u;

WITH u AS (
  UPDATE fields SET data = data || '{"archived":true,"hidden":true}'::jsonb, version = version + 1, updated_at = now()
   WHERE id IN (SELECT id FROM _mc_f)
     AND NOT (data @> '{"archived":true,"hidden":true}'::jsonb)
  RETURNING id
)
INSERT INTO changes (collection, record_id, op) SELECT 'fields', id, 'put' FROM u;
