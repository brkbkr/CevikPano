// Pano kartı ve 4 seviyeli öncelik tarayıcı testi (issue #8, docs/tasarim/kart/karar.md).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/kart.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi işlerini ve
// izleyicisini oluşturur; regresyon/kullanıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_k_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);           // tekrar çalıştırmada çakışmasın
const ID = n => `i_kt${RUN}_${n}`;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1600, height: 900 }, colorScheme = 'light') => {
    const ctx = await b.newContext({ viewport: vp, colorScheme });
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
  /* Panoyu yalnız bu testin kartlarıyla aç (filtre: özet "KART-T<RUN>"). */
  const board = async p => {
    await p.evaluate(() => { location.hash = 'home'; }); await sleep(300);
    await p.evaluate(q => { DB.ui.project = 'p1'; DB.board.scope = 'all'; DB.board.swimlane = 'none';
      DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = q; location.hash = 'board'; }, 'KART-T' + RUN);
    await sleep(700);
  };
  const qmOpen = p => p.evaluate(() => !!document.querySelector('.qm'));
  const scrimOn = p => p.evaluate(() => document.getElementById('scrim').classList.contains('on'));
  const hist = (p, id, field) => p.evaluate(([id, f]) => DB.history.filter(h => h.issueId === id && h.field === f)
    .sort((a, b) => a.at - b.at).map(h => `${h.from} → ${h.to}`), [id, field]);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ---- test verisi: 1–5 öncelik, alanı olmayan iş, XSS'li ve çok etiketli iş ---- */
  const users = await A.evaluate(([ids, xss]) => {
    const pr = DB.projects.find(x => x.id === 'p1');
    const st = DB.statuses.filter(s => s.projectId === 'p1' && s.cat !== 'done').sort((a, b) => a.ord - b.ord).map(s => s.id);
    const mkI = (id, n, extra) => ({ id, projectId: 'p1', key: `${pr.key}-${++pr.counter}`, type: 'task',
      summary: `KART-T${ids[0]} ${n}`, description: '', statusId: st[n % st.length], assignee: null, reporter: ME.id,
      labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: -1000 + n, start: '', due: '', ...extra });
    [1, 2, 3, 4, 5].forEach(p => DB.issues.push(mkI(ids[p], p, { priority: p })));
    DB.issues.push(mkI(ids[6], 6, {}));                                          // priority alanı yok
    DB.issues.push(mkI(ids[7], 7, { priority: 3, labels: [xss, 'Bordro', 'Hukuk', 'SGK'] }));
    DB.rules.push({ id: 'r_kt' + ids[0], name: 'Kart testi: atanınca etiket', on: 'assigned', whenStatus: null,
      then: [{ act: 'label', v: 'atandi' }], projectId: 'p1', enabled: true });
    save();
    return memsOf(pr).map(u => ({ id: u.id, name: u.name }));
  }, [[RUN, 1, 2, 3, 4, 5, 6, 7].map((n, k) => k ? ID(n) : RUN), XSS]);
  await sleep(1800);
  await board(A);

  // 1) kartta 4 seviye: ikon + metin; 5 → Düşük; alanı olmayan → Orta; pano çökmez
  const badges = await A.evaluate(ids => ids.map(id => { const el = document.querySelector(`.card[data-id="${id}"] .prio`);
    return el ? [el.className.replace('prio', '').replace('open', '').trim(), el.textContent.trim(), !!el.querySelector('svg')] : null; }),
    [1, 2, 3, 4, 5, 6].map(ID));
  ok('card shows 4 levels with icon + text', JSON.stringify(badges) === JSON.stringify([
    ['acil', 'Acil', true], ['yuksek', 'Yüksek', true], ['orta', 'Orta', true], ['dusuk', 'Düşük', true],
    ['dusuk', 'Düşük', true], ['orta', 'Orta', true]]), JSON.stringify(badges));
  const noPri = await A.evaluate(async id => { const r = await API.get('/api/state'); const i = r.data.issues.find(x => x.id === id);
    return i && !('priority' in i); }, ID(6));
  ok('issue without priority stored as-is and board renders', noPri && await A.isVisible(`.card[data-id="${ID(6)}"]`));
  ok('no unicode priority glyphs left on board', await A.evaluate(() => !/[⇈⇊↑↓]/.test(document.getElementById('view').textContent)));
  await A.screenshot({ path: SS + 'board.png' });

  // 2) PQL: yeni adlar, eski takma adlar, 5 artık boş
  const q = await A.evaluate(([ids, run]) => {
    const f = s => runQuery(s + ` AND ozet ~ "KART-T${run}"`).map(i => i.id).sort();
    return { dusuk: f('oncelik = Düşük'), dusukAscii: f('oncelik = dusuk'), bes: f('oncelik = 5'),
      kritik: f('oncelik = Kritik'), onemsiz: f('oncelik = Önemsiz'), orta: f('oncelik = Orta'), le2: f('oncelik <= 2'), ids };
  }, [[1, 2, 3, 4, 5, 6, 7].map(ID), RUN]);
  ok('PQL oncelik = Düşük finds 4 and 5', JSON.stringify(q.dusuk) === JSON.stringify([ID(4), ID(5)].sort()), JSON.stringify(q.dusuk));
  ok('PQL ascii/alias names work', JSON.stringify(q.dusukAscii) === JSON.stringify(q.dusuk) && JSON.stringify(q.onemsiz) === JSON.stringify(q.dusuk)
    && JSON.stringify(q.kritik) === JSON.stringify([ID(1)]), JSON.stringify([q.dusukAscii, q.onemsiz, q.kritik]));
  ok('PQL oncelik = 5 empty', q.bes.length === 0, JSON.stringify(q.bes));
  ok('PQL Orta includes missing priority', JSON.stringify(q.orta) === JSON.stringify([ID(3), ID(6), ID(7)].sort()), JSON.stringify(q.orta));
  ok('PQL oncelik <= 2', JSON.stringify(q.le2) === JSON.stringify([ID(1), ID(2)].sort()), JSON.stringify(q.le2));

  // 3) XSS'li etiket kaçışlı; en fazla 2 etiket + "+n"
  const tags = await A.evaluate(id => { const c = document.querySelector(`.card[data-id="${id}"] .c-tags`);
    return c && { n: c.querySelectorAll('.c-tag').length, img: c.querySelectorAll('img').length, first: c.children[0].textContent, last: c.lastElementChild.textContent }; }, ID(7));
  ok('xss label escaped on card', tags && tags.img === 0 && tags.first === XSS && !(await A.evaluate(() => window.__xss)), JSON.stringify(tags));
  ok('labels limited to 2 + "+n"', tags && tags.n === 3 && tags.last === '+2', JSON.stringify(tags));

  // 4) öncelik rozeti menüsü: açılır, mevcut seviye işaretli, seçim kaydedilir, geçmiş adla
  await A.click(`[data-qpri="${ID(3)}"]`); await sleep(250);
  const m1 = await A.evaluate(() => { const m = document.querySelector('.qm');
    return m && { n: m.querySelectorAll('.qm-opt').length, checked: m.querySelector('[aria-checked="true"]')?.dataset.qv,
      inBody: m.parentElement.parentElement === document.body, fixed: getComputedStyle(m).position, focus: document.activeElement?.dataset?.qv }; });
  ok('priority menu opens in body (fixed) with 4 options, Orta checked', m1 && m1.n === 4 && m1.checked === '3' && m1.inBody && m1.fixed === 'fixed', JSON.stringify(m1));
  ok('priority menu focuses current option', m1 && m1.focus === '3');
  const r1 = await A.evaluate(() => { const r = document.querySelector('.qm').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  ok('desktop menu inside viewport', r1);
  ok('card not opened by badge click', !(await scrimOn(A)));
  /* Menü açıkken başkasının değişikliği gelirse yeniden çizim ertelenir. */
  const deferred = await A.evaluate(id => { RERENDER = true; tryRerender();
    return RERENDER === true && document.querySelector(`[data-qpri="${id}"]`).classList.contains('open'); }, ID(3));
  ok('tryRerender deferred while menu open', deferred);
  await A.screenshot({ path: SS + 'pri_menu.png' });
  await A.click('.qm [data-qv="1"]'); await sleep(300);
  ok('menu closes after pick', !(await qmOpen(A)));
  ok('pick saved locally', await A.evaluate(id => issue(id).priority === 1 && !!document.querySelector(`.card[data-id="${id}"] .prio.acil`), ID(3)));
  ok('history "Orta → Acil"', JSON.stringify(await hist(A, ID(3), 'Öncelik')) === JSON.stringify(['Orta → Acil']), JSON.stringify(await hist(A, ID(3), 'Öncelik')));
  ok('deferred rerender ran after close', await A.evaluate(() => RERENDER === false));
  await sleep(1500);
  const srv1 = await A.evaluate(async id => { const r = await API.get('/api/state');
    return [r.data.issues.find(x => x.id === id).priority, r.data.history.filter(h => h.issueId === id && h.field === 'Öncelik').map(h => h.from + '→' + h.to)]; }, ID(3));
  ok('pick synced to server', srv1[0] === 1 && srv1[1].includes('Orta→Acil'), JSON.stringify(srv1));

  // 5) 5 olan iş: "Düşük" seçili, Düşük seçmek ya da 4 tuşu hiçbir şey yazmaz
  await A.click(`[data-qpri="${ID(5)}"]`); await sleep(250);
  ok('priority 5 shows Düşük checked', await A.evaluate(() => document.querySelector('.qm [aria-checked="true"]')?.dataset.qv) === '4');
  const h5 = await A.evaluate(id => DB.history.filter(h => h.issueId === id).length, ID(5));
  await A.click('.qm [data-qv="4"]'); await sleep(300);
  await A.click(`[data-qpri="${ID(5)}"]`); await sleep(200); await A.keyboard.press('4'); await sleep(300);
  ok('priority 5 unchanged after picking Düşük', await A.evaluate(([id, h]) => issue(id).priority === 5 && DB.history.filter(x => x.issueId === id).length === h, [ID(5), h5]));

  // 6) klavye: ok tuşları odak taşır, 1–4 seçer
  await A.click(`[data-qpri="${ID(2)}"]`); await sleep(250);
  await A.keyboard.press('ArrowDown'); await sleep(80);
  const f1 = await A.evaluate(() => document.activeElement?.dataset?.qv);
  await A.keyboard.press('ArrowUp'); await A.keyboard.press('ArrowUp'); await sleep(80);
  const f2 = await A.evaluate(() => document.activeElement?.dataset?.qv);
  ok('arrow keys move focus in menu', f1 === '3' && f2 === '1', f1 + ',' + f2);
  await A.keyboard.press('3'); await sleep(300);
  ok('number key picks level', await A.evaluate(id => issue(id).priority === 3, ID(2)) && !(await qmOpen(A)));
  ok('history "Yüksek → Orta"', (await hist(A, ID(2), 'Öncelik')).join() === 'Yüksek → Orta');
  /* Enter ile seçim (odaklı seçenek). */
  await A.click(`[data-qpri="${ID(2)}"]`); await sleep(200); await A.keyboard.press('ArrowUp'); await A.keyboard.press('Enter'); await sleep(300);
  ok('Enter picks focused option', await A.evaluate(id => issue(id).priority === 2, ID(2)));

  // 7) Esc ve dışarı tıklama kapatır, kartı açmaz; kart gövdesi detayı açar
  await A.click(`[data-qpri="${ID(1)}"]`); await sleep(200);
  await A.keyboard.press('Escape'); await sleep(200);
  ok('Esc closes menu without opening card', !(await qmOpen(A)) && !(await scrimOn(A)));
  ok('Esc returns focus to badge', await A.evaluate(id => document.activeElement?.dataset?.qpri === id, ID(1)));
  await A.click(`[data-qpri="${ID(1)}"]`); await sleep(200);
  await A.click(`.card[data-id="${ID(6)}"] .sum`); await sleep(300);
  ok('outside click closes menu, card not opened', !(await qmOpen(A)) && !(await scrimOn(A)));
  ok('outside click changes nothing', await A.evaluate(id => issue(id).priority === 1, ID(1)));
  /* Başka bir rozete tıklamak doğrudan onun menüsünü açar. */
  await A.click(`[data-qpri="${ID(1)}"]`); await sleep(200);
  await A.click(`[data-qpri="${ID(6)}"]`); await sleep(250);
  ok('clicking another badge switches menu', await A.evaluate(id => document.querySelectorAll('.qm').length === 1
    && document.querySelector(`[data-qpri="${id}"]`).classList.contains('open'), ID(6)));
  await A.keyboard.press('Escape'); await sleep(150);
  await A.click(`.card[data-id="${ID(6)}"] .sum`); await sleep(400);
  ok('card body click opens issue detail', await scrimOn(A) && await A.evaluate(id => OPEN_ISSUE === id, ID(6)));
  ok('detail priority selector has 4 options, Orta for missing', await A.evaluate(() => {
    const s = document.querySelector('[data-f="priority"]'); return s.options.length === 4 && s.value === '3'; }));
  await A.evaluate(() => closeModal()); await sleep(200);

  // 8) avatar menüsü ile atama: geçmişte ad, "Atanan değişince" otomasyonu çalışır
  const target = users[0];
  await A.click(`[data-qas="${ID(4)}"]`); await sleep(250);
  const m2 = await A.evaluate(() => { const m = document.querySelector('.qm.as');
    return m && { opts: [...m.querySelectorAll('.qm-opt')].map(o => o.dataset.qv), checked: m.querySelector('[aria-checked="true"]')?.dataset.qv }; });
  ok('assignee menu lists project users + Atanmamış', m2 && users.every(u => m2.opts.includes(u.id)) && m2.opts.includes('') && m2.checked === '', JSON.stringify(m2));
  await A.screenshot({ path: SS + 'as_menu.png' });
  await A.click(`.qm [data-qv="${target.id}"]`); await sleep(300);
  ok('quick assign saved', await A.evaluate(([id, u]) => issue(id).assignee === u, [ID(4), target.id]));
  ok('history "— → name" for assignee', (await hist(A, ID(4), 'Atanan')).join() === `— → ${target.name}`, (await hist(A, ID(4), 'Atanan')).join());
  ok('assigned rule ran on quick assign', await A.evaluate(id => (issue(id).labels || []).includes('atandi'), ID(4)));
  ok('avatar shows assignee', await A.evaluate(([id, n]) => document.querySelector(`[data-qas="${id}"]`).title === 'Atanan: ' + n, [ID(4), target.name]));
  /* Aynı kişiyi seçmek bir şey yazmaz. */
  const hc = await A.evaluate(id => DB.history.filter(h => h.issueId === id).length, ID(4));
  await A.click(`[data-qas="${ID(4)}"]`); await sleep(200); await A.click(`.qm [data-qv="${target.id}"]`); await sleep(300);
  ok('same assignee writes nothing', await A.evaluate(([id, n]) => DB.history.filter(h => h.issueId === id).length === n, [ID(4), hc]));
  /* 8'den fazla kişide arama kutusu: geçici (kaydedilmeyen) kişilerle denenir. */
  await A.evaluate(() => { const p = DB.projects.find(x => x.id === 'p1'); window.__mem = [...p.members];
    for (let k = 0; k < 7; k++) { DB.users.push({ id: 'u_tmp' + k, username: 'tmp' + k, name: 'Geçici Kişi ' + k, role: 'member', active: true, ini: 'G' + k, color: '#0F766E' });
      p.members.push('u_tmp' + k); } });
  await A.click(`[data-qas="${ID(7)}"]`); await sleep(250);
  const hasSearch = await A.evaluate(() => document.activeElement?.classList.contains('qm-in'));
  await A.keyboard.type('bur'); await sleep(150);
  const filtered = await A.evaluate(() => [...document.querySelectorAll('.qm .qm-opt')].map(o => o.dataset.qv));
  await A.keyboard.type('xyz'); await sleep(150);
  const none = await A.evaluate(() => document.querySelectorAll('.qm .qm-opt').length === 0 && !!document.querySelector('.qm-empty'));
  await A.keyboard.press('Escape'); await sleep(150);
  await A.evaluate(() => { DB.users = DB.users.filter(u => !u.id.startsWith('u_tmp')); DB.projects.find(x => x.id === 'p1').members = window.__mem; render(); });
  ok('assignee search shown for > 8 people and focused', hasSearch);
  ok('assignee search filters by name', filtered.join() === 'u1', filtered.join());
  ok('assignee search: no match message', none);
  /* Atanmamış simgesi */
  ok('unassigned avatar icon', await A.evaluate(id => { const b = document.querySelector(`[data-qas="${id}"]`); return b.classList.contains('none') && !!b.querySelector('svg'); }, ID(1)));

  // 9) iş detayında atanan/öncelik: adla geçmiş + otomasyon
  await A.evaluate(id => openIssue(id), ID(1)); await sleep(300);
  await A.selectOption('[data-f="assignee"]', users[1].id); await sleep(300);
  await A.selectOption('[data-f="priority"]', '2'); await sleep(300);
  await A.evaluate(() => closeModal());
  ok('detail assign: history by name + rule', (await hist(A, ID(1), 'Atanan')).join() === `— → ${users[1].name}`
    && await A.evaluate(id => issue(id).labels.includes('atandi'), ID(1)), (await hist(A, ID(1), 'Atanan')).join());
  ok('detail priority: history by name', (await hist(A, ID(1), 'Öncelik')).join() === 'Acil → Yüksek', (await hist(A, ID(1), 'Öncelik')).join());
  /* 5 olan iş detayında Düşük seçili; Düşük'ü tekrar seçmek yazmaz. */
  await A.evaluate(id => openIssue(id), ID(5)); await sleep(300);
  const d5 = await A.$eval('[data-f="priority"]', s => s.value);
  await A.evaluate(() => { const s = document.querySelector('[data-f="priority"]'); s.value = '4'; s.onchange(); }); await sleep(200);
  await A.evaluate(() => closeModal());
  ok('detail: priority 5 shown as Düşük and kept', d5 === '4' && await A.evaluate(id => issue(id).priority === 5 && !DB.history.some(h => h.issueId === id && h.field === 'Öncelik'), ID(5)));

  // 10) toplu düzenleme: atanan → otomasyon + adla geçmiş; öncelik 1–4
  await A.evaluate(id => { location.hash = 'search'; }); await sleep(600);
  await A.evaluate(id => { SEL.clear(); SEL.add(id); render(); }, ID(6)); await sleep(300);
  const bulkOpts = await A.$$eval('#bk_pr option', o => o.map(x => x.value).filter(Boolean));
  await A.selectOption('#bk_as', users[2].id); await A.selectOption('#bk_pr', '4'); await A.click('#bk_go'); await sleep(300);
  ok('bulk priority options 1–4', bulkOpts.join() === '1,2,3,4', bulkOpts.join());
  ok('bulk assign: rule + history by name', await A.evaluate(([id, u]) => { const i = issue(id); return i.assignee === u && i.labels.includes('atandi') && i.priority === 4; }, [ID(6), users[2].id])
    && (await hist(A, ID(6), 'Atanan')).join() === `— → ${users[2].name}` && (await hist(A, ID(6), 'Öncelik')).join() === 'Orta → Düşük');
  await sleep(1500);

  // 11) diğer seçiciler yalnız 4 seçenek
  await board(A);
  const sels = await A.evaluate(() => {
    const n = [];
    newIssueForm(); n.push(document.querySelectorAll('#f_pri option').length); closeModal();
    subTaskForm(DB.issues.find(i => i.projectId === 'p1' && !i.parentId).id); n.push(document.querySelectorAll('#sb_p option').length); closeModal();
    DB.ui.qaOpen = stats()[0].id; render(); n.push(document.querySelectorAll('#qa_p option').length); DB.ui.qaOpen = null; render();
    return n;
  });
  ok('new issue / subtask / quick add selectors have 4 options', sels.join() === '4,4,4', sels.join());

  // 12) izleyici: rozet ve avatar düğme değil, menü açılmaz
  const vu = 'kartizl' + RUN, vid = 'u_kv' + RUN;
  await A.evaluate(async ([vid, vu]) => {
    await API.post('/api/sync', { changes: [{ c: 'users', id: vid, op: 'put', data: { username: vu, name: 'Kart İzleyici', role: 'viewer', active: true, ini: 'Kİ', color: '#64748B' } }] });
    const p = DB.projects.find(x => x.id === 'p1'); p.members = [...new Set([...(p.members || []), vid])]; save();
  }, [vid, vu]);
  await sleep(1500);
  const V = await mk('viewer'); await login(V, vu, 'Baslangic123');
  await V.fill('#fp_a', 'KartIzl12345'); await V.fill('#fp_b', 'KartIzl12345'); await V.click('#fpForm button[type=submit]'); await sleep(1800);
  await board(V);
  const vv = await V.evaluate(() => ({ cards: document.querySelectorAll('.card').length, btn: document.querySelectorAll('[data-qpri],[data-qas],.c-tick').length,
    spans: document.querySelectorAll('span.prio').length }));
  ok('viewer: badges are plain spans, no quick buttons', vv.cards >= 7 && vv.btn === 0 && vv.spans === vv.cards, JSON.stringify(vv));
  await V.click(`.card[data-id="${ID(3)}"] .prio`); await sleep(300);
  ok('viewer: no quick menu', !(await qmOpen(V)));
  await V.evaluate(() => closeModal());

  // 13) mobil 390px: alt sayfa, taşma yok, satırlar ≥ 44px, tamamla düğmesi görünür
  const M = await mk('mobile', { width: 390, height: 844 }); await login(M, 'admin', 'admin12345');
  await board(M);
  ok('mobile: complete button always visible', await M.evaluate(id => getComputedStyle(document.querySelector(`.card[data-id="${id}"] .c-tick`)).opacity === '1', ID(1)));
  await M.click(`[data-qpri="${ID(1)}"]`); await sleep(300);
  const mm = await M.evaluate(() => { const m = document.querySelector('.qm'); if (!m) return null; const r = m.getBoundingClientRect();
    return { l: r.left, r: r.right, b: r.bottom, t: r.top, sheet: !!document.querySelector('.qm-wrap.sheet .qm-dim'),
      minH: Math.min(...[...m.querySelectorAll('.qm-opt')].map(o => o.getBoundingClientRect().height)), sw: document.documentElement.scrollWidth }; });
  ok('mobile: priority sheet inside 390px viewport', mm && mm.sheet && mm.l >= 0 && mm.r <= 390 && mm.b <= 844 + 0.5 && mm.t >= 0 && mm.sw <= 391, JSON.stringify(mm));
  ok('mobile: menu rows >= 44px', mm && mm.minH >= 44, mm && String(mm.minH));
  await M.screenshot({ path: SS + 'm_pri.png' });
  await M.click('.qm-dim', { position: { x: 20, y: 20 } }); await sleep(300);
  ok('mobile: tapping backdrop closes sheet, card not opened', !(await qmOpen(M)) && !(await scrimOn(M)));
  await M.click(`[data-qas="${ID(2)}"]`); await sleep(300);
  const ma = await M.evaluate(() => { const m = document.querySelector('.qm'); const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.bottom <= 844.5; });
  ok('mobile: assignee sheet inside viewport', ma);
  await M.screenshot({ path: SS + 'm_as.png' });
  await M.keyboard.press('Escape');

  // 14) güvenlik: XSS yükleri sunucuda reddedilir; istemciye yine de ulaşırsa çalışmaz, pano çökmez
  const PAY = '"><img src=x onerror="window.__xss=1">';
  const X = await mk('xss'); await login(X, 'admin', 'admin12345');
  const rej = await X.evaluate(async ([pay, run]) => {
    const base = { projectId: 'p1', summary: 'KART-T' + run + ' xss', statusId: 'p1_s0' };
    const cfg = DB.cfg;
    const r = await API.post('/api/sync', { changes: [
      { c: 'issues', id: 'i' + pay, op: 'put', data: base },
      { c: 'issues', id: 'i_xp' + run, op: 'put', data: { ...base, points: '<img src=x onerror="window.__xss=1">' } },
      { c: 'issues', id: 'i_xc' + run, op: 'put', data: { ...base, type: 'epic', color: 'red' + pay } },
      { c: 'issues', id: 'i_xl' + run, op: 'put', data: { ...base, labels: 'metin' } },
      { c: 'issues', id: 'i_xa' + run, op: 'put', data: { ...base, assignee: 'u_yok_' + run } },
      { c: '_settings', id: 'cfg', op: 'put', data: { ...cfg, types: cfg.types.map((t, k) => k ? t : { ...t, color: 'red' + pay }) } },
    ] });
    return [r.applied, r.rejected.length];
  }, [PAY, RUN]);
  ok('server rejects XSS payloads (id, points, color, labels, assignee, cfg.types)', rej[0] === 0 && rej[1] === 6, JSON.stringify(rej));
  /* İkinci katman: yük bir şekilde istemciye ulaşmış gibi yerelde enjekte et (kaydetmeden). */
  await board(X);
  await X.evaluate(([pay, run]) => {
    window.save = () => {}; window.scheduleSync = () => {};
    DB.cfg.modules = { ...DB.cfg.modules, points: true, epic: true };
    DB.cfg.types[0].color = 'red' + pay; buildTypes();
    const st = DB.statuses.find(s => s.projectId === 'p1' && s.cat === 'todo').id;
    const mkI = (id, extra) => ({ id, projectId: 'p1', key: 'PANO-9' + DB.issues.length, type: DB.cfg.types[0].id, summary: 'KART-T' + run + ' x',
      statusId: st, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: -5000, start: TODAY, due: TODAY, ...extra });
    DB.issues.push(mkI('i_xe' + run, { type: 'epic', color: 'red' + pay, summary: 'KART-T' + run + ' epik' }));
    DB.issues.push(mkI('i' + pay, { epicId: 'i_xe' + run, points: '<img src=x onerror="window.__xss=1">' }));
    DB.issues.push(mkI('i_xl' + run, { labels: 'metin' }));
    DB.issues.push(mkI('i_xo' + run, { labels: { a: 1 }, priority: '<img src=x>' }));
    render();
  }, [PAY, RUN]);
  await sleep(300);
  const v1 = await X.evaluate(() => ({ cards: document.querySelectorAll('.card').length, img: document.querySelectorAll('#view img[src="x"]').length, xss: !!window.__xss }));
  await X.evaluate(() => { location.hash = 'backlog'; }); await sleep(500);
  const v2 = await X.evaluate(() => ({ rows: document.querySelectorAll('.row').length, img: document.querySelectorAll('#view img[src="x"]').length, xss: !!window.__xss }));
  await X.evaluate(() => { location.hash = 'roadmap'; }); await sleep(500);
  const v3 = await X.evaluate(() => ({ img: document.querySelectorAll('#view img[src="x"]').length, xss: !!window.__xss, title: document.getElementById('title')?.textContent }));
  ok('injected XSS does not run on board/backlog/roadmap', !v1.xss && !v2.xss && !v3.xss && v1.img + v2.img + v3.img === 0, JSON.stringify([v1, v2, v3]));
  ok('board survives non-array labels / bad priority', v1.cards >= 10 && v2.rows > 0 && !errs.some(e => e.startsWith('xss')), JSON.stringify(v1) + ' ' + errs.filter(e => e.startsWith('xss')).join('; '));
  await X.screenshot({ path: SS + 'xss.png' });
  await X.context().close();

  // 14b) çalışma günü ayarı kaydedilince diğer yapılandırma (modüller, türler, varsayılan akış) silinmez
  await A.evaluate(() => { location.hash = 'admin'; }); await sleep(500);
  await A.evaluate(() => { DB.ui.adminTab = 'people'; render(); }); await sleep(200);
  const setH = v => A.evaluate(v => { const el = document.getElementById('cfgH'); el.value = v; el.dispatchEvent(new Event('change')); }, v);
  const h0 = await A.evaluate(() => { window.__cfg0 = JSON.parse(JSON.stringify(DB.cfg)); return DB.cfg.h || 8; });
  await setH('7'); await sleep(1500);
  const cfg1 = await A.evaluate(async () => { const srv = (await API.get('/api/state')).data.cfg, c0 = window.__cfg0;
    const J = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x);   // jsonb anahtar sırası
    return Object.fromEntries(['modules', 'types', 'defaultStatuses'].flatMap(k => [['loc_' + k, J(DB.cfg[k]) === J(c0[k])], ['srv_' + k, J(srv[k]) === J(c0[k])]])
      .concat([['h', DB.cfg.h === 7 && srv.h === 7], ['had', !!c0.modules && !!c0.types && !!c0.defaultStatuses]])); });
  ok('work-day setting keeps other cfg (modules, types, default flow)', Object.values(cfg1).every(Boolean), JSON.stringify(cfg1));
  await setH(String(h0)); await sleep(1200);
  await A.evaluate(() => { DB.ui.adminTab = 'workflow'; save(); });

  // 15) koyu tema ekran görüntüsü + temizlik
  const D = await mk('dark', undefined, 'dark'); await login(D, 'admin', 'admin12345');
  await board(D); await D.screenshot({ path: SS + 'dark.png' });
  await A.evaluate(r => { DB.rules = DB.rules.filter(x => x.id !== r); DB.board.q = ''; save(); }, 'r_kt' + RUN); await sleep(1200);

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
