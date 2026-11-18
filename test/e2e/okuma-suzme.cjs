// Okuma süzmesi tarayıcı testi (18). Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri); test kendi kullanıcısını,
// alanını ve projesini oluşturur, sonunda temizler; diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: erişimi olmayan alanın projesi/işi/yorumu tarayıcıya hiç gelmez (ilk yükleme ve canlı akış), ekran hatasız açılır;
// alana eklenince sayfa yenilemeden (poll → yeniden yükleme) proje ve iş görünür; çıkarılınca kaybolur.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const X = 'u_osx' + R, WS = 'ws_os' + R, PID = 'p_os' + R, IID = 'i_os' + R, KEY = 'OS' + R.toUpperCase();

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async name => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw); await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) { await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800); }
  };
  const waitFor = async (p, fn, arg, ms = 10000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(250); } return false; };
  const sync = (p, changes) => p.evaluate(async ch => (await API.post('/api/sync', { changes: ch })), changes);
  const wsMembers = async (p, members) => sync(p, [{ c: 'workspaces', id: WS, op: 'put',
    data: { ...(await p.evaluate(async ws => (await API.get('/api/state')).data.workspaces.find(w => w.id === ws), WS)), members } }]);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  let r = await sync(A, [
    { c: 'users', id: X, op: 'put', data: { username: 'osx' + R, name: 'Os Dışarıda ' + R, role: 'member', active: true } },
    { c: 'workspaces', id: WS, op: 'put', data: { name: 'Gizli Alan ' + R, members: [{ userId: 'u_admin', role: 'admin' }] } },
    { c: 'projects', id: PID, op: 'put', data: { key: KEY, code: KEY, name: 'Gizli Proje ' + R, workspaceId: WS, counter: 0, members: [], archived: false, type: 'board' } },
    { c: 'statuses', id: PID + '_s0', op: 'put', data: { projectId: PID, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 } },
    { c: 'issues', id: IID, op: 'put', data: { projectId: PID, key: KEY + '-1', summary: 'Gizli iş ' + R, statusId: PID + '_s0', type: 'task' } },
    { c: 'comments', id: 'c_os' + R, op: 'put', data: { issueId: IID, body: 'gizli yorum ' + R } }]);
  ok('setup', r.rejected.length === 0, JSON.stringify(r.rejected));

  const P = await mk('outsider'); await login(P, 'osx' + R, 'Baslangic123', 'OkumaSuzme123');
  ok('outsider: hidden workspace/project/issue/comment not in client data', await P.evaluate(([pid, iid, ws]) =>
    !DB.projects.some(p => p.id === pid) && !DB.issues.some(i => i.id === iid) && !DB.comments.some(c => c.issueId === iid)
    && !DB.workspaces.some(w => w.id === ws), [PID, IID, WS]));
  ok('outsider: page source has no hidden text', !(await P.content()).includes('Gizli Proje ' + R));
  /* Canlı akış: yeni gizli iş gelmez. */
  await sync(A, [{ c: 'issues', id: IID + 'b', op: 'put', data: { projectId: PID, key: KEY + '-2', summary: 'Gizli iş 2 ' + R, statusId: PID + '_s0', type: 'task' } }]);
  await sleep(5000);
  ok('outsider: live poll does not deliver hidden issue', await P.evaluate(id => !DB.issues.some(i => i.id === id), IID + 'b'));
  /* Gezinme hatasız: pano, benim işlerim, raporlar. */
  for (const v of ['home', 'greports', 'board', 'timesheet', 'reports']) { await P.evaluate(v => { location.hash = v; }, v); await sleep(600); }

  /* Alana eklenince yenilemeden görünür. */
  r = await wsMembers(A, [{ userId: 'u_admin', role: 'admin' }, { userId: X, role: 'member' }]);
  ok('admin adds outsider to workspace', r.rejected.length === 0, JSON.stringify(r.rejected));
  ok('outsider: after being added, project + issue + comment arrive without page reload',
    await waitFor(P, ([pid, iid]) => DB.projects.some(p => p.id === pid) && DB.issues.some(i => i.id === iid) && DB.comments.some(c => c.issueId === iid), [PID, IID]));
  /* Çıkarılınca kaybolur. */
  r = await wsMembers(A, [{ userId: 'u_admin', role: 'admin' }]);
  ok('outsider: after removal, data disappears without page reload',
    await waitFor(P, ([pid, iid]) => !DB.projects.some(p => p.id === pid) && !DB.issues.some(i => i.id === iid) && !DB.comments.some(c => c.issueId === iid), [PID, IID]));
  await P.evaluate(() => { location.hash = 'board'; }); await sleep(800);

  /* temizlik */
  r = await sync(A, [{ c: 'issues', id: IID, op: 'del' }, { c: 'issues', id: IID + 'b', op: 'del' },
    { c: 'statuses', id: PID + '_s0', op: 'del' }, { c: 'projects', id: PID, op: 'del' }, { c: 'workspaces', id: WS, op: 'del' },
    { c: 'users', id: X, op: 'del' }]);
  ok('cleanup', r.rejected.length === 0, JSON.stringify(r.rejected));
  console.log(errs.join('\n') || 'no page errors / alerts');
  await b.close(); process.exit(FAILS || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
