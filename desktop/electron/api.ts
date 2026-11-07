import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ApiResult, PickedFile } from './shared';

export interface ApiClientDeps {
  baseUrl: () => string;
  /** Liefert ein gültiges Zugriffstoken oder null (Anmeldung nötig) */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  maxUploadBytes?: number;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * Server-Zugriff aus dem Hauptprozess. Die Oberfläche kann nur Pfade unter /api
 * des konfigurierten Servers aufrufen – keine beliebigen URLs.
 */
export class ApiClient {
  private readonly f: typeof fetch;
  constructor(private readonly d: ApiClientDeps) {
    this.f = d.fetch ?? fetch;
  }

  url(p: string): string {
    if (!/^\/api\/[\w\-./?=&%:]*$/.test(p) || p.includes('..')) throw new Error(`Unzulässiger Pfad: ${p}`);
    return `${this.d.baseUrl().replace(/\/$/, '')}${p}`;
  }

  async request<T>(method: string, p: string, body?: unknown): Promise<ApiResult<T>> {
    if (!ALLOWED_METHODS.has(method)) return { ok: false, status: 0, error: 'Unzulässige Methode' };
    let url: string;
    try {
      url = this.url(p);
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
    const token = await this.d.token();
    if (!token) return { ok: false, status: 401, error: 'Bitte anmelden.' };
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return this.send<T>(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async upload<T>(p: string, files: PickedFile[], fields: Record<string, string> = {}, fieldName = 'files'): Promise<ApiResult<T>> {
    const token = await this.d.token();
    if (!token) return { ok: false, status: 401, error: 'Bitte anmelden.' };
    const max = this.d.maxUploadBytes ?? 50 * 1024 * 1024;
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) {
      const st = await stat(f.path);
      if (st.size > max) return { ok: false, status: 413, error: `${f.name} ist grösser als ${Math.round(max / 1024 / 1024)} MB.` };
      const buf = await readFile(f.path);
      form.append(fieldName, new Blob([new Uint8Array(buf)], { type: mimeOf(f.name) }), path.basename(f.name));
    }
    let url: string;
    try {
      url = this.url(p);
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message };
    }
    return this.send<T>(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  }

  private async send<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(300_000) });
    } catch (e) {
      const m = (e as Error).name === 'TimeoutError' ? 'Zeitüberschreitung – Server antwortet nicht.' : 'Server nicht erreichbar. Netzwerk/VPN prüfen.';
      return { ok: false, status: 0, error: m };
    }
    if (res.status === 204) return { ok: true, status: 204 };
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const err = (data as { error?: string } | undefined)?.error ?? `Fehler ${res.status}`;
      return { ok: false, status: res.status, error: err, data: data as T };
    }
    return { ok: true, status: res.status, data: data as T };
  }
}

export function mimeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      '.pdf': 'application/pdf',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
      '.csv': 'text/csv',
      '.txt': 'text/plain',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
    } as Record<string, string>
  )[ext] ?? 'application/octet-stream';
}
