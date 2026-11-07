import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore, validateSettings, DEFAULT_SETTINGS } from '../electron/settings';
import { ApiClient } from '../electron/api';
import { SseParser, describeEvent } from '../electron/events';

const GOOD = {
  serverUrl: 'https://balance-scout.kanzlei.ch',
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  apiScope: 'api://balance-scout/access_as_user',
};

describe('Einstellungen', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'bsd-')); });

  it('validiert Eingaben verständlich', () => {
    expect(validateSettings({ ...DEFAULT_SETTINGS, ...GOOD })).toBeNull();
    expect(validateSettings({ ...DEFAULT_SETTINGS, ...GOOD, serverUrl: 'http://server.kanzlei.ch' })).toMatch(/https/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, ...GOOD, serverUrl: 'http://localhost:8080' })).toBeNull();
    expect(validateSettings({ ...DEFAULT_SETTINGS, ...GOOD, tenantId: 'kanzlei' })).toMatch(/GUID/);
    expect(validateSettings({ ...DEFAULT_SETTINGS, ...GOOD, apiScope: 'api://x/.default' })).toMatch(/access_as_user/);
    expect(validateSettings({ ...DEFAULT_SETTINGS }, true)).toBeNull(); // Einrichtung: leer erlaubt
  });

  it('Richtliniendatei der IT überschreibt und sperrt Felder', () => {
    const policy = path.join(dir, 'policy.json');
    writeFileSync(policy, '\uFEFF' + JSON.stringify({ serverUrl: GOOD.serverUrl, tenantId: GOOD.tenantId, autoStart: true }));
    const st = new SettingsStore(path.join(dir, 'user', 'settings.json'), policy);
    expect(st.managed()).toEqual({ serverUrl: true, tenantId: true, autoStart: true });
    expect(st.set({ serverUrl: 'https://andere.example', clientId: GOOD.clientId, apiScope: GOOD.apiScope, autoStart: false })).toBeNull();
    expect(st.get()).toMatchObject({ serverUrl: GOOD.serverUrl, clientId: GOOD.clientId, autoStart: true });
    expect(st.complete()).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(dir, 'user', 'settings.json'), 'utf8'));
    expect(saved.serverUrl).toBeUndefined();
  });

  it('ignoriert beschädigte Dateien und unbekannte Felder', () => {
    const f = path.join(dir, 's.json');
    writeFileSync(f, '{kaputt');
    const st = new SettingsStore(f, null);
    expect(st.get()).toEqual(DEFAULT_SETTINGS);
    expect(st.set({ ...GOOD, evil: 'x' } as never)).toBeNull();
    expect(JSON.parse(readFileSync(f, 'utf8')).evil).toBeUndefined();
    expect(st.set({ serverUrl: 'ftp://x' })).toMatch(/https/);
  });
});

describe('Server-Zugriff aus der App', () => {
  const client = (fetchImpl: typeof fetch, token: string | null = 'T') =>
    new ApiClient({ baseUrl: () => 'https://bs.example/', token: async () => token, fetch: fetchImpl });

  it('nur Pfade unter /api, kein Pfad-Trick', async () => {
    const c = client((async () => new Response('{}')) as typeof fetch);
    expect(c.url('/api/engagements')).toBe('https://bs.example/api/engagements');
    for (const bad of ['https://evil.example/api', '/admin', '/api/../x', '//evil.example/api/x', '/api/x\ny']) {
      expect(() => c.url(bad)).toThrow(/Unzulässig/);
    }
    expect((await c.request('PATCH', '/api/x')).error).toMatch(/Methode/);
  });

  it('ohne Anmeldung kein Aufruf; Fehler verständlich', async () => {
    let called = false;
    const c = client((async () => { called = true; return new Response('{}'); }) as typeof fetch, null);
    expect(await c.request('GET', '/api/me')).toEqual({ ok: false, status: 401, error: 'Bitte anmelden.' });
    expect(called).toBe(false);
    const down = client((async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    expect((await down.request('GET', '/api/me')).error).toMatch(/nicht erreichbar/);
    const err = client((async () => new Response(JSON.stringify({ error: 'Wird bearbeitet von Anna.' }), { status: 409 })) as typeof fetch);
    expect(await err.request('POST', '/api/accounts/x/lock')).toMatchObject({ ok: false, status: 409, error: 'Wird bearbeitet von Anna.' });
  });
});

describe('Live-Ereignisse', () => {
  it('zerlegt Teilstücke, ignoriert Pings', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nevent: x\ndata: {"type":"review.upd')).toEqual([]);
    const ev = p.push('ated","engagementId":"e","actor":"a@k.ch","data":{"decision":"bestaetigt"},"at":"t"}\r\n\r\n');
    expect(ev).toHaveLength(1);
    expect(describeEvent(ev[0]!, 'b@k.ch')).toEqual({ title: 'Prüfvermerk gespeichert', body: 'a: bestätigt' });
  });
});
