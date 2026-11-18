import { HttpError } from './util.js';

/* Kayıt doğrulama. Eski verilerle uyum için gevşek tutuldu: yalnızca verinin
   bütünlüğünü bozacak hataları reddeder. */
const MAX_RECORD = 512 * 1024;
const str = (v, max = 1000) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v == null || v === '' || str(v, max);
const date = v => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));

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

const RULES = {
  projects: d => [
    [str(d.name, 200) && d.name.trim(), 'Proje adı gerekli'],
    [optKey(d.key, KEY_RE), 'Proje anahtarı yalnızca harf, rakam, _ ve - içerebilir (en fazla 20)'],
    [optKey(d.code, KEY_RE), 'Proje kodu geçersiz'],
    [d.workspaceId == null || d.workspaceId === '' || validId(d.workspaceId), 'Geçersiz çalışma alanı'],
    [optBool(d.archived), 'Arşiv bilgisi true ya da false olmalı'],
  ],
  workspaces: d => [
    [str(d.name, 100) && d.name.trim().length >= 1 && d.name.trim().length <= 60,
      'Çalışma alanı adı gerekli (en fazla 60 karakter)'],
    [d.color == null || d.color === '' || (typeof d.color === 'string' && HEX_RE.test(d.color)), 'Renk #RRGGBB biçiminde olmalı'],
    [optStr(d.description, 500), 'Açıklama en fazla 500 karakter'],
    [optBool(d.archived), 'Arşiv bilgisi true ya da false olmalı'],
  ],
  statuses: d => [
    [str(d.projectId, 200), 'Durumun projesi yok'],
    [str(d.name, 100) && d.name.trim(), 'Durum adı gerekli'],
    [d.cat == null || ['todo', 'inprogress', 'done'].includes(d.cat), 'Geçersiz durum kategorisi'],
  ],
  sprints: d => [[str(d.projectId, 200), 'Sprintin projesi yok'], [optStr(d.name, 200), 'Sprint adı çok uzun']],
  issues: d => [
    [str(d.projectId, 200), 'İşin projesi yok'],
    [optKey(d.key, ISSUE_KEY_RE), 'Geçersiz iş anahtarı'],
    [typeof d.summary === 'string' && d.summary.length <= 500, 'İş özeti gerekli (en fazla 500 karakter)'],
    [optStr(d.description, 100000), 'Açıklama çok uzun'],
    [date(d.due) && date(d.start), 'Geçersiz tarih'],
    [d.estimate == null || (typeof d.estimate === 'number' && d.estimate >= 0), 'Tahmin negatif olamaz'],
    [d.priority == null || (Number.isInteger(d.priority) && d.priority >= 1 && d.priority <= 5), 'Öncelik 1 ile 5 arasında bir tamsayı olmalı'],
    [d.points == null || (typeof d.points === 'number' && Number.isFinite(d.points) && d.points >= 0 && d.points <= 1000), 'Puan 0 ile 1000 arasında bir sayı olmalı'],
    [d.color == null || d.color === '' || (typeof d.color === 'string' && HEX_RE.test(d.color)), 'Renk #RRGGBB biçiminde olmalı'],
    [d.labels == null || (Array.isArray(d.labels) && d.labels.length <= 50 && d.labels.every(l => typeof l === 'string' && l.length <= 100)),
      'Etiketler en fazla 50 metin olmalı (her biri en fazla 100 karakter)'],
  ],
  worklogs: d => [
    [str(d.issueId, 200), 'Süre kaydının işi yok'],
    [str(d.userId, 200), 'Süre kaydının kişisi yok'],
    [date(d.date) && d.date, 'Süre kaydının tarihi yok'],
    [typeof d.hours === 'number' && Number.isFinite(d.hours) && d.hours >= 0 && d.hours <= 24, 'Saat 0 ile 24 arasında olmalı'],
  ],
  comments: d => [
    [str(d.issueId, 200), 'Yorumun işi yok'],
    [typeof d.body === 'string' && d.body.length <= 20000, 'Yorum en fazla 20.000 karakter'],
  ],
};

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

export function validate(collection, data) {
  if (JSON.stringify(data).length > MAX_RECORD) throw new HttpError(400, 'Kayıt çok büyük');
  const r = Object.hasOwn(RULES, collection) ? RULES[collection] : undefined;   // `constructor` kural değildir
  if (!r) return;
  for (const [ok, msg] of r(data)) if (!ok) throw new HttpError(400, msg);
}
