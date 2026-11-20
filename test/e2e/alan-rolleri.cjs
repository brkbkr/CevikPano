// Çalışma alanı yöneticileri ve proje rolleri tarayıcı testi (yetki-v2; eski 22b alan rolleri yerine). Ön koşullar regresyon.cjs
// ile aynı (temiz DB + demo veri); test kendi kullanıcılarını, alanını ve projesini oluşturur, sonunda temizler.
// Kapsam: alan penceresinde alan yöneticileri (ara/ekle/çıkar, rol seçici yok), sahip kaldırılamaz, XSS; alan sayfası yöneticileri
// gösterir; alan yöneticisi projeye eklenmeden alanın projelerini görür/yönetir ve alana proje açar; projeye Üye olarak eklenen kişi
// iş açar ama alan/proje ayarı göremez; İzleyici yazma düğmesi görmez; eklenmemiş kişi alanı/projeyi görmez; kullanıcı
// penceresinde projeye rol verilince kişinin açık sekmesi kendiliğinden yenilenir; alan yöneticiliği kalkınca erişim kalkar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_ar_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const Y = 'u_ary' + R, M = 'u_arm' + R, V = 'u_arv' + R, X = 'u_arx' + R;
const XSS = '<img src=x onerror="window.__xss=1">';
const WSN = `Rol Alanı ${R}`;

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
  const srvWs = (p, id) => p.evaluate(async id => (await API.get('/api/state')).data.workspaces.find(x => x.id === id) || null, id);
  const srvProj = (p, id) => p.evaluate(async id => (await API.get('/api/state')).data.projects.find(x => x.id === id) || null, id);
  const waitFor = async (p, fn, arg, ms = 9000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(200); } return false; };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([R, Y, M, V, X, XSS]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: Y, op: 'put', data: { username: 'ary' + R, name: 'Ar Yönetici ' + R, role: 'member', active: true } },
      { c: 'users', id: M, op: 'put', data: { username: 'arm' + R, name: 'Ar Üye ' + R + XSS, role: 'member', active: true } },
      { c: 'users', id: V, op: 'put', data: { username: 'arv' + R, name: 'Ar İzleyici ' + R, role: 'member', active: true } },
      { c: 'users', id: X, op: 'put', data: { username: 'arx' + R, name: 'Ar Dışarıda ' + R, role: 'member', active: true } }] });
    await reloadState();
  }, [R, Y, M, V, X, XSS]);

  /* 1) Menü: Projeler öğesi yok; Cariler ve Kullanıcılar sistem yöneticisinde var */
  const nav = await A.evaluate(() => ({ proj: !!document.querySelector('#rail [data-v="projects"]'), cu: !!document.querySelector('#rail [data-v="customers"], #navMore [data-v="customers"]'),
    us: !!document.querySelector('#rail [data-v="users"], #navMore [data-v="users"]') }));
  ok('admin menu: no Projeler item; Cariler + Kullanıcılar present', !nav.proj && nav.cu && nav.us, JSON.stringify(nav));

  /* 2) Yeni alan penceresi: Alan yöneticileri (ara + ekle, rol seçici yok), sahip seçimi; sahip kaldırılamaz */
  await A.click('#rail .nv-sech [data-wsnew]'); await sleep(300);
  await A.fill('#wsf_n', WSN);
  const f0 = await A.evaluate(() => ({ q: !!document.querySelector('#wsf_q'), own: document.querySelector('#wsf_o')?.value, info: document.querySelector('#wsf_info')?.textContent || '',
    rows: [...document.querySelectorAll('#wsf_ml [data-wsfm]')].map(x => x.dataset.wsfm), del: document.querySelectorAll('#wsf_ml [data-wsfdel]').length }));
  ok('ws dialog: admin search + owner select (default: me) + owner row without remove + info', f0.q && f0.own === 'u_admin' && f0.rows.join() === 'u_admin' && f0.del === 0
    && /yalnız eklendikleri projeleri/.test(f0.info), JSON.stringify(f0));
  await A.fill('#wsf_q', 'ar yönet'); await sleep(150); await A.click(`#wsf_res [data-wsfadd="${Y}"]`); await sleep(100);
  await A.fill('#wsf_q', 'Ar Üye ' + R); await sleep(150);
  ok('XSS name rendered as text in search results', await A.evaluate(() => !window.__xss && !document.querySelector('#wsf_res img')));
  await A.click(`#wsf_res [data-wsfadd="${M}"]`); await sleep(100);
  ok('no role select in admin list; added admin removable', await A.evaluate(M => !document.querySelector('#wsf_ml [data-wsfr]') && !!document.querySelector(`#wsf_ml [data-wsfdel="${M}"]`), M));
  await A.click(`#wsf_ml [data-wsfdel="${M}"]`); await sleep(100);
  await A.screenshot({ path: SS + 'ws-dialog.png' });
  await A.click('#wsf_ok'); await sleep(400); await flush(A); await sleep(400);
  const wsId = await A.evaluate(n => DB.workspaces.find(w => w.name === n)?.id, WSN);
  const sw = await srvWs(A, wsId);
  ok('server: owner + admins, no member list written', sw && sw.ownerId === 'u_admin' && JSON.stringify(sw.admins) === JSON.stringify([Y]) && !(sw.members || []).length, JSON.stringify(sw));

  /* proje: sistem yöneticisi açar, M Üye ve V İzleyici olarak eklenir; Y (alan yöneticisi) projeye eklenmez */
  const PID = 'p_ar' + R;
  await A.evaluate(async ([ws, R, pid, M, V]) => {
    DB.projects.push({ id: pid, key: 'AR' + R.toUpperCase(), code: 'AR' + R.toUpperCase(), name: 'Rol Projesi ' + R, workspaceId: ws, lead: SESSION, counter: 0,
      ownerId: SESSION, roles: { [SESSION]: 'admin', [M]: 'member', [V]: 'viewer' }, members: [SESSION, M, V], archived: false, type: 'board' });
    DB.statuses.push({ id: pid + '_s0', projectId: pid, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 }, { id: pid + '_s1', projectId: pid, name: 'Bitti', cat: 'done', wip: 0, ord: 1 });
    save(); await flushAll();
  }, [wsId, R, PID, M, V]);

  /* 3) Alan sayfası: kartlar, + Proje, Alan yöneticileri (rozet), Düzenle/Arşivle */
  await A.click(`#wsTree [data-wstog="${wsId}"]`); await sleep(400);
  const pg = await A.evaluate(([ws, pid, Y]) => ({ view: DB.ui.view, page: !!document.querySelector(`[data-wspage="${ws}"]`), card: !!document.querySelector(`[data-wspage] [data-wsproj="${pid}"]`),
    add: !!document.querySelector(`[data-wspage] [data-wsnewproj="${ws}"]`), edit: !!document.querySelector('[data-wspage] [data-wsedit]'), arch: !!document.querySelector('[data-wspage] [data-wsarch]'),
    adm: [...document.querySelectorAll('[data-wspage] [data-wspm]')].map(x => x.dataset.wspm), own: document.querySelector('[data-wspm="u_admin"] .ws-role')?.textContent,
    people: document.querySelectorAll(`[data-wsproj="${pid}"] [data-projpeople] .memchip`).length }), [wsId, PID, Y]);
  ok('workspace page: cards, + Proje, admins with badges, edit/archive, project people', pg.view === 'workspace' && pg.page && pg.card && pg.add && pg.edit && pg.arch
    && pg.adm.join() === ['u_admin', Y].join() && /Sahip/.test(pg.own || '') && pg.people === 3, JSON.stringify(pg));
  await A.screenshot({ path: SS + 'ws-page-admin.png', fullPage: true });

  /* 4) Alan yöneticisi Y: alan sayfasında Düzenle ve + Proje; projeye eklenmeden projeyi görür, Yetkiler sekmesi açık */
  const Yb = await mk('wsadmin'); await login(Yb, 'ary' + R, 'Baslangic123', 'ArYon12345!');
  await Yb.evaluate(ws => openWsPage(ws), wsId); await sleep(300);
  const y1 = await Yb.evaluate(pid => ({ edit: !!document.querySelector('[data-wspage] [data-wsedit]'), add: !!document.querySelector('[data-wspage] [data-wsnewproj]'),
    card: !!document.querySelector(`[data-wsproj="${pid}"]`), role: document.querySelector('[data-wsmyrole]')?.textContent, wsnew: !!document.querySelector('[data-wsnew]'),
    cu: !!document.querySelector('[data-v="customers"]') }), PID);
  ok('ws admin: edit + Proje, sees project without being added; no new workspace / Cariler', y1.edit && y1.add && y1.card && y1.role === 'Alan yöneticisi' && !y1.wsnew && !y1.cu, JSON.stringify(y1));
  const y3 = await Yb.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'admin'; render();
    return { tab: viewAllowed('admin'), cols: canEditCols(P()), tabs: [...document.querySelectorAll('#adminTabs [data-a]')].map(x => x.dataset.a) }; }, PID);
  ok('ws admin: project settings incl. Yetkiler', y3.tab && y3.cols && y3.tabs.includes('perms'), JSON.stringify(y3));

  /* 5) Proje Üyesi M: iş açar; alan/proje ayarı yok; yöneticisi olan alana proje açamaz */
  const Mb = await mk('member'); await login(Mb, 'arm' + R, 'Baslangic123', 'ArUye12345!');
  await Mb.evaluate(ws => openWsPage(ws), wsId); await sleep(300);
  const m1 = await Mb.evaluate(pid => ({ edit: !!document.querySelector('[data-wspage] [data-wsedit]'), arch: !!document.querySelector('[data-wspage] [data-wsarch]'),
    add: !!document.querySelector('[data-wspage] [data-wsnewproj]'), pname: document.querySelector(`[data-wspage] [data-projname="${pid}"]`)?.disabled,
    cu: !!document.querySelector('[data-v="customers"]'), us: !!document.querySelector('[data-v="users"]') }), PID);
  ok('member: ws page without edit/archive/+Proje; project name read-only; no Cariler/Kullanıcılar', !m1.edit && !m1.arch && !m1.add && m1.pname === true && !m1.cu && !m1.us, JSON.stringify(m1));
  const m2 = await Mb.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render();
    return { edit: canEdit(), nw: !!document.querySelector('#newIssue'), tabs: [...document.querySelectorAll('[data-v="admin"]')].length }; }, PID);
  ok('member: can create issues, no project settings tab', m2.edit && m2.nw && m2.tabs === 0, JSON.stringify(m2));
  ok('member: creating a project in a workspace with admins rejected by server', await Mb.evaluate(async ([ws, R]) => {
    const r = await API.post('/api/sync', { changes: [{ c: 'projects', id: 'p_arm' + R, op: 'put', data: { name: 'Üye projesi ' + R, key: 'ARM' + R.toUpperCase(), workspaceId: ws } }] });
    return r.rejected?.[0]?.reason === 'Bu alana yalnızca alan yöneticisi proje açabilir'; }, [wsId, R]));

  /* 6) Proje İzleyicisi V: yazma düğmesi yok */
  const Vb = await mk('viewer'); await login(Vb, 'arv' + R, 'Baslangic123', 'ArIzci12345!');
  const v1 = await Vb.evaluate(([ws, pid]) => { openWsPage(ws); const pg = { add: !!document.querySelector('[data-wspage] [data-wsnewproj]'), edit: !!document.querySelector('[data-wspage] [data-wsedit]') };
    DB.ui.project = pid; DB.ui.view = 'board'; render();
    return { ...pg, edit2: canEdit(), nw: !!document.querySelector('#newIssue'), qa: !!document.querySelector('[data-qa]'), ro: document.body.classList.contains('readonly') }; }, [wsId, PID]);
  ok('viewer: no write buttons (ws page, board), readonly body', !v1.add && !v1.edit && !v1.edit2 && !v1.nw && !v1.qa && v1.ro, JSON.stringify(v1));

  /* 7) Eklenmemiş kişi X: alan ve proje hiçbir yerde görünmez */
  const Xb = await mk('outsider'); await login(Xb, 'arx' + R, 'Baslangic123', 'ArDis12345!');
  const x1 = await Xb.evaluate(([ws, pid]) => ({ vis: visibleWs().some(w => w.id === ws), tree: !!document.querySelector(`#wsTree [data-wstog="${ws}"]`),
    sel: selectableProjects().some(p => p.id === pid), gr: grScope().some(p => p.id === pid) }), [wsId, PID]);
  ok('outsider: workspace/project hidden (tree, selectors, reports)', !x1.vis && !x1.tree && !x1.sel && !x1.gr, JSON.stringify(x1));

  /* 8) Kullanıcı penceresi: X'e projede Üye rolü → X'in açık sekmesi kendiliğinden yenilenir ve projeyi görür */
  await A.evaluate(() => { location.hash = 'users'; }); await sleep(1200);
  await A.click(`tr.urow[data-uedit="${X}"]`); await sleep(500);
  ok('user dialog: project role select (—) and workspace admin checkbox', await A.evaluate(([ws, pid]) => !document.querySelector('[data-uws]')
    && document.querySelector(`[data-uproj="${pid}"]`)?.value === '' && document.querySelector(`[data-uwsa="${ws}"]`)?.checked === false, [wsId, PID]));
  await A.selectOption(`[data-uproj="${PID}"]`, 'member'); await A.click('#ue_ok'); await sleep(1500);
  ok('user dialog: role written to project roles', (await srvProj(A, PID))?.roles?.[X] === 'member');
  ok('outsider now sees the project and workspace (poll, no reload)', await waitFor(Xb, ([ws, pid]) => selectableProjects().some(p => p.id === pid) && visibleWs().some(w => w.id === ws), [wsId, PID]));

  /* 9) Alan yöneticiliği kalkınca Y projeyi görmez */
  const w9 = await srvWs(A, wsId);
  await A.evaluate(async ([ws, w]) => { await API.post('/api/sync', { changes: [{ c: 'workspaces', id: ws, op: 'put', data: { ...w, admins: [] }, base: w }] }); }, [wsId, w9]);
  ok('ws admin removed: project disappears from their tab (poll)', await waitFor(Yb, pid => !DB.projects.some(p => p.id === pid), PID));

  /* temizlik */
  await A.evaluate(async ([pid, ws, ids]) => {
    await reloadState();
    DB.issues = DB.issues.filter(i => i.projectId !== pid); DB.statuses = DB.statuses.filter(s => s.projectId !== pid);
    DB.projects = DB.projects.filter(p => p.id !== pid); save(); await flushAll();
    DB.workspaces = DB.workspaces.filter(w => w.id !== ws); DB.users = DB.users.filter(u => !ids.includes(u.id)); save(); await flushAll();
  }, [PID, wsId, [Y, M, V, X]]);
  ok('cleanup', !(await srvWs(A, wsId)));
  console.log(errs.join('\n') || 'no page errors / alerts');
  await b.close(); process.exit(FAILS || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
