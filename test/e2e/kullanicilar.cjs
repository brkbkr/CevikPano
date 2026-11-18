// Kullanıcılar ekranı tarayıcı testi. Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri).
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/', SS = require('os').tmpdir() + '/pano_u_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let F = 0; const ok = (n, c, x = '') => { if (!c) F++; console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' — ' + x : '')); };
(async () => {
  const b = await chromium.launch(); const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => { const ctx = await b.newContext({ viewport: vp }); const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' ' + e.message)); p.on('dialog', d => d.accept()); return p; };
  const login = async (p, u, pw) => { await p.goto(BASE); await p.waitForSelector('#lg_u'); await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500); };
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.click('.nav a[data-v="users"]'); await sleep(1500);
  ok('users view opens', (await A.textContent('#title')).includes('Kullanıcılar'));
  const rows = await A.$$eval('tr.urow', r => r.length); ok('lists users', rows >= 5, String(rows));
  await A.screenshot({ path: SS + 'list.png' });
  // yeni kullanıcı
  await A.click('#uAdd'); await sleep(400);
  await A.fill('#ue_n', 'Zeynep Kaya'); await A.fill('#ue_e', 'zeynep@firma.com'); await A.fill('#ue_t', 'Proje Yöneticisi');
  ok('username auto', (await A.inputValue('#ue_u')) === 'zeynep');
  await A.check('input[name="ue_r"][value="member"]');
  const pids = await A.$$eval('[data-up]', e => e.map(x => x.dataset.up));
  await A.uncheck(`[data-up="${pids[1]}"]`);
  await A.screenshot({ path: SS + 'new.png' });
  await A.click('#ue_ok'); await sleep(2500);
  const pw = await A.evaluate(() => document.querySelector('.pwline code')?.textContent);
  ok('generated password shown once', pw && pw.length >= 12, pw);
  await A.screenshot({ path: SS + 'cred.png' });
  await A.click('[data-close]'); await sleep(300);
  const z = await A.evaluate(() => { const u = DB.users.find(x => x.username === 'zeynep'); return u && { email: u.email, title: u.title, role: u.role, inP1: DB.projects[0].members.includes(u.id), inP2: DB.projects[1].members.includes(u.id) }; });
  ok('user saved with profile & memberships', z && z.email === 'zeynep@firma.com' && z.role === 'member' && z.inP1 && !z.inP2, JSON.stringify(z));
  // yeni kullanıcı girişi
  const Z = await mk('zeynep'); await login(Z, 'zeynep', pw);
  ok('new user forced to set password', await Z.isVisible('#fp_a'));
  await Z.fill('#fp_a', 'ZeynepYeni12'); await Z.fill('#fp_b', 'ZeynepYeni12'); await Z.click('#fpForm button[type=submit]'); await sleep(2000);
  /* sol menü ağacı (dilim A2): görünen projeler yalnız üyesi olduğu proje */
  ok('new user sees only member projects', await Z.evaluate(() => document.querySelectorAll('#wsTree [data-proj]').length) === 1);
  ok('member sees no data tools', await Z.evaluate(() => {
    const foot = document.querySelector('.rail-foot');
    const visible = foot && getComputedStyle(foot).display !== 'none';
    location.hash = 'system';
    return !visible && !document.querySelector('a[data-v="system"]:not([style*="none"])');
  }));
  await sleep(300);
  ok('member cannot open system view', await Z.evaluate(() => DB.ui.view !== 'system'));
  // admin: rolü izleyici yap
  await A.evaluate(() => { location.hash = 'home'; }); await sleep(300); await A.evaluate(() => { location.hash = 'users'; }); await sleep(1200);
  await A.click(`tr.urow[data-uedit="${await A.evaluate(() => DB.users.find(x => x.username === 'zeynep').id)}"]`); await sleep(500);
  await A.screenshot({ path: SS + 'edit.png' });
  await A.check('input[name="ue_r"][value="viewer"]'); await A.click('#ue_ok'); await sleep(2000);
  await sleep(5000);
  ok('role change reaches user live', await Z.evaluate(() => CU().role) === 'viewer');
  // parola üret
  const zid = await A.evaluate(() => DB.users.find(x => x.username === 'zeynep').id);
  await A.click(`tr.urow[data-uedit="${zid}"]`); await sleep(500);
  await A.click('#ue_gen'); await sleep(1500);
  const pw2 = await A.textContent('#ue_pwtxt'); ok('regenerated password', pw2 && pw2 !== pw);
  await sleep(4500);
  ok('old session closed after reset', await Z.isVisible('#lg_u'));
  // pasifleştir
  await A.click('#ue_toggle'); await sleep(2000);
  const st = await A.evaluate(id => fetch('/api/admin/users').then(r => r.json()).then(l => l.find(x => x.id === id)), zid);
  ok('deactivated', await A.evaluate(id => user(id).active === false, zid));
  const Z2 = await mk('zeynep2'); await login(Z2, 'zeynep', pw2);
  ok('inactive user cannot log in', await Z2.isVisible('#lg_u') && (await Z2.textContent('#lg_err')).length > 0);
  // sil
  await A.click(`tr.urow[data-uedit="${zid}"]`); await sleep(500); await A.click('#ue_del'); await sleep(2000);
  ok('deleted', await A.evaluate(id => !user(id), zid));
  // kendini koru
  await A.click(`tr.urow[data-uedit="u_admin"]`); await sleep(500);
  ok('self role locked, no delete', await A.evaluate(() => [...document.querySelectorAll('input[name="ue_r"]')].every(r => r.disabled) && !document.getElementById('ue_del')));
  await A.click('[data-close]');
  // mobil
  const M = await mk('mobile', { width: 390, height: 844 }); await login(M, 'admin', 'admin12345');
  await M.evaluate(() => { location.hash = 'users'; }); await sleep(1500);
  ok('mobile no horizontal overflow', await M.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await M.screenshot({ path: SS + 'mobile.png' });
  console.log(errs.join('\n') || 'no page errors'); await b.close(); process.exit(F || errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
