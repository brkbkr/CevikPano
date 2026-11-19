// Kayıtlı (parametrik) raporlar tarayıcı testi.
// Ön koşullar regresyon.cjs ile aynı: temiz DB, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123,
// demo veri (seed-demo) + 005. Test kendi kullanıcılarını, alanını, projesini ve işlerini açar; diğer testlerden sonra da çalışır.
// Kapsam: kapsam seçici (Tüm sistem / Çalışma alanı / Proje), ölçü (saat / iş sayısı / puan) ve çubuk grafik; raporu kaydet,
// listede gör, aç (ayar geri gelir), düzenle (ad, görünürlük), değişikliği kaydet, kopyala, sil; paylaşılan rapor kapsamına
// erişimi olmayana görünmez, alana eklenince görünür ve salt okunur; hazır rapordan "Kopyala ve düzenle"; proje sekmesinde
// kapsam kilitli; XSS (rapor adı ve açıklaması); mobilde liste taşmaz.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SHOT = process.env.SHOT_DIR || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const U1 = 'u_kr1' + R, U2 = 'u_kr2' + R, N1 = 'kr1' + R, N2 = 'kr2' + R, WS = 'ws_kr' + R, PID = 'p_kr' + R;
const KEY = 'KR' + R.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6), MON = '2025-04';
const XSS = '<img src=x onerror="window.__xss=1">';
const RNAME = 'Proje saatleri ' + XSS, RDESC = 'Açıklama ' + XSS;

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: vp.width < 900 });
    const p = await ctx.newPage();
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
  const sync = (p, changes) => p.evaluate(ch => API.post('/api/sync', { changes: ch }), changes);
  const srvReports = p => p.evaluate(async () => (await API.get('/api/state')).data.reports || []);
  const shot = async (p, name) => { if (SHOT) await p.screenshot({ path: `${SHOT}/${name}.png`, fullPage: false }); };
  const gr = async (p, tab, f) => {
    await p.evaluate(([tab, f]) => { closeModal(); GR.cell = null; if (f) DB.ui.grF = f; DB.ui.grTab = tab;
      if (location.hash === '#raporlar/' + tab) { DB.ui.view = 'greports'; render(); } else location.hash = 'raporlar/' + tab; }, [tab, f]); await sleep(500);
  };
  const pv = p => p.evaluate(() => { const R = GR.last; return { total: R.grand, ms: R.ms, scope: R.X.scope.map(x => x.id), rowK: R.rowK, colK: R.colK }; });
  const put = (c, id, data) => ({ c, id, op: 'put', data });

  /* ---------------- kurulum: alan, proje, işler, süre kayıtları, iki kullanıcı ---------------- */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345'); await sleep(800);
  const at = d => Date.parse(d + 'T12:00:00Z');
  let r = await sync(A, [
    put('users', U1, { username: N1, name: 'Rapor Ayşe ' + R, role: 'member', active: true }),
    put('users', U2, { username: N2, name: 'Rapor Bora ' + R, role: 'member', active: true })]);
  r = await sync(A, [
    put('workspaces', WS, { name: 'Rapor alanı ' + R, color: '#2563EB', members: [{ userId: U1, role: 'member' }] }),
    /* İstemcinin şema tamamlayıcısı (ensureProjects) bir şey yazmasın: kod, arşiv ve üye listesi dolu (Üye proje kaydını yazamaz). */
    put('projects', PID, { name: 'Rapor projesi', key: KEY, code: KEY, counter: 3, archived: false, workspaceId: WS, members: [U1, U2] }),
    put('statuses', PID + '_s0', { projectId: PID, name: 'Yapılacak', cat: 'todo', ord: 0 }),
    put('statuses', PID + '_s1', { projectId: PID, name: 'Bitti', cat: 'done', ord: 1 }),
    put('issues', PID + '_i1', { projectId: PID, key: KEY + '-1', summary: 'Birinci', statusId: PID + '_s0', type: 'task', points: 3, assignee: U1, created: at('2025-04-02') }),
    put('issues', PID + '_i2', { projectId: PID, key: KEY + '-2', summary: 'İkinci', statusId: PID + '_s1', type: 'task', points: 5, created: at('2025-04-09') }),
    put('issues', PID + '_i3', { projectId: PID, key: KEY + '-3', summary: 'Eski', statusId: PID + '_s0', type: 'task', points: 8, assignee: U1, created: at('2025-02-01') }),
    put('worklogs', PID + '_w1', { issueId: PID + '_i1', userId: U1, date: '2025-04-10', hours: 2.5 }),
    put('worklogs', PID + '_w2', { issueId: PID + '_i2', userId: U1, date: '2025-04-11', hours: 4 })]);
  ok('setup: workspace, project, issues and worklogs written', r.rejected.length === 0, JSON.stringify(r.rejected));

  const M = await mk('member1'); await login(M, N1, 'Baslangic123', 'RaporYeni12345'); await sleep(500);

  /* ---------------- kapsam seçici ---------------- */
  await gr(M, 'sure', { month: MON });
  ok('scope selector: three options, "Tüm sistem" selected by default', await M.evaluate(() =>
    [...document.querySelectorAll('[data-grsk]')].map(b => b.dataset.grsk).join() === 'all,ws,project'
    && document.querySelector('[data-grsk="all"]').getAttribute('aria-checked') === 'true'));
  const pAll = await pv(M);
  ok('Tüm sistem: member sees only accessible projects (no hidden workspace projects)', pAll.scope.includes(PID)
    && await M.evaluate(sc => sc.every(id => projVisible(DB.projects.find(p => p.id === id))), pAll.scope));
  await M.click('[data-grsk="ws"]'); await sleep(300);
  await M.selectOption('[data-grsid]', WS); await sleep(300);
  const pWs = await pv(M);
  ok('Çalışma alanı scope: only projects of that workspace, total 6,5 h', pWs.scope.join() === PID && pWs.total === 6.5, JSON.stringify(pWs));
  ok('crumb shows the scope name', await M.evaluate(() => /^Rapor alanı/.test(document.getElementById('crumb').textContent)));
  await M.click('[data-grsk="project"]'); await sleep(300);
  await M.selectOption('[data-grsid]', PID); await sleep(300);
  const pP = await pv(M);
  ok('Proje scope: one project; project filter hidden', pP.scope.join() === PID && await M.evaluate(() => !document.querySelector('[data-grf="proj"]') && !document.querySelector('[data-grf="ws"]')));

  /* ---------------- ölçü ve grafik ---------------- */
  await M.selectOption('[data-grmeasure]', 'count'); await sleep(300);
  const pc = await pv(M);
  ok('measure "İş sayısı": issues created in the period (2 of 3)', pc.ms === 'count' && pc.total === 2, JSON.stringify(pc));
  await M.selectOption('[data-grmeasure]', 'points'); await sleep(300);
  ok('measure "Puan": 3 + 5 = 8', (await pv(M)).total === 8);
  await M.click('[data-grch="bar"]'); await sleep(300);
  ok('bar chart shown with one bar per row', await M.evaluate(() => !!document.querySelector('#grChart') && document.querySelectorAll('#grChart .gr-bars li').length === GR.last.rows.length));
  await M.selectOption('[data-grmeasure]', 'hours'); await sleep(300);
  await M.selectOption('[data-grdim="row"]', 'status'); await sleep(300);
  ok('status dimension: Yapılacak 2,5 / Bitti 4', await M.evaluate(() => { const R = GR.last; return R.rowK === 'status' && R.rT.get('Yapılacak') === 2.5 && R.rT.get('Bitti') === 4; }));

  /* ---------------- kaydet (paylaşılan, sabit dönem), XSS ---------------- */
  await M.click('[data-grsaveas]'); await sleep(300);
  ok('save dialog: scope shown, share option enabled for project scope', await M.evaluate(() => /Rapor projesi/.test(document.querySelector('[data-grssc]').textContent)
    && !document.querySelector('input[name="grs_v"][value="shared"]').disabled));
  await M.fill('#grs_n', RNAME); await M.fill('#grs_d', RDESC);
  await M.check('input[name="grs_v"][value="shared"]'); await M.click('#grs_ok'); await sleep(400); await flush(M); await sleep(300);
  let reps = (await srvReports(M)).filter(x => x.ownerId === U1);
  const rep = reps.find(x => x.name === RNAME);
  ok('saved on server: shared, project scope, row/measure/chart/period', !!rep && rep.vis === 'shared' && rep.scope.kind === 'project' && rep.scope.id === PID
    && rep.cfg.row === 'status' && rep.cfg.ms === 'hours' && rep.cfg.ch === 'bar' && rep.cfg.per === 'month' && rep.cfg.month === MON && rep.desc === RDESC, JSON.stringify(rep));
  ok('report bar shows the name as text (no markup)', await M.evaluate(n => document.querySelector('#grRName').textContent === n && !document.querySelector('#grRName img'), RNAME));
  await shot(M, 'kayitli-rapor-acik');

  /* ---------------- değiştir → kaydedilmemiş değişiklik → Kaydet ---------------- */
  await M.selectOption('[data-grdim="col"]', 'user'); await sleep(300);
  ok('change → "Kaydedilmemiş değişiklik" and Kaydet button', await M.evaluate(() => !!document.querySelector('[data-grdirty]') && !!document.querySelector('[data-grsave]')));
  await M.click('[data-grsave]'); await sleep(300); await flush(M); await sleep(200);
  reps = await srvReports(M);
  ok('Kaydet updates the saved config on server', reps.find(x => x.id === rep.id)?.cfg.col === 'user' && await M.evaluate(() => !document.querySelector('[data-grdirty]')));

  /* ---------------- liste: aç (ayar geri gelir), düzenle, kopyala, sil ---------------- */
  await gr(M, 'sure', { month: '2024-01', row: 'customer' });
  await gr(M, 'liste');
  ok('list: groups Hazır / Benim / Paylaşılan, search box', await M.evaluate(id => ['tpl', 'mine', 'shared'].every(k => document.querySelector(`[data-grsec="${k}"]`))
    && !!document.querySelector('#grQ') && !!document.querySelector(`[data-grsec="mine"] [data-grri="${id}"]`) && document.querySelectorAll('[data-grsec="tpl"] .gr-ri').length === 5, rep.id));
  await shot(M, 'kayitli-rapor-liste');
  ok('list: recent shows the report', await M.evaluate(id => !!document.querySelector(`.gr-rrec [data-gropen="${id}"]`), rep.id));
  await M.fill('#grQ', 'hiçyokböyle'); await sleep(150);
  ok('search: no match → message', await M.evaluate(() => !document.querySelector('#grQNone').hidden));
  await M.fill('#grQ', 'proje saat'); await sleep(150);
  ok('search: matches by name (case-insensitive)', await M.evaluate(id => !document.querySelector(`[data-grri="${id}"]`).hidden && document.querySelector('#grQNone').hidden, rep.id));
  await M.click(`[data-grsec="mine"] .acts [data-gropen="${rep.id}"]`); await sleep(500);
  const op = await M.evaluate(() => ({ tab: grTab(), f: { ...grF() }, rowK: GR.last.rowK, colK: GR.last.colK, total: GR.last.grand, cur: DB.ui.grCur }));
  ok('open: config restored (scope, dims, period, chart), no dirty flag', op.tab === 'sure' && op.f.sk === 'project' && op.f.sid === PID && op.rowK === 'status' && op.colK === 'user'
    && op.f.month === MON && op.f.ch === 'bar' && op.total === 6.5 && op.cur === rep.id && await M.evaluate(() => !document.querySelector('[data-grdirty]')), JSON.stringify(op));
  await gr(M, 'liste');
  await M.click(`[data-gredit="${rep.id}"]`); await sleep(300);
  await M.fill('#grs_n', 'Proje saatleri (düzenlendi)'); await M.check('input[name="grs_v"][value="private"]'); await M.click('#grs_ok'); await sleep(300); await flush(M); await sleep(200);
  reps = await srvReports(M);
  ok('edit: name and visibility saved', reps.find(x => x.id === rep.id)?.name === 'Proje saatleri (düzenlendi)' && reps.find(x => x.id === rep.id)?.vis === 'private');
  await M.click(`[data-grcopy="${rep.id}"]`); await sleep(300); await flush(M); await sleep(200);
  reps = (await srvReports(M)).filter(x => x.ownerId === U1);
  const cp = reps.find(x => x.name === 'Proje saatleri (düzenlendi) (kopya)');
  ok('copy: private copy with same config', !!cp && cp.vis === 'private' && JSON.stringify(cp.cfg) === JSON.stringify(reps.find(x => x.id === rep.id).cfg));
  await M.click(`[data-grdel="${cp.id}"]`); await sleep(300); await flush(M); await sleep(200);
  ok('delete: copy removed on server and from list', !(await srvReports(M)).some(x => x.id === cp.id) && await M.evaluate(id => !document.querySelector(`[data-grri="${id}"]`), cp.id));
  /* tekrar paylaş */
  await M.click(`[data-gredit="${rep.id}"]`); await sleep(300);
  await M.check('input[name="grs_v"][value="shared"]'); await M.click('#grs_ok'); await sleep(300); await flush(M); await sleep(200);

  /* ---------------- hazır rapordan kopyala ve düzenle ---------------- */
  await M.click('[data-grcopy="tpl:kisifat"]'); await sleep(700);
  ok('template copy: dialog prefilled "Kişi × Faturalama (kopya)"', await M.evaluate(() => document.querySelector('#grs_n')?.value === 'Kişi × Faturalama (kopya)'));
  await M.click('#grs_ok'); await sleep(300); await flush(M); await sleep(200);
  const tc = (await srvReports(M)).find(x => x.ownerId === U1 && x.tpl === 'kisifat');
  ok('template copy: personal report with template dims', !!tc && tc.vis === 'private' && tc.cfg.row === 'user' && tc.cfg.col === 'billable', JSON.stringify(tc));
  ok('template copy: report opened (bar shows its name)', await M.evaluate(() => document.querySelector('#grRName')?.textContent === 'Kişi × Faturalama (kopya)'));

  /* ---------------- paylaşılan rapor: erişimi olmayana görünmez ---------------- */
  const B = await mk('member2'); await login(B, N2, 'Baslangic123', 'RaporYeni12345'); await sleep(500);
  ok('no access: shared report not in client data nor server state', await B.evaluate(id => !(DB.reports || []).some(x => x.id === id), rep.id)
    && !(await srvReports(B)).some(x => x.id === rep.id));
  await gr(B, 'liste');
  ok('no access: not listed', await B.evaluate(id => !document.querySelector(`[data-grri="${id}"]`), rep.id));
  /* alana eklenince görünür (salt okunur: düzenle/sil yok) */
  const w = await A.evaluate(async id => (await API.get('/api/state')).data.workspaces.find(x => x.id === id), WS);
  r = await sync(A, [{ c: 'workspaces', id: WS, op: 'put', data: { ...w, members: [...w.members, { userId: U2, role: 'viewer' }] }, base: w }]);
  await B.evaluate(() => reloadState()); await sleep(600);
  await gr(B, 'liste');
  ok('after joining workspace: listed under Paylaşılan, no edit/delete', await B.evaluate(id => !!document.querySelector(`[data-grsec="shared"] [data-grri="${id}"]`)
    && !document.querySelector(`[data-gredit="${id}"]`) && !document.querySelector(`[data-grdel="${id}"]`), rep.id));
  ok('private copy of the owner still invisible', !(await srvReports(B)).some(x => x.id === tc.id));
  await B.click(`[data-grsec="shared"] .acts [data-gropen="${rep.id}"]`); await sleep(500);
  ok('other user opens shared report: same config, own data', await B.evaluate(pid => grF().sk === 'project' && grF().sid === pid && GR.last.rowK === 'status' && GR.last.grand === 6.5
    && !document.querySelector('[data-grsave]'), PID));
  /* sunucu: başkası değiştiremez */
  const rr = await B.evaluate(async id => { const x = DB.reports.find(r => r.id === id); return API.post('/api/sync', { changes: [{ c: 'reports', id, op: 'put', data: { ...x, name: 'ele geçirildi' }, base: x }] }); }, rep.id);
  ok('server: non-owner write rejected', rr.applied === 0 && /sahibi/.test(rr.rejected[0]?.reason || ''), JSON.stringify(rr));

  /* ---------------- proje sekmesi: kapsam kilitli ---------------- */
  await M.evaluate(pid => { closeModal(); DB.ui.project = pid; DB.ui.rpTab = 'param'; DB.ui.grTabP = 'liste'; location.hash = 'reports'; }, PID); await sleep(600);
  ok('project tab: same engine, list shows project report', await M.evaluate(id => DB.ui.view === 'reports' && !!document.querySelector('[data-rptab="param"][aria-checked="true"]')
    && !!document.querySelector(`[data-grri="${id}"]`), rep.id));
  await M.click(`[data-grsec="mine"] .acts [data-gropen="${rep.id}"]`); await sleep(500);
  ok('project tab: opened with scope locked to the project', await M.evaluate(pid => DB.ui.view === 'reports' && grInProj() && grF().sid === pid && !!document.querySelector('[data-grsclock]')
    && !document.querySelector('[data-grsk]') && GR.last.grand === 6.5 && location.hash === '#reports', PID));
  ok('project tab: general report prefs untouched', await M.evaluate(() => DB.ui.grF?.month !== undefined && DB.ui.grFP?.sk === 'project'));
  await M.click('[data-rptab="ozet"]'); await sleep(300);
  ok('project tab: back to summary panels', await M.evaluate(() => !document.querySelector('.gr') && !!document.querySelector('.grid2')));
  await M.evaluate(() => { DB.ui.rpTab = 'ozet'; save(); });

  /* ---------------- mobil: liste taşmaz ---------------- */
  const MM = await mk('member1-mobile', { width: 390, height: 844 }); await login(MM, N1, 'RaporYeni12345'); await sleep(400);
  await gr(MM, 'liste');
  const mo = await MM.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, n: document.querySelectorAll('.gr-ri').length }));
  ok('mobile 390px: report list fits (no page overflow)', mo.n >= 7 && mo.sw <= mo.cw + 1, JSON.stringify(mo));

  ok('XSS: no script ran', !(await M.evaluate(() => window.__xss)) && !(await B.evaluate(() => window.__xss)) && !(await MM.evaluate(() => window.__xss)));

  /* temizlik: raporlar (diğer testler etkilenmesin) */
  await A.evaluate(async ids => API.post('/api/sync', { changes: ids.map(id => ({ c: 'reports', id, op: 'del' })) }), [rep.id, tc.id]);

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
