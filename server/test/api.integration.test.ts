import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const DB_URL = process.env.TEST_DATABASE_URL;
const FIX = path.join(import.meta.dirname, 'fixtures');

function multipart(files: { name: string; filename: string; data: Buffer; type: string }[], fields: Record<string, string> = {}) {
  const boundary = '----bsb' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`), f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function tbXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('SaBi');
  ws.addRows([
    ['Muster AG – Saldobilanz 31.12.2025'],
    [],
    ['Kontonummer', 'Kontobezeichnung', 'Saldo', 'Vorjahr'],
    [1000, 'Kasse', 1500, 1200],
    [1020, 'Bank UBS Kontokorrent', 48250.35, 30000],
    [1100, 'Debitoren', 12000, 10000],
    [1170, 'Vorsteuer', 0, 300],
    [2000, 'Kreditoren', -8000, -7000],
    [2800, 'Aktienkapital', -50000, -50000],
    [3200, 'Warenertrag', -20000, -15000],
    [4200, 'Warenaufwand', 16249.65, 30500],
  ]);
  // Formelzelle: Ergebnis muss gelesen werden
  ws.getCell('C6').value = { formula: '7000+5000', result: 12000 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe.skipIf(!DB_URL)('API-Integration (PostgreSQL)', () => {
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    db = createPool(DB_URL!);
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
    const storage = await mkdtemp(path.join(tmpdir(), 'bsb-'));
    app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL!, STORAGE_DIR: storage }), db);
  });
  afterAll(async () => {
    await app?.close();
    await db?.end();
  });

  it('kompletter Ablauf: Mandat → Saldobilanz → Belege → Matching → Protokoll', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ status: 'ok' });

    const e = await app.inject({ method: 'POST', url: '/api/engagements', headers: { 'x-user': 'm.schwander' }, payload: { name: 'JA 2025', clientName: 'Muster AG', closingDate: '2025-12-31' } });
    expect(e.statusCode).toBe(201);
    const engagementId = e.json().id;

    // Vorschau (dryRun) speichert nichts
    const mp0 = multipart([{ name: 'file', filename: 'SaBi_2025.xlsx', data: await tbXlsx(), type: 'application/octet-stream' }], { dryRun: 'true' });
    const dry = await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/trial-balances`, ...mp0 });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().validation.ok).toBe(true);

    const mp = multipart([{ name: 'file', filename: 'SaBi_2025.xlsx', data: await tbXlsx(), type: 'application/octet-stream' }], { signConvention: 'signed' });
    const tb = await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/trial-balances`, ...mp });
    expect(tb.statusCode).toBe(201);
    const tbBody = tb.json();
    expect(tbBody.validation.accountCount).toBe(8);
    expect(tbBody.validation.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);

    const tbGet = (await app.inject({ method: 'GET', url: `/api/trial-balances/${tbBody.id}` })).json();
    expect(tbGet.accounts.find((a: { accountNumber: string }) => a.accountNumber === '1020').balanceCurrentYear).toBe(4825035);

    const ev = multipart([
      { name: 'files', filename: 'UBS_Kontoauszug_1020.pdf', data: await readFile(path.join(FIX, 'UBS_Kontoauszug_1020.pdf')), type: 'application/pdf' },
      { name: 'files', filename: 'Debitorenliste.pdf', data: await readFile(path.join(FIX, 'Debitorenliste.pdf')), type: 'application/pdf' },
      { name: 'files', filename: 'Scan.pdf', data: await readFile(path.join(FIX, 'Scan.pdf')), type: 'application/pdf' },
      { name: 'files', filename: 'virus.exe', data: Buffer.from('MZ'), type: 'application/octet-stream' },
    ]);
    const up = await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/evidence`, ...ev });
    expect(up.statusCode).toBe(201);
    const upBody = up.json();
    expect(upBody.map((r: { status: string }) => r.status)).toEqual(['stored', 'stored', 'stored', 'rejected']);
    expect(upBody[2].needsOcr).toBe(true);

    // Duplikat erkennen
    const dup = await app.inject({ method: 'POST', url: `/api/engagements/${engagementId}/evidence`, ...multipart([{ name: 'files', filename: 'kopie.pdf', data: await readFile(path.join(FIX, 'Debitorenliste.pdf')), type: 'application/pdf' }]) });
    expect(dup.json()[0].status).toBe('duplicate');

    const run = await app.inject({ method: 'POST', url: `/api/trial-balances/${tbBody.id}/match-runs`, payload: {} });
    expect(run.statusCode).toBe(201);
    const out = run.json();
    const byNr = Object.fromEntries(out.results.map((r: { accountNumber: string }) => [r.accountNumber, r]));
    expect(byNr['1020'].status).toBe('BELEGT');
    expect(byNr['1020'].best).toMatchObject({ filename: 'UBS_Kontoauszug_1020.pdf', page: 1 });
    expect(byNr['1100'].status).toBe('PRUEFEN'); // 11'999.50 vs 12'000.00 → Toleranz
    expect(byNr['1100'].best.differenceCents).toBe(-50);
    expect(byNr['1000'].status).toBe('KEIN_NACHWEIS');
    expect(byNr['1170'].status).toBe('NULLSALDO');
    expect(byNr['3200'].status).toBe('NICHT_IM_UMFANG');

    const persisted = (await app.inject({ method: 'GET', url: `/api/match-runs/${out.id}` })).json();
    expect(persisted.results).toHaveLength(8);
    expect(persisted.engine_version).toBe('bsb-match/1.1.0');

    const log = (await app.inject({ method: 'GET', url: `/api/engagements/${engagementId}/audit-log` })).json();
    expect(log.map((l: { action: string }) => l.action)).toEqual(['engagement.create', 'trial_balance.import', 'evidence.upload', 'evidence.upload', 'evidence.upload', 'matching.run']);
    expect(log[0].actor).toBe('m.schwander');
    await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/unveränderlich/);
  });

  it('liefert verständliche Fehler', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/engagements', payload: { name: '' } });
    expect(r1.statusCode).toBe(400);
    const r2 = await app.inject({ method: 'GET', url: '/api/engagements/00000000-0000-0000-0000-000000000000' });
    expect(r2.statusCode).toBe(404);
    const e = (await app.inject({ method: 'POST', url: '/api/engagements', payload: { name: 'X' } })).json();
    const bad = multipart([{ name: 'file', filename: 'x.csv', data: Buffer.from('a;b\n1;2\n'), type: 'text/csv' }]);
    const r3 = await app.inject({ method: 'POST', url: `/api/engagements/${e.id}/trial-balances`, ...bad });
    expect(r3.statusCode).toBe(422);
    expect(r3.json().error).toMatch(/Kopfzeile nicht erkannt/);
  });
});

describe('Authentifizierung', () => {
  it('verlangt Token, wenn API_TOKENS gesetzt', async () => {
    const fakeDb = { query: async () => ({ rows: [] }) } as unknown as Db;
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'x', API_TOKENS: 'geheim:anna' }), fakeDb);
    expect((await app.inject({ method: 'GET', url: '/api/engagements' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/engagements', headers: { authorization: 'Bearer geheim' } })).statusCode).toBe(200);
    await app.close();
  });
});
