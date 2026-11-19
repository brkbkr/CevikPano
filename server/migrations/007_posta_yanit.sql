-- Kart içinden e-postayla yanıt (madde 21, E3): gelen iletinin konusu ve Gmail konu zinciri kimliği.
-- Yalnız ekleme: eski sürüm bu kolonları bilmeden çalışır; eski satırlarda boş kalır (gönderimde sağlayıcıdan tamamlanır).
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS subject text;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS thread_id text;
