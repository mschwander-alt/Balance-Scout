/**
 * Einheitliche KI-Schnittstelle. Jeder Anbieter ist ein austauschbares Modul.
 * Die KI liefert Vorschläge und Begründungen – Prüfentscheide trifft die
 * deterministische Engine bzw. der Mensch.
 */

export type ProviderId = 'm365-copilot' | 'azure-foundry' | 'ollama';

/**
 * Datengrenze – entscheidet, ob ein Mandat diesen Anbieter verwenden darf.
 *  local:  Daten verlassen das eigene Netz nicht (Ollama)
 *  tenant: Daten bleiben im eigenen Microsoft-Tenant bzw. eigenen Azure-Abo
 *  external: Drittanbieter (für spätere Erweiterungen)
 */
export type DataBoundary = 'local' | 'tenant' | 'external';

export interface ProviderCapabilities {
  /** Akzeptiert System-Anweisung getrennt vom Benutzertext */
  systemPrompt: boolean;
  /** Kann Bilder (z. B. gescannte Seiten) lesen */
  vision: boolean;
  /** Erzwingt JSON-Ausgabe serverseitig (sonst: per Anweisung + Validierung) */
  nativeJson: boolean;
  /** Benötigt einen angemeldeten Benutzer (delegiertes Token) */
  requiresUserToken: boolean;
  /** Kann Dateien aus SharePoint/OneDrive per URL als Kontext lesen */
  sharePointFiles: boolean;
}

export interface AiImage {
  mimeType: 'image/png' | 'image/jpeg';
  base64: string;
  label?: string;
}

export interface AiRequest {
  /** Fachliche Aufgabe, nur für Protokoll/Routing */
  task: AiTask;
  system: string;
  user: string;
  /** Zusätzlicher Kontext (z. B. extrahierter Belegtext) */
  context?: string[];
  images?: AiImage[];
  /** SharePoint/OneDrive-URLs (nur m365-copilot) */
  sharePointFiles?: string[];
  /** JSON-Schema der erwarteten Antwort (für Anbieter mit nativeJson) */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface AiCallContext {
  actor: string;
  /** Access-Token des angemeldeten Benutzers für unsere API (für On-Behalf-Of) */
  userAssertion?: string;
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Quellenangaben (Copilot) */
  citations?: { title: string; url?: string }[];
  /** Anbieter hat die Antwort verweigert (z. B. Copilot disengagedForRai) */
  refused?: boolean;
}

export interface AiProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly boundary: DataBoundary;
  readonly capabilities: ProviderCapabilities;
  /** Ziel-Host für Transparenzanzeige ("Daten gehen an …") */
  readonly destination: string;
  complete(req: AiRequest, ctx: AiCallContext): Promise<AiResponse>;
  /** Verbindungstest ohne Mandantendaten */
  healthCheck(ctx: AiCallContext): Promise<{ ok: boolean; detail: string }>;
}

export type AiTask = 'evidence_extraction' | 'match_review';

export class AiError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_CONFIGURED'
      | 'POLICY_BLOCKED'
      | 'AUTH_REQUIRED'
      | 'UNSUPPORTED'
      | 'UPSTREAM'
      | 'INVALID_OUTPUT'
      | 'REFUSED'
      | 'TIMEOUT',
    public readonly httpStatus = 502,
  ) {
    super(message);
  }
}
