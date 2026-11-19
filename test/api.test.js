/* API testleri — gerçek bir PostgreSQL veritabanına karşı çalışır.
   TEST_DATABASE_URL tanımlı değilse atlanır. Veritabanı her çalıştırmada SIFIRLANIR.
   Örnek: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, migrate, MISC_COLLECTIONS } from '../server/db.js';
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
    { c: 'filters', id: 'x1', op: 'put', data: { a: 1 } },
  ]);
  assert.equal(r.json.applied, 3);
  /* Aynı veri tekrar gelirse değişiklik sayılmaz. */
  r = await c.sync([{ c: 'issues', id: 'i_t1', op: 'put', data: { projectId: 'p1', key: 'GEN-1', summary: 'İlk', statusId: 'p1_s0' } }]);
  assert.equal(r.json.applied, 0);
  const ch = (await c.req('GET', `/api/changes?since=${s0}`)).json;
  assert.deepEqual(ch.items.map(i => i.c).sort(), ['_settings', 'filters', 'issues', 'projects']);   // projects: sayaç GEN-1'e çekildi
  const st = (await c.state()).json.data;
  assert.equal(st.issues.find(i => i.id === 'i_t1').summary, 'İlk');
  assert.equal(st.cfg.h, 8);
  assert.equal(st.filters.find(f => f.id === 'x1').a, 1);
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

t('yetki (#9 Benim işlerim): izleyici durum/öncelik/atanan değiştiremez, süre giremez; ana ekran süzgeci kalıcı', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  let r = await a.sync([{ c: 'issues', id: 'i_hm9', op: 'put',
    data: { projectId: 'p1', summary: 'Benim işlerim', statusId: 'p1_s0', priority: 3, assignee: 'u_viewer' } }]);
  assert.equal(r.json.applied, 1);
  const v = client();
  await v.login('izci', 'IzciYeni12345');
  const base = (await v.state()).json.data.issues.find(i => i.id === 'i_hm9');
  for (const patch of [{ statusId: 'p1_s1' }, { priority: 1 }, { assignee: null }, { assignee: 'u_admin' }]) {
    r = await v.sync([{ c: 'issues', id: 'i_hm9', op: 'put', data: { ...base, ...patch }, base }]);
    assert.equal(r.json.applied, 0, JSON.stringify(patch));
    assert.equal(r.json.rejected[0].reason, 'salt okunur kullanıcı');
  }
  r = await v.sync([{ c: 'worklogs', id: 'w_hm9', op: 'put',
    data: { issueId: 'i_hm9', userId: 'u_viewer', date: '2026-11-18', hours: 1, comment: 'izleyici' } }]);
  assert.equal(r.json.applied, 0);
  const row = (await pool.query(`SELECT data FROM issues WHERE id='i_hm9'`)).rows[0].data;
  assert.deepEqual([row.statusId, row.priority, row.assignee], ['p1_s0', 3, 'u_viewer']);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM worklogs WHERE id='w_hm9'`)).rows[0].n, 0);
  /* Süzgeç kişisel tercihtir: izleyici de yazar, yeni oturumda geri gelir, başkasına gitmez. */
  r = await v.sync([{ c: '_prefs', id: 'ui', op: 'put', data: { view: 'home', homeProj: 'p1' } }]);
  assert.equal(r.json.applied, 1);
  const v2 = client();
  await v2.login('izci', 'IzciYeni12345');
  const ui = (await v2.state()).json.data.ui;
  assert.equal(ui.homeProj, 'p1');
  assert.equal(ui.view, 'home');
  assert.equal((await a.state()).json.data.ui?.homeProj, undefined);
});

t('gezinme (A2): sol menü tercihleri (nav, wsOpen, recentProj, recentWs) kişisel; izleyici de yazar, şema değişmez', async () => {
  const a = client();
  await a.login('admin', 'test-admin-pw');
  const v = client();
  await v.login('izci', 'IzciYeni12345');
  const ui = { view: 'board', project: 'p1', nav: { order: ['customers', 'recent', 'projects', 'users', 'system'], hidden: ['projects'] },
    wsOpen: { ws1: false }, recentProj: ['p1'], recentWs: ['ws1'] };
  const r = await v.sync([{ c: '_prefs', id: 'ui', op: 'put', data: ui }]);
  assert.equal(r.json.applied, 1);
  assert.deepEqual(r.json.rejected, []);
  const v2 = client();
  await v2.login('izci', 'IzciYeni12345');
  const got = (await v2.state()).json.data.ui;
  assert.deepEqual(got.nav, ui.nav);
  assert.deepEqual(got.wsOpen, ui.wsOpen);
  assert.deepEqual(got.recentProj, ['p1']);
  assert.deepEqual(got.recentWs, ['ws1']);
  /* varsayılana dönünce nav silinir: ui bütün olarak yazılır, eski nav kalmaz */
  await v.sync([{ c: '_prefs', id: 'ui', op: 'put', data: { ...ui, nav: undefined } }]);
  assert.equal((await v2.state()).json.data.ui.nav, undefined);
  /* başkasına gitmez */
  const au = (await a.state()).json.data.ui;
  assert.equal(au?.nav, undefined);
  assert.equal(au?.recentProj, undefined);
  /* izleyici yine de veri değiştiremez (yetki sunucuda aynen) */
  const rj = await v.sync([{ c: 'projects', id: 'p_izci', op: 'put', data: { name: 'İzci projesi', key: 'IZC' } }]);
  assert.equal(rj.json.applied, 0);
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

/* ---------------- saldırı testleri (güvenlik incelemesi, #8) ---------------- */
const XSS = '"><img src=x onerror=alert(1)>';
const iss = (id, n, extra = {}) => ({ c: 'issues', id, op: 'put',
  data: { projectId: 'p1', key: 'GEN-' + n, summary: 'saldırı ' + n, statusId: 'p1_s0', ...extra } });

t('güvenlik: kayıt kimliği beyaz listede; XSS yüklü kimlik reddedilir, mevcut kimlik biçimleri kabul edilir', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const bad = ['x' + XSS, 'i_a b', 'i_<b>', "i_'x", 'i_"x', 'ı_türkçe', 'x'.repeat(201)];
  const r = await a.sync([...bad.map((id, k) => iss(id, 300 + k)),
    { c: 'comments', id: 'c' + XSS, op: 'put', data: { issueId: 'i_k1', userId: 'u_admin', body: 'x' } }]);
  assert.equal(r.json.applied, 0);
  assert.equal(r.json.rejected.length, bad.length + 1);
  assert.ok(r.json.rejected.every(x => x.reason === 'geçersiz kimlik'), JSON.stringify(r.json.rejected));
  /* uid() ve demo/varsayılan kimlikler */
  const good = ['p1', 'u1', 'p1_s0', 'i_x7k2m9q', 'cf_mus', 'l1', 'r1', 'sp1', 'u_chnm5ai', 'a.b:c-D_9', 'x'.repeat(200)];
  const r2 = await a.sync(good.map(id => ({ c: 'filters', id, op: 'put', data: { a: 1 } })));
  assert.equal(r2.json.applied, good.length, JSON.stringify(r2.json.rejected));
  assert.equal((await pool.query(`SELECT count(*) n FROM issues WHERE data::text LIKE '%onerror%'`)).rows[0].n, '0');
});

t('güvenlik: puan sonlu sayı 0–1000, epik rengi hex, etiketler metin dizisi', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const r = await a.sync([
    iss('i_sx_p1', 310, { points: '<img src=x onerror=alert(1)>' }), iss('i_sx_p2', 311, { points: -1 }),
    iss('i_sx_p3', 312, { points: 1001 }), iss('i_sx_p4', 313, { points: [1] }),
    iss('i_sx_c1', 314, { color: 'red' + XSS }), iss('i_sx_c2', 315, { color: 'red' }), iss('i_sx_c3', 316, { color: 12 }),
    iss('i_sx_l1', 317, { labels: 'metin' }), iss('i_sx_l2', 318, { labels: [123] }),
    iss('i_sx_l3', 319, { labels: Array.from({ length: 51 }, (_, k) => 'e' + k) }), iss('i_sx_l4', 320, { labels: ['x'.repeat(101)] }),
    iss('i_sx_l5', 321, { labels: { 0: 'a' } }),
  ]);
  assert.equal(r.json.applied, 0, JSON.stringify(r.json));
  assert.equal(r.json.rejected.length, 12);
  const ok = await a.sync([
    iss('i_sx_ok1', 322, { points: 5, color: '#6B4FBB', labels: ['Bordro', '<b>metin</b>'] }),
    iss('i_sx_ok2', 323, { points: null, color: null, labels: [] }), iss('i_sx_ok3', 324, { points: 0.5, color: '#abc' }),
    iss('i_sx_ok4', 325, {}),
  ]);
  assert.equal(ok.json.applied, 4, JSON.stringify(ok.json.rejected));
});

t('güvenlik: cfg.types doğrulanır (renk hex, kısa harf/ad, güvenli kimlik)', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const cur = (await a.state()).json.data.cfg || {};
  const T = { id: 'task', name: 'Görev', letter: 'G', color: '#3E7BC4' };
  for (const types of [[{ ...T, color: 'red' + XSS }], [{ ...T, color: 'red' }], [{ ...T, letter: '<img src=x>' }],
    [{ ...T, id: 'a' + XSS }], [{ ...T, name: '' }], [{ ...T, name: 'x'.repeat(101) }], 'metin', [null]]) {
    const r = await a.sync([{ c: '_settings', id: 'cfg', op: 'put', data: { ...cur, types } }]);
    assert.equal(r.json.applied, 0, JSON.stringify(types));
    assert.match(r.json.rejected[0].reason, /iş tipi/);
  }
  const r = await a.sync([{ c: '_settings', id: 'cfg', op: 'put', data: { ...cur, types: [T, { id: 'talep2', name: 'Talep', letter: 'T', color: '#1F6F5C' }] } }]);
  assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  assert.equal((await a.state()).json.data.cfg.types[1].id, 'talep2');
});

t('güvenlik: atanan var olan aktif kullanıcı olmalı (yalnız değiştiğinde denetlenir)', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  await a.sync([
    { c: 'users', id: 'u_pasif', op: 'put', data: { username: 'pasif', name: 'Pasif', role: 'member', active: false } },
    { c: 'users', id: 'u_sonra', op: 'put', data: { username: 'sonra', name: 'Sonra', role: 'member', active: true } },
  ]);
  const r = await a.sync([iss('i_as1', 330, { assignee: 'u_pasif' }), iss('i_as2', 331, { assignee: 'u_yok' }),
    iss('i_as3', 332, { assignee: XSS }), iss('i_as4', 333, { assignee: ['u_admin'] })]);
  assert.equal(r.json.applied, 0);
  assert.ok(r.json.rejected.every(x => /Atanan/.test(x.reason)), JSON.stringify(r.json.rejected));
  const r2 = await a.sync([iss('i_as5', 334, { assignee: 'u_sonra' }), iss('i_as6', 335, { assignee: null }), iss('i_as7', 336, { assignee: '' })]);
  assert.equal(r2.json.applied, 3, JSON.stringify(r2.json.rejected));
  /* Kişi sonradan pasifleşirse işin başka alanı yine düzenlenebilir; ama pasif kişiye yeniden atanamaz. */
  const u = (await pool.query(`SELECT username, name, role FROM users WHERE id='u_sonra'`)).rows[0];
  await a.sync([{ c: 'users', id: 'u_sonra', op: 'put', data: { ...u, active: false } }]);
  const row = (await pool.query(`SELECT data FROM issues WHERE id='i_as5'`)).rows[0].data;
  const r3 = await a.sync([{ c: 'issues', id: 'i_as5', op: 'put', data: { ...row, summary: 'özet değişti' } }]);
  assert.equal(r3.json.applied, 1, JSON.stringify(r3.json.rejected));
  const r4 = await a.sync([{ c: 'issues', id: 'i_as6', op: 'put', data: { ...iss('i_as6', 335).data, assignee: 'u_sonra' } }]);
  assert.equal(r4.json.applied, 0);
});

t('güvenlik: __proto__ / constructor / prototype anahtarları atılır (girdi ve birleştirme)', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const evil = { ['__proto__']: { polluted: 1 }, constructor: { prototype: { polluted: 1 } }, prototype: 1 };
  const d = { ...iss('i_proto', 340).data, ...evil, cf: { ['__proto__']: { polluted: 1 }, f1: 'x' } };
  assert.ok(JSON.stringify(d).includes('__proto__'));         // yük gerçekten gidiyor
  const r = await a.sync([{ c: 'issues', id: 'i_proto', op: 'put', data: d }]);
  assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  assert.ok(r.json.adjusted.some(x => x.id === 'i_proto'));
  const txt = (await pool.query(`SELECT data::text t FROM issues WHERE id='i_proto'`)).rows[0].t;
  assert.ok(!/__proto__|constructor|prototype/.test(txt), txt);
  assert.ok(txt.includes('"f1": "x"'));
  /* Birleştirme yolu: base ve mine'da __proto__ */
  const row = (await pool.query(`SELECT data FROM issues WHERE id='i_proto'`)).rows[0].data;
  await a.sync([{ c: 'issues', id: 'i_proto', op: 'put', data: { ...row, summary: 'başkası' } }]);
  const r2 = await a.sync([{ c: 'issues', id: 'i_proto', op: 'put', base: { ...row, ...evil }, data: { ...row, ...evil, priority: 1 } }]);
  assert.equal(r2.json.applied, 1);
  const txt2 = (await pool.query(`SELECT data::text t FROM issues WHERE id='i_proto'`)).rows[0].t;
  assert.ok(!/__proto__|constructor|prototype/.test(txt2) && txt2.includes('başkası'), txt2);
  assert.equal(({}).polluted, undefined);
  const { merge3 } = await import('../server/util.js');
  const m = merge3({}, JSON.parse('{"__proto__":{"x":1},"constructor":2,"a":1}'), JSON.parse('{"b":2,"__proto__":{"y":1}}'));
  assert.deepEqual(Object.keys(m).sort(), ['a', 'b']);
  assert.equal(Object.getPrototypeOf(m), Object.prototype);
  assert.equal(m.x, undefined); assert.equal(m.y, undefined);
});

t('güvenlik: iş ve proje anahtarı metin olmalı (dizi reddedilir)', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const r = await a.sync([iss('i_keyarr', 350, { key: ['GEN-350'] }),
    { c: 'projects', id: 'p_keyarr', op: 'put', data: { name: 'Dizi', key: ['DZ'] } }]);
  assert.equal(r.json.applied, 0);
  assert.equal(r.json.rejected.length, 2);
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
    users: [{ id: 'u_imp', username: 'veli', name: 'Veli', role: 'member', pw: 'x', salt: 'y' },
      { id: 'u"><img src=x>', username: 'kotu', name: 'Kötü', role: 'member' }],
    projects: [{ id: 'px', key: 'IMP', name: 'İthal', counter: 2 }],
    statuses: [{ id: 'px_s0', projectId: 'px', name: 'Yapılacak', cat: 'todo', ord: 0 }],
    issues: [{ id: 'ix1', projectId: 'px', key: 'IMP-1', summary: 'a', priority: '4' }, { id: 'ix2', projectId: 'px', key: 'IMP-1', summary: 'çift', priority: 'yok' },
      /* saldırı: XSS'li kimlik, dizi anahtar (atlanır), prototip anahtarı (atılır) */
      { id: 'ix"><img src=x onerror=alert(1)>', projectId: 'px', key: 'IMP-5', summary: 'kötü kimlik' },
      { id: 'ix4', projectId: 'px', key: ['IMP-1'], summary: 'dizi anahtar' },
      JSON.parse('{"id":"ix5","projectId":"px","key":"IMP-6","summary":"proto","__proto__":{"polluted":1}}')],
    cfg: { h: 7 }, ui: { view: 'board' },
  };
  const r = await a.req('POST', '/api/import', { data });
  assert.equal(r.status, 200);
  assert.equal(r.json.fixedKeys, 1);
  const st = (await a.state()).json.data;
  assert.equal(st.issues.length, 3);
  assert.equal(r.json.skipped, 2);
  assert.ok(!JSON.stringify(st.issues).includes('__proto__') && !st.issues.some(i => /onerror/.test(i.id)));
  assert.notEqual(st.issues[0].key, st.issues[1].key);
  /* Eski yedekteki metin/geçersiz öncelik atlanmaz, düzeltilerek alınır. */
  assert.strictEqual(st.issues.find(i => i.id === 'ix1').priority, 4);
  assert.strictEqual(st.issues.find(i => i.id === 'ix2').priority, 3);
  assert.equal(st.cfg.h, 7);
  assert.ok(st.users.find(u => u.username === 'admin'));          // mevcut hesap silinmedi
  assert.ok(!st.users.find(u => u.username === 'kotu'));          // XSS'li kimlikli kullanıcı alınmadı
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
    { c: 'projects', id: 'p_y', op: 'put', data: { key: 'YT', name: 'Yetki', counter: 0, members: ['u_admin'] } },
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

t('prototip adları (constructor, __proto__, hasOwnProperty) koleksiyon/ayar adı olamaz: 500 yok, ret', async () => {
  const a = client(); await a.login('admin', 'test-admin-pw');
  const names = ['constructor', '__proto__', 'hasOwnProperty', 'toString'];
  const r = await a.sync([...names.map(c => ({ c, id: 'x1', op: 'put', data: { a: 1 } })),
    ...names.map(c => ({ c, id: 'x2', op: 'del' })),
    ...names.map(id => ({ c: '_settings', id, op: 'put', data: { a: 1 } }))]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.applied, 0);
  assert.equal(r.json.rejected.length, names.length * 3);
  assert.deepEqual([...new Set(r.json.rejected.slice(0, names.length * 2).map(x => x.reason))], ['geçersiz koleksiyon']);
  assert.equal((await pool.query(`SELECT count(*) n FROM misc_records WHERE collection = ANY($1)`, [names])).rows[0].n, '0');
  /* eski sürümün yazmış olabileceği misc kaydı durumu bozmaz */
  await pool.query(`INSERT INTO misc_records (collection, id, data) VALUES ('constructor','x9','{"id":"x9"}'), ('__proto__','x9','{"id":"x9"}')`);
  try {
    const st = await a.state();
    assert.equal(st.status, 200);
    assert.ok(!Object.hasOwn(st.json.data, 'constructor') && !Object.hasOwn(st.json.data, '__proto__'));
    assert.equal((await a.req('GET', '/api/changes?since=0')).status, 200);
  } finally { await pool.query(`DELETE FROM misc_records WHERE collection IN ('constructor','__proto__')`); }
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

/* ---------------- çalışma alanları (#22) ---------------- */
describe('çalışma alanları', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const ws = (id, data) => ({ c: 'workspaces', id, op: 'put', data });
  const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
  const reasons = r => r.json.rejected.map(x => x.reason);
  let A, U1, U2, V;
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'WsYeni123456' })).status, 200);
    return k;
  };

  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    U1 = await newUser('u_ws1', 'wsuye', 'member');
    U2 = await newUser('u_ws2', 'wsuye2', 'member');
    V = await newUser('u_wsv', 'wsizci', 'viewer');
  });

  test('göç: temiz kurulumda Genel (ws1) var ve p1 ona bağlı', async () => {
    const w = await row('workspaces', 'ws1');
    assert.equal(w.name, 'Genel'); assert.equal(w.archived, false); assert.equal(w.data.createdBy, null);
    assert.equal(w.data.color, '#64748B');
    assert.equal((await row('projects', 'p1')).workspace_id, 'ws1');
    const st = (await A.state()).json.data;
    assert.deepEqual(st.workspaces.map(x => x.id), ['ws1']);
  });

  test('göç: alanı olmayan projeler (arşivliler dahil) 003 yeniden çalışınca Genel\'e bağlanır; ws1 tek satır; değişiklik akışında görünür', async () => {
    await pool.query(`INSERT INTO projects (id, data) VALUES
      ('p_gc1', '{"id":"p_gc1","name":"Eski","key":"ESK","counter":7}'),
      ('p_gc2', '{"id":"p_gc2","name":"Eski arşiv","key":"ESA","archived":true,"workspaceId":""}')`);
    const s0 = (await A.state()).json.seq;
    const p1v = (await row('projects', 'p1')).version;
    await pool.query(`DELETE FROM schema_migrations WHERE id='003_workspaces.sql'`);
    await migrate(pool);
    assert.equal((await pool.query(`SELECT count(*) n FROM schema_migrations WHERE id='003_workspaces.sql'`)).rows[0].n, '1');
    const g1 = await row('projects', 'p_gc1'), g2 = await row('projects', 'p_gc2');
    assert.equal(g1.workspace_id, 'ws1'); assert.equal(g2.workspace_id, 'ws1');
    assert.equal(g1.data.counter, 7); assert.equal(g1.data.key, 'ESK'); assert.equal(g2.archived, true);
    assert.equal(g1.version, 2);
    assert.equal((await row('projects', 'p1')).version, p1v);          // zaten bağlı olana dokunulmaz
    assert.equal((await pool.query(`SELECT count(*) n FROM workspaces`)).rows[0].n, '1');
    const ch = (await A.req('GET', `/api/changes?since=${s0}`)).json;
    assert.equal(ch.reload, undefined);
    const got = ch.items.filter(i => i.c === 'projects');
    assert.ok(got.every(i => i.op === 'put' && i.data.workspaceId === 'ws1'), JSON.stringify(got));
    for (const id of ['p_gc1', 'p_gc2', 'p_y']) assert.ok(got.some(i => i.id === id), id);   // p_y: önceki testte alansız açıldı
    assert.ok(!got.some(i => i.id === 'p1'));
    assert.ok(!ch.items.some(i => i.c === 'workspaces'));           // var olan ws1 yeniden yazılmadı
    await pool.query(`DELETE FROM projects WHERE id IN ('p_gc1','p_gc2')`);
  });

  test('eski sürümün misc_records\'a yazdığı workspaces kayıtları çift görünmez', async () => {
    await pool.query(`INSERT INTO misc_records (collection, id, data) VALUES ('workspaces','ws1','{"id":"ws1","name":"Kopya"}')`);
    const st = (await A.state()).json.data;
    assert.deepEqual(st.workspaces.map(x => [x.id, x.name]), [['ws1', 'Genel']]);
    await pool.query(`DELETE FROM misc_records WHERE collection='workspaces'`);
  });

  test('oluşturma: yalnız sistem yöneticisi açar (üye/izleyici 403); açan ve sahip sunucuda yazılır, güncellemede korunur', async () => {
    let r = await U1.sync([ws('ws_a', { name: 'Ar-Ge', color: '#3E7BC4' })]);
    assert.equal(r.status, 200);
    assert.deepEqual(reasons(r), ['Çalışma alanını yalnızca yönetici açabilir']);
    assert.equal(await row('workspaces', 'ws_a'), undefined);
    /* Yönetici açar; sahibini başka bir kişi seçebilir (sahip alan yöneticisidir). Sahte createdBy düzeltilir. */
    r = await A.sync([ws('ws_a', { name: 'Ar-Ge', color: '#3E7BC4', description: 'açıklama', createdBy: 'u_ws2', ownerId: 'u_ws1' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.deepEqual(r.json.adjusted, [{ c: 'workspaces', id: 'ws_a' }]);
    let w = await row('workspaces', 'ws_a');
    assert.equal(w.created_by, 'u_admin'); assert.equal(w.data.ownerId, 'u_ws1'); assert.equal(w.archived, false);
    /* Sahip (alan yöneticisi) düzenler; createdBy ve ownerId'yi değiştiremez. */
    r = await U1.sync([ws('ws_a', { ...w.data, description: 'yeni', createdBy: 'u_ws2', ownerId: 'u_ws2' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.ok(r.json.adjusted.some(x => x.id === 'ws_a'));
    w = await row('workspaces', 'ws_a');
    assert.equal(w.created_by, 'u_admin'); assert.equal(w.data.ownerId, 'u_ws1'); assert.equal(w.data.description, 'yeni');
    /* createdBy / ownerId gönderilmese de korunur. */
    const { createdBy, ownerId, ...rest } = w.data;
    r = await U1.sync([ws('ws_a', { ...rest, color: '#1F6F5C' })]);
    assert.equal(r.json.applied, 1);
    assert.equal((await row('workspaces', 'ws_a')).created_by, 'u_admin');
    assert.equal((await row('workspaces', 'ws_a')).data.ownerId, 'u_ws1');
    assert.equal(createdBy, 'u_admin'); assert.equal(ownerId, 'u_ws1');
    /* Yeni alanda doğru createdBy gönderilirse düzeltme bildirilmez; sahip seçilmezse açan yöneticidir. */
    r = await A.sync([ws('ws_dogru', { name: 'Doğru açan', createdBy: 'u_admin', ownerId: 'u_admin' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.deepEqual(r.json.adjusted, []);
    r = await A.sync([ws('ws_sahipsiz', { name: 'Sahipsiz açılan' })]);
    assert.equal((await row('workspaces', 'ws_sahipsiz')).data.ownerId, 'u_admin');
    await pool.query(`DELETE FROM workspaces WHERE id='ws_sahipsiz'`);
  });

  test('ad: zorunlu, en fazla 60, etkin alanlarda Türkçe büyük/küçük harf ve boşluk duyarsız tekil', async () => {
    let r = await A.sync([ws('ws_ik', { name: 'İnsan Kaynakları', ownerId: 'u_ws1' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    for (const name of ['insan kaynakları', '  İNSAN   KAYNAKLARI ', 'İnsan Kaynakları']) {
      r = await A.sync([ws('ws_ik2', { name })]);
      assert.equal(r.json.applied, 0, name);
      assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var'], name);
    }
    for (const name of ['', '   ', 'x'.repeat(61), 12, null, ['a']]) {
      r = await A.sync([ws('ws_bad', { name })]);
      assert.equal(r.json.applied, 0, String(name));
      assert.match(reasons(r)[0], /Çalışma alanı adı gerekli/, String(name));
    }
    r = await A.sync([ws('ws_60', { name: 'y'.repeat(60), ownerId: 'u_ws2' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* Kendi adını büyük/küçük harf değiştirerek güncellemek çakışma sayılmaz. */
    const ik = (await row('workspaces', 'ws_ik')).data;
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* Arşivli alanla aynı ad serbest; arşivden çıkarmada etkin adla çakışırsa reddedilir. */
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları', archived: true })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await A.sync([ws('ws_ik2', { name: 'İnsan Kaynakları', ownerId: 'u_ws2' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları', archived: false })]);
    assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var']);
    assert.equal((await row('workspaces', 'ws_ik')).archived, true);
    /* Başka bir etkin alanın adına yeniden adlandırma da reddedilir. */
    r = await U2.sync([ws('ws_60', { ...(await row('workspaces', 'ws_60')).data, name: 'ar-ge' })]);
    assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var']);
  });

  test('ad tekilliği eşzamanlı oluşturmada da korunur', async () => {
    const A2 = client(); await A2.login('admin', 'test-admin-pw');
    const [r1, r2] = await Promise.all([A.sync([ws('ws_es1', { name: 'Eşzamanlı' })]), A2.sync([ws('ws_es2', { name: 'eşzamanlı' })])]);
    assert.equal(r1.json.applied + r2.json.applied, 1, JSON.stringify([r1.json, r2.json]));
    assert.equal((await pool.query(`SELECT count(*) n FROM workspaces WHERE id IN ('ws_es1','ws_es2')`)).rows[0].n, '1');
  });

  test('aynı kimlikle eşzamanlı oluşturma: ikincisi üzerine yazmaz (409), sahip değişmez', async () => {
    const A2 = client(); await A2.login('admin', 'test-admin-pw');
    const [r1, r2] = await Promise.all([A.sync([ws('ws_ayni', { name: 'Aynı kimlik', ownerId: 'u_ws1' })]),
      A2.sync([ws('ws_ayni', { name: 'Aynı kimlik', ownerId: 'u_ws2' })])]);
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    assert.equal(r1.json.applied + r2.json.applied, 1, JSON.stringify([r1.json, r2.json]));
    const winner = r1.json.applied ? 'u_ws1' : 'u_ws2';
    assert.equal((await row('workspaces', 'ws_ayni')).data.ownerId, winner);
    /* Kesin yarış: ilk kayıt henüz onaylanmamışken ikinci oluşturma gelir → bekler, üzerine yazmaz. */
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO workspaces (id, data) VALUES ('ws_yaris', '{"id":"ws_yaris","name":"Yarış alanı","createdBy":"u_ws1"}')`);
      const pending = A.sync([ws('ws_yaris', { name: 'Yarış alanı', description: 'ikinci' })]);
      await new Promise(r => setTimeout(r, 300));
      await c.query('COMMIT');
      const r = await pending;
      assert.equal(r.status, 200); assert.equal(r.json.applied, 0);
      assert.deepEqual(reasons(r), ['Kayıt aynı anda oluşturuldu, yeniden deneyin']);
    } finally { c.release(); }
    const w = await row('workspaces', 'ws_yaris');
    assert.equal(w.created_by, 'u_ws1'); assert.equal(w.data.description, undefined);
    /* yeniden denemede kayıt var: güncelleme kuralları işler (başkasının alanı) */
    assert.deepEqual(reasons(await U2.sync([ws('ws_yaris', { name: 'Yarış alanı', description: 'ikinci' })])),
      ['Bu çalışma alanını yalnızca alan yöneticisi değiştirebilir']);
    await pool.query(`DELETE FROM workspaces WHERE id IN ('ws_ayni','ws_yaris')`);
  });

  test('doğrulama: renk HEX, açıklama ≤500, archived boolean (metin 500 değil ret)', async () => {
    const r = await A.sync([
      ws('ws_c1', { name: 'Renk 1', color: 'red' }), ws('ws_c2', { name: 'Renk 2', color: '#fff;' + XSS }),
      ws('ws_c3', { name: 'Renk 3', color: 12 }), ws('ws_d1', { name: 'Açıklama', description: 'x'.repeat(501) }),
      ws('ws_ar', { name: 'Arşiv', archived: 'evet' }),
      { c: 'projects', id: 'p_ar', op: 'put', data: { name: 'Arşiv metin', key: 'PAR', archived: 'evet' } },
      { c: 'projects', id: 'p_wsid', op: 'put', data: { name: 'Kötü alan', key: 'PKA', workspaceId: 'ws' + XSS } },
    ]);
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, 0, JSON.stringify(r.json));
    assert.deepEqual(reasons(r), ['Renk #RRGGBB biçiminde olmalı', 'Renk #RRGGBB biçiminde olmalı', 'Renk #RRGGBB biçiminde olmalı',
      'Açıklama en fazla 500 karakter', 'Arşiv bilgisi true ya da false olmalı', 'Arşiv bilgisi true ya da false olmalı',
      'Geçersiz çalışma alanı']);
    const ok = await A.sync([ws('ws_c4', { name: 'Renk 4', color: '#abc', description: '', ownerId: 'u_ws1' }),
      ws('ws_c5', { name: 'Renk 5', color: '', ownerId: 'u_ws1' })]);
    assert.equal(ok.json.applied, 2, JSON.stringify(ok.json.rejected));
  });

  test('archived: "true"/"false" metni ve 1/0 boolean\'a çevrilir (adjusted), diğer değerler reddedilir', async () => {
    const { normalizeArchived, validate } = await import('../server/validate.js');
    for (const [v, want] of [['true', true], [' TRUE ', true], ['False', false], [1, true], [0, false]]) {
      const d = { archived: v }; assert.equal(normalizeArchived(d), true, String(v)); assert.strictEqual(d.archived, want, String(v));
    }
    for (const v of [true, false, null, undefined, 'evet', '1', 2, {}]) {
      const d = { archived: v }; assert.equal(normalizeArchived(d), false, String(v)); assert.strictEqual(d.archived, v);
    }
    assert.throws(() => validate('projects', { name: 'x', archived: 'evet' }), /Arşiv bilgisi/);
    let r = await A.sync([
      { c: 'projects', id: 'p_arm', op: 'put', data: { name: 'Metin arşiv', key: 'PAM', archived: 'true' } },
      { c: 'projects', id: 'p_arm0', op: 'put', data: { name: 'Sayı arşiv', key: 'PA0', archived: 0 } },
      ws('ws_arm', { name: 'Metin arşivli alan', archived: 'FALSE' }),
      { c: 'projects', id: 'p_arx', op: 'put', data: { name: 'Kötü arşiv', key: 'PAX', archived: 'evet' } },
      ws('ws_arx', { name: 'Kötü arşivli alan', archived: 'hayır' }),
    ]);
    assert.equal(r.json.applied, 3, JSON.stringify(r.json));
    assert.deepEqual(reasons(r), ['Arşiv bilgisi true ya da false olmalı', 'Arşiv bilgisi true ya da false olmalı']);
    assert.deepEqual(r.json.adjusted.map(x => x.id).sort(), ['p_arm', 'p_arm0', 'ws_arm']);
    assert.strictEqual((await row('projects', 'p_arm')).data.archived, true);
    assert.equal((await row('projects', 'p_arm')).archived, true);
    assert.strictEqual((await row('projects', 'p_arm0')).data.archived, false);
    assert.strictEqual((await row('workspaces', 'ws_arm')).data.archived, false);
    /* Var olan alan "true" metniyle arşivlenince arşiv kuralları uygulanır. */
    r = await A.sync([ws('ws1', { ...(await row('workspaces', 'ws1')).data, archived: 'true' })]);
    assert.deepEqual(reasons(r), ['Genel çalışma alanı arşivlenemez']);
    await pool.query(`DELETE FROM projects WHERE id IN ('p_arm','p_arm0')`);
  });

  test('ad HTML olarak değil metin olarak saklanır', async () => {
    const name = '<script>alert(1)</script>';
    const r = await A.sync([ws('ws_xss', { name })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.equal((await A.state()).json.data.workspaces.find(x => x.id === 'ws_xss').name, name);
  });

  test('izleyici çalışma alanı açamaz, değiştiremez, proje taşıyamaz', async () => {
    const p1 = (await row('projects', 'p1')).data;
    const r = await V.sync([ws('ws_v', { name: 'İzleyici' }), ws('ws_a', { name: 'Değişti' }), { c: 'workspaces', id: 'ws_c4', op: 'del' },
      { c: 'projects', id: 'p1', op: 'put', data: { ...p1, workspaceId: 'ws_a' } }]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(reasons(r), ['Çalışma alanını yalnızca yönetici açabilir', 'salt okunur kullanıcı',
      'Bu değişiklik için yönetici yetkisi gerekli', 'salt okunur kullanıcı']);
    assert.equal(await row('workspaces', 'ws_v'), undefined);
  });

  test('başkasının alanını yalnız alan yöneticisi (sahip dahil) ya da sistem yöneticisi değiştirir/arşivler', async () => {
    const a = (await row('workspaces', 'ws_a')).data;
    const MSG = 'Bu çalışma alanını yalnızca alan yöneticisi değiştirebilir';
    let r = await U2.sync([ws('ws_a', { ...a, name: 'Ele geçirildi' }), ws('ws_a', { ...a, archived: true }),
      ws('ws_a', { ...a, createdBy: 'u_ws2', ownerId: 'u_ws2' })]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(reasons(r), [MSG, MSG]);                           // createdBy denemesi değişiklik sayılmaz
    assert.equal((await row('workspaces', 'ws_a')).name, 'Ar-Ge');
    /* Değişmemiş kaydı yeniden göndermek reddedilmez (istemci gereksiz yeniden yükleme yapmasın). */
    r = await U2.sync([ws('ws_a', a)]);
    assert.deepEqual(r.json.rejected, []);
    r = await A.sync([ws('ws_a', { ...a, name: 'Ar-Ge Merkezi' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    const w = await row('workspaces', 'ws_a');
    assert.equal(w.name, 'Ar-Ge Merkezi'); assert.equal(w.data.ownerId, 'u_ws1');   // yönetici düzenlese de sahip değişmez
    r = await U1.sync([ws('ws_a', { ...w.data, name: 'Ar-Ge' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  });

  test('Genel (ws1): arşivlenemez, silinemez, adını yalnız yönetici değiştirir', async () => {
    const g = (await row('workspaces', 'ws1')).data;
    let r = await A.sync([ws('ws1', { ...g, archived: true }), { c: 'workspaces', id: 'ws1', op: 'del' }]);
    assert.deepEqual(reasons(r), ['Genel çalışma alanı arşivlenemez', 'Genel çalışma alanı silinemez']);
    r = await U1.sync([ws('ws1', { ...g, name: 'Benim' })]);
    assert.deepEqual(reasons(r), ['Bu çalışma alanını yalnızca alan yöneticisi değiştirebilir']);
    r = await A.sync([ws('ws1', { ...g, name: 'Ortak' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.equal((await row('workspaces', 'ws1')).name, 'Ortak');
    assert.equal((await row('workspaces', 'ws1')).data.createdBy, null);
    await A.sync([ws('ws1', g)]);
    assert.equal((await row('workspaces', 'ws1')).name, 'Genel');
  });

  test('son etkin çalışma alanı arşivlenemez', async () => {
    const prev = (await pool.query(`SELECT id, data FROM workspaces WHERE NOT archived AND id <> 'ws_c4'`)).rows;
    await pool.query(`UPDATE workspaces SET data = data || '{"archived":true}' WHERE id = ANY($1)`, [prev.map(x => x.id)]);
    try {
      const c4 = (await row('workspaces', 'ws_c4')).data;
      const r = await U1.sync([ws('ws_c4', { ...c4, archived: true })]);
      assert.deepEqual(reasons(r), ['Son etkin çalışma alanı arşivlenemez']);
    } finally {
      for (const x of prev) await pool.query(`UPDATE workspaces SET data=$2::jsonb WHERE id=$1`, [x.id, JSON.stringify(x.data)]);
    }
  });

  test('silme: yalnız yönetici; boş alan silinir ve çöp kutusundan geri gelir', async () => {
    let r = await U1.sync([{ c: 'workspaces', id: 'ws_c5', op: 'del' }]);   // kendi alanı olsa da
    assert.deepEqual(reasons(r), ['Bu değişiklik için yönetici yetkisi gerekli']);
    assert.ok(await row('workspaces', 'ws_c5'));
    r = await A.sync([{ c: 'workspaces', id: 'ws_c5', op: 'del' }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.equal(await row('workspaces', 'ws_c5'), undefined);
    const ch = (await U2.req('GET', `/api/changes?since=${r.json.seq - 1}`)).json;
    assert.deepEqual(ch.items.map(i => [i.c, i.id, i.op]), [['workspaces', 'ws_c5', 'del']]);
    const it = (await A.req('GET', '/api/trash')).json.find(x => x.collection === 'workspaces' && x.record_id === 'ws_c5');
    assert.equal(it.title, 'Renk 5');
    assert.equal((await A.req('POST', `/api/trash/${it.id}/restore`, {})).json.restored, 1);
    assert.equal((await row('workspaces', 'ws_c5')).data.ownerId, 'u_ws1');
  });

  test('silme: projesi olan alan silinmez (arşivli proje dahil) — "Önce projeleri taşıyın"', async () => {
    let r = await U1.sync([{ c: 'projects', id: 'p_dolu', op: 'put', data: { name: 'Dolu', key: 'DOL', workspaceId: 'ws_c5', archived: true } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await A.sync([{ c: 'workspaces', id: 'ws_c5', op: 'del' }]);
    assert.deepEqual(reasons(r), ['Önce projeleri taşıyın']);
    assert.ok(await row('workspaces', 'ws_c5'));
  });

  test('taşıma: anahtar, sayaç, işler, sprint, süre ve üyeler aynı kalır; diğer istemci görür', async () => {
    await U1.sync([
      { c: 'projects', id: 'p_ts', op: 'put', data: { name: 'Taşınan', key: 'TS', counter: 0, members: ['u_ws1', 'u_ws2'], workspaceId: 'ws1' } },
      { c: 'sprints', id: 'sp_ts', op: 'put', data: { projectId: 'p_ts', name: 'Sprint 1', state: 'active' } },
      { c: 'issues', id: 'i_ts1', op: 'put', data: { projectId: 'p_ts', key: 'TS-1', summary: 'bir', sprintId: 'sp_ts' } },
      { c: 'issues', id: 'i_ts2', op: 'put', data: { projectId: 'p_ts', key: 'TS-2', summary: 'iki' } },
      { c: 'links', id: 'l_ts', op: 'put', data: { from: 'i_ts1', to: 'i_ts2', type: 'blocks' } },
      { c: 'worklogs', id: 'w_ts', op: 'put', data: { issueId: 'i_ts1', userId: 'u_ws1', date: '2026-03-03', hours: 2 } },
    ]);
    const snap = async () => {
      const q = async (sql) => (await pool.query(sql)).rows;
      return JSON.stringify([await q(`SELECT id, data FROM issues WHERE project_id='p_ts' ORDER BY id`),
        await q(`SELECT id, data FROM sprints WHERE project_id='p_ts'`), await q(`SELECT id, data FROM links WHERE id='l_ts'`),
        await q(`SELECT id, data FROM worklogs WHERE id='w_ts'`)]);
    };
    const before = await snap();
    const p = (await row('projects', 'p_ts')).data;
    assert.equal(p.counter, 2);
    const s0 = (await U2.state()).json.seq;
    /* Eski (üyesiz) alandan taşıma yalnız sistem yöneticisi (güvenlik O1). */
    assert.deepEqual(reasons(await U2.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, workspaceId: 'ws_a' } }])), ['Projeyi başka alana yalnızca iki alanın da yöneticisi taşıyabilir']);
    const r = await A.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, workspaceId: 'ws_a' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    const after = (await row('projects', 'p_ts')).data;
    assert.deepEqual({ ...after, workspaceId: 'ws1' }, p);
    assert.equal(after.workspaceId, 'ws_a');
    assert.equal(await snap(), before);
    const ch = (await A.req('GET', `/api/changes?since=${s0}`)).json;
    assert.deepEqual(ch.items.map(i => [i.c, i.id, i.data.workspaceId]), [['projects', 'p_ts', 'ws_a']]);
    /* Alanı olmayan (eski istemcinin açtığı) proje kabul edilir ve sonradan taşınabilir. */
    const r2 = await U1.sync([{ c: 'projects', id: 'p_alansiz', op: 'put', data: { name: 'Alansız', key: 'ALS' } }]);
    assert.equal(r2.json.applied, 1, JSON.stringify(r2.json.rejected));
    assert.equal((await row('projects', 'p_alansiz')).workspace_id, null);
    assert.deepEqual(reasons(await U1.sync([{ c: 'projects', id: 'p_alansiz', op: 'put', data: { name: 'Alansız', key: 'ALS', workspaceId: 'ws_a' } }])), ['Projeyi başka alana yalnızca iki alanın da yöneticisi taşıyabilir']);
    const r3 = await A.sync([{ c: 'projects', id: 'p_alansiz', op: 'put', data: { name: 'Alansız', key: 'ALS', workspaceId: 'ws_a' } }]);
    assert.equal(r3.json.applied, 1, JSON.stringify(r3.json.rejected));
  });

  test('taşıma: arşivli ya da olmayan alana taşınamaz, orada proje açılamaz; arşivli alandaki proje düzenlenebilir', async () => {
    const c4 = (await row('workspaces', 'ws_c4')).data;
    await U1.sync([{ c: 'projects', id: 'p_arsws', op: 'put', data: { name: 'Arşivli alanda', key: 'AAP', workspaceId: 'ws_c4' } }]);
    let r = await U1.sync([ws('ws_c4', { ...c4, archived: true })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    const p = (await row('projects', 'p_ts')).data;
    r = await U2.sync([
      { c: 'projects', id: 'p_ts', op: 'put', data: { ...p, workspaceId: 'ws_c4' } },
      { c: 'projects', id: 'p_ts', op: 'put', data: { ...p, workspaceId: 'ws_yok' } },
      { c: 'projects', id: 'p_yeni', op: 'put', data: { name: 'Yeni', key: 'YEN', workspaceId: 'ws_c4' } },
      { c: 'projects', id: 'p_yeni2', op: 'put', data: { name: 'Yeni 2', key: 'YN2', workspaceId: 'ws_yok' } },
    ]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(reasons(r), ['Arşivlenmiş çalışma alanına proje taşınamaz', 'Çalışma alanı bulunamadı',
      'Arşivlenmiş çalışma alanına proje taşınamaz', 'Çalışma alanı bulunamadı']);
    assert.equal((await row('projects', 'p_ts')).workspace_id, 'ws_a');
    const ap = (await row('projects', 'p_arsws')).data;
    r = await U2.sync([{ c: 'projects', id: 'p_arsws', op: 'put', base: ap, data: { ...ap, name: 'Yeni ad' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* Arşivli alandan etkin bir alana taşınabilir (eski alanlar arasında: sistem yöneticisi). */
    r = await A.sync([{ c: 'projects', id: 'p_arsws', op: 'put', data: { ...ap, name: 'Yeni ad', workspaceId: 'ws1' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  });

  test('taşıma: eşzamanlı düzenlemede alan ve ad birleşir; eski hâlle gelen değişiklik taşımayı geri almaz', async () => {
    const p = (await row('projects', 'p_ts')).data;          // ws_a
    let r = await A.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, workspaceId: 'ws_60' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* U2 taşımadan habersiz (base = eski hâl) adı değiştirir. */
    r = await U2.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, name: 'Taşınan 2' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.deepEqual(r.json.adjusted, [{ c: 'projects', id: 'p_ts' }]);
    const d = (await row('projects', 'p_ts')).data;
    assert.equal(d.workspaceId, 'ws_60'); assert.equal(d.name, 'Taşınan 2');
    /* Hedef alan sonradan arşivlenirse projenin başka alanları yine düzenlenebilir (kıyas güncel kayda göre). */
    const w60 = (await row('workspaces', 'ws_60')).data;
    r = await U2.sync([ws('ws_60', { ...w60, archived: true })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await U1.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: d, data: { ...d, name: 'Taşınan 3' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    const d2 = (await row('projects', 'p_ts')).data;
    assert.equal(d2.workspaceId, 'ws_60'); assert.equal(d2.name, 'Taşınan 3');
  });

  test('içe aktarma / geri yükleme: dosyada alan yoksa Genel yeniden oluşur', async () => {
    const r = await A.req('POST', '/api/import', { data: { projects: [{ id: 'pi', key: 'IMP', name: 'İthal' },
      { id: 'pi2', key: 'IM2', name: 'Eski arşivli', archived: 'TRUE' }, { id: 'pi3', key: 'IM3', name: 'Eski etkin', archived: 'false' },
      { id: 'pi4', key: 'IM4', name: 'Bozuk arşiv', archived: 'evet' }], issues: [] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.projects, 3); assert.equal(r.json.skipped, 1);   // metin arşiv bilgisi atlanmaz, düzeltilir
    const st = (await A.state()).json.data;
    assert.deepEqual(st.projects.map(p => [p.id, p.archived]), [['pi', undefined], ['pi2', true], ['pi3', false]]);
    assert.deepEqual(st.workspaces, [{ id: 'ws1', name: 'Genel', color: '#64748B', description: '', archived: false, createdBy: null }]);
    const pre = (await A.req('GET', '/api/backups')).json.find(b => b.kind === 'pre-import');
    assert.ok(pre.counts.workspaces > 1);
    assert.equal((await A.req('POST', `/api/backups/${pre.id}/restore`, {})).status, 200);
    const st2 = (await A.state()).json.data;
    assert.equal(st2.workspaces.length, pre.counts.workspaces);
    assert.equal(st2.workspaces.find(x => x.id === 'ws_a').ownerId, 'u_ws1');
    assert.equal(st2.projects.find(x => x.id === 'p_ts').workspaceId, 'ws_60');
  });

  test('içe aktarma: arşivli Genel arşivden çıkar; olmayan alana bağlı projenin bağı kalkar; prototip adlı dizi 500 vermez', async () => {
    const r = await A.req('POST', '/api/import', { data: {
      workspaces: [{ id: 'ws1', name: 'Genel', archived: true }, { id: 'ws_i', name: 'İthal alan' }],
      projects: [{ id: 'pw1', key: 'PW1', name: 'Olmayan alanda', workspaceId: 'ws_yok' },
        { id: 'pw2', key: 'PW2', name: 'Var olan alanda', workspaceId: 'ws_i' },
        { id: 'pw3', key: 'PW3', name: 'Alansız' }, { id: 'pw4', key: 'PW4', name: 'Boş alan', workspaceId: '' }],
      issues: [], constructor: [{ id: 'k1' }], hasOwnProperty: [{ id: 'k2' }] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.skipped, 2);
    const st = (await A.state()).json.data;
    assert.equal(st.workspaces.find(x => x.id === 'ws1').archived, false);
    assert.equal((await row('workspaces', 'ws1')).archived, false);
    assert.deepEqual(st.projects.map(p => [p.id, p.workspaceId]),
      [['pw1', undefined], ['pw2', 'ws_i'], ['pw3', undefined], ['pw4', '']]);
    assert.equal((await row('projects', 'pw1')).workspace_id, null);
    assert.ok(!Object.hasOwn(st, 'constructor') && !Object.hasOwn(st, 'hasOwnProperty'));
    /* önceki duruma dön (sonraki testler) */
    const pre = (await A.req('GET', '/api/backups')).json.find(b => b.kind === 'pre-import');
    assert.equal((await A.req('POST', `/api/backups/${pre.id}/restore`, {})).status, 200);
    assert.ok((await A.state()).json.data.workspaces.some(x => x.id === 'ws_a'));
  });
});

/* ---------------- cariler (#11) ----------------
   Test verileri uydurmadır (gerçek kişi/firma/kimlik numarası değildir). */
describe('cariler', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const cu = (id, data, base) => ({ c: 'customers', id, op: 'put', data, ...(base ? { base } : {}) });
  const del = (c, id) => ({ c, id, op: 'del' });
  const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
  const reasons = r => r.json.rejected.map(x => x.reason);
  const ok = r => { assert.equal(r.status, 200); assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected)); };
  const rejectedWith = (r, msg) => { assert.equal(r.status, 200); assert.equal(r.json.applied, 0); assert.deepEqual(reasons(r), [msg]); };
  /* snapshots (yedek) hariç tüm tabloların metin dökümü */
  const dump = async () => {
    const ts = (await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'snapshots'`)).rows.map(r => r.table_name);
    let out = '';
    for (const t of ts) out += (await pool.query(`SELECT t::text AS x FROM "${t}" t`)).rows.map(r => r.x).join('\n') + '\n';
    return out;
  };
  let A, U, V;
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'CuYeni123456' })).status, 200);
    return k;
  };
  const firm = (name, extra = {}) => ({ name, kind: 'customer', ...extra });
  const firmWith = (id, name, taxNo) => ({ id, name, kind: 'supplier', taxNo });

  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    U = await newUser('u_cu1', 'cuuye', 'member');
    V = await newUser('u_cuv', 'cuizci', 'viewer');
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: { name: 'Cari projesi', key: 'CUA', counter: 0, workspaceId: 'ws1' } },
      { c: 'projects', id: 'p_cu2', op: 'put', data: { name: 'Cari arşiv', key: 'CUB', counter: 0, workspaceId: 'ws1', archived: true } }]));
  });

  test('göç: 004 tekrar çalışır; tablo, kısmi tekil indeks ve projects.customer_id var; veri korunur', async () => {
    ok(await A.sync([cu('c_g1', firm('Göç Deneme A.Ş.', { taxNo: '1111111111' }))]));
    await pool.query(`DELETE FROM schema_migrations WHERE id='004_cariler.sql'`);
    await migrate(pool);
    assert.equal((await pool.query(`SELECT count(*) n FROM schema_migrations WHERE id='004_cariler.sql'`)).rows[0].n, '1');
    const r = await row('customers', 'c_g1');
    assert.equal(r.name, 'Göç Deneme A.Ş.'); assert.equal(r.tax_no, '1111111111'); assert.equal(r.kind, 'customer'); assert.equal(r.active, true);
    const idx = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname='customers_tax_no_uq'`)).rows[0].indexdef;
    assert.match(idx, /UNIQUE/); assert.match(idx, /WHERE \(tax_no IS NOT NULL\)/);
    assert.equal((await row('projects', 'p_cu1')).customer_id, null);
    ok(await A.sync([del('customers', 'c_g1')]));
  });

  test('normalleştirme: vergi no boşluk/tire temizlenir, unvan ve e-postalar kırpılır (adjusted)', async () => {
    const r = await A.sync([cu('c_n1', firm('  Boşluklu Ltd.  ', { kind: 'both', taxNo: '123 456-7890', email: ' info@ornek.test ',
      contacts: [{ id: 'ct_n1', name: ' Deneme Kişi ', email: ' kisi@ornek.test ' }] }))]);
    ok(r);
    assert.deepEqual(r.json.adjusted, [{ c: 'customers', id: 'c_n1' }]);
    const d = (await row('customers', 'c_n1')).data;
    assert.equal(d.taxNo, '1234567890'); assert.equal(d.name, 'Boşluklu Ltd.'); assert.equal(d.email, 'info@ornek.test');
    assert.deepEqual(d.contacts, [{ id: 'ct_n1', name: 'Deneme Kişi', email: 'kisi@ornek.test' }]);
    assert.equal(d.active, undefined);
    assert.equal((await row('customers', 'c_n1')).active, true);        // yeni = Etkin
    /* zaten düzgün kayıtta adjusted yok */
    const r2 = await A.sync([cu('c_n2', firm('Düzgün Ltd.', { taxNo: '1234567891' }))]);
    ok(r2); assert.deepEqual(r2.json.adjusted, []);
    for (const id of ['c_n1', 'c_n2']) ok(await A.sync([del('customers', id)]));
  });

  test('doğrulama: hatalı kayıt yazılmaz; iletilerde değer yok', async () => {
    const cases = [
      [{ kind: 'customer' }, 'Unvan gerekli (en fazla 200 karakter)'],
      [{ name: '   ', kind: 'customer' }, 'Unvan gerekli (en fazla 200 karakter)'],
      [{ name: 'x'.repeat(201), kind: 'customer' }, 'Unvan gerekli (en fazla 200 karakter)'],
      [{ name: 'Türsüz' }, 'Tür müşteri, tedarikçi ya da ikisi olmalı'],
      [firm('Tür', { kind: 'rakip' }), 'Tür müşteri, tedarikçi ya da ikisi olmalı'],
      [firm('Dokuz', { taxNo: '987654321' }), 'Vergi numarası 10 ya da 11 haneli olmalı'],
      [firm('Oniki', { taxNo: '987654321098' }), 'Vergi numarası 10 ya da 11 haneli olmalı'],
      [firm('Harfli', { taxNo: '98765A3210' }), 'Vergi numarası 10 ya da 11 haneli olmalı'],
      [firm('Sayı', { taxNo: 9876543210 }), 'Vergi numarası 10 ya da 11 haneli olmalı'],
      [firm('Posta', { email: 'gizli-posta@' }), 'E-posta adresi geçersiz'],
      [firm('Tel', { phone: '9'.repeat(31) }), 'Telefon en fazla 30 karakter'],
      [firm('Kısa', { shortName: 'k'.repeat(61) }), 'Kısa ad en fazla 60 karakter'],
      [firm('Daire', { taxOffice: 'd'.repeat(101) }), 'Vergi dairesi en fazla 100 karakter'],
      [firm('Adres', { address: 'a'.repeat(501) }), 'Adres en fazla 500 karakter'],
      [firm('Not', { notes: 'n'.repeat(2001) }), 'Notlar en fazla 2000 karakter'],
      [firm('Etkin', { active: 'x' }), 'Durum (etkin) true ya da false olmalı'],
      [firm('Kişiler', { contacts: 'gizli-kisi' }), 'Yetkili kişiler en fazla 200 kişilik bir liste olmalı'],
      [firm('Çok kişi', { contacts: Array.from({ length: 201 }, (_, i) => ({ id: 'ct' + i, name: 'K' + i })) }),
        'Yetkili kişiler en fazla 200 kişilik bir liste olmalı'],
      [firm('Adsız', { contacts: [{ id: 'ct_1', email: 'adsiz@ornek.test' }] }), 'Yetkili kişinin adı gerekli (en fazla 120 karakter)'],
      [firm('Kimliksiz', { contacts: [{ id: '<b>', name: 'K' }] }), 'Yetkili kişinin kimliği geçersiz'],
      [firm('Çift', { contacts: [{ id: 'ct_1', name: 'K' }, { id: 'ct_1', name: 'L' }] }), 'Yetkili kişi kimlikleri tekil olmalı'],
      [firm('Görev', { contacts: [{ id: 'ct_1', name: 'K', title: 'g'.repeat(121) }] }), 'Yetkili kişinin görevi en fazla 120 karakter'],
      [firm('KP', { contacts: [{ id: 'ct_1', name: 'K', email: 'gizli@' }] }), 'Yetkili kişinin e-posta adresi geçersiz'],
      [firm('KT', { contacts: [{ id: 'ct_1', name: 'K', phone: '5'.repeat(31) }] }), 'Yetkili kişinin telefonu en fazla 30 karakter'],
    ];
    for (const [data, msg] of cases) {
      const r = await A.sync([cu('c_bad', data)]);
      rejectedWith(r, msg);
      for (const v of ['987654321', 'gizli', 'adsiz@', '9'.repeat(31)]) assert.ok(!reasons(r)[0].includes(v), msg);
    }
    assert.equal(await row('customers', 'c_bad'), undefined);
    /* 200 kişi ve en uzun geçerli değerler kabul edilir */
    ok(await A.sync([cu('c_max', firm('u'.repeat(200), { shortName: 'k'.repeat(60), taxNo: '', phone: '9'.repeat(30), active: false,
      contacts: Array.from({ length: 200 }, (_, i) => ({ id: 'ct' + i, name: 'K' + i, title: '', email: '', phone: '' })) }))]));
    ok(await A.sync([del('customers', 'c_max')]));
  });

  test('vergi no tekil (pasif dahil, yalnız kimlik iletilir); boş vergi no denetlenmez', async () => {
    ok(await A.sync([cu('c_t1', firm('Tekil Bir A.Ş.', { taxNo: '2222222222', active: false }))]));
    let r = await A.sync([cu('c_t2', firm('Tekil İki A.Ş.', { taxNo: '222-222 2222' }))]);
    assert.equal(r.status, 200);
    assert.deepEqual(reasons(r), ['Bu vergi numarasıyla kayıtlı cari var (#c_t1)']);
    assert.equal(await row('customers', 'c_t2'), undefined);
    ok(await A.sync([cu('c_t2', firm('Tekil İki A.Ş.', { taxNo: '' }))]));
    ok(await A.sync([cu('c_t3', firm('Tekil Üç A.Ş.'))]));               // iki boş vergi no
    /* var olan carinin vergi numarasını başkasınınkiyle değiştirmek de reddedilir */
    r = await A.sync([cu('c_t2', firm('Tekil İki A.Ş.', { taxNo: '2222222222' }))]);
    assert.deepEqual(reasons(r), ['Bu vergi numarasıyla kayıtlı cari var (#c_t1)']);
    /* kendi vergi numarasıyla güncelleme serbest */
    ok(await A.sync([cu('c_t1', firm('Tekil Bir A.Ş. (yeni)', { taxNo: '2222222222', active: false }))]));
    assert.equal((await row('customers', 'c_t1')).name, 'Tekil Bir A.Ş. (yeni)');
    for (const id of ['c_t1', 'c_t2', 'c_t3']) ok(await A.sync([del('customers', id)]));
  });

  test('vergi no tekilliği eşzamanlı yazmada da korunur (500 yok, aynı ileti)', async () => {
    const [r1, r2] = await Promise.all([
      A.sync([cu('c_y1', firm('Yarış Bir', { taxNo: '3333333333' }))]),
      A.sync([cu('c_y2', firm('Yarış İki', { taxNo: '3333333333' }))]),
    ]);
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    assert.equal(r1.json.applied + r2.json.applied, 1);
    const lost = r1.json.applied ? r2 : r1, won = r1.json.applied ? 'c_y1' : 'c_y2';
    assert.deepEqual(reasons(lost), [`Bu vergi numarasıyla kayıtlı cari var (#${won})`]);
    assert.equal((await pool.query(`SELECT count(*) n FROM customers WHERE tax_no='3333333333'`)).rows[0].n, '1');
    ok(await A.sync([del('customers', won)]));
    /* Kesin yarış: ön denetim diğer işlemin henüz onaylanmamış kaydını görmez, indeks (23505) yakalar. */
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO customers (id, data) VALUES ('c_y3', '{"id":"c_y3","name":"Yarış Üç","kind":"customer","taxNo":"3333333334"}')`);
      const pending = A.sync([cu('c_y4', firm('Yarış Dört', { taxNo: '3333333334' }))]);
      await new Promise(r => setTimeout(r, 300));
      await c.query('COMMIT');
      const r = await pending;
      assert.equal(r.status, 200);
      rejectedWith(r, 'Bu vergi numarasıyla kayıtlı cari var (#c_y3)');
    } finally { c.release(); }
    ok(await A.sync([del('customers', 'c_y3')]));
  });

  test('vergi no: aynı numaraya yazmalar danışma kilidiyle sıralanır; ikincisi ön denetimde 409 alır (23505 değil)', async () => {
    const TN = '3333333335';
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(727277, hashtext($1))', [TN]);
      const pending = A.sync([cu('c_k2', firm('Kilit İki', { taxNo: TN }))]);
      await new Promise(r => setTimeout(r, 300));
      const waiting = (await pool.query(`SELECT count(*) n FROM pg_locks WHERE locktype='advisory' AND classid=727277 AND NOT granted`)).rows[0].n;
      assert.equal(waiting, '1');                                          // senkron kilidi bekliyor
      await c.query(`INSERT INTO customers (id, data) VALUES ('c_k1', $1::jsonb)`,
        [JSON.stringify({ id: 'c_k1', name: 'Kilit Bir', kind: 'customer', taxNo: TN })]);
      await c.query('COMMIT');
      rejectedWith(await pending, 'Bu vergi numarasıyla kayıtlı cari var (#c_k1)');
    } finally { c.release(); }
    assert.equal(await row('customers', 'c_k2'), undefined);
    ok(await A.sync([del('customers', 'c_k1')]));
  });

  test('aynı kimlikle eşzamanlı cari oluşturma: ikincisi üzerine yazmaz (409)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO customers (id, data) VALUES ('c_ay', '{"id":"c_ay","name":"İlk Yazan","kind":"customer"}')`);
      const pending = A.sync([cu('c_ay', firm('İkinci Yazan'))]);
      await new Promise(r => setTimeout(r, 300));
      await c.query('COMMIT');
      rejectedWith(await pending, 'Kayıt aynı anda oluşturuldu, yeniden deneyin');
    } finally { c.release(); }
    assert.equal((await row('customers', 'c_ay')).name, 'İlk Yazan');
    ok(await A.sync([del('customers', 'c_ay')]));
  });

  test('yetki: üye ve izleyici cari ekleyemez, değiştiremez, silemez; yönetici yönetir', async () => {
    ok(await A.sync([cu('c_y', firm('Yetki A.Ş.'))]));
    for (const k of [U, V]) {
      const msg = k === U ? 'Bu değişiklik için yönetici yetkisi gerekli' : 'salt okunur kullanıcı';
      rejectedWith(await k.sync([cu('c_yeni', firm('Yeni'))]), msg);
      rejectedWith(await k.sync([cu('c_y', firm('Yetki A.Ş. değişti'))]), msg);
      rejectedWith(await k.sync([del('customers', 'c_y')]), msg);
    }
    assert.equal(await row('customers', 'c_yeni'), undefined);
    assert.equal((await row('customers', 'c_y')).name, 'Yetki A.Ş.');
    /* süper olmayan yönetici de ekler, pasife alır, siler */
    await A.sync([{ c: 'users', id: 'u_cua', op: 'put', data: { username: 'cuyon', name: 'cuyon', role: 'admin', active: true } }]);
    const Y = client(); await Y.login('cuyon', 'Start12345');
    await Y.req('POST', '/api/auth/password', { newPassword: 'CuYeni123456' });
    ok(await Y.sync([cu('c_y', firm('Yetki A.Ş.', { active: false }))]));
    assert.equal((await row('customers', 'c_y')).active, false);
    ok(await Y.sync([del('customers', 'c_y')]));
  });

  test('projeye bağlama: üye etkin cariyi bağlar; pasif/olmayan ret; pasifleşen bağ korunur; kaldırma serbest; izleyici bağlayamaz', async () => {
    ok(await A.sync([cu('c_e', firm('Etkin Müşteri')), cu('c_p', firm('Pasif Müşteri', { active: false }))]));
    const p = (await row('projects', 'p_cu1')).data;
    const put = (k, data, base) => k.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data, ...(base ? { base } : {}) }]);
    rejectedWith(await put(V, { ...p, customerId: 'c_e' }), 'salt okunur kullanıcı');
    rejectedWith(await put(U, { ...p, customerId: 'c_p' }), 'Pasif cari projeye bağlanamaz');
    rejectedWith(await put(U, { ...p, customerId: 'c_yok' }), 'Cari bulunamadı');
    rejectedWith(await put(U, { ...p, customerId: '<x>' }), 'Geçersiz cari');
    rejectedWith(await U.sync([{ c: 'projects', id: 'p_cu_new', op: 'put', data: { name: 'Yeni', key: 'CUN', workspaceId: 'ws1', customerId: 'c_p' } }]),
      'Pasif cari projeye bağlanamaz');
    ok(await put(U, { ...p, customerId: 'c_e' }));
    assert.equal((await row('projects', 'p_cu1')).customer_id, 'c_e');
    /* cari pasife alınır: bağ korunur, proje düzenlenebilir (eski base ile de) */
    ok(await A.sync([cu('c_e', firm('Etkin Müşteri', { active: false }))]));
    const p2 = (await row('projects', 'p_cu1')).data;
    ok(await put(U, { ...p2, name: 'Cari projesi 2' }, p2));
    ok(await put(U, { ...p, name: 'Cari projesi 3' }, p));                // eski hâl (carisiz) base: bağ birleşmede korunur
    const d = (await row('projects', 'p_cu1')).data;
    assert.equal(d.customerId, 'c_e'); assert.equal(d.name, 'Cari projesi 3');
    /* bağı kaldırma serbest; tekrar pasife bağlanamaz */
    const { customerId: _drop, ...noCu } = d;
    ok(await put(U, noCu, d));
    assert.equal((await row('projects', 'p_cu1')).customer_id, null);
    rejectedWith(await put(U, { ...noCu, customerId: 'c_e' }), 'Pasif cari projeye bağlanamaz');
    for (const id of ['c_e', 'c_p']) ok(await A.sync([del('customers', id)]));
  });

  test('silme: bağlı projesi (arşivli dahil) olan cari silinmez (409 + N), bağsızsa kalıcı silinir ve iz kalmaz', async () => {
    const NAME = 'Kvkk Deneme Ticaret A.Ş.', TCKN = '10000000146', MAIL = 'yetkili.kvkk@ornek.test', CMAIL = 'firma.kvkk@ornek.test';
    ok(await A.sync([cu('c_s', firm(NAME, { taxNo: TCKN, email: CMAIL, notes: 'deneme notu', contacts: [{ id: 'ct_s1', name: 'Deneme Yetkili', email: MAIL }] }))]));
    const pa = (await row('projects', 'p_cu1')).data, pb = (await row('projects', 'p_cu2')).data;
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: { ...pa, customerId: 'c_s' } },
      { c: 'projects', id: 'p_cu2', op: 'put', data: { ...pb, customerId: 'c_s' } }]));
    let r = await A.sync([del('customers', 'c_s')]);
    rejectedWith(r, 'Bu cariye bağlı 2 proje var; silmek yerine pasife alın');
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: pa }]));
    rejectedWith(await A.sync([del('customers', 'c_s')]), 'Bu cariye bağlı 1 proje var; silmek yerine pasife alın');   // yalnız arşivli
    ok(await A.sync([{ c: 'projects', id: 'p_cu2', op: 'put', data: pb }]));
    const s0 = (await A.state()).json.seq;
    r = await A.sync([del('customers', 'c_s')]);
    ok(r); assert.equal(r.json.applied, 1);
    assert.equal(await row('customers', 'c_s'), undefined);
    assert.equal((await pool.query(`SELECT count(*) n FROM deleted_records WHERE collection='customers'`)).rows[0].n, '0');
    const ch = (await U.req('GET', `/api/changes?since=${s0}`)).json;
    assert.deepEqual(ch.items.map(i => [i.c, i.id, i.op, i.data]), [['customers', 'c_s', 'del', undefined]]);
    assert.ok(!(await A.state()).json.data.customers.some(x => x.id === 'c_s'));
    const all = await dump();
    for (const v of [NAME, TCKN, MAIL, CMAIL]) assert.ok(!all.includes(v), v);
    assert.equal((await A.req('GET', '/api/trash')).json.some(x => x.collection === 'customers'), false);
    /* olmayan cariyi silmek değişiklik değildir */
    r = await A.sync([del('customers', 'c_s')]);
    assert.equal(r.json.applied, 0); assert.equal(r.json.rejected.length, 0);
  });

  test('e-posta: ? & " < > ve boşluk (mailto: enjeksiyonu) cari, yetkili kişi ve hızlı kişi eklemede ret; değişmeyen eski adres korunur', async () => {
    const BAD = ['a?cc=x@ornek.com', 'a@ornek.com?subject=x', 'a&b@ornek.com', 'a"b@ornek.com', 'a<b@ornek.com', 'a>b@ornek.com', 'a b@ornek.com', 'a@ornek.com&body=x'];
    for (const m of BAD) {
      rejectedWith(await A.sync([cu('c_em', firm('E-posta Carisi', { email: m }))]), 'E-posta adresi geçersiz');
      rejectedWith(await A.sync([cu('c_em', firm('E-posta Carisi', { contacts: [{ id: 'ct_em', name: 'Kişi', email: m }] }))]),
        'Yetkili kişinin e-posta adresi geçersiz');
    }
    ok(await A.sync([cu('c_em', firm('E-posta Carisi', { email: 'ad.soyad+etiket@ornek.com.tr', contacts: [{ id: 'ct_em', name: 'Kişi', email: 'k_1@ornek.io' }] }))]));
    for (const m of BAD) assert.equal((await A.req('POST', '/api/customers/c_em/contacts', { name: 'Hızlı', email: m })).status, 400, m);
    /* eski (bu kuraldan önce yazılmış) adres: düzenlemede değişmedikçe kayıt reddedilmez; yeni bozuk değere geçilemez */
    await pool.query(`UPDATE customers SET data = data || '{"email":"eski&adres@ornek.com","contacts":[{"id":"ct_em","name":"Kişi","email":"k?x@ornek.io"}]}'::jsonb WHERE id='c_em'`);
    const d = (await row('customers', 'c_em')).data;
    ok(await A.sync([cu('c_em', { ...d, notes: 'not' }, d)]));
    const d2 = (await row('customers', 'c_em')).data;
    rejectedWith(await A.sync([cu('c_em', { ...d2, email: 'yeni&adres@ornek.com' }, d2)]), 'E-posta adresi geçersiz');
    rejectedWith(await A.sync([cu('c_em', { ...d2, contacts: [{ id: 'ct_em', name: 'Kişi', email: 'k?y@ornek.io' }] }, d2)]), 'Yetkili kişinin e-posta adresi geçersiz');
    ok(await A.sync([del('customers', 'c_em')]));
  });

  test('silme ↔ bağlama yarışı: cari satırı kilitli; önce bağlayan sayılır (409), önce silen bağlamayı "Cari bulunamadı" yapar', async () => {
    const pa = (await row('projects', 'p_cu1')).data;
    const pending = async p => Promise.race([p.then(() => 'bitti'), new Promise(r => setTimeout(() => r('bekliyor'), 400))]);
    /* 1) bağlayan önce: işlem açık iken silme bekler, bağ işlenince sayılır */
    ok(await A.sync([cu('c_r1', firm('Yarış Carisi 1'))]));
    const t1 = await pool.connect();
    try {
      await t1.query('BEGIN');
      await t1.query(`SELECT active FROM customers WHERE id='c_r1' FOR SHARE`);
      await t1.query(`UPDATE projects SET data = data || '{"customerId":"c_r1"}'::jsonb WHERE id='p_cu1'`);
      const d = A.sync([del('customers', 'c_r1')]);
      assert.equal(await pending(d), 'bekliyor');
      await t1.query('COMMIT');
      rejectedWith(await d, 'Bu cariye bağlı 1 proje var; silmek yerine pasife alın');
    } finally { t1.release(); }
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: pa }]));
    ok(await A.sync([del('customers', 'c_r1')]));
    /* 2) silen önce: bağlama bekler, cari silinince reddedilir; proje bağsız kalır */
    ok(await A.sync([cu('c_r2', firm('Yarış Carisi 2'))]));
    const t2 = await pool.connect();
    try {
      await t2.query('BEGIN');
      await t2.query(`SELECT 1 FROM customers WHERE id='c_r2' FOR UPDATE`);
      await t2.query(`DELETE FROM customers WHERE id='c_r2'`);
      const l = U.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: { ...pa, customerId: 'c_r2' } }]);
      assert.equal(await pending(l), 'bekliyor');
      await t2.query('COMMIT');
      rejectedWith(await l, 'Cari bulunamadı');
    } finally { t2.release(); }
    assert.equal((await row('projects', 'p_cu1')).customer_id, null);
  });

  test('silme: silinen cari yedeklerden de çıkar (unvan/TCKN kalmaz), diğer cariler ve sayım güncel', async () => {
    const NAME = 'Yedek Silme Deneme Ltd.', TCKN = '10000000278', KEEP = 'Yedekte Kalan A.Ş.';
    ok(await A.sync([cu('c_ys', firm(NAME, { taxNo: TCKN, contacts: [{ id: 'ct_ys', name: 'Yedek Yetkili' }] })), cu('c_yk', firm(KEEP))]));
    const b1 = (await A.req('POST', '/api/backups', { label: 'cari silme öncesi' })).json;
    const b2 = (await A.req('POST', '/api/backups', { label: 'cari silme öncesi 2' })).json;
    const before = (await A.req('GET', '/api/backups')).json.find(b => b.id === b1.id);
    const r = await A.sync([del('customers', 'c_ys')]);
    ok(r); assert.equal(r.json.applied, 1);
    for (const b of [b1, b2]) {
      const g = await A.req('GET', `/api/backups/${b.id}`);
      assert.equal(g.status, 200);
      const txt = JSON.stringify(g.json);
      for (const v of [NAME, TCKN, 'Yedek Yetkili']) assert.ok(!txt.includes(v), v);
      assert.ok(g.json.customers.some(x => x.name === KEEP));
      assert.ok(Array.isArray(g.json.projects) && Array.isArray(g.json.issues));   // yedeğin geri kalanı aynı
    }
    const after = (await A.req('GET', '/api/backups')).json.find(b => b.id === b1.id);
    assert.equal(after.counts.customers, before.counts.customers - 1);
    assert.equal(after.counts.projects, before.counts.projects);
    const raw = (await pool.query(`SELECT count(*) n FROM snapshots WHERE data::text LIKE '%' || $1 || '%'`, [TCKN])).rows[0].n;
    assert.equal(raw, '0');
    /* silme reddedilirse (bağlı proje) yedeklere dokunulmaz */
    const pa = (await row('projects', 'p_cu1')).data;
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: { ...pa, customerId: 'c_yk' } }]));
    rejectedWith(await A.sync([del('customers', 'c_yk')]), 'Bu cariye bağlı 1 proje var; silmek yerine pasife alın');
    assert.ok((await A.req('GET', `/api/backups/${b1.id}`)).json.customers.some(x => x.name === KEEP));
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: pa }]));
    ok(await A.sync([del('customers', 'c_yk')]));
  });

  test('yetkili kişi: silinen kişi hiçbir tabloda kalmaz; eski base ile geri gelmez; silinmiş cariye base ile yazılamaz', async () => {
    const MAIL = 'silinecek.kisi@ornek.test';
    ok(await A.sync([cu('c_k', firm('Kişi A.Ş.', { contacts: [{ id: 'ct_k1', name: 'Silinecek Kişi', email: MAIL }, { id: 'ct_k2', name: 'Kalan Kişi' }] }))]));
    const old = (await row('customers', 'c_k')).data;
    ok(await A.sync([cu('c_k', { ...old, contacts: [old.contacts[1]] }, old)]));
    assert.ok(!(await dump()).includes(MAIL));
    /* başka bir yönetici eski hâlle (silinen kişi içinde) kişi ekler ve kalan kişiyi değiştirir */
    const r = await A.sync([cu('c_k', { ...old, contacts: [old.contacts[0], { id: 'ct_k2', name: 'Kalan Kişi', title: 'Müdür' }, { id: 'ct_k3', name: 'Yeni Kişi' }] }, old)]);
    ok(r); assert.deepEqual(r.json.adjusted, [{ c: 'customers', id: 'c_k' }]);
    assert.deepEqual((await row('customers', 'c_k')).data.contacts,
      [{ id: 'ct_k2', name: 'Kalan Kişi', title: 'Müdür' }, { id: 'ct_k3', name: 'Yeni Kişi' }]);
    assert.ok(!(await dump()).includes(MAIL));
    /* eşzamanlı iki ekleme ikisi de kalır; değiştirdiğim kişide benimki kazanır; sildiğim çıkar */
    const b = (await row('customers', 'c_k')).data;
    ok(await A.sync([cu('c_k', { ...b, contacts: [...b.contacts, { id: 'ct_k4', name: 'Dört' }] }, b)]));
    ok(await A.sync([cu('c_k', { ...b, contacts: [{ ...b.contacts[0], phone: '0000' }, { id: 'ct_k5', name: 'Beş' }] }, b)]));
    assert.deepEqual((await row('customers', 'c_k')).data.contacts.map(x => [x.id, x.phone]),
      [['ct_k2', '0000'], ['ct_k4', undefined], ['ct_k5', undefined]]);
    /* silinmiş cari eski hâliyle diriltilemez */
    const last = (await row('customers', 'c_k')).data;
    ok(await A.sync([del('customers', 'c_k')]));
    rejectedWith(await A.sync([cu('c_k', { ...last, name: 'Diriltme' }, last)]), 'Cari silinmiş');
    assert.equal(await row('customers', 'c_k'), undefined);
  });

  test('eşzamanlı düzenleme: biri telefonu, öteki notu değiştirir — ikisi de korunur', async () => {
    ok(await A.sync([cu('c_m', firm('Birleşme A.Ş.', { phone: '1', notes: 'ilk' }))]));
    const b = (await row('customers', 'c_m')).data;
    ok(await A.sync([cu('c_m', { ...b, phone: '0212 000 00 00' }, b)]));
    const r = await A.sync([cu('c_m', { ...b, notes: 'güncel not' }, b)]);
    ok(r); assert.deepEqual(r.json.adjusted, [{ c: 'customers', id: 'c_m' }]);
    const d = (await row('customers', 'c_m')).data;
    assert.equal(d.phone, '0212 000 00 00'); assert.equal(d.notes, 'güncel not');
    ok(await A.sync([del('customers', 'c_m')]));
  });

  test('izleyiciye 11 haneli vergi no (T.C. kimlik no) maskeli; üye/yönetici tam görür; 10 hane maskesiz', async () => {
    const s0 = (await A.state()).json.seq;
    ok(await A.sync([cu('c_tc', firm('Şahıs Deneme', { taxNo: '12345678901' })), cu('c_vk', firm('Tüzel Deneme', { taxNo: '4444444444' }))]));
    const pick = (list, id) => list.find(x => x.id === id).taxNo;
    const vs = (await V.state()).json.data.customers, us = (await U.state()).json.data.customers, as = (await A.state()).json.data.customers;
    assert.equal(pick(vs, 'c_tc'), '*********01'); assert.equal(pick(vs, 'c_vk'), '4444444444');
    assert.equal(pick(us, 'c_tc'), '12345678901'); assert.equal(pick(as, 'c_tc'), '12345678901');
    const items = async k => (await k.req('GET', `/api/changes?since=${s0}`)).json.items.filter(i => i.c === 'customers').map(i => i.data);
    const vc = await items(V), uc = await items(U);
    assert.equal(pick(vc, 'c_tc'), '*********01'); assert.equal(pick(vc, 'c_vk'), '4444444444');
    assert.equal(pick(uc, 'c_tc'), '12345678901');
    assert.ok(!JSON.stringify((await V.state()).json).includes('12345678901'));
    assert.ok(!JSON.stringify((await V.state()).json).includes('123*'));      // ilk haneler de görünmez
    /* dışa aktarma (yönetici) maskesiz; izleyici dışa aktaramaz */
    assert.equal(pick((await A.req('GET', '/api/export')).json.customers, 'c_tc'), '12345678901');
    assert.equal((await V.req('GET', '/api/export')).status, 403);
    assert.equal((await row('customers', 'c_tc')).tax_no, '12345678901');   // veritabanında tam değer
  });

  test('veritabanı hatasında günlüğe yalnız kod/ileti/kısıt yazılır (detail yok)', async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION pano_test_hata() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = 'gunlukdeneme' THEN RAISE EXCEPTION 'deneme hatası' USING DETAIL = 'GIZLI-DETAY-12345678901'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER pano_test_hata BEFORE INSERT ON filters FOR EACH ROW EXECUTE FUNCTION pano_test_hata()`);
    const orig = console.error, lines = [];
    console.error = (...a) => lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x) + String(x?.stack || ''))).join(' '));
    try {
      const r = await A.sync([{ c: 'filters', id: 'gunlukdeneme', op: 'put', data: { a: 1 } }]);
      assert.equal(r.status, 500); assert.equal(r.json.error, 'Sunucu hatası');
    } finally {
      console.error = orig;
      await pool.query('DROP TRIGGER pano_test_hata ON filters; DROP FUNCTION pano_test_hata()');
    }
    const log = lines.join('\n');
    assert.match(log, /\[hata\]/); assert.match(log, /P0001/); assert.match(log, /deneme hatası/);
    assert.ok(!log.includes('GIZLI-DETAY'), log);
  });

  test('yedek: dışa → içe aktarmada cariler ve proje bağı aynı kalır; çift vergi nolu cari atlanır; carisiz eski yedek çalışır', async () => {
    const pa = (await row('projects', 'p_cu1')).data;
    ok(await A.sync([{ c: 'projects', id: 'p_cu1', op: 'put', data: { ...pa, customerId: 'c_vk' } }]));
    const exp = (await A.req('GET', '/api/export')).json;
    assert.ok(exp.customers.length >= 2);
    let r = await A.req('POST', '/api/import', { data: exp });
    assert.equal(r.status, 200); assert.equal(r.json.customers, exp.customers.length); assert.equal(r.json.skipped, undefined);
    const st = (await A.state()).json.data;
    assert.deepEqual(st.customers, exp.customers);
    assert.equal(st.projects.find(p => p.id === 'p_cu1').customerId, 'c_vk');
    /* çift vergi no: ilki kalır, ikincisi atlanır; boşluklu/tireli numara düzeltilir; geçersiz kayıt atlanır */
    r = await A.req('POST', '/api/import', { data: { ...exp, customers: [
      firmWith('c_i1', 'İçe Bir', '555 555-5555'), firmWith('c_i2', 'İçe İki', '5555555555'),
      firmWith('c_i3', 'İçe Üç', ''), firmWith('c_i4', 'İçe Dört', ''), { id: 'c_i5', name: 'Türsüz' }] } });
    assert.equal(r.status, 200); assert.equal(r.json.customers, 3); assert.equal(r.json.skipped, 2);
    const st2 = (await A.state()).json.data.customers;
    assert.deepEqual(st2.map(x => [x.id, x.taxNo]), [['c_i1', '5555555555'], ['c_i3', ''], ['c_i4', '']]);
    /* carisiz (eski) yedek: içe aktarma çalışır, cariler boşalır */
    const { customers: _c, ...oldBackup } = exp;
    r = await A.req('POST', '/api/import', { data: oldBackup });
    assert.equal(r.status, 200); assert.equal(r.json.customers, undefined);
    assert.deepEqual((await A.state()).json.data.customers, []);
  });

  test('yetim cari bağı: silinmiş cariye işaret eden proje/iş yedekten ya da çöp kutusundan bağsız geri gelir', async () => {
    const P = (id, extra = {}) => ({ c: 'projects', id, op: 'put', data: { name: 'Yetim ' + id, key: id.toUpperCase().replace(/_/g, ''), counter: 0, workspaceId: 'ws1', ...extra } });
    const I = (id, pid, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: pid, summary: 'Yetim işi ' + id, ...extra } });
    const req = { customerId: 'c_yt', contactId: 'ct_yt' };
    ok(await A.sync([cu('c_yt', firm('Yetim Carisi', { contacts: [{ id: 'ct_yt', name: 'Yetim Kişi' }] })), cu('c_yk2', firm('Kalan Cari')),
      P('p_yt', { customerId: 'c_yt' }), P('p_yt2'),
      I('i_yt', 'p_yt', { customerId: 'c_yt', requester: req }), I('i_yt2', 'p_yt2', { customerId: 'c_yt' }), I('i_yk', 'p_yt2', { customerId: 'c_yk2' })]));
    const b = (await A.req('POST', '/api/backups', { label: 'yetim öncesi' })).json;
    /* i_yt2 çöpe; p_yt ve i_yt bağı kalkar; cari silinir (yedekten de çıkar) */
    ok(await A.sync([del('issues', 'i_yt2')]));
    const p = (await row('projects', 'p_yt')).data, i = (await row('issues', 'i_yt')).data;
    const { customerId: _a, ...p0 } = p, { customerId: _b, requester: _c, ...i0 } = i;
    ok(await A.sync([{ c: 'projects', id: 'p_yt', op: 'put', data: p0, base: p }, { c: 'issues', id: 'i_yt', op: 'put', data: i0, base: i }]));
    ok(await A.sync([del('customers', 'c_yt')]));
    /* çöp kutusundan: bağsız */
    const t = (await A.req('GET', '/api/trash')).json.find(x => x.record_id === 'i_yt2');
    assert.equal((await A.req('POST', `/api/trash/${t.id}/restore`, {})).json.restored, 1);
    let r2 = await row('issues', 'i_yt2');
    assert.equal(r2.customer_id, null); assert.equal(r2.data.customerId, undefined);
    /* yedekten: proje ve işlerde silinmiş cari bağı (ve talep eden) kalkar; var olan cari bağı korunur */
    assert.equal((await A.req('POST', `/api/backups/${b.id}/restore`, {})).status, 200);
    const pr = await row('projects', 'p_yt'), ir = await row('issues', 'i_yt');
    r2 = await row('issues', 'i_yt2');
    assert.equal(pr.customer_id, null); assert.equal(pr.data.customerId, undefined);
    assert.equal(ir.customer_id, null); assert.equal(ir.data.customerId, undefined); assert.equal(ir.data.requester, undefined);
    assert.equal(r2.customer_id, null);
    assert.equal((await row('issues', 'i_yk')).customer_id, 'c_yk2');
    assert.equal(await row('customers', 'c_yt'), undefined);
    const st = (await A.state()).json.data;
    assert.ok(!st.projects.some(x => x.customerId === 'c_yt') && !st.issues.some(x => x.customerId === 'c_yt' || x.requester?.customerId === 'c_yt'));
  });
});

/* ---------------- proje türü ve kolonlar (#12) ---------------- */
describe('proje türü ve kolonlar', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const P = (id, data) => ({ c: 'projects', id, op: 'put', data: { key: id.toUpperCase().replace(/[^A-Z0-9]/g, ''), counter: 0, ...data, name: data.name || id } });
  const S = (id, pid, name, cat = 'inprogress', ord = 0, extra = {}) => ({ c: 'statuses', id, op: 'put', data: { projectId: pid, name, cat, wip: 0, ord, ...extra } });
  const D = (c, id) => ({ c, id, op: 'del' });
  const I = (id, pid, statusId, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: pid, summary: id, statusId, ...extra } });
  const reasons = r => r.json.rejected.map(x => x.reason);
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  const cols = async pid => (await pool.query(`SELECT id, data FROM statuses WHERE project_id=$1 ORDER BY id`, [pid])).rows.map(r => r.data);
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const conflict = (r, msg) => { assert.equal(r.status, 409, JSON.stringify(r.json)); assert.equal(r.json.error, msg); };
  let A, M, N, V;
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'KolYeni123456' })).status, 200);
    return k;
  };
  const flow = pid => [S(pid + '_a', pid, 'Yapılacak', 'todo', 0), S(pid + '_b', pid, 'Devam ediyor', 'inprogress', 1), S(pid + '_c', pid, 'Bitti', 'done', 2)];
  const setSprintModule = async on => {
    const cur = (await pool.query(`SELECT value FROM settings WHERE key='cfg'`)).rows[0]?.value || {};
    ok(await A.sync([{ c: '_settings', id: 'cfg', op: 'put', data: { ...cur, modules: { ...(cur.modules || {}), sprint: on } } }]));
  };

  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    M = await newUser('u_k_m', 'kolonuye', 'member');
    N = await newUser('u_k_n', 'kolondisi', 'member');
    V = await newUser('u_k_v', 'kolonizci', 'viewer');
    ok(await A.sync([P('pk1', { members: ['u_admin', 'u_k_m'] }), ...flow('pk1'), P('pk_bos', { members: [] }), ...flow('pk_bos')]));
  });

  test('üye olan Üye kolon ekler, adını/kategorisini değiştirir, sıralar ve boş kolonu siler', async () => {
    ok(await M.sync([S('pk1_x', 'pk1', 'İnceleme', 'inprogress', 3)]));
    ok(await M.sync([S('pk1_x', 'pk1', 'Kod incelemesi', 'todo', 3)]));
    ok(await M.sync([S('pk1_x', 'pk1', 'Kod incelemesi', 'todo', 1), S('pk1_b', 'pk1', 'Devam ediyor', 'inprogress', 3)]));
    assert.equal((await row('statuses', 'pk1_x')).ord, 1);
    assert.equal((await row('statuses', 'pk1_x')).cat, 'todo');
    ok(await M.sync([D('statuses', 'pk1_x')]));
    assert.equal(await row('statuses', 'pk1_x'), undefined);
  });

  test('üye listesi boş projede her Üye kolon değiştirebilir', async () => {
    ok(await N.sync([S('pk_bos_x', 'pk_bos', 'Test', 'inprogress', 3)]));
    ok(await N.sync([D('statuses', 'pk_bos_x')]));
  });

  test('izleyici ret: salt okunur kullanıcı', async () => {
    const r = await V.sync([S('pk1_v', 'pk1', 'İzleyici', 'todo', 5)]);
    assert.deepEqual(reasons(r), ['salt okunur kullanıcı']);
    assert.equal(await row('statuses', 'pk1_v'), undefined);
  });

  test('üye olmayan Üye kolon ekleyemez, değiştiremez, silemez (403); başka projeye taşıyamaz', async () => {
    const r = await N.sync([S('pk1_n', 'pk1', 'Yabancı', 'todo', 5), S('pk1_a', 'pk1', 'Değişti', 'todo', 0),
      D('statuses', 'pk1_b'), S('pk1_c', 'pk_bos', 'Bitti 2', 'done', 9)]);
    assert.deepEqual(reasons(r), Array(4).fill('Kolonları yalnızca alan yöneticisi değiştirebilir'));
    assert.equal(r.json.applied, 0);
    assert.equal((await row('statuses', 'pk1_a')).name, 'Yapılacak');
    /* projesi olmayan kolon */
    assert.deepEqual(reasons(await N.sync([S('pk_yok_s', 'pk_yok', 'X')])), ['Durumun projesi yok']);
  });

  test('kolon kilidi yetkiden sonra: yetkisiz istek (üye olmayan, izleyici) kilidi beklemez ve kilit almaz; yetkili bekler', async () => {
    const pending = async p => Promise.race([p.then(() => 'bitti'), new Promise(r => setTimeout(() => r('bekliyor'), 500))]);
    const h = await pool.connect();
    try {
      await h.query('BEGIN');
      await h.query('SELECT pg_advisory_xact_lock(727276, hashtext($1))', ['pk1']);   // başka bir kolon düzenlemesi sürüyor
      const n = N.sync([S('pk1_n2', 'pk1', 'Yabancı 2', 'todo', 6), D('statuses', 'pk1_b')]);
      assert.equal(await pending(n), 'bitti');
      assert.deepEqual(reasons(await n), Array(2).fill('Kolonları yalnızca alan yöneticisi değiştirebilir'));
      const v = V.sync([S('pk1_v2', 'pk1', 'İzleyici 2', 'todo', 6)]);
      assert.equal(await pending(v), 'bitti');
      assert.deepEqual(reasons(await v), ['salt okunur kullanıcı']);
      /* yetkisiz istek sürerken kilit tutmaz: başka bağlantı kilidi hemen alabilir */
      const m = M.sync([S('pk1_m2', 'pk1', 'Üye kolonu', 'todo', 6)]);
      assert.equal(await pending(m), 'bekliyor');
      await h.query('COMMIT');
      ok(await m);
    } finally { h.release(); }
    ok(await M.sync([D('statuses', 'pk1_m2')]));
  });

  test('içinde iş kalan kolon silinmez (409); işler aynı gönderimde taşınınca (silme dizide önce gelse de) silinir', async () => {
    ok(await M.sync([S('pk1_t', 'pk1', 'Geçici', 'inprogress', 4), I('i_k1', 'pk1', 'pk1_t'), I('i_k2', 'pk1', 'pk1_t')]));
    let r = await M.sync([D('statuses', 'pk1_t'), I('i_k1', 'pk1', 'pk1_b')]);
    assert.deepEqual(reasons(r), ['Önce içindeki işleri taşıyın']);
    assert.ok(await row('statuses', 'pk1_t'));
    r = await M.sync([D('statuses', 'pk1_t'), I('i_k2', 'pk1', 'pk1_a')]);
    ok(r);
    assert.equal(await row('statuses', 'pk1_t'), undefined);
    assert.equal((await row('issues', 'i_k2')).statusId, 'pk1_a');
  });

  test('Üye yeni projeyi kolonlarıyla tek gönderimde açar (kolonlar dizide önce gelse de)', async () => {
    const r = await M.sync([...flow('pk_m'), P('pk_m', { members: ['u_k_m'], type: 'board' })]);
    ok(r);
    assert.equal(r.json.applied, 4);
    assert.deepEqual((await cols('pk_m')).map(s => s.name), ['Yapılacak', 'Devam ediyor', 'Bitti']);
    const st = (await M.state()).json.data;
    assert.equal(st.statuses.filter(s => s.projectId === 'pk_m').length, 3);
    assert.equal(st.projects.find(p => p.id === 'pk_m').type, 'board');
  });

  test('son kolon ve son Bitti kolonu silinemez, son Bitti kategorisi değişemez; iki Bitti\'den biri silinir', async () => {
    ok(await A.sync([P('pk_tek', {}), S('pk_tek_a', 'pk_tek', 'Tek', 'todo', 0)]));
    conflict(await A.sync([D('statuses', 'pk_tek_a')]), 'Projenin son kolonu silinemez');
    assert.ok(await row('statuses', 'pk_tek_a'));
    conflict(await M.sync([D('statuses', 'pk1_c')]), 'Projede en az bir Bitti kolonu kalmalı');
    conflict(await M.sync([S('pk1_c', 'pk1', 'Bitti', 'inprogress', 2)]), 'Projede en az bir Bitti kolonu kalmalı');
    assert.equal((await row('statuses', 'pk1_c')).cat, 'done');
    ok(await M.sync([S('pk1_c2', 'pk1', 'Yayında', 'done', 5)]));
    ok(await M.sync([D('statuses', 'pk1_c2')]));
    /* ihlal tüm gönderimi geri alır (ilgisiz değişiklik dahil) */
    conflict(await M.sync([I('i_k1', 'pk1', 'pk1_a'), D('statuses', 'pk1_c')]), 'Projede en az bir Bitti kolonu kalmalı');
    assert.equal((await row('issues', 'i_k1')).statusId, 'pk1_b');
    /* eski projede Bitti hiç yoksa kural işlemez */
    ok(await A.sync([S('pk_tek_b', 'pk_tek', 'İkinci', 'todo', 1)]));
    ok(await A.sync([D('statuses', 'pk_tek_b')]));
  });

  test('şablon uygulama (yeniden adlandır + kategori + fazlaları taşıyıp sil) tek gönderimde kabul', async () => {
    ok(await M.sync([S('pk1_e1', 'pk1', 'Ek 1', 'inprogress', 6), S('pk1_e2', 'pk1', 'Ek 2', 'inprogress', 7), I('i_k3', 'pk1', 'pk1_e2')]));
    /* Basit: Yapılacak / Bitti (pk1_b "Bitti" olur, eski Bitti silinir) */
    const r = await M.sync([
      S('pk1_a', 'pk1', 'Yapılacak', 'todo', 0), S('pk1_b', 'pk1', 'Bitti', 'done', 1),
      I('i_k1', 'pk1', 'pk1_b'), I('i_k3', 'pk1', 'pk1_b'),
      D('statuses', 'pk1_c'), D('statuses', 'pk1_e1'), D('statuses', 'pk1_e2')]);
    ok(r);
    assert.deepEqual((await cols('pk1')).map(s => [s.id, s.name, s.cat]), [['pk1_a', 'Yapılacak', 'todo'], ['pk1_b', 'Bitti', 'done']]);
    /* eski akışa dön */
    ok(await M.sync([S('pk1_b', 'pk1', 'Devam ediyor', 'inprogress', 1), S('pk1_c', 'pk1', 'Bitti', 'done', 2)]));
  });

  test('yönetici projeyi kolonları ve işleriyle siler: kolon kuralları engellemez', async () => {
    ok(await A.sync([P('pk_sil', {}), ...flow('pk_sil'), I('i_ks', 'pk_sil', 'pk_sil_c')]));
    const r = await A.sync([D('projects', 'pk_sil'), D('issues', 'i_ks'), ...flow('pk_sil').map(s => D('statuses', s.id))]);
    ok(r);
    assert.equal((await cols('pk_sil')).length, 0);
  });

  test('kolon adı: 31 karakter ve boş ret, tr harf duyarsız tekil (IŞIK = ışık), eski uzun adlı kolon sıralanabilir', async () => {
    assert.deepEqual(reasons(await M.sync([S('pk1_l', 'pk1', 'x'.repeat(31))])), ['Kolon adı 1 ile 30 karakter arasında olmalı']);
    assert.deepEqual(reasons(await M.sync([S('pk1_l', 'pk1', '   ')])), ['Durum adı gerekli']);
    ok(await M.sync([S('pk1_l', 'pk1', 'x'.repeat(30), 'inprogress', 8)]));
    ok(await M.sync([S('pk1_i', 'pk1', 'ışık', 'inprogress', 9)]));
    conflict(await M.sync([S('pk1_i2', 'pk1', 'IŞIK', 'inprogress', 10)]), 'Bu adla bir kolon zaten var');
    conflict(await M.sync([S('pk1_l', 'pk1', '  Işık ', 'inprogress', 8)]), 'Bu adla bir kolon zaten var');
    ok(await M.sync([S('pk1_i', 'pk1', 'IŞIK', 'inprogress', 9)]));          // kendi adının büyük harfi
    ok(await M.sync([S('pk_bos_i', 'pk_bos', 'Işık', 'inprogress', 9)]));    // başka projede aynı ad serbest
    /* eski (40 karakterlik) ad: yalnız sıra değişince kabul, ad değişince 1–30 */
    await pool.query(`UPDATE statuses SET data = jsonb_set(data, '{name}', to_jsonb($2::text)) WHERE id=$1`, ['pk1_l', 'u'.repeat(40)]);
    ok(await M.sync([S('pk1_l', 'pk1', 'u'.repeat(40), 'inprogress', 11)]));
    assert.deepEqual(reasons(await M.sync([S('pk1_l', 'pk1', 'u'.repeat(41), 'inprogress', 11)])), ['Kolon adı 1 ile 30 karakter arasında olmalı']);
    ok(await M.sync([D('statuses', 'pk1_l'), D('statuses', 'pk1_i'), D('statuses', 'pk_bos_i')]));
  });

  test('bir projede en fazla 12 kolon: 13. kolon ret', async () => {
    ok(await A.sync([P('pk_12', {}), ...Array.from({ length: 12 }, (_, k) => S('pk_12_' + k, 'pk_12', 'K' + k, k === 11 ? 'done' : 'todo', k))]));
    conflict(await A.sync([S('pk_12_x', 'pk_12', 'On üç', 'todo', 12)]), 'Bir projede en fazla 12 kolon olabilir');
    /* birini silip birini eklemek serbest */
    ok(await A.sync([D('statuses', 'pk_12_0'), S('pk_12_x', 'pk_12', 'Yeni', 'todo', 0)]));
    assert.equal((await cols('pk_12')).length, 12);
  });

  test('proje türü: board/agile/boş kabul, "x" 400', async () => {
    assert.deepEqual(reasons(await A.sync([P('pk_tx', { type: 'x' })])), ['Geçersiz proje türü']);
    ok(await A.sync([P('pk_tb', { type: 'board' }), P('pk_ta', { type: 'agile' }), P('pk_tn', { type: '' })]));
  });

  test('tür değişimi: aktif sprintte Agile→Pano 409 (türsüz + modules.sprint:true dahil); sprint yoksa kabul; üye olmayan 403; türsüz kalır', async () => {
    ok(await A.sync([P('pk_ag', { type: 'agile', members: ['u_admin', 'u_k_m'] }), ...flow('pk_ag'),
      { c: 'sprints', id: 'sp_k1', op: 'put', data: { projectId: 'pk_ag', name: 'S1', state: 'active' } }]));
    assert.deepEqual(reasons(await M.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })])), ['Önce aktif sprinti tamamlayın']);
    assert.deepEqual(reasons(await N.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })])),
      ['Proje türünü yalnızca alan yöneticisi değiştirebilir']);
    assert.equal((await row('projects', 'pk_ag')).type, 'agile');
    /* türsüz proje + genel sprint açık → agile sayılır */
    await setSprintModule(true);
    try {
      ok(await A.sync([P('pk_ts', { members: [] }), { c: 'sprints', id: 'sp_k2', op: 'put', data: { projectId: 'pk_ts', name: 'S', state: 'active' } }]));
      assert.deepEqual(reasons(await A.sync([P('pk_ts', { members: [], type: 'board' })])), ['Önce aktif sprinti tamamlayın']);
      ok(await A.sync([P('pk_ts', { members: [], name: 'Yeni ad' })]));     // türsüz kalır
      assert.equal(Object.hasOwn(await row('projects', 'pk_ts'), 'type'), false);
      ok(await N.sync([P('pk_ts', { members: [], name: 'Yeni ad', type: 'agile' })]));   // hesaplanan tür aynı: denetim yok
    } finally { await setSprintModule(false); }
    /* sprint tamamlanınca (eski alanda sprinti sistem yöneticisi bitirir) Agile→Pano kabul; Pano→Agile her zaman */
    ok(await A.sync([{ c: 'sprints', id: 'sp_k1', op: 'put', data: { projectId: 'pk_ag', name: 'S1', state: 'closed' } }]));
    ok(await M.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })]));
    ok(await M.sync([P('pk_ag', { type: 'agile', members: ['u_admin', 'u_k_m'] })]));
    ok(await M.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })]));
  });

  test('türü açıkça Pano olan projede sprint başlatılamaz; türsüz (genel sprint kapalı) projede ve Agile\'da başlar', async () => {
    assert.equal((await pool.query(`SELECT value FROM settings WHERE key='cfg'`)).rows[0]?.value?.modules?.sprint, false);
    const r = await A.sync([{ c: 'sprints', id: 'sp_k3', op: 'put', data: { projectId: 'pk_ag', name: 'S3', state: 'active' } },
      { c: 'sprints', id: 'sp_k4', op: 'put', data: { projectId: 'pk_bos', name: 'S4', state: 'active' } },
      { c: 'sprints', id: 'sp_k5', op: 'put', data: { projectId: 'pk_ag', name: 'S5', state: 'future' } }]);
    assert.deepEqual(reasons(r), ['Pano türündeki projede sprint başlatılamaz']);
    assert.equal((await row('projects', 'pk_ag')).type, 'board');
    assert.equal(await row('sprints', 'sp_k3'), undefined);
    assert.equal((await row('sprints', 'sp_k4')).state, 'active');        // türsüz eski proje: kural yok
    assert.equal((await row('sprints', 'sp_k5')).state, 'future');
    /* future → active geçişi de Pano'da ret */
    assert.deepEqual(reasons(await A.sync([{ c: 'sprints', id: 'sp_k5', op: 'put', data: { projectId: 'pk_ag', name: 'S5', state: 'active' } }])),
      ['Pano türündeki projede sprint başlatılamaz']);
    assert.deepEqual(reasons(await A.sync([{ c: 'sprints', id: 'sp_k7', op: 'put', data: { projectId: 'pk_tb', name: 'S7', state: 'active' } }])),
      ['Pano türündeki projede sprint başlatılamaz']);
    ok(await A.sync([{ c: 'sprints', id: 'sp_k4', op: 'put', data: { projectId: 'pk_bos', name: 'S4', state: 'closed' } }]));
    ok(await A.sync([{ c: 'sprints', id: 'sp_k6', op: 'put', data: { projectId: 'pk_ta', name: 'S6', state: 'active' } }]));
  });

  test('işin kolonu var olan bir kolon olmalı (yeni iş dahil); kolon değişmediyse denetlenmez', async () => {
    assert.deepEqual(reasons(await M.sync([I('i_k9', 'pk1', 'kolon_yok')])), ['Kolon bulunamadı']);
    ok(await M.sync([I('i_k9', 'pk1', 'pk1_a')]));
    assert.deepEqual(reasons(await M.sync([I('i_k9', 'pk1', 'kolon_yok')])), ['Kolon bulunamadı']);
    await pool.query(`UPDATE issues SET data = jsonb_set(data, '{statusId}', '"eski_kolon"') WHERE id='i_k9'`);
    ok(await M.sync([I('i_k9', 'pk1', 'eski_kolon', { summary: 'özet değişti' })]));
    ok(await M.sync([I('i_k9', 'pk1', 'pk1_a')]));
  });

  test('silinmiş kolon eski hâliyle (base) yeniden doğmaz', async () => {
    ok(await M.sync([S('pk1_r', 'pk1', 'Geri', 'todo', 6)]));
    const base = await row('statuses', 'pk1_r');
    ok(await A.sync([D('statuses', 'pk1_r')]));
    const r = await M.sync([{ ...S('pk1_r', 'pk1', 'Geri 2', 'todo', 6), base }]);
    assert.deepEqual(reasons(r), ['Kolon silinmiş']);
    assert.equal(await row('statuses', 'pk1_r'), undefined);
  });

  test('XSS: <script> kolon adı metin olarak saklanır', async () => {
    const name = '<script>alert(1)</script>';
    ok(await M.sync([S('pk1_xss', 'pk1', name, 'todo', 7)]));
    assert.equal((await M.state()).json.data.statuses.find(s => s.id === 'pk1_xss').name, name);
    ok(await M.sync([D('statuses', 'pk1_xss')]));
  });

  test('eşzamanlı: iki Üye aynı anda iki Bitti kolonundan birer tanesini siler → biri 409, bir Bitti kalır', async () => {
    ok(await M.sync([S('pk1_c3', 'pk1', 'Yayında', 'done', 5)]));
    const M2 = client(); await M2.login('kolonuye', 'KolYeni123456');
    const [r1, r2] = await Promise.all([M.sync([D('statuses', 'pk1_c')]), M2.sync([D('statuses', 'pk1_c3')])]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal((await cols('pk1')).filter(s => s.cat === 'done').length, 1);
  });
  test('gruplama: yeni çalışma alanı + o alanda proje ve yeni cari + ona bağlı proje tek gönderimde (proje dizide önce gelse de)', async () => {
    ok(await A.sync([P('pk_wsp', { workspaceId: 'ws_k1', members: ['u_k_m'] }),
      { c: 'workspaces', id: 'ws_k1', op: 'put', data: { name: 'Kolon alanı', color: '#3E7BC4' } }]));
    assert.equal((await row('projects', 'pk_wsp')).workspaceId, 'ws_k1');
    assert.ok(await row('workspaces', 'ws_k1'));
    ok(await A.sync([P('pk_cup', { customerId: 'c_k1' }),
      { c: 'customers', id: 'c_k1', op: 'put', data: { name: 'Kolon Carisi', kind: 'customer' } }]));
    assert.equal((await row('projects', 'pk_cup')).customerId, 'c_k1');
    /* silmeler gönderim sırasıyla: önce proje, sonra alanı */
    ok(await A.sync([D('projects', 'pk_wsp'), D('workspaces', 'ws_k1')]));
    assert.equal(await row('workspaces', 'ws_k1'), undefined);
  });

  test('kilitlenme yok: ters sıralı eşzamanlı kolon gönderimleri 500 vermez', async () => {
    ok(await A.sync([P('pk_dl1', {}), ...flow('pk_dl1'), P('pk_dl2', {}), ...flow('pk_dl2')]));
    const A2 = client(); await A2.login('admin', 'test-admin-pw');
    for (let k = 0; k < 5; k++) {
      const rs = await Promise.all([
        A.sync([S('pk_dl1_b', 'pk_dl1', 'Ara ' + k, 'inprogress', 1), S('pk_dl2_b', 'pk_dl2', 'Ara ' + k, 'inprogress', 1)]),
        A2.sync([S('pk_dl2_b', 'pk_dl2', 'Orta ' + k, 'inprogress', 1), S('pk_dl1_b', 'pk_dl1', 'Orta ' + k, 'inprogress', 1)])]);
      for (const r of rs) { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); }
    }
  });

  test('yalnız projesi değişen iş: kolonu yeni projede yoksa yeni projenin ilk "yapılacak" (yoksa ilk) kolonuna taşınır', async () => {
    ok(await A.sync([P('pm1', {}), S('pm1_a', 'pm1', 'Yapılacak', 'todo', 0), S('pm1_b', 'pm1', 'Bitti', 'done', 1),
      P('pm2', {}), S('pm2_x', 'pm2', 'Analiz', 'inprogress', 0), S('pm2_y', 'pm2', 'Sıra', 'todo', 2), S('pm2_t', 'pm2', 'Bekleyen', 'todo', 1), S('pm2_d', 'pm2', 'Bitti', 'done', 3),
      P('pm3', {}), S('pm3_d', 'pm3', 'Bitti', 'done', 1), S('pm3_i', 'pm3', 'Sürüyor', 'inprogress', 0)]));
    ok(await A.sync([I('i_pm', 'pm1', 'pm1_b')]));
    let cur = await row('issues', 'i_pm');
    const r = ok(await A.sync([{ c: 'issues', id: 'i_pm', op: 'put', data: { ...cur, projectId: 'pm2' }, base: cur }]));
    assert.ok(r.json.adjusted.some(x => x.c === 'issues' && x.id === 'i_pm'));
    cur = await row('issues', 'i_pm');
    assert.equal(cur.projectId, 'pm2'); assert.equal(cur.statusId, 'pm2_t');
    /* yapılacak kolonu yoksa ilk kolon (sıraya göre) */
    ok(await A.sync([{ c: 'issues', id: 'i_pm', op: 'put', data: { ...cur, projectId: 'pm3' }, base: cur }]));
    cur = await row('issues', 'i_pm');
    assert.equal(cur.statusId, 'pm3_i');
    /* kolonu da açıkça verilirse: yeni projenin kolonu korunur, başka projenin kolonu ret */
    ok(await A.sync([I('i_pm', 'pm2', 'pm2_d')]));
    assert.equal((await row('issues', 'i_pm')).statusId, 'pm2_d');
    assert.deepEqual(reasons(await A.sync([I('i_pm', 'pm1', 'pm2_x')])), ['Kolon bulunamadı']);
    assert.equal((await row('issues', 'i_pm')).projectId, 'pm2');
  });

  test('işin kolonu işin projesine ait olmalı: başka projenin kolonu "Kolon bulunamadı"', async () => {
    assert.deepEqual(reasons(await M.sync([I('i_k9', 'pk1', 'pk_bos_a')])), ['Kolon bulunamadı']);
    assert.deepEqual(reasons(await M.sync([I('i_k10', 'pk1', 'pk_bos_a')])), ['Kolon bulunamadı']);
    assert.equal((await row('issues', 'i_k9')).statusId, 'pk1_a');
  });

  test('üye listesi: üye olmayan değiştiremez (403); üye ve yönetici değiştirir; boş listeye kendini ekleyebilir; yeni projede serbest', async () => {
    const pk1 = await row('projects', 'pk1');
    assert.deepEqual(reasons(await N.sync([P('pk1', { ...pk1, members: [...pk1.members, 'u_k_n'] })])),
      ['Proje üyelerini yalnızca alan yöneticisi değiştirebilir']);
    assert.deepEqual((await row('projects', 'pk1')).members, ['u_admin', 'u_k_m']);
    /* proje adı/ayarı da canDesign: listede olmayan Üye değiştiremez (önceden serbestti) */
    assert.deepEqual(reasons(await N.sync([P('pk1', { ...pk1, name: 'pk1 yeni ad' })])), ['Projeyi yalnızca alan yöneticisi değiştirebilir']);
    ok(await M.sync([P('pk1', { ...pk1, name: 'pk1 yeni ad' })]));
    ok(await M.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m', 'u_k_n'] })]));
    ok(await N.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m'] })]));      // artık üye: değiştirebilir
    ok(await A.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m'] })]));
    const bos = await row('projects', 'pk_bos');
    ok(await N.sync([P('pk_bos', { ...bos, members: ['u_k_n'] })]));               // liste boştu: kendini ekler
    assert.deepEqual(reasons(await M.sync([P('pk_bos', { ...bos, members: [] })])),
      ['Proje üyelerini yalnızca alan yöneticisi değiştirebilir']);
    ok(await N.sync([P('pk_bos', { ...bos, members: [] })]));
    ok(await N.sync([P('pk_yeni_n', { members: ['u_admin'] })]));                  // yeni proje: serbest
  });

  /* Şablon galerisi (görev 10): data.template yalnız bilgi; bilinen değerler ya da boş. */
  test('şablon: bilinen 7 değer ve boş kabul; "x"/sayı "Geçersiz şablon"; kayıt oluşmaz', async () => {
    for (const t of ['x', 'Kanban', 42, '<b>talep</b>'])
      assert.deepEqual(reasons(await A.sync([P('pk_tplx', { template: t })])), ['Geçersiz şablon'], String(t));
    assert.equal(await row('projects', 'pk_tplx'), undefined);
    const all = ['kanban', 'scrum', 'gorev', 'uyarlama', 'talep', 'yolharitasi', 'bos'];
    ok(await A.sync([...all.map(t => P('pk_tpl_' + t, { template: t })), P('pk_tpl_e', { template: '' })]));
    for (const t of all) assert.equal((await row('projects', 'pk_tpl_' + t)).template, t);
  });

  test('şablon: Üye Talep projesini kolonlarıyla açar (data.template="talep"); Scrum → Agile; izleyici ret', async () => {
    const tc = [['Yeni', 'todo'], ['İnceleniyor', 'inprogress'], ['Talep edenden yanıt bekleniyor', 'inprogress'], ['Çözüldü', 'done'], ['Kapandı', 'done']];
    ok(await M.sync([P('pk_talep', { type: 'board', template: 'talep', members: ['u_k_m'], lead: 'u_k_m', workspaceId: 'ws1' }),
      ...tc.map(([n, c], k) => S('pk_talep_' + k, 'pk_talep', n, c, k))]));
    const p = await row('projects', 'pk_talep');
    assert.deepEqual([p.template, p.type], ['talep', 'board']);
    assert.deepEqual((await cols('pk_talep')).sort((a, b) => a.ord - b.ord).map(s => [s.name, s.cat]), tc);
    ok(await M.sync([P('pk_scrum', { type: 'agile', template: 'scrum', members: ['u_k_m'] }), ...flow('pk_scrum')]));
    assert.deepEqual([(await row('projects', 'pk_scrum')).type, (await row('projects', 'pk_scrum')).template], ['agile', 'scrum']);
    const r = await V.sync([P('pk_tpl_v', { type: 'board', template: 'kanban', members: ['u_k_v'] })]);
    assert.deepEqual(reasons(r), ['salt okunur kullanıcı']);
    assert.equal(await row('projects', 'pk_tpl_v'), undefined);
  });

  /* Pano iyileştirmeleri + alan rolleri: sprint başlatma/tamamlama ve sprint süresi projenin alanında Yönetici
     (sistem yöneticisi sınırsız; üyesiz eski alanda yalnız sistem yöneticisi); sprint süresi 1–8 hafta. */
  const SP = (id, pid, state, extra = {}) => ({ c: 'sprints', id, op: 'put', data: { projectId: pid, name: id, state, ...extra } });
  const SPRINT_403 = 'Sprinti yalnızca alan yöneticisi başlatıp bitirebilir';
  const WEEKS_403 = 'Sprint süresini yalnızca alan yöneticisi değiştirebilir';
  const SPWS = { name: 'Sprint alanı', members: [{ userId: 'u_k_m', role: 'admin' }, { userId: 'u_k_n', role: 'member' }, { userId: 'u_k_v', role: 'viewer' }] };
  test('sprint: alan Üyesi başlatamaz/tamamlayamaz (403), oluşturabilir; alan Yöneticisi ve sistem yöneticisi başlatır ve tamamlar', async () => {
    ok(await A.sync([{ c: 'workspaces', id: 'ws_ksp', op: 'put', data: SPWS },
      P('pk_spy', { type: 'agile', workspaceId: 'ws_ksp', members: ['u_admin', 'u_k_m', 'u_k_n'] }), ...flow('pk_spy'),
      P('pk_spz', { type: 'agile', workspaceId: 'ws_ksp' }), ...flow('pk_spz')]));
    ok(await N.sync([SP('sp_y1', 'pk_spy', 'future', { start: '2026-11-16', end: '2026-11-22' })]));       // planlama serbest
    const r = await N.sync([SP('sp_y1', 'pk_spy', 'active')]);
    assert.deepEqual(reasons(r), [SPRINT_403]);                                                            // proje üyesi olsa da alan Üyesi
    assert.equal((await row('sprints', 'sp_y1')).state, 'future');
    assert.deepEqual(reasons(await N.sync([SP('sp_y9', 'pk_spy', 'active')])), [SPRINT_403]);             // doğrudan aktif oluşturma da başlatmadır
    assert.equal(await row('sprints', 'sp_y9'), undefined);
    ok(await M.sync([SP('sp_y1', 'pk_spy', 'active')]));                                                     // alan Yöneticisi başlatır
    ok(await N.sync([SP('sp_y1', 'pk_spy', 'active', { goal: 'hedef' })]));                                 // aktif sprintte düzenleme serbest
    assert.deepEqual(reasons(await N.sync([SP('sp_y1', 'pk_spy', 'closed')])), [SPRINT_403]);
    assert.equal((await row('sprints', 'sp_y1')).state, 'active');
    ok(await M.sync([SP('sp_y1', 'pk_spy', 'closed')]));
    ok(await A.sync([SP('sp_y2', 'pk_spy', 'active')]));                                                     // sistem yöneticisi her projede
    ok(await A.sync([SP('sp_y2', 'pk_spy', 'closed')]));
    /* alan Yöneticisi, proje üye listesinde olmadığı projede de başlatır; alan İzleyicisi başlatamaz */
    ok(await M.sync([SP('sp_y6', 'pk_spz', 'active')]));
    ok(await M.sync([SP('sp_y6', 'pk_spz', 'closed')]));
    assert.equal(reasons(await V.sync([SP('sp_y5', 'pk_spz', 'active')])).length, 1);
    assert.equal(await row('sprints', 'sp_y5'), undefined);
    /* aktif sprinti alan Yöneticisi olmadığı alandaki projeye taşımak da başlatmadır */
    ok(await A.sync([{ c: 'workspaces', id: 'ws_ksp2', op: 'put', data: { name: 'Sprint alanı 2', members: [{ userId: 'u_k_m', role: 'member' }, { userId: 'u_k_n', role: 'admin' }] } },
      P('pk_spn', { type: 'agile', workspaceId: 'ws_ksp2' }), ...flow('pk_spn')]));
    ok(await N.sync([SP('sp_y3', 'pk_spn', 'active')]));                                                     // N burada alan Yöneticisi
    assert.deepEqual(reasons(await N.sync([SP('sp_y3', 'pk_spy', 'active')])), [SPRINT_403]);
    assert.deepEqual(reasons(await M.sync([SP('sp_y7', 'pk_spn', 'active')])), [SPRINT_403]);              // M burada alan Üyesi
    /* üyesiz (eski) alanda yalnız sistem yöneticisi: üye listesi boş projede de Üye başlatamaz */
    assert.deepEqual(reasons(await N.sync([SP('sp_y4', 'pk_bos', 'active')])), [SPRINT_403]);
    assert.equal(await row('sprints', 'sp_y4'), undefined);
    ok(await A.sync([SP('sp_y4', 'pk_bos', 'active')]));
    assert.deepEqual(reasons(await N.sync([SP('sp_y4', 'pk_bos', 'closed')])), [SPRINT_403]);
    ok(await A.sync([SP('sp_y4', 'pk_bos', 'closed')]));
    assert.deepEqual(reasons(await V.sync([SP('sp_y5', 'pk_bos', 'active')])), ['salt okunur kullanıcı']);
  });

  test('sprint süresi: 1–8 tamsayı (boş = 1); geçersiz değer reddedilir; yalnız alan Yöneticisi değiştirir', async () => {
    const W = { type: 'agile', workspaceId: 'ws_ksp', members: ['u_admin', 'u_k_m', 'u_k_n'] };
    ok(await A.sync([P('pk_spw', W)]));
    ok(await M.sync([P('pk_spw', { ...W, sprintWeeks: 2 })]));                                               // alan Yöneticisi
    assert.equal((await row('projects', 'pk_spw')).sprintWeeks, 2);
    for (const bad of [0, 9, 1.5, '2', -1, true, 'iki'])
      assert.deepEqual(reasons(await A.sync([P('pk_spw', { ...W, sprintWeeks: bad })])),
        ['Sprint süresi 1 ile 8 hafta arasında bir tamsayı olmalı'], String(bad));
    ok(await A.sync([P('pk_spw', { ...W, sprintWeeks: 8 })]));
    ok(await A.sync([P('pk_spw', { ...W, sprintWeeks: 1 })]));
    assert.equal(reasons(await N.sync([P('pk_spw', { ...W, sprintWeeks: 3 })])).length, 1);                  // alan Üyesi
    assert.equal(reasons(await V.sync([P('pk_spw', { ...W, sprintWeeks: 3 })])).length, 1);                  // alan İzleyicisi
    assert.equal((await row('projects', 'pk_spw')).sprintWeeks, 1);
    /* üyesiz (eski) alanda: proje üyesi Üye kolonları değiştirebilir ama sprint süresini değiştiremez */
    ok(await A.sync([P('pk_spl', { type: 'agile', members: ['u_admin', 'u_k_m'] })]));
    assert.deepEqual(reasons(await M.sync([P('pk_spl', { type: 'agile', members: ['u_admin', 'u_k_m'], sprintWeeks: 3 })])), [WEEKS_403]);
    ok(await A.sync([P('pk_spl', { type: 'agile', members: ['u_admin', 'u_k_m'], sprintWeeks: 3 })]));
    ok(await N.sync([P('pk_spw2', { type: 'agile', members: ['u_k_n'], sprintWeeks: 4 })]));            // yeni projede serbest
  });
});

describe('geçmiş ve yorum koruması', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const LOCKED = 'Geçmiş kaydı değiştirilemez';
  const NOT_OWNER = 'Başkasının yorumunu yalnızca yönetici değiştirebilir';
  const NO_ISSUE = 'Geçmiş kaydının işi bulunamadı';
  const I = (id, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: 'ph1', summary: id, statusId: 'ph1_a', ...extra } });
  const H = (id, data) => ({ c: 'history', id, op: 'put', data: { field: 'Durum', from: 'A', to: 'B', ...data } });
  const C = (id, data) => ({ c: 'comments', id, op: 'put', data: { body: 'yorum', ...data } });
  const D = (c, id) => ({ c, id, op: 'del' });
  const reasons = r => r.json.rejected.map(x => x.reason);
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const adj = (r, c, id) => r.json.adjusted.some(x => x.c === c && x.id === id);
  let A, M, N, V;
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'GecYeni123456' })).status, 200);
    return k;
  };

  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    M = await newUser('u_h_m', 'gecuye', 'member');
    N = await newUser('u_h_n', 'gecuye2', 'member');
    V = await newUser('u_h_v', 'gecizci', 'viewer');
    ok(await A.sync([
      { c: 'projects', id: 'ph1', op: 'put', data: { name: 'Geçmiş', key: 'GEC', counter: 0 } },
      { c: 'statuses', id: 'ph1_a', op: 'put', data: { projectId: 'ph1', name: 'Yapılacak', cat: 'todo', ord: 0 } },
      I('ih1'), I('ih2'),
    ]));
  });

  test('üye: sahte userId oturuma düzeltilir (adjusted); zaman ±5 dk kırpılır; zamansız kayda şimdi yazılır', async () => {
    const t0 = Date.now();
    const r = ok(await M.sync([
      H('hh_fake', { issueId: 'ih1', userId: 'u_admin', at: t0 }),
      H('hh_ileri', { issueId: 'ih1', userId: 'u_h_m', at: t0 + 3600e3 }),
      H('hh_geri', { issueId: 'ih1', userId: 'u_h_m', at: t0 - 3600e3 }),
      H('hh_yok', { issueId: 'ih1', userId: 'u_h_m' }),
      H('hh_dogru', { issueId: 'ih1', userId: 'u_h_m', at: t0 }),
    ]));
    assert.equal(r.json.applied, 5);
    const t1 = Date.now();
    const fake = await row('history', 'hh_fake');
    assert.equal(fake.userId, 'u_h_m'); assert.equal(fake.at, t0);
    assert.ok(adj(r, 'history', 'hh_fake'));
    const ileri = await row('history', 'hh_ileri'), geri = await row('history', 'hh_geri'), yok = await row('history', 'hh_yok');
    assert.ok(ileri.at <= t1 + 5 * 60e3 && ileri.at >= t0 + 5 * 60e3, String(ileri.at));
    assert.ok(geri.at >= t0 - 5 * 60e3 && geri.at <= t1 - 5 * 60e3, String(geri.at));
    assert.ok(yok.at >= t0 && yok.at <= t1);
    for (const id of ['hh_ileri', 'hh_geri', 'hh_yok']) assert.ok(adj(r, 'history', id), id);
    assert.ok(!adj(r, 'history', 'hh_dogru'));
    assert.equal((await row('history', 'hh_dogru')).at, t0);
  });

  test('yönetici yazar/zaman zorlamasından muaf (Birleştir/seed)', async () => {
    const r = ok(await A.sync([H('hh_adm', { issueId: 'ih1', userId: 'u_h_n', at: 1000 })]));
    const d = await row('history', 'hh_adm');
    assert.equal(d.userId, 'u_h_n'); assert.equal(d.at, 1000);
    assert.ok(!adj(r, 'history', 'hh_adm'));
  });

  test('olmayan işe geçmiş reddedilir; aynı gönderimde açılan işin geçmişi (dizide önce gelse de) kabul edilir', async () => {
    assert.deepEqual(reasons(await M.sync([H('hh_yetim', { issueId: 'i_yok_h', userId: 'u_h_m', at: Date.now() })])), [NO_ISSUE]);
    assert.equal(await row('history', 'hh_yetim'), undefined);
    assert.deepEqual(reasons(await M.sync([H('hh_bos', { userId: 'u_h_m', at: Date.now() })])), ['Geçmiş kaydının işi yok']);
    ok(await M.sync([H('hh_yeni', { issueId: 'ih_yeni', field: 'Oluşturma', kind: 'create', from: null, to: 'ih_yeni', at: Date.now() }), I('ih_yeni')]));
    assert.equal((await row('history', 'hh_yeni')).issueId, 'ih_yeni');
    assert.equal((await row('history', 'hh_yeni')).kind, 'create');
  });

  test('var olan geçmiş kaydı: aynı veri sessizce geçer; değiştirme ve silme üye ve yöneticide 403', async () => {
    const cur = await row('history', 'hh_dogru');
    const same = ok(await M.sync([{ c: 'history', id: 'hh_dogru', op: 'put', data: { ...cur }, base: cur }]));
    assert.equal(same.json.applied, 0);
    ok(await A.sync([{ c: 'history', id: 'hh_dogru', op: 'put', data: { ...cur } }]));
    assert.deepEqual(reasons(await M.sync([{ c: 'history', id: 'hh_dogru', op: 'put', data: { ...cur, to: 'C' }, base: cur }])), [LOCKED]);
    assert.deepEqual(reasons(await A.sync([{ c: 'history', id: 'hh_dogru', op: 'put', data: { ...cur, to: 'C' }, base: cur }])), [LOCKED]);
    assert.deepEqual(reasons(await N.sync([{ c: 'history', id: 'hh_dogru', op: 'put', data: { ...cur, issueId: 'ih2' } }])), [LOCKED]);
    assert.deepEqual(reasons(await M.sync([D('history', 'hh_dogru')])), [LOCKED]);
    assert.deepEqual(reasons(await A.sync([D('history', 'hh_dogru')])), [LOCKED]);
    assert.deepEqual(await row('history', 'hh_dogru'), cur);
    /* Olmayan kaydı silme ret değildir (etkisiz). */
    const r = ok(await M.sync([D('history', 'hh_hic_yok')]));
    assert.equal(r.json.applied, 0);
    /* Yeniden gönderim: sunucunun düzelttiği yazar/zaman dışında aynı veri → ret yok. */
    const fake = await row('history', 'hh_fake');
    const re = ok(await M.sync([H('hh_fake', { ...fake, userId: 'u_admin' })]));
    assert.equal(re.json.applied, 0);
    assert.deepEqual(await row('history', 'hh_fake'), fake);
  });

  test('eşzamanlı oluşturma: aynı kimlikli ikinci geçmiş/yorum ilk yazanın kaydını ezmez', async () => {
    for (const [table, mk] of [['history', id => H(id, { issueId: 'ih1', to: 'ikinci', at: Date.now() })],
                               ['comments', id => C(id, { issueId: 'ih1', body: 'ikinci' })]]) {
      const id = table + '_yaris', c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO ${table} (id, data) VALUES ($1, $2::jsonb)`,
          [id, JSON.stringify({ id, issueId: 'ih1', userId: 'u_h_m', at: 1, field: 'Durum', to: 'ilk', body: 'ilk' })]);
        const pending = N.sync([mk(id)]);
        await new Promise(r => setTimeout(r, 300));
        await c.query('COMMIT');
        assert.deepEqual(reasons(await pending), ['Kayıt aynı anda oluşturuldu, yeniden deneyin'], table);
      } finally { c.release(); }
      const d = await row(table, id);
      assert.equal(d.userId, 'u_h_m', table); assert.equal(table === 'history' ? d.to : d.body, 'ilk', table);
      /* yeniden denemede kayıt var: koruma kuralları işler */
      assert.deepEqual(reasons(await N.sync([mk(id)])), [table === 'history' ? LOCKED : NOT_OWNER], table);
    }
  });

  test('izleyici geçmiş yazamaz ve silemez', async () => {
    assert.deepEqual(reasons(await V.sync([H('hh_v', { issueId: 'ih1', userId: 'u_h_v', at: Date.now() }), D('history', 'hh_dogru')])),
      ['salt okunur kullanıcı', 'salt okunur kullanıcı']);
    assert.equal(await row('history', 'hh_v'), undefined);
    assert.ok(await row('history', 'hh_dogru'));
  });

  test('metinler 200 (alan adı 100) karaktere "…" ile kırpılır; nesne değer metne çevrilir', async () => {
    const r = ok(await M.sync([H('hh_uzun', { issueId: 'ih1', at: Date.now(), field: 'F'.repeat(150), from: 'x'.repeat(250), to: ['a', 'b'], rule: 'k'.repeat(300) })]));
    const d = await row('history', 'hh_uzun');
    assert.equal(d.from.length, 200); assert.ok(d.from.endsWith('…'));
    assert.equal(d.field.length, 100); assert.ok(d.field.endsWith('…'));
    assert.equal(d.rule.length, 200);
    assert.equal(d.to, '["a","b"]');
    assert.ok(adj(r, 'history', 'hh_uzun'));
    /* Kısa metinler ve sayı/boolean/null değerler aynen kalır. */
    ok(await M.sync([H('hh_tur', { issueId: 'ih1', at: Date.now(), from: 3, to: true })]));
    const t = await row('history', 'hh_tur');
    assert.strictEqual(t.from, 3); assert.strictEqual(t.to, true);
  });

  test('iş + geçmiş + yorum silmeleri aynı istekte (dizide önce gelse de): ret yok, hepsi çöp kutusunda; geri yüklemede "Geri yükleme" satırı', async () => {
    ok(await M.sync([I('ih_sil'), C('ch_sil_n', { issueId: 'ih_sil' }), H('hh_sil', { issueId: 'ih_sil', at: Date.now() })]));
    ok(await N.sync([C('ch_sil_baska', { issueId: 'ih_sil', userId: 'u_h_n' })]));
    /* Bugünkü istemci iş silmede yorumları da siler (başkasınınki dahil); proje silmede geçmişi de. */
    const r = ok(await M.sync([D('history', 'hh_sil'), D('comments', 'ch_sil_baska'), D('comments', 'ch_sil_n'), D('issues', 'ih_sil')]));
    assert.equal(r.json.applied, 1);
    for (const [t, id] of [['issues', 'ih_sil'], ['history', 'hh_sil'], ['comments', 'ch_sil_baska']]) assert.equal(await row(t, id), undefined, id);
    const del = (await pool.query(`SELECT collection, record_id, batch_id FROM deleted_records WHERE record_id IN ('ih_sil','hh_sil','ch_sil_baska','ch_sil_n')`)).rows;
    assert.equal(del.length, 4);
    assert.equal(new Set(del.map(x => x.batch_id)).size, 1);
    const s0 = (await A.state()).json.seq;
    const it = (await A.req('GET', '/api/trash')).json.find(x => x.record_id === 'ih_sil');
    const rr = await A.req('POST', `/api/trash/${it.id}/restore`, {});
    assert.equal(rr.json.restored, 4);                                  // "Geri yükleme" satırı sayılmaz
    assert.equal((await row('history', 'hh_sil')).issueId, 'ih_sil');   // eski geçmiş geri geldi
    const hs = (await pool.query(`SELECT data FROM history WHERE issue_id='ih_sil' AND data->>'kind'='restore'`)).rows.map(x => x.data);
    assert.equal(hs.length, 1);
    assert.equal(hs[0].field, 'Geri yükleme'); assert.equal(hs[0].userId, 'u_admin');
    assert.ok(Math.abs(hs[0].at - Date.now()) < 60e3);
    const ch = (await A.req('GET', `/api/changes?since=${s0}`)).json;
    assert.ok(ch.items.some(x => x.c === 'history' && x.id === hs[0].id && x.op === 'put'), JSON.stringify(ch.items.map(x => x.c + ':' + x.id)));
  });

  test('yönetici proje silme (bugünkü istemci sırası: geçmiş/yorum silmeleri işlerden önce): ret yok', async () => {
    ok(await A.sync([
      { c: 'projects', id: 'ph2', op: 'put', data: { name: 'Silinecek', key: 'SLN', counter: 0 } },
      { c: 'statuses', id: 'ph2_a', op: 'put', data: { projectId: 'ph2', name: 'Yapılacak', cat: 'todo', ord: 0 } },
      { c: 'issues', id: 'ih_p2', op: 'put', data: { projectId: 'ph2', summary: 'x', statusId: 'ph2_a' } },
    ]));
    ok(await M.sync([H('hh_p2', { issueId: 'ih_p2', at: Date.now() }), C('ch_p2', { issueId: 'ih_p2' })]));
    ok(await A.sync([D('comments', 'ch_p2'), D('history', 'hh_p2'), D('issues', 'ih_p2'), D('statuses', 'ph2_a'), D('projects', 'ph2')]));
    for (const [t, id] of [['projects', 'ph2'], ['issues', 'ih_p2'], ['history', 'hh_p2'], ['comments', 'ch_p2']]) assert.equal(await row(t, id), undefined, id);
  });

  test('yorumlar: başkasının yorumunu üye değiştiremez/silemez (403); kendi yorumu ve yönetici serbest; yeni yorumda yazar oturum', async () => {
    let r = ok(await M.sync([C('ch_m', { issueId: 'ih1', userId: 'u_h_n', at: Date.now() })]));
    assert.equal((await row('comments', 'ch_m')).userId, 'u_h_m');
    assert.ok(adj(r, 'comments', 'ch_m'));
    r = ok(await M.sync([C('ch_m2', { issueId: 'ih1', at: Date.now() })]));               // yazarsız → oturum
    assert.equal((await row('comments', 'ch_m2')).userId, 'u_h_m');
    const cur = await row('comments', 'ch_m');
    assert.deepEqual(reasons(await N.sync([{ c: 'comments', id: 'ch_m', op: 'put', data: { ...cur, body: 'değişti' }, base: cur }])), [NOT_OWNER]);
    assert.deepEqual(reasons(await N.sync([D('comments', 'ch_m')])), [NOT_OWNER]);
    assert.deepEqual(reasons(await V.sync([D('comments', 'ch_m')])), ['salt okunur kullanıcı']);
    assert.equal((await row('comments', 'ch_m')).body, 'yorum');
    /* Kendi yorumu: düzenler; yazarı başkasına aktaramaz (sunucu korur). */
    r = ok(await M.sync([{ c: 'comments', id: 'ch_m', op: 'put', data: { ...cur, body: 'düzenlendi', userId: 'u_h_n' }, base: cur }]));
    assert.deepEqual([(await row('comments', 'ch_m')).body, (await row('comments', 'ch_m')).userId], ['düzenlendi', 'u_h_m']);
    assert.ok(adj(r, 'comments', 'ch_m'));
    /* Yönetici başkasının yorumunu düzenler ve siler; yönetici yazar muafiyeti yorumda da geçerli. */
    const c2 = await row('comments', 'ch_m');
    ok(await A.sync([{ c: 'comments', id: 'ch_m', op: 'put', data: { ...c2, body: 'yönetici düzeltti' }, base: c2 }]));
    assert.deepEqual([(await row('comments', 'ch_m')).body, (await row('comments', 'ch_m')).userId], ['yönetici düzeltti', 'u_h_m']);
    ok(await A.sync([C('ch_a', { issueId: 'ih1', userId: 'u_h_n' })]));
    assert.equal((await row('comments', 'ch_a')).userId, 'u_h_n');
    ok(await A.sync([D('comments', 'ch_m')]));
    assert.equal(await row('comments', 'ch_m'), undefined);
    /* Kendi yorumunu siler; olmayan yorumu silmek ret değildir. */
    ok(await M.sync([D('comments', 'ch_m2'), D('comments', 'ch_hic_yok')]));
    assert.equal(await row('comments', 'ch_m2'), undefined);
  });

  test('geçmiş: bilinmeyen anahtarlar atılır, 2 KB sınırı, üye "restore" türü yazamaz', async () => {
    let r = ok(await M.sync([H('hh_ek', { issueId: 'ih1', at: Date.now(), body: 'x'.repeat(5000), extra: { a: 1 }, kind: 'edit' })]));
    assert.deepEqual(Object.keys(await row('history', 'hh_ek')).sort(), ['at', 'field', 'from', 'id', 'issueId', 'kind', 'to', 'userId']);
    assert.ok(adj(r, 'history', 'hh_ek'));
    /* Alanlar kırpılsa da toplam 2 KB'ı aşan kayıt (uzun kimlikler) reddedilir. */
    assert.deepEqual(reasons(await A.sync([H('hh_buyuk', { issueId: 'ih1', userId: 'u'.repeat(200), key: 'k'.repeat(200), rule: 'r'.repeat(200),
      field: 'f'.repeat(100), from: '€'.repeat(200), to: '€'.repeat(200), kind: '€'.repeat(200) })])), ['Geçmiş kaydı çok büyük']);
    assert.equal(await row('history', 'hh_buyuk'), undefined);
    r = ok(await M.sync([H('hh_rst', { issueId: 'ih1', at: Date.now(), field: 'Geri yükleme', kind: 'restore' })]));
    assert.equal((await row('history', 'hh_rst')).kind, undefined);
    assert.ok(adj(r, 'history', 'hh_rst'));
    ok(await A.sync([H('hh_rst_a', { issueId: 'ih1', field: 'Geri yükleme', kind: 'restore' })]));
    assert.equal((await row('history', 'hh_rst_a')).kind, 'restore');
  });

  test('yorum: işi var olmalı (aynı gönderimdeki yeni iş dahil); yazarı olmayan eski yorumu yalnız yönetici değiştirir/siler', async () => {
    assert.deepEqual(reasons(await M.sync([C('ch_yetim', { issueId: 'i_yok_c' })])), ['Yorumun işi bulunamadı']);
    assert.deepEqual(reasons(await A.sync([C('ch_yetim', { issueId: 'i_yok_c' })])), ['Yorumun işi bulunamadı']);
    assert.equal(await row('comments', 'ch_yetim'), undefined);
    ok(await M.sync([C('ch_yeniis', { issueId: 'ih_yorum' }), I('ih_yorum')]));
    await pool.query(`INSERT INTO comments (id, data) VALUES ('ch_eski', '{"id":"ch_eski","issueId":"ih1","body":"eski"}')`);
    const cur = await row('comments', 'ch_eski');
    assert.deepEqual(reasons(await M.sync([{ c: 'comments', id: 'ch_eski', op: 'put', data: { ...cur, body: 'x' }, base: cur }])), [NOT_OWNER]);
    assert.deepEqual(reasons(await M.sync([D('comments', 'ch_eski')])), [NOT_OWNER]);
    ok(await A.sync([{ c: 'comments', id: 'ch_eski', op: 'put', data: { ...cur, body: 'yönetici' }, base: cur }]));
    assert.equal((await row('comments', 'ch_eski')).userId, undefined);
    ok(await A.sync([D('comments', 'ch_eski')]));
    assert.equal(await row('comments', 'ch_eski'), undefined);
  });

  test('içe aktarma (replaceAll) eski, uzun, yazarsız, zamansız geçmişi atlamaz; metinleri kırpar', async () => {
    const before = (await A.state()).json.data;
    const data = {
      projects: [{ id: 'pz', key: 'ESK', name: 'Eski', counter: 1 }],
      issues: [{ id: 'iz1', projectId: 'pz', key: 'ESK-1', summary: 'eski' }],
      history: [
        { id: 'hz_yazarsiz', issueId: 'iz1', field: 'Durum', from: 'A', to: 'B' },
        { id: 'hz_uzun', issueId: 'iz1', userId: 'u_admin', at: '2019-01-01T00:00:00Z', field: 'Özet', from: 'u'.repeat(5000), to: { eski: 1 } },
        { id: 'hz_issiz', field: 'Durum', from: 1, to: 2, at: 12 },
        { id: 'hz_alan', issueId: 'iz1', userId: 7, field: 'A'.repeat(300), from: null, to: false },
      ],
      comments: [{ id: 'cz_yetim', issueId: 'iz_yok', body: 'işi silinmiş eski yorum' }],
    };
    const r = await A.req('POST', '/api/import', { data });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.history, 4);
    assert.equal(r.json.comments, 1);                                    // yorumun işi içe aktarmada denetlenmez
    assert.ok(!r.json.skipped, JSON.stringify(r.json));
    const u = await row('history', 'hz_uzun');
    assert.equal(u.from.length, 200); assert.ok(u.from.endsWith('…')); assert.equal(u.to, '{"eski":1}');
    assert.equal((await row('history', 'hz_alan')).field.length, 100);
    assert.equal((await row('history', 'hz_yazarsiz')).userId, undefined);
    const pre = (await A.req('GET', '/api/backups')).json.find(b => b.kind === 'pre-import');
    assert.equal((await A.req('POST', `/api/backups/${pre.id}/restore`, {})).status, 200);
    const after = (await A.state()).json.data;
    assert.equal(after.history.length, before.history.length);           // geri yükleme de geçmişi atlamadı
    assert.equal(after.comments.length, before.comments.length);
  });
});

/* ---------------- talep eden ve hızlı kişi ekleme (görev 12, E1) ----------------
   Test verileri uydurmadır. */
describe('talep eden', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const reasons = r => r.json.rejected.map(x => x.reason);
  const ok = r => { assert.equal(r.status, 200); assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected)); };
  const rejectedWith = (r, msg) => { assert.equal(r.status, 200); assert.equal(r.json.applied, 0); assert.deepEqual(reasons(r), [msg]); };
  const row = async (table, id) => (await pool.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
  let A, U, V;
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'TlpYeni123456' })).status, 200);
    return k;
  };
  const iss = (id, data) => ({ c: 'issues', id, op: 'put', data: { projectId: 'p_tl', statusId: 'p_tl_s0', summary: 'Talep', ...data } });
  const R = (customerId, contactId) => ({ customerId, contactId });

  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    U = await newUser('u_tl1', 'tluye', 'member');
    V = await newUser('u_tlv', 'tlizci', 'viewer');
    ok(await A.sync([
      { c: 'customers', id: 'c_tl1', op: 'put', data: { name: 'Talep Bir A.Ş.', kind: 'customer', contacts: [{ id: 'ct_a', name: 'Ayşe Örnek', email: 'ayse@ornek.test' }] } },
      { c: 'customers', id: 'c_tl2', op: 'put', data: { name: 'Talep İki Ltd.', kind: 'customer', contacts: [{ id: 'ct_b', name: 'Bora Örnek' }] } },
      { c: 'customers', id: 'c_tlp', op: 'put', data: { name: 'Pasif Ltd.', kind: 'customer', active: false, contacts: [{ id: 'ct_p', name: 'Pasif Kişi' }] } },
      { c: 'projects', id: 'p_tl', op: 'put', data: { name: 'Destek', key: 'DST', counter: 0, workspaceId: 'ws1', template: 'talep' } },
      { c: 'projects', id: 'p_tg', op: 'put', data: { name: 'Genel iş', key: 'TGN', counter: 0, workspaceId: 'ws1', customerId: 'c_tl1' } },
      { c: 'statuses', id: 'p_tl_s0', op: 'put', data: { projectId: 'p_tl', name: 'Yeni', cat: 'todo', ord: 0 } },
      { c: 'statuses', id: 'p_tg_s0', op: 'put', data: { projectId: 'p_tg', name: 'Yapılacak', cat: 'todo', ord: 0 } },
    ]));
  });

  test('talep projesinde talep edensiz yeni iş 400 "Talep eden gerekli"; geçerli kişiyle kabul', async () => {
    rejectedWith(await U.sync([iss('i_tl1', { key: 'DST-1' })]), 'Talep eden gerekli');
    rejectedWith(await U.sync([iss('i_tl1', { key: 'DST-1', requester: null })]), 'Talep eden gerekli');
    ok(await U.sync([iss('i_tl1', { key: 'DST-1', requester: R('c_tl1', 'ct_a') })]));
    assert.deepEqual((await row('issues', 'i_tl1')).data.requester, R('c_tl1', 'ct_a'));
    /* var olan işte talep edeni boşaltmak da reddedilir */
    rejectedWith(await U.sync([iss('i_tl1', { key: 'DST-1', requester: null })]), 'Talep eden gerekli');
  });

  test('başka carinin kişisi, pasif cari, olmayan cari ve biçimsiz değer reddedilir', async () => {
    rejectedWith(await U.sync([iss('i_tl2', { key: 'DST-2', requester: R('c_tl1', 'ct_b') })]), 'Talep eden kişi bu caride bulunamadı');
    rejectedWith(await U.sync([iss('i_tl2', { key: 'DST-2', requester: R('c_tlp', 'ct_p') })]), 'Pasif carinin kişisi talep eden olamaz');
    rejectedWith(await U.sync([iss('i_tl2', { key: 'DST-2', requester: R('c_yok', 'ct_a') })]), 'Talep edenin carisi bulunamadı');
    rejectedWith(await U.sync([iss('i_tl2', { key: 'DST-2', requester: { customerId: '<x>', contactId: 'ct_a' } })]), 'Talep eden geçersiz');
    rejectedWith(await U.sync([iss('i_tl2', { key: 'DST-2', requester: 'ct_a' })]), 'Talep eden geçersiz');
    assert.equal(await row('issues', 'i_tl2'), undefined);
  });

  test('eski talep edensiz iş düzenlenebilir; değişmeyen eski bağ (pasifleşen cari, silinen kişi) korunur', async () => {
    await pool.query(`INSERT INTO issues (id, data) VALUES ('i_tlold', '{"id":"i_tlold","projectId":"p_tl","statusId":"p_tl_s0","key":"DST-50","summary":"Eski"}')`);
    const cur = (await row('issues', 'i_tlold')).data;
    ok(await U.sync([{ c: 'issues', id: 'i_tlold', op: 'put', data: { ...cur, summary: 'Eski (başlık)' }, base: cur }]));
    assert.equal((await row('issues', 'i_tlold')).data.summary, 'Eski (başlık)');
    /* i_tl1'in carisi pasife alınır ve kişisi silinir: başlık yine değişir */
    const c1 = (await row('customers', 'c_tl1')).data;
    ok(await A.sync([{ c: 'customers', id: 'c_tl1', op: 'put', data: { ...c1, active: false, contacts: [] }, base: c1 }]));
    const i1 = (await row('issues', 'i_tl1')).data;
    ok(await U.sync([{ c: 'issues', id: 'i_tl1', op: 'put', data: { ...i1, summary: 'Yeni başlık' }, base: i1 }]));
    assert.deepEqual((await row('issues', 'i_tl1')).data.requester, R('c_tl1', 'ct_a'));
    const c1b = (await row('customers', 'c_tl1')).data;
    ok(await A.sync([{ c: 'customers', id: 'c_tl1', op: 'put', data: c1, base: c1b }]));
  });

  test('cari bağlı diğer projede talep eden isteğe bağlı; verilirse denetlenir', async () => {
    const g = d => ({ c: 'issues', id: 'i_tg1', op: 'put', data: { projectId: 'p_tg', statusId: 'p_tg_s0', key: 'TGN-1', summary: 'Genel', ...d } });
    ok(await U.sync([g({})]));
    rejectedWith(await U.sync([g({ requester: R('c_tl2', 'ct_x') })]), 'Talep eden kişi bu caride bulunamadı');
    ok(await U.sync([g({ requester: R('c_tl2', 'ct_b') })]));
    ok(await U.sync([g({ requester: null })]));
  });

  test('hızlı kişi ekleme: yalnız sistem yöneticisi ekler (yalnız ad/e-posta/telefon), üye ve izleyici 403, değişiklik akışına düşer', async () => {
    const s0 = (await U.state()).json.seq;
    const den = await U.req('POST', '/api/customers/c_tl2/contacts', { name: 'Üye denemesi' });
    assert.equal(den.status, 403); assert.equal(den.json.error, 'Kişi eklemeyi yalnızca yönetici yapabilir');
    const r = await A.req('POST', '/api/customers/c_tl2/contacts',
      { name: '  Cem Yeni  ', email: 'cem@ornek.test', phone: '0212 000 00 00', title: 'Müdür', id: 'ct_zorla' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ct = r.json.contact;
    assert.equal(ct.name, 'Cem Yeni'); assert.equal(ct.email, 'cem@ornek.test'); assert.equal(ct.title, undefined);
    assert.notEqual(ct.id, 'ct_zorla'); assert.match(ct.id, /^ct_[a-f0-9]{16}$/);
    const d = (await row('customers', 'c_tl2')).data;
    assert.equal(d.name, 'Talep İki Ltd.');
    assert.deepEqual(d.contacts.map(x => x.id), ['ct_b', ct.id]);
    const ch = (await U.req('GET', '/api/changes?since=' + s0)).json;
    assert.ok(ch.items.some(i => i.c === 'customers' && i.id === 'c_tl2' && i.op === 'put' && i.data.contacts.length === 2));
    /* yeni kişi hemen talep eden olabilir */
    ok(await U.sync([iss('i_tl3', { key: 'DST-3', requester: R('c_tl2', ct.id) })]));
    /* yalnız bu uç: üye cari kaydının kendisini (unvan) yine değiştiremez */
    rejectedWith(await U.sync([{ c: 'customers', id: 'c_tl2', op: 'put', data: { ...d, name: 'Değişti' }, base: d }]), 'Bu değişiklik için yönetici yetkisi gerekli');

    assert.equal((await V.req('POST', '/api/customers/c_tl2/contacts', { name: 'İzci' })).status, 403);
    assert.equal((await A.req('POST', '/api/customers/c_tl2/contacts', { name: '   ' })).status, 400);
    assert.equal((await A.req('POST', '/api/customers/c_tl2/contacts', { name: 'x'.repeat(121) })).status, 400);
    assert.equal((await A.req('POST', '/api/customers/c_tl2/contacts', { name: 'Kötü', email: 'yok' })).status, 400);
    const nf = await A.req('POST', '/api/customers/c_yok/contacts', { name: 'Kimse' });
    assert.equal(nf.status, 404); assert.match(nf.json.error, /Yöneticinize cari ekletin/);
    assert.equal((await A.req('POST', '/api/customers/c_tlp/contacts', { name: 'Pasife' })).status, 400);
    assert.equal((await A.req('POST', '/api/customers/c_tl2/contacts', { name: 'CSRF' }, { 'x-pano': '' })).status, 403);
    assert.equal((await client().req('POST', '/api/customers/c_tl2/contacts', { name: 'Anonim' })).status, 401);
    assert.equal((await row('customers', 'c_tl2')).data.contacts.length, 2);
  });
});

/* ---------------- müşteri atamaları cariden (görev 11b) ----------------
   005 geçişi: eski "Müşteri" seçim alanının değerleri cariye dönüşür, işler bağlanır, alan gizlenir. */
describe('müşteri → cari (005)', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const del = (c, id) => ({ c, id, op: 'del' });
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  const reasons = r => r.json.rejected.map(x => x.reason);
  const ok = r => { assert.equal(r.status, 200); assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected)); };
  const rejectedWith = (r, msg) => { assert.equal(r.status, 200); assert.equal(r.json.applied, 0, JSON.stringify(r.json)); assert.deepEqual(reasons(r), [msg]); };
  const KEYS = { i_mi1: 'GEN-9101', i_mk1: 'GEN-9102', i_mk2: 'GEN-9103', i_mk3: 'GEN-9104' };
  const iss = (id, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: 'p1', key: KEYS[id], summary: 'Cari işi ' + id, statusId: 'p1_s0', ...extra } });
  const readRel = async p => (await import('node:fs/promises')).readFile(new globalThis.URL(p, import.meta.url), 'utf8');
  const rerun = async () => {
    const sql = await readRel('../server/migrations/005_musteri_cari.sql');
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); } finally { c.release(); }
  };
  const maxSeq = async () => Number((await pool.query('SELECT max(seq) m FROM changes')).rows[0].m);
  let A, U;
  before(async () => {
    A = client(); await A.login('admin', 'test-admin-pw');
    await A.sync([{ c: 'users', id: 'u_mc1', op: 'put', data: { username: 'mcuye', name: 'mcuye', role: 'member', active: true } }]);
    U = client(); await U.login('mcuye', 'Start12345');
    assert.equal((await U.req('POST', '/api/auth/password', { newPassword: 'McYeni123456' })).status, 200);
  });

  test('geçiş: demo verisi (Müşteri alanı) → cariler, işler bağlanır, alan gizlenir; tekrar çalıştırınca çift cari yok', async () => {
    const demo = JSON.parse(await readRel('./fixtures/demo.json'));
    /* eski yedek gibi doğrudan tablolara: alan + işler (kimlikler önekli, başka testlerle çakışmasın) */
    const f = demo.fields.find(x => x.key === 'musteri');
    await pool.query('INSERT INTO fields (id, data) VALUES ($1, $2::jsonb)', ['mc_' + f.id, JSON.stringify({ ...f, id: 'mc_' + f.id })]);
    const issues = demo.issues.map(i => ({ ...i, id: 'mc_' + i.id, projectId: 'p_mcdemo',
      cf: Object.fromEntries(Object.entries(i.cf || {}).map(([k, v]) => ['mc_' + k, v])) }));
    /* yazım farkları: boşluk + büyük/küçük harf aynı cari; önceden bağlı iş değişmez */
    issues[0].cf.mc_cf_mus = '  acme ';
    issues[1].cf.mc_cf_mus = 'GLOBEX';
    const pre = issues.find(i => !i.cf.mc_cf_mus); pre.cf.mc_cf_mus = 'Initech'; pre.customerId = 'c_mc_pre';
    for (const i of issues) await pool.query('INSERT INTO issues (id, data) VALUES ($1, $2::jsonb)', [i.id, JSON.stringify(i)]);
    /* "Acme" adlı cari zaten var (farklı yazımla) → yenisi açılmaz, ona bağlanır */
    ok(await A.sync([{ c: 'customers', id: 'c_mc_acme', op: 'put', data: { name: 'ACME', kind: 'customer' } },
      { c: 'customers', id: 'c_mc_pre', op: 'put', data: { name: 'Önceden', kind: 'customer' } }]));
    const seq0 = await maxSeq();
    await rerun();
    const byVal = v => issues.filter(i => i !== pre && String(i.cf.mc_cf_mus || '').trim().toLowerCase() === v);
    const glob = (await pool.query(`SELECT id, data FROM customers WHERE lower(name)='globex'`)).rows;
    assert.equal(glob.length, 1);
    assert.match(glob[0].id, /^cu_m_[0-9a-f]{32}$/);
    assert.deepEqual(glob[0].data, { id: glob[0].id, name: 'Globex', kind: 'customer', active: true, contacts: [] });   // en sık yazım
    assert.ok(byVal('acme').length >= 9 && byVal('globex').length >= 8);
    for (const i of byVal('acme')) assert.equal((await row('issues', i.id)).customerId, 'c_mc_acme');
    for (const i of byVal('globex')) assert.equal((await row('issues', i.id)).customerId, glob[0].id);
    assert.equal((await row('issues', pre.id)).customerId, 'c_mc_pre');                           // dolu olan değişmez
    assert.equal((await pool.query(`SELECT count(*) n FROM customers WHERE lower(name) IN ('acme','initech')`)).rows[0].n, '1');
    for (const i of issues.filter(x => !x.cf.mc_cf_mus)) assert.equal((await row('issues', i.id)).customerId, undefined);
    assert.equal((await row('issues', issues[0].id)).cf.mc_cf_mus, '  acme ');                     // değerler yerinde
    const fd = await row('fields', 'mc_cf_mus');
    assert.equal(fd.archived, true); assert.equal(fd.hidden, true); assert.deepEqual(fd.options, f.options);
    const ch = (await pool.query('SELECT collection, count(*)::int n FROM changes WHERE seq > $1 GROUP BY 1', [seq0])).rows;
    const n = Object.fromEntries(ch.map(r => [r.collection, r.n]));
    assert.equal(n.customers, 1); assert.equal(n.fields, 1);
    assert.equal(n.issues, byVal('acme').length + byVal('globex').length);
    assert.ok((await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname='issues_customer_idx'`)).rowCount);
    /* tekrar: hiçbir şey değişmez */
    const seq1 = await maxSeq();
    const cnt = (await pool.query('SELECT count(*) n FROM customers')).rows[0].n;
    await rerun();
    assert.equal((await pool.query('SELECT count(*) n FROM customers')).rows[0].n, cnt);
    assert.equal(await maxSeq(), seq1);
    /* yeni gelen eski biçimli iş (ör. eski sürümden) sonraki çalıştırmada var olan cariye bağlanır */
    await pool.query('INSERT INTO issues (id, data) VALUES ($1, $2::jsonb)', ['mc_new', JSON.stringify({ id: 'mc_new', projectId: 'p_mcdemo', summary: 'x', cf: { mc_cf_mus: 'Globex' } })]);
    await rerun();
    assert.equal((await row('issues', 'mc_new')).customerId, glob[0].id);
    assert.equal((await pool.query('SELECT count(*) n FROM customers')).rows[0].n, cnt);
    /* geçiş kaydı: migrate() 005'i bir kez uygular */
    await pool.query(`DELETE FROM schema_migrations WHERE id='005_musteri_cari.sql'`);
    await migrate(pool);
    assert.equal((await pool.query(`SELECT count(*) n FROM schema_migrations WHERE id='005_musteri_cari.sql'`)).rows[0].n, '1');
    /* istemciye alan gizli işaretiyle gider */
    assert.equal((await A.state()).json.data.fields.find(x => x.id === 'mc_cf_mus').hidden, true);
    await pool.query(`DELETE FROM issues WHERE id LIKE 'mc\\_%'`);
    await pool.query(`DELETE FROM fields WHERE id='mc_cf_mus'`);
  });

  test('iş customerId: biçim, var olan ve etkin cari; değişmeyen pasif bağ korunur; kaldırma serbest', async () => {
    ok(await A.sync([{ c: 'customers', id: 'c_mi1', op: 'put', data: { name: 'İş Carisi', kind: 'customer' } },
      { c: 'customers', id: 'c_mi2', op: 'put', data: { name: 'Pasif İş Carisi', kind: 'customer', active: false } }]));
    for (const bad of [7, { x: 1 }, '<b>', 'a b']) rejectedWith(await U.sync([iss('i_mi1', { customerId: bad })]), 'Geçersiz cari');
    rejectedWith(await U.sync([iss('i_mi1', { customerId: 'c_yok' })]), 'Cari bulunamadı');
    rejectedWith(await U.sync([iss('i_mi1', { customerId: 'c_mi2' })]), 'Pasif cari işe bağlanamaz');
    ok(await U.sync([iss('i_mi1', { customerId: 'c_mi1' })]));                        // üye de bağlar
    assert.equal((await row('issues', 'i_mi1')).customerId, 'c_mi1');
    assert.equal((await pool.query(`SELECT customer_id FROM issues WHERE id='i_mi1'`)).rows[0].customer_id, 'c_mi1');
    ok(await A.sync([{ c: 'customers', id: 'c_mi1', op: 'put', data: { name: 'İş Carisi', kind: 'customer', active: false } }]));
    ok(await U.sync([iss('i_mi1', { customerId: 'c_mi1', summary: 'değişti' })]));   // pasif bağ korunur
    rejectedWith(await A.sync([del('customers', 'c_mi1')]), 'Bu cariye bağlı 1 iş var; silmek yerine pasife alın');
    ok(await U.sync([iss('i_mi1', { customerId: '' })]));
    ok(await U.sync([iss('i_mi1', { customerId: null })]));
    rejectedWith(await U.sync([iss('i_mi1', { customerId: 'c_mi1' })]), 'Pasif cari işe bağlanamaz');
    ok(await A.sync([del('issues', 'i_mi1'), del('customers', 'c_mi1'), del('customers', 'c_mi2')]));
  });

  test('birleştir: proje + iş bağları ve kişiler hedefe, kaynak silinir; tek değişiklik, yalnız yönetici', async () => {
    ok(await A.sync([
      { c: 'customers', id: 'c_mk', op: 'put', data: { name: 'Kaynak Ltd', kind: 'customer', contacts: [{ id: 'k1', name: 'Ali' }, { id: 'k2', name: 'Veli' }] } },
      { c: 'customers', id: 'c_mh', op: 'put', data: { name: 'Hedef A.Ş.', kind: 'customer', contacts: [{ id: 'k1', name: 'Ayşe' }] } },
      { c: 'customers', id: 'c_mp', op: 'put', data: { name: 'Pasif Hedef', kind: 'customer', active: false } },
      { c: 'projects', id: 'p_mk1', op: 'put', data: { name: 'Birleşme 1', key: 'MKA', counter: 0, workspaceId: 'ws1', customerId: 'c_mk' } },
      { c: 'projects', id: 'p_mk2', op: 'put', data: { name: 'Birleşme 2', key: 'MKB', counter: 0, workspaceId: 'ws1', customerId: 'c_mk', archived: true } },
      iss('i_mk1', { customerId: 'c_mk' }), iss('i_mk2', { customerId: 'c_mk' }), iss('i_mk3', { customerId: 'c_mh' })]));
    const mrg = to => ({ c: 'customers', id: 'c_mk', op: 'del', mergeInto: to });
    rejectedWith(await U.sync([mrg('c_mh')]), 'Bu değişiklik için yönetici yetkisi gerekli');
    rejectedWith(await A.sync([mrg('c_mp')]), 'Pasif cariye birleştirilemez');
    rejectedWith(await A.sync([mrg('c_mk')]), 'Birleştirilecek cari geçersiz');
    rejectedWith(await A.sync([mrg('c_yok')]), 'Cari bulunamadı');
    rejectedWith(await A.sync([mrg(5)]), 'Birleştirilecek cari geçersiz');
    assert.equal((await row('issues', 'i_mk1')).customerId, 'c_mk');                       // reddedilen birleştirme hiçbir şey yazmaz
    assert.equal((await row('projects', 'p_mk1')).customerId, 'c_mk');
    const seq0 = await maxSeq();
    const r = await A.sync([mrg('c_mh')]);
    ok(r); assert.equal(r.json.applied, 1);
    assert.equal(await row('customers', 'c_mk'), undefined);
    for (const id of ['p_mk1', 'p_mk2']) assert.equal((await row('projects', id)).customerId, 'c_mh');
    for (const id of ['i_mk1', 'i_mk2', 'i_mk3']) assert.equal((await row('issues', id)).customerId, 'c_mh');
    assert.equal((await row('projects', 'p_mk2')).archived, true);
    assert.deepEqual((await row('customers', 'c_mh')).contacts, [{ id: 'k1', name: 'Ayşe' }, { id: 'k1_2', name: 'Ali' }, { id: 'k2', name: 'Veli' }]);
    const ch = (await pool.query('SELECT collection, record_id, op FROM changes WHERE seq > $1', [seq0])).rows.map(x => `${x.collection}:${x.record_id}:${x.op}`);
    assert.deepEqual(ch.sort(), ['customers:c_mh:put', 'customers:c_mk:del', 'issues:i_mk1:put', 'issues:i_mk2:put', 'projects:p_mk1:put', 'projects:p_mk2:put'].sort());
    assert.equal((await A.sync([mrg('c_mh')])).json.applied, 0);                             // kaynak yok: etkisiz
    ok(await A.sync([del('issues', 'i_mk1'), del('issues', 'i_mk2'), del('issues', 'i_mk3'), del('projects', 'p_mk1'), del('projects', 'p_mk2')]));
    ok(await A.sync([del('customers', 'c_mh'), del('customers', 'c_mp')]));
  });
});

/* ---- Posta kutuları (görev 11, E2): sağlayıcı fetch'i taklit edilir; gerçek ağ isteği yok ---- */
describe('posta kutuları', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  let mail, A, U, V, adminCookie;
  const ENV = ['MAIL_TOKEN_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT', 'MAIL_ENABLED', 'MAIL_POLL_SEC'];
  const saved = {};
  const calls = [], seenBodies = [];
  const routes = [];                      // [regex(origin+path), fn(url, opt) → Response]; en son eklenen önce
  const J = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const route = (re, fn) => { routes.unshift([re, fn]); };
  const configure = () => {
    process.env.MAIL_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.GOOGLE_CLIENT_ID = 'g-istemci'; process.env.GOOGLE_CLIENT_SECRET = 'g-sir';
    process.env.MS_CLIENT_ID = 'm-istemci'; process.env.MS_CLIENT_SECRET = 'm-sir'; process.env.MS_TENANT = 'common';
    process.env.MAIL_ENABLED = 'true';
  };
  const unconfigure = () => { for (const k of ENV) delete process.env[k]; };
  /* Ham istek (yönlendirme izlenmez): OAuth başlangıç / dönüş için. */
  const raw = async (path, cookie) => {
    const r = await fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    return { status: r.status, location: r.headers.get('location') || '' };
  };
  const loginCookie = async (u, p) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'x-pano': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    return r.headers.get('set-cookie').split(';')[0];
  };
  const track = r => { seenBodies.push(JSON.stringify(r.json)); return r; };
  const newUser = async (id, username, role) => {
    await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]);
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'PostaYeni12345' })).status, 200);
    return k;
  };
  const enc64 = s => Buffer.from(s, 'utf8').toString('base64url');
  const gm = (id, h, { text, html, files = 0, labels = ['INBOX'] } = {}) => ({
    id, labelIds: labels, internalDate: String(Date.now()),
    payload: { mimeType: 'multipart/mixed', headers: Object.entries(h).map(([name, value]) => ({ name, value })), parts: [
      text != null && { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }], body: { data: enc64(text) } },
      html != null && { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { data: enc64(html) } },
      ...Array.from({ length: files }, (_, i) => ({ mimeType: 'application/pdf', filename: `ek${i}.pdf`, body: { attachmentId: 'at' + i } })),
    ].filter(Boolean) } });
  const inbox = new Map();                 // Gmail kimliği → ileti
  const issuesOf = async pid => (await pool.query(`SELECT data FROM issues WHERE project_id=$1 ORDER BY created_at, id`, [pid])).rows.map(r => r.data);
  const acct = async addr => (await pool.query('SELECT * FROM mail_accounts WHERE lower(address)=lower($1)', [addr])).rows[0];
  const poll = async id => track(await A.req('POST', `/api/mail/accounts/${id}/poll`));

  before(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    unconfigure();
    mail = await import('../server/mail.js');
    mail.setMailFetch(async (url, opt = {}) => {
      const u = new globalThis.URL(url); calls.push({ url: u.toString(), method: opt.method || 'GET', body: opt.body || '' });
      for (const [re, fn] of routes) if (re.test(u.origin + u.pathname)) return fn(u, opt);
      return J(404, { error: 'bulunamadı' });
    });
    A = client(); await A.login('admin', 'test-admin-pw');
    adminCookie = await loginCookie('admin', 'test-admin-pw');
    U = await newUser('u_pm1', 'postauye', 'member');
    V = await newUser('u_pmv', 'postaizci', 'viewer');
    const ok = r => assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected));
    ok(await A.sync([
      { c: 'customers', id: 'c_pm1', op: 'put', data: { name: 'Posta Müşteri A.Ş.', kind: 'customer', contacts: [{ id: 'ct_pm', name: 'Ayşe Posta', email: 'Ayse@Musteri.test' }] } },
      { c: 'projects', id: 'p_mx', op: 'put', data: { name: 'Destek posta', key: 'PST', counter: 0, workspaceId: 'ws1', template: 'talep' } },
      { c: 'projects', id: 'p_my', op: 'put', data: { name: 'Muhasebe', key: 'MHS', counter: 0, workspaceId: 'ws1' } },
      ...[['Yeni', 'todo'], ['İnceleniyor', 'inprogress'], ['Talep edenden yanıt bekleniyor', 'inprogress'], ['Çözüldü', 'done']].map(([n, c], i) =>
        ({ c: 'statuses', id: `p_mx_s${i}`, op: 'put', data: { projectId: 'p_mx', name: n, cat: c, ord: i } })),
      { c: 'statuses', id: 'p_my_s0', op: 'put', data: { projectId: 'p_my', name: 'Yapılacak', cat: 'todo', ord: 0 } },
    ]));
  });
  after(() => { mail?.setMailFetch(null); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('yapılandırma yoksa özellik kapalı: "Sunucu yapılandırılmamış"', async () => {
    const s = track(await A.req('GET', '/api/mail/status'));
    assert.equal(s.status, 200);
    assert.equal(s.json.configured, false); assert.equal(s.json.polling, false);
    const r = await A.req('GET', '/api/mail/oauth/google/start');
    assert.equal(r.status, 409); assert.equal(r.json.error, 'Sunucu yapılandırılmamış');
    /* anahtar var ama 32 bayt değil → yine kapalı */
    process.env.MAIL_TOKEN_KEY = Buffer.alloc(16).toString('base64'); process.env.GOOGLE_CLIENT_ID = 'x'; process.env.GOOGLE_CLIENT_SECRET = 'y';
    assert.equal((await A.req('GET', '/api/mail/status')).json.configured, false);
    unconfigure();
    assert.equal(calls.length, 0);
  });

  test('izleyici ve üye posta uçlarına 403; oturumsuz 401', async () => {
    configure();
    for (const k of [U, V]) {
      assert.equal((await k.req('GET', '/api/mail/status')).status, 403);
      assert.equal((await k.req('GET', '/api/mail/oauth/google/start')).status, 403);
      assert.equal((await k.req('POST', '/api/mail/rules', { rules: [] })).status, 403);
      assert.equal((await k.req('POST', '/api/mail/accounts/mb_x', { active: false })).status, 403);
      assert.equal((await k.req('POST', '/api/mail/accounts/mb_x/delete')).status, 403);
      assert.equal((await k.req('POST', '/api/mail/accounts/mb_x/poll')).status, 403);
    }
    assert.equal((await client().req('GET', '/api/mail/status')).status, 401);
    /* üye dönüş adresine gelirse bağlanmaz */
    const uc = await loginCookie('postauye', 'PostaYeni12345');
    assert.match((await raw('/api/mail/oauth/google/callback?state=x&code=y', uc)).location, /posta=hata&neden=yetki/);
    assert.equal((await A.req('POST', '/api/mail/rules', { rules: [] }, { 'x-pano': '' })).status, 403);   // CSRF
  });

  test('OAuth (Google): state + PKCE, kapsamlar; tek kullanımlık state; jeton şifreli', async () => {
    configure();
    let challenge = '';
    route(/oauth2\.googleapis\.com\/token$/, async (_u, opt) => {
      const f = new URLSearchParams(opt.body);
      if (f.get('grant_type') === 'authorization_code') {
        const { createHash } = await import('node:crypto');
        if (createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== challenge || f.get('code') !== 'kod-1')
          return J(400, { error: 'invalid_grant' });
        return J(200, { access_token: 'tok_ERISIM_g1', refresh_token: 'tok_YENILEME_g1', expires_in: 3600 });
      }
      return J(200, { access_token: 'tok_ERISIM_g2', expires_in: 3600 });
    });
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile$/, () => J(200, { emailAddress: 'destek@sirket.test', historyId: '100' }));

    const st = await raw('/api/mail/oauth/google/start', adminCookie);
    assert.equal(st.status, 302);
    const L = new globalThis.URL(st.location);
    assert.equal(L.origin + L.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    const q = L.searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256'); assert.equal(q.get('access_type'), 'offline'); assert.equal(q.get('prompt'), 'consent');
    for (const sc of ['gmail.readonly', 'gmail.send', 'openid', 'email']) assert.ok(q.get('scope').includes(sc), sc);
    assert.match(q.get('redirect_uri'), /\/api\/mail\/oauth\/google\/callback$/);
    assert.ok(q.get('state').length >= 30);
    challenge = q.get('code_challenge');

    /* sahte state; başka sağlayıcının dönüşü (state'i tüketir) */
    assert.match((await raw('/api/mail/oauth/google/callback?state=sahte&code=kod-1', adminCookie)).location, /neden=state/);
    assert.match((await raw(`/api/mail/oauth/microsoft/callback?state=${q.get('state')}&code=kod-1`, adminCookie)).location, /neden=state/);
    assert.match((await raw(`/api/mail/oauth/google/callback?state=${q.get('state')}&code=kod-1`, adminCookie)).location, /neden=state/);
    const st2 = new globalThis.URL((await raw('/api/mail/oauth/google/start', adminCookie)).location).searchParams;
    challenge = st2.get('code_challenge');
    /* oturumsuz dönüş bağlanmaz */
    assert.match((await raw(`/api/mail/oauth/google/callback?state=${st2.get('state')}&code=kod-1`, '')).location, /neden=oturum/);
    /* yanlış kod (PKCE/kod doğrulaması sağlayıcıda başarısız) */
    const st3 = new globalThis.URL((await raw('/api/mail/oauth/google/start', adminCookie)).location).searchParams;
    assert.match((await raw(`/api/mail/oauth/google/callback?state=${st3.get('state')}&code=baska`, adminCookie)).location, /neden=saglayici/);
    const ok = await raw(`/api/mail/oauth/google/callback?state=${st2.get('state')}&code=kod-1`, adminCookie);
    assert.equal(ok.location, '/?posta=bagli#system');
    /* aynı state ikinci kez → reddedilir */
    assert.match((await raw(`/api/mail/oauth/google/callback?state=${st2.get('state')}&code=kod-1`, adminCookie)).location, /neden=state/);

    const a = await acct('destek@sirket.test');
    assert.equal(a.provider, 'google'); assert.equal(a.cursor, '100'); assert.equal(a.status, 'ok');
    assert.match(a.refresh_token_enc, /^v1:/);
    assert.ok(!a.refresh_token_enc.includes('YENILEME') && !a.access_token_enc.includes('ERISIM'));
    assert.equal(mail.decrypt(a.refresh_token_enc), 'tok_YENILEME_g1');
    const s = track(await A.req('GET', '/api/mail/status'));
    assert.equal(s.json.configured, true); assert.equal(s.json.accounts.length, 1);
    assert.deepEqual(Object.keys(s.json.accounts[0]).sort(), ['active', 'address', 'backoffUntil', 'createdAt', 'defaultProjectId', 'id', 'lastError', 'lastPollAt', 'provider', 'status']);
    /* durum / dışa aktarma / yedek: posta tabloları yok */
    track(await A.req('GET', '/api/state')); track(await A.req('GET', '/api/export'));
    track(await A.req('POST', '/api/backups', { label: 'posta' }));
    const snap = (await pool.query('SELECT data::text AS t FROM snapshots ORDER BY id DESC LIMIT 1')).rows[0].t;
    assert.ok(!snap.includes('v1:') && !snap.includes('mail_accounts'));
  });

  test('varsayılan proje yalnız talep şablonlu; kurallar sırayla, ilk eşleşen kazanır', async () => {
    configure();
    const a = await acct('destek@sirket.test');
    assert.equal((await A.req('POST', `/api/mail/accounts/${a.id}`, { defaultProjectId: 'p_my' })).status, 400);
    assert.equal((await A.req('POST', `/api/mail/accounts/${a.id}`, { defaultProjectId: 'p_yok' })).status, 400);
    const r = track(await A.req('POST', `/api/mail/accounts/${a.id}`, { defaultProjectId: 'p_mx' }));
    assert.equal(r.status, 200); assert.equal(r.json.defaultProjectId, 'p_mx');
    assert.equal((await A.req('POST', '/api/mail/rules', { rules: [{ projectId: 'p_yok' }] })).status, 400);
    assert.equal((await A.req('POST', '/api/mail/rules', { rules: [{ projectId: 'p_my', assigneeId: 'u_yok' }] })).status, 400);
    const rules = [
      { id: 'mr_fat', subjectContains: 'FATURA', projectId: 'p_my', assigneeId: 'u_pm1' },
      { id: 'mr_dom', fromDomain: 'tedarik.test', projectId: 'p_mx' },
    ];
    const s = track(await A.req('POST', '/api/mail/rules', { rules }));
    assert.equal(s.status, 200); assert.deepEqual(s.json.map(x => x.id), ['mr_fat', 'mr_dom']);
    const R = (await pool.query('SELECT * FROM mail_rules ORDER BY ord')).rows;
    const msg = { to: ['destek@sirket.test'], subject: 'Fatura sorusu', from: { addr: 'ali@tedarik.test' } };
    assert.equal(mail.matchRule(R, a.id, msg).id, 'mr_fat');
    assert.equal(mail.matchRule([...R].reverse(), a.id, msg).id, 'mr_dom');            // sıra değişince diğeri
    assert.equal(mail.matchRule(R, a.id, { ...msg, subject: 'Merhaba', from: { addr: 'x@alt.tedarik.test' } }).id, 'mr_dom');
    assert.equal(mail.matchRule(R, a.id, { ...msg, subject: 'Merhaba', from: { addr: 'x@kotutedarik.test' } }), null);
    assert.equal(mail.matchRule([{ id: 'r', to_match: 'INFO@', active: true }], a.id, { ...msg, to: ['info@sirket.test'] }).id, 'r');
    assert.equal(mail.matchRule([{ id: 'r', account_id: 'mb_baska', active: true }], a.id, msg), null);
  });

  test('HTML → düz metin: betik/stil atılır, etiket kalmaz, varlıklar çözülür, alıntı kırpılır', () => {
    const t = mail.htmlToText('<html><head><style>p{color:red}</style></head><body><p>Merhaba&nbsp;<b>dünya</b> &amp; &lt;x&gt;</p>'
      + '<script>alert(1)</script><img src=x onerror="alert(2)"><ul><li>bir</li><li>iki</li></ul>&#304;stanbul &#x131;</body></html>');
    assert.ok(!/script|onerror|color:red|<img|<b>/.test(t), t);
    assert.match(t, /Merhaba dünya & <x>/); assert.match(t, /• bir\n• iki/); assert.match(t, /İstanbul ı/);
    assert.equal(mail.stripQuotes('Teşekkürler\n\nOn Mon, 1 Jan 2026 at 10:00 Ali <a@b.c> wrote:\n> eski metin'), 'Teşekkürler');
    assert.equal(mail.stripQuotes('Tamam.\n\n1 Oca 2026 Pzt 10:00 tarihinde Ali <a@b.c> şunu yazdı:\n> eski'), 'Tamam.');
    assert.equal(mail.stripQuotes('> yalnız alıntı'), '> yalnız alıntı');
    assert.equal(mail.decodeHeader('=?UTF-8?B?w5zDp8O8bmPDvCBzb3J1?='), 'Üçüncü soru');
  });

  test('çekme: yeni iş (kural/varsayılan), eşleşmeyen gönderen havuza, Message-ID tekil, In-Reply-To ve [ANAHTAR] → yorum, döngü önleme', async () => {
    configure();
    const a = await acct('destek@sirket.test');
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/history$/, () => J(200, {
      historyId: '200', history: [{ messagesAdded: [...inbox.values()].map(m => ({ message: { id: m.id, labelIds: m.labelIds } })) }] }));
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[^/]+$/, u => {
      const m = inbox.get(decodeURIComponent(u.pathname.split('/').pop())); return m ? J(200, m) : J(404, { error: 'yok' });
    });
    const H = (from, subject, mid, extra = {}) => ({ From: from, To: 'Destek <destek@sirket.test>', Subject: subject, 'Message-ID': mid, ...extra });
    inbox.set('g1', gm('g1', H('Ayşe Posta <ayse@musteri.test>', 'Yazıcı çalışmıyor', '<m1@musteri.test>'),
      { html: '<div>Yazıcı <b>çalışmıyor</b>.<script>window.x=1</script><img src=x onerror=alert(1)></div><blockquote>eski</blockquote>', files: 2 }));
    inbox.set('g2', gm('g2', H('Bilinmeyen <kimse@yabanci.test>', '<img src=x onerror=alert(1)> Merhaba', '<m2@yabanci.test>'), { text: 'Düz metin gövde' }));
    inbox.set('g3', gm('g3', H('Ali <ali@yabanci.test>', 'FATURA hakkında', '<m3@yabanci.test>'), { text: 'Fatura' }));
    inbox.set('g4', gm('g4', H('Kopya <ayse@musteri.test>', 'Yazıcı çalışmıyor', '<m1@musteri.test>'), { text: 'aynı ileti başka kimlikle' }));
    inbox.set('g5', gm('g5', H('Oto <oto@yabanci.test>', 'İzindeyim', '<m5@yabanci.test>', { 'Auto-Submitted': 'auto-replied' }), { text: 'otomatik' }));
    inbox.set('g6', gm('g6', H('Biz <destek@sirket.test>', 'Kendi gönderdiğimiz', '<m6@sirket.test>'), { text: 'döngü' }));
    inbox.set('g7', gm('g7', H('Toplu <bulten@yabanci.test>', 'Bülten', '<m7@yabanci.test>', { Precedence: 'bulk' }), { text: 'bülten' }));

    let r = await poll(a.id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const R = r.json.result;
    assert.deepEqual({ i: R.issues, d: R.duplicate, s: R.skipped, e: R.errors }, { i: 3, d: 1, s: 3, e: 0 }, JSON.stringify(r.json));
    const mx = await issuesOf('p_mx'), my = await issuesOf('p_my');
    const i1 = mx.find(i => i.summary === 'Yazıcı çalışmıyor'), i2 = mx.find(i => i.summary.includes('Merhaba'));
    assert.ok(i1 && i2); assert.equal(mx.filter(i => i.summary === 'Yazıcı çalışmıyor').length, 1);
    assert.deepEqual(i1.requester, { customerId: 'c_pm1', contactId: 'ct_pm' });        // harf duyarsız eşleşme
    assert.deepEqual(i1.labels, []); assert.equal(i1.reporter, 'u_posta'); assert.equal(i1.statusId, 'p_mx_s0');
    assert.match(i1.key, /^PST-\d+$/);
    assert.ok(!/[<>]|script|onerror/.test(i1.description), i1.description);
    assert.match(i1.description, /Yazıcı çalışmıyor\./); assert.ok(!i1.description.includes('eski'));
    assert.match(i1.description, /2 ek vardı/);
    assert.equal(i2.requester, undefined); assert.deepEqual(i2.labels, ['Talep eden bekleniyor']); assert.equal(i2.requesterEmail, 'kimse@yabanci.test');
    assert.equal(i2.summary, '<img src=x onerror=alert(1)> Merhaba');                   // düz metin olarak saklanır; istemci esc() ile basar
    assert.equal(my.length, 1); assert.equal(my[0].assignee, 'u_pm1');                  // kural: FATURA → Muhasebe + atanan
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM mail_messages`)).rows[0].n, 6);
    assert.equal((await acct('destek@sirket.test')).cursor, '200');
    const hist = (await pool.query(`SELECT data FROM history WHERE issue_id=$1`, [i1.id])).rows.map(x => x.data);
    assert.ok(hist.some(h => h.kind === 'create' && h.key === i1.key));

    /* yanıt: In-Reply-To → yorum + "Talep edenden yanıt bekleniyor" → "İnceleniyor" */
    const cur = (await pool.query('SELECT data FROM issues WHERE id=$1', [i1.id])).rows[0].data;
    assert.equal((await A.sync([{ c: 'issues', id: i1.id, op: 'put', data: { ...cur, statusId: 'p_mx_s2' }, base: cur }])).json.rejected.length, 0);
    inbox.set('g8', gm('g8', H('Ayşe Posta <ayse@musteri.test>', 'Re: Yazıcı çalışmıyor', '<m8@musteri.test>', { 'In-Reply-To': '<m1@musteri.test>', References: '<m1@musteri.test>' }),
      { text: 'Hâlâ çalışmıyor.\n\nOn Tue, 2 Jan 2026 Destek <destek@sirket.test> wrote:\n> eski yazışma' }));
    inbox.set('g9', gm('g9', H('Bilinmeyen <kimse@yabanci.test>', `Re: Merhaba [${i2.key}]`, '<m9@yabanci.test>'), { text: 'Ek bilgi' }));
    r = await poll(a.id);
    assert.deepEqual([r.json.result.issues, r.json.result.comments], [0, 2], JSON.stringify(r.json));
    const cm = (await pool.query(`SELECT data FROM comments WHERE issue_id=$1`, [i1.id])).rows.map(x => x.data);
    assert.equal(cm.length, 1); assert.equal(cm[0].userId, 'u_posta');
    assert.match(cm[0].body, /Hâlâ çalışmıyor\./); assert.ok(!cm[0].body.includes('eski yazışma'));
    assert.equal((await pool.query('SELECT data FROM issues WHERE id=$1', [i1.id])).rows[0].data.statusId, 'p_mx_s1');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM comments WHERE issue_id=$1`, [i2.id])).rows[0].n, 1);
    /* aynı iletiler yeniden gelse de bir şey olmaz */
    r = await poll(a.id);
    assert.deepEqual([r.json.result.issues, r.json.result.comments], [0, 0]);
    /* sistem kullanıcısı giriş yapamaz */
    assert.equal((await client().login('posta-sistemi', 'herhangi')).status, 401);
  });

  test('429: Retry-After kadar geri çekilir; süre dolmadan otomatik turda istek atılmaz; yoksa üstel', async () => {
    configure();
    const a = await acct('destek@sirket.test');
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/history$/, () => J(429, { error: { message: 'Too many' } }, { 'retry-after': '120' }));
    const r = await poll(a.id);
    assert.equal(r.json.result.error, true); assert.equal(r.json.result.retryIn, 120);
    const b = await acct('destek@sirket.test');
    assert.equal(b.fail_count, 1); assert.match(b.last_error, /429/);
    const left = (new Date(b.backoff_until) - Date.now()) / 1000;
    assert.ok(left > 100 && left <= 121, String(left));
    const n = calls.length;
    await mail.pollAll(pool);
    assert.equal(calls.length, n);
    /* Retry-After yoksa üstel: ikinci hata → MAIL_POLL_SEC(120) * 2 */
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/history$/, () => J(503, {}));
    const r2 = await poll(a.id);
    assert.equal(r2.json.result.retryIn, 240);
    routes.shift(); routes.shift();                               // 503/429 taklitlerini kaldır
    await pool.query('UPDATE mail_accounts SET backoff_until=NULL, fail_count=0, last_error=NULL WHERE id=$1', [a.id]);
  });

  test('Outlook: Graph delta (ilk turda yalnız imleç), HTML gövde düz metin, sabit adres dışına istek yok', async () => {
    configure();
    route(/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, () => J(200, { access_token: 'tok_ERISIM_m1', refresh_token: 'tok_YENILEME_m1', expires_in: 3600 }));
    route(/graph\.microsoft\.com\/v1\.0\/me$/, () => J(200, { mail: 'Talep@Outlook.test' }));
    const L = new globalThis.URL((await raw('/api/mail/oauth/microsoft/start', adminCookie)).location);
    assert.equal(L.origin + L.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    for (const sc of ['offline_access', 'Mail.Read', 'Mail.Send', 'User.Read', 'openid', 'email']) assert.ok(L.searchParams.get('scope').split(' ').includes(sc), sc);
    assert.equal((await raw(`/api/mail/oauth/microsoft/callback?state=${L.searchParams.get('state')}&code=k`, adminCookie)).location, '/?posta=bagli#system');
    const a = await acct('talep@outlook.test');
    await A.req('POST', `/api/mail/accounts/${a.id}`, { defaultProjectId: 'p_mx' });
    route(/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta$/, u => {
      if (u.searchParams.get('$filter')) return J(200, { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=d1' });
      if (u.searchParams.get('$deltatoken') === 'd1') return J(200, { value: [{ id: 'AAMk/1==' }, { id: 'sil', '@removed': { reason: 'deleted' } }],
        '@odata.deltaLink': 'https://evil.example/steal?$deltatoken=d2' });
      return J(400, {});
    });
    route(/graph\.microsoft\.com\/v1\.0\/me\/messages\/.+$/, u => {
      assert.equal(u.pathname, '/v1.0/me/messages/AAMk%2F1%3D%3D');                       // kimlik yola kodlanarak girer
      return J(200, { id: 'AAMk/1==', internetMessageId: '<o1@outlook.test>', subject: 'Outlook talebi',
        from: { emailAddress: { name: 'Dış Kişi', address: 'dis@kisi.test' } }, toRecipients: [{ emailAddress: { address: 'talep@outlook.test' } }],
        receivedDateTime: new Date().toISOString(), hasAttachments: true, body: { contentType: 'html', content: '<p>Merhaba <i>ekip</i></p><style>x{}</style>' } });
    });
    let r = await poll(a.id);
    assert.equal(r.json.result.issues, 0, JSON.stringify(r.json));
    assert.match((await acct('talep@outlook.test')).cursor, /deltatoken=d1$/);
    r = await poll(a.id);
    assert.equal(r.json.result.issues, 1, JSON.stringify(r.json));
    const it = (await issuesOf('p_mx')).find(i => i.summary === 'Outlook talebi');
    assert.equal(it.description, 'Merhaba ekip\n\n(İletide ek vardı; ekler aktarılmadı.)');
    /* sonraki turda imleç sabit olmayan adrese işaret ediyor: istek atılmaz, hata kaydedilir */
    const before = calls.length;
    r = await poll(a.id);
    assert.equal(r.json.result.error, true);
    assert.ok(calls.slice(before).every(c => !c.url.includes('evil.example')));
    assert.match((await acct('talep@outlook.test')).last_error, /izinli değil/);
  });

  test('jeton geçersiz → "Yeniden bağlanın" + yöneticiye bildirim; bağlantıyı kes jetonu siler ve Google izni geri alınır', async () => {
    configure();
    const a = await acct('destek@sirket.test');
    await pool.query(`UPDATE mail_accounts SET access_expires_at=now() - interval '1 hour' WHERE id=$1`, [a.id]);
    route(/oauth2\.googleapis\.com\/token$/, () => J(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const r = await poll(a.id);
    assert.equal(r.json.result.reconnect, true);
    const b = await acct('destek@sirket.test');
    assert.equal(b.status, 'reconnect'); assert.equal(b.refresh_token_enc, null); assert.match(b.last_error, /Yeniden bağlanın/);
    const n = track(await A.req('GET', '/api/notifications'));
    assert.ok(n.json.items.some(x => x.kind === 'mail' && x.meta.address === 'destek@sirket.test'));
    /* yeniden bağlanmış gibi: kesmede revoke çağrılır */
    await pool.query(`UPDATE mail_accounts SET status='ok', refresh_token_enc=$2 WHERE id=$1`, [a.id, mail.encrypt('tok_YENILEME_g9')]);
    route(/oauth2\.googleapis\.com\/revoke$/, () => J(200, {}));
    const d = track(await A.req('POST', `/api/mail/accounts/${a.id}/delete`));
    assert.equal(d.status, 200); assert.equal(d.json.revoked, true);
    assert.ok(calls.some(c => c.url === 'https://oauth2.googleapis.com/revoke' && c.method === 'POST' && c.body.includes('tok_YENILEME_g9')));
    assert.equal(await acct('destek@sirket.test'), undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mail_messages WHERE account_id=$1', [a.id])).rows[0].n, 0);
  });

  test('jeton ve sır hiçbir yanıtta görünmez', () => {
    const all = seenBodies.join('\n');
    for (const s of ['tok_', 'refresh_token', 'access_token', 'g-sir', 'm-sir', '_enc', 'verifier', 'v1:']) assert.ok(!all.includes(s), s);
  });
});

/* ---------------- kart içinden e-postayla yanıt (madde 21, E3) ----------------
   Sağlayıcı çağrıları setMailFetch ile taklit edilir (ağa çıkılmaz). Alıcı/konu/zincir sunucuda, kaynak iletiden. */
describe('e-postayla yanıt', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  let mail, A, M, W, X;
  const ENV = ['MAIL_TOKEN_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT', 'MAIL_ENABLED'];
  const saved = {};
  const calls = [], routes = [];
  const J = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const route = (re, fn) => { routes.unshift([re, fn]); };
  const configure = () => {
    process.env.MAIL_TOKEN_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.GOOGLE_CLIENT_ID = 'g-istemci'; process.env.GOOGLE_CLIENT_SECRET = 'g-sir';
    process.env.MS_CLIENT_ID = 'm-istemci'; process.env.MS_CLIENT_SECRET = 'm-sir'; process.env.MS_TENANT = 'common';
    process.env.MAIL_ENABLED = 'true';
  };
  const ok = r => assert.equal(r.json.rejected.length, 0, JSON.stringify(r.json.rejected));
  const newUser = async (id, username, role) => {
    ok(await A.sync([{ c: 'users', id, op: 'put', data: { username, name: username, role, active: true } }]));
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'YanitYeni12345' })).status, 200);
    return k;
  };
  const enc64 = s => Buffer.from(s, 'utf8').toString('base64url');
  const gm = (id, threadId, h, text) => ({ id, threadId, labelIds: ['INBOX'], internalDate: String(Date.now()),
    payload: { mimeType: 'text/plain', headers: Object.entries(h).map(([name, value]) => ({ name, value })), body: { data: enc64(text) } } });
  const issueOf = async summary => (await pool.query(`SELECT id, data FROM issues WHERE project_id='p_ey' AND data->>'summary'=$1`, [summary])).rows[0];
  const sent = () => calls.filter(c => /\/messages\/send$/.test(c.url));
  const mime = c => Buffer.from(JSON.parse(c.body).raw, 'base64url').toString('utf8');
  const hdrs = m => m.split('\r\n\r\n')[0];
  const decSubj = m => { const v = /^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m.exec(hdrs(m))?.[1]; return v ? Buffer.from(v, 'base64').toString('utf8') : null; };
  const reply = (k, iid, body) => k.req('POST', `/api/mail/reply/${iid}`, body);
  let IG, IO;                                           // Gmail ve Outlook'tan oluşan işler

  before(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    configure();
    mail = await import('../server/mail.js');
    mail.setMailFetch(async (url, opt = {}) => {
      const u = new globalThis.URL(url); calls.push({ url: u.toString(), path: u.origin + u.pathname, method: opt.method || 'GET', body: opt.body || '' });
      for (const [re, fn] of routes) if (re.test(u.origin + u.pathname)) return fn(u, opt);
      return J(404, { error: 'bulunamadı' });
    });
    A = client(); await A.login('admin', 'test-admin-pw');
    M = await newUser('u_eym', 'eyuye', 'member');
    W = await newUser('u_eyw', 'eyizci', 'member');
    X = await newUser('u_eyx', 'eydis', 'member');
    /* E-posta sistem kullanıcısı (u_posta) alanın üyesi DEĞİL: sunucu içi system bayrağıyla yine iş açar. */
    ok(await A.sync([
      { c: 'workspaces', id: 'ws_ey', op: 'put', data: { name: 'Destek alanı', members: [{ userId: 'u_eym', role: 'member' }, { userId: 'u_eyw', role: 'viewer' }] } },
      { c: 'projects', id: 'p_ey', op: 'put', data: { name: 'EY destek', key: 'EY', counter: 0, workspaceId: 'ws_ey', template: 'talep' } },
      { c: 'statuses', id: 'p_ey_s0', op: 'put', data: { projectId: 'p_ey', name: 'Yeni', cat: 'todo', ord: 0 } },
      { c: 'projects', id: 'p_ey2', op: 'put', data: { name: 'EY iç', key: 'EYI', counter: 0, workspaceId: 'ws_ey' } },
      { c: 'statuses', id: 'p_ey2_s0', op: 'put', data: { projectId: 'p_ey2', name: 'Yeni', cat: 'todo', ord: 0 } },
      { c: 'issues', id: 'i_eyelle', op: 'put', data: { projectId: 'p_ey2', key: 'EYI-1', summary: 'Elle açılan iş', statusId: 'p_ey2_s0' } },
    ]));
    await pool.query('DELETE FROM mail_rules');
    for (const [id, p, addr] of [['mb_eyg', 'google', 'destek@ey.test'], ['mb_eym', 'microsoft', 'talep@ey.test']])
      await pool.query(`INSERT INTO mail_accounts (id, provider, address, refresh_token_enc, access_token_enc, access_expires_at, default_project_id)
        VALUES ($1,$2,$3,$4,$5, now() + interval '1 hour', 'p_ey')`, [id, p, addr, mail.encrypt('tok_YEN_' + id), mail.encrypt('tok_ERS_' + id)]);
    const accG = (await pool.query(`SELECT * FROM mail_accounts WHERE id='mb_eyg'`)).rows[0];
    const accM = (await pool.query(`SELECT * FROM mail_accounts WHERE id='mb_eym'`)).rows[0];
    assert.equal(await mail.processMessage(pool, accG, mail.parseGmail(gm('gy1', 'th_EY1', {
      From: 'Ayşe Talep <Ayse@Musteri-ey.test>', To: 'destek@ey.test', Subject: 'Yazıcım bozuldu', 'Message-ID': '<ilk1@musteri-ey.test>',
      References: '<eski0@musteri-ey.test>' }, 'Merhaba, yazıcı çalışmıyor.'))), 'issue');
    assert.equal(await mail.processMessage(pool, accM, mail.parseGraph({ id: 'AAMk/ey1==', internetMessageId: '<o1@kisi-ey.test>', subject: 'Outlook talebi EY',
      from: { emailAddress: { name: 'Dış', address: 'dis@kisi-ey.test' } }, toRecipients: [{ emailAddress: { address: 'talep@ey.test' } }],
      receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'Outlook gövde' } })), 'issue');
    IG = await issueOf('Yazıcım bozuldu'); IO = await issueOf('Outlook talebi EY');
    assert.ok(IG && IO);
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, () => J(200, { id: 'gsent' + calls.length, threadId: 'th_EY1' }));
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/gy1$/, () => J(200, gm('gy1', 'th_EY1', {
      Subject: 'Yazıcım bozuldu', 'Message-ID': '<ilk1@musteri-ey.test>', References: '<eski0@musteri-ey.test>' }, '')));
  });
  after(() => { mail?.setMailFetch(null); mail?.resetReplyLimit(); for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('gelen iletide konu ve Gmail zincir kimliği saklanır (007)', async () => {
    const r = (await pool.query(`SELECT subject, thread_id, from_addr FROM mail_messages WHERE issue_id=$1`, [IG.id])).rows[0];
    assert.deepEqual(r, { subject: 'Yazıcım bozuldu', thread_id: 'th_EY1', from_addr: 'ayse@musteri-ey.test' });
  });

  test('durum ucu: alan Üyesi ve yönetici görür (alıcı sunucudan); izleyici 403, alan dışı 404, oturumsuz 401, e-postasız iş kapalı', async () => {
    for (const k of [M, A]) {
      const r = await k.req('GET', `/api/mail/reply/${IG.id}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { available: true, to: 'ayse@musteri-ey.test', subject: `Re: Yazıcım bozuldu [${IG.data.key}]`, provider: 'google' });
    }
    assert.equal((await W.req('GET', `/api/mail/reply/${IG.id}`)).status, 403);
    assert.equal((await X.req('GET', `/api/mail/reply/${IG.id}`)).status, 404);
    assert.equal((await M.req('GET', '/api/mail/reply/i_yok')).status, 404);
    assert.equal((await client().req('GET', `/api/mail/reply/${IG.id}`)).status, 401);
    assert.deepEqual((await M.req('GET', '/api/mail/reply/i_eyelle')).json, { available: false, reason: 'Bu iş bir e-postadan oluşmadı' });
  });

  test('gönderim yetkisi sunucuda: izleyici 403, alan dışı 404, CSRF 403; sağlayıcıya istek gitmez', async () => {
    mail.resetReplyLimit();
    const n = calls.length;
    assert.equal((await reply(W, IG.id, { body: 'izleyici' })).status, 403);
    assert.equal((await reply(X, IG.id, { body: 'dışarıdan' })).status, 404);
    assert.equal((await M.req('POST', `/api/mail/reply/${IG.id}`, { body: 'csrf' }, { 'x-pano': '' })).status, 403);
    assert.equal((await reply(M, 'i_eyelle', { body: 'e-postasız' })).status, 409);
    assert.equal(calls.length, n);
  });

  test('Gmail: alıcı ve konu sunucudan, threadId + In-Reply-To/References; yorum, geçmiş ve giden ileti kaydı', async () => {
    mail.resetReplyLimit();
    const n = sent().length, s0 = (await pool.query('SELECT coalesce(max(seq),0)::int AS s FROM changes')).rows[0].s;
    const r = await reply(M, IG.id, { body: 'Merhaba Ayşe Hanım,\nyazıcınızı yarın değiştiriyoruz.\n\nİyi çalışmalar' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.to, 'ayse@musteri-ey.test'); assert.equal(r.json.recorded, true);
    assert.equal(sent().length, n + 1);
    const c = sent().at(-1), j = JSON.parse(c.body), m = mime(c), h = hdrs(m);
    assert.equal(c.method, 'POST'); assert.equal(j.threadId, 'th_EY1');
    assert.match(h, /^From: destek@ey\.test$/m); assert.match(h, /^To: ayse@musteri-ey\.test$/m);
    assert.equal(decSubj(m), `Re: Yazıcım bozuldu [${IG.data.key}]`);
    assert.match(h, /^In-Reply-To: <ilk1@musteri-ey\.test>$/m);
    assert.match(h, /^References: <eski0@musteri-ey\.test> <ilk1@musteri-ey\.test>$/m);
    assert.match(h, /^Content-Type: text\/plain; charset=UTF-8$/m);
    const mid = /^Message-ID: (<cp\.[0-9a-f]+@ey\.test>)$/m.exec(h)?.[1]; assert.ok(mid, h);
    assert.equal(Buffer.from(m.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'),
      'Merhaba Ayşe Hanım,\r\nyazıcınızı yarın değiştiriyoruz.\r\n\r\nİyi çalışmalar');
    const cm = (await pool.query(`SELECT data FROM comments WHERE id=$1`, [r.json.commentId])).rows[0].data;
    assert.equal(cm.userId, 'u_eym'); assert.equal(cm.issueId, IG.id);
    assert.match(cm.body, /^✉ E-postayla yanıtlandı \(ayse@musteri-ey\.test\):\n\nMerhaba Ayşe Hanım/);
    const hs = (await pool.query(`SELECT data FROM history WHERE issue_id=$1 AND data->>'kind'='reply'`, [IG.id])).rows.map(x => x.data);
    assert.equal(hs.length, 1); assert.equal(hs[0].field, 'E-posta'); assert.equal(hs[0].userId, 'u_eym');
    assert.equal(hs[0].to, `ayse@musteri-ey.test · Re: Yazıcım bozuldu [${IG.data.key}]`);
    const out = (await pool.query(`SELECT * FROM mail_messages WHERE issue_id=$1 AND direction='out'`, [IG.id])).rows;
    assert.equal(out.length, 1); assert.equal(out[0].message_id, mid); assert.equal(out[0].comment_id, r.json.commentId);
    /* talep eden bu yanıta cevap verirse aynı işe yorum olarak düşer (In-Reply-To = gönderdiğimiz Message-ID) */
    const accG = (await pool.query(`SELECT * FROM mail_accounts WHERE id='mb_eyg'`)).rows[0];
    assert.equal(await mail.processMessage(pool, accG, mail.parseGmail(gm('gy2', 'th_EY1', { From: 'ayse@musteri-ey.test', To: 'destek@ey.test',
      Subject: 'Re: başka konu', 'Message-ID': '<cevap2@musteri-ey.test>', 'In-Reply-To': mid }, 'Teşekkürler'))), 'comment');
    /* yorum değişiklik akışıyla üyeye gelir */
    const ch = await M.req('GET', `/api/changes?since=${s0}`);
    assert.ok(ch.json.items.some(x => x.c === 'comments' && x.id === r.json.commentId), 'yorum akışta');
  });

  test('istemci alıcı/konu/başlık belirleyemez (400); CR/LF başlığa giremez', async () => {
    mail.resetReplyLimit();
    const n = calls.length;
    for (const extra of [{ to: 'saldirgan@kotu.test' }, { cc: 'x@kotu.test' }, { bcc: 'x@kotu.test' }, { subject: 'Sahte' }, { headers: { Bcc: 'x@kotu.test' } }]) {
      const r = await reply(M, IG.id, { body: 'merhaba', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra)); assert.match(r.json.error, /sunucuda belirlenir/);
    }
    for (const body of ['', '   ', 5, null, 'x'.repeat(10001), 'a\0b']) assert.equal((await reply(M, IG.id, { body })).status, 400, String(body).slice(0, 20));
    assert.equal(calls.length, n);
    /* gövdedeki CRLF + "Bcc:" başlık olmaz (gövde base64) */
    let r = await reply(M, IG.id, { body: 'satır\r\nBcc: gizli@kotu.test\r\n\r\nX-Ek: 1' });
    assert.equal(r.status, 200);
    const h = hdrs(mime(sent().at(-1)));
    assert.ok(!/bcc|x-ek|kotu/i.test(h), h);
    /* kaynak iletideki konuda CR/LF: tek satıra iner; adres CR/LF içeriyorsa gönderilmez (409) */
    await pool.query(`UPDATE mail_messages SET subject=$2 WHERE issue_id=$1 AND direction='in'`, [IG.id, 'Yazıcı\r\nBcc: gizli@kotu.test']);
    r = await reply(M, IG.id, { body: 'konu denemesi' });
    assert.equal(r.status, 200);
    const m2 = mime(sent().at(-1));
    assert.equal(decSubj(m2), `Re: Yazıcı Bcc: gizli@kotu.test [${IG.data.key}]`);
    assert.ok(!/^Bcc:/mi.test(hdrs(m2)));
    await pool.query(`UPDATE mail_messages SET subject='Yazıcım bozuldu' WHERE issue_id=$1 AND direction='in'`, [IG.id]);
    await pool.query(`UPDATE mail_messages SET from_addr=$2 WHERE issue_id=$1 AND direction='in' AND comment_id IS NULL`, [IG.id, 'ayse@musteri-ey.test\r\nBcc: gizli@kotu.test']);
    const k = sent().length;
    r = await reply(M, IG.id, { body: 'adres denemesi' });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'Talep edenin e-posta adresi geçersiz');
    assert.equal(sent().length, k);
    await pool.query(`UPDATE mail_messages SET from_addr='ayse@musteri-ey.test' WHERE issue_id=$1 AND direction='in' AND comment_id IS NULL`, [IG.id]);
    /* MIME kurucu da reddeder (derin savunma) */
    assert.throws(() => mail.buildMime({ from: 'a@b.test', to: 'c@d.test\r\nBcc: e@f.test', subject: 's', messageId: '<x@y>', body: 'b' }), /Geçersiz e-posta başlığı/);
    assert.equal(mail.replySubject('RE: Ynt: Fatura [EY-5]', 'EY-5'), 'Re: Fatura [EY-5]');
  });

  test('hız sınırı: kullanıcı başına dakikada 10; başka kullanıcı etkilenmez', async () => {
    mail.resetReplyLimit();
    for (let i = 0; i < 10; i++) assert.equal((await reply(M, IG.id, { body: 'yanıt ' + i })).status, 200, 'gönderim ' + i);
    const n = sent().length;
    const r = await reply(M, IG.id, { body: 'on birinci' });
    assert.equal(r.status, 429); assert.match(r.json.error, /Çok fazla e-posta yanıtı/);
    assert.equal(sent().length, n);
    assert.equal((await reply(A, IG.id, { body: 'yönetici' })).status, 200);
    mail.resetReplyLimit();
  });

  test('yapılandırılmamış / kapalı / bağlı olmayan kutu: düğme kapalı (available:false), gönderim 409', async () => {
    mail.resetReplyLimit();
    const n = calls.length;
    process.env.MAIL_ENABLED = 'false';
    assert.equal((await M.req('GET', `/api/mail/reply/${IG.id}`)).json.available, false);
    let r = await reply(M, IG.id, { body: 'kapalı' });
    assert.equal(r.status, 409); assert.match(r.json.error, /MAIL_ENABLED/);
    delete process.env.MAIL_TOKEN_KEY;
    r = await reply(M, IG.id, { body: 'yapılandırılmamış' });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'Sunucu yapılandırılmamış');
    configure();
    await pool.query(`UPDATE mail_accounts SET status='reconnect' WHERE id='mb_eyg'`);
    r = await reply(M, IG.id, { body: 'süresi dolmuş' });
    assert.equal(r.status, 409); assert.match(r.json.error, /^Posta kutusunu yeniden bağlayın/);
    await pool.query(`UPDATE mail_accounts SET status='ok', active=false WHERE id='mb_eyg'`);
    assert.deepEqual((await M.req('GET', `/api/mail/reply/${IG.id}`)).json, { available: false, reason: 'İletinin geldiği posta kutusu bağlı değil' });
    assert.equal((await reply(M, IG.id, { body: 'pasif' })).status, 409);
    await pool.query(`UPDATE mail_accounts SET active=true WHERE id='mb_eyg'`);
    assert.equal(calls.length, n);
  });

  test('gönderme kapsamı yok (403) ya da yenileme reddi: "Posta kutusunu yeniden bağlayın", kayıt yazılmaz', async () => {
    mail.resetReplyLimit();
    const cm0 = (await pool.query(`SELECT count(*)::int AS n FROM comments WHERE issue_id=$1`, [IG.id])).rows[0].n;
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, () => J(403, { error: { code: 403, message: 'Request had insufficient authentication scopes.' } }));
    let r = await reply(M, IG.id, { body: 'kapsamsız' });
    assert.equal(r.status, 409); assert.equal(r.json.error, mail.RECONNECT_MSG);
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, () => J(500, { error: { message: 'iç' } }));
    r = await reply(M, IG.id, { body: 'sağlayıcı hatası' });
    assert.equal(r.status, 424); assert.match(r.json.error, /E-posta gönderilemedi/);
    route(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send$/, () => J(200, { id: 'gsent_x', threadId: 'th_EY1' }));
    await pool.query(`UPDATE mail_accounts SET access_expires_at=now() - interval '1 hour' WHERE id='mb_eym'`);
    route(/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token$/, () => J(400, { error: 'invalid_grant', error_description: 'AADSTS65001 consent' }));
    r = await reply(M, IO.id, { body: 'graph kapsamsız' });
    assert.equal(r.status, 409); assert.equal(r.json.error, mail.RECONNECT_MSG);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM comments WHERE issue_id IN ($1,$2)`, [IG.id, IO.id])).rows[0].n, cm0);
    await pool.query(`UPDATE mail_accounts SET access_expires_at=now() + interval '1 hour' WHERE id='mb_eym'`);
    assert.equal((await pool.query(`SELECT status FROM mail_accounts WHERE id='mb_eym'`)).rows[0].status, 'ok');
  });

  test('Outlook: createReply → düz metin + sunucunun alıcısı → send; taşınmış iletide internetMessageId ile bulunur', async () => {
    mail.resetReplyLimit();
    let patch = null;
    route(/graph\.microsoft\.com\/v1\.0\/me\/messages\/[^/]+\/createReply$/, u =>
      (u.pathname === '/v1.0/me/messages/AAMk%2Fey1%3D%3D/createReply' || u.pathname === '/v1.0/me/messages/YENI%2Fid/createReply'
        ? J(201, { id: 'TASLAK/1', internetMessageId: '<taslak1@ey.test>' }) : J(404, { error: { code: 'ErrorItemNotFound' } })));
    route(/graph\.microsoft\.com\/v1\.0\/me\/messages\/[^/]+$/, (_u, opt) => { if (opt.method === 'PATCH') patch = JSON.parse(opt.body); return J(200, {}); });
    route(/graph\.microsoft\.com\/v1\.0\/me\/messages\/[^/]+\/send$/, () => J(202));
    route(/graph\.microsoft\.com\/v1\.0\/me\/messages$/, u => J(200, { value: /o1@kisi-ey\.test/.test(u.searchParams.get('$filter')) ? [{ id: 'YENI/id' }] : [] }));
    let r = await reply(M, IO.id, { body: 'Outlook yanıtı' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(patch, { subject: `Re: Outlook talebi EY [${IO.data.key}]`, body: { contentType: 'text', content: 'Outlook yanıtı' },
      toRecipients: [{ emailAddress: { address: 'dis@kisi-ey.test' } }], ccRecipients: [], bccRecipients: [] });
    assert.ok(calls.some(c => c.path === 'https://graph.microsoft.com/v1.0/me/messages/TASLAK%2F1/send' && c.method === 'POST'));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM mail_messages WHERE message_id='<taslak1@ey.test>' AND direction='out' AND issue_id=$1`, [IO.id])).rows[0].n, 1);
    /* ileti başka klasöre taşınmış (kimlik değişmiş): internetMessageId ile aranır */
    await pool.query(`UPDATE mail_messages SET provider_msg_id='ESKI-id' WHERE issue_id=$1 AND direction='in'`, [IO.id]);
    await pool.query(`DELETE FROM mail_messages WHERE message_id='<taslak1@ey.test>'`);
    r = await reply(M, IO.id, { body: 'ikinci' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(calls.some(c => c.path === 'https://graph.microsoft.com/v1.0/me/messages' && /internetMessageId/.test(decodeURIComponent(c.url))));
    /* hiç bulunamazsa 409 */
    await pool.query(`UPDATE mail_messages SET message_id='<yok@kisi-ey.test>' WHERE issue_id=$1 AND direction='in'`, [IO.id]);
    r = await reply(M, IO.id, { body: 'üçüncü' });
    assert.equal(r.status, 409); assert.match(r.json.error, /Özgün ileti posta kutusunda bulunamadı/);
    assert.ok(calls.every(c => /^https:\/\/(graph\.microsoft\.com|gmail\.googleapis\.com|oauth2\.googleapis\.com|login\.microsoftonline\.com)\//.test(c.url)));
  });

  test('posta kuralı üyeli alanda iş açar (sistem kullanıcısı üye değil); rolü olmayan/izleyici atanan boş kalır, Üye atanır', async () => {
    const ws = (await pool.query(`SELECT data FROM workspaces WHERE id='ws_ey'`)).rows[0].data;
    assert.ok(!ws.members.some(x => x.userId === 'u_posta'), 'sistem kullanıcısı alanda üye değil');
    assert.equal(IG.data.reporter, 'u_posta');
    const accG = (await pool.query(`SELECT * FROM mail_accounts WHERE id='mb_eyg'`)).rows[0];
    try {
      const r = await A.req('POST', '/api/mail/rules', { rules: [
        { id: 'mr_eyx', subjectContains: 'KURALX', projectId: 'p_ey2', assigneeId: 'u_eyx' },
        { id: 'mr_eyw', subjectContains: 'KURALW', projectId: 'p_ey2', assigneeId: 'u_eyw' },
        { id: 'mr_eym', subjectContains: 'KURALM', projectId: 'p_ey2', assigneeId: 'u_eym' },
      ] });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      for (const [tag, want] of [['KURALX', null], ['KURALW', null], ['KURALM', 'u_eym']]) {
        assert.equal(await mail.processMessage(pool, accG, mail.parseGmail(gm('gk_' + tag, 'th_' + tag, {
          From: 'kural@musteri-ey.test', To: 'destek@ey.test', Subject: `${tag} talebi`, 'Message-ID': `<${tag}@musteri-ey.test>` }, 'gövde'))), 'issue', tag);
        const i = (await pool.query(`SELECT data FROM issues WHERE project_id='p_ey2' AND data->>'summary'=$1`, [`${tag} talebi`])).rows[0]?.data;
        assert.ok(i, tag); assert.equal(i.assignee ?? null, want, tag); assert.equal(i.reporter, 'u_posta');
        assert.match(i.key, /^EYI-\d+$/); assert.equal(i.statusId, 'p_ey2_s0');
      }
    } finally { await pool.query('DELETE FROM mail_rules'); }
  });

  test('istemci system bayrağını ayarlayamaz: /api/sync gövdesinde, değişiklikte ya da veride system:true etkisiz', async () => {
    const data = { projectId: 'p_ey', key: 'EY-900', summary: 'Sahte sistem işi', statusId: 'p_ey_s0', system: true };
    const r = await X.req('POST', '/api/sync', { system: true, opts: { system: true },
      changes: [{ c: 'issues', id: 'i_eysahte', op: 'put', system: true, opts: { system: true }, data }] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.rejected.map(x => x.reason), ['Bu çalışma alanına erişiminiz yok']);
    assert.equal((await pool.query(`SELECT 1 FROM issues WHERE id='i_eysahte'`)).rowCount, 0);
    /* yorumda da: alan dışı kişi sistem bayrağıyla alanın işine yazamaz */
    const c = await X.req('POST', '/api/sync', { system: true,
      changes: [{ c: 'comments', id: 'c_eysahte', op: 'put', system: true, data: { issueId: IG.id, body: 'sızma', system: true } }] });
    assert.deepEqual(c.json.rejected.map(x => x.reason), ['Bu çalışma alanına erişiminiz yok']);
  });
});

/* ---------------- çalışma alanı üyelikleri ve rolleri (22b) ----------------
   Rol matrisi: sistem yöneticisi sınırsız; alan Yöneticisi (sahip dahil) proje tasarımı + alan üyeleri; alan Üyesi
   iş/yorum/süre/sprint; alan İzleyicisi salt okunur; listede olmayan erişemez. Üyesiz (eski) alanda genel rol. */
describe('alan rolleri', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const reasons = r => r.json.rejected.map(x => x.reason);
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const rej = (r, msg) => { assert.equal(r.status, 200); assert.equal(r.json.applied, 0, JSON.stringify(r.json)); assert.deepEqual(reasons(r), [msg]); };
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  const put = (c, id, data, base) => ({ c, id, op: 'put', data, ...(base ? { base } : {}) });
  const NO = 'Bu çalışma alanına erişiminiz yok', RO = 'Bu çalışma alanında yalnızca görüntüleme yetkiniz var';
  const DES = 'Bu değişiklik için alan yöneticisi yetkisi gerekli', WSE = 'Bu çalışma alanını yalnızca alan yöneticisi değiştirebilir';
  const C = {};
  const newUser = async (id, username, role) => {
    ok(await C.A.sync([put('users', id, { username, name: username, role, active: true })]));
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'RolYeni123456' })).status, 200);
    return k;
  };
  let nKey = 100;
  const iss = (id, pid, extra = {}) => put('issues', id, { projectId: pid, key: `${pid.toUpperCase().replace(/_/g, "")}-${nKey++}`, summary: 'iş', statusId: `${pid}_s0`, ...extra });

  before(async () => {
    C.A = client(); await C.A.login('admin', 'test-admin-pw');
    C.O = await newUser('u_ro', 'rolsahip', 'member');      // alan sahibi
    C.Y = await newUser('u_ry', 'rolyon', 'member');        // alan Yöneticisi
    C.M = await newUser('u_rm', 'roluye', 'member');        // alan Üyesi
    C.V = await newUser('u_rv', 'rolizci', 'member');       // alan İzleyicisi (genel rolü Üye)
    C.X = await newUser('u_rx', 'roldis', 'member');        // alanda yok
    C.G = await newUser('u_rg', 'rolgenizci', 'viewer');    // genel İzleyici, alanda Üye
    ok(await C.A.sync([
      put('workspaces', 'ws_r', { name: 'Rol alanı', ownerId: 'u_ro', members: [
        { userId: 'u_ry', role: 'admin' }, { userId: 'u_rm', role: 'member' }, { userId: 'u_rv', role: 'viewer' }, { userId: 'u_rg', role: 'member' }] }),
      put('workspaces', 'ws_r2', { name: 'Rol alanı 2', members: [{ userId: 'u_rm', role: 'viewer' }, { userId: 'u_rv', role: 'member' }] }),
      put('projects', 'pr', { name: 'Rol projesi', key: 'PR', counter: 0, workspaceId: 'ws_r', members: ['u_admin'] }),
      put('projects', 'pr2', { name: 'Rol projesi 2', key: 'PR2', counter: 0, workspaceId: 'ws_r2' }),
      put('statuses', 'pr_s0', { projectId: 'pr', name: 'Yapılacak', cat: 'todo', ord: 0 }),
      put('statuses', 'pr_s1', { projectId: 'pr', name: 'Bitti', cat: 'done', ord: 1 }),
      put('statuses', 'pr2_s0', { projectId: 'pr2', name: 'Yapılacak', cat: 'todo', ord: 0 }),
      put('statuses', 'pr2_s1', { projectId: 'pr2', name: 'Bitti', cat: 'done', ord: 1 }),
      iss('i_r1', 'pr'), iss('i_r2', 'pr2')]));
  });

  test('üye listesi: sahip otomatik ve kaldırılamaz Yönetici; biçim, rol ve kişi doğrulanır', async () => {
    const w = await row('workspaces', 'ws_r');
    assert.equal(w.ownerId, 'u_ro'); assert.equal(w.createdBy, 'u_admin');
    assert.deepEqual(w.members[0], { userId: 'u_ro', role: 'admin' });            // sahip listeye eklendi
    assert.equal((await row('workspaces', 'ws_r2')).members[0].userId, 'u_admin'); // sahip seçilmezse açan yönetici
    /* Alan yöneticisi sahibi çıkarmaya ya da düşürmeye çalışır: sahip Yönetici olarak kalır. */
    let r = await C.Y.sync([put('workspaces', 'ws_r', { ...w, members: w.members.filter(m => m.userId !== 'u_ro') }, w)]);
    assert.deepEqual(r.json.rejected, []);
    let w2 = await row('workspaces', 'ws_r');
    assert.ok(w2.members.some(m => m.userId === 'u_ro' && m.role === 'admin'));
    r = await C.Y.sync([put('workspaces', 'ws_r', { ...w2, members: w2.members.map(m => m.userId === 'u_ro' ? { ...m, role: 'viewer' } : m) }, w2)]);
    assert.equal(r.json.applied, 0); assert.deepEqual(r.json.rejected, []);
    assert.ok((await row('workspaces', 'ws_r')).members.some(m => m.userId === 'u_ro' && m.role === 'admin'));
    for (const [members, msg] of [[[{ userId: 'u_rm', role: 'sahip' }], /Üye kaydı geçersiz/], [[{ userId: 'u_yok', role: 'member' }], /Üye bulunamadı/],
      [{ u_rm: 'member' }, /Üyeler dizi olmalı/], [['u_rm'], /Üye kaydı geçersiz/]]) {
      r = await C.A.sync([put('workspaces', 'ws_r', { ...w2, members }, w2)]);
      assert.match(reasons(r)[0] || '', msg, JSON.stringify(members));
    }
    /* Dolu listeyi boşaltmak (alanı herkese açmak) Yönetici/üyeye kapalı. */
    const r2 = await row('workspaces', 'ws_r2');
    assert.equal((await C.V.sync([put('workspaces', 'ws_r2', { ...r2, members: [] }, r2)])).json.applied, 0);
    assert.deepEqual(w2.members, (await row('workspaces', 'ws_r')).members);
  });

  test('alan üyeleri ve rolleri: yalnız alan Yöneticisi (sahip dahil) ya da sistem yöneticisi değiştirir; sahipliği yalnız sistem yöneticisi devreder', async () => {
    const w = await row('workspaces', 'ws_r');
    const add = { ...w, members: [...w.members, { userId: 'u_rx', role: 'viewer' }] };
    for (const k of [C.M, C.V, C.X, C.G]) assert.equal((await k.sync([put('workspaces', 'ws_r', add, w)])).json.applied, 0);
    rej(await C.M.sync([put('workspaces', 'ws_r', add, w)]), WSE);
    /* Yetkisiz kişi üye doğrulamasına ulaşmaz (kişi var/yok bilgisi sızmaz): 403 */
    rej(await C.X.sync([put('workspaces', 'ws_r', { ...w, members: [{ userId: 'u_yok', role: 'member' }] }, w)]), WSE);
    ok(await C.Y.sync([put('workspaces', 'ws_r', add, w)]));
    const w2 = await row('workspaces', 'ws_r');
    assert.ok(w2.members.some(m => m.userId === 'u_rx' && m.role === 'viewer'));
    ok(await C.O.sync([put('workspaces', 'ws_r', { ...w2, members: w2.members.filter(m => m.userId !== 'u_rx'), description: 'sahip düzenledi' }, w2)]));
    const w3 = await row('workspaces', 'ws_r');
    assert.equal(w3.description, 'sahip düzenledi');
    /* Sahiplik: Yönetici/sahip ownerId'yi değiştiremez (yok sayılır); sistem yöneticisi devreder. */
    const r = await C.Y.sync([put('workspaces', 'ws_r', { ...w3, ownerId: 'u_ry' }, w3)]);
    assert.equal(r.json.applied, 0);
    assert.equal((await row('workspaces', 'ws_r')).ownerId, 'u_ro');
    rej(await C.A.sync([put('workspaces', 'ws_r', { ...w3, ownerId: 'u_yok' }, w3)]), 'Alan sahibi bulunamadı ya da pasif');
    ok(await C.A.sync([put('workspaces', 'ws_r', { ...w3, ownerId: 'u_rx' }, w3)]));
    const w4 = await row('workspaces', 'ws_r');
    assert.equal(w4.ownerId, 'u_rx');
    assert.ok(w4.members.some(m => m.userId === 'u_rx' && m.role === 'admin'));    // yeni sahip otomatik Yönetici
    assert.ok(w4.members.some(m => m.userId === 'u_ro' && m.role === 'admin'));    // eski sahip Yönetici olarak kalır
    /* Geri al (sonraki testler): sahip u_ro, u_rx listede yok. */
    ok(await C.A.sync([put('workspaces', 'ws_r', { ...w4, ownerId: 'u_ro', members: w4.members.filter(m => m.userId !== 'u_rx') }, w4)]));
    assert.equal((await row('workspaces', 'ws_r')).members.some(m => m.userId === 'u_rx'), false);
  });

  test('alan Üyesi: iş açar/düzenler, kendi süresini ve yorumunu yazar, sprint açar; tasarım (kolon, tür, proje ayarı/üyeleri, özel alan, alan) 403', async () => {
    const M = C.M;
    ok(await M.sync([iss('i_rm1', 'pr'), put('worklogs', 'w_rm1', { issueId: 'i_r1', userId: 'u_rm', date: '2026-11-02', hours: 1 }),
      put('comments', 'c_rm1', { issueId: 'i_r1', userId: 'u_rm', body: 'yorum' }),
      put('sprints', 'sp_rm1', { projectId: 'pr', name: 'S1', state: 'future' })]));
    const i = await row('issues', 'i_r1');
    ok(await M.sync([put('issues', 'i_r1', { ...i, summary: 'üye düzenledi' }, i)]));
    rej(await M.sync([put('statuses', 'pr_s2', { projectId: 'pr', name: 'Yeni kolon', cat: 'todo', ord: 2 })]), 'Kolonları yalnızca alan yöneticisi değiştirebilir');
    const p = await row('projects', 'pr');
    rej(await M.sync([put('projects', 'pr', { ...p, name: 'Ele geçirildi' }, p)]), DES);
    rej(await M.sync([put('projects', 'pr', { ...p, type: 'agile' }, p)]), DES);
    rej(await M.sync([put('projects', 'pr', { ...p, members: [] }, p)]), DES);
    rej(await M.sync([put('projects', 'pr', { ...p, archived: true }, p)]), DES);
    rej(await M.sync([put('projects', 'pr_yeni', { name: 'Yeni', key: 'PRY', workspaceId: 'ws_r' })]), DES);
    rej(await M.sync([put('fields', 'f_rm', { projectId: 'pr', key: 'x', name: 'X', type: 'text' })]), 'Bu değişiklik için yönetici yetkisi gerekli');
    const w = await row('workspaces', 'ws_r');
    rej(await M.sync([put('workspaces', 'ws_r', { ...w, name: 'Benim alanım' }, w)]), WSE);
    /* Yalnız iş sayacı değişen proje kaydı (iş açarken) Üyeye açık. */
    ok(await M.sync([put('projects', 'pr', { ...p, counter: (p.counter || 0) + 5 }, p)]));
    /* Başkası adına süre yine yalnız sistem yöneticisi. */
    rej(await M.sync([put('worklogs', 'w_rm2', { issueId: 'i_r1', userId: 'u_ry', date: '2026-11-02', hours: 1 })]), 'Başkasının süre kaydını yalnızca yönetici değiştirebilir');
  });

  test('alan İzleyicisi salt okunur; rol alanlar arasında ayrı (bir alanda İzleyici, ötekinde Üye)', async () => {
    rej(await C.V.sync([iss('i_rv1', 'pr')]), RO);
    const i = await row('issues', 'i_r1');
    rej(await C.V.sync([put('issues', 'i_r1', { ...i, summary: 'izci' }, i)]), RO);
    rej(await C.V.sync([put('comments', 'c_rv1', { issueId: 'i_r1', userId: 'u_rv', body: 'x' })]), RO);
    rej(await C.V.sync([put('worklogs', 'w_rv1', { issueId: 'i_r1', userId: 'u_rv', date: '2026-11-02', hours: 1 })]), RO);
    rej(await C.V.sync([put('sprints', 'sp_rv1', { projectId: 'pr', name: 'S', state: 'future' })]), RO);
    rej(await C.V.sync([{ c: 'issues', id: 'i_r1', op: 'del' }]), RO);
    /* ws_r2'de Üye: yazar. M ise ws_r2'de İzleyici. */
    ok(await C.V.sync([iss('i_rv2', 'pr2'), put('worklogs', 'w_rv2', { issueId: 'i_r2', userId: 'u_rv', date: '2026-11-02', hours: 2 })]));
    rej(await C.M.sync([iss('i_rm2', 'pr2')]), RO);
    /* İşi erişimli alandan salt okunur alana taşıyamaz. */
    const mi = await row('issues', 'i_rm1');
    rej(await C.M.sync([put('issues', 'i_rm1', { ...mi, projectId: 'pr2', statusId: 'pr2_s0' }, mi)]), RO);
    /* Genel rolü İzleyici olan kişi alanda Üye ise yazar. */
    ok(await C.G.sync([iss('i_rg1', 'pr'), put('comments', 'c_rg1', { issueId: 'i_rg1', userId: 'u_rg', body: 'g' })]));
  });

  test('alanda olmayan kişi: o alanın işine, yorumuna, süresine, geçmişine, bağlantısına, sprintine yazamaz (403)', async () => {
    const X = C.X;
    rej(await X.sync([iss('i_rx1', 'pr')]), NO);
    rej(await X.sync([put('worklogs', 'w_rx1', { issueId: 'i_r1', userId: 'u_rx', date: '2026-11-02', hours: 1 })]), NO);
    rej(await X.sync([put('comments', 'c_rx1', { issueId: 'i_r1', userId: 'u_rx', body: 'x' })]), NO);
    rej(await X.sync([put('history', 'h_rx1', { issueId: 'i_r1', userId: 'u_rx', at: Date.now(), field: 'summary', from: 'a', to: 'b' })]), NO);
    rej(await X.sync([put('links', 'l_rx1', { from: 'i_r1', to: 'i_r2', type: 'blocks' })]), NO);
    rej(await X.sync([put('sprints', 'sp_rx1', { projectId: 'pr', name: 'S', state: 'future' })]), NO);
    rej(await X.sync([put('statuses', 'pr_s9', { projectId: 'pr', name: 'X', cat: 'todo', ord: 9 })]), NO);
    const p = await row('projects', 'pr');
    rej(await X.sync([put('projects', 'pr', { ...p, name: 'X' }, p)]), NO);
    /* Erişimi olmayan alana proje taşıyamaz ya da açamaz. */
    ok(await X.sync([put('projects', 'p_rx', { name: 'Dış', key: 'DIS', workspaceId: 'ws1' })]));
    const px = await row('projects', 'p_rx');
    rej(await X.sync([put('projects', 'p_rx', { ...px, workspaceId: 'ws_r' }, px)]), NO);
    rej(await X.sync([put('projects', 'p_rx2', { name: 'Dış 2', key: 'DS2', workspaceId: 'ws_r' })]), NO);
  });

  test('alan Yöneticisi: kolon, tür, proje ayarı/üyeleri, projeye özel alan, yeni proje, alan düzenle/arşivle; genel alan, kural, proje silme ve başka alan 403', async () => {
    const Y = C.Y;
    ok(await Y.sync([put('statuses', 'pr_s2', { projectId: 'pr', name: 'İncelemede', cat: 'inprogress', ord: 2 })]));
    const p = await row('projects', 'pr');
    ok(await Y.sync([put('projects', 'pr', { ...p, name: 'Rol projesi (yeni)', type: 'agile', members: ['u_admin', 'u_ry'] }, p)]));
    assert.equal((await row('projects', 'pr')).type, 'agile');
    ok(await Y.sync([put('fields', 'f_ry', { projectId: 'pr', key: 'ry', name: 'Alan', type: 'text' })]));
    rej(await Y.sync([put('fields', 'f_ryg', { key: 'ryg', name: 'Genel', type: 'text' })]), 'Bu değişiklik için yönetici yetkisi gerekli');
    rej(await Y.sync([put('rules', 'r_ry', { projectId: 'pr', name: 'kural' })]), 'Bu değişiklik için yönetici yetkisi gerekli');
    ok(await Y.sync([put('projects', 'pr_y', { name: 'Yön. projesi', key: 'PRY', counter: 0, workspaceId: 'ws_r' })]));
    rej(await Y.sync([{ c: 'projects', id: 'pr_y', op: 'del' }]), 'Bu değişiklik için yönetici yetkisi gerekli');
    rej(await Y.sync([put('projects', 'pr_y2', { name: 'Öteki alanda', key: 'PY2', workspaceId: 'ws_r2' })]), NO);
    const py = await row('projects', 'pr_y');
    rej(await Y.sync([put('projects', 'pr_y', { ...py, workspaceId: 'ws_r2' }, py)]), NO);
    const w = await row('workspaces', 'ws_r');
    ok(await Y.sync([put('workspaces', 'ws_r', { ...w, name: 'Rol alanı (Y)', archived: true }, w)]));
    const w2 = await row('workspaces', 'ws_r');
    ok(await Y.sync([put('workspaces', 'ws_r', { ...w2, name: 'Rol alanı', archived: false }, w2)]));
    rej(await Y.sync([{ c: 'workspaces', id: 'ws_r', op: 'del' }]), 'Bu değişiklik için yönetici yetkisi gerekli');
    /* Proje üye listesinde olmasa da alan yöneticisi kolonları yönetir; Üye listede olsa da yönetemez. */
    const p2 = await row('projects', 'pr');
    ok(await C.O.sync([put('projects', 'pr', { ...p2, members: ['u_rm'] }, p2)]));
    ok(await Y.sync([put('statuses', 'pr_s2', { projectId: 'pr', name: 'İnceleme', cat: 'inprogress', ord: 2 })]));
    rej(await C.M.sync([put('statuses', 'pr_s2', { projectId: 'pr', name: 'Üye', cat: 'inprogress', ord: 2 })]), 'Kolonları yalnızca alan yöneticisi değiştirebilir');
  });

  test('sistem yöneticisi her alanda sınırsız (listede olmasa da)', async () => {
    const A = C.A;
    const p = await row('projects', 'pr2');
    ok(await A.sync([iss('i_ra1', 'pr2'), put('statuses', 'pr2_s2', { projectId: 'pr2', name: 'Ara', cat: 'inprogress', ord: 2 }),
      put('projects', 'pr2', { ...p, name: 'Yön. değiştirdi' }, p), put('fields', 'f_ra', { projectId: 'pr2', key: 'ra', name: 'A', type: 'text' }),
      put('worklogs', 'w_ra', { issueId: 'i_r2', userId: 'u_rv', date: '2026-11-03', hours: 1 })]));
    const w = await row('workspaces', 'ws_r2');
    ok(await A.sync([put('workspaces', 'ws_r2', { ...w, members: [] }, w)]));     // listeyi boşaltmak: sistem yöneticisi
    assert.deepEqual((await row('workspaces', 'ws_r2')).members, []);                 // boş liste: eski davranış (genel rol)
  });

  test('üye listesi tanımsız (eski) alan: genel rol geçerli (bugünkü davranış)', async () => {
    /* Genel (ws1) üyesiz: alanda olmayan genel Üye iş açar, kolon/proje değiştirir (proje üye listesi boşsa); genel İzleyici yazamaz. */
    ok(await C.X.sync([iss('i_rl1', 'p1', { statusId: 'p1_s0' })]));
    ok(await C.A.sync([put('projects', 'p_rl', { name: 'Eski alan', key: 'RLE', workspaceId: 'ws1' }),
      put('statuses', 'p_rl_s0', { projectId: 'p_rl', name: 'Yapılacak', cat: 'todo', ord: 0 })]));
    ok(await C.X.sync([put('statuses', 'p_rl_s1', { projectId: 'p_rl', name: 'Bitti', cat: 'done', ord: 1 })]));
    const pl = await row('projects', 'p_rl');
    ok(await C.X.sync([put('projects', 'p_rl', { ...pl, name: 'Eski alan (Üye)' }, pl)]));
    rej(await C.G.sync([iss('i_rl2', 'p_rl', { statusId: 'p_rl_s0' })]), 'salt okunur kullanıcı');
    /* Eski alanda projeye özel alan yine yalnız sistem yöneticisi. */
    rej(await C.X.sync([put('fields', 'f_rl', { projectId: 'p_rl', key: 'rl', name: 'R', type: 'text' })]), 'Bu değişiklik için yönetici yetkisi gerekli');
  });

  test('proje adı/ayarı: üyeli alanda yalnız alan Yöneticisi; eski alanda projenin üye listesindeki Üye (canDesign), listede olmayan 403', async () => {
    /* üyeli alan: Üye ve İzleyici adı değiştiremez, alan Yöneticisi ve sahip değiştirir */
    let p = await row('projects', 'pr');
    rej(await C.M.sync([put('projects', 'pr', { ...p, name: 'Üye adı' }, p)]), DES);
    rej(await C.V.sync([put('projects', 'pr', { ...p, description: 'x' }, p)]), DES);
    ok(await C.Y.sync([put('projects', 'pr', { ...p, name: 'Rol projesi (Y)' }, p)]));
    p = await row('projects', 'pr');
    ok(await C.O.sync([put('projects', 'pr', { ...p, name: 'Rol projesi' }, p)]));
    /* eski (üyesiz) alan: proje listesi dolu → listede olmayan Üye ad/ayar değiştiremez, kendini de ekleyemez */
    ok(await C.A.sync([put('projects', 'p_rl2', { name: 'Eski liste', key: 'RLL', counter: 0, workspaceId: 'ws1', members: ['u_rm'] })]));
    const q = await row('projects', 'p_rl2');
    rej(await C.X.sync([put('projects', 'p_rl2', { ...q, name: 'Yabancı adı' }, q)]), 'Projeyi yalnızca alan yöneticisi değiştirebilir');
    rej(await C.X.sync([put('projects', 'p_rl2', { ...q, archived: true }, q)]), 'Projeyi yalnızca alan yöneticisi değiştirebilir');
    rej(await C.X.sync([put('projects', 'p_rl2', { ...q, members: ['u_rm', 'u_rx'], name: 'Yabancı adı' }, q)]),
      'Proje üyelerini yalnızca alan yöneticisi değiştirebilir');
    assert.equal((await row('projects', 'p_rl2')).name, 'Eski liste');
    ok(await C.M.sync([put('projects', 'p_rl2', { ...q, name: 'Eski liste (Üye)' }, q)]));
    /* yalnız sayaç (iş açarken) yine serbest */
    const q2 = await row('projects', 'p_rl2');
    ok(await C.X.sync([put('projects', 'p_rl2', { ...q2, counter: (q2.counter || 0) + 1 }, q2)]));
  });

  test('hızlı kişi ekleme: alan Yöneticisi, sahip ve Üye 403 (yalnız sistem yöneticisi)', async () => {
    ok(await C.A.sync([put('customers', 'c_rl', { name: 'Rol Carisi', kind: 'customer' })]));
    for (const k of [C.Y, C.M, C.O]) assert.equal((await k.req('POST', '/api/customers/c_rl/contacts', { name: 'Kişi' })).status, 403);
    assert.equal((await C.A.req('POST', '/api/customers/c_rl/contacts', { name: 'Kişi' })).status, 200);
  });
});

/* Okuma süzmesi (18): her kullanıcı yalnız rolü olduğu alanların verisini alır (ilk yükleme ve değişiklik akışı);
   sistem yöneticisi her şeyi görür; üyelik değişince etkilenen kullanıcıya tam yeniden yükleme sinyali gider. */
describe('okuma süzmesi', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const put = (c, id, data, base) => ({ c, id, op: 'put', data, ...(base ? { base } : {}) });
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  const ids = (d, c) => (d[c] || []).map(x => x.id);
  const changes = async (k, since) => (await k.req('GET', `/api/changes?since=${since}`)).json;
  const seq = async () => Number((await pool.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
  const C = {};
  const newUser = async (id, username, role = 'member') => {
    ok(await C.A.sync([put('users', id, { username, name: username, role, active: true })]));
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'OkumaYeni123' })).status, 200);
    return k;
  };
  /* Gizli alan (ws_ob) kayıtları: hiçbiri u_oa'ya gitmemeli. */
  const HIDDEN = { workspaces: ['ws_ob'], projects: ['pob'], statuses: ['pob_s0'], sprints: ['sp_ob'], issues: ['i_ob1'],
    worklogs: ['w_ob1'], comments: ['c_ob1'], history: ['h_ob1'], links: ['l_ob1'], fields: ['f_ob'] };

  before(async () => {
    C.A = client(); await C.A.login('admin', 'test-admin-pw');
    C.U = await newUser('u_oa', 'okuyan');       // ws_oa üyesi, ws_ob'de yok
    C.B = await newUser('u_ob', 'obsahip');      // ws_ob üyesi
    ok(await C.A.sync([
      put('workspaces', 'ws_oa', { name: 'Okuma A', members: [{ userId: 'u_oa', role: 'member' }] }),
      put('workspaces', 'ws_ob', { name: 'Okuma B', members: [{ userId: 'u_ob', role: 'member' }] }),
      put('projects', 'poa', { name: 'Okuma A projesi', key: 'POA', counter: 0, workspaceId: 'ws_oa' }),
      put('projects', 'pob', { name: 'Okuma B projesi', key: 'POB', counter: 0, workspaceId: 'ws_ob' }),
      put('statuses', 'poa_s0', { projectId: 'poa', name: 'Yapılacak', cat: 'todo', ord: 0 }),
      put('statuses', 'pob_s0', { projectId: 'pob', name: 'Yapılacak', cat: 'todo', ord: 0 }),
      put('sprints', 'sp_ob', { projectId: 'pob', name: 'S1', state: 'future' }),
      put('issues', 'i_oa1', { projectId: 'poa', key: 'POA-1', summary: 'görünen', statusId: 'poa_s0' }),
      put('issues', 'i_ob1', { projectId: 'pob', key: 'POB-1', summary: 'gizli iş', statusId: 'pob_s0' }),
      put('worklogs', 'w_ob1', { issueId: 'i_ob1', userId: 'u_admin', date: '2026-11-02', hours: 1 }),
      put('comments', 'c_ob1', { issueId: 'i_ob1', userId: 'u_admin', body: 'gizli yorum' }),
      put('history', 'h_ob1', { issueId: 'i_ob1', field: 'summary', from: 'a', to: 'b' }),
      put('links', 'l_ob1', { from: 'i_ob1', to: 'i_ob1', type: 'relates' }),
      put('fields', 'f_ob', { projectId: 'pob', key: 'gizli', name: 'Gizli alan', type: 'text' }),
    ]));
  });

  test('ilk yükleme: üye başka alanın projesini, işini, süre kaydını, yorumunu, geçmişini görmez; admin görür', async () => {
    const d = (await C.U.state()).json.data;
    for (const [c, list] of Object.entries(HIDDEN)) for (const id of list) assert.ok(!ids(d, c).includes(id), `${c}/${id} sızdı`);
    assert.ok(ids(d, 'projects').includes('poa')); assert.ok(ids(d, 'issues').includes('i_oa1'));
    assert.ok(ids(d, 'workspaces').includes('ws_oa'));
    assert.ok(!JSON.stringify(d).includes('gizli yorum'));
    /* Proje bağımsız tablolar olduğu gibi: kullanıcı listesi. */
    assert.ok(ids(d, 'users').includes('u_ob'));
    const a = (await C.A.state()).json.data;
    for (const [c, list] of Object.entries(HIDDEN)) for (const id of list) assert.ok(ids(a, c).includes(id), `admin ${c}/${id} görmüyor`);
    const b = (await C.B.state()).json.data;
    assert.ok(ids(b, 'issues').includes('i_ob1')); assert.ok(!ids(b, 'issues').includes('i_oa1'));
  });

  test('değişiklik akışı: başka alandaki yeni iş/süre/yorum üyeye gitmez; kendi alanındaki gider; admin hepsini alır', async () => {
    const s0 = await seq();
    ok(await C.B.sync([
      put('issues', 'i_ob2', { projectId: 'pob', key: 'POB-2', summary: 'gizli iş 2', statusId: 'pob_s0' }),
      put('worklogs', 'w_ob2', { issueId: 'i_ob1', userId: 'u_ob', date: '2026-11-03', hours: 2 }),
      put('comments', 'c_ob2', { issueId: 'i_ob1', userId: 'u_ob', body: 'gizli yorum 2' })]));
    ok(await C.A.sync([put('issues', 'i_oa2', { projectId: 'poa', key: 'POA-2', summary: 'görünen 2', statusId: 'poa_s0' })]));
    const ch = await changes(C.U, s0);
    assert.ok(!ch.reload);
    const got = ch.items.filter(i => i.op === 'put').map(i => `${i.c}/${i.id}`);
    for (const k of ['issues/i_ob2', 'worklogs/w_ob2', 'comments/c_ob2', 'issues/i_ob1', 'projects/pob']) assert.ok(!got.includes(k), `${k} sızdı`);
    assert.ok(got.includes('issues/i_oa2'));
    assert.ok(!JSON.stringify(ch).includes('gizli'));
    const ca = await changes(C.A, s0);
    const ga = ca.items.map(i => `${i.c}/${i.id}`);
    for (const k of ['issues/i_ob2', 'worklogs/w_ob2', 'comments/c_ob2', 'issues/i_oa2']) assert.ok(ga.includes(k), `admin ${k} almadı`);
    /* Okunamayan şey yazılamaz da: gizli işe yorum 403. */
    const r = await C.U.sync([put('comments', 'c_oa_x', { issueId: 'i_ob1', userId: 'u_oa', body: 'x' })]);
    assert.deepEqual(r.json.rejected.map(x => x.reason), ['Bu çalışma alanına erişiminiz yok']);
  });

  test('üyeliğe eklenince yeniden yükleme sinyali gelir ve alanın verisi görünür; çıkarılınca yine sinyal ve veri kaybolur', async () => {
    const s0 = await seq();
    const w = await row('workspaces', 'ws_ob');
    ok(await C.A.sync([put('workspaces', 'ws_ob', { ...w, members: [...w.members, { userId: 'u_oa', role: 'viewer' }] }, w)]));
    const ch = await changes(C.U, s0);
    assert.equal(ch.reload, true); assert.equal(ch.access, true); assert.deepEqual(ch.items, []);
    /* Erişimi değişmeyen kullanıcı ve admin sinyal almaz. */
    assert.ok(!(await changes(C.B, s0)).reload);
    assert.ok(!(await changes(C.A, s0)).reload);
    let d = (await C.U.state()).json.data;
    for (const [c, list] of Object.entries(HIDDEN)) for (const id of list) assert.ok(ids(d, c).includes(id), `eklenince ${c}/${id} yok`);
    assert.ok(ids(d, 'worklogs').includes('w_ob2'));
    /* Artık değişiklik akışında da gelir. */
    const s1 = await seq();
    ok(await C.B.sync([put('comments', 'c_ob3', { issueId: 'i_ob1', userId: 'u_ob', body: 'artık görünür' })]));
    assert.ok((await changes(C.U, s1)).items.some(i => i.c === 'comments' && i.id === 'c_ob3'));
    /* Çıkarılınca: sinyal, veri yok. */
    const s2 = await seq();
    const w2 = await row('workspaces', 'ws_ob');
    ok(await C.A.sync([put('workspaces', 'ws_ob', { ...w2, members: w2.members.filter(m => m.userId !== 'u_oa') }, w2)]));
    assert.equal((await changes(C.U, s2)).reload, true);
    d = (await C.U.state()).json.data;
    for (const [c, list] of Object.entries(HIDDEN)) for (const id of list) assert.ok(!ids(d, c).includes(id), `çıkarılınca ${c}/${id} sızdı`);
    /* Yalnız rol değişimi (görünürlük aynı) sinyal üretmez. */
    const s3 = await seq();
    const w3 = await row('workspaces', 'ws_ob');
    ok(await C.A.sync([put('workspaces', 'ws_ob', { ...w3, members: w3.members.map(m => m.userId === 'u_ob' ? { ...m, role: 'viewer' } : m) }, w3)]));
    assert.ok(!(await changes(C.B, s3)).reload);
  });

  test('proje başka alana taşınınca yeniden yükleme sinyali; yönetici yapılan kullanıcı her şeyi görür', async () => {
    const s0 = await seq();
    const p = await row('projects', 'pob');
    ok(await C.A.sync([put('projects', 'pob', { ...p, workspaceId: 'ws_oa' }, p)]));
    assert.equal((await changes(C.U, s0)).reload, true);
    let d = (await C.U.state()).json.data;
    assert.ok(ids(d, 'issues').includes('i_ob1'));
    const p2 = await row('projects', 'pob');
    ok(await C.A.sync([put('projects', 'pob', { ...p2, workspaceId: 'ws_ob' }, p2)]));
    d = (await C.U.state()).json.data;
    assert.ok(!ids(d, 'issues').includes('i_ob1'));
    /* Genel rol yönetici: sinyal ve tam veri. */
    const s1 = await seq();
    const u = (await C.A.state()).json.data.users.find(x => x.id === 'u_oa');
    ok(await C.A.sync([put('users', 'u_oa', { ...u, role: 'admin' })]));
    assert.equal((await changes(C.U, s1)).reload, true);
    d = (await C.U.state()).json.data;
    for (const [c, list] of Object.entries(HIDDEN)) for (const id of list) assert.ok(ids(d, c).includes(id), `yönetici ${c}/${id} görmüyor`);
    ok(await C.A.sync([put('users', 'u_oa', { ...u, role: 'member' })]));
    assert.ok(!ids((await C.U.state()).json.data, 'issues').includes('i_ob1'));
  });
});

/* Genel test/güvenlik turu düzeltmeleri: atama alan rolüne bağlı, bildirim süzmesi, alanlar arası proje taşıma,
   aktif sprintten çıkış, `_` ile başlayan koleksiyonlar, bağlantının iki ucu. */
describe('genel tur düzeltmeleri', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const rej = (r, reason) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected.map(x => x.reason), [reason]); };
  const put = (c, id, data, base) => ({ c, id, op: 'put', data, ...(base ? { base } : {}) });
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  let N = 0;
  const iss = (id, pid, extra = {}) => put('issues', id, { projectId: pid, key: `${pid.toUpperCase()}-${++N}`, summary: `iş ${id}`, statusId: `${pid}_s0`, ...extra });
  const seq = async () => Number((await pool.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
  const AS = 'Atanan kişinin bu çalışma alanında Üye ya da Yönetici rolü yok';
  const MV = 'Projeyi başka alana yalnızca iki alanın da yöneticisi taşıyabilir';
  const NO = 'Bu çalışma alanına erişiminiz yok';
  const C = {};
  const newUser = async (id, username, role = 'member') => {
    ok(await C.A.sync([put('users', id, { username, name: username, role, active: true })]));
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'GenelTur123' })).status, 200);
    return k;
  };

  before(async () => {
    C.A = client(); await C.A.login('admin', 'test-admin-pw');
    C.Y = await newUser('u_gy', 'gtyon');     // ws_g1 ve ws_g2'de Yönetici, ws_g3'te Üye
    C.M = await newUser('u_gm', 'gtuye');     // ws_g1'de Üye, ws_g2'de İzleyici
    C.V = await newUser('u_gv', 'gtizci');    // ws_g1'de İzleyici
    C.X = await newUser('u_gx', 'gtdis');     // hiçbir üyeli alanda yok
    ok(await C.A.sync([
      put('workspaces', 'ws_g1', { name: 'GT 1', members: [{ userId: 'u_gy', role: 'admin' }, { userId: 'u_gm', role: 'member' }, { userId: 'u_gv', role: 'viewer' }] }),
      put('workspaces', 'ws_g2', { name: 'GT 2', members: [{ userId: 'u_gy', role: 'admin' }, { userId: 'u_gm', role: 'viewer' }] }),
      put('workspaces', 'ws_g3', { name: 'GT 3', members: [{ userId: 'u_gy', role: 'member' }] }),
      ...['pg1', 'pg2', 'pg3', 'pgl'].flatMap((id, n) => [
        put('projects', id, { name: `GT proje ${id}`, key: id.toUpperCase(), counter: 0, workspaceId: ['ws_g1', 'ws_g2', 'ws_g3', 'ws1'][n], members: n < 3 ? ['u_admin'] : undefined }),
        put('statuses', `${id}_s0`, { projectId: id, name: 'Yapılacak', cat: 'todo', ord: 0 }),
        put('statuses', `${id}_s1`, { projectId: id, name: 'Bitti', cat: 'done', ord: 1 })]),
      iss('i_g1', 'pg1'), iss('i_g2', 'pg2'), iss('i_g3', 'pg3'), iss('i_gl', 'pgl'),
    ]));
  });

  test('atama: üyeli alanda yalnız Yönetici/Üye rolü olan kişiye; alan dışı ve izleyici 400; eski alanda bugünkü kural', async () => {
    let i = await row('issues', 'i_g1');
    rej(await C.Y.sync([put('issues', 'i_g1', { ...i, assignee: 'u_gx' }, i)]), AS);
    rej(await C.Y.sync([put('issues', 'i_g1', { ...i, assignee: 'u_gv' }, i)]), AS);
    rej(await C.M.sync([iss('i_g1b', 'pg1', { assignee: 'u_gx' })]), AS);
    ok(await C.Y.sync([put('issues', 'i_g1', { ...i, assignee: 'u_gm' }, i)]));
    ok(await C.M.sync([iss('i_g1c', 'pg1', { assignee: 'u_gy' })]));
    /* Sistem yöneticisi her alanda Yönetici sayılır. */
    i = await row('issues', 'i_g1c');
    ok(await C.Y.sync([put('issues', 'i_g1c', { ...i, assignee: 'u_admin' }, i)]));
    /* Eski (üyesiz) alan: alanda olmayan genel Üye atanabilir. */
    const l = await row('issues', 'i_gl');
    ok(await C.X.sync([put('issues', 'i_gl', { ...l, assignee: 'u_gm' }, l)]));
    /* Başka alana taşınınca orada Üye/Yönetici rolü olmayan atanan boşalır (sunucu düzeltir). */
    i = await row('issues', 'i_g1');
    const r = ok(await C.Y.sync([put('issues', 'i_g1', { ...i, projectId: 'pg2', statusId: 'pg2_s0' }, i)]));
    assert.deepEqual(r.json.adjusted, [{ c: 'issues', id: 'i_g1' }]);
    const moved = await row('issues', 'i_g1');
    assert.equal(moved.projectId, 'pg2'); assert.equal(moved.assignee, null);
    ok(await C.Y.sync([put('issues', 'i_g1', { ...moved, projectId: 'pg1', statusId: 'pg1_s0' }, moved)]));
  });

  test('bildirim: erişimi olmayan işin anahtarı, başlığı, projesi ve yorum özeti boş döner', async () => {
    const i = await row('issues', 'i_g1');
    ok(await C.Y.sync([put('issues', 'i_g1', { ...i, assignee: 'u_gm', summary: 'GİZLİ başlık' }, i)]));
    ok(await C.Y.sync([put('comments', 'c_g1', { issueId: 'i_g1', userId: 'u_gy', body: 'GİZLİ yorum' })]));
    const list = async k => (await k.req('GET', '/api/notifications')).json.items.filter(n => n.issue_id === 'i_g1');
    let n = await list(C.M);
    assert.ok(n.some(x => x.kind === 'assigned' && x.issue_key && x.summary === 'GİZLİ başlık'), JSON.stringify(n));
    assert.ok(n.some(x => x.kind === 'comment' && x.meta.excerpt === 'GİZLİ yorum'));
    const w = await row('workspaces', 'ws_g1');
    ok(await C.A.sync([put('workspaces', 'ws_g1', { ...w, members: w.members.filter(m => m.userId !== 'u_gm') }, w)]));
    n = await list(C.M);
    assert.ok(n.length >= 2);
    assert.ok(!JSON.stringify(n).includes('GİZLİ'), JSON.stringify(n));
    assert.ok(n.every(x => x.issue_key === '' && x.summary === '' && x.project_id === null));
    /* Geri eklenince yine görünür. */
    const w2 = await row('workspaces', 'ws_g1');
    ok(await C.A.sync([put('workspaces', 'ws_g1', { ...w2, members: [...w2.members, { userId: 'u_gm', role: 'member' }] }, w2)]));
    assert.ok((await list(C.M)).some(x => x.summary === 'GİZLİ başlık'));
  });

  test('proje taşıma: iki alanda da alan yöneticisi gerekir; eski (üyesiz) alan işin içindeyse yalnız sistem yöneticisi', async () => {
    let p = await row('projects', 'pg2');
    rej(await C.M.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws_g1' }, p)]), 'Bu değişiklik için alan yöneticisi yetkisi gerekli');
    rej(await C.Y.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws_g3' }, p)]), 'Bu değişiklik için alan yöneticisi yetkisi gerekli');
    rej(await C.Y.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws1' }, p)]), MV);
    const pl = await row('projects', 'pgl');
    rej(await C.Y.sync([put('projects', 'pgl', { ...pl, workspaceId: 'ws_g1' }, pl)]), MV);
    rej(await C.X.sync([put('projects', 'pgl', { ...pl, workspaceId: 'ws_g1' }, pl)]), NO);
    /* Alan değişmeyen düzenleme (eski alanda Üye) etkilenmez. */
    ok(await C.X.sync([put('projects', 'pgl', { ...pl, name: 'GT eski (X)' }, pl)]));
    assert.equal((await row('projects', 'pgl')).workspaceId, 'ws1');
    ok(await C.Y.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws_g1' }, p)]));
    p = await row('projects', 'pg2');
    ok(await C.Y.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws_g2' }, p)]));
    p = await row('projects', 'pg2');
    ok(await C.A.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws1' }, p)]));
    p = await row('projects', 'pg2');
    ok(await C.A.sync([put('projects', 'pg2', { ...p, workspaceId: 'ws_g2' }, p)]));
  });

  test('aktif sprint: geri çekme, tamamlama ve silme yalnız alan yöneticisi; aktif olmayanı Üye siler', async () => {
    ok(await C.Y.sync([put('sprints', 'sp_g', { projectId: 'pg1', name: 'S', state: 'active' }),
      put('sprints', 'sp_gf', { projectId: 'pg1', name: 'S2', state: 'future' })]));
    const s = await row('sprints', 'sp_g');
    const F = 'Sprinti yalnızca alan yöneticisi başlatıp bitirebilir';
    rej(await C.M.sync([put('sprints', 'sp_g', { ...s, state: 'future' }, s)]), F);
    rej(await C.M.sync([put('sprints', 'sp_g', { ...s, state: 'closed' }, s)]), F);
    rej(await C.M.sync([{ c: 'sprints', id: 'sp_g', op: 'del' }]), 'Aktif sprinti yalnızca alan yöneticisi silebilir');
    assert.equal((await row('sprints', 'sp_g')).state, 'active');
    /* Aktif sprintin adını Üye değiştirir; aktif olmayan sprinti siler. */
    ok(await C.M.sync([put('sprints', 'sp_g', { ...s, name: 'S yeni' }, s)]));
    ok(await C.M.sync([{ c: 'sprints', id: 'sp_gf', op: 'del' }]));
    const s2 = await row('sprints', 'sp_g');
    ok(await C.Y.sync([put('sprints', 'sp_g', { ...s2, state: 'future' }, s2)]));
    ok(await C.Y.sync([put('sprints', 'sp_g', { ...s2, state: 'active' })]));
    ok(await C.Y.sync([{ c: 'sprints', id: 'sp_g', op: 'del' }]));
  });

  test('`_` ile başlayan koleksiyon istemciden yazılamaz (`_prefs`, `_settings` hariç); `_access` sinyali taklit edilemez', async () => {
    const s0 = await seq();
    const r = await C.X.sync([put('_access', 'u_gm', { x: 1 }), put('_gizli', 'a', { x: 1 }), { c: '_access', id: 'u_gm', op: 'del' }]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(r.json.rejected.map(x => x.reason), ['geçersiz koleksiyon', 'geçersiz koleksiyon', 'geçersiz koleksiyon']);
    const ch = (await C.M.req('GET', `/api/changes?since=${s0}`)).json;
    assert.ok(!ch.reload, JSON.stringify(ch));
    assert.equal((await pool.query(`SELECT count(*) n FROM misc_records WHERE collection LIKE '\\_%'`)).rows[0].n, '0');
    /* Eski sürümde yazılmış `_` kaydı durumda görünmez. */
    await pool.query(`INSERT INTO misc_records (collection, id, data) VALUES ('_access','u_gm','{"id":"u_gm","x":1}')`);
    assert.equal((await C.M.state()).json.data._access, undefined);
    await pool.query(`DELETE FROM misc_records WHERE collection='_access'`);
    /* Meşru adlar çalışır. */
    ok(await C.X.sync([{ c: '_prefs', id: 'ui', op: 'put', data: { theme: 'dark' } }]));
    ok(await C.A.sync([{ c: '_settings', id: 'gtAyar', op: 'put', data: { a: 1 } }]));
    ok(await C.A.sync([{ c: '_settings', id: 'gtAyar', op: 'del' }]));
  });

  test('bağlantı: iki uç da var olan iş; `to` ucuna erişim gerekir; aynı gönderimde işten önce gelen bağlantı da yazılır', async () => {
    const E = 'Bağlantının işi bulunamadı';
    rej(await C.X.sync([put('links', 'l_g0', { from: 'i_yok', to: 'i_g1', type: 'blocks' })]), E);
    rej(await C.A.sync([put('links', 'l_g0', { from: 'i_yok', to: 'i_g1', type: 'blocks' })]), E);
    rej(await C.M.sync([put('links', 'l_g1', { from: 'i_g1', to: 'i_yok', type: 'blocks' })]), E);
    rej(await C.M.sync([put('links', 'l_g2', { from: 'i_g1', to: 'i_g3', type: 'blocks' })]), NO);   // ws_g3'te rolü yok
    rej(await C.M.sync([put('links', 'l_g3', { from: 'i_g2', to: 'i_g1', type: 'blocks' })]), 'Bu çalışma alanında yalnızca görüntüleme yetkiniz var');
    ok(await C.M.sync([put('links', 'l_g4', { from: 'i_g1', to: 'i_g2', type: 'relates' })]));         // ws_g2'de İzleyici: hedef olur
    const l = await row('links', 'l_g4');
    ok(await C.M.sync([put('links', 'l_g4', { ...l, type: 'blocks' }, l)]));
    rej(await C.M.sync([put('links', 'l_g4', { ...l, to: 'i_g3' }, l)]), NO);
    ok(await C.M.sync([put('links', 'l_g5', { from: 'i_g1', to: 'i_g1d', type: 'blocks' }), iss('i_g1d', 'pg1')]));
  });
});

describe('düşük bulgular (güvenlik raporu)', { skip: !URL && 'TEST_DATABASE_URL yok' }, () => {
  const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected, []); return r; };
  const rej = (r, reason) => { assert.equal(r.status, 200, JSON.stringify(r.json)); assert.deepEqual(r.json.rejected.map(x => x.reason), [reason]); };
  const put = (c, id, data, base) => ({ c, id, op: 'put', data, ...(base ? { base } : {}) });
  const row = async (table, id) => (await pool.query(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data;
  let N = 0;
  const iss = (id, pid, extra = {}) => put('issues', id, { projectId: pid, key: `${pid.toUpperCase()}-${++N}`, summary: `iş ${id}`, statusId: `${pid}_s0`, ...extra });
  const seq = async () => Number((await pool.query('SELECT coalesce(max(seq),0) AS s FROM changes')).rows[0].s);
  const hist = async iid => (await pool.query(`SELECT data FROM history WHERE issue_id=$1 AND data->>'field'='Atanan' ORDER BY ord`, [iid])).rows.map(r => r.data);
  const C = {};
  const newUser = async (id, username, role = 'member') => {
    ok(await C.A.sync([put('users', id, { username, name: 'Kişi ' + username, role, active: true })]));
    const k = client(); await k.login(username, 'Start12345');
    assert.equal((await k.req('POST', '/api/auth/password', { newPassword: 'DusukBul123' })).status, 200);
    return k;
  };
  const setMembers = async (who, ws, fn) => { const w = await row('workspaces', ws); return who.sync([put('workspaces', ws, { ...w, members: fn(w.members || []) }, w)]); };

  before(async () => {
    C.A = client(); await C.A.login('admin', 'test-admin-pw');
    C.Y = await newUser('u_dy', 'dyon');      // ws_d1, ws_d2: Yönetici
    C.M = await newUser('u_dm', 'duye');      // ws_d1, ws_d2: Üye
    C.K = await newUser('u_dk', 'dkisi');     // ws_d1: Üye (çıkarılacak); ws_d2'de yok
    ok(await C.A.sync([
      put('workspaces', 'ws_d1', { name: 'DB 1', members: [{ userId: 'u_dy', role: 'admin' }, { userId: 'u_dm', role: 'member' }, { userId: 'u_dk', role: 'member' }] }),
      put('workspaces', 'ws_d2', { name: 'DB 2', members: [{ userId: 'u_dy', role: 'admin' }, { userId: 'u_dm', role: 'member' }] }),
      put('workspaces', 'ws_d3', { name: 'DB 3 (eski)' }),
      ...['pd1', 'pd2', 'pd3'].flatMap((id, n) => [
        put('projects', id, { name: `DB proje ${id}`, key: id.toUpperCase(), counter: 0, workspaceId: ['ws_d1', 'ws_d2', 'ws_d3'][n] }),
        put('statuses', `${id}_s0`, { projectId: id, name: 'Yapılacak', cat: 'todo', ord: 0 }),
        put('statuses', `${id}_s1`, { projectId: id, name: 'Bitti', cat: 'done', ord: 1 })]),
    ]));
  });

  test('alandan çıkarılan kişinin atandığı işler boşalır (geçmişe yazılır); rolü kalanlar ve sistem yöneticisi kalır', async () => {
    ok(await C.Y.sync([iss('i_d1', 'pd1', { assignee: 'u_dk' }), iss('i_d2', 'pd1', { assignee: 'u_dm' }), iss('i_d3', 'pd1', { assignee: 'u_admin' })]));
    const s0 = await seq();
    const r = ok(await setMembers(C.Y, 'ws_d1', m => m.filter(x => x.userId !== 'u_dk')));
    assert.ok(r.json.adjusted.some(x => x.c === 'issues' && x.id === 'i_d1'), JSON.stringify(r.json.adjusted));
    assert.equal((await row('issues', 'i_d1')).assignee, null);
    assert.equal((await row('issues', 'i_d2')).assignee, 'u_dm');
    assert.equal((await row('issues', 'i_d3')).assignee, 'u_admin');
    const h = await hist('i_d1');
    assert.equal(h.length, 1); assert.equal(h[0].from, 'Kişi dkisi'); assert.equal(h[0].to, '—'); assert.equal(h[0].userId, 'u_dy');
    /* Değişiklik akışı: işi ve geçmişi diğer üyeler alır. */
    const items = (await C.M.req('GET', `/api/changes?since=${s0}`)).json.items;
    assert.ok(items.some(i => i.c === 'issues' && i.id === 'i_d1' && i.data.assignee === null), JSON.stringify(items));
    assert.ok(items.some(i => i.c === 'history' && i.data?.issueId === 'i_d1'));
    /* Rolü düşürülen (İzleyici) kişi erişimini korur: ataması boşalmaz. */
    ok(await setMembers(C.Y, 'ws_d1', m => [...m, { userId: 'u_dk', role: 'member' }]));
    const i1 = await row('issues', 'i_d1');
    ok(await C.Y.sync([put('issues', 'i_d1', { ...i1, assignee: 'u_dk' }, i1)]));
    ok(await setMembers(C.Y, 'ws_d1', m => m.map(x => x.userId === 'u_dk' ? { ...x, role: 'viewer' } : x)));
    assert.equal((await row('issues', 'i_d1')).assignee, 'u_dk');
    ok(await setMembers(C.Y, 'ws_d1', m => m.map(x => x.userId === 'u_dk' ? { ...x, role: 'member' } : x)));
  });

  test('proje başka alana taşınınca orada rolü olmayan atanan boşalır; eski alan üye listesine geçince de', async () => {
    ok(await C.Y.sync([iss('i_d4', 'pd1', { assignee: 'u_dk' }), iss('i_d5', 'pd1', { assignee: 'u_dm' })]));
    let p = await row('projects', 'pd1');
    const r = ok(await C.Y.sync([put('projects', 'pd1', { ...p, workspaceId: 'ws_d2' }, p)]));
    assert.ok(r.json.adjusted.some(x => x.c === 'issues' && x.id === 'i_d4'));
    assert.equal((await row('issues', 'i_d4')).assignee, null);
    assert.equal((await row('issues', 'i_d5')).assignee, 'u_dm');
    assert.equal((await hist('i_d4')).length, 1);
    p = await row('projects', 'pd1');
    ok(await C.Y.sync([put('projects', 'pd1', { ...p, workspaceId: 'ws_d1' }, p)]));
    /* Eski (üyesiz) alan: herkes atanabilir; üye listesi tanımlanınca listede olmayanın ataması boşalır. */
    ok(await C.K.sync([iss('i_d6', 'pd3', { assignee: 'u_dk' }), iss('i_d7', 'pd3', { assignee: 'u_dm' })]));
    ok(await setMembers(C.A, 'ws_d3', () => [{ userId: 'u_dm', role: 'member' }]));
    assert.equal((await row('issues', 'i_d6')).assignee, null);
    assert.equal((await row('issues', 'i_d7')).assignee, 'u_dm');
  });

  test('@bahsetme ve yorum bildirimi yalnız işin alanına erişimi olana', async () => {
    ok(await C.Y.sync([iss('i_d8', 'pd1', { reporter: 'u_dk' })]));
    ok(await setMembers(C.Y, 'ws_d1', m => m.filter(x => x.userId !== 'u_dk')));
    const count = async (u, kind) => Number((await pool.query(`SELECT count(*) n FROM notifications WHERE user_id=$1 AND issue_id='i_d8' AND kind=$2`, [u, kind])).rows[0].n);
    ok(await C.M.sync([put('comments', 'c_d1', { issueId: 'i_d8', userId: 'u_dm', body: '@dkisi @dyon bakar mısınız' })]));
    assert.equal(await count('u_dk', 'mention'), 0);
    assert.equal(await count('u_dk', 'comment'), 0);            // raporlayan ama erişimi yok
    assert.equal(await count('u_dy', 'mention'), 1);
    /* Geri eklenince (İzleyici bile olsa) yine bildirim alır. */
    ok(await setMembers(C.Y, 'ws_d1', m => [...m, { userId: 'u_dk', role: 'viewer' }]));
    ok(await C.M.sync([put('comments', 'c_d2', { issueId: 'i_d8', userId: 'u_dm', body: '@dkisi tekrar' })]));
    assert.equal(await count('u_dk', 'mention'), 1);
    ok(await setMembers(C.Y, 'ws_d1', m => m.map(x => x.userId === 'u_dk' ? { ...x, role: 'member' } : x)));
  });

  test('sprint: kapalı duruma her geçiş ve kapalıdan çıkış alan yöneticisinde (başlamamış sprint ve yeni kayıt dahil)', async () => {
    const F = 'Sprinti yalnızca alan yöneticisi başlatıp bitirebilir';
    ok(await C.M.sync([put('sprints', 'sp_d1', { projectId: 'pd1', name: 'D1', state: 'future' })]));
    const s = await row('sprints', 'sp_d1');
    rej(await C.M.sync([put('sprints', 'sp_d1', { ...s, state: 'closed' }, s)]), F);
    rej(await C.M.sync([put('sprints', 'sp_d2', { projectId: 'pd1', name: 'D2', state: 'closed' })]), F);
    assert.equal(await row('sprints', 'sp_d2'), undefined);
    assert.equal((await row('sprints', 'sp_d1')).state, 'future');
    ok(await C.Y.sync([put('sprints', 'sp_d1', { ...s, state: 'closed' }, s)]));
    const c = await row('sprints', 'sp_d1');
    rej(await C.M.sync([put('sprints', 'sp_d1', { ...c, state: 'future' }, c)]), F);
    /* Kapalı sprintte durum dışı düzenleme Üyede serbest. */
    ok(await C.M.sync([put('sprints', 'sp_d1', { ...c, name: 'D1 yeni' }, c)]));
    const c2 = await row('sprints', 'sp_d1');
    ok(await C.Y.sync([put('sprints', 'sp_d1', { ...c2, state: 'future' }, c2)]));
    ok(await C.M.sync([{ c: 'sprints', id: 'sp_d1', op: 'del' }]));
  });

  test('misc koleksiyonu beyaz liste: rastgele ad ve tercih/ayar adları reddedilir (yönetici dahil); eski kayıtlar okunur', async () => {
    const names = ['notlar', 'ui', 'cfg', 'board', 'open', 'yeniDizi'];
    for (const k of [C.A, C.M]) {
      const r = await k.sync([...names.map(c => put(c, 'x1', { a: 1 })), ...names.map(c => ({ c, id: 'x1', op: 'del' }))]);
      assert.equal(r.status, 200); assert.equal(r.json.applied, 0);
      assert.equal(r.json.rejected.length, names.length * 2);
      assert.ok(r.json.rejected.every(x => x.reason === 'geçersiz koleksiyon'), JSON.stringify(r.json.rejected));
    }
    assert.equal((await pool.query(`SELECT count(*) n FROM misc_records WHERE collection = ANY($1)`, [names])).rows[0].n, '0');
    const st = (await C.M.state()).json.data;
    assert.ok(!Array.isArray(st.ui) && !Array.isArray(st.cfg) && st.notlar === undefined);
    /* Beyaz listedeki ad yazılır; listede olsa da tercih ve ayar adı reddedilir. */
    ok(await C.A.sync([put('_settings', 'dAyar', { a: 1 })]));
    MISC_COLLECTIONS.push('dNot', 'ui', 'dAyar');
    try {
      ok(await C.M.sync([put('dNot', 'n1', { a: 1 })]));
      rej(await C.M.sync([put('ui', 'n1', { a: 1 })]), 'geçersiz koleksiyon');
      rej(await C.A.sync([put('dAyar', 'n1', { a: 1 })]), 'geçersiz koleksiyon');
      assert.equal((await C.M.state()).json.data.dNot[0].a, 1);
      ok(await C.M.sync([{ c: 'dNot', id: 'n1', op: 'del' }]));
    } finally { MISC_COLLECTIONS.length = 0; await C.A.sync([{ c: '_settings', id: 'dAyar', op: 'del' }]); }
    /* Eski sürümün misc_records'a yazdığı dizi okunmaya devam eder (okuma tarafı aynı). */
    await pool.query(`INSERT INTO misc_records (collection, id, data) VALUES ('eskiDizi','e1','{"id":"e1","a":2}')`);
    try { assert.equal((await C.M.state()).json.data.eskiDizi[0].a, 2); }
    finally { await pool.query(`DELETE FROM misc_records WHERE collection='eskiDizi'`); }
  });

  test('anahtarsız yeni iş: sunucu proje anahtarı + sonraki numarayı verir, sayacı ilerletir; anahtarlı ve eski anahtarsız iş değişmez', async () => {
    const r1 = ok(await C.M.sync([put('issues', 'i_dk1', { projectId: 'pd2', summary: 'anahtarsız', statusId: 'pd2_s0' })]));
    assert.ok(r1.json.adjusted.some(x => x.c === 'issues' && x.id === 'i_dk1'), JSON.stringify(r1.json));
    const k1 = (await row('issues', 'i_dk1')).key;
    assert.match(k1, /^PD2-\d+$/);
    assert.equal(Number((await row('projects', 'pd2')).counter), Number(k1.split('-')[1]));
    ok(await C.M.sync([put('issues', 'i_dk2', { projectId: 'pd2', key: 'PD2-50', summary: 'anahtarlı', statusId: 'pd2_s0' })]));
    assert.equal((await row('issues', 'i_dk2')).key, 'PD2-50');
    ok(await C.M.sync([put('issues', 'i_dk3', { projectId: 'pd2', key: '', summary: 'boş anahtar', statusId: 'pd2_s0' })]));
    assert.equal((await row('issues', 'i_dk3')).key, 'PD2-51');
    assert.equal(Number((await row('projects', 'pd2')).counter), 51);
    /* Anahtarı olmayan eski iş düzenlenince anahtar almaz (bugünkü davranış). */
    await pool.query(`INSERT INTO issues (id, data) VALUES ('i_dk4', '{"id":"i_dk4","projectId":"pd2","summary":"eski","statusId":"pd2_s0"}'::jsonb)`);
    const old = await row('issues', 'i_dk4');
    ok(await C.M.sync([put('issues', 'i_dk4', { ...old, summary: 'eski 2' }, old)]));
    assert.equal((await row('issues', 'i_dk4')).key, undefined);
  });
});
