import { HttpError } from './util.js';
import { PROJECT_ROLES, MAX_PROJECT_ROLES, permsError } from './perms.js';

/* Kayıt doğrulama. Eski verilerle uyum için gevşek tutuldu: yalnızca verinin
   bütünlüğünü bozacak hataları reddeder. */
const MAX_RECORD = 512 * 1024;
const str = (v, max = 1000) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v == null || v === '' || str(v, max);
const date = v => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));
/* Sıkı tarih (canlı yazmada değişen alan): tam 'YYYY-AA-GG' ve takvimde var olan gün. */
const realDate = v => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v);
export const ESTIMATE_MAX = 10000;   // saat

const KEY_RE = /^[\p{L}\p{N}_-]{1,20}$/u;
const ISSUE_KEY_RE = /^[\p{L}\p{N}_-]{1,20}-\d{1,9}$/u;
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
/* Üretilen sütunlar (archived) ::boolean dönüşümü yapar: metin gelirse 500 yerine 400. */
const optBool = v => v == null || typeof v === 'boolean';
const optKey = (v, re) => v == null || v === '' || (typeof v === 'string' && re.test(v));

/* Kayıt kimlikleri ekranda HTML özniteliklerine basılır: yalnız güvenli karakterler.
   uid() (i_x7k2…), demo/varsayılan kimlikler (p1, u1, p1_s0, cf_mus, sp1) bu kalıba uyar. */
export const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export const validId = v => typeof v === 'string' && ID_RE.test(v);
/* Sprint planı: { count, points, est?, ids, at? } — yalnız bu anahtarlar; ids benzersiz iş kimlikleri, count = ids sayısı. */
const PLAN_KEYS = new Set(['count', 'points', 'est', 'ids', 'at']);
const nonNeg = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e7;
export const validPlan = p => !!p && typeof p === 'object' && !Array.isArray(p)
  && Object.keys(p).every(k => PLAN_KEYS.has(k))
  && Array.isArray(p.ids) && p.ids.length <= 2000 && p.ids.every(validId) && new Set(p.ids).size === p.ids.length
  && Number.isInteger(p.count) && p.count === p.ids.length && nonNeg(p.points)
  && (p.est == null || nonNeg(p.est)) && (p.at == null || (Number.isInteger(p.at) && p.at > 0));

/* Prototip kirletmeye yol açabilecek anahtarları (iç içe dahil) siler; silinen sayısını döner. */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function stripBadKeys(v, depth = 0) {
  if (v === null || typeof v !== 'object' || depth > 32) return 0;
  let n = 0;
  if (Array.isArray(v)) { for (const x of v) n += stripBadKeys(x, depth + 1); return n; }
  for (const k of Object.keys(v)) {
    if (BAD_KEYS.has(k)) { delete v[k]; n++; } else n += stripBadKeys(v[k], depth + 1);
  }
  return n;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const optEmail = v => v == null || v === '' || (typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v));
/* Cari ve yetkili kişi e-postası mailto: bağlantısına basılır: canlı yazmada yeni/değişen adreste ? & " < > ve
   boşluk yok (konu/gövde/alıcı parametresi enjeksiyonu). Değişmeyen eski adres ve içe aktarma/geri yükleme korunur. */
const MAILTO_BAD = /[?&"<>\s]/;
const cuEmail = (v, old, live) => optEmail(v) && (!live || v == null || v === '' || v === old || !MAILTO_BAD.test(v));
export const CUSTOMER_KINDS = ['customer', 'supplier', 'both'];
/* Vergi no: yeni ya da değişen değer 10 haneli VKN (canlı yazma). Eski 11 haneli kayıt (T.C. kimlik no) silinmez:
   değişmeden kaydedilebilir, içe aktarma/geri yükleme de kabul eder; sistem yöneticisi dışındakilere maskeli gider (store.js maskCustomer). */
const TAX_NO_RE = /^\d{10,11}$/;
const VKN_RE = /^\d{10}$/;
export const TAX_NO_MSG = 'Vergi numarası 10 haneli olmalı';
const MAX_CONTACTS = 200;

/* Yetkili kişiler: dizi; her biri güvenli kimlik ve ad taşır. İlk hata döner (yoksa boş). */
function contactRules(list, opts = {}) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > MAX_CONTACTS) return [[false, `Yetkili kişiler en fazla ${MAX_CONTACTS} kişilik bir liste olmalı`]];
  const ids = new Set();
  const prev = new Map((Array.isArray(opts.cur?.contacts) ? opts.cur.contacts : []).filter(x => x && typeof x === 'object').map(x => [x.id, x.email]));
  for (const p of list) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !validId(p.id)) return [[false, 'Yetkili kişinin kimliği geçersiz']];
    if (ids.has(p.id)) return [[false, 'Yetkili kişi kimlikleri tekil olmalı']];
    ids.add(p.id);
    const checks = [
      [typeof p.name === 'string' && p.name.trim().length >= 1 && p.name.length <= 120, 'Yetkili kişinin adı gerekli (en fazla 120 karakter)'],
      [optStr(p.title, 120), 'Yetkili kişinin görevi en fazla 120 karakter'],
      [cuEmail(p.email, prev.get(p.id), opts.live), 'Yetkili kişinin e-posta adresi geçersiz'],
      [optStr(p.phone, 30), 'Yetkili kişinin telefonu en fazla 30 karakter'],
    ];
    const bad = checks.find(([ok]) => !ok);
    if (bad) return [bad];
  }
  return [];
}

/* Proje türü (#12): boş/yok = genel sprint ayarından hesaplanır (kayda yazılmaz). */
export const PROJECT_TYPES = ['board', 'agile'];
export const COL_NAME_MAX = 30;
/* Yeni proje şablonu (görev 10): yalnız bilgi; boş/yok = şablonsuz (eski) proje. */
export const PROJECT_TEMPLATES = ['kanban', 'scrum', 'gorev', 'uyarlama', 'talep', 'yolharitasi', 'bos'];

/* Proje alanları (parametrik alanlar). Hazır alanlar (bind) değerini işin yerleşik özelliğinde tutar:
   billable → issues.data.billable, billType → billType, customerId → customerId. Anahtar ve tür bind'e sabittir. */
export const FIELD_TYPES = ['text', 'number', 'select', 'date', 'user', 'checkbox', 'cari'];
/* Alan kapsamı: 'issue' (yok = iş alanı, eski kayıtlar) ya da 'customer' (cari özel alanı: genel, hazır alan değil,
   yalnız sistem yöneticisi tanımlar — projesiz alan store.js checkScope'ta yöneticiye kalır). */
export const FIELD_SCOPES = ['issue', 'customer'];
export const CUSTOMER_FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];
export const FIELD_BINDS = { billable: { key: 'fatura', type: 'select' }, billType: { key: 'faturaturu', type: 'select' },
  customerId: { key: 'cari', type: 'cari' } };
export const BILLABLE_OPTIONS = ['Faturalanacak', 'Faturalanmayacak'];
const FIELD_KEY_RE = /^[a-z0-9_]{1,30}$/;
const MAX_FIELD_OPTIONS = 100;
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const optionsOk = o => o == null || (Array.isArray(o) && o.length <= MAX_FIELD_OPTIONS
  && o.every(x => typeof x === 'string' && x.trim().length >= 1 && x.length <= 100) && new Set(o).size === o.length);
const defOk = v => v == null || v === '' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || str(v, 100);
/* Değer haritası (issue.cf): nesne, en çok 200 anahtar; değerler metin (≤1000), sayı, boolean ya da boş. */
const MAX_CF_KEYS = 200;
const cfOk = v => v == null || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= MAX_CF_KEYS
  && Object.entries(v).every(([k, x]) => k.length <= 200 && (x == null || typeof x === 'boolean'
    || (typeof x === 'number' && Number.isFinite(x)) || str(x, 1000))));
/* Sıkı kurallar yalnız canlı yazmada; var olan kayıtta yalnız değişen özellik denetlenir (eski veri kaydedilebilsin).
   İçe aktarma/geri yükleme gevşek kalır. */
const changed = (d, opts, k) => !!opts.live && (!opts.cur || !sameJson(opts.cur[k], d[k]));

/* Kayıtlı raporlar (011). Yeni koleksiyon, eski verisi yok: her yazmada sıkı. Bilinmeyen anahtar reddedilir (ekrana
   basılan her şey bilinen biçimde); ayar (cfg) genel raporun kişisel süzgeç nesnesinin (grF) kaydedilebilir kısmıdır. */
export const REPORT_NAME_MAX = 80;
export const REPORT_DESC_MAX = 300;
export const REPORT_MAX_BYTES = 8 * 1024;
export const REPORT_VIS = ['private', 'shared'];
export const REPORT_SCOPES = ['all', 'ws', 'project'];
export const REPORT_MEASURES = ['hours', 'count', 'points'];
export const REPORT_CHARTS = ['table', 'bar'];
const REPORT_KEYS = new Set(['id', 'name', 'desc', 'ownerId', 'vis', 'scope', 'cfg', 'tpl', 'createdAt', 'updatedAt']);
const REPORT_CFG_KEYS = new Set(['tab', 'row', 'col', 'ms', 'ch', 'per', 'month', 'from', 'to', 'f']);
const REPORT_F_KEYS = new Set(['ws', 'proj', 'cu', 'user', 'type', 'bill', 'cfk', 'cfv']);
const REPORT_DIM_RE = /^(cf:[a-z0-9_]{1,30}|[A-Za-z]{1,20})$/;
const plainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const optTime = v => v == null || (Number.isInteger(v) && v > 0);
const reportScopeOk = s => plainObj(s) && Object.keys(s).every(k => k === 'kind' || k === 'id') && REPORT_SCOPES.includes(s.kind)
  && (s.kind === 'all' ? s.id == null : validId(s.id));
const reportCfgOk = g => plainObj(g) && Object.keys(g).every(k => REPORT_CFG_KEYS.has(k))
  && (g.tab == null || ['sure', 'fatura'].includes(g.tab))
  && (g.row == null || (typeof g.row === 'string' && REPORT_DIM_RE.test(g.row)))
  && (g.col == null || g.col === '' || (typeof g.col === 'string' && REPORT_DIM_RE.test(g.col)))
  && (g.ms == null || REPORT_MEASURES.includes(g.ms)) && (g.ch == null || REPORT_CHARTS.includes(g.ch))
  && (g.per == null || ['rel', 'month', 'custom'].includes(g.per))
  && (g.month == null || g.month === '' || (typeof g.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(g.month)))
  && realDate(g.from) && realDate(g.to)
  && (g.f == null || (plainObj(g.f) && Object.entries(g.f).every(([k, v]) => REPORT_F_KEYS.has(k) && str(v, 200))));

const RULES = {
  projects: (d, opts) => [
    [str(d.name, 200) && d.name.trim(), 'Proje adı gerekli'],
    [optKey(d.key, KEY_RE), 'Proje anahtarı yalnızca harf, rakam, _ ve - içerebilir (en fazla 20)'],
    [optKey(d.code, KEY_RE), 'Proje kodu geçersiz'],
    [d.workspaceId == null || d.workspaceId === '' || validId(d.workspaceId), 'Geçersiz çalışma alanı'],
    [optBool(d.archived), 'Arşiv bilgisi true ya da false olmalı'],
    [d.customerId == null || d.customerId === '' || validId(d.customerId), 'Geçersiz cari'],
    [d.type == null || d.type === '' || PROJECT_TYPES.includes(d.type), 'Geçersiz proje türü'],
    [d.template == null || d.template === '' || PROJECT_TEMPLATES.includes(d.template), 'Geçersiz şablon'],
    [d.sprintWeeks == null || (Number.isInteger(d.sprintWeeks) && d.sprintWeeks >= 1 && d.sprintWeeks <= 8),
      'Sprint süresi 1 ile 8 hafta arasında bir tamsayı olmalı'],
    /* Proje rolleri (yetki-v2): { kullanıcı kimliği: 'admin'|'member'|'viewer' }, en çok 1000 kişi. */
    [d.roles == null || (typeof d.roles === 'object' && !Array.isArray(d.roles) && Object.keys(d.roles).length <= MAX_PROJECT_ROLES
      && Object.entries(d.roles).every(([k, v]) => validId(k) && PROJECT_ROLES.includes(v))),
      `Proje rolleri geçersiz (kişi kimliği ve rol: admin, member, viewer; en fazla ${MAX_PROJECT_ROLES} kişi)`],
    [d.ownerId == null || validId(d.ownerId), 'Proje sahibi geçersiz'],
    [!changed(d, opts, 'members') || d.members == null || (Array.isArray(d.members) && d.members.length <= MAX_PROJECT_ROLES && d.members.every(validId)), 'Proje üyeleri geçersiz'],
    [d.perms == null || !permsError(d.perms), d.perms == null ? '' : permsError(d.perms) || ''],
  ],
  /* Cariler (#11). İletilerde değer YOK: kişisel veri (T.C. kimlik no, e-posta) günlüğe/yanıta düşmesin. */
  customers: (d, opts) => [
    [typeof d.name === 'string' && d.name.trim().length >= 1 && d.name.length <= 200, 'Unvan gerekli (en fazla 200 karakter)'],
    [CUSTOMER_KINDS.includes(d.kind), 'Tür müşteri, tedarikçi ya da ikisi olmalı'],
    [optStr(d.shortName, 60), 'Kısa ad en fazla 60 karakter'],
    [optStr(d.taxOffice, 100), 'Vergi dairesi en fazla 100 karakter'],
    [d.taxNo == null || d.taxNo === '' || (typeof d.taxNo === 'string' && TAX_NO_RE.test(d.taxNo)), TAX_NO_MSG],
    [!changed(d, opts, 'taxNo') || d.taxNo == null || d.taxNo === '' || VKN_RE.test(d.taxNo), TAX_NO_MSG],
    [optStr(d.address, 500), 'Adres en fazla 500 karakter'],
    [cuEmail(d.email, opts.cur?.email, opts.live), 'E-posta adresi geçersiz'],
    [optStr(d.phone, 30), 'Telefon en fazla 30 karakter'],
    [optStr(d.notes, 2000), 'Notlar en fazla 2000 karakter'],
    [optBool(d.active), 'Durum (etkin) true ya da false olmalı'],
    /* Cari özel alanları (fields.scope = 'customer'): değerler customers.data.cf'de, işlerdeki cf ile aynı biçim. */
    [!changed(d, opts, 'cf') || cfOk(d.cf), 'Cari alan değerleri geçersiz (en fazla 200 alan; değer metin, sayı ya da evet/hayır)'],
    ...contactRules(d.contacts, opts),
  ],
  workspaces: d => [
    [str(d.name, 100) && d.name.trim().length >= 1 && d.name.trim().length <= 60,
      'Çalışma alanı adı gerekli (en fazla 60 karakter)'],
    [d.color == null || d.color === '' || (typeof d.color === 'string' && HEX_RE.test(d.color)), 'Renk #RRGGBB biçiminde olmalı'],
    [optStr(d.description, 500), 'Açıklama en fazla 500 karakter'],
    [optBool(d.archived), 'Arşiv bilgisi true ya da false olmalı'],
    /* Alan yöneticileri (yetki-v2): kişi kimlikleri, tekil, en çok 1000. */
    [d.admins == null || (Array.isArray(d.admins) && d.admins.length <= MAX_PROJECT_ROLES && d.admins.every(validId)
      && new Set(d.admins).size === d.admins.length), 'Alan yöneticileri geçersiz (tekil kişi kimlikleri, en fazla 1000)'],
  ],
  /* Kolon adı 1–30 karakter: yalnız canlı yazmada (opts.live), yeni kolonda ya da ad değişince.
     Eski uzun adlı kolon sıralanabilir; içe aktarma/geri yükleme eski veriyi reddetmez. */
  statuses: (d, opts) => [
    [str(d.projectId, 200), 'Durumun projesi yok'],
    [str(d.name, 100) && d.name.trim(), 'Durum adı gerekli'],
    [!opts.live || typeof d.name !== 'string' || (opts.cur && opts.cur.name === d.name) || (d.name.trim().length >= 1 && d.name.length <= COL_NAME_MAX),
      `Kolon adı 1 ile ${COL_NAME_MAX} karakter arasında olmalı`],
    [d.cat == null || ['todo', 'inprogress', 'done'].includes(d.cat), 'Geçersiz durum kategorisi'],
  ],
  sprints: d => [[str(d.projectId, 200), 'Sprintin projesi yok'], [optStr(d.name, 200), 'Sprint adı çok uzun'],
    [d.plan == null || validPlan(d.plan), 'Geçersiz sprint planı']],
  issues: (d, opts) => [
    [str(d.projectId, 200), 'İşin projesi yok'],
    [optKey(d.key, ISSUE_KEY_RE), 'Geçersiz iş anahtarı'],
    [typeof d.summary === 'string' && d.summary.length <= 500, 'İş özeti gerekli (en fazla 500 karakter)'],
    [optStr(d.description, 100000), 'Açıklama çok uzun'],
    [date(d.due) && date(d.start), 'Geçersiz tarih'],
    [(!changed(d, opts, 'start') || realDate(d.start)) && (!changed(d, opts, 'due') || realDate(d.due)),
      'Tarih YYYY-AA-GG biçiminde geçerli bir gün olmalı'],
    [!(changed(d, opts, 'start') || changed(d, opts, 'due')) || !d.start || !d.due || String(d.due) >= String(d.start),
      'Bitiş, başlangıçtan önce olamaz'],
    [d.customerId == null || d.customerId === '' || validId(d.customerId), 'Geçersiz cari'],
    [d.estimate == null || (typeof d.estimate === 'number' && d.estimate >= 0), 'Tahmin negatif olamaz'],
    [!changed(d, opts, 'estimate') || d.estimate == null || (Number.isFinite(d.estimate) && d.estimate <= ESTIMATE_MAX),
      `Tahmin en fazla ${ESTIMATE_MAX} saat olabilir`],
    [d.priority == null || (Number.isInteger(d.priority) && d.priority >= 1 && d.priority <= 5), 'Öncelik 1 ile 5 arasında bir tamsayı olmalı'],
    [d.points == null || (typeof d.points === 'number' && Number.isFinite(d.points) && d.points >= 0 && d.points <= 1000), 'Puan 0 ile 1000 arasında bir sayı olmalı'],
    [d.color == null || d.color === '' || (typeof d.color === 'string' && HEX_RE.test(d.color)), 'Renk #RRGGBB biçiminde olmalı'],
    [d.labels == null || (Array.isArray(d.labels) && d.labels.length <= 50 && d.labels.every(l => typeof l === 'string' && l.length <= 100)),
      'Etiketler en fazla 50 metin olmalı (her biri en fazla 100 karakter)'],
    /* Talep eden (görev 12): yok/null ya da cari kimliği + o carinin yetkili kişi kimliği. */
    [d.requester == null || (typeof d.requester === 'object' && !Array.isArray(d.requester)
      && validId(d.requester.customerId) && validId(d.requester.contactId)), 'Talep eden geçersiz'],
    [optEmail(d.requesterEmail), 'Talep edenin e-posta adresi geçersiz'],
    [!changed(d, opts, 'cf') || cfOk(d.cf), 'Özel alan değerleri geçersiz (en fazla 200 alan; değer metin, sayı ya da evet/hayır)'],
    [!changed(d, opts, 'billable') || optStr(d.billable, 100), 'Faturalama değeri en fazla 100 karakter'],
    [!changed(d, opts, 'billType') || optStr(d.billType, 100), 'Fatura türü değeri en fazla 100 karakter'],
  ],
  /* Değer serbesttir (zorunluluk yok, eski değerler korunur): seçenek listesine uyum zorlanmaz. */
  fields: (d, opts) => {
    const b = d.bind == null || d.bind === '' ? null : d.bind, B = b && Object.hasOwn(FIELD_BINDS, b) ? FIELD_BINDS[b] : null;
    const cur = opts.cur;
    return [
      [!changed(d, opts, 'name') || (typeof d.name === 'string' && d.name.trim().length >= 1 && d.name.length <= 60), 'Alan adı gerekli (en fazla 60 karakter)'],
      [!changed(d, opts, 'key') || (typeof d.key === 'string' && FIELD_KEY_RE.test(d.key)), 'Alan anahtarı yalnız küçük harf, rakam ve _ içerebilir (en fazla 30)'],
      [!changed(d, opts, 'type') || FIELD_TYPES.includes(d.type), 'Geçersiz alan türü'],
      [!changed(d, opts, 'scope') || d.scope == null || FIELD_SCOPES.includes(d.scope), 'Geçersiz alan kapsamı'],
      [!opts.live || d.scope !== 'customer' || ((d.projectId == null || d.projectId === '') && b == null),
        'Cari alanı tüm carilerde geçerlidir; projeye ya da hazır alana bağlanamaz'],
      [!opts.live || d.scope !== 'customer' || !changed(d, opts, 'type') || CUSTOMER_FIELD_TYPES.includes(d.type),
        'Cari alanının türü metin, sayı, tarih, seçim ya da evet/hayır olmalı'],
      [d.projectId == null || d.projectId === '' || validId(d.projectId), 'Geçersiz proje'],
      [!changed(d, opts, 'options') || optionsOk(d.options), `Seçenekler en fazla ${MAX_FIELD_OPTIONS} tekil metin olmalı (her biri 1–100 karakter)`],
      [!changed(d, opts, 'def') || defOk(d.def), 'Varsayılan değer geçersiz'],
      [['onCard', 'onList', 'archived', 'hidden'].every(k => !changed(d, opts, k) || optBool(d[k])), 'Alan işaretleri true ya da false olmalı'],
      /* Hazır alan: bilinen bind, projeye özel, anahtar/tür sabit; Faturalama seçenekleri değişmez (raporlar ve eski sürüm). */
      [b == null || !!B, 'Geçersiz hazır alan'],
      [!opts.live || !B || (typeof d.projectId === 'string' && d.projectId !== ''), 'Hazır alan bir projeye bağlı olmalı'],
      [!opts.live || !B || (d.key === B.key && d.type === B.type), 'Hazır alanın anahtarı ve türü değiştirilemez'],
      [!opts.live || b !== 'billable' || d.options == null || sameJson(d.options, BILLABLE_OPTIONS), 'Faturalama seçenekleri değiştirilemez'],
      [!opts.live || b !== 'customerId' || d.options == null || (Array.isArray(d.options) && !d.options.length), 'Cari alanının seçenekleri cari kayıtlarından gelir'],
      /* Sonradan değişmez: bind, kapsam ve proje (yetki ve değer yeri bunlara bağlı). */
      [!opts.live || !cur || ((cur.bind ?? null) === (d.bind ?? null) && (cur.scope ?? 'issue') === (d.scope ?? 'issue')
        && (cur.projectId || null) === (d.projectId || null)), 'Alanın hazır alan bağı, kapsamı ve projesi sonradan değiştirilemez'],
    ];
  },
  reports: d => [
    [Buffer.byteLength(JSON.stringify(d)) <= REPORT_MAX_BYTES, 'Rapor kaydı çok büyük'],
    [Object.keys(d).every(k => REPORT_KEYS.has(k)), 'Rapor kaydında bilinmeyen alan var'],
    [typeof d.name === 'string' && d.name.trim().length >= 1 && d.name.length <= REPORT_NAME_MAX, `Rapor adı gerekli (en fazla ${REPORT_NAME_MAX} karakter)`],
    [optStr(d.desc, REPORT_DESC_MAX), `Açıklama en fazla ${REPORT_DESC_MAX} karakter`],
    [validId(d.ownerId), 'Raporun sahibi geçersiz'],
    [REPORT_VIS.includes(d.vis), 'Görünürlük "private" ya da "shared" olmalı'],
    [reportScopeOk(d.scope), 'Rapor kapsamı geçersiz (tüm sistem, çalışma alanı ya da proje)'],
    [reportCfgOk(d.cfg), 'Rapor ayarı geçersiz (boyut, ölçü, grafik, dönem ya da süzgeç)'],
    [d.tpl == null || (typeof d.tpl === 'string' && /^[a-z0-9_]{1,30}$/.test(d.tpl)), 'Hazır rapor kimliği geçersiz'],
    [optTime(d.createdAt) && optTime(d.updatedAt), 'Rapor zamanı geçersiz'],
  ],
  worklogs: d => [
    [str(d.issueId, 200), 'Süre kaydının işi yok'],
    [str(d.userId, 200), 'Süre kaydının kişisi yok'],
    [date(d.date) && d.date, 'Süre kaydının tarihi yok'],
    [typeof d.hours === 'number' && Number.isFinite(d.hours) && d.hours >= 0 && d.hours <= 24, 'Saat 0 ile 24 arasında olmalı'],
  ],
  /* Geçmiş (B2): eski kayıtlarla uyum için gevşek. Canlı yazmada işi olmalı; içe aktarma/geri yükleme
     işsiz, yazarsız ya da zamansız eski kaydı atlamaz. Metinler önce normalizeHistory ile kırpılır. */
  history: (d, opts) => [
    [opts.live ? str(d.issueId, 200) && d.issueId.length > 0
      : d.issueId == null || typeof d.issueId === 'number' || str(d.issueId, 200), 'Geçmiş kaydının işi yok'],
    [d.field == null || str(d.field, HIST_FIELD_MAX), `Geçmiş alan adı en fazla ${HIST_FIELD_MAX} karakter`],
    [histVal(d.from) && histVal(d.to), 'Geçmiş değeri metin, sayı ya da boş olmalı'],
    [opts.live ? optStr(d.userId, 200) : d.userId == null || ['string', 'number'].includes(typeof d.userId),
      'Geçmiş kaydının kişisi geçersiz'],
    [!opts.live || d.at == null || (typeof d.at === 'number' && Number.isFinite(d.at)) || str(d.at, 40),
      'Geçmiş kaydının zamanı geçersiz'],
    [['kind', 'key', 'rule'].every(k => d[k] == null || str(d[k], HIST_TEXT_MAX)), 'Geçmiş kaydı alanı geçersiz'],
  ],
  comments: d => [
    [str(d.issueId, 200), 'Yorumun işi yok'],
    [typeof d.body === 'string' && d.body.length <= 20000, 'Yorum en fazla 20.000 karakter'],
  ],
};

/* Geçmiş metinleri (B2): alan adı 100, değerler ve diğer metinler 200 karaktere '…' ile kırpılır; nesne/dizi
   değer (eski veri) JSON metnine çevrilir. Doğrulamadan ÖNCE çağrılır (eski uzun kayıt reddedilmesin/atlanmasın).
   Değer değiştiyse true döner. */
export const HIST_TEXT_MAX = 200;
export const HIST_FIELD_MAX = 100;
const histVal = v => v == null || ['string', 'number', 'boolean'].includes(typeof v);
const clip = (s, n) => {
  if (s.length <= n) return s;
  let t = s.slice(0, n - 1);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);   // vekil çifti bölünmesin
  return t + '…';
};
export function normalizeHistory(d) {
  if (!d || typeof d !== 'object') return false;
  let changed = false;
  for (const k of ['field', 'from', 'to', 'kind', 'key', 'rule']) {
    let v = d[k];
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object') { try { v = JSON.stringify(v); } catch { v = String(v); } }
    else if (typeof v === 'number' && !Number.isFinite(v)) v = null;
    if (k !== 'from' && k !== 'to' && (typeof v === 'number' || typeof v === 'boolean')) v = String(v);
    if (typeof v === 'string') v = clip(v, k === 'field' ? HIST_FIELD_MAX : HIST_TEXT_MAX);
    if (v !== d[k]) { d[k] = v; changed = true; }
  }
  return changed;
}

/* İş önceliği: sayısal metin sayıya çevrilir, geçersiz değer 3 (Orta) olur.
   Alan yoksa (eski kayıt) dokunulmaz. Değer değiştiyse true döner. */
export function normalizePriority(d) {
  if (!d || d.priority == null) return false;
  const v = d.priority;
  let n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  if (!(Number.isInteger(n) && n >= 1 && n <= 5)) n = 3;
  if (n === v) return false;
  d.priority = n;
  return true;
}

/* Arşiv bilgisi: eski (SharePoint) verideki "true"/"false" metni (büyük/küçük harf duyarsız) ve 1/0
   boolean'a çevrilir; diğer değerlere dokunulmaz (doğrulama reddeder). Değer değiştiyse true döner. */
export function normalizeArchived(d) {
  if (!d || d.archived == null || typeof d.archived === 'boolean') return false;
  const v = d.archived;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : v;
  if (s === 'true' || s === 1) d.archived = true;
  else if (s === 'false' || s === 0) d.archived = false;
  else return false;
  return true;
}

/* Cari: vergi numarasındaki boşluk/tire silinir; unvan, e-posta (cari ve yetkili kişi) ve kişi adı kırpılır.
   Değer değiştiyse true döner (istemci sunucudaki hâli yeniden alır). */
export function normalizeCustomer(d) {
  if (!d || typeof d !== 'object') return false;
  let changed = false;
  const set = (o, k, v) => { if (o[k] !== v) { o[k] = v; changed = true; } };
  if (typeof d.taxNo === 'string') set(d, 'taxNo', d.taxNo.replace(/[\s-]/g, ''));
  for (const k of ['name', 'email']) if (typeof d[k] === 'string') set(d, k, d[k].trim());
  if (Array.isArray(d.contacts)) {
    for (const p of d.contacts) {
      if (!p || typeof p !== 'object') continue;
      for (const k of ['name', 'email']) if (typeof p[k] === 'string') set(p, k, p[k].trim());
    }
  }
  return changed;
}

/* Genel ayar `cfg`: iş tipleri kartta rozet olarak basılır (harf, ad, renk). */
export function validateCfg(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Geçersiz ayar');
  if (v.types === undefined) return;
  const ok = Array.isArray(v.types) && v.types.length <= 100 && v.types.every(t => t && typeof t === 'object'
    && typeof t.id === 'string' && t.id.length <= 40 && ID_RE.test(t.id)
    && typeof t.name === 'string' && t.name.length >= 1 && t.name.length <= 100
    && typeof t.letter === 'string' && t.letter.length <= 4
    && typeof t.color === 'string' && HEX_RE.test(t.color));
  if (!ok) throw new HttpError(400, 'Geçersiz iş tipi ayarı (kimlik, ad, harf ve #RRGGBB renk gerekli)');
}

/* Genel ayar `navDefault` (yönetici, herkes için varsayılan kenar çubuğu): { items: [{ id, visible }] }.
   Kimlikler istemcideki NAV_MOVABLE ile aynı (bilinen, benzersiz); visible boolean; başka anahtar yok. */
export const NAV_DEFAULT_IDS = ['recent', 'customers', 'reports', 'pool', 'users', 'system'];
/* Genel ayar `perms` (sistem varsayılanı rol yetkileri, yalnız sistem yöneticisi): perms.js permsError. */
export function validatePerms(v) {
  const e = permsError(v, { system: true });
  if (e) throw new HttpError(400, e);
}
export function validateNavDefault(v) {
  const ok = v != null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => k === 'items')
    && Array.isArray(v.items) && v.items.length <= NAV_DEFAULT_IDS.length
    && v.items.every((x, i, a) => x && typeof x === 'object' && !Array.isArray(x)
      && Object.keys(x).every(k => k === 'id' || k === 'visible')
      && typeof x.id === 'string' && NAV_DEFAULT_IDS.includes(x.id) && typeof x.visible === 'boolean'
      && a.findIndex(y => y && y.id === x.id) === i);
  if (!ok) throw new HttpError(400, 'Geçersiz varsayılan menü (bilinen öğe kimlikleri, benzersiz, görünürlük true/false)');
}

/* Genel ayar `modules` (yönetici, Sistem → Modüller): { customers?: boolean }. Yok/true = açık; false = Cariler modülü
   kapalı (veri silinmez; sunucu cari yazmalarını reddeder, store.js customersOff). Başka anahtar yok. */
export const MODULE_KEYS = ['customers'];
export function validateModules(v) {
  const ok = v != null && typeof v === 'object' && !Array.isArray(v)
    && Object.entries(v).every(([k, x]) => MODULE_KEYS.includes(k) && typeof x === 'boolean');
  if (!ok) throw new HttpError(400, 'Geçersiz modül ayarı (yalnız customers: true/false)');
}

/* opts: { live: true, cur } → /api/sync yazması (cur: veritabanındaki güncel hâl); içe aktarmada verilmez. */
export function validate(collection, data, opts = {}) {
  if (JSON.stringify(data).length > MAX_RECORD) throw new HttpError(400, 'Kayıt çok büyük');
  const r = Object.hasOwn(RULES, collection) ? RULES[collection] : undefined;   // `constructor` kural değildir
  if (!r) return;
  for (const [ok, msg] of r(data, opts)) if (!ok) throw new HttpError(400, msg);
}
