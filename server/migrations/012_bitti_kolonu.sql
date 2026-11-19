-- 012: tamamlanan işler Bitti kolonunda. Yalnızca veriyi günceller (kolon/tablo silmez), tekrar çalıştırılabilir;
-- eski sürüm bu veriyle de açılır.
-- Eski pano, Bitti kategorili durumdaki işi `doneFrom` (tamamlandığı kolon) alanına göre o kolonun altında katlanmış
-- "Tamamlananlar" grubunda gösteriyordu. Yeni pano işi her zaman durumunun kolonunda (Bitti) gösterir. Bu geçiş,
-- başka bir kolonda görünen tamamlanmış işlerin `doneFrom` alanını kaldırır (eski sürüm de onları Bitti kolonunda
-- gösterir), her işin geçmişine "Pano kolonu: <eski kolon> → <Bitti kolonu>" yazar; her değişen kayıt için changes
-- satırı (açık sekmeler /api/changes ile alır).
-- (Bitti kolonu olmayan projeye kolon ekleme her açılışta store.js → ensureDoneColumns ile yapılır.)

CREATE TEMP TABLE _bk ON COMMIT DROP AS
  SELECT i.id, f.id AS from_id, coalesce(f.data->>'name', '') AS from_name, coalesce(s.data->>'name', '') AS to_name
    FROM issues i
    JOIN statuses s ON s.id = i.status_id AND s.project_id = i.project_id AND s.category = 'done'
    JOIN statuses f ON f.id = i.data->>'doneFrom' AND f.project_id = i.project_id AND f.id <> s.id;

WITH u AS (
  UPDATE issues i SET data = i.data - 'doneFrom', version = i.version + 1, updated_at = now()
    FROM _bk b
   WHERE i.id = b.id AND i.data->>'doneFrom' = b.from_id
  RETURNING i.id
)
INSERT INTO changes (collection, record_id, op) SELECT 'issues', id, 'put' FROM u;

WITH h AS (
  INSERT INTO history (id, data)
  SELECT 'h_bk_' || md5(b.id || ':' || b.from_id),
         jsonb_build_object('id', 'h_bk_' || md5(b.id || ':' || b.from_id), 'issueId', b.id, 'userId', NULL,
                            'at', (extract(epoch FROM now()) * 1000)::bigint, 'field', 'Pano kolonu',
                            'from', left(b.from_name, 200), 'to', left(b.to_name, 200))
    FROM _bk b
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
INSERT INTO changes (collection, record_id, op) SELECT 'history', id, 'put' FROM h;
