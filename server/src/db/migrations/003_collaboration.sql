-- Schritt 3: Zusammenarbeit (Sperren, Prüfvermerke) und SharePoint

-- Bearbeitungssperre pro Konto (verhindert gleichzeitiges Bearbeiten)
CREATE TABLE account_locks (
  account_id      uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  engagement_id   uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  locked_by       text NOT NULL,
  locked_by_name  text NOT NULL,
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX ON account_locks(engagement_id);

-- Prüfvermerk des Prüfers pro Konto (versioniert: jede Änderung ist eine neue Zeile)
CREATE TABLE account_reviews (
  id            bigserial PRIMARY KEY,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES match_runs(id) ON DELETE SET NULL,
  decision      text NOT NULL CHECK (decision IN ('offen','bestaetigt','abweichung','nicht_anwendbar')),
  comment       text NOT NULL DEFAULT '',
  version       int NOT NULL,
  reviewed_by   text NOT NULL,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);

ALTER TABLE evidence_documents ADD COLUMN sharepoint_item_id text;
