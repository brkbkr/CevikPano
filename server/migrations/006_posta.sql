-- Posta kutusu bağlantısı (Gmail / Outlook, OAuth) ve e-postadan iş (görev 11, E2).
-- Yalnız EK tablolar: eski sürüm bu şemayla da açılır. Bu tablolar TABLES'a girmez, istemciye inmez;
-- yalnız yönetici uçları (/api/mail/*) maskeli olarak okur. Jetonlar AES-256-GCM ile şifreli saklanır
-- (anahtar sunucudaki MAIL_TOKEN_KEY); ham ileti saklanmaz.

CREATE TABLE IF NOT EXISTS mail_accounts (
  id                 text PRIMARY KEY,
  provider           text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  address            text NOT NULL,
  refresh_token_enc  text,
  access_token_enc   text,
  access_expires_at  timestamptz,
  cursor             text,                        -- Gmail historyId / Graph deltaLink
  default_project_id text,
  active             boolean NOT NULL DEFAULT true,
  status             text NOT NULL DEFAULT 'ok',  -- ok | reconnect
  last_poll_at       timestamptz,
  last_error         text,
  fail_count         integer NOT NULL DEFAULT 0,
  backoff_until      timestamptz,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_accounts_addr_uq ON mail_accounts (provider, lower(address));

CREATE TABLE IF NOT EXISTS mail_rules (
  id               text PRIMARY KEY,
  ord              integer NOT NULL DEFAULT 0,
  account_id       text REFERENCES mail_accounts(id) ON DELETE CASCADE,   -- null: tüm kutular
  to_match         text,
  subject_contains text,
  from_domain      text,
  project_id       text NOT NULL,
  assignee_id      text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_rules_ord_idx ON mail_rules (ord);

CREATE TABLE IF NOT EXISTS mail_messages (
  id              bigserial PRIMARY KEY,
  message_id      text NOT NULL,
  account_id      text,
  provider_msg_id text,
  issue_id        text,
  comment_id      text,
  direction       text NOT NULL DEFAULT 'in',      -- in | out
  from_addr       text,
  received_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_mid_uq ON mail_messages (message_id);
CREATE INDEX IF NOT EXISTS mail_messages_prov_idx ON mail_messages (account_id, provider_msg_id);
CREATE INDEX IF NOT EXISTS mail_messages_issue_idx ON mail_messages (issue_id);

-- OAuth başlangıcı: tek kullanımlık state + PKCE doğrulayıcısı (10 dk).
CREATE TABLE IF NOT EXISTS mail_oauth_states (
  state      text PRIMARY KEY,
  provider   text NOT NULL,
  verifier   text NOT NULL,
  user_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
