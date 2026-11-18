// Demo/eski JSON verisini API üzerinden yükler: node scripts/seed-demo.mjs <adres> <json> [kullanıcı] [parola]
import fs from 'node:fs';
const [base, file, user = 'admin', pass = 'admin12345'] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
let cookie = '';
const req = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'x-pano': '1', 'content-type': 'application/json', cookie }, body: b && JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r.json(); };
await req('POST', '/api/auth/login', { username: user, password: pass });
const ch = [];
for (const [k, v] of Object.entries(d)) {
  if (['ui', 'board', 'open', 'savedAt', 'savedBy'].includes(k)) continue;
  if (Array.isArray(v)) v.forEach(x => x?.id != null && ch.push({ c: k, id: String(x.id), op: 'put', data: x }));
  else ch.push({ c: '_settings', id: k, op: 'put', data: v });
}
ch.sort((a, b) => (a.c === 'users' ? 0 : 1) - (b.c === 'users' ? 0 : 1));
for (let i = 0; i < ch.length; i += 1000) console.log(JSON.stringify(await req('POST', '/api/sync', { changes: ch.slice(i, i + 1000) })).slice(0, 200));
