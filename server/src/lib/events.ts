import type pg from 'pg';
import type { Db } from '../db/pool.js';

export interface BsbEvent {
  type:
    | 'lock.acquired'
    | 'lock.released'
    | 'review.updated'
    | 'match.completed'
    | 'evidence.uploaded'
    | 'ai.extract.completed'
    | 'sharepoint.uploaded';
  engagementId: string;
  actor: string;
  /** frei, z. B. accountId, runId, documentId */
  data: Record<string, unknown>;
  at: string;
}

type Listener = (e: BsbEvent) => void;
const CHANNEL = 'bsb_events';

export interface EventPublisher {
  publish(e: Omit<BsbEvent, 'at'>): Promise<void>;
  subscribe(l: Listener): () => void;
}

/** In-Prozess-Variante (Tests, Einzelinstanz) */
export class LocalEventBus implements EventPublisher {
  private readonly listeners = new Set<Listener>();
  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  async publish(e: Omit<BsbEvent, 'at'>) {
    const ev = { ...e, at: new Date().toISOString() };
    for (const l of this.listeners) l(ev);
  }
}

/**
 * Ereignisverteilung über PostgreSQL LISTEN/NOTIFY – funktioniert auch mit
 * mehreren Server-Instanzen (Azure Container Apps skaliert horizontal).
 */
export class PgEventBus implements EventPublisher {
  private readonly listeners = new Set<Listener>();
  private client: pg.PoolClient | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(private readonly db: Db, private readonly log: (msg: string) => void = () => undefined) {}

  async start(): Promise<void> {
    this.stopped = false;
    const client = await this.db.connect();
    this.client = client;
    // Verbindungsabbruch (z. B. Wartung der Azure-Datenbank): neu verbinden
    client.on('error', err => {
      this.log(`Ereignis-Verbindung unterbrochen: ${err.message} – neuer Versuch in 5 s`);
      try {
        client.release(true);
      } catch {
        /* bereits freigegeben */
      }
      if (this.client === client) this.client = null;
      this.scheduleRestart();
    });
    client.on('notification', msg => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const e = JSON.parse(msg.payload) as BsbEvent;
        for (const l of this.listeners) l(e);
      } catch {
        /* ungültige Nachricht ignorieren */
      }
    });
    await client.query(`LISTEN ${CHANNEL}`);
  }

  private scheduleRestart(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.start().catch(e => {
        this.log(`Neuverbindung fehlgeschlagen: ${(e as Error).message}`);
        this.scheduleRestart();
      });
    }, 5000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (!this.client) return;
    await this.client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
    this.client.release();
    this.client = null;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async publish(e: Omit<BsbEvent, 'at'>): Promise<void> {
    const payload = JSON.stringify({ ...e, at: new Date().toISOString() });
    // NOTIFY-Payload max. 8000 Bytes – Ereignisse enthalten nur IDs
    await this.db.query('SELECT pg_notify($1, $2)', [CHANNEL, payload.slice(0, 7900)]);
  }
}
