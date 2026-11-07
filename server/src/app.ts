import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import { FileStorage } from './lib/storage.js';
import { engagementRoutes } from './routes/engagements.js';
import { trialBalanceRoutes } from './routes/trialBalances.js';
import { evidenceRoutes } from './routes/evidence.js';
import { matchingRoutes } from './routes/matching.js';
import { MappingError, UnsupportedFormatError } from './domain/trialBalance/parser.js';
import { aiRoutes } from './routes/ai.js';
import { AiService } from './ai/service.js';
import { AiError } from './ai/types.js';
import type { ConfigProblem, ProviderRegistry } from './ai/registry.js';
import { AuthError, EntraVerifier } from './auth/entra.js';
import { LocalEventBus, type EventPublisher } from './lib/events.js';
import type { SharePointUploader } from './lib/sharepoint.js';
import { collaborationRoutes } from './routes/collaboration.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: string;
    displayName: string;
    isAdmin: boolean;
    /** Microsoft-Token des Benutzers für On-Behalf-Of (M365 Copilot) */
    userAssertion?: string;
  }
  interface FastifyInstance {
    db: Db;
    storage: FileStorage;
    config: Config;
    ai: AiService;
    aiProblems: ConfigProblem[];
    events: EventPublisher;
    sharePoint: SharePointUploader | null;
  }
}

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface AiSetup {
  registry: ProviderRegistry;
  problems: ConfigProblem[];
}

export interface AppDeps {
  ai?: AiSetup;
  events?: EventPublisher;
  verifier?: EntraVerifier;
  sharePoint?: SharePointUploader | null;
}

export async function buildApp(config: Config, db: Db, deps: AppDeps = {}): Promise<FastifyInstance> {
  const aiSetup = deps.ai ?? { registry: new Map(), problems: [] };
  const verifier =
    config.authMode === 'entra'
      ? deps.verifier ?? new EntraVerifier({ tenantId: config.ENTRA_TENANT_ID!, audiences: config.audiences, adminRole: config.ENTRA_ADMIN_ROLE, userRole: config.ENTRA_USER_ROLE || undefined })
      : null;
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
    bodyLimit: 5 * 1024 * 1024,
  });
  app.decorate('db', db);
  app.decorate('storage', new FileStorage(config.STORAGE_DIR));
  app.decorate('config', config);
  app.decorate('ai', new AiService(db, aiSetup.registry));
  app.decorate('aiProblems', aiSetup.problems);
  app.decorate('events', deps.events ?? new LocalEventBus());
  app.decorate('sharePoint', deps.sharePoint ?? null);
  app.decorateRequest('actor', '');
  app.decorateRequest('displayName', '');
  app.decorateRequest('isAdmin', false);
  app.decorateRequest('userAssertion', undefined);

  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 20 } });

  // Authentifizierung
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.url === '/api/health') return;
    const h = req.headers.authorization ?? '';
    const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (verifier) {
      // Microsoft-Anmeldung: Token prüfen; es dient zugleich als Assertion für On-Behalf-Of
      if (!bearer) throw new HttpError(401, 'Bitte mit dem Microsoft-365-Konto anmelden.');
      try {
        const p = await verifier.verify(bearer);
        req.actor = p.actor;
        req.displayName = p.name;
        req.isAdmin = p.isAdmin;
        req.userAssertion = p.assertion;
      } catch (e) {
        if (e instanceof AuthError) throw new HttpError(401, e.message);
        throw e;
      }
      return;
    }
    const assertion = req.headers['x-ms-assertion'];
    if (typeof assertion === 'string' && assertion) req.userAssertion = assertion;
    if (config.authMode === 'tokens') {
      const user = config.tokens.get(bearer);
      if (!user) throw new HttpError(401, 'Nicht angemeldet oder ungültiges Token.');
      req.actor = user;
      req.isAdmin = config.admins.has(user);
    } else {
      req.actor = (req.headers['x-user'] as string | undefined) ?? 'dev';
      req.isAdmin = true;
    }
    req.displayName = req.actor;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Ungültige Eingabe', details: err.issues });
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof AiError) return reply.status(err.httpStatus).send({ error: err.message, code: err.code });
    if (err instanceof MappingError || err instanceof UnsupportedFormatError) {
      return reply.status(422).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Interner Fehler' });
  });

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(engagementRoutes, { prefix: '/api' });
  await app.register(trialBalanceRoutes, { prefix: '/api' });
  await app.register(evidenceRoutes, { prefix: '/api' });
  await app.register(matchingRoutes, { prefix: '/api' });
  await app.register(aiRoutes, { prefix: '/api' });
  await app.register(collaborationRoutes, { prefix: '/api' });
  return app;
}
