-- 009: proje bazlı yetkiler (yetki-v2). Yalnız veri EKLER (şema değişmez), hiçbir alanı silmez; tekrar çalıştırılabilir:
-- her adım yalnız ilgili alanı henüz OLMAYAN kayda dokunur (NOT (data ? 'admins'), NOT (data ? 'roles')).
-- Eski sürüm bu veriyle açılır: roles/admins alanlarını bilmez ve birleştirmede korur; workspaces.data.members değişmez
-- (eski erişim kuralı aynı kalır). Kural server/perms.js legacyRole ile aynıdır: kimse bugün gördüğü projeyi kaybetmez.

-- 1) Alan yöneticileri: alanın üye listesinde Yönetici rolündeki var olan kişiler (sahip hariç; sahip her zaman yönetici).
WITH u AS (
  UPDATE workspaces w SET data = w.data || jsonb_build_object('admins', coalesce((
      SELECT jsonb_agg(x.uid ORDER BY x.o) FROM (
        SELECT DISTINCT ON (e.m->>'userId') e.m->>'userId' AS uid, e.m->>'role' AS role, e.o
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.data->'members') = 'array' THEN w.data->'members' ELSE '[]'::jsonb END)
               WITH ORDINALITY e(m, o)
         WHERE jsonb_typeof(e.m) = 'object' AND e.m->>'userId' IS NOT NULL
         ORDER BY e.m->>'userId', e.o) x
       WHERE x.role = 'admin'
         AND x.uid IS DISTINCT FROM coalesce(w.data->>'ownerId', w.data->>'createdBy')
         AND EXISTS (SELECT 1 FROM users us WHERE us.id = x.uid)), '[]'::jsonb)),
    version = w.version + 1, updated_at = now()
   WHERE NOT (w.data ? 'admins')
  RETURNING w.id
)
INSERT INTO changes (collection, record_id, op) SELECT 'workspaces', id, 'put' FROM u;

-- 2) Proje rolleri (roles) ve üye listesi (members = roles'taki kişiler).
--    Üyeli alan: alandaki her Üye/İzleyici alandaki rolüyle (alan sahibi ve alan yöneticileri eklenmez: alan yöneticisi
--    olarak zaten görür). Üyesiz (eski) alan: projenin üye listesi doluysa listedekiler, boşsa tüm kullanıcılar; genel
--    rolü İzleyici olan İzleyici, diğerleri Üye. Sistem kullanıcıları (u_posta) hiçbir projeye eklenmez.
DO $$
DECLARE
  p record; w jsonb; roles jsonb; mem jsonb; has_members boolean; n integer := 0;
BEGIN
  FOR p IN SELECT id, data FROM projects WHERE NOT (data ? 'roles') ORDER BY ord LOOP
    SELECT data INTO w FROM workspaces WHERE id = coalesce(nullif(p.data->>'workspaceId', ''), 'ws1');
    IF w IS NULL THEN SELECT data INTO w FROM workspaces WHERE id = 'ws1'; END IF;
    has_members := w IS NOT NULL AND (CASE WHEN jsonb_typeof(w->'members') = 'array' THEN jsonb_array_length(w->'members') > 0 ELSE false END);
    IF has_members THEN
      SELECT coalesce(jsonb_object_agg(x.uid, x.role), '{}'::jsonb) INTO roles
        FROM (SELECT DISTINCT ON (e.m->>'userId') e.m->>'userId' AS uid, e.m->>'role' AS role
                FROM jsonb_array_elements(w->'members') WITH ORDINALITY e(m, o)
               WHERE jsonb_typeof(e.m) = 'object' AND e.m->>'userId' IS NOT NULL
               ORDER BY e.m->>'userId', e.o) x
        JOIN users u ON u.id = x.uid AND NOT u.system
       WHERE x.role IN ('member', 'viewer')
         AND x.uid IS DISTINCT FROM coalesce(w->>'ownerId', w->>'createdBy');
    ELSE
      SELECT coalesce(jsonb_object_agg(u.id, CASE WHEN u.role = 'viewer' THEN 'viewer' ELSE 'member' END), '{}'::jsonb) INTO roles
        FROM users u
       WHERE NOT u.system
         AND (CASE WHEN jsonb_typeof(p.data->'members') = 'array' THEN jsonb_array_length(p.data->'members') = 0 ELSE true END
              OR p.data->'members' ? u.id);
    END IF;
    SELECT coalesce(jsonb_agg(k.k ORDER BY coalesce(z.o, 1000000000), k.k), '[]'::jsonb) INTO mem
      FROM jsonb_object_keys(roles) k(k)
      LEFT JOIN LATERAL (
        SELECT min(e.o) AS o
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'members') = 'array' THEN p.data->'members' ELSE '[]'::jsonb END)
               WITH ORDINALITY e(v, o)
         WHERE e.v = to_jsonb(k.k)) z ON true;
    UPDATE projects SET data = data || jsonb_build_object('roles', roles, 'members', mem),
           version = version + 1, updated_at = now()
     WHERE id = p.id;
    INSERT INTO changes (collection, record_id, op) VALUES ('projects', p.id, 'put');
    n := n + 1;
  END LOOP;
  -- Açık sekmeler tam yeniden yüklesin (görünürlük yeni kurala göre hesaplanır).
  IF n > 0 THEN INSERT INTO changes (collection, record_id, op) VALUES ('_access', '*', 'put'); END IF;
END $$;
