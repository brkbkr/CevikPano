// Tarayıcı regresyon testi (QA bulguları). Çalıştırmadan önce: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/regresyon.cjs  (BASE_URL ile adres değiştirilebilir)
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_q_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1400, height: 850 }) => {
    const ctx = await b.newContext({ viewport: vp });
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
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  // 1) zorunlu parola: Esc ile atlanamaz, API kapalı
  const B = await mk('adem'); await login(B, 'adem', 'Baslangic123');
  ok('forced pw screen shown', await B.isVisible('#fp_a'));
  await B.keyboard.press('Escape'); await sleep(300);
  ok('forced pw not skippable by Esc', await B.isVisible('#fp_a'));
  const st = await B.evaluate(() => fetch('/api/state').then(r => r.status));
  ok('state blocked before pw change', st === 403, 'status ' + st);
  await B.fill('#fp_a', 'AdemYeni123'); await B.fill('#fp_b', 'AdemYeni123'); await B.click('#fpForm button[type=submit]'); await sleep(2000);
  ok('app opens after pw change', await B.evaluate(() => !!DB && DB.issues.length > 0));

  // 2) XSS: kullanıcı ini, iş key
  const x = await B.evaluate(async () => {
    const r1 = await API.post('/api/sync', { changes: [{ c: 'users', id: ME.id, op: 'put', data: { ...user(ME.id), ini: '<img src=x onerror=alert(1)>' } }] });
    const r2 = await API.post('/api/sync', { changes: [{ c: 'issues', id: 'i_xss', op: 'put', data: { projectId: 'p1', key: '<img src=x onerror=alert(2)>', summary: '<img src=x onerror=alert(3)>' } }] });
    return [r1.rejected.length, r2.rejected.length];
  });
  ok('xss payloads rejected by server', x[0] === 1 && x[1] === 1, JSON.stringify(x));
  await B.evaluate(() => { DB.issues[0].summary = '<img src=x onerror=alert(4)>'; save(); }); await sleep(1500);
  await A.evaluate(() => { location.hash = 'board'; }); await sleep(5000);

  // 3) eşzamanlı iş açma: farklı numara
  const mkIssue = p => p.evaluate(() => {
    const pr = DB.projects.find(x => x.id === 'p1');
    const it = { id: uid('i'), projectId: 'p1', key: `${pr.key}-${++pr.counter}`, type: 'task', summary: 'eşzamanlı',
      statusId: stats()[0]?.id || DB.statuses.find(s => s.projectId === 'p1').id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: 1 };
    DB.issues.push(it); save(); return it.id;
  });
  const [ia, ib] = await Promise.all([mkIssue(A), mkIssue(B)]);
  await sleep(6000);
  const keys = await A.evaluate(([a, b]) => [issue(a)?.key, issue(b)?.key], [ia, ib]);
  ok('concurrent issue keys unique', keys[0] && keys[1] && keys[0] !== keys[1], keys.join(' / '));

  // 4) açık pencere: B öncelik değiştirir, A açık pencerede tip değiştirir → ikisi de kalır
  const target = await A.evaluate(() => DB.issues.find(i => i.type === 'task' && i.projectId === 'p1').id);
  await A.evaluate(id => openIssue(id), target); await sleep(400);
  await B.evaluate(id => { const i = issue(id); i.priority = 1; save(); }, target); await sleep(5500);
  await A.evaluate(id => { const i = issue(id); i.type = 'bug'; save(); }, target); await sleep(2500);
  const both = await B.evaluate(async id => { const r = await API.get('/api/state'); const i = r.data.issues.find(x => x.id === id); return [i.priority, i.type]; }, target);
  ok('open modal edit + remote edit both kept', both[0] === 1 && both[1] === 'bug', JSON.stringify(both));

  // 5) eşzamanlı süre kaydı → spent doğru
  const wl = (p, h) => p.evaluate(([id, h]) => { DB.worklogs.push({ id: uid('w'), issueId: id, userId: ME.id, date: TODAY, hours: h, comment: 'x' });
    const i = issue(id); i.spent = (i.spent || 0) + h; save(); }, [target, h]);
  await Promise.all([wl(A, 1), wl(B, 2)]); await sleep(6000);
  const sp = await A.evaluate(async id => { const r = await API.get('/api/state'); const i = r.data.issues.find(x => x.id === id);
    const sum = r.data.worklogs.filter(w => w.issueId === id).reduce((a, w) => a + w.hours, 0); return [i.spent, sum]; }, target);
  ok('spent equals worklog sum', sp[0] === sp[1], JSON.stringify(sp));

  // 6) üye başkasının süre kaydını silemez (UI'da buton yok)
  await B.evaluate(() => { location.hash = 'timesheet'; }); await sleep(800);
  const foreignDel = await B.evaluate(() => [...document.querySelectorAll('[data-delwl]')].filter(b => DB.worklogs.find(w => w.id === b.dataset.delwl)?.userId !== ME.id).length);
  ok('no delete button on others worklogs', foreignDel === 0, String(foreignDel));

  // 7) Ctrl+S dosya seçici açmaz
  await A.evaluate(() => { window.__picker = 0; window.showSaveFilePicker = () => { window.__picker++; return Promise.reject(); }; });
  await A.keyboard.press('Control+s'); await sleep(500);
  ok('ctrl+s no file picker', await A.evaluate(() => window.__picker === 0));

  // 8) iş silme: yetim kalmaz, açık penceresi olan kişiye haber
  await B.evaluate(id => openIssue(id), target); await sleep(300);
  await A.evaluate(id => { DB.issues = DB.issues.filter(x => x.id !== id); DB.worklogs = DB.worklogs.filter(x => x.issueId !== id); DB.comments = DB.comments.filter(x => x.issueId !== id); closeModal(); save(); }, target);
  await sleep(6000);
  ok('deleted issue closes modal for other user', await B.evaluate(() => !document.getElementById('scrim').classList.contains('on')));
  const orphans = await A.evaluate(async id => { const r = await API.get('/api/state'); return ['history', 'transitions', 'links', 'worklogs', 'comments']
    .map(k => r.data[k].filter(x => x.issueId === id || x.from === id || x.to === id).length).reduce((a, b) => a + b, 0); }, target);
  ok('no orphan records', orphans === 0, String(orphans));

  // 9) izleyici c/w kısayolu açmaz
  await A.evaluate(async () => { await API.post('/api/sync', { changes: [{ c: 'users', id: 'u_v1', op: 'put', data: { username: 'izl', name: 'İzleyici', role: 'viewer', active: true, ini: 'İZ', color: '#64748B' } }] }); });
  const V = await mk('viewer'); await login(V, 'izl', 'Baslangic123');
  await V.fill('#fp_a', 'IzlYeni1234'); await V.fill('#fp_b', 'IzlYeni1234'); await V.click('#fpForm button[type=submit]'); await sleep(1800);
  await V.keyboard.press('c'); await sleep(300); const c1 = await V.evaluate(() => document.getElementById('scrim').classList.contains('on'));
  await V.keyboard.press('w'); await sleep(300); const c2 = await V.evaluate(() => document.getElementById('scrim').classList.contains('on'));
  ok('viewer shortcuts blocked', !c1 && !c2);

  // 10) oturum düşünce değişiklik kaybolmaz
  await B.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-pano': '1' } }); });
  await B.evaluate(() => { DB.issues[1].summary = 'Oturum düşerken yazıldı'; save(); }); await sleep(1500);
  ok('login shown after session loss', await B.isVisible('#lg_u'));
  await B.fill('#lg_u', 'adem'); await B.fill('#lg_p', 'AdemYeni123'); await B.click('#lgForm button[type=submit]'); await sleep(2000);
  const kept = await B.evaluate(async () => { const r = await API.get('/api/state'); return r.data.issues.some(i => i.summary === 'Oturum düşerken yazıldı'); });
  ok('unsynced change survives re-login', kept);

  // 11) süper yönetici: tek admin'i üyeye düşürebilir
  const demote = await A.evaluate(async () => { const r = await API.post('/api/sync', { changes: [{ c: 'users', id: 'u1', op: 'put', data: { ...user('u1'), role: 'member' } }] }); return r.rejected.length; });
  ok('super can demote only admin', demote === 0);

  // 12) mobil: iş penceresi taşmıyor, hesap menüsünde çıkış var
  const M = await mk('mobile', { width: 390, height: 844 }); await login(M, 'admin', 'admin12345');
  await M.evaluate(() => { location.hash = 'board'; }); await sleep(700);
  await M.click('.card'); await sleep(600);
  const ov = await M.evaluate(() => { const m = document.querySelector('.modal'); return m.scrollWidth - m.clientWidth; });
  ok('mobile modal no horizontal overflow', ov <= 1, String(ov));
  await M.screenshot({ path: SS + 'm_issue.png' });
  await M.evaluate(() => closeModal());
  await M.click('#acctBtn'); await sleep(400);
  ok('mobile account menu has logout', await M.isVisible('#acctMenu [data-act="logout"]'));
  await M.screenshot({ path: SS + 'm_menu.png' });

  // 13) silinmiş duruma bağlı iş çökertmiyor
  await A.evaluate(() => { DB.issues[2].statusId = 'yok_boyle_durum'; render(); location.hash = 'home'; }); await sleep(600);
  await A.evaluate(() => { location.hash = 'search'; }); await sleep(600);

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
