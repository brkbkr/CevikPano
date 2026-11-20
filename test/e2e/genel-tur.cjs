// Genel test/güvenlik turu düzeltmeleri tarayıcı testi. Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri);
// test kendi kullanıcılarını ve alanını oluşturur; diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: (Y1) üyeli alanda alan sayfasından açılan projede (proje üyelerine dokunmadan) atama menüsünde alanın
// Yönetici/Üye kişileri görünür, izleyici ve alan dışı görünmez; (D3) proje kartı üye çipleri yalnız alan üyeleri, sayı
// işaretli çiplerle aynı; (O1) alan dışına atama sunucuda reddedilir; (O2) alandan çıkarılan kişinin açık iş detayı
// kapanır, yazdığı metin için uyarı çıkar; (Güv O1) proje taşıma menüsü eski alanda alan yöneticisine görünmez.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_gt_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const Y = 'u_gty' + R, M = 'u_gtm' + R, V = 'u_gtv' + R, X = 'u_gtx' + R, WS = 'ws_gt' + R;

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw); await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) { await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800); }
  };
  const flush = p => p.evaluate(() => flushAll());
  const waitFor = async (p, fn, arg, ms = 10000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(200); } return false; };

  /* Kurulum: dört kişi ve üyeli alan (sahip: sistem yöneticisi; Y Yönetici, M Üye, V İzleyici; X yok). */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([R, Y, M, V, X, WS]) => {
    const u = (id, n) => ({ c: 'users', id, op: 'put', data: { username: n + R, name: n + ' ' + R, role: 'member', active: true } });
    await API.post('/api/sync', { changes: [u(Y, 'gty'), u(M, 'gtm'), u(V, 'gtv'), u(X, 'gtx'),
      { c: 'workspaces', id: WS, op: 'put', data: { name: 'Genel Tur ' + R, color: '#3E7BC4',
        members: [{ userId: Y, role: 'admin' }, { userId: M, role: 'member' }, { userId: V, role: 'viewer' }] } },
      { c: 'projects', id: 'p_gtl' + R, op: 'put', data: { name: 'GT Eski ' + R, key: 'GTL' + R.toUpperCase(), counter: 0, workspaceId: 'ws1', members: [Y], type: 'board' } },
      { c: 'statuses', id: 'p_gtl' + R + '_s0', op: 'put', data: { projectId: 'p_gtl' + R, name: 'Yapılacak', cat: 'todo', ord: 0 } },
      { c: 'statuses', id: 'p_gtl' + R + '_s1', op: 'put', data: { projectId: 'p_gtl' + R, name: 'Bitti', cat: 'done', ord: 1 } }] });
    await reloadState();
  }, [R, Y, M, V, X, WS]);

  /* Y1: alan sayfasından + Proje → Scrum → üyelere dokunmadan Oluştur */
  await A.evaluate(ws => openWsPage(ws), WS); await sleep(400);
  await A.click(`[data-wspage="${WS}"] [data-wsnewproj="${WS}"]`); await sleep(300);
  await A.click('#ps_next'); await sleep(200);
  ok('+ Proje preselects the workspace', await A.evaluate(ws => document.querySelector('#np_ws')?.value === ws, WS));
  await A.fill('#np_n', 'GT Proje ' + R); await A.click('#np_ok'); await sleep(400); await flush(A);
  const PID = await A.evaluate(n => DB.projects.find(p => p.name === n)?.id, 'GT Proje ' + R);
  const pm = await A.evaluate(pid => DB.projects.find(p => p.id === pid)?.members, PID);
  ok('new project in member workspace; project members untouched (only creator)', !!PID && JSON.stringify(pm) === '["u_admin"]', JSON.stringify(pm));
  const IID = 'i_gt' + R;
  await A.evaluate(async ([pid, iid]) => {
    const p = DB.projects.find(x => x.id === pid), s = DB.statuses.find(x => x.projectId === pid && x.cat === 'todo');
    p.counter = (p.counter || 0) + 1;
    DB.issues.push({ id: iid, projectId: pid, key: p.key + '-' + p.counter, summary: 'Genel tur işi', type: 'task', statusId: s.id, priority: 3,
      reporter: SESSION, assignee: null, created: Date.now(), labels: [], cf: {} });
    save(); await flushAll();
  }, [PID, IID]);

  /* yetki-v2: kişiler projeye proje rolüyle eklenir (Yetkiler sekmesi); proje kartı projenin kişilerini gösterir */
  await A.evaluate(async ([pid, M, V]) => { const p = DB.projects.find(x => x.id === pid); p.roles = { ...p.roles, [M]: 'member', [V]: 'viewer' }; save(); await flushAll(); }, [PID, M, V]);
  await A.evaluate(ws => openWsPage(ws), WS); await sleep(400);
  const card = await A.evaluate(pid => { const c = document.querySelector(`[data-wsproj="${pid}"]`);
    return { n: c.querySelectorAll('[data-projpeople] .memchip').length, lbl: c.querySelector('.ws-plbl')?.textContent, perms: !!c.querySelector('[data-projperms]') }; }, PID);
  ok('project card: people of the project (owner + 2) and "Kişiler ve yetkiler" for project admin', card.n === 3 && card.lbl === 'Kişiler (3)' && card.perms, JSON.stringify(card));

  /* Y1: alan yöneticisi panoda kartın kişi düğmesinden atama menüsü → alanın Yönetici/Üye kişileri */
  const Yp = await mk('wsadmin'); await login(Yp, 'gty' + R, 'Baslangic123', 'GtYon12345!');
  await Yp.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render(); }, PID); await sleep(400);
  await Yp.click(`[data-qas="${IID}"]`); await sleep(300);
  const menu = await Yp.evaluate(() => [...document.querySelectorAll('.qm-opt[data-qv]')].map(x => x.dataset.qv));
  ok('assign menu lists project members with edit right (not viewer, outsider, system user)', menu.includes(M) && !menu.includes(V)
    && !menu.includes(X) && !menu.includes('u_admin'), JSON.stringify(menu));
  await Yp.click(`.qm-opt[data-qv="${M}"]`); await sleep(300); await flush(Yp);
  ok('assignment to workspace member saved on server', await Yp.evaluate(async ([iid, M]) =>
    (await API.get('/api/state')).data.issues.find(i => i.id === iid)?.assignee === M, [IID, M]));
  await Yp.screenshot({ path: SS + 'atama.png' });

  /* O1: alan dışına atama sunucuda reddedilir */
  ok('server rejects assigning an outsider', await Yp.evaluate(async ([iid, X]) => {
    const i = (await API.get('/api/state')).data.issues.find(x => x.id === iid);
    const r = await API.post('/api/sync', { changes: [{ c: 'issues', id: iid, op: 'put', data: { ...i, assignee: X }, base: i }] });
    return r.rejected?.[0]?.reason === 'Atanan kişinin bu projede iş düzenleme yetkisi yok'; }, [IID, X]));

  /* Güv O1: alan yöneticisi kendi (üyeli) alanındaki projede taşıma menüsünü görür; eski Genel alanındaki projede görmez */
  const mv = await Yp.evaluate(([ws, pid, lp]) => { openWsPage(ws);
    const own = !!document.querySelector(`[data-wsproj="${pid}"] [data-movproj]`);
    openWsPage('ws1');
    const c = document.querySelector(`[data-wsproj="${lp}"]`);
    return { own, card: !!c, legacy: !!c?.querySelector('[data-movproj]'), arch: !!c?.querySelector('[data-arch]') }; }, [WS, PID, 'p_gtl' + R]);
  /* yetki-v2: Genel'deki projede Y proje Üyesi: taşıma yok, arşivleme (proje ayarı) de varsayılanda kapalı */
  ok('move menu: shown in own workspace, hidden in workspace without admin; project member has no archive', mv.own && mv.card && !mv.legacy && !mv.arch, JSON.stringify(mv));

  /* O2: üye iş detayını açık tutup yorum yazarken alandan çıkarılır → pencere kapanır, uyarı tostu */
  const Mp = await mk('member'); await login(Mp, 'gtm' + R, 'Baslangic123', 'GtUye12345!');
  await Mp.evaluate(([pid, iid]) => { DB.ui.project = pid; DB.ui.view = 'board'; render(); openIssue(iid);
    window.__toasts = []; const t0 = toast; window.toast = (m, o) => { window.__toasts.push(m); return t0(m, o); }; }, [PID, IID]);
  await sleep(400);
  ok('member: issue detail open', await Mp.evaluate(() => !!document.querySelector('#scrim.on .modal.id-dlg')));
  await Mp.fill('#newCmt', 'yarım kalan yorum');
  /* yetki-v2: projeden çıkarılır */
  await A.evaluate(async ([pid, M]) => {
    const p = (await API.get('/api/state')).data.projects.find(x => x.id === pid), roles = { ...p.roles }; delete roles[M];
    await API.post('/api/sync', { changes: [{ c: 'projects', id: pid, op: 'put', data: { ...p, roles }, base: p }] });
  }, [PID, M]);
  ok('removed member: detail dialog closes within a poll', await waitFor(Mp, () => !document.querySelector('#scrim.on')));
  const after = await Mp.evaluate(([pid, iid]) => ({ proj: DB.projects.some(p => p.id === pid), iss: DB.issues.some(i => i.id === iid),
    sel: DB.ui.project === pid, txt: document.body.innerText.includes('Genel tur işi'), toasts: window.__toasts }), [PID, IID]);
  ok('removed member: project and issue gone, not selected, not on screen', !after.proj && !after.iss && !after.sel && !after.txt, JSON.stringify(after));
  ok('removed member: unsaved text warning toast', after.toasts.some(t => /erişiminiz kalmadı; yazdığınız metin kaydedilmedi/.test(t)), JSON.stringify(after.toasts));
  await Mp.screenshot({ path: SS + 'cikarildi.png' });

  /* O4: çıkarılan üyenin bildiriminde işin anahtarı/başlığı yok */
  const nt = await Mp.evaluate(async iid => (await API.get('/api/notifications')).items.filter(n => n.issue_id === iid), IID);
  ok('removed member: notification without key/summary', nt.length > 0 && nt.every(n => n.issue_key === '' && n.summary === ''), JSON.stringify(nt));

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
