// Cariler CSV içe / dışa aktarma tarayıcı testi.
// Ön koşullar regresyon.cjs ile aynı (sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100,
// demo veri yüklü). Sonra: node test/e2e/cari-csv.cjs  (BASE_URL ile adres değiştirilebilir; SHOT_DIR verilirse
// önizleme penceresinin ekran görüntüsü oraya da yazılır). Veriler uydurmadır; tekrar çalıştırmada çakışmaz.
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_csv_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const T = '7' + String(Date.now()).slice(-6);            // 7 hane; vergi numaraları buna 3 hane ekler (10 hane)
const tx = n => T + String(n).padStart(3, '0');
const M = 'u_csvm' + RUN;
/* windows-1254 (Excel'in Türkçe ANSI CSV çıktısı) kodlayıcı: ASCII + Türkçe harfler yeter. */
const W1254 = { 'ç': 0xE7, 'Ç': 0xC7, 'ğ': 0xF0, 'Ğ': 0xD0, 'ı': 0xFD, 'İ': 0xDD, 'ö': 0xF6, 'Ö': 0xD6, 'ş': 0xFE, 'Ş': 0xDE, 'ü': 0xFC, 'Ü': 0xDC };
const enc1254 = s => Buffer.from([...s].map(c => c.charCodeAt(0) < 128 ? c.charCodeAt(0) : W1254[c] ?? 0x3F));

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, o = {}) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...o });
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
  const view = async (p, v) => { await p.evaluate(v => { closeModal(); DB.ui.view = v; render(); }, v); await sleep(250); };
  const srvAll = p => p.evaluate(async () => (await API.get('/api/state')).data.customers || []);
  const byTax = (list, t) => list.find(c => c.taxNo === t);
  const counts = p => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-cucn]')].map(e => [e.dataset.cucn, +e.textContent])));
  const result = p => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-cucr]')].map(e => [e.dataset.cucr, +e.textContent])));
  const rowOf = (p, n) => p.evaluate(n => { const r = document.querySelector(`[data-cucrow="${n}"]`);
    return r ? { act: r.dataset.act, why: r.querySelector('.cuc-why').textContent, name: r.children[2].textContent, bg: getComputedStyle(r.children[0]).backgroundColor } : null; }, n);
  const upload = async (p, name, buf) => {
    await p.evaluate(() => cuCsvOpen()); await sleep(150);
    await p.setInputFiles('#cuc_file', { name, mimeType: 'text/csv', buffer: buf });
    await p.waitForSelector('#cuc_body .cuc-sum, #cuc_block', { timeout: 5000 });
  };
  const runImport = async p => { await p.click('#cuc_run'); await p.waitForSelector('#cuc_res', { timeout: 20000 }); await sleep(150); };
  const dl = async (p, fn) => { const [d] = await Promise.all([p.waitForEvent('download'), p.evaluate(fn)]); return { name: d.suggestedFilename(), buf: fs.readFileSync(await d.path()) }; };

  const A = await mk('admin', { deviceScaleFactor: 2 }); await login(A, 'admin', 'admin12345');
  await A.evaluate(async ([R, M]) => {
    await API.post('/api/sync', { changes: [{ c: 'users', id: M, op: 'put', data: { username: 'csvm' + R, name: 'CSV Üye ' + R, role: 'member', active: true, ini: 'CÜ', color: '#0F766E' } }] });
    await reloadState();
  }, [RUN, M]);
  /* kayıtlı cari: CSV'deki aynı vergi numarası buna eşleşir */
  const EX = 'cu_csvex' + RUN;
  await A.evaluate(async ([id, R, t]) => {
    await API.post('/api/sync', { changes: [{ c: 'customers', id, op: 'put', data: { name: `Kayıtlı Cari ${R} A.Ş.`, kind: 'supplier', taxNo: t, phone: '0312 111 11 11', active: true,
      contacts: [{ id: 'ct_csv1', name: 'Yetkili Kişi' }] } }] });
    await reloadState();
  }, [EX, RUN, tx(1)]);

  // 1) üye: Cariler ekranı ve düğmeler yok; işlevler de reddeder
  const Mb = await mk('member'); await login(Mb, 'csvm' + RUN, 'Baslangic123', 'CsvUye12345!');
  ok('member: no import/export buttons, customers view not reachable', await Mb.evaluate(() => { DB.ui.view = 'customers'; render();
    return DB.ui.view !== 'customers' && !document.querySelector('[data-cuimp],[data-cuexp]'); }));
  ok('member: cuCsvOpen / cuCsvExport refuse', await Mb.evaluate(() => { cuCsvOpen(); const a = !document.querySelector('#cuc_file');
    const t1 = document.getElementById('toast').textContent; cuCsvExport(); return a && /yalnızca yöneticiler/.test(t1) && /yalnızca yöneticiler/.test(document.getElementById('toast').textContent); }));

  // 2) yönetici: düğmeler
  await view(A, 'customers');
  ok('admin: "İçe aktar" and "Dışa aktar (CSV)" buttons', await A.evaluate(() => /İçe aktar/.test(document.querySelector('.cu-tools [data-cuimp]')?.textContent || '')
    && /Dışa aktar \(CSV\)/.test(document.querySelector('.cu-tools [data-cuexp]')?.textContent || '')));

  // 3) Excel Türkçe ";" çıktısı: BOM'lu UTF-8, tırnak içinde ayırıcı ve yeni satır, eşlenmeyen sütun (Şehir)
  const XSS = '<img src=x onerror="window.__xss=1">';
  const semi = [
    'Unvan;Tür;Vergi No;Vergi Dairesi;E-posta;Telefon;Notlar;Şehir',
    `Çağrı Şişman Danışmanlık ${RUN} Ltd. Şti.;Müşteri;${tx(2)};Kadıköy;bilgi@cagri.com.tr;0216 000 00 00;"İki satırlık; not\nikinci ""satır""";İstanbul`,   // 2
    `"Noktalı; Virgüllü ${RUN} A.Ş.";Tedarikçi;${tx(3)};;;;;Ankara`,                                                        // 3
    `Hatalı Posta ${RUN};Müşteri;${tx(4)};;a b@ornek.com;;;`,                                                             // 4
    `;Müşteri;${tx(5)};;;;;`,                                                                                              // 5 unvan yok
    `Kısa Vergi ${RUN};Müşteri;12345;;;;;`,                                                                                // 6
    `Yinelenen ${RUN};İkisi;${tx(2)};;;;;`,                                                                                // 7 dosyada yinelenen
    `Kayıtlı Güncel ${RUN};;${tx(1)};;;0312 999 99 99;;`,                                                                  // 8 kayıtlı cari
    `${XSS} ${RUN};Bilinmeyen;${tx(9)};;;;;`,                                                                              // 9 tür tanınmadı
    '',
    `Onbir Hane Kişi ${RUN};müşteri;${T}0046;;;;;`,                                                                             // 11 (boş satır atlandı) 11 hane: yalnız VKN
  ].join('\r\n');
  await upload(A, 'cariler-excel.csv', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(semi, 'utf8')]));
  const hd = await A.evaluate(() => ({ src: document.getElementById('cuc_src').textContent, map: [...document.querySelectorAll('[data-cucmap]')].map(s => s.value),
    firstHead: document.querySelector('#cuc_map label span').textContent }));
  ok('";" detected, BOM stripped from first header, headers auto-mapped (Şehir not mapped)', /ayırıcı: noktalı virgül/.test(hd.src) && hd.firstHead === 'Unvan'
    && hd.map.join(',') === 'name,kind,taxNo,taxOffice,email,phone,notes,', JSON.stringify(hd));
  let c = await counts(A);
  ok('preview counts: 2 add, 1 update, 0 skip, 6 error', c.add === 2 && c.update === 1 && c.skip === 0 && c.error === 6, JSON.stringify(c));
  const r4 = await rowOf(A, 4), r5 = await rowOf(A, 5), r6 = await rowOf(A, 6), r7 = await rowOf(A, 7), r9 = await rowOf(A, 9);
  ok('error rows red with reason: e-posta, unvan, vergi no, yinelenen, tür', r4?.act === 'error' && /E-posta adresi geçersiz/.test(r4.why)
    && /Unvan boş/.test(r5?.why) && /Vergi no 10 haneli \(VKN\) olmalı/.test(r6?.why) && /dosyada yineleniyor \(satır 2\)/.test(r7?.why) && /Tür tanınmadı/.test(r9?.why)
    && r4.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify([r4, r7]));
  ok('errors listed first; quoted ";" kept in name; XSS shown as text', await A.evaluate(() => document.querySelector('#cuc_body tbody tr').dataset.act === 'error')
    && (await rowOf(A, 3))?.name === `Noktalı; Virgüllü ${RUN} A.Ş.` && r9.name.startsWith('<img') && await A.evaluate(() => window.__xss === undefined));
  const r11 = await rowOf(A, 11);
  ok('row 8 matches existing by tax no → update; row 11 (after blank line, 11 digits) rejected as non-VKN, no TCKN notice', (await rowOf(A, 8))?.act === 'update'
    && r11?.act === 'error' && /Vergi no 10 haneli \(VKN\) olmalı/.test(r11.why) && await A.evaluate(() => !document.getElementById('cuc_kvkk')
      && !/TCKN|T\.C\. kimlik/.test(document.querySelector('#scrim .modal').textContent)), JSON.stringify(r11));
  ok('run button counts importable rows', await A.evaluate(() => /3 cariyi aktar/.test(document.getElementById('cuc_run').textContent) && !document.getElementById('cuc_run').disabled));
  await A.screenshot({ path: SS + 'onizleme.png' });
  if (process.env.SHOT_DIR) await A.screenshot({ path: process.env.SHOT_DIR + '/cari-csv-onizleme.png' });
  /* Atla seçeneği */
  await A.click('[data-cucmode="skip"]'); await sleep(100);
  c = await counts(A);
  ok('"Atla": existing match becomes skipped', c.add === 2 && c.update === 0 && c.skip === 1 && (await rowOf(A, 8))?.act === 'skip', JSON.stringify(c));
  await A.click('[data-cucmode="update"]'); await sleep(100);
  /* eşlemeyi kaldır: Unvan zorunlu */
  await A.selectOption('[data-cucmap="0"]', ''); await sleep(100);
  ok('unmapped Unvan blocks import', await A.evaluate(() => /Unvan sütununu eşleyin/.test(document.getElementById('cuc_block')?.textContent || '') && document.getElementById('cuc_run').disabled));
  await A.selectOption('[data-cucmap="0"]', 'name'); await A.selectOption('[data-cucmap="7"]', 'name'); await sleep(100);
  ok('same field mapped twice blocks import', await A.evaluate(() => /birden çok sütuna/.test(document.getElementById('cuc_block')?.textContent || '')));
  await A.selectOption('[data-cucmap="7"]', ''); await sleep(100);
  /* yalnız hatalılar */
  await A.click('#cuc_erronly'); await sleep(100);
  ok('"Yalnız hatalılar" filter', await A.evaluate(() => [...document.querySelectorAll('#cuc_body tbody tr')].every(r => r.dataset.act === 'error')
    && document.querySelectorAll('#cuc_body tbody tr').length === 6));
  await runImport(A);
  let rs = await result(A);
  ok('result summary: 2 added, 1 updated, 0 skipped, 6 errors', rs.add === 2 && rs.update === 1 && rs.skip === 0 && rs.error === 6, JSON.stringify(rs));
  let all = await srvAll(A);
  const c2 = byTax(all, tx(2)), ex = all.find(x => x.id === EX);
  ok('server: Turkish chars and quoted multi-line note with ";" and ""', c2?.name === `Çağrı Şişman Danışmanlık ${RUN} Ltd. Şti.` && c2.notes === 'İki satırlık; not\nikinci "satır"'
    && c2.kind === 'customer' && c2.taxOffice === 'Kadıköy' && c2.active === true, JSON.stringify(c2));
  ok('server: update keeps empty cells and contacts, changes phone + name', ex?.phone === '0312 999 99 99' && ex.name === `Kayıtlı Güncel ${RUN}` && ex.kind === 'supplier'
    && ex.contacts?.length === 1, JSON.stringify(ex));
  ok('server: invalid rows not written; 11-digit row not written', !byTax(all, tx(4)) && !byTax(all, tx(5)) && !byTax(all, tx(9)) && !byTax(all, T + '0046'));
  ok('list shows imported customers', await A.evaluate(r => { closeModal(); CU_Q = r; render(); return document.querySelectorAll('#cuList tr.cu-row').length; }, RUN) >= 3);

  // 4) "," ayırıcı, BOM'suz windows-1254 (Excel ANSI); tekillik: kayıtlı vergi no "Atla", sunucu çakışmayı reddeder
  const comma = [
    'Unvan,Tür,VKN,E-posta',
    `Gökçe Ilık Ürün ${RUN} San. Tic.,Tedarikçi,${tx(20)},`,
    `"Virgül, İçeren ${RUN}",Müşteri,${tx(21)},satis@ornek.com.tr`,
    `Yeniden Kayıtlı ${RUN},Müşteri,${tx(2)},`,
    `Yarışan ${RUN},Müşteri,${tx(22)},`,
  ].join('\n');
  await upload(A, 'ansi.csv', enc1254(comma));
  await A.click('[data-cucmode="skip"]'); await sleep(100);
  c = await counts(A);
  ok('"," detected; windows-1254 decoded; existing tax no skipped', /ayırıcı: virgül/.test(await A.textContent('#cuc_src'))
    && (await rowOf(A, 2))?.name === `Gökçe Ilık Ürün ${RUN} San. Tic.` && (await rowOf(A, 3))?.name === `Virgül, İçeren ${RUN}`
    && (await rowOf(A, 4))?.act === 'skip' && c.add === 3 && c.skip === 1, JSON.stringify(c));
  /* önizlemeden sonra başka biri aynı vergi numarasını kaydetti: sunucu reddeder, satır nedeniyle raporlanır */
  await A.evaluate(async ([R, t]) => { await API.post('/api/sync', { changes: [{ c: 'customers', id: 'cu_race' + R, op: 'put', data: { name: `Önce Gelen ${R}`, kind: 'customer', taxNo: t } }] }); }, [RUN, tx(22)]);
  await runImport(A);
  rs = await result(A);
  const why5 = await A.evaluate(() => document.querySelector('[data-cucerr="5"] .cuc-why')?.textContent || '');
  ok('server rejection reported per row with readable reason', rs.add === 2 && rs.skip === 1 && rs.error === 1 && why5 === `Bu vergi numarasıyla kayıtlı cari var: Önce Gelen ${RUN}`, JSON.stringify(rs) + ' ' + why5);
  all = await srvAll(A);
  ok('server: ANSI Turkish name stored correctly, only one record per tax no', byTax(all, tx(20))?.name === `Gökçe Ilık Ürün ${RUN} San. Tic.` && byTax(all, tx(20)).kind === 'supplier'
    && all.filter(x => x.taxNo === tx(22)).length === 1 && all.filter(x => x.taxNo === tx(2)).length === 1);

  // 5) yapıştırma (sekme ayırıcı) ve geçersiz içerik
  await A.evaluate(() => cuCsvOpen()); await sleep(100);
  await A.fill('#cuc_paste', `Unvan\tTür\tVergi no / TCKN\nSekmeli ${RUN}\tİkisi\t${tx(30)}`);
  await A.click('#cuc_go'); await sleep(150);
  ok('paste with tab separator', /ayırıcı: sekme/.test(await A.textContent('#cuc_src')) && (await rowOf(A, 2))?.act === 'add');
  await runImport(A);
  ok('pasted row imported (kind both)', byTax(await srvAll(A), tx(30))?.kind === 'both');

  // 6) dışa aktarma: görünen liste, ";" ayırıcı, BOM'lu UTF-8, formül kaçışı
  await A.evaluate(async ([R, t]) => {
    await API.post('/api/sync', { changes: [{ c: 'customers', id: 'cu_fx' + R, op: 'put', data: { name: `=HYPERLINK("http://x","tıkla") ${R}`, shortName: '-2+3',
      kind: 'customer', taxNo: t, phone: '+90 555 000 00 00', notes: '@SUM(A1)', address: 'Satır 1\nSatır 2; daire 3', active: false } }] });
    await reloadState(); closeModal(); DB.ui.view = 'customers'; DB.ui.cuPassive = true; DB.ui.cuKind = 'all'; CU_Q = R; render();
  }, [RUN, tx(40)]);
  const shown = await A.evaluate(() => [...document.querySelectorAll('#cuList tr.cu-row')].length);
  const ex1 = await dl(A, () => document.querySelector('.cu-tools [data-cuexp]').click());
  const txt = ex1.buf.toString('utf8');
  const lines = txt.slice(1).split('\r\n').filter(Boolean);
  ok('export: BOM UTF-8, ";" header, file name', ex1.buf[0] === 0xEF && ex1.buf[1] === 0xBB && ex1.buf[2] === 0xBF && /^cariler-\d{4}-\d{2}-\d{2}\.csv$/.test(ex1.name)
    && lines[0] === 'Unvan;Kısa ad;Tür;Vergi dairesi;Vergi no;Adres;Telefon;E-posta;Notlar;Durum', lines[0]);
  const fx = txt.split('\r\n').find(l => l.includes(tx(40))) || '';
  ok('export: formula cells prefixed with \' (= + - @), quotes doubled', fx.startsWith(`"'=HYPERLINK(""http://x"",""tıkla"") ${RUN}";'-2+3;Müşteri;;${tx(40)};"Satır 1\nSatır 2; daire 3";'+90 555 000 00 00;;'@SUM(A1);Pasif`), fx);
  /* görünen (süzülmüş) liste: satır sayısı ekranla aynı; tür süzgeci uygulanır */
  const nRec = await A.evaluate(t => csvParse(t.replace(/^﻿/, ''), ';').length - 1, txt);
  ok('export: only visible (filtered) rows', nRec === shown && shown >= 8, `${nRec} / ${shown}`);
  await A.evaluate(() => { DB.ui.cuKind = 'supplier'; render(); });
  const ex2 = await dl(A, () => cuCsvExport());
  const sup = await A.evaluate(t => csvParse(t.replace(/^﻿/, ''), ';').slice(1).map(r => r.cells[2]), ex2.buf.toString('utf8'));
  ok('export respects kind filter', sup.length >= 2 && sup.every(k => k === 'Tedarikçi' || k === 'İkisi'), JSON.stringify(sup));
  /* dışa aktarılan dosya geri yüklenince değişiklik yok (' öneki geri alınır) */
  await A.evaluate(() => { DB.ui.cuKind = 'all'; render(); });
  await upload(A, ex1.name, ex1.buf);
  c = await counts(A);
  ok('re-import of exported file: nothing to change (round trip, \' prefix undone)', c.add === 0 && c.update === 0 && c.error === 0 && c.skip === nRec
    && await A.evaluate(() => document.getElementById('cuc_run').disabled), JSON.stringify(c));
  await A.evaluate(() => closeModal());

  // 7) örnek şablon
  await A.evaluate(() => cuCsvOpen()); await sleep(100);
  const tp = await dl(A, () => document.getElementById('cuc_tpl').click());
  const tpt = tp.buf.toString('utf8');
  ok('template: BOM, header, quoted sample note', tp.name === 'cari-sablon.csv' && tp.buf[0] === 0xEF && tpt.slice(1).startsWith('Unvan;Kısa ad;Tür;')
    && tpt.includes('"Notlar ""tırnak"" ve ; içerebilir"'));
  await A.setInputFiles('#cuc_file', { name: 'cari-sablon.csv', mimeType: 'text/csv', buffer: tp.buf });
  await A.waitForSelector('#cuc_body .cuc-sum');
  c = await counts(A);
  ok('template parses without errors', c.error === 0 && c.add + c.update + c.skip === 2, JSON.stringify(c));
  await A.evaluate(() => closeModal());

  ok('no XSS executed', await A.evaluate(() => window.__xss === undefined));
  console.log(errs.length ? errs.join('\n') : 'no page errors / dialogs / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
