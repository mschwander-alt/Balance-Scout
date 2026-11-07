import { httpJson } from '../http.js';
import type { TokenProvider } from '../entra.js';
import { AiError, type AiCallContext, type AiProvider, type AiRequest, type AiResponse } from '../types.js';

export interface AzureFoundryConfig {
  /** z. B. https://<ressource>.openai.azure.com oder https://<ressource>.services.ai.azure.com */
  endpoint: string;
  /** Deployment-Name des Modells */
  deployment: string;
  /** Wenn gesetzt: API-Key; sonst Entra-ID (App-Registrierung, empfohlen) */
  apiKey?: string;
  timeoutMs: number;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Azure AI Foundry / Azure OpenAI (OpenAI-v1-kompatibler Endpunkt). Region z. B. Switzerland North. */
export class AzureFoundryProvider implements AiProvider {
  readonly id = 'azure-foundry' as const;
  readonly displayName = 'Azure AI Foundry';
  readonly boundary = 'tenant' as const;
  readonly capabilities = { systemPrompt: true, vision: true, nativeJson: true, requiresUserToken: false, sharePointFiles: false };
  readonly destination: string;
  private readonly url: string;

  constructor(private readonly cfg: AzureFoundryConfig, private readonly tokens?: TokenProvider) {
    this.url = `${cfg.endpoint.replace(/\/$/, '')}/openai/v1/chat/completions`;
    this.destination = new URL(cfg.endpoint).host;
    if (!cfg.apiKey && !tokens) throw new AiError('Azure AI Foundry: API-Key oder Entra-App-Registrierung erforderlich.', 'NOT_CONFIGURED', 500);
  }

  async complete(req: AiRequest, ctx: AiCallContext): Promise<AiResponse> {
    const userContent: unknown[] = [{ type: 'text', text: req.user }];
    for (const c of req.context ?? []) userContent.push({ type: 'text', text: c });
    for (const img of req.images ?? []) {
      userContent.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' } });
    }
    const body: Record<string, unknown> = {
      model: this.cfg.deployment,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      seed: 42,
      max_tokens: req.maxOutputTokens ?? 4000,
    };
    if (req.jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: req.task, schema: req.jsonSchema, strict: false } };
    }
    const r = await httpJson<ChatCompletion>(this.url, { headers: await this.authHeaders(), body, timeoutMs: this.cfg.timeoutMs, signal: ctx.signal });
    const msg = r.choices?.[0]?.message;
    if (msg?.refusal) return { text: '', model: r.model ?? this.cfg.deployment, refused: true };
    if (!msg?.content) throw new AiError('Azure AI Foundry hat keine Antwort geliefert.', 'UPSTREAM');
    return {
      text: msg.content,
      model: r.model ?? this.cfg.deployment,
      usage: { inputTokens: r.usage?.prompt_tokens, outputTokens: r.usage?.completion_tokens },
    };
  }

  async healthCheck(ctx: AiCallContext) {
    try {
      await this.complete({ task: 'match_review', system: 'Antworte nur mit OK.', user: 'Verbindungstest', maxOutputTokens: 5 }, ctx);
      return { ok: true, detail: `Verbunden (${this.destination}, Deployment ${this.cfg.deployment}).` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.cfg.apiKey) return { 'api-key': this.cfg.apiKey };
    const token = await this.tokens!.appOnly(['https://cognitiveservices.azure.com/.default']);
    return { authorization: `Bearer ${token}` };
  }
}
