// Sürümler / teslim paketleri tarayıcı testi (017). Ön koşullar regresyon.cjs ile aynı (temiz DB + demo veri); test kendi
// kullanıcılarını ve projesini oluşturur, sonunda temizler; diğer testlerden sonra aynı veritabanında da çalışır.
// Kapsam: "Sürümler" sekmesi, boş durum, sürüm oluştur (ad tekilliği, tarih sırası), iş detayında birden çok sürüm ekle/kaldır,
// yeni iş formunda ve toplu düzenlemede sürüm, sorguda `surum`, raporda Sürüm boyutu, ilerleme (iş ve puan) ve gecikme uyarısı,
// "Yayınla" (açık işler başka sürüme taşınır), arşiv (seçicide yok), silme (işlerden bağ kalkar), Üye/İzleyici/dışarıdaki kişi,
// XSS (sürüm adı metin olarak basılır), dar ekran.
// Sonra: node test/e2e/surumler.cjs  (BASE_URL ile adres değiştirilebilir; SHOT ile ekran görüntüsü yolu).
const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3100/';
const SS = require('os').tmpdir() + '/pano_srm_';
const SHOT = process.env.SHOT || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let FAILS = 0;
const ok = (name, cond, extra = '') => { if (!cond) FAILS++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const R = Date.now().toString(36).slice(-5);
const PID = 'p_srm' + R, KEY = 'SR' + R.toUpperCase(), M = 'u_srmm' + R, O = 'u_srmo' + R, VW = 'u_srmv' + R;
const XSS = 'v1.0 <img src=x onerror=window.__xss=1>';
const I = n => 'i_srm' + n + R;

(async () => {
  const b = await chromium.launch();
  const errs = [];
  const mk = async (name, vp = { width: 1440, height: 900 }) => {
    const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 }); const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(name + ' PAGEERR ' + e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(name + ' CONSOLE ' + m.text()); });
    p.on('dialog', d => { if (d.type() === 'alert') errs.push(name + ' ALERT ' + d.message()); d.accept(); });
    return p;
  };
  const login = async (p, u, pw, newPw) => {
    await p.goto(BASE); await p.waitForSelector('#lg_u');
    await p.fill('#lg_u', u); await p.fill('#lg_p', pw); await p.click('#lgForm button[type=submit]'); await sleep(1500);
    if (newPw && await p.isVisible('#fp_a')) { await p.fill('#fp_a', newPw); await p.fill('#fp_b', newPw); await p.click('#fpForm button[type=submit]'); await sleep(1800); }
  };
  const waitFor = async (p, fn, arg, ms = 10000) => { const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await sleep(200); } return false; };
  const sync = (p, changes) => p.evaluate(async ch => (await API.post('/api/sync', { changes: ch })), changes);
  const srv = (p, col, id) => p.evaluate(async ([c, id]) => (await API.get('/api/state')).data[c].find(x => x.id === id), [col, id]);
  const flushed = p => waitFor(p, () => !DIRTY && SYNC_STATE === 'ok');
  const goVersions = async p => { await p.evaluate(pid => { DB.ui.project = pid; DB.ui.verSel = null; DB.ui.view = 'versions'; save(); render(); }, PID); await sleep(300); };

  const A = await mk('admin'); await login(A, 'admin', 'admin12345');
  const past = await A.evaluate(() => iso(addD(new Date(), -5)));
  const start = await A.evaluate(() => iso(addD(new Date(), -30)));
  const iss = (n, s, pts, extra = {}) => ({ c: 'issues', id: I(n), op: 'put', data: { projectId: PID, summary: 'Sürüm işi ' + n, statusId: PID + '_' + s, type: 'task', points: pts, ...extra } });
  let r = await sync(A, [
    { c: 'users', id: M, op: 'put', data: { username: 'srmm' + R, name: 'Sürüm Üye ' + R, role: 'member', active: true } },
    { c: 'users', id: VW, op: 'put', data: { username: 'srmv' + R, name: 'Sürüm İzleyici ' + R, role: 'member', active: true } },
    { c: 'users', id: O, op: 'put', data: { username: 'srmo' + R, name: 'Sürüm Dışarıda ' + R, role: 'member', active: true } },
    { c: 'projects', id: PID, op: 'put', data: { key: KEY, code: KEY, name: 'Sürüm Projesi ' + R, workspaceId: 'ws1', counter: 0, type: 'board' } },
    { c: 'statuses', id: PID + '_t', op: 'put', data: { projectId: PID, name: 'Yapılacak', cat: 'todo', wip: 0, ord: 0 } },
    { c: 'statuses', id: PID + '_d', op: 'put', data: { projectId: PID, name: 'Bitti', cat: 'done', wip: 0, ord: 1 } },
    iss(1, 'd', 3), iss(2, 'd', 2), iss(3, 't', 5), iss(4, 't', 3)]);
  ok('setup', r.rejected.length === 0, JSON.stringify(r.rejected));
  const p0 = await srv(A, 'projects', PID);
  r = await sync(A, [{ c: 'projects', id: PID, op: 'put', data: { ...p0, roles: { ...(p0.roles || {}), [M]: 'member', [VW]: 'viewer' } }, base: p0 }]);
  ok('setup roles', r.rejected.length === 0, JSON.stringify(r.rejected));
  await A.evaluate(() => reloadState()); await sleep(500);

  /* 1) sekme + boş durum + oluştur */
  await goVersions(A);
  ok('tab "Sürümler" visible in project tabs', await A.isVisible('#tab-versions') && (await A.textContent('#tab-versions')).includes('Sürümler'));
  ok('empty state with create button', await A.isVisible('[data-vrempty="none"] [data-vrnew]'));
  await A.click('[data-vrempty="none"] [data-vrnew]'); await sleep(250);
  await A.click('#vr_ok'); await sleep(100);
  ok('form: name required', (await A.textContent('#vr_name_e')).includes('Ad gerekli'));
  await A.fill('#vr_name', XSS); await A.fill('#vr_desc', 'İlk teslim <b>kalın</b>');
  await A.evaluate(([a, b]) => { for (const [id, v] of [['vr_start', b], ['vr_due', a]]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); } }, [past, start]);
  await A.evaluate(([a, b]) => { const e = document.getElementById('vr_due'); e.value = b; e.dispatchEvent(new Event('change', { bubbles: true })); }, [past, '2000-01-01']);
  await A.click('#vr_ok'); await sleep(100);
  ok('form: due before start blocked', await A.isVisible('#vr_ok') && (await A.textContent('#vr_due_e')).includes('önce olamaz'));
  await A.evaluate(d => { const e = document.getElementById('vr_due'); e.value = d; e.dispatchEvent(new Event('change', { bubbles: true })); }, past);
  await A.click('#vr_ok'); await sleep(300);
  ok('version created and saved', await flushed(A) && await A.evaluate(([pid, n]) => DB.versions.some(v => v.projectId === pid && v.name === n), [PID, XSS]));
  const V1 = await A.evaluate(([pid, n]) => DB.versions.find(v => v.projectId === pid && v.name === n).id, [PID, XSS]);
  const sv1 = await srv(A, 'versions', V1);
  ok('server has version (state planned, dates)', sv1?.state === 'planned' && sv1.due === past && sv1.start === start, JSON.stringify(sv1));
  ok('opens version page after create', await A.isVisible('#vrTitle') && (await A.textContent('#vrTitle')) === XSS);
  /* ikinci sürüm + ad tekilliği */
  await A.click('[data-vrback]'); await sleep(200);
  await A.click('.vr-tools [data-vrnew]'); await sleep(200);
  await A.fill('#vr_name', '  ' + XSS.toLocaleUpperCase('tr') + ' '); await A.click('#vr_ok'); await sleep(100);
  ok('form: duplicate name (case-insensitive) blocked', (await A.textContent('#vr_name_e')).includes('bu adla bir sürüm zaten var'));
  await A.fill('#vr_name', 'v1.1'); await A.click('#vr_ok'); await sleep(300);
  await flushed(A);
  const V2 = await A.evaluate(pid => DB.versions.find(v => v.projectId === pid && v.name === 'v1.1')?.id, PID);
  ok('second version created', !!V2);

  /* 2) iş detayı: birden çok sürüm ekle / kaldır */
  await A.evaluate(id => openIssue(id), I(3)); await sleep(300);
  ok('issue detail: Sürüm row with add select', await A.isVisible('#idVerAdd'));
  await A.selectOption('#idVerAdd', V1); await sleep(200);
  await A.selectOption('#idVerAdd', V2); await sleep(200);
  ok('issue detail: two version chips', await A.evaluate(() => document.querySelectorAll('#idVers .id-tag').length) === 2);
  ok('issue detail: chip shows name as text', await A.evaluate(n => [...document.querySelectorAll('#idVers .id-tag')].some(t => t.textContent.includes(n)), XSS));
  await A.click(`#idVers [data-delver="${V2}"]`); await sleep(200);
  await flushed(A);
  ok('issue detail: removed one; server has [V1]', JSON.stringify((await srv(A, 'issues', I(3))).versionIds) === JSON.stringify([V1]));
  ok('issue history logs Sürüm', await A.evaluate(id => DB.history.some(h => h.issueId === id && h.field === 'Sürüm'), I(3)));
  await A.evaluate(() => closeModal());

  /* 3) yeni iş formu */
  await A.evaluate(() => newIssueForm()); await sleep(250);
  await A.click('#f_moreBtn'); await sleep(100);
  ok('new issue form: version checkboxes', await A.evaluate(() => document.querySelectorAll('#f_vers input[type=checkbox]').length) === 2);
  await A.fill('#f_sum', 'Formdan sürümlü iş ' + R);
  await A.check(`#f_vers input[value="${V1}"]`); await A.check(`#f_vers input[value="${V2}"]`);
  await A.click('#doCreate'); await sleep(300); await flushed(A);
  const nid = await A.evaluate(s => DB.issues.find(i => i.summary === s)?.id, 'Formdan sürümlü iş ' + R);
  const ni = nid && await srv(A, 'issues', nid);
  ok('new issue saved with two versions', ni && ni.versionIds?.length === 2 && ni.versionIds.includes(V1) && ni.versionIds.includes(V2), JSON.stringify(ni?.versionIds));

  /* 4) toplu düzenleme: I1, I2, I4 → V1 */
  await A.evaluate(() => { DB.ui.view = 'search'; DB.ui.pql = ''; render(); }); await sleep(300);
  for (const n of [1, 2, 4]) await A.check(`[data-sel="${I(n)}"]`);
  await sleep(200);
  ok('bulk bar: version select', await A.isVisible('#bk_ver'));
  await A.selectOption('#bk_ver', V1); await A.click('#bk_go'); await sleep(300); await flushed(A);
  const bulk = await A.evaluate(async ids => { const d = (await API.get('/api/state')).data.issues; return ids.map(id => d.find(i => i.id === id)?.versionIds || []); }, [I(1), I(2), I(4)]);
  ok('bulk: three issues got V1', bulk.every(v => v.includes(V1)), JSON.stringify(bulk));

  /* 5) sorgu ve rapor boyutu */
  const q = await A.evaluate(([n, pid]) => ({ a: runQuery(`surum = "${n}" AND proje = ${DB.projects.find(p => p.id === pid).key}`).length,
    b: runQuery('surum = "v1.1"').filter(i => i.projectId === pid).length, e: runQuery(`surum IS EMPTY AND proje = ${DB.projects.find(p => p.id === pid).key}`).length }), [XSS, PID]);
  ok('PQL: surum = V1 → 5 issues, v1.1 → 1, IS EMPTY → 0', q.a === 5 && q.b === 1 && q.e === 0, JSON.stringify(q));
  const dim = await A.evaluate(([pid, a, bb]) => { const D = grDims(grCtx()); const i = DB.issues.find(x => x.projectId === pid && (x.versionIds || []).length === 2);
    return { has: !!D.version, l: D.version?.l, k: D.version?.k({}, i), n: D.version?.n(D.version.k({}, i)), none: D.version?.n('__none'), ef: activeDims().some(([k]) => k === 'version') }; }, [PID, V1, V2]);
  ok('report dimension "Sürüm": multi-version issue counted once as "A + B"; "Sürümsüz"; effort dims too',
    dim.has && dim.l === 'Sürüm' && dim.k.split('|').length === 2 && dim.n.includes(' + ') && dim.none === 'Sürümsüz' && dim.ef, JSON.stringify(dim));

  /* 6) sürüm listesi + sayfası: ilerleme, gecikme */
  await goVersions(A);
  ok('list: two rows; V1 late chip', await A.evaluate(() => document.querySelectorAll('tr[data-vropen]').length) === 2
    && await A.isVisible(`tr[data-vropen="${V1}"] [data-vrlate]`) && !(await A.isVisible(`tr[data-vropen="${V2}"] [data-vrlate]`)));
  await A.click(`tr[data-vropen="${V1}"]`); await sleep(250);
  ok('page: progress 2/5 issues', (await A.textContent('[data-vrn]')) === '2/5');
  ok('page: points 5/13', (await A.textContent('[data-vrp]')).replace(/\s/g, '') === '5/13');
  ok('page: late warning', await A.isVisible('.vr-late[data-vrlate]') && (await A.textContent('.vr-late')).includes('3 iş hâlâ açık'));
  ok('page: issue rows clickable (5)', await A.evaluate(() => document.querySelectorAll('#vrPage tr[data-open]').length) === 5);
  ok('XSS: name and description printed as text (no injected img / b)', await A.evaluate(() => !window.__xss && !document.querySelector('img[src="x"]')
    && ![...document.querySelectorAll('#vrPage b')].some(x => x.textContent === 'kalın') && document.querySelector('.vr-desc').textContent === 'İlk teslim <b>kalın</b>'));
  if (SHOT) await A.screenshot({ path: SHOT, fullPage: false });

  /* 7) Üye: görür, yazamaz (arayüz + sunucu); işe sürüm ekler */
  const Mp = await mk('member'); await login(Mp, 'srmm' + R, 'Baslangic123', 'SurumUye12345');
  await goVersions(Mp);
  ok('member: tab visible, list visible, no create button', await Mp.isVisible('#tab-versions') && await Mp.isVisible(`tr[data-vropen="${V1}"]`) && !(await Mp.isVisible('[data-vrnew]')));
  await Mp.click(`tr[data-vropen="${V1}"]`); await sleep(200);
  ok('member: no release/edit/delete actions', !(await Mp.isVisible('[data-vrrel]')) && !(await Mp.isVisible('[data-vredit]')) && !(await Mp.isVisible('[data-vrdel]')));
  r = await sync(Mp, [{ c: 'versions', id: 'v_srmx' + R, op: 'put', data: { projectId: PID, name: 'Üye sürümü', state: 'planned' } }]);
  ok('member: server rejects version write', r.rejected.length === 1 && /Proje adı ve ayarları/.test(r.rejected[0].reason), JSON.stringify(r.rejected));
  await Mp.evaluate(id => openIssue(id), I(4)); await sleep(300);
  await Mp.selectOption('#idVerAdd', V2); await sleep(200); await flushed(Mp);
  ok('member: adds version to issue (issue.edit)', ((await srv(Mp, 'issues', I(4))).versionIds || []).includes(V2));
  await Mp.evaluate(() => closeModal());
  /* İzleyici: seçici yok. Dışarıdaki: veri yok. */
  const Vp = await mk('viewer'); await login(Vp, 'srmv' + R, 'Baslangic123', 'SurumIzl12345');
  await Vp.evaluate(id => openIssue(id), I(3)); await sleep(300);
  ok('viewer: version chip read-only (no select / remove)', await Vp.isVisible('#idVers .id-tag') && !(await Vp.isVisible('#idVerAdd')) && !(await Vp.isVisible('[data-delver]')));
  await Vp.evaluate(() => closeModal());
  const Op = await mk('outsider'); await login(Op, 'srmo' + R, 'Baslangic123', 'SurumDis12345');
  ok('outsider: no versions of the project in client data', await Op.evaluate(pid => !(DB.versions || []).some(v => v.projectId === pid), PID));

  /* 8) Yayınla: açık işler V2'ye taşınır */
  await A.evaluate(() => reloadState()); await sleep(400);
  await goVersions(A); await A.click(`tr[data-vropen="${V1}"]`); await sleep(200);
  await A.click('[data-vrrel]'); await sleep(250);
  ok('release dialog: open issue question with V2 first', (await A.textContent('#scrim .modal')).includes('Açık 3 iş başka sürüme taşınsın mı?')
    && await A.getAttribute(`[data-vrdest="${V2}"]`, 'aria-checked') === 'true');
  await A.click('#vr_doRel'); await sleep(300); await flushed(A);
  const rel = await srv(A, 'versions', V1);
  ok('released on server with date', rel.state === 'released' && /^\d{4}-\d{2}-\d{2}$/.test(rel.releasedAt), JSON.stringify(rel));
  const after = await A.evaluate(async ids => { const d = (await API.get('/api/state')).data.issues; return ids.map(id => d.find(i => i.id === id)?.versionIds || []); }, [I(1), I(3), I(4), nid]);
  ok('open issues moved V1 → V2; done issue stays in V1', after[0].includes(V1) && [1, 2, 3].every(k => !after[k].includes(V1) && after[k].includes(V2)), JSON.stringify(after));
  ok('released: no late warning; chip Yayınlandı', !(await A.isVisible('.vr-late')) && (await A.textContent('#vrPage .vr-head .vr-st')) === 'Yayınlandı');

  /* 9) Arşiv: seçicide yok */
  await A.goto(BASE + '#versions'); await sleep(1200);
  await goVersions(A); await A.click(`tr[data-vropen="${V2}"]`); await sleep(200);
  await A.click('[data-vrarch]'); await sleep(300); await flushed(A);
  ok('archived on server', (await srv(A, 'versions', V2)).state === 'archived');
  await A.evaluate(id => openIssue(id), I(2)); await sleep(300);
  ok('archived version not offered in issue detail', !(await A.evaluate(v => [...document.querySelectorAll('#idVerAdd option')].some(o => o.value === v), V2)));
  await A.evaluate(() => closeModal());

  /* 10) Dar ekran: yatay taşma yok */
  const Mob = await mk('mobile', { width: 390, height: 844 }); await login(Mob, 'admin', 'admin12345');
  await goVersions(Mob);
  ok('mobile: list fits (no horizontal page overflow)', await Mob.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await Mob.click(`tr[data-vropen="${V1}"]`); await sleep(200);
  ok('mobile: page fits', await Mob.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  /* 11) Sil: işlerden bağ kalkar */
  await goVersions(A); await A.click(`tr[data-vropen="${V1}"]`); await sleep(200);
  await A.click('[data-vrdel]'); await sleep(400); await flushed(A);
  ok('deleted: version gone on server, list shown', !(await srv(A, 'versions', V1)) && await A.isVisible('.vr-tools'));
  ok('deleted: issue I1 no longer references V1', !((await srv(A, 'issues', I(1))).versionIds || []).includes(V1));

  /* temizlik */
  const ids = await A.evaluate(pid => DB.issues.filter(i => i.projectId === pid).map(i => i.id), PID);
  r = await sync(A, [...ids.map(id => ({ c: 'issues', id, op: 'del' })), { c: 'versions', id: V2, op: 'del' },
    { c: 'projects', id: PID, op: 'del' }, ...[M, O, VW].map(id => ({ c: 'users', id, op: 'del' }))]);
  ok('cleanup', r.rejected.length === 0, JSON.stringify(r.rejected));
  if (FAILS) await A.screenshot({ path: SS + 'son.png' });
  ok('no page errors', errs.length === 0, errs.join(' | '));
  await b.close();
  console.log(FAILS ? `\n${FAILS} FAIL` : '\nALL PASS');
  process.exit(FAILS ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
