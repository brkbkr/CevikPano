// "Benim işlerim" ana ekranı tarayıcı testi (issue #9, docs/tasarim/benim-islerim/karar.md).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/benim-islerim.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını,
// projelerini ve işlerini oluşturur; diğer tarayıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_h_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);           // tekrar çalıştırmada çakışmasın
const ID = n => `i_hm${RUN}_${n}`;
const T = 'u_hm' + RUN, V = 'u_hmv' + RUN, PB = 'p_hmb' + RUN, PA = 'p_hma' + RUN, PC = 'p_hmc' + RUN, PD = 'p_hmd' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
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
  const home = async p => { await p.evaluate(() => { DB.ui.view = 'home'; render(); }); await sleep(250); };
  const groupOf = (p, id) => p.evaluate(id => document.querySelector(`[data-hmrow="${id}"]`)?.closest('[data-hmgrp]')?.dataset.hmgrp || null, id);
  const groupIds = (p, g) => p.evaluate(g => [...document.querySelectorAll(`[data-hmgrp="${g}"] [data-hmrow]`)].map(r => r.dataset.hmrow), g);
  const has = (p, id) => p.evaluate(id => !!document.querySelector(`[data-hmrow="${id}"]`), id);
  const st = (p, id) => p.evaluate(id => issue(id)?.statusId, id);
  const toastInfo = p => p.evaluate(() => { const t = document.getElementById('toast');
    return { on: t.classList.contains('on'), warn: t.classList.contains('t-warn'), text: t.textContent.trim(),
      undo: !!t.querySelector('.toast-undo'), x: !!t.querySelector('.toast-x'), role: t.getAttribute('role'), live: t.getAttribute('aria-live') }; });
  /* odak beklentisi (homeRefocus ile aynı kural): aynı gruptaki sonraki, yoksa önceki satırın aynı düğmesi; yoksa "Geri al" */
  const nextFocus = (p, id, sel) => p.evaluate(([id, sel]) => { const r = document.querySelector(`[data-hmrow="${id}"]`);
    const rows = [...r.parentElement.children].filter(x => x.dataset.hmrow), k = rows.indexOf(r);
    const n = [rows[k + 1], rows[k - 1]].find(x => x && x.querySelector(sel)); return n ? n.dataset.hmrow : 'toast'; }, [id, sel]);
  const focusAt = (p, sel) => p.evaluate(sel => { const a = document.activeElement;
    return a?.closest('#toast') && a.classList.contains('toast-undo') ? 'toast' : a?.matches(sel) ? a.closest('[data-hmrow]')?.dataset.hmrow || null : a?.tagName; }, sel);
  const waitFor = async (p, fn, arg, ms = 6000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(250); } return -1; };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ---- test verisi: üye T, izleyici V; PB son durumu "done" olmayan proje, PA arşivli, PC İlerlet yürüyüşü,
     PD otomasyonla başkasına atayan proje ---- */
  const setup = await A.evaluate(async ([R, T, V, PB, PA, PC, PD, XSS, ids]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: T, op: 'put', data: { username: 'hm' + R, name: 'Hm Üye ' + R, role: 'member', active: true, ini: 'HÜ', color: '#0F766E', capacity: 20 } },
      { c: 'users', id: V, op: 'put', data: { username: 'hmv' + R, name: 'Hm İzleyici ' + R, role: 'viewer', active: true, ini: 'Hİ', color: '#64748B' } },
    ] });
    ['p1', 'p2'].forEach(pid => { const p = DB.projects.find(x => x.id === pid); p.roles = { ...(p.roles || {}), [T]: 'member', [V]: 'viewer' }; p.members = [...new Set([...(p.members || []), T, V])]; });
    DB.projects.push({ id: PB, key: 'HB' + R.toUpperCase(), code: 'HB' + R.toUpperCase(), name: `HM-B ${R} ${XSS}`, lead: T, counter: 0, members: [T, 'u3', V], archived: false });
    DB.projects.push({ id: PA, key: 'HA' + R.toUpperCase(), code: 'HA' + R.toUpperCase(), name: `HM-A ${R}`, lead: T, counter: 0, members: [T, ME.id], archived: true });
    [['Açık', 'todo'], ['Kapandı', 'done'], ['Sonra', 'inprogress']].forEach(([n, c], k) => DB.statuses.push({ id: `${PB}_s${k}`, projectId: PB, name: n, cat: c, wip: 0, ord: k }));
    [['Açık', 'todo'], ['Bitti', 'done']].forEach(([n, c], k) => DB.statuses.push({ id: `${PA}_s${k}`, projectId: PA, name: n, cat: c, wip: 0, ord: k }));
    [[PC, 'HC'], [PD, 'HD']].forEach(([id, k]) => DB.projects.push({ id, key: k + R.toUpperCase(), code: k + R.toUpperCase(), name: `${k}-${R}`, lead: T, counter: 0, members: [T, 'u3'], archived: false }));
    [['Yeni', 'todo'], ['Sürüyor', 'inprogress'], ['Kontrol', 'inprogress'], ['Tamam', 'done']].forEach(([n, c], k) => DB.statuses.push({ id: `${PC}_s${k}`, projectId: PC, name: n, cat: c, wip: 0, ord: k }));
    [['Yeni', 'todo'], ['İncele', 'inprogress'], ['Tamam', 'done']].forEach(([n, c], k) => DB.statuses.push({ id: `${PD}_s${k}`, projectId: PD, name: n, cat: c, wip: 0, ord: k }));
    DB.rules.push({ id: 'r_hm' + R, name: 'HM: incelemede u3', on: 'status', whenStatus: `${PD}_s1`, then: [{ act: 'assign', v: 'u3' }], projectId: PD, enabled: true });
    const today = iso(new Date()), d = n => iso(addD(new Date(today + 'T12:00'), n)), sun = homeWeek(today)[6];
    const p1 = statsOf('p1'), todo1 = p1.find(s => s.cat === 'todo').id, done1 = p1.find(s => s.cat === 'done').id;
    const mkI = (n, extra) => { const pid = extra.projectId || 'p1', pr = DB.projects.find(x => x.id === pid);
      const it = { id: ids + n, projectId: pid, key: `${pr.key}-${++pr.counter}`, type: 'task', summary: `HM-T${R} ${n}`, description: '',
        statusId: pid === 'p1' ? todo1 : `${pid}_s0`, assignee: T, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(),
        updatedAt: Date.now(), rank: 1000, start: '', due: '', estimate: 0, spent: 0, ...extra };
      DB.issues.push(it); return it; };
    mkI('late', { due: d(-3), priority: 2, estimate: 8 });
    mkI('today1', { due: today });
    mkI('today2', { start: d(-1), due: d(20) });
    if (sun > today) mkI('week', { due: sun });
    mkI('s1', { priority: 2, due: d(40), rank: 5 });
    mkI('s2', { priority: 1, due: d(50) });
    mkI('s3', { priority: 2, due: d(35) });
    mkI('s4', { priority: 2, due: d(40), rank: 3 });
    mkI('later1', { due: d(30) });
    mkI('later2', { start: d(2) });
    mkI('nodate', { summary: XSS + ' özet', estimate: 5 });
    mkI('wait', { due: d(-1) });
    mkI('blocker', { assignee: 'u3' });
    DB.links.push({ id: 'l_hm' + R, from: ids + 'blocker', to: ids + 'wait', type: 'blocks' });
    mkI('epic', { type: 'epic', color: '#6B4FBB' });
    mkI('done', { statusId: done1 });
    mkI('other', { assignee: 'u2' });
    mkI('arch', { projectId: PA });
    mkI('adv', { projectId: PC });
    mkI('rule', { projectId: PD });
    mkI('bTodo', { projectId: PB });
    mkI('bLast', { projectId: PB, statusId: `${PB}_s2` });
    mkI('bAs', { projectId: PB });
    /* süper yönetici: arşivli proje, epik ve tamamlanmış iş onda da görünmez */
    mkI('sup', { assignee: ME.id });
    mkI('supArch', { projectId: PA, assignee: ME.id });
    mkI('supEpic', { type: 'epic', assignee: ME.id, color: '#6B4FBB' });
    mkI('supDone', { statusId: done1, assignee: ME.id });
    save();
    return { today, sun, hasWeek: sun > today, p1: p1.map(s => ({ id: s.id, name: s.name, cat: s.cat })), pc: statsOf(PC).map(s => ({ id: s.id, name: s.name, cat: s.cat })) };
  }, [RUN, T, V, PB, PA, PC, PD, XSS, ID('')]);
  await sleep(2500);

  // 0) süper yönetici: kendi işi görünür, arşivli/epik/tamamlanmış görünmez
  await home(A);
  ok('super: own open issue listed', await has(A, ID('sup')));
  ok('super: archived-project / epic / done issues hidden', !(await has(A, ID('supArch'))) && !(await has(A, ID('supEpic'))) && !(await has(A, ID('supDone'))));

  // 1) üye T: giriş ekranı "Benim işlerim", menü adları, #home, g h
  const M = await mk('member'); await login(M, 'hm' + RUN, 'Baslangic123', 'HmYeni12345');
  /* Silinmiş kolondaki iş yalnız eski veride olur: sunucu artık var olmayan kolona iş kabul etmiyor ("Kolon bulunamadı", #12)
     ve içinde iş olan kolon silinemiyor. Eski veriyi üyenin tarayıcısında yerel olarak kur (sunucuyla eşit sayılsın, gönderilmesin). */
  await M.evaluate(([R, id]) => { const t = DB.issues.find(i => i.id === id.replace(/ghost$/, 'late'));
    const g = { ...t, id, key: 'GH-' + R, summary: `HM-T${R} ghost`, statusId: 'yok_durum_' + R, due: '', start: '', estimate: 0, priority: 3 };
    DB.issues.push(g); SNAP.rec.issues.set(id, cj(g)); render(); }, [RUN, ID('ghost')]);
  const names = await M.evaluate(() => ({ title: document.getElementById('title').textContent, hash: location.hash,
    nav: document.querySelector('.nav a[data-v="home"]').textContent.trim(),
    /* Benim işlerim genel ekran: proje sekmesi değil (sekme satırı gizli); dar ekranda ☰ çekmecedeki sol menüde (#rail). */
    tab: document.querySelector('#tabbar').hidden && !document.querySelector('#vtabs [data-v="home"]') && !!document.querySelector('#rail .nav a[data-v="home"]') }));
  ok('login opens "Benim işlerim" at #home', names.title === 'Benim işlerim' && names.hash === '#home', JSON.stringify(names));
  ok('menu renamed, general screen without project tabs', names.nav === 'Benim işlerim' && names.tab === true, JSON.stringify(names));
  await M.evaluate(() => { location.hash = 'board'; }); await sleep(500);
  await M.keyboard.press('g'); await M.keyboard.press('h'); await sleep(500);
  ok('g h goes to Benim işlerim', await M.evaluate(() => location.hash === '#home' && document.getElementById('title').textContent === 'Benim işlerim'));
  ok('no project cards on home', await M.evaluate(() => !document.querySelector('#view .projcard')));
  await M.screenshot({ path: SS + 'member.png', fullPage: true });

  // 2) gruplar (ilk uyan kazanır), boş grup yok, başlıkta sayı
  const exp = { late: 'late', today1: 'today', today2: 'today', s1: 'later', later1: 'later', later2: 'later', nodate: 'nodate', wait: 'wait', adv: 'nodate', rule: 'nodate', ghost: 'nodate' };
  if (setup.hasWeek) exp.week = 'week';
  const got = {}; for (const k of Object.keys(exp)) got[k] = await groupOf(M, ID(k));
  ok('issues land in expected groups', JSON.stringify(got) === JSON.stringify(exp), JSON.stringify(got));
  const order = await M.evaluate(() => [...document.querySelectorAll('[data-hmgrp]')].map(s => s.dataset.hmgrp));
  const want = ['late', 'today', 'week', 'later', 'nodate', 'wait'].filter(g => setup.hasWeek || g !== 'week');
  ok('group display order', JSON.stringify(order) === JSON.stringify(want), order.join());
  const counts = await M.evaluate(() => [...document.querySelectorAll('[data-hmgrp]')].every(s => +s.querySelector('.hm-gh .n').textContent === s.querySelectorAll('[data-hmrow]').length));
  ok('group header shows row count', counts);
  ok('epic / done / others / archived-project issues hidden', !(await has(M, ID('epic'))) && !(await has(M, ID('done'))) && !(await has(M, ID('other'))) && !(await has(M, ID('arch'))));

  // 3) grup içi sıralama: öncelik, bitiş (yoksa sona), rank
  ok('sort: priority, due (empty last), rank', JSON.stringify(await groupIds(M, 'later')) === JSON.stringify(['s2', 's3', 's4', 's1', 'later1', 'later2'].map(ID)),
    (await groupIds(M, 'later')).join());

  // 4) satır: proje, anahtar, gecikme (iş günü), kalan süre, durum; silinmiş durum çökertmez
  const row = await M.evaluate(([late, nodate, today1, ghost]) => { const q = (id, s) => document.querySelector(`[data-hmrow="${id}"] ${s}`);
    return { lateDue: q(late, '.hm-due').textContent.trim(), lateCls: q(late, '.hm-due').className, rem: q(late, '.rem')?.textContent.trim(),
      noRem: !q(today1, '.rem'), key: q(late, '.hm-sub .k').textContent === issue(late).key, pj: q(late, '.pj').textContent.trim(),
      st: q(late, '.hm-st').textContent.trim(), todayDue: q(today1, '.hm-due').textContent.trim(), noDue: q(nodate, '.hm-due').textContent.trim(),
      ghostSt: q(ghost, '.hm-st')?.textContent.trim(), ghostAdv: !!q(ghost, '[data-hmadv]'),
      expLate: workdaysBetween(issue(late).due, iso(new Date())) + ' gün gecikme' }; }, [ID('late'), ID('nodate'), ID('today1'), ID('ghost')]);
  ok('row: late due in work days, red', row.lateDue === row.expLate && /d-late/.test(row.lateCls), JSON.stringify(row));
  ok('row: key, project, status, remaining', row.key && row.pj === 'Ürün Platformu' && row.st === setup.p1.find(s => s.cat === 'todo').name && row.rem === '8h kalan', JSON.stringify(row));
  ok('row: remaining 0 hidden; Bugün; Tarih yok', row.noRem && row.todayDue === 'Bugün' && row.noDue === 'Tarih yok', JSON.stringify(row));
  ok('row: deleted status renders without İlerlet', row.ghostSt === '(silinmiş durum)' && !row.ghostAdv, JSON.stringify(row));
  ok('row: summary opens issue', await (async () => { await M.click(`[data-hmrow="${ID('today1')}"] .hm-t`); await sleep(300);
    const r = await M.evaluate(id => OPEN_ISSUE === id, ID('today1')); await M.evaluate(() => closeModal()); return r; })());

  // 5) XSS: özet ve proje adı kaçışlı
  const x = await M.evaluate(([nodate, pb]) => ({ img: document.querySelectorAll('#view img[src="x"]').length, xss: !!window.__xss,
    sum: document.querySelector(`[data-hmrow="${nodate}"] .hm-t`).textContent, chip: document.querySelector(`[data-hmproj="${pb}"] .t`)?.textContent }), [ID('nodate'), PB]);
  ok('xss in summary / project name escaped', x.img === 0 && !x.xss && x.sum.startsWith('<img') && (x.chip || '').includes('<img'), JSON.stringify(x));

  // 6) Beklemede: açık engelleyen; engelleyen tamamlanınca grubu değişir (poll ≤ 5 sn)
  ok('blocked row shows blocker', await M.evaluate(([w, bl]) => document.querySelector(`[data-hmrow="${w}"] .blk`)?.textContent.includes(issue(bl).key), [ID('wait'), ID('blocker')]));
  await A.evaluate(id => { const i = issue(id); setStatus(i, statsOf(i.projectId).find(s => s.cat === 'done').id); save(); }, ID('blocker'));
  const tBl = await waitFor(M, id => document.querySelector(`[data-hmrow="${id}"]`)?.closest('[data-hmgrp]')?.dataset.hmgrp === 'late', ID('wait'), 7000);
  ok('blocker done → issue moves from Beklemede to Gecikmiş', tBl >= 0, tBl + ' ms');

  // 7) özet: açık iş, gecikmiş, haftalık süre / kapasite
  const sum0 = await M.evaluate(() => ({ open: +document.querySelector('[data-hmsum="open"]').textContent, rows: document.querySelectorAll('[data-hmrow]').length,
    late: +document.querySelector('[data-hmsum="late"]').textContent, lateRows: document.querySelectorAll('[data-hmgrp="late"] [data-hmrow]').length,
    lateCls: document.querySelector('[data-hmsum="late"]').closest('.hm-stat').className,
    week: document.querySelector('[data-hmsum="week"]').textContent.trim(), pct: document.querySelector('[data-hmsum="pct"]')?.textContent }));
  ok('summary counts match list', sum0.open === sum0.rows && sum0.late === sum0.lateRows && sum0.late > 0 && /is-late/.test(sum0.lateCls), JSON.stringify(sum0));
  ok('summary week 0h / 20h, %0', sum0.week === '0h / 20h' && sum0.pct === '%0', JSON.stringify(sum0));

  // 8) Süre gir → iş seçili süre formu; hafta toplamı artar; çizelgede 2 hafta geri gitmek değiştirmez
  await M.click(`[data-hmlog="${ID('late')}"]`); await sleep(400);
  ok('Süre gir opens worklog form with the issue', await M.evaluate(id => document.getElementById('w_i')?.value === id, ID('late')));
  await M.fill('#w_h', '2h'); await M.fill('#w_c', 'hm test'); await M.click('#doWork'); await sleep(600);
  const wk1 = await M.evaluate(() => [document.querySelector('[data-hmsum="week"]').textContent.trim(), document.querySelector('[data-hmsum="pct"]').textContent]);
  ok('week total updated after logging', wk1[0] === '2h / 20h' && wk1[1] === '%10', wk1.join(' '));
  await M.evaluate(() => { location.hash = 'timesheet'; }); await sleep(500);
  await M.evaluate(() => { DB.ui.week = iso(addD(monday(new Date()), -14)); save(); render(); }); await sleep(300);
  await home(M);
  const wk2 = await M.evaluate(() => [document.querySelector('[data-hmsum="week"]').textContent.trim(), weekDays()[0] !== homeWeek(iso(new Date()))[0]]);
  ok('week total independent of timesheet week', wk2[0] === '2h / 20h' && wk2[1], JSON.stringify(wk2));
  await M.evaluate(() => { DB.ui.week = iso(monday(new Date())); save(); });

  // 9) İlerlet: işin projesinin sırasında sonraki; geçmiş; Bitti'de listeden düşer + Geri al
  const pc = setup.pc, doneIdx = pc.findIndex(s => s.cat === 'done');
  let advOk = true;
  for (let k = 0; k < doneIdx - 1; k++) {
    const lbl = await M.evaluate(id => document.querySelector(`[data-hmadv="${id}"]`)?.textContent.trim(), ID('adv'));
    if (lbl !== pc[k + 1].name) { advOk = false; break; }
    await M.click(`[data-hmadv="${ID('adv')}"]`); await sleep(250);
    if (await st(M, ID('adv')) !== pc[k + 1].id) { advOk = false; break; }
  }
  ok('İlerlet walks the issue project status order', advOk && await st(M, ID('adv')) === pc[doneIdx - 1].id, await st(M, ID('adv')));
  const h = await M.evaluate(id => DB.history.filter(x => x.issueId === id && x.field === 'Durum').map(x => x.from + ' → ' + x.to), ID('adv'));
  ok('İlerlet writes history', h[0] === `${pc[0].name} → ${pc[1].name}`, h.join(' | '));
  ok('İlerlet: no sprint / rank change', await M.evaluate(id => issue(id).sprintId == null && issue(id).rank === 1000, ID('adv')));
  ok('İlerlet focus stays on row button', await M.evaluate(id => document.activeElement?.dataset?.hmadv === id, ID('adv')));
  ok('next = done → green check button', await M.evaluate(id => document.querySelector(`[data-hmadv="${id}"]`)?.classList.contains('to-done'), ID('adv')));
  const fAdv = await nextFocus(M, ID('adv'), '[data-hmadv]');
  await M.click(`[data-hmadv="${ID('adv')}"]`); await sleep(300);
  const t1 = await toastInfo(M);
  ok('İlerlet to done: focus to neighbour İlerlet (not BODY)', await focusAt(M, '[data-hmadv]') === fAdv, fAdv);
  ok('done → row leaves list, undo toast', !(await has(M, ID('adv'))) && await st(M, ID('adv')) === pc[doneIdx].id && t1.on && t1.undo && t1.x && !t1.warn, JSON.stringify(t1));
  ok('toast is role=status aria-live=polite', t1.role === 'status' && t1.live === 'polite');
  await M.screenshot({ path: SS + 'toast.png' });
  await M.click('#toast .toast-undo'); await sleep(300);
  ok('Geri al restores status and row', await st(M, ID('adv')) === pc[doneIdx - 1].id && await has(M, ID('adv')));
  await sleep(1500);
  ok('undo synced to server', await M.evaluate(async ([id, s]) => (await API.get('/api/state')).data.issues.find(i => i.id === id).statusId === s, [ID('adv'), pc[doneIdx - 1].id]));
  /* iş bu arada değişirse geri alınamaz */
  await M.click(`[data-hmadv="${ID('adv')}"]`); await sleep(300);
  await M.evaluate(([id, s]) => { setStatus(issue(id), s); render(); }, [ID('adv'), pc[0].id]);
  await M.click('#toast .toast-undo'); await sleep(300);
  const t2 = await toastInfo(M);
  ok('changed meanwhile → "geri alınamadı", no undo', t2.on && t2.warn && !t2.undo && /geri alınamadı/.test(t2.text) && await st(M, ID('adv')) === pc[0].id, JSON.stringify(t2));
  await M.evaluate(() => save());
  /* otomasyon başkasına atarsa da düşer; Geri al durumu ve atananı geri yazar */
  await M.click(`[data-hmadv="${ID('rule')}"]`); await sleep(300);
  const t5 = await toastInfo(M);
  ok('rule reassigns on İlerlet → leaves list + undo', !(await has(M, ID('rule'))) && await M.evaluate(id => issue(id).assignee === 'u3', ID('rule')) && t5.undo, JSON.stringify(t5));
  await M.click('#toast .toast-undo'); await sleep(300);
  ok('undo restores status and assignee', await M.evaluate(([id, pd]) => issue(id).assignee === ME.id && issue(id).statusId === pd + '_s0', [ID('rule'), PD]) && await has(M, ID('rule')));

  // 10) son durumda İlerlet yok; Tamamla dairesi işin kendi projesinin "done" durumunu kullanır (H1)
  ok('last status: no İlerlet button (placeholder hidden)', await M.evaluate(id => !document.querySelector(`[data-hmadv="${id}"]`)
    && getComputedStyle(document.querySelector(`[data-hmrow="${id}"] .hm-adv.none`)).visibility === 'hidden', ID('bLast')));
  ok('other project: İlerlet label from its own order', await M.evaluate(id => document.querySelector(`[data-hmadv="${id}"]`)?.textContent.trim() === 'Kapandı', ID('bTodo')));
  ok('selected project differs from issue project', await M.evaluate(pb => DB.ui.project !== pb, PB));
  const fTick = await nextFocus(M, ID('bTodo'), '[data-complete]');
  await M.focus(`[data-hmrow="${ID('bTodo')}"] .hm-tick`); await M.keyboard.press('Enter'); await sleep(300);
  const t3 = await toastInfo(M);
  ok('keyboard tick: focus to neighbour tick (not BODY)', fTick !== 'toast' && await focusAt(M, '[data-complete]') === fTick, fTick);
  ok('tick completes with own project done status + undo toast', await st(M, ID('bTodo')) === `${PB}_s1` && !(await has(M, ID('bTodo'))) && t3.undo, JSON.stringify(t3));
  await M.click('#toast .toast-undo'); await sleep(400);
  ok('tick undo restores', await st(M, ID('bTodo')) === `${PB}_s0` && await has(M, ID('bTodo')));

  // 11) hızlı atama: işin projesinin üyeleri (H2); başkasına atanınca düşer + Geri al
  await M.click(`[data-qas="${ID('bAs')}"]`); await sleep(300);
  const opts = await M.evaluate(() => [...document.querySelectorAll('.qm .qm-opt')].map(o => o.dataset.qv).sort());
  /* yetki-v2: atanabilir = projede iş düzenleme yetkili kişi (İzleyici V listede yok) */
  ok('assignee menu = issue project members', JSON.stringify(opts) === JSON.stringify(['', T, 'u3'].sort()), opts.join());
  const fAs = await nextFocus(M, ID('bAs'), '[data-qas]');
  await M.click('.qm [data-qv="u3"]'); await sleep(300);
  const t4 = await toastInfo(M);
  ok('assign away: focus to neighbour assignee (not BODY)', await focusAt(M, '[data-qas]') === fAs, fAs);
  ok('no neighbour → focus on toast "Geri al"', await M.evaluate(() => { homeRefocus('yok', '[data-complete]', []);
    return document.activeElement?.classList.contains('toast-undo'); }));
  ok('assign to other → leaves list + undo toast', !(await has(M, ID('bAs'))) && await M.evaluate(id => issue(id).assignee === 'u3', ID('bAs')) && t4.undo && /listenden çıktı/.test(t4.text), JSON.stringify(t4));
  /* üzerine gelince süre durur */
  await M.hover('#toast .tx'); await sleep(6800);
  ok('toast paused while hovered', (await toastInfo(M)).on);
  await M.click('#toast .toast-undo'); await sleep(300);
  await sleep(200);
  ok('assign undo restores me', await M.evaluate(id => issue(id).assignee === ME.id, ID('bAs')) && await has(M, ID('bAs')));
  ok('assign undo history by name', (await M.evaluate(id => DB.history.filter(x => x.issueId === id && x.field === 'Atanan').map(x => x.to), ID('bAs'))).length === 2);
  await M.mouse.move(5, 5);
  /* bildirim kendiliğinden kapanır (kapat düğmesi de çalışır) */
  await M.click(`[data-qas="${ID('bAs')}"]`); await sleep(250); await M.click('.qm [data-qv="u3"]'); await sleep(300);
  await M.click('#toast .toast-x'); await sleep(300);
  ok('close button hides toast', !(await toastInfo(M)).on);
  ok('reduced motion: timer line hidden', await (async () => { await M.emulateMedia({ reducedMotion: 'reduce' });
    await M.evaluate(() => toast('x', { label: 'Geri al', fn: () => {} }));
    const r = await M.evaluate(() => getComputedStyle(document.querySelector('#toast .tm')).display === 'none');
    await M.evaluate(() => toastHide()); await M.emulateMedia({ reducedMotion: 'no-preference' }); return r; })());
  ok('plain toast unchanged (text only, 2 s)', await (async () => { await M.evaluate(() => toast('Düz bildirim'));
    const a = await toastInfo(M); await sleep(2400); const z = await toastInfo(M);
    return a.on && a.text === 'Düz bildirim' && !a.undo && !z.on; })());

  // 12) ikinci oturumdan atama ≤ 5 sn görünür
  await A.evaluate(([id, T]) => { const pr = DB.projects.find(x => x.id === 'p1');
    DB.issues.push({ id, projectId: 'p1', key: `${pr.key}-${++pr.counter}`, type: 'task', summary: 'HM uzaktan atama', statusId: statsOf('p1')[0].id,
      assignee: T, reporter: ME.id, priority: 1, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: 1, start: '', due: '' }); save(); }, [ID('remote'), T]);
  const tR = await waitFor(M, id => !!document.querySelector(`[data-hmrow="${id}"]`), ID('remote'), 7000);
  ok('assignment from another session appears ≤ 5 s after save', tR >= 0 && tR <= 6500, tR + ' ms');

  // 13) süzgeç: çipler düğme; seçim yenilemede korunur; özet süzgece uyar; görünmeyen proje → Tümü
  await M.click(`[data-hmproj="${PB}"]`); await sleep(300);
  const f1 = await M.evaluate(pb => ({ pressed: document.querySelector(`[data-hmproj="${pb}"]`).getAttribute('aria-pressed'),
    tag: document.querySelector(`[data-hmproj="${pb}"]`).tagName, open: +document.querySelector('[data-hmsum="open"]').textContent,
    rows: [...document.querySelectorAll('[data-hmrow]')].map(r => issue(r.dataset.hmrow).projectId), week: document.querySelector('[data-hmsum="week"]').textContent.trim() }), PB);
  ok('filter chip selects project; summary follows', f1.pressed === 'true' && f1.tag === 'BUTTON' && f1.rows.length === f1.open && f1.rows.every(p => p === PB)
    && f1.week === '0h / 20h', JSON.stringify(f1));
  await sleep(1500);
  await M.reload(); await sleep(2500);
  ok('filter kept after reload', await M.evaluate(pb => location.hash === '#home' && DB.ui.homeProj === pb
    && document.querySelector(`[data-hmproj="${pb}"]`)?.getAttribute('aria-pressed') === 'true', PB));
  await M.evaluate(pa => { DB.ui.homeProj = pa; render(); }, PA); await sleep(200);
  ok('invisible saved project → Tümü', await M.evaluate(() => document.querySelector('[data-hmproj=""]').getAttribute('aria-pressed') === 'true'
    && +document.querySelector('[data-hmsum="open"]').textContent === document.querySelectorAll('[data-hmrow]').length));
  ok('invisible saved project → homeProj cleared (no comeback on unarchive)', await M.evaluate(() => DB.ui.homeProj === ''));
  await M.evaluate(() => { DB.ui.homeProj = 'p2'; render(); }); await sleep(200);
  const e2 = await M.evaluate(() => ({ h: document.querySelector('.hm-empty h3')?.textContent, btn: !!document.querySelector('.hm-empty [data-hmproj=""]') }));
  ok('filtered empty state', e2.h === 'Bu projede sana atanmış açık iş yok' && e2.btn, JSON.stringify(e2));
  await M.click('.hm-empty [data-hmproj=""]'); await sleep(300);
  ok('"Tüm projeleri göster" resets filter', await M.evaluate(() => DB.ui.homeProj === '' && document.querySelectorAll('[data-hmrow]').length > 5));
  /* üye için boş durum (yalnız yerelde, senkron tek adımda geri konur) */
  const e1 = await M.evaluate(() => { const keep = DB.issues; DB.issues = []; render();
    const r = { h: document.querySelector('.hm-empty h3')?.textContent, nw: !!document.querySelector('#hmNew'), pj: !!document.querySelector('.hm-empty [data-v="projects"]'),
      late: document.querySelector('[data-hmsum="late"]')?.closest('.hm-stat').classList.contains('is-zero') };
    DB.issues = keep; render(); return r; });
  ok('empty state (member): İş oluştur + Projelere git, late box ok', e1.h === 'Sana atanmış açık iş yok' && e1.nw && e1.pj && e1.late, JSON.stringify(e1));

  // 14) 50'den fazla satır: 50 + "Tümünü göster"
  await A.evaluate(([T, base]) => { const pr = DB.projects.find(x => x.id === 'p2'), s0 = statsOf('p2')[0].id;
    for (let k = 0; k < 55; k++) DB.issues.push({ id: base + 'bulk' + k, projectId: 'p2', key: `${pr.key}-${++pr.counter}`, type: 'task', summary: 'HM toplu ' + k,
      statusId: s0, assignee: T, reporter: ME.id, priority: 4, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: k, start: '', due: '' });
    save(); }, [T, ID('')]);
  await waitFor(M, () => document.querySelectorAll('[data-hmgrp="nodate"] [data-hmrow]').length >= 50, null, 8000);
  const m1 = await M.evaluate(() => { const g = document.querySelector('[data-hmgrp="nodate"]');
    return { rows: g.querySelectorAll('[data-hmrow]').length, total: +g.querySelector('.hm-gh .n').textContent, more: g.querySelector('[data-hmmore]')?.textContent.trim() }; });
  ok('group capped at 50 with "Tümünü göster"', m1.rows === 50 && m1.total > 55 && m1.more === `Tümünü göster · ${m1.total - 50} iş daha`, JSON.stringify(m1));
  await M.click('[data-hmmore="nodate"]'); await sleep(300);
  ok('"Tümünü göster" shows all', await M.evaluate(() => { const g = document.querySelector('[data-hmgrp="nodate"]');
    return g.querySelectorAll('[data-hmrow]').length === +g.querySelector('.hm-gh .n').textContent && !g.querySelector('[data-hmmore]'); }));
  await A.evaluate(base => { DB.issues = DB.issues.filter(i => !i.id.startsWith(base + 'bulk')); save(); }, ID(''));

  // 15) mobil 375px: yatay kaydırma yok, düğmeler ≥ 40px
  const Mo = await mk('mobile', { width: 375, height: 812 }); await login(Mo, 'hm' + RUN, 'HmYeni12345');
  await home(Mo); await sleep(300);
  const mob = await Mo.evaluate(() => { const v = document.getElementById('view');
    const sz = [...document.querySelectorAll('.hm-act button, .hm-act .c-av, .hm-tick, .hm-pf')].map(e => e.getBoundingClientRect()).filter(r => r.width);
    return { sw: document.documentElement.scrollWidth, vw: v.scrollWidth - v.clientWidth, minH: Math.min(...sz.map(r => r.height)), minW: Math.min(...sz.map(r => r.width)),
      n: sz.length, rowsW: Math.max(...[...document.querySelectorAll('.hm-row')].map(r => r.scrollWidth - r.clientWidth)) }; });
  ok('mobile 375: no horizontal scroll', mob.sw <= 375 && mob.vw <= 0 && mob.rowsW <= 0, JSON.stringify(mob));
  ok('mobile 375: buttons ≥ 40px', mob.n > 10 && mob.minH >= 40 && mob.minW >= 40, JSON.stringify(mob));
  ok('mobile: last status has no İlerlet placeholder', await Mo.evaluate(id => getComputedStyle(document.querySelector(`[data-hmrow="${id}"] .hm-adv.none`)).display === 'none', ID('bLast')));
  await Mo.screenshot({ path: SS + 'mobile.png', fullPage: true });
  await Mo.evaluate(() => toast('PANO-1 Bitti olarak işaretlendi.', { label: 'Geri al', fn: () => {} }));
  const mt = await Mo.evaluate(() => { const r = document.getElementById('toast').getBoundingClientRect(); return r.left >= 0 && r.right <= 375 && r.bottom <= 812; });
  ok('mobile toast inside viewport', mt);

  // 15b) bayat İlerlet işlem yapmaz; yeniden açma / kolon: doneFrom yalnız var olan ve kendi projesinin durumuysa
  const stale = await M.evaluate(id => { const s0 = issue(id).statusId; homeAdvance(id, 'yok_durum');
    const t = document.getElementById('toast'); return issue(id).statusId === s0 && t.classList.contains('t-warn') && /Durumlar değişti/.test(t.textContent); }, ID('bTodo'));
  ok('stale İlerlet target: no change + "Durumlar değişti" toast', stale);
  const ro = await M.evaluate(([id, pb]) => { const i = issue(id), p1 = statsOf('p1'), r = {};
    i.doneFrom = 'yok_durum'; r.colMissing = colOf(i) === i.statusId;
    i.doneFrom = pb + '_s0'; r.colOther = colOf(i) === i.statusId;
    i.doneFrom = p1[1].id; r.colOwn = colOf(i) === p1[1].id;
    i.doneFrom = pb + '_s0'; reopenIssue(id); r.reOther = i.statusId === p1[0].id && !i.doneFrom;
    completeIssue(id); i.doneFrom = 'yok_durum'; reopenIssue(id); r.reMissing = i.statusId === p1[0].id;
    completeIssue(id); i.doneFrom = p1[1].id; reopenIssue(id); r.reOwn = i.statusId === p1[1].id;
    return r; }, [ID('done'), PB]);
  ok('doneFrom of other project / deleted → first status; own → back', Object.values(ro).every(Boolean), JSON.stringify(ro));

  // 16) izleyici: boş durumda yalnız "Projelere git"; atanmış işte düğme yok
  const Vp = await mk('viewer'); await login(Vp, 'hmv' + RUN, 'Baslangic123', 'HmvYeni12345');
  await home(Vp);
  const ve = await Vp.evaluate(() => ({ h: document.querySelector('.hm-empty h3')?.textContent, nw: !!document.querySelector('#hmNew'),
    pj: !!document.querySelector('.hm-empty [data-v="projects"]'), note: document.querySelector('.hm-ro-note')?.textContent.trim() }));
  ok('viewer empty state: only Projelere git', ve.h === 'Sana atanmış açık iş yok' && !ve.nw && ve.pj, JSON.stringify(ve));
  ok('viewer note shown', ve.note === 'İzleyici olarak görüntülüyorsun; işleri değiştiremezsin.', ve.note);
  /* yetki-v2: İzleyici'ye yeni atama yapılamaz; Üye iken atanıp İzleyici'ye düşen kişinin ataması kalır. */
  await A.evaluate(([id, V]) => { const pr = DB.projects.find(x => x.id === 'p1'); pr.roles = { ...pr.roles, [V]: 'member' }; save();
    DB.issues.push({ id, projectId: 'p1', key: `${pr.key}-${++pr.counter}`, type: 'task', summary: 'HM izleyici işi', statusId: statsOf('p1')[1].id,
      assignee: V, reporter: ME.id, priority: 2, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: 1, start: '', due: '' }); save(); }, [ID('vi'), V]);
  await sleep(1200);
  await A.evaluate(V => { const pr = DB.projects.find(x => x.id === 'p1'); pr.roles = { ...pr.roles, [V]: 'viewer' }; save(); }, V);
  const tV = await waitFor(Vp, id => !!document.querySelector(`[data-hmrow="${id}"]`), ID('vi'), 7000);
  const vv = await Vp.evaluate(() => ({ rows: document.querySelectorAll('[data-hmrow]').length,
    btn: document.querySelectorAll('#view .hm-tick, #view [data-hmadv], #view [data-hmlog], #view button[data-qpri], #view button[data-qas], #view [data-complete]').length,
    prio: document.querySelectorAll('#view span.prio').length }));
  ok('viewer: row without action buttons', tV >= 0 && vv.rows === 1 && vv.btn === 0 && vv.prio === 1, JSON.stringify(vv));
  await Vp.screenshot({ path: SS + 'viewer.png' });

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
