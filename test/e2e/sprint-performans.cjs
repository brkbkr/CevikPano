// Sprint performansı (planlanan / gerçekleşen) ve komut paleti girişleri tarayıcı testi.
// Ön koşullar regresyon.cjs ile aynı: boş veritabanı, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123
// PORT=3100, demo veri (node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json).
// Sonra: node test/e2e/sprint-performans.cjs (BASE_URL ile adres değiştirilebilir; SHOT ile ekran görüntüsü yolu).
// Kendi alanını, projesini, sprintlerini ve kullanıcısını açar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SHOT = process.env.SHOT || require('os').tmpdir() + '/pano_spf_rapor.png';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PID = 'p_spf' + RUN, KEY = 'SF' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');
const XSS = '<img src=x onerror="window.__xss=1">';
const S0N = KEY + ' Sprint 0 ' + XSS, S1N = KEY + ' Sprint 1';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 950 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
  };
  const go = async (p, view) => {
    await p.evaluate(() => { location.hash = 'home'; }); await sleep(250);
    await p.evaluate(([pid, v]) => { DB.ui.project = pid; location.hash = v; }, [PID, view]);
    await sleep(600);
  };
  const palItems = (p, q = '') => p.evaluate(q => { palette(); if (q) { $('#pl_q').value = q; $('#pl_q').oninput(); } const t = [...document.querySelectorAll('#pl_r [data-pl]')]
    .map(x => [x.querySelector('.k').textContent, x.querySelector('.sum').textContent]); closeModal(); return t; }, q);
  const palRun = async (p, name) => { await p.evaluate(() => document.activeElement?.blur()); await p.keyboard.press('Control+k'); await sleep(250);
    await p.fill('#pl_q', name); await p.keyboard.press('Enter'); await sleep(500); };
  const perfRow = (p, sid) => p.evaluate(sid => { const r = document.querySelector(`#spPerf [data-spf="${sid}"]`);
    return r ? [...r.cells].map((c, k) => { const m = c.firstChild?.textContent?.trim() ?? '', sm = c.querySelector('small')?.textContent.trim();
      return k && sm ? m + '|' + sm : m; }).concat([r.textContent.includes('plan verisi yok') ? 'NA' : '']) : null; }, sid);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  const MU = 'spfuye' + RUN, MID = 'u_spf' + RUN, WSID = 'ws_spf' + RUN;
  const seed = await A.evaluate(async ([pid, key, mid, mu, wsid, s0n, s1n]) => {
    const st = ['Yapılacak', 'Devam ediyor', 'Bitti'].map((n, k) => ({ id: `${pid}_s${k}`, projectId: pid, name: n, cat: ['todo', 'inprogress', 'done'][k], wip: 0, ord: k }));
    const I = (n, sid, extra = {}) => ({ c: 'issues', id: `${pid}_i${n}`, op: 'put', data: { projectId: pid, key: `${key}-${n}`, type: 'task', summary: 'SPF iş ' + n,
      description: '', statusId: sid, assignee: null, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: n * 100, start: '', due: '', ...extra } });
    const H = (n, iss, at, from, to) => ({ c: 'history', id: `${pid}_h${n}`, op: 'put', data: { issueId: `${pid}_i${iss}`, userId: ME.id, at, field: 'Sprint', from, to } });
    const t = d => new Date(d + 'T12:00').getTime();
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: mid, op: 'put', data: { username: mu, name: 'SPF Üye', role: 'member', active: true, ini: 'SÜ', color: '#0F766E' } },
      { c: 'workspaces', id: wsid, op: 'put', data: { name: 'SPF alanı ' + key, color: '#3E7BC4', members: [{ userId: mid, role: 'member' }] } },
      { c: 'projects', id: pid, op: 'put', data: { name: 'Sprint perf ' + key, key, counter: 9, type: 'agile', members: [ME.id, mid], workspaceId: wsid } },
      ...st.map(s => ({ c: 'statuses', id: s.id, op: 'put', data: s })),
      /* eski (plansız) kapanmış sprint: geçmişten tahmin */
      { c: 'sprints', id: pid + '_sp0', op: 'put', data: { projectId: pid, name: s0n, state: 'closed', start: '2026-10-01', end: '2026-10-14' } },
      { c: 'sprints', id: pid + '_sp1', op: 'put', data: { projectId: pid, name: s1n, state: 'future', start: '', end: '' } },
      I(1, st[2].id, { sprintId: pid + '_sp0', points: 3 }),          // planlanan + biten (geçmişi yok)
      I(2, st[0].id, { sprintId: null, points: 5 }),                  // planlanan, kapanışta backlog'a taşındı
      I(3, st[2].id, { sprintId: pid + '_sp0', points: 2 }),          // sonradan eklendi, bitti
      I(4, st[0].id, { sprintId: pid + '_sp1', points: 3 }),
      I(5, st[0].id, { sprintId: pid + '_sp1', points: 2 }),
      I(6, st[0].id, { sprintId: null, points: 1 }),
    ] });
    const r2 = await API.post('/api/sync', { changes: [
      H(1, 3, t('2026-10-05'), 'Backlog', s0n), H(2, 2, t('2026-10-14'), s0n, 'Backlog')] });
    return [...(r.data?.rejected || r.rejected || []), ...(r2.data?.rejected || r2.rejected || [])];
  }, [PID, KEY, MID, MU, WSID, S0N, S1N]);
  ok('seed accepted', Array.isArray(seed) && seed.length === 0, JSON.stringify(seed));
  await A.reload(); await sleep(1800);

  /* ===== 1) eski sprint: plan verisi yok, geçmişten tahmin ===== */
  await go(A, 'reports');
  const r0 = await perfRow(A, PID + '_sp0');
  /* plan ~2 (i1 3p + i2 5p) · planlanandan biten 1 (i1 3p) · oran %50 iş / %38 puan · eklenen 1 (i3 2p) · eklenip biten 1 · taşınan 1 */
  ok('old sprint: "plan verisi yok", ~2 planned, 1 plan-done, %50 / %38, 1 added, 1 added-done, 1 moved',
    JSON.stringify(r0 && r0.slice(1)) === JSON.stringify(['~2|8 puan', '1|3 puan', '%50|%38 puan', '1|2 puan', '1|2 puan', '1', 'NA']), JSON.stringify(r0));
  ok('old sprint: active-sprint strip uses same (~) logic', await A.evaluate(sid => document.createRange().createContextualFragment(spPlanLine(sprint(sid)))
    .textContent.replace(/\s+/g, ' ').trim(), PID + '_sp0') === 'Planlanan ~2 iş · 8 puan Biten 1/~2 planlanan · %50 Sonradan eklenen 1 · biten 1');
  ok('sprint name escaped in report (no XSS)', await A.evaluate(() => !window.__xss && !document.querySelector('#spPerf img')
    && document.querySelector('#spPerf .spf-tbl')?.textContent.includes('onerror')));

  /* ===== 2) başlatma planı kaydeder ===== */
  await go(A, 'backlog');
  await A.click(`[data-start="${PID}_sp1"]`); await sleep(400);
  await A.click('#doStart'); await sleep(1500);
  const plan = await A.evaluate(async pid => (await API.get('/api/state')).data.sprints.find(s => s.id === pid + '_sp1')?.plan, PID);
  ok('start saves plan snapshot on server (2 issues, 5 points, ids)', plan && plan.count === 2 && plan.points === 5
    && JSON.stringify(plan.ids.slice().sort()) === JSON.stringify([PID + '_i4', PID + '_i5']) && plan.at > 0, JSON.stringify(plan));

  /* sonradan ekleme (i6, bitti) + bir planlananı bitirme (i4) → aktif sprintte canlı özet */
  await A.evaluate(pid => { const i = issue(pid + '_i6'); i.sprintId = pid + '_sp1'; logHist(i, 'Sprint', 'Backlog', sprint(pid + '_sp1').name);
    i.statusId = pid + '_s2'; issue(pid + '_i4').statusId = pid + '_s2'; save(); }, PID); await sleep(1200);
  await go(A, 'sprint');
  const line = await A.evaluate(() => document.querySelector('[data-spplan]')?.textContent.replace(/\s+/g, ' ').trim());
  ok('active sprint: planned vs plan-done (%50), added + added-done separate', line === 'Planlanan 2 iş · 5 puan Biten 1/2 planlanan · %50 Sonradan eklenen 1 · biten 1', line);
  await go(A, 'reports');
  const live = await A.evaluate(() => [...document.querySelectorAll('#spPerf [data-spflive] b')].map(b => b.textContent)
    .concat(document.querySelector('#spPerf [data-spflive] + .sub')?.textContent.includes('3/5 planlanan puan biten') ? 'pts' : ''));
  ok('reports: live summary of active sprint (2 / 1 / %50 / +1 / 1, 3/5 puan)', JSON.stringify(live) === JSON.stringify(['2', '1', '%50', '+1', '1', 'pts']), JSON.stringify(live));

  /* ===== 3) sunucu: plan alanı değişmez (alan Üyesi ve sistem yöneticisi) ===== */
  const M = await mk('member'); await login(M, MU, 'Baslangic123');
  await M.fill('#fp_a', 'SpfUye123456'); await M.fill('#fp_b', 'SpfUye123456'); await M.click('#fpForm button[type=submit]'); await sleep(1800);
  const tamper = async (p, plan) => p.evaluate(async ([pid, plan]) => { const s = { ...DB.sprints.find(x => x.id === pid + '_sp1'), plan };
    const r = await API.post('/api/sync', { changes: [{ c: 'sprints', id: s.id, op: 'put', data: s }] }); return (r.data?.rejected || r.rejected || []).map(x => x.reason); }, [PID, plan]);
  const bad = { count: 3, points: 6, ids: [PID + '_i4', PID + '_i5', PID + '_i6'], at: Date.now() };
  ok('member cannot change plan (server)', JSON.stringify(await tamper(M, bad)) === JSON.stringify(['Sprintin başlangıç planı değiştirilemez']));
  ok('admin cannot change or clear plan (server)', JSON.stringify([...await tamper(A, bad), ...await tamper(A, null)])
    === JSON.stringify(['Sprintin başlangıç planı değiştirilemez', 'Sprintin başlangıç planı değiştirilemez']));
  const kept = await M.evaluate(async pid => { const { plan: _p, ...s } = DB.sprints.find(x => x.id === pid + '_sp1');
    const r = await API.post('/api/sync', { changes: [{ c: 'sprints', id: s.id, op: 'put', data: { ...s, goal: 'Hedef' } }] });
    const d = (await API.get('/api/state')).data.sprints.find(x => x.id === pid + '_sp1');
    return { rej: (r.data?.rejected || r.rejected || []).length, count: d?.plan?.count, goal: d?.goal }; }, PID);
  ok('edit without plan field keeps plan', kept.rej === 0 && kept.count === 2 && kept.goal === 'Hedef', JSON.stringify(kept));

  /* ===== 4) tamamlama → rapor satırı ve grafik ===== */
  await A.reload(); await sleep(1800);
  await go(A, 'sprint');
  await A.click(`.as-head [data-spcomplete="${PID}_sp1"]`); await sleep(400);
  await A.click('.sp-dest [data-dest=""]'); await A.click('#doComplete'); await sleep(1500);
  await go(A, 'reports');
  const r1 = await perfRow(A, PID + '_sp1');
  /* plan 2 (5p) · planlanandan biten 1 (i4 3p) · %50 / %60 puan · eklenen 1 (i6 1p) · eklenip biten 1 · taşınan 1 (i5) */
  ok('closed sprint row: plan 2, plan-done 1, %50 / %60, added 1, added-done 1, moved 1, plan present',
    JSON.stringify(r1 && r1.slice(1)) === JSON.stringify(['2|5 puan', '1|3 puan', '%50|%60 puan', '1|1 puan', '1|1 puan', '1', '']), JSON.stringify(r1));
  const segs = await A.evaluate(() => [...document.querySelectorAll('#spPerf svg[role=img] rect[data-bar]')].map(r => r.dataset.bar + ':' + r.getAttribute('fill')));
  const SEG = ['plan:var(--line2)', 'added:url(#spfHA)', 'planDone:var(--accent)', 'addedDone:url(#spfHD)'];
  ok('chart: 4 distinguishable segments per sprint (colour + hatch pattern)', JSON.stringify(segs) === JSON.stringify([...SEG, ...SEG])
    && await A.evaluate(() => !!document.querySelector('#spPerf pattern#spfHA') && !!document.querySelector('#spPerf pattern#spfHD')), JSON.stringify(segs));
  ok('chart legend + bar labels', await A.evaluate(() => [...document.querySelectorAll('#spPerf svg[role=img] text')].map(t => t.textContent).filter(t => t.includes('/')).join(','))
    === '1/2 +1/1,1/2 +1/1' && await A.evaluate(() => ['Planlanan', 'Planlanandan biten', 'Sonradan eklenen', 'Sonradan eklenip biten']
      .every(n => document.getElementById('spPerf').textContent.includes(n))));
  const ch = await A.evaluate(() => ({ svg: !!document.querySelector('#spPerf svg[role=img]'), bars: document.querySelectorAll('#spPerf svg rect').length,
    rows: document.querySelectorAll('#spPerf [data-spf]').length, first: document.querySelector('#spPerf [data-spf]')?.dataset.spf, live: !!document.querySelector('[data-spflive]') }));
  ok('chart (SVG bars) + newest sprint first, no live block without active sprint', ch.svg && ch.bars >= 4 && ch.rows === 2 && ch.first === PID + '_sp1' && !ch.live, JSON.stringify(ch));
  await A.evaluate(() => document.getElementById('spPerf').scrollIntoView({ block: 'center' })); await sleep(200);
  await (await A.$('#spPerf')).screenshot({ path: SHOT });

  /* ===== 5) komut paleti ===== */
  await go(A, 'board');
  await A.evaluate(pid => { openIssue(pid + '_i5'); closeModal(); openIssue(pid + '_i4'); closeModal(); }, PID); await sleep(200);
  const ai = await palItems(A);
  const names = ai.map(x => x[1]);
  const need = ['Aktif sprinte git', 'Sprint raporu', 'Benim işlerim', 'Genel raporlar', 'Cariler', 'Kullanıcılar', 'Posta kutuları'];
  ok('admin palette: new entries', need.every(n => names.includes(n)), JSON.stringify(need.filter(n => !names.includes(n))));
  ok('admin palette: "<Proje> panosu" per project', JSON.stringify((await palItems(A, 'Sprint perf ' + KEY + ' panosu')))
    === JSON.stringify([['Pano', 'Sprint perf ' + KEY + ' panosu']]));
  ok('admin palette: no duplicate screen entries', ['Benim işlerim', 'Genel raporlar', 'Kullanıcılar', 'Cariler'].every(n => names.filter(x => x === n).length === 1));
  ok('admin palette: Talep havuzu follows viewAllowed', names.includes('Talep havuzu') === await A.evaluate(() => viewAllowed('pool')));
  ok('palette: last opened issues first (newest first)', ai[0][0] === 'Son' && ai[0][1].startsWith(KEY + '-4') && ai[1][1].startsWith(KEY + '-5'), JSON.stringify(ai.slice(0, 3)));
  await palRun(A, 'Sprint raporu');
  ok('"Sprint raporu" opens reports', await A.evaluate(() => DB.ui.view === 'reports' && !!document.getElementById('spPerf')));
  await palRun(A, 'Posta kutuları');
  ok('"Posta kutuları" opens Sistem → Posta kutuları', await A.evaluate(() => DB.ui.view === 'system' && SYS_TAB === 'mail'));
  await A.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'home'; render(); }, PID); await sleep(200);
  await palRun(A, 'Aktif sprinte git');
  ok('"Aktif sprinte git" opens sprint tab', await A.evaluate(() => DB.ui.view === 'sprint'));
  await palRun(A, 'Sprint perf ' + KEY + ' panosu');
  ok('"<Proje> panosu" opens project board', await A.evaluate(pid => DB.ui.view === 'board' && DB.ui.project === pid, PID));

  await go(M, 'board');
  const mn = (await palItems(M)).map(x => x[1]);
  ok('member palette: no admin entries, has sprint + own entries', !['Cariler', 'Kullanıcılar', 'Posta kutuları'].some(n => mn.includes(n))
    && ['Aktif sprinte git', 'Sprint raporu', 'Benim işlerim', 'Genel raporlar'].every(n => mn.includes(n))
    && (await palItems(M, 'panosu')).some(x => x[1] === 'Sprint perf ' + KEY + ' panosu'), JSON.stringify(mn.slice(0, 15)));

  await A.evaluate(() => { DB.ui.project = 'p1'; save(); }); await sleep(1200);
  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  console.log('ekran görüntüsü: ' + SHOT);
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
