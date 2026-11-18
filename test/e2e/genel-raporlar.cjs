// Genel raporlar tarayıcı testi (grup D1, docs/tasarim/genel-raporlar).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/genel-raporlar.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını,
// carilerini, projelerini ve 2025-03 dönemindeki süre kayıtlarını oluşturur (uydurma veri).
// Performans: 50.000 kayıt / 10.000 iş / 200 proje yalnız tarayıcı belleğinde üretilir (sunucuya gitmez).
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_gr_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const L = RUN.replace(/\d/g, d => 'QRSTUVWXYZ'[d]).toUpperCase();   // proje anahtarı için yalnız harf
const XSS = '<img src=x onerror="window.__xss=1">';
const M = 'u_grm' + RUN, V = 'u_grv' + RUN, GONE = 'u_grgone' + RUN;
const CU1 = 'cu_gra' + RUN, CU2 = 'cu_grb' + RUN, WS2 = 'ws_gr' + RUN;
const PA = 'p_gra' + RUN, PB = 'p_grb' + RUN, PC = 'p_grc' + RUN;
const KA = 'GA' + L, KB = 'GB' + L, KC = 'GC' + L;
const MON = '2025-03';
const num = s => +String(s).replace(/\./g, '').replace(',', '.');

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 950 }) => {
    const ctx = await b.newContext({ viewport: vp, acceptDownloads: true });
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
  const gr = async (p, tab = 'sure', f = { month: MON }) => {
    await p.evaluate(([tab, f]) => { closeModal(); GR.cell = null; DB.ui.grF = f;
      if (location.hash === '#raporlar/' + tab) { DB.ui.view = 'greports'; DB.ui.grTab = tab; render(); } else location.hash = 'raporlar/' + tab; }, [tab, f]);
    await sleep(400);
  };
  const total = p => p.evaluate(() => +document.querySelector('[data-grtotal]')?.dataset.grtotal);
  const viewText = p => p.evaluate(() => document.getElementById('view').innerText);
  const xlsx = async (p) => {
    const [d] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }), p.click('[data-grxls]')]);
    const file = SS + RUN + '_' + d.suggestedFilename(); await d.saveAs(file);
    const buf = fs.readFileSync(file).toString('utf8');        // zipStore: sıkıştırmasız, XML düz metin
    const sheets = [...buf.matchAll(/<worksheet[\s\S]*?<\/worksheet>/g)].map(m => m[0]);
    return { name: d.suggestedFilename(), raw: buf, sheets };
  };
  const rowsOf = xml => [...xml.matchAll(/<row r="\d+">([\s\S]*?)<\/row>/g)].map(r =>
    [...r[1].matchAll(/<c r="([A-Z]+)\d+"(?: t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)<\/c>/g)].map(c => c[2] != null ? +c[2] : c[3]));

  /* ---------------- kurulum (yönetici, API) ---------------- */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  const ADM = await A.evaluate(() => CU().id);
  await A.evaluate(async ([R, M, V, CU1, CU2, WS2, PA, PB, PC, KA, KB, KC, ADM, XSS]) => {
    const st = (pid) => [0, 1, 2].map(k => ({ c: 'statuses', id: `${pid}_s${k}`, op: 'put',
      data: { projectId: pid, name: ['Yapılacak', 'Sürüyor', 'Bitti'][k], cat: ['todo', 'inprogress', 'done'][k], wip: 0, ord: k } }));
    const r1 = await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'grm' + R, name: 'Rapor Üye ' + R, role: 'member', active: true, ini: 'RÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'grv' + R, name: 'Rapor İzleyici ' + R, role: 'viewer', active: true, ini: 'Rİ', color: '#64748B' } },
      { c: 'customers', id: CU1, op: 'put', data: { name: `${XSS} Örnek Cari ${R}`, kind: 'customer', active: true, contacts: [] } },
      { c: 'customers', id: CU2, op: 'put', data: { name: `Pasif Cari ${R}`, kind: 'customer', active: true, contacts: [] } },
      { c: 'workspaces', id: WS2, op: 'put', data: { id: WS2, name: 'Rapor Alanı ' + R, color: '#2563EB', description: '' } },
    ] });
    const r2 = await API.post('/api/sync', { changes: [
      { c: 'projects', id: PA, op: 'put', data: { key: KA, name: 'Rapor A ' + R, lead: ADM, counter: 2, members: [ADM, M, V], archived: false, customerId: CU1 } },
      { c: 'projects', id: PB, op: 'put', data: { key: KB, name: 'Rapor B ' + R, lead: ADM, counter: 1, members: [ADM, M, V], archived: false, workspaceId: WS2 } },
      { c: 'projects', id: PC, op: 'put', data: { key: KC, name: 'Gizli Proje ' + R, lead: ADM, counter: 1, members: [ADM], archived: false, customerId: CU2 } },
      ...st(PA), ...st(PB), ...st(PC),
    ] });
    const iss = (id, pid, key, type, billable, summary) => ({ c: 'issues', id, op: 'put', data: { key, projectId: pid, type, priority: 2, summary,
      statusId: pid + '_s0', assignee: M, reporter: ADM, estimate: 0, spent: 0, labels: [], rank: 1, created: Date.now(), ...(billable ? { billable } : {}) } });
    const wl = (id, iid, uid, date, hours, comment = '') => ({ c: 'worklogs', id, op: 'put', data: { issueId: iid, userId: uid, date, hours, comment } });
    const r3 = await API.post('/api/sync', { changes: [
      iss('i_gra1' + R, PA, KA + '-1', 'task', 'Faturalanacak', 'Rapor işi A1 ' + R),
      iss('i_gra2' + R, PA, KA + '-2', 'bug', 'Faturalanmayacak', 'Rapor işi A2 ' + R),
      iss('i_grb1' + R, PB, KB + '-1', 'task', '', 'Rapor işi B1 ' + R),
      iss('i_grc1' + R, PC, KC + '-1', 'task', 'Faturalanacak', 'Gizli iş ' + R),
    ] });
    const r4 = await API.post('/api/sync', { changes: [
      wl('w_gr1' + R, 'i_gra1' + R, M, '2025-03-03', 2, 'Analiz ' + XSS),
      wl('w_gr2' + R, 'i_gra1' + R, M, '2025-03-10', 1.5),
      wl('w_gr3' + R, 'i_gra1' + R, ADM, '2025-03-05', 3),
      wl('w_gr4' + R, 'i_gra2' + R, M, '2025-03-12', 1.25),
      wl('w_gr5' + R, 'i_gra2' + R, 'u_grgone' + R, '2025-03-14', 0.75),
      wl('w_gr6' + R, 'i_grb1' + R, M, '2025-03-20', 4),
      wl('w_gr7' + R, 'i_grc1' + R, ADM, '2025-03-21', 5),
      wl('w_gr8' + R, 'i_gra1' + R, M, '2025-04-02', 9),            // başka ay: dönem dışında kalmalı
    ] });
    /* cari bağlıyken pasife alınır (pasif cari projeye bağlanamaz); B arşivlenir */
    const r5 = await API.post('/api/sync', { changes: [
      { c: 'customers', id: CU2, op: 'put', data: { name: `Pasif Cari ${R}`, kind: 'customer', active: false, contacts: [] } },
    ] });
    await reloadState();
    const pb = DB.projects.find(p => p.id === PB); pb.archived = true; save(); await flushAll();
    window.__setup = [r1, r2, r3, r4, r5].map(r => r.rejected || []).flat();
  }, [RUN, M, V, CU1, CU2, WS2, PA, PB, PC, KA, KB, KC, ADM, XSS]);
  ok('kurulum reddedilmedi', !(await A.evaluate(() => window.__setup.length)), JSON.stringify(await A.evaluate(() => window.__setup)));

  /* ---------------- kriter 1: sol menü + adres + geri tuşu ---------------- */
  await A.evaluate(() => { DB.ui.view = 'home'; render(); }); await sleep(200);
  const navOk = await A.evaluate(() => { const a = document.querySelector('#rail [data-v="greports"]'); return !!a && a.textContent.trim() === 'Raporlar'; });
  ok('sol menüde "Raporlar" var', navOk);
  await A.evaluate(() => { DB.ui.grF = { month: '2025-03' }; }); await A.click('#rail [data-v="greports"]'); await sleep(400);
  ok('Raporlar → "Genel raporlar" başlığı + #raporlar/sure', await A.evaluate(() => $('#title').textContent === 'Genel raporlar' && location.hash === '#raporlar/sure'
    && document.querySelector('#grtab-sure').getAttribute('aria-selected') === 'true'));
  await A.click('#grtab-fatura'); await sleep(300);
  ok('Faturalanabilir saat sekmesi adresi', await A.evaluate(() => location.hash === '#raporlar/fatura' && !!document.querySelector('#grFt')));
  await A.goBack(); await sleep(400);
  ok('geri tuşu Süre sekmesine döner', await A.evaluate(() => location.hash === '#raporlar/sure' && !!document.querySelector('#grPv')));
  await A.goto(BASE + '#raporlar/fatura'); await A.waitForSelector('#grFt', { timeout: 8000 }).catch(() => {});
  ok('doğrudan adresle açılır (#raporlar/fatura)', await A.evaluate(() => DB.ui.view === 'greports' && !!document.querySelector('#grFt')));
  ok('özelleştirme listesinde Raporlar taşınabilir öğe', await A.evaluate(() => NAV_MOVABLE.includes('reports') && navCfg().order.includes('reports')));

  /* ---------------- kriter 4: tek proje toplamı = Efor raporu toplamı ---------------- */
  const eforTotal = async (p, pid) => p.evaluate(pid => {
    closeModal(); DB.ui.project = pid; DB.ui.efProjFor = pid; DB.ui.efProject = pid; DB.ui.efRange = 'month'; DB.ui.efMonth = '2025-03'; DB.ui.efUser = '';
    DB.ui.view = 'effort'; render();
    return { sum: periodLogs().reduce((a, w) => a + w.hours, 0), link: !!document.querySelector('#efGr[href="#raporlar/sure"]') };
  }, pid);
  const ef = await eforTotal(A, PA);
  ok('Efor sekmesinde "Tüm projeler: Genel raporlar" bağlantısı', ef.link);
  await gr(A, 'sure', { month: MON, proj: PA });
  const tA = await total(A);
  ok('kriter 4: tek proje + dönem toplamı = Efor toplamı', tA === Math.round(ef.sum * 100) / 100 && tA === 8.5, `gr=${tA} efor=${ef.sum}`);
  const ef2 = await eforTotal(A, PB); await gr(A, 'sure', { month: MON, proj: PB });
  ok('kriter 4: arşivli proje B de eşit', (await total(A)) === ef2.sum && ef2.sum === 4, `${await total(A)} / ${ef2.sum}`);

  /* Efor tercihlerini geri al: aynı veritabanında sonra çalışan testleri etkilemesin */
  await A.evaluate(async () => { ['efMonth', 'efRange', 'efProject', 'efProjFor', 'efUser'].forEach(k => delete DB.ui[k]); save(); await flushAll(); });
  /* ---------------- üye: kapsam, pivot, hücre listesi ---------------- */
  const Mb = await mk('member'); await login(Mb, 'grm' + RUN, 'Baslangic123', 'RaporUye12345!');
  await gr(Mb, 'sure', { month: MON, row: 'customer', col: 'user' });
  const tM = await total(Mb);
  const mInfo = await Mb.evaluate(() => {
    const R = GR.last; const cells = [...document.querySelectorAll('#grPv tbody td:not(.tot) .gr-c')].reduce((a, b) => a + (b.disabled ? 0 : num(b.textContent)), 0);
    function num(s) { return +String(s).trim().replace(/\./g, '').replace(',', '.'); }
    return { cells, rows: [...document.querySelectorAll('#grPv tbody th.rh')].map(e => e.textContent.trim()),
      cols: [...document.querySelectorAll('#grPv thead th')].map(e => e.textContent.trim()), grand: R.grand };
  });
  ok('üye: genel toplam yalnız kendi projeleri (12,50)', tM === 12.5, String(tM));
  ok('pivot hücreleri toplamı = genel toplam', Math.abs(mInfo.cells - tM) < 0.001, `${mInfo.cells} / ${tM}`);
  ok('"Cari bağlı değil" satırı var', mInfo.rows.some(r => r.includes('Cari bağlı değil')));
  ok('silinmiş kullanıcı "Bilinmeyen" sütunu toplamda', mInfo.cols.some(c => c.includes('Bilinmeyen')));
  const vt = await viewText(Mb);
  ok('kriter 8: üyesi olunmayan proje (5 saat) hiçbir yerde yok', !vt.includes(KC) && !vt.includes('Gizli') && !vt.includes('Pasif Cari')
    && !(await Mb.evaluate(kc => [...document.querySelectorAll('#view option')].some(o => o.textContent.includes(kc)), KC)));
  ok('kriter 8: süzgeç listesinde gizli proje yok', !(await Mb.evaluate(pc => !!document.querySelector(`[data-grf="proj"] option[value="${pc}"]`), PC)));
  ok('XSS: cari adı metin olarak basılır', vt.includes('<img src=x') && !(await Mb.evaluate(() => window.__xss)));
  ok('arşivli proje etiketi (Proje satırında)', await (async () => { await gr(Mb, 'sure', { month: MON, row: 'project', col: '' });
    return Mb.evaluate(kb => [...document.querySelectorAll('#grPv tbody th.rh')].some(e => e.textContent.includes(kb) && e.textContent.includes('Arşivli')), KB); })());

  /* hücre listesi: toplam = hücre */
  await gr(Mb, 'sure', { month: MON, row: 'customer', col: 'user' });
  const cellSel = await Mb.evaluate(cu => { const b = document.querySelector(`#grPv tbody .gr-c[data-grr="${cu}"]:not([data-grc="*"]):not(:disabled)`); return b ? [b.dataset.grr, b.dataset.grc, b.textContent.trim()] : null; }, CU1);
  await Mb.click(`#grPv .gr-c[data-grr="${cellSel[0]}"][data-grc="${cellSel[1]}"]`); await sleep(300);
  const dr = await Mb.evaluate(() => { const d = document.querySelector('#grDrill'); if (!d) return null;
    const n = s => +String(s).trim().replace(/\./g, '').replace(',', '.');
    return { sum: +d.querySelector('[data-grdsum]').dataset.grdsum, rows: [...d.querySelectorAll('tbody td.h')].reduce((a, e) => a + n(e.textContent), 0),
      eq: !!d.querySelector('.eq'), pressed: document.querySelector('#grPv .gr-c[aria-pressed="true"]')?.textContent.trim(), cols: [...d.querySelectorAll('thead th')].map(e => e.textContent) }; });
  ok('kriter 5: hücre listesi açılır, toplam = hücre', dr && dr.sum === num(cellSel[2]) && Math.abs(dr.rows - dr.sum) < 0.001 && dr.eq, JSON.stringify(dr));
  ok('kriter 5: sütunlar Tarih/Kişi/İş/Açıklama/Saat', dr && dr.cols.join('|') === 'Tarih|Kişi|İş|Açıklama|Saat');
  /* kriter 14: poll yenilemesi açık listeyi bozmaz */
  await Mb.evaluate(() => tryRerender()); await sleep(200);
  ok('yeniden çizimde hücre listesi açık kalır', await Mb.evaluate(() => !!document.querySelector('#grDrill') && !!document.querySelector('#grPv .gr-c[aria-pressed="true"]')));
  /* klavye: Enter ile hücre açılır */
  await Mb.click('[data-grclose]'); await sleep(200);
  await Mb.focus(`#grPv .gr-c[data-grr="${cellSel[0]}"][data-grc="*"]`); await Mb.keyboard.press('Enter'); await sleep(300);
  ok('klavye: Enter ile satır toplamı listesi açılır', await Mb.evaluate(() => !!document.querySelector('#grDrill')));

  /* ---------------- kriter 2: süzgeçler (alan daraltma, geçersiz temizlenir, kalıcı) ---------------- */
  await gr(Mb, 'sure', { month: MON });
  await Mb.selectOption('[data-grf="ws"]', WS2); await sleep(300);
  const projOpts = await Mb.evaluate(() => [...document.querySelectorAll('[data-grf="proj"] option')].map(o => o.value).filter(Boolean));
  ok('alan seçilince proje listesi daralır', projOpts.length === 1 && projOpts[0] === PB, projOpts.join());
  await Mb.evaluate(pa => { DB.ui.grF.proj = pa; render(); }, PA); await sleep(200);
  ok('alanla uyuşmayan proje seçimi temizlenir', await Mb.evaluate(() => !DB.ui.grF.proj));
  ok('etkin süzgeç çipi (Alan)', await Mb.evaluate(() => document.querySelectorAll('.gr-chip').length === 1 && /Alan:/.test(document.querySelector('.gr-chip').textContent)));
  await Mb.evaluate(() => flushAll()); await sleep(300);
  await Mb.reload(); await sleep(1800);
  ok('süzgeçler kalıcı (yeniden yüklemede alan seçili)', await Mb.evaluate(ws => DB.ui.view === 'greports' && DB.ui.grF?.ws === ws && document.querySelector('[data-grf="ws"]').value === ws, WS2));

  /* ---------------- kriter 6: Faturalanabilir saat ---------------- */
  await gr(Mb, 'fatura', { month: MON });
  const fat = await Mb.evaluate(() => ({ f: +document.querySelector('[data-grf-f]').dataset.grfF, n: +document.querySelector('[data-grf-n]').dataset.grfN,
    t: +document.querySelector('[data-grf-t]').dataset.grfT, rows: [...document.querySelectorAll('#grFt tbody tr.top')].map(r => r.textContent.replace(/\s+/g, ' ').trim()) }));
  ok('kriter 6: F + FY = T (10,50 + 2,00 = 12,50)', fat.f === 10.5 && fat.n === 2 && fat.t === 12.5 && fat.f + fat.n === fat.t, JSON.stringify(fat));
  ok('kriter 6: "Cari bağlı değil" en altta', /Cari bağlı değil/.test(fat.rows[fat.rows.length - 1] || ''));
  await Mb.click(`#grFt [data-grtog="${CU1}"]`); await sleep(250);
  ok('cari satırı açılınca projeleri görünür', await Mb.evaluate(([cu, ka]) => document.querySelector(`#grFt [data-grtog="${cu}"]`).getAttribute('aria-expanded') === 'true'
    && [...document.querySelectorAll(`#grFt tr.sub[data-grsub="${cu}"]`)].some(r => r.textContent.includes(ka)), [CU1, KA]));
  ok('kriter 11: vergi no / yetkili iletişim yok', !/Vergi|E-posta|Telefon/i.test(await viewText(Mb)));

  /* ---------------- kriter 10: Excel (üye) ---------------- */
  await gr(Mb, 'sure', { month: MON, row: 'customer', col: 'user' });
  const xs = await xlsx(Mb);
  const sOz = rowsOf(xs.sheets[0] || ''), sDt = rowsOf(xs.sheets[1] || '');
  const ozTot = (sOz.find(r => r[0] === 'TOPLAM') || []).slice(-1)[0];
  const dtHead = sDt[0] || [], dtSum = sDt.slice(1).filter(r => r[8] !== 'TOPLAM').reduce((a, r) => a + (typeof r[9] === 'number' ? r[9] : 0), 0);
  ok('Excel dosya adı genel-rapor-sure-2025-03.xlsx', xs.name === 'genel-rapor-sure-2025-03.xlsx', xs.name);
  ok('Excel iki sayfa: Özet + Detay', /<sheet name="Özet"/.test(xs.raw) && /<sheet name="Detay"/.test(xs.raw) && xs.sheets.length === 2);
  ok('Excel Özet toplamı = ekran', ozTot === 12.5, String(ozTot));
  ok('Excel Detay sütunları', dtHead.join('|') === 'Cari|Alan|Proje|Tarih|Kişi|İş|Açıklama|Tür|Faturalama|Saat', dtHead.join('|'));
  ok('Excel Detay saat toplamı = ekran, tarih gg.aa.yyyy', Math.abs(dtSum - 12.5) < 0.001 && sDt[1]?.[3] === '03.03.2025', `${dtSum} ${sDt[1]?.[3]}`);
  ok('kriter 8: Excel\'de gizli proje yok', !xs.raw.includes(KC) && !xs.raw.includes('Gizli') && !xs.raw.includes('Pasif Cari'));
  ok('Excel üstte dönem satırı', sOz.some(r => r[0] === 'Dönem' && r[1] === 'Mart 2025'));
  await gr(Mb, 'fatura', { month: MON });
  const xf = await xlsx(Mb), fOz = rowsOf(xf.sheets[0] || '');
  const fT = fOz.find(r => r[0] === 'TOPLAM') || [];
  ok('fatura Excel: TOPLAM F+FY=T ve ekranla aynı', xf.name === 'genel-rapor-fatura-2025-03.xlsx' && fT[1] === 10.5 && fT[2] === 2 && fT[3] === 12.5, JSON.stringify(fT));

  /* ---------------- kriter 12: boş durum ---------------- */
  await gr(Mb, 'sure', { month: MON, type: 'epic' });
  ok('kriter 12: boş durum metni', (await viewText(Mb)).includes('Bu süzgeçlerle süre kaydı yok'));
  let dl = false; Mb.once('download', () => { dl = true; });
  await Mb.click('[data-grxls]'); await sleep(400);
  ok('boşken Excel uyarı verir, dosya inmez', !dl && await Mb.evaluate(() => /Aktarılacak süre kaydı yok/.test(document.getElementById('toast').textContent)));
  await Mb.click('.gr-empty [data-grclear]'); await sleep(300);
  ok('"Süzgeçleri temizle" tabloyu geri getirir', await Mb.evaluate(() => !!document.querySelector('#grPv') && !DB.ui.grF.type));

  /* ---------------- kriter 9: izleyici Excel alır, düzenleme yok ---------------- */
  const Vb = await mk('viewer'); await login(Vb, 'grv' + RUN, 'Baslangic123', 'RaporIzl12345!');
  await gr(Vb, 'sure', { month: MON });
  ok('izleyici raporu görür (12,50)', (await total(Vb)) === 12.5);
  const xv = await xlsx(Vb);
  ok('izleyici Excel alır', xv.sheets.length === 2);
  await Vb.click('#grPv tbody .gr-c:not(:disabled)'); await sleep(200);
  ok('izleyicide kayıt listesinde düzenleme/silme yok', await Vb.evaluate(() => !document.querySelector('#grDrill [data-delwl], #grDrill input, #grDrill .danger')));

  /* ---------------- kriter 15: 375 px ---------------- */
  const Mm = await mk('mobil', { width: 375, height: 800 }); await login(Mm, 'grm' + RUN, 'RaporUye12345!');
  await gr(Mm, 'sure', { month: MON, row: 'project', col: 'user', ws: WS2 });
  const mob = await Mm.evaluate(() => ({ sw: document.documentElement.scrollWidth, fbtn: getComputedStyle(document.querySelector('[data-grsheet]')).display !== 'none',
    grid: getComputedStyle(document.querySelector('.gr-fgrid')).display, n: document.querySelector('[data-grsheet] .n').textContent.trim(),
    sticky: getComputedStyle(document.querySelector('#grPv tbody th.rh')).position }));
  ok('375px: sayfa yatay taşmaz', mob.sw <= 375, String(mob.sw));
  ok('375px: "Süzgeçler (n)" düğmesi, süzgeçler gizli', mob.fbtn && mob.grid === 'none' && mob.n === '1', JSON.stringify(mob));
  ok('375px: pivot ilk sütun sabit', mob.sticky === 'sticky');
  await Mm.click('[data-grsheet]'); await sleep(200);
  ok('375px: Süzgeçler paneli açılır', await Mm.evaluate(() => getComputedStyle(document.querySelector('.gr-fgrid')).display !== 'none'));
  await gr(Mm, 'fatura', { month: MON });
  ok('375px: Faturalanabilir kart listesi', await Mm.evaluate(() => getComputedStyle(document.querySelector('.gr-fc-list')).display !== 'none'
    && getComputedStyle(document.querySelector('.gr-ftwrap')).display === 'none' && document.documentElement.scrollWidth <= 375));
  await Mm.screenshot({ path: SS + 'mobil.png' });

  /* ---------------- koyu tema ---------------- */
  await A.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await gr(A, 'sure', { month: MON });
  ok('koyu tema ısı rengi', await A.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--gr-heat').trim().toUpperCase() === '#60A5FA'));
  await A.evaluate(() => { delete document.documentElement.dataset.theme; });

  /* ---------------- kriter 13: performans (50.000 kayıt / 10.000 iş / 200 proje, yalnız bellekte) ---------------- */
  const LIM = +(process.env.GR_PERF_MS || (process.env.CI ? 2000 : 1000)), LIM2 = LIM / 2;
  const perf = await A.evaluate(() => {
    clearInterval(pollT);
    const ps = [], is = [], ws = [], us = DB.users.map(u => u.id).concat(['u_x1', 'u_x2']);
    for (let k = 0; k < 200; k++) ps.push({ id: 'pp' + k, key: 'PF' + k, name: 'Perf ' + k, members: [], archived: k % 50 === 0, customerId: k % 3 ? null : (cuList()[k % cuList().length]?.id || null) });
    for (let k = 0; k < 10000; k++) is.push({ id: 'pi' + k, key: 'PF' + (k % 200) + '-' + k, projectId: 'pp' + (k % 200), type: ['task', 'bug', 'story'][k % 3], summary: 'İş ' + k,
      statusId: 'x', billable: k % 4 ? 'Faturalanacak' : 'Faturalanmayacak' });
    for (let k = 0; k < 50000; k++) ws.push({ id: 'pw' + k, issueId: 'pi' + (k * 7 % 10000), userId: us[k % us.length], date: `2025-03-${String(k % 28 + 1).padStart(2, '0')}`, hours: (k % 8 + 1) / 4, comment: '' });
    DB.projects = DB.projects.concat(ps); DB.issues = DB.issues.concat(is); DB.worklogs = DB.worklogs.concat(ws);
    DB.ui.grF = { month: '2025-03', row: 'project', col: 'user' }; DB.ui.grTab = 'sure'; DB.ui.view = 'greports';
    const v = document.getElementById('view');
    let t0 = performance.now(); v.innerHTML = renderGr(); const first = performance.now() - t0;
    DB.ui.grF.row = 'customer'; DB.ui.grF.col = 'month';
    t0 = performance.now(); v.innerHTML = renderGr(); const change = performance.now() - t0;
    DB.ui.grTab = 'fatura';
    t0 = performance.now(); v.innerHTML = renderGr(); const fat = performance.now() - t0;
    return { first, change, fat, logs: GR.last.logs.length };
  });
  ok(`kriter 13: 50.000 kayıtla ilk çizim < ${LIM} ms`, perf.first < LIM && perf.logs >= 50000, `${perf.first.toFixed(0)} ms, ${perf.logs} kayıt`);
  ok(`kriter 13: boyut değişimi < ${LIM2} ms`, perf.change < LIM2, perf.change.toFixed(0) + ' ms');
  ok(`kriter 13: fatura sekmesi < ${LIM2} ms`, perf.fat < LIM2, perf.fat.toFixed(0) + ' ms');
  await A.evaluate(() => reloadState()); await sleep(1000);
  ok('performans verisi sunucuya gitmedi', await A.evaluate(async () => !(await API.get('/api/state')).data.worklogs.some(w => w.id === 'pw1')));

  ok('sayfa hatası yok', !errs.length, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} test BAŞARISIZ` : '\nTüm genel rapor testleri geçti');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
