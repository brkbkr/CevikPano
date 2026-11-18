// Pano iyileştirmeleri tarayıcı testi: hızlı kart ekleme (tek satır + çipler), alt işler panoda kart,
// sprint başlat/tamamla yetkisi ve proje sprint süresi.
// Ön koşullar regresyon.cjs ile aynı: boş veritabanı, sunucu ADMIN_PASSWORD=admin12345 DEFAULT_USER_PASSWORD=Baslangic123
// PORT=3100, demo veri (node scripts/seed-demo.mjs http://localhost:3100 test/fixtures/demo.json).
// Sonra: node test/e2e/pano-iyilestirme.cjs (BASE_URL ile adres değiştirilebilir). Kendi projesini ve kullanıcısını açar.
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/'; const SS = require('os').tmpdir() + '/pano_pi_';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const RUN = Date.now().toString(36).slice(-5);
const PID = 'p_pi' + RUN, KEY = 'PI' + RUN.toUpperCase().replace(/[^A-Z0-9]/g, '');

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1600, height: 900 }, colorScheme = 'light') => {
    const ctx = await b.newContext({ viewport: vp, colorScheme, hasTouch: vp.width < 900 });
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw);
    await p.click('#lgForm button[type=submit]'); await sleep(1500);
  };
  const go = async (p, view) => {
    await p.evaluate(() => { location.hash = 'home'; }); await sleep(250);
    await p.evaluate(([pid, v]) => { DB.ui.project = pid; DB.board.scope = 'all'; DB.board.swimlane = 'none';
      DB.board.filterUser = ''; DB.board.filterType = ''; DB.board.q = ''; location.hash = v; }, [PID, view]);
    await sleep(600);
  };
  const A = await mk('admin'); await login(A, 'admin', 'admin12345');

  /* ---- test verisi: agile proje (üyeler: admin + u2), 3 kolon, gelecek sprint, üst iş + alt iş, üye olmayan kullanıcı ---- */
  const MU = 'piuye' + RUN, MID = 'u_pi' + RUN, VU = 'piizl' + RUN, VID = 'u_piv' + RUN;
  const seed = await A.evaluate(async ([pid, key, mid, mu, vid, vu]) => {
    const st = ['Yapılacak', 'Devam ediyor', 'Bitti'].map((n, k) => ({ id: `${pid}_s${k}`, projectId: pid, name: n, cat: ['todo', 'inprogress', 'done'][k], wip: 0, ord: k }));
    const I = (id, n, sid, extra = {}) => ({ id, projectId: pid, key: `${key}-${n}`, type: 'task', summary: 'PI ' + id, description: '', statusId: sid,
      assignee: null, reporter: ME.id, priority: 3, labels: [], cf: {}, created: Date.now(), updatedAt: Date.now(), rank: n * 100, start: '', due: '', ...extra });
    const r = await API.post('/api/sync', { changes: [
      { c: 'users', id: mid, op: 'put', data: { username: mu, name: 'PI Üye Dışı', role: 'member', active: true, ini: 'PÜ', color: '#0F766E' } },
      { c: 'users', id: vid, op: 'put', data: { username: vu, name: 'PI İzleyici', role: 'viewer', active: true, ini: 'Pİ', color: '#64748B' } },
      { c: 'projects', id: pid, op: 'put', data: { name: 'Pano iyileştirme ' + key, key, counter: 2, type: 'agile', members: [ME.id, 'u2', vid], workspaceId: 'ws1' } },
      ...st.map(s => ({ c: 'statuses', id: s.id, op: 'put', data: s })),
      { c: 'sprints', id: pid + '_sp', op: 'put', data: { projectId: pid, name: key + ' Sprint 1', state: 'future', goal: '', start: '2026-11-09', end: '2026-11-15' } },
      { c: 'issues', id: pid + '_par', op: 'put', data: I(pid + '_par', 1, st[0].id, { sprintId: pid + '_sp' }) },
      { c: 'issues', id: pid + '_sub', op: 'put', data: I(pid + '_sub', 2, st[1].id, { parentId: pid + '_par', sprintId: pid + '_sp' }) },
    ] });
    return { rej: r.data?.rejected || r.rejected, st: st.map(s => s.id) };
  }, [PID, KEY, MID, MU, VID, VU]);
  ok('seed accepted', Array.isArray(seed.rej) && seed.rej.length === 0, JSON.stringify(seed.rej));
  await sleep(4800);                         // poll ile gelsin
  await A.reload(); await sleep(1500);
  const [S0, S1] = seed.st;

  /* ===== 1) hızlı kart ekleme ===== */
  await go(A, 'board');
  await A.click(`[data-qa="${S0}"]`); await sleep(300);
  const shape = await A.evaluate(() => ({
    selects: document.querySelectorAll('.qadd select').length,
    old: ['#qa_b', '#qa_bt', '#qa_e', '#qa_st', '#qa_du', '#qa_dd', '#qa_ok', '.qa-hint'].filter(s => document.querySelector(s)).length,
    chips: ['#qa_t', '#qa_a', '#qa_p', '#qa_d', '#qa_more', '#qa_x'].filter(s => document.querySelector(s)).length,
    inputs: [...document.querySelectorAll('.qadd input:not([type=date])')].length,
    focus: document.activeElement?.id,
  }));
  ok('quick add: single title input, no selects / old fields', shape.selects === 0 && shape.old === 0 && shape.inputs === 1, JSON.stringify(shape));
  ok('quick add: chips (type, assignee, priority, due, more, close)', shape.chips === 6, JSON.stringify(shape));
  ok('quick add: title focused on open', shape.focus === 'qa_s', shape.focus);

  // çipler: tip, öncelik (Acil), atanan (ben), bitiş (Bugün)
  const pick = async (chip, v) => { await A.click(chip); await sleep(200); const has = await A.evaluate(v => !!document.querySelector(`.qm [data-qv="${v}"]`), v);
    if (has) await A.click(`.qm [data-qv="${v}"]`); await sleep(250); return has; };
  const env = await A.evaluate(() => ({ me: ME.id, today: TODAY, types: qaTypes(), acil: PRI[1][1] }));
  const typ = env.types.find(t => t !== 'task') || env.types[0];
  ok('type menu has option', await pick('#qa_t', typ), typ);
  ok('priority menu has 4 options', await A.evaluate(() => { document.querySelector('#qa_p').click(); const n = document.querySelectorAll('.qm .qm-opt').length; closeQuick(false); return n; }) === 4);
  ok('priority pick', await pick('#qa_p', '1'));
  ok('assignee menu (#8 person menu) pick', await pick('#qa_a', 'u2'));
  ok('due menu pick "Bugün"', await pick('#qa_d', env.today));
  const chipsNow = await A.evaluate(() => ({ p: document.querySelector('#qa_p').textContent.trim(), d: document.querySelector('#qa_d').textContent.trim(),
    a: document.querySelector('#qa_a').getAttribute('aria-label'), t: document.querySelector('#qa_t').getAttribute('aria-label') }));
  ok('chips show chosen values', chipsNow.p.includes(env.acil) && chipsNow.d === 'Bugün' && !chipsNow.a.includes('Atanmamış'), JSON.stringify(chipsNow));

  await A.click('#qa_s'); await A.keyboard.type('PIQ ilk kart'); await A.keyboard.press('Enter'); await sleep(350);
  const f1 = await A.evaluate(() => document.activeElement?.id);
  await A.keyboard.type('PIQ ikinci kart'); await A.keyboard.press('Enter'); await sleep(350);
  const made = await A.evaluate(([pid, s0]) => DB.issues.filter(i => i.projectId === pid && /^PIQ /.test(i.summary))
    .map(i => ({ s: i.summary, st: i.statusId === s0, p: i.priority, a: i.assignee, d: i.due, t: i.type })), [PID, S0]);
  ok('Enter adds two cards in a row, cursor stays', made.length === 2 && f1 === 'qa_s' && await A.evaluate(() => document.activeElement?.id === 'qa_s' && document.querySelector('#qa_s').value === ''),
    JSON.stringify(made) + ' focus=' + f1);
  ok('cards get chip values (column, type, priority, assignee, due)', made.every(m => m.st && m.p === 1 && m.a === 'u2' && m.d === env.today && m.t === typ), JSON.stringify(made));
  ok('cards visible in column', await A.evaluate(s0 => [...document.querySelectorAll(`.col[data-status="${s0}"] .card .sum`)].filter(e => e.textContent.startsWith('PIQ')).length, S0) === 2);
  ok('choices remembered (chips keep values after add)', (await A.evaluate(() => document.querySelector('#qa_p').textContent)).includes(env.acil));
  await A.screenshot({ path: SS + 'qadd.png' });
  await A.keyboard.press('Escape'); await sleep(250);
  ok('Esc closes quick add', await A.evaluate(() => !document.querySelector('.qadd')));

  // Daha fazla…: tam form bu değerlerle
  await A.click(`[data-qa="${S1}"]`); await sleep(300);
  await A.fill('#qa_s', 'PIQ tam form'); await A.click('#qa_more'); await sleep(500);
  const form = await A.evaluate(() => ({ sum: $('#f_sum')?.value, pri: $('#f_pri [aria-checked="true"]')?.dataset.pri, as: $('#f_as')?.value,
    due: $('#f_due')?.value, st: $('#f_st')?.value, type: $('#f_type')?.value, qadd: !!document.querySelector('.qadd') }));
  ok('"Daha fazla…" opens full form with values', form.sum === 'PIQ tam form' && form.pri === '1' && form.as === 'u2' && form.due === env.today && form.st === S1 && form.type === typ && !form.qadd,
    JSON.stringify(form));
  await A.click('#doCreate'); await sleep(400);
  ok('full form creates in chosen column', await A.evaluate(([pid, s1]) => DB.issues.some(i => i.projectId === pid && i.summary === 'PIQ tam form' && i.statusId === s1 && i.priority === 1), [PID, S1]));
  // XSS: başlık metin olarak
  await A.click(`[data-qa="${S0}"]`); await sleep(200);
  await A.fill('#qa_s', '<img src=x onerror="window.__xss=1">'); await A.keyboard.press('Enter'); await sleep(400);
  ok('quick add title escaped', await A.evaluate(() => !window.__xss && !document.querySelector('.card .sum img')));
  await A.keyboard.press('Escape'); await sleep(200);

  // mobil: dokunma hedefleri ≥44px + koyu tema
  const Mb = await mk('mobile', { width: 390, height: 844 }, 'dark'); await login(Mb, 'admin', 'admin12345');
  await go(Mb, 'board');
  await Mb.evaluate(s0 => { DB.ui.qaOpen = s0; render(); }, S0); await sleep(300);
  const tgt = await Mb.evaluate(() => ['#qa_s', '#qa_t', '#qa_a', '#qa_p', '#qa_d', '#qa_more', '#qa_x'].map(s => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? Math.min(r.height, r.width) : 0; }));
  ok('mobile: quick add targets ≥44px', tgt.every(h => h >= 44), tgt.join());
  await Mb.screenshot({ path: SS + 'qadd_mobile_dark.png' });
  await Mb.evaluate(() => { DB.ui.qaOpen = null; render(); });

  /* ===== 2) alt işler panoda kart ===== */
  await go(A, 'board');
  const sub = await A.evaluate(([pid, s1]) => {
    const c = document.querySelector(`.col[data-status="${s1}"] .card[data-id="${pid}_sub"]`);
    const par = document.querySelector(`.card[data-id="${pid}_par"]`);
    return { inCol: !!c, chip: c?.querySelector('.c-par')?.textContent.trim(), counter: par?.querySelector('.c-sub')?.textContent.trim(),
      sw: document.querySelector('#fSubs')?.getAttribute('aria-checked') };
  }, [PID, S1]);
  ok('subtask card in its own status column', sub.inCol, JSON.stringify(sub));
  ok('subtask card shows parent key chip', sub.chip === `↳ ${KEY}-1`, sub.chip);
  ok('parent card keeps subtask counter', sub.counter === '0/1', sub.counter);
  ok('subtasks switch on by default', sub.sw === 'true', sub.sw);
  await A.click(`.card[data-id="${PID}_sub"] .c-par`); await sleep(500);
  ok('parent chip opens parent issue', await A.evaluate(pid => OPEN_ISSUE === pid + '_par' && document.querySelector('#scrim.on .id-dlg') != null, PID));
  await A.evaluate(() => closeModal()); await sleep(300);
  await A.click('#fSubs'); await sleep(400);
  const hid = await A.evaluate(pid => ({ card: !!document.querySelector(`.card[data-id="${pid}_sub"]`), pref: DB.board.subs, sw: document.querySelector('#fSubs').getAttribute('aria-checked'),
    focus: document.activeElement?.id }), PID);
  ok('switch hides subtasks (personal pref)', !hid.card && hid.pref === false && hid.sw === 'false' && hid.focus === 'fSubs', JSON.stringify(hid));
  await sleep(1500);
  ok('pref saved on server (user_prefs)', await A.evaluate(async () => (await API.get('/api/state')).data.board?.subs === false));
  await A.click('#fSubs'); await sleep(400);
  ok('switch shows subtasks again', await A.evaluate(pid => !!document.querySelector(`.card[data-id="${pid}_sub"]`) && DB.board.subs === true, PID));
  await go(A, 'backlog');
  ok('backlog row for subtask with parent chip', await A.evaluate(pid => document.querySelector(`.row[data-id="${pid}_sub"] .c-par`)?.textContent.trim(), PID) === `↳ ${KEY}-1`);

  /* ===== 3) sprint: yetki ve süre ===== */
  ok('manager sees "start sprint"', await A.evaluate(pid => !!document.querySelector(`[data-start="${pid}_sp"]`), PID));
  const fresh = async (name, u, pw) => { const p = await mk(name); await login(p, u, 'Baslangic123');
    await p.fill('#fp_a', pw); await p.fill('#fp_b', pw); await p.click('#fpForm button[type=submit]'); await sleep(1800); return p; };
  const V = await fresh('viewer', VU, 'PiIzl123456');
  await go(V, 'backlog');
  const vv = await V.evaluate(pid => ({ box: !!document.querySelector(`[data-sprint="${pid}_sp"]`), start: document.querySelectorAll('[data-start],[data-spcomplete]').length,
    canMan: canManageProject(P()) }), PID);
  ok('not manager (viewer member): sprint visible, no start/complete buttons', vv.box && vv.start === 0 && vv.canMan === false, JSON.stringify(vv));
  await go(V, 'admin');
  ok('not manager: sprint length read-only', await V.evaluate(() => !document.querySelector('#ptSprintW')));
  const M = await fresh('nonmember', MU, 'PiUye123456');
  const srv = await M.evaluate(async pid => { const s = { ...DB.sprints.find(x => x.id === pid + '_sp'), state: 'active' };
    const r = await API.post('/api/sync', { changes: [{ c: 'sprints', id: s.id, op: 'put', data: s }] }); return (r.data?.rejected || r.rejected || []).map(x => x.reason); }, PID);
  ok('non-member: server rejects sprint start', srv.join() === 'Sprinti yalnızca proje yöneticisi başlatıp bitirebilir', srv.join());

  await go(A, 'admin');
  const w0 = await A.evaluate(() => document.querySelector('#ptSprintW')?.value);
  ok('sprint length setting default 1 week', w0 === '1', w0);
  await A.selectOption('#ptSprintW', '2'); await sleep(1500);
  ok('sprint length saved (projects.data.sprintWeeks)', await A.evaluate(async pid => P().sprintWeeks === 2
    && (await API.get('/api/state')).data.projects.find(p => p.id === pid)?.sprintWeeks === 2, PID));
  await go(A, 'backlog');
  await A.click('#newSprint'); await sleep(400);
  const sd = await A.evaluate(() => ({ s: $('#s_start').value, e: $('#s_end').value }));
  const days = (Date.parse(sd.e) - Date.parse(sd.s)) / 864e5 + 1;
  ok('new sprint: starts day after previous end, 14 days', sd.s === '2026-11-16' && days === 14, JSON.stringify(sd));
  await A.click('#doSprint'); await sleep(400);
  ok('new sprint saved with dates', await A.evaluate(([pid, s]) => DB.sprints.some(x => x.projectId === pid && x.id !== pid + '_sp' && x.start === s.s && x.end === s.e && x.state === 'future'), [PID, sd]));
  await A.click(`[data-start="${PID}_sp"]`); await sleep(1500);
  ok('manager starts sprint', await A.evaluate(async pid => (await API.get('/api/state')).data.sprints.find(s => s.id === pid + '_sp')?.state === 'active', PID));
  ok('manager sees "complete sprint"', await A.evaluate(pid => !!document.querySelector(`[data-spcomplete="${pid}_sp"]`), PID));

  /* temizlik: tercihler eski hâline */
  await A.evaluate(() => { DB.board.subs = true; DB.ui.project = 'p1'; save(); }); await sleep(1200);
  console.log(errs.length ? errs.join('\n') : 'no page errors / alerts');
  await b.close();
  if (FAILS || errs.length) { console.log(`${FAILS} başarısız kontrol, ${errs.length} sayfa hatası`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
