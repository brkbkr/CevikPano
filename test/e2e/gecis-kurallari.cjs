// İş akışı geçiş kuralları tarayıcı testi (gk). Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri); test kendi
// kullanıcılarını ve projesini oluşturur, diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: proje Yöneticisi Proje ayarları → İş akışı → Geçiş kuralları'nda "Bitti kategorisine geçiş: süre kaydı + Fatura türü"
// kuralı ekler (sunucuya yazılır). Üye panoda kartı Bitti'ye sürükler → kart yerinde kalır, eksikler uyarıda ("Bitti'ye geçmek
// için: süre kaydı girin, Fatura türü seçin"); iş detayındaki durum menüsünde Bitti'nin altında eksikler; seçince yine uyarı.
// Süre + Fatura türü girilince sürükleme geçer. Eski istemci (kuralı atlayan) taşırsa sunucu reddeder, iş geri döner.
// Rol kuralı (Onaylandı: yalnız Yönetici) Üye'de menü notu; Yönetici taşır. Yalnız "Proje adı ve ayarları" yetkisi olan Üye
// İş akışı sekmesinde yalnız geçiş kurallarını görür. XSS: alan adı metin olarak basılır. 390 px: yatay kaydırma yok.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SS = process.env.SS_DIR || '/tmp/pano_gecis_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const XSS = '<img src=x onerror="window.__xss=1">';
const Y = 'u_gky' + R, M = 'u_gkm' + R;
const P = 'p_gk' + R, KEY = 'GK' + R.toUpperCase();
const S = { todo: P + '_s0', dev: P + '_s1', done: P + '_s2', ok: P + '_s3' };
const I1 = 'i_gk1' + R, I2 = 'i_gk2' + R, I3 = 'i_gk3' + R, FX = 'cf_gkx' + R;
const MSG = "Bitti'ye geçmek için: süre kaydı girin, Fatura türü seçin";

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 }); const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw); await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) { await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800); }
  };
  const flush = p => p.evaluate(() => flushAll());
  const waitFor = async (p, fn, arg, ms = 10000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return Date.now() - t0; await sleep(250); } return -1; };
  const srv = (p, c, id) => p.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c].find(x => x.id === id) || null, [c, id]);
  const toastTx = p => p.evaluate(() => { const t = document.getElementById('toast'); return t.classList.contains('on') ? t.textContent.trim() : ''; });
  const noHScroll = p => p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  const openWorkflow = p => p.evaluate(pid => { closeModal(); DB.ui.project = pid; DB.ui.view = 'admin'; DB.ui.adminTab = 'workflow'; render(); }, P);
  const openBoard = p => p.evaluate(([pid, S]) => { closeModal(); DB.ui.project = pid; DB.ui.view = 'board'; DB.board.scope = 'all';
    DB.ui.doneOpen = { ...(DB.ui.doneOpen || {}), [S.done]: true, [S.ok]: true }; render(); }, [P, S]);
  const colOf = (p, id) => p.evaluate(id => issue(id)?.statusId, id);
  const drag = async (p, id, sid) => {
    await p.dragAndDrop(`.card[data-id="${id}"]`, `.col-b[data-status="${sid}"]`); await sleep(400);
  };

  /* ---- kurulum: Y (proje Yöneticisi), M (Üye), proje + 4 kolon + işler + XSS adlı özel alan ---- */
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  let r = await A.evaluate(async ([R, Y, M, P, KEY, S, I1, I2, I3, FX, XSS]) => (await API.post('/api/sync', { changes: [
    { c: 'users', id: Y, op: 'put', data: { username: 'gky' + R, name: 'Geçiş Yöneticisi ' + R, role: 'member', active: true, ini: 'GY', color: '#2563EB' } },
    { c: 'users', id: M, op: 'put', data: { username: 'gkm' + R, name: 'Geçiş Üyesi ' + R, role: 'member', active: true, ini: 'GÜ', color: '#0F766E' } },
    { c: 'projects', id: P, op: 'put', data: { name: 'Geçiş Projesi ' + R, key: KEY, code: KEY, counter: 3, workspaceId: 'ws1', type: 'board', roles: { [Y]: 'admin', [M]: 'member' } } },
    { c: 'statuses', id: S.todo, op: 'put', data: { projectId: P, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 } },
    { c: 'statuses', id: S.dev, op: 'put', data: { projectId: P, name: 'Devam', cat: 'inprogress', wip: 0, ord: 1 } },
    { c: 'statuses', id: S.done, op: 'put', data: { projectId: P, name: 'Bitti', cat: 'done', wip: 0, ord: 2 } },
    { c: 'statuses', id: S.ok, op: 'put', data: { projectId: P, name: 'Onaylandı', cat: 'done', wip: 0, ord: 3 } },
    { c: 'fields', id: FX, op: 'put', data: { projectId: P, key: 'gkx' + R, name: 'Kod ' + XSS, type: 'text' } },
    ...[I1, I2, I3].map((id, k) => ({ c: 'issues', id, op: 'put', data: { projectId: P, key: KEY + '-' + (k + 1), summary: 'Geçiş işi ' + (k + 1), type: 'task',
      statusId: S.todo, priority: 3, created: Date.now(), updatedAt: Date.now(), reporter: Y, assignee: M, labels: [], rank: k + 1, estimate: 0, spent: 0 } })),
  ] })), [R, Y, M, P, KEY, S, I1, I2, I3, FX, XSS]);
  ok('setup accepted', r.rejected.length === 0, JSON.stringify(r.rejected));

  /* ---- 1) proje Yöneticisi: İş akışı → Geçiş kuralları ---- */
  const Yp = await mk('projadmin'); await login(Yp, 'gky' + R, 'Baslangic123', 'GkYon123456!');
  await openWorkflow(Yp); await sleep(300);
  const t0 = await Yp.evaluate(() => ({ panel: !!document.getElementById('gkPanel'), empty: document.querySelector('#gkPanel .empty')?.textContent || '',
    add: !!document.getElementById('gkAdd'), cols: !!document.querySelector('[data-st]') }));
  ok('workflow tab: rules panel, empty state, add button (columns still shown)', t0.panel && /Geçiş kuralı yok/.test(t0.empty) && t0.add && t0.cols, JSON.stringify(t0));
  await Yp.click('#gkAdd'); await sleep(300);
  const f0 = await Yp.evaluate(() => ({ to: document.getElementById('gk_to')?.value,
    fields: [...document.querySelectorAll('[data-gkf]')].map(x => x.dataset.gkf), xssTxt: [...document.querySelectorAll('#gk_fields .gk-cb b')].map(x => x.textContent) }));
  ok('form: default target Bitti category, bind + custom fields offered', f0.to === 'cat:done' && f0.fields.includes('bind:billType') && f0.fields.includes('bind:billable')
    && f0.fields.includes('cf:' + FX), JSON.stringify(f0));
  ok('form: XSS field name rendered as text', f0.xssTxt.some(t => t.includes('<img')) && !(await Yp.evaluate(() => window.__xss)));
  /* Koşulsuz kayıt reddedilir (formda ileti). */
  await Yp.click('#gk_ok'); await sleep(150);
  ok('form: needs at least one condition', /En az bir koşul/.test(await Yp.textContent('#gk_err')));
  await Yp.check('#gk_worklog'); await Yp.check('[data-gkf="bind:billType"]');
  await Yp.screenshot({ path: SS + 'form.png' });
  await Yp.click('#gk_ok'); await sleep(300);
  const t1 = await Yp.evaluate(() => ({ n: document.querySelectorAll('#gkPanel .gk-rule').length,
    chips: [...document.querySelectorAll('#gkPanel .gk-c .chip')].map(x => x.textContent), to: document.querySelector('#gkPanel .gk-to')?.textContent }));
  ok('rule listed with chips', t1.n === 1 && t1.chips.join('|') === 'Süre kaydı girilmiş|Fatura türü dolu' && /Bitti kategorisine geçmek için/.test(t1.to), JSON.stringify(t1));
  await flush(Yp); await sleep(300);
  const s1 = await srv(A, 'projects', P);
  ok('server: gates saved on project', s1?.gates?.length === 1 && s1.gates[0].cat === 'done' && s1.gates[0].worklog === true
    && JSON.stringify(s1.gates[0].fields) === '["bind:billType"]' && !s1.gates[0].roles, JSON.stringify(s1?.gates));
  /* Rol kuralı: Onaylandı kolonuna yalnız Yönetici. Aynı hedefe ikinci kural seçilemez. */
  await Yp.click('#gkAdd'); await sleep(300);
  ok('form: target with an existing rule is disabled', await Yp.evaluate(() => document.querySelector('#gk_to option[value="cat:done"]').disabled));
  await Yp.selectOption('#gk_to', 'st:' + S.ok); await Yp.selectOption('#gk_roles', 'admin');
  await Yp.click('#gk_ok'); await sleep(300);
  await Yp.screenshot({ path: SS + 'kurallar.png', fullPage: true });
  await flush(Yp); await sleep(300);
  ok('server: role rule saved', (await srv(A, 'projects', P))?.gates?.some(g => g.statusId === S.ok && JSON.stringify(g.roles) === '["admin"]'));

  /* ---- 2) Üye: panoda sürükle-bırak engellenir, eksikler uyarıda ---- */
  const Mp = await mk('member'); await login(Mp, 'gkm' + R, 'Baslangic123', 'GkUye123456!');
  await openBoard(Mp); await sleep(400);
  ok('member: no workflow tab (no settings/columns permission)', !(await Mp.evaluate(() => { DB.ui.view = 'admin'; render(); return adminTabs().some(x => x[0] === 'workflow'); })));
  await openBoard(Mp); await sleep(300);
  await drag(Mp, I1, S.done);
  const d1 = { col: await colOf(Mp, I1), toast: await toastTx(Mp) };
  ok('drag to Bitti blocked: card stays, toast lists what is missing', d1.col === S.todo && d1.toast === MSG, JSON.stringify(d1));
  await Mp.screenshot({ path: SS + 'pano.png' });
  /* Kategori içinde olmayan kolon serbest. */
  await drag(Mp, I1, S.dev);
  ok('drag to Devam (no rule) allowed', (await colOf(Mp, I1)) === S.dev);
  await flush(Mp); await sleep(300);
  ok('server: Devam saved, no Bitti', (await srv(A, 'issues', I1))?.statusId === S.dev);

  /* ---- 3) İş detayı: durum menüsünde eksikler, seçince uyarı ---- */
  await Mp.evaluate(id => { closeModal(); openIssue(id); }, I1); await sleep(400);
  await Mp.click('#idHead [data-pm="status"]'); await sleep(300);
  const m1 = await Mp.evaluate(S => { const o = q => document.querySelector(`.qm-opt[data-qv="${q}"] .qm-sub`)?.textContent || '';
    return { done: o(S.done), ok: o(S.ok), todo: o(S.todo) }; }, S);
  ok('detail menu: Bitti shows missing items, Onaylandı role note, Yapılacak none',
    m1.done === 'Önce: süre kaydı girin, Fatura türü seçin' && m1.ok === 'Yalnız Yönetici rolündekiler taşıyabilir' && m1.todo === '', JSON.stringify(m1));
  await Mp.screenshot({ path: SS + 'detay.png' });
  await Mp.click(`.qm-opt[data-qv="${S.done}"]`); await sleep(300);
  ok('detail pick Bitti blocked + toast', (await colOf(Mp, I1)) === S.dev && (await toastTx(Mp)) === MSG);

  /* ---- 4) Eksikler tamamlanınca geçer ---- */
  await Mp.evaluate(([id, me]) => { const i = issue(id); i.billType = 'Adam/Ay';
    DB.worklogs.push({ id: uid('w'), issueId: id, userId: me, date: TODAY, hours: 1, comment: '' }); i.spent = 1; save(); closeModal(); }, [I1, M]);
  await flush(Mp); await sleep(300);
  await openBoard(Mp); await sleep(300);
  await drag(Mp, I1, S.done);
  ok('after worklog + Fatura türü: drag to Bitti allowed', (await colOf(Mp, I1)) === S.done);
  await flush(Mp); await sleep(300);
  ok('server: Bitti saved', (await srv(A, 'issues', I1))?.statusId === S.done);
  /* Bitti → Onaylandı: rol kuralı (Üye engellenir). */
  await drag(Mp, I1, S.ok);
  ok('member: Onaylandı blocked by role rule', (await colOf(Mp, I1)) === S.done && /yalnız Yönetici rolündekiler taşıyabilir/.test(await toastTx(Mp)));

  /* ---- 5) Kuralı atlayan (eski) istemci: sunucu reddeder, iş geri döner ---- */
  await Mp.evaluate(([id, sid]) => { setStatus(issue(id), sid, { gate: false }); save(); }, [I2, S.done]);
  await sleep(200); await flush(Mp); await sleep(800);
  const d5 = { col: await colOf(Mp, I2), srv: (await srv(A, 'issues', I2))?.statusId, toast: await toastTx(Mp) };
  ok('stale client: server rejects with the same message, state reloaded', d5.col === S.todo && d5.srv === S.todo && d5.toast.includes(MSG), JSON.stringify(d5));

  /* ---- 6) Yönetici Onaylandı'ya taşır ---- */
  await openBoard(Yp); await waitFor(Yp, id => issue(id)?.statusId === DB.statuses.find(s => s.name === 'Bitti' && s.projectId === issue(id).projectId)?.id, I1);
  await Yp.evaluate(() => render()); await sleep(200);
  await drag(Yp, I1, S.ok);
  ok('project admin: Onaylandı allowed', (await colOf(Yp, I1)) === S.ok);
  await flush(Yp); await sleep(300);
  ok('server: Onaylandı saved', (await srv(A, 'issues', I1))?.statusId === S.ok);

  /* ---- 7) Yalnız "Proje adı ve ayarları" yetkisi olan Üye: İş akışı sekmesinde yalnız geçiş kuralları ---- */
  r = await A.evaluate(async P => { const p = (await API.get('/api/state')).data.projects.find(x => x.id === P);
    return API.post('/api/sync', { changes: [{ c: 'projects', id: P, op: 'put', data: { ...p, perms: { member: { 'project.settings': true } } }, base: p }] }); }, P);
  ok('perms: member gets project.settings', r.rejected.length === 0, JSON.stringify(r.rejected));
  const w7 = await waitFor(Mp, () => adminTabs().some(x => x[0] === 'workflow'), null, 12000);
  await openWorkflow(Mp); await sleep(300);
  const t7 = await Mp.evaluate(() => ({ panel: !!document.getElementById('gkPanel'), cols: !!document.querySelector('[data-st]'), add: !!document.getElementById('gkAdd'),
    edit: document.querySelectorAll('[data-gkedit]').length }));
  ok('settings-only member: workflow tab shows only gate rules (editable)', w7 >= 0 && t7.panel && !t7.cols && t7.add && t7.edit === 2, JSON.stringify(t7));
  /* XSS adlı alanı kurala ekler: chip ve uyarı metin olarak. */
  await Mp.click('[data-gkedit]'); await sleep(300);
  await Mp.check(`[data-gkf="cf:${FX}"]`); await Mp.click('#gk_ok'); await sleep(300);
  ok('XSS field chip rendered as text', await Mp.evaluate(() => !window.__xss && [...document.querySelectorAll('#gkPanel .chip')].some(c => c.textContent.includes('<img'))));
  await flush(Mp); await sleep(300);
  await openBoard(Mp); await sleep(300);
  await drag(Mp, I3, S.done);
  const d7 = await toastTx(Mp);
  ok('toast lists XSS field as text', d7.includes('Kod <img') && d7.includes('girin') && !(await Mp.evaluate(() => window.__xss || !!document.querySelector('#toast img'))), d7);

  /* ---- 8) Kural silme ---- */
  await openWorkflow(Mp); await sleep(300);
  await Mp.click(`[data-gkdel="${(await srv(A, 'projects', P)).gates.find(g => g.statusId === S.ok).id}"]`); await sleep(300);
  await flush(Mp); await sleep(300);
  ok('rule deleted on server', (await srv(A, 'projects', P))?.gates?.length === 1);

  /* ---- 9) 390 px ---- */
  const Ms = await mk('mobile', { width: 390, height: 844 }); await login(Ms, 'gky' + R, 'GkYon123456!');
  await openWorkflow(Ms); await sleep(400);
  ok('390px: workflow tab no horizontal scroll', await noHScroll(Ms));
  await Ms.click('#gkAdd'); await sleep(300);
  ok('390px: rule form no horizontal scroll', await noHScroll(Ms));
  await Ms.screenshot({ path: SS + 'mobil.png' });

  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
