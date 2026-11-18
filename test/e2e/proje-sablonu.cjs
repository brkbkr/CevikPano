// Şablon galerisiyle yeni proje tarayıcı testi (görev 10, docs/tasarim/proje-sablonu).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/proje-sablonu.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını,
// cari ve çalışma alanını oluşturur; açtığı Epik modülünü sonda kapatır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_ps_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const M = 'u_psm' + RUN, V = 'u_psv' + RUN, CU = 'cu_ps' + RUN, WS = 'ws_ps' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';
const KANBAN = [['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['İncelemede', 'inprogress'], ['Bitti', 'done']];
const TALEP = [['Yeni', 'todo'], ['İnceleniyor', 'inprogress'], ['Talep edenden yanıt bekleniyor', 'inprogress'], ['Çözüldü', 'done'], ['Kapandı', 'done']];

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1500, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ' CONSOLE ' + m.text()); });
    p.on('dialog', d => { errs.push(name + ' DIALOG ' + d.message()); d.accept(); });
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
  const view = async (p, v) => { await p.evaluate(v => { closeModal(); DB.ui.view = v; render(); }, v); await sleep(200); };
  const waitFor = async (p, fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const flush = p => p.evaluate(() => flushAll());
  const srvAll = (p, c) => p.evaluate(async c => (await API.get('/api/state')).data[c] || [], c);
  const srv = async (p, c, id) => (await srvAll(p, c)).find(x => x.id === id) || null;
  const rows = p => p.evaluate(() => [...document.querySelectorAll('#np_cols .pt-row')].map(r => [r.querySelector('[data-cn]').value, r.querySelector('[data-cc]').value]));
  const boardCols = (p, pid) => p.evaluate(pid => DB.statuses.filter(s => s.projectId === pid).sort((a, b) => a.ord - b.ord).map(s => [s.name, s.cat]), pid);
  const pick = async (p, k) => { await p.click(`.ps-card[data-pk="${k}"] .ps-pick`); await sleep(60); };
  const byName = (p, n) => p.evaluate(n => DB.projects.find(x => x.name === n) || null, n);
  const nProj = p => p.evaluate(() => DB.projects.length);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([R, M, V, CU, WS]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'psm' + R, name: 'Şablon Üye ' + R, role: 'member', active: true, ini: 'ŞÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'psv' + R, name: 'Şablon İzleyici ' + R, role: 'viewer', active: true, ini: 'Şİ', color: '#64748B' } },
      { c: 'customers', id: CU, op: 'put', data: { name: 'Şablon Cari ' + R, kind: 'customer', active: true } },
      { c: 'workspaces', id: WS, op: 'put', data: { name: 'Şablon Alanı ' + R, color: '#2563EB', archived: false, members: [] } },
    ] });
    await reloadState();
  }, [RUN, M, V, CU, WS]);
  const epic0 = await A.evaluate(() => MOD('epic'));

  // 1) Projeler → "+ Yeni proje" galeriyi açar: 7 kart, radio grubu, Kanban önerilen ve seçili, 4 sütun
  await view(A, 'projects');
  await A.click('#pNew'); await sleep(250);
  const g = await A.evaluate(() => { const cards = [...document.querySelectorAll('.ps-card')];
    const xs = new Set(cards.map(c => Math.round(c.getBoundingClientRect().left)));
    return { n: cards.length, radios: document.querySelectorAll('#ps_grid input[type=radio][name=ps_tpl]').length, fs: document.querySelector('#ps_grid').tagName,
      sel: document.querySelector('#ps_grid input:checked')?.value, rec: document.querySelector('.ps-card[data-pk="kanban"] .ps-rec')?.textContent,
      cols: xs.size, title: document.getElementById('ps_t')?.textContent, tags: cards.map(c => c.querySelector('.pt-type')?.textContent),
      epic: document.querySelector('.ps-card[data-pk="yolharitasi"] .ps-mod')?.textContent,
      clamp: cards.every(c => { const d = c.querySelector('.ps-desc'); return d.getBoundingClientRect().height <= parseFloat(getComputedStyle(d).lineHeight) * 2 + 1; }) }; });
  ok('galeri: 7 kart, radio grubu, Kanban önerilen+seçili, 4 sütun, tür etiketleri', g.n === 7 && g.radios === 7 && g.fs === 'FIELDSET' && g.sel === 'kanban'
    && /Önerilen/.test(g.rec) && g.cols === 4 && g.title === 'Yeni proje · Şablon seçin' && g.tags.filter(t => t === 'Agile').length === 1
    && g.tags.filter(t => t === 'Pano').length === 6 && /Epik/.test(g.epic) && g.clamp, JSON.stringify(g));
  await A.screenshot({ path: SS + 'galeri.png' });

  // 2) klavye: ok tuşu seçimi değiştirir, Enter adım 2'ye geçer
  await A.focus('#ps_grid input[value="kanban"]'); await A.keyboard.press('ArrowRight'); await sleep(60);
  ok('ok tuşu: Scrum seçildi, alt not güncel', await A.evaluate(() => document.querySelector('#ps_grid input:checked')?.value === 'scrum'
    && /Scrum/.test(document.getElementById('ps_note').textContent) && document.querySelector('.ps-card.on')?.dataset.pk === 'scrum'));
  await A.keyboard.press('Enter'); await sleep(150);
  ok('Enter: adım 2 Scrum ile açıldı', await A.evaluate(() => document.getElementById('ps_tn')?.textContent === 'Scrum' && !!document.getElementById('np_n')));
  await A.click('#ps_chg'); await sleep(120);

  // 3) Önizle: kolonlar ve kategoriler birebir, tür + açılış ekranı; kayıt oluşmaz
  const n0 = await nProj(A), st0 = await A.evaluate(() => DB.statuses.length);
  await A.click('[data-pvw="talep"]'); await sleep(150);
  const pv = await A.evaluate(() => ({ cols: [...document.querySelectorAll('#ps_pvcols .ps-mcol')].map(li => [li.querySelector('.nm').textContent, li.dataset.cat]),
    type: document.getElementById('ps_pvtype').textContent, open: document.getElementById('ps_pvopen').textContent, t: document.getElementById('ps_pt').textContent }));
  ok('Önizle (Talep): 5 kolon kategoriyle, Pano, açılış Pano', JSON.stringify(pv.cols) === JSON.stringify(TALEP) && /Pano/.test(pv.type) && /^Pano/.test(pv.open)
    && pv.t === 'Talep / servis masası', JSON.stringify(pv));
  await A.screenshot({ path: SS + 'onizle.png' });
  await A.click('#ps_pvgal'); await sleep(120);
  ok('Galeriye dön: galeri geri geldi, Önizle kayıt oluşturmadı', await A.evaluate(() => document.querySelectorAll('.ps-card').length === 7) && await nProj(A) === n0
    && await A.evaluate(() => DB.statuses.length) === st0);
  await A.click('[data-pvw="scrum"]'); await sleep(120);
  ok('Önizle (Scrum): Agile, açılış Backlog', await A.evaluate(() => /Agile/.test(document.getElementById('ps_pvtype').textContent)
    && /Backlog/.test(document.getElementById('ps_pvopen').textContent)));
  await A.click('#ps_pvback'); await sleep(100);

  // 4) Kanban → Önizle → Bu şablonu kullan → adım 2 → Oluştur → pano kolonları
  await A.click('[data-pvw="kanban"]'); await sleep(100); await A.click('#ps_pvuse'); await sleep(150);
  ok('adım 2: Kanban kolonları dolu, varsayılan akış kutusu yöneticide', JSON.stringify(await rows(A)) === JSON.stringify(KANBAN)
    && await A.evaluate(() => !!document.getElementById('np_def') && !document.querySelector('#np_cols .pt-tpls')));
  const PK = 'Kanban ' + RUN + ' ' + XSS;
  await A.fill('#np_n', PK); await sleep(50);
  const sugKey = await A.inputValue('#np_key');
  ok('anahtar addan önerilir', /^[A-Z0-9]{2,}/.test(sugKey), sugKey);
  await A.click('#np_ok'); await sleep(400); await flush(A);
  const pk = await byName(A, PK);
  ok('Kanban: proje oluştu, pano açıldı, kolonlar birebir', !!pk && pk.type === 'board' && pk.template === 'kanban' && pk.key === sugKey
    && await A.evaluate(id => DB.ui.project === id && DB.ui.view === 'board', pk?.id) && JSON.stringify(await boardCols(A, pk?.id)) === JSON.stringify(KANBAN)
    && await A.evaluate(() => [...document.querySelectorAll('#view .col .col-h, #view .col h3, #view .col .cn')].length >= 0), JSON.stringify(pk));
  const colTexts = await A.evaluate(() => document.getElementById('view').textContent);
  ok('pano ekranında 4 kolon adı görünür', KANBAN.every(([n]) => colTexts.includes(n)) && await A.evaluate(() => document.querySelectorAll('#view .col').length) === 4);
  const sp = await srv(A, 'projects', pk.id);
  ok('sunucu: template=kanban, type=board, 4 kolon', sp?.template === 'kanban' && sp?.type === 'board'
    && (await srvAll(A, 'statuses')).filter(s => s.projectId === pk.id).length === 4, JSON.stringify(sp));

  // 5) Scrum → Agile + backlog açılışı
  await view(A, 'projects'); await A.click('#pNew'); await sleep(200); await pick(A, 'scrum'); await A.click('#ps_next'); await sleep(150);
  await A.fill('#np_n', 'Scrum ' + RUN); await A.click('#np_ok'); await sleep(400); await flush(A);
  const ps = await byName(A, 'Scrum ' + RUN);
  ok('Scrum: Agile, İş listesi/Backlog açıldı, Geliştirme kolonları', ps?.type === 'agile' && ps?.template === 'scrum' && await A.evaluate(() => DB.ui.view === 'backlog')
    && (await boardCols(A, ps.id)).map(r => r[0]).join() === 'Yapılacak,Geliştirmede,İncelemede,Testte,Bitti', JSON.stringify(ps));

  // 6) hata metinleri: satır altında, kayıt oluşmaz
  await view(A, 'projects'); await A.click('#pNew'); await sleep(200); await A.click('#ps_next'); await sleep(120);
  const n1 = await nProj(A);
  await A.click('#np_ok'); await sleep(120);
  ok('boş ad: "Proje adı gerekli" satır altında', await A.evaluate(() => document.getElementById('np_n_e')?.textContent === 'Proje adı gerekli'
    && document.getElementById('np_n').getAttribute('aria-invalid') === 'true'));
  await A.fill('#np_n', 'ÜRÜN PLATFORMU'); await A.click('#np_ok'); await sleep(120);
  ok('aynı ad (Türkçe harf duyarsız): "Bu adda bir proje zaten var"', await A.evaluate(() => document.getElementById('np_n_e')?.textContent === 'Bu adda bir proje zaten var'));
  await A.fill('#np_n', 'Hata Deneme ' + RUN); await A.fill('#np_key', 'pano'); await A.click('#np_ok'); await sleep(120);
  const ke = await A.evaluate(() => ({ e: document.getElementById('np_key_e')?.textContent, s: document.getElementById('np_key_s')?.dataset.sug, n: document.getElementById('np_n').value }));
  ok('kullanılan anahtar: "Bu anahtar kullanımda" + öneri; ad korunur', ke.e === 'Bu anahtar kullanımda' && ke.s === 'PANO2' && ke.n === 'Hata Deneme ' + RUN, JSON.stringify(ke));
  await A.click('#np_key_s'); await sleep(100);
  ok('öneri tıklanınca anahtar dolar', await A.inputValue('#np_key') === 'PANO2');
  await A.selectOption('#np_cu', CU); await A.evaluate(id => { cuById(id).active = false; }, CU);
  await A.click('#np_ok'); await sleep(120);
  ok('pasif cari: "Bu cari pasif; başka bir cari seçin"', await A.evaluate(() => document.getElementById('np_cu_e')?.textContent === 'Bu cari pasif; başka bir cari seçin'));
  await A.evaluate(id => { cuById(id).active = true; }, CU);
  await A.selectOption('#np_cu', ''); await A.selectOption('#np_ws', WS); await A.evaluate(id => { wsById(id).archived = true; }, WS);
  await A.click('#np_ok'); await sleep(120);
  ok('arşivli alan: "Bu çalışma alanı arşivde; başka bir alan seçin"', await A.evaluate(() => document.getElementById('np_ws_e')?.textContent === 'Bu çalışma alanı arşivde; başka bir alan seçin'));
  await A.evaluate(id => { wsById(id).archived = false; }, WS);
  ok('hatalarda kayıt yok, pencere açık', await nProj(A) === n1 && await A.evaluate(() => document.getElementById('scrim').classList.contains('on')));
  /* kolon kuralları (#12): Bitti yoksa kayıt yok */
  await A.selectOption('#np_ws', 'ws1');
  const last = (await rows(A)).length - 1;
  await A.selectOption(`[data-cc="${last}"]`, 'inprogress'); await sleep(80);
  await A.click('#np_ok'); await sleep(150);
  ok('Bitti kolonu yoksa: kolon hatası, kayıt yok', await A.evaluate(() => /en az bir Bitti/.test(document.getElementById('np_cerr').textContent)) && await nProj(A) === n1);

  // 7) şablon değiştir: elle kolon değişikliği → soru; ad/anahtar/alan/cari korunur, kolonlar yeniden dolar
  await A.click('#ps_chg'); await sleep(100); await pick(A, 'gorev'); await A.click('#ps_next'); await sleep(150);
  ok('"Kolon değişiklikleriniz kaybolacak" sorusu', await A.evaluate(() => document.getElementById('ps_ct')?.textContent === 'Kolon değişiklikleriniz kaybolacak'
    && document.getElementById('ps_conf').getAttribute('role') === 'alertdialog'));
  await A.click('#ps_cno'); await sleep(100);
  ok('Vazgeç: elle değişiklik ve şablon korunur', await A.evaluate(l => document.querySelector(`[data-cc="${l}"]`)?.value === 'inprogress'
    && document.getElementById('ps_tn').textContent === 'Kanban', last));
  await A.click('#ps_chg'); await sleep(100); await pick(A, 'gorev'); await A.click('#ps_next'); await sleep(120); await A.click('#ps_cyes'); await sleep(120);
  const kept = await A.evaluate(() => ({ n: document.getElementById('np_n').value, k: document.getElementById('np_key').value, ws: document.getElementById('np_ws').value,
    t: document.getElementById('ps_tn').textContent }));
  ok('Şablonu değiştir: Görev takibi kolonları, ad/anahtar/alan korundu', JSON.stringify(await rows(A)) === JSON.stringify([['Yapılacak', 'todo'], ['Devam ediyor', 'inprogress'], ['Bitti', 'done']])
    && kept.n === 'Hata Deneme ' + RUN && kept.k === 'PANO2' && kept.ws === 'ws1' && kept.t === 'Görev takibi', JSON.stringify(kept));
  await A.click('#ps_chg'); await sleep(100); await pick(A, 'uyarlama'); await A.click('#ps_next'); await sleep(120);
  ok('değişiklik yoksa soru sorulmaz', await A.evaluate(() => !document.getElementById('ps_conf') && document.getElementById('ps_tn').textContent === 'Uyarlama projesi'));
  /* Boş proje: kolon kaynağı seçeneği (varsayılan akış / aktif projeden kopyala) */
  await A.click('#ps_chg'); await sleep(100); await pick(A, 'bos'); await A.click('#ps_next'); await sleep(120);
  const bos = await A.evaluate(() => [...document.querySelectorAll('#np_cols [data-tpl]')].map(b => b.dataset.tpl));
  ok('Boş proje: kolon kaynağı varsayılan akış + aktif projeden kopyala', JSON.stringify(bos) === '["default","copy"]', JSON.stringify(bos));
  await A.click('[data-tpl="copy"]'); await sleep(100);
  const cp = await A.evaluate(() => stats().map(s => s.name).join());
  ok('kopyala: aktif projenin kolonları', (await rows(A)).map(r => r[0]).join() === cp, cp);
  await A.evaluate(() => closeModal());

  // 8) Ürün yol haritası: Epik kapalıyken yöneticiye kutu; açarsa Yol haritası açılır
  await view(A, 'projects'); await A.click('#pNew'); await sleep(200); await pick(A, 'yolharitasi'); await A.click('#ps_next'); await sleep(150);
  ok('yöneticide "Epikleri aç (tüm projelerde)" kutusu, varsayılan boş; açılış Pano', epic0 || await A.evaluate(() => document.getElementById('np_epic')?.checked === false
    && /Pano/.test(document.getElementById('np_open').textContent)));
  if (!epic0) { await A.check('#np_epic'); await sleep(50); }
  ok('kutu işaretlenince açılış Yol haritası', await A.evaluate(() => /Yol haritası/.test(document.getElementById('np_open').textContent)));
  await A.fill('#np_n', 'Yol ' + RUN); await A.click('#np_ok'); await sleep(400); await flush(A);
  ok('Yol haritası: Epik açıldı, roadmap ekranı, template=yolharitasi', await A.evaluate(n => MOD('epic') && DB.ui.view === 'roadmap'
    && DB.projects.find(p => p.name === n)?.template === 'yolharitasi', 'Yol ' + RUN));
  if (!epic0) await A.evaluate(async () => { DB.cfg.modules.epic = false; save(); await flushAll(); });

  // 9) alan grubundan gelindiyse alan seçili ve bağlamda gösterilir
  await view(A, 'projects');
  await A.click(`[data-wsnewproj="${WS}"]`); await sleep(200);
  ok('alan grubundan: galeride alan adı', await A.evaluate(R => document.querySelector('.ps-ctx b')?.textContent === 'Şablon Alanı ' + R, RUN));
  await A.click('#ps_next'); await sleep(120);
  ok('adım 2: alan seçili + "Bu alandan açtınız"', await A.evaluate(id => document.getElementById('np_ws').value === id && /Bu alandan açtınız/.test(document.querySelector('.ps-hint')?.textContent || ''), WS));
  await A.evaluate(() => closeModal());

  // 10) Üye: Benim işlerim → Talep; yenilemede ve 2. oturumda eksiksiz
  const Mb = await mk('member'); await login(Mb, 'psm' + RUN, 'Baslangic123', 'SabUye12345!');
  await view(Mb, 'projects');
  await Mb.click('#pNew'); await sleep(200);
  ok('üye: Projeler girişi aynı galeriyi açar (Benim işlerim düğmesi kalktı)', await Mb.evaluate(() => document.querySelectorAll('.ps-card').length === 7));
  await pick(Mb, 'yolharitasi'); await Mb.click('#ps_next'); await sleep(120);
  ok('üye + yol haritası + epik kapalı: bilgi var, kutular yok', await Mb.evaluate(() => /Yöneticinizden epikleri açmasını isteyin/.test(document.getElementById('np_einfo')?.textContent || '')
    && !document.getElementById('np_epic') && !document.getElementById('np_def')));
  await Mb.click('#ps_chg'); await sleep(100); await pick(Mb, 'talep'); await Mb.click('#ps_next'); await sleep(120);
  const PT = 'Talep ' + RUN;
  await Mb.fill('#np_n', PT); await Mb.click('#np_ok'); await sleep(400); await flush(Mb);
  const pt = await byName(Mb, PT);
  const tA = await waitFor(A, id => DB.projects.some(p => p.id === id) && DB.statuses.filter(s => s.projectId === id).length === 5, pt?.id, 9000);
  await Mb.reload(); await sleep(1800);
  const after = await Mb.evaluate(id => ({ p: DB.projects.find(x => x.id === id), cols: DB.statuses.filter(s => s.projectId === id).sort((a, b) => a.ord - b.ord).map(s => [s.name, s.cat]) }), pt?.id);
  ok('üyenin Talep projesi yenilemede eksiksiz (template=talep, 5 kolon, üye)', after.p?.template === 'talep' && after.p?.type === 'board'
    && JSON.stringify(after.cols) === JSON.stringify(TALEP) && after.p?.members.includes(M), JSON.stringify(after));
  ok('2. oturumda (yönetici) görünür', tA >= 0, 't=' + tA + ' ms');
  const sv = await srv(A, 'projects', pt.id);
  ok('sunucu: data.template="talep"', sv?.template === 'talep');

  // 11) İzleyici: giriş yok; palette/doğrudan çağrı "İzleyiciler proje oluşturamaz"
  const Vb = await mk('viewer'); await login(Vb, 'psv' + RUN, 'Baslangic123', 'SabIzl12345!');
  await view(Vb, 'projects');
  const vv = await Vb.evaluate(() => ({ btn: document.querySelectorAll('#pNew,#hNewProject,[data-wsnewproj]').length }));
  await view(Vb, 'home');
  vv.home = await Vb.evaluate(() => document.querySelectorAll('#pNew,#hNewProject,[data-wsnewproj]').length);
  await Vb.evaluate(() => newProjectForm()); await sleep(100);
  vv.toast = await Vb.evaluate(() => document.getElementById('toast').textContent);
  vv.open = await Vb.evaluate(() => document.getElementById('scrim').classList.contains('on'));
  ok('izleyici: giriş yok, "İzleyiciler proje oluşturamaz", pencere açılmaz', vv.btn === 0 && vv.home === 0 && vv.toast === 'İzleyiciler proje oluşturamaz' && !vv.open, JSON.stringify(vv));

  // 12) 375 px: tek sütun, taşma yok, ≥44 px; Önizle tam ekran ve geri dönülebilir
  const Mo = await mk('mobile', { width: 375, height: 760 }); await login(Mo, 'psm' + RUN, 'SabUye12345!');
  await view(Mo, 'projects'); await Mo.evaluate(() => newProjectForm()); await sleep(250);
  const mg = await Mo.evaluate(() => { const cards = [...document.querySelectorAll('.ps-card')]; const m = document.querySelector('#scrim .modal').getBoundingClientRect();
    return { xs: new Set(cards.map(c => Math.round(c.getBoundingClientRect().left))).size, w: Math.round(m.width), sw: document.getElementById('scrim').scrollWidth,
      look: Math.min(...[...document.querySelectorAll('.ps-look')].map(e => e.getBoundingClientRect().height)),
      next: Math.round(document.getElementById('ps_next').getBoundingClientRect().height), x: Math.round(document.querySelector('.ps-x').getBoundingClientRect().height) }; });
  ok('375 px galeri: tek sütun, tam genişlik, yatay kayma yok, düğmeler ≥44 px', mg.xs === 1 && mg.w === 375 && mg.sw <= 375 && mg.look >= 44 && mg.next >= 44 && mg.x >= 44, JSON.stringify(mg));
  await Mo.screenshot({ path: SS + 'mobil.png' });
  await Mo.click('[data-pvw="talep"]'); await sleep(150);
  const mp = await Mo.evaluate(() => { const m = document.querySelector('#scrim .modal').getBoundingClientRect();
    return { w: Math.round(m.width), h: Math.round(m.height), sw: document.getElementById('scrim').scrollWidth, back: Math.round(document.getElementById('ps_pvback').getBoundingClientRect().height) }; });
  ok('375 px Önizle: tam ekran, taşma yok, geri ≥44 px', mp.w === 375 && mp.h >= 700 && mp.sw <= 375 && mp.back >= 44, JSON.stringify(mp));
  await Mo.screenshot({ path: SS + 'mobil-onizle.png' });
  await Mo.click('#ps_pvback'); await sleep(120);
  ok('375 px: Önizle → galeriye dönülür', await Mo.evaluate(() => document.querySelectorAll('.ps-card').length === 7));
  await Mo.click('#ps_next'); await sleep(150);
  const mf = await Mo.evaluate(() => ({ sw: document.getElementById('scrim').scrollWidth, ok: Math.round(document.getElementById('np_ok').getBoundingClientRect().height),
    inp: Math.round(document.getElementById('np_n').getBoundingClientRect().height) }));
  ok('375 px adım 2: taşma yok, Oluştur ve alanlar ≥44 px', mf.sw <= 375 && mf.ok >= 44 && mf.inp >= 44, JSON.stringify(mf));
  await Mo.evaluate(() => closeModal());

  // 13) mevcut projeler etkilenmez; XSS çalışmadı
  const p1 = await srv(A, 'projects', 'p1');
  ok('mevcut proje (p1) şablonsuz kalır', p1 && p1.template === undefined);
  ok('XSS çalışmadı', (await Promise.all([A, Mb, Vb, Mo].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
