import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { App } from '../../src/App';
import type { BsbBridge, ServerEvent } from '../../electron/shared';

const ENG = { id: 'e1', name: 'JA 2025 Muster AG', client_name: 'Muster AG', closing_date: '2025-12-31', currency: 'CHF', created_at: '2026-01-10T10:00:00Z', settings: { aiPolicy: 'tenant' }, trialBalances: [{ id: 'tb1', filename: 'sabi.xlsx', sign_convention: 'signed', is_valid: true, created_at: '2026-01-10T10:00:00Z', created_by: 'anna@k.ch' }] };
const RUN = {
  id: 'r1', engine_version: 'bsb-match/1.1.0', created_at: '2026-01-10T11:00:00Z', created_by: 'anna@k.ch',
  summary: { engineVersion: 'bsb-match/1.1.0', counts: { BELEGT: 1, PRUEFEN: 1, KEIN_NACHWEIS: 0, NULLSALDO: 0, NICHT_IM_UMFANG: 1 }, inScopeAbsTotal: 4975035, confirmedAbsTotal: 4825035, coverage: 0.9698, params: { absoluteToleranceCents: 100, scope: 'balance_sheet' } },
  results: [
    { accountId: 'a1', accountNumber: '1020', accountName: 'Bank UBS', balance: 4825035, status: 'BELEGT', reasons: ['Saldo exakt gefunden.'], best: { documentId: 'd1', filename: 'UBS.pdf', page: 1, lineNo: 6, source: 'text-layer', line: "Schlusssaldo CHF 48'250.35", raw: "48'250.35", evidenceCents: 4825035, differenceCents: 0, kind: 'exact', score: 85, flags: [], reasons: ['Betrag exakt (+50)'] }, candidates: [] },
    { accountId: 'a2', accountNumber: '1000', accountName: 'Kasse', balance: 150000, status: 'PRUEFEN', reasons: ['Quelle Scan'], best: { documentId: 'd2', filename: 'Scan.pdf', page: 1, lineNo: 2, source: 'ocr:ollama', line: "Kassabestand 1'500.00", raw: "1'500.00", evidenceCents: 150000, differenceCents: 0, kind: 'exact', score: 70, flags: ['OCR_SOURCE'], reasons: [] }, candidates: [] },
    { accountId: 'a3', accountNumber: '3200', accountName: 'Warenertrag', balance: -2000000, status: 'NICHT_IM_UMFANG', reasons: [], best: null, candidates: [] },
  ],
};

let listeners: ((e: ServerEvent) => void)[] = [];
let settingsComplete = true;
let signedIn = false;
const calls: string[] = [];

function mockBridge(): BsbBridge {
  const routes: Record<string, (body?: unknown) => { ok: boolean; status: number; data?: unknown; error?: string }> = {
    'GET /api/me': () => ({ ok: true, status: 200, data: { actor: 'beat@k.ch', name: 'Beat Beispiel', isAdmin: false, microsoftLinked: true } }),
    'GET /api/engagements': () => ({ ok: true, status: 200, data: [ENG] }),
    'GET /api/engagements/e1': () => ({ ok: true, status: 200, data: ENG }),
    'GET /api/engagements/e1/locks': () => ({ ok: true, status: 200, data: [{ accountId: 'a2', lockedBy: 'anna@k.ch', lockedByName: 'Anna Muster', expiresAt: '2099-01-01' }] }),
    'GET /api/trial-balances/tb1/match-runs': () => ({ ok: true, status: 200, data: [RUN] }),
    'GET /api/match-runs/r1': () => ({ ok: true, status: 200, data: RUN }),
    'GET /api/trial-balances/tb1/reviews': () => ({ ok: true, status: 200, data: [{ accountId: 'a1', decision: 'bestaetigt', comment: 'ok', version: 1, reviewedBy: 'anna@k.ch', reviewedAt: '2026-01-10T12:00:00Z' }] }),
    'GET /api/accounts/a1/reviews': () => ({ ok: true, status: 200, data: [] }),
    'GET /api/accounts/a2/reviews': () => ({ ok: true, status: 200, data: [] }),
    'POST /api/accounts/a1/lock': () => ({ ok: true, status: 200, data: {} }),
    'DELETE /api/accounts/a1/lock': () => ({ ok: true, status: 204 }),
    'PUT /api/accounts/a1/review': () => ({ ok: false, status: 409, error: 'Der Prüfvermerk wurde inzwischen geändert. Bitte neu laden.' }),
    'GET /api/engagements/e1/ai-preview?task=match_review': () => ({ ok: true, status: 200, data: { allowed: true, provider: 'm365-copilot', displayName: 'Microsoft 365 Copilot', destination: 'workiq.svc.cloud.microsoft', boundary: 'tenant', requiresUserLogin: true } }),
  };
  return {
    settings: {
      get: async () => ({ settings: { serverUrl: '', tenantId: '', clientId: '', apiScope: '', autoStart: true, notifications: 'andere' }, managed: { serverUrl: true }, complete: settingsComplete }),
      set: async s => (s.tenantId === 'falsch' ? { ok: false, error: 'Tenant-ID muss eine GUID sein.' } : ((settingsComplete = true), { ok: true })),
    },
    auth: {
      status: async () => ({ signedIn, broker: true, account: signedIn ? { name: 'Beat Beispiel', username: 'beat@k.ch' } : undefined }),
      signIn: async () => ((signedIn = true), { signedIn: true, broker: true, account: { name: 'Beat Beispiel', username: 'beat@k.ch' } }),
      signOut: async () => ((signedIn = false), { signedIn: false, broker: true }),
    },
    api: {
      request: (async (m: string, p: string, b?: unknown) => {
        calls.push(`${m} ${p}`);
        const h = routes[`${m} ${p}`];
        return h ? h(b) : { ok: false, status: 404, error: `nicht gemockt: ${m} ${p}` };
      }) as BsbBridge['api']['request'],
      pickFiles: async () => [],
      upload: (async () => ({ ok: true, status: 201, data: [] })) as BsbBridge['api']['upload'],
    },
    events: { watch: async () => undefined, on: cb => ((listeners.push(cb)), () => (listeners = listeners.filter(l => l !== cb))), onConnection: () => () => undefined },
    app: { setActivity: async () => undefined, setRecent: async () => undefined, onNavigate: () => () => undefined, openExternal: async () => undefined, version: async () => '0.3.0' },
  };
}

beforeEach(() => {
  cleanup();
  listeners = [];
  calls.length = 0;
  settingsComplete = true;
  signedIn = false;
  (window as unknown as { bsb: BsbBridge }).bsb = mockBridge();
});

describe('Oberfläche', () => {
  it('Einrichtung: von der IT vorgegebene Felder gesperrt, Fehler sichtbar', async () => {
    settingsComplete = false;
    render(<App />);
    const server = await screen.findByPlaceholderText('https://balance-scout.kanzlei.ch');
    expect((server as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/von der IT vorgegeben/)).toBeTruthy();
    fireEvent.change(screen.getAllByPlaceholderText('00000000-0000-0000-0000-000000000000')[0]!, { target: { value: 'falsch' } });
    fireEvent.click(screen.getByText('Speichern'));
    expect(await screen.findByText('Tenant-ID muss eine GUID sein.')).toBeTruthy();
  });

  it('Anmeldung → Mandat → Abgleich mit Kennzahlen, Sperre und Konflikt', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText('Mit Microsoft 365 anmelden'));
    fireEvent.click(await screen.findByText('JA 2025 Muster AG'));

    // Kennzahlen
    expect(await screen.findByText('97.0 %')).toBeTruthy();
    expect(screen.getByText("48'250.35 von 49'750.35")).toBeTruthy();
    // Sperre einer Kollegin sichtbar
    expect(screen.getByTitle('In Bearbeitung: Anna Muster')).toBeTruthy();
    // OCR-Hinweis
    expect(screen.getByText('Scan/OCR')).toBeTruthy();
    // Filter "Nicht im Umfang" ausblenden/zeigen
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);

    // Konto öffnen, bearbeiten, Konflikt beim Speichern
    fireEvent.click(within(table).getByText('Bank UBS'));
    fireEvent.click(await screen.findByText('Bearbeiten'));
    await waitFor(() => expect(calls).toContain('POST /api/accounts/a1/lock'));
    fireEvent.change(screen.getByPlaceholderText(/Feststellungen/), { target: { value: 'Abgestimmt.' } });
    fireEvent.click(screen.getAllByText('Speichern').at(-1)!);
    expect(await screen.findByText(/Inzwischen von jemand anderem geändert/)).toBeTruthy();
  });

  it('KI-Beurteilung zeigt vorher, wohin die Daten gehen; Abbrechen sendet nichts', async () => {
    signedIn = true;
    render(<App />);
    fireEvent.click(await screen.findByText('JA 2025 Muster AG'));
    fireEvent.click(await screen.findByText('Bank UBS'));
    fireEvent.click(await screen.findByText('KI-Beurteilung anfordern'));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Microsoft 365 Copilot')).toBeTruthy();
    expect(within(dlg).getByText('workiq.svc.cloud.microsoft')).toBeTruthy();
    expect(within(dlg).getByText(/Microsoft-Tenant/)).toBeTruthy();
    expect(within(dlg).getByText(/in Ihrem Namen/)).toBeTruthy();
    fireEvent.click(within(dlg).getByText('Abbrechen'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some(c => c.includes('ai-review'))).toBe(false);
  });

  it('Live-Ereignis einer Kollegin lädt neu und meldet es', async () => {
    signedIn = true;
    render(<App />);
    fireEvent.click(await screen.findByText('JA 2025 Muster AG'));
    await screen.findByText('97.0 %');
    const before = calls.filter(c => c === 'GET /api/trial-balances/tb1/match-runs').length;
    listeners.forEach(l => l({ type: 'review.updated', engagementId: 'e1', actor: 'anna@k.ch', data: { decision: 'bestaetigt' }, at: '' }));
    expect(await screen.findByText('anna hat einen Prüfvermerk gespeichert.')).toBeTruthy();
    await waitFor(() => expect(calls.filter(c => c === 'GET /api/trial-balances/tb1/match-runs').length).toBe(before + 1));
  });
});
