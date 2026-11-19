// Proje yetkileri tarayıcı testi (yetki-v2, docs/tasarim/yetkiler). Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri);
// test kendi kullanıcılarını ve projelerini oluşturur, diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: proje Yöneticisi Yetkiler sekmesinde kişi ekler, rol değiştirir, Üye'ye "Proje adı ve ayarları"nı açar → Üye oturumunda
// proje adı düzenlenebilir; varsayılana dönüş. Üye'de sekme yok (#admin elle yazılsa da). Yeni proje formunda kişi + rol;
// İzleyici'de "+ İş" yok, Üye'de var; eklenmemiş kişi projeyi görmez. Kullanıcı penceresinde projeye rol verilir → açık sekme
// kendiliğinden yenilenir. Sistem ekranında varsayılan yetki değişir → kendi ayarı olmayan projede etkili. 390 px: kart görünümü,
// yatay kaydırma yok. XSS: kişi adı metin olarak basılır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SS = process.env.SS_DIR || '/tmp/pano_yetki_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const XSS = '<img src=x onerror="window.__xss=1">';
const Y = 'u_pmy' + R, M = 'u_pmm' + R, V = 'u_pmv' + R, X = 'u_pmx' + R;
const P1 = 'p_pm' + R, KEY = 'PM' + R.toUpperCase();

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 }); const p = await ctx.newPage();
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
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(250); } return -1; };
  const srvProj = (p, id) => p.evaluate(async id => (await API.get('/api/state')).data.projects.find(x => x.id === id) || null, id);
  const noHScroll = p => p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

  /* ---- kurulum: Y (proje Yöneticisi olacak), M (Üye), V (İzleyici; adı XSS), X (eklenmemiş) ---- */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  let r = await A.evaluate(async ([R, Y, M, V, X, P1, KEY, XSS]) => (await API.post('/api/sync', { changes: [
    { c: 'users', id: Y, op: 'put', data: { username: 'pmy' + R, name: 'Proje Yöneticisi ' + R, role: 'member', active: true, ini: 'PY', color: '#2563EB' } },
    { c: 'users', id: M, op: 'put', data: { username: 'pmm' + R, name: 'Proje Üyesi ' + R, role: 'member', active: true, ini: 'PÜ', color: '#0F766E' } },
    { c: 'users', id: V, op: 'put', data: { username: 'pmv' + R, name: 'İzleyen ' + XSS, role: 'viewer', active: true, ini: 'Pİ', color: '#64748B' } },
    { c: 'users', id: X, op: 'put', data: { username: 'pmx' + R, name: 'Dışarıdaki ' + R, role: 'member', active: true, ini: 'PD', color: '#B45309' } },
    { c: 'projects', id: P1, op: 'put', data: { name: 'Yetki Projesi ' + R, key: KEY, code: KEY, counter: 0, workspaceId: 'ws1', type: 'board', roles: { [Y]: 'admin' } } },
    { c: 'statuses', id: P1 + '_s0', op: 'put', data: { projectId: P1, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 } },
    { c: 'statuses', id: P1 + '_s1', op: 'put', data: { projectId: P1, name: 'Bitti', cat: 'done', wip: 0, ord: 1 } },
  ] })), [R, Y, M, V, X, P1, KEY, XSS]);
  ok('setup accepted', r.rejected.length === 0, JSON.stringify(r.rejected));

  /* ---- 1) proje Yöneticisi: Yetkiler sekmesi, kişi ekle, rol değiştir, Üye'ye proje ayarı ---- */
  const Yp = await mk('projadmin'); await login(Yp, 'pmy' + R, 'Baslangic123', 'PmYon123456!');
  await Yp.evaluate(pid => openProjPerms(pid), P1); await sleep(400);
  const t0 = await Yp.evaluate(() => ({ tabs: [...document.querySelectorAll('#adminTabs [data-a]')].map(x => x.dataset.a), on: document.querySelector('#adminTabs .on')?.dataset.a,
    rows: document.querySelectorAll('[data-pmrow]').length, lock: !!document.querySelector('[data-pmrow] .pm-rlock'), empty: !!document.querySelector('.pm-empty') }));
  ok('project admin: Yetkiler tab open, owner row locked', t0.tabs.includes('perms') && t0.on === 'perms' && t0.rows >= 1, JSON.stringify(t0));
  await Yp.selectOption('#pp_user', M); await sleep(50);
  ok('add: role suggested from general role (Üye)', (await Yp.inputValue('#pp_role')) === 'member');
  await Yp.click('#pp_add'); await sleep(300);
  await Yp.selectOption('#pp_user', V); await sleep(50);
  ok('add: viewer suggested as İzleyici', (await Yp.inputValue('#pp_role')) === 'viewer');
  await Yp.click('#pp_add'); await sleep(300);
  ok('XSS name rendered as text in people list', await Yp.evaluate(V => !window.__xss && !document.querySelector(`[data-pmrow="${V}"] img`)
    && document.querySelector(`[data-pmrow="${V}"] .nm`).textContent.includes('<img'), V));
  await Yp.selectOption(`[data-prole="${M}"]`, 'admin'); await sleep(200);
  await Yp.selectOption(`[data-prole="${M}"]`, 'member'); await sleep(200);
  await Yp.click('[data-permtable="proj"] tr[data-permrow="project.settings"] [data-pr="member"]'); await sleep(300);
  const t1 = await Yp.evaluate(() => ({ chg: document.querySelector('[data-pmchg]')?.dataset.pmchg, row: document.querySelector('[data-permtable="proj"] tr[data-permrow="project.settings"]')?.classList.contains('chg'),
    rev: !!document.querySelector('[data-permrev="project.settings"]'), all: !!document.querySelector('#permRevAll') }));
  ok('cell marked "changed in this project" + revert buttons', t1.chg === '1' && t1.row && t1.rev && t1.all, JSON.stringify(t1));
  await Yp.screenshot({ path: SS + 'sekme.png', fullPage: true });
  await flush(Yp); await sleep(400);
  const s1 = await srvProj(A, P1);
  ok('server: roles + sparse perms saved', s1?.roles?.[M] === 'member' && s1?.roles?.[V] === 'viewer' && s1?.roles?.[Y] === 'admin'
    && JSON.stringify(s1?.perms) === '{"member":{"project.settings":true}}' && s1.members.includes(M), JSON.stringify(s1));

  /* Üye oturumu: proje adı düzenlenebilir; Yetkiler sekmesi yok, #admin elle yazılsa da açılmaz */
  const Mp = await mk('member'); await login(Mp, 'pmm' + R, 'Baslangic123', 'PmUye123456!');
  await Mp.evaluate(pid => { DB.ui.project = pid; render(); openWsPage('ws1'); }, P1); await sleep(400);
  ok('member: project name editable after Üye got settings permission', await Mp.evaluate(pid => document.querySelector(`[data-projname="${pid}"]`)?.disabled === false, P1));
  await Mp.evaluate(() => { location.hash = 'admin'; }); await sleep(500);
  const m1 = await Mp.evaluate(() => ({ view: DB.ui.view, tab: !!document.querySelector('[data-a="perms"]'), pt: !!document.querySelector('[data-permstab]'), allowed: viewAllowed('admin') }));
  ok('member: no Yetkiler tab, #admin does not open it', m1.view !== 'admin' && !m1.tab && !m1.pt && !m1.allowed, JSON.stringify(m1));
  ok('member: server rejects writing roles', await Mp.evaluate(async ([pid, X]) => { const p = (await API.get('/api/state')).data.projects.find(x => x.id === pid);
    const r = await API.post('/api/sync', { changes: [{ c: 'projects', id: pid, op: 'put', data: { ...p, roles: { ...p.roles, [X]: 'member' } }, base: p }] });
    return r.rejected?.[0]?.reason === 'Projenin kişilerini ve yetkilerini yalnızca proje yöneticisi değiştirebilir'; }, [P1, X]));
  /* Varsayılana dönüş → Üye'nin adı düzenleme yetkisi kalkar (yoklama) */
  await Yp.click('[data-permrev="project.settings"]'); await sleep(300); await flush(Yp);
  ok('revert: project perms empty on server', JSON.stringify((await srvProj(A, P1))?.perms || {}) === '{}');
  ok('member: settings permission gone after revert (poll)', await waitFor(Mp, pid => !canDesign(DB.projects.find(p => p.id === pid)), P1) >= 0);

  /* ---- 3) yeni proje formu: kişiler ve roller; İzleyici'de "+ İş" yok, Üye'de var; eklenmemiş kişi görmez ---- */
  await Yp.evaluate(() => newProjectForm()); await sleep(300);
  await Yp.click('#ps_next'); await sleep(250);
  const f0 = await Yp.evaluate(() => ({ rows: document.querySelectorAll('#np_m [data-npmrow]').length, lock: !!document.querySelector('#np_m .pm-rlock'),
    info: document.querySelector('#np_wsinfo')?.textContent || '' }));
  ok('new project: creator locked as Yönetici, info line', f0.rows === 1 && f0.lock && /genel rolüne göre/.test(f0.info), JSON.stringify(f0));
  const PN = 'Formdan ' + R;
  await Yp.fill('#np_n', PN);
  await Yp.selectOption('#np_pu', M); await Yp.click('#np_padd'); await sleep(150);
  await Yp.selectOption('#np_pu', V); await sleep(50);
  ok('new project: viewer suggested as İzleyici', (await Yp.inputValue('#np_pr')) === 'viewer');
  await Yp.click('#np_padd'); await sleep(150);
  await Yp.screenshot({ path: SS + 'yeni-proje.png' });
  await Yp.click('#np_ok'); await sleep(500); await flush(Yp); await sleep(500);
  const NP = await Yp.evaluate(n => DB.projects.find(p => p.name === n)?.id, PN);
  const sn = NP && await srvProj(A, NP);
  ok('server: new project with owner and roles', sn && sn.ownerId === Y && sn.roles[Y] === 'admin' && sn.roles[M] === 'member' && sn.roles[V] === 'viewer' && !sn.roles[X], JSON.stringify(sn));
  const Vp = await mk('viewer'); await login(Vp, 'pmv' + R, 'Baslangic123', 'PmIzl123456!');
  await Vp.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render(); }, NP); await sleep(400);
  const v1 = await Vp.evaluate(() => ({ nw: !!document.querySelector('#newIssue'), qa: !!document.querySelector('[data-qa]'), ro: document.body.classList.contains('readonly'), sel: P()?.id }));
  ok('viewer: no "+ İş" / quick add, readonly body', v1.sel === NP && !v1.nw && !v1.qa && v1.ro, JSON.stringify(v1));
  ok('member: sees new project (poll) and has "+ İş"', await waitFor(Mp, pid => DB.projects.some(p => p.id === pid), NP) >= 0
    && await Mp.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render(); return !!document.querySelector('#newIssue'); }, NP));
  const Xp = await mk('outsider'); await login(Xp, 'pmx' + R, 'Baslangic123', 'PmDis123456!');
  const x1 = await Xp.evaluate(([a, b]) => ({ tree: !!document.querySelector(`#wsTree [data-proj="${a}"]`) || !!document.querySelector(`#wsTree [data-proj="${b}"]`),
    sel: selectableProjects().some(p => p.id === a || p.id === b), data: DB.projects.some(p => p.id === a || p.id === b) }), [NP, P1]);
  ok('outsider: projects not in tree, selectors or data', !x1.tree && !x1.sel && !x1.data, JSON.stringify(x1));

  /* ---- 5) Sistem → Varsayılan yetkiler: kendi ayarı olmayan projede etkili, olanda değil; yalnız sistem yöneticisi ---- */
  await A.evaluate(() => { SYS_TAB = 'perms'; DB.ui.view = 'system'; render(); }); await sleep(800);
  ok('system: default permission table shown to system admin', await A.evaluate(() => !!document.querySelector('[data-permtable="sys"]') && !!document.querySelector('#sysPermReset')));
  await A.click('[data-permtable="sys"] tr[data-permrow="project.settings"] [data-pr="member"]'); await sleep(600); await flush(A);
  const sp = await A.evaluate(async () => (await API.get('/api/state')).data.perms);
  ok('system: default saved sparsely on server', sp?.member?.['project.settings'] === true && Object.keys(sp.member).length === 1, JSON.stringify(sp));
  await Yp.evaluate(pid => openProjPerms(pid), P1); await sleep(1500);
  await Yp.evaluate(() => reloadState()); await sleep(500);
  await Yp.evaluate(pid => openProjPerms(pid), P1); await sleep(300);
  ok('project tab follows the new default (Üye ✓, not marked changed)', await Yp.evaluate(() => {
    const c = document.querySelector('[data-permtable="proj"] tr[data-permrow="project.settings"] [data-pr="member"]'); return c?.checked && !c.closest('tr').classList.contains('chg'); }));
  await Yp.click('[data-permtable="proj"] tr[data-permrow="project.settings"] [data-pr="member"]'); await sleep(300); await flush(Yp);
  ok('member: default applies to project without own value, not to project with own value (poll)', await waitFor(Mp, ([a, b]) =>
    canDesign(DB.projects.find(p => p.id === b)) && !canDesign(DB.projects.find(p => p.id === a)), [P1, NP]) >= 0);
  ok('member: server rejects writing the default', await Mp.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: '_settings', id: 'perms', op: 'put',
    data: { v: 1, member: { 'project.columns': true } } }] })).rejected?.[0]?.reason === 'Bu değişiklik için yönetici yetkisi gerekli'));
  await A.evaluate(() => { SYS_TAB = 'perms'; render(); }); await sleep(600);
  await A.screenshot({ path: SS + 'sistem.png', fullPage: true });
  await A.click('#sysPermReset'); await sleep(500); await flush(A);
  ok('system: factory reset', await A.evaluate(async () => { const p = (await API.get('/api/state')).data.perms; return !Object.keys(p?.member || {}).length && !Object.keys(p?.viewer || {}).length; }));
  await Yp.evaluate(async pid => { await reloadState(); const p = DB.projects.find(x => x.id === pid); p.perms = {}; save(); await flushAll(); }, P1);
  /* masaüstü görüntüsü: Yetkiler sekmesinin üstü (kişiler) */
  await Yp.evaluate(pid => openProjPerms(pid), P1); await sleep(400);
  await Yp.evaluate(() => document.querySelector('[data-permstab]')?.scrollIntoView({ block: 'start' })); await sleep(200);
  await Yp.screenshot({ path: SS + 'kisiler.png' });

  /* ---- 6) 390 px: Yetkiler sekmesi kart görünümü, yatay kaydırma yok ---- */
  const Ym = await mk('mobile', { width: 390, height: 844 }); await login(Ym, 'pmy' + R, 'PmYon123456!');
  await Ym.evaluate(pid => openProjPerms(pid), P1); await sleep(500);
  const mo = await Ym.evaluate(() => ({ cards: getComputedStyle(document.querySelector('[data-permcards="proj"]')).display, table: getComputedStyle(document.querySelector('[data-permtable="proj"]')).display,
    n: document.querySelectorAll('[data-permcards="proj"] .pm-pc').length }));
  ok('mobile: permission cards instead of table', mo.cards === 'flex' && mo.table === 'none' && mo.n >= 10, JSON.stringify(mo));
  ok('mobile: no horizontal scroll', await noHScroll(Ym));
  await Ym.screenshot({ path: SS + 'mobil.png', fullPage: true });
  await Ym.click(`[data-permcards="proj"] [data-pr="viewer"][data-pk="comment.write"]`); await sleep(300); await flush(Ym);
  ok('mobile: toggling a card cell saves', (await srvProj(A, P1))?.perms?.viewer?.['comment.write'] === true);

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
