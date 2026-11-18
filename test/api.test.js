/* API testleri — gerçek bir PostgreSQL veritabanına karşı çalışır.
   TEST_DATABASE_URL tanımlı değilse atlanır. Veritabanı her çalıştırmada SIFIRLANIR.
   Örnek: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate } from '../server/db.js';
import { bootstrap } from '../server/store.js';
import { createApp } from '../server/app.js';

const URL = process.env.TEST_DATABASE_URL;
let pool, server, base;

before(async () => {
  if (!URL) return;
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-admin-pw';
  process.env.DEFAULT_USER_PASSWORD = 'Start12345';
  pool = createPool(URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await bootstrap(pool, () => {});
  server = createApp(pool).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await pool?.end(); });

function client() {
  let cookie = '';
  const req = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'x-pano': '1', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch { }
    return { status: r.status, json };
  };
  return {
    req,
    login: (username, password) => req('POST', '/api/auth/login', { username, password }),
    sync: changes => req('POST', '/api/sync', { changes }),
    state: () => req('GET', '/api/state'),
  };
}

const t = (name, fn) => test(name, { skip: !URL && 'TEST_DATABASE_URL yok' }, fn);

t('giriş: yanlış parola reddedilir, doğrusu kabul edilir', async () => {
  const c = client();
  assert.equal((await c.login('admin', 'yanlis')).status, 401);
  assert.equal((await c.state()).status, 401);
  const r = await c.login('ADMIN', 'test-admin-pw');
  assert.equal(r.status, 200);
  assert.equal(r.json.role, 'super');
  const s = await c.state();
  assert.equal(s.status, 200);
  assert.equal(s.json.data.projects[0].name, 'Genel');
  assert.ok(!JSON.stringify(s.json).includes('password_hash'));
});

t('CSRF: x-pano başlığı olmayan yazma isteği reddedilir', async () => {
  const c = client();
  await c.login('admin', 'test-admin-pw');
  const r = await c.req('POST', '/api/sync', { changes: [] }, { 'x-pano': '' });
  assert.equal(r.status, 403);
});

t('senkron: kayıt ekle/güncelle/sil ve değişiklik akışı', async () => {
  const c = client();
  await c.login('admin', 'test-admin-pw');
  const s0 = (await c.state()).json.seq;
  let r = await c.sync([
    { c: 'issues', id: 'i_t1', op: 'put', data: { projectId: 'p1', key: 'GEN-1', summary: 'İlk', statusId: 'p1_s0' } },
    { c: '_settings', id: 'cfg', op: 'put', data: { h: 8, d: 5 } },
    { c: 'yeniDizi', id: 'x1', op: 'put', data: { a: 1 } },
  ]);
  assert.equal(r.json.applied, 3);
  /* Aynı veri tekrar gelirse değişiklik sayılmaz. */
  r = await c.sync([{ c: 'issues', id: 'i_t1', op: 'put', data: { projectId: 'p1', key: 'GEN-1', summary: 'İlk', statusId: 'p1_s0' } }]);
  assert.equal(r.json.applied, 0);
  const ch = (await c.req('GET', `/api/changes?since=${s0}`)).json;
  assert.deepEqual(ch.items.map(i => i.c).sort(), ['_settings', 'issues', 'projects', 'yeniDizi']);   // projects: sayaç GEN-1'e çekildi
  const st = (await c.state()).json.data;
  assert.equal(st.issues.find(i => i.id === 'i_t1').summary, 'İlk');
  assert.equal(st.cfg.h, 8);
  assert.equal(st.yeniDizi[0].a, 1);
  /* İlişkisel sütunlar JSON'dan türetilir. */
  const row = (await pool.query(`SELECT project_id, issue_key, status_id FROM issues WHERE id='i_t1'`)).rows[0];
  assert.deepEqual(row, { project_id: 'p1', issue_key: 'GEN-1', status_id: 'p1_s0' });
  r = await c.sync([{ c: 'issues', id: 'i_t1', op: 'del' }]);
  assert.equal(r.json.applied, 1);
  const ch2 = (await c.req('GET', `/api/changes?since=${r.json.seq - 1}`)).json;
  assert.equal(ch2.items[0].op, 'del');
});

t('kullanıcı: yönetici ekler, yeni kullanıcı başlangıç parolasıyla girer ve parolasını değiştirmek zorunda', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  let r = await a.sync([{ c: 'users', id: 'u_ali', op: 'put',
    data: { username: 'ali', name: 'Ali', role: 'member', active: true, pw: 'hile', salt: 'x', ini: 'AL' } }]);
  assert.equal(r.json.applied, 1);
  const u = (await pool.query(`SELECT * FROM users WHERE id='u_ali'`)).rows[0];
  assert.equal(u.must_change, true);
  assert.equal(u.data.pw, undefined);
  assert.equal(u.data.ini, 'AL');

  const b = client();
  r = await b.login('ali', 'Start12345');
  assert.equal(r.status, 200);
  assert.equal(r.json.mustChange, true);
  assert.equal(r.json.defaultPassword, null);           // üye başlangıç parolasını görmez
  assert.equal((await b.req('POST', '/api/auth/password', { newPassword: 'kisa' })).status, 400);
  assert.equal((await b.req('POST', '/api/auth/password', { newPassword: 'AliYeni12345' })).status, 200);
  assert.equal((await client().login('ali', 'Start12345')).status, 401);
  assert.equal((await client().login('ali', 'AliYeni12345')).status, 200);
});

t('yetki: üye rol yükseltemez, başkasını değiştiremez, kullanıcı silemez', async () => {
  const b = client();
  await b.login('ali', 'AliYeni12345');
  let r = await b.sync([{ c: 'users', id: 'u_ali', op: 'put', data: { username: 'ali', name: 'Ali K', role: 'super', active: true } }]);
  const me = (await pool.query(`SELECT role, name FROM users WHERE id='u_ali'`)).rows[0];
  assert.equal(me.role, 'member');
  assert.equal(me.name, 'Ali K');                       // kendi adını değiştirebilir
  r = await b.sync([{ c: 'users', id: 'u_admin', op: 'put', data: { username: 'admin', name: 'X', role: 'viewer' } }]);
  assert.equal(r.json.applied, 0);
  r = await b.sync([{ c: 'users', id: 'u_admin', op: 'del' }]);
  assert.equal(r.json.rejected.length, 1);
  assert.equal((await b.req('POST', '/api/users/u_admin/password', {})).status, 403);
  assert.equal((await b.req('GET', '/api/export')).status, 403);
});

t('yetki: izleyici veri değiştiremez ama kendi ekran tercihini kaydedebilir', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'users', id: 'u_viewer', op: 'put', data: { username: 'izci', name: 'İzci', role: 'viewer', active: true } }]);
  const v = client();
  await v.login('izci', 'Start12345');
  await v.req('POST', '/api/auth/password', { newPassword: 'IzciYeni12345' });
  const r = await v.sync([
    { c: 'issues', id: 'i_v', op: 'put', data: { projectId: 'p1', summary: 'yasak' } },
    { c: '_prefs', id: 'ui', op: 'put', data: { view: 'board' } },
  ]);
  assert.equal(r.json.applied, 1);
  assert.equal(r.json.rejected[0].reason, 'salt okunur kullanıcı');
  assert.equal((await v.state()).json.data.ui.view, 'board');
  assert.equal((await a.state()).json.data.ui, undefined);       // tercihler kişiye özel
});

t('son aktif yönetici pasifleştirilemez; kendi hesabını silemez', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  let r = await a.sync([{ c: 'users', id: 'u_admin', op: 'del' }]);
  assert.match(r.json.rejected[0].reason, /Kendi/);
  /* Kendi rolünü düşürmeye çalışırsa yok sayılır. */
  await a.sync([{ c: 'users', id: 'u_admin', op: 'put', data: { username: 'admin', name: 'Yönetici', role: 'member', active: false } }]);
  const row = (await pool.query(`SELECT role, active FROM users WHERE id='u_admin'`)).rows[0];
  assert.deepEqual(row, { role: 'super', active: true });
});

t('yönetici parola sıfırlar; kullanıcının oturumları kapanır', async () => {
  const b = client();
  await b.login('ali', 'AliYeni12345');
  const a = client();
  await a.login('admin', 'test-admin-pw');
  assert.equal((await a.req('POST', '/api/users/u_ali/password', {})).status, 200);
  assert.equal((await b.state()).status, 401);
  const r = await client().login('ali', 'Start12345');
  assert.equal(r.json.mustChange, true);
});

t('pasif kullanıcı giriş yapamaz', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'users', id: 'u_ali', op: 'put', data: { username: 'ali', name: 'Ali K', role: 'member', active: false } }]);
  assert.equal((await client().login('ali', 'Start12345')).status, 401);
});

/* ---------------- sağlamlık ---------------- */

t('eşzamanlı düzenleme: farklı alanlar birleşir, kimsenin değişikliği kaybolmaz', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const base = { projectId: 'p1', key: 'GEN-50', summary: 'Ortak iş', statusId: 'p1_s0', priority: 3 };
  await a.sync([{ c: 'issues', id: 'i_m', op: 'put', data: base }]);
  /* İki kullanıcı da aynı hâlden başladı. A özeti, B önceliği değiştirdi. */
  await a.sync([{ c: 'issues', id: 'i_m', op: 'put', base, data: { ...base, summary: 'A değiştirdi' } }]);
  const r = await a.sync([{ c: 'issues', id: 'i_m', op: 'put', base, data: { ...base, priority: 1 } }]);
  assert.deepEqual(r.json.adjusted, [{ c: 'issues', id: 'i_m' }]);
  const row = (await pool.query(`SELECT data FROM issues WHERE id='i_m'`)).rows[0].data;
  assert.equal(row.summary, 'A değiştirdi');
  assert.equal(row.priority, 1);
});

t('iş anahtarı çakışması: aynı anda açılan iki işe farklı numara verilir', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'issues', id: 'i_k1', op: 'put', data: { projectId: 'p1', key: 'GEN-60', summary: 'bir' } }]);
  const r = await a.sync([{ c: 'issues', id: 'i_k2', op: 'put', data: { projectId: 'p1', key: 'GEN-60', summary: 'iki' } }]);
  assert.ok(r.json.adjusted.some(x => x.id === 'i_k2'));
  const k2 = (await pool.query(`SELECT issue_key FROM issues WHERE id='i_k2'`)).rows[0].issue_key;
  assert.equal(k2, 'GEN-61');
  const counter = (await pool.query(`SELECT data->>'counter' c FROM projects WHERE id='p1'`)).rows[0].c;
  assert.equal(counter, '61');
  /* Eski sayaçla gelen proje güncellemesi sayacı geri almaz. */
  const p = (await pool.query(`SELECT data FROM projects WHERE id='p1'`)).rows[0].data;
  await a.sync([{ c: 'projects', id: 'p1', op: 'put', data: { ...p, counter: 10, name: 'Genel 2' } }]);
  const p2 = (await pool.query(`SELECT data FROM projects WHERE id='p1'`)).rows[0].data;
  assert.equal(p2.counter, 61); assert.equal(p2.name, 'Genel 2');
});

t('doğrulama: bozuk kayıt reddedilir', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const r = await a.sync([
    { c: 'worklogs', id: 'w_bad', op: 'put', data: { issueId: 'i_k1', userId: 'u_admin', date: '2026-01-01', hours: 30 } },
    { c: 'issues', id: 'i_bad', op: 'put', data: { summary: 'projesiz' } },
    { c: 'users', id: 'u_bad', op: 'put', data: { username: 'Boşluklu Ad', name: 'x' } },
  ]);
  assert.equal(r.json.applied, 0);
  assert.equal(r.json.rejected.length, 3);
});

t('öncelik: sayısal metin sayıya çevrilir, geçersiz değer Orta (3) olur, 1–5 korunur', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const mk = (id, n, priority) => ({ c: 'issues', id, op: 'put',
    data: { projectId: 'p1', key: 'GEN-' + (n + 120), summary: 'öncelik ' + id, statusId: 'p1_s0', ...(priority === undefined ? {} : { priority }) } });
  const r = await a.sync([
    mk('i_pr_txt', 80, '2'), mk('i_pr_txt2', 81, ' 4 '), mk('i_pr_big', 82, 9), mk('i_pr_zero', 83, 0),
    mk('i_pr_frac', 84, 2.5), mk('i_pr_word', 85, 'Acil'), mk('i_pr_empty', 86, ''), mk('i_pr_obj', 87, { x: 1 }),
    mk('i_pr_five', 88, 5), mk('i_pr_one', 89, 1), mk('i_pr_none', 90), mk('i_pr_null', 91, null), mk('i_pr_bool', 92, true),
  ]);
  assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected));
  assert.equal(r.json.applied, 13);
  const rows = Object.fromEntries((await pool.query(`SELECT id, data FROM issues WHERE id LIKE 'i_pr_%'`)).rows.map(x => [x.id, x.data]));
  const want = { i_pr_txt: 2, i_pr_txt2: 4, i_pr_big: 3, i_pr_zero: 3, i_pr_frac: 3, i_pr_word: 3, i_pr_empty: 3, i_pr_obj: 3,
    i_pr_five: 5, i_pr_one: 1, i_pr_bool: 3 };
  for (const [id, p] of Object.entries(want)) assert.strictEqual(rows[id].priority, p, id);
  /* Alanı olmayan (eski) kayıtlara dokunulmaz. */
  assert.ok(!('priority' in rows.i_pr_none));
  assert.strictEqual(rows.i_pr_null.priority, null);
  /* Sunucunun düzelttiği kayıtlar istemciye `adjusted` ile bildirilir; geçerli olanlar bildirilmez. */
  const adj = new Set(r.json.adjusted.map(x => x.id));
  for (const id of ['i_pr_txt', 'i_pr_txt2', 'i_pr_big', 'i_pr_zero', 'i_pr_frac', 'i_pr_word', 'i_pr_empty', 'i_pr_obj', 'i_pr_bool'])
    assert.ok(adj.has(id), id + ' adjusted olmalı');
  for (const id of ['i_pr_five', 'i_pr_one', 'i_pr_none', 'i_pr_null']) assert.ok(!adj.has(id), id + ' adjusted olmamalı');
  /* Var olan kayıt geçersiz öncelikle güncellenirse de düzeltilir. */
  const r2 = await a.sync([{ c: 'issues', id: 'i_pr_five', op: 'put', data: { ...rows.i_pr_five, priority: '7' } }]);
  assert.deepEqual(r2.json.adjusted, [{ c: 'issues', id: 'i_pr_five' }]);
  assert.strictEqual((await pool.query(`SELECT data FROM issues WHERE id='i_pr_five'`)).rows[0].data.priority, 3);
});

t('öncelik doğrulaması: validate 1–5 dışını reddeder, normalizePriority düzeltir', async () => {
  const { validate, normalizePriority } = await import('../server/validate.js');
  const base = { projectId: 'p1', summary: 'x' };
  for (const p of [1, 2, 3, 4, 5, null, undefined]) assert.doesNotThrow(() => validate('issues', { ...base, priority: p }), String(p));
  for (const p of [0, 6, 2.5, '2', 'Acil', true]) assert.throws(() => validate('issues', { ...base, priority: p }), /Öncelik/, String(p));
  const d = { priority: '3' }; assert.equal(normalizePriority(d), true); assert.strictEqual(d.priority, 3);
  const e = { priority: 4 }; assert.equal(normalizePriority(e), false); assert.strictEqual(e.priority, 4);
  const f = {}; assert.equal(normalizePriority(f), false); assert.ok(!('priority' in f));
  const g = { priority: -1 }; assert.equal(normalizePriority(g), true); assert.strictEqual(g.priority, 3);
});

t('çöp kutusu: silinen iş bağlı kayıtlarıyla geri gelir', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([
    { c: 'issues', id: 'i_tr', op: 'put', data: { projectId: 'p1', key: 'GEN-70', summary: 'Silinecek' } },
    { c: 'comments', id: 'c_tr', op: 'put', data: { issueId: 'i_tr', userId: 'u_admin', body: 'yorum' } },
    { c: 'worklogs', id: 'w_tr', op: 'put', data: { issueId: 'i_tr', userId: 'u_admin', date: '2026-01-02', hours: 2 } },
  ]);
  await a.sync([{ c: 'issues', id: 'i_tr', op: 'del' }, { c: 'comments', id: 'c_tr', op: 'del' }, { c: 'worklogs', id: 'w_tr', op: 'del' }]);
  const trash = (await a.req('GET', '/api/trash')).json;
  const it = trash.find(x => x.record_id === 'i_tr');
  assert.ok(it && !trash.find(x => x.record_id === 'c_tr'));   // bağlı kayıtlar ayrıca listelenmez
  const r = await a.req('POST', `/api/trash/${it.id}/restore`, {});
  assert.equal(r.json.restored, 3);
  assert.equal((await pool.query(`SELECT count(*) n FROM worklogs WHERE id='w_tr'`)).rows[0].n, '1');
});

t('içe aktarma: önce otomatik yedek alır, veriyi değiştirir, hesapları korur, yedekten geri döner', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const before = (await a.state()).json.data.issues.length;
  const data = {
    users: [{ id: 'u_imp', username: 'veli', name: 'Veli', role: 'member', pw: 'x', salt: 'y' }],
    projects: [{ id: 'px', key: 'IMP', name: 'İthal', counter: 2 }],
    statuses: [{ id: 'px_s0', projectId: 'px', name: 'Yapılacak', cat: 'todo', ord: 0 }],
    issues: [{ id: 'ix1', projectId: 'px', key: 'IMP-1', summary: 'a', priority: '4' }, { id: 'ix2', projectId: 'px', key: 'IMP-1', summary: 'çift', priority: 'yok' }],
    cfg: { h: 7 }, ui: { view: 'board' },
  };
  const r = await a.req('POST', '/api/import', { data });
  assert.equal(r.status, 200);
  assert.equal(r.json.fixedKeys, 1);
  const st = (await a.state()).json.data;
  assert.equal(st.issues.length, 2);
  assert.notEqual(st.issues[0].key, st.issues[1].key);
  /* Eski yedekteki metin/geçersiz öncelik atlanmaz, düzeltilerek alınır. */
  assert.strictEqual(st.issues.find(i => i.id === 'ix1').priority, 4);
  assert.strictEqual(st.issues.find(i => i.id === 'ix2').priority, 3);
  assert.equal(st.cfg.h, 7);
  assert.ok(st.users.find(u => u.username === 'admin'));          // mevcut hesap silinmedi
  assert.equal((await client().login('veli', 'Start12345')).status, 200);
  const ch = (await a.req('GET', '/api/changes?since=0')).json;
  assert.equal(ch.reload, true);
  const backups = (await a.req('GET', '/api/backups')).json;
  const pre = backups.find(b => b.kind === 'pre-import');
  assert.equal(pre.counts.issues, before);
  const rr = await a.req('POST', `/api/backups/${pre.id}/restore`, {});
  assert.equal(rr.status, 200);
  assert.equal((await a.state()).json.data.issues.length, before);
});

t('bildirim: atama, yorum ve @bahsetme', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'users', id: 'u_n', op: 'put', data: { username: 'nur', name: 'Nur', role: 'member', active: true } }]);
  await a.sync([{ c: 'issues', id: 'i_n', op: 'put', data: { projectId: 'p1', key: 'GEN-80', summary: 'Bildirim', assignee: 'u_n', reporter: 'u_admin' } }]);
  await a.sync([{ c: 'comments', id: 'c_n', op: 'put', data: { issueId: 'i_n', userId: 'u_admin', body: 'Bakar mısın @nur' } }]);
  const n = client(); await n.login('nur', 'Start12345');
  await n.req('POST', '/api/auth/password', { newPassword: 'NurYeni12345' });
  const r = (await n.req('GET', '/api/notifications')).json;
  assert.equal(r.unread, 2);
  assert.deepEqual(r.items.map(x => x.kind).sort(), ['assigned', 'mention']);
  assert.equal(r.items[0].issue_key, 'GEN-80');
  const ch = (await n.req('GET', '/api/changes?since=999999')).json;
  assert.equal(ch.unread, 2);
  assert.ok(ch.online.some(o => o.id === 'u_n'));
  assert.equal((await n.req('POST', '/api/notifications/read', { ids: 'all' })).json.unread, 0);
});

t('yönetici araçları üyeye kapalı', async () => {
  const n = client(); await n.login('nur', 'NurYeni12345');
  for (const p of ['/api/backups', '/api/trash', '/api/activity']) assert.equal((await n.req('GET', p)).status, 403);
  assert.equal((await n.req('POST', '/api/import', { data: {} })).status, 403);
});

/* ---------------- QA bulguları ---------------- */

t('zorunlu parola değişimi sunucuda uygulanır', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'users', id: 'u_mc', op: 'put', data: { username: 'mc', name: 'MC', role: 'member', active: true } }]);
  const m = client(); await m.login('mc', 'Start12345');
  assert.equal((await m.state()).status, 403);
  assert.equal((await m.sync([])).status, 403);
  assert.equal((await m.req('GET', '/api/auth/me')).status, 200);
  await m.req('POST', '/api/auth/password', { newPassword: 'McYeni12345' });
  assert.equal((await m.state()).status, 200);
});

t('yetki: üye proje yapılandırmasını ve başkasının süre kaydını değiştiremez', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([
    { c: 'projects', id: 'p_y', op: 'put', data: { key: 'YT', name: 'Yetki', counter: 0 } },
    { c: 'issues', id: 'i_y', op: 'put', data: { projectId: 'p_y', key: 'YT-1', summary: 'y' } },
    { c: 'worklogs', id: 'w_adm', op: 'put', data: { issueId: 'i_y', userId: 'u_admin', date: '2026-02-02', hours: 3 } },
  ]);
  const m = client(); await m.login('mc', 'McYeni12345');
  let r = await m.sync([
    { c: 'projects', id: 'p_y', op: 'del' },
    { c: 'statuses', id: 'st_x', op: 'put', data: { projectId: 'p_y', name: 'X', cat: 'todo' } },
    { c: '_settings', id: 'cfg', op: 'put', data: { h: 1 } },
    { c: 'worklogs', id: 'w_adm', op: 'del' },
    { c: 'worklogs', id: 'w_fake', op: 'put', data: { issueId: 'i_y', userId: 'u_admin', date: '2026-02-02', hours: 1 } },
  ]);
  assert.equal(r.json.applied, 0);
  assert.equal(r.json.rejected.length, 5);
  r = await m.sync([
    { c: 'worklogs', id: 'w_mc', op: 'put', data: { issueId: 'i_y', userId: 'u_mc', date: '2026-02-02', hours: 2 } },
    { c: 'issues', id: 'i_y2', op: 'put', data: { projectId: 'p_y', key: 'YT-2', summary: 'üye açtı' } },
  ]);
  assert.equal(r.json.rejected.length, 0);
});

t('harcanan süre sunucuda süre kayıtlarından hesaplanır', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  /* İstemci eski spent değeriyle işi gönderse bile sonuç doğru kalır. */
  await a.sync([{ c: 'issues', id: 'i_y', op: 'put', data: { projectId: 'p_y', key: 'YT-1', summary: 'y', spent: 999, estimate: 10 } }]);
  const d = (await pool.query(`SELECT data FROM issues WHERE id='i_y'`)).rows[0].data;
  assert.equal(d.spent, 5);   // 3 (admin) + 2 (mc)
});

t('iş silinince bağlı kayıtlar çöp kutusuna gider, alt işlerin bağı kopar', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([
    { c: 'issues', id: 'i_sub', op: 'put', data: { projectId: 'p_y', key: 'YT-3', summary: 'alt', parentId: 'i_y' } },
    { c: 'links', id: 'l_y', op: 'put', data: { from: 'i_y', to: 'i_sub', type: 'blocks' } },
    { c: 'history', id: 'h_y', op: 'put', data: { issueId: 'i_y', field: 'Durum' } },
  ]);
  await a.sync([{ c: 'issues', id: 'i_y', op: 'del' }]);
  for (const t of ['worklogs', 'history', 'links']) {
    const n = (await pool.query(`SELECT count(*) n FROM ${t} WHERE ${t === 'links' ? "from_issue='i_y'" : "issue_id='i_y'"}`)).rows[0].n;
    assert.equal(n, '0', t);
  }
  assert.equal((await pool.query(`SELECT parent_id FROM issues WHERE id='i_sub'`)).rows[0].parent_id, null);
  const trash = (await a.req('GET', '/api/trash')).json.find(x => x.record_id === 'i_y');
  assert.ok(Number(trash.batch_size) >= 5);
  await a.req('POST', `/api/trash/${trash.id}/restore`, {});
  assert.equal((await pool.query(`SELECT count(*) n FROM worklogs WHERE issue_id='i_y'`)).rows[0].n, '2');
});

t('kullanıcı görünüm alanları doğrulanır (XSS)', async () => {
  const m = client(); await m.login('mc', 'McYeni12345');
  const r = await m.sync([{ c: 'users', id: 'u_mc', op: 'put', data: { username: 'mc', name: 'MC', ini: '<img src=x>', color: 'red;x' } }]);
  assert.equal(r.json.rejected.length, 1);
  const r2 = await m.sync([{ c: 'issues', id: 'i_x', op: 'put', data: { projectId: 'p_y', key: '<b>-1', summary: 's' } }]);
  assert.equal(r2.json.rejected.length, 1);
});

/* ---------------- kullanıcı yönetimi ---------------- */
t('yönetici: rastgele parola üretir (bir kez döner), oturumları kapatır, ek bilgileri görür', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([{ c: 'users', id: 'u_km', op: 'put', data: { username: 'km', name: 'KM', role: 'member', active: true, email: 'km@firma.com', title: 'Analist' } }]);
  let r = await a.req('POST', '/api/users/u_km/password', { generate: true, requireChange: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.password.length, 12);
  assert.equal(r.json.mustChange, false);
  const k = client();
  const lg = await k.login('km', r.json.password);
  assert.equal(lg.json.mustChange, false);
  assert.equal((await k.state()).status, 200);                       // zorunlu değişim yok
  const meta = (await a.req('GET', '/api/admin/users')).json.find(x => x.id === 'u_km');
  assert.equal(meta.sessions, 1);
  assert.ok(meta.lastLoginAt);
  assert.equal(JSON.stringify(meta).includes('hash'), false);
  r = await a.req('POST', '/api/users/u_km/sessions/revoke', {});
  assert.equal(r.json.revoked, 1);
  assert.equal((await k.state()).status, 401);
  /* belirli parola, kısa parola reddi */
  assert.equal((await a.req('POST', '/api/users/u_km/password', { password: 'kisa' })).status, 400);
  assert.equal((await a.req('POST', '/api/users/u_km/password', { password: 'Belirli12345' })).json.mustChange, true);
  /* e-posta doğrulaması */
  const bad = await a.sync([{ c: 'users', id: 'u_km', op: 'put', data: { username: 'km', name: 'KM', email: 'gecersiz' } }]);
  assert.equal(bad.json.rejected.length, 1);
  /* üye bu uçlara erişemez */
  const m = client(); await m.login('km', 'Belirli12345'); await m.req('POST', '/api/auth/password', { newPassword: 'KmYeni123456' });
  assert.equal((await m.req('GET', '/api/admin/users')).status, 403);
  assert.equal((await m.req('POST', '/api/users/u_admin/sessions/revoke', {})).status, 403);
  assert.equal((await m.req('POST', '/api/users/u_km/password', { generate: true })).status, 403);
});
