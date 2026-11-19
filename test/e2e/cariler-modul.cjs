// Cariler modülü (aç/kapat) ve cari özel alanları tarayıcı testi.
// Ön koşullar regresyon.cjs ile aynı: boş veritabanı + ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 ile sunucu,
// node scripts/seed-demo.mjs ... test/fixtures/demo.json ve 005 dönüşümü. Sonra: node test/e2e/cariler-modul.cjs
// (BASE_URL ile adres, SHOT_DIR ile ekran görüntüsü klasörü). Kendi kullanıcı, cari, alan ve talep projesini oluşturur
// (uydurma veri); sonunda modülü açık bırakır, alanları ve carileri siler.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_cm_';
const SHOT = process.env.SHOT_DIR || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const T = '6' + String(Date.now()).slice(-6);                 // 7 hane + 3 = 10 hane VKN
const M = 'u_cmm' + RUN, CU1 = 'cu_cm1' + RUN, CU2 = 'cu_cm2' + RUN, PT = 'p_cmt' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2, acceptDownloads: true });
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
  const view = async (p, v) => { await p.evaluate(v => { closeModal(); DB.ui.view = v; render(); }, v); await sleep(250); };
  const waitFor = async (p, fn, arg, ms = 8000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const flush = p => p.evaluate(() => flushAll());
  const state = p => p.evaluate(async () => (await API.get('/api/state')).data);
  const sync = (p, changes) => p.evaluate(async ch => API.post('/api/sync', { changes: ch }), changes);
  const dl = async (p, fn) => { const [d] = await Promise.all([p.waitForEvent('download'), p.evaluate(fn)]);
    const chunks = []; for await (const c of await d.createReadStream()) chunks.push(c); return { name: d.suggestedFilename(), buf: Buffer.concat(chunks) }; };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* veri: üye (p1 üyesi), iki cari (biri p1'e bağlı), talep şablonlu proje */
  await A.evaluate(async ([R, M, CU1, CU2, PT, T]) => {
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'cmm' + R, name: 'Modül Üye ' + R, role: 'member', active: true, ini: 'MÜ', color: '#0F766E' } },
      { c: 'customers', id: CU1, op: 'put', data: { name: `Modül Bir ${R} A.Ş.`, kind: 'customer', taxNo: T + '001', active: true, contacts: [{ id: 'ct_cm' + R, name: 'Modül Kişi', email: `kisi${R}@ornek.example` }] } },
      { c: 'customers', id: CU2, op: 'put', data: { name: `Modül İki ${R} Ltd.`, kind: 'supplier', taxNo: T + '002', active: true, contacts: [] } },
      { c: 'projects', id: PT, op: 'put', data: { name: 'Modül Talep ' + R, key: 'MT' + R.toUpperCase().replace(/[^A-Z0-9]/g, ''), counter: 0, template: 'talep', type: 'board', workspaceId: 'ws1', members: [M] } },
      { c: 'statuses', id: PT + '_s0', op: 'put', data: { projectId: PT, name: 'Yeni', cat: 'todo', ord: 0 } },
    ] });
    if (r.rejected?.length) throw new Error(JSON.stringify(r.rejected));
    await reloadState();
    const p = DB.projects.find(x => x.id === 'p1'); p.members = [...new Set([...(p.members || []), M])]; p.customerId = CU1;
    save(); await flushAll();
  }, [RUN, M, CU1, CU2, PT, T]);
  const Mb = await mk('member'); await login(Mb, 'cmm' + RUN, 'Baslangic123', 'ModulUye12345!');
  const nCu0 = (await state(A)).customers.length;

  // 1) Sistem → Modüller: Cariler açık (varsayılan); üye ayarı yazamaz
  await A.evaluate(() => { SYS_TAB = 'modules'; DB.ui.view = 'system'; render(); }); await sleep(500);
  const sm = await A.evaluate(() => ({ tab: !!document.querySelector('[data-systab="modules"].on'), sw: document.getElementById('modCu')?.getAttribute('aria-checked'),
    role: document.getElementById('modCu')?.getAttribute('role'), chip: document.getElementById('smCuS')?.textContent }));
  ok('Sistem → Modüller: Cariler switch on by default', sm.tab && sm.sw === 'true' && sm.role === 'switch' && sm.chip === 'açık', JSON.stringify(sm));
  const mr = await Mb.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: '_settings', id: 'modules', op: 'put', data: { customers: false } }] })).rejected?.[0]?.reason);
  ok('member cannot write module setting (server)', mr === 'Bu değişiklik için yönetici yetkisi gerekli', mr);
  const bad = await A.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: '_settings', id: 'modules', op: 'put', data: { customers: 'kapalı' } }] })).rejected?.[0]?.reason);
  ok('bad module setting rejected (server format check)', /Geçersiz modül ayarı/.test(bad || ''), bad);

  // 2) kapat: ayar sunucuda; her yerden kalkar; veri durur
  await A.click('#modCu'); await sleep(300); await flush(A);
  ok('switch off → server settings.modules = { customers: false }', JSON.stringify((await state(A)).modules) === '{"customers":false}');
  await A.evaluate(() => { SYS_TAB = 'modules'; render(); }); await sleep(400);
  ok('Modüller shows "kapalı" and kept-data note', await A.evaluate(() => document.getElementById('smCuS')?.textContent === 'kapalı' && /korunuyor/.test(document.getElementById('smCuOff')?.textContent || '')));
  const offA = await A.evaluate(() => ({ nav: !!document.querySelector('.nav a[data-v="customers"]'), pal: paletteJumps().some(x => x.v === 'customers'), allowed: viewAllowed('customers') }));
  ok('off: no Cariler in menu or command palette; view not allowed', !offA.nav && !offA.pal && !offA.allowed, JSON.stringify(offA));
  await A.evaluate(() => { location.hash = 'customers'; }); await sleep(400);
  ok('off: #customers address does not open Cariler', await A.evaluate(() => DB.ui.view !== 'customers' && !document.getElementById('cuList')));
  await view(A, 'projects');
  ok('off: project card has no cari link', await A.evaluate(() => !document.querySelector('[data-pcust], .cu-plink')));
  await A.evaluate(() => { const p = DB.projects.find(x => x.id === 'p1'); DB.ui.project = p.id; DB.ui.view = 'board'; render(); }); await sleep(250);
  await A.evaluate(() => newIssueForm()); await sleep(250);
  ok('off: new issue form has no Cari picker', await A.evaluate(() => !document.getElementById('f_cu') && !document.getElementById('f_reqBtn')));
  await A.evaluate(() => closeModal());
  const iid = await A.evaluate(() => DB.issues.find(i => i.projectId === 'p1' && i.type !== 'epic').id);
  await A.evaluate(id => openIssue(id), iid); await sleep(350);
  ok('off: issue detail has no Cari row / Talep eden', await A.evaluate(() => !document.querySelector('#idSide [data-pm="cari"]') && !document.querySelector('#idSide [data-pm="req"]')));
  await A.evaluate(() => closeModal());
  await A.evaluate(() => { DB.ui.adminTab = 'fields'; DB.ui.view = 'admin'; render(); }); await sleep(250);
  ok('off: "Cari" preset not in Alanlar', await A.evaluate(() => !document.querySelector('[data-pfrow="b:customerId"]') && !!document.querySelector('[data-pfrow="b:billable"]')));
  await A.evaluate(() => { location.hash = 'raporlar/sure'; }); await sleep(500);
  const gr = await A.evaluate(() => ({ cu: !!document.querySelector('[data-grf="cu"]'), tpl: [...document.querySelectorAll('[data-grtpl]')].map(x => x.dataset.grtpl),
    dims: [...document.querySelectorAll('[data-grdim="row"] option')].map(o => o.value), row: GR.last?.rowK }));
  ok('off: reports without Cari filter, "Cari × Proje" template and Cari dimension', !gr.cu && !gr.tpl.includes('cariproje') && gr.tpl.includes('fatura')
    && !gr.dims.includes('customer') && gr.row !== 'customer', JSON.stringify(gr));
  await A.evaluate(() => { location.hash = 'raporlar/liste'; }); await sleep(500);
  const rl = await A.evaluate(() => [...document.querySelectorAll('[data-grsec="tpl"] [data-grri]')].map(x => x.dataset.grri));
  ok('off: report list "Hazır raporlar" without "Cari × Proje"', rl.length >= 4 && !rl.includes('tpl:cariproje') && rl.includes('tpl:fatura'), JSON.stringify(rl));
  await A.evaluate(() => { location.hash = 'raporlar/fatura'; }); await sleep(500);
  ok('off: billable hours tab without cari column', await A.evaluate(() => !document.querySelector('#grFt') || document.querySelector('#grFt thead th').textContent === 'Projeler'));
  await A.evaluate(() => { location.hash = 'home'; }); await sleep(250);
  /* talep şablonlu proje: talep eden seçicisi yok, talep edensiz iş açılır (sunucu da istemez) */
  await A.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'pool'; render(); }, PT); await sleep(300);
  ok('off: talep pool without Cari filter', await A.evaluate(() => !!document.getElementById('tpPool') && !document.getElementById('tp_cust')));
  await A.evaluate(pid => emailTalep(pid), PT); await sleep(250);
  ok('off: e-mail ticket dialog without Talep eden', await A.evaluate(() => !document.getElementById('et_reqBtn') && !!document.getElementById('et_sub')));
  await A.fill('#et_from', 'Ad Soyad <ad@ornek.example>'); await A.fill('#et_sub', 'Modül kapalı talep ' + RUN); await A.click('#et_ok'); await sleep(300); await flush(A);
  ok('off: ticket without requester saved on server', (await state(A)).issues.some(i => i.projectId === PT && i.summary === 'Modül kapalı talep ' + RUN && !i.requester));
  /* sunucu kapalıyken cari yazmasını reddeder; veri silinmez */
  const w = await sync(A, [{ c: 'customers', id: CU2, op: 'put', data: { name: 'Kapalıyken', kind: 'supplier', taxNo: T + '002', active: true } }]);
  const ct = await A.evaluate(async id => { try { await API.post(`/api/customers/${id}/contacts`, { name: 'Kapalı Kişi' }); return 'ok'; } catch (e) { return e.status + ' ' + e.message; } }, CU1);
  ok('off: server rejects customer write and contact add ("Cariler modülü kapalı")', w.rejected?.[0]?.reason === 'Cariler modülü kapalı' && ct === '409 Cariler modülü kapalı', JSON.stringify([w.rejected, ct]));
  const s1 = await state(A);
  ok('off: data kept (customers, project link)', s1.customers.length === nCu0 && s1.projects.find(p => p.id === 'p1')?.customerId === CU1
    && s1.customers.find(c => c.id === CU2)?.name === `Modül İki ${RUN} Ltd.`);
  /* diğer kullanıcı yoklamayla kapalı hâli görür */
  ok('member sees module off after poll', await waitFor(Mb, () => !cuOn() && !paletteJumps().some(x => x.v === 'customers')) >= 0);
  await A.screenshot({ path: SS + 'kapali.png' });

  // 3) aç: her şey geri gelir
  await A.evaluate(() => { SYS_TAB = 'modules'; DB.ui.view = 'system'; render(); }); await sleep(400);
  await A.click('#modCu'); await sleep(300); await flush(A);
  ok('switch on → server settings.modules = { customers: true }', JSON.stringify((await state(A)).modules) === '{"customers":true}');
  const onA = await A.evaluate(() => ({ nav: !!document.querySelector('.nav a[data-v="customers"]'), pal: paletteJumps().some(x => x.v === 'customers') }));
  ok('on: Cariler back in menu and palette', onA.nav && onA.pal, JSON.stringify(onA));
  await view(A, 'projects');
  ok('on: project card cari link back (p1 → test cari)', await A.evaluate(id => document.querySelector('[data-pcust="p1"]')?.value === id, CU1));
  await A.evaluate(id => openIssue(id), iid); await sleep(350);
  ok('on: issue detail Cari row back', await A.evaluate(() => !!document.querySelector('#idSide [data-pm="cari"]')));
  await A.evaluate(() => closeModal());

  // 4) cari alanları: yalnız sistem yöneticisi tanımlar
  await view(A, 'customers');
  ok('Cariler toolbar: "Cari alanları" (admin)', await A.evaluate(() => /Cari alanları/.test(document.querySelector('.cu-tools [data-cufields]')?.textContent || '')));
  await A.click('.cu-tools [data-cufields]'); await sleep(250);
  ok('fields dialog: empty state, 5 types', await A.evaluate(() => !!document.getElementById('cuf_none') && document.querySelectorAll('[data-cuft]').length === 5));
  const addField = async (name, type, opts, onList) => {
    await A.fill('#cuf_n', name); await A.click(`[data-cuft="${type}"]`);
    if (opts) await A.fill('#cuf_o', opts.join('\n'));
    if (onList) await A.check('#cuf_l');
    await A.click('#cuf_ok'); await sleep(250);
  };
  await addField('Sektör ' + XSS, 'text', null, true);
  ok('field key auto-slug and XSS name as text in list', await A.evaluate(() => { const r = document.querySelector('.cuf-row'); return !!r && /sektor_img_src_x/.test(r.querySelector('.key').textContent)
    && r.querySelector('b').textContent.startsWith('Sektör <img') && window.__xss === undefined; }));
  await addField('Segment', 'select', ['Altın', 'Gümüş'], true);
  await addField('Çalışan sayısı', 'number');
  await addField('Sözleşme bitişi', 'date');
  await addField('E-fatura', 'checkbox');
  await A.fill('#cuf_n', 'Segment'); await A.fill('#cuf_k', 'segment'); await A.click('#cuf_ok'); await sleep(150);
  ok('duplicate key rejected in dialog', /zaten var/.test(await A.textContent('#cuf_e')));
  await A.fill('#cuf_n', 'Boş seçim'); await A.fill('#cuf_k', 'bos_secim'); await A.click('[data-cuft="select"]'); await A.click('#cuf_ok'); await sleep(150);
  ok('select without options rejected', /En az bir seçenek/.test(await A.textContent('#cuf_e')));
  await flush(A);
  const F = (await state(A)).fields.filter(f => f.scope === 'customer');
  const fid = n => F.find(f => f.name.startsWith(n))?.id;
  ok('server: 5 customer fields (scope customer, global, hidden for old version)', F.length === 5 && F.every(f => !f.projectId && f.hidden === true && !f.bind)
    && F.find(f => f.name === 'Segment')?.options?.join() === 'Altın,Gümüş', JSON.stringify(F.map(f => [f.key, f.type])));
  const mf = await Mb.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: 'fields', id: 'f_mx', op: 'put', data: { scope: 'customer', key: 'mx', name: 'X', type: 'text', hidden: true } }] })).rejected?.[0]?.reason);
  ok('member cannot define customer field (server)', mf === 'Bu değişiklik için yönetici yetkisi gerekli', mf);
  await A.evaluate(() => closeModal());

  // 5) cari formunda alanlar; değerler customer.cf; listede sütun; kartta görünür
  await A.evaluate(id => openCustomer(id), CU1); await sleep(250);
  ok('customer form: "Cari alanları" section with 5 inputs', await A.evaluate(() => document.querySelectorAll('#cu_cf [data-cucf]').length === 5));
  const inp = n => `[data-cucf="${fid(n)}"]`;
  await A.fill(inp('Sektör'), 'Yazılım ' + XSS); await A.selectOption(inp('Segment'), 'Altın');
  await A.fill(inp('Çalışan'), 'on iki'); await A.fill(inp('Sözleşme'), '2027-03-31'); await A.selectOption(inp('E-fatura'), 'evet');
  await A.click('#cu_ok'); await sleep(200);
  ok('invalid number shows field error, dialog stays', await A.evaluate(() => /sayı olmalı/.test(document.querySelector('#cu_cf .has-err .cu-err')?.textContent || '')) && await A.isVisible('#cu_ok'));
  await A.fill(inp('Çalışan'), '12,5'); await A.click('#cu_ok'); await sleep(250); await flush(A);
  const c1 = (await state(A)).customers.find(c => c.id === CU1);
  ok('server: cf values typed (text, select, number, date, boolean)', c1?.cf?.[fid('Sektör')] === 'Yazılım ' + XSS && c1.cf[fid('Segment')] === 'Altın' && c1.cf[fid('Çalışan')] === 12.5
    && c1.cf[fid('Sözleşme')] === '2027-03-31' && c1.cf[fid('E-fatura')] === true, JSON.stringify(c1?.cf));
  await view(A, 'customers'); await A.fill('#cuQ', RUN); await sleep(120);
  const lc = await A.evaluate(([id, sf, gf]) => ({ heads: [...document.querySelectorAll('.cu-tbl thead th[data-cufcol]')].map(h => h.textContent),
    seg: document.querySelector(`tr[data-cuopen="${id}"] td.c-cf[title^="Segment"]`)?.textContent || '', xss: window.__xss }), [CU1]);
  ok('list: onList fields as columns (Sektör, Segment), values as text', lc.heads.length === 2 && lc.heads[0].startsWith('Sektör <img') && lc.heads[1] === 'Segment'
    && /Altın/.test(lc.seg) && lc.xss === undefined, JSON.stringify(lc));
  if (SHOT) await A.screenshot({ path: SHOT + '/cariler-alanlar-liste.png' });
  await A.click('.cu-tools [data-cufields]'); await sleep(250);
  if (SHOT) await A.screenshot({ path: SHOT + '/cariler-alanlar-pencere.png' });
  await A.evaluate(() => closeModal());
  await Mb.evaluate(() => reloadState()); await Mb.evaluate(id => openCustomer(id), CU1); await sleep(250);
  ok('member read-only card shows field values (escaped)', await Mb.evaluate(([sf]) => { const t = document.querySelector('#scrim .cu-dl')?.textContent || '';
    return t.includes('Yazılım <img') && t.includes('Altın') && t.includes('12,5') && t.includes('31.03.2027') && t.includes('Evet') && window.__xss === undefined; }, [fid('Sektör')]));
  await Mb.evaluate(() => closeModal());

  // 6) CSV: dışa aktarmada alan sütunları; içe aktarmada eşleme, tür çevirisi, hatalı değer
  await view(A, 'customers'); await A.fill('#cuQ', RUN); await sleep(120);
  const ex = await dl(A, () => cuCsvExport());
  const rows = await A.evaluate(t => csvParse(t.replace(/^﻿/, ''), ';').map(r => r.cells), ex.buf.toString('utf8'));
  const H = rows[0], r1 = rows.find(r => r[0] === `Modül Bir ${RUN} A.Ş.`) || [];
  ok('export: field columns after built-in ones, typed values', H.slice(10).join('|') === ['Sektör ' + XSS, 'Segment', 'Çalışan sayısı', 'Sözleşme bitişi', 'E-fatura'].join('|')
    && r1.slice(10).join('|') === ['Yazılım ' + XSS, 'Altın', '12,5', '2027-03-31', 'Evet'].join('|'), JSON.stringify([H.slice(10), r1.slice(10)]));
  const csv = ['Unvan;Vergi no;Segment;Çalışan sayısı;Sözleşme bitişi;E-fatura',
    `Modül İki ${RUN} Ltd.;${T}002;gümüş;7;15.04.2028;Hayır`,
    `Modül Üç ${RUN};${T}003;Bronz;;;`,
    `Modül Dört ${RUN};${T}004;Altın;x;;`].join('\n');
  await A.evaluate(t => { cuCsvOpen(); document.getElementById('cuc_paste').value = t; }, csv); await A.click('#cuc_go'); await sleep(250);
  const map = await A.evaluate(() => [...document.querySelectorAll('[data-cucmap]')].map(s => s.value));
  ok('import: field columns auto-mapped by name', map[0] === 'name' && map[1] === 'taxNo' && map.slice(2).every((m, k) => m === 'cf:' + [fid('Segment'), fid('Çalışan'), fid('Sözleşme'), fid('E-fatura')][k]), JSON.stringify(map));
  const why = await A.evaluate(() => Object.fromEntries([...document.querySelectorAll('#cuc_body tr[data-cucrow]')].map(r => [r.dataset.cucrow, [r.dataset.act, r.querySelector('.cuc-why').textContent]])));
  ok('import: bad select / number values are row errors', why[2]?.[0] === 'update' && why[3]?.[0] === 'error' && /Segment: seçeneklerden biri/.test(why[3][1])
    && why[4]?.[0] === 'error' && /Çalışan sayısı: sayı olmalı/.test(why[4][1]), JSON.stringify(why));
  await A.click('#cuc_run'); await sleep(1200);
  const c2 = (await state(A)).customers.find(c => c.id === CU2);
  ok('import: update writes typed field values (option case, dd.mm.yyyy, Hayır=false)', c2?.cf?.[fid('Segment')] === 'Gümüş' && c2.cf[fid('Çalışan')] === 7
    && c2.cf[fid('Sözleşme')] === '2028-04-15' && c2.cf[fid('E-fatura')] === false && c2.name === `Modül İki ${RUN} Ltd.`, JSON.stringify(c2?.cf));
  await A.evaluate(() => closeModal());

  // 7) alan kapatma: formda/listede/CSV'de yok, değer silinmez; kapalı modülde alan yazılmaz
  await view(A, 'customers'); await A.click('.cu-tools [data-cufields]'); await sleep(250);
  await A.click(`[data-cufarch="${fid('Segment')}"]`); await sleep(200); await flush(A);
  await A.evaluate(() => closeModal()); await A.fill('#cuQ', RUN); await sleep(120);
  ok('archived field: not a list column, not in form', await A.evaluate(id => ![...document.querySelectorAll('[data-cufcol]')].some(h => h.dataset.cufcol === id)
    && (openCustomer(document.querySelector('#cuList tr.cu-row').dataset.cuopen), !document.querySelector(`[data-cucf="${id}"]`)), fid('Segment')));
  await A.evaluate(() => closeModal());
  ok('archived field: values kept on server', (await state(A)).customers.find(c => c.id === CU1)?.cf?.[fid('Segment')] === 'Altın');
  await sync(A, [{ c: '_settings', id: 'modules', op: 'put', data: { customers: false } }]);
  const fr = await sync(A, [{ c: 'fields', id: 'f_off' + RUN, op: 'put', data: { scope: 'customer', key: 'off' + RUN, name: 'Kapalı', type: 'text', hidden: true } }]);
  ok('off: server rejects customer field write', fr.rejected?.[0]?.reason === 'Cariler modülü kapalı', JSON.stringify(fr.rejected));
  await sync(A, [{ c: '_settings', id: 'modules', op: 'put', data: { customers: true } }]);

  // 8) mobil: alan penceresi ve liste taşmaz
  const Mo = await mk('mobile', { width: 390, height: 844 }); await login(Mo, 'admin', 'admin12345');
  await view(Mo, 'customers'); await Mo.evaluate(() => cuFieldsOpen()); await sleep(250);
  ok('mobile 390: fields dialog without horizontal overflow', await Mo.evaluate(() => document.documentElement.scrollWidth <= 391));
  await Mo.evaluate(() => closeModal());
  ok('no XSS executed', (await Promise.all([A, Mb, Mo].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));

  /* temizlik: alanlar, test carileri (p1 bağı kaldırılır), modül açık */
  await A.evaluate(async ([CU1, CU2, R]) => {
    await reloadState();
    const p = DB.projects.find(x => x.id === 'p1'); delete p.customerId;
    DB.fields = DB.fields.filter(f => f.scope !== 'customer'); save(); await flushAll();
    const ids = DB.customers.filter(c => c.name.includes(R)).map(c => c.id);
    await API.post('/api/sync', { changes: ids.map(id => ({ c: 'customers', id, op: 'del' })) });
    await reloadState();
  }, [CU1, CU2, RUN]);
  const s9 = await state(A);
  ok('cleanup: no customer fields, test customers removed, module on', !s9.fields.some(f => f.scope === 'customer') && !s9.customers.some(c => c.name.includes(RUN))
    && s9.modules?.customers !== false);

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
