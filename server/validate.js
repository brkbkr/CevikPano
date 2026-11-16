import { HttpError } from './util.js';

/* Kayıt doğrulama. Eski verilerle uyum için gevşek tutuldu: yalnızca verinin
   bütünlüğünü bozacak hataları reddeder. */
const MAX_RECORD = 512 * 1024;
const str = (v, max = 1000) => typeof v === 'string' && v.length <= max;
const optStr = (v, max) => v == null || v === '' || str(v, max);
const date = v => v == null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));

const RULES = {
  projects: d => [
    [str(d.name, 200) && d.name.trim(), 'Proje adı gerekli'],
    [optStr(d.key, 20), 'Proje anahtarı en fazla 20 karakter'],
  ],
  statuses: d => [
    [str(d.projectId, 200), 'Durumun projesi yok'],
    [str(d.name, 100) && d.name.trim(), 'Durum adı gerekli'],
    [d.cat == null || ['todo', 'inprogress', 'done'].includes(d.cat), 'Geçersiz durum kategorisi'],
  ],
  sprints: d => [[str(d.projectId, 200), 'Sprintin projesi yok'], [optStr(d.name, 200), 'Sprint adı çok uzun']],
  issues: d => [
    [str(d.projectId, 200), 'İşin projesi yok'],
    [typeof d.summary === 'string' && d.summary.length <= 500, 'İş özeti gerekli (en fazla 500 karakter)'],
    [optStr(d.description, 100000), 'Açıklama çok uzun'],
    [date(d.due) && date(d.start), 'Geçersiz tarih'],
    [d.estimate == null || (typeof d.estimate === 'number' && d.estimate >= 0), 'Tahmin negatif olamaz'],
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

export function validate(collection, data) {
  if (JSON.stringify(data).length > MAX_RECORD) throw new HttpError(400, 'Kayıt çok büyük');
  const r = RULES[collection];
  if (!r) return;
  for (const [ok, msg] of r(data)) if (!ok) throw new HttpError(400, msg);
}
