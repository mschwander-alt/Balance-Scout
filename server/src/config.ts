import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8080),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),
  STORAGE_DIR: z.string().default('./data/files'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
  /** Kommagetrennt "token:benutzer", z. B. "abc123:m.schwander,def456:reviewer" */
  API_TOKENS: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  /** Kommagetrennte Benutzernamen mit Administratorrechten (nur AUTH_MODE=tokens) */
  ADMIN_USERS: z.string().default(''),
  /**
   * entra:  Microsoft-Anmeldung (Produktivbetrieb)
   * tokens: statische API-Tokens (Übergang/Automatisierung)
   * dev:    keine Anmeldung, Benutzer aus Header X-User (nur Entwicklung, in production verboten)
   */
  AUTH_MODE: z.enum(['entra', 'tokens', 'dev']).optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  /** Audience(s) der Server-API, z. B. "api://balance-scout,<client-id>" */
  ENTRA_API_AUDIENCE: z.string().default(''),
  ENTRA_ADMIN_ROLE: z.string().default('BalanceScout.Admin'),
  ENTRA_USER_ROLE: z.string().default('BalanceScout.User'),
  SHAREPOINT_DRIVE_ID: z.string().optional(),
  SHAREPOINT_ROOT_FOLDER: z.string().default('Balance Scout'),
  GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
});

export type AuthMode = 'entra' | 'tokens' | 'dev';
export type Config = z.infer<typeof Env> & { tokens: Map<string, string>; admins: Set<string>; authMode: AuthMode; audiences: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env);
  const tokens = new Map<string, string>();
  for (const pair of parsed.API_TOKENS.split(',').map(s => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(':');
    if (i < 1) throw new Error(`API_TOKENS: ungültiger Eintrag "${pair}"`);
    tokens.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const authMode: AuthMode = parsed.AUTH_MODE ?? (tokens.size ? 'tokens' : 'dev');
  if (parsed.NODE_ENV === 'production' && authMode === 'dev') {
    throw new Error('In production ist AUTH_MODE=dev nicht erlaubt (entra oder tokens verwenden).');
  }
  if (authMode === 'tokens' && tokens.size === 0) throw new Error('AUTH_MODE=tokens erfordert API_TOKENS.');
  const audiences = parsed.ENTRA_API_AUDIENCE.split(',').map(s => s.trim()).filter(Boolean);
  if (authMode === 'entra' && (!parsed.ENTRA_TENANT_ID || audiences.length === 0)) {
    throw new Error('AUTH_MODE=entra erfordert ENTRA_TENANT_ID und ENTRA_API_AUDIENCE.');
  }
  const admins = new Set(parsed.ADMIN_USERS.split(',').map(s => s.trim()).filter(Boolean));
  return { ...parsed, tokens, admins, authMode, audiences };
}
