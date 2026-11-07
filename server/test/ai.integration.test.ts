import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildRegistry } from '../src/ai/registry.js';
import { loadAiConfig } from '../src/ai/config.js';
import { startFakeAi, fakeTokens, type FakeAi } from './fakeAi.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const FIX = path.join(import.meta.dirname, 'fixtures');

function multipart(files: { filename: string; data: Buffer; type: string }[], fields: Record<string, string> = {}) {
  const boundary = '----bsb' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const TB_CSV = [
  'Konto;Bezeichnung;Saldo',
  "1000;Kasse;1'500.00",
  "1020;Bank UBS Kontokorrent;48'250.35",
  "2800;Aktienkapital;-49'750.35",
].join('\n');

describe.skipIf(!DB_URL)('KI-Integration (PostgreSQL + nachgebildete Anbieter)', () => {
  let app: FastifyInstance;
  let db: Db;
  let fake: FakeAi;
  let engagementId: string;
  let tbId: string;
  const docs: Record<string, string> = {};
  const H = { 'x-user': 'anna' };

  beforeAll(async () => {
    fake = await startFakeAi();
    db = createPool(DB_URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const aiCfg = loadAiConfig({
      M365_COPILOT_ENABLED: 'true', M365_COPILOT_VARIANT: 'workiq', M365_COPILOT_BASE_URL: `${fake.url}/rest`,
      AZURE_FOUNDRY_ENDPOINT: fake.url, AZURE_FOUNDRY_DEPLOYMENT: 'gpt-4.1', AZURE_FOUNDRY_API_KEY: 'k',
      OLLAMA_BASE_URL: fake.url, OLLAMA_MODEL: 'llama3.3:70b', OLLAMA_VISION_MODEL: 'qwen2.5vl:32b',
    });
    const storage = await mkdtemp(path.join(tmpdir(), 'bsb-ai-'));
    app = await buildApp(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL!, STORAGE_DIR: storage }),
      db,
      { ai: buildRegistry(aiCfg, fakeTokens()) },
    );

    engagementId = (await app.inject({ method: 'POST', url: '/api/engagements', headers: H, payload: { name: 'JA 2025', closingDate: '2025-12-31' } })).json().id;
    tbId = (await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/trial-balances`, headers: H, ...multipart([{ filename: 'sabi.csv', data: Buffer.from(TB_CSV), type: 'text/csv' }]) })).json().id;
    for (const f of ['UBS_Kontoauszug_1020.pdf', 'Scan.pdf']) {
      const r = await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/evidence`, headers: H, ...multipart([{ filename: f, data: await readFile(path.join(FIX, f)), type: 'application/pdf' }]) });
      docs[f] = r.json()[0].id;
    }
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
    await fake?.close();
  });

  it('zeigt Anbieter, Fähigkeiten und Ziel-Hosts', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/ai/providers', headers: H })).json();
    expect(r.providers.map((p: { id: string }) => p.id)).toEqual(['m365-copilot', 'azure-foundry', 'ollama']);
    expect(r.providers[0]).toMatchObject({ boundary: 'tenant', capabilities: { requiresUserToken: true, vision: false } });
    expect(r.routing).toEqual({ evidence_extraction: 'm365-copilot', match_review: 'm365-copilot' });
  });

  it('KI ist pro Mandat standardmässig gesperrt', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/evidence/${docs['UBS_Kontoauszug_1020.pdf']}/ai-extract`, headers: H, payload: { provider: 'azure-foundry' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('POLICY_BLOCKED');
    expect(fake.calls).toHaveLength(0); // nichts verlassen
  });

  it('Richtlinie local_only erlaubt nur Ollama', async () => {
    await app.inject({ method: 'PUT', url: `/api/engagements/${engagementId}/ai-policy`, headers: H, payload: { aiPolicy: 'local_only' } });
    const p1 = (await app.inject({ method: 'GET', url: `/api/engagements/${engagementId}/ai-preview?task=evidence_extraction&provider=azure-foundry`, headers: H })).json();
    expect(p1.allowed).toBe(false);
    const p2 = (await app.inject({ method: 'GET', url: `/api/engagements/${engagementId}/ai-preview?task=evidence_extraction&provider=ollama`, headers: H })).json();
    expect(p2).toMatchObject({ allowed: true, boundary: 'local', destination: expect.stringContaining('127.0.0.1') });
    await app.inject({ method: 'PUT', url: `/api/engagements/${engagementId}/ai-policy`, headers: H, payload: { aiPolicy: 'tenant' } });
  });

  it('Belegauswertung mit Azure: Halluzination wird verworfen, echter Saldo verifiziert', async () => {
    fake.reply = () => JSON.stringify({
      documentType: 'kontoauszug', issuer: 'UBS Switzerland AG', balanceDate: '2025-12-31',
      accountReferences: [{ type: 'iban', value: 'CH93 0076 2011 6238 5295 7' }],
      balances: [
        { label: 'Schlusssaldo', amount: "48'250.35", currency: 'CHF', date: '2025-12-31', side: 'soll', page: 1, quote: "Schlusssaldo zu Ihren Gunsten CHF 48'250.35" },
        { label: 'Zinsen', amount: "312.40", currency: 'CHF', date: null, side: 'soll', page: 1, quote: 'Zinsgutschrift 312.40' },
      ],
      notes: null,
    });
    const r = await app.inject({ method: 'POST', url: `/api/evidence/${docs['UBS_Kontoauszug_1020.pdf']}/ai-extract`, headers: H, payload: { provider: 'azure-foundry' } });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.ocr).toBe(false);
    expect(b.verification.balances.map((x: { status: string }) => x.status)).toEqual(['verified', 'quote_not_found']);
    // Belegtext (nicht das Bild) wurde gesendet
    const sent = fake.calls.at(-1)!.body;
    expect(JSON.stringify(sent.messages[1].content)).toContain('Schlusssaldo zu Ihren Gunsten');
  });

  it('Scan: OCR über Ollama-Vision; Abschrift wird gespeichert, Treffer bleibt PRUEFEN', async () => {
    fake.reply = () => JSON.stringify({
      documentType: 'inventar', issuer: null, balanceDate: '2025-12-31', accountReferences: [],
      balances: [{ label: 'Kassabestand', amount: "1'500.00", currency: 'CHF', date: '2025-12-31', side: 'soll', page: 1, quote: "Kassabestand per 31.12.2025 CHF 1'500.00" }],
      transcription: [{ page: 1, text: "Kassenprotokoll\nKassabestand per 31.12.2025 CHF 1'500.00\nVisum: AB" }],
      notes: 'Handschriftlich visiert',
    });
    const r = await app.inject({ method: 'POST', url: `/api/evidence/${docs['Scan.pdf']}/ai-extract`, headers: H, payload: { provider: 'ollama' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ ocr: true, verification: { balances: [{ status: 'ocr_unconfirmed', location: { page: 1, lineNo: 2 } }] } });
    const call = fake.calls.at(-1)!.body;
    expect(call.model).toBe('qwen2.5vl:32b');
    expect(call.messages[1].images[0].length).toBeGreaterThan(1000); // gerenderte PDF-Seite
    const lines = (await app.inject({ method: 'GET', url: `/api/evidence/${docs['Scan.pdf']}/lines`, headers: H })).json();
    expect(lines.filter((l: { source: string }) => l.source === 'ocr:ollama')).toHaveLength(3);
  });

  it('Copilot kann Scans ohne SharePoint nicht lesen – klare Meldung', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/evidence/${docs['Scan.pdf']}/ai-extract`, headers: { ...H, 'x-ms-assertion': 'jwt' }, payload: { provider: 'm365-copilot' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatch(/Bilder/);
  });

  let runId: string;
  it('Matching nutzt KI-Ergebnisse deterministisch', async () => {
    const r = (await app.inject({ method: 'POST', url: `/api/trial-balances/${tbId}/match-runs`, headers: H, payload: {} })).json();
    runId = r.id;
    const by = Object.fromEntries(r.results.map((x: { accountNumber: string }) => [x.accountNumber, x]));
    expect(by['1020'].status).toBe('BELEGT');
    expect(by['1020'].best.reasons).toContain('KI-Auswertung: als Saldo erkannt und am Belegtext verifiziert (+10)');
    expect(by['1000'].status).toBe('PRUEFEN');
    expect(by['1000'].best.flags).toContain('OCR_SOURCE');
    expect(by['1000'].best.source).toBe('ocr:ollama');
  });

  it('Stichtagsabweichung laut KI blockiert BELEGT', async () => {
    await db.query(`UPDATE ai_extractions SET verification = jsonb_set(verification, '{balanceDate}', '"2025-11-30"') WHERE document_id=$1 AND is_current`, [docs['UBS_Kontoauszug_1020.pdf']]);
    const r = (await app.inject({ method: 'POST', url: `/api/trial-balances/${tbId}/match-runs`, headers: H, payload: {} })).json();
    const acc = r.results.find((x: { accountNumber: string }) => x.accountNumber === '1020');
    expect(acc.status).toBe('PRUEFEN');
    expect(acc.reasons).toContain('Stichtag im Beleg weicht vom Bilanzstichtag ab.');
    await db.query(`UPDATE ai_extractions SET verification = jsonb_set(verification, '{balanceDate}', '"2025-12-31"') WHERE document_id=$1 AND is_current`, [docs['UBS_Kontoauszug_1020.pdf']]);
  });

  it('KI-Beurteilung über Microsoft 365 Copilot (im Namen des Benutzers)', async () => {
    const accountId = (await db.query(`SELECT id FROM accounts WHERE account_number='1020' AND trial_balance_id=$1`, [tbId])).rows[0].id;
    // ohne Microsoft-Anmeldung
    const r0 = await app.inject({ method: 'POST', url: `/api/match-runs/${runId}/accounts/${accountId}/ai-review`, headers: H, payload: {} });
    expect(r0.statusCode).toBe(401);
    fake.reply = () => 'Gerne, hier meine Einschätzung:\n```json\n{"assessment":"stuetzt","reasoning":"Schlusssaldo per Stichtag entspricht dem Buchsaldo.","issues":[],"suggestedComment":"Saldo gemäss Kontoauszug UBS per 31.12.2025 abgestimmt."}\n```';
    const r = await app.inject({ method: 'POST', url: `/api/match-runs/${runId}/accounts/${accountId}/ai-review`, headers: { ...H, 'x-ms-assertion': 'anna-jwt' }, payload: {} });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ provider: 'm365-copilot', review: { assessment: 'stuetzt' }, notice: expect.stringMatching(/kein Prüfentscheid/) });
    const sent = fake.calls.at(-1)!.body;
    expect(sent.contextualResources.webContext.isWebEnabled).toBe(false);
    expect(sent.additionalContext[0].text).toContain(">> [S.1 Z.6] Schlusssaldo");
  });

  it('protokolliert jeden KI-Aufruf ohne Inhalte', async () => {
    const calls = (await app.inject({ method: 'GET', url: `/api/engagements/${engagementId}/ai-calls`, headers: H })).json();
    expect(calls.map((c: { provider: string; status: string }) => `${c.provider}:${c.status}`)).toEqual(['azure-foundry:ok', 'ollama:ok', 'm365-copilot:error', 'm365-copilot:ok']);
    expect(calls[1]).toMatchObject({ images_sent: 1, boundary: 'local', actor: 'anna' });
    expect(calls[0].prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(calls[0])).not.toContain('prompt');
    const log = (await app.inject({ method: 'GET', url: `/api/engagements/${engagementId}/audit-log`, headers: H })).json();
    expect(log.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['engagement.ai_policy', 'ai.extract', 'ai.review']));
  });

  it('nur Administratoren ändern Routing und Richtlinien', async () => {
    const strict = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL!, API_TOKENS: 't1:anna,t2:chef', ADMIN_USERS: 'chef' }), db, { ai: buildRegistry(loadAiConfig({ OLLAMA_BASE_URL: fake.url, OLLAMA_MODEL: 'llama3.3:70b' })) });
    const body = { task: 'match_review', provider: 'ollama' };
    expect((await strict.inject({ method: 'PUT', url: '/api/ai/routing', headers: { authorization: 'Bearer t1' }, payload: body })).statusCode).toBe(403);
    expect((await strict.inject({ method: 'PUT', url: '/api/ai/routing', headers: { authorization: 'Bearer t2' }, payload: body })).statusCode).toBe(200);
    await strict.close();
  });
});
