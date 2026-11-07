import { createHash } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { ProviderRegistry } from './registry.js';
import { AiError, type AiCallContext, type AiProvider, type AiRequest, type AiResponse, type AiTask, type DataBoundary, type ProviderId } from './types.js';

/**
 * KI-Richtlinie pro Mandat (engagements.settings.aiPolicy):
 *  disabled   – keine KI (Standard, bis bewusst freigegeben)
 *  local_only – nur Anbieter im eigenen Netz (Ollama)
 *  tenant     – zusätzlich eigener Microsoft-Tenant / eigenes Azure-Abo (M365 Copilot, Azure AI Foundry)
 */
export type AiPolicy = 'disabled' | 'local_only' | 'tenant';
export const AI_POLICIES: AiPolicy[] = ['disabled', 'local_only', 'tenant'];

const ALLOWED: Record<AiPolicy, DataBoundary[]> = {
  disabled: [],
  local_only: ['local'],
  tenant: ['local', 'tenant'],
};

export function policyAllows(policy: AiPolicy, boundary: DataBoundary): boolean {
  return ALLOWED[policy].includes(boundary);
}

export class AiService {
  constructor(private readonly db: Db, readonly registry: ProviderRegistry) {}

  async routing(): Promise<Record<AiTask, ProviderId | null>> {
    const { rows } = await this.db.query<{ task: AiTask; provider: ProviderId }>('SELECT task, provider FROM ai_settings');
    const first = ([...this.registry.keys()][0] ?? null) as ProviderId | null;
    const out: Record<AiTask, ProviderId | null> = { evidence_extraction: first, match_review: first };
    for (const r of rows) if (this.registry.has(r.provider)) out[r.task] = r.provider;
    return out;
  }

  async setRouting(task: AiTask, provider: ProviderId, actor: string): Promise<void> {
    if (!this.registry.has(provider)) throw new AiError(`Anbieter ${provider} ist auf dem Server nicht konfiguriert.`, 'NOT_CONFIGURED', 400);
    await this.db.query(
      `INSERT INTO ai_settings(task, provider, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (task) DO UPDATE SET provider=EXCLUDED.provider, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [task, provider, actor],
    );
  }

  /** Welcher Anbieter würde für dieses Mandat und diese Aufgabe verwendet – und darf er? */
  async resolve(task: AiTask, engagementId: string, override?: ProviderId): Promise<{ provider: AiProvider; policy: AiPolicy }> {
    const policy = await this.policyOf(engagementId);
    if (policy === 'disabled') throw new AiError('KI ist für dieses Mandat nicht freigegeben (Einstellung "aiPolicy").', 'POLICY_BLOCKED', 403);
    const id = override ?? (await this.routing())[task];
    const provider = id ? this.registry.get(id) : undefined;
    if (!provider) throw new AiError('Kein KI-Anbieter konfiguriert.', 'NOT_CONFIGURED', 503);
    if (!policyAllows(policy, provider.boundary)) {
      throw new AiError(`${provider.displayName} (${provider.boundary === 'tenant' ? 'Microsoft-Tenant/Azure' : 'extern'}) ist für dieses Mandat nicht erlaubt (Richtlinie "${policy}").`, 'POLICY_BLOCKED', 403);
    }
    return { provider, policy };
  }

  async policyOf(engagementId: string): Promise<AiPolicy> {
    const { rows } = await this.db.query<{ p: string | null }>(`SELECT settings->>'aiPolicy' AS p FROM engagements WHERE id=$1`, [engagementId]);
    if (!rows[0]) throw new AiError('Mandat nicht gefunden.', 'NOT_CONFIGURED', 404);
    const p = rows[0].p as AiPolicy | null;
    return p && AI_POLICIES.includes(p) ? p : 'disabled';
  }

  /** Führt einen KI-Aufruf aus und protokolliert ihn (ohne Inhalte). */
  async call(
    provider: AiProvider,
    req: AiRequest,
    ctx: AiCallContext,
    meta: { engagementId: string; documentId?: string },
  ): Promise<AiResponse> {
    if (req.images?.length && !provider.capabilities.vision) {
      throw new AiError(`${provider.displayName} kann keine Bilder/Scans lesen. Für Scans einen Anbieter mit Bilderkennung wählen.`, 'UNSUPPORTED', 422);
    }
    const payload = JSON.stringify({ s: req.system, u: req.user, c: req.context, i: req.images?.map(i => i.base64), f: req.sharePointFiles });
    const sha = createHash('sha256').update(payload).digest('hex');
    const chars = req.system.length + req.user.length + (req.context ?? []).reduce((a, c) => a + c.length, 0);
    const started = Date.now();
    let res: AiResponse | undefined;
    let err: unknown;
    try {
      res = await provider.complete(req, ctx);
      return res;
    } catch (e) {
      err = e;
      throw e;
    } finally {
      await this.db.query(
        `INSERT INTO ai_calls(actor, engagement_id, task, provider, model, destination, boundary, document_id, chars_sent, images_sent, prompt_sha256, duration_ms, status, error, input_tokens, output_tokens)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          ctx.actor, meta.engagementId, req.task, provider.id, res?.model ?? null, provider.destination, provider.boundary, meta.documentId ?? null,
          chars, req.images?.length ?? 0, sha, Date.now() - started,
          err ? 'error' : res?.refused ? 'refused' : 'ok',
          err ? String((err as Error).message).slice(0, 1000) : null,
          res?.usage?.inputTokens ?? null, res?.usage?.outputTokens ?? null,
        ],
      );
    }
  }
}
