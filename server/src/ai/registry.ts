import type { AiConfig } from './config.js';
import { createEntraTokenProvider, type TokenProvider } from './entra.js';
import { AzureFoundryProvider } from './providers/azureFoundry.js';
import { M365CopilotProvider } from './providers/m365Copilot.js';
import { OllamaProvider } from './providers/ollama.js';
import type { AiProvider, ProviderId } from './types.js';
import { ManagedIdentityCredential } from '@azure/identity';
import { AiError } from './types.js';

/** Token über die verwaltete Identität der Container App (keine Schlüssel nötig) */
export function managedIdentityTokens(clientId: string): TokenProvider {
  const cred = new ManagedIdentityCredential({ clientId });
  return {
    async onBehalfOf() {
      throw new AiError('On-Behalf-Of ist mit verwalteter Identität nicht möglich.', 'NOT_CONFIGURED', 500);
    },
    async appOnly(scopes) {
      try {
        const t = await cred.getToken(scopes);
        return t.token;
      } catch (e) {
        throw new AiError(`Verwaltete Identität: Token nicht erhalten (${(e as Error).message})`, 'AUTH_REQUIRED', 401);
      }
    },
  };
}

export type ProviderRegistry = Map<ProviderId, AiProvider>;

export interface ConfigProblem {
  provider: ProviderId;
  message: string;
}

/** Baut alle vollständig konfigurierten Anbieter; unvollständige werden gemeldet, nicht stillschweigend ignoriert. */
export function buildRegistry(cfg: AiConfig, tokenProvider?: TokenProvider): { registry: ProviderRegistry; problems: ConfigProblem[]; tokens?: TokenProvider } {
  const registry: ProviderRegistry = new Map();
  const problems: ConfigProblem[] = [];
  const hasEntra = !!(cfg.ENTRA_TENANT_ID && cfg.ENTRA_CLIENT_ID && cfg.ENTRA_CLIENT_SECRET);
  const tokens = tokenProvider ?? (hasEntra ? createEntraTokenProvider({ tenantId: cfg.ENTRA_TENANT_ID!, clientId: cfg.ENTRA_CLIENT_ID!, clientSecret: cfg.ENTRA_CLIENT_SECRET! }) : undefined);

  if (cfg.M365_COPILOT_ENABLED) {
    if (!tokens) problems.push({ provider: 'm365-copilot', message: 'ENTRA_TENANT_ID, ENTRA_CLIENT_ID und ENTRA_CLIENT_SECRET fehlen (nötig für On-Behalf-Of).' });
    else
      registry.set(
        'm365-copilot',
        new M365CopilotProvider(
          { variant: cfg.M365_COPILOT_VARIANT, baseUrl: cfg.M365_COPILOT_BASE_URL, timeZone: cfg.AI_TIMEZONE, timeoutMs: cfg.AI_TIMEOUT_MS, maxContextChars: cfg.M365_COPILOT_MAX_CONTEXT_CHARS },
          tokens,
        ),
      );
  }
  if (cfg.AZURE_FOUNDRY_ENDPOINT || cfg.AZURE_FOUNDRY_DEPLOYMENT) {
    if (!cfg.AZURE_FOUNDRY_ENDPOINT || !cfg.AZURE_FOUNDRY_DEPLOYMENT) problems.push({ provider: 'azure-foundry', message: 'AZURE_FOUNDRY_ENDPOINT und AZURE_FOUNDRY_DEPLOYMENT müssen beide gesetzt sein.' });
    else {
      // Reihenfolge: verwaltete Identität (empfohlen) > API-Key > Entra-App
      const azTokens = cfg.AZURE_MANAGED_IDENTITY_CLIENT_ID ? managedIdentityTokens(cfg.AZURE_MANAGED_IDENTITY_CLIENT_ID) : tokens;
      if (!cfg.AZURE_FOUNDRY_API_KEY && !azTokens) problems.push({ provider: 'azure-foundry', message: 'Verwaltete Identität, AZURE_FOUNDRY_API_KEY oder Entra-App-Registrierung erforderlich.' });
      else
        registry.set(
          'azure-foundry',
          new AzureFoundryProvider(
            { endpoint: cfg.AZURE_FOUNDRY_ENDPOINT, deployment: cfg.AZURE_FOUNDRY_DEPLOYMENT, apiKey: cfg.AZURE_MANAGED_IDENTITY_CLIENT_ID ? undefined : cfg.AZURE_FOUNDRY_API_KEY, timeoutMs: cfg.AI_TIMEOUT_MS },
            azTokens,
          ),
        );
    }
  }
  if (cfg.OLLAMA_BASE_URL || cfg.OLLAMA_MODEL) {
    if (!cfg.OLLAMA_BASE_URL || !cfg.OLLAMA_MODEL) problems.push({ provider: 'ollama', message: 'OLLAMA_BASE_URL und OLLAMA_MODEL müssen beide gesetzt sein.' });
    else registry.set('ollama', new OllamaProvider({ baseUrl: cfg.OLLAMA_BASE_URL, model: cfg.OLLAMA_MODEL, visionModel: cfg.OLLAMA_VISION_MODEL, timeoutMs: cfg.AI_TIMEOUT_MS }));
  }
  return { registry, problems, tokens };
}
