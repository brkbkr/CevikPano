-- 004: cariler (#11). Yalnızca ek tablo, ek indeks ve ek (üretilen) sütun:
-- eski sürüm bu şemayla da açılır (yeni tabloyu okumaz, projelerdeki
-- customerId alanını birleştirmede korur). Tekrar çalıştırılabilir.
-- Yetkili kişiler kaydın içinde (data->'contacts') durur; ayrı tablo yok.

CREATE TABLE IF NOT EXISTS customers (
  id          text PRIMARY KEY,
  data        jsonb NOT NULL,
  name        text GENERATED ALWAYS AS (data->>'name') STORED,
  tax_no      text GENERATED ALWAYS AS (nullif(data->>'taxNo', '')) STORED,
  kind        text GENERATED ALWAYS AS (data->>'kind') STORED,
  active      boolean GENERATED ALWAYS AS (coalesce((data->>'active')::boolean, true)) STORED,
  version     integer NOT NULL DEFAULT 1,
  ord         bigserial,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Vergi numarası (pasif cariler dahil) tekil; boş vergi numarası denetlenmez.
-- Eşzamanlı iki kayıtta ikincisini veritabanı reddeder (store.js bu adla eşler).
CREATE UNIQUE INDEX IF NOT EXISTS customers_tax_no_uq ON customers (tax_no) WHERE tax_no IS NOT NULL;

-- Projenin bağlı olduğu cari (en çok bir). Silmede bağlı proje sayımı bu indeksi kullanır.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_id text
  GENERATED ALWAYS AS (data->>'customerId') STORED;
CREATE INDEX IF NOT EXISTS projects_customer_idx ON projects (customer_id);
