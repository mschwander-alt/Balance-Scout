import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startFakeAi, fakeTokens, type FakeAi } from './fakeAi.js';
import { M365CopilotProvider } from '../src/ai/providers/m365Copilot.js';
import { AzureFoundryProvider } from '../src/ai/providers/azureFoundry.js';
import { OllamaProvider } from '../src/ai/providers/ollama.js';
import { buildRegistry } from '../src/ai/registry.js';
import { loadAiConfig } from '../src/ai/config.js';
import { policyAllows } from '../src/ai/service.js';
import { extractJson } from '../src/ai/json.js';
import { buildExtractionRequest, parseExtraction, verifyExtraction } from '../src/ai/tasks/evidenceExtraction.js';
import { parseReview } from '../src/ai/tasks/matchReview.js';

let fake: FakeAi;
beforeAll(async () => { fake = await startFakeAi(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => { fake.calls.length = 0; fake.reply = () => 'OK'; fake.copilotState = 'active'; });

const ctx = { actor: 'anna', userAssertion: 'user-jwt' };
const req = { task: 'match_review' as const, system: 'SYSTEMREGEL', user: 'FRAGE', context: ['BELEGTEXT'] };

describe('Microsoft 365 Copilot', () => {
  const mk = (variant: 'workiq' | 'graph-beta', tokens = fakeTokens()) =>
    ({ tokens, p: new M365CopilotProvider({ variant, baseUrl: `${fake.url}${variant === 'workiq' ? '/rest' : '/beta/copilot'}`, timeZone: 'Europe/Zurich', timeoutMs: 5000, maxContextChars: 20 }, tokens) });

  it('ruft im Namen des Benutzers auf (On-Behalf-Of) mit richtigem Scope', async () => {
    const { p, tokens } = mk('workiq');
    await p.complete(req, ctx);
    expect(tokens.calls).toEqual([{ kind: 'obo', assertion: 'user-jwt', scopes: ['api://workiq.svc.cloud.microsoft/.default'] }]);
    expect(fake.calls[1]!.headers.authorization).toBe('Bearer graph-token-for-user-jwt');
    const g = mk('graph-beta');
    await g.p.complete(req, ctx);
    expect(g.tokens.calls[0]!.scopes).toEqual(['https://graph.microsoft.com/.default']);
  });

  it('legt Konversation an, schaltet Websuche ab, sendet Zeitzone und Kontext', async () => {
    const { p } = mk('graph-beta');
    await p.complete(req, ctx);
    expect(fake.calls.map(c => c.path)).toEqual(['/beta/copilot/conversations', '/beta/copilot/conversations/chat']);
    const body = fake.calls[1]!.body;
    expect(body.message.text).toContain('ANWEISUNG:\nSYSTEMREGEL'); // kein System-Prompt -> im Text
    expect(body.message.text).toContain('AUFGABE:\nFRAGE');
    expect(body.contextualResources.webContext.isWebEnabled).toBe(false);
    expect(body.locationHint.timeZone).toBe('Europe/Zurich');
    expect(body.additionalContext).toEqual([{ text: 'BELEGTEXT' }]);
  });

  it('kürzt Kontext auf Obergrenze', async () => {
    const { p } = mk('workiq');
    await p.complete({ ...req, context: ['x'.repeat(50)] }, ctx);
    expect(fake.calls[1]!.body.additionalContext[0].text).toMatch(/^x{20}\n\[… gekürzt\]$/);
  });

  it('nimmt die Copilot-Antwort, nicht das Echo; liefert Quellen', async () => {
    fake.reply = () => 'ANTWORT';
    const { p } = mk('workiq');
    const r = await p.complete(req, ctx);
    expect(r.text).toBe('ANTWORT');
    expect(r.citations).toEqual([{ title: 'UBS_Kontoauszug.pdf', url: 'https://contoso.sharepoint.com/x' }]);
  });

  it('erkennt Ablehnung (disengagedForRai)', async () => {
    fake.copilotState = 'disengagedForRai';
    const r = await mk('workiq').p.complete(req, ctx);
    expect(r.refused).toBe(true);
  });

  it('verlangt Anmeldung und lehnt Bilder ab', async () => {
    const { p } = mk('workiq');
    await expect(p.complete(req, { actor: 'anna' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(p.complete({ ...req, images: [{ mimeType: 'image/png', base64: 'AA' }] }, ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(p.complete(req, { actor: 'anna', userAssertion: 'abgelaufen' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('übergibt SharePoint-Dateien als Kontext', async () => {
    await mk('workiq').p.complete({ ...req, sharePointFiles: ['https://contoso.sharepoint.com/sites/revision/beleg.pdf'] }, ctx);
    expect(fake.calls[1]!.body.contextualResources.files).toEqual([{ uri: 'https://contoso.sharepoint.com/sites/revision/beleg.pdf' }]);
  });

  it('Verbindungstest ohne Anmeldung gibt verständlichen Hinweis', async () => {
    expect(await mk('workiq').p.healthCheck({ actor: 'x' })).toMatchObject({ ok: false, detail: expect.stringMatching(/Anmeldung/) });
  });
});

describe('Azure AI Foundry', () => {
  it('System-Prompt, JSON-Schema, Bilder, API-Key', async () => {
    const p = new AzureFoundryProvider({ endpoint: fake.url, deployment: 'gpt-4.1', apiKey: 'k3y', timeoutMs: 5000 });
    const r = await p.complete({ ...req, jsonSchema: { type: 'object' }, images: [{ mimeType: 'image/png', base64: 'QUJD' }] }, ctx);
    const c = fake.calls[0]!;
    expect(c.headers['api-key']).toBe('k3y');
    expect(c.body.messages[0]).toEqual({ role: 'system', content: 'SYSTEMREGEL' });
    expect(c.body.messages[1].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD', detail: 'high' } });
    expect(c.body.response_format.type).toBe('json_schema');
    expect(c.body.temperature).toBe(0);
    expect(r).toMatchObject({ text: 'OK', usage: { inputTokens: 120, outputTokens: 40 } });
  });

  it('Entra-Anmeldung statt API-Key', async () => {
    const tokens = fakeTokens();
    await new AzureFoundryProvider({ endpoint: fake.url, deployment: 'gpt-4.1', timeoutMs: 5000 }, tokens).complete(req, ctx);
    expect(fake.calls[0]!.headers.authorization).toBe('Bearer app-token');
    expect(tokens.calls[0]!.scopes).toEqual(['https://cognitiveservices.azure.com/.default']);
  });
});

describe('Ollama', () => {
  it('nutzt Vision-Modell für Bilder und erzwingt Schema', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url, model: 'llama3.3:70b', visionModel: 'qwen2.5vl:32b', timeoutMs: 5000 });
    await p.complete({ ...req, jsonSchema: { type: 'object' }, images: [{ mimeType: 'image/png', base64: 'QUJD' }] }, ctx);
    const b = fake.calls[0]!.body;
    expect(b.model).toBe('qwen2.5vl:32b');
    expect(b.format).toEqual({ type: 'object' });
    expect(b.messages[1].images).toEqual(['QUJD']);
    expect(b.options.temperature).toBe(0);
  });
  it('ohne Vision-Modell: klare Fehlermeldung', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url, model: 'llama3.3:70b', timeoutMs: 5000 });
    await expect(p.complete({ ...req, images: [{ mimeType: 'image/png', base64: 'A' }] }, ctx)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
  it('Verbindungstest meldet fehlende Modelle', async () => {
    const p = new OllamaProvider({ baseUrl: fake.url, model: 'mistral-large', timeoutMs: 5000 });
    expect(await p.healthCheck()).toMatchObject({ ok: false, detail: expect.stringContaining('mistral-large') });
  });
  it('nicht erreichbar → verständlicher Fehler', async () => {
    const p = new OllamaProvider({ baseUrl: 'http://127.0.0.1:1', model: 'x', timeoutMs: 2000 });
    expect((await p.healthCheck()).ok).toBe(false);
  });
});

describe('Konfiguration und Richtlinie', () => {
  it('baut nur vollständig konfigurierte Anbieter und meldet Lücken', () => {
    const { registry, problems } = buildRegistry(loadAiConfig({ M365_COPILOT_ENABLED: 'true', AZURE_FOUNDRY_ENDPOINT: 'https://x.openai.azure.com', OLLAMA_BASE_URL: 'http://ollama:11434', OLLAMA_MODEL: 'llama3.3' }));
    expect([...registry.keys()]).toEqual(['ollama']);
    expect(problems.map(p => p.provider)).toEqual(['m365-copilot', 'azure-foundry']);
  });
  it('Datengrenzen je Richtlinie', () => {
    expect(policyAllows('disabled', 'local')).toBe(false);
    expect(policyAllows('local_only', 'local')).toBe(true);
    expect(policyAllows('local_only', 'tenant')).toBe(false);
    expect(policyAllows('tenant', 'tenant')).toBe(true);
    expect(policyAllows('tenant', 'external')).toBe(false);
  });
});

describe('Antwortverarbeitung und Halluzinationsschutz', () => {
  it('liest JSON aus Markdown (Copilot)', () => {
    expect(extractJson('Hier das Ergebnis:\n```json\n{"a":1}\n```\nGruss')).toEqual({ a: 1 });
    expect(() => extractJson('kein json')).toThrow(/kein JSON/);
  });

  const lines = [
    { page: 1, lineNo: 1, text: 'UBS Switzerland AG' },
    { page: 1, lineNo: 5, text: "Schlusssaldo zu Ihren Gunsten CHF 48’250.35" },
  ];
  const ex = (balances: unknown[]) => parseExtraction(JSON.stringify({ documentType: 'kontoauszug', issuer: 'UBS', balanceDate: '2025-12-31', accountReferences: [], balances, notes: null }));

  it('akzeptiert nur Beträge, die wörtlich im Beleg stehen', () => {
    const v = verifyExtraction(
      ex([
        { label: 'Schlusssaldo', amount: "48'250.35", currency: 'CHF', date: null, side: 'soll', page: 1, quote: "Schlusssaldo zu Ihren Gunsten CHF 48'250.35" },
        { label: 'erfunden', amount: "99'000.00", currency: 'CHF', date: null, side: 'soll', page: 1, quote: "Saldo 99'000.00" },
        { label: 'falsches Zitat', amount: "48'250.35", currency: 'CHF', date: null, side: 'soll', page: 1, quote: 'Total 12.00' },
        { label: 'kaputt', amount: 'viel', currency: null, date: null, side: 'unbekannt', page: null, quote: 'x' },
      ]),
      lines,
      false,
    );
    expect(v.balances.map(b => b.status)).toEqual(['verified', 'quote_not_found', 'amount_not_in_quote', 'unparseable']);
    expect(v.balances[0]).toMatchObject({ cents: 4825035, location: { page: 1, lineNo: 5 } });
    expect(v.verifiedCount).toBe(1);
    expect(v.rejectedCount).toBe(3);
  });

  it('Anfrage enthält Zeilennummern; bei Bildern Abschrift verlangt', () => {
    const r = buildExtractionRequest({ filename: 'a.pdf', lines });
    expect(r.context![0]).toContain('[S.1 Z.5] Schlusssaldo');
    const o = buildExtractionRequest({ filename: 'scan.pdf', lines: [], images: [{ mimeType: 'image/png', base64: 'A' }] });
    expect(o.user).toMatch(/transcription/);
    expect(o.context).toBeUndefined();
  });

  it('Review-Schema wird streng geprüft', () => {
    expect(parseReview('{"assessment":"stuetzt","reasoning":"ok","issues":[],"suggestedComment":null}').assessment).toBe('stuetzt');
    expect(() => parseReview('{"assessment":"vielleicht","reasoning":"x"}')).toThrow(/Format/);
  });
});
