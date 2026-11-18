// İş geçmişi (B2, "Tam geçmiş") tarayıcı testi: her değişiklik logHist'ten adla yazılır, akışta
// eski değer üstü çizili → yeni, aynı kişinin 1 dk içindeki değişiklikleri tek blok, otomasyon alt satırları.
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/gecmis.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi işlerini oluşturur.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const A = await ctx.newPage();
  A.on('pageerror', e => errs.push('PAGEERR ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
  A.on('dialog', d => { errs.push('DIALOG ' + d.type() + ' ' + d.message()); d.dismiss(); });
  await A.goto(BASE); await A.waitForSelector('#lg_u');
  await A.fill('#lg_u', 'admin'); await A.fill('#lg_p', 'admin12345');
  await A.click('#lgForm button[type=submit]'); await sleep(1500);
  const srv = (fn, arg) => A.evaluate(async ([fn, arg]) => { const r = (await API.get('/api/state')).data; return eval(fn)(r, arg); }, [String(fn), arg]);
  const open = async id => { await A.evaluate(id => { closeModal(); closeModal(); openIssue(id); }, id); await sleep(300); };
  const hist = (id, field) => A.evaluate(([id, f]) => DB.history.filter(h => h.issueId === id && (!f || h.field === f)), [id, field]);
  const flush = () => A.evaluate(async () => { await flushAll(); });
  /* Akıştaki geçmiş blokları: başlık metni, satır sayısı, üstü çizili/yeni, otomasyon alt satırları. */
  const feed = () => A.evaluate(() => [...document.querySelectorAll('#idA .id-ev.h')].map(e => ({
    hd: e.querySelector('.hd')?.textContent.replace(/\s+/g, ' ').trim(), n: +e.dataset.hn,
    rows: [...e.querySelectorAll('.id-chg > li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()),
    old: [...e.querySelectorAll('del.id-old')].map(x => x.textContent.replace(/^eski: /, '')),
    nw: [...e.querySelectorAll('ins.id-new')].map(x => x.textContent.replace(/^yeni: /, '')),
    auto: [...e.querySelectorAll('.id-auto')].map(x => x.textContent.trim()) })));

  // 0) proje: p1 (demo). Kendi işlerimiz createIssue ile (tek kapı) — geçmişte "işi oluşturdu".
  const ids = await A.evaluate(run => {
    DB.ui.idFeed = 'hist';
    const pr = DB.projects.find(x => x.id === 'p1');
    const a = createIssue(pr, { summary: `GC${run} ana`, description: 'eski açıklama' });
    const o = createIssue(pr, { summary: `GC${run} öteki` });
    save(); return { main: a.id, other: o.id, mkey: a.key, okey: o.key };
  }, RUN);
  await flush();
  let h = await hist(ids.main, 'Oluşturma');
  ok('create: one "Oluşturma" record with kind create', h.length === 1 && h[0].kind === 'create' && h[0].key === ids.mkey, JSON.stringify(h));
  ok('create: record on server', await srv((r, id) => r.history.some(x => x.issueId === id && x.kind === 'create'), ids.main));
  await open(ids.main);
  let f = await feed();
  ok('create: feed shows "işi oluşturdu"', f.some(e => /işi oluşturdu/.test(e.hd)), JSON.stringify(f));

  // 1) açıklama: 120 karakter özet
  const longDesc = 'Uzun açıklama ' + 'x'.repeat(300);
  await A.click('[data-ie="description"]'); await sleep(150);
  await A.fill('#idDescIn', longDesc); await A.click('#idDescOk'); await sleep(250);
  h = await hist(ids.main, 'Açıklama');
  ok('description: record kind edit, to clipped to 120 with …', h.length === 1 && h[0].kind === 'edit' && h[0].to.length === 120 && h[0].to.endsWith('…')
    && h[0].from === 'eski açıklama', JSON.stringify(h.map(x => [x.kind, x.to.length, x.from])));
  f = await feed();
  ok('description: feed "Açıklamayı değiştirdi" + quote', f.some(e => /Açıklamayı değiştirdi/.test(e.hd) || e.rows.some(r => r.startsWith('Açıklamayı değiştirdi'))) && await A.evaluate(() => !!document.querySelector('#idA .id-quote')));

  // 2) etiket ekle / kaldır (+ XSS etiketi esc ile)
  await A.fill('#newLabel', 'api'); await A.press('#newLabel', 'Enter'); await sleep(200);
  await A.fill('#newLabel', XSS); await A.press('#newLabel', 'Enter'); await sleep(200);
  await A.click('[data-dellabel="api"]'); await sleep(200);
  h = await hist(ids.main, 'Etiket');
  ok('labels: add api, add xss, remove api', h.length === 3 && h[0].kind === 'add' && h[0].to === 'api' && h[2].kind === 'remove' && h[2].from === 'api', JSON.stringify(h.map(x => [x.kind, x.from, x.to])));
  f = await feed();
  ok('labels: feed lines "Etiket ekledi: api" / "Etiket kaldırdı: api"', f.some(e => e.rows.some(r => r === 'Etiket ekledi: api')) && f.some(e => e.rows.some(r => r === 'Etiket kaldırdı: api')), JSON.stringify(f.slice(0, 2)));
  ok('labels: xss not executed', await A.evaluate(() => !window.__xss));

  // 3) bağlantı ekle / kaldır — iki uçta
  await A.click('#addLink'); await sleep(250);
  await A.selectOption('#lk_t', 'blocks'); await A.selectOption('#lk_i', ids.other); await A.click('#lk_ok'); await sleep(350);
  const ha = await hist(ids.main, 'Bağlantı'), hb = await hist(ids.other, 'Bağlantı');
  ok('link add: both ends ("engelliyor KEY" / "engelleniyor KEY")', ha.length === 1 && ha[0].to === `engelliyor ${ids.okey}` && ha[0].key === ids.okey
    && hb.length === 1 && hb[0].to === `engelleniyor ${ids.mkey}`, JSON.stringify([ha, hb]));
  await open(ids.main);
  const lid = await A.evaluate(id => DB.links.find(l => l.from === id)?.id, ids.main);
  await A.click(`[data-dellink="${lid}"]`); await sleep(250);
  const ha2 = await hist(ids.main, 'Bağlantı'), hb2 = await hist(ids.other, 'Bağlantı');
  ok('link remove: both ends kind remove', ha2.length === 2 && ha2[1].kind === 'remove' && ha2[1].from === `engelliyor ${ids.okey}`
    && hb2.length === 2 && hb2[1].kind === 'remove', JSON.stringify([ha2[1], hb2[1]]));
  f = await feed();
  ok('link: feed "Bağlantı kaldırdı: engelliyor KEY"', f.some(e => e.rows.some(r => r === `Bağlantı kaldırdı: engelliyor ${ids.okey}`) || e.hd.includes(`Bağlantı kaldırdı: engelliyor ${ids.okey}`)), JSON.stringify(f.slice(0, 1)));

  // 4) yorum ekle / düzenle / sil (80 karakter), silmede Geri al geçmişi de geri alır
  const longC = 'Yorum ' + 'y'.repeat(150);
  const feedTo = v => A.evaluate(v => { DB.ui.idFeed = v; refreshIssue(['act']); }, v);
  await feedTo('all');
  await A.click('#newCmt'); await A.fill('#newCmt', longC); await A.click('#addCmt'); await sleep(250);
  const cid = await A.evaluate(id => DB.comments.find(c => c.issueId === id)?.id, ids.main);
  await A.click(`[data-cedit="${cid}"]`); await sleep(150);
  await A.fill(`#ce_${cid}`, 'Düzenlenmiş yorum'); await A.click(`[data-csave="${cid}"]`); await sleep(250);
  h = await hist(ids.main, 'Yorum');
  ok('comment add (80 chars) + edit', h.length === 2 && h[0].kind === 'add' && h[0].to.length === 80 && h[0].to.endsWith('…') && h[1].kind === 'edit' && h[1].to === 'Düzenlenmiş yorum', JSON.stringify(h.map(x => [x.kind, x.to.length])));
  await A.click(`[data-cdel="${cid}"]`); await sleep(250); await A.click('#delOk'); await sleep(250);
  h = await hist(ids.main, 'Yorum');
  ok('comment delete: kind del record (local)', h.length === 3 && h[2].kind === 'del' && h[2].from === 'Düzenlenmiş yorum');
  await sleep(1200);
  ok('comment delete held: "Yorumu sildi" not on server yet', await srv((r, id) => !r.history.some(x => x.issueId === id && x.field === 'Yorum' && x.kind === 'del'), ids.main));
  await A.click('#toast .toast-undo'); await sleep(300);
  ok('comment undo: comment back, "Yorumu sildi" removed', await A.evaluate(([id, c]) => DB.comments.some(x => x.id === c)
    && !DB.history.some(x => x.issueId === id && x.field === 'Yorum' && x.kind === 'del'), [ids.main, cid]));
  await A.click(`[data-cdel="${cid}"]`); await sleep(250); await A.click('#delOk'); await sleep(250);
  await A.evaluate(() => holdReleaseAll()); await sleep(1500); await flush();
  ok('comment delete released: "Yorumu sildi" on server', await srv((r, id) => r.history.some(x => x.issueId === id && x.field === 'Yorum' && x.kind === 'del'), ids.main));
  await feedTo('hist');
  f = await feed();
  ok('comment: feed lines "Yorum ekledi/Yorumu düzenledi/Yorumu sildi"', ['Yorum ekledi', 'Yorumu düzenledi', 'Yorumu sildi'].every(t => f.some(e => e.hd.includes(t) || e.rows.some(r => r.startsWith(t)))), JSON.stringify(f.slice(0, 2)));

  // 5) süre kaydı ekle / düzenle / sil
  await feedTo('all');
  await A.click('#logHere'); await sleep(300);
  await A.fill('#w_h', '2h'); await A.fill('#w_c', 'çalıştım'); await A.click('#doWork'); await sleep(300);
  const wid = await A.evaluate(id => DB.worklogs.find(w => w.issueId === id)?.id, ids.main);
  await open(ids.main);
  await A.click(`#idA [data-editwl="${wid}"]`); await sleep(300);
  await A.fill('#w_h', '3h'); await A.click('#doWork'); await sleep(300);
  await open(ids.main);
  await A.click(`#idA [data-delwl="${wid}"]`); await sleep(250); await A.click('#delOk'); await sleep(250);
  await A.evaluate(() => holdReleaseAll()); await sleep(500);
  await feedTo('hist');
  h = await hist(ids.main, 'Süre kaydı');
  const dm = await A.evaluate(() => hmDM(TODAY));
  ok('worklog: add "2h (gün)", edit 2h → 3h, del 3h', h.length === 3 && h[0].kind === 'add' && h[0].to === `2h (${dm})`
    && h[1].kind === 'edit' && h[1].from === '2h' && h[1].to === '3h' && h[2].kind === 'del' && h[2].from === '3h', JSON.stringify(h.map(x => [x.kind, x.from, x.to])));
  f = await feed();
  ok('worklog: feed "süre kaydetti", "2h → 3h" struck, "Süre kaydını sildi: 3h"',
    f.some(e => e.hd.includes(`2h süre kaydetti (${dm})`) || e.rows.some(r => r.includes(`2h süre kaydetti (${dm})`)))
    && f.some(e => e.old.includes('2h') && e.nw.includes('3h'))
    && f.some(e => e.hd.includes('Süre kaydını sildi: 3h') || e.rows.includes('Süre kaydını sildi: 3h')), JSON.stringify(f.slice(0, 3)));
  ok('"Tümü" hides duplicate add rows (comment/worklog shown by itself)', await A.evaluate(() => { DB.ui.idFeed = 'all'; refreshIssue(['act']);
    const t = document.getElementById('idA').textContent; DB.ui.idFeed = 'hist'; refreshIssue(['act']); return !/Yorum ekledi/.test(t); }));

  // 6) alt iş ekle (üst işte "Alt iş ekledi: KEY") / tamamla ("Alt işi tamamladı")
  await A.click('#subIn'); await A.keyboard.type(`GC${RUN} alt`); await A.keyboard.press('Enter'); await sleep(300);
  const kid = await A.evaluate(id => kidsOf(id)[0], ids.main);
  await A.click(`[data-subdone="${kid.id}"]`); await sleep(300);
  h = await hist(ids.main, 'Alt iş');
  ok('subtask: add + done on parent with key', h.length === 2 && h[0].kind === 'add' && h[0].key === kid.key && h[0].to.startsWith(kid.key)
    && h[1].kind === 'done' && h[1].key === kid.key, JSON.stringify(h));
  ok('subtask: child has its own "Oluşturma"', (await hist(kid.id, 'Oluşturma')).length === 1);

  // 7) alan değişiklikleri adla: Sprint / Epik / Raporlayan / Tip / tarih
  const nm = await A.evaluate(([id, run]) => {
    const i = issue(id), sp = DB.sprints.find(s => s.projectId === 'p1'), ep = DB.issues.find(x => x.projectId === 'p1' && x.type === 'epic');
    const rep = DB.users.find(u => u.id !== ME.id && !u.system && u.active !== false), ty = ISSUE_TYPES().find(t => t !== i.type && t !== 'epic');
    if (sp) idSet(i, 'sprintId', sp.id); if (ep) idSet(i, 'epicId', ep.id); if (rep) idSet(i, 'reporter', rep.id); if (ty) idSet(i, 'type', ty);
    return { sp: sp?.name, ep: ep?.summary, rep: rep?.name, ty: ty && TYPE[ty][2] };
  }, [ids.main, RUN]);
  await open(ids.main);
  await A.evaluate(() => { const el = document.getElementById('idDue'); el.value = '2026-11-18'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await sleep(200);
  const byF = async fl => (await hist(ids.main, fl)).pop();
  const sp = await byF('Sprint'), ep = await byF('Epik'), rp = await byF('Raporlayan'), ty = await byF('Tip'), du = await byF('Bitiş');
  ok('fields written by name (Sprint/Epik/Raporlayan/Tip)', (!nm.sp || (sp.from === 'Backlog' && sp.to === nm.sp)) && (!nm.ep || (ep.from === 'Yok' && ep.to === nm.ep))
    && (!nm.rep || rp.to === nm.rep) && (!nm.ty || ty.to === nm.ty), JSON.stringify([nm, sp, ep, rp, ty]));
  ok('date written as "18 Kas 2026"', du && du.to === '18 Kas 2026' && du.from === '—', JSON.stringify(du));

  // 8) ham kimlikli eski kayıt: gösterimde ada çevrilir, veri değişmez
  const raw = await A.evaluate(id => {
    const sp = DB.sprints.find(s => s.projectId === 'p1'), u = DB.users.find(x => !x.system);
    DB.history.push({ id: uid('h'), issueId: id, userId: ME.id, at: Date.now() - 3 * 3600e3, field: 'Sprint', from: '', to: sp?.id || 'yok' },
      { id: uid('h'), issueId: id, userId: ME.id, at: Date.now() - 3 * 3600e3 - 1, field: 'Raporlayan', from: u.id, to: 'bilinmeyen-kimlik' },
      { id: uid('h'), issueId: id, userId: ME.id, at: Date.now() - 3 * 3600e3 - 2, field: 'Başlangıç', from: '2026-11-03', to: '—' });
    save(); refreshIssue(['act']); return { sp: sp?.name, spid: sp?.id, u: u.name, uid: u.id };
  }, ids.main);
  f = await feed();
  const old = f.find(e => e.n === 3 && e.rows.some(r => r.startsWith('Sprint')));
  ok('old raw-id record shown by name; unknown id as-is; ISO date formatted', !!old && (!raw.sp || old.nw.includes(raw.sp)) && old.old.includes(raw.u)
    && old.nw.includes('bilinmeyen-kimlik') && old.old.includes('3 Kas 2026'), JSON.stringify(old));
  ok('old record data unchanged', await A.evaluate(([id, sid]) => DB.history.some(h => h.issueId === id && h.field === 'Sprint' && h.to === (sid || 'yok')), [ids.main, raw.spid]));

  // 9) gruplama: aynı kişi 1 dk içinde → tek blok ("N değişiklik"); 2 dk önceki ayrı blok; başka kişi ayrı blok
  const g = await A.evaluate(run => {
    const pr = DB.projects.find(x => x.id === 'p1'), i = createIssue(pr, { summary: `GC${run} grup` }), t = Date.now() - 600e3;
    const other = DB.users.find(u => u.id !== ME.id && !u.system);
    DB.history = DB.history.filter(h => h.issueId !== i.id);   // yalnız yerel görünüm testi (kayıt henüz gönderilmedi)
    const H = (at, field, from, to, userId = ME.id) => DB.history.push({ id: uid('h'), issueId: i.id, userId, at, field, from, to });
    H(t, 'Öncelik', 'Orta', 'Yüksek'); H(t + 20e3, 'Durum', 'Yapılacak', 'Devam'); H(t + 50e3, 'Atanan', '—', 'Ali');
    H(t - 120e3, 'Puan', '1', '2'); H(t + 55e3, 'Puan', '2', '3', other.id);
    return i.id;
  }, RUN);
  await open(g);
  f = await feed();
  ok('grouping: 3 changes in 1 min → one block "3 değişiklik"; other user separate; 2 min earlier separate',
    f.length === 3 && f[0].n === 1 && f[1].n === 3 && /3 değişiklik/.test(f[1].hd) && f[2].n === 1,
    JSON.stringify(f.map(e => [e.n, e.hd])));
  ok('grouped block: old struck → new for each row', f[1] && f[1].old.length === 3 && f[1].nw.join() === 'Ali,Devam,Yüksek', JSON.stringify(f[1]));

  // 10) toplu düzenleme: her alan ayrı kayıt (tarih adla, etiket "add")
  await A.evaluate(() => { closeModal(); closeModal(); }); await sleep(200);
  await A.evaluate(() => { location.hash = 'search'; }); await sleep(600);
  await A.evaluate(([a, o]) => { SEL.clear(); SEL.add(a); SEL.add(o); render(); }, [ids.main, ids.other]); await sleep(300);
  const n0 = await A.evaluate(id => DB.history.filter(h => h.issueId === id).length, ids.other);
  await A.evaluate(() => { document.getElementById('bk_st2').value = '2026-11-02'; document.getElementById('bk_du').value = '2026-11-20';
    document.getElementById('bk_lb').value = 'toplu'; const b = document.getElementById('bk_bill'); b.value = b.options[b.options.length - 1].value; });
  await A.click('#bk_go'); await sleep(300);
  h = await A.evaluate(([id, n]) => DB.history.filter(x => x.issueId === id).slice(n), [ids.other, n0]);
  ok('bulk: start, due, billable, label as separate records by name', ['Başlangıç', 'Bitiş', 'Etiket'].every(fl => h.some(x => x.field === fl))
    && h.find(x => x.field === 'Başlangıç').to === '2 Kas 2026' && h.find(x => x.field === 'Bitiş').to === '20 Kas 2026' && h.find(x => x.field === 'Etiket').kind === 'add',
    JSON.stringify(h.map(x => [x.field, x.from, x.to, x.kind])));

  // 11) otomasyon: kuralın her değişikliği ayrı alt satır "Otomasyon: <kural>"
  const rn = `GC${RUN} kural <b>`;
  const au = await A.evaluate(([run, rn]) => {
    const pr = DB.projects.find(x => x.id === 'p1');
    DB.rules.push({ id: 'r_gc' + run, projectId: 'p1', name: rn, on: 'created', enabled: true,
      then: [{ act: 'priority', v: 1 }, { act: 'label', v: 'oto' }, { act: 'comment', v: 'merhaba' }, { act: 'due', v: '3' }] });
    const i = createIssue(pr, { summary: `GC${run} oto` }); save();
    return { id: i.id, h: DB.history.filter(h => h.issueId === i.id).map(h => [h.field, h.rule || '', h.kind || '']) };
  }, [RUN, rn]);
  ok('rule: each change has rule=name (Öncelik, Etiket, Yorum, Başlangıç, Bitiş) + header', ['Öncelik', 'Etiket', 'Yorum', 'Başlangıç', 'Bitiş', 'Otomasyon'].every(fl => au.h.some(x => x[0] === fl && x[1] === rn))
    && au.h.some(x => x[0] === 'Oluşturma' && x[1] === ''), JSON.stringify(au.h));
  await open(au.id);
  f = await feed();
  const blk = f.find(e => e.auto.length);
  ok('rule: feed sub-lines "Otomasyon: <kural>" (escaped)', !!blk && blk.auto.length >= 5 && blk.auto.every(t => t === `Otomasyon: ${rn}`)
    && await A.evaluate(() => !document.querySelector('#idA .id-auto b b')), JSON.stringify(blk));
  await flush();
  ok('rule records on server with rule field', await srv((r, [id, rn]) => r.history.filter(x => x.issueId === id && x.rule === rn).length >= 6, [au.id, rn]));
  await A.evaluate(run => { DB.rules = DB.rules.filter(r => r.id !== 'r_gc' + run); save(); }, RUN);

  // 12) "Geri yükleme" satırı (sunucunun yazdığı biçim)
  await A.evaluate(id => { DB.history.push({ id: uid('h'), issueId: id, userId: ME.id, at: Date.now() + 1000, field: 'Geri yükleme', kind: 'restore', from: 'Çöp kutusu', to: 'Geri yüklendi' });
    refreshIssue(['act']); }, au.id);
  f = await feed();
  ok('restore row: "Geri yükleme" line on top', /çöp kutusundan geri yükledi/.test(f[0]?.hd || '') || f[0]?.rows[0] === 'Geri yükleme: Çöp kutusundan geri yükledi', JSON.stringify(f[0]));

  // 13) sunucu: kayıtlar sunucuda, istemci var olan geçmişi değiştirmez
  await flush(); await sleep(500);
  const cnt = await A.evaluate(id => DB.history.filter(h => h.issueId === id).length, ids.main);
  ok('all main-issue records reached server', await srv((r, [id, n]) => r.history.filter(x => x.issueId === id).length === n, [ids.main, cnt]));
  ok('no xss, no page errors / dialogs', await A.evaluate(() => !window.__xss) && !errs.length, errs.join(' ; '));

  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
