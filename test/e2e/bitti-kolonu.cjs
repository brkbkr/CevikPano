// Bitti kolonu tarayıcı testi: panoda katlanmış "Tamamlananlar" grubu yok; kartın tamamla düğmesi işi Bitti kolonuna
// taşır; eski (doneFrom'lu) tamamlanmış iş de Bitti kolonunda görünür; kalabalık Bitti kolonu son 20 tamamlananı gösterir,
// "Tümünü göster" hepsini açar; tek Bitti kolonu Kolonları düzenle'de silinemez/kategorisi değişmez; kolonsuz projede
// ilk eklenen kolon Bitti olur (sunucu Bitti'siz akışı reddeder). Kolon ve iş adları metin olarak basılır.
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/bitti-kolonu.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi kayıtlarını oluşturur.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = process.env.SS_PREFIX || require('os').tmpdir() + '/pano_bk_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const P1 = 'p_bk' + RUN, P2 = 'p_bkn' + RUN;
const XSS = '<img src=x onerror=alert(1)>';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ' CONSOLE ' + m.text()); });
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
  };
  const waitFor = async (p, fn, arg, ms = 8000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const go = (p, pid) => p.evaluate(pid => { DB.ui.project = pid; DB.ui.view = 'board'; render(); }, pid);
  const flush = p => p.evaluate(async () => { save(); await flushAll(); });
  /* kolon → kart kimlikleri ve kolon başlığındaki sayı */
  const board = p => p.evaluate(() => [...document.querySelectorAll('#view .col')].map(c => ({
    id: c.dataset.status, name: c.querySelector('.col-h .nm').textContent, ct: c.querySelector('.col-h .ct').textContent.trim(),
    cards: [...c.querySelectorAll('.card')].map(x => x.dataset.id), more: c.querySelector('[data-doneall]')?.textContent.replace(/\s+/g, ' ').trim() || '' })));

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ---- kurulum: Pano türü proje; Yapılacak / Sürüyor / Bitti; 3 açık iş, eski biçimde (doneFrom) tamamlanmış 1 iş,
     Bitti'de 24 iş (farklı tamamlanma günleri), adı <img> olan bir iş ---- */
  const setup = await A.evaluate(async ([R, P1, P2, XSS]) => {
    const st = (k, name, cat, ord) => ({ c: 'statuses', id: `${P1}_${k}`, op: 'put', data: { projectId: P1, name, cat, wip: 0, ord } });
    const iss = (id, s, extra = {}) => ({ c: 'issues', id, op: 'put', data: { projectId: P1, type: 'task', summary: 'BK işi ' + id, statusId: `${P1}_${s}`, priority: 3, rank: 1, ...extra } });
    const ch = [
      { c: 'projects', id: P1, op: 'put', data: { name: 'BK Pano ' + R, key: 'BK' + R.toUpperCase(), counter: 0, workspaceId: 'ws1', type: 'board', members: [ME.id] } },
      st('t', 'Yapılacak', 'todo', 0), st('i', 'Sürüyor', 'inprogress', 1), st('d', 'Bitti', 'done', 2),
      iss('i_bka' + R, 't', { rank: 1 }), iss('i_bkb' + R, 't', { rank: 2, summary: XSS }), iss('i_bkc' + R, 'i', { rank: 3 }),
      iss('i_bkold' + R, 'd', { rank: 4, doneFrom: `${P1}_t`, doneAt: '2026-01-02' }),
    ];
    for (let k = 0; k < 24; k++) ch.push(iss(`i_bkd${k}_${R}`, 'd', { rank: 10 + k, doneAt: `2026-0${1 + (k % 9)}-${String(10 + k).padStart(2, '0')}` }));
    const r = await API.post('/api/sync', { changes: ch });
    await reloadState(); return r;
  }, [RUN, P1, P2, XSS]);
  ok('setup accepted', setup && !setup.rejected?.length, JSON.stringify(setup?.rejected || setup).slice(0, 300));
  await go(A, P1); await sleep(200);

  // 1) katlanmış grup yok; eski biçimde tamamlanmış iş (doneFrom = Yapılacak) Bitti kolonunda kart
  let bd = await board(A);
  const col = (bd, k) => bd.find(c => c.id === `${P1}_${k}`);
  ok('no folded "Tamamlananlar" group on the board', await A.evaluate(() => !document.querySelector('#view .donehead, #view [data-donetgl]')
    && !/Tamamlananlar/.test(document.querySelector('#view .board').textContent)));
  ok('Yapılacak shows only open cards (old doneFrom card not there)', JSON.stringify(col(bd, 't').cards) === JSON.stringify(['i_bka' + RUN, 'i_bkb' + RUN])
    && col(bd, 't').ct === '2', JSON.stringify(col(bd, 't')));
  ok('Bitti column: count = all 25 done issues incl. old doneFrom one; shows 20 (old one is oldest → hidden until "Tümünü göster")', col(bd, 'd').ct === '25'
    && col(bd, 'd').cards.length === 20 && !col(bd, 'd').cards.includes('i_bkold' + RUN), JSON.stringify(col(bd, 'd')).slice(0, 200));
  ok('"Tümünü göster" shows remaining count', /Tümünü göster 5 daha/.test(col(bd, 'd').more), col(bd, 'd').more);
  /* gösterilen 20: en son tamamlananlar (doneAt büyük olanlar), pano sırasıyla */
  const exp = await A.evaluate(P1 => DB.issues.filter(i => i.statusId === P1 + '_d').sort(doneRecent).slice(0, 20).sort((a, b) => a.rank - b.rank).map(i => i.id), P1);
  ok('shown 20 are the most recently done, in board order', JSON.stringify(exp) === JSON.stringify(col(bd, 'd').cards));
  await A.click(`[data-doneall="${P1}_d"]`); await sleep(200);
  bd = await board(A);
  ok('"Tümünü göster" opens all 25 (old doneFrom issue too); button toggles back', col(bd, 'd').cards.length === 25 && col(bd, 'd').cards.includes('i_bkold' + RUN)
    && /Son tamamlananları göster/.test(col(bd, 'd').more), col(bd, 'd').more);

  // 2) karttaki Tamamla: iş Bitti kolonuna gider (Yapılacak'ta grup oluşmaz); yeniden aç önceki kolona döner
  await A.click(`.card[data-id="i_bka${RUN}"] [data-complete]`); await sleep(250); await flush(A);
  bd = await board(A);
  ok('completed card moves to Bitti column, not grouped in Yapılacak', col(bd, 'd').cards.includes('i_bka' + RUN) && !col(bd, 't').cards.includes('i_bka' + RUN)
    && col(bd, 't').ct === '1' && col(bd, 'd').ct === '26', JSON.stringify([col(bd, 't'), col(bd, 'd').ct]));
  const sv = await A.evaluate(async id => (await API.get('/api/state')).data.issues.find(i => i.id === id), 'i_bka' + RUN);
  ok('server: completed issue status is Bitti', sv?.statusId === P1 + '_d', JSON.stringify(sv));
  await A.evaluate(id => reopenIssue(id), 'i_bka' + RUN); await sleep(200);
  bd = await board(A);
  ok('reopen returns the card to Yapılacak', col(bd, 't').cards.includes('i_bka' + RUN) && !col(bd, 'd').cards.includes('i_bka' + RUN));
  /* kapat: varsayılan (son 20) görünüm tercihten döner */
  await A.click(`[data-doneall="${P1}_d"]`); await sleep(150);
  ok('collapsed again: 20 cards', col(await board(A), 'd').cards.length === 20);

  // 3) <img> adlı iş metin olarak basılır
  const xs = await A.evaluate(XSS => ({ txt: [...document.querySelectorAll('#view .card .sum, #view .card')].some(e => e.textContent.includes(XSS)),
    img: !!document.querySelector('#view .card img[src="x"]') }), XSS);
  ok('issue summary with <img> rendered as text', xs.txt && !xs.img, JSON.stringify(xs));

  // 4) ikinci tarayıcı: tamamlanan iş Bitti kolonunda ≤ yoklama
  const B = await mk('admin2'); await login(B, 'admin', 'admin12345'); await go(B, P1); await sleep(200);
  await A.click(`.card[data-id="i_bkc${RUN}"] [data-complete]`); await sleep(150); await flush(A);
  const t2 = await waitFor(B, ([P1, id]) => !!document.querySelector(`.col[data-status="${P1}_d"] .card[data-id="${id}"]`), [P1, 'i_bkc' + RUN], 9000);
  ok('2nd browser sees the completed card in Bitti (≤ poll)', t2 >= 0, 't=' + t2);
  await A.screenshot({ path: SS + 'pano.png' });

  // 5) Kolonları düzenle: tek Bitti kolonu kilitli (sil ve kategori pasif)
  await A.evaluate(P1 => colsEditor(P1), P1); await sleep(200);
  const lk = await A.evaluate(() => { const rows = [...document.querySelectorAll('#scrim .pt-row')]; const last = rows[rows.length - 1];
    return { n: rows.length, cat: last.querySelector('[data-cc]').disabled, del: last.querySelector('[data-cx]').disabled,
      others: rows.slice(0, -1).every(r => !r.querySelector('[data-cx]').disabled) }; });
  ok('column editor: only Bitti column locked (delete + category)', lk.n === 3 && lk.cat && lk.del && lk.others, JSON.stringify(lk));
  /* istemci kilidini aşan silme: sunucu reddeder, kolon kalır */
  const fd = await A.evaluate(async P1 => (await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pano': '1' },
    body: JSON.stringify({ changes: [{ c: 'issues', id: 'i_bkx', op: 'put', data: { projectId: P1, summary: 'x', statusId: P1 + '_t' } },
      ...DB.issues.filter(i => i.statusId === P1 + '_d').map(i => ({ c: 'issues', id: i.id, op: 'put', data: { ...i, statusId: P1 + '_t' } })),
      { c: 'statuses', id: P1 + '_d', op: 'del' }] }) })).json(), P1);
  ok('server rejects deleting the only Bitti column (whole batch)', fd.error === 'Projede en az bir Bitti kolonu kalmalı', JSON.stringify(fd));
  await A.evaluate(() => closeModal());

  // 6) kolonsuz proje: Kolonları düzenle → ilk "Kolon ekle" Bitti (done) ekler; sunucu kabul eder; sonra "Devam ediyor"
  await A.evaluate(async ([R, P2]) => {
    DB.projects.push({ id: P2, key: 'BN' + R.toUpperCase(), code: 'BN' + R.toUpperCase(), name: 'BK Kolonsuz ' + R, lead: ME.id, counter: 0, members: [ME.id], archived: false, workspaceId: 'ws1', type: 'board' });
    save(); await flushAll(); DB.ui.project = P2; DB.ui.view = 'board'; render();
  }, [RUN, P2]);
  ok('column-less project: empty state', await A.evaluate(() => /Bu projede henüz kolon yok/.test(document.getElementById('view').textContent)));
  await A.click('#colsEdit2'); await sleep(200);
  ok('hint: first column is added as Bitti', await A.evaluate(() => /ilk kolon "Bitti" olarak eklenir/.test(document.getElementById('pt_lim').textContent)));
  await A.click('#pt_add'); await sleep(200); await flush(A);
  await A.click('#pt_add'); await sleep(200); await flush(A);
  const nc = await A.evaluate(async P2 => ({ loc: statsOf(P2).map(s => [s.name, s.cat]),
    srv: (await API.get('/api/state')).data.statuses.filter(s => s.projectId === P2).sort((a, b) => a.ord - b.ord).map(s => [s.name, s.cat]) }), P2);
  ok('column-less project: first added column is Bitti (done), next "Yeni kolon"; saved on server', JSON.stringify(nc.srv) === JSON.stringify([['Bitti', 'done'], ['Yeni kolon', 'inprogress']])
    && JSON.stringify(nc.loc) === JSON.stringify(nc.srv), JSON.stringify(nc));
  await A.evaluate(() => closeModal());

  // 7) dar ekran: Bitti kolonu ve "Tümünü göster" yatay taşma yapmaz
  const Mo = await mk('mobile', { width: 390, height: 844 }); await login(Mo, 'admin', 'admin12345'); await go(Mo, P1); await sleep(300);
  const mob = await Mo.evaluate(P1 => { const c = document.querySelector(`.col[data-status="${P1}_d"] [data-doneall]`); const r = c?.getBoundingClientRect();
    const colr = document.querySelector(`.col[data-status="${P1}_d"]`).getBoundingClientRect();
    return !!c && r.left >= colr.left - 1 && r.right <= colr.right + 1 && document.documentElement.scrollWidth <= innerWidth + 1; }, P1);
  ok('mobile: "Tümünü göster" inside Bitti column, no page overflow', mob);

  if (FAILS) await A.screenshot({ path: SS + 'son.png' });
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
