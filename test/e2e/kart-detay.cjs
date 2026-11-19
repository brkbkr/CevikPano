// İş detayı, yeni iş formu ve alt pencereler tarayıcı testi (görev 6, 7, 9; docs/tasarim/kart-detay).
// Ön koşullar regresyon.cjs ile aynı: boş bir veritabanıyla sunucuyu
// ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123 PORT=3100 ile başlatın ve
// node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json ile demo veriyi yükleyin.
// Sonra: node test/e2e/kart-detay.cjs  (BASE_URL ile adres değiştirilebilir). Test kendi işlerini,
// üyesini ve izleyicisini oluşturur; diğer tarayıcı testlerinden sonra aynı veritabanında da çalışır.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_kd_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const ID = n => `i_kd${RUN}_${n}`;
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }, colorScheme = 'light') => {
    const ctx = await b.newContext({ viewport: vp, colorScheme });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
    /* confirm() kalktı: herhangi bir tarayıcı penceresi açılırsa hata sayılır. */
    p.on('dialog', d => { errs.push(name + ' DIALOG ' + d.type() + ' ' + d.message()); d.dismiss(); });
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
  };
  const srv = (p, fn, arg) => p.evaluate(async ([fn, arg]) => { const r = (await API.get('/api/state')).data; return eval(fn)(r, arg); }, [String(fn), arg]);
  const open = async (p, id) => { await p.evaluate(id => { closeModal(); closeModal(); openIssue(id); }, id); await sleep(300); };
  const scrimOn = p => p.evaluate(() => document.getElementById('scrim').classList.contains('on'));

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  /* Kullanıcılar: üye ve izleyici (ilk girişte parola değiştirir). */
  const mid = 'u_kdm' + RUN, vid = 'u_kdv' + RUN;
  await A.evaluate(async ([mid, vid, run]) => {
    await API.post('/api/sync', { changes: [
      { c: 'users', id: mid, op: 'put', data: { username: 'kdm' + run, name: 'Detay Üye', role: 'member', active: true, ini: 'DÜ', color: '#0F766E' } },
      { c: 'users', id: vid, op: 'put', data: { username: 'kdv' + run, name: 'Detay İzleyici', role: 'viewer', active: true, ini: 'Dİ', color: '#64748B' } }] });
  }, [mid, vid, RUN]);
  await sleep(1200);
  /* Test verisi: ana iş (yorum, süre kaydı, bağlantı, 2 alt iş), boş iş, XSS'li iş, ham kimlikli eski geçmiş. */
  await A.evaluate(([ids, run, mid, vid, xss]) => {
    const pr = DB.projects.find(x => x.id === 'p1');
    pr.roles = { ...(pr.roles || {}), [mid]: 'member', [vid]: 'viewer' };   // yetki-v2: projeye proje rolüyle
    pr.members = [...new Set([...(pr.members || []), mid, vid])];
    const st = statsOf('p1');
    const mkI = (id, n, extra) => ({ id, projectId: 'p1', key: `${pr.key}-${++pr.counter}`, type: 'task', summary: `KD-T${run} ${n}`, description: '',
      statusId: st[0].id, assignee: null, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: -2000 + n,
      start: '', due: '', estimate: 6, remainingEst: 6, spent: 0, ...extra });
    DB.issues.push(mkI(ids.main, 1, { description: 'Satır 1\nSatır 2', start: '2026-11-12', due: '2026-11-17', spent: 2, remainingEst: 4 }));
    DB.issues.push(mkI(ids.k1, 2, { type: 'sub', parentId: ids.main }), mkI(ids.k2, 3, { type: 'sub', parentId: ids.main, statusId: st.find(s => s.cat === 'done').id }));
    DB.issues.push(mkI(ids.other, 4, {}), mkI(ids.xss, 5, { summary: xss, description: xss, labels: [xss] }), mkI(ids.del, 6, {}), mkI(ids.dk, 7, { type: 'sub', parentId: ids.del }));
    DB.links.push({ id: 'l_kd' + run, from: ids.main, to: ids.other, type: 'blocks' }, { id: 'l_kdd' + run, from: ids.del, to: ids.other, type: 'relates' });
    DB.comments.push({ id: 'c_kda' + run, issueId: ids.main, userId: ME.id, at: Date.now() - 60000, body: 'Yönetici yorumu\n2. satır' },
      { id: 'c_kdx' + run, issueId: ids.xss, userId: ME.id, at: Date.now(), body: xss },
      { id: 'c_kdd' + run, issueId: ids.del, userId: ME.id, at: Date.now(), body: 'silinecek' });
    DB.worklogs.push({ id: 'w_kd' + run, issueId: ids.main, userId: ME.id, date: TODAY, hours: 2, comment: 'ilk kayıt', adj: 'auto' },
      { id: 'w_kdd' + run, issueId: ids.del, userId: ME.id, date: TODAY, hours: 3, comment: 'sil', adj: 'auto' });
    issue(ids.del).spent = 3;
    const sp = DB.sprints.find(s => s.projectId === 'p1');
    DB.history.push({ id: 'h_kd' + run, issueId: ids.main, userId: ME.id, at: Date.now() - 120000, field: 'Raporlayan', from: '—', to: ME.id },
      { id: 'h_kd2' + run, issueId: ids.main, userId: ME.id, at: Date.now() - 110000, field: 'Tip', from: 'bug', to: 'task' },
      ...(sp ? [{ id: 'h_kd3' + run, issueId: ids.main, userId: ME.id, at: Date.now() - 100000, field: 'Sprint', from: '—', to: sp.id }] : []));
    save();
  }, [{ main: ID('main'), k1: ID('k1'), k2: ID('k2'), other: ID('other'), xss: ID('xss'), del: ID('del'), dk: ID('dk') }, RUN, mid, vid, XSS]);
  await sleep(1800);

  // 1) kabuk: üst şerit, sol akış, sağ gruplar; tek kabuk + parça yenileme
  await A.evaluate(() => { location.hash = 'board'; }); await sleep(500);
  await open(A, ID('main'));
  const sh = await A.evaluate(() => ({ head: !!document.querySelector('#idHead [data-f="statusId"]') && !!document.getElementById('logHere') && !!document.getElementById('idMore'),
    groups: [...document.querySelectorAll('#idSide .id-gh')].map(e => e.textContent.trim()), role: document.querySelector('#scrim .modal').getAttribute('role'),
    desc: document.querySelector('#idD .id-desc')?.textContent, close: document.querySelector('#idHead [data-close]')?.getAttribute('aria-label') }));
  ok('detail shell: head actions, grouped side, dialog role', sh.head && sh.role === 'dialog' && sh.close === 'Kapat'
    && ['Durum', 'Kişiler', 'Planlama', 'Zaman', 'Faturalama', 'Etiketler'].every(g => sh.groups.includes(g)), JSON.stringify(sh));
  ok('description keeps line breaks', sh.desc === 'Satır 1\nSatır 2', JSON.stringify(sh.desc));
  ok('old raw-id history shown by name (Raporlayan, Tip, Sprint)', await A.evaluate(() => {
    const t = document.getElementById('idA').textContent; return t.includes(ME.name || user(ME.id).name) && t.includes('Hata') && t.includes('Görev') && !t.includes(ME.id); }));
  await A.screenshot({ path: SS + 'detail.png' });

  // 2) satır içi başlık: Enter kaydeder, Esc vazgeçer, boş başlık kaydedilmez, dışarı tıklama kaydeder
  const shellBefore = await A.evaluate(() => { const m = document.querySelector('#scrim .modal'); m.__mark = 1; return 1; });
  await A.click('#idT [data-ie="summary"]'); await sleep(150);
  await A.fill('#idSumIn', `KD-T${RUN} başlık yeni`); await A.keyboard.press('Enter'); await sleep(250);
  ok('title Enter saves + history, shell not rebuilt', await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} başlık yeni`
    && DB.history.some(h => h.issueId === id && h.field === 'Özet') && document.querySelector('#scrim .modal').__mark === 1 && !document.getElementById('idSumIn'), [ID('main'), RUN]) && shellBefore);
  await A.click('#idT [data-ie="summary"]'); await sleep(150);
  await A.fill('#idSumIn', 'vazgeçilecek'); await A.keyboard.press('Escape'); await sleep(200);
  ok('title Esc cancels, modal stays open', await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} başlık yeni`, [ID('main'), RUN]) && await scrimOn(A));
  await A.click('#idT [data-ie="summary"]'); await sleep(150);
  await A.fill('#idSumIn', '   '); await A.keyboard.press('Enter'); await sleep(200);
  const emp = await A.evaluate(() => ({ err: document.getElementById('idSumErr')?.textContent || '', open: !!document.getElementById('idSumIn') }));
  ok('empty title: "Başlık boş olamaz", not saved', emp.open && /Başlık boş olamaz/.test(emp.err) && await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} başlık yeni`, [ID('main'), RUN]), JSON.stringify(emp));
  await A.fill('#idSumIn', `KD-T${RUN} başlık dış`); await A.click('#idSide .id-gh'); await sleep(250);
  ok('title blur (outside click) saves', await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} başlık dış`, [ID('main'), RUN]));

  // 3) açıklama: Kaydet/Vazgeç, satır sonu korunur, Ctrl+Enter
  await A.click('#idD [data-ie="description"]'); await sleep(150);
  await A.fill('#idDescIn', 'A\nB\n\nC'); await A.click('#idDescNo'); await sleep(150);
  ok('description Vazgeç keeps old', await A.evaluate(id => issue(id).description === 'Satır 1\nSatır 2', ID('main')));
  await A.click('#idD [data-ie="description"]'); await sleep(150);
  await A.fill('#idDescIn', 'A\nB\n\nC'); await A.keyboard.press('Control+Enter'); await sleep(200);
  ok('description Ctrl+Enter saves with line breaks', await A.evaluate(id => issue(id).description === 'A\nB\n\nC' && document.querySelector('#idD .id-desc').textContent === 'A\nB\n\nC', ID('main')));

  // 4) özellik satırı: Puan/Tahmin satır içi, "Kaydedildi"; menüler; Esc önce menüyü kapatır
  await A.click('#idSide [data-ie="estimate"]'); await sleep(150);
  await A.fill('#ie_estimate', '10h'); await A.keyboard.press('Enter'); await sleep(200);
  ok('estimate inline saved + "Kaydedildi"', await A.evaluate(id => issue(id).estimate === 10 && !!document.querySelector('#idSide .id-saved'), ID('main')));
  await A.click('#idSide [data-f="priority"]'); await sleep(200);
  await A.keyboard.press('Escape'); await sleep(150);
  ok('Esc closes menu first, modal stays', !(await A.evaluate(() => !!document.querySelector('.qm'))) && await scrimOn(A)
    && await A.evaluate(() => document.activeElement?.dataset?.f === 'priority'));
  await A.click('#idHead [data-f="statusId"]'); await sleep(200);
  const st2 = await A.evaluate(id => statsOf(issue(id).projectId)[1].id, ID('main'));
  await A.click(`.qm [data-qv="${st2}"]`); await sleep(250);
  ok('status menu changes status + head/side refreshed', await A.evaluate(([id, s]) => issue(id).statusId === s
    && document.querySelector('#idHead [data-f="statusId"]').textContent.includes(stat(s).name), [ID('main'), st2]));
  await A.click('#idSide [data-f="assignee"]'); await sleep(200);
  const asm = await A.evaluate(() => [...document.querySelectorAll('.qm [data-qv]')].map(x => x.dataset.qv));
  await A.click(`.qm [data-qv="${mid}"]`); await sleep(250);
  ok('assignee person menu (Bana ata + members) assigns', asm.includes(mid) && await A.evaluate(([id, m]) => issue(id).assignee === m, [ID('main'), mid]), JSON.stringify(asm));
  await A.keyboard.press('Escape'); await sleep(200);
  ok('Esc then closes the modal', !(await scrimOn(A)));

  // 5) tarih bileşeni: "18 Kas 2026 Çar" biçimi; bitiş < başlangıç kırmızı uyarı, kaydedilmez; gecikmiş çip
  await open(A, ID('main'));
  const df = await A.evaluate(() => ({ s: document.querySelector('[data-dfbtn="idStart"] .t').textContent, late: document.querySelector('#idSide .id-late')?.textContent || '' }));
  ok('date shown long ("12 Kas 2026 Per") + late chip', df.s === '12 Kas 2026Per' && /gün gecikti/.test(df.late), JSON.stringify(df));
  await A.evaluate(() => { const i = document.getElementById('idDue'); i.value = '2026-11-10'; i.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(200);
  const bad = await A.evaluate(id => ({ due: issue(id).due, err: document.getElementById('idDue_e')?.textContent || '', red: document.querySelector('[data-df="idDue"]').classList.contains('bad') }), ID('main'));
  ok('due before start: red warning, not saved', bad.due === '2026-11-17' && bad.red && /Bitiş, başlangıçtan \(12 Kas 2026\) önce olamaz/.test(bad.err), JSON.stringify(bad));
  await A.click('[data-df="idDue"] [data-dfq]:not(.clr)'); await sleep(200);
  ok('date shortcut "Bugün" saves', await A.evaluate(id => issue(id).due === TODAY && !document.querySelector('[data-df="idDue"]').classList.contains('bad'), ID('main')));
  await A.evaluate(id => { issue(id).due = '2026-11-17'; save(); }, ID('main'));

  // 6) başkasının değişikliği pencere açıkken: açık düzenleyici korunur, "Bu alan az önce değişti" uyarısı
  const M = await mk('member'); await login(M, 'kdm' + RUN, 'Baslangic123');
  await M.fill('#fp_a', 'DetayUye12345'); await M.fill('#fp_b', 'DetayUye12345'); await M.click('#fpForm button[type=submit]'); await sleep(1800);
  await open(A, ID('main'));
  await A.click('#idT [data-ie="summary"]'); await sleep(150);
  await A.fill('#idSumIn', `KD-T${RUN} benim`);
  await M.evaluate(([id, run]) => { const i = issue(id); i.summary = `KD-T${run} onun`; i.priority = 1; save(); }, [ID('main'), RUN]);
  let stale = null;
  for (let k = 0; k < 20 && !stale; k++) { await sleep(500); stale = await A.evaluate(() => { const b = document.getElementById('idSumStale'); return b && !b.hidden ? b.textContent : null; }); }
  const keep = await A.evaluate(run => ({ val: document.getElementById('idSumIn')?.value, pri: document.querySelector('#idSide [data-f="priority"]').textContent.trim() }), RUN);
  ok('remote change while editing: editor kept, warning shown, other parts refreshed', !!stale && /Bu alan az önce değişti/.test(stale) && stale.includes('onun')
    && keep.val === `KD-T${RUN} benim` && keep.pri === 'Acil', JSON.stringify([stale, keep]));
  await A.keyboard.press('Enter'); await sleep(200);
  ok('Enter on stale does not overwrite silently', await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} onun`, [ID('main'), RUN]));
  await A.click('[data-stale="save"]'); await sleep(250);
  ok('"Yine de kaydet" writes mine', await A.evaluate(([id, run]) => issue(id).summary === `KD-T${run} benim` && !document.getElementById('idSumIn'), [ID('main'), RUN]));

  // 7) süre kaydet: iş başlıkta, çip, notsuz hata, Ctrl+Enter, önizleme; detay kapanmaz
  await A.click('#logHere'); await sleep(300);
  const wf = await A.evaluate(id => ({ sub: !!document.querySelector('#scrim2.on #w_h'), hidden: document.getElementById('w_i')?.type === 'hidden' && document.getElementById('w_i').value === id,
    head: document.querySelector('#scrim2 .id-mh .sub')?.textContent.includes(issue(id).key), date: document.getElementById('w_d').value === TODAY,
    behind: document.getElementById('scrim').classList.contains('on') }), ID('main'));
  ok('worklog dialog over detail, issue read-only in header, date today', Object.values(wf).every(Boolean), JSON.stringify(wf));
  await A.click('[data-wch="2h"]'); await sleep(100);
  const prev = await A.evaluate(() => ({ h: document.getElementById('w_h').value, prev: document.getElementById('w_prev').textContent.replace(/\s+/g, ' ') }));
  ok('chip fills duration + remaining preview', prev.h === '2h' && /Kalan tahmin/.test(prev.prev), JSON.stringify(prev));
  await A.keyboard.press('Control+Enter'); await sleep(200);
  ok('note required: error under field, not saved', await A.evaluate(() => /Not zorunlu/.test(document.getElementById('w_c_e').textContent) && !!document.querySelector('#scrim2.on')));
  const wl0 = await A.evaluate(id => DB.worklogs.filter(w => w.issueId === id).length, ID('main'));
  await A.fill('#w_c', 'çip ile kayıt'); await A.keyboard.press('Control+Enter'); await sleep(300);
  ok('Ctrl+Enter saves, detail stays open and shows it', await A.evaluate(([id, n]) => DB.worklogs.filter(w => w.issueId === id).length === n + 1
    && document.getElementById('scrim').classList.contains('on') && !document.querySelector('#scrim2.on') && document.getElementById('idA').textContent.includes('çip ile kayıt'), [ID('main'), wl0]));

  // 8) alt işler: art arda Enter, imleç satırda kalır, ilerleme 2/4 → sonra tamamla 3/4; önek aynen
  await A.click('#subIn'); await A.keyboard.type('alt A'); await A.keyboard.press('Enter'); await sleep(250);
  await A.keyboard.type('alt B'); await A.keyboard.press('Enter'); await sleep(250);
  const subs = await A.evaluate(id => ({ n: kidsOf(id).length, focus: document.activeElement?.id, val: document.getElementById('subIn').value,
    cnt: document.querySelector('#idS .id-cnt')?.textContent, keys: kidsOf(id).slice(-2).map(k => k.key), pk: DB.projects.find(p => p.id === 'p1') }), ID('main'));
  const pre = subs.pk.code || subs.pk.key;
  ok('inline sub add: Enter twice, focus stays, 1/4', subs.n === 4 && subs.focus === 'subIn' && subs.val === '' && subs.cnt === '1/4', JSON.stringify(subs));
  ok('sub key prefix unchanged', subs.keys.every(k => k.startsWith(pre + '-')), JSON.stringify(subs.keys));
  await A.click(`[data-subdone="${ID('k1')}"]`); await sleep(300);
  ok('complete checkbox → 2/4', await A.evaluate(() => document.querySelector('#idS .id-cnt')?.textContent) === '2/4');

  // 9) yorum: Ctrl+Enter, düzenle (düzenlendi), sil → onay → Geri al
  await A.click('#newCmt'); await A.keyboard.type('Yeni yorum ' + RUN); await A.keyboard.press('Control+Enter'); await sleep(250);
  const cid = await A.evaluate(([id, run]) => DB.comments.find(c => c.issueId === id && c.body === 'Yeni yorum ' + run)?.id, [ID('main'), RUN]);
  ok('comment added with Ctrl+Enter', !!cid);
  await A.click(`[data-cedit="${cid}"]`); await sleep(150);
  await A.fill(`#ce_${cid}`, 'Düzenlenmiş ' + RUN); await A.keyboard.press('Control+Enter'); await sleep(250);
  ok('comment edited + "düzenlendi"', await A.evaluate(([c, run]) => DB.comments.find(x => x.id === c).body === 'Düzenlenmiş ' + run
    && !!document.querySelector('#idA .id-edited'), [cid, RUN]));
  await A.click(`[data-cdel="${cid}"]`); await sleep(250);
  ok('comment delete: confirm dialog, focus on Vazgeç', await A.evaluate(() => !!document.querySelector('#scrim2.on [role="alertdialog"], #scrim2.on .modal[role="alertdialog"]') && document.activeElement?.id === 'delNo'));
  await A.click('#delOk'); await sleep(250);
  ok('comment removed locally, "Geri al" toast', await A.evaluate(c => !DB.comments.some(x => x.id === c) && /Yorum silindi/.test(document.getElementById('toast').textContent)
    && !!document.querySelector('#toast .toast-undo'), cid));
  await A.click('#toast .toast-undo'); await sleep(300);
  ok('comment undo restores', await A.evaluate(c => DB.comments.some(x => x.id === c) && document.getElementById('idA').textContent.includes('Düzenlenmiş'), cid));
  await sleep(1500);
  ok('restored comment still on server', await srv(A, (r, c) => r.comments.some(x => x.id === c), cid));

  // 10) süre kaydı silme + Geri al (iş kaydı da bekletilir)
  const wid = 'w_kd' + RUN;
  const sp0 = await A.evaluate(id => issue(id).spent, ID('main'));
  await A.click(`#idA [data-delwl="${wid}"]`); await sleep(250); await A.click('#delOk'); await sleep(250);
  ok('worklog delete → spent reduced, toast', await A.evaluate(([id, w, s]) => !DB.worklogs.some(x => x.id === w) && issue(id).spent === s - 2
    && /Süre kaydı silindi: 2h/.test(document.getElementById('toast').textContent), [ID('main'), wid, sp0]));
  await A.click('#toast .toast-undo'); await sleep(300);
  ok('worklog undo restores record and spent', await A.evaluate(([id, w, s]) => DB.worklogs.some(x => x.id === w) && issue(id).spent === s, [ID('main'), wid, sp0]));
  await A.evaluate(() => closeModal());

  // 11) iş silme: sayılar, 8 sn bekletme (sunucuya istek yok), Geri al; sonra süre dolunca sunucuda silinir, yetim yok
  const dels = [];
  A.on('request', r => { if (r.url().includes('/api/sync') && r.method() === 'POST' && (r.postData() || '').includes('"del"')) dels.push(r.postData()); });
  await open(A, ID('del'));
  await A.click('#idMore'); await sleep(200); await A.click('.qm [data-qv="del"]'); await sleep(300);
  const dc = await A.evaluate(() => ({ t: document.querySelector('#scrim2 .id-delc')?.textContent.replace(/\s+/g, ' '), w: document.querySelector('#scrim2 .id-delw')?.textContent || '',
    item: document.querySelector('#scrim2 .id-delitem')?.textContent || '', foc: document.activeElement?.id }));
  ok('delete confirm: counts (1 yorum, 1 süre kaydı · 3h, 1 bağlantı), 1 alt iş bağı, focus Vazgeç',
    /1\s*yorum/.test(dc.t) && /1\s*süre kaydı · 3h/.test(dc.t) && /1\s*bağlantı/.test(dc.t) && /1 alt işin üst iş bağı kopar/.test(dc.w) && dc.foc === 'delNo', JSON.stringify(dc));
  await A.keyboard.press('Enter'); await sleep(200);
  ok('Enter on focused Vazgeç does not delete', await A.evaluate(id => !!issue(id), ID('del')) && await A.evaluate(() => !document.querySelector('#scrim2.on')));
  await A.click('#idMore'); await sleep(200); await A.click('.qm [data-qv="del"]'); await sleep(300); await A.click('#delOk'); await sleep(300);
  ok('deleted locally, modal closed, toast with Geri al', await A.evaluate(([id, k]) => !issue(id) && issue(k).parentId === null && !DB.comments.some(c => c.issueId === id)
    && !document.getElementById('scrim').classList.contains('on') && !!document.querySelector('#toast .toast-undo'), [ID('del'), ID('dk')]));
  await sleep(2500);
  ok('during hold: nothing sent to server', dels.length === 0 && await srv(A, (r, id) => r.issues.some(i => i.id === id), ID('del')), String(dels.length));
  await A.click('#toast .toast-undo'); await sleep(400);
  ok('undo restores issue, comment, worklog, link, sub-issue parent', await A.evaluate(([id, k, run]) => !!issue(id) && issue(k).parentId === id
    && DB.comments.some(c => c.id === 'c_kdd' + run) && DB.worklogs.some(w => w.id === 'w_kdd' + run) && DB.links.some(l => l.id === 'l_kdd' + run), [ID('del'), ID('dk'), RUN]));
  await sleep(1500);
  ok('after undo: still nothing deleted on server', dels.length === 0);
  await open(A, ID('del'));
  await A.click('#idMore'); await sleep(200); await A.click('.qm [data-qv="del"]'); await sleep(300); await A.click('#delOk'); await sleep(300);
  await sleep(9500);
  const gone = await srv(A, (r, [id, k]) => ({ issue: r.issues.some(i => i.id === id), orphans: ['comments', 'worklogs', 'history', 'transitions'].reduce((a, c) => a + r[c].filter(x => x.issueId === id).length, 0)
    + r.links.filter(l => l.from === id || l.to === id).length, kidParent: r.issues.find(i => i.id === k)?.parentId ?? null }), [ID('del'), ID('dk')]);
  ok('after 8 s: deleted on server, no orphans, sub-issue detached', !gone.issue && gone.orphans === 0 && gone.kidParent === null && dels.length > 0, JSON.stringify(gone));

  // 12) yorum sahipliği: üye yöneticinin yorumunda Düzenle/Sil görmez, kendi yorumunda görür
  await M.evaluate(() => { location.hash = 'board'; }); await sleep(400);
  await open(M, ID('main'));
  await M.click('#newCmt'); await M.keyboard.type('üye yorumu'); await M.keyboard.press('Control+Enter'); await sleep(300);
  const own = await M.evaluate(run => { const mine = DB.comments.find(c => c.body === 'üye yorumu' && c.userId === ME.id);
    return { foreign: !!document.querySelector(`[data-cedit="c_kda${run}"],[data-cdel="c_kda${run}"]`), mine: !!mine && !!document.querySelector(`[data-cedit="${mine.id}"]`) && !!document.querySelector(`[data-cdel="${mine.id}"]`) }; }, RUN);
  ok('member: no edit/delete on others comment, has on own', !own.foreign && own.mine, JSON.stringify(own));

  // 13) izleyici: düzenleme imleci, ekleme satırı, Süre kaydet, Sil, yorum kutusu yok
  const V = await mk('viewer'); await login(V, 'kdv' + RUN, 'Baslangic123');
  await V.fill('#fp_a', 'DetayIzl12345'); await V.fill('#fp_b', 'DetayIzl12345'); await V.click('#fpForm button[type=submit]'); await sleep(1800);
  await open(V, ID('main'));
  const vv = await V.evaluate(() => ({ ie: document.querySelectorAll('#scrim [data-ie],[data-pm],#subIn,#logHere,#idMore,#newCmt,#newLabel,[data-cdel],[data-delwl],[data-dfbtn]').length,
    title: document.getElementById('idTitle')?.textContent.length > 0, inputs: document.querySelectorAll('#scrim input:not([type=hidden]),#scrim textarea,#scrim select').length }));
  ok('viewer: no edit affordances rendered at all', vv.ie === 0 && vv.inputs === 0 && vv.title, JSON.stringify(vv));
  await V.evaluate(() => worklogForm({ issueId: OPEN_ISSUE })); await sleep(200);
  ok('viewer: worklog form cannot open', !(await V.evaluate(() => !!document.getElementById('w_h'))));
  await V.screenshot({ path: SS + 'viewer.png' });

  // 14) XSS: özet, açıklama, yorum, etiket kaçışlı
  await open(A, ID('xss'));
  const xs = await A.evaluate(() => ({ img: document.querySelectorAll('#scrim img').length, xss: !!window.__xss, t: document.getElementById('idTitle').textContent }));
  ok('xss escaped in detail', xs.img === 0 && !xs.xss && xs.t.startsWith('<img'), JSON.stringify(xs));
  await A.evaluate(() => closeModal());

  // 15) yeni iş formu: tip kartları, 4'lü öncelik (Orta), Bana ata, boş özet hatası, Oluştur ve yenisini aç
  await A.evaluate(() => { DB.ui.project = 'p1'; location.hash = 'board'; }); await sleep(400);
  await A.keyboard.press('c'); await sleep(300);
  const nf = await A.evaluate(() => ({ cards: document.querySelectorAll('#scrim .id-tcard[role=radio]').length, pri: [...document.querySelectorAll('#f_pri [data-pri]')].map(b => b.getAttribute('aria-checked')).join(),
    focus: document.activeElement?.id, more: document.getElementById('f_more').hidden }));
  ok('new issue form: type cards, Orta selected, summary focused, more fields hidden', nf.cards >= 2 && nf.pri === 'false,false,true,false' && nf.focus === 'f_sum' && nf.more, JSON.stringify(nf));
  await A.click('#doCreate'); await sleep(150);
  ok('empty summary: error under field, dialog stays', await A.evaluate(() => /Özet boş olamaz/.test(document.getElementById('f_sum_e').textContent) && document.activeElement?.id === 'f_sum'));
  await A.click('#scrim .id-tcard[data-type="bug"]'); await A.click('#f_pri [data-pri="2"]'); await A.click('#f_me'); await sleep(100);
  await A.fill('#f_sum', `KD-T${RUN} yeni 1`);
  await A.evaluate(() => { const i = document.getElementById('f_due'); i.value = '2026-11-25'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  const n0 = await A.evaluate(() => DB.issues.length);
  await A.click('#doCreateMore'); await sleep(300);
  const c1 = await A.evaluate(([run, n0]) => { const it = DB.issues.find(i => i.summary === `KD-T${run} yeni 1`);
    return { made: DB.issues.length === n0 + 1, type: it?.type, pri: it?.priority, as: it?.assignee === ME.id, due: it?.due, rep: it?.reporter === ME.id, key: it?.key,
      keepType: document.querySelector('#scrim .id-tcard[aria-checked="true"]')?.dataset.type, keepPri: document.querySelector('#f_pri [aria-checked="true"]')?.dataset.pri,
      empty: document.getElementById('f_sum').value === '', focus: document.activeElement?.id }; }, [RUN, n0]);
  ok('"Oluştur ve yenisini aç": created (bug, Yüksek, me, due), form reopened keeping type/priority', c1.made && c1.type === 'bug' && c1.pri === 2 && c1.as && c1.due === '2026-11-25'
    && c1.rep && c1.keepType === 'bug' && c1.keepPri === '2' && c1.empty && c1.focus === 'f_sum', JSON.stringify(c1));
  ok('new issue key prefix unchanged', c1.key?.startsWith(subs.pk.key + '-'), c1.key);
  await A.fill('#f_sum', `KD-T${RUN} yeni 2`); await A.keyboard.press('Control+Enter'); await sleep(300);
  ok('Ctrl+Enter creates and closes', await A.evaluate(run => DB.issues.some(i => i.summary === `KD-T${run} yeni 2`) && !document.getElementById('scrim').classList.contains('on'), RUN));
  await A.keyboard.press('c'); await sleep(300);
  await A.evaluate(() => { const s = document.getElementById('f_start'), d = document.getElementById('f_due'); s.value = '2026-11-20'; d.value = '2026-11-10';
    d.dispatchEvent(new Event('change', { bubbles: true })); });
  await A.fill('#f_sum', `KD-T${RUN} tarih`); await A.click('#doCreate'); await sleep(200);
  ok('new issue: due before start blocks creation', await A.evaluate(run => !DB.issues.some(i => i.summary === `KD-T${run} tarih`) && /önce olamaz/.test(document.getElementById('f_due_e').textContent), RUN));
  await A.screenshot({ path: SS + 'new.png' });
  await A.keyboard.press('Escape'); await sleep(150);

  // 15b) toplu silme: aynı onay + Geri al (confirm() yok)
  await A.evaluate(() => { location.hash = 'search'; }); await sleep(500);
  const bulk = await A.evaluate(run => DB.issues.filter(i => i.summary === `KD-T${run} yeni 1` || i.summary === `KD-T${run} yeni 2`).map(i => i.id), RUN);
  await A.evaluate(ids => { SEL.clear(); ids.forEach(id => SEL.add(id)); render(); }, bulk); await sleep(300);
  await A.click('#bk_del'); await sleep(250);
  ok('bulk delete: confirm dialog "2 iş silinsin mi?"', await A.evaluate(() => document.getElementById('delTitle')?.textContent === '2 iş silinsin mi?'));
  await A.click('#delOk'); await sleep(250);
  ok('bulk delete: removed locally + Geri al', await A.evaluate(ids => ids.every(id => !issue(id)) && !!document.querySelector('#toast .toast-undo'), bulk));
  await A.click('#toast .toast-undo'); await sleep(300);
  ok('bulk delete: undo restores both', await A.evaluate(ids => ids.every(id => !!issue(id)), bulk));

  // 16) mobil 390px: tam ekran, taşma yok, özellikler başlık altında, dokunma ≥ 44px, menü alt sayfa
  const Mo = await mk('mobile', { width: 390, height: 844 }); await login(Mo, 'admin', 'admin12345');
  await Mo.evaluate(() => { location.hash = 'board'; }); await sleep(400);
  await open(Mo, ID('main'));
  const mob = await Mo.evaluate(() => { const m = document.querySelector('#scrim .modal'), r = m.getBoundingClientRect(), t = document.getElementById('idT').getBoundingClientRect(),
    s = document.getElementById('idSide').getBoundingClientRect(), d = document.getElementById('idD').getBoundingClientRect();
    const hs = [...document.querySelectorAll('#idHead button')].map(b => b.getBoundingClientRect().height);
    return { w: Math.round(r.width), left: Math.round(r.left), ov: m.scrollWidth - m.clientWidth, order: t.top < s.top && s.top < d.top, minBtn: Math.min(...hs) }; });
  ok('mobile: full-screen, no overflow, props under title, head buttons ≥ 44px', mob.w === 390 && mob.left === 0 && mob.ov <= 1 && mob.order && mob.minBtn >= 44, JSON.stringify(mob));
  await Mo.click('#idSide [data-f="priority"]'); await sleep(250);
  ok('mobile: menu as bottom sheet', await Mo.evaluate(() => !!document.querySelector('.qm-wrap.sheet .qm')));
  await Mo.screenshot({ path: SS + 'mobile.png' });
  await Mo.keyboard.press('Escape'); await sleep(150);
  await Mo.evaluate(() => { const y = document.getElementById('scrim'); y.scrollTop = 600; }); await sleep(100);
  ok('mobile: head stays sticky on scroll', await Mo.evaluate(() => Math.abs(document.getElementById('idHead').getBoundingClientRect().top) <= 1));

  // 17) koyu tema ekran görüntüsü
  const D = await mk('dark', undefined, 'dark'); await login(D, 'admin', 'admin12345');
  await open(D, ID('main')); await D.screenshot({ path: SS + 'dark.png' });

  console.log(errs.length ? errs.join('\n') : 'no page errors / dialogs');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
