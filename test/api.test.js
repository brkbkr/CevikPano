/* API testleri — gerçek bir PostgreSQL veritabanına karşı çalışır.
   TEST_DATABASE_URL tanımlı değilse atlanır. Veritabanı her çalıştırmada SIFIRLANIR.
   Örnek: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/pano_test npm test */
import { test, describe, before, after } from 'node:test';
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
  const r2 = await a.sync(good.map(id => ({ c: 'kimlikTesti', id, op: 'put', data: { a: 1 } })));
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

  test('oluşturma: açan kişi sunucuda yazılır (sahte createdBy düzeltilir), güncellemede korunur', async () => {
    let r = await U1.sync([ws('ws_a', { name: 'Ar-Ge', color: '#3E7BC4', description: 'açıklama', createdBy: 'u_admin' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.deepEqual(r.json.adjusted, [{ c: 'workspaces', id: 'ws_a' }]);
    let w = await row('workspaces', 'ws_a');
    assert.equal(w.created_by, 'u_ws1'); assert.equal(w.archived, false);
    r = await U1.sync([ws('ws_a', { ...w.data, description: 'yeni', createdBy: 'u_ws2' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.ok(r.json.adjusted.some(x => x.id === 'ws_a'));
    w = await row('workspaces', 'ws_a');
    assert.equal(w.created_by, 'u_ws1'); assert.equal(w.data.description, 'yeni');
    /* createdBy alanı gönderilmese de korunur. */
    const { createdBy, ...rest } = w.data;
    r = await U1.sync([ws('ws_a', { ...rest, color: '#1F6F5C' })]);
    assert.equal(r.json.applied, 1);
    assert.equal((await row('workspaces', 'ws_a')).created_by, 'u_ws1');
    assert.equal(createdBy, 'u_ws1');
    /* Yeni alanda doğru createdBy gönderilirse düzeltme bildirilmez. */
    r = await U1.sync([ws('ws_dogru', { name: 'Doğru açan', createdBy: 'u_ws1' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.deepEqual(r.json.adjusted, []);
  });

  test('ad: zorunlu, en fazla 60, etkin alanlarda Türkçe büyük/küçük harf ve boşluk duyarsız tekil', async () => {
    let r = await U1.sync([ws('ws_ik', { name: 'İnsan Kaynakları' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    for (const name of ['insan kaynakları', '  İNSAN   KAYNAKLARI ', 'İnsan Kaynakları']) {
      r = await U2.sync([ws('ws_ik2', { name })]);
      assert.equal(r.json.applied, 0, name);
      assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var'], name);
    }
    for (const name of ['', '   ', 'x'.repeat(61), 12, null, ['a']]) {
      r = await U2.sync([ws('ws_bad', { name })]);
      assert.equal(r.json.applied, 0, String(name));
      assert.match(reasons(r)[0], /Çalışma alanı adı gerekli/, String(name));
    }
    r = await U2.sync([ws('ws_60', { name: 'y'.repeat(60) })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* Kendi adını büyük/küçük harf değiştirerek güncellemek çakışma sayılmaz. */
    const ik = (await row('workspaces', 'ws_ik')).data;
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    /* Arşivli alanla aynı ad serbest; arşivden çıkarmada etkin adla çakışırsa reddedilir. */
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları', archived: true })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await U2.sync([ws('ws_ik2', { name: 'İnsan Kaynakları' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    r = await U1.sync([ws('ws_ik', { ...ik, name: 'insan kaynakları', archived: false })]);
    assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var']);
    assert.equal((await row('workspaces', 'ws_ik')).archived, true);
    /* Başka bir etkin alanın adına yeniden adlandırma da reddedilir. */
    r = await U2.sync([ws('ws_60', { ...(await row('workspaces', 'ws_60')).data, name: 'ar-ge' })]);
    assert.deepEqual(reasons(r), ['Bu adla etkin bir çalışma alanı zaten var']);
  });

  test('ad tekilliği eşzamanlı oluşturmada da korunur', async () => {
    const [r1, r2] = await Promise.all([U1.sync([ws('ws_es1', { name: 'Eşzamanlı' })]), U2.sync([ws('ws_es2', { name: 'eşzamanlı' })])]);
    assert.equal(r1.json.applied + r2.json.applied, 1, JSON.stringify([r1.json, r2.json]));
    assert.equal((await pool.query(`SELECT count(*) n FROM workspaces WHERE id IN ('ws_es1','ws_es2')`)).rows[0].n, '1');
  });

  test('aynı kimlikle eşzamanlı oluşturma: ikincisi üzerine yazmaz (409), açan kişi değişmez', async () => {
    const [r1, r2] = await Promise.all([U1.sync([ws('ws_ayni', { name: 'Aynı kimlik' })]), U2.sync([ws('ws_ayni', { name: 'Aynı kimlik' })])]);
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    assert.equal(r1.json.applied + r2.json.applied, 1, JSON.stringify([r1.json, r2.json]));
    const winner = r1.json.applied ? 'u_ws1' : 'u_ws2';
    assert.equal((await row('workspaces', 'ws_ayni')).created_by, winner);
    /* Kesin yarış: ilk kayıt henüz onaylanmamışken ikinci oluşturma gelir → bekler, üzerine yazmaz. */
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO workspaces (id, data) VALUES ('ws_yaris', '{"id":"ws_yaris","name":"Yarış alanı","createdBy":"u_ws1"}')`);
      const pending = U2.sync([ws('ws_yaris', { name: 'Yarış alanı', description: 'ikinci' })]);
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
      ['Bu çalışma alanını yalnızca açan kişi ya da yönetici değiştirebilir']);
    await pool.query(`DELETE FROM workspaces WHERE id IN ('ws_ayni','ws_yaris')`);
  });

  test('doğrulama: renk HEX, açıklama ≤500, archived boolean (metin 500 değil ret)', async () => {
    const r = await U1.sync([
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
    const ok = await U1.sync([ws('ws_c4', { name: 'Renk 4', color: '#abc', description: '' }), ws('ws_c5', { name: 'Renk 5', color: '' })]);
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
    let r = await U1.sync([
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
    const r = await U1.sync([ws('ws_xss', { name })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    assert.equal((await A.state()).json.data.workspaces.find(x => x.id === 'ws_xss').name, name);
  });

  test('izleyici çalışma alanı açamaz, değiştiremez, proje taşıyamaz', async () => {
    const p1 = (await row('projects', 'p1')).data;
    const r = await V.sync([ws('ws_v', { name: 'İzleyici' }), ws('ws_a', { name: 'Değişti' }), { c: 'workspaces', id: 'ws_c4', op: 'del' },
      { c: 'projects', id: 'p1', op: 'put', data: { ...p1, workspaceId: 'ws_a' } }]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(reasons(r), Array(4).fill('salt okunur kullanıcı'));
    assert.equal(await row('workspaces', 'ws_v'), undefined);
  });

  test('başkasının alanını yalnız açan kişi ya da yönetici değiştirir/arşivler', async () => {
    const a = (await row('workspaces', 'ws_a')).data;
    const MSG = 'Bu çalışma alanını yalnızca açan kişi ya da yönetici değiştirebilir';
    let r = await U2.sync([ws('ws_a', { ...a, name: 'Ele geçirildi' }), ws('ws_a', { ...a, archived: true }),
      ws('ws_a', { ...a, createdBy: 'u_ws2' })]);
    assert.equal(r.json.applied, 0);
    assert.deepEqual(reasons(r), [MSG, MSG]);                           // createdBy denemesi değişiklik sayılmaz
    assert.equal((await row('workspaces', 'ws_a')).name, 'Ar-Ge');
    /* Değişmemiş kaydı yeniden göndermek reddedilmez (istemci gereksiz yeniden yükleme yapmasın). */
    r = await U2.sync([ws('ws_a', a)]);
    assert.deepEqual(r.json.rejected, []);
    r = await A.sync([ws('ws_a', { ...a, name: 'Ar-Ge Merkezi' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
    const w = await row('workspaces', 'ws_a');
    assert.equal(w.name, 'Ar-Ge Merkezi'); assert.equal(w.created_by, 'u_ws1');   // yönetici düzenlese de açan değişmez
    r = await U1.sync([ws('ws_a', { ...w.data, name: 'Ar-Ge' })]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  });

  test('Genel (ws1): arşivlenemez, silinemez, adını yalnız yönetici değiştirir', async () => {
    const g = (await row('workspaces', 'ws1')).data;
    let r = await A.sync([ws('ws1', { ...g, archived: true }), { c: 'workspaces', id: 'ws1', op: 'del' }]);
    assert.deepEqual(reasons(r), ['Genel çalışma alanı arşivlenemez', 'Genel çalışma alanı silinemez']);
    r = await U1.sync([ws('ws1', { ...g, name: 'Benim' })]);
    assert.deepEqual(reasons(r), ['Bu çalışma alanını yalnızca açan kişi ya da yönetici değiştirebilir']);
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
    assert.equal((await row('workspaces', 'ws_c5')).created_by, 'u_ws1');
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
    const r = await U2.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, workspaceId: 'ws_a' } }]);
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
    const r3 = await U1.sync([{ c: 'projects', id: 'p_alansiz', op: 'put', data: { name: 'Alansız', key: 'ALS', workspaceId: 'ws_a' } }]);
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
    /* Arşivli alandan etkin bir alana taşınabilir. */
    r = await U2.sync([{ c: 'projects', id: 'p_arsws', op: 'put', data: { ...ap, name: 'Yeni ad', workspaceId: 'ws1' } }]);
    assert.equal(r.json.applied, 1, JSON.stringify(r.json.rejected));
  });

  test('taşıma: eşzamanlı düzenlemede alan ve ad birleşir; eski hâlle gelen değişiklik taşımayı geri almaz', async () => {
    const p = (await row('projects', 'p_ts')).data;          // ws_a
    let r = await U1.sync([{ c: 'projects', id: 'p_ts', op: 'put', base: p, data: { ...p, workspaceId: 'ws_60' } }]);
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
    assert.equal(st2.workspaces.find(x => x.id === 'ws_a').createdBy, 'u_ws1');
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
      BEGIN IF NEW.collection = 'gunlukdeneme' THEN RAISE EXCEPTION 'deneme hatası' USING DETAIL = 'GIZLI-DETAY-12345678901'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER pano_test_hata BEFORE INSERT ON misc_records FOR EACH ROW EXECUTE FUNCTION pano_test_hata()`);
    const orig = console.error, lines = [];
    console.error = (...a) => lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x) + String(x?.stack || ''))).join(' '));
    try {
      const r = await A.sync([{ c: 'gunlukdeneme', id: 'g1', op: 'put', data: { a: 1 } }]);
      assert.equal(r.status, 500); assert.equal(r.json.error, 'Sunucu hatası');
    } finally {
      console.error = orig;
      await pool.query('DROP TRIGGER pano_test_hata ON misc_records; DROP FUNCTION pano_test_hata()');
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
    assert.deepEqual(reasons(r), Array(4).fill('Kolonları yalnızca yönetici ya da proje üyesi değiştirebilir'));
    assert.equal(r.json.applied, 0);
    assert.equal((await row('statuses', 'pk1_a')).name, 'Yapılacak');
    /* projesi olmayan kolon */
    assert.deepEqual(reasons(await N.sync([S('pk_yok_s', 'pk_yok', 'X')])), ['Durumun projesi yok']);
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
      ['Proje türünü yalnızca yönetici ya da proje üyesi değiştirebilir']);
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
    /* sprint tamamlanınca Agile→Pano kabul; Pano→Agile her zaman */
    ok(await M.sync([{ c: 'sprints', id: 'sp_k1', op: 'put', data: { projectId: 'pk_ag', name: 'S1', state: 'closed' } }]));
    ok(await M.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })]));
    ok(await M.sync([P('pk_ag', { type: 'agile', members: ['u_admin', 'u_k_m'] })]));
    ok(await M.sync([P('pk_ag', { type: 'board', members: ['u_admin', 'u_k_m'] })]));
  });

  test('türü açıkça Pano olan projede sprint başlatılamaz; türsüz (genel sprint kapalı) projede ve Agile\'da başlar', async () => {
    assert.equal((await pool.query(`SELECT value FROM settings WHERE key='cfg'`)).rows[0]?.value?.modules?.sprint, false);
    const r = await M.sync([{ c: 'sprints', id: 'sp_k3', op: 'put', data: { projectId: 'pk_ag', name: 'S3', state: 'active' } },
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
    ok(await M.sync([{ c: 'sprints', id: 'sp_k4', op: 'put', data: { projectId: 'pk_bos', name: 'S4', state: 'closed' } }]));
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
    ok(await M.sync([P('pk_wsp', { workspaceId: 'ws_k1', members: ['u_k_m'] }),
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

  test('işin kolonu işin projesine ait olmalı: başka projenin kolonu "Kolon bulunamadı"', async () => {
    assert.deepEqual(reasons(await M.sync([I('i_k9', 'pk1', 'pk_bos_a')])), ['Kolon bulunamadı']);
    assert.deepEqual(reasons(await M.sync([I('i_k10', 'pk1', 'pk_bos_a')])), ['Kolon bulunamadı']);
    assert.equal((await row('issues', 'i_k9')).statusId, 'pk1_a');
  });

  test('üye listesi: üye olmayan değiştiremez (403); üye ve yönetici değiştirir; boş listeye kendini ekleyebilir; yeni projede serbest', async () => {
    const pk1 = await row('projects', 'pk1');
    assert.deepEqual(reasons(await N.sync([P('pk1', { ...pk1, members: [...pk1.members, 'u_k_n'] })])),
      ['Proje üyelerini yalnızca yönetici ya da proje üyesi değiştirebilir']);
    assert.deepEqual((await row('projects', 'pk1')).members, ['u_admin', 'u_k_m']);
    ok(await N.sync([P('pk1', { ...pk1, name: 'pk1 yeni ad' })]));                // üye listesine dokunmayan düzenleme serbest
    ok(await M.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m', 'u_k_n'] })]));
    ok(await N.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m'] })]));      // artık üye: değiştirebilir
    ok(await A.sync([P('pk1', { ...pk1, members: ['u_admin', 'u_k_m'] })]));
    const bos = await row('projects', 'pk_bos');
    ok(await N.sync([P('pk_bos', { ...bos, members: ['u_k_n'] })]));               // liste boştu: kendini ekler
    assert.deepEqual(reasons(await M.sync([P('pk_bos', { ...bos, members: [] })])),
      ['Proje üyelerini yalnızca yönetici ya da proje üyesi değiştirebilir']);
    ok(await N.sync([P('pk_bos', { ...bos, members: [] })]));
    ok(await N.sync([P('pk_yeni_n', { members: ['u_admin'] })]));                  // yeni proje: serbest
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
