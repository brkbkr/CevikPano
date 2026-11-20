// "İşi izle" tarayıcı testi: iş ayrıntısında İzle / İzlemeyi bırak, izleyen sayısı ve kişiler, proje Yöneticisinin
// başkasını eklemesi/çıkarması, izleyicilere giden bildirimler ve Benim işlerim → İzlediklerim sekmesi.
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/isi-izle.cjs  (BASE_URL ile adres, SHOT ile ekran görüntüsü yolu değiştirilebilir).
// Test kendi kullanıcılarını, projesini ve işlerini oluşturur; diğer tarayıcı testlerinden sonra da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SHOT = process.env.SHOT || require('os').tmpdir() + '/pano_izle.png';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PW = 'Baslangic123', NPW = 'IzleYeni123';
const U = { y: 'u_izy' + RUN, m: 'u_izm' + RUN, v: 'u_izv' + RUN, x: 'u_izx' + RUN };
const P = 'p_iz' + RUN, I1 = 'i_iz1' + RUN, I2 = 'i_iz2' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) {
      await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800);
    }
  };
  const open = async (p, id) => { await p.evaluate(id => { closeModal(); closeModal(); openIssue(id); }, id); await sleep(300); };
  const sync = async p => { await p.evaluate(async () => { await flushAll(); await poll(); await poll(); }); await sleep(150); };
  const btn = p => p.evaluate(() => { const b = document.getElementById('idWatch');
    return b ? { on: b.classList.contains('on'), pressed: b.getAttribute('aria-pressed'), n: b.querySelector('.num')?.textContent, lbl: b.querySelector('.lbl')?.textContent,
      aria: b.getAttribute('aria-label') } : null; });
  const menu = p => p.evaluate(() => { const m = document.querySelector('.qm.wlist');
    return m ? { rows: [...m.querySelectorAll('[data-wid]')].map(r => ({ id: r.dataset.wid, rm: !!r.querySelector('[data-qv^="rm:"]') })),
      add: [...m.querySelectorAll('[data-qv^="add:"]')].map(x => x.dataset.qv.slice(4)), self: m.querySelector('[data-qv="me"]')?.textContent.trim() || '',
      search: !!m.querySelector('.qm-in'), head: m.querySelector('.qm-h:nth-of-type(1)')?.textContent || '' } : null; });
  const srv = (p, id) => p.evaluate(async id => (await API.get('/api/state')).data.issues.find(i => i.id === id), id);
  const notifs = (p, iid) => p.evaluate(async iid => (await API.get('/api/notifications')).items.filter(n => n.issue_id === iid).map(n => n.kind), iid);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* Kişiler: Y proje Yöneticisi, M Üye, V İzleyici (adında XSS), X projede yok. İş I1: açan admin, atanan M. */
  const setup = await A.evaluate(async ([R, U, P, I1, I2, XSS, PW]) => {
    const r1 = await API.post('/api/sync', { changes: [
      { c: 'users', id: U.y, op: 'put', data: { username: 'izy' + R, name: 'İz Yönetici ' + R, role: 'member', active: true, ini: 'İY', color: '#7C3AED' } },
      { c: 'users', id: U.m, op: 'put', data: { username: 'izm' + R, name: 'İz Üye ' + R, role: 'member', active: true, ini: 'İÜ', color: '#0F766E' } },
      { c: 'users', id: U.v, op: 'put', data: { username: 'izv' + R, name: 'İz İzci ' + XSS, role: 'member', active: true, ini: 'İİ', color: '#B45309' } },
      { c: 'users', id: U.x, op: 'put', data: { username: 'izx' + R, name: 'İz Dışarıda ' + R, role: 'member', active: true, ini: 'İD', color: '#64748B' } },
      { c: 'projects', id: P, op: 'put', data: { key: 'IZ' + R.toUpperCase().replace(/[^A-Z]/g, 'Q'), name: 'İzleme ' + R, counter: 0, workspaceId: 'ws1',
        roles: { [U.y]: 'admin', [U.m]: 'member', [U.v]: 'viewer' } } },
      { c: 'statuses', id: P + '_s0', op: 'put', data: { projectId: P, name: 'Yapılacak', cat: 'todo', ord: 0 } },
      { c: 'statuses', id: P + '_s1', op: 'put', data: { projectId: P, name: 'Sürüyor', cat: 'inprogress', ord: 1 } },
      { c: 'statuses', id: P + '_s2', op: 'put', data: { projectId: P, name: 'Bitti', cat: 'done', ord: 2 } },
    ] });
    const r2 = await API.post('/api/sync', { changes: [
      { c: 'issues', id: I1, op: 'put', data: { projectId: P, summary: 'İzlenecek iş ' + R, statusId: P + '_s0', type: 'task', reporter: ME.id, assignee: U.m, priority: 3 } },
      { c: 'issues', id: I2, op: 'put', data: { projectId: P, summary: 'Diğer iş ' + R, statusId: P + '_s0', type: 'task', reporter: ME.id, assignee: null, priority: 3 } },
    ] });
    return [r1.rejected, r2.rejected];
  }, [RUN, U, P, I1, I2, XSS, PW]);
  ok('setup', setup.every(x => !x.length), JSON.stringify(setup));

  const V = await mk('izci'); await login(V, 'izv' + RUN, PW, NPW);
  const M = await mk('uye'); await login(M, 'izm' + RUN, PW, NPW);
  const Y = await mk('yonetici'); await login(Y, 'izy' + RUN, PW, NPW);
  for (const p of [V, M, Y]) await p.evaluate(P => { DB.ui.project = P; save(); startApp(false); }, P);
  await sleep(500);

  // 1) İzleyici rolündeki kişi: düğme, sayı (açan + atanan), kendini ekler; başkasını çıkaramaz, kişi ekleyemez
  await open(V, I1);
  let s = await btn(V);
  ok('watch button shown to viewer, not watching, 2 watchers (reporter + assignee)', s && !s.on && s.pressed === 'false' && s.n === '2' && s.lbl === 'İzle', JSON.stringify(s));
  await V.click('#idWatch'); await sleep(200);
  let mm = await menu(V);
  ok('viewer menu: İzle option, 2 rows, no remove for others, no add/search', mm && /^İzle/.test(mm.self) && mm.rows.length === 2
    && mm.rows.every(r => !r.rm) && !mm.add.length && !mm.search, JSON.stringify(mm));
  await V.click('.qm.wlist [data-qv="me"]'); await sleep(250);
  s = await btn(V);
  ok('viewer starts watching: button on, count 3, label İzleniyor', s.on && s.pressed === 'true' && s.n === '3' && s.lbl === 'İzleniyor' && !(await V.$('.qm.wlist')), JSON.stringify(s));
  await sync(V);
  ok('server stored watcher (viewer, watchers only change)', ((await srv(A, I1)).watchers || []).includes(U.v), JSON.stringify((await srv(A, I1)).watchers));
  await V.click('#idWatch'); await sleep(200);
  mm = await menu(V);
  ok('own row has remove button (sen)', mm.rows.some(r => r.id === U.v && r.rm) && mm.rows.filter(r => r.id !== U.v).every(r => !r.rm), JSON.stringify(mm));
  ok('XSS in watcher name not executed', !(await V.evaluate(() => window.__xss)) && await V.evaluate(() => !document.querySelector('.qm.wlist img')));
  await V.screenshot({ path: SHOT });
  await V.keyboard.press('Escape'); await sleep(150);

  // 2) Benim işlerim → İzlediklerim
  await V.evaluate(() => { closeModal(); DB.ui.view = 'home'; DB.ui.homeTab = 'mine'; render(); }); await sleep(250);
  ok('home: tabs shown, Bana atananlar default, I1 not in mine', await V.evaluate(I1 => !!document.querySelector('[data-hmtab="watch"]')
    && document.querySelector('[data-hmtab="mine"]').getAttribute('aria-selected') === 'true' && !document.querySelector(`[data-hmrow="${I1}"]`), I1));
  await V.click('[data-hmtab="watch"]'); await sleep(250);
  ok('İzlediklerim lists watched open issue', await V.evaluate(([I1, I2]) => !!document.querySelector(`[data-hmrow="${I1}"]`) && !document.querySelector(`[data-hmrow="${I2}"]`)
    && document.querySelector('[data-hmtab="watch"]').getAttribute('aria-selected') === 'true' && DB.ui.homeTab === 'watch'
    && document.querySelector('[data-hmtab="watch"] .n').textContent === '1', [I1, I2]));

  // 3) İzleyiciye bildirimler: Üye durum + öncelik + bitiş değiştirir
  await sync(M);
  await M.evaluate(([I1, P]) => { const i = issue(I1); setStatus(i, P + '_s1'); setPriority(i, 1); i.due = '2026-12-31'; i.updatedAt = Date.now(); save(); }, [I1, P]);
  await sync(M); await sleep(300);
  let nv = await notifs(V, I1);
  ok('viewer (watcher) got status, priority, due notifications', ['status', 'priority', 'due'].every(k => nv.includes(k)), JSON.stringify(nv));
  ok('actor gets no notification for own change', !(await notifs(M, I1)).some(k => ['status', 'priority', 'due'].includes(k)));
  await V.evaluate(() => openNotifications()); await sleep(600);
  const ntext = await V.evaluate(I1 => [...document.querySelectorAll(`#notifPop .notif[data-iss="${I1}"] .nt > span:first-child`)].map(x => x.textContent), I1);
  ok('notification texts (önceliği Acil, bitiş tarihini 31 Ara 2026)', ntext.some(t => /önceliği Acil yaptı/.test(t)) && ntext.some(t => /bitiş tarihini .*31 Ara 2026.* yaptı/.test(t))
    && ntext.some(t => /durumu Sürüyor yaptı/.test(t)), JSON.stringify(ntext));
  await V.evaluate(() => document.getElementById('notifPop')?.remove());

  // 4) Proje Yöneticisi: başkasını ekler/çıkarır; kişi ekleme listesi yalnız projede rolü olanlar
  await sync(Y); await open(Y, I1);
  await Y.click('#idWatch'); await sleep(200);
  mm = await menu(Y);
  ok('project admin menu: add list (role holders only), remove on every row, search', mm.search && mm.add.includes(U.y) && !mm.add.includes(U.x)
    && !mm.add.includes(U.v) && mm.rows.every(r => r.rm), JSON.stringify(mm));
  await Y.click(`.qm.wlist [data-qv="rm:${U.m}"]`); await sleep(300);
  mm = await menu(Y);
  ok('admin removed assignee from watchers, menu stays open', mm && !mm.rows.some(r => r.id === U.m) && mm.add.includes(U.m), JSON.stringify(mm));
  await Y.fill('.qm.wlist .qm-in', 'İz Üye'); await sleep(150);
  mm = await menu(Y);
  ok('search filters add list', mm.add.length === 1 && mm.add[0] === U.m, JSON.stringify(mm));
  await Y.click(`.qm.wlist [data-qv="add:${U.m}"]`); await sleep(300);
  await Y.keyboard.press('Escape'); await sleep(100);
  await sync(Y);
  ok('server: admin re-added member', ((await srv(A, I1)).watchers || []).includes(U.m));

  // 5) Üye başkasını çıkaramaz (arayüzde düğme yok; sunucu da reddeder)
  await sync(M); await open(M, I1);
  await M.click('#idWatch'); await sleep(200);
  mm = await menu(M);
  ok('member: no add list, remove only on own row', !mm.add.length && !mm.search && mm.rows.filter(r => r.rm).map(r => r.id).join() === U.m, JSON.stringify(mm));
  await M.keyboard.press('Escape');
  const forced = await M.evaluate(async ([I1, V]) => { const i = (await API.get('/api/state')).data.issues.find(x => x.id === I1);
    const r = await API.post('/api/sync', { changes: [{ c: 'issues', id: I1, op: 'put', data: { ...i, watchers: i.watchers.filter(x => x !== V) }, base: i }] });
    return r.rejected.map(x => x.reason); }, [I1, U.v]);
  ok('server rejects member removing someone else', forced.join() === 'Başka kişileri izleyici olarak yalnızca proje yöneticisi ekleyip çıkarabilir', JSON.stringify(forced));

  // 6) Yorum yapan izler; İzlemeyi bırakan bildirim almaz
  await open(M, I2);
  ok('member not watching I2 (no assignee, admin opened)', !(await btn(M)).on);
  await M.click('#newCmt'); await M.fill('#newCmt', 'Bakıyorum'); await M.click('#addCmt'); await sleep(250);
  ok('commenting makes you a watcher (button on)', (await btn(M)).on);
  await sync(M);
  ok('server: commenter is watcher', ((await srv(A, I2)).watchers || []).includes(U.m));
  await sync(V); await open(V, I1);
  await V.click('#idWatch'); await sleep(200);
  await V.click('.qm.wlist [data-qv="me"]'); await sleep(250);
  s = await btn(V);
  ok('viewer stops watching', !s.on && s.lbl === 'İzle', JSON.stringify(s));
  await sync(V);
  await M.evaluate(I1 => { const i = issue(I1); i.due = '2027-01-15'; i.updatedAt = Date.now(); save(); }, I1);
  await sync(M); await sleep(300);
  nv = await notifs(V, I1);
  ok('unwatched viewer gets no new due notification', nv.filter(k => k === 'due').length === 1, JSON.stringify(nv));
  await V.evaluate(() => { closeModal(); DB.ui.view = 'home'; render(); }); await sleep(250);
  ok('İzlediklerim empty state after unwatch', await V.evaluate(() => !!document.querySelector('[data-hmempty="watch"]')));

  // 7) Dar ekran: düğme görünür, sayı kalır
  const Mo = await mk('mobil', { width: 390, height: 800 }); await login(Mo, 'izy' + RUN, NPW);
  await Mo.evaluate(P => { DB.ui.project = P; save(); startApp(false); }, P); await sleep(400);
  await open(Mo, I1);
  ok('mobile: watch button visible with count', await Mo.evaluate(() => { const b = document.getElementById('idWatch'); const r = b?.getBoundingClientRect();
    return !!b && r.width > 0 && r.right <= innerWidth && b.querySelector('.num').offsetParent !== null; }));

  ok('no page errors', !errs.length, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
