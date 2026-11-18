// Proje türü (Pano / Agile) ve kolon yönetimi tarayıcı testi (issue #12-a, docs/tasarim/proje-turu).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/proje-turu.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını ve
// projelerini oluşturur (demo projelerinin türü ve kolonları değişmez); demo'da genel sprint kapalı (türsüz
// projeler Pano), Agile davranışı için test içinde açılan bir projeye type:'agile' yazılır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_pt_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const M = 'u_ptm' + RUN, V = 'u_ptv' + RUN;
const PC = 'p_ptc' + RUN, PA = 'p_pta' + RUN;          // kolon testi projesi (Pano, türsüz) ve Agile projesi

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
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
  const go = async (p, pid, v) => { await p.evaluate(([pid, v]) => { closeModal(); DB.ui.project = pid; DB.ui.view = v; render(); }, [pid, v]); await sleep(200); };
  const waitFor = async (p, fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const flush = p => p.evaluate(() => flushAll());
  const srvAll = (p, c) => p.evaluate(async c => (await API.get('/api/state')).data[c] || [], c);
  const srv = async (p, c, id) => (await srvAll(p, c)).find(x => x.id === id) || null;
  const dlgRows = p => p.evaluate(() => [...document.querySelectorAll('#scrim .pt-row [data-cn]')].map(e => e.value));

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([R, M, V, PC, PA]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'ptm' + R, name: 'Tür Üye ' + R, role: 'member', active: true, ini: 'TÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'ptv' + R, name: 'Tür İzleyici ' + R, role: 'viewer', active: true, ini: 'Tİ', color: '#64748B' } },
    ] });
    await reloadState();
    const p = DB.projects.find(x => x.id === 'p1'); p.members = [...new Set([...(p.members || []), M, V])];
    const used = new Set(DB.projects.map(x => x.code || x.key));
    const kc = projCode('Kolon Test ' + R, used); used.add(kc); const ka = projCode('Agile Test ' + R, used);
    DB.projects.push({ id: PC, key: kc, code: kc, name: 'Kolon Test ' + R, lead: SESSION, counter: 0, members: [SESSION, M, V], archived: false, workspaceId: 'ws1' });
    DB.projects.push({ id: PA, key: ka, code: ka, name: 'Agile Test ' + R, type: 'agile', lead: SESSION, counter: 0, members: [SESSION, M, V], archived: false, workspaceId: 'ws1' });
    [['Yapılacak', 'todo'], ['Geliştirmede', 'inprogress'], ['İncelemede', 'inprogress'], ['Testte', 'inprogress'], ['Bitti', 'done']]
      .forEach(([n, c], k) => DB.statuses.push({ id: `${PC}_s${k}`, projectId: PC, name: n, cat: c, wip: 0, ord: k }));
    [['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['Bitti', 'done']]
      .forEach(([n, c], k) => DB.statuses.push({ id: `${PA}_s${k}`, projectId: PA, name: n, cat: c, wip: 0, ord: k }));
    const t = iso(new Date());
    DB.sprints.push({ id: 'sp_pt' + R, projectId: PA, name: 'Deneme Sprint 1', state: 'active', start: t, end: iso(addD(new Date(t + 'T12:00'), 13)), goal: '' });
    const mk = (pid, n, st, extra = {}) => { const pr = DB.projects.find(x => x.id === pid);
      DB.issues.push({ id: `i_pt${R}${pid === PC ? 'c' : 'a'}${n}`, projectId: pid, key: `${pr.key}-${++pr.counter}`, type: 'task', summary: `Tür deneme ${n}`, description: '',
        statusId: st, assignee: M, reporter: SESSION, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: 1000 + n,
        start: '', due: '', estimate: 0, spent: 0, sprintId: null, ...extra }); };
    [1, 2, 3].forEach(n => mk(PC, n, `${PC}_s1`)); [4, 5].forEach(n => mk(PC, n, `${PC}_s0`));
    mk(PA, 1, `${PA}_s0`, { sprintId: 'sp_pt' + R }); mk(PA, 2, `${PA}_s1`);
    save(); await flushAll();
  }, [RUN, M, V, PC, PA]);
  const Mb = await mk('member'); await login(Mb, 'ptm' + RUN, 'Baslangic123', 'TurUye12345!');
  const Vb = await mk('viewer'); await login(Vb, 'ptv' + RUN, 'Baslangic123', 'TurIzl12345!');

  // 1) türsüz proje + genel sprint kapalı → Pano: menü "İş listesi", kapsam yok, sprint yok
  const pano = await A.evaluate(() => {
    closeModal(); DB.ui.project = 'p1'; DB.ui.view = 'board'; render();
    const r = { type: projType(P()), stored: 'type' in P(), nav: document.querySelector('#vtabs [data-v="backlog"]').textContent.trim(),
      tab: document.querySelector('#vtabs [data-v="backlog"]').textContent.trim(), scope: !!document.getElementById('scope'),
      cols: !!document.getElementById('colsEdit') };
    DB.ui.view = 'backlog'; render();
    /* Proje ekranında başlık proje adı; açık ekranın adı seçili sekmede. */
    Object.assign(r, { title: document.querySelector('#vtabs [aria-selected="true"]').textContent.trim(), name: document.getElementById('title').textContent === P().name,
      newSprint: !!document.getElementById('newSprint'),
      list: /İş listesi/.test(document.querySelector('#view .sb-h b')?.textContent || ''), boxes: document.querySelectorAll('.sprintbox.active').length });
    newIssueForm(); r.spField = !!document.getElementById('f_sp'); closeModal();
    DB.ui.view = 'reports'; render(); r.burn = /Sprint burndown|Sprint hızı/.test(document.getElementById('view').textContent);
    return r;
  });
  ok('türsüz proje (sprint kapalı) Pano sayılır, kayda yazılmaz', pano.type === 'board' && !pano.stored, JSON.stringify(pano));
  ok('Pano: sekme "İş listesi", açık sekme "İş listesi", başlık proje adı', pano.nav === 'İş listesi' && pano.tab === 'İş listesi' && pano.title === 'İş listesi' && pano.name, JSON.stringify(pano));
  ok('Pano: kapsam geçişi, "+ Sprint oluştur", sprint kutusu, Sprint alanı, burndown/hız yok',
    !pano.scope && !pano.newSprint && pano.list && !pano.boxes && !pano.spField && !pano.burn, JSON.stringify(pano));
  ok('admin panoda "Kolonları düzenle" görür', pano.cols);

  const legacySprint = await A.evaluate(() => {
    const previous = DB.cfg.modules.sprint;
    DB.cfg.modules.sprint = true;
    DB.ui.view = 'board'; render();
    const opensBacklog = DB.ui.view === 'backlog' && !('type' in P())
      && !!document.querySelector('#tab-sprint') && !document.querySelector('#tab-board');
    DB.cfg.modules.sprint = previous; DB.ui.view = 'board'; render();
    return opensBacklog;
  });
  ok('türsüz eski projede genel sprint ayarı açıksa Pano yerine Backlog açılır', legacySprint);

  // 2) Agile projesi (test içinde type:'agile') → proje değişince menü/araç çubuğu tek çizimde değişir
  const agile = await A.evaluate(PA => {
    DB.ui.project = PA; DB.ui.view = 'board'; DB.board.scope = 'sprint'; render();
    const r = { tabs: [...document.querySelectorAll('#vtabs [data-v]')].map(el => el.dataset.v), hash: location.hash, view: DB.ui.view };
    Object.assign(r, { title: document.querySelector('#vtabs [aria-selected="true"]').textContent.trim(), name: document.getElementById('title').textContent === P().name,
      newSprint: !!document.getElementById('newSprint'),
      active: document.querySelectorAll('.sprintbox.active').length });
    newIssueForm(); r.spField = !!document.getElementById('f_sp'); closeModal();
    DB.ui.view = 'reports'; render(); r.burn = /Sprint burndown/.test(document.getElementById('view').textContent);
    DB.ui.project = 'p1'; DB.ui.view = 'board'; render();
    r.back = { nav: document.querySelector('#vtabs [data-v="backlog"]').textContent.trim(), scope: !!document.getElementById('scope') };
    return r;
  }, PA);
  ok('Agile: eski Pano tercihi Backlog açar, ardından Aktif sprint sekmesi, "+ Sprint oluştur", Sprint alanı, burndown',
    agile.view === 'backlog' && agile.hash === '#backlog' && agile.tabs.slice(0, 2).join() === 'backlog,sprint' && !agile.tabs.includes('board')
    && agile.title === 'Backlog' && agile.name && agile.newSprint && agile.active === 1 && agile.spField && agile.burn, JSON.stringify(agile));
  ok('Agile → Pano proje değişimi tek çizimde menüyü ve kapsamı değiştirir', agile.back.nav === 'İş listesi' && !agile.back.scope, JSON.stringify(agile.back));
  ok('Pano: pano aktif sprint kapsamı istense de tüm işleri gösterir', await A.evaluate(() => {
    DB.board.scope = 'sprint'; DB.board.q = ''; DB.board.filterUser = ''; DB.board.filterType = ''; render();
    return boardIssues().length === issuesOf().filter(i => i.type !== 'epic' && !i.parentId).length && !/Aktif sprint yok/.test(document.getElementById('view').textContent);
  }));

  // Üye ve izleyici için de eski bağlantı, klavye kısayolu ve komut paleti proje türüne uyar.
  for (const [rol, p] of [['üye', Mb], ['izleyici', Vb]]) {
    await go(p, PA, 'reports');
    await p.evaluate(() => { location.hash = 'board'; });
    await p.waitForFunction(() => location.hash === '#backlog');
    ok(rol + ': #board → Backlog', await p.locator('#tab-backlog').getAttribute('aria-selected') === 'true');
    await p.keyboard.press('g'); await p.keyboard.press('b');
    await p.waitForSelector('#tab-sprint[aria-selected="true"]');
    ok(rol + ': G+B aktif sprinti açar', await p.locator('.as-head').isVisible());
    await p.keyboard.press('Control+k'); await p.waitForSelector('#pl_r');
    const screens = await p.locator('#pl_r .row').evaluateAll(rows => rows.filter(r => r.querySelector('.k').textContent === 'Git')
      .map(r => r.querySelector('.sum').textContent));
    ok(rol + ': palette Backlog ve Aktif sprint var, Pano yok', screens.includes('Backlog') && screens.includes('Aktif sprint') && !screens.includes('Pano'), JSON.stringify(screens));
    await p.keyboard.press('Escape');
  }

  // 3) kapalı ekran adresleri çökmez
  for (const h of ['backlog', 'roadmap']) {
    await A.evaluate(h => { location.hash = h; }, h); await sleep(350);
    ok(`#${h} Pano projesinde çökmez`, await A.evaluate(() => !!document.getElementById('view').innerHTML && !!document.getElementById('title').textContent));
  }

  // 3b) Proje ayarları: sprint modül anahtarı kalktı, not var; epik/puan/raporlayan genel kalır; İş akışında tür ve kolon satırı
  const adm = await A.evaluate(PC => {
    closeModal(); DB.ui.project = PC; DB.ui.view = 'admin'; DB.ui.adminTab = 'people'; render();
    const r = { sprintMod: !!document.querySelector('[data-mod="sprint"]'), others: ['epic', 'points', 'reporter'].every(k => !!document.querySelector(`[data-mod="${k}"]`)),
      note: /Sprint artık proje türüyle belirlenir/.test(document.getElementById('view').textContent) };
    DB.ui.adminTab = 'workflow'; render();
    r.tag = document.querySelector('#view .pt-set .pt-type')?.textContent.trim(); r.typeBtn = !!document.getElementById('ptTypeSet');
    document.getElementById('ptColsSet')?.click(); r.dlg = !!document.querySelector('#scrim.on .modal[data-cols]'); closeModal();
    return r;
  }, PC);
  ok('Proje ayarları: sprint anahtarı yok, "Sprint artık proje türüyle belirlenir", diğer modüller duruyor', !adm.sprintMod && adm.others && adm.note, JSON.stringify(adm));
  ok('Proje ayarları → İş akışı: tür etiketi, "Türü değiştir…", "Kolonları düzenle" penceresi açar', adm.tag === 'Pano' && adm.typeBtn && adm.dlg, JSON.stringify(adm));

  // 4) Projeler kartı: tür etiketi + ⋯ "Türü değiştir…" (izleyicide yok)
  await go(A, PC, 'projects');
  const tags = await A.evaluate(ids => ids.map(id => document.querySelector(`[data-wsproj="${id}"] .pt-type`)?.textContent.trim()), ['p1', PC, PA]);
  ok('Projeler kartı: "Pano" / "Agile" etiketi', tags[0] === 'Pano' && tags[1] === 'Pano' && tags[2] === 'Agile', JSON.stringify(tags));
  await A.click(`[data-wsproj="${PC}"] [data-wsmore]`); await sleep(150);
  ok('⋯ menüsünün ilk maddesi "Türü değiştir…" (Şu an Pano)', await A.evaluate(PC => {
    const mi = document.querySelector(`[data-wsproj="${PC}"] .ws-pop .ws-mi`); return !!mi && mi.dataset.ptypedlg === PC && /Türü değiştir…/.test(mi.textContent) && /Şu an Pano/.test(mi.textContent); }, PC));
  await A.click(`[data-wsproj="${PC}"] [data-ptypedlg]`); await sleep(200);
  ok('Türü değiştir: şu anki tür seçili, düğme pasif', await A.evaluate(() => document.querySelector('[data-ptype="board"]').getAttribute('aria-checked') === 'true'
    && document.getElementById('pt_tok').disabled));
  await A.focus('[data-ptype="board"]'); await A.keyboard.press('ArrowRight'); await sleep(100);
  ok('ok tuşu Agile seçer; "Agile\'a geçince" listesi', await A.evaluate(() => document.querySelector('[data-ptype="agile"]').getAttribute('aria-checked') === 'true'
    && /Agile'a geçince/.test(document.querySelector('#scrim').textContent) && !document.getElementById('pt_tok').disabled));
  await A.click('#pt_tok'); await sleep(200); await flush(A);
  ok('tür sunucuya yazıldı (Pano → Agile)', (await srv(A, 'projects', PC))?.type === 'agile');
  await A.evaluate(PC => typeDialog(PC), PC); await sleep(150);
  await A.click('[data-ptype="board"]'); await sleep(100);
  ok('Agile → Pano (aktif sprint yok): "Pano\'ya geçince" listesi, düğme açık', await A.evaluate(() => !document.querySelector('#scrim .ws-alert')
    && /Pano'ya geçince/.test(document.querySelector('#scrim').textContent) && !document.getElementById('pt_tok').disabled));
  await A.click('#pt_tok'); await sleep(200); await flush(A);
  ok('tür sunucuya yazıldı (Agile → Pano)', (await srv(A, 'projects', PC))?.type === 'board');
  await A.evaluate(PA => typeDialog(PA), PA); await sleep(150);
  await A.click('[data-ptype="board"]'); await sleep(100);
  const blk = await A.evaluate(() => ({ alert: document.querySelector('#scrim .ws-alert b')?.textContent, dis: document.getElementById('pt_tok').disabled, bl: !!document.getElementById('pt_tbl') }));
  ok('Agile → Pano: aktif sprint varken uyarı, düğme pasif, "Backlog\'a git"', blk.alert === 'Önce aktif sprinti tamamlayın' && blk.dis && blk.bl, JSON.stringify(blk));
  await A.click('#pt_tbl'); await sleep(250);
  ok('"Backlog\'a git" Agile projenin backlog\'unu açar', await A.evaluate(PA => DB.ui.project === PA && DB.ui.view === 'backlog'
    && !document.getElementById('scrim').classList.contains('on') && !!document.querySelector('.sprintbox.active'), PA));
  ok('izleyici ⋯ menüsünde "Türü değiştir…" yok', await (async () => { await go(Vb, PC, 'projects');
    return Vb.evaluate(() => !document.querySelector('[data-ptypedlg]')); })());

  // 5) "Kolonları düzenle" görünürlüğü: yönetici + üye görür, izleyici görmez
  /* tür değişikliği (Agile → Pano) yoklamayla üyeye ve izleyiciye ulaşsın */
  for (const p of [Mb, Vb]) await waitFor(p, PC => DB.projects.find(x => x.id === PC)?.type === 'board', PC, 9000);
  await go(Mb, PC, 'board'); await go(Vb, PC, 'board');
  ok('üye (proje üyesi) "Kolonları düzenle" görür', await Mb.evaluate(() => !!document.getElementById('colsEdit')));
  ok('izleyici "Kolonları düzenle" görmez', await Vb.evaluate(() => !document.getElementById('colsEdit') && canEditCols(P()) === false));

  await go(A, PC, 'board');
  // 6) Üye kolon ekler / adlandırır / sıralar (klavye) / siler; 2. tarayıcı ≤4 sn'de görür
  await Mb.click('#colsEdit'); await sleep(200);
  const before = await dlgRows(Mb);
  ok('pencere: kolonlar sırayla, son Bitti kilitli ve ipucu', before.length === 5 && await Mb.evaluate(() => {
    const rows = [...document.querySelectorAll('#scrim .pt-row')]; const last = rows[rows.length - 1];
    return last.querySelector('[data-cc]').disabled && last.querySelector('[data-cx]').disabled && /Projede en az bir Bitti kolonu kalmalı/.test(last.textContent); }), JSON.stringify(before));
  await Mb.click('#pt_add'); await sleep(200);
  ok('Kolon ekle: "Yeni kolon" (Devam ediyor) eklenir, ad seçili', await Mb.evaluate(() => {
    const el = document.activeElement; return el?.dataset.cn === '5' && el.value === 'Yeni kolon' && document.querySelector('[data-cc="5"]').value === 'inprogress'; }));
  await Mb.fill('[data-cn="5"]', 'YAPILACAK'); await Mb.press('[data-cn="5"]', 'Enter'); await sleep(150);
  ok('aynı ad (tr harf duyarsız) satır içi hata', await Mb.evaluate(() => /Bu adla bir kolon zaten var/.test(document.querySelector('#c5-e')?.textContent || '')
    && document.querySelector('[data-cn="5"]').getAttribute('aria-invalid') === 'true'));
  await Mb.fill('[data-cn="5"]', '   '); await Mb.press('[data-cn="5"]', 'Enter'); await sleep(150);
  ok('boş ad satır içi hata (1–30)', await Mb.evaluate(() => /Kolon adı 1 ile 30 karakter arasında olmalı/.test(document.querySelector('#c5-e')?.textContent || '')));
  ok('ad alanı en çok 30 karakter', await Mb.evaluate(() => document.querySelector('[data-cn="5"]').maxLength === 30));
  const XN = '<script>x</script>' + RUN;
  await Mb.fill('[data-cn="5"]', XN); await Mb.press('[data-cn="5"]', 'Enter'); await sleep(150); await flush(Mb);
  const newCol = await Mb.evaluate(([n, PC]) => DB.statuses.find(s => s.projectId === PC && s.name === n), [XN, PC]);
  ok('üyenin eklediği kolon sunucuda', !!newCol && (await srv(Mb, 'statuses', newCol.id))?.name === XN);
  const xs = await Mb.evaluate(n => ({ board: [...document.querySelectorAll('.col-h .nm')].map(e => e.textContent.trim()),
    dlg: [...document.querySelectorAll('#scrim [data-cn]')].some(e => e.value === n), script: !!document.querySelector('#view script, #scrim script') }), XN);
  ok('<script> kolon adı metin olarak (panoda ve pencerede)', xs.board.includes(XN) && xs.dlg && !xs.script, JSON.stringify(xs));
  // klavye ↑: odak taşınan satırın ↑ düğmesinde kalır
  await Mb.focus('[data-cu="5"]'); await Mb.keyboard.press('Enter'); await sleep(200);
  const mv = await Mb.evaluate(() => ({ f: document.activeElement?.dataset.cu, names: [...document.querySelectorAll('#scrim [data-cn]')].map(e => e.value) }));
  ok('↑ klavyeyle sıralar, odak korunur', mv.f === '4' && mv.names[4] === XN && mv.names[5] === 'Bitti', JSON.stringify(mv));
  await flush(Mb);
  const t2 = await waitFor(A, n => { const names = [...document.querySelectorAll('.col-h .nm')].map(e => e.textContent); return names[4] === n; }, XN, 9000);
  ok('2. tarayıcı yeni kolonu ve sırayı ≤4 sn (+yoklama) içinde görür', t2 >= 0 && t2 <= 6500, 't=' + t2);

  // 7) 12 kolon sınırı
  for (let k = 0; k < 6; k++) { await Mb.click('#pt_add'); await sleep(120); }
  const lim = await Mb.evaluate(() => ({ n: document.querySelectorAll('#scrim .pt-row').length, dis: document.getElementById('pt_add').disabled,
    t: document.getElementById('pt_lim').textContent }));
  ok('12 kolonda "Kolon ekle" pasif ve nedenini yazar', lim.n === 12 && lim.dis && /12\/12 · Bir projede en fazla 12 kolon olabilir/.test(lim.t), JSON.stringify(lim));
  for (let k = 0; k < 6; k++) { await Mb.click('[data-cx="6"]'); await sleep(120); }        // boş kolonlar sorulmadan silinir
  ok('boş kolonlar doğrudan silinir', (await dlgRows(Mb)).length === 6);

  // 8) içinde iş olan kolonu sil: hedef sorulur (varsayılan önceki kolon), geçmişe "Durum: X → Y"
  const gel = await Mb.evaluate(PC => DB.issues.filter(i => i.statusId === PC + '_s1').map(i => i.id), PC);
  await Mb.click('[data-cx="1"]'); await sleep(200);
  const step = await Mb.evaluate(() => ({ q: document.getElementById('pt_dq')?.textContent, def: document.querySelector('[data-cto][aria-checked="true"]')?.dataset.cto,
    info: document.querySelector('#scrim .ws-info')?.textContent || '', foc: document.activeElement?.dataset.cto }));
  ok('silme adımı: "İçindeki N iş hangi kolona taşınsın?", varsayılan önceki kolon', gel.length === 3 && step.q === 'İçindeki 3 iş hangi kolona taşınsın?' && step.def === PC + '_s0'
    && /Durum: Geliştirmede → Yapılacak/.test(step.info) && step.foc === PC + '_s0', JSON.stringify(step));
  await Mb.keyboard.press('ArrowDown'); await sleep(100);
  ok('ok tuşu hedefi değiştirir', await Mb.evaluate(PC => document.querySelector('[data-cto][aria-checked="true"]')?.dataset.cto === PC + '_s2', PC));
  await Mb.click('#pt_delok'); await sleep(250); await flush(Mb);
  const after = await Mb.evaluate(([ids, PC]) => ({ gone: !DB.statuses.some(s => s.id === PC + '_s1'), moved: ids.every(id => issue(id).statusId === PC + '_s2'),
    hist: ids.every(id => DB.history.some(h => h.issueId === id && h.field === 'Durum' && h.from === 'Geliştirmede' && h.to === 'İncelemede')),
    rows: document.querySelectorAll('#scrim .pt-row').length }), [gel, PC]);
  const sIss = await srvAll(Mb, 'issues');
  ok('Sil ve taşı: işler taşındı, geçmiş yazıldı, kolon silindi (sunucu dahil)', after.gone && after.moved && after.hist && after.rows === 5
    && !(await srv(Mb, 'statuses', PC + '_s1')) && gel.every(id => sIss.find(i => i.id === id)?.statusId === PC + '_s2'), JSON.stringify(after));
  await Mb.screenshot({ path: SS + 'kolonlar.png' });
  await Mb.evaluate(() => closeModal());

  // 9) üye formdan proje açar: tür (varsayılan Pano), Basit şablonu, Bitti zorunlu; yenileyince kolonlar var
  await go(Mb, PC, 'projects');
  await Mb.evaluate(() => newProjectForm()); await sleep(200);
  ok('yeni proje: galeri açılır, Kanban (Pano) seçili', await Mb.evaluate(() =>
    document.querySelector('#ps_grid input[value="kanban"]')?.checked === true));
  await Mb.click('.ps-card[data-pk="gorev"] .ps-pick'); await Mb.click('#ps_next'); await sleep(150);
  ok('"varsayılan akış" kutusu üyede yok', await Mb.evaluate(() => !document.getElementById('np_def') && !!document.getElementById('np_n')));
  ok('Görev takibi şablonu: 3 kolon', JSON.stringify(await dlgRows(Mb)) === JSON.stringify(['Yapılacak', 'Devam ediyor', 'Bitti']));
  await Mb.selectOption('[data-cc="2"]', 'inprogress'); await sleep(100);
  await Mb.fill('#np_n', 'Tür Deneme ' + RUN); await Mb.click('#np_ok'); await sleep(200);
  ok('Bitti kolonu olmadan oluşturulmaz', await Mb.evaluate(() => /Projede en az bir Bitti kolonu olmalı/.test(document.getElementById('np_cerr').textContent)
    && document.getElementById('scrim').classList.contains('on')));
  await Mb.selectOption('[data-cc="2"]', 'done'); await sleep(100);
  await Mb.click('#np_ok'); await sleep(300); await flush(Mb);
  const np = await Mb.evaluate(n => DB.projects.find(p => p.name === n), 'Tür Deneme ' + RUN);
  await Mb.reload(); await sleep(1800);
  const npS = (await srvAll(Mb, 'statuses')).filter(s => s.projectId === np?.id);
  ok('üyenin açtığı projenin kolonları kaydedildi (yeniden yüklemede de)', !!np && npS.length === 3 && npS.some(s => s.cat === 'done')
    && (await srv(Mb, 'projects', np.id))?.type === 'board', JSON.stringify(npS.map(s => s.name)));
  const t3 = await waitFor(A, id => DB.statuses.filter(s => s.projectId === id).length === 3, np?.id, 9000);
  ok('yeni proje ve kolonları 2. tarayıcıda', t3 >= 0, 't=' + t3);

  // 10) kolonsuz eski proje: boş durum; yetkiliye "Kolonları düzenle", izleyiciye değil
  await A.evaluate(async R => {
    DB.projects.push({ id: 'p_nc' + R, key: 'NC' + R.slice(0, 2).toUpperCase(), code: 'NC' + R.slice(0, 2).toUpperCase(), name: 'Kolonsuz ' + R, lead: SESSION, counter: 0, members: [], archived: false, workspaceId: 'ws1' });
    save(); await flushAll(); DB.ui.project = 'p_nc' + R; DB.ui.view = 'board'; render();
  }, RUN);
  ok('kolonsuz proje: boş durum + "Kolonları düzenle", araç çubuğu yok', await A.evaluate(() => /Bu projede henüz kolon yok/.test(document.getElementById('view').textContent)
    && !!document.getElementById('colsEdit2') && !document.getElementById('newIssue')));

  // 11) sunucu reddi: aynı anda başkası kolonu silerse pencere açık kalır, uyarı çıkar
  await go(A, PC, 'board');
  await A.evaluate(PC => colsEditor(PC), PC); await sleep(150);
  const victim = PC + '_s3';                    // "Testte": boş kolon
  await Mb.evaluate(async id => { DB.statuses = DB.statuses.filter(x => x.id !== id); save(); await flushAll(); }, victim);
  await A.evaluate(async id => { const s = DB.statuses.find(x => x.id === id); s.name = 'Çakışma'; save(); await flushAll(); }, victim);
  await sleep(400);
  const rej = await A.evaluate(() => ({ open: !!document.querySelector('#scrim.on .modal[data-cols]'), alert: document.querySelector('#scrim .ws-alert b')?.textContent }));
  ok('sunucu reddi: pencere açık, sunucunun iletisi uyarıda', rej.open && rej.alert === 'Kolon silinmiş', JSON.stringify(rej));
  await A.evaluate(() => closeModal());

  // 12) 375 px: pencere tam ekran, yatay kayma yok
  const Mo = await mk('mobile', { width: 375, height: 760 }); await login(Mo, 'ptm' + RUN, 'TurUye12345!');
  await go(Mo, PC, 'board'); await Mo.evaluate(PC => colsEditor(PC), PC); await sleep(250);
  const mob = await Mo.evaluate(() => { const m = document.querySelector('#scrim .modal'); const r = m.getBoundingClientRect();
    return { w: Math.round(r.width), sw: document.querySelector('#scrim').scrollWidth, btn: Math.round(document.querySelector('[data-cu="1"]').getBoundingClientRect().height) }; });
  ok('375 px: pencere tam genişlik, yatay kayma yok, düğmeler ≥40 px', mob.w === 375 && mob.sw <= 375 && mob.btn >= 40, JSON.stringify(mob));
  await Mo.screenshot({ path: SS + 'mobil.png' });

  ok('XSS çalışmadı', (await Promise.all([A, Mb, Vb, Mo].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
