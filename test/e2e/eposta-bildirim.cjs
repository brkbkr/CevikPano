// E-posta bildirimleri tarayıcı testi (hesap menüsü → Bildirimler, Sistem → Posta kutuları → Bildirim gönderici, e-postadaki iş bağlantısı).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın (posta değişkenleri OLMADAN) ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/eposta-bildirim.cjs  (BASE_URL ile adres değiştirilebilir; SHOT ile ekran görüntüsü yolu).
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_epb_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const M = 'u_epb' + RUN, MU = 'epb' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1400, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ' CONSOLE ' + m.text()); });
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw, url = BASE) => {
    await p.goto(url); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) {
      await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800);
    }
  };
  const txt = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);
  const openPrefs = async p => {
    await p.evaluate(() => closeModal());
    await p.click('#acctBtn'); await sleep(150);
    await p.click('#acctMenu [data-acct="notif"]');
    await p.waitForSelector('#npBody [data-np]', { timeout: 5000 }); await sleep(150);
  };
  const boxes = p => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('#npBody [data-np]')].map(x => [x.dataset.np, x.checked])));

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([M, MU]) => {
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: MU, name: 'Bildirim Üye', role: 'member', active: true, ini: 'BÜ', color: '#0F766E', email: MU + '@ornek.test' } },
    ] });
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
  }, [M, MU]);

  /* ---- 1) hesap menüsünde "Bildirimler"; varsayılanlar; kapalı sunucu açıklaması ---- */
  await A.click('#acctBtn'); await sleep(150);
  const mi = await A.evaluate(() => [...document.querySelectorAll('#acctMenu .nv-mi')].map(x => x.dataset.act || x.dataset.acct || x.dataset.v));
  ok('hesap menüsünde "Bildirimler" (tema ile kısayollar arasında)', mi.indexOf('notif') === mi.indexOf('theme') + 1 && mi.indexOf('keys') === mi.indexOf('notif') + 1, mi.join());
  await A.keyboard.press('Escape'); await sleep(100);
  await openPrefs(A);
  ok('pencere: başlık "Bildirimler", menü kapandı', /Bildirimler/.test(await txt(A, '#npTitle')) && !(await A.$('#acctMenu')));
  ok('varsayılan: atama ve bahsetme açık, diğerleri ve sabah özeti kapalı', JSON.stringify(await boxes(A))
    === JSON.stringify({ assigned: true, comment: false, mention: true, status: false, due: false, digest: false }), JSON.stringify(await boxes(A)));
  ok('posta yapılandırılmamış sunucu: "kapalı" açıklaması', /bu sunucuda kapalı/.test(await txt(A, '#npBody .np-off')), await txt(A, '#npBody'));
  ok('sabah özeti açıklaması (08:30, iş günü)', /Her iş günü 08:30/.test(await txt(A, '#npBody')));
  await A.screenshot({ path: SS + '1_tercihler.png' });

  /* ---- 2) kaydet → kalıcı (sunucuda) ---- */
  await A.check('#npBody [data-np="digest"]'); await A.check('#npBody [data-np="due"]'); await A.uncheck('#npBody [data-np="mention"]');
  await A.click('#np_ok'); await sleep(500);
  ok('kaydet: pencere kapanır, bilgi', !(await A.$('#npBody')) && /Bildirim tercihleri kaydedildi/.test(await txt(A, '#toast')));
  const sv = await A.evaluate(() => API.get('/api/notify/prefs'));
  ok('sunucuda saklandı', sv.prefs.digest === true && sv.prefs.due === true && sv.prefs.mention === false && sv.prefs.assigned === true, JSON.stringify(sv.prefs));
  await A.reload(); await sleep(1500);
  await openPrefs(A);
  const bx = await boxes(A);
  ok('yeniden açınca tercihler gelir', bx.digest && bx.due && !bx.mention && bx.assigned, JSON.stringify(bx));
  ok('tercih DB/senkron verisine girmez', await A.evaluate(() => DB.notif === undefined));
  /* Vazgeç: değişiklik gitmez */
  await A.uncheck('#npBody [data-np="digest"]');
  await A.click('#scrim .m-f [data-close]'); await sleep(300);
  ok('vazgeç: kaydedilmez', (await A.evaluate(() => API.get('/api/notify/prefs'))).prefs.digest === true);
  await A.evaluate(() => API.post('/api/notify/prefs', { digest: false, due: false, mention: true }));

  /* ---- 3) etkin durum (taklit): adres esc() ile basılır ---- */
  await A.route('**/api/notify/prefs', r => r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: { assigned: true, mention: true }, email: 'x' + XSS + '@ornek.test', available: true, reason: '' }) })
    : r.continue());
  await openPrefs(A);
  ok('etkin: "adresine gider" + birleştirme açıklaması', /adresine gider/.test(await txt(A, '#npBody .np-ok')) && /tek e-postada birleştirilir/.test(await txt(A, '#npBody .np-ok')));
  ok('adres HTML olarak basılmaz (XSS yok)', !(await A.evaluate(() => window.__xss)) && !(await A.$('#npBody img')) && /onerror/.test(await txt(A, '#npBody .np-ok')));
  await A.unroute('**/api/notify/prefs');
  await A.route('**/api/notify/prefs', r => r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: {}, email: '', available: false, reason: 'noemail' }) }) : r.continue());
  await openPrefs(A);
  ok('e-postası olmayan hesap: açıklama', /e-posta adresi tanımlı değil/.test(await txt(A, '#npBody .np-off')));
  await A.unroute('**/api/notify/prefs');
  await A.evaluate(() => closeModal());

  /* ---- 4) Sistem → Posta kutuları: Bildirim gönderici seçimi (taklit) ---- */
  const now = new Date().toISOString();
  const FAKE = { configured: true, providers: { google: true, microsoft: true }, polling: true, pollSec: 120, redirect: {}, rules: [],
    accounts: [
      { id: 'mb_g1', provider: 'google', address: 'destek@ornek.test', defaultProjectId: null, active: true, status: 'ok', lastPollAt: now, lastError: null, backoffUntil: null, createdAt: now, notifySender: true },
      { id: 'mb_m1', provider: 'microsoft', address: 'x' + XSS + '@ornek.test', defaultProjectId: null, active: true, status: 'ok', lastPollAt: now, lastError: null, backoffUntil: null, createdAt: now, notifySender: false },
    ] };
  let posted = null;
  await A.route('**/api/mail/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }));
  await A.route('**/api/mail/accounts/**', r => { posted = { url: r.request().url(), body: JSON.parse(r.request().postData() || '{}') };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...FAKE.accounts[1], notifySender: true }) }); });
  await A.evaluate(() => { DB.ui.view = 'system'; SYS_TAB = 'mail'; render(); });
  await A.waitForSelector('[data-mbnotify]', { timeout: 5000 }); await sleep(200);
  ok('kutu satırında "Bildirim gönderici" seçimi; seçili kutu işaretli', await A.evaluate(() =>
    document.querySelector('[data-mbnotify="mb_g1"]').checked && !document.querySelector('[data-mbnotify="mb_m1"]').checked));
  ok('açıklama: bildirimler seçili kutudan gönderilir', /destek@ornek\.test kutusundan gönderilir/.test(await txt(A, '.mb-notify')), await txt(A, '.mb-notify'));
  ok('tablo başlığında "Bildirimler" sütunu', await A.evaluate(() => [...document.querySelectorAll('.mb-tbl thead th')].some(th => th.textContent === 'Bildirimler')));
  await A.screenshot({ path: SS + '2_gonderici.png', fullPage: true });
  await A.check('[data-mbnotify="mb_m1"]'); await sleep(500);
  ok('başka kutu seçilince sunucuya { notifySender: true }', posted && /\/api\/mail\/accounts\/mb_m1$/.test(posted.url) && posted.body.notifySender === true, JSON.stringify(posted));
  ok('XSS yok (adres esc)', !(await A.evaluate(() => window.__xss)) && !(await A.$('.mb-tbl img')));
  FAKE.accounts.forEach(a => { a.notifySender = false; });
  await A.evaluate(() => loadSystem()); await sleep(500);
  ok('gönderici yokken açıklama: "E-posta bildirimleri kapalı"', /E-posta bildirimleri kapalı/.test(await txt(A, '.mb-notify')));
  await A.unroute('**/api/mail/status'); await A.unroute('**/api/mail/accounts/**');

  /* ---- 5) e-postadaki bağlantı: /?is=ANAHTAR işi açar; bilinmeyen anahtar bilgi verir ---- */
  const key = await A.evaluate(() => DB.issues.find(i => i.key && i.type !== 'epic')?.key);
  await A.goto(BASE + '?is=' + encodeURIComponent(key)); await sleep(1800);
  ok('?is=ANAHTAR → iş penceresi açılır, adres temizlenir', await A.evaluate(k => OPEN_ISSUE && issue(OPEN_ISSUE)?.key === k && !location.search, key), key);
  await A.goto(BASE + '?is=' + encodeURIComponent('YOK-99999')); await sleep(1800);
  ok('bilinmeyen anahtar → bilgi, pencere açılmaz', !(await A.evaluate(() => OPEN_ISSUE)) && /İş bulunamadı/.test(await txt(A, '#toast')));

  /* ---- 6) üye: kendi tercihini kaydeder; mobilde pencere sığar ---- */
  const U = await mk('uye');
  await login(U, MU, 'Baslangic123', 'EpbYeni12345');
  await openPrefs(U);
  ok('üye: varsayılanlar', JSON.stringify(await boxes(U)) === JSON.stringify({ assigned: true, comment: false, mention: true, status: false, due: false, digest: false }));
  await U.check('#npBody [data-np="status"]'); await U.click('#np_ok'); await sleep(500);
  ok('üye: kaydedildi, yöneticininki değişmedi', (await U.evaluate(() => API.get('/api/notify/prefs'))).prefs.status === true
    && (await A.evaluate(() => API.get('/api/notify/prefs'))).prefs.status === false);
  const mob = await mk('mobil', { width: 390, height: 780 });
  await login(mob, MU, 'EpbYeni12345');
  await openPrefs(mob);
  const fit = await mob.evaluate(() => { const m = document.querySelector('#scrim .modal').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; });
  ok('mobil: pencere ekrana sığar', fit);
  await mob.screenshot({ path: SS + '3_mobil.png' });

  ok('sayfa hatası yok', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
