import type { ServerEvent } from './shared';

/** Zerlegt einen Server-Sent-Events-Strom in Ereignisse (robust gegen Teilstücke). */
export class SseParser {
  private buf = '';

  push(chunk: string): ServerEvent[] {
    this.buf += chunk.replace(/\r\n/g, '\n');
    const out: ServerEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const data = block
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue; // Kommentar/Ping
      try {
        out.push(JSON.parse(data) as ServerEvent);
      } catch {
        /* ungültig – ignorieren */
      }
    }
    return out;
  }
}

export interface EventStreamDeps {
  url: (engagementId: string) => string;
  token: () => Promise<string | null>;
  onEvent: (e: ServerEvent) => void;
  onState: (s: 'connected' | 'reconnecting' | 'offline') => void;
  fetch?: typeof fetch;
}

/** Hält die Verbindung zum Ereignisstrom eines Mandats offen, mit Wiederverbindung (Backoff). */
export class EventStream {
  private ac: AbortController | null = null;
  private current: string | null = null;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: EventStreamDeps) {}

  watch(engagementId: string | null): void {
    if (engagementId === this.current) return;
    this.stop();
    this.current = engagementId;
    if (engagementId) void this.connect(engagementId);
  }

  stop(): void {
    this.ac?.abort();
    this.ac = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
  }

  private async connect(id: string): Promise<void> {
    const ac = new AbortController();
    this.ac = ac;
    try {
      const token = await this.d.token();
      if (!token) throw new Error('nicht angemeldet');
      const res = await (this.d.fetch ?? fetch)(this.d.url(id), { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: ac.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.attempt = 0;
      this.d.onState('connected');
      const parser = new SseParser();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const e of parser.push(dec.decode(value, { stream: true }))) this.d.onEvent(e);
      }
      throw new Error('Verbindung beendet');
    } catch {
      if (ac.signal.aborted || this.current !== id) return;
      this.attempt++;
      this.d.onState(this.attempt > 5 ? 'offline' : 'reconnecting');
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
      this.timer = setTimeout(() => {
        if (this.current === id) void this.connect(id);
      }, delay);
    }
  }
}

/** Text für Windows-Benachrichtigungen */
export function describeEvent(e: ServerEvent, me: string): { title: string; body: string } | null {
  const who = e.actor === me ? 'Sie' : e.actor.split('@')[0];
  const d = e.data;
  switch (e.type) {
    case 'lock.acquired':
      return { title: 'Konto in Bearbeitung', body: `${(d.name as string) ?? who} bearbeitet ein Konto.` };
    case 'review.updated':
      return { title: 'Prüfvermerk gespeichert', body: `${who}: ${labelDecision(d.decision as string)}` };
    case 'match.completed':
      return { title: 'Abgleich abgeschlossen', body: `${who} hat einen Abgleich ausgeführt.` };
    case 'evidence.uploaded':
      return { title: 'Neue Belege', body: `${who} hat ${d.count ?? ''} Beleg(e) hochgeladen.` };
    case 'ai.extract.completed':
      return { title: 'KI-Auswertung fertig', body: `${d.filename ?? 'Beleg'} wurde ausgewertet.` };
    case 'sharepoint.uploaded':
      return { title: 'In SharePoint abgelegt', body: `${who} hat einen Beleg in SharePoint abgelegt.` };
    default:
      return null;
  }
}

function labelDecision(d: string): string {
  return ({ bestaetigt: 'bestätigt', abweichung: 'Abweichung', offen: 'offen', nicht_anwendbar: 'nicht anwendbar' } as Record<string, string>)[d] ?? d;
}
