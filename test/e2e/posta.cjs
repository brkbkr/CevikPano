// Posta kutuları tarayıcı testi (görev 11, E2).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın (posta değişkenleri OLMADAN) ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/posta.cjs  (BASE_URL ile adres değiştirilebilir).
// 1) Gerçek sunucu: "Sunucu yapılandırılmamış", bağla düğmeleri kapalı. 2) /api/mail/status taklit edilir: bağlı kutu
// listesi, "Yeniden bağlanın" durumu, kurallar; adres/hata metni HTML olarak basılmaz. 3) Üye Sistem ekranını görmez, uç 403.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_mb_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PT = 'p_mb' + RUN, M = 'u_mbm' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
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
  const txt = (p, sel) => p.evaluate(s => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);
  const openMail = async p => {
    await p.evaluate(() => { closeModal(); DB.ui.view = 'system'; SYS_TAB = 'mail'; render(); });
    await p.waitForSelector('#sysBody h3', { timeout: 5000 }); await sleep(300);
  };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* kurulum: talep projesi + üye */
  await A.evaluate(async ([R, PT, M]) => {
    const ws = DB.workspaces[0]?.id || 'ws1';
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'mbm' + R, name: 'Posta Üye ' + R, role: 'member', active: true, ini: 'PÜ', color: '#0F766E' } },
      { c: 'projects', id: PT, op: 'put', data: { name: 'Posta destek ' + R, key: 'MB' + R.toUpperCase().replace(/[^A-Z0-9]/g, ''), counter: 0, workspaceId: ws, template: 'talep', type: 'board' } },
      { c: 'statuses', id: PT + '_s0', op: 'put', data: { projectId: PT, name: 'Yeni', cat: 'todo', ord: 0 } },
    ] });
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
    await reloadState();
  }, [RUN, PT, M]);

  /* ---- 1) yapılandırılmamış sunucu ---- */
  await openMail(A);
  ok('Sistem ekranında "Posta kutuları" sekmesi', await A.isVisible('[data-systab="mail"].on'));
  ok('"Sunucu yapılandırılmamış" bilgisi', /Sunucu yapılandırılmamış/.test(await txt(A, '.mb-nocfg')), await txt(A, '#sysBody'));
  ok('Gmail / Outlook bağla düğmeleri kapalı', await A.evaluate(() =>
    [...document.querySelectorAll('[data-mbconnect]')].length === 2 && [...document.querySelectorAll('[data-mbconnect]')].every(b => b.disabled)));
  ok('boş liste ve kural yok metni', /Bağlı posta kutusu yok/.test(await txt(A, '#sysBody')) && /Kural yok/.test(await txt(A, '#sysBody')));
  await A.screenshot({ path: SS + '1_yapilandirilmamis.png' });

  /* ---- 2) taklit edilmiş bağlı kutular ---- */
  const now = new Date().toISOString();
  const FAKE = {
    configured: true, providers: { google: true, microsoft: true }, polling: true, pollSec: 120, redirect: {},
    accounts: [
      { id: 'mb_g1', provider: 'google', address: 'destek@ornek.test', defaultProjectId: PT, active: true, status: 'ok', lastPollAt: now, lastError: null, backoffUntil: null, createdAt: now },
      { id: 'mb_m1', provider: 'microsoft', address: 'x' + XSS + '@ornek.test', defaultProjectId: null, active: true, status: 'reconnect', lastPollAt: now,
        lastError: 'Yeniden bağlanın: ' + XSS, backoffUntil: null, createdAt: now },
    ],
    rules: [
      { id: 'mr_1', ord: 0, accountId: null, toMatch: '', subjectContains: 'fatura', fromDomain: '', projectId: PT, assigneeId: M, active: true },
      { id: 'mr_2', ord: 1, accountId: 'mb_g1', toMatch: 'destek@', subjectContains: '', fromDomain: 'tedarik.test', projectId: PT, assigneeId: null, active: false },
    ],
  };
  let posted = null;
  await A.route('**/api/mail/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) }));
  await A.route('**/api/mail/rules', async r => { posted = JSON.parse(r.request().postData() || '{}'); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(posted.rules) }); });
  await A.route('**/api/mail/accounts/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE.accounts[0]) }));
  await openMail(A);
  ok('yapılandırılmamış bilgisi yok, bağla düğmeleri açık', !(await A.isVisible('.mb-nocfg'))
    && await A.evaluate(() => [...document.querySelectorAll('.mb-acts [data-mbconnect]')].every(b => !b.disabled)));
  const rows = await A.evaluate(() => [...document.querySelectorAll('.mb-tbl tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()));
  ok('iki kutu listelenir (adres, sağlayıcı)', rows.length === 2 && /destek@ornek\.test/.test(rows[0]) && /Gmail/.test(rows[0]) && /Outlook/.test(rows[1]), JSON.stringify(rows));
  ok('bağlı kutu: "Bağlı" + "Şimdi çek"; varsayılan proje seçili', /Bağlı/.test(rows[0]) && /Şimdi çek/.test(rows[0])
    && await A.evaluate(PT => document.querySelector('[data-mbproj="mb_g1"]').value === PT, PT));
  ok('varsayılan proje seçeneklerinde yalnız talep projeleri', await A.evaluate(() =>
    [...document.querySelectorAll('[data-mbproj="mb_g1"] option')].filter(o => o.value).every(o => DB.projects.find(p => p.id === o.value)?.template === 'talep')));
  ok('süresi dolan kutu: "Yeniden bağlanın" + "Yeniden bağlan" düğmesi', /Yeniden bağlanın/.test(rows[1]) && await A.isVisible('[data-mbrow="mb_m1"] [data-mbconnect="microsoft"]'));
  ok('adres ve hata metni HTML olarak basılmaz (XSS yok)', !(await A.evaluate(() => window.__xss)) && !(await A.$('.mb-tbl img'))
    && rows[1].includes('onerror'));
  const rr = await A.evaluate(() => [...document.querySelectorAll('.mb-rules tbody tr')].map(tr => tr.textContent.replace(/\s+/g, ' ').trim()));
  ok('kurallar sırayla: koşullar, hedef proje, atanan', rr.length === 2 && /^1/.test(rr[0]) && /Konu: fatura/.test(rr[0]) && /Posta Üye/.test(rr[0])
    && /Gönderen: @tedarik\.test/.test(rr[1]) && /Alıcı: destek@/.test(rr[1]) && /Kapalı/.test(rr[1]), JSON.stringify(rr));
  await A.screenshot({ path: SS + '2_bagli.png', fullPage: true });
  /* sırayı değiştir: ↓ ile ilk kural ikinciye iner, liste sunucuya sırasıyla gider */
  await A.click('[data-mbrule="mr_1"] [data-mbmv][data-dir="1"]'); await sleep(500);
  ok('aşağı taşı → sunucuya yeni sıra', posted && posted.rules.map(r => r.id).join() === 'mr_2,mr_1', JSON.stringify(posted));
  /* kural ekle penceresi */
  await A.click('#mbAddRule'); await A.waitForSelector('#mr_proj');
  ok('kural penceresi: kutu, alıcı, konu, alan adı, proje, atanan', await A.evaluate(() =>
    ['#mr_acc', '#mr_to', '#mr_sub', '#mr_dom', '#mr_proj', '#mr_asg'].every(s => document.querySelector(s))));
  await A.fill('#mr_sub', 'iade'); await A.fill('#mr_dom', '@musteri.test');
  await A.selectOption('#mr_proj', PT); await sleep(150);
  await A.click('#mr_ok'); await sleep(500);
  const last = posted?.rules?.[posted.rules.length - 1];
  ok('yeni kural sona eklenir (alan adı @ olmadan)', posted?.rules?.length === 3 && last.subjectContains === 'iade' && last.fromDomain === 'musteri.test' && last.projectId === PT, JSON.stringify(last));
  /* bağlan düğmesi başlangıç ucuna gider */
  let startUrl = '';
  await A.route('**/api/mail/oauth/**', r => { startUrl = r.request().url(); r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }); });
  await A.click('.mb-acts [data-mbconnect="google"]'); await sleep(800);
  ok('"Gmail bağla" → /api/mail/oauth/google/start', /\/api\/mail\/oauth\/google\/start$/.test(startUrl), startUrl);
  /* OAuth dönüşü: ?posta=hata&neden=state → bilgi + Posta kutuları sekmesi */
  await A.goto(BASE + '?posta=hata&neden=state#system'); await sleep(1800);
  ok('OAuth dönüşü: Posta kutuları sekmesi açılır, adres temizlenir', await A.isVisible('[data-systab="mail"].on') && !/posta=/.test(await A.evaluate(() => location.search)));
  ok('OAuth dönüşü: neden bildirilir', /süresi doldu/.test(await txt(A, '#toast') || await A.evaluate(() => document.body.textContent)), await txt(A, '#toast'));
  await A.unroute('**/api/mail/status');

  /* ---- 2b) kart içinden e-postayla yanıt (madde 21) ---- */
  const PB = 'p_mbb' + RUN, IE = 'i_mbe' + RUN, IN = 'i_mbn' + RUN;
  await A.evaluate(async ([R, PB, IE, IN]) => {
    const ws = DB.workspaces[0]?.id || 'ws1', K = 'MBB' + R.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const r = await API.post('/api/sync', { changes: [
      { c: 'projects', id: PB, op: 'put', data: { name: 'Posta iç ' + R, key: K, counter: 2, workspaceId: ws, type: 'board' } },
      { c: 'statuses', id: PB + '_s0', op: 'put', data: { projectId: PB, name: 'Yeni', cat: 'todo', ord: 0 } },
      { c: 'issues', id: IE, op: 'put', data: { projectId: PB, key: K + '-1', summary: 'E-postadan gelen', statusId: PB + '_s0',
        source: { kind: 'email', provider: 'google', from: 'ayse@musteri.test' } } },
      { c: 'issues', id: IN, op: 'put', data: { projectId: PB, key: K + '-2', summary: 'Elle açılan', statusId: PB + '_s0' } },
      { c: 'history', id: 'h_mbe' + R, op: 'put', data: { issueId: IE, userId: CU().id, at: Date.now() - 5000, field: 'E-posta', from: '', to: 'ayse@musteri.test · Re: E-postadan gelen', kind: 'reply' } },
    ] });
    if (r.rejected.length) throw new Error(JSON.stringify(r.rejected));
    await reloadState();
  }, [RUN, PB, IE, IN]);
  const openI = async id => { await A.evaluate(id => { closeModal(); DB.ui.idFeed = 'all'; openIssue(id); }, id); await A.waitForSelector('#idA #newCmt'); await sleep(700); };
  /* gerçek sunucu (posta yapılandırılmamış): düğme yok */
  await openI(IE);
  ok('yapılandırılmamış: "E-postayla yanıtla" düğmesi yok', !(await A.$('#mailCmt')));
  ok('sunucu durumu: available=false', await A.evaluate(async id => (await API.get('/api/mail/reply/' + id)).available === false, IE));
  /* durum taklit: bağlı kutu; alıcı ve konu sunucudan (XSS denemesiyle) */
  let replyGets = 0, replyPost = null, replyStatus = 200;
  await A.route('**/api/mail/reply/**', async r => {
    if (r.request().method() === 'GET') { replyGets++; return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ available: true, to: 'ayse' + XSS + '@musteri.test', subject: 'Re: E-postadan gelen ' + XSS, provider: 'google' }) }); }
    replyPost = JSON.parse(r.request().postData() || '{}');
    return replyStatus === 200 ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, to: 'ayse@musteri.test', subject: 'Re: x', commentId: 'c_x', recorded: true }) })
      : r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Posta kutusunu yeniden bağlayın (Sistem → Posta kutuları): gönderme izni yok ya da bağlantının süresi doldu' }) });
  });
  await openI(IN);
  ok('e-postasız işte düğme yok ve sunucuya sorulmaz', !(await A.$('#mailCmt')) && replyGets === 0, String(replyGets));
  await openI(IE);
  ok('e-postadan gelen işte "E-postayla yanıtla" düğmesi (yorum kutusu açılmadan görünür)', await A.isVisible('#mailCmt'));
  await A.click('#mailCmt'); await sleep(300);
  ok('yanıt kipi: alıcı ve konu gösterilir (metin olarak), "E-postayla gönder"', await A.isVisible('#mailTo') && await A.isVisible('#sendMail')
    && /Alıcı: ayse<img/.test(await txt(A, '#mailTo')) && /Konu: Re: E-postadan gelen/.test(await txt(A, '#mailTo')), await txt(A, '#mailTo'));
  ok('alıcı/konu HTML olarak basılmaz (XSS yok)', !(await A.evaluate(() => window.__xss)) && !(await A.$('#mailTo img')));
  await A.fill('#newCmt', 'Merhaba,\nsorununuz çözüldü.');
  await A.click('#sendMail'); await sleep(900);
  ok('gönderim: istemci yalnız metni yollar (alıcı/konu yok)', replyPost && JSON.stringify(Object.keys(replyPost)) === '["body"]' && replyPost.body === 'Merhaba,\nsorununuz çözüldü.', JSON.stringify(replyPost));
  ok('gönderim sonrası bildirim ve kutu sıfırlanır', /E-postayla yanıtlandı/.test(await txt(A, '#toast')) && !(await A.$('#sendMail')) && await A.evaluate(() => !$('#newCmt').value), await txt(A, '#toast'));
  /* 409: anlaşılır hata, düğme gizlenir */
  replyStatus = 409; replyPost = null;
  await A.click('#mailCmt'); await sleep(200);
  await A.fill('#newCmt', 'ikinci'); await A.click('#sendMail'); await sleep(900);
  ok('409: "Posta kutusunu yeniden bağlayın" bildirilir, düğme kalkar, metin korunur', /Posta kutusunu yeniden bağlayın/.test(await txt(A, '#toast'))
    && !(await A.$('#mailCmt')) && !(await A.$('#sendMail')) && await A.evaluate(() => $('#newCmt').value === 'ikinci'), await txt(A, '#toast'));
  /* geçmiş satırı */
  await A.evaluate(() => { DB.ui.idFeed = 'hist'; refreshIssue(['act']); }); await sleep(300);
  ok('Geçmiş: "✉ E-postayla yanıtlandı" satırı', /✉ E-postayla yanıtlandı: ayse@musteri\.test · Re: E-postadan gelen/.test(await txt(A, '#idA .id-feed')), await txt(A, '#idA .id-feed'));
  await A.evaluate(() => { DB.ui.idFeed = 'all'; closeModal(); });
  await A.screenshot({ path: SS + '3_yanit.png' });
  await A.unroute('**/api/mail/reply/**');

  /* ---- 3) üye: Sistem ekranı yok, uç 403 ---- */
  const P = await mk('uye'); await login(P, 'mbm' + RUN, 'Baslangic123', 'PostaUye12345');
  const st = await P.evaluate(async () => { try { await API.get('/api/mail/status'); return 200; } catch (e) { return e.status; } });
  ok('üye: /api/mail/status 403', st === 403, String(st));
  ok('üye: Sistem ekranı izinli değil', await P.evaluate(() => !viewAllowed('system')));

  ok('sayfa hatası yok', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} BAŞARISIZ` : '\nTÜMÜ GEÇTİ');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
