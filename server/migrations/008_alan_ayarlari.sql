-- 008: parametrik proje alanları. Yalnız ekleme, VERİ SİLMEZ ve taşımaz, tekrar çalıştırılabilir.
-- Hazır alanlar (Faturalama, Fatura türü, Cari) fields kaydında data.bind ile işaretlenir; değerler işin
-- yerleşik özelliğinde kalır (billable/billType/customerId). Bir projede her hazır alan en çok bir kez:
-- eşzamanlı ikinci kayıt bu indeksle reddedilir (store.js bunu Türkçe iletiye eşler).
-- Eski sürüm bind kaydı yazmaz; bu kayıtlar hidden:true taşıdığı için eski sürümde görünmez.
CREATE UNIQUE INDEX IF NOT EXISTS fields_project_bind_uq ON fields (coalesce(project_id, ''), (data->>'bind'))
  WHERE data->>'bind' IS NOT NULL;
