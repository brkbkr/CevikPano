// Küçük düzeltmeler tarayıcı testi: "Sunucu meşgul" (409) sonrası yerel değişiklik atılmaz ve yeniden gönderilir;
// komut paletinde "Yeni proje oluştur" yalnız proje açabilene; cari e-postasında ? & " < > ve boşluk reddi;
// cari kartı özetinde açık iş / bağlı proje / bu ay / toplam süre sabit beklenen sayılarla.
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/kucuk-duzeltmeler.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kayıtlarını oluşturur.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_kd_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const V = 'u_kdv' + RUN, CU = 'c_kd' + RUN, CU2 = 'c_kd2' + RUN, P1 = 'p_kd' + RUN, P2 = 'p_kdb' + RUN;

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
  const waitFor = async (p, fn, arg, ms = 8000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const palItems = p => p.evaluate(() => { palette(); const t = [...document.querySelectorAll('#pl_r [data-pl] .sum')].map(x => x.textContent); closeModal(); return t; });

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ---- kurulum: izleyici, iki cari, bağlı proje P1 (+ kolonlar), bağsız proje P2; işler ve süreler ---- */
  const setup = await A.evaluate(async ([R, V, CU, CU2, P1, P2]) => {
    const t = TODAY, d0 = new Date(t.slice(0, 7) + '-01T12:00:00');
    d0.setDate(0);                                              // geçen ayın son günü
    const last = d0.toISOString().slice(0, 10);
    const st = (pid, k, name, cat, ord) => ({ c: 'statuses', id: `${pid}_${k}`, op: 'put', data: { projectId: pid, name, cat, wip: 0, ord } });
    const iss = (id, pid, s, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: pid, type: 'task', summary: 'KD işi ' + id, statusId: `${pid}_${s}`, priority: 3, ...extra } });
    const wl = (id, iid, hours, date) => ({ c: 'worklogs', id, op: 'put', data: { issueId: iid, userId: ME.id, hours, date } });
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: V, op: 'put', data: { username: 'kdv' + R, name: 'KD İzleyici ' + R, role: 'viewer', active: true, ini: 'Kİ', color: '#64748B' } },
      { c: 'customers', id: CU, op: 'put', data: { name: 'KD Carisi ' + R, kind: 'customer' } },
      { c: 'customers', id: CU2, op: 'put', data: { name: 'KD Diğer ' + R, kind: 'customer' } },
      { c: 'projects', id: P1, op: 'put', data: { name: 'KD Bağlı ' + R, key: 'KDA' + R.toUpperCase(), counter: 0, workspaceId: 'ws1', customerId: CU } },
      { c: 'projects', id: P2, op: 'put', data: { name: 'KD Bağsız ' + R, key: 'KDB' + R.toUpperCase(), counter: 0, workspaceId: 'ws1' } },
      st(P1, 't', 'Yapılacak', 'todo', 0), st(P1, 'i', 'Sürüyor', 'inprogress', 1), st(P1, 'd', 'Bitti', 'done', 2),
      st(P2, 't', 'Yapılacak', 'todo', 0), st(P2, 'd', 'Bitti', 'done', 1),
      iss('i_kd1' + R, P1, 't'), iss('i_kd2' + R, P1, 'i'), iss('i_kd3' + R, P1, 'd'),
      iss('i_kd4' + R, P2, 't', { customerId: CU }),            // iş düzeyi bağ: sayılır
      iss('i_kd5' + R, P1, 't', { customerId: CU2 }),           // projesi bağlı ama işin carisi başka: sayılmaz
      wl('w_kd1' + R, 'i_kd1' + R, 1.5, t), wl('w_kd2' + R, 'i_kd2' + R, 2, t), wl('w_kd3' + R, 'i_kd3' + R, 3, last),
      wl('w_kd4' + R, 'i_kd4' + R, 0.5, t), wl('w_kd5' + R, 'i_kd5' + R, 10, t),
    ] });
    await reloadState();
    return r.rejected;
  }, [RUN, V, CU, CU2, P1, P2]);
  ok('setup accepted', Array.isArray(setup) && setup.length === 0, JSON.stringify(setup));

  // 1) cari kartı özeti: sabit beklenen değerler (açık 3, proje 1, bu ay 4 s, toplam 7 s)
  await A.evaluate(id => openCustomer(id), CU); await sleep(300);
  const sum = await A.evaluate(() => {
    const g = k => document.querySelector(`[data-cun="${k}"]`)?.textContent;
    return { got: [g('open'), g('proj'), g('month'), g('total')], exp: ['3', '1', efFmt(4), efFmt(7)] };
  });
  ok('customer summary: open 3, projects 1, month 4 h, total 7 h', JSON.stringify(sum.got) === JSON.stringify(sum.exp), JSON.stringify(sum));
  await A.evaluate(() => closeModal());

  // 2) cari e-postası: mailto: enjeksiyon karakterleri istemcide reddedilir
  await A.evaluate(id => customerForm(id), CU); await sleep(250);
  const mailErr = [];
  for (const m of ['a&b@ornek.com', 'a@ornek.com?subject=x', 'a"b@ornek.com', 'a<b@ornek.com']) {
    await A.fill('#cu_m', m); await A.click('#cu_ok'); await sleep(150);
    mailErr.push(await A.evaluate(() => document.getElementById('cu_m_e')?.textContent || ''));
  }
  ok('email with ? & " < rejected in customer form', mailErr.every(x => x === 'E-posta adresi geçersiz') && await A.isVisible('#cu_ok'), JSON.stringify(mailErr));
  await A.fill('#cu_m', 'ad.soyad+kd@ornek.com'); await A.click('#cu_ok'); await sleep(400);
  ok('valid email saved', await waitFor(A, id => !DIRTY && cuById(id)?.email === 'ad.soyad+kd@ornek.com', CU) >= 0);
  await A.evaluate(() => closeModal());

  // 3) "Sunucu meşgul" (409): yerel değişiklik atılmaz, kısa beklemeyle yeniden gönderilir
  let busy = 0;
  await A.route('**/api/sync', async route => {
    if (busy < 2) { busy++; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Sunucu meşgul, yeniden deneyin' }) }); }
    return route.continue();
  });
  const NEW = 'KD meşgul sonrası ' + RUN;
  await A.evaluate(([id, s]) => { issue(id).summary = s; save(); }, ['i_kd1' + RUN, NEW]);
  await sleep(700);
  const mid = await A.evaluate(id => ({ s: issue(id).summary, dirty: DIRTY }), 'i_kd1' + RUN);
  ok('after 409 busy: local change kept and still pending', mid.s === NEW && mid.dirty === true, JSON.stringify(mid));
  const t = await waitFor(A, async ([id, s]) => (await API.get('/api/state')).data.issues.find(i => i.id === id)?.summary === s, ['i_kd1' + RUN, NEW], 12000);
  ok('busy retry: change reaches server after retries', t >= 0 && busy === 2, `busy=${busy} t=${t}`);
  ok('busy retry: sync state ok at end', await waitFor(A, () => !DIRTY && SYNC_STATE === 'ok') >= 0);
  await A.unroute('**/api/sync');

  // 4) komut paleti: "Yeni proje oluştur" yalnız proje açabilene
  const aItems = await palItems(A);
  ok('palette: admin sees "Yeni proje oluştur"', aItems.includes('Yeni proje oluştur'));
  const Vp = await mk('viewer'); await login(Vp, 'kdv' + RUN, 'Baslangic123', 'KdYeni12345');
  const vItems = await palItems(Vp);
  ok('palette: viewer does not see "Yeni proje oluştur"', vItems.length > 0 && !vItems.includes('Yeni proje oluştur'), String(vItems.length));
  const vCan = await Vp.evaluate(() => canNewProjAny());
  ok('palette matches canNewProjAny (viewer false)', vCan === false);

  if (FAILS) await A.screenshot({ path: SS + 'son.png' });
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
