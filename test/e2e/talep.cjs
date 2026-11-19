// Talep eden + Talep havuzu tarayıcı testi (görev 12, E1).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/talep.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını, carisini ve
// talep projesini oluşturur (uydurma veri); diğer tarayıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_tl_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const M = 'u_tlm' + RUN, V = 'u_tlv' + RUN, PT = 'p_tl' + RUN, C1 = 'cu_tl1' + RUN, C2 = 'cu_tl2' + RUN, KEY = 'TL' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');
const XSS = '<img src=x onerror="window.__xss=1">';

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
  const view = async (p, v) => { await p.evaluate(v => { closeModal(); closeQuick(false); DB.ui.view = v; render(); }, v); await sleep(250); };
  const flush = p => p.evaluate(() => flushAll());
  const srv = (p, c, id) => p.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c]?.find(x => x.id === id) || null, [c, id]);
  const srvIssues = p => p.evaluate(async PT => (await API.get('/api/state')).data.issues.filter(i => i.projectId === PT), PT);
  const txt = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* ---- kurulum: üye M, izleyici V, iki cari (kişiler), talep projesi (M ve V üye), p1'e M üye ---- */
  await A.evaluate(async ([R, M, V, PT, C1, C2, KEY, XSS]) => {
    const ws = DB.workspaces[0]?.id || 'ws1';
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'tlm' + R, name: 'Talep Üye ' + R, role: 'member', active: true, ini: 'TÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'tlv' + R, name: 'Talep İzleyici ' + R, role: 'viewer', active: true, ini: 'Tİ', color: '#64748B' } },
      { c: 'customers', id: C1, op: 'put', data: { name: 'Örnek Destek ' + R + ' A.Ş.', shortName: 'Örnek ' + R, kind: 'customer', contacts: [
        { id: 'ct_a' + R, name: 'Ayşe Örnek', email: 'ayse.' + R + '@ornek.test', title: 'Muhasebe' },
        { id: 'ct_b' + R, name: 'Bora Deneme', email: 'bora.' + R + '@ornek.test' }] } },
      { c: 'customers', id: C2, op: 'put', data: { name: 'Başka Ticaret ' + R, kind: 'customer', contacts: [
        { id: 'ct_c' + R, name: 'Can ' + XSS, email: 'can.' + R + '@baska.test' }] } },
      { c: 'projects', id: PT, op: 'put', data: { name: 'Destek masası ' + R, key: KEY, counter: 0, workspaceId: ws, template: 'talep', type: 'board', members: [M, V] } },
      ...[['Yeni', 'todo'], ['İnceleniyor', 'inprogress'], ['Çözüldü', 'done']].map(([n, c], i) =>
        ({ c: 'statuses', id: `${PT}_s${i}`, op: 'put', data: { projectId: PT, name: n, cat: c, ord: i } })),
    ] });
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
    await reloadState();
    const p = DB.projects.find(x => x.id === 'p1'); p.roles = { ...(p.roles || {}), [M]: 'member' }; p.members = [...new Set([...(p.members || []), M])];
    save(); await flushAll();
  }, [RUN, M, V, PT, C1, C2, KEY, XSS]);
  const CA = 'ct_a' + RUN;

  /* ---- 1) sol menüde "Talep havuzu"; boş durum ---- */
  await view(A, 'pool');
  ok('admin: rail has "Talep havuzu" (data-v=pool)', await A.evaluate(() => !!document.querySelector('#rail [data-v="pool"]')
    && document.querySelector('#rail [data-v="pool"]').textContent.includes('Talep havuzu')));
  ok('pool is in the customizable rail list (NAV_MOVABLE)', await A.evaluate(() => NAV_MOVABLE.includes('pool') && navCfg().order.includes('pool')));
  const emp = await A.evaluate(() => { const e = document.querySelector('[data-tpempty="none"]'); return e ? { t: e.querySelector('h3').textContent, b: !!e.querySelector('#tp_mail2') } : null; });
  /* aynı DB'de tekrar çalışmada başka talep projelerinde iş olabilir: yalnız ilk çalıştırmada boş */
  const anyOther = await A.evaluate(() => poolItems().length);
  ok('empty state "Havuzda bekleyen talep yok" + "E-postadan talep oluştur"', anyOther > 0 || (emp?.t === 'Havuzda bekleyen talep yok' && emp.b), JSON.stringify(emp));

  /* ---- 2) üye: yeni iş formunda zorunluluk uyarısı, seçici arama ---- */
  const Mb = await mk('member'); await login(Mb, 'tlm' + RUN, 'Baslangic123', 'TalepUye12345!');
  await Mb.evaluate(PT => { DB.ui.project = PT; DB.ui.view = 'board'; save(); render(); }, PT); await sleep(200);
  await Mb.evaluate(() => newIssueForm()); await sleep(200);
  ok('new issue form: "Talep eden" required (*) in talep project', await Mb.evaluate(() => !!document.querySelector('#f_reqBtn')
    && [...document.querySelectorAll('.id-new .id-fl')].some(e => e.textContent.includes('Talep eden') && e.querySelector('.req'))));
  await Mb.fill('#f_sum', 'Fatura sorusu ' + RUN);
  const n0 = (await srvIssues(Mb)).length;
  await Mb.click('#doCreate'); await sleep(300);
  ok('create without requester: inline "Talep eden gerekli", form stays open', (await txt(Mb, '#f_req_e')).includes('Talep eden gerekli')
    && await Mb.evaluate(() => !!document.querySelector('#f_reqBtn')));
  await flush(Mb);
  ok('nothing sent to server', (await srvIssues(Mb)).length === n0);
  await Mb.click('#f_reqBtn'); await sleep(200);
  const all = await Mb.evaluate(() => [...document.querySelectorAll('.qm.req .qm-opt[data-qv]')].map(e => e.dataset.qv));
  /* 22b: hızlı kişi ekleme yalnız sistem yöneticisi: üyede "Yeni kişi ekle" yok */
  ok('picker: contacts of active customers, no "Yeni kişi ekle" for member; no "Yok" when required', all.includes(`${C1}|${CA}`) && !all.includes('__add') && !all.includes(''), JSON.stringify(all.slice(0, 6)));
  const search = async q => { await Mb.fill('.qm.req .qm-in', q); await sleep(80);
    return Mb.evaluate(() => [...document.querySelectorAll('.qm.req .qm-opt[data-qv]')].map(e => e.dataset.qv).filter(v => v !== '__add')); };
  ok('search by name (Türkçe katlama: "ayse")', JSON.stringify(await search('ayse')) === JSON.stringify([`${C1}|${CA}`]));
  ok('search by e-mail', JSON.stringify(await search('bora.' + RUN)) === JSON.stringify([`${C1}|ct_b${RUN}`]));
  ok('search by unvan', JSON.stringify(await search('Başka Ticaret ' + RUN)) === JSON.stringify([`${C2}|ct_c${RUN}`]));
  ok('XSS contact name in picker shown as text', await Mb.evaluate(() => !document.querySelector('.qm.req img') && document.querySelector('.qm.req').textContent.includes('<img')));
  await search('ayse');
  await Mb.click(`.qm.req [data-qv="${C1}|${CA}"]`); await sleep(150);
  ok('picked: button shows "Ayşe Örnek — Örnek …", error cleared', (await txt(Mb, '#f_reqBtn')).includes('Ayşe Örnek') && !(await txt(Mb, '#f_req_e')));
  await Mb.click('#doCreate'); await sleep(300); await flush(Mb);
  let mine = (await srvIssues(Mb)).filter(i => i.summary === 'Fatura sorusu ' + RUN)[0];
  ok('server: issue has requester {customerId, contactId}', mine?.requester?.customerId === C1 && mine.requester.contactId === CA, JSON.stringify(mine?.requester));

  /* ---- 3) hızlı kişi ekle (22b: yalnız sistem yöneticisi; üye 403) ---- */
  ok('member: quick add endpoint 403', await Mb.evaluate(async c => (await fetch('/api/customers/' + c + '/contacts', { method: 'POST', headers: { 'x-pano': '1', 'content-type': 'application/json' }, body: '{"name":"x"}' })).status === 403, C2));
  await A.evaluate(pt => { DB.ui.project = pt; DB.ui.view = 'board'; render(); newIssueForm(); }, PT); await sleep(200);
  await A.fill('#f_sum', 'Yeni kişiden talep ' + RUN);
  await A.click('#f_reqBtn'); await sleep(150);
  await A.click('.qm.req [data-qv="__add"]'); await sleep(250);
  ok('quick add dialog opens above the form', await A.evaluate(() => !!document.querySelector('#scrim2.on #qc_n') && !!document.querySelector('#scrim.on #f_sum')));
  await A.selectOption('#qc_cu', C2);
  await A.click('#qc_ok'); await sleep(150);
  ok('quick add: name required', (await txt(A, '#qc_err')).includes('Ad gerekli'));
  await A.fill('#qc_n', 'Deniz Yeni ' + RUN); await A.fill('#qc_e', 'deniz.' + RUN + '@baska.test'); await A.fill('#qc_p', '0212 000 00 01');
  await A.click('#qc_ok'); await sleep(700);
  ok('quick add: dialog closes, new person selected in form', await A.evaluate(() => !document.querySelector('#scrim2.on'))
    && (await txt(A, '#f_reqBtn')).includes('Deniz Yeni'));
  await A.click('#doCreate'); await sleep(300); await flush(A);
  const c2 = await srv(A, 'customers', C2);
  const dz = c2?.contacts?.find(x => x.name === 'Deniz Yeni ' + RUN);
  mine = (await srvIssues(A)).find(i => i.summary === 'Yeni kişiden talep ' + RUN);
  ok('server: contact added to customer (name/email/phone), issue points to it', !!dz && dz.email === 'deniz.' + RUN + '@baska.test' && dz.phone === '0212 000 00 01'
    && mine?.requester?.contactId === dz.id && c2.name === 'Başka Ticaret ' + RUN, JSON.stringify(dz));
  ok('admin sync ok after quick add (customers not re-pushed by client)', await A.evaluate(() => SYNC_STATE === 'ok' && !diffSnap(SNAP, snapOf(DB)).some(x => x.c === 'customers')));

  /* ---- 4) e-postadan talep: yapıştırmada otomatik eşleşme, eşleşmeyen adres, XSS konu ---- */
  await view(Mb, 'pool');
  await Mb.click('#tp_mail'); await sleep(250);
  if (await Mb.$('#et_proj')) await Mb.selectOption('#et_proj', PT);
  await Mb.fill('#et_from', 'Kimse <yok.' + RUN + '@hic.test>'); await sleep(100);
  ok('unknown From: "kayıtlı kişi yok", member: no "kişi olarak ekleyin" (22b)', (await txt(Mb, '#et_match')).includes('kayıtlı kişi yok') && !(await Mb.$('#et_add')));
  await Mb.evaluate(v => { const e = document.getElementById('et_from'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); },
    `"Ayşe Örnek" <AYSE.${RUN}@ORNEK.TEST>`); await sleep(100);
  ok('pasted From matches contact e-mail case-insensitively → auto selected', (await txt(Mb, '#et_match')).includes('Eşleşti') && (await txt(Mb, '#et_reqBtn')).includes('Ayşe Örnek'));
  await Mb.fill('#et_sub', XSS + ' konu ' + RUN);
  await Mb.fill('#et_body', 'Merhaba,\n<b>kalın değil</b>\nTeşekkürler');
  await Mb.click('#et_ok'); await sleep(400); await flush(Mb);
  const em = (await srvIssues(Mb)).find(i => i.summary === XSS + ' konu ' + RUN);
  ok('server: subject → summary, body → description (plain), requester matched', !!em && em.description.includes('<b>kalın değil</b>') && em.requester?.contactId === CA, JSON.stringify(em?.requester));
  await view(Mb, 'pool');
  ok('XSS subject rendered as text in pool (no img, no execution)', await Mb.evaluate(() => !document.querySelector('#tpPool img') && window.__xss === undefined
    && document.getElementById('tpPool').textContent.includes('<img src=x')));

  /* ---- 5) süzgeçler ---- */
  const rows = p => p.evaluate(() => [...document.querySelectorAll('#tpPool .tp-row')].map(r => r.dataset.tprow));
  const allRows = await rows(Mb);
  ok('pool lists my 3 todo requests', [mine?.id, em?.id].every(id => allRows.includes(id)) && allRows.length >= 3, allRows.length);
  await Mb.selectOption('#tp_cust', C2); await sleep(150);
  ok('filter by cari', JSON.stringify(await rows(Mb)) === JSON.stringify([mine.id]));
  await Mb.selectOption('#tp_cust', ''); await Mb.selectOption('#tp_proj', PT); await sleep(150);
  ok('filter by project', (await rows(Mb)).length === 3);

  /* ---- 6) havuzdan taşı + ata ---- */
  await Mb.click(`[data-tpmove="${em.id}"]`); await sleep(200);
  await Mb.selectOption('#tm_proj', 'p1'); await sleep(80);
  await Mb.selectOption('#tm_as', M);
  await Mb.click('#tm_ok'); await sleep(300); await flush(Mb);
  const mv = await srv(Mb, 'issues', em.id);
  ok('moved to p1 + assigned: server projectId/assignee/key/status', mv?.projectId === 'p1' && mv.assignee === M && /^[^-]+-\d+$/.test(mv.key) && !mv.key.startsWith(KEY)
    && (await Mb.evaluate(id => stat(issue(id).statusId).projectId === 'p1', em.id)), JSON.stringify({ p: mv?.projectId, a: mv?.assignee, k: mv?.key }));
  ok('moved request leaves the pool', !(await rows(Mb)).includes(em.id));
  await Mb.click('#tp_un'); await sleep(150);
  ok('filter "Yalnız atanmamış"', (await rows(Mb)).length === 2);
  await Mb.click('#tp_un'); await sleep(100);

  /* ---- 7) iş detayı: kişi, cari, e-posta, telefon; silinmiş kişi; eski talepsiz iş uyarısı ---- */
  await Mb.evaluate(id => openIssue(id), mine.id); await sleep(300);
  const side = await txt(Mb, '#idSide');
  ok('detail: Talep eden group with person, cari, e-mail, phone', side.includes('Talep eden') && side.includes('Deniz Yeni ' + RUN) && side.includes('Başka Ticaret ' + RUN)
    && side.includes('deniz.' + RUN + '@baska.test') && side.includes('0212 000 00 01'));
  await Mb.click('#idSide [data-pm="req"]'); await sleep(150);
  await Mb.click(`.qm.req [data-qv="${C1}|${CA}"]`); await sleep(250); await flush(Mb);
  ok('detail: change requester via picker → server', (await srv(Mb, 'issues', mine.id))?.requester?.contactId === CA && (await txt(Mb, '#idSide')).includes('Ayşe Örnek'));
  /* yönetici kişiyi siler: detayda "Silinmiş kişi" */
  await A.evaluate(async ([C1, CA]) => { await reloadState(); const c = DB.customers.find(x => x.id === C1); c.contacts = c.contacts.filter(p => p.id !== CA); save(); await flushAll(); }, [C1, CA]);
  await Mb.evaluate(() => { closeModal(); return reloadState(); }); await sleep(300);
  await Mb.evaluate(id => openIssue(id), mine.id); await sleep(300);
  ok('deleted contact → "Silinmiş kişi"', (await txt(Mb, '#idSide')).includes('Silinmiş kişi'));
  /* eski talepsiz iş: başka projede açılıp talep projesine taşınmış (talep eden değişmedi → sunucu kabul eder) */
  const OLD = 'i_tlold' + RUN;
  await A.evaluate(async ([OLD, PT, R]) => {
    let r = await API.post('/api/sync', { changes: [{ c: 'issues', id: OLD, op: 'put', data: { projectId: 'p1', statusId: DB.statuses.find(s => s.projectId === 'p1').id, key: 'ESKI' + R + '-1', summary: 'Eski talep ' + R } }] });
    const cur = (await API.get('/api/state')).data.issues.find(i => i.id === OLD);
    r = await API.post('/api/sync', { changes: [{ c: 'issues', id: OLD, op: 'put', data: { ...cur, projectId: PT, statusId: PT + '_s0' }, base: cur }] });
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
  }, [OLD, PT, RUN]);
  await Mb.evaluate(() => { closeModal(); return reloadState(); }); await sleep(300);
  await Mb.evaluate(id => openIssue(id), OLD); await sleep(300);
  ok('legacy request without requester: warning on open', (await txt(Mb, '#idSide .id-reqwarn')).includes('talep eden yok'));
  await Mb.evaluate(id => { const i = issue(id); idSet(i, 'priority', 1); }, OLD); await sleep(200); await flush(Mb);
  ok('legacy request still editable (priority saved)', (await srv(Mb, 'issues', OLD))?.priority === 1);
  await Mb.evaluate(() => closeModal());

  /* ---- 8) izleyici: salt okunur havuz ---- */
  const Vw = await mk('viewer'); await login(Vw, 'tlv' + RUN, 'Baslangic123', 'TalepIzci12345!');
  await view(Vw, 'pool');
  ok('viewer: pool visible, read-only note, no move / e-mail buttons', await Vw.evaluate(() => !!document.querySelector('#tpPool .tp-row') && !!document.querySelector('#tpPool .hm-ro-note')
    && !document.querySelector('[data-tpmove], #tp_mail, #tp_mail2')));

  /* ---- 9) mobil 360 px ---- */
  const S = await mk('mobile', { width: 360, height: 740 }); await login(S, 'tlm' + RUN, 'TalepUye12345!');
  await view(S, 'pool');
  const lay = await S.evaluate(() => { const r = document.querySelector('#tpPool .tp-row'), bt = r?.querySelector('[data-tpmove]');
    return { sw: document.documentElement.scrollWidth, cols: r ? getComputedStyle(r).gridTemplateColumns.split(' ').length : 0, bt: bt ? bt.getBoundingClientRect().height : 0 }; });
  ok('360px: pool fits (no horizontal scroll), single-column cards, 40px buttons', lay.sw <= 360 && lay.cols === 1 && lay.bt >= 40, JSON.stringify(lay));
  await S.screenshot({ path: SS + 'havuz-360.png' });
  await S.evaluate(PT => { DB.ui.project = PT; save(); newIssueForm(); }, PT); await sleep(250);
  await S.click('#f_reqBtn'); await sleep(250);
  const sh = await S.evaluate(() => { const q = document.querySelector('.qm-wrap.sheet .qm.req'); if (!q) return null; const r = q.getBoundingClientRect(); return { t: r.top, h: r.height, w: r.width }; });
  ok('360px: requester picker is full screen', !!sh && sh.t <= 1 && sh.h >= 730 && sh.w >= 359, JSON.stringify(sh));
  await S.screenshot({ path: SS + 'secici-360.png' });

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  if (FAILS) { console.log(`${FAILS} başarısız kontrol`); process.exit(1); }
  console.log('Tüm talep kontrolleri geçti');
})().catch(e => { console.error(e); process.exit(1); });
