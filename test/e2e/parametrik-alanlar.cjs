// Parametrik proje alanları tarayıcı testi (docs/tasarim/parametrik-alanlar).
// Ön koşullar regresyon.cjs ile aynı: temiz DB, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123,
// demo veri (seed-demo) + 005. Test kendi kullanıcılarını, alanını ve projesini açar; diğer testlerden sonra da çalışır.
// Kapsam: alan yöneticisi Alanlar sekmesini görür ve proje alanı ekler, üye göremez/ekleyemez; hazır alan aç/kapat
// (değerler silinmez); kartta değer girme; pano rozetleri; kapatılınca toplamlar değişmez; demo faturalama değerleri
// korunur; XSS (alan adı, seçenek); genel raporda alan boyutları, Alan süzgeci ve hazır şablonlar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_pa_';
const SHOT = process.env.SHOT_DIR || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const Y = 'u_pay' + R, M = 'u_pam' + R, WS = 'ws_pa' + R, PID = 'p_pa' + R, KEY = 'PA' + R.toUpperCase().replace(/[^A-Z0-9]/g, '');
const I1 = PID + '_i1', I2 = PID + '_i2', CU = 'cu_pa' + R, MON = '2025-05';
const XSS = '<img src=x onerror="window.__xss=1">';
const FN = 'Sahne ' + XSS, OPT2 = '<b>Kalın</b>' + XSS;

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
  const srv = (p, fn, arg) => p.evaluate(async ([src, arg]) => { const d = (await API.get('/api/state')).data; return (0, eval)(src)(d, arg); }, [fn.toString(), arg]);
  const go = async (p, view) => {
    await p.evaluate(() => { location.hash = 'home'; }); await sleep(250);
    await p.evaluate(([pid, v]) => { closeModal(); DB.ui.project = pid; DB.board.scope = 'all'; DB.board.swimlane = 'none';
      DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = ''; location.hash = v; }, [PID, view]); await sleep(400);
  };
  const fieldsTab = async p => { await go(p, 'admin'); await p.evaluate(() => { DB.ui.adminTab = 'fields'; render(); }); await sleep(200); };
  const pm = async (p, kind) => { await p.evaluate(k => document.querySelector(`#idSide [data-pm="${k}"]`).scrollIntoView({ block: 'center' }), kind); await sleep(300);
    await p.click(`#idSide [data-pm="${kind}"]`); await sleep(250); };
  const shot = async (p, name) => { if (SHOT) await p.screenshot({ path: `${SHOT}/${name}.png`, fullPage: false }); };

  /* ---------------- 0) demo veri: faturalama değerleri ve toplamlar (hiçbir ayar yapmadan) ---------------- */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await sleep(1500); await flush(A);
  const DEMO_IDS = require('../fixtures/demo.json').issues.map(i => i.id);
  const demoVals = () => srv(A, (d, ids) => Object.fromEntries(d.issues.filter(i => ids.includes(i.id)).map(i => [i.id, [i.billable ?? null, i.billType ?? null]])), DEMO_IDS);
  const demo0 = await demoVals();
  ok('demo: issues keep billing values after app load (nothing written)', Object.keys(demo0).length >= 20
    && Object.values(demo0).every(([b, t]) => b === 'Faturalanacak' && t === 'Kişi/Saat'), JSON.stringify([Object.keys(demo0).length, DEMO_IDS.length]));
  const demoTot = async () => {
    await A.evaluate(() => { closeModal(); GR.cell = null; DB.ui.grF = { month: '2026-10' }; DB.ui.grTab = 'fatura';
      if (location.hash === '#raporlar/fatura') { DB.ui.view = 'greports'; render(); } else location.hash = 'raporlar/fatura'; }); await sleep(500);
    return A.evaluate(() => ({ f: +document.querySelector('[data-grf-f]')?.dataset.grfF, n: +document.querySelector('[data-grf-n]')?.dataset.grfN,
      t: +document.querySelector('[data-grf-t]')?.dataset.grfT }));
  };
  const dt0 = await demoTot();
  const dtExp = await A.evaluate(() => { const IM = new Map(DB.issues.map(i => [i.id, i])); let f = 0, n = 0;
    DB.worklogs.filter(w => w.date >= '2026-10-01' && w.date <= '2026-10-31').forEach(w => { const i = IM.get(w.issueId); if (!i || !grScope().some(p => p.id === i.projectId)) return;
      if (i.billable === 'Faturalanmayacak') n += w.hours; else f += w.hours; }); return { f: Math.round(f * 100) / 100, n: Math.round(n * 100) / 100 }; });
  ok('demo: billable hours report unchanged rule (empty/other = Faturalanacak)', dt0.f === dtExp.f && dt0.n === dtExp.n && dt0.t === dtExp.f + dtExp.n && dt0.t > 0, JSON.stringify([dt0, dtExp]));
  await A.evaluate(() => { DB.ui.project = 'p1'; openIssue(DB.issues.find(i => i.projectId === 'p1' && i.type !== 'epic').id); }); await sleep(400);
  const dd = await A.evaluate(() => ({ bill: document.querySelector('[data-pm="bill"]')?.textContent.trim(), bt: document.querySelector('[data-pm="btype"]')?.textContent.trim(),
    cari: !!document.querySelector('[data-pm="cari"]') }));
  ok('demo project without field records: all presets open (Faturalama, Fatura türü, Cari) with values', dd.bill === 'Faturalanacak' && dd.bt === 'Kişi/Saat' && dd.cari, JSON.stringify(dd));
  await A.evaluate(() => closeModal());

  /* ---------------- kurulum (yönetici, API) ---------------- */
  await A.evaluate(async ([R, Y, M, WS, PID, KEY, I1, I2, CU, MON]) => {
    const r1 = await API.post('/api/sync', { changes: [
      { c: 'users', id: Y, op: 'put', data: { username: 'pay' + R, name: 'Pa Yönetici ' + R, role: 'member', active: true } },
      { c: 'users', id: M, op: 'put', data: { username: 'pam' + R, name: 'Pa Üye ' + R, role: 'member', active: true } },
      { c: 'customers', id: CU, op: 'put', data: { name: 'Pa Cari ' + R, kind: 'customer', active: true, contacts: [] } }] });
    const r2 = await API.post('/api/sync', { changes: [
      { c: 'workspaces', id: WS, op: 'put', data: { name: 'Pa Alanı ' + R, members: [{ userId: Y, role: 'admin' }, { userId: M, role: 'member' }] } }] });
    const r3 = await API.post('/api/sync', { changes: [
      { c: 'projects', id: PID, op: 'put', data: { key: KEY, code: KEY, name: 'Param Proje ' + R, workspaceId: WS, counter: 2, members: [], archived: false, type: 'board', customerId: CU } },
      { c: 'statuses', id: PID + '_s0', op: 'put', data: { projectId: PID, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 } },
      { c: 'statuses', id: PID + '_s1', op: 'put', data: { projectId: PID, name: 'Bitti', cat: 'done', wip: 0, ord: 1 } }] });
    const r4 = await API.post('/api/sync', { changes: [
      { c: 'issues', id: I1, op: 'put', data: { projectId: PID, key: KEY + '-1', type: 'task', summary: 'Birinci iş', statusId: PID + '_s0', priority: 3, labels: [], cf: {}, rank: 1,
        billable: 'Faturalanmayacak', billType: 'Adam/Ay', estimate: 0, spent: 0, created: Date.now() } },
      { c: 'issues', id: I2, op: 'put', data: { projectId: PID, key: KEY + '-2', type: 'task', summary: 'İkinci iş', statusId: PID + '_s0', priority: 3, labels: [], cf: {}, rank: 2,
        estimate: 0, spent: 0, created: Date.now() } }] });
    const r5 = await API.post('/api/sync', { changes: [
      { c: 'worklogs', id: PID + '_w1', op: 'put', data: { issueId: I1, userId: Y, date: MON + '-06', hours: 4 } },
      { c: 'worklogs', id: PID + '_w2', op: 'put', data: { issueId: I2, userId: M, date: MON + '-07', hours: 3 } },
      { c: 'worklogs', id: PID + '_w3', op: 'put', data: { issueId: I2, userId: Y, date: MON + '-20', hours: 1.5 } }] });
    if ([r1, r2, r3, r4, r5].some(r => r.rejected?.length)) throw new Error(JSON.stringify([r1, r2, r3, r4, r5].map(r => r.rejected)));
    await reloadState();
  }, [R, Y, M, WS, PID, KEY, I1, I2, CU, MON]);

  /* ---------------- 1) alan yöneticisi: Alanlar sekmesi, hazır alanlar, proje alanı ekle (XSS) ---------------- */
  const YP = await mk('wsadmin'); await login(YP, 'pay' + R, 'Baslangic123', 'PaYon123456');
  await go(YP, 'admin');
  const tabsY = await YP.evaluate(() => [...document.querySelectorAll('#adminTabs [data-a]')].map(b => b.dataset.a));
  ok('field admin: project settings show İş akışı + Alanlar tabs only', JSON.stringify(tabsY) === '["workflow","fields"]', JSON.stringify(tabsY));
  await YP.click('#adminTabs [data-a="fields"]'); await sleep(300);
  const t0 = await YP.evaluate(() => ({ rows: [...document.querySelectorAll('#pfTab [data-pfrow^="b:"]')].map(r => [r.dataset.pfrow, r.classList.contains('on')]),
    add: !!document.querySelector('#addField'), empty: !!document.querySelector('#pfTab .pf-empty') }));
  ok('Alanlar: three presets listed and open by default (no records), + Alan ekle, empty state', JSON.stringify(t0.rows) === '[["b:billable",true],["b:billType",true],["b:customerId",true]]'
    && t0.add && t0.empty, JSON.stringify(t0));
  await YP.click('#addField'); await sleep(250);
  await YP.fill('#pf_n', FN); await YP.fill('#pf_k', 'sahne');
  await YP.fill('[data-pfo="0"]', 'Canlı');
  await YP.click('[data-pfoadd]'); await sleep(150); await YP.fill('[data-pfo="1"]', OPT2);
  await YP.selectOption('#pf_def', 'Canlı');
  await YP.click('[data-pfsw2="onCard"]');
  await YP.click('#pf_ok'); await sleep(300); await flush(YP); await sleep(300);
  const nf = await srv(YP, (d, pid) => d.fields.find(f => f.projectId === pid && f.key === 'sahne') || null, PID);
  ok('field admin adds project field (server: projectId, options, default, onCard)', nf && nf.type === 'select' && nf.options.join('|') === 'Canlı|' + OPT2 && nf.def === 'Canlı' && nf.onCard === true && !nf.bind,
    JSON.stringify(nf));
  const FID = nf?.id;
  ok('XSS: field name and option rendered as text in Alanlar', await YP.evaluate(() => !window.__xss && !document.querySelector('#pfTab img, #pfTab b b')
    && [...document.querySelectorAll('#pfTab .pf-nm .n')].some(x => x.textContent.includes('<img'))));
  /* Fatura türü: "Sabit fiyat" seçeneği + Kartta göster (panel açıkken ekran görüntüsü) */
  await YP.click('[data-pfedit="b:billType"]'); await sleep(250);
  await YP.click('[data-pfoadd]'); await sleep(150);
  await YP.fill('[data-pfo="2"]', 'Sabit fiyat');
  await YP.click('[data-pfsw2="onCard"]');
  const pan = await YP.evaluate(() => ({ key: $('#pf_k').disabled, types: [...document.querySelectorAll('[data-pftype]')].map(b => [b.dataset.pftype, b.disabled]),
    sel: document.querySelector('.pf-row.sel')?.dataset.pfrow }));
  ok('preset edit panel: key and type locked, row highlighted', pan.key && JSON.stringify(pan.types) === '[["select",true]]' && pan.sel === 'b:billType', JSON.stringify(pan));
  await shot(YP, 'alanlar-sekmesi');
  await YP.click('#pf_ok'); await sleep(300); await flush(YP); await sleep(300);
  const bt = await srv(YP, (d, pid) => d.fields.find(f => f.projectId === pid && f.bind === 'billType') || null, PID);
  ok('preset saved as bind record (deterministic id, hidden for old version, options, onCard)', bt && bt.id === 'cf_billType_' + PID && bt.hidden === true && bt.key === 'faturaturu'
    && bt.options.join('|') === 'Kişi/Saat|Adam/Ay|Sabit fiyat' && bt.onCard === true, JSON.stringify(bt));
  /* Faturalama seçenekleri sabit (panelde düzenlenmez) */
  await YP.click('[data-pfedit="b:billable"]'); await sleep(200);
  ok('Faturalama options are fixed (no option inputs)', await YP.evaluate(() => !document.querySelector('[data-pfo]') && document.querySelectorAll('.pf-fixed .chip').length === 2));
  await YP.click('[data-pfclose]'); await sleep(150);

  /* ---------------- 2) üye: sekme yok, sunucu reddeder ---------------- */
  const MP = await mk('member'); await login(MP, 'pam' + R, 'Baslangic123', 'PaUye123456');
  await fieldsTab(MP);
  const mt = await MP.evaluate(() => ({ tabs: [...document.querySelectorAll('#adminTabs [data-a]')].map(b => b.dataset.a), pf: !!document.querySelector('#pfTab') }));
  ok('member: no Alanlar tab, forced tab does not open it', !mt.tabs.includes('fields') && !mt.pf, JSON.stringify(mt));
  const mr = await MP.evaluate(async pid => (await API.post('/api/sync', { changes: [{ c: 'fields', id: 'f_m_' + pid, op: 'put', data: { projectId: pid, key: 'uyealan', name: 'Üye', type: 'text' } }] })), PID);
  ok('member: server rejects project field (403 reason)', mr.applied === 0 && mr.rejected?.[0]?.reason === 'Bu değişiklik için yönetici yetkisi gerekli', JSON.stringify(mr));

  /* ---------------- 3) kartta (iş detayında) değer girme ---------------- */
  await go(MP, 'board');
  await MP.evaluate(id => openIssue(id), I2); await sleep(400);
  const d2 = await MP.evaluate(fid => ({ bill: document.querySelector('[data-pm="bill"]')?.textContent.replace(/\s+/g, ' ').trim(),
    sel: [...document.querySelectorAll(`select[data-cf="${fid}"] option`)].map(o => o.textContent) }), FID);
  ok('detail: empty Faturalama shows "—" (raporda Faturalanacak); custom select options as text', /^—\s*\(raporda Faturalanacak\)$/.test(d2.bill || '')
    && d2.sel.join('|') === '—|Canlı|' + OPT2, JSON.stringify(d2));
  await pm(MP, 'btype');
  const menu = await MP.evaluate(() => [...document.querySelectorAll('.qm-opt')].map(b => b.dataset.qv));
  ok('Fatura türü menu: blank + project options (incl. Sabit fiyat)', JSON.stringify(menu) === JSON.stringify(['', 'Kişi/Saat', 'Adam/Ay', 'Sabit fiyat']), JSON.stringify(menu));
  await MP.click('.qm-opt[data-qv="Sabit fiyat"]'); await sleep(300);
  await MP.selectOption(`select[data-cf="${FID}"]`, 'Canlı'); await sleep(300);
  await flush(MP); await sleep(300);
  const s2 = await srv(MP, (d, id) => d.issues.find(i => i.id === id), I2);
  ok('member enters values in issue (server: billType, cf)', s2.billType === 'Sabit fiyat' && s2.cf?.[FID] === 'Canlı' && !s2.billable, JSON.stringify([s2.billType, s2.cf, s2.billable]));
  await MP.evaluate(() => closeModal());

  /* ---------------- 4) pano rozetleri ---------------- */
  await YP.evaluate(() => reloadState());
  await go(YP, 'board'); await sleep(300);
  const badges = id => YP.evaluate(id => [...document.querySelectorAll(`.card[data-id="${id}"] .c-fb`)].map(x => [x.textContent.trim(), x.classList.contains('risk')]), id);
  const b2 = await badges(I2), b1 = await badges(I1);
  ok('card badges: Fatura türü + custom field (I2), Fatura türü only (I1)', JSON.stringify(b2) === JSON.stringify([['Fatura türü: Sabit fiyat', false], [FN + ': Canlı', false]])
    && JSON.stringify(b1) === JSON.stringify([['Fatura türü: Adam/Ay', false]]), JSON.stringify([b2, b1]));
  /* Faturalama kartta: yalnız Faturalanmayacak iken (risk rozeti) */
  await fieldsTab(YP);
  await YP.click('[data-pfcard="b:billable"]'); await sleep(300); await flush(YP);
  await go(YP, 'board');
  const b1b = await badges(I1), b2b = await badges(I2);
  ok('Faturalama badge only when "Faturalanmayacak" (red)', b1b.some(([t, r]) => t === 'Faturalanmayacak' && r) && !b2b.some(([t]) => /Faturalan/.test(t)), JSON.stringify([b1b, b2b]));
  ok('XSS: badges rendered as text', await YP.evaluate(() => !window.__xss && !document.querySelector('.c-fb img')));
  await YP.evaluate(() => DB.ui.view = 'board');

  /* ---------------- 5) hazır alanı kapat: detay, form, kart; değerler korunur; geri aç ---------------- */
  await A.evaluate(async () => { await reloadState(); }); await sleep(300);
  const tot = () => A.evaluate(async ([pid, mon]) => { await reloadState(); closeModal(); GR.cell = null; DB.ui.grF = { month: mon, proj: pid }; DB.ui.grTab = 'fatura';
    if (location.hash === '#raporlar/fatura') { DB.ui.view = 'greports'; render(); } else location.hash = 'raporlar/fatura';
    await new Promise(r => setTimeout(r, 400));
    return { f: +document.querySelector('[data-grf-f]').dataset.grfF, n: +document.querySelector('[data-grf-n]').dataset.grfN, t: +document.querySelector('[data-grf-t]').dataset.grfT }; }, [PID, MON]);
  const T0 = await tot();
  ok('billable hours before closing: F=4.5 (blank counts), N=4, T=8.5', T0.f === 4.5 && T0.n === 4 && T0.t === 8.5, JSON.stringify(T0));
  await fieldsTab(YP);
  await YP.click('[data-pfsw="b:billType"]'); await sleep(300); await flush(YP); await sleep(300);
  const bt2 = await srv(YP, (d, pid) => [d.fields.find(f => f.id === 'cf_billType_' + pid)?.archived, d.issues.find(i => i.id === pid + '_i1')?.billType], PID);
  ok('close Fatura türü: record archived, issue value kept on server', bt2[0] === true && bt2[1] === 'Adam/Ay', JSON.stringify(bt2));
  await go(YP, 'board');
  ok('closed field: no Fatura türü badge on cards', !(await badges(I1)).some(([t]) => /Fatura türü/.test(t)) && !(await badges(I2)).some(([t]) => /Fatura türü/.test(t)));
  await YP.evaluate(id => openIssue(id), I1); await sleep(300);
  ok('closed field: not in issue detail', await YP.evaluate(() => !document.querySelector('[data-pm="btype"]') && !!document.querySelector('[data-pm="bill"]')));
  await YP.evaluate(() => { closeModal(); newIssueForm({}); }); await sleep(300);
  ok('closed field: not in new issue form (Faturalama there with default)', await YP.evaluate(() => !document.querySelector('#f_btype') && $('#f_bill')?.value === 'Faturalanacak'));
  await YP.evaluate(() => closeModal());
  const T1 = await tot();
  ok('closing Fatura türü does not change billable totals', JSON.stringify(T1) === JSON.stringify(T0), JSON.stringify([T0, T1]));
  /* Faturalama kapatılır: toplam aynı, kapalı alan Faturalanacak sayılır */
  await fieldsTab(YP);
  await YP.click('[data-pfsw="b:billable"]'); await sleep(300); await flush(YP); await sleep(300);
  const T2 = await tot();
  ok('closing Faturalama: total unchanged', T2.t === T0.t, JSON.stringify([T0, T2]));
  ok('closing Faturalama keeps issue value on server', (await srv(YP, (d, id) => d.issues.find(i => i.id === id)?.billable, I1)) === 'Faturalanmayacak');
  /* yeniden aç: değerler geri gelir */
  await YP.click('[data-pfsw="b:billType"]'); await sleep(200); await YP.click('[data-pfsw="b:billable"]'); await sleep(300); await flush(YP); await sleep(300);
  await YP.evaluate(id => openIssue(id), I1); await sleep(300);
  const re = await YP.evaluate(() => [document.querySelector('[data-pm="btype"]')?.textContent.trim(), document.querySelector('[data-pm="bill"]')?.textContent.trim()]);
  ok('reopened fields: values come back (Adam/Ay, Faturalanmayacak)', re[0] === 'Adam/Ay' && re[1] === 'Faturalanmayacak', JSON.stringify(re));
  await YP.evaluate(() => closeModal());
  /* yeni iş: varsayılanlar (zorunlu değil; boş seçilebilir) */
  await go(YP, 'board');
  await YP.evaluate(() => newIssueForm({})); await sleep(300);
  await YP.fill('#f_sum', 'Boş faturalı iş ' + R);
  await YP.evaluate(() => { $('#f_moreBtn').click(); }); await sleep(100);
  const nd = await YP.evaluate(fid => ({ b: $('#f_bill').value, t: $('#f_btype').value, c: document.querySelector(`#f_more select[data-cf="${fid}"]`)?.value }), FID);
  ok('new issue form: project defaults preselected (Faturalanacak, Kişi/Saat, custom default)', nd.b === 'Faturalanacak' && nd.t === 'Kişi/Saat' && nd.c === 'Canlı', JSON.stringify(nd));
  await YP.selectOption('#f_btype', ''); await YP.click('#doCreate'); await sleep(300); await flush(YP); await sleep(300);
  const ni = await srv(YP, (d, s) => d.issues.find(i => i.summary === s) || null, 'Boş faturalı iş ' + R);
  ok('new issue with blank Fatura türü is saved (not required)', ni && ni.billable === 'Faturalanacak' && !ni.billType, JSON.stringify(ni && [ni.billable, ni.billType]));

  /* ---------------- 6) mobil: Alanlar sekmesi taşmaz ---------------- */
  const YM = await mk('wsadmin-mobile', { width: 390, height: 844 }); await login(YM, 'pay' + R, 'PaYon123456');
  await fieldsTab(YM);
  const ov = await YM.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, rows: document.querySelectorAll('#pfTab .pf-row').length }));
  ok('mobile 390px: Alanlar tab without horizontal overflow', ov.rows >= 4 && ov.sw <= ov.cw + 1, JSON.stringify(ov));

  /* ---------------- P2 raporlar ---------------- */
  /*@@P2@@*/

  /* ---------------- demo veri: değerler yine aynı ---------------- */
  const demo1 = await demoVals();
  ok('demo: billing values preserved at the end', JSON.stringify(demo1) === JSON.stringify(demo0));
  ok('demo totals unchanged at the end', JSON.stringify(await demoTot()) === JSON.stringify(dt0));

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
