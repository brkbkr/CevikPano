// Çalışma alanı üyelikleri ve rolleri tarayıcı testi (22b). Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri);
// test kendi kullanıcılarını ve alanlarını oluşturur, sonunda temizler; diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: alan penceresinde üye ara/ekle + rol, sahip kaldırılamaz; alan adına tıklayınca alan sayfası; menüde Projeler yok;
// Cariler/Kullanıcılar yalnız sistem yöneticisi; alan izleyicisi düğme görmez; alan yöneticisi proje ayarlarını görür;
// üye alan açamaz; erişimi olmayan alan hiçbir yerde görünmez; #projects üyede alan sayfasına yönlenir.
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
  const waitFor = async (p, fn, arg, ms = 8000) => { const t0 = Date.now();
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

  /* 2) Yeni alan penceresi: Üyeler (ara + ekle + rol), sahip seçimi; sahip kaldırılamaz */
  await A.click('#rail .nv-sech [data-wsnew]'); await sleep(300);
  await A.fill('#wsf_n', WSN);
  const f0 = await A.evaluate(() => ({ q: !!document.querySelector('#wsf_q'), own: document.querySelector('#wsf_o')?.value,
    rows: [...document.querySelectorAll('#wsf_ml [data-wsfm]')].map(x => x.dataset.wsfm), del: document.querySelectorAll('#wsf_ml [data-wsfdel]').length }));
  ok('ws dialog: member search + owner select (default: me) + owner row without remove', f0.q && f0.own === 'u_admin' && f0.rows.join() === 'u_admin' && f0.del === 0, JSON.stringify(f0));
  const addP = async (q, id, role) => { await A.fill('#wsf_q', q); await sleep(150); await A.click(`#wsf_res [data-wsfadd="${id}"]`); await sleep(100);
    if (role) await A.selectOption(`#wsf_ml [data-wsfr="${id}"]`, role); };
  await addP('ar yönet', Y, 'admin'); await addP('ar üye ' + R, M); await addP('izleyici ' + R, V, 'viewer');
  await A.fill('#wsf_q', 'Ar Üye ' + R); await sleep(150);
  ok('search hides already added people', await A.evaluate(id => !document.querySelector(`#wsf_res [data-wsfadd="${id}"]`), M));
  await A.fill('#wsf_q', ''); await sleep(50);
  ok('XSS name rendered as text in member list', await A.evaluate(() => !window.__xss && !document.querySelector('#wsf_ml img')));
  /* sahibi Y yap: Y sahip satırına geçer, eski sahip (admin) Yönetici satırı olur */
  await A.selectOption('#wsf_o', Y); await sleep(100);
  const f1 = await A.evaluate(([Y]) => ({ first: document.querySelector('#wsf_ml [data-wsfm]')?.dataset.wsfm, ownDel: !!document.querySelector(`#wsf_ml [data-wsfdel="${Y}"]`),
    n: document.querySelectorAll('#wsf_ml [data-wsfm]').length }), [Y]);
  ok('owner change: new owner fixed at top (not removable)', f1.first === Y && !f1.ownDel && f1.n === 4, JSON.stringify(f1));
  await A.screenshot({ path: SS + 'ws-dialog.png' });
  await A.click('#wsf_ok'); await sleep(400); await flush(A); await sleep(400);
  const wsId = await A.evaluate(n => DB.workspaces.find(w => w.name === n)?.id, WSN);
  const sw = await srvWs(A, wsId);
  const roles = Object.fromEntries((sw?.members || []).map(m => [m.userId, m.role]));
  ok('server: owner + members with roles', sw && sw.ownerId === Y && roles[Y] === 'admin' && roles.u_admin === 'admin' && roles[M] === 'member' && roles[V] === 'viewer' && !roles[X], JSON.stringify(sw));

  /* proje: sistem yöneticisi alan sayfasından açar */
  await A.evaluate(async ([ws, R]) => {
    DB.projects.push({ id: 'p_ar' + R, key: 'AR' + R.toUpperCase(), code: 'AR' + R.toUpperCase(), name: 'Rol Projesi ' + R, workspaceId: ws, lead: SESSION, counter: 0, members: [], archived: false, type: 'board' });
    DB.statuses.push({ id: 'p_ar' + R + '_s0', projectId: 'p_ar' + R, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 }, { id: 'p_ar' + R + '_s1', projectId: 'p_ar' + R, name: 'Bitti', cat: 'done', wip: 0, ord: 1 });
    save(); await flushAll();
  }, [wsId, R]);
  const PID = 'p_ar' + R;

  /* 3) Alan adına tıklayınca alan sayfası: kartlar, + Proje, Üyeler (rozetler), Düzenle/Arşivle */
  await A.click(`#wsTree [data-wstog="${wsId}"]`); await sleep(400);
  const pg = await A.evaluate(([ws, pid, Y]) => ({ view: DB.ui.view, page: !!document.querySelector(`[data-wspage="${ws}"]`), card: !!document.querySelector(`[data-wspage] [data-wsproj="${pid}"]`),
    add: !!document.querySelector(`[data-wspage] [data-wsnewproj="${ws}"]`), edit: !!document.querySelector('[data-wspage] [data-wsedit]'), arch: !!document.querySelector('[data-wspage] [data-wsarch]'),
    mems: document.querySelectorAll('[data-wspage] [data-wspm]').length, own: document.querySelector(`[data-wspm="${Y}"] .ws-role`)?.textContent,
    tree: document.querySelector(`#wsTree [data-wstog="${ws}"]`).getAttribute('aria-expanded'), hash: location.hash }), [wsId, PID, Y]);
  ok('workspace page opens from tree (cards, + Proje, members with badges, edit/archive)', pg.view === 'workspace' && pg.page && pg.card && pg.add && pg.edit && pg.arch
    && pg.mems === 4 && /Sahip/.test(pg.own || '') && pg.tree === 'true' && pg.hash === '#workspace', JSON.stringify(pg));
  await A.screenshot({ path: SS + 'ws-page-admin.png', fullPage: true });
  await A.evaluate(() => { location.hash = 'projects'; }); await sleep(400);
  ok('admin: #projects still lists all workspaces', await A.evaluate(() => DB.ui.view === 'projects' && document.querySelectorAll('[data-wsgrp]').length >= 2));

  /* 4) Alan Üyesi: alan sayfasında düzenle/arşivle/+Proje yok; Cariler/Kullanıcılar menüde yok, adresle açılmaz; #projects → alan sayfası;
        yeni alan girişi yok; iş oluşturabilir; proje ayarları sekmesi yok */
  const Mb = await mk('member'); await login(Mb, 'arm' + R, 'Baslangic123', 'ArUye12345!');
  await Mb.click(`#wsTree [data-wstog="${wsId}"]`); await sleep(400);
  const mv = await Mb.evaluate(([ws, pid]) => { DB.ui.project = pid; render();
    return { page: !!document.querySelector(`[data-wspage="${ws}"]`) || DB.ui.view !== 'workspace', role: document.querySelector('[data-wsmyrole]')?.dataset.wsmyrole };
  }, [wsId, PID]);
  await Mb.evaluate(ws => openWsPage(ws), wsId); await sleep(300);
  const m1 = await Mb.evaluate(([ws]) => ({ role: document.querySelector('[data-wsmyrole]')?.dataset.wsmyrole, edit: !!document.querySelector('[data-wspage] [data-wsedit]'),
    arch: !!document.querySelector('[data-wspage] [data-wsarch]'), add: !!document.querySelector('[data-wspage] [data-wsnewproj]'),
    pname: document.querySelector('[data-wspage] [data-projname]')?.disabled, wsnew: !!document.querySelector('[data-wsnew]'),
    cu: !!document.querySelector('[data-v="customers"]'), us: !!document.querySelector('[data-v="users"]'), proj: !!document.querySelector('#rail [data-v="projects"]') }), [wsId]);
  ok('member: ws page without edit/archive/+Proje; no Cariler/Kullanıcılar/Projeler/new workspace', m1.role === 'member' && !m1.edit && !m1.arch && !m1.add && m1.pname === true
    && !m1.wsnew && !m1.cu && !m1.us && !m1.proj, JSON.stringify(m1));
  await Mb.evaluate(() => { location.hash = 'customers'; }); await sleep(300);
  ok('member: #customers not reachable', await Mb.evaluate(() => DB.ui.view !== 'customers'));
  await Mb.evaluate(() => { location.hash = 'projects'; }); await sleep(400);
  ok('member: #projects redirects to the workspace page', await Mb.evaluate(ws => DB.ui.view === 'workspace' && !!document.querySelector(`[data-wspage="${ws}"]`), wsId));
  const m2 = await Mb.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render();
    return { edit: canEdit(), nw: !!document.querySelector('#newIssue'), tabs: [...document.querySelectorAll('[data-v="admin"]')].length, design: canDesign(P()) }; }, PID);
  ok('member: can create issues, no project settings tab', m2.edit && m2.nw && m2.tabs === 0 && !m2.design, JSON.stringify(m2));
  ok('member: quick add contact hidden (server 403)', await Mb.evaluate(async () => {
    const r = await fetch('/api/customers/c_yok/contacts', { method: 'POST', headers: { 'x-pano': '1', 'content-type': 'application/json' }, body: '{"name":"x"}' }); return r.status === 403; }));
  ok('member: creating a workspace rejected by server (403 reason)', await Mb.evaluate(async R => {
    const r = await API.post('/api/sync', { changes: [{ c: 'workspaces', id: 'ws_arm' + R, op: 'put', data: { name: 'Üye alanı ' + R } }] });
    return r.rejected?.[0]?.reason === 'Çalışma alanını yalnızca yönetici açabilir'; }, R));

  /* 5) Alan İzleyicisi: hiçbir yazma düğmesi görmez */
  const Vb = await mk('viewer'); await login(Vb, 'arv' + R, 'Baslangic123', 'ArIzci12345!');
  const v1 = await Vb.evaluate(([ws, pid]) => { openWsPage(ws); const pg = { add: !!document.querySelector('[data-wspage] [data-wsnewproj]'), edit: !!document.querySelector('[data-wspage] [data-wsedit]'),
      role: document.querySelector('[data-wsmyrole]')?.dataset.wsmyrole };
    DB.ui.project = pid; DB.ui.view = 'board'; render();
    return { ...pg, edit2: canEdit(), nw: !!document.querySelector('#newIssue'), qa: !!document.querySelector('[data-qa]'), ro: document.body.classList.contains('readonly') }; }, [wsId, PID]);
  ok('viewer: no write buttons (ws page, board), readonly body', v1.role === 'viewer' && !v1.add && !v1.edit && !v1.edit2 && !v1.nw && !v1.qa && v1.ro, JSON.stringify(v1));
  await Vb.screenshot({ path: SS + 'viewer-board.png' });

  /* 6) Alanda olmayan kişi: alan ve projesi hiçbir yerde görünmez */
  const Xb = await mk('outsider'); await login(Xb, 'arx' + R, 'Baslangic123', 'ArDis12345!');
  const x1 = await Xb.evaluate(([ws, pid]) => ({ vis: visibleWs().some(w => w.id === ws), tree: !!document.querySelector(`#wsTree [data-wstog="${ws}"]`),
    sel: selectableProjects().some(p => p.id === pid), gr: grScope().some(p => p.id === pid), pal: !!document.body.innerHTML.includes('Rol Projesi') }), [wsId, PID]);
  ok('outsider: workspace/project hidden (tree, selectors, reports)', !x1.vis && !x1.tree && !x1.sel && !x1.gr, JSON.stringify(x1));

  /* 7) Alan Yöneticisi (sahip Y): alan sayfasında Düzenle; üye rolünü değiştirir; proje ayarları sekmesi görünür */
  const Yb = await mk('wsadmin'); await login(Yb, 'ary' + R, 'Baslangic123', 'ArYon12345!');
  await Yb.evaluate(ws => openWsPage(ws), wsId); await sleep(300);
  const y1 = await Yb.evaluate(() => ({ edit: !!document.querySelector('[data-wspage] [data-wsedit]'), add: !!document.querySelector('[data-wspage] [data-wsnewproj]'),
    wsnew: !!document.querySelector('[data-wsnew]'), cu: !!document.querySelector('[data-v="customers"]') }));
  ok('ws admin: edit + Proje on ws page; still no new workspace / Cariler', y1.edit && y1.add && !y1.wsnew && !y1.cu, JSON.stringify(y1));
  await Yb.click('[data-wspage] [data-wspmed]'); await sleep(300);
  const y2 = await Yb.evaluate(([Y, V]) => ({ own: !!document.querySelector('#wsf_o'), ownDel: !!document.querySelector(`#wsf_ml [data-wsfdel="${Y}"]`), vSel: !!document.querySelector(`#wsf_ml [data-wsfr="${V}"]`) }), [Y, V]);
  ok('ws admin: member editor without owner select; owner not removable', !y2.own && !y2.ownDel && y2.vSel, JSON.stringify(y2));
  await Yb.selectOption(`#wsf_ml [data-wsfr="${V}"]`, 'member'); await Yb.click('#wsf_ok'); await sleep(300); await flush(Yb); await sleep(300);
  ok('ws admin: role change saved on server', ((await srvWs(A, wsId))?.members || []).some(m => m.userId === V && m.role === 'member'));
  ok('viewer becomes member live (poll)', await waitFor(Vb, pid => { DB.ui.project = pid; return canEdit(); }, PID));
  const y3 = await Yb.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render(); return { tab: viewAllowed('admin'), cols: canEditCols(P()) }; }, PID);
  ok('ws admin: project settings + columns allowed', y3.tab && y3.cols, JSON.stringify(y3));

  /* 8) Kullanıcı penceresi: alan + rol */
  await A.evaluate(() => { location.hash = 'users'; }); await sleep(1200);
  await A.click(`tr.urow[data-uedit="${X}"]`); await sleep(500);
  ok('user dialog: workspace role select (no project checkboxes)', await A.evaluate(ws => !document.querySelector('[data-up]') && document.querySelector(`[data-uws="${ws}"]`)?.value === '', wsId));
  await A.selectOption(`[data-uws="${wsId}"]`, 'viewer'); await A.click('#ue_ok'); await sleep(1500);
  ok('user dialog: role written to workspace members', ((await srvWs(A, wsId))?.members || []).some(m => m.userId === X && m.role === 'viewer'));
  ok('outsider now sees workspace (poll)', await waitFor(Xb, ws => visibleWs().some(w => w.id === ws), wsId));

  /* temizlik */
  await A.evaluate(async ([pid, ws, ids]) => {
    DB.issues = DB.issues.filter(i => i.projectId !== pid); DB.statuses = DB.statuses.filter(s => s.projectId !== pid);
    DB.projects = DB.projects.filter(p => p.id !== pid); save(); await flushAll();
    DB.workspaces = DB.workspaces.filter(w => w.id !== ws); DB.users = DB.users.filter(u => !ids.includes(u.id)); save(); await flushAll();
  }, [PID, wsId, [Y, M, V, X]]);
  ok('cleanup', !(await srvWs(A, wsId)));
  console.log(errs.join('\n') || 'no page errors / alerts');
  await b.close(); process.exit(FAILS || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
