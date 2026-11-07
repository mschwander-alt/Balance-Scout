import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { EntraVerifier } from '../src/auth/entra.js';
import { PgEventBus, type BsbEvent } from '../src/lib/events.js';
import { SharePointUploader } from '../src/lib/sharepoint.js';
import { fakeTokens } from './fakeAi.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const TENANT = '11111111-2222-3333-4444-555555555555';
const AUD = 'api://balance-scout';
const FIX = path.join(import.meta.dirname, 'fixtures');

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' } as JWK;
  const sign = (claims: Record<string, unknown>, o: { tid?: string; aud?: string; exp?: string; iss?: string } = {}) =>
    new SignJWT({ tid: o.tid ?? TENANT, scp: 'access_as_user', ver: '2.0', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.iss ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
      .setAudience(o.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '1h')
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), sign, privateKey };
}

describe('Microsoft-Anmeldung (Token-Prüfung)', () => {
  it('akzeptiert gültige Tokens und liest Rollen', async () => {
    const k = await keys();
    const v = new EntraVerifier({ tenantId: TENANT, audiences: [AUD], adminRole: 'BalanceScout.Admin', userRole: 'BalanceScout.User' }, k.jwks);
    const p = await v.verify(await k.sign({ preferred_username: 'anna@kanzlei.ch', name: 'Anna Muster', oid: 'o1', roles: ['BalanceScout.Admin'] }));
    expect(p).toMatchObject({ actor: 'anna@kanzlei.ch', name: 'Anna Muster', isAdmin: true });
  });

  it.each([
    ['fremder Tenant', { tid: '99999999-0000-0000-0000-000000000000' }, {}],
    ['falsche Audience', {}, { aud: 'api://andere-app' }],
    ['abgelaufen', {}, { exp: '-5m' }],
    ['falscher Aussteller', {}, { iss: 'https://evil.example/v2.0' }],
    ['ohne Rolle', { roles: [] }, {}],
    ['ohne Scope', { scp: 'User.Read' }, {}],
  ])('lehnt ab: %s', async (_n, claims, opts) => {
    const k = await keys();
    const v = new EntraVerifier({ tenantId: TENANT, audiences: [AUD], adminRole: 'BalanceScout.Admin', userRole: 'BalanceScout.User' }, k.jwks);
    const token = await k.sign({ preferred_username: 'x@y.ch', roles: ['BalanceScout.User'], ...claims }, opts as never);
    await expect(v.verify(token)).rejects.toThrow();
  });

  it('lehnt mit fremdem Schlüssel signierte Tokens ab', async () => {
    const good = await keys();
    const evil = await keys();
    const v = new EntraVerifier({ tenantId: TENANT, audiences: [AUD], adminRole: 'A' }, good.jwks);
    await expect(v.verify(await evil.sign({ preferred_username: 'x@y.ch' }))).rejects.toThrow(/ungültig/);
  });

  it('production verbietet Anmeldung ohne Prüfung', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x' })).toThrow(/AUTH_MODE=dev/);
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', AUTH_MODE: 'entra' })).toThrow(/ENTRA_TENANT_ID/);
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_API_AUDIENCE: AUD }).authMode).toBe('entra');
  });
});

describe.skipIf(!DB_URL)('Zusammenarbeit (PostgreSQL, zwei Server-Instanzen)', () => {
  let db: Db;
  let a: FastifyInstance; // Instanz 1
  let b: FastifyInstance; // Instanz 2
  let busA: PgEventBus;
  let busB: PgEventBus;
  let graph: FastifyInstance;
  const graphCalls: { url: string; auth: string; size: number }[] = [];
  let anna: string;
  let beat: string;
  let engagementId: string;
  let accountId: string;
  let docId: string;

  beforeAll(async () => {
    db = createPool(DB_URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const k = await keys();
    anna = await k.sign({ preferred_username: 'anna@kanzlei.ch', name: 'Anna Muster', oid: 'a', roles: ['BalanceScout.Admin'] });
    beat = await k.sign({ preferred_username: 'beat@kanzlei.ch', name: 'Beat Beispiel', oid: 'b', roles: ['BalanceScout.User'] });

    graph = Fastify();
    graph.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
    graph.put('/v1.0/*', async req => {
      graphCalls.push({ url: req.url, auth: String(req.headers.authorization), size: (req.body as Buffer).length });
      return { id: 'item-1', webUrl: 'https://kanzlei.sharepoint.com/sites/revision/Belege/UBS.pdf' };
    });
    await graph.listen({ port: 0, host: '127.0.0.1' });
    const graphUrl = `http://127.0.0.1:${(graph.server.address() as { port: number }).port}/v1.0`;

    const storage = await mkdtemp(path.join(tmpdir(), 'bsb-c-'));
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL!, STORAGE_DIR: storage, AUTH_MODE: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_API_AUDIENCE: AUD });
    const verifier = new EntraVerifier({ tenantId: TENANT, audiences: [AUD], adminRole: 'BalanceScout.Admin', userRole: 'BalanceScout.User' }, k.jwks);
    const tokens = fakeTokens();
    const sharePoint = new SharePointUploader({ driveId: 'b!drive', rootFolder: 'Balance Scout', graphBaseUrl: graphUrl }, tokens);
    busA = new PgEventBus(db);
    busB = new PgEventBus(db);
    await busA.start();
    await busB.start();
    a = await buildApp(cfg, db, { verifier, events: busA, sharePoint });
    b = await buildApp(cfg, db, { verifier, events: busB, sharePoint });
    await b.listen({ port: 0, host: '127.0.0.1' });

    const H = { authorization: `Bearer ${anna}` };
    engagementId = (await a.inject({ method: 'POST', url: '/api/engagements', headers: H, payload: { name: 'Muster AG', closingDate: '2025-12-31' } })).json().id;
    const csv = "Konto;Bezeichnung;Saldo\n1020;Bank UBS;48'250.35\n2800;Aktienkapital;-48'250.35\n";
    const boundary = 'xx';
    const mp = (name: string, filename: string, data: Buffer, type: string) => ({
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { ...H, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const tb = (await a.inject({ method: 'POST', url: `/api/engagements/${engagementId}/trial-balances`, ...mp('file', 'sabi.csv', Buffer.from(csv), 'text/csv') })).json();
    accountId = (await db.query(`SELECT id FROM accounts WHERE trial_balance_id=$1 AND account_number='1020'`, [tb.id])).rows[0].id;
    docId = (await a.inject({ method: 'POST', url: `/api/engagements/${engagementId}/evidence`, ...mp('files', 'UBS.pdf', await readFile(path.join(FIX, 'UBS_Kontoauszug_1020.pdf')), 'application/pdf') })).json()[0].id;
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await graph?.close();
    await busA?.stop();
    await busB?.stop();
    await db?.end();
  });

  it('ohne Anmeldung kein Zugriff; /me liefert Benutzer', async () => {
    expect((await a.inject({ method: 'GET', url: '/api/engagements' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${beat}` } })).json()).toEqual({ actor: 'beat@kanzlei.ch', name: 'Beat Beispiel', isAdmin: false, microsoftLinked: true });
  });

  it('Rollen aus Entra steuern Adminrechte', async () => {
    const r = await a.inject({ method: 'PUT', url: `/api/engagements/${engagementId}/ai-policy`, headers: { authorization: `Bearer ${beat}` }, payload: { aiPolicy: 'tenant' } });
    expect(r.statusCode).toBe(403);
  });

  it('Sperren: zweiter Benutzer wird abgewiesen, Prüfvermerk nur mit Sperre und richtiger Version', async () => {
    const A = { authorization: `Bearer ${anna}` };
    const B = { authorization: `Bearer ${beat}` };
    expect((await a.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: A })).statusCode).toBe(200);
    // Instanz 2, anderer Benutzer
    const blocked = await b.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: B });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('Wird bearbeitet von Anna Muster.');
    // Heartbeat durch Anna verlängert
    expect((await b.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: A })).statusCode).toBe(200);

    expect((await a.inject({ method: 'PUT', url: `/api/accounts/${accountId}/review`, headers: B, payload: { decision: 'bestaetigt', baseVersion: 0 } })).statusCode).toBe(423);
    const ok = await a.inject({ method: 'PUT', url: `/api/accounts/${accountId}/review`, headers: A, payload: { decision: 'bestaetigt', comment: 'Saldo gemäss UBS abgestimmt.', baseVersion: 0 } });
    expect(ok.json()).toMatchObject({ version: 1, reviewedBy: 'anna@kanzlei.ch' });
    expect((await a.inject({ method: 'PUT', url: `/api/accounts/${accountId}/review`, headers: A, payload: { decision: 'abweichung', baseVersion: 0 } })).statusCode).toBe(409);

    await a.inject({ method: 'DELETE', url: `/api/accounts/${accountId}/lock`, headers: A });
    expect((await b.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: B })).statusCode).toBe(200);
    const locks = (await a.inject({ method: 'GET', url: `/api/engagements/${engagementId}/locks`, headers: A })).json();
    expect(locks).toEqual([expect.objectContaining({ lockedByName: 'Beat Beispiel' })]);
    await b.inject({ method: 'DELETE', url: `/api/accounts/${accountId}/lock`, headers: B });
  });

  it('abgelaufene Sperre darf übernommen werden', async () => {
    await a.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: { authorization: `Bearer ${anna}` } });
    await db.query(`UPDATE account_locks SET expires_at = now() - interval '1 second' WHERE account_id=$1`, [accountId]);
    expect((await a.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: { authorization: `Bearer ${beat}` } })).statusCode).toBe(200);
    await a.inject({ method: 'DELETE', url: `/api/accounts/${accountId}/lock`, headers: { authorization: `Bearer ${beat}` } });
  });

  it('Live-Ereignisse erreichen Benutzer auf der anderen Server-Instanz', async () => {
    const port = (b.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/engagements/${engagementId}/events`, { headers: { authorization: `Bearer ${beat}` }, signal: ac.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const received: BsbEvent[] = [];
    const reading = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/data: (.+)\n\n/g)) received.push(JSON.parse(m[1]!));
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
        if (received.length >= 2) break;
      }
    })();
    await new Promise(r => setTimeout(r, 150));
    // Anna arbeitet auf Instanz A
    await a.inject({ method: 'POST', url: `/api/accounts/${accountId}/lock`, headers: { authorization: `Bearer ${anna}` } });
    await a.inject({ method: 'PUT', url: `/api/accounts/${accountId}/review`, headers: { authorization: `Bearer ${anna}` }, payload: { decision: 'abweichung', comment: 'Differenz klären', baseVersion: 1 } });
    await Promise.race([reading, new Promise(r => setTimeout(r, 3000))]);
    ac.abort();
    expect(received.map(e => e.type)).toEqual(['lock.acquired', 'review.updated']);
    expect(received[0]).toMatchObject({ actor: 'anna@kanzlei.ch', data: { accountId, name: 'Anna Muster' } });
    await a.inject({ method: 'DELETE', url: `/api/accounts/${accountId}/lock`, headers: { authorization: `Bearer ${anna}` } });
  });

  it('SharePoint-Ablage im Namen des Benutzers', async () => {
    const r = await a.inject({ method: 'POST', url: `/api/evidence/${docId}/sharepoint`, headers: { authorization: `Bearer ${anna}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().webUrl).toMatch(/sharepoint\.com/);
    expect(graphCalls[0]!.url).toBe('/v1.0/drives/b!drive/root:/Balance%20Scout/Muster%20AG%202025-12-31/Belege/UBS.pdf:/content?@microsoft.graph.conflictBehavior=replace');
    expect(graphCalls[0]!.auth).toBe(`Bearer graph-token-for-${anna}`);
    expect(graphCalls[0]!.size).toBeGreaterThan(500);
    const row = (await db.query(`SELECT sharepoint_url FROM evidence_documents WHERE id=$1`, [docId])).rows[0];
    expect(row.sharepoint_url).toMatch(/sharepoint\.com/);
  });

  it('Listen für die Windows-App: Belege, Läufe, aktuelle Prüfvermerke', async () => {
    const A = { authorization: `Bearer ${anna}` };
    const ev = await a.inject({ method: 'GET', url: `/api/engagements/${engagementId}/evidence`, headers: A });
    expect(ev.statusCode).toBe(200);
    expect(ev.json()[0]).toMatchObject({ filename: 'UBS.pdf', line_count: expect.any(Number), ai: null });
    const tbId = (await db.query(`SELECT trial_balance_id FROM accounts WHERE id=$1`, [accountId])).rows[0].trial_balance_id;
    await a.inject({ method: 'POST', url: `/api/trial-balances/${tbId}/match-runs`, headers: A, payload: {} });
    const runs = (await a.inject({ method: 'GET', url: `/api/trial-balances/${tbId}/match-runs`, headers: A })).json();
    expect(runs).toHaveLength(1);
    // Bank und Aktienkapital haben denselben Betrag -> Fundstelle mehrdeutig -> beide PRUEFEN
    expect(runs[0].summary.counts).toMatchObject({ BELEGT: 0, PRUEFEN: 2 });
    const rev = (await a.inject({ method: 'GET', url: `/api/trial-balances/${tbId}/reviews`, headers: A })).json();
    expect(rev).toEqual([expect.objectContaining({ accountId, decision: 'abweichung', version: 2 })]);
  });

  it('Prüfvermerke sind versioniert und im Protokoll', async () => {
    const hist = (await a.inject({ method: 'GET', url: `/api/accounts/${accountId}/reviews`, headers: { authorization: `Bearer ${anna}` } })).json();
    expect(hist.map((h: { version: number; decision: string }) => `${h.version}:${h.decision}`)).toEqual(['2:abweichung', '1:bestaetigt']);
    const log = (await a.inject({ method: 'GET', url: `/api/engagements/${engagementId}/audit-log`, headers: { authorization: `Bearer ${anna}` } })).json();
    expect(log.filter((l: { action: string }) => l.action === 'account.review').map((l: { actor: string }) => l.actor)).toEqual(['anna@kanzlei.ch', 'anna@kanzlei.ch']);
  });
});

describe.skipIf(!DB_URL)('Ereignis-Verbindung', () => {
  it('verbindet nach Abbruch der Datenbankverbindung neu', async () => {
    const db = createPool(DB_URL!);
    const bus = new PgEventBus(db);
    await bus.start();
    const got: string[] = [];
    bus.subscribe(e => got.push(e.type));
    // Verbindung serverseitig beenden (wie bei Wartung/Failover)
    await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN bsb_events' AND pid <> pg_backend_pid()`);
    await new Promise(r => setTimeout(r, 5800));
    await bus.publish({ type: 'match.completed', engagementId: 'x', actor: 't', data: {} });
    await new Promise(r => setTimeout(r, 200));
    await bus.stop();
    await db.end();
    expect(got).toEqual(['match.completed']);
  }, 15_000);
});
