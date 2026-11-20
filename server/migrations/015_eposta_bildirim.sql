-- E-posta bildirimleri ve sabah özeti (server/notifymail.js).
-- Yalnız EK kolon ve tablolar: eski sürüm bu şemayla da açılır (kolonu ve tabloları bilmez, dokunmaz).
-- Bu tablolar TABLES'a girmez, istemciye inmez. Kişisel tercihler user_prefs.data.notif içinde (yeni kolon yok).

-- Bildirimlerin gönderildiği posta kutusu (en fazla bir tane; Sistem → Posta kutuları).
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS notify_sender boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_notify_sender_uq ON mail_accounts ((true)) WHERE notify_sender;

-- Gönderilmeyi bekleyen olaylar: aynı kişinin kısa sürede gelen olayları tek e-postada birleştirilir.
-- status: pending | sent | dropped (erişim kalktı, tercih kapandı, iş silindi, çok eskidi).
CREATE TABLE IF NOT EXISTS mail_notify_queue (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- assigned | comment | mention | status | due_soon | overdue
  issue_id    text,
  actor_id    text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS mail_notify_queue_pending_idx ON mail_notify_queue (user_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS mail_notify_queue_created_idx ON mail_notify_queue (created_at);
-- Bitiş hatırlatması aynı iş ve aynı bitiş tarihi için kişiye bir kez.
CREATE UNIQUE INDEX IF NOT EXISTS mail_notify_queue_due_uq ON mail_notify_queue (user_id, issue_id, kind, (meta->>'due'))
  WHERE kind IN ('due_soon', 'overdue');

-- Gönderilen e-postalar (hız sınırı ve günde bir sabah özeti). İçerik saklanmaz.
CREATE TABLE IF NOT EXISTS mail_notify_sent (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- events | digest
  day         date,                          -- sabah özeti: İstanbul günü
  items       integer NOT NULL DEFAULT 0,
  sent        boolean NOT NULL DEFAULT true, -- false: özet boştu, e-posta gitmedi
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_notify_sent_created_idx ON mail_notify_sent (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS mail_notify_sent_digest_uq ON mail_notify_sent (user_id, day) WHERE kind = 'digest';
