// Çalışma alanları tarayıcı testi (issue #22, docs/tasarim/calisma-alanlari).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/calisma-alanlari.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını,
// alanlarını ve işlerini oluşturur; diğer tarayıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_ws_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);           // tekrar çalıştırmada çakışmasın
const M = 'u_wsm' + RUN, V = 'u_wsv' + RUN, N = 'u_wsn' + RUN, NV = 'u_wsnv' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';
const WSA = `Alan A ${RUN} ${XSS}`;                       // 60 karakterin altında

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    /* konsol temiz olmalı (giriş öncesi 401 ve bilinçli ret yanıtlarının ağ satırları hariç) */
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ' CONSOLE ' + m.text()); });
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
  const view = async (p, v) => { await p.evaluate(v => { DB.ui.view = v; render(); }, v); await sleep(250); };
  const waitFor = async (p, fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(200); } return -1; };
  const flush = p => p.evaluate(() => flushAll());
  const srv = (p, c, id) => p.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c]?.find(x => x.id === id) || null, [c, id]);
  const toastText = p => p.evaluate(() => document.getElementById('toast').textContent.trim());
  const openPop = async (p, sel) => { await p.click(`${sel} [data-wsmore]`); await sleep(150); };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  ok('rail: two-level selector present (#projSel kept)', await A.evaluate(() => !!document.querySelector('#wsSwitch #wsCur') && !!document.querySelector('#wsSwitch #projSel')));
  ok('default workspace "Genel" exists (migration)', await A.evaluate(() => DB.workspaces.some(w => w.id === 'ws1' && w.name && !w.archived)));
  ok('projects without workspaceId count as Genel', await A.evaluate(() => wsOf(DB.projects.find(p => p.id === 'p1')) === 'ws1'));

  /* ---- kullanıcılar: üye M ve izleyici V (p1, p2 üyesi); projesiz üye N ve projesiz izleyici NV ---- */
  await A.evaluate(async ([R, M, V, N, NV]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'wsm' + R, name: 'Ws Üye ' + R, role: 'member', active: true, ini: 'WÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'wsv' + R, name: 'Ws İzleyici ' + R, role: 'viewer', active: true, ini: 'Wİ', color: '#64748B' } },
      { c: 'users', id: N, op: 'put', data: { username: 'wsn' + R, name: 'Ws Projesiz ' + R, role: 'member', active: true, ini: 'WP', color: '#7C3AED' } },
      { c: 'users', id: NV, op: 'put', data: { username: 'wsnv' + R, name: 'Ws Projesiz İzl ' + R, role: 'viewer', active: true, ini: 'WZ', color: '#C2410C' } },
    ] });
    await reloadState();
    ['p1', 'p2'].forEach(pid => { const p = DB.projects.find(x => x.id === pid); p.members = [...new Set([...(p.members || []), M, V])]; });
    save(); await flushAll();
  }, [RUN, M, V, N, NV]);

  // 1) alan menüsü: klavye ile açılır, Esc kapatır ve odak düğmeye döner
  await A.focus('#wsCur'); await A.keyboard.press('ArrowDown'); await sleep(150);
  const menu = await A.evaluate(() => ({ open: !!document.querySelector('#wsMenu[role="menu"]'), exp: document.querySelector('#wsCur').getAttribute('aria-expanded'),
    focusIn: !!document.activeElement.closest('#wsMenu'), radios: document.querySelectorAll('#wsMenu [role="menuitemradio"]').length, nw: !!document.querySelector('#wsMenu [data-wsnew]') }));
  ok('ws menu opens with keyboard (menu + menuitemradio, focus inside)', menu.open && menu.exp === 'true' && menu.focusIn && menu.radios >= 1 && menu.nw, JSON.stringify(menu));
  await A.keyboard.press('Escape'); await sleep(100);
  ok('Esc closes ws menu and returns focus', await A.evaluate(() => !document.querySelector('#wsMenu') && document.activeElement.id === 'wsCur'));

  // 2) yeni alan: ad çakışması (Türkçe büyük/küçük harf duyarsız) önce istemcide yakalanır
  await A.click('#wsCur'); await sleep(100); await A.click('#wsMenu [data-wsnew]'); await sleep(250);
  ok('new workspace dialog opens', await A.isVisible('#wsf_n') && await A.evaluate(() => document.querySelector('#scrim .modal').getAttribute('role') === 'dialog'));
  await A.fill('#wsf_n', '  gENEL '); await A.click('#wsf_ok'); await sleep(150);
  const dup = await A.evaluate(() => ({ e: document.querySelector('#wsf_ne').textContent.trim(), inv: document.querySelector('#wsf_n').getAttribute('aria-invalid'), open: !!document.querySelector('#wsf_n') }));
  ok('duplicate name rejected in client', dup.e === 'Bu adla etkin bir çalışma alanı zaten var' && dup.inv === 'true' && dup.open, JSON.stringify(dup));
  await A.fill('#wsf_n', '   '); await A.click('#wsf_ok'); await sleep(100);
  ok('empty name rejected', await A.evaluate(() => document.querySelector('#wsf_ne').textContent.trim()) === 'Çalışma alanı adı gerekli (en fazla 60 karakter)');
  await A.fill('#wsf_n', WSA);
  await A.click('[data-wsc="#BE185D"]'); await A.keyboard.press('ArrowRight'); await sleep(50);
  ok('color radiogroup: arrow keys move selection', await A.evaluate(() => document.querySelector('[data-wsc="#C2410C"]').getAttribute('aria-checked') === 'true'
    && document.activeElement.dataset.wsc === '#C2410C' && /Turuncu/.test(document.querySelector('#wsf_cn').textContent)));
  await A.fill('#wsf_d', 'Test alanı'); await A.click('#wsf_ok'); await sleep(300);
  const wsA = await A.evaluate(name => DB.workspaces.find(w => w.name === name)?.id, WSA);
  const afterCreate = await A.evaluate(id => ({ sel: DB.ui.workspace === id, proj: DB.ui.project, nm: document.querySelector('#wsCur .nm').textContent,
    opts: [...document.querySelectorAll('#projSel option')].map(o => o.value), dis: document.querySelector('#projSel').disabled }), wsA);
  ok('created workspace is selected, no project', wsA && afterCreate.sel && !afterCreate.proj && afterCreate.nm === WSA && afterCreate.dis, JSON.stringify(afterCreate));

  // 3) boş durum (a): projeye bağlı ekranlar çökmez, panel görünür; c kısayolu iş formu açmaz
  const empties = [];
  for (const v of ['board', 'backlog', 'plan', 'reports', 'timesheet', 'effort', 'admin']) {
    await view(A, v);
    empties.push(await A.evaluate(() => document.querySelector('#view [data-wsempty="a"] h3')?.textContent || 'YOK'));
  }
  ok('empty state (a) on project views', empties.every(t => t === 'Bu çalışma alanında henüz proje yok'), empties.join(' | '));
  ok('empty state (a) offers + Yeni proje for admin', await A.evaluate(id => !!document.querySelector(`#view [data-wsempty="a"] [data-wsnewproj="${id}"]`), wsA));
  await view(A, 'board'); await A.press('body', 'c'); await sleep(200);
  ok('c shortcut without project: toast, no form', !(await A.evaluate(() => document.getElementById('scrim').classList.contains('on'))) && /Önce bir proje seçin/.test(await toastText(A)));
  for (const v of ['home', 'projects', 'search']) await view(A, v);
  await flush(A); await sleep(400);
  const sA = await srv(A, 'workspaces', wsA);
  const meId = await A.evaluate(() => ME.id);
  ok('server stored workspace; createdBy written by server', sA && sA.name === WSA && sA.createdBy === meId && sA.color === '#C2410C', JSON.stringify(sA));
  ok('client gets createdBy from server (adjusted → poll)', await waitFor(A, ([id, me]) => DB.workspaces.find(w => w.id === id)?.createdBy === me, [wsA, meId]) >= 0);

  // 4) Projeler ekranı: alan başlıkları; "+ Proje" o alana bağlar
  await view(A, 'projects');
  const grp = await A.evaluate(id => { const g = document.querySelector(`[data-wsgrp="${id}"]`);
    return g && { t: g.querySelector('h2 .t').textContent, cnt: g.querySelector('.cnt').textContent, empty: !!g.querySelector('.ws-gempty'),
      first: document.querySelector('[data-wsgrp]').dataset.wsgrp }; }, wsA);
  ok('projects grouped by workspace (Genel first, XSS name as text)', grp && grp.t === WSA && grp.cnt === '0 proje' && grp.empty && grp.first === 'ws1', JSON.stringify(grp));
  await A.click(`[data-wsgrp="${wsA}"] .ws-gh [data-wsnewproj]`); await sleep(250);
  ok('+ Proje preselects the workspace', await A.evaluate(id => document.querySelector('#np_ws')?.value === id, wsA));
  await A.fill('#np_n', 'WS Proje ' + RUN); await A.click('#np_ok'); await sleep(400);
  const np = await A.evaluate(name => { const p = DB.projects.find(x => x.name === name); return p && { id: p.id, ws: p.workspaceId, sel: DB.ui.project === p.id, uiWs: DB.ui.workspace }; }, 'WS Proje ' + RUN);
  ok('new project bound to workspace and selected', np && np.ws === wsA && np.sel && np.uiWs === wsA, JSON.stringify(np));
  await flush(A);
  ok('server: project has workspaceId', (await srv(A, 'projects', np.id))?.workspaceId === wsA);
  await view(A, 'board');
  ok('board renders for the new project', await A.evaluate(() => !document.querySelector('[data-wsempty]') && !!document.querySelector('#view .col')));

  // 5) üye M ikinci tarayıcıda: Genel'de p1/p2
  const Mb = await mk('member'); await login(Mb, 'wsm' + RUN, 'Baslangic123', 'WsUye12345!');
  const mInit = await Mb.evaluate(id => ({ vis: visibleWs().map(w => w.id), opts: [...document.querySelectorAll('#projSel option')].map(o => o.value) }), wsA);
  ok('member: sees only workspaces with own projects', mInit.vis.includes('ws1') && !mInit.vis.includes(wsA), JSON.stringify(mInit));

  // 6) taşıma (yönetici, ⋯ menüsünden): anahtarlar aynı; üye ≤ 4 sn (+ pay) içinde görür
  const keysBefore = await A.evaluate(() => DB.issues.filter(i => i.projectId === 'p2').map(i => i.id + ':' + i.key).sort().join());
  const sprintsBefore = await A.evaluate(() => DB.sprints.filter(s => s.projectId === 'p2').length);
  await view(A, 'projects');
  await openPop(A, '[data-wsproj="p2"]');
  ok('card ⋯ menu holds move / archive / delete', await A.evaluate(() => { const pop = document.querySelector('[data-wsproj="p2"] .ws-pop');
    return !pop.hidden && !!pop.querySelector('[data-movproj]') && !!pop.querySelector('[data-arch]') && !!pop.querySelector('[data-delproj]')
      && document.activeElement.closest('.ws-pop') === pop; }));
  await A.click('[data-wsproj="p2"] [data-movproj]'); await sleep(250);
  ok('move: Taşı disabled until another workspace chosen', await A.evaluate(() => document.querySelector('#wsm_ok').disabled
    && document.querySelector('[data-mvto="ws1"]').getAttribute('aria-checked') === 'true'));
  await A.click(`[data-mvto="${wsA}"]`); await A.click('#wsm_ok'); await sleep(300);
  ok('project moved locally', await A.evaluate(id => DB.projects.find(p => p.id === 'p2').workspaceId === id, wsA));
  await flush(A);
  const tMove = await waitFor(Mb, id => wsOf(DB.projects.find(p => p.id === 'p2')) === id && visibleWs().some(w => w.id === id), wsA, 8000);
  ok('member sees the move within poll interval', tMove >= 0, tMove + ' ms');
  const keysAfter = await Mb.evaluate(() => DB.issues.filter(i => i.projectId === 'p2').map(i => i.id + ':' + i.key).sort().join());
  ok('issue keys and sprints unchanged after move', keysAfter === keysBefore && await Mb.evaluate(() => DB.sprints.filter(s => s.projectId === 'p2').length) === sprintsBefore);
  await Mb.evaluate(() => { DB.ui.project = 'p1'; render(); }); await sleep(200);
  ok('member: project select narrows to workspace', await Mb.evaluate(() => { const o = [...document.querySelectorAll('#projSel option')].map(x => x.value);
    return o.includes('p1') && !o.includes('p2'); }));
  await Mb.click('#wsCur'); await sleep(100); await Mb.click(`#wsMenu [data-wspick="${wsA}"]`); await sleep(300);
  ok('member: switching workspace opens its first project', await Mb.evaluate(id => DB.ui.workspace === id && DB.ui.project === 'p2'
    && [...document.querySelectorAll('#projSel option')].map(o => o.value).join() === 'p2', wsA));

  // 7) Benim işlerim: alan çipleri (Tümü + açık işim olan alanlar), altında seçili alanın projeleri
  await A.evaluate(([M, R]) => {
    const add = (pid, n) => { const pr = DB.projects.find(x => x.id === pid);
      DB.issues.push({ id: `i_ws${R}_${n}`, projectId: pid, key: `${pr.key}-${++pr.counter}`, type: 'task', summary: `WS-${R} ${n}`, description: '',
        statusId: statsOf(pid).find(s => s.cat !== 'done').id, assignee: M, reporter: ME.id, priority: 3, labels: [], cf: {},
        created: Date.now(), updatedAt: Date.now(), rank: 1, start: '', due: '' }); };
    add('p1', 1); add('p2', 2); add('p2', 3); save();
  }, [M, RUN]);
  await flush(A);
  await waitFor(Mb, R => DB.issues.filter(i => i.summary.startsWith('WS-' + R)).length === 3, RUN, 8000);
  await view(Mb, 'home');
  const hf = await Mb.evaluate(() => ({ row: !!document.querySelector('.ws-hf'), chips: [...document.querySelectorAll('[data-hmws]')].map(b => b.dataset.hmws + '=' + b.querySelector('.n').textContent) }));
  ok('home: workspace chips (Tümü + workspaces with my open issues)', hf.row && hf.chips.length === 3 && hf.chips[0] === '=3' && hf.chips.includes('ws1=1'), JSON.stringify(hf));
  await Mb.click(`[data-hmws="${wsA}"]`); await sleep(250);
  const hf2 = await Mb.evaluate(id => ({ pressed: document.querySelector(`[data-hmws="${id}"]`).getAttribute('aria-pressed'), ui: DB.ui.homeWs === id,
    rows: document.querySelectorAll('[data-hmrow]').length, open: +document.querySelector('[data-hmsum="open"]').textContent }), wsA);
  ok('home: workspace chip filters list', hf2.pressed === 'true' && hf2.ui && hf2.rows === 2 && hf2.open === 2, JSON.stringify(hf2));
  await flush(Mb); await Mb.reload(); await sleep(2200);
  ok('home: workspace filter kept after reload', await Mb.evaluate(id => DB.ui.homeWs === id && document.querySelector(`[data-hmws="${id}"]`)?.getAttribute('aria-pressed') === 'true', wsA));
  await Mb.evaluate(pid => { DB.ui.homeProj = pid; render(); }, np.id); await sleep(200);
  ok('home: project of another workspace resets to Tümü', await Mb.evaluate(() => DB.ui.homeProj === '' || DB.ui.homeProj === undefined));
  await Mb.evaluate(() => { DB.ui.homeWs = 'yok_boyle_alan'; render(); }); await sleep(200);
  ok('home: unknown saved workspace → Tümü', await Mb.evaluate(() => DB.ui.homeWs === '' && document.querySelector('[data-hmws=""]').getAttribute('aria-pressed') === 'true'));

  // 8) üye kendi alanını açar; Genel'in menüsünü görmez, silme yok
  await view(Mb, 'projects');
  await Mb.click('#wsNewBtn'); await sleep(200);
  await Mb.fill('#wsf_n', 'Üye Alanı ' + RUN); await Mb.press('#wsf_n', 'Enter'); await sleep(300);
  const wsM = await Mb.evaluate(name => DB.workspaces.find(w => w.name === name)?.id, 'Üye Alanı ' + RUN);
  ok('member creates workspace (selected, visible before server echo)', wsM && await Mb.evaluate(id => DB.ui.workspace === id && visibleWs().some(w => w.id === id), wsM));
  await view(Mb, 'projects');
  const mm = await Mb.evaluate(id => ({ own: !!document.querySelector(`[data-wsgrp="${id}"] [data-wsedit]`), genel: !!document.querySelector('[data-wsgrp="ws1"] .ws-gh [data-wsmore]'),
    del: document.querySelectorAll('[data-wsdel]').length, move: document.querySelectorAll('[data-movproj]').length > 0 }), wsM);
  ok('member: manages own workspace only, no delete', mm.own && !mm.genel && mm.del === 0 && mm.move, JSON.stringify(mm));
  await flush(Mb);
  ok('server: member workspace createdBy = member', (await srv(Mb, 'workspaces', wsM))?.createdBy === M);

  // 9) arşivle → seçicilerde yok, "göster" ile görünür, geri al; veri silinmez
  await view(A, 'projects');
  await openPop(A, `[data-wsgrp="${wsA}"] .ws-gh`);
  await A.click(`[data-wsgrp="${wsA}"] [data-wsarch]`); await sleep(300);
  await flush(A);
  const arch = await A.evaluate(id => ({ w: DB.workspaces.find(w => w.id === id).archived, inMenu: visibleWs().some(w => w.id === id),
    grp: !!document.querySelector(`[data-wsgrp="${id}"]`), tog: !!document.querySelector('[data-wsarchtog]'), p2: DB.projects.some(p => p.id === 'p2') }), wsA);
  ok('archived workspace hidden from selectors and list', arch.w === true && !arch.inMenu && !arch.grp && arch.tog && arch.p2, JSON.stringify(arch));
  const tArchM = await waitFor(Mb, id => !visibleWs().some(w => w.id === id) && !selectableProjects().some(p => p.id === 'p2'), wsA, 8000);
  ok('member: archived workspace and its projects leave selectors', tArchM >= 0);
  await Mb.evaluate(() => { DB.ui.homeWs = ''; DB.ui.view = 'home'; render(); }); await sleep(200);
  ok('member home: issues of archived workspace hidden', await Mb.evaluate(() => document.querySelectorAll('[data-hmrow]').length === 1 && !document.querySelector('.ws-hf')));
  await openPop(A, '[data-wsproj="p1"]'); await A.click('[data-wsproj="p1"] [data-movproj]'); await sleep(250);
  ok('move dialog: archived workspace listed but not selectable', await A.evaluate(id => { const o = document.querySelector(`[data-mvto="${id}"]`);
    o.click(); return o.getAttribute('aria-disabled') === 'true' && o.getAttribute('aria-checked') === 'false' && document.querySelector('#wsm_ok').disabled; }, wsA));
  await A.evaluate(() => closeModal());
  const rej = await A.evaluate(async id => { const p = DB.projects.find(x => x.id === 'p1');
    const r = await API.post('/api/sync', { changes: [{ c: 'projects', id: 'p1', op: 'put', data: { ...p, workspaceId: id }, base: p }] }); return r.rejected?.[0]?.reason; }, wsA);
  ok('server rejects move into archived workspace', rej === 'Arşivlenmiş çalışma alanına proje taşınamaz', rej);
  await A.click('[data-wsarchtog]'); await sleep(250);
  ok('show archived: archived group visible (gray, read-only card)', await A.evaluate(id => { const g = document.querySelector(`[data-wsgrp="${id}"]`);
    return g?.classList.contains('is-arch') && !!g.querySelector('[data-wsunarch]') && !g.querySelector('[data-goproj]') && DB.ui.showArchivedWs === true; }, wsA));
  await A.click(`[data-wsunarch="${wsA}"]`); await sleep(300); await flush(A);
  ok('unarchive restores workspace', await A.evaluate(id => DB.workspaces.find(w => w.id === id).archived === false && visibleWs().some(w => w.id === id), wsA)
    && (await srv(A, 'workspaces', wsA))?.archived === false);

  // 10) silme: Genel ve dolu alan devre dışı (nedeniyle); boş alan silinir
  await A.evaluate(() => { DB.ui.showArchivedWs = false; render(); });
  const dis = await A.evaluate(id => ({ g: document.querySelector('[data-wsgrp="ws1"] [data-wsdel]')?.disabled, gWhy: document.querySelector('[data-wsgrp="ws1"] [data-wsdel] .why')?.textContent,
    gArch: !document.querySelector('[data-wsgrp="ws1"] [data-wsarch]'), a: document.querySelector(`[data-wsgrp="${id}"] [data-wsdel]`)?.disabled,
    aWhy: document.querySelector(`[data-wsgrp="${id}"] [data-wsdel] .why`)?.textContent }), wsA);
  ok('delete disabled for Genel and non-empty workspace', dis.g && dis.gWhy === 'Genel çalışma alanı silinemez' && dis.gArch && dis.a && /^Önce projeleri taşıyın · 2 proje/.test(dis.aWhy), JSON.stringify(dis));
  const delRej = await A.evaluate(async id => (await API.post('/api/sync', { changes: [{ c: 'workspaces', id, op: 'del' }] })).rejected?.[0]?.reason, wsA);
  ok('server rejects deleting non-empty workspace', delRej === 'Önce projeleri taşıyın', delRej);
  await view(A, 'projects');
  await openPop(A, `[data-wsgrp="${wsM}"] .ws-gh`);
  await A.click(`[data-wsgrp="${wsM}"] [data-wsdel]`); await sleep(300); await flush(A);
  ok('admin deletes empty workspace', await A.evaluate(id => !DB.workspaces.some(w => w.id === id), wsM) && !(await srv(A, 'workspaces', wsM)));
  const tDelM = await waitFor(Mb, id => !DB.workspaces.some(w => w.id === id), wsM, 8000);
  ok('member: deleted workspace disappears, selection falls back', tDelM >= 0 && await Mb.evaluate(id => DB.ui.workspace !== id, wsM));

  // 11) izleyici: oluşturma / taşıma yok
  const Vb = await mk('viewer'); await login(Vb, 'wsv' + RUN, 'Baslangic123', 'WsIzl12345!');
  await Vb.click('#wsCur'); await sleep(100);
  const vm = await Vb.evaluate(() => ({ nw: !!document.querySelector('#wsMenu [data-wsnew]'), man: !!document.querySelector('#wsMenu [data-wsmanage]') }));
  await Vb.keyboard.press('Escape');
  await view(Vb, 'projects');
  const vp = await Vb.evaluate(() => ({ btn: !!document.querySelector('#wsNewBtn,#pNew'), more: document.querySelectorAll('[data-wsmore]').length,
    add: document.querySelectorAll('[data-wsnewproj]').length }));
  ok('viewer: no create / move controls', !vm.nw && vm.man && !vp.btn && vp.more === 0 && vp.add === 0, JSON.stringify([vm, vp]));
  const vRej = await Vb.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: 'workspaces', id: 'ws_izl', op: 'put', data: { id: 'ws_izl', name: 'İzleyici alanı' } }] })).rejected?.[0]?.reason);
  ok('server rejects viewer workspace', vRej === 'salt okunur kullanıcı', vRej);

  // 12) hiçbir projede üye değil (b): üye → "Çalışma alanı oluştur"; izleyici → yalnız metin
  const Nb = await mk('noproj'); await login(Nb, 'wsn' + RUN, 'Baslangic123', 'WsProj12345!');
  await view(Nb, 'board');
  const nb = await Nb.evaluate(() => ({ h: document.querySelector('[data-wsempty="b"] h3')?.textContent, btn: !!document.querySelector('[data-wsempty="b"] [data-wsnew]'),
    sel: document.querySelector('#projSel').disabled, crumb: document.getElementById('crumb').textContent }));
  ok('no-project member: empty state (b) with create button', nb.h === 'Henüz bir projeye eklenmedin' && nb.btn && nb.sel, JSON.stringify(nb));
  await Nb.press('body', 'w'); await sleep(250);
  ok('w shortcut without project does not crash', await Nb.evaluate(() => document.getElementById('scrim').classList.contains('on')));
  await Nb.evaluate(() => closeModal());
  for (const v of ['backlog', 'plan', 'reports', 'timesheet', 'effort', 'home', 'projects', 'search']) await view(Nb, v);
  const NVb = await mk('noproj-viewer'); await login(NVb, 'wsnv' + RUN, 'Baslangic123', 'WsPrjIzl1234!');
  await view(NVb, 'board');
  const nvb = await NVb.evaluate(() => ({ h: document.querySelector('[data-wsempty="b"] h3')?.textContent, btn: !!document.querySelector('[data-wsempty] button'),
    p: document.querySelector('[data-wsempty="b"] p')?.textContent }));
  ok('no-project viewer: (b) without button', nvb.h === 'Henüz bir projeye eklenmedin' && !nvb.btn && /Yöneticinden seni bir projeye eklemesini iste/.test(nvb.p), JSON.stringify(nvb));

  // 13) seçim kişisel ve kalıcı
  await A.evaluate(id => pickWs(id), wsA); await sleep(300); await flush(A);
  await A.reload(); await sleep(2200);
  ok('admin: selected workspace kept after reload', await A.evaluate(id => DB.ui.workspace === id && document.querySelector('#wsCur .nm').textContent.includes('Alan A'), wsA));

  // 14) dar ekran 375px: proje seç penceresi, ≥40px, yatay kaydırma yok
  const Mo = await mk('mobile', { width: 375, height: 812 }); await login(Mo, 'admin', 'admin12345');
  await view(Mo, 'projects');
  const mo = await Mo.evaluate(() => ({ sw: document.documentElement.scrollWidth, cols: new Set([...document.querySelectorAll('.ws-pcard')].slice(0, 6).map(c => Math.round(c.getBoundingClientRect().left))).size,
    more: Math.min(...[...document.querySelectorAll('.ws-more')].map(x => x.getBoundingClientRect().height)) }));
  ok('mobile projects: no horizontal scroll, single column, ≥40px buttons', mo.sw <= 376 && mo.cols === 1 && mo.more >= 40, JSON.stringify(mo));
  await Mo.click('#vtabs [data-v="__proj"]'); await sleep(250);
  const sh = await Mo.evaluate(() => { const m = document.querySelector('#scrim .modal'); const r = m.getBoundingClientRect();
    return { cur: document.querySelector('#pm_ws')?.getBoundingClientRect().height, rows: Math.min(...[...m.querySelectorAll('.ws-prow')].map(x => x.getBoundingClientRect().height)),
      l: r.left, r: r.right, sw: document.documentElement.scrollWidth }; });
  ok('mobile project sheet: workspace selector + rows ≥40px inside viewport', sh.cur >= 40 && sh.rows >= 40 && sh.l >= 0 && sh.r <= 375 && sh.sw <= 376, JSON.stringify(sh));
  await Mo.click('#pm_ws'); await sleep(200);
  await Mo.click('[data-wspick="ws1"][data-wssheet]'); await sleep(300);
  ok('mobile sheet: picking workspace shows its projects', await Mo.evaluate(() => DB.ui.workspace === 'ws1' && !!document.querySelector('#scrim .ws-prow[data-proj]')));
  await Mo.screenshot({ path: SS + 'mobile.png' });
  await Mo.evaluate(() => closeModal());

  // 15) XSS: alan adları metin olarak
  ok('no XSS from workspace names', await A.evaluate(() => window.__xss === undefined) && await Mb.evaluate(() => window.__xss === undefined) && await Mo.evaluate(() => window.__xss === undefined));
  await view(A, 'projects'); await A.screenshot({ path: SS + 'projects.png', fullPage: true });

  /* temizlik: p2 Genel'e döner (sonraki testler etkilenmesin) */
  await A.evaluate(() => { DB.projects.find(p => p.id === 'p2').workspaceId = 'ws1'; save(); }); await flush(A);

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
