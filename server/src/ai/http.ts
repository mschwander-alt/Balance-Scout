import { AiError } from './types.js';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Anzahl Wiederholungen bei 429/503 (mit Retry-After) */
  retries?: number;
}

/** fetch mit Timeout, Retry bei Drosselung und verständlichen Fehlern */
export async function httpJson<T>(url: string, o: HttpOptions): Promise<T> {
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    o.signal?.addEventListener('abort', () => ac.abort(), { once: true });
    let res: Response;
    try {
      res = await fetch(url, {
        method: o.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') throw new AiError(`Zeitüberschreitung nach ${o.timeoutMs} ms (${new URL(url).host})`, 'TIMEOUT', 504);
      throw new AiError(`Verbindung zu ${new URL(url).host} fehlgeschlagen: ${(e as Error).message}`, 'UPSTREAM');
    }
    clearTimeout(timer);
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await new Promise(r => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt, 30_000)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = text.slice(0, 500);
      if (res.status === 401 || res.status === 403) throw new AiError(`Zugriff verweigert (${res.status}) von ${new URL(url).host}: ${detail}`, 'AUTH_REQUIRED', 401);
      throw new AiError(`Fehler ${res.status} von ${new URL(url).host}: ${detail}`, 'UPSTREAM');
    }
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new AiError(`Ungültige JSON-Antwort von ${new URL(url).host}`, 'UPSTREAM');
    }
  }
}
