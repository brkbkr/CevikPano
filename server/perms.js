/* Proje bazlı yetki modeli (yetki-v2). Kural TEK yerde: sunucu (store.js) ve istemci (public/index.html → projRole /
   effPerms / canP) bu dosyayla birebir aynı mantığı kullanır.
   - Etkin proje rolü (projRole): sistem yöneticisi, alan yöneticisi (sahip ya da ws.admins) ve projenin sahibi (ownerId)
     her zaman 'admin'; diğerleri projenin roles haritasındaki rol. roles'u olmayan (geçiş öncesi / içe aktarılmış) eski
     kayıtta eski kural (legacyRole).
   - Rolün yapabildikleri: DEFAULT_PERMS ⊕ settings.perms (sistem varsayılanı) ⊕ project.perms (projeye özel, seyrek).
     Yönetici sütunu sabittir (her şey açık). */
import { isAdminRole } from './util.js';

export const PROJECT_ROLES = ['admin', 'member', 'viewer'];
export const PERM_KEYS = ['issue.create', 'issue.edit', 'issue.delete', 'comment.write', 'worklog.own',
  'sprint.edit', 'sprint.manage', 'project.settings', 'project.columns', 'project.fields'];
export const PERM_LABEL = {
  'issue.create': 'İş açma', 'issue.edit': 'İş düzenleme', 'issue.delete': 'İş silme', 'comment.write': 'Yorum yazma',
  'worklog.own': 'Süre kaydı', 'sprint.edit': 'Sprint oluşturma', 'sprint.manage': 'Sprint başlatma ve bitirme',
  'project.settings': 'Proje adı ve ayarları', 'project.columns': 'Kolonlar ve proje türü', 'project.fields': 'Proje alanları',
};
const on = keys => Object.fromEntries(PERM_KEYS.map(k => [k, keys.includes(k)]));
export const DEFAULT_PERMS = Object.freeze({
  member: Object.freeze(on(['issue.create', 'issue.edit', 'issue.delete', 'comment.write', 'worklog.own', 'sprint.edit'])),
  viewer: Object.freeze(on([])),
});
export const EDITABLE_ROLES = ['member', 'viewer'];
export const MAX_PROJECT_ROLES = 1000;

const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/* Yetki tablosu biçimi: { member?: { anahtar: boolean }, viewer?: {...} } (+ sistem varsayılanında v). Bilinmeyen rol
   ya da anahtar, boolean olmayan değer → hata iletisi; geçerliyse null. */
export function permsError(v, { system = false } = {}) {
  if (!obj(v)) return 'Yetki tablosu nesne olmalı';
  for (const [r, m] of Object.entries(v)) {
    if (system && r === 'v') { if (v.v !== 1) return 'Yetki tablosu sürümü geçersiz'; continue; }
    if (!EDITABLE_ROLES.includes(r)) return 'Yetki tablosunda yalnız Üye ve İzleyici rolleri değiştirilebilir';
    if (!obj(m)) return 'Yetki tablosu geçersiz';
    for (const [k, b] of Object.entries(m)) {
      if (!PERM_KEYS.includes(k)) return 'Bilinmeyen yetki: ' + String(k).slice(0, 40);
      if (typeof b !== 'boolean') return 'Yetki değeri açık (true) ya da kapalı (false) olmalı';
    }
  }
  return null;
}

/* Etkin tablo (rol → anahtar → boolean). sys: settings.perms, p: proje kaydı. */
export function effPerms(p, sys) {
  const out = {};
  for (const r of EDITABLE_ROLES) {
    out[r] = { ...DEFAULT_PERMS[r] };
    for (const src of [sys, p?.perms]) {
      const m = obj(src) && obj(src[r]) ? src[r] : null;
      if (m) for (const k of PERM_KEYS) if (typeof m[k] === 'boolean') out[r][k] = m[k];
    }
  }
  out.admin = on(PERM_KEYS);
  return out;
}

export const wsOwner = ws => ws?.ownerId ?? ws?.createdBy ?? null;
const wsMembers = ws => (Array.isArray(ws?.members) ? ws.members : []);
/* Alan yöneticileri: sahip + admins. admins alanı olmayan (geçiş öncesi / içe aktarılmış) alanda eski üye listesindeki
   Yönetici rolündekiler. */
export function wsAdminIds(ws) {
  const ids = Array.isArray(ws?.admins) ? ws.admins.filter(x => typeof x === 'string')
    : wsMembers(ws).filter(m => m && m.role === 'admin' && typeof m.userId === 'string').map(m => m.userId);
  const o = wsOwner(ws);
  return o ? [o, ...ids.filter(x => x !== o)] : ids;
}
export const isWsAdmin = (u, ws) => !!u && !!ws && wsAdminIds(ws).includes(u.id);
/* Yöneticisi olmayan alan (Genel gibi): sahibi yok, admins boş. Bu alanda genel rolü Üye olan da proje açar. */
export const wsHasNoAdmin = ws => !!ws && wsAdminIds(ws).length === 0;
const active = u => !!u && u.active !== false;

/* Eski kural (roles'u olmayan proje): üyeli alanda alandaki rol; üyesiz alanda proje üye listesi boşsa herkes, doluysa
   listedekiler (genel izleyici → İzleyici, diğerleri Üye). Geçiş (009) bu kuralla roles yazar. */
export function legacyRole(u, p, ws) {
  if (u.system) return null;
  const mem = wsMembers(ws);
  if (mem.length) {
    const r = mem.find(m => m && m.userId === u.id)?.role;
    return PROJECT_ROLES.includes(r) ? r : null;
  }
  const list = Array.isArray(p?.members) ? p.members : [];
  if (list.length && !list.includes(u.id)) return null;
  return u.role === 'viewer' ? 'viewer' : 'member';
}

/* Etkin proje rolü: 'admin' | 'member' | 'viewer' | null (erişim yok). */
export function projRole(u, p, ws) {
  if (!active(u)) return null;
  if (isAdminRole(u.role)) return 'admin';
  if (isWsAdmin(u, ws)) return 'admin';
  if (!p) return null;
  if (p.ownerId && p.ownerId === u.id) return 'admin';
  if (obj(p.roles)) { const r = Object.hasOwn(p.roles, u.id) ? p.roles[u.id] : null; return PROJECT_ROLES.includes(r) ? r : null; }
  return legacyRole(u, p, ws);
}
export const roleCan = (role, p, sys, key) => role === 'admin' || (!!role && effPerms(p, sys)[role]?.[key] === true);

/* Anahtar düzeyinde üç yönlü birleştirme (roles, perms.member ...): başkasının değiştirdiği anahtarlar korunur. */
export function mergeMap(base, mine, theirs) {
  const B = obj(base) ? base : {}, M = obj(mine) ? mine : {};
  const out = obj(theirs) ? { ...theirs } : {};
  for (const k of new Set([...Object.keys(B), ...Object.keys(M)])) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (JSON.stringify(B[k]) === JSON.stringify(M[k])) continue;
    if (M[k] === undefined) delete out[k]; else out[k] = M[k];
  }
  return out;
}
export function mergePerms(base, mine, theirs) {
  const B = obj(base) ? base : {}, M = obj(mine) ? mine : {}, T = obj(theirs) ? theirs : {};
  const out = {};
  for (const r of new Set([...Object.keys(B), ...Object.keys(M), ...Object.keys(T)])) {
    if (r === '__proto__' || r === 'constructor' || r === 'prototype') continue;
    let v;
    if ([B[r], M[r], T[r]].every(x => x === undefined || obj(x))) v = mergeMap(B[r], M[r], T[r]);
    else v = JSON.stringify(B[r]) === JSON.stringify(M[r]) ? T[r] : M[r];
    if (v !== undefined) out[r] = v;
  }
  return out;
}

/* İşi izle: izleyiciler işin data.watchers dizisinde (kişi kimlikleri). Dizisi olmayan eski işte izleyiciler raporlayan +
   atanan (eski bildirim alıcılarıyla aynı). İstemcideki watchersOf ile birebir aynı. */
export const WATCHERS_MAX = 200;
export function watchersOf(d) {
  const src = Array.isArray(d?.watchers) ? d.watchers : [d?.reporter, d?.assignee];
  return [...new Set(src.filter(x => typeof x === 'string' && x))];
}
/* Küme düzeyinde üç yönlü birleştirme: istemcinin (base → mine) eklediği/çıkardığı kişiler güncel listeye (theirs)
   uygulanır; iki kişi aynı anda izlemeye başlarsa ikisi de kalır. */
export function mergeList(base, mine, theirs) {
  const B = new Set(base), M = new Set(mine);
  const out = theirs.filter(x => !(B.has(x) && !M.has(x))), seen = new Set(out);
  for (const x of mine) if (!B.has(x) && !seen.has(x)) { out.push(x); seen.add(x); }
  return out;
}
