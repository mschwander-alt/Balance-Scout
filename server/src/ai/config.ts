import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0', '']).optional().transform(v => v === 'true' || v === '1');

export const AiEnv = z.object({
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AI_TIMEZONE: z.string().default('Europe/Zurich'),
  // Entra-App-Registrierung des Servers (für Copilot On-Behalf-Of und optional Azure)
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  // Microsoft 365 Copilot
  M365_COPILOT_ENABLED: bool,
  M365_COPILOT_VARIANT: z.enum(['workiq', 'graph-beta']).default('workiq'),
  M365_COPILOT_BASE_URL: z.string().url().optional(),
  M365_COPILOT_MAX_CONTEXT_CHARS: z.coerce.number().int().positive().default(60_000),
  // Azure AI Foundry
  AZURE_FOUNDRY_ENDPOINT: z.string().url().optional(),
  AZURE_FOUNDRY_DEPLOYMENT: z.string().optional(),
  AZURE_FOUNDRY_API_KEY: z.string().optional(),
  /** Client-ID der verwalteten Identität (Azure Container Apps) – empfohlen statt API-Key */
  AZURE_MANAGED_IDENTITY_CLIENT_ID: z.string().optional(),
  // Ollama
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_MODEL: z.string().optional(),
  OLLAMA_VISION_MODEL: z.string().optional(),
});
export type AiConfig = z.infer<typeof AiEnv>;

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  return AiEnv.parse(env);
}
