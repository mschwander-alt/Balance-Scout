import { httpJson } from '../http.js';
import { AiError, type AiCallContext, type AiProvider, type AiRequest, type AiResponse } from '../types.js';

export interface OllamaConfig {
  /** z. B. http://ki-server.intern:11434 */
  baseUrl: string;
  model: string;
  /** Optionales separates Modell für Bilder/Scans (z. B. ein Vision-Modell) */
  visionModel?: string;
  timeoutMs: number;
}

interface OllamaChat {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Lokales Modell über Ollama – Daten verlassen das eigene Netz nicht. */
export class OllamaProvider implements AiProvider {
  readonly id = 'ollama' as const;
  readonly displayName = 'Ollama (lokal)';
  readonly boundary = 'local' as const;
  readonly capabilities: AiProvider['capabilities'];
  readonly destination: string;
  private readonly base: string;

  constructor(private readonly cfg: OllamaConfig) {
    this.base = cfg.baseUrl.replace(/\/$/, '');
    this.destination = new URL(this.base).host;
    this.capabilities = { systemPrompt: true, vision: !!cfg.visionModel, nativeJson: true, requiresUserToken: false, sharePointFiles: false };
  }

  async complete(req: AiRequest, ctx: AiCallContext): Promise<AiResponse> {
    const hasImages = !!req.images?.length;
    if (hasImages && !this.cfg.visionModel) {
      throw new AiError('Für Scans ist ein Vision-Modell nötig (OLLAMA_VISION_MODEL).', 'UNSUPPORTED', 422);
    }
    const model = hasImages ? this.cfg.visionModel! : this.cfg.model;
    const user = [req.user, ...(req.context ?? [])].join('\n\n');
    const r = await httpJson<OllamaChat>(`${this.base}/api/chat`, {
      body: {
        model,
        stream: false,
        format: req.jsonSchema ?? undefined,
        options: { temperature: 0, seed: 42, num_ctx: 32768 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: user, ...(hasImages ? { images: req.images!.map(i => i.base64) } : {}) },
        ],
      },
      timeoutMs: this.cfg.timeoutMs,
      signal: ctx.signal,
    });
    if (!r.message?.content) throw new AiError('Ollama hat keine Antwort geliefert.', 'UPSTREAM');
    return { text: r.message.content, model: r.model ?? model, usage: { inputTokens: r.prompt_eval_count, outputTokens: r.eval_count } };
  }

  async healthCheck() {
    try {
      const r = await httpJson<{ models?: { name: string }[] }>(`${this.base}/api/tags`, { method: 'GET', timeoutMs: 5000, retries: 0 });
      const names = (r.models ?? []).map(m => m.name);
      const missing = [this.cfg.model, this.cfg.visionModel].filter((m): m is string => !!m && !names.some(n => n === m || n.startsWith(`${m}:`)));
      return missing.length
        ? { ok: false, detail: `Ollama erreichbar, Modell fehlt: ${missing.join(', ')} (ollama pull …)` }
        : { ok: true, detail: `Verbunden (${this.destination}), Modelle: ${names.join(', ')}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
