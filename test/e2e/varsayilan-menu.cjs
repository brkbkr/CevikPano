// Varsayılan menü tarayıcı testi: sistem yöneticisi "Kenar çubuğunu özelleştir" panelinden herkes için varsayılan
// kenar çubuğunu (sıra + görünürlük, settings.navDefault) ayarlar / sıfırlar. Kişisel düzeni olmayan kullanıcı varsayılanı
// görür (yoklamayla canlı), kişisel düzeni olan kendi düzenini; "Varsayılana dön" kişisel düzeni kaldırır. Yetkisi
// olmayan öğe (Cariler, Kullanıcılar, Sistem) varsayılanda görünür olsa da üyeye gösterilmez.
// Ön koşullar regresyon.cjs ile aynı (ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123, demo veri).
// Çalıştırma: node test/e2e/varsayilan-menu.cjs  (BASE_URL ile adres değiştirilebilir). Sonunda varsayılanı siler.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_vm_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const M = 'u_vmm' + RUN;

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async name => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
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
  const waitFor = async (p, fn, arg, ms = 9000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const rail = p => p.evaluate(() => ({ nav: DB.ui.nav, def: DB.navDefault, more: !!document.querySelector('#navMore [data-navmore]'),
    items: [...document.querySelectorAll('#navRoot .nv-list > .nv-item')].map(x => x.dataset.v || (x.hasAttribute('data-navrecent') ? 'recent' : '?')),
    adminOnly: !!document.querySelector('#rail [data-v="customers"], #rail [data-v="users"], #rail [data-v="system"]') }));
  const openCz = async p => { await p.evaluate(() => { closeModal(); DB.ui.view = 'home'; render(); }); await sleep(150);
    await p.click('#rail [data-navws]'); await sleep(150); await p.click('#navPop [data-navcz]'); await sleep(300); };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([M, R]) => {
    if (DB.navDefault) { delete DB.navDefault; save(); await flushAll(); }
    await API.post('/api/sync', { changes: [{ c: 'users', id: M, op: 'put',
      data: { username: 'vmm' + R, name: 'Menü Üye ' + R, role: 'member', active: true, ini: 'MÜ', color: '#0F766E' } }] });
    await reloadState();
  }, [M, RUN]);

  // 1) Yönetici panelinde iki seçenek; varsayılan yokken "Varsayılanı sıfırla" görünmez
  await openCz(A);
  ok('admin panel: "Bu düzeni herkes için varsayılan yap" var, sıfırla yok (varsayılan yok)', await A.evaluate(() =>
    /herkes için varsayılan yap/.test(document.getElementById('cz_setdef')?.textContent || '') && !document.getElementById('cz_clrdef')));
  // Raporlar en üste, Son kullanılanlar ve Sistem gizli → herkes için varsayılan
  await A.click('[data-czmore="reports"]'); await sleep(150); await A.click('#czPop [data-czmv="top"]'); await sleep(100);
  await A.click('[data-czchk="recent"]'); await A.click('[data-czchk="system"]');
  await A.click('#cz_setdef'); await sleep(300); await A.evaluate(() => flushAll());
  const a1 = await rail(A);
  const exp = [{ id: 'reports', visible: true }, { id: 'recent', visible: false }, { id: 'customers', visible: true },
    { id: 'users', visible: true }, { id: 'system', visible: false }];
  /* Talep havuzu talep projesine bağlı: yöneticide de yoksa önceki görünürlüğüyle (görünür) sona eklenir. */
  const d1 = a1.def?.items || [], noPool = d1.filter(x => x.id !== 'pool'), pool = d1.find(x => x.id === 'pool');
  ok('admin: varsayılan kaydedildi (sıra + boolean görünürlük, 6 öğe), kişisel düzen yok', JSON.stringify(noPool) === JSON.stringify(exp)
    && d1.length === 6 && pool?.visible === true && a1.nav === undefined, JSON.stringify(a1));
  ok('admin: kenar çubuğu varsayılanı gösterir', a1.items[0] === 'home' && a1.items[1] === 'greports' && !a1.items.includes('recent')
    && !a1.items.includes('system') && a1.items.includes('customers') && a1.more, JSON.stringify(a1));

  // 2) Kişisel düzeni olmayan üye varsayılanı görür; yönetici öğeleri gösterilmez
  const U = await mk('member'); await login(U, 'vmm' + RUN, 'Baslangic123', 'UyeYeni12345');
  const u1 = await rail(U);
  ok('member: varsayılanı görür (Raporlar 2., Son kullanılanlar Daha fazla menüsünde)', u1.nav === undefined && u1.items[0] === 'home'
    && u1.items[1] === 'greports' && !u1.items.includes('recent') && u1.more, JSON.stringify(u1));
  ok('member: Cariler / Kullanıcılar / Sistem varsayılanda görünür olsa da gösterilmez', !u1.adminOnly && !u1.items.some(k => ['customers', 'users', 'system'].includes(k)), JSON.stringify(u1));
  await U.click('#navMore [data-navmore]'); await sleep(150);
  const mi = await U.evaluate(() => [...document.querySelectorAll('#navPop [role="menuitem"]')].map(b => b.textContent.trim()));
  ok('member: "Daha fazla" yalnız yetkili gizli öğe + özelleştir', mi.join() === 'Son kullanılanlar,Kenar çubuğunu özelleştir', JSON.stringify(mi));
  await U.keyboard.press('Escape');
  await openCz(U);
  ok('member panel: varsayılan seçenekleri yok; taslak varsayılanla açılır', await U.evaluate(() => !document.getElementById('cz_setdef') && !document.getElementById('cz_clrdef')
    && [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).filter(k => k !== 'pool').join() === 'home,reports,ws,recent'));
  await U.evaluate(() => closeModal());
  const rj = await U.evaluate(async () => (await API.post('/api/sync', { changes: [{ c: '_settings', id: 'navDefault', op: 'put', data: { items: [] } }] })));
  ok('member: API ile varsayılanı yazamaz (sunucu reddeder)', rj.applied === 0 && rj.rejected?.length === 1, JSON.stringify(rj));

  // 3) Varsayılan değişince üyede yoklamayla güncellenir (Son kullanılanlar görünür olur)
  await openCz(A); await A.click('[data-czchk="recent"]'); await A.click('#cz_setdef'); await sleep(300); await A.evaluate(() => flushAll());
  const t3 = await waitFor(U, () => [...document.querySelectorAll('#navRoot .nv-list > .nv-item')].some(x => x.hasAttribute('data-navrecent')));
  ok('member: varsayılan değişikliği yoklamayla gelir (yeniden yüklemeden)', t3 >= 0, 't=' + t3);

  // 4) Kişisel düzeni olan kendi düzenini görür; varsayılan değişse de etkilenmez
  await openCz(U); await U.click('[data-czchk="reports"]'); await U.click('#cz_ok'); await sleep(300); await U.evaluate(() => flushAll());
  ok('member: kişisel düzen kaydedildi', await U.evaluate(() => DB.ui.nav?.hidden?.join() === 'reports' && !document.querySelector('#rail [data-v="greports"]')));
  await openCz(A); await A.click('#cz_clrdef'); await sleep(300); await A.evaluate(() => flushAll());
  ok('admin: Varsayılanı sıfırla → navDefault silinir', await A.evaluate(() => DB.navDefault === undefined));
  const t4 = await waitFor(U, () => DB.navDefault === undefined);
  const u4 = await rail(U);
  ok('member: varsayılan sıfırlansa da kişisel düzen kalır', t4 >= 0 && u4.nav?.hidden?.join() === 'reports' && !u4.items.includes('greports'), JSON.stringify(u4));

  // 5) Üyede "Varsayılana dön": kişisel düzen kalkar, yöneticinin (yeni) varsayılanı geçerli olur
  await openCz(A); await A.click('[data-czchk="reports"]'); await A.click('#cz_setdef'); await sleep(300); await A.evaluate(() => flushAll());
  await waitFor(U, () => !!DB.navDefault);
  await openCz(U); await U.click('#cz_reset'); await sleep(100);
  const d5 = await U.evaluate(() => ({ rows: [...document.querySelectorAll('[data-czrow]')].map(r => r.dataset.czrow).filter(k => k !== 'pool').join(),
    off: [...document.querySelectorAll('[data-czchk][aria-checked="false"]')].map(x => x.dataset.czchk).join() }));
  ok('member: Varsayılana dön taslağa yöneticinin varsayılanını yükler', d5.rows === 'home,recent,ws,reports' && d5.off === 'reports', JSON.stringify(d5));
  await U.click('#cz_ok'); await sleep(300); await U.evaluate(() => flushAll()); await U.reload(); await sleep(2200);
  const u5 = await rail(U);
  ok('member: Varsayılana dön kalıcı (kişisel düzen yok, varsayılan görünür)', u5.nav === undefined && u5.items[1] === 'recent' && !u5.items.includes('greports')
    && u5.more, JSON.stringify(u5));
  await A.screenshot({ path: SS + 'admin.png' });

  ok('no XSS', (await Promise.all([A, U].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));
  /* temizlik: varsayılanı sil (sonraki testler kod içi varsayılanı bekler) */
  await A.evaluate(async () => { closeModal(); delete DB.navDefault; save(); await flushAll(); });
  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
