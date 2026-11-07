import Fastify, { type FastifyInstance } from 'fastify';

export interface Recorded {
  path: string;
  headers: Record<string, unknown>;
  body: any;
}

export interface FakeAi {
  url: string;
  calls: Recorded[];
  /** Antwort-Text, der als Modellausgabe zurückkommt */
  reply: (body: any, path: string) => string;
  copilotState: 'active' | 'disengagedForRai';
  ollamaModels: string[];
  close(): Promise<void>;
}

/**
 * Nachbildung der drei Schnittstellen gemäss Herstellerdokumentation:
 *  - M365 Copilot (Graph beta /copilot/conversations und Work IQ /rest/conversations)
 *  - Azure AI Foundry (OpenAI v1 chat/completions)
 *  - Ollama (/api/chat, /api/tags)
 */
export async function startFakeAi(): Promise<FakeAi> {
  const app: FastifyInstance = Fastify({ bodyLimit: 50 * 1024 * 1024 });
  const state: Omit<FakeAi, 'url' | 'close'> = {
    calls: [],
    reply: () => 'OK',
    copilotState: 'active',
    ollamaModels: ['llama3.3:70b', 'qwen2.5vl:32b'],
  };
  const rec = (path: string, req: { headers: Record<string, unknown>; body: unknown }) => state.calls.push({ path, headers: req.headers, body: req.body });

  for (const prefix of ['/beta/copilot', '/rest']) {
    app.post(`${prefix}/conversations`, async req => {
      rec(`${prefix}/conversations`, req);
      return { id: 'conv-123', createdDateTime: new Date().toISOString(), displayName: '', state: 'active', turnCount: 0 };
    });
    app.post(`${prefix}/conversations/:id/chat`, async req => {
      rec(`${prefix}/conversations/chat`, req);
      const body = req.body as { message: { text: string } };
      if (state.copilotState === 'disengagedForRai') return { id: 'conv-123', state: 'disengagedForRai', turnCount: 1, messages: [{ id: '1', text: body.message.text }] };
      return {
        id: 'conv-123',
        state: 'active',
        turnCount: 1,
        messages: [
          { id: 'm1', text: body.message.text }, // Echo der Benutzernachricht (dokumentiertes Verhalten)
          { id: 'm2', text: state.reply(body, prefix), attributions: [{ attributionType: 'citation', providerDisplayName: 'UBS_Kontoauszug.pdf', seeMoreWebUrl: 'https://contoso.sharepoint.com/x' }] },
        ],
      };
    });
  }

  app.post('/openai/v1/chat/completions', async req => {
    rec('/openai/v1/chat/completions', req);
    return { model: 'gpt-4.1-2025-04-14', choices: [{ message: { content: state.reply(req.body, 'azure') }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 40 } };
  });

  app.post('/api/chat', async req => {
    rec('/api/chat', req);
    return { model: (req.body as { model: string }).model, message: { role: 'assistant', content: state.reply(req.body, 'ollama') }, prompt_eval_count: 100, eval_count: 30 };
  });
  app.get('/api/tags', async () => ({ models: state.ollamaModels.map(name => ({ name })) }));

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  const fake = state as FakeAi;
  fake.url = `http://127.0.0.1:${addr.port}`;
  fake.close = () => app.close();
  return fake;
}

export function fakeTokens() {
  const calls: { kind: string; assertion?: string; scopes: string[] }[] = [];
  return {
    calls,
    async onBehalfOf(assertion: string, scopes: string[]) {
      calls.push({ kind: 'obo', assertion, scopes });
      if (assertion === 'abgelaufen') {
        const { AiError } = await import('../src/ai/types.js');
        throw new AiError('Anmeldung bei Microsoft fehlgeschlagen (On-Behalf-Of): AADSTS500133', 'AUTH_REQUIRED', 401);
      }
      return `graph-token-for-${assertion}`;
    },
    async appOnly(scopes: string[]) {
      calls.push({ kind: 'app', scopes });
      return 'app-token';
    },
  };
}
