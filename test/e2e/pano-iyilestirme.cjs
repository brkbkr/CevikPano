// Pano iyileştirmeleri tarayıcı testi: hızlı kart ekleme v2 (büyük başlık + ızgara: tip, öncelik, atanan, tarihler, tahmin), alt işler panoda kart,
// sprint başlat/tamamla yetkisi ve proje sprint süresi.
// Ön koşullar regresyon.cjs ile aynı: boş veritabanı, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123
// PORT=3100, demo veri (node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json).
// Sonra: node test/e2e/pano-iyilestirme.cjs (BASE_URL ile adres değiştirilebilir). Kendi projesini ve kullanıcısını açar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_pi_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PID = 'p_pi' + RUN, KEY = 'PI' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1600, height: 900 }, colorScheme = 'light') => {
    const ctx = await b.newContext({ viewport: vp, colorScheme, hasTouch: vp.width < 900 });
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
    await p.evaluate(([pid, v]) => { DB.ui.project = pid; DB.board.scope = 'all'; DB.board.swimlane = 'none';
      DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = ''; location.hash = v; }, [PID, view]);
    await sleep(600);
  };
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ===== 0) Benim işlerim: üst araç satırında oluştur / süre / yeni proje düğmeleri yok; c ve w kısayolları çalışır ===== */
  await A.evaluate(() => { DB.ui.project = DB.ui.project || 'p1'; location.hash = 'home'; }); await sleep(500);
  ok('home toolbar: no "+ İş oluştur", "Süre kaydet", "+ Yeni proje"', await A.evaluate(() => DB.ui.view === 'home'
    && !document.querySelector('#hNewIssue,#hLogWork,#hNewProject') && ![...document.querySelectorAll('#toolrow button, .toolbar button')].some(b => /İş oluştur|Süre kaydet|Yeni proje/.test(b.textContent))));
  await A.evaluate(() => document.activeElement?.blur()); await A.keyboard.press('c'); await sleep(400);
  ok('home: "c" shortcut opens new issue form', await A.evaluate(() => !!document.querySelector('#scrim.on #f_sum')));
  await A.evaluate(() => closeModal()); await sleep(200);
  await A.keyboard.press('w'); await sleep(400);
  ok('home: "w" shortcut opens work log', await A.evaluate(() => document.getElementById('scrim').classList.contains('on') && !document.querySelector('#f_sum')));
  await A.evaluate(() => closeModal()); await sleep(200);

  /* ---- test verisi: üyeli çalışma alanı (alan Yöneticisi YU, alan Üyesi MU, alan İzleyicisi VU; genel rolleri Üye/Üye/İzleyici),
     içinde agile proje (proje üyeleri: admin + u2 + MU + VU; atanabilenler alanın Yönetici/Üye kişileri: YU, MU), 3 kolon, gelecek sprint, üst iş + alt iş ---- */
  const MU = 'piuye' + RUN, MID = 'u_pi' + RUN, VU = 'piizl' + RUN, VID = 'u_piv' + RUN, YU = 'piyon' + RUN, YID = 'u_piy' + RUN, WSID = 'ws_pi' + RUN;
  const seed = await A.evaluate(async ([pid, key, mid, mu, vid, vu, yid, yu, wsid]) => {
    const st = ['Yapılacak', 'Devam ediyor', 'Bitti'].map((n, k) => ({ id: `${pid}_s${k}`, projectId: pid, name: n, cat: ['todo', 'inprogress', 'done'][k], wip: 0, ord: k }));
    const I = (id, n, sid, extra = {}) => ({ id, projectId: pid, key: `${key}-${n}`, type: 'task', summary: 'PI ' + id, description: '', statusId: sid,
      assignee: null, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: n * 100, start: '', due: '', ...extra });
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: mid, op: 'put', data: { username: mu, name: 'PI Üye Dışı', role: 'member', active: true, ini: 'PÜ', color: '#0F766E' } },
      { c: 'users', id: vid, op: 'put', data: { username: vu, name: 'PI İzleyici', role: 'viewer', active: true, ini: 'Pİ', color: '#64748B' } },
      { c: 'users', id: yid, op: 'put', data: { username: yu, name: 'PI Alan Yöneticisi', role: 'member', active: true, ini: 'PY', color: '#7C3AED' } },
      { c: 'workspaces', id: wsid, op: 'put', data: { name: 'PI alanı ' + key, color: '#3E7BC4',
        members: [{ userId: yid, role: 'admin' }, { userId: mid, role: 'member' }, { userId: vid, role: 'viewer' }] } },
      { c: 'projects', id: pid, op: 'put', data: { name: 'Pano iyileştirme ' + key, key, counter: 2, type: 'agile', members: [ME.id, 'u2', mid, vid], workspaceId: wsid } },
      ...st.map(s => ({ c: 'statuses', id: s.id, op: 'put', data: s })),
      { c: 'projects', id: pid + 'b', op: 'put', data: { name: 'PI Pano ' + key, key: key + 'B', counter: 0, type: 'board', members: [ME.id], workspaceId: 'ws1' } },
      { c: 'sprints', id: pid + '_sp', op: 'put', data: { projectId: pid, name: key + ' Sprint 1', state: 'future', goal: 'Panoyu <b>hızlandır</b>', start: '2026-11-09', end: '2026-11-15' } },
      { c: 'issues', id: pid + '_par', op: 'put', data: I(pid + '_par', 1, st[0].id, { sprintId: pid + '_sp' }) },
      { c: 'issues', id: pid + '_sub', op: 'put', data: I(pid + '_sub', 2, st[1].id, { parentId: pid + '_par', sprintId: pid + '_sp' }) },
    ] });
    return { rej: r.data?.rejected || r.rejected, st: st.map(s => s.id) };
  }, [PID, KEY, MID, MU, VID, VU, YID, YU, WSID]);
  ok('seed accepted', Array.isArray(seed.rej) && seed.rej.length === 0, JSON.stringify(seed.rej));
  await sleep(4800);                         // poll ile gelsin
  await A.reload(); await sleep(1500);
  const [S0, S1] = seed.st;

  /* ===== 1) hızlı kart ekleme (v2: büyük başlık + iki sütunlu ızgara, docs/tasarim/hizli-kart-v2) ===== */
  await go(A, 'board');
  await A.click(`[data-qa="${S0}"]`); await sleep(300);
  const R = s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } : null; };
  const shape = await A.evaluate(R0 => { const R = eval(R0); return {
    selects: document.querySelectorAll('.qadd select').length,
    old: ['#qa_b', '#qa_bt', '#qa_st', '#qa_du', '#qa_dd', '#qa_ok', '.qa-hint', '.qa-chips', '#qa_e'].filter(s => document.querySelector(s)).length,
    fields: ['#qa_s', '#qa_t', '#qa_p', '#qa_a', '#qa_sd', '#qa_d', '#qa_est', '#qa_more', '#qa_x', '#qa_add'].filter(s => document.querySelector(s)).length,
    title: document.querySelector('#qa_s')?.tagName,
    t: R('#qa_t'), p: R('#qa_p'), a: R('#qa_a'), sd: R('#qa_sd'), d: R('#qa_d'), grid: R('.qa2-grid'),
    names: [document.querySelector('#qa_t .tx').textContent.trim(), document.querySelector('#qa_p').textContent.trim(), document.querySelector('#qa_a .tx').textContent.trim()],
    want: [TYPE[DB.ui.qa.type][2], PRI[DB.ui.qa.priority][1], user(DB.ui.qa.assignee)?.name || 'Atanmamış'],
    unit: document.querySelector('#qa_unit')?.textContent, more: document.querySelector('#qa_more')?.textContent.trim(),
    btns: [document.querySelector('#qa_x')?.textContent.trim(), document.querySelector('#qa_add')?.textContent.trim()],
    focus: document.activeElement?.id,
  }; }, R.toString());
  ok('quick add v2: textarea title + grid fields, no selects / old chips', shape.selects === 0 && shape.old === 0 && shape.fields === 10 && shape.title === 'TEXTAREA', JSON.stringify(shape));
  ok('quick add v2: Tip·Öncelik and Başlangıç·Bitiş side by side, Atanan full row',
    shape.t.t === shape.p.t && shape.p.l > shape.t.l && shape.sd.t === shape.d.t && shape.d.l > shape.sd.l
    && shape.a.t > shape.t.t && shape.a.w >= shape.grid.w - 2 && shape.sd.t > shape.a.t, JSON.stringify(shape));
  ok('quick add v2: selectors show value names', shape.names[0] === shape.want[0] && shape.names[1] === shape.want[1] && shape.names[2] === shape.want[2], JSON.stringify([shape.names, shape.want]));
  ok('quick add v2: "Tüm alanlar…", Vazgeç, Ekle', shape.more === 'Tüm alanlar…' && shape.btns[0] === 'Vazgeç' && shape.btns[1] === 'Ekle', JSON.stringify(shape));
  ok('quick add v2: agile project estimate unit is "puan"', shape.unit === 'puan', shape.unit);
  ok('quick add: title focused on open', shape.focus === 'qa_s', shape.focus);
  // başlık büyür: en çok 2 satır
  const h1 = await A.evaluate(() => document.querySelector('#qa_s').getBoundingClientRect().height);
  await A.fill('#qa_s', 'Çok uzun bir başlık '.repeat(4)); await A.dispatchEvent('#qa_s', 'input'); await sleep(100);
  const h2 = await A.evaluate(() => document.querySelector('#qa_s').getBoundingClientRect().height);
  await A.fill('#qa_s', 'Çok uzun bir başlık '.repeat(12)); await A.dispatchEvent('#qa_s', 'input'); await sleep(100);
  const h3 = await A.evaluate(() => { const t = document.querySelector('#qa_s'), lh = parseFloat(getComputedStyle(t).lineHeight);
    return { h: t.getBoundingClientRect().height, lh, nl: t.value.includes('\n') }; });
  ok('title grows to 2 lines, then stays at 2 lines', h2 > h1 + 8 && Math.abs(h3.h - h2) <= 2 && h3.h <= 2 * h3.lh + 8, `${h1} ${h2} ${JSON.stringify(h3)}`);
  await A.fill('#qa_s', ''); await A.dispatchEvent('#qa_s', 'input');

  // seçiciler: tip, öncelik (Acil), atanan
  const pick = async (chip, v) => { await A.click(chip); await sleep(200); const has = await A.evaluate(v => !!document.querySelector(`.qm [data-qv="${v}"]`), v);
    if (has) await A.click(`.qm [data-qv="${v}"]`); await sleep(250); return has; };
  const env = await A.evaluate(() => ({ me: ME.id, today: TODAY, wk: iso(addD(new Date(), 7)), types: qaTypes(), acil: PRI[1][1],
    wd: workdaysBetween(TODAY, iso(addD(new Date(), 7))) }));
  const typ = env.types.find(t => t !== 'task') || env.types[0];
  ok('type menu has option', await pick('#qa_t', typ), typ);
  ok('priority menu has 4 options', await A.evaluate(() => { document.querySelector('#qa_p').click(); const n = document.querySelectorAll('.qm .qm-opt').length; closeQuick(false); return n; }) === 4);
  ok('priority pick', await pick('#qa_p', '1'));
  ok('assignee menu (#8 person menu) pick', await pick('#qa_a', MID));
  const selNow = await A.evaluate(() => ({ p: document.querySelector('#qa_p').textContent.trim(), a: document.querySelector('#qa_a .tx').textContent.trim(),
    t: document.querySelector('#qa_t .tx').textContent.trim(), tn: TYPE[DB.ui.qa.type][2] }));
  ok('selectors show chosen names', selNow.p.includes(env.acil) && selNow.a === 'PI Üye Dışı' && selNow.t === selNow.tn, JSON.stringify(selNow));

  // tarih doğrulaması: bitiş başlangıçtan önce → hata metni + Ekle pasif + Enter eklemez
  ok('start menu pick "Haftaya"', await pick('#qa_sd', env.wk));
  ok('due menu pick "Bugün"', await pick('#qa_d', env.today));
  const bad = await A.evaluate(() => ({ err: document.querySelector('#qa_err').textContent.trim(), dis: document.querySelector('#qa_add').disabled,
    rng: document.querySelector('#qa_rng').textContent.trim(), cls: document.querySelector('#qa_d').classList.contains('bad') }));
  ok('due before start: error text, Ekle disabled, no summary', bad.err === 'Bitiş, başlangıçtan önce olamaz.' && bad.dis && !bad.rng && bad.cls, JSON.stringify(bad));
  const nBefore = await A.evaluate(pid => DB.issues.filter(i => i.projectId === pid).length, PID);
  await A.click('#qa_s'); await A.keyboard.type('PIQ hatalı tarih'); await A.keyboard.press('Enter'); await sleep(300);
  ok('Enter does not add while dates invalid', await A.evaluate(([pid, n]) => DB.issues.filter(i => i.projectId === pid).length === n && document.querySelector('#qa_s').value === 'PIQ hatalı tarih', [PID, nBefore]));
  await A.fill('#qa_s', '');
  ok('start menu pick "Bugün"', await pick('#qa_sd', env.today));
  ok('due menu pick "Haftaya"', await pick('#qa_d', env.wk));
  const good = await A.evaluate(() => ({ err: document.querySelector('#qa_err').textContent.trim(), dis: document.querySelector('#qa_add').disabled,
    rng: document.querySelector('#qa_rng').textContent.trim(), sd: document.querySelector('#qa_sd').textContent.trim() }));
  ok('valid dates: summary "N iş günü", Ekle enabled', !good.err && !good.dis && good.rng.startsWith(env.wd + ' iş günü') && good.sd === 'Bugün', JSON.stringify(good) + ' wd=' + env.wd);

  // tahmin (agile: puan): geçersiz → hata + pasif; geçerli → kartın puanı
  await A.fill('#qa_est', '1001'); await sleep(100);
  const estBad = await A.evaluate(() => ({ err: document.querySelector('#qa_err').textContent, dis: document.querySelector('#qa_add').disabled, foc: document.activeElement?.id }));
  ok('estimate out of range: error, Ekle disabled, focus kept', /Puan 0 ile 1000/.test(estBad.err) && estBad.dis && estBad.foc === 'qa_est', JSON.stringify(estBad));
  await A.fill('#qa_est', '3');
  ok('estimate valid: error cleared', await A.evaluate(() => !document.querySelector('#qa_err').textContent && !document.querySelector('#qa_add').disabled));

  // Enter ile art arda ekleme: form açık kalır, tarih/tahmin sıfırlanır, tip/atanan/öncelik hatırlanır
  await A.click('#qa_s'); await A.keyboard.type('PIQ ilk kart'); await A.keyboard.press('Enter'); await sleep(350);
  const after1 = await A.evaluate(() => ({ f: document.activeElement?.id, v: document.querySelector('#qa_s')?.value, sd: document.querySelector('#qa_sd').textContent.trim(),
    d: document.querySelector('#qa_d').textContent.trim(), est: document.querySelector('#qa_est').value, rng: document.querySelector('#qa_rng').textContent.trim(),
    p: document.querySelector('#qa_p').textContent, q: { ...DB.ui.qa } }));
  ok('after add: form open, dates and estimate reset', after1.f === 'qa_s' && after1.v === '' && after1.sd === 'Seçin' && after1.d === 'Seçin' && after1.est === '' && !after1.rng
    && !after1.q.start && !after1.q.due && !after1.q.estimate, JSON.stringify(after1));
  ok('choices remembered (type, assignee, priority)', after1.p.includes(env.acil) && after1.q.assignee === MID && after1.q.type === typ && after1.q.priority === 1, JSON.stringify(after1.q));
  await A.keyboard.type('PIQ ikinci kart'); await A.keyboard.press('Enter'); await sleep(350);
  const made = await A.evaluate(([pid, s0]) => DB.issues.filter(i => i.projectId === pid && /^PIQ /.test(i.summary))
    .map(i => ({ s: i.summary, st: i.statusId === s0, p: i.priority, a: i.assignee, sd: i.start, d: i.due, t: i.type, pts: i.points, est: i.estimate })), [PID, S0]);
  const m1 = made.find(m => m.s === 'PIQ ilk kart'), m2 = made.find(m => m.s === 'PIQ ikinci kart');
  ok('Enter adds two cards in a row, cursor stays', made.length === 2 && await A.evaluate(() => document.activeElement?.id === 'qa_s' && document.querySelector('#qa_s').value === ''), JSON.stringify(made));
  ok('cards get values (column, type, priority, assignee)', made.every(m => m.st && m.p === 1 && m.a === MID && m.t === typ), JSON.stringify(made));
  ok('first card: start/due and points (agile: puan, no hours)', m1 && m1.sd === env.today && m1.d === env.wk && m1.pts === 3 && !m1.est, JSON.stringify(m1));
  ok('second card: no dates, no estimate', m2 && !m2.sd && !m2.d && m2.pts == null && !m2.est, JSON.stringify(m2));
  ok('cards visible in column', await A.evaluate(s0 => [...document.querySelectorAll(`.col[data-status="${s0}"] .card .sum`)].filter(e => e.textContent.startsWith('PIQ')).length, S0) === 2);
  await sleep(1200);
  ok('server stored start/due/points', await A.evaluate(async ([pid, k]) => { const r = await API.get('/api/state'); const d = r.data || r;
    const i = (d.issues || []).find(x => x.projectId === pid && x.summary === 'PIQ ilk kart'); return !!i && i.start === k.today && i.due === k.wk && i.points === 3; }, [PID, env]));
  await A.screenshot({ path: SS + 'qadd.png' });
  await A.keyboard.press('Escape'); await sleep(250);
  ok('Esc closes quick add', await A.evaluate(() => !document.querySelector('.qadd')));
  await A.click(`[data-qa="${S0}"]`); await sleep(250);
  await A.click('#qa_x'); await sleep(250);
  ok('Vazgeç closes quick add', await A.evaluate(() => !document.querySelector('.qadd') && !DB.ui.qaOpen));

  // Tüm alanlar…: tam form bu değerlerle (agile: puan)
  await A.click(`[data-qa="${S1}"]`); await sleep(300);
  await A.fill('#qa_s', 'PIQ tam form');
  await pick('#qa_sd', env.today); await pick('#qa_d', env.wk); await A.fill('#qa_est', '5');
  await A.click('#qa_more'); await sleep(500);
  const form = await A.evaluate(() => ({ sum: $('#f_sum')?.value, pri: $('#f_pri [aria-checked="true"]')?.dataset.pri, as: $('#f_as')?.value,
    start: $('#f_start')?.value, due: $('#f_due')?.value, pts: $('#f_pts')?.value, st: $('#f_st')?.value, type: $('#f_type')?.value, qadd: !!document.querySelector('.qadd') }));
  ok('"Tüm alanlar…" opens full form with values (dates, points)', form.sum === 'PIQ tam form' && form.pri === '1' && form.as === MID && form.start === env.today
    && form.due === env.wk && form.pts === '5' && form.st === S1 && form.type === typ && !form.qadd, JSON.stringify(form));
  await A.click('#doCreate'); await sleep(400);
  ok('full form creates in chosen column', await A.evaluate(([pid, s1, k]) => DB.issues.some(i => i.projectId === pid && i.summary === 'PIQ tam form' && i.statusId === s1
    && i.priority === 1 && i.start === k.today && i.due === k.wk && i.points === 5), [PID, S1, env]));
  // XSS: başlık metin olarak
  await A.click(`[data-qa="${S0}"]`); await sleep(200);
  await A.fill('#qa_s', '<img src=x onerror="window.__xss=1">'); await A.keyboard.press('Enter'); await sleep(400);
  ok('quick add title escaped', await A.evaluate(() => !window.__xss && !document.querySelector('.card .sum img')));
  await A.keyboard.press('Escape'); await sleep(200);

  // pano projesi: tahmin saat (ondalık), Tüm alanlar süreyi taşır
  await A.evaluate(() => { location.hash = 'home'; }); await sleep(250);
  const PB = await A.evaluate(() => DB.projects.find(p => projType(p) === 'board' && canSeeProject(p) && statsOf(p.id).length)?.id);
  await A.evaluate(pb => { DB.ui.project = pb; DB.board.scope = 'all'; DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = ''; location.hash = 'board'; }, PB); await sleep(600);
  const SB = await A.evaluate(() => stats()[0].id);
  await A.click(`[data-qa="${SB}"]`); await sleep(300);
  ok('board project: estimate unit is "saat"', await A.evaluate(() => document.querySelector('#qa_unit')?.textContent === 'saat' && /saat/.test(document.querySelector('#qa_est').getAttribute('aria-label'))));
  await A.fill('#qa_est', 'abc'); await sleep(80);
  ok('board project: invalid hours → error', await A.evaluate(() => /Tahmin 0 ile 1000 saat/.test(document.querySelector('#qa_err').textContent) && document.querySelector('#qa_add').disabled));
  await A.fill('#qa_est', '1,5');
  await A.fill('#qa_s', 'PIQ saatli'); await A.click('#qa_add'); await sleep(350);
  ok('board project: Ekle adds with hours (1,5 → 1.5), no points', await A.evaluate(pb => { const i = DB.issues.find(x => x.projectId === pb && x.summary === 'PIQ saatli');
    return !!i && i.estimate === 1.5 && i.remainingEst === 1.5 && i.points == null && !!document.querySelector('.qadd'); }, PB));
  await A.fill('#qa_s', 'PIQ saat tam'); await A.fill('#qa_est', '2'); await A.click('#qa_more'); await sleep(500);
  ok('board project: "Tüm alanlar…" carries hours', await A.evaluate(() => $('#f_est')?.value === '2h' && $('#f_sum').value === 'PIQ saat tam'));
  await A.evaluate(() => closeModal()); await sleep(200);
  await go(A, 'board');

  // mobil: dokunma hedefleri ≥44px + koyu tema
  const Mb = await mk('mobile', { width: 390, height: 844 }, 'dark'); await login(Mb, 'admin', 'admin12345');
  await go(Mb, 'board');
  await Mb.evaluate(s0 => { DB.ui.qaOpen = s0; render(); }, S0); await sleep(300);
  const tgt = await Mb.evaluate(() => ['#qa_s', '#qa_t', '#qa_a', '#qa_p', '#qa_sd', '#qa_d', '.qa2-num', '#qa_more', '#qa_x', '#qa_add'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? Math.round(Math.min(r.height, r.width)) : 0; }));
  ok('mobile: quick add targets ≥44px', tgt.every(h => h >= 44), tgt.join());
  ok('mobile: dark theme applied to form', await Mb.evaluate(() => { const c = getComputedStyle(document.querySelector('.qadd')).backgroundColor.match(/\d+/g).map(Number); return c[0] + c[1] + c[2] < 200; }));
  await Mb.screenshot({ path: SS + 'qadd_mobile_dark.png' });
  await Mb.evaluate(() => { DB.ui.qaOpen = null; render(); });

  /* ===== 2) alt işler panoda kart ===== */
  await go(A, 'board');
  const sub = await A.evaluate(([pid, s1]) => {
    const c = document.querySelector(`.col[data-status="${s1}"] .card[data-id="${pid}_sub"]`);
    const par = document.querySelector(`.card[data-id="${pid}_par"]`);
    return { inCol: !!c, chip: c?.querySelector('.c-par')?.textContent.trim(), counter: par?.querySelector('.c-sub')?.textContent.trim(),
      sw: document.querySelector('#fSubs')?.getAttribute('aria-checked') };
  }, [PID, S1]);
  ok('subtask card in its own status column', sub.inCol, JSON.stringify(sub));
  ok('subtask card shows parent key chip', sub.chip === `↳ ${KEY}-1`, sub.chip);
  ok('parent card keeps subtask counter', sub.counter === '0/1', sub.counter);
  ok('subtasks switch on by default', sub.sw === 'true', sub.sw);
  await A.click(`.card[data-id="${PID}_sub"] .c-par`); await sleep(500);
  ok('parent chip opens parent issue', await A.evaluate(pid => OPEN_ISSUE === pid + '_par' && document.querySelector('#scrim.on .id-dlg') != null, PID));
  await A.evaluate(() => closeModal()); await sleep(300);
  await A.click('#fSubs'); await sleep(400);
  const hid = await A.evaluate(pid => ({ card: !!document.querySelector(`.card[data-id="${pid}_sub"]`), pref: DB.board.subs, sw: document.querySelector('#fSubs').getAttribute('aria-checked'),
    focus: document.activeElement?.id }), PID);
  ok('switch hides subtasks (personal pref)', !hid.card && hid.pref === false && hid.sw === 'false' && hid.focus === 'fSubs', JSON.stringify(hid));
  await sleep(1500);
  ok('pref saved on server (user_prefs)', await A.evaluate(async () => (await API.get('/api/state')).data.board?.subs === false));
  await A.click('#fSubs'); await sleep(400);
  ok('switch shows subtasks again', await A.evaluate(pid => !!document.querySelector(`.card[data-id="${pid}_sub"]`) && DB.board.subs === true, PID));
  await go(A, 'backlog');
  ok('backlog row for subtask with parent chip', await A.evaluate(pid => document.querySelector(`.row[data-id="${pid}_sub"] .c-par`)?.textContent.trim(), PID) === `↳ ${KEY}-1`);

  /* ===== 3) sprint: yetki ve süre ===== */
  ok('manager sees "start sprint"', await A.evaluate(pid => !!document.querySelector(`[data-start="${pid}_sp"]`), PID));
  const fresh = async (name, u, pw) => { const p = await mk(name); await login(p, u, 'Baslangic123');
    await p.fill('#fp_a', pw); await p.fill('#fp_b', pw); await p.click('#fpForm button[type=submit]'); await sleep(1800); return p; };
  const V = await fresh('viewer', VU, 'PiIzl123456');
  await go(V, 'backlog');
  const vv = await V.evaluate(pid => ({ box: !!document.querySelector(`[data-sprint="${pid}_sp"]`), start: document.querySelectorAll('[data-start],[data-spcomplete]').length,
    canMan: canManageProject(P()) }), PID);
  ok('not manager (workspace viewer): sprint visible, no start/complete buttons', vv.box && vv.start === 0 && vv.canMan === false, JSON.stringify(vv));
  await go(V, 'admin');
  ok('not manager: sprint length read-only', await V.evaluate(() => !document.querySelector('#ptSprintW')));
  /* alan Üyesi (projenin üyesi de): düğme yok, sunucu reddeder */
  const M = await fresh('wsmember', MU, 'PiUye123456');
  await go(M, 'backlog');
  const mv = await M.evaluate(pid => ({ box: !!document.querySelector(`[data-sprint="${pid}_sp"]`), start: document.querySelectorAll('[data-start],[data-spcomplete],#newSprint').length,
    canMan: canManageProject(P()) }), PID);
  ok('workspace member (project member too): sprint visible, no create/start/complete buttons', mv.box && mv.start === 0 && mv.canMan === false, JSON.stringify(mv));
  await go(M, 'admin');
  ok('workspace member: no sprint length setting', await M.evaluate(() => !document.querySelector('#ptSprintW')));
  const srv = await M.evaluate(async pid => { const s = { ...DB.sprints.find(x => x.id === pid + '_sp'), state: 'active' };
    const r = await API.post('/api/sync', { changes: [{ c: 'sprints', id: s.id, op: 'put', data: s }] }); return (r.data?.rejected || r.rejected || []).map(x => x.reason); }, PID);
  ok('workspace member: server rejects sprint start', srv.join() === 'Sprinti yalnızca alan yöneticisi başlatıp bitirebilir', srv.join());
  const srvW = await M.evaluate(async pid => { const p = { ...DB.projects.find(x => x.id === pid), sprintWeeks: 4 };
    const r = await API.post('/api/sync', { changes: [{ c: 'projects', id: p.id, op: 'put', data: p }] }); return (r.data?.rejected || r.rejected || []).length; }, PID);
  ok('workspace member: server rejects sprint length change', srvW === 1, String(srvW));

  await go(A, 'admin');
  const w0 = await A.evaluate(() => document.querySelector('#ptSprintW')?.value);
  ok('sprint length setting default 1 week', w0 === '1', w0);
  /* alan Yöneticisi (genel rolü Üye): sprint düğmeleri var; proje ayarlarında yalnız projeye özel İş akışı ve Alanlar sekmeleri + sprint süresi */
  const Y = await fresh('wsadmin', YU, 'PiYon123456');
  await go(Y, 'backlog');
  const yv = await Y.evaluate(pid => ({ start: !!document.querySelector(`[data-start="${pid}_sp"]`), nw: !!document.querySelector('#newSprint'), canMan: canManageProject(P()), sys: isAdmin() }), PID);
  ok('workspace admin: create/start sprint buttons, canManageProject', yv.start && yv.nw && yv.canMan && !yv.sys, JSON.stringify(yv));
  await go(Y, 'admin');
  const ya = await Y.evaluate(() => ({ tabs: [...document.querySelectorAll('#adminTabs [data-a]')].map(b => b.dataset.a), w: !!document.querySelector('#ptSprintW'),
    def: !!document.querySelector('#defFlow,#saveDefFlow'), cols: !!document.querySelector('#ptColsSet') }));
  ok('workspace admin: project settings show only project-specific tabs: İş akışı + Alanlar (no general settings)', JSON.stringify(ya.tabs) === '["workflow","fields"]' && ya.w && !ya.def && ya.cols, JSON.stringify(ya));
  await Y.selectOption('#ptSprintW', '3'); await sleep(1500);
  ok('workspace admin: sprint length saved on server', await Y.evaluate(async pid => (await API.get('/api/state')).data.projects.find(p => p.id === pid)?.sprintWeeks === 3, PID));
  await A.reload(); await sleep(1500); await go(A, 'admin');
  ok('admin sees workspace admin\'s sprint length', await A.evaluate(() => document.querySelector('#ptSprintW')?.value) === '3');
  await A.selectOption('#ptSprintW', '2'); await sleep(1500);
  ok('sprint length saved (projects.data.sprintWeeks)', await A.evaluate(async pid => P().sprintWeeks === 2
    && (await API.get('/api/state')).data.projects.find(p => p.id === pid)?.sprintWeeks === 2, PID));
  await go(A, 'backlog');
  await A.click('#newSprint'); await sleep(400);
  const sd = await A.evaluate(() => ({ s: $('#s_start').value, e: $('#s_end').value, name: $('#s_name').value, dlg: !!document.querySelector('#scrim.on .id-m.sp-m'),
    df: !!document.querySelector('[data-df="s_start"]') && !!document.querySelector('[data-df="s_end"]'), days: $('#s_days')?.textContent, stats: document.querySelectorAll('#s_sum .sp-stat').length }));
  const days = (Date.parse(sd.e) - Date.parse(sd.s)) / 864e5 + 1;
  ok('new sprint: starts day after previous end, 14 days', sd.s === '2026-11-16' && days === 14 && sd.days === '14', JSON.stringify(sd));
  ok('create dialog: id- window, auto name "Sprint N", dateFields, scope summary', sd.dlg && /^Sprint \d+$/.test(sd.name) && sd.df && sd.stats === 3, JSON.stringify(sd));
  await A.evaluate(() => { const i = $('#s_start'); i.value = '2026-12-07'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  ok('create dialog: changing start recomputes end from sprint length', await A.evaluate(() => $('#s_end').value === '2026-12-20' && $('#s_days').textContent === '14'));
  await A.evaluate(([s]) => { const i = $('#s_start'); i.value = s; i.dispatchEvent(new Event('change', { bubbles: true })); }, [sd.s]);
  await A.click('#doSprint'); await sleep(400);
  ok('new sprint saved with dates', await A.evaluate(([pid, s]) => DB.sprints.some(x => x.projectId === pid && x.id !== pid + '_sp' && x.name === s.name && x.start === s.s && x.end === s.e && x.state === 'future'), [PID, sd]));

  // Aktif sprint sekmesi: agile projede Pano'dan sonra; aktif sprint yokken boş durum
  await go(A, 'sprint');
  const t0 = await A.evaluate(() => ({ tabs: [...document.querySelectorAll('#vtabs [role=tab]')].map(t => t.dataset.v), v: DB.ui.view, h: location.hash,
    empty: !!document.querySelector('.as-empty'), plan: !!document.querySelector('#asPlan') }));
  ok('agile: "Aktif sprint" tab right after Pano, #sprint opens it', t0.tabs[0] === 'board' && t0.tabs[1] === 'sprint' && t0.v === 'sprint' && t0.h === '#sprint', JSON.stringify(t0));
  ok('no active sprint: empty state + "Sprint planla" (manager)', t0.empty && t0.plan, JSON.stringify(t0));
  await go(V, 'sprint');
  ok('no active sprint: viewer sees empty state without "Sprint planla"', await V.evaluate(() => !!document.querySelector('.as-empty') && !document.querySelector('#asPlan')));
  await A.click('#asPlan'); await sleep(400);
  ok('"Sprint planla" goes to backlog', await A.evaluate(() => DB.ui.view === 'backlog'));

  // Başlat penceresi
  await A.click(`[data-start="${PID}_sp"]`); await sleep(400);
  const sw = await A.evaluate(() => ({ dlg: !!document.querySelector('#scrim.on .sp-m'), n: document.querySelector('.sp-stats .sp-stat b')?.textContent,
    cap: !!document.querySelector('.sp-cap [role=progressbar]'), btn: $('#doStart')?.textContent.trim() }));
  ok('start dialog: summary (2 issues), capacity comparison, primary "Sprinti başlat"', sw.dlg && sw.n === '2' && sw.cap && sw.btn === 'Sprinti başlat', JSON.stringify(sw));
  await A.screenshot({ path: SS + 'sprint_start.png' });
  await A.click('#doStart'); await sleep(1500);
  ok('manager starts sprint', await A.evaluate(async pid => (await API.get('/api/state')).data.sprints.find(s => s.id === pid + '_sp')?.state === 'active', PID));
  ok('manager sees "complete sprint"', await A.evaluate(pid => !!document.querySelector(`[data-spcomplete="${pid}_sp"]`), PID));

  // Aktif sprint panosu: başlık şeridi + yalnız sprint işleri
  await A.evaluate(([pid, s2]) => { const i = issue(pid + '_sub'); i.statusId = s2; save(); }, [PID, PID + '_s2']); await sleep(400);
  await go(A, 'sprint');
  const ah = await A.evaluate(pid => ({ h: document.querySelector('.as-head h2')?.textContent, goal: document.querySelector('.as-goal')?.textContent.trim(),
    goalB: !!document.querySelector('.as-goal b'), left: document.querySelector('.as-left')?.textContent, dates: !!document.querySelector('.as-dates'),
    prog: document.querySelector('.as-pl')?.textContent.replace(/\s+/g, ' ').trim(), bars: document.querySelectorAll('.as-head [role=progressbar]').length,
    done: !!document.querySelector(`.as-head [data-spcomplete="${pid}_sp"]`), cards: [...document.querySelectorAll('.board .card')].map(c => c.dataset.id),
    scope: !!document.querySelector('#scope'), sel: document.querySelector('#tab-sprint')?.getAttribute('aria-selected') }), PID);
  ok('sprint strip: name, goal (text), dates, days left, progress', ah.h === KEY + ' Sprint 1' && ah.goal === 'Panoyu <b>hızlandır</b>' && !ah.goalB && ah.dates && /gün kaldı|Son gün|gecikti/.test(ah.left || '')
    && /1\/2/.test(ah.prog) && ah.bars >= 1 && ah.done && ah.sel === 'true', JSON.stringify(ah));
  ok('sprint board: only sprint issues, no scope switch', ah.cards.includes(PID + '_par') && !ah.cards.some(id => !id.startsWith(PID + '_')) && !ah.scope, JSON.stringify(ah.cards));
  await A.screenshot({ path: SS + 'sprint_tab.png' });
  await go(V, 'sprint');
  ok('viewer: active sprint strip without "Sprinti tamamla"', await V.evaluate(() => !!document.querySelector('.as-head') && !document.querySelector('[data-spcomplete]')));

  // Tamamla penceresi: sayılar, oran, hedef seçimi
  await A.click(`.as-head [data-spcomplete="${PID}_sp"]`); await sleep(400);
  const cw = await A.evaluate(() => ({ st: [...document.querySelectorAll('.sp-stats .sp-stat b')].map(b => b.textContent), bar: document.querySelector('.sp-cap [role=progressbar]')?.getAttribute('aria-valuenow'),
    dest: [...document.querySelectorAll('.sp-dest [data-dest]')].map(b => [b.dataset.dest ? 'sprint' : 'backlog', b.getAttribute('aria-checked')]), btn: $('#doComplete')?.textContent.trim() }));
  ok('complete dialog: done/not done, success bar, destination (next sprint first / backlog)', cw.st[0] === '1' && cw.st[1] === '1' && cw.bar === '50'
    && JSON.stringify(cw.dest) === JSON.stringify([['sprint', 'true'], ['backlog', 'false']]) && cw.btn === 'Sprinti tamamla', JSON.stringify(cw));
  await A.click('.sp-dest [data-dest=""]'); await A.click('#doComplete'); await sleep(1500);
  ok('complete: open issue to backlog, sprint closed (server)', await A.evaluate(async pid => { const d = (await API.get('/api/state')).data;
    return d.sprints.find(s => s.id === pid + '_sp')?.state === 'closed' && d.issues.find(i => i.id === pid + '_par')?.sprintId == null
      && d.issues.find(i => i.id === pid + '_sub')?.sprintId === pid + '_sp'; }, PID));

  // Pano türündeki projede sekme yok, #sprint → Pano
  await A.evaluate(pb => { DB.ui.project = pb; DB.ui.view = 'board'; save(); render(); }, PID + 'b'); await sleep(300);
  await A.evaluate(() => { location.hash = 'sprint'; }); await sleep(400);
  ok('board-type project: no sprint tab, #sprint falls back to Pano', await A.evaluate(() => !document.querySelector('#tab-sprint') && DB.ui.view === 'board'));

  /* temizlik: tercihler eski hâline */
  await A.evaluate(() => { DB.board.subs = true; DB.ui.project = 'p1'; save(); }); await sleep(1200);
  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
