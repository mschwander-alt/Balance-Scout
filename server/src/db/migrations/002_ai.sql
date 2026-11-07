-- Schritt 2: KI-Schicht

-- Zuordnung Aufgabe -> Anbieter (vom Administrator gepflegt)
CREATE TABLE ai_settings (
  task        text PRIMARY KEY CHECK (task IN ('evidence_extraction','match_review')),
  provider    text NOT NULL CHECK (provider IN ('m365-copilot','azure-foundry','ollama')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text NOT NULL
);

-- Jeder KI-Aufruf (ohne Inhalte – nur Hash, Umfang, Ziel)
CREATE TABLE ai_calls (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor           text NOT NULL,
  engagement_id   uuid REFERENCES engagements(id) ON DELETE SET NULL,
  task            text NOT NULL,
  provider        text NOT NULL,
  model           text,
  destination     text NOT NULL,
  boundary        text NOT NULL,
  document_id     uuid,
  chars_sent      int NOT NULL,
  images_sent     int NOT NULL,
  prompt_sha256   char(64) NOT NULL,
  duration_ms     int NOT NULL,
  status          text NOT NULL,          -- ok | refused | error
  error           text,
  input_tokens    int,
  output_tokens   int
);
CREATE INDEX ON ai_calls(engagement_id, at);

-- Ergebnis der KI-Belegauswertung inkl. Verifikation
CREATE TABLE ai_extractions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  model         text NOT NULL,
  result        jsonb NOT NULL,
  verification  jsonb NOT NULL,
  is_current    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL
);
CREATE UNIQUE INDEX ai_extractions_current ON ai_extractions(document_id) WHERE is_current;

-- KI-Einschätzung zu einem Matching-Ergebnis (nur Hinweis, kein Prüfentscheid)
CREATE TABLE ai_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  model       text NOT NULL,
  result      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL
);

-- Seiten-Abschriften aus OCR kennzeichnen
ALTER TABLE evidence_lines DROP CONSTRAINT evidence_lines_pkey;
ALTER TABLE evidence_lines ADD PRIMARY KEY (document_id, source, page, line_no);

-- Optional: Ablage des Belegs in SharePoint (für Copilot als Dateikontext)
ALTER TABLE evidence_documents ADD COLUMN sharepoint_url text;
