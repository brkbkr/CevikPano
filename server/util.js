export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* Anahtar sırası bağımsız JSON (jsonb anahtarları yeniden sıralar). */
export function cj(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(x => x === undefined ? 'null' : cj(x)).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + cj(v[k])).join(',') + '}';
}
export const same = (a, b) => cj(a) === cj(b);

/* Üç yönlü birleştirme (alan düzeyinde).
   base: istemcinin değiştirmeye başladığı hâl, mine: istemcinin yeni hâli,
   theirs: veritabanındaki güncel hâl. İstemcinin değiştirmediği alanlarda
   başkasının değişikliği korunur; ikisi de aynı alanı değiştirdiyse son yazan kazanır. */
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
export function merge3(base, mine, theirs) {
  const out = {};
  for (const k of Object.keys(theirs || {})) if (!BAD_KEYS.has(k)) out[k] = theirs[k];
  for (const k of new Set([...Object.keys(base || {}), ...Object.keys(mine || {})])) {
    if (BAD_KEYS.has(k)) continue;                   // prototip anahtarları hiç taşınmaz
    if (same(own(base, k), own(mine, k))) continue;  // istemci bu alana dokunmadı
    if (own(mine, k) === undefined) delete out[k]; else out[k] = mine[k];
  }
  return out;
}

export const isAdminRole = r => r === 'admin' || r === 'super';
