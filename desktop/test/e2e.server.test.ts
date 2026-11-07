/**
 * Ende-zu-Ende: Netzwerkschicht der Windows-App (ApiClient, Upload, EventStream)
 * gegen den echten Balance-Scout-Server im Entra-Modus mit PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiClient } from '../electron/api';
import { EventStream } from '../electron/events';
import type { PickedFile, ServerEvent } from '../electron/shared';
import { buildApp } from '../../server/src/app';
import { loadConfig } from '../../server/src/config';
import { createPool } from '../../server/src/db/pool';
import { migrate } from '../../server/src/db/migrate';
import { EntraVerifier } from '../../server/src/auth/entra';
import { PgEventBus } from '../../server/src/lib/events';
import { testKeys, TEST_AUDIENCE, TEST_TENANT } from '../../server/test/entraTestKeys';

const DB_URL = process.env.TEST_DATABASE_URL;
const FIX = path.join(__dirname, '..', '..', 'server', 'test', 'fixtures');

describe.skipIf(!DB_URL)('Windows-App ↔ Server (Ende-zu-Ende)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: ReturnType<typeof createPool>;
  let bus: PgEventBus;
  let base: string;
  let annaApi: ApiClient;
  let beatApi: ApiClient;
  let tokens: { anna: string; beat: string };
  let tmp: string;

  beforeAll(async () => {
    db = createPool(DB_URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const k = await testKeys();
    tokens = {
      anna: await k.sign({ preferred_username: 'anna@kanzlei.ch', name: 'Anna Muster', oid: 'a', roles: ['BalanceScout.Admin'] }),
      beat: await k.sign({ preferred_username: 'beat@kanzlei.ch', name: 'Beat Beispiel', oid: 'b', roles: ['BalanceScout.User'] }),
    };
    tmp = await mkdtemp(path.join(tmpdir(), 'bs-e2e-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL!, STORAGE_DIR: path.join(tmp, 'files'), AUTH_MODE: 'entra', ENTRA_TENANT_ID: TEST_TENANT, ENTRA_API_AUDIENCE: TEST_AUDIENCE });
    bus = new PgEventBus(db);
    await bus.start();
    app = await buildApp(cfg, db, { verifier: new EntraVerifier({ tenantId: TEST_TENANT, audiences: [TEST_AUDIENCE], adminRole: 'BalanceScout.Admin', userRole: 'BalanceScout.User' }, k.jwks), events: bus });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    annaApi = new ApiClient({ baseUrl: () => base, token: async () => tokens.anna });
    beatApi = new ApiClient({ baseUrl: () => base, token: async () => tokens.beat });
  });

  afterAll(async () => {
    await app?.close();
    await bus?.stop();
    await db?.end();
  });

  it('kompletter Arbeitsablauf zweier Prüfer', async () => {
    const me = await annaApi.request<{ actor: string; isAdmin: boolean }>('GET', '/api/me');
    expect(me.data).toMatchObject({ actor: 'anna@kanzlei.ch', isAdmin: true });

    const eng = await annaApi.request<{ id: string }>('POST', '/api/engagements', { name: 'Muster AG', clientName: 'Muster AG', closingDate: '2025-12-31' });
    expect(eng.status).toBe(201);
    const E = eng.data!.id;

    // Beat hört live mit (wie die Taskleisten-App)
    const events: ServerEvent[] = [];
    const states: string[] = [];
    const stream = new EventStream({ url: id => beatApi.url(`/api/engagements/${id}/events`), token: async () => tokens.beat, onEvent: e => events.push(e), onState: s => states.push(s) });
    stream.watch(E);
    await new Promise(r => setTimeout(r, 200));

    // Saldobilanz als Datei vom Datenträger (wie aus dem Dateidialog)
    const tbFile = path.join(tmp, 'SaBi 2025.csv');
    await writeFile(tbFile, "Konto;Bezeichnung;Saldo\n1000;Kasse;1'500.00\n1020;Bank UBS Kontokorrent;48'250.35\n2800;Aktienkapital;-49'750.35\n");
    const pick = (p: string): PickedFile => ({ path: p, name: path.basename(p), size: require('node:fs').statSync(p).size });
    const preview = await annaApi.upload<{ dryRun: boolean; validation: { ok: boolean } }>(`/api/engagements/${E}/trial-balances`, [pick(tbFile)], { dryRun: 'true' }, 'file');
    expect(preview.data).toMatchObject({ dryRun: true, validation: { ok: true } });
    const tb = await annaApi.upload<{ id: string }>(`/api/engagements/${E}/trial-balances`, [pick(tbFile)], {}, 'file');
    expect(tb.status).toBe(201);

    const ev = await annaApi.upload<{ status: string }[]>(`/api/engagements/${E}/evidence`, [pick(path.join(FIX, 'UBS_Kontoauszug_1020.pdf')), pick(path.join(FIX, 'Scan.pdf'))]);
    expect(ev.data!.map(x => x.status)).toEqual(['stored', 'stored']);

    const run = await annaApi.request<{ id: string; results: { accountId: string; accountNumber: string; status: string }[] }>('POST', `/api/trial-balances/${tb.data!.id}/match-runs`, {});
    const bank = run.data!.results.find(r => r.accountNumber === '1020')!;
    expect(bank.status).toBe('BELEGT');

    // Beat öffnet dasselbe Konto, während Anna es bearbeitet
    expect((await annaApi.request('POST', `/api/accounts/${bank.accountId}/lock`)).ok).toBe(true);
    const blocked = await beatApi.request('POST', `/api/accounts/${bank.accountId}/lock`);
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'Wird bearbeitet von Anna Muster.' });
    const saved = await annaApi.request<{ version: number }>('PUT', `/api/accounts/${bank.accountId}/review`, { decision: 'bestaetigt', comment: 'Saldo gemäss UBS-Kontoauszug per 31.12.2025.', runId: run.data!.id, baseVersion: 0 });
    expect(saved.data!.version).toBe(1);
    expect((await annaApi.request('DELETE', `/api/accounts/${bank.accountId}/lock`)).status).toBe(204);

    // Beat ist kein Admin
    expect((await beatApi.request('PUT', `/api/engagements/${E}/ai-policy`, { aiPolicy: 'tenant' })).status).toBe(403);

    await new Promise(r => setTimeout(r, 300));
    stream.stop();
    expect(states[0]).toBe('connected');
    expect(events.map(e => e.type)).toEqual(['evidence.uploaded', 'match.completed', 'lock.acquired', 'review.updated', 'lock.released']);
    expect(events.every(e => e.actor === 'anna@kanzlei.ch')).toBe(true);
  });

  it('abgelaufene/ungültige Anmeldung wird sauber gemeldet', async () => {
    const bad = new ApiClient({ baseUrl: () => base, token: async () => 'kein.gueltiges.token' });
    const r = await bad.request('GET', '/api/engagements');
    expect(r.status).toBe(401);
    expect(r.error).toMatch(/Anmeldung ungültig/);
  });

  it('Live-Verbindung verbindet nach Abbruch neu', async () => {
    const states: string[] = [];
    let n = 0;
    const flaky: typeof fetch = async (u, i) => {
      n++;
      if (n === 1) throw new TypeError('Netz weg');
      return fetch(u, i);
    };
    const E = (await annaApi.request<{ id: string }>('POST', '/api/engagements', { name: 'Reconnect' })).data!.id;
    const s = new EventStream({ url: id => annaApi.url(`/api/engagements/${id}/events`), token: async () => tokens.anna, onEvent: () => undefined, onState: x => states.push(x), fetch: flaky });
    s.watch(E);
    await new Promise(r => setTimeout(r, 2600));
    s.stop();
    expect(states.slice(0, 2)).toEqual(['reconnecting', 'connected']);
  });
});
