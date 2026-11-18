// Gezinme tarayıcı testi, dilim A1 (docs/tasarim/gezinme): proje sekmeleri, yol + proje adı, sağ üstte hesap menüsü,
// dar ekranda "Proje ▾" ve ☰ çekmece. Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/gezinme.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını, çalışma
// alanını ve projesini oluşturur; demo verisinde (modüller kapalı) yalnız kendi projesine iş ve süre ekler.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_nv_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const XSS = '<img src=x onerror="window.__xss=1">';
const WSN = `Gezinme ${RUN} ${XSS}`;
const M = 'u_nvm' + RUN, V = 'u_nvv' + RUN, D = 'u_nvd' + RUN, WS = 'ws_nv' + RUN, PX = 'p_nv' + RUN;
const PXN = `Gezinme Proje ${RUN} <b>kalın</b>`;
const ORDER = ['board', 'backlog', 'plan', 'roadmap', 'timesheet', 'effort', 'reports', 'search', 'admin'];
const LABELS = ['Pano', 'İş listesi', 'Zaman planı', 'Yol haritası', 'Zaman çizelgesi', 'Efor raporu', 'Raporlar', 'Arama', 'Proje ayarları'];

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
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
  const go = async (p, pid, v) => { await p.evaluate(([pid, v]) => { closeModal(); if (pid) DB.ui.project = pid; DB.ui.view = v; render(); }, [pid, v]); await sleep(150); };
  const hash = async (p, v) => { await p.evaluate(v => { location.hash = v; }, v); await sleep(250); };
  const waitFor = async (p, fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const tabs = p => p.evaluate(() => [...document.querySelectorAll('#vtabs [role="tab"]')].map(t => t.dataset.v));
  const sel = p => p.evaluate(() => { const s = [...document.querySelectorAll('#vtabs [aria-selected="true"]')]; return s.length === 1 ? s[0].dataset.v : s.length; });
  /* Yol haritası Epik modülüne bağlı: yalnız bu sekmede, kaydetmeden aç/kapat (demo'da kapalı). */
  const epic = (p, on) => p.evaluate(on => { DB.cfg.modules = { ...(DB.cfg.modules || {}), epic: on }; render(); }, on);

  const A = await mk('super'); await login(A, 'admin', 'admin12345');
  /* ---- kurulum: üye M, izleyici V, yönetici D; XSS adlı çalışma alanında proje PX (iş + bu ay süre) ---- */
  await A.evaluate(async ([R, M, V, D, WS, PX, WSN, PXN]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'nvm' + R, name: 'Gez Üye ' + R, role: 'member', active: true, ini: 'GÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'nvv' + R, name: 'Gez İzleyici ' + R, role: 'viewer', active: true, ini: 'Gİ', color: '#64748B' } },
      { c: 'users', id: D, op: 'put', data: { username: 'nvd' + R, name: 'Gez Yönetici ' + R, role: 'admin', active: true, ini: 'GY', color: '#7C3AED' } },
      { c: 'workspaces', id: WS, op: 'put', data: { id: WS, name: WSN, color: '#2563EB', description: '' } },
    ] });
    await reloadState();
    const p1 = DB.projects.find(x => x.id === 'p1'); p1.members = [...new Set([...(p1.members || []), M, V, D])];
    const used = new Set(DB.projects.map(x => x.code || x.key)); const k = projCode('Gezinme ' + R, used);
    DB.projects.push({ id: PX, key: k, code: k, name: PXN, lead: SESSION, counter: 0, members: [SESSION, M, V, D], archived: false, workspaceId: WS });
    [['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['Bitti', 'done']]
      .forEach(([n, c], i) => DB.statuses.push({ id: `${PX}_s${i}`, projectId: PX, name: n, cat: c, wip: 0, ord: i }));
    const pr = DB.projects.find(x => x.id === PX);
    for (let n = 1; n <= 3; n++) DB.issues.push({ id: `i_nv${R}${n}`, projectId: PX, key: `${k}-${++pr.counter}`, type: 'task', summary: `Gezinme işi ${n}`,
      description: '', statusId: `${PX}_s0`, assignee: M, reporter: SESSION, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(),
      rank: 1000 + n, start: '', due: '', estimate: 4, spent: n === 1 ? 2 : 0, sprintId: null });
    DB.worklogs.push({ id: 'wl_nv' + R, issueId: `i_nv${R}1`, userId: SESSION, date: TODAY, hours: 2, note: 'gezinme' });
    save(); await flushAll();
  }, [RUN, M, V, D, WS, PX, WSN, PXN]);
  await A.reload(); await sleep(2000);

  // 1) sekme satırı: 9 sekme sırası (Epik açıkken), tablist/tab, tek seçili, gezici tabindex, tabpanel
  await go(A, PX, 'board'); await epic(A, true);
  const t9 = await A.evaluate(() => {
    const tl = document.getElementById('vtabs'), ts = [...tl.querySelectorAll('[role="tab"]')];
    return { role: tl.getAttribute('role'), vs: ts.map(t => t.dataset.v), ls: ts.map(t => t.textContent.trim()),
      tab0: ts.filter(t => t.tabIndex === 0).map(t => t.dataset.v), panel: document.getElementById('view').getAttribute('role'),
      lab: document.getElementById('view').getAttribute('aria-labelledby'), bar: !document.getElementById('tabbar').hidden,
      under: document.getElementById('tabbar').compareDocumentPosition(document.getElementById('toolrow')) === Node.DOCUMENT_POSITION_FOLLOWING };
  });
  ok('9 project tabs in order with labels', JSON.stringify(t9.vs) === JSON.stringify(ORDER) && JSON.stringify(t9.ls) === JSON.stringify(LABELS), JSON.stringify(t9));
  ok('tablist/tab roles, roving tabindex, tabpanel, toolrow under tabs', t9.role === 'tablist' && t9.tab0.join() === 'board' && t9.panel === 'tabpanel'
    && t9.lab === 'tab-board' && t9.bar && t9.under && await sel(A) === 'board', JSON.stringify(t9));

  // 2) yol + proje adı: "Alan / ANAHTAR", başlık proje adı; XSS metin olarak
  const hd = await A.evaluate(PX => { const p = DB.projects.find(x => x.id === PX);
    return { crumb: document.getElementById('crumb').textContent, key: p.key, title: document.getElementById('title').textContent, name: p.name,
      img: document.querySelectorAll('#crumb img, #title img, #title b').length, nav: !!document.querySelector('#crumb nav[aria-label="Konum"] a[data-v="projects"]') }; }, PX);
  ok('crumb "workspace / KEY" and project name title (text, no markup)', hd.crumb.includes(WSN) && hd.crumb.trim().endsWith('/' + hd.key) && hd.title === PXN
    && hd.img === 0 && hd.nav, JSON.stringify(hd));
  ok('no XSS from workspace / project names', await A.evaluate(() => window.__xss === undefined));
  await A.screenshot({ path: SS + 'tabs.png' });

  // 3) 9 adres aynı ekranı açar, sekme seçili
  const hres = [];
  for (const v of ORDER) { await hash(A, v); hres.push([v, await A.evaluate(() => DB.ui.view), await sel(A)]); }
  ok('9 hashes open the same screen with tab selected', hres.every(([v, a, s]) => v === a && v === s), JSON.stringify(hres));

  // 4) Epik kapalı: Yol haritası sekmesi yok, #roadmap → Pano
  await epic(A, false); await hash(A, 'board');
  ok('epic off: no roadmap tab', !(await tabs(A)).includes('roadmap') && (await tabs(A)).length === 8, JSON.stringify(await tabs(A)));
  await hash(A, 'roadmap');
  ok('epic off: #roadmap falls back to Pano', await A.evaluate(() => DB.ui.view === 'board' && location.hash === '#board') && await sel(A) === 'board');

  // 5) klavye: ←/→ sarar, Home/End, Enter açar; odak seçili sekmede kalır
  await go(A, PX, 'board');
  await A.focus('#tab-board');
  await A.keyboard.press('ArrowRight');
  const k1 = await A.evaluate(() => ({ f: document.activeElement.dataset.v, v: DB.ui.view, ti: document.activeElement.tabIndex }));
  await A.keyboard.press('Enter'); await sleep(200);
  const k2 = await A.evaluate(() => ({ f: document.activeElement.dataset.v, v: DB.ui.view, s: document.activeElement.getAttribute('aria-selected') }));
  ok('ArrowRight moves focus only; Enter opens the tab and keeps focus', k1.f === 'backlog' && k1.v === 'board' && k1.ti === 0 && k2.f === 'backlog' && k2.v === 'backlog' && k2.s === 'true',
    JSON.stringify([k1, k2]));
  await A.keyboard.press('End'); const kE = await A.evaluate(() => document.activeElement.dataset.v);
  await A.keyboard.press('ArrowRight'); const kW = await A.evaluate(() => document.activeElement.dataset.v);
  await A.keyboard.press('ArrowLeft'); const kL = await A.evaluate(() => document.activeElement.dataset.v);
  await A.keyboard.press('Home'); const kH = await A.evaluate(() => document.activeElement.dataset.v);
  ok('End / wrap-around ArrowRight / ArrowLeft / Home', kE === 'admin' && kW === 'board' && kL === 'admin' && kH === 'board', [kE, kW, kL, kH].join());
  await A.keyboard.press(' '); await sleep(200);
  ok('Space opens focused tab', await A.evaluate(() => DB.ui.view === 'board'));

  // 6) g-kısayolları ve Ctrl+K aynen
  await A.evaluate(() => document.activeElement.blur());
  const gk = [];
  for (const [k, v] of [['l', 'backlog'], ['e', 'effort'], ['a', 'search'], ['b', 'board'], ['h', 'home']]) {
    await A.keyboard.press('g'); await A.keyboard.press(k); await sleep(300); gk.push([v, await A.evaluate(() => DB.ui.view)]);
  }
  ok('g shortcuts still work', gk.every(([a, b]) => a === b), JSON.stringify(gk));
  await A.keyboard.press('Control+k'); await sleep(250);
  await A.fill('#pl_q', 'Efor raporu'); await A.keyboard.press('Enter'); await sleep(300);
  ok('Ctrl+K palette still opens screens', await A.evaluate(() => DB.ui.view === 'effort' && !document.getElementById('scrim').classList.contains('on')));

  // 7) genel ekranlarda sekme satırı yok
  const gen = [];
  for (const v of ['home', 'projects', 'customers', 'users', 'system']) { await hash(A, v);
    gen.push(await A.evaluate(v => ({ v, ok: DB.ui.view === v && document.getElementById('tabbar').hidden && !document.querySelector('#vtabs [role="tab"]')
      && document.getElementById('title').textContent === viewTitle(v) && !document.getElementById('view').getAttribute('role') }), v)); }
  ok('general screens: no tab row, title is the screen name', gen.every(x => x.ok), JSON.stringify(gen));

  // 8) Efor raporu projeye süzülü; seçim kutusu kalır, proje değişince yeni projeyi izler
  /* Önceki çalıştırmadan kalan kişisel seçim (efProjFor/efProject) temizlenir. */
  await A.evaluate(() => { delete DB.ui.efProjFor; delete DB.ui.efProject; });
  await go(A, PX, 'effort');
  const e1 = await A.evaluate(PX => ({ sel: document.getElementById('efProject').value, logs: periodLogs().length,
    only: periodLogs().every(w => issue(w.issueId)?.projectId === PX), all: !!document.querySelector('#efProject option[value=""]') }), PX);
  ok('effort: filtered to current project, "Tüm projeler" kept', e1.sel === PX && e1.logs >= 1 && e1.only && e1.all, JSON.stringify(e1));
  await go(A, 'p1', 'effort');
  const e2 = await A.evaluate(() => ({ sel: document.getElementById('efProject').value, only: periodLogs().every(w => issue(w.issueId)?.projectId === 'p1') }));
  await A.selectOption('#efProject', ''); await sleep(250);
  const e3 = await A.evaluate(PX => ({ sel: document.getElementById('efProject').value, any: periodLogs().some(w => issue(w.issueId)?.projectId === PX) }), PX);
  await go(A, PX, 'effort');
  const e4 = await A.evaluate(() => document.getElementById('efProject').value);
  ok('effort: follows project change; "Tüm projeler" holds for that project only', e2.sel === 'p1' && e2.only && e3.sel === '' && e3.any && e4 === PX,
    JSON.stringify([e2, e3, e4]));

  // 9) Arama: boş sorguda yalnız seçili projenin işleri (süper yönetici dahil); dolu sorgu tüm projeler
  await A.evaluate(() => { DB.ui.pql = ''; }); await go(A, PX, 'search');
  const s1 = await A.evaluate(PX => { const ids = [...document.querySelectorAll('#view tr[data-open]')].map(r => r.dataset.open);
    return { n: ids.length, exp: DB.issues.filter(i => i.projectId === PX).length, only: ids.every(id => issue(id)?.projectId === PX), sup: isSuper() }; }, PX);
  ok('search: empty query lists only the project issues (super too)', s1.sup && s1.n === s1.exp && s1.n === 3 && s1.only, JSON.stringify(s1));
  await A.fill('#pql', 'oncelik <= 9'); await A.click('#runQ'); await sleep(300);
  ok('search: filled query spans all visible projects', await A.evaluate(PX => [...document.querySelectorAll('#view tr[data-open]')].some(r => issue(r.dataset.open)?.projectId !== PX), PX));
  await A.evaluate(() => { DB.ui.pql = ''; save(); render(); });

  // 10) hesap menüsü: avatar, rol, canlı kayıt durumu, ↑/↓, Esc / dışarı / Tab kapatır, odak avatara
  const av = await A.evaluate(() => { const b = document.getElementById('acctBtn'), bell = document.getElementById('btnBell');
    return { ini: b.textContent, ini2: CU().ini, lab: b.getAttribute('aria-label'), pop: b.getAttribute('aria-haspopup'), exp: b.getAttribute('aria-expanded'),
      right: !!(bell.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), whoami: !!document.getElementById('whoami'), data: !!document.querySelector('[data-v="__data"]') }; });
  ok('avatar right of bell with initials; old session box and "Hesap ▾" gone', av.ini === av.ini2 && av.lab === 'Hesap: ' + (await A.evaluate(() => CU().name))
    && av.pop === 'menu' && av.exp === 'false' && av.right && !av.whoami && !av.data, JSON.stringify(av));
  await A.evaluate(() => flushAll()); await sleep(100);
  await A.click('#acctBtn'); await sleep(150);
  const m1 = await A.evaluate(() => { const m = document.getElementById('acctMenu');
    return { role: m?.getAttribute('role'), exp: document.getElementById('acctBtn').getAttribute('aria-expanded'), f: document.activeElement.dataset.act,
      txt: m?.textContent.replace(/\s+/g, ' '), sys: !!m?.querySelector('[data-v="system"]'), out: !!m?.querySelector('[data-act="logout"]'),
      sync: document.getElementById('acctSync')?.textContent, theme: m?.querySelector('[data-act="theme"]')?.getAttribute('aria-checked') }; });
  ok('menu: name, username, role, sync state and items (super)', m1.role === 'menu' && m1.exp === 'true' && m1.f === 'savefile' && /Yönetici/.test(m1.txt) && /admin/.test(m1.txt)
    && /Süper yönetici/.test(m1.txt) && m1.sync === 'Tüm değişiklikler kaydedildi' && /Şimdi kaydet/.test(m1.txt) && /Parolamı değiştir/.test(m1.txt)
    && /Koyu tema/.test(m1.txt) && /Klavye kısayolları/.test(m1.txt) && m1.sys && m1.out && /^(true|false)$/.test(m1.theme), JSON.stringify(m1));
  const live = await A.evaluate(async () => { const p = DB.projects.find(x => x.id === 'p1'); p.description = (p.description || '') + ' ';
    save(); const a = document.getElementById('acctSync').textContent; await flushAll();
    await new Promise(r => setTimeout(r, 100)); return [a, document.getElementById('acctSync').textContent]; });
  ok('menu sync state is live ("Kaydediliyor…" → "Tüm değişiklikler kaydedildi")', live[0] === 'Kaydediliyor…' && live[1] === 'Tüm değişiklikler kaydedildi', JSON.stringify(live));
  await A.keyboard.press('ArrowDown'); const d1 = await A.evaluate(() => document.activeElement.dataset.act);
  await A.keyboard.press('ArrowUp'); await A.keyboard.press('ArrowUp'); const d2 = await A.evaluate(() => document.activeElement.dataset.act);
  ok('menu ↑/↓ (wraps)', d1 === 'pw' && d2 === 'logout', [d1, d2].join());
  await A.keyboard.press('Escape'); await sleep(100);
  ok('Esc closes menu, focus back to avatar', await A.evaluate(() => !document.getElementById('acctMenu') && document.activeElement.id === 'acctBtn'
    && document.getElementById('acctBtn').getAttribute('aria-expanded') === 'false'));
  await A.click('#acctBtn'); await sleep(100); await A.click('#title'); await sleep(100);
  ok('outside click closes menu', await A.evaluate(() => !document.getElementById('acctMenu')));
  await A.click('#acctBtn'); await sleep(100); await A.keyboard.press('Tab'); await sleep(100);
  ok('Tab closes menu', await A.evaluate(() => !document.getElementById('acctMenu')));
  await A.click('#acctBtn'); await sleep(100); await A.click('#acctMenu [data-acct="keys"]'); await sleep(200);
  ok('"Klavye kısayolları" opens the shortcut list', await A.evaluate(() => /Klavye kısayolları/.test(document.querySelector('#scrim .m-h')?.textContent || '') && !document.getElementById('acctMenu')));
  await A.evaluate(() => closeModal());
  const th0 = await A.evaluate(() => isDark());
  await A.click('#acctBtn'); await sleep(100); await A.click('#acctMenu [data-act="theme"]'); await sleep(150);
  await A.click('#acctBtn'); await sleep(100);
  const th1 = await A.evaluate(() => ({ d: isDark(), c: document.querySelector('#acctMenu [data-act="theme"]').getAttribute('aria-checked') }));
  ok('theme item toggles and reflects state', th1.d === !th0 && th1.c === String(!th0), JSON.stringify([th0, th1]));
  await A.click('#acctMenu [data-act="theme"]'); await sleep(100);
  await A.click('#acctBtn'); await sleep(100); await A.click('#acctMenu [data-v="system"]'); await sleep(300);
  ok('"Sistem" item opens Sistem', await A.evaluate(() => DB.ui.view === 'system' && !document.getElementById('acctMenu')));
  await A.click('#acctBtn'); await sleep(100); await A.screenshot({ path: SS + 'acct.png' }); await A.keyboard.press('Escape');

  // 11) yönetici / üye / izleyici: sekmeler ve menü rol bazlı; üyede Proje ayarları yok, #admin → Pano
  const Dp = await mk('admin-role'); await login(Dp, 'nvd' + RUN, 'Baslangic123', 'GezYon12345!');
  const Mp = await mk('member'); await login(Mp, 'nvm' + RUN, 'Baslangic123', 'GezUye12345!');
  const Vp = await mk('viewer'); await login(Vp, 'nvv' + RUN, 'Baslangic123', 'GezIzl12345!');
  for (const [n, p, adm, rl] of [['admin', Dp, true, 'Yönetici'], ['member', Mp, false, 'Üye'], ['viewer', Vp, false, 'İzleyici']]) {
    await go(p, PX, 'board');
    const tb = await tabs(p);
    await p.click('#acctBtn'); await sleep(150);
    const mm = await p.evaluate(() => ({ role: document.querySelector('#acctMenu .nv-role')?.textContent.trim(), sys: !!document.querySelector('#acctMenu [data-v="system"]'),
      out: !!document.querySelector('#acctMenu [data-act="logout"]'), pw: !!document.querySelector('#acctMenu [data-act="pw"]') }));
    await p.keyboard.press('Escape');
    ok(`${n}: tabs ${adm ? 'with' : 'without'} Proje ayarları, menu role "${rl}", Sistem ${adm ? 'shown' : 'hidden'}`,
      tb.includes('admin') === adm && tb.length === (adm ? 8 : 7) && mm.role === rl && mm.sys === adm && mm.out && mm.pw, JSON.stringify([tb, mm]));
    if (!adm) {
      await hash(p, 'admin');
      ok(`${n}: #admin falls back to Pano`, await p.evaluate(() => DB.ui.view === 'board' && location.hash === '#board') && await sel(p) === 'board');
      ok(`${n}: rail hides Proje ayarları / Kullanıcılar / Sistem`, await p.evaluate(() => ['admin', 'users', 'system']
        .every(v => document.querySelector(`.nav a[data-v="${v}"]`).style.display === 'none')));
    }
  }
  ok('member: search empty query = project issues', await Mp.evaluate(PX => { DB.ui.pql = ''; DB.ui.project = PX; DB.ui.view = 'search'; render();
    return document.querySelectorAll('#view tr[data-open]').length === DB.issues.filter(i => i.projectId === PX).length; }, PX));

  // 12) başkasının değişikliği (poll) sekme satırını bozmaz: odak sekmede kalır
  await go(Mp, PX, 'board'); await Mp.focus('#tab-board'); await Mp.keyboard.press('ArrowRight');
  await A.evaluate(PX => { DB.projects.find(x => x.id === PX).description = 'poll ' + Date.now(); save(); }, PX);
  await sleep(5500);
  ok('poll re-render keeps tab focus (roving)', await Mp.evaluate(() => document.activeElement?.dataset.v === 'backlog' && DB.ui.view === 'board'));

  // 13) dar ekran 375px: sekmeler yana kayar, "Proje ▾" tablist dışında, ☰ çekmece, ≥44px, yatay taşma yok
  const Mo = await mk('mobile', { width: 375, height: 812 }); await login(Mo, 'nvm' + RUN, 'GezUye12345!');
  await go(Mo, PX, 'board');
  const mb = await Mo.evaluate(() => { const r = e => e.getBoundingClientRect(), pp = document.getElementById('projPick'), tl = document.getElementById('vtabs');
    return { sw: document.documentElement.scrollWidth, pp: r(pp).height, ppIn: !!pp.closest('[role="tablist"]'), ppTxt: pp.textContent.trim(), ppV: pp.dataset.v,
      tab: Math.min(...[...tl.querySelectorAll('[role="tab"]')].map(t => r(t).height)), one: new Set([...tl.querySelectorAll('[role="tab"]')].map(t => Math.round(r(t).top))).size,
      scroll: tl.scrollWidth > tl.clientWidth, av: r(document.getElementById('acctBtn')), nb: r(document.getElementById('navBtn')),
      rail: r(document.getElementById('rail')).right, bell: r(document.getElementById('btnBell')).height }; });
  ok('mobile: one-line scrollable tabs ≥44px, "Proje ▾" outside tablist, no horizontal overflow', mb.sw <= 375 && mb.pp >= 44 && !mb.ppIn && mb.ppTxt === 'Proje'
    && mb.ppV === '__proj' && mb.tab >= 44 && mb.one === 1 && mb.scroll, JSON.stringify(mb));
  ok('mobile: avatar top-right, ☰ top-left, touch ≥44px, rail closed', mb.av.right > 330 && mb.av.top < 60 && mb.av.height >= 44 && mb.nb.left < 40 && mb.nb.height >= 44
    && mb.bell >= 44 && mb.rail <= 0, JSON.stringify(mb));
  await hash(Mo, 'search');
  const vis = await Mo.evaluate(() => { const tl = document.getElementById('vtabs'), s = tl.querySelector('[aria-selected="true"]'), a = tl.getBoundingClientRect(), b = s.getBoundingClientRect();
    return { v: s.dataset.v, l: b.left >= a.left - 1, r: b.right <= a.right + 1, sl: tl.scrollLeft, wx: scrollX, sw: document.documentElement.scrollWidth }; });
  ok('mobile: open tab scrolled into the visible area (no page scroll)', vis.v === 'search' && vis.l && vis.r && vis.sl > 0 && vis.wx === 0 && vis.sw <= 375, JSON.stringify(vis));
  await Mo.screenshot({ path: SS + 'm_tabs.png' });
  await Mo.click('#projPick'); await sleep(250);
  ok('mobile: "Proje ▾" opens the project picker', await Mo.evaluate(() => !!document.querySelector('#scrim.on #pm_ws')));
  await Mo.evaluate(() => closeModal());
  await Mo.click('#navBtn'); await sleep(350);
  const dr = await Mo.evaluate(() => { const r = document.getElementById('rail').getBoundingClientRect();
    return { open: document.body.classList.contains('nav-open'), l: r.left, w: r.width, exp: document.getElementById('navBtn').getAttribute('aria-expanded'),
      scrim: !document.getElementById('navScrim').hidden, home: !!document.querySelector('#rail .nav a[data-v="home"]'), ws: !!document.querySelector('#rail #wsCur'),
      plan: [...document.querySelectorAll('#rail .navgroup')].map(g => g.textContent.trim()), sw: document.documentElement.scrollWidth }; });
  ok('mobile ☰: drawer with today\'s rail content (no Planlama/Takip)', dr.open && dr.l >= 0 && dr.w <= 375 && dr.exp === 'true' && dr.scrim && dr.home && dr.ws
    && !dr.plan.includes('Planlama') && !dr.plan.includes('Takip') && dr.sw <= 375, JSON.stringify(dr));
  await Mo.screenshot({ path: SS + 'm_drawer.png' });
  await Mo.keyboard.press('Escape'); await sleep(300);
  ok('mobile ☰: Esc closes, focus back to ☰', await Mo.evaluate(() => !document.body.classList.contains('nav-open') && document.activeElement.id === 'navBtn'));
  await Mo.click('#navBtn'); await sleep(350); await Mo.click('#rail .nav a[data-v="customers"]'); await sleep(400);
  ok('mobile ☰: picking a screen closes the drawer (general screen: no tabs)', await Mo.evaluate(() => DB.ui.view === 'customers' && !document.body.classList.contains('nav-open')
    && document.getElementById('tabbar').hidden));
  await Mo.click('#navBtn'); await sleep(350); await Mo.click('#navScrim', { position: { x: 360, y: 400 } }); await sleep(300);
  ok('mobile ☰: scrim click closes', await Mo.evaluate(() => !document.body.classList.contains('nav-open')));
  await Mo.click('#acctBtn'); await sleep(200);
  const ma = await Mo.evaluate(() => { const m = document.getElementById('acctMenu').getBoundingClientRect();
    return { l: m.left, r: m.right, mi: Math.min(...[...document.querySelectorAll('#acctMenu .nv-mi')].map(x => x.getBoundingClientRect().height)), sw: document.documentElement.scrollWidth }; });
  ok('mobile account menu inside viewport, items ≥44px', ma.l >= 0 && ma.r <= 375 && ma.mi >= 44 && ma.sw <= 375, JSON.stringify(ma));
  await Mo.screenshot({ path: SS + 'm_acct.png' });
  await Mo.keyboard.press('Escape');

  ok('no XSS anywhere', (await Promise.all([A, Dp, Mp, Vp, Mo].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));

  /* temizlik: test projesi ve alanı kalır (kendi kimlikleri); demo projesi p1'e eklenen üyelik zararsız */
  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
