-- Balance Scout – Grundschema (Schritt 1)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE engagements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  client_name   text,
  closing_date  date,
  currency      char(3) NOT NULL DEFAULT 'CHF',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL
);

CREATE TABLE trial_balances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id     uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  file_sha256       char(64) NOT NULL,
  storage_key       text NOT NULL,
  sign_convention   text NOT NULL CHECK (sign_convention IN ('signed','unsigned')),
  column_mapping    jsonb NOT NULL,
  header_row_index  int NOT NULL,
  validation        jsonb NOT NULL,
  is_valid          boolean NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL
);
CREATE INDEX ON trial_balances(engagement_id);

CREATE TABLE accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_balance_id      uuid NOT NULL REFERENCES trial_balances(id) ON DELETE CASCADE,
  row_index             int NOT NULL,
  account_number        text NOT NULL,
  account_name          text NOT NULL,
  balance_cy            numeric(18,2) NOT NULL,
  balance_py            numeric(18,2),
  balance_fx            numeric(18,2),
  group_code            text,
  group_name            text,
  category              text NOT NULL
);
CREATE INDEX ON accounts(trial_balance_id);

CREATE TABLE evidence_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_id     uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        bigint NOT NULL,
  file_sha256       char(64) NOT NULL,
  storage_key       text NOT NULL,
  extraction_method text NOT NULL,
  page_count        int NOT NULL DEFAULT 0,
  needs_ocr         boolean NOT NULL DEFAULT false,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  UNIQUE (engagement_id, file_sha256)
);

CREATE TABLE evidence_lines (
  document_id  uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  page         int NOT NULL,
  line_no      int NOT NULL,
  text         text NOT NULL,
  source       text NOT NULL DEFAULT 'text-layer', -- später: 'ocr:<provider>'
  PRIMARY KEY (document_id, page, line_no)
);

CREATE TABLE match_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_balance_id  uuid NOT NULL REFERENCES trial_balances(id) ON DELETE CASCADE,
  engine_version    text NOT NULL,
  params            jsonb NOT NULL,
  summary           jsonb NOT NULL,
  document_ids      uuid[] NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL
);

CREATE TABLE match_results (
  run_id      uuid NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status      text NOT NULL,
  best        jsonb,
  candidates  jsonb NOT NULL,
  reasons     jsonb NOT NULL,
  PRIMARY KEY (run_id, account_id)
);

-- Unveränderliches Prüfprotokoll
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor         text NOT NULL,
  action        text NOT NULL,
  engagement_id uuid,
  entity        text NOT NULL,
  entity_id     text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ON audit_log(engagement_id, at);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log ist unveränderlich'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
