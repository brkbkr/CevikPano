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
    issues: [{ id: 'ix1', projectId: 'px', key: 'IMP-1', summary: 'a' }, { id: 'ix2', projectId: 'px', key: 'IMP-1', summary: 'çift' }],
    cfg: { h: 7 }, ui: { view: 'board' },
  };
  const r = await a.req('POST', '/api/import', { data });
  assert.equal(r.status, 200);
  assert.equal(r.json.fixedKeys, 1);
  const st = (await a.state()).json.data;
  assert.equal(st.issues.length, 2);
  assert.notEqual(st.issues[0].key, st.issues[1].key);
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
  const n = client(); await n.login('nur', 'Start12345');
  for (const p of ['/api/backups', '/api/trash', '/api/activity']) assert.equal((await n.req('GET', p)).status, 403);
  assert.equal((await n.req('POST', '/api/import', { data: {} })).status, 403);
});
