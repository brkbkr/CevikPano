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
});
