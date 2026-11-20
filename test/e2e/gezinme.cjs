// Gezinme tarayıcı testi (docs/tasarim/gezinme). Dilim A1: proje sekmeleri, yol + proje adı, sağ üstte hesap menüsü,
// dar ekranda "Proje ▾" ve ☰ çekmece. Dilim A2: sol menüde çalışma alanı ağacı, son kullanılanlar, "Kenar çubuğunu özelleştir",
// "Daha fazla", koyu tema karşıtlığı. Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
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
const WS2 = 'ws_nv2' + RUN, P6 = [1, 2, 3, 4, 5, 6].map(n => `p_nv${RUN}_${n}`);      // A2: 6 projeli alan
const PXN = `Gezinme Proje ${RUN} <b>kalın</b>`;
const ORDER = ['board', 'backlog', 'plan', 'roadmap', 'versions', 'timesheet', 'effort', 'reports', 'search', 'admin'];
const LABELS = ['Pano', 'İş listesi', 'Zaman planı', 'Yol haritası', 'Sürümler', 'Zaman çizelgesi', 'Efor raporu', 'Raporlar', 'Arama', 'Proje ayarları'];

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
  await A.evaluate(async ([R, M, V, D, WS, PX, WSN, PXN, P6, WS2]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'nvm' + R, name: 'Gez Üye ' + R, role: 'member', active: true, ini: 'GÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'nvv' + R, name: 'Gez İzleyici ' + R, role: 'viewer', active: true, ini: 'Gİ', color: '#64748B' } },
      { c: 'users', id: D, op: 'put', data: { username: 'nvd' + R, name: 'Gez Yönetici ' + R, role: 'admin', active: true, ini: 'GY', color: '#7C3AED' } },
      { c: 'workspaces', id: WS, op: 'put', data: { id: WS, name: WSN, color: '#2563EB', description: '' } },
      { c: 'workspaces', id: WS2, op: 'put', data: { id: WS2, name: 'Altı Proje ' + R, color: '#047857', description: '' } },
    ] });
    await reloadState();
    const p1 = DB.projects.find(x => x.id === 'p1'); p1.roles = { ...(p1.roles || {}), [M]: 'member', [V]: 'viewer', [D]: 'member' }; p1.members = [...new Set([...(p1.members || []), M, V, D])];
    const used = new Set(DB.projects.map(x => x.code || x.key)); const k = projCode('Gezinme ' + R, used);
    DB.projects.push({ id: PX, key: k, code: k, name: PXN, lead: SESSION, counter: 0, members: [SESSION, M, V, D], archived: false, workspaceId: WS });
    [['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['Bitti', 'done']]
      .forEach(([n, c], i) => DB.statuses.push({ id: `${PX}_s${i}`, projectId: PX, name: n, cat: c, wip: 0, ord: i }));
    const pr = DB.projects.find(x => x.id === PX);
    for (let n = 1; n <= 3; n++) DB.issues.push({ id: `i_nv${R}${n}`, projectId: PX, key: `${k}-${++pr.counter}`, type: 'task', summary: `Gezinme işi ${n}`,
      description: '', statusId: `${PX}_s0`, assignee: M, reporter: SESSION, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(),
      rank: 1000 + n, start: '', due: '', estimate: 4, spent: n === 1 ? 2 : 0, sprintId: null });
    DB.worklogs.push({ id: 'wl_nv' + R, issueId: `i_nv${R}1`, userId: SESSION, date: TODAY, hours: 2, note: 'gezinme' });
    /* A2: 6 projeli alan (üye M ve izleyici V hepsinde) */
    P6.forEach((id, n) => { const k6 = projCode('Altı ' + R + ' ' + n, new Set(DB.projects.map(x => x.code || x.key)));
      DB.projects.push({ id, key: k6, code: k6, name: `Altı ${n + 1} ${R}`, lead: SESSION, counter: 0, members: [SESSION, M, V], archived: false, workspaceId: WS2 });
      ['Yapılacak', 'Bitti'].forEach((nm, i) => DB.statuses.push({ id: `${id}_s${i}`, projectId: id, name: nm, cat: i ? 'done' : 'todo', wip: 0, ord: i })); });
    save(); await flushAll();
  }, [RUN, M, V, D, WS, PX, WSN, PXN, P6, WS2]);
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
  ok('10 project tabs in order with labels', JSON.stringify(t9.vs) === JSON.stringify(ORDER) && JSON.stringify(t9.ls) === JSON.stringify(LABELS), JSON.stringify(t9));
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
  ok('epic off: no roadmap tab', !(await tabs(A)).includes('roadmap') && (await tabs(A)).length === 9, JSON.stringify(await tabs(A)));
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
      sync: !!document.getElementById('acctSync') || !!m?.querySelector('[data-act="savefile"]'), theme: m?.querySelector('[data-act="theme"]')?.getAttribute('aria-checked') }; });
  /* Kayıt göstergeleri kalktı: menüde "Şimdi kaydet" ve "Tüm değişiklikler kaydedildi" yok (yalnız sorun çipi, aşağıda). */
  ok('menu: name, username, role and items (super), no save indicators', m1.role === 'menu' && m1.exp === 'true' && m1.f === 'pw' && /Yönetici/.test(m1.txt) && /admin/.test(m1.txt)
    && /Süper yönetici/.test(m1.txt) && !m1.sync && !/Şimdi kaydet|Tüm değişiklikler kaydedildi/.test(m1.txt) && /Parolamı değiştir/.test(m1.txt)
    && /Koyu tema/.test(m1.txt) && /Klavye kısayolları/.test(m1.txt) && m1.sys && m1.out && /^(true|false)$/.test(m1.theme), JSON.stringify(m1));
  await A.keyboard.press('ArrowDown'); const d1 = await A.evaluate(() => document.activeElement.dataset.act);
  await A.keyboard.press('ArrowUp'); await A.keyboard.press('ArrowUp'); const d2 = await A.evaluate(() => document.activeElement.dataset.act);
  ok('menu ↑/↓ (wraps)', d1 === 'theme' && d2 === 'logout', [d1, d2].join());
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

  // 10b) kayıt göstergesi yalnız sorun olduğunda: normalde sol altta / üstte hiçbir şey yok; çevrimdışı ve uzun süren kayıtta
  //      üst çubukta çip, tıklayınca hemen yeniden dener; sayfa kapanırken bekleyen değişiklik uyarısı aynen
  const quiet = () => A.evaluate(() => ({ chip: document.querySelector('#syncWarn button')?.textContent.trim() || '', fb: !!document.getElementById('fileBar'),
    rail: /Kaydedildi|otomatik kaydedilir/.test(document.getElementById('rail').textContent) }));
  const edit = () => A.evaluate(() => { const p = DB.projects.find(x => x.id === 'p1'); p.description = (p.description || '').trim() + ' ' + Date.now(); save(); });
  await edit(); await sleep(60);
  const q0 = await quiet(); await A.evaluate(() => flushAll()); await sleep(100); const q1 = await quiet();
  ok('sync: no indicator while saving normally or after save (no #fileBar)', !q0.chip && !q1.chip && !q0.fb && !q0.rail && !q1.rail, JSON.stringify([q0, q1]));
  await A.context().setOffline(true); await edit(); await sleep(1200);
  const off = await A.evaluate(() => { const c = document.querySelector('#syncWarn button'); return { t: c?.textContent.trim(), act: c?.dataset.act, live: document.getElementById('syncWarn').getAttribute('role'),
    vis: !!c && c.getBoundingClientRect().width > 0, dirty: DIRTY }; });
  ok('sync: offline → chip "Bağlantı yok — değişiklikler bekliyor" (status, retry button)', off.t === 'Bağlantı yok — değişiklikler bekliyor' && off.act === 'savefile' && off.live === 'status' && off.vis && off.dirty, JSON.stringify(off));
  ok('sync: pending changes still guarded on page close (beforeunload)', await A.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; }));
  /* çevrimdışıyken çipe tıklamak hemen dener (başarısız: çip kalır); bağlantı gelince kendiliğinden gönderilir */
  await A.click('#syncWarn button'); await sleep(600);
  ok('sync: chip click while offline retries, chip stays', await A.evaluate(() => SYNC_STATE === 'error' && !!document.querySelector('#syncWarn button')));
  await A.context().setOffline(false); await sleep(1500);
  ok('sync: back online → saved automatically, chip gone', await A.evaluate(() => !document.querySelector('#syncWarn button') && SYNC_STATE === 'ok' && !DIRTY));
  /* gönderim 10 sn'den uzun sürerse "gecikiyor" çipi */
  await A.route('**/api/sync', async r => { await sleep(11500); try { await r.continue(); } catch (_) { } });
  await edit(); await sleep(10900);
  const slow = (await quiet()).chip;
  await A.unroute('**/api/sync'); await A.evaluate(() => flushAll()); await sleep(1200);
  ok('sync: saving longer than 10 s → chip, then gone when saved', slow === 'Kaydetme gecikiyor — yeniden dene' && !(await quiet()).chip, slow);
  /* gönderim başarısız (sunucu hatası) */
  await A.route('**/api/sync', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }));
  await edit(); await sleep(1500);
  const fail = (await quiet()).chip;
  await A.unroute('**/api/sync'); await A.click('#syncWarn button'); await sleep(1500);
  ok('sync: failed send → "Kaydedilemedi, yeniden deneniyor", retry clears it', fail === 'Kaydedilemedi, yeniden deneniyor' && !(await quiet()).chip, fail);

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
      tb.includes('admin') === adm && tb.length === (adm ? 9 : 8) && mm.role === rl && mm.sys === adm && mm.out && mm.pw, JSON.stringify([tb, mm]));
    /* Ctrl+K paletinde "Git" ekranları viewAllowed ile süzülür: yetkisiz Kullanıcılar / Sistem / Proje ayarları yok */
    await p.evaluate(() => document.activeElement?.blur()); await p.keyboard.press('Control+k'); await sleep(250);
    const pg = await p.evaluate(() => [...document.querySelectorAll('#pl_r .row')].filter(r => r.querySelector('.k')?.textContent === 'Git').map(r => r.querySelector('.sum').textContent));
    await p.evaluate(() => closeModal());
    ok(`${n}: palette screens by role`, ['Kullanıcılar', 'Sistem', 'Proje ayarları'].every(x => pg.includes(x) === adm) && pg.includes('Pano') && pg.includes('Benim işlerim'), JSON.stringify(pg));
    if (!adm) {
      await hash(p, 'admin');
      ok(`${n}: #admin falls back to Pano`, await p.evaluate(() => DB.ui.view === 'board' && location.hash === '#board') && await sel(p) === 'board');
      /* dilim A2: yetkisiz ekranlar sol menüde hiç çizilmez */
      ok(`${n}: rail hides Proje ayarları / Kullanıcılar / Sistem`, await p.evaluate(() => ['admin', 'users', 'system']
        .every(v => !document.querySelector(`#rail [data-v="${v}"]`))));
    }
  }
  ok('member: search empty query = project issues', await Mp.evaluate(PX => { DB.ui.pql = ''; DB.ui.project = PX; DB.ui.view = 'search'; render();
    return document.querySelectorAll('#view tr[data-open]').length === DB.issues.filter(i => i.projectId === PX).length; }, PX));

  // 12) başkasının değişikliği (poll) sekme satırını bozmaz: odak sekmede kalır
  await go(Mp, PX, 'board'); await Mp.focus('#tab-board'); await Mp.keyboard.press('ArrowRight');
  await A.evaluate(PX => { DB.projects.find(x => x.id === PX).description = 'poll ' + Date.now(); save(); }, PX);
  await sleep(5500);
  ok('poll re-render keeps tab focus (roving)', await Mp.evaluate(() => document.activeElement?.dataset.v === 'backlog' && DB.ui.view === 'board'));

  /* ======================= dilim A2: sol menü ağacı ve kenar çubuğunu özelleştir ======================= */
  const railState = p => p.evaluate(() => ({ nav: DB.ui.nav, more: !!document.querySelector('#navMore [data-navmore]'),
    items: [...document.querySelectorAll('#navRoot .nv-list > .nv-item')].map(x => x.dataset.v || (x.hasAttribute('data-navrecent') ? 'recent' : '?')) }));
  await waitFor(Mp, P6 => P6.every(id => DB.projects.some(p => p.id === id)), P6, 9000);

  // A2-1) ağaç: alan satırı <button aria-expanded aria-controls>, seçili proje aria-current="page", alanı açık; aç/kapa kişisel ve kalıcı
  await go(Mp, PX, 'board');
  const t1 = await Mp.evaluate(([WS, PX]) => { const r = document.querySelector(`#wsTree [data-wstog="${WS}"]`), l = document.getElementById(r?.getAttribute('aria-controls'));
    return { tag: r?.tagName, exp: r?.getAttribute('aria-expanded'), list: !!l && !l.hidden, cur: document.querySelector(`#wsTree [data-proj="${PX}"]`)?.getAttribute('aria-current'),
      pages: document.querySelectorAll('#rail [aria-current="page"]').length, name: r?.querySelector('.tx')?.textContent, img: document.querySelectorAll('#rail img:not(.brand-ic)').length,
      sel: !!document.querySelector('#projSel, #wsCur, #wsSwitch'), conf: [...document.querySelectorAll('#rail')].some(x => /Yapılandırma|Proje ayarları/.test(x.textContent)) }; }, [WS, PX]);
  ok('A2 tree: workspace row button (aria-expanded/controls), current project aria-current=page, old selectors gone', t1.tag === 'BUTTON' && t1.exp === 'true' && t1.list
    && t1.cur === 'page' && t1.pages === 1 && t1.name === WSN && t1.img === 0 && !t1.sel && !t1.conf, JSON.stringify(t1));
  /* 22b: alan adı önce alan sayfasını açar (açık kalır); alan sayfasındayken tıklamak aç/kapa yapar */
  await Mp.click(`#wsTree [data-wstog="${WS}"]`); await sleep(250);
  ok('A2 tree: workspace name opens the workspace page (row stays open)', await Mp.evaluate(WS => DB.ui.view === 'workspace' && DB.ui.workspace === WS
    && !!document.querySelector(`[data-wspage="${WS}"]`) && document.querySelector(`#wsTree [data-wstog="${WS}"]`).getAttribute('aria-expanded') === 'true', WS));
  await Mp.click(`#wsTree [data-wstog="${WS}"]`); await sleep(200);
  ok('A2 tree: workspace row collapses, focus stays on the row', await Mp.evaluate(WS => { const r = document.querySelector(`#wsTree [data-wstog="${WS}"]`);
    return r.getAttribute('aria-expanded') === 'false' && document.getElementById(r.getAttribute('aria-controls')).hidden && DB.ui.wsOpen?.[WS] === false && document.activeElement === r; }, WS));
  await Mp.evaluate(() => flushAll()); await Mp.reload(); await sleep(2200);
  ok('A2 tree: collapsed state kept after reload (personal pref)', await Mp.evaluate(WS => DB.ui.wsOpen?.[WS] === false
    && document.querySelector(`#wsTree [data-wstog="${WS}"]`).getAttribute('aria-expanded') === 'false', WS));
  ok('A2 tree: another user is not affected', await A.evaluate(WS => DB.ui.wsOpen?.[WS] !== false, WS));
  await Mp.click(`#wsTree [data-wstog="${WS}"]`); await sleep(200);

  // A2-2) 6 projeli alan: seçili + son kullanılan → 3 satır + "Tüm projeler (6)" → Projeler ekranında o alana odak
  await go(Mp, P6[4], 'board');
  const t2 = await Mp.evaluate(([WS2, P6]) => { const l = document.getElementById('nvp-' + WS2);
    return { rows: [...l.querySelectorAll('[data-proj]')].map(a => a.dataset.proj), all: l.querySelector(`[data-wsall="${WS2}"]`)?.textContent.trim(),
      cur: l.querySelector('[aria-current="page"]')?.dataset.proj }; }, [WS2, P6]);
  ok('A2: >5 projects → 3 rows (current included) + "Tüm projeler (6)"', t2.rows.length === 3 && t2.rows.includes(P6[4]) && t2.cur === P6[4] && t2.all === 'Tüm projeler (6)', JSON.stringify(t2));
  await Mp.click(`#wsTree [data-wsall="${WS2}"]`); await sleep(400);
  ok('A2: "Tüm projeler (n)" opens the workspace page (22b: Projeler menüde yok)', await Mp.evaluate(WS2 => DB.ui.view === 'workspace' && DB.ui.workspace === WS2
    && document.querySelectorAll(`[data-wspage="${WS2}"] [data-wsproj]`).length === 6 && !document.querySelector('#rail [data-v="projects"]'), WS2));
  /* genel ekrandayken hatırlanan proje kalın (zeminsiz); ağaçtan seçince Pano; proje ekranındayken aynı sekme */
  ok('A2: on a general screen the remembered project is bold, not current', await Mp.evaluate(P => { const a = document.querySelector(`#wsTree [data-proj="${P}"]`);
    return a.classList.contains('is-last') && !a.hasAttribute('aria-current'); }, P6[4]));
  await Mp.click(`#nvp-${WS2} [data-proj="${t2.rows.find(x => x !== P6[4])}"]`); await sleep(300);
  ok('A2: picking a project from a general screen opens Pano', await Mp.evaluate(() => DB.ui.view === 'board'));
  await go(Mp, P6[4], 'effort'); await Mp.click(`#nvp-${WS2} [data-proj="${t2.rows.find(x => x !== P6[4])}"]`); await sleep(300);
  ok('A2: picking a project on a project screen keeps the tab', await Mp.evaluate(() => DB.ui.view === 'effort'));

  // A2-3) Son kullanılanlar: son 5 proje (kişisel), sağa açılan menü, Esc odak geri
  for (const id of [P6[0], P6[1], P6[2], P6[3], P6[5], PX]) await go(Mp, id, 'board');
  await Mp.click('#rail [data-navrecent]'); await sleep(200);
  const t3 = await Mp.evaluate(() => { const m = document.getElementById('navPop'), b = document.querySelector('#rail [data-navrecent]');
    return { role: m?.getAttribute('role'), ids: [...m.querySelectorAll('[data-proj]')].map(x => x.dataset.proj), rec: DB.ui.recentProj, exp: b.getAttribute('aria-expanded'),
      right: m.getBoundingClientRect().left >= b.getBoundingClientRect().right, focus: !!document.activeElement.closest('#navPop') }; });
  ok('A2: Son kullanılanlar = last 5 projects (newest first), menu to the right', t3.role === 'menu' && t3.ids.length === 5 && t3.ids[0] === PX && t3.ids[1] === P6[5]
    && JSON.stringify(t3.rec) === JSON.stringify(t3.ids) && t3.exp === 'true' && t3.right && t3.focus, JSON.stringify(t3));
  await Mp.keyboard.press('ArrowDown'); await Mp.keyboard.press('Escape'); await sleep(100);
  ok('A2: Esc closes the menu, focus back to the button', await Mp.evaluate(() => !document.getElementById('navPop') && document.activeElement.matches('#rail [data-navrecent]')));
  await Mp.click('#rail [data-navrecent]'); await sleep(150); await Mp.click(`#navPop [data-proj="${P6[3]}"]`); await sleep(300);
  ok('A2: picking a recent project selects it', await Mp.evaluate(P => DB.ui.project === P && !document.getElementById('navPop') && DB.ui.recentProj[0] === P, P6[3]));

  // A2-4) başkası proje ekler / siler / üyelikten çıkarır → ≤4 sn (+ pay) güncellenir; aç/kapa bozulmaz
  await go(Mp, PX, 'board');
  await Mp.evaluate(WS2 => { wsOpenSet(WS2, false); save(); renderRail(); }, WS2); await sleep(200);        // 6 projeli alan kapalı
  const NP = 'p_nvnew' + RUN;
  await A.evaluate(async ([NP, WS, M, R]) => { const k = projCode('Yeni ' + R, new Set(DB.projects.map(x => x.code || x.key)));
    DB.projects.push({ id: NP, key: k, code: k, name: 'Sonradan ' + R, lead: SESSION, counter: 0, members: [SESSION, M], archived: false, workspaceId: WS }); save(); await flushAll(); }, [NP, WS, M, RUN]);
  const tAdd = await waitFor(Mp, NP => !!document.querySelector(`#wsTree [data-proj="${NP}"]`), NP, 9000);
  ok('A2: project added by someone else appears in the tree (poll)', tAdd >= 0 && tAdd <= 6000, tAdd + ' ms');
  ok('A2: open/closed state survives the poll redraw', await Mp.evaluate(WS2 => document.querySelector(`#wsTree [data-wstog="${WS2}"]`).getAttribute('aria-expanded') === 'false', WS2));
  await A.evaluate(async NP => { DB.projects = DB.projects.filter(p => p.id !== NP); save(); await flushAll(); }, NP);
  const tDel = await waitFor(Mp, NP => !document.querySelector(`#wsTree [data-proj="${NP}"]`), NP, 9000);
  ok('A2: project deleted by someone else leaves the tree (poll)', tDel >= 0 && tDel <= 6000, tDel + ' ms');
  await Mp.evaluate(WS2 => { wsOpenSet(WS2, true); save(); renderRail(); }, WS2); await sleep(200);
  await go(Mp, P6[5], 'board');
  await A.evaluate(async ([P, M]) => { const p = DB.projects.find(x => x.id === P); const r = { ...p.roles }; delete r[M]; p.roles = r; p.members = p.members.filter(x => x !== M); save(); await flushAll(); }, [P6[5], M]);
  const tOut = await waitFor(Mp, pid => DB.ui.project !== pid && !!P() && !document.querySelector(`#wsTree [data-proj="${pid}"]`), P6[5], 9000).catch(() => -1);
  ok('A2: removed from the current project → falls back to another project', tOut >= 0, tOut + ' ms');

  /* 22b: üyenin özelleştirme listesi: Projeler / Cariler / Kullanıcılar / Sistem yok */
  await go(Mp, PX, 'board');
  await Mp.click('#rail [data-navws]'); await sleep(150); await Mp.click('#navPop [data-navcz]'); await sleep(300);
  const mRows = await Mp.evaluate(() => [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).join());
  await Mp.keyboard.press('Escape'); await sleep(150);
  ok('A2 member: customize list without Projeler/Cariler/Kullanıcılar/Sistem', mRows === 'home,recent,ws,reports', mRows);
  // A2-5) Kenar çubuğunu özelleştir (22b: yönetici; üyede yalnız Son kullanılanlar + Raporlar): açıklama, sabit satırlar, taslak; Vazgeç / Esc atar
  await go(Dp, PX, 'board');
  await Dp.click('#rail [data-navws]'); await sleep(150); await Dp.click('#navPop [data-navcz]'); await sleep(300);
  const c1 = await Dp.evaluate(() => { const m = document.querySelector('#scrim .modal');
    return { role: m?.getAttribute('role'), lab: document.getElementById(m?.getAttribute('aria-labelledby'))?.textContent, p: m?.querySelector('.nv-czb > p')?.textContent,
      rows: [...m.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow), fixed: [...m.querySelectorAll('.nv-cz-r.fixed')].map(r => r.dataset.czrow + ':' + !r.querySelector('[data-czgrip]') + ':' + /Sabit/.test(r.textContent)),
      cnt: document.getElementById('cz_n').textContent, live: document.getElementById('cz_live')?.getAttribute('role') }; });
  ok('A2 customize: dialog, description, fixed rows (no grip, "Sabit"), admin list (no Projeler), Raporlar movable', c1.role === 'dialog' && c1.lab === 'Kenar çubuğunu özelleştir'
    && c1.p === 'Seçili öğeler kenar çubuğunda her zaman görünür; seçmediklerin "Daha fazla" menüsünde. Değişiklikler yalnız seni etkiler.'
    && c1.rows.join() === 'home,recent,ws,customers,reports,users,system' && c1.fixed.join() === 'home:true:true,ws:true:true' && c1.cnt === '7 öğe · 7 görünür' && c1.live === 'status', JSON.stringify(c1));
  await Dp.click('[data-czchk="customers"]'); await sleep(100);
  ok('A2 customize: draft only — rail unchanged before saving', await Dp.evaluate(() => !!document.querySelector('#rail [data-v="customers"]') && !DB.ui.nav
    && document.querySelector('[data-czchk="customers"]').getAttribute('aria-checked') === 'false' && /Daha fazla menüsünde/.test(document.querySelector('[data-czrow="customers"]').textContent)));
  await Dp.click('#scrim .m-f [data-close]'); await sleep(200);
  ok('A2 customize: Vazgeç discards', await Dp.evaluate(() => !document.getElementById('scrim').classList.contains('on') && !DB.ui.nav && !!document.querySelector('#rail [data-v="customers"]')));
  await Dp.click('#rail [data-navws]'); await sleep(150); await Dp.click('#navPop [data-navcz]'); await sleep(300);
  await Dp.click('[data-czchk="reports"]'); await Dp.keyboard.press('Escape'); await sleep(200);
  ok('A2 customize: Esc discards', await Dp.evaluate(() => !document.getElementById('scrim').classList.contains('on') && !DB.ui.nav));

  // A2-6) sırala: Alt+↑ tutamakta + duyuru; ⋯ → En üste taşı; gizle; Kaydet → kenar çubuğu, Daha fazla, adres çalışır, kalıcı
  await Dp.click('#rail [data-navws]'); await sleep(150); await Dp.click('#navPop [data-navcz]'); await sleep(300);
  await Dp.focus('[data-czgrip="reports"]'); await Dp.keyboard.press('Alt+ArrowUp'); await sleep(100);
  const c2 = await Dp.evaluate(() => ({ live: document.getElementById('cz_live').textContent, rows: [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).join(),
    f: document.activeElement.dataset.czgrip, lab: document.activeElement.getAttribute('aria-label') }));
  ok('A2 customize: Alt+↑ on the grip moves and announces ("Raporlar 4. sıraya taşındı")', c2.live === 'Raporlar 4. sıraya taşındı' && c2.rows === 'home,recent,ws,reports,customers,users,system'
    && c2.f === 'reports' && /4\. sırada/.test(c2.lab), JSON.stringify(c2));
  await Dp.click('[data-czmore="reports"]'); await sleep(150);
  const c3 = await Dp.evaluate(() => ({ role: document.getElementById('czPop')?.getAttribute('role'), items: [...document.querySelectorAll('#czPop [role="menuitem"]')].map(b => b.textContent.trim()),
    focus: !!document.activeElement.closest('#czPop') }));
  ok('A2 customize: ⋯ menu (Yukarı / Aşağı / En üste taşı)', c3.role === 'menu' && c3.items.join() === 'Yukarı taşı,Aşağı taşı,En üste taşı' && c3.focus, JSON.stringify(c3));
  await Dp.click('#czPop [data-czmv="top"]'); await sleep(100);
  ok('A2 customize: "En üste taşı" → 2nd place (fixed items stay), announced', await Dp.evaluate(() => document.getElementById('cz_live').textContent === 'Raporlar 2. sıraya taşındı'
    && [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).join() === 'home,reports,ws,recent,customers,users,system'));
  await Dp.click('[data-czchk="customers"]');
  await Dp.click('#cz_ok'); await sleep(300);
  const c4 = await railState(Dp);
  ok('A2 customize: saved → rail order, hidden item in "Daha fazla"', JSON.stringify(c4.nav) === JSON.stringify({ order: ['reports', 'recent', 'customers', 'users', 'system'], hidden: ['customers'] })
    && c4.items.join() === 'home,greports,recent,users,system' && c4.more && !(await Dp.evaluate(() => !!document.querySelector('#rail [data-v="customers"]'))), JSON.stringify(c4));
  await Dp.click('#navMore [data-navmore]'); await sleep(150);
  const c5 = await Dp.evaluate(() => ({ role: document.getElementById('navPop')?.getAttribute('role'), items: [...document.querySelectorAll('#navPop [role="menuitem"]')].map(b => b.textContent.trim()) }));
  ok('A2 "Daha fazla": menu with the hidden item + Kenar çubuğunu özelleştir', c5.role === 'menu' && c5.items.join() === 'Cariler,Kenar çubuğunu özelleştir', JSON.stringify(c5));
  await Dp.click('#navPop [data-v="customers"]'); await sleep(300);
  ok('A2 "Daha fazla": hidden screen opens', await Dp.evaluate(() => DB.ui.view === 'customers' && !document.getElementById('navPop')));
  await hash(Dp, 'home'); await hash(Dp, 'customers');
  ok('A2: hidden screen address still works', await Dp.evaluate(() => DB.ui.view === 'customers'));
  await Dp.keyboard.press('g'); await Dp.keyboard.press('h'); await sleep(250); await Dp.keyboard.press("g"); await Dp.keyboard.press("j"); await sleep(300);
  ok('A2: Projeler (menüde yok) shortcut g j still works for admin', await Dp.evaluate(() => DB.ui.view === 'projects'));
  await Dp.evaluate(() => flushAll()); await Dp.reload(); await sleep(2200);
  ok('A2 customize: kept after reload (user_prefs)', JSON.stringify((await railState(Dp)).items) === JSON.stringify(['home', 'greports', 'recent', 'users', 'system']));
  ok('A2 customize: personal — other users unchanged', await A.evaluate(() => !DB.ui.nav && !document.querySelector('#navMore [data-navmore]')));
  await Dp.click('#rail [data-navws]'); await sleep(150); await Dp.click('#navPop [data-navcz]'); await sleep(300);
  await Dp.click('#cz_reset'); await sleep(100);
  ok('A2 customize: Varsayılana dön resets the draft only', await Dp.evaluate(() => [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).join() === 'home,recent,ws,customers,reports,users,system'
    && document.querySelectorAll('[data-czchk][aria-checked="false"]').length === 0 && !!DB.ui.nav));
  await Dp.click('#cz_ok'); await sleep(300);
  const c6 = await railState(Dp);
  ok('A2 customize: default saved → nav removed, no "Daha fazla"', c6.nav === undefined && !c6.more && c6.items.join() === 'home,recent,customers,greports,users,system', JSON.stringify(c6));

  // A2-7) izleyici de özelleştirir ("+" yok, ⋯ var); yönetici Kullanıcılar/Sistem'i görür
  await go(Vp, PX, 'board');
  ok('A2 viewer: no "+" new workspace, ⋯ present', await Vp.evaluate(() => !document.querySelector('#rail [data-wsnew]') && !!document.querySelector('#rail [data-navws]')));
  await Vp.click('#rail [data-navws]'); await sleep(150); await Vp.click('#navPop [data-navcz]'); await sleep(300);
  await Vp.click('[data-czchk="reports"]'); await Vp.click('#cz_ok'); await sleep(300); await Vp.evaluate(() => flushAll()); await Vp.reload(); await sleep(2200);
  ok('A2 viewer: customizes and it persists', await Vp.evaluate(() => DB.ui.nav?.hidden?.join() === 'reports' && !document.querySelector('#rail [data-v="greports"]')
    && !!document.querySelector('#navMore [data-navmore]')));
  await Vp.evaluate(async () => { delete DB.ui.nav; save(); render(); await flushAll(); });
  await go(Dp, PX, 'board');
  await Dp.click('#rail [data-navws]'); await sleep(150); await Dp.click('#navPop [data-navcz]'); await sleep(300);
  const dRows = await Dp.evaluate(() => [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).join());
  await Dp.keyboard.press('Escape'); await sleep(150);
  ok('A2 admin: Kullanıcılar and Sistem in rail and in the customize list', dRows === 'home,recent,ws,customers,reports,users,system'
    && await Dp.evaluate(() => !!document.querySelector('#rail [data-v="users"]') && !!document.querySelector('#rail [data-v="system"]')), dRows);

  // A2-8) erişilebilirlik: açık ve koyu temada sol menü metinleri AA (≥4.5:1)
  const aa = p => p.evaluate(() => {
    const rgb = s => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
    const bgOf = el => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
      let out = { r: 255, g: 255, b: 255 }; for (const c of layers.reverse()) out = { r: c.r * c.a + out.r * (1 - c.a), g: c.g * c.a + out.g * (1 - c.a), b: c.b * c.a + out.b * (1 - c.a) }; return out; };
    const ratio = el => { const a = lum(rgb(getComputedStyle(el).color)), b = lum(bgOf(el)); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    const sels = ['.nv-item .tx', '.nv-sech .l', '.nv-ws .tx', '.nv-proj:not([aria-current]) .tx', '.nv-proj:not([aria-current]) .k', '.nv-proj[aria-current="page"] .tx', '.nv-proj.all .tx', '.nv-empty', '.nv-other .tx'];
    return sels.map(s => { const el = document.querySelector('#rail ' + s); return [s, el ? Math.round(ratio(el) * 100) / 100 : null]; });
  });
  await go(Mp, P6[0], 'board');
  const lightAA = await aa(Mp);
  await Mp.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(150);
  const darkAA = await aa(Mp);
  await Mp.screenshot({ path: SS + 'a2_dark.png' });
  await Mp.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  ok('A2 a11y: rail text contrast AA in light theme', lightAA.every(([, r]) => r === null || r >= 4.5) && lightAA.filter(([, r]) => r !== null).length >= 6, JSON.stringify(lightAA));
  ok('A2 a11y: rail text contrast AA in dark theme', darkAA.every(([, r]) => r === null || r >= 4.5) && darkAA.filter(([, r]) => r !== null).length >= 6, JSON.stringify(darkAA));
  ok('A2: no XSS from tree / menus', (await Promise.all([A, Mp, Vp, Dp].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));
  await Mp.screenshot({ path: SS + 'a2_tree.png' });

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
  await Mo.click('#projPick'); await sleep(400);
  ok('mobile: "Proje ▾" opens the ☰ drawer focused on the current project (A2)', await Mo.evaluate(PX => document.body.classList.contains('nav-open')
    && document.activeElement.matches(`#wsTree [data-proj="${PX}"][aria-current="page"]`), PX));
  await Mo.keyboard.press('Escape'); await sleep(300);
  await Mo.click('#navBtn'); await sleep(350);
  const dr = await Mo.evaluate(() => { const r = document.getElementById('rail').getBoundingClientRect();
    return { open: document.body.classList.contains('nav-open'), l: r.left, w: r.width, exp: document.getElementById('navBtn').getAttribute('aria-expanded'),
      scrim: !document.getElementById('navScrim').hidden, home: !!document.querySelector('#rail .nav a[data-v="home"]'), ws: !!document.querySelector('#rail #wsTree [data-wstog]'),
      plan: [...document.querySelectorAll('#rail .navgroup')].map(g => g.textContent.trim()), sw: document.documentElement.scrollWidth }; });
  ok('mobile ☰: drawer with the workspace tree (no Planlama/Takip)', dr.open && dr.l >= 0 && dr.w <= 375 && dr.exp === 'true' && dr.scrim && dr.home && dr.ws
    && !dr.plan.includes('Planlama') && !dr.plan.includes('Takip') && dr.sw <= 375, JSON.stringify(dr));
  await Mo.screenshot({ path: SS + 'm_drawer.png' });
  await Mo.keyboard.press('Escape'); await sleep(300);
  ok('mobile ☰: Esc closes, focus back to ☰', await Mo.evaluate(() => !document.body.classList.contains('nav-open') && document.activeElement.id === 'navBtn'));
  await Mo.click('#navBtn'); await sleep(350); await Mo.click('#rail .nav a[data-v="greports"]'); await sleep(400);
  ok('mobile ☰: picking a screen closes the drawer (general screen: no tabs)', await Mo.evaluate(() => DB.ui.view === 'greports' && !document.body.classList.contains('nav-open')
    && document.getElementById('tabbar').hidden));
  await Mo.click('#navBtn'); await sleep(350); await Mo.click('#navScrim', { position: { x: 360, y: 400 } }); await sleep(300);
  ok('mobile ☰: scrim click closes', await Mo.evaluate(() => !document.body.classList.contains('nav-open')));
  /* A2: çekmecede ağaç, ⋯ menüsü ve özelleştirme penceresi de çalışır; dokunma ≥44px, görünür alanda */
  await Mo.click('#navBtn'); await sleep(350);
  const mt = await Mo.evaluate(() => { const h = s => Math.min(...[...document.querySelectorAll(s)].map(x => x.getBoundingClientRect().height));
    return { ws: h('#rail .nv-ws'), proj: h('#rail .nv-proj'), item: h('#rail .nv-item'), ib: h('#rail .nv-ib') }; });
  ok('mobile ☰ (A2): tree rows and buttons ≥44px', Object.values(mt).every(v => v >= 44), JSON.stringify(mt));
  await Mo.click('#rail [data-navws]'); await sleep(200);
  const mp = await Mo.evaluate(() => { const r = document.getElementById('navPop')?.getBoundingClientRect();
    return r && { l: r.left, r: r.right, b: r.bottom, mi: Math.min(...[...document.querySelectorAll('#navPop .nv-mi')].map(x => x.getBoundingClientRect().height)) }; });
  ok('mobile ☰ (A2): ⋯ menu inside the viewport, items ≥44px', mp && mp.l >= 0 && mp.r <= 375 && mp.b <= 812 && mp.mi >= 44, JSON.stringify(mp));
  await Mo.click('#navPop [data-navcz]'); await sleep(350);
  const md = await Mo.evaluate(() => { const m = document.querySelector('#scrim.on .modal'), r = m?.getBoundingClientRect();
    return r && { l: r.left, r: r.right, drawer: document.body.classList.contains('nav-open'), sw: document.documentElement.scrollWidth,
      grip: Math.min(...[...m.querySelectorAll('.nv-grip, .nv-chk:not([aria-disabled]), .nv-cz-r .nv-ib')].map(x => x.getBoundingClientRect().height)) }; });
  ok('mobile (A2): customize dialog over a closed drawer, inside viewport, targets ≥44px', md && md.l >= 0 && md.r <= 375 && !md.drawer && md.sw <= 375 && md.grip >= 44, JSON.stringify(md));
  await Mo.screenshot({ path: SS + 'm_customize.png' });
  await Mo.keyboard.press('Escape'); await sleep(200);
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
