import { httpJson } from '../http.js';
import type { TokenProvider } from '../entra.js';
import { AiError, type AiCallContext, type AiProvider, type AiRequest, type AiResponse } from '../types.js';

export interface M365CopilotConfig {
  /**
   * workiq:     Work IQ Chat API (GA seit 16.06.2026, Abrechnung über Copilot Credits, 1 Berechtigung WorkIQAgent.Ask)
   * graph-beta: Microsoft Graph /beta/copilot (Vorschau, über Copilot-Lizenz, 7 delegierte Berechtigungen)
   */
  variant: 'workiq' | 'graph-beta';
  baseUrl?: string;
  timeZone: string;
  timeoutMs: number;
  /** Obergrenze für mitgesendeten Kontexttext (Zeichen) */
  maxContextChars: number;
}

const DEFAULTS = {
  workiq: { baseUrl: 'https://workiq.svc.cloud.microsoft/rest', scopes: ['api://workiq.svc.cloud.microsoft/.default'] },
  'graph-beta': { baseUrl: 'https://graph.microsoft.com/beta/copilot', scopes: ['https://graph.microsoft.com/.default'] },
} as const;

interface CopilotConversation {
  id: string;
  state?: 'active' | 'disengagedForRai' | string;
  messages?: { id?: string; text?: string; attributions?: { attributionType?: string; providerDisplayName?: string; seeMoreWebUrl?: string }[] }[];
}

/**
 * Microsoft 365 Copilot als KI-Anbieter.
 * Besonderheiten (laut Microsoft-Dokumentation):
 *  - nur delegierter Zugriff → Aufruf im Namen des angemeldeten Benutzers (On-Behalf-Of)
 *  - kein System-Prompt, keine native JSON-Ausgabe → Anweisung im Nachrichtentext, Ausgabe wird streng validiert
 *  - Websuche ist standardmässig aktiv → wird bei JEDER Nachricht abgeschaltet
 *  - Dateien nur über SharePoint/OneDrive-URL, Bilder können nicht direkt übergeben werden
 *  - Antwort enthält die Benutzer-Nachricht als Echo → Copilot-Antwort gezielt auswählen
 */
export class M365CopilotProvider implements AiProvider {
  readonly id = 'm365-copilot' as const;
  readonly displayName = 'Microsoft 365 Copilot';
  readonly boundary = 'tenant' as const;
  readonly capabilities = { systemPrompt: false, vision: false, nativeJson: false, requiresUserToken: true, sharePointFiles: true };
  readonly destination: string;
  private readonly base: string;
  private readonly scopes: readonly string[];

  constructor(private readonly cfg: M365CopilotConfig, private readonly tokens: TokenProvider) {
    this.base = (cfg.baseUrl ?? DEFAULTS[cfg.variant].baseUrl).replace(/\/$/, '');
    this.scopes = DEFAULTS[cfg.variant].scopes;
    this.destination = new URL(this.base).host;
  }

  async complete(req: AiRequest, ctx: AiCallContext): Promise<AiResponse> {
    if (req.images?.length) {
      throw new AiError('Microsoft 365 Copilot kann keine Bilder direkt lesen. Scans bitte in SharePoint ablegen oder Azure AI Foundry / Ollama für die Texterkennung verwenden.', 'UNSUPPORTED', 422);
    }
    const token = await this.userToken(ctx);
    const headers = { authorization: `Bearer ${token}` };

    const conv = await httpJson<CopilotConversation>(`${this.base}/conversations`, { headers, body: {}, timeoutMs: this.cfg.timeoutMs, signal: ctx.signal });
    if (!conv.id) throw new AiError('Copilot hat keine Konversation angelegt.', 'UPSTREAM');

    const messageText = [`ANWEISUNG:\n${req.system}`, `AUFGABE:\n${req.user}`].join('\n\n');
    const context = this.limitContext(req.context ?? []);
    const body = {
      message: { text: messageText },
      locationHint: { timeZone: this.cfg.timeZone },
      ...(context.length ? { additionalContext: context.map(text => ({ text })) } : {}),
      contextualResources: {
        webContext: { isWebEnabled: false },
        ...(req.sharePointFiles?.length ? { files: req.sharePointFiles.map(uri => ({ uri })) } : {}),
      },
    };
    const res = await httpJson<CopilotConversation>(`${this.base}/conversations/${encodeURIComponent(conv.id)}/chat`, {
      headers,
      body,
      timeoutMs: this.cfg.timeoutMs,
      signal: ctx.signal,
    });

    if (res.state === 'disengagedForRai') {
      return { text: '', model: `m365-copilot/${this.cfg.variant}`, refused: true };
    }
    const msgs = res.messages ?? [];
    // Das erste Element ist das Echo der Benutzernachricht – Antwort ist die letzte Nachricht mit anderem Text
    const answer = [...msgs].reverse().find(m => m.text && m.text.trim() !== messageText.trim());
    if (!answer?.text) throw new AiError('Copilot hat keine Antwort geliefert.', 'UPSTREAM');
    return {
      text: answer.text,
      model: `m365-copilot/${this.cfg.variant}`,
      citations: (answer.attributions ?? [])
        .filter(a => a.attributionType === 'citation')
        .map(a => ({ title: a.providerDisplayName ?? '', url: a.seeMoreWebUrl })),
    };
  }

  async healthCheck(ctx: AiCallContext) {
    if (!ctx.userAssertion) return { ok: false, detail: 'Anmeldung mit Microsoft-365-Konto erforderlich (Copilot arbeitet nur im Namen eines Benutzers).' };
    try {
      const r = await this.complete({ task: 'match_review', system: 'Antworte ausschliesslich mit dem Wort OK.', user: 'Verbindungstest' }, ctx);
      return { ok: !r.refused, detail: r.refused ? 'Copilot hat die Anfrage abgelehnt.' : `Verbunden (${this.cfg.variant}).` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  private async userToken(ctx: AiCallContext): Promise<string> {
    if (!ctx.userAssertion) {
      throw new AiError('Für Microsoft 365 Copilot ist eine Anmeldung mit dem Microsoft-365-Konto nötig.', 'AUTH_REQUIRED', 401);
    }
    return this.tokens.onBehalfOf(ctx.userAssertion, [...this.scopes]);
  }

  private limitContext(parts: string[]): string[] {
    const out: string[] = [];
    let left = this.cfg.maxContextChars;
    for (const p of parts) {
      if (left <= 0) break;
      out.push(p.length > left ? `${p.slice(0, left)}\n[… gekürzt]` : p);
      left -= p.length;
    }
    return out;
  }
}
