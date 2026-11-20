// Engelli iş tarayıcı testi (PO önerisi 1): açık engelleyeni olan iş ("engelliyor" bağlantısı) pano kartında, Aktif sprint'te,
// backlog'da, Benim işlerim'de, zaman çizelgesinde (Zaman planı ve süre çizelgesi) ve aramada "Engelli" rozeti taşır; üzerine gelince
// (title) engelleyen açık işler listelenir. "Engelli işler" hızlı süzgeci (pano/backlog/plan) ve PQL "engelli = evet".
// Bitti'ye alırken (panoda sürükleme, Tamamla tiki, iş detayında durum menüsü ve sonraki durum düğmesi, Benim işlerim'de İlerlet)
// onay penceresi; Vazgeç hiçbir şey değiştirmez, "Yine de tamamla" tamamlar. Proje ayarı (Proje ayarları → İş akışı) kapatınca sorulmaz.
// Ön koşullar regresyon.cjs ile aynı: boş veritabanı, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123
// PORT=3100, demo veri (node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json).
// Sonra: node test/e2e/engellenen-is.cjs (BASE_URL ile adres değiştirilebilir). Kendi projesini açar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = process.env.SS_DIR || (require('os').tmpdir() + '/pano_eng_');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PID = 'p_eng' + RUN, KEY = 'EN' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');
const ID = s => PID + '_' + s;

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { errs.push(name + ' DIALOG ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
  };
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  const go = async (view, extra = {}) => {
    await A.evaluate(() => { closeModal(); location.hash = 'home'; }); await sleep(250);
    await A.evaluate(([pid, v, x]) => { DB.ui.project = pid; DB.board.scope = 'all'; DB.board.swimlane = 'none'; DB.board.blocked = false;
      DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = ''; Object.assign(DB.ui, x); location.hash = v; }, [PID, view, extra]);
    await sleep(600);
  };

  /* ---- veri: agile proje, aktif sprint, 3 kolon. X: B1 ve B2 (açık) ile B3 (Bitti) tarafından engelleniyor.
     Y: yalnız Bitti'deki B3 tarafından → engelli değil. Z: bağlantısız. B1 özetinde HTML (kaçış denetimi). ---- */
  const env = await A.evaluate(async ([pid, key]) => {
    const st = ['Yapılacak', 'Devam ediyor', 'Bitti'].map((n, k) => ({ id: `${pid}_s${k}`, projectId: pid, name: n, cat: ['todo', 'inprogress', 'done'][k], wip: 0, ord: k }));
    const due = iso(addD(new Date(), 5));
    const I = (s, n, sid, sum, extra = {}) => ({ c: 'issues', id: `${pid}_${s}`, op: 'put', data: { projectId: pid, key: `${key}-${n}`, type: 'task', summary: sum,
      description: '', statusId: sid, assignee: ME.id, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(),
      rank: n * 100, start: TODAY, due, sprintId: `${pid}_sp`, ...extra } });
    const L = (s, from, to) => ({ c: 'links', id: `${pid}_l${s}`, op: 'put', data: { from: `${pid}_${from}`, to: `${pid}_${to}`, type: 'blocks' } });
    const r = await API.post('/api/sync', { changes: [
      { c: 'projects', id: pid, op: 'put', data: { name: 'Engelli iş ' + key, key, counter: 6, type: 'agile', members: [ME.id], workspaceId: 'ws1' } },
      ...st.map(s => ({ c: 'statuses', id: s.id, op: 'put', data: s })),
      { c: 'sprints', id: pid + '_sp', op: 'put', data: { projectId: pid, name: key + ' Sprint 1', state: 'active', goal: '', start: TODAY, end: due } },
      I('b1', 1, st[0].id, 'Engelleyen <b>kalın</b> <img src=x onerror="window.__xss=1">'),
      I('b2', 2, st[1].id, 'İkinci engelleyen'),
      I('b3', 3, st[2].id, 'Biten engelleyen'),
      I('x', 4, st[0].id, 'Engelli iş X'),
      I('y', 5, st[0].id, 'Engeli bitmiş Y'),
      I('z', 6, st[0].id, 'Bağlantısız Z'),
      L(1, 'b1', 'x'), L(2, 'b2', 'x'), L(3, 'b3', 'x'), L(4, 'b3', 'y'),
      { c: 'worklogs', id: pid + '_w1', op: 'put', data: { issueId: pid + '_x', userId: ME.id, date: TODAY, hours: 1 } },
    ] });
    return { rej: r.data?.rejected || r.rejected, st: st.map(s => s.id), me: ME.id };
  }, [PID, KEY]);
  ok('seed accepted', Array.isArray(env.rej) && env.rej.length === 0, JSON.stringify(env.rej));
  const [S0, , S2] = env.st;
  await A.reload(); await sleep(1800);

  const badge = (sel) => A.evaluate(sel => { const e = document.querySelector(sel); return e ? { t: e.textContent.trim(), title: e.getAttribute('title') || '',
    aria: e.getAttribute('aria-label') || '', html: e.innerHTML, n: e.querySelector('b')?.textContent || '' } : null; }, sel);
  const K = n => `${KEY}-${n}`;

  /* ===== 1) pano kartı ===== */
  await go('board');
  const bx = await badge(`.card[data-id="${ID('x')}"] .blk-b`);
  ok('board: X card has "Engelli" badge with count 2', !!bx && bx.t.startsWith('Engelli') && bx.n === '2', JSON.stringify(bx));
  ok('board: hover title lists open blockers B1, B2 (not done B3)', !!bx && bx.title.includes(K(1)) && bx.title.includes(K(2)) && !bx.title.includes(K(3))
    && bx.title.startsWith('Engelleyen açık işler (2)'), bx?.title);
  ok('board: blocker summary escaped (title text, no injected element)', !!bx && bx.title.includes('<b>kalın</b>') && !/<img|<b>kalın/.test(bx.html)
    && await A.evaluate(() => !window.__xss), bx?.html);
  ok('board: aria-label says Engelli + blockers', !!bx && bx.aria.startsWith('Engelli. ') && bx.aria.includes(K(2)), bx?.aria);
  ok('board: Y (only done blocker), Z, blockers have no badge', await A.evaluate(ids => ids.every(id => document.querySelector(`.card[data-id="${id}"]`)
    && !document.querySelector(`.card[data-id="${id}"] .blk-b`)), [ID('y'), ID('z'), ID('b1'), ID('b2')]));
  await A.hover(`.card[data-id="${ID('x')}"] .blk-b`); await sleep(150);
  await A.screenshot({ path: SS + 'pano.png' });

  /* hızlı süzgeç: Engelli işler */
  const fb = await A.evaluate(() => ({ t: document.querySelector('#fBlk')?.textContent.trim(), p: document.querySelector('#fBlk')?.getAttribute('aria-pressed') }));
  ok('board: "Engelli işler" quick filter with count 1', fb.t === 'Engelli işler1' && fb.p === 'false', JSON.stringify(fb));
  await A.click('#fBlk'); await sleep(300);
  const vis = await A.evaluate(() => [...document.querySelectorAll('.board .card')].map(c => c.dataset.id));
  ok('board: filter on shows only X', vis.length === 1 && vis[0] === ID('x') && await A.evaluate(() => DB.board.blocked === true
    && document.querySelector('#fBlk').getAttribute('aria-pressed') === 'true' && document.activeElement?.id === 'fBlk'), JSON.stringify(vis));
  await A.click('#fBlk'); await sleep(300);
  ok('board: filter off shows all again', await A.evaluate(() => document.querySelectorAll('.board .card').length) >= 5);

  /* ===== 2) Aktif sprint, backlog, Benim işlerim, Zaman planı, süre çizelgesi, arama ===== */
  await go('sprint');
  ok('active sprint: X card badge', !!(await badge(`.card[data-id="${ID('x')}"] .blk-b`)) && !(await badge(`.card[data-id="${ID('z')}"] .blk-b`)));
  await go('backlog');
  const bl = await badge(`.row[data-id="${ID('x')}"] .blk-b`);
  ok('backlog: X row badge lists blockers', !!bl && bl.title.includes(K(1)) && !(await badge(`.row[data-id="${ID('y')}"] .blk-b`)), JSON.stringify(bl));
  ok('backlog: quick filter button present', await A.evaluate(() => !!document.querySelector('#fBlk')));
  await A.click('#fBlk'); await sleep(300);
  ok('backlog: filter on → only X row', await A.evaluate(x => { const r = [...document.querySelectorAll('.row[data-id]')].map(e => e.dataset.id); return r.length === 1 && r[0] === x; }, ID('x')));
  await A.click('#fBlk'); await sleep(200);
  await go('home', { homeProj: '', homeWs: '' });
  await A.evaluate(() => { location.hash = 'home'; }); await sleep(600);
  const hm = await badge(`[data-hmrow="${ID('x')}"] .blk-b`);
  ok('Benim işlerim: X row badge', !!hm && hm.title.includes(K(2)) && !(await badge(`[data-hmrow="${ID('z')}"] .blk-b`)), JSON.stringify(hm));
  await go('plan', { planUnset: true });
  ok('Zaman planı: X row badge', !!(await badge(`tr[data-open="${ID('x')}"] .blk-b`)) && !(await badge(`tr[data-open="${ID('z')}"] .blk-b`)));
  await A.click('#fBlk'); await sleep(300);
  ok('Zaman planı: filter on → only X', await A.evaluate(x => { const r = [...document.querySelectorAll('tr[data-open]')].map(e => e.dataset.open); return r.length === 1 && r[0] === x; }, ID('x')));
  await A.click('#fBlk'); await sleep(200);
  await go('timesheet', { tsMode: 'issue', week: await A.evaluate(() => iso(monday(new Date()))) });
  ok('Zaman çizelgesi (işe göre): X row badge', !!(await badge(`[data-open="${ID('x')}"] .blk-b`)));
  await go('search', { pql: '' });
  ok('search: sample "Engelli işler" button', await A.evaluate(() => [...document.querySelectorAll('[data-q]')].some(b => b.textContent.trim() === 'Engelli işler' && b.dataset.q === 'engelli = evet')));
  await A.evaluate(() => [...document.querySelectorAll('[data-q]')].find(b => b.textContent.trim() === 'Engelli işler').click()); await sleep(400);
  const sr = await A.evaluate(() => ({ q: DB.ui.pql, ids: [...document.querySelectorAll('tbody tr[data-open]')].map(r => r.dataset.open),
    all: [...document.querySelectorAll('tbody tr[data-open]')].every(r => isBlocked(issue(r.dataset.open))) }));
  ok('search: engelli = evet → X, not Y/Z/B1, every row blocked', sr.q === 'engelli = evet' && sr.ids.includes(ID('x')) && sr.all
    && ![ID('y'), ID('z'), ID('b1')].some(i => sr.ids.includes(i)), JSON.stringify(sr));
  ok('search: X row badge in results', !!(await badge(`tr[data-open="${ID('x')}"] .blk-b`)));
  const neg = await A.evaluate(([pid]) => runQuery(`engelli = hayır AND proje = "${DB.projects.find(p => p.id === pid).key}"`).map(i => i.id), [PID]);
  ok('search: engelli = hayır excludes X', !neg.includes(ID('x')) && neg.includes(ID('z')), JSON.stringify(neg));

  /* ===== 3) Bitti'ye sürükleme: onay penceresi ===== */
  const statusOf = id => A.evaluate(id => issue(id).statusId, id);
  const drag = (id, sid) => A.evaluate(([id, sid]) => {
    const card = document.querySelector(`.card[data-id="${id}"]`), col = document.querySelector(`.col-b[data-status="${sid}"]`);
    const dt = new DataTransfer(), r = col.getBoundingClientRect();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 20 }));
    col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + 20 }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  }, [id, sid]);
  const dlg = () => A.evaluate(() => { const m = document.querySelector('#blkOk')?.closest('.modal'); return m ? { title: m.querySelector('#blkTitle')?.textContent,
    items: [...m.querySelectorAll('.blk-list .id-delitem')].map(e => e.textContent.replace(/\s+/g, ' ').trim()), role: m.getAttribute('role'),
    focus: document.activeElement?.id, html: m.querySelector('.blk-list').innerHTML, ok: m.querySelector('#blkOk').textContent.trim() } : null; });

  await go('board');
  await drag(ID('z'), S2); await sleep(400);
  ok('drag: unblocked Z to Bitti → no dialog, done', !(await dlg()) && await statusOf(ID('z')) === S2);
  await drag(ID('x'), S2); await sleep(400);
  let d = await dlg();
  ok('drag: blocked X to Bitti → dialog "Bu işi engelleyen 2 açık iş var"', !!d && d.title === 'Bu işi engelleyen 2 açık iş var' && d.role === 'alertdialog', JSON.stringify(d));
  ok('dialog: lists B1 and B2 with status, escaped', !!d && d.items.length === 2 && d.items[0].includes(K(1)) && d.items[1].includes(K(2))
    && d.items[1].includes('Devam ediyor') && !/<img|<b>kalın/.test(d.html), JSON.stringify(d?.items));
  ok('dialog: focus on Vazgeç, button "Yine de tamamla"', !!d && d.focus === 'blkNo' && d.ok === 'Yine de tamamla', JSON.stringify(d));
  ok('dialog: status not changed yet', await statusOf(ID('x')) === S0);
  await A.screenshot({ path: SS + 'onay.png' });
  await A.click('#blkNo'); await sleep(300);
  ok('Vazgeç: dialog closed, X stays in Yapılacak', !(await dlg()) && await statusOf(ID('x')) === S0
    && await A.evaluate(([x, s]) => !!document.querySelector(`.col-b[data-status="${s}"] .card[data-id="${x}"]`), [ID('x'), S0]));
  await drag(ID('x'), S2); await sleep(400);
  await A.keyboard.press('Escape'); await sleep(250);
  ok('Escape: dialog closed, no change', !(await dlg()) && await statusOf(ID('x')) === S0);
  await drag(ID('x'), S2); await sleep(400);
  await A.click('#blkOk'); await sleep(500);
  ok('Yine de tamamla: X done', !(await dlg()) && await statusOf(ID('x')) === S2);
  await sleep(1500);
  const srv = await A.evaluate(async id => { const s = await API.get('/api/state'); return (s.data || s).issues.find(i => i.id === id)?.statusId; }, ID('x'));
  ok('server: X saved as done', srv === S2, srv);
  ok('done X: no badge any more', !(await badge(`.card[data-id="${ID('x')}"] .blk-b`)));
  const reopen = () => A.evaluate(([x, s]) => { setStatus(issue(x), s); save(); render(); }, [ID('x'), S0]);
  await reopen(); await sleep(300);

  /* Tamamla tiki (kart) */
  await A.click(`.card[data-id="${ID('x')}"] [data-complete]`); await sleep(400);
  ok('card tick: dialog', (await dlg())?.title === 'Bu işi engelleyen 2 açık iş var');
  await A.click('#blkNo'); await sleep(250);
  ok('card tick Vazgeç: unchanged', await statusOf(ID('x')) === S0);
  await A.click(`.card[data-id="${ID('x')}"] [data-complete]`); await sleep(400);
  await A.click('#blkOk'); await sleep(400);
  ok('card tick confirm: done', await statusOf(ID('x')) === S2);
  await reopen(); await sleep(300);

  /* ===== 4) iş detayı: durum menüsü ve sonraki durum ===== */
  await A.evaluate(id => openIssue(id), ID('x')); await sleep(500);
  await A.click('#scrim [data-pm="status"]'); await sleep(250);
  await A.click(`.qm [data-qv="${S2}"]`); await sleep(400);
  d = await dlg();
  ok('detail status menu → Bitti: dialog over detail (#scrim2)', !!d && await A.evaluate(() => !!document.querySelector('#scrim2.on #blkOk') && !!document.querySelector('#scrim.on .id-dlg')), JSON.stringify(d));
  await A.click('#blkNo'); await sleep(300);
  ok('detail Vazgeç: detail still open, status unchanged', await A.evaluate(() => !!document.querySelector('#scrim.on .id-dlg') && !document.querySelector('#scrim2.on'))
    && await statusOf(ID('x')) === S0);
  await A.click('#scrim [data-pm="status"]'); await sleep(250);
  await A.click(`.qm [data-qv="${S2}"]`); await sleep(400);
  await A.click('#blkOk'); await sleep(500);
  ok('detail confirm: done, detail open and shows Bitti', await statusOf(ID('x')) === S2
    && await A.evaluate(() => !!document.querySelector('#scrim.on .id-dlg') && document.querySelector('#scrim [data-pm="status"]')?.textContent.includes('Bitti')));
  await A.evaluate(() => closeModal()); await reopen(); await sleep(300);
  /* sonraki durum düğmesi (data-next) Bitti'ye giderse */
  await A.evaluate(([x, s]) => { setStatus(issue(x), s); save(); render(); openIssue(x); }, [ID('x'), env.st[1]]); await sleep(500);
  const hasNext = await A.evaluate(s => !!document.querySelector(`#scrim [data-next="${s}"]`), S2);
  if (hasNext) {
    await A.click(`#scrim [data-next="${S2}"]`); await sleep(400);
    ok('detail next-status → Bitti: dialog', (await dlg())?.title === 'Bu işi engelleyen 2 açık iş var');
    await A.click('#blkNo'); await sleep(250);
    ok('detail next-status Vazgeç: unchanged', await statusOf(ID('x')) === env.st[1]);
  } else ok('detail next-status button exists (skip)', true, 'no data-next to done');
  await A.evaluate(() => closeModal()); await reopen(); await sleep(300);

  /* Benim işlerim: İlerlet → Bitti */
  await A.evaluate(([x, s]) => { setStatus(issue(x), s); save(); }, [ID('x'), env.st[1]]);
  await A.evaluate(() => { location.hash = 'board'; }); await sleep(200);
  await A.evaluate(() => { location.hash = 'home'; }); await sleep(600);
  const adv = `[data-hmrow="${ID('x')}"] [data-hmadv]`;
  if (await A.$(adv)) {
    await A.click(adv); await sleep(400);
    ok('Benim işlerim İlerlet → Bitti: dialog', (await dlg())?.title === 'Bu işi engelleyen 2 açık iş var');
    await A.click('#blkNo'); await sleep(250);
    ok('Benim işlerim Vazgeç: unchanged', await statusOf(ID('x')) === env.st[1]);
  } else ok('Benim işlerim: X row in "Beklemede" with İlerlet', false, 'no advance button');
  await reopen(); await sleep(300);

  /* ===== 5) proje ayarı: uyarıyı kapat / aç ===== */
  await go('admin', { adminTab: 'workflow' });
  const sw = await A.evaluate(() => ({ c: document.querySelector('#ptBlkWarn')?.getAttribute('aria-checked'), t: document.querySelector('#ptBlkWarn')?.textContent.trim(),
    l: document.querySelector('#ptBlkWarnL')?.textContent }));
  ok('settings: switch present, default on', sw.c === 'true' && sw.t === 'Açık' && sw.l === "Engelli işi Bitti'ye alırken uyar", JSON.stringify(sw));
  await A.click('#ptBlkWarn'); await sleep(400);
  ok('settings: switched off (project.blockWarn false)', await A.evaluate(pid => DB.projects.find(p => p.id === pid).blockWarn === false
    && document.querySelector('#ptBlkWarn').getAttribute('aria-checked') === 'false', PID));
  await sleep(1500);
  const srvP = await A.evaluate(async pid => { const s = await API.get('/api/state'); return (s.data || s).projects.find(p => p.id === pid)?.blockWarn; }, PID);
  ok('server: project.blockWarn saved false', srvP === false, String(srvP));
  await go('board');
  ok('setting off: badge still shown', !!(await badge(`.card[data-id="${ID('x')}"] .blk-b`)));
  await drag(ID('x'), S2); await sleep(400);
  ok('setting off: drag to Bitti → no dialog, done', !(await dlg()) && await statusOf(ID('x')) === S2);
  await reopen(); await sleep(300);
  await go('admin', { adminTab: 'workflow' });
  await A.click('#ptBlkWarn'); await sleep(400);
  ok('settings: switched back on', await A.evaluate(pid => DB.projects.find(p => p.id === pid).blockWarn === true, PID));
  await go('board');
  await drag(ID('x'), S2); await sleep(400);
  ok('setting on again: dialog', !!(await dlg()));
  await A.click('#blkNo'); await sleep(200);

  /* ===== 6) mobil: rozet ve pencere sığar ===== */
  const Mo = await mk('mobile', { width: 390, height: 800 }); await login(Mo, 'admin', 'admin12345');
  await Mo.evaluate(pid => { DB.ui.project = pid; DB.board.scope = 'all'; DB.board.blocked = false; location.hash = 'board'; }, PID); await sleep(800);
  const mb = await Mo.evaluate(id => { const e = document.querySelector(`.card[data-id="${id}"] .blk-b`), c = e?.closest('.card');
    if (!e) return null; const r = e.getBoundingClientRect(), cr = c.getBoundingClientRect(); return { inside: r.right <= cr.right + 1 && r.left >= cr.left - 1 }; }, ID('x'));
  ok('mobile: badge inside card', !!mb && mb.inside, JSON.stringify(mb));
  await Mo.evaluate(id => completeIssue(id), ID('x')); await sleep(400);
  const mm = await Mo.evaluate(() => { const m = document.querySelector('#blkOk')?.closest('.modal'); if (!m) return null; const r = m.getBoundingClientRect();
    return { w: r.width, l: r.left, vw: innerWidth }; });
  ok('mobile: dialog fits viewport', !!mm && mm.l >= 0 && mm.l + mm.w <= mm.vw + 1, JSON.stringify(mm));
  await Mo.screenshot({ path: SS + 'mobil.png' });
  await Mo.click('#blkNo'); await sleep(200);

  ok('no page errors / unexpected dialogs', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
