// Cariler tarayıcı testi (issue #11, docs/tasarim/cariler).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/cariler.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kullanıcılarını ve
// carilerini oluşturur (uydurma veri); diğer tarayıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_cu_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* Eski 11 haneli vergi no (T.C. kimlik no) artık arayüzden ve canlı yazmayla girilmez: eski kaydı veritabanına doğrudan
   yazarız (DATABASE_URL, CI'daki sunucuyla aynı). Değişiklik akışına da düşer (yoklama görür). */
async function legacyTax(id, tx) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL gerekli (eski 11 haneli vergi no kaydı için)');
  const { Client } = require('pg'); const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  try {
    await db.query(`UPDATE customers SET data = data || jsonb_build_object('taxNo', $2::text), version = version + 1 WHERE id = $1`, [id, tx]);
    await db.query(`INSERT INTO changes (collection, record_id, op) VALUES ('customers', $1, 'put')`, [id]);
  } finally { await db.end(); }
}
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);            // tekrar çalıştırmada çakışmasın
const T = '5' + String(Date.now()).slice(-6);             // 7 hane; vergi numaraları buna ekle
const TAX_A = T + '001', TAX_B = T + '002', TC_X = T + '0046';
const M = 'u_cum' + RUN, V = 'u_cuv' + RUN;
const XSS = '<img src=x onerror="window.__xss=1">';
const NAME_A = `Örnek Şirket ${RUN} Ltd. Şti.`;
const ID = { B: 'cu_b' + RUN, C: 'cu_c' + RUN, D: 'cu_d' + RUN, X: 'cu_x' + RUN };

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
  const view = async (p, v) => { await p.evaluate(v => { closeModal(); DB.ui.view = v; render(); }, v); await sleep(250); };
  const waitFor = async (p, fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const flush = p => p.evaluate(() => flushAll());
  const srv = (p, c, id) => p.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c]?.find(x => x.id === id) || null, [c, id]);
  const rowNames = p => p.evaluate(() => [...document.querySelectorAll('#cuList tr.cu-row .cu-nm')].map(e => e.textContent));
  const mine = names => names.filter(n => n.includes(RUN));
  const setQ = async (p, q) => { await p.fill('#cuQ', q); await sleep(80); };
  const errText = (p, id) => p.evaluate(id => document.getElementById(id)?.textContent.trim() || '', id);

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* ---- kullanıcılar: üye M ve izleyici V (p1 üyesi) ---- */
  await A.evaluate(async ([R, M, V]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: M, op: 'put', data: { username: 'cum' + R, name: 'Cari Üye ' + R, role: 'member', active: true, ini: 'CÜ', color: '#0F766E' } },
      { c: 'users', id: V, op: 'put', data: { username: 'cuv' + R, name: 'Cari İzleyici ' + R, role: 'viewer', active: true, ini: 'Cİ', color: '#64748B' } },
    ] });
    await reloadState();
    const p = DB.projects.find(x => x.id === 'p1'); p.members = [...new Set([...(p.members || []), M, V])];
    save(); await flushAll();
  }, [RUN, M, V]);
  const Mb = await mk('member'); await login(Mb, 'cum' + RUN, 'Baslangic123', 'CariUye12345!');
  const Vb = await mk('viewer'); await login(Vb, 'cuv' + RUN, 'Baslangic123', 'CariIzl12345!');

  // 1) menü yalnız sistem yöneticisinde (22b); üye ve izleyici seçicilerde cari adlarını görmeye devam eder
  ok('menu: "Cariler" visible for admin', await A.evaluate(() => { const a = document.querySelector('.nav a[data-v="customers"]');
    /* Cariler genel ekran: proje sekmesi değil; dar ekranda ☰ çekmecedeki aynı sol menüden açılır. */
    return !!a && a.offsetParent !== null && a.textContent.trim() === 'Cariler' && !!a.closest('#rail') && !document.querySelector('#vtabs [data-v="customers"]'); }));
  for (const [n, p] of [['member', Mb], ['viewer', Vb]]) {
    ok(`menu: "Cariler" hidden for ${n} (22b), #customers not reachable`, await p.evaluate(() => { const a = !!document.querySelector('[data-v="customers"]');
      DB.ui.view = 'customers'; render(); return !a && DB.ui.view !== 'customers'; }));
  }

  // 2) boş durum (yalnız henüz hiç cari yoksa — temiz veritabanında)
  const initial = await A.evaluate(() => (DB.customers || []).length);
  for (const p of [A, Mb, Vb]) await view(p, 'customers');
  if (initial === 0) {
    ok('empty state admin: "Henüz cari yok" + "Cari ekle"', await A.evaluate(() => { const e = document.querySelector('[data-cuempty="none"]');
      return !!e && e.querySelector('h3').textContent === 'Henüz cari yok' && !!e.querySelector('[data-cunew]'); }));
    for (const [n, p] of [['member', Mb], ['viewer', Vb]])
      ok(`empty state ${n}: ask your admin, no add button`, await p.evaluate(() => { const e = document.querySelector('[data-cuempty="none"]');
        return !!e && /Cari eklemek için yöneticinize başvurun/.test(e.textContent) && !document.querySelector('[data-cunew]'); }));
  } else console.log('SKIP empty-state checks (veritabanında cari var: ' + initial + ')');
  ok('crumb/title: Yönetim · Cariler', await A.evaluate(() => document.querySelector('#title').textContent === 'Cariler' && /Yönetim/.test(document.querySelector('#crumb').textContent)));

  // 3) ekle: zorunlu alan uyarıları, e-posta biçimi, adsız kişi
  await A.click('[data-cunew]'); await sleep(250);
  const nf = await A.evaluate(() => ({ t: document.getElementById('cu_t')?.textContent, del: !!document.getElementById('cu_del'),
    act: document.getElementById('cu_act')?.getAttribute('aria-checked'), role: document.querySelector('#scrim .modal')?.getAttribute('role'),
    hint: document.getElementById('cu_no_h')?.textContent || '' }));
  ok('new customer dialog: title, active by default, no delete, KVKK hint', nf.t === 'Yeni cari' && !nf.del && nf.act === 'true' && nf.role === 'dialog'
    && /Kişisel veya hassas bilgi yazmayın/.test(nf.hint) && !/T\.C\./.test(nf.hint), JSON.stringify(nf));
  ok('no TCKN input/label in form: tax no is 10-digit VKN', await A.evaluate(() => { const t = document.querySelector('#scrim .modal').textContent;
    return !/TCKN|T\.C\. kimlik/i.test(t) && document.getElementById('cu_vn_h')?.textContent === '10 hane VKN' && !document.getElementById('cu_vn_old'); }));
  await A.click('#cu_ok'); await sleep(150);
  ok('required: Unvan + Tür warnings under fields, dialog stays open', await errText(A, 'cu_n_e') === 'Unvan gerekli' && await errText(A, 'cu_k_e') === 'Tür seçin'
    && await A.evaluate(() => document.activeElement.id === 'cu_n' && document.getElementById('cu_n').getAttribute('aria-invalid') === 'true'));
  await A.fill('#cu_n', NAME_A); await A.click('[data-cuk="customer"]');
  await A.fill('#cu_vn', `${TAX_A.slice(0, 3)} ${TAX_A.slice(3, 6)}-${TAX_A.slice(6)}`);
  await A.fill('#cu_vd', 'Örnek Vergi Dairesi'); await A.fill('#cu_p', '0312 555 01 23'); await A.fill('#cu_m', 'yanlis@');
  await A.click('#cu_add'); await A.fill('#ct_0_name', 'Elif Deneme'); await A.fill('#ct_0_email', 'elif.deneme@ornek.example');
  await A.click('#cu_add'); await A.fill('#ct_1_title', 'Muhasebe');
  await A.click('#cu_ok'); await sleep(150);
  ok('email format + nameless contact rejected in client', await errText(A, 'cu_m_e') === 'E-posta adresi geçersiz'
    && await A.evaluate(() => /Ad zorunlu/.test(document.querySelector('[data-ctrow="1"]')?.textContent || '')) && await A.isVisible('#cu_ok'));
  await A.fill('#cu_vn', '123 456 789');
  await A.click('#cu_ok'); await sleep(100);
  ok('9-digit tax no rejected', await errText(A, 'cu_vn_e') === 'Vergi numarası 10 haneli olmalı');
  await A.fill('#cu_vn', '1234 567 8901');
  await A.click('#cu_ok'); await sleep(100);
  ok('11-digit tax no (TCKN) rejected in client', await errText(A, 'cu_vn_e') === 'Vergi numarası 10 haneli olmalı');
  await A.fill('#cu_vn', `${TAX_A.slice(0, 3)} ${TAX_A.slice(3, 6)}-${TAX_A.slice(6)}`);
  await A.fill('#cu_m', 'info@ornek-sirket.example'); await A.fill('#ct_1_name', 'Murat Örnek');
  await A.fill('#cu_no', 'Yıllık bakım sözleşmesi.');
  await A.click('#cu_ok'); await sleep(200); await flush(A);
  const idA = await A.evaluate(n => DB.customers.find(c => c.name === n)?.id, NAME_A);
  const sA = idA && await srv(A, 'customers', idA);
  ok('customer saved on server (tax no cleaned, active:true, 2 contacts)', !!sA && sA.taxNo === TAX_A && sA.active === true && sA.kind === 'customer'
    && sA.contacts?.length === 2 && sA.contacts.every(x => x.id && x.name), JSON.stringify(sA));
  ok('dialog closed after save', await A.evaluate(() => !document.getElementById('scrim').classList.contains('on')));

  /* diğer cariler (uydurma) + 500 toplu cari */
  await A.evaluate(async ([R, ID, TB, TCX, XSS]) => {
    const ch = [
      { c: 'customers', id: ID.B, op: 'put', data: { name: `Deneme Tedarik ${R} A.Ş.`, kind: 'supplier', taxNo: TB, active: true, contacts: [] } },
      { c: 'customers', id: ID.C, op: 'put', data: { name: `Test İkisi Ticaret ${R}`, kind: 'both', active: true, contacts: [] } },
      { c: 'customers', id: ID.D, op: 'put', data: { name: `Eski Pasif Firma ${R}`, kind: 'customer', active: false, contacts: [] } },
      { c: 'customers', id: ID.X, op: 'put', data: { name: `${XSS} Mali Müşavir ${R}`, shortName: XSS, kind: 'supplier', active: true,
        notes: XSS, contacts: [{ id: 'ct_x' + R, name: XSS, email: 'x@ornek.example' }] } },
    ];
    for (let k = 0; k < 500; k++) ch.push({ c: 'customers', id: `cu_t${R}_${k}`, op: 'put', data: { name: `Toplu Cari ${R} ${k}`, kind: k % 2 ? 'customer' : 'supplier',
      active: true, contacts: [{ id: `ct_t${R}_${k}`, name: `Kişi ${k}`, email: `kisi${k}@toplu.example` }] } });
    const r = await API.post('/api/sync', { changes: ch });
    if (r.rejected?.length) throw new Error(JSON.stringify(r.rejected[0]));
    /* canlı yazmada 11 hane reddedilir (yalnız kimlik ve ileti, değer yok) */
    const t = await API.post('/api/sync', { changes: [{ c: 'customers', id: ID.X + 'tc', op: 'put', data: { name: 'TC', kind: 'customer', taxNo: TCX } }] });
    window.__tcRej = t.rejected?.[0]?.reason;
  }, [RUN, ID, TAX_B, TC_X, XSS]);
  ok('server rejects new 11-digit tax no', await A.evaluate(() => window.__tcRej === 'Vergi numarası 10 haneli olmalı'));
  await legacyTax(ID.X, TC_X);
  await A.evaluate(() => reloadState());
  await view(A, 'customers');

  // 4) liste: sıralama, süzgeçler, pasif rozeti
  let names = mine(await rowNames(A));
  ok('list sorted by name (tr) and passive hidden by default', names.length === 504 && !names.some(n => n.startsWith('Eski Pasif'))
    && names.every((n, k) => !k || names[k - 1].localeCompare(n, 'tr') <= 0), names.slice(0, 5).join(' | '));
  const h1 = await A.evaluate(() => ({ th: [...document.querySelectorAll('.cu-tbl th')].map(t => t.textContent.trim()),
    tax: [...document.querySelectorAll('#cuList tr.cu-row')].find(r => r.textContent.includes('Örnek Şirket'))?.querySelector('.cu-tax')?.textContent }));
  ok('table columns + tax no shown', h1.th.slice(0, 5).join(',') === 'Unvan,Tür,Vergi no,Projeler,Durum' && (h1.tax || '').includes(TAX_A), JSON.stringify(h1));
  await A.click('[data-cupas]'); await sleep(150);
  ok('"Pasifleri de göster" shows passive with "Pasif" badge', await A.evaluate(r => { const row = [...document.querySelectorAll('#cuList tr.cu-row')].find(x => x.textContent.includes('Eski Pasif Firma ' + r));
    return !!row && row.classList.contains('is-off') && row.querySelector('.cu-st.off')?.textContent.trim() === 'Pasif'; }, RUN));
  await A.click('[data-cukind="supplier"]'); await sleep(150);
  names = mine(await rowNames(A)).filter(n => !n.startsWith('Toplu'));
  ok('kind filter "Tedarikçi" includes "İkisi"', names.length === 3 && names.some(n => n.startsWith('Deneme Tedarik')) && names.some(n => n.startsWith('Test İkisi'))
    && !names.some(n => n.startsWith('Örnek Şirket')), names.join(' | '));
  await A.click('[data-cukind="both"]'); await sleep(150);
  names = mine(await rowNames(A));
  ok('kind filter "İkisi" only both', names.length === 1 && names[0].startsWith('Test İkisi'), names.join(' | '));
  await A.click('[data-cukind="all"]'); await A.click('[data-cupas]'); await sleep(150);

  // 5) arama: tr harf/büyük-küçük duyarsız, vergi no (boşluklu), yetkili e-postası; 500 caride < 1 sn; odak korunur
  await setQ(A, 'şirket ' + RUN);
  ok('search "şirket" finds unvan', JSON.stringify(mine(await rowNames(A))) === JSON.stringify([NAME_A]) && await A.evaluate(() => document.activeElement.id === 'cuQ'));
  await setQ(A, 'SIRKET ' + RUN.toUpperCase());
  ok('search "SIRKET" (case/diacritic-insensitive)', JSON.stringify(mine(await rowNames(A))) === JSON.stringify([NAME_A]));
  await setQ(A, `${TAX_B.slice(0, 4)} ${TAX_B.slice(4, 7)}-${TAX_B.slice(7)}`);
  ok('search by tax no with spaces/dashes', (await rowNames(A)).length === 1 && (await rowNames(A))[0].startsWith('Deneme Tedarik'));
  await setQ(A, 'ELİF.deneme@ornek');
  ok('search by contact e-mail', JSON.stringify(await rowNames(A)) === JSON.stringify([NAME_A]));
  const perf = await A.evaluate(r => { const el = document.getElementById('cuQ'), t0 = performance.now();
    el.value = 'kisi499@toplu'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const t1 = performance.now(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
    const t2 = performance.now(); render(); const t3 = performance.now();
    return { one: t1 - t0, all: t2 - t1, full: t3 - t2, n: document.querySelectorAll('#cuList tr.cu-row').length }; }, RUN);
  ok('500+ customers: search and full list render < 1 s', perf.one < 1000 && perf.all < 1000 && perf.full < 1000 && perf.n >= 504, JSON.stringify(perf));
  await setQ(A, 'yokboyle' + RUN);
  const em = await A.evaluate(() => { const e = document.querySelector('[data-cuempty="search"]'); return e && { h: e.querySelector('h3').textContent, b: !!e.querySelector('[data-cuclear]') }; });
  ok('no-match empty state + "Süzgeçleri temizle"', em?.h === 'Aramanızla eşleşen cari yok' && em.b, JSON.stringify(em));
  ok('search text is not written to DB.ui (prefs)', await A.evaluate(r => !JSON.stringify(DB.ui).includes('yokboyle' + r) && !JSON.stringify(DB.board).includes('yokboyle' + r), RUN));
  await A.click('[data-cuclear]'); await sleep(150);
  ok('clear filters restores list', await A.evaluate(() => document.getElementById('cuQ').value === '' && document.querySelectorAll('#cuList tr.cu-row').length >= 504));

  // 6) çift vergi no: istemcide unvanlı ileti + "Kartı aç"; sunucuda ret (yalnız kimlik) → bildirimde unvan + "Kartı aç"
  await A.click('.cu-tools [data-cunew]'); await sleep(200);
  await A.fill('#cu_n', 'Kopya Cari ' + RUN); await A.click('[data-cuk="supplier"]'); await A.fill('#cu_vn', TAX_A);
  await A.click('#cu_ok'); await sleep(150);
  const dupE = await errText(A, 'cu_vn_e');
  ok('duplicate tax no: message with other customer name', dupE.startsWith('Bu vergi numarasıyla kayıtlı cari var: ' + NAME_A) && /Kartı aç/.test(dupE), dupE);
  await A.click('#cu_vn_e a[data-cuopen]'); await sleep(250);
  ok('"Kartı aç" opens the other card', await A.evaluate(n => document.getElementById('cu_n')?.value === n, NAME_A));
  await A.evaluate(() => closeModal());
  const rej = await A.evaluate(async t => (await API.post('/api/sync', { changes: [{ c: 'customers', id: 'cu_dup' + Date.now(), op: 'put',
    data: { name: 'Kopya', kind: 'customer', taxNo: t, active: true } }] })).rejected, TAX_A);
  ok('server rejects duplicate tax no with id only', rej?.length === 1 && rej[0].reason === `Bu vergi numarasıyla kayıtlı cari var (#${idA})`, JSON.stringify(rej));
  await A.evaluate(t => { DB.customers.push({ id: 'cu_race' + Date.now(), name: 'Yarış Cari', kind: 'customer', taxNo: t, active: true, contacts: [] }); save(); }, TAX_A);
  await flush(A); await sleep(400);
  const tst = await A.evaluate(() => ({ t: document.querySelector('#toast .tx')?.textContent || '', btn: document.querySelector('#toast .toast-undo')?.textContent || '' }));
  ok('race reject toast: name + "Kartı aç", local copy dropped', tst.t === 'Bu vergi numarasıyla kayıtlı cari var: ' + NAME_A && tst.btn === 'Kartı aç'
    && await A.evaluate(() => !DB.customers.some(c => c.name === 'Yarış Cari')), JSON.stringify(tst));

  // 7) yetkili kişi silme: kayıttan tamamen kalkar
  await A.evaluate(id => openCustomer(id), idA); await sleep(200);
  await A.click('[data-ctdel="0"]'); await sleep(100);
  ok('contact row removed immediately', await A.evaluate(() => document.querySelectorAll('#cu_ct .cu-ctrow').length === 1 && document.getElementById('cu_ctn').textContent === '1'));
  await A.click('#cu_ok'); await sleep(200); await flush(A);
  const sA2 = await srv(A, 'customers', idA);
  ok('deleted contact gone from server record', sA2.contacts.length === 1 && !JSON.stringify(sA2).includes('elif.deneme'), JSON.stringify(sA2.contacts));

  // 8) proje formunda yalnız etkin cariler; projeye bağlama (yeni proje + üye Projeler kartından)
  await A.evaluate(() => newProjectForm()); await sleep(200);
  await A.click('#ps_next'); await sleep(150);
  const opts = await A.evaluate(() => [...document.querySelectorAll('#np_cu option')].map(o => [o.value, o.textContent]));
  ok('project form: "— Cari yok —" first, only active customers', opts[0]?.[1] === '— Cari yok —' && opts.some(o => o[0] === idA) && opts.some(o => o[0] === ID.B)
    && !opts.some(o => o[0] === ID.D), opts.length + ' seçenek');
  const PN = 'Cari Proje ' + RUN;
  await A.fill('#np_n', PN); await A.selectOption('#np_cu', idA); await A.click('#np_ok'); await sleep(300); await flush(A);
  const newP = await A.evaluate(n => DB.projects.find(p => p.name === n), PN);
  ok('new project linked to customer on server', !!newP && (await srv(A, 'projects', newP.id))?.customerId === idA);
  await view(Mb, 'projects');
  ok('member: project card has customer select (only active + none)', await Mb.evaluate(([d, a]) => { const s = document.querySelector('[data-pcust="p1"]');
    return !!s && [...s.options].some(o => o.value === a) && ![...s.options].some(o => o.value === d); }, [ID.D, idA]));
  await Mb.selectOption('[data-pcust="p1"]', idA); await sleep(200); await flush(Mb);
  ok('member links active customer to project', (await srv(A, 'projects', 'p1'))?.customerId === idA);
  const mRej = await Mb.evaluate(async d => { const p = { ...DB.projects.find(x => x.id === 'p2'), customerId: d };
    return (await API.post('/api/sync', { changes: [{ c: 'projects', id: 'p2', op: 'put', data: p }] })).rejected; }, ID.D);
  ok('server: passive customer cannot be linked', mRej?.[0]?.reason === 'Pasif cari projeye bağlanamaz', JSON.stringify(mRej));

  // 9) kart özeti (iş düzeyi cari bağı sayılır): süreler efor raporuyla aynı hesap, açık iş tıklaması aynı sayıyı verir
  await A.evaluate(() => reloadState()); await sleep(300);
  await A.evaluate(id => openCustomer(id), idA); await sleep(250);
  const sum = await A.evaluate(id => {
    const ids = new Set(DB.projects.filter(p => p.customerId === id).map(p => p.id)), mon = TODAY.slice(0, 7);
    /* görev 11b: işe bağlı cari önce gelir; carisi olmayan iş projesinin carisini alır */
    const wl = DB.worklogs.filter(w => { const i = issue(w.issueId); return i && (i.customerId && cuById(i.customerId) ? i.customerId === id : ids.has(i.projectId)); });
    const tot = wl.reduce((a, w) => a + (+w.hours || 0), 0), m = wl.filter(w => String(w.date).slice(0, 7) === mon).reduce((a, w) => a + (+w.hours || 0), 0);
    const g = k => document.querySelector(`[data-cun="${k}"]`)?.textContent;
    return { exp: [efFmt(m), efFmt(tot), String(ids.size)], got: [g('month'), g('total'), g('proj')], open: +g('open'), tot };
  }, idA);
  ok('summary: linked projects + hours (this month / total) match effort calc', JSON.stringify(sum.exp) === JSON.stringify(sum.got) && sum.tot > 0, JSON.stringify(sum));
  await A.click('[data-cuissues]'); await sleep(300);
  const sr = await A.evaluate(() => ({ v: DB.ui.view, q: DB.ui.pql, n: document.querySelectorAll('#view .ts tbody tr[data-open]').length }));
  ok('open issues click → search with same count', sr.v === 'search' && /^cari = "/.test(sr.q) && sr.n === sum.open && sum.open > 0, JSON.stringify(sr) + ' beklenen ' + sum.open);
  await A.evaluate(() => { DB.ui.pql = ''; save(); });

  // 10) silme: bağlı cari silinemez → "Pasife al"; bağsız cari onayla kalıcı silinir
  await A.evaluate(id => openCustomer(id), idA); await sleep(200);
  await A.click('#cu_del'); await sleep(200);
  const blk = await A.evaluate(() => ({ t: document.getElementById('cud_t')?.textContent, d: document.getElementById('cud_d')?.textContent || '',
    pas: !!document.getElementById('cud_pas'), role: document.querySelector('#scrim .modal')?.getAttribute('role') }));
  ok('linked customer: "Bu cariye bağlı 2 proje var; silmek yerine pasife alın" + "Pasife al"', blk.t === 'Cari silinemez' && blk.pas && blk.role === 'alertdialog'
    && blk.d.includes('Bu cariye bağlı 2 proje var; silmek yerine pasife alın'), JSON.stringify(blk));
  await A.evaluate(() => closeModal());
  const sDel = await A.evaluate(async id => (await API.post('/api/sync', { changes: [{ c: 'customers', id, op: 'del' }] })).rejected, idA);
  ok('server also refuses deleting linked customer', sDel?.[0]?.reason === 'Bu cariye bağlı 2 proje var; silmek yerine pasife alın', JSON.stringify(sDel));
  await A.evaluate(id => openCustomer(id), ID.C); await sleep(200);
  await A.click('#cu_del'); await sleep(200);
  const cf = await A.evaluate(() => ({ d: document.getElementById('cud_d')?.textContent || '', f: document.activeElement?.id }));
  ok('unlinked: permanent delete confirmation, focus on "Vazgeç"', /kalıcı olarak silinir, çöp kutusuna gitmez/.test(cf.d) && cf.f === 'cud_no', JSON.stringify(cf));
  await A.click('#cud_ok'); await sleep(200); await flush(A);
  ok('unlinked customer deleted on server', (await srv(A, 'customers', ID.C)) === null);

  // 11) ikinci oturum ≤ 5 sn: yönetici yeni cari ekler, üye listesinde görünür
  await view(Mb, 'customers');
  await A.evaluate(r => { DB.customers.push({ id: 'cu_live' + r, name: 'Canlı Cari ' + r, kind: 'customer', active: true, contacts: [] }); save(); }, RUN);
  await flush(A);
  const live = await waitFor(Mb, r => (DB.customers || []).some(c => c.name === 'Canlı Cari ' + r), RUN, 8000);
  ok('other session receives new customer within 5 s (for pickers)', live >= 0 && live <= 5000, live + ' ms');

  // 12) üye / izleyici: düğme yok, salt okunur kart; sunucu reddeder; istemci üyenin cari değişikliğini göndermez
  ok('member: no "Cari ekle"', await Mb.evaluate(() => !document.querySelector('[data-cunew]')));
  await Mb.evaluate(id => openCustomer(id), idA); await sleep(250);
  ok('member: read-only card (no inputs, no delete, "Salt okunur")', await Mb.evaluate(() => !document.getElementById('cu_n') && !document.getElementById('cu_del')
    && !document.getElementById('cu_ok') && /Salt okunur/.test(document.querySelector('#scrim .cu-ro-chip')?.textContent || '') && !!document.querySelector('#scrim [data-cun="total"]')));
  await Mb.evaluate(() => closeModal());
  const mPut = await Mb.evaluate(async id => (await API.post('/api/sync', { changes: [{ c: 'customers', id, op: 'put', data: { name: 'Üye değiştirdi', kind: 'customer', active: true } }] })).rejected, ID.B);
  const mNew = await Mb.evaluate(async r => (await API.post('/api/sync', { changes: [{ c: 'customers', id: 'cu_m' + r, op: 'put', data: { name: 'Üye ekledi', kind: 'customer', active: true } }] })).rejected, RUN);
  const mDel = await Mb.evaluate(async id => (await API.post('/api/sync', { changes: [{ c: 'customers', id, op: 'del' }] })).rejected, ID.B);
  ok('server rejects member put/new/delete', mPut?.length === 1 && mNew?.length === 1 && mDel?.length === 1);
  await Mb.evaluate(id => { DB.customers.find(c => c.id === id).name = 'Yerel değişiklik'; save(); }, ID.B); await flush(Mb);
  ok('client does not send member customer edits', (await srv(A, 'customers', ID.B))?.name === `Deneme Tedarik ${RUN} A.Ş.`);
  await Mb.evaluate(() => reloadState()); await sleep(300);

  await view(Vb, 'customers'); await Vb.evaluate(() => reloadState()); await sleep(300);
  ok('viewer: no "Cari ekle"', await Vb.evaluate(() => !document.querySelector('[data-cunew]')));
  await Vb.evaluate(id => openCustomer(id), ID.X); await sleep(250);
  const vm = await Vb.evaluate(t => ({ tx: document.getElementById('cu_tx')?.textContent || '', leak: JSON.stringify(DB.customers).includes(t), ro: !document.getElementById('cu_n') }), TC_X);
  const vRaw = await Vb.evaluate(id => DB.customers.find(c => c.id === id)?.taxNo, ID.X);
  ok('viewer: 11-digit tax no masked from server, not shown on card, never in client data', vRaw === '*********' + TC_X.slice(-2) && vm.tx === '—' && !vm.leak && vm.ro, JSON.stringify({ vm, vRaw }));
  await Mb.evaluate(() => reloadState()); await Mb.evaluate(id => openCustomer(id), ID.X); await sleep(200);
  ok('member: old 11-digit value not shown on read-only card', await Mb.evaluate(t => document.getElementById('cu_tx')?.textContent === '—' && !document.querySelector('#scrim .modal').textContent.includes(t), TC_X));
  await Mb.evaluate(() => closeModal());
  await Vb.evaluate(() => closeModal());
  const vPut = await Vb.evaluate(async id => (await API.post('/api/sync', { changes: [{ c: 'customers', id, op: 'put', data: { name: 'İzleyici', kind: 'customer', active: true } }] })).rejected, ID.B);
  ok('server rejects viewer write', vPut?.length === 1);
  /* yönetici X'i değiştirir; izleyiciye poll ile gelen kayıt da maskeli */
  await A.evaluate(id => { DB.customers.find(c => c.id === id).phone = '0232 555 00 11'; save(); }, ID.X); await flush(A);
  const vPoll = await waitFor(Vb, id => DB.customers.find(c => c.id === id)?.phone === '0232 555 00 11', ID.X, 8000);
  ok('viewer: polled change still masked', vPoll >= 0 && await Vb.evaluate(([id, t]) => !JSON.stringify(DB.customers).includes(t) && DB.customers.find(c => c.id === id).taxNo.startsWith('*'), [ID.X, TC_X]));
  await view(Vb, 'projects');
  ok('viewer: project card shows customer as link (no select)', await Vb.evaluate(id => !document.querySelector('[data-pcust]') && !!document.querySelector(`.cu-plink a[data-cuopen="${id}"]`), idA));

  // 12b) eski 11 haneli vergi no: yöneticide salt okunur "eski kayıt"; formdan değişmeden kaydedilir (silinmez)
  await view(A, 'customers'); await setQ(A, 'Mali Müşavir ' + RUN);
  ok('admin list: old 11-digit value with "eski kayıt" tag', await A.evaluate(([id, t]) => { const r = document.querySelector(`#cuList tr[data-cuopen="${id}"] td.c-tx`);
    return !!r && r.textContent.includes(t) && /eski kayıt/.test(r.textContent) && !/TCKN/.test(r.textContent); }, [ID.X, TC_X]));
  await A.evaluate(id => openCustomer(id), ID.X); await sleep(200);
  const of = await A.evaluate(() => ({ v: document.getElementById('cu_vn')?.value, old: document.getElementById('cu_vn_old')?.textContent || '' }));
  ok('admin form: tax input empty, old value read-only below', of.v === '' && of.old.includes(TC_X) && /Eski kayıt \(salt okunur\)/.test(of.old), JSON.stringify(of));
  await A.fill('#cu_p', '0232 555 00 12'); await A.click('#cu_ok'); await sleep(200); await flush(A);
  ok('saving form keeps old 11-digit value on server', await (async () => { const d = await srv(A, 'customers', ID.X); return d?.taxNo === TC_X && d.phone === '0232 555 00 12'; })());
  await setQ(A, '');

  // 13) "Pasife al": bağlar korunur, proje kartında "(Pasif)"
  await A.evaluate(id => openCustomer(id), idA); await sleep(200);
  await A.click('#cu_del'); await sleep(150); await A.click('#cud_pas'); await sleep(200); await flush(A);
  ok('"Pasife al" deactivates, links kept', (await srv(A, 'customers', idA))?.active === false && (await srv(A, 'projects', 'p1'))?.customerId === idA);
  await view(A, 'projects');
  ok('project card keeps passive link as "(Pasif)" with hint', await A.evaluate(id => { const s = document.querySelector('[data-pcust="p1"]');
    return s && s.value === id && /\(Pasif\)/.test(s.selectedOptions[0].textContent) && /Bağlı cari pasif/.test(s.closest('.cu-plink').textContent); }, idA));

  // 14) mobil 375px: kart liste, yatay kaydırma yok, form tek sütun, Kaydet/İptal görünür
  const Mo = await mk('mobile', { width: 375, height: 740 }); await login(Mo, 'admin', 'admin12345');
  await view(Mo, 'customers');
  const mob = await Mo.evaluate(() => { const r = document.querySelector('#cuList tr.cu-row');
    return { sw: document.documentElement.scrollWidth, disp: r && getComputedStyle(r).display, thead: getComputedStyle(document.querySelector('.cu-tbl thead')).display }; });
  ok('mobile 375: card list, no horizontal scroll', mob.sw <= 375 && mob.disp === 'grid' && mob.thead === 'none', JSON.stringify(mob));
  await Mo.click('.cu-tools [data-cunew]'); await sleep(250);
  const mf = await Mo.evaluate(() => { const f = document.querySelector('.cu-form'), ok = document.getElementById('cu_ok').getBoundingClientRect(),
    cancel = [...document.querySelectorAll('#scrim .m-f .btn')].find(b => b.textContent.trim() === 'İptal').getBoundingClientRect();
    return { cols: getComputedStyle(f).gridTemplateColumns.split(' ').length, okB: ok.bottom, cB: cancel.bottom, h: innerHeight, sw: document.documentElement.scrollWidth }; });
  ok('mobile form: single column, Kaydet/İptal visible', mf.cols === 1 && mf.okB <= mf.h && mf.cB <= mf.h && mf.sw <= 375, JSON.stringify(mf));
  await Mo.screenshot({ path: SS + 'mobil-form.png' });
  await Mo.evaluate(() => closeModal());
  await Mo.screenshot({ path: SS + 'mobil.png' });

  // 15) XSS: unvan/kısa ad/not/kişi metin olarak; fatura dökümü cariye göre
  await view(A, 'customers'); await setQ(A, 'Mali Müşavir ' + RUN);
  ok('XSS name rendered as text', await A.evaluate(() => [...document.querySelectorAll('#cuList .cu-nm')].some(e => e.textContent.startsWith('<img'))));
  await Vb.evaluate(id => openCustomer(id), ID.X); await sleep(200);
  ok('no XSS executed (admin, member, viewer, mobile)', (await Promise.all([A, Mb, Vb, Mo].map(p => p.evaluate(() => window.__xss === undefined)))).every(Boolean));
  await Vb.evaluate(() => closeModal());
  /* görev 11b: müşteri atamaları cariden — fatura dökümü ve rapor gruplaması cariye göre, eski Müşteri alanı görünmez */
  ok('billing export / report grouping by cari; old Müşteri field hidden', await A.evaluate(() => typeof customerOf === 'function' && BILL_HEAD[0] === 'Cari'
    && DIMS.customer?.l === 'Cari' && !liveFields().some(f => f.key === 'musteri')
    && DB.issues.slice(0, 20).every(i => { try { const n = customerOf(i); return n === (cuById(customerIdOf(i))?.name || 'Cari bağlı değil'); } catch (_) { return false; } })));
  await A.screenshot({ path: SS + 'liste.png' });

  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts / console errors');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
