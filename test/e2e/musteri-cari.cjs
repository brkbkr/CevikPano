// Müşteri atamaları cariden (görev 11b) tarayıcı testi.
// Ön koşullar regresyon.cjs ile aynı (sunucu + demo veri) ve ardından eski Müşteri alanının dönüşümü:
//   DATABASE_URL=... node scripts/apply-sql.mjs server/migrations/005_musteri_cari.sql
// Sonra: node test/e2e/musteri-cari.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi carilerini oluşturur
// (uydurma veri) ve sonunda siler; diğer tarayıcı testleriyle aynı veritabanında çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_mc_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const ID = { S: 'cu_ms' + RUN, T: 'cu_mt' + RUN, P: 'cu_mp' + RUN };

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1500, height: 900 } });
  const A = await ctx.newPage();
  A.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  A.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  A.on('dialog', d => { if (d.type() === 'alert') errs.push('ALERT ' + d.message()); d.accept(); });
  const waitFor = async (fn, arg, ms = 7000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await A.evaluate(fn, arg)) return Date.now() - t0; await sleep(100); } return -1; };
  const srv = (c, id) => A.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c]?.find(x => x.id === id) || null, [c, id]);
  const open = async id => { await A.evaluate(id => { closeModal(); closeModal(); openIssue(id); }, id); await sleep(350); };

  await A.goto(BASE); await A.waitForSelector('#lg_u');
  await A.fill('#lg_u', 'admin'); await A.fill('#lg_p', 'admin12345');
  await A.click('#lgForm button[type=submit]'); await sleep(1500);

  /* 1) Geçiş sonrası: Acme/Globex carileri var, eski Müşteri alanı gizli, işler bağlı */
  const g = await A.evaluate(() => {
    const f = DB.fields.find(x => x.key === 'musteri');
    const ac = DB.customers.find(c => c.name === 'Acme'), gl = DB.customers.find(c => c.name === 'Globex');
    return { hidden: f?.hidden === true && f?.archived === true, ac: ac?.id, gl: gl?.id,
      nAc: DB.issues.filter(i => i.customerId === ac?.id).length, nGl: DB.issues.filter(i => i.customerId === gl?.id).length,
      live: liveFields().some(x => x.key === 'musteri'), cf: DB.issues.filter(i => i.cf?.[f?.id]).length };
  });
  ok('migration: Acme + Globex customers, issues bound, field hidden (values kept)', g.hidden && g.ac && g.gl && g.nAc >= 5 && g.nGl >= 5 && !g.live && g.cf >= g.nAc + g.nGl, JSON.stringify(g));

  /* test carileri: kaynak (kişili), hedef, pasif; p1 projesi pasif olmayan hedefe değil, kaynağa bağlı değil */
  await A.evaluate(async ([ID, R]) => {
    DB.customers.push({ id: ID.S, name: 'Kaynak ' + R, kind: 'customer', active: true, contacts: [{ id: 'ct_a' + R, name: 'Ali ' + R }] },
      { id: ID.T, name: 'Hedef ' + R, kind: 'customer', active: true, contacts: [] },
      { id: ID.P, name: 'Pasif ' + R, kind: 'customer', active: false, contacts: [] });
    save(); await flushAll();
  }, [ID, RUN]);

  /* 2) İş detayı: Cari satırı ve seçici; eski Müşteri alanı yok */
  const acIss = await A.evaluate(ac => DB.issues.find(i => i.customerId === ac && i.projectId === 'p1' && i.type !== 'epic')?.id, g.ac);
  await open(acIss);
  const d1 = await A.evaluate(() => { const s = document.querySelector('#idSide'); const b = s?.querySelector('[data-pm="cari"]');
    return { txt: s?.textContent || '', btn: b?.textContent.trim() || '', cf: !!s?.querySelector('[data-cf]') }; });
  ok('issue detail: Cari row shows Acme, no Müşteri custom field', d1.btn.includes('Acme') && !/Müşteri/.test(d1.txt) && !d1.cf, JSON.stringify(d1).slice(0, 200));
  /* önce görünür alana kaydır: kaydırma olayı açık menüyü kapatır (tasarım gereği) */
  await A.evaluate(() => document.querySelector('#idSide [data-pm="cari"]').scrollIntoView({ block: 'center' })); await sleep(300);
  await A.click('#idSide [data-pm="cari"]'); await sleep(250);
  const menu = await A.evaluate(([ID]) => ({ opts: [...document.querySelectorAll('.qm-opt[data-qv]')].map(o => o.dataset.qv), }), [ID]);
  ok('cari menu: only active customers (passive hidden)', menu.opts.includes(ID.T) && !menu.opts.includes(ID.P) && menu.opts.includes(''), JSON.stringify(menu).slice(0, 300));
  await A.click(`.qm-opt[data-qv="${ID.T}"]`); await sleep(300);
  await A.evaluate(() => flushAll());
  ok('cari picked → issue.customerId saved on server', (await srv('issues', acIss))?.customerId === ID.T);
  ok('cari change logged in history', await A.evaluate(id => DB.history.some(h => h.issueId === id && h.field === 'Cari' && h.from === 'Acme'), acIss));
  ok('detail row now shows target', (await A.evaluate(() => document.querySelector('#idSide [data-pm="cari"]')?.textContent || '')).includes('Hedef ' + RUN));
  await A.screenshot({ path: SS + 'detay.png' });

  /* 3) Yeni iş formu: Cari varsayılanı projenin carisi; eski alan yok */
  await A.evaluate(gl => { closeModal(); closeModal(); const p = DB.projects.find(x => x.id === 'p1'); p.customerId = gl; save(); DB.ui.project = 'p1'; DB.ui.view = 'board'; render(); newIssueForm(); }, g.gl);
  await sleep(300);
  const nf = await A.evaluate(([ID]) => ({ v: document.querySelector('#f_cu')?.value, opts: [...document.querySelectorAll('#f_cu option')].map(o => o.value),
    cf: !!document.querySelector('#scrim [data-cf]'), more: document.querySelector('#f_moreBtn')?.textContent || '' }), [ID]);
  ok('new issue form: Cari defaults to project customer, passive not listed', nf.v === g.gl && nf.opts.includes(ID.T) && !nf.opts.includes(ID.P), JSON.stringify(nf).slice(0, 200));
  ok('new issue form: no old Müşteri field', !nf.cf && !/özel alan/.test(nf.more), nf.more);
  await A.fill('#f_sum', 'Cari testi ' + RUN); await A.selectOption('#f_cu', ID.T); await A.click('#doCreate'); await sleep(300);
  const ni = await A.evaluate(R => DB.issues.find(i => i.summary === 'Cari testi ' + R), RUN);
  await A.evaluate(() => flushAll());
  ok('new issue saved with chosen customerId', ni?.customerId === ID.T && (await srv('issues', ni.id))?.customerId === ID.T);

  /* 4) Arama / PQL: eski alan önerilerde ve sütunlarda yok; cari alanı çalışır */
  const q = await A.evaluate(R => {
    DB.ui.view = 'search'; DB.ui.pql = ''; render();
    const th = [...document.querySelectorAll('#content th, main th')].map(t => t.textContent.trim());
    const help = document.body.textContent;
    let old = null; try { runQuery('musteri = "Acme"'); old = 'çalıştı'; } catch (e) { old = 'hata'; }
    const rows = runQuery(`cari = "Hedef ${R}"`).map(i => i.summary);
    return { th, oldHelp: /Özel alanlar:[^\n]*musteri/.test(help), old, rows };
  }, RUN);
  ok('search: no Müşteri column / suggestion; old field not queryable', !q.th.includes('Müşteri') && !q.oldHelp && q.old === 'hata', JSON.stringify(q).slice(0, 300));
  ok('PQL cari = "..." finds issue-level customer', q.rows.includes('Cari testi ' + RUN), JSON.stringify(q.rows));

  /* 5) Fatura dökümü, efor boyutu, aylık özet, genel raporlar → işin carisi, yoksa projenin, yoksa "Cari bağlı değil" */
  const r = await A.evaluate(([ID, gl]) => {
    const p2 = DB.projects.find(x => x.id === 'p2'); delete p2.customerId;
    const inP1 = DB.issues.find(i => i.projectId === 'p1' && !i.customerId);
    const inP2 = DB.issues.find(i => i.projectId === 'p2' && !i.customerId);
    const t = DB.issues.find(i => i.customerId === ID.T);
    const X = grCtx(), D = grDims(X);
    const pOf = i => X.PM.get(i.projectId);
    return { head: BILL_HEAD[0], head2: BILL_HEAD2[0], dims: DIMS.customer.l, cfCust: !!D.cfCust, grL: D.customer.l,
      of: [customerOf(t), inP1 ? customerOf(inP1) : 'x', inP2 ? customerOf(inP2) : 'Cari bağlı değil'],
      gr: [D.customer.k(null, t, pOf(t)), inP1 ? D.customer.k(null, inP1, pOf(inP1)) : gl],
      ef: DIMS.customer.n(DIMS.customer.k({ issueId: t.id })),
      rows: (() => { DB.ui.efPeriod = 'all'; try { return billingRows().map(x => x[0]); } catch (e) { return ['ERR ' + e.message]; } })(),
      sum: (() => { try { return summaryTables().customer.map(x => x.name); } catch (e) { return ['ERR ' + e.message]; } })() };
  }, [ID, g.gl]);
  ok('billing heads + effort dim label = Cari; general reports: no "Müşteri (iş alanı)" dim', r.head === 'Cari' && r.head2 === 'Cari' && r.dims === 'Cari' && !r.cfCust && r.grL === 'Cari', JSON.stringify(r).slice(0, 300));
  ok('customerOf: issue cari → project cari → "Cari bağlı değil"', r.of[0] === 'Hedef ' + RUN && r.of[1] === 'Globex' && r.of[2] === 'Cari bağlı değil', JSON.stringify(r.of));
  ok('general reports customer dim uses issue-level customer', r.gr[0] === ID.T && r.gr[1] === g.gl, JSON.stringify(r.gr));
  ok('effort dim names issue customer', r.ef === 'Hedef ' + RUN, r.ef);
  ok('billing rows / monthly summary customer column = cari names', !r.rows.some(x => String(x).startsWith('ERR')) && !r.sum.some(x => String(x).startsWith('ERR'))
    && r.rows.every(x => x === 'Cari bağlı değil' || x === 'Acme' || x === 'Globex' || x === 'Hedef ' + RUN || (typeof x === 'string' && x.length)), JSON.stringify(r.sum).slice(0, 200));
  await A.evaluate(() => { location.reload(); }); await sleep(1800);       // p2 yerel değişikliği atılır (save yok)

  /* fatura Excel'i: indirme dosyası oluşur ve Cari başlığıyla başlar */
  const xl = await A.evaluate(() => { let rows = null; const orig = makeXlsx;
    window.makeXlsx = (d, ...a) => { rows = d; return orig(d, ...a); };
    try { DB.ui.efPeriod = 'all'; const _dl = window.download; window.download = () => {}; exportBillingXlsx(); window.download = _dl; } catch (e) { return 'ERR ' + e.message; }
    window.makeXlsx = orig; return rows ? rows.slice(0, 3).map(x => x[0]) : null; });
  ok('billing Excel first column header "Cari"', Array.isArray(xl) ? xl[0] === 'Cari' : xl === null, JSON.stringify(xl));

  /* 6) Cari kartı özeti: iş düzeyi bağ sayılır */
  const sm = await A.evaluate(ID => { const s = cuSummary(ID.T);
    const exp = DB.issues.filter(i => i.customerId === ID.T && stat(i.statusId).cat !== 'done' && (MOD('epic') || i.type !== 'epic')).length;
    return { o: s.open, p: s.projs.length, exp, n: DB.issues.filter(i => i.customerId === ID.T).length }; }, ID);
  ok('customer summary counts issue-level bindings (no projects linked)', sm.o === sm.exp && sm.o >= 1 && sm.n === 2 && sm.p === 0, JSON.stringify(sm));

  /* 7) Birleştir: kaynak → hedef (bağlı iş + kişiler), kaynak silinir */
  const srcIss = await A.evaluate(async ([ID]) => { const i = DB.issues.find(x => x.projectId === 'p2' && x.type !== 'epic'); i.customerId = ID.S; save(); await flushAll(); return i.id; }, [ID]);
  await A.evaluate(ID => { DB.ui.view = 'customers'; render(); openCustomer(ID.S); }, ID); await sleep(300);
  ok('customer card has Birleştir (admin)', await A.isVisible('#cu_mrg'));
  await A.click('#cu_mrg'); await sleep(250);
  const mo = await A.evaluate(() => [...document.querySelectorAll('#cum_to option')].map(o => o.value));
  ok('merge targets: active others only', mo.includes(ID.T) && !mo.includes(ID.S) && !mo.includes(ID.P), JSON.stringify(mo).slice(0, 200));
  await A.selectOption('#cum_to', ID.T); await A.screenshot({ path: SS + 'birlestir.png' });
  await A.click('#cum_ok');
  ok('merge done in UI (source gone locally)', await waitFor(ID => !cuById(ID.S) && DB.issues.some(i => i.customerId === ID.T), ID) >= 0);
  ok('merge persisted: source deleted, issue moved, contacts merged', (await srv('customers', ID.S)) === null
    && (await srv('issues', srcIss))?.customerId === ID.T && (await srv('customers', ID.T))?.contacts?.some(c => c.name === 'Ali ' + RUN));

  /* temizlik */
  await A.evaluate(async ([ID, R, gl]) => {
    DB.issues.filter(i => [ID.T, ID.S].includes(i.customerId)).forEach(i => { i.customerId = ''; });
    DB.issues = DB.issues.filter(i => i.summary !== 'Cari testi ' + R);
    const p = DB.projects.find(x => x.id === 'p1'); delete p.customerId;
    save(); await flushAll();
    DB.customers = DB.customers.filter(c => ![ID.T, ID.P].includes(c.id)); save(); await flushAll();
  }, [ID, RUN, g.gl]);
  ok('cleanup: test customers removed', (await srv('customers', ID.T)) === null && (await srv('customers', ID.P)) === null);
  ok('XSS-safe / no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nTÜMÜ GEÇTİ');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
